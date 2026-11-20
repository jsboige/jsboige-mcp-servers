"""
Tests for #1819: the kernel subprocess console must never inherit the MCP
stdio transport.

A kernel inheriting the server's stdout lets any console write from the
kernel process (dotnet-interactive prints "Application is shutting down..."
at stop time) land in the JSONRPC stream and kill the client session
(pydantic JSONRPCMessage ValidationError, then the anyio cancel-scope
teardown error). These tests pin the redirect contract at the three sites
that matter:

1. start_kernel passes stdout/stderr FILE handles (a kernel console write
   goes to a log file, not to the process stdout -- i.e. not to the wire);
2. the opt-out (PAPERMILL_MCP_KERNEL_REDIRECT=0) preserves the pre-#1819
   inherit behavior;
3. the handles close when the kernel leaves the registry (stop_kernel, and
   the failed-start cleanup), and stay OPEN across restart (jupyter_client
   reuses _launch_args on restart).
"""

import asyncio
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

pytestmark = pytest.mark.asyncio

from papermill_mcp.config import MCPConfig
from papermill_mcp.core import jupyter_manager as jm
from papermill_mcp.core.jupyter_manager import JupyterManager


class FakeKernelManager:
    """Captures start_kernel kwargs; no real process is spawned."""

    def __init__(self, kernel_name="python3"):
        self.kernel_name = kernel_name
        self.start_kwargs = None
        self.connection_file = "fake-connection.json"
        self.shut_down = False
        self.restarted = False

    def start_kernel(self, **kw):
        self.start_kwargs = kw

    def client(self):
        c = MagicMock()
        return c

    def shutdown_kernel(self, now=False):
        self.shut_down = True

    def restart_kernel(self):
        self.restarted = True


def _manager_with_fake_kernel(monkeypatch):
    """JupyterManager whose KernelManager class is FakeKernelManager."""
    mgr = JupyterManager(MCPConfig())
    monkeypatch.setattr(jm, "KernelManager", FakeKernelManager)
    return mgr


async def test_start_kernel_redirects_console_to_files(monkeypatch, tmp_path):
    """#1819 core: stdout/stderr are file handles under the log dir -- a
    kernel console write lands in the file, never on the process stdout."""
    monkeypatch.setenv("PAPERMILL_MCP_KERNEL_LOG_DIR", str(tmp_path))
    monkeypatch.delenv("PAPERMILL_MCP_KERNEL_REDIRECT", raising=False)
    mgr = _manager_with_fake_kernel(monkeypatch)

    kernel_id = await mgr.start_kernel("python3")

    km = mgr._active_kernels[kernel_id]
    assert km.start_kwargs is not None
    out_h, err_h = km.start_kwargs["stdout"], km.start_kwargs["stderr"]
    # Real append-mode binary files under the configured log dir...
    assert out_h.mode == "ab" and err_h.mode == "ab"
    assert Path(out_h.name).parent == tmp_path
    # ...and the writes a kernel would make at stop time go THERE, not to
    # the transport: the #1819 poison line, written through the handle the
    # kernel received, must not touch sys.stdout.
    poison = b"      Application is shutting down...\r\n"
    out_h.write(poison)
    out_h.flush()
    assert poison in Path(out_h.name).read_bytes()


async def test_start_kernel_redirect_optout(monkeypatch, tmp_path):
    """PAPERMILL_MCP_KERNEL_REDIRECT=0 preserves the inherit behavior."""
    monkeypatch.setenv("PAPERMILL_MCP_KERNEL_LOG_DIR", str(tmp_path))
    monkeypatch.setenv("PAPERMILL_MCP_KERNEL_REDIRECT", "0")
    mgr = _manager_with_fake_kernel(monkeypatch)

    kernel_id = await mgr.start_kernel("python3")

    km = mgr._active_kernels[kernel_id]
    assert "stdout" not in km.start_kwargs
    assert "stderr" not in km.start_kwargs
    assert getattr(km, "_mcp_redirect_handles", None) is None


async def test_stop_kernel_closes_redirect_handles(monkeypatch, tmp_path):
    """Registry exit closes the handles (they must not leak per kernel)."""
    monkeypatch.setenv("PAPERMILL_MCP_KERNEL_LOG_DIR", str(tmp_path))
    monkeypatch.delenv("PAPERMILL_MCP_KERNEL_REDIRECT", raising=False)
    mgr = _manager_with_fake_kernel(monkeypatch)

    kernel_id = await mgr.start_kernel("python3")
    km = mgr._active_kernels[kernel_id]
    out_h = km.start_kwargs["stdout"]

    stopped = await mgr.stop_kernel(kernel_id)

    assert stopped is True
    assert out_h.closed
    assert getattr(km, "_mcp_redirect_handles", None) is None


async def test_restart_keeps_handles_open(monkeypatch, tmp_path):
    """jupyter_client reuses _launch_args on restart: the SAME open handles
    must survive a restart (closing early would give the respawned kernel
    bad descriptors)."""
    monkeypatch.setenv("PAPERMILL_MCP_KERNEL_LOG_DIR", str(tmp_path))
    monkeypatch.delenv("PAPERMILL_MCP_KERNEL_REDIRECT", raising=False)
    mgr = _manager_with_fake_kernel(monkeypatch)

    kernel_id = await mgr.start_kernel("python3")
    km = mgr._active_kernels[kernel_id]
    out_h = km.start_kwargs["stdout"]

    restarted = await mgr.restart_kernel(kernel_id)

    assert restarted is True
    assert not out_h.closed


async def test_failed_start_closes_redirect_handles(monkeypatch, tmp_path):
    """A start_kernel failure (e.g. wait_for_ready timeout on slow .NET
    kernels) must close the freshly-opened redirect handles -- they are in
    no registry."""
    monkeypatch.setenv("PAPERMILL_MCP_KERNEL_LOG_DIR", str(tmp_path))
    monkeypatch.delenv("PAPERMILL_MCP_KERNEL_REDIRECT", raising=False)
    mgr = _manager_with_fake_kernel(monkeypatch)

    captured = {}

    real_start = FakeKernelManager.start_kernel

    def boom(self, **kw):
        real_start(self, **kw)
        captured["out"] = kw["stdout"]
        raise RuntimeError("simulated wait_for_ready failure")

    monkeypatch.setattr(FakeKernelManager, "start_kernel", boom)
    # The #3346 cleanup path tree-kills the (fake) kernel: stub it out --
    # the fake has no provisioner/PID to walk.
    async def fake_tree_kill(km):
        return {"killed": True}

    monkeypatch.setattr(mgr, "_kill_process_tree", fake_tree_kill)
    with pytest.raises(RuntimeError):
        await mgr.start_kernel("python3")

    assert captured["out"].closed
