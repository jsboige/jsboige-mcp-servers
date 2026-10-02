#!/usr/bin/env python3
"""
Bound MCP connect handshake (po-203 finding, fleet thread T#128).

A spawned-but-silent MCP server (process starts, initialize() never
answered) used to hang _ensure_mcp_loaded forever: MCPStdioPlugin was
created without request_timeout, so ClientSession(read_timeout_seconds=None)
and connect() waited on its ready-event unbounded. Agent creation pended
>= 90 s on po-203 for exactly this reason.

Covers:
- hanging server -> bounded failure (connect_timeout_s override)
- missing binary -> fast failure, no hang, no leftover loading state
- degraded continuation: a second, healthy plugin still loads afterwards
- diagnostics exposes the configured-minus-loaded diff
"""

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import sk_agent
from sk_agent import (
    SKAgentManager,
    DEFAULT_MCP_CONNECT_TIMEOUT_S,
    _MCP_CLOSE_TIMEOUT_S,
    _MCP_FAILURE_TTL_S,
)
from sk_agent_config import SKAgentConfig, McpConfig


def _manager_with(mcps: list[McpConfig]) -> SKAgentManager:
    return SKAgentManager(SKAgentConfig(mcps=mcps))


HANGING_MCP = McpConfig(
    id="hang-server",
    command=sys.executable,
    args=["-c", "import time; time.sleep(120)"],
    connect_timeout_s=1.5,
)

ECHO_MCP = McpConfig(
    id="echo-server",
    # A real MCP stdio server: FastMCP echo, handshake completes.
    command=sys.executable,
    args=["-c", "from mcp.server.fastmcp import FastMCP; FastMCP('echo').run()"],
    connect_timeout_s=15.0,
)

MISSING_MCP = McpConfig(
    id="missing-binary",
    command="definitely-not-a-real-binary-xyz",
)


def test_default_timeout_constant_is_bound():
    assert DEFAULT_MCP_CONNECT_TIMEOUT_S > 0
    assert DEFAULT_MCP_CONNECT_TIMEOUT_S <= 60


def test_mcp_config_connect_timeout_round_trip():
    cfg = McpConfig.from_dict({"id": "x", "command": "c", "connect_timeout_s": 12.5})
    assert cfg.connect_timeout_s == 12.5
    assert McpConfig.from_dict(cfg.to_dict()).connect_timeout_s == 12.5
    # absent -> None -> omitted from to_dict (backward-compatible schema)
    plain = McpConfig.from_dict({"id": "y", "command": "c"})
    assert plain.connect_timeout_s is None
    assert "connect_timeout_s" not in plain.to_dict()


def test_hanging_server_fails_bounded():
    mgr = _manager_with([HANGING_MCP])
    t0 = time.monotonic()
    ok = asyncio.run(mgr._ensure_mcp_loaded("hang-server"))
    elapsed = time.monotonic() - t0
    assert ok is False
    # Budget = handshake bound + close cap (the plugin's own close() cannot
    # interrupt a stuck initialize(), upstream semantic_kernel behavior).
    assert elapsed < HANGING_MCP.connect_timeout_s + _MCP_CLOSE_TIMEOUT_S + 5.0, (
        f"connect should be bounded, took {elapsed:.1f}s"
    )
    assert "hang-server" not in mgr._mcp_plugins
    assert not mgr._loading_mcps, "loading set must be cleared (finally path)"


def test_missing_binary_fails_fast():
    mgr = _manager_with([MISSING_MCP])
    t0 = time.monotonic()
    ok = asyncio.run(mgr._ensure_mcp_loaded("missing-binary"))
    elapsed = time.monotonic() - t0
    # semantic_kernel 1.42.0 bug (reproduced here): the failed spawn still
    # sets the ready-event, connect() returns a session-less zombie and the
    # load used to report True. The zombie must be refused at our boundary.
    assert ok is False, "zombie plugin (session=None) must not count as loaded"
    assert elapsed < DEFAULT_MCP_CONNECT_TIMEOUT_S, (
        "spawn failure must not wait the full handshake budget"
    )
    assert "missing-binary" not in mgr._mcp_plugins


def test_degraded_continuation_after_timeout():
    """The po-203 unblock: after one plugin times out, the next still loads."""
    mgr = _manager_with([HANGING_MCP, ECHO_MCP])

    async def scenario():
        first = await mgr._ensure_mcp_loaded("hang-server")
        second = await mgr._ensure_mcp_loaded("echo-server")
        return first, second

    first, second = asyncio.run(scenario())
    assert first is False
    assert second is True, "healthy plugin must still load after a timeout"
    assert "echo-server" in mgr._mcp_plugins


def test_negative_cache_short_circuits_retry():
    """A failed plugin must not re-pay the connect budget on each attempt."""
    mgr = _manager_with([MISSING_MCP])

    async def scenario():
        first = await mgr._ensure_mcp_loaded("missing-binary")
        t0 = time.monotonic()
        second = await mgr._ensure_mcp_loaded("missing-binary")
        return first, second, time.monotonic() - t0

    first, second, retry_elapsed = asyncio.run(scenario())
    assert first is False
    assert second is False
    assert retry_elapsed < 1.0, "cached failure must short-circuit instantly"
    assert mgr._mcp_failed_until["missing-binary"] <= time.monotonic() + _MCP_FAILURE_TTL_S


def test_relative_args_resolve_against_config_dir(tmp_path, monkeypatch):
    """Sibling-relative plugin paths load even when our cwd is elsewhere.

    Under Claude Code the sk-agent process runs from the session workspace,
    so ``../open-terminal-mcp/...`` used to resolve outside the servers tree
    and the plugin dropped out of its preset (vllm#63, ai-01 03/10).
    """
    cfg_dir = tmp_path / "servers" / "sk-agent"
    srv_dir = tmp_path / "servers" / "echo-sibling-srv"
    cfg_dir.mkdir(parents=True)
    srv_dir.mkdir(parents=True)
    (srv_dir / "echo_server.py").write_text(
        "from mcp.server.fastmcp import FastMCP\nFastMCP('echo').run()\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(sk_agent, "CONFIG_PATH", str(cfg_dir / "sk_agent_config.json"))
    # From here, the relative arg points at a directory that does not exist.
    monkeypatch.chdir(tmp_path)
    assert not Path("../echo-sibling-srv/echo_server.py").exists()

    mgr = _manager_with([
        McpConfig(
            id="sibling-echo",
            command=sys.executable,
            args=["../echo-sibling-srv/echo_server.py"],
            connect_timeout_s=15.0,
        )
    ])
    ok = asyncio.run(mgr._ensure_mcp_loaded("sibling-echo"))
    assert ok is True, "relative args must resolve against the config directory"
    assert "sibling-echo" in mgr._mcp_plugins


def test_diagnostics_lists_unavailable_plugins(monkeypatch):
    mgr = _manager_with([HANGING_MCP, ECHO_MCP])

    async def scenario():
        await mgr._ensure_mcp_loaded("hang-server")  # times out (1.5s)
        await mgr._ensure_mcp_loaded("echo-server")  # loads
        monkeypatch.setattr(sk_agent, "_manager", mgr)
        return await sk_agent.diagnostics()

    data = json.loads(asyncio.run(scenario()))
    assert data["mcp_plugins_loaded"] == ["echo-server"]
    assert data["mcp_plugins_unavailable"] == ["hang-server"]
