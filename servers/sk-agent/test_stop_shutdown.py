"""#4854: stop() survives exit-stack close failures and always flushes state.

Measured defect (ai-01:vllm, 21/11): ``SKAgentManager.stop()`` called
``await self._exit_stack.aclose()`` bare. At server shutdown anyio raises
``RuntimeError("Attempted to exit cancel scope in a different task than it
was entered in")`` when a stdio plugin's cancel scope is finalised from
another task — the error propagated, the dicts were never flushed and the
final log never ran. The forced plugin-close path already treats this exact
case as debug noise; stop() now aligns with it and flushes in ``finally``.

Run:

    python -m pytest test_stop_shutdown.py -v
"""

import asyncio
import logging
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sk_agent
from sk_agent import SKAgentManager

_ANYIO_MSG = (
    "Attempted to exit cancel scope in a different task "
    "than it was entered in"
)


class _RaisingExitStack:
    """Exit-stack double whose aclose() raises a fixed exception."""

    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    async def aclose(self):
        raise self._exc


class _HangingExitStack:
    """Exit-stack double whose aclose() never completes on its own."""

    async def aclose(self):
        await asyncio.sleep(30)


def _manager_with(exit_stack) -> SKAgentManager:
    manager = SKAgentManager.__new__(SKAgentManager)
    manager._exit_stack = exit_stack
    manager._mcp_plugins = {"m1": object()}
    manager._mcp_plugin_list = [object()]
    manager._threads = {"c1": object()}
    manager._conv_locks = {"c1": object()}
    manager._turn_counts = {"c1": 3}
    manager._epochs = {"c1": 2}
    manager._kernels = {"k1": object()}
    manager._sk_agents = {"a1": object()}
    manager._openai_clients = {"mo1": object()}
    manager._services = {"s1": object()}
    manager._memory_stores = {"mem1": object()}
    return manager


def _all_flushed(manager: SKAgentManager) -> bool:
    return (
        not manager._mcp_plugins
        and not manager._mcp_plugin_list
        and not manager._threads
        and not manager._conv_locks
        and not manager._turn_counts
        and not manager._epochs
        and not manager._kernels
        and not manager._sk_agents
        and not manager._openai_clients
        and not manager._services
        and not manager._memory_stores
    )


@pytest.mark.asyncio
async def test_stop_cross_task_cancel_scope_is_debug_and_flushes(caplog):
    """The anyio RuntimeError from #4854: debug, not an error, and stop()
    still completes with every dict flushed and the final log emitted."""
    manager = _manager_with(_RaisingExitStack(RuntimeError(_ANYIO_MSG)))
    with caplog.at_level(logging.DEBUG, logger="sk-agent"):
        await manager.stop()  # must not raise

    assert _all_flushed(manager)
    debug_records = [
        r
        for r in caplog.records
        if r.levelno == logging.DEBUG and "cancel-scope" in r.getMessage()
    ]
    assert debug_records, "expected a DEBUG record for the cross-task cancel-scope exit"
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert any(
        "SK Agent Manager stopped" in r.getMessage() for r in caplog.records
    )


@pytest.mark.asyncio
async def test_stop_unexpected_exception_is_logged_and_flushes(caplog):
    """Any other exception (here ValueError) is logged via log.exception —
    ERROR level with a traceback — and the flush still happens."""
    manager = _manager_with(_RaisingExitStack(ValueError("boom")))
    with caplog.at_level(logging.DEBUG, logger="sk-agent"):
        await manager.stop()  # must not raise

    assert _all_flushed(manager)
    exc_records = [
        r for r in caplog.records if r.levelno == logging.ERROR and r.exc_info
    ]
    assert exc_records, "expected a log.exception record (ERROR + traceback)"
    assert any(
        "SK Agent Manager stopped" in r.getMessage() for r in caplog.records
    )


@pytest.mark.asyncio
async def test_stop_hanging_aclose_times_out_warns_and_flushes(caplog, monkeypatch):
    """A close that never completes is bounded by _MCP_CLOSE_TIMEOUT_S:
    warning + flush. The timeout is shortened to keep the test fast."""
    monkeypatch.setattr(sk_agent, "_MCP_CLOSE_TIMEOUT_S", 0.05)
    manager = _manager_with(_HangingExitStack())
    with caplog.at_level(logging.DEBUG, logger="sk-agent"):
        await manager.stop()  # must not raise

    assert _all_flushed(manager)
    warn_records = [
        r for r in caplog.records if r.levelno == logging.WARNING
    ]
    assert warn_records, "expected a WARNING record for the bounded close timeout"
    assert any(
        "SK Agent Manager stopped" in r.getMessage() for r in caplog.records
    )


@pytest.mark.asyncio
async def test_stop_cancellation_still_flushes():
    """BaseException path — this is what the ``finally`` is FOR. A
    CancelledError (BaseException, not caught by ``except Exception``)
    propagates out of stop() — correct, cancellation must not be swallowed
    — but the flush runs first. This also makes the literal "dedent the
    finally block" mutant red: without ``finally``, the flush is skipped
    on this path."""
    manager = _manager_with(
        _RaisingExitStack(asyncio.CancelledError("cancelled during close"))
    )
    with pytest.raises(asyncio.CancelledError):
        await manager.stop()

    assert _all_flushed(manager), (
        "flush must run even when a BaseException propagates out of stop()"
    )
