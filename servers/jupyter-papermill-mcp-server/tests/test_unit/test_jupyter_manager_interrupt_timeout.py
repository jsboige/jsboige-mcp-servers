"""
Unit tests for JupyterManager execute_code interrupt-on-timeout hardening (#2718).

Covers the residual hang where km.interrupt_kernel() itself blocks on Windows for
dotnet-interactive kernels in the middle of a non-cooperative nuget restore.
"""

import asyncio
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from papermill_mcp.core.jupyter_manager import (
    JupyterManager,
    KernelInfo,
    ExecutionResult,
)


@pytest.fixture
def manager_with_busy_kernel():
    """Build a JupyterManager with a kernel in busy state and a mocked client/km."""
    mgr = JupyterManager()
    kernel_id = "test-kernel-2718"

    km_mock = MagicMock()
    kc_mock = MagicMock()

    # Make get_iopub_msg return empty quickly so the deadline loop expires fast
    kc_mock.get_iopub_msg.side_effect = lambda timeout=1.0: (_ for _ in ()).throw(
        TimeoutError("no message")
    )
    km_mock.client.return_value = kc_mock

    mgr._active_kernels[kernel_id] = km_mock
    mgr._kernel_info[kernel_id] = KernelInfo(
        kernel_id=kernel_id,
        kernel_name=".net-csharp",
        connection_file="/tmp/fake.json",
        started_at=datetime.now(),
        last_activity=datetime.now(),
        status="busy",
    )
    return mgr, kernel_id, km_mock


@pytest.mark.asyncio
async def test_execute_code_interrupt_hang_marks_unresponsive(manager_with_busy_kernel):
    """#2718: when interrupt_kernel itself blocks > 5s, tool must return bounded
    and mark kernel 'unresponsive' (not 'idle')."""
    mgr, kernel_id, km_mock = manager_with_busy_kernel

    # Make interrupt_kernel block forever -- simulates dotnet nuget restore hang.
    # asyncio.wait_for will cancel this after 5s.
    async def hang_interrupt(kid):
        await asyncio.sleep(1000)

    with patch.object(mgr, "interrupt_kernel", side_effect=hang_interrupt):
        result = await mgr.execute_code(kernel_id, "#r \"nuget: System.Text.Json\"", timeout=1)

    assert result.status == "timeout"
    # Kernel MUST be marked unresponsive so subsequent calls don't re-queue on busy
    assert mgr._kernel_info[kernel_id].status == "unresponsive"


@pytest.mark.asyncio
async def test_execute_code_interrupt_succeeds_marks_idle(manager_with_busy_kernel):
    """When interrupt succeeds within the timebox, kernel returns to 'idle'."""
    mgr, kernel_id, km_mock = manager_with_busy_kernel

    interrupt_calls = []

    async def fast_interrupt(kid):
        interrupt_calls.append(kid)
        mgr._kernel_info[kid].status = "idle"
        return True

    with patch.object(mgr, "interrupt_kernel", side_effect=fast_interrupt):
        result = await mgr.execute_code(kernel_id, "import time; time.sleep(100)", timeout=1)

    assert result.status == "timeout"
    assert interrupt_calls == [kernel_id]
    # Interrupt succeeded -> kernel back to idle
    assert mgr._kernel_info[kernel_id].status == "idle"


@pytest.mark.asyncio
async def test_execute_code_interrupt_raises_exception_stays_unresponsive(manager_with_busy_kernel):
    """When interrupt raises a non-timeout exception, kernel stays 'unresponsive'."""
    mgr, kernel_id, km_mock = manager_with_busy_kernel

    async def failing_interrupt(kid):
        raise RuntimeError("kernel protocol error")

    with patch.object(mgr, "interrupt_kernel", side_effect=failing_interrupt):
        result = await mgr.execute_code(kernel_id, "while True: pass", timeout=1)

    assert result.status == "timeout"
    assert mgr._kernel_info[kernel_id].status == "unresponsive"


@pytest.mark.asyncio
async def test_execute_code_normal_completion_marks_idle(manager_with_busy_kernel):
    """Normal completion (no timeout) returns ok and kernel idle."""
    mgr, kernel_id, km_mock = manager_with_busy_kernel

    # Make get_iopub_msg return an idle status quickly
    kc_mock = km_mock.client.return_value
    kc_mock.get_iopub_msg.side_effect = lambda timeout=1.0: {
        "msg_type": "status",
        "content": {"execution_state": "idle"},
    }

    result = await mgr.execute_code(kernel_id, "print('hello')", timeout=5)

    assert result.status == "ok"
    assert mgr._kernel_info[kernel_id].status == "idle"


@pytest.mark.asyncio
async def test_execute_code_refuses_unresponsive_kernel(manager_with_busy_kernel):
    """#2718: an 'unresponsive' kernel (prior non-cooperative timeout) must NOT be
    re-queued. The entry-point gate raises RuntimeError instead of executing again
    on a still-busy kernel. Recovery is via restart_kernel() (resets status to 'idle').
    """
    mgr, kernel_id, km_mock = manager_with_busy_kernel
    # Simulate a prior call that left the kernel unresponsive.
    mgr._kernel_info[kernel_id].status = "unresponsive"

    with pytest.raises(RuntimeError, match="unresponsive"):
        await mgr.execute_code(kernel_id, "#r \"nuget: System.Text.Json\"", timeout=5)

    # Kernel status must stay 'unresponsive' (not flipped to 'busy' by a re-queue).
    assert mgr._kernel_info[kernel_id].status == "unresponsive"
