"""
Unit tests for kernel cleanup/lifecycle on the full-notebook execution path (#3346).

Incident (po-2025, 2026-08-31): execute_on_kernel(mode="notebook") on a
.net-csharp kernel leaked two kernels registered `busy` with live OS processes
after timeout/crash. Root causes covered here:

1. transport-level cancellation (asyncio.wait_for hard timeout) raises
   CancelledError, which derives from BaseException and used to skip both the
   `except Exception` and the post-loop status update in execute_code;
2. a failed kernel start (IOException during wait_for_ready) leaked the
   already-spawned process with no registry entry;
3. the notebook path dropped the caller's timeout (config default 900s used
   instead) and returned no cleanup diagnostics;
4. nothing surfaced same-name lingering kernels on a new start.

Repro 2 (same day, follow-up comment): after a transport-timeout of a
`notebook_cell` call, the registry said `not_found` while the OS process tree
stayed alive -- jupyter_client's force-stop only terminates the process it
spawned (the dotnet.exe wrapper), orphaning the real kernel
(dotnet-interactive.exe grandchild). Covered by the process-tree kill tests.
"""

import asyncio
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from papermill_mcp.core.jupyter_manager import (
    JupyterManager,
    KernelInfo,
    ExecutionResult,
)
from papermill_mcp.services.kernel_service import KernelService
from papermill_mcp.config import MCPConfig


@pytest.fixture
def manager_with_busy_kernel():
    """Build a JupyterManager with a busy .net-csharp kernel and a mocked km."""
    mgr = JupyterManager()
    kernel_id = "test-kernel-3346"

    km_mock = MagicMock()
    kc_mock = MagicMock()
    # No iopub messages arrive: the deadline loop spins until cancelled/timed out
    kc_mock.get_iopub_msg.side_effect = lambda timeout=1.0: (_ for _ in ()).throw(
        TimeoutError("no message")
    )
    km_mock.client.return_value = kc_mock

    mgr._active_kernels[kernel_id] = km_mock
    mgr._kernel_info[kernel_id] = KernelInfo(
        kernel_id=kernel_id,
        kernel_name=".net-csharp",
        connection_file="C:/Users/jsboi/AppData/Local/Temp/tmpfake.json",
        started_at=datetime.now(),
        last_activity=datetime.now(),
        status="busy",
    )
    return mgr, kernel_id, km_mock


# ---------------------------------------------------------------------------
# 1. Cancellation (transport hard timeout / caller cancelled) must clean up
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancellation_force_stops_noncooperative_kernel(manager_with_busy_kernel):
    """#3346: cancelled call + interrupt hanging (non-cooperative .NET kernel)
    -> kernel force-stopped (shutdown now=True) and DEREGISTERED. Before the
    fix it stayed 'busy' in the registry with a live OS process."""
    mgr, kernel_id, km_mock = manager_with_busy_kernel

    async def hang_interrupt(kid):
        await asyncio.sleep(1000)  # dotnet nuget restore hang

    with patch.object(mgr, "interrupt_kernel", side_effect=hang_interrupt):
        # Outer wait_for simulates the transport hard timeout cancelling the call
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(
                mgr.execute_code(kernel_id, '#r "nuget: Microsoft.ML.OnnxRuntimeGenAI.Cuda"',
                                 timeout=420),
                timeout=1,
            )

    # The kernel must no longer be registered: the leak is closed.
    assert kernel_id not in mgr._kernel_info
    assert kernel_id not in mgr._active_kernels
    # The process was actually asked to die, hard.
    km_mock.shutdown_kernel.assert_called_once_with(now=True)


@pytest.mark.asyncio
async def test_cancellation_with_cooperative_interrupt_keeps_kernel(manager_with_busy_kernel):
    """#3346: cancelled call but cooperative kernel (interrupt works within the
    timebox) -> kernel kept, back to 'idle' and reusable."""
    mgr, kernel_id, km_mock = manager_with_busy_kernel

    async def fast_interrupt(kid):
        mgr._kernel_info[kid].status = "idle"
        return True

    with patch.object(mgr, "interrupt_kernel", side_effect=fast_interrupt):
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(
                mgr.execute_code(kernel_id, "Console.WriteLine(42)", timeout=420),
                timeout=1,
            )

    assert kernel_id in mgr._kernel_info
    assert mgr._kernel_info[kernel_id].status == "idle"


@pytest.mark.asyncio
async def test_cancellation_force_stop_failure_keeps_entry_recoverable(manager_with_busy_kernel):
    """#3346: if even the force-stop fails, the entry stays registered as
    'unresponsive' so manage_kernel(action='stop') can still reclaim it
    manually (this is how the incident kernels were reclaimed)."""
    mgr, kernel_id, km_mock = manager_with_busy_kernel
    km_mock.shutdown_kernel.side_effect = RuntimeError("kill failed")

    async def hang_interrupt(kid):
        await asyncio.sleep(1000)

    with patch.object(mgr, "interrupt_kernel", side_effect=hang_interrupt):
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(
                mgr.execute_code(kernel_id, "#r \"nuget: Big.Package\"", timeout=420),
                timeout=1,
            )

    assert kernel_id in mgr._kernel_info
    assert mgr._kernel_info[kernel_id].status == "unresponsive"
    # Manual recovery via the registry still works once the kill starts
    # succeeding (simulating the operator's manual stop in the incident).
    km_mock.shutdown_kernel.side_effect = None
    assert await mgr.stop_kernel(kernel_id) is True
    assert kernel_id not in mgr._kernel_info


@pytest.mark.asyncio
async def test_timeout_caller_present_keeps_2718_semantics(manager_with_busy_kernel):
    """#3346 regression guard: a plain per-cell timeout (caller present) must
    NOT force-stop the kernel -- #2718 semantics (unresponsive + manual
    restart) are preserved."""
    mgr, kernel_id, km_mock = manager_with_busy_kernel

    async def hang_interrupt(kid):
        await asyncio.sleep(1000)

    with patch.object(mgr, "interrupt_kernel", side_effect=hang_interrupt):
        result = await mgr.execute_code(kernel_id, "#r \"nuget: X\"", timeout=1)

    assert result.status == "timeout"
    assert mgr._kernel_info[kernel_id].status == "unresponsive"
    km_mock.shutdown_kernel.assert_not_called()


# ---------------------------------------------------------------------------
# 2. Failed kernel start must not leak the spawned process
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_kernel_failure_cleans_spawned_process():
    """#3346: start_kernel failing after the process was spawned (IOException
    during the wait_for_ready handshake) must shut the process down instead of
    leaking it with no registry entry."""
    mgr = JupyterManager()

    with patch("papermill_mcp.core.jupyter_manager.KernelManager") as KM:
        km_mock = MagicMock()
        km_mock.client.return_value.wait_for_ready.side_effect = OSError(
            "IOException during handshake"
        )
        KM.return_value = km_mock

        with pytest.raises(RuntimeError, match="Failed to start kernel"):
            await mgr.start_kernel(".net-csharp")

        km_mock.shutdown_kernel.assert_called_once_with(now=True)

    assert len(mgr._kernel_info) == 0
    assert len(mgr._active_kernels) == 0


# ---------------------------------------------------------------------------
# 3. Notebook path: timeout passthrough + cleanup diagnostics
# ---------------------------------------------------------------------------


@pytest.fixture
def kernel_service_mock():
    config = Mock(spec=MCPConfig)
    config.papermill = Mock()
    config.papermill.timeout = 900
    config.continue_on_error = False
    service = KernelService(config)
    service.jupyter_manager = MagicMock()
    service.jupyter_manager.start_kernel = MagicMock()
    return service


def _fake_notebook():
    """NotebookNode-like object with 2 code cells (nbformat is mocked at the
    FileUtils level by the caller)."""
    nb = MagicMock()
    md_cell = MagicMock()
    md_cell.cell_type = "markdown"
    md_cell.source = "# title"
    code1 = MagicMock()
    code1.cell_type = "code"
    code1.source = '#r "nuget: Microsoft.ML.OnnxRuntimeGenAI.Cuda, 0.15.2"'
    code2 = MagicMock()
    code2.cell_type = "code"
    code2.source = "Console.WriteLine(42)"
    nb.cells = [md_cell, code1, code2]
    return nb


@pytest.mark.asyncio
async def test_notebook_mode_forwards_timeout_and_reports_cleanup(kernel_service_mock):
    """#3346: mode='notebook' must forward the caller timeout as the per-cell
    budget (it was silently dropped before) and, when a cell times out with a
    non-cooperative kernel, report cell/phase/cleanup and stop the run."""
    service = kernel_service_mock
    service.jupyter_manager.execute_code = AsyncMock(
        return_value=ExecutionResult(status="timeout", execution_count=0)
    )
    service.jupyter_manager.get_kernel_info = MagicMock(
        return_value={"kernel_id": "k1", "status": "unresponsive"}
    )

    # FileUtils is imported locally inside the method: patch at its source module
    with patch(
        "papermill_mcp.utils.file_utils.FileUtils.read_notebook",
        return_value=_fake_notebook(),
    ):
        result = await service.execute_notebook_in_kernel(
            "k1", "10f_ORTGenAI_DotNet_BakeOff.ipynb", timeout=420
        )

    # The caller's 420s is forwarded per cell -- NOT the 900s config default
    assert service.jupyter_manager.execute_code.call_args_list[0].kwargs[
        "timeout"
    ] == 420.0
    # Diagnostics name the failing cell (index 1 = first code cell), the phase
    # and the post-cleanup kernel state.
    assert result["timeout_cell_index"] == 1
    assert result["cleanup"]["phase"] == "interrupt"
    assert result["cleanup"]["kernel_status"] == "unresponsive"
    assert result["cleanup"]["result"] == "kernel_unresponsive_restart_required"
    assert result["timeout_cells"] == 1
    assert result["success"] is False
    # No re-queue on an unresponsive kernel: only the first code cell ran
    assert service.jupyter_manager.execute_code.call_count == 1


@pytest.mark.asyncio
async def test_notebook_mode_continues_after_cooperative_timeout(kernel_service_mock):
    """#3346: a timed-out cell whose kernel returned to 'idle' (cooperative
    interrupt) does not abort the run."""
    service = kernel_service_mock
    service.jupyter_manager.execute_code = AsyncMock(
        side_effect=[
            ExecutionResult(status="timeout", execution_count=0),
            ExecutionResult(status="ok", execution_count=1),
        ]
    )
    service.jupyter_manager.get_kernel_info = MagicMock(
        return_value={"kernel_id": "k1", "status": "idle"}
    )

    with patch(
        "papermill_mcp.utils.file_utils.FileUtils.read_notebook",
        return_value=_fake_notebook(),
    ):
        result = await service.execute_notebook_in_kernel("k1", "nb.ipynb", timeout=420)

    assert service.jupyter_manager.execute_code.call_count == 2
    assert result["timeout_cells"] == 1
    assert result["successful_cells"] == 1
    assert result["success"] is False  # still not a clean success
    assert result["cleanup"]["kernel_status"] == "idle"
    assert result["cleanup"]["result"] == "kernel_idle"


# ---------------------------------------------------------------------------
# 4. New start must surface lingering same-name kernels
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_kernel_warns_about_lingering_kernels(kernel_service_mock):
    """#3346: starting a kernel while a same-name kernel from a prior run is
    still busy/unresponsive must surface it (the incident stacked two
    .net-csharp kernels this way)."""
    service = kernel_service_mock

    async def _start(_name):
        return "new-kernel-id"

    service.jupyter_manager.start_kernel = _start
    service.jupyter_manager.list_active_kernels = MagicMock(
        return_value=[
            {
                "kernel_id": "6adaed85-2256",
                "kernel_name": ".net-csharp",
                "status": "busy",
                "started_at": "2026-08-31T17:49:56",
            },
            {
                "kernel_id": "0366cdb5-d1c6",
                "kernel_name": ".net-csharp",
                "status": "unresponsive",
                "started_at": "2026-08-31T17:54:19",
            },
            {
                "kernel_id": "healthy-1",
                "kernel_name": ".net-csharp",
                "status": "idle",
            },
            {
                "kernel_id": "other-1",
                "kernel_name": "python3",
                "status": "busy",
            },
        ]
    )

    result = await service.start_kernel(".net-csharp")

    assert result["success"] is True
    assert result["kernel_id"] == "new-kernel-id"
    # Only the busy/unresponsive same-name kernels are flagged
    warned = {k["kernel_id"] for k in result["warning"]["kernels"]}
    assert warned == {"6adaed85-2256", "0366cdb5-d1c6"}


@pytest.mark.asyncio
async def test_start_kernel_no_warning_when_clean(kernel_service_mock):
    async def _start(_name):
        return "new-kernel-id"

    service = kernel_service_mock
    service.jupyter_manager.start_kernel = _start
    service.jupyter_manager.list_active_kernels = MagicMock(return_value=[])

    result = await service.start_kernel(".net-csharp")
    assert "warning" not in result


# ---------------------------------------------------------------------------
# 5. Transport hard timeout for notebook mode (no more inversion)
# ---------------------------------------------------------------------------


def test_transport_hard_timeout_proportional_for_notebook(tmp_path):
    """#3346: notebook mode transport bound = per-cell budget * n_code_cells +
    60 (clamped) -- NOT per-cell + 30, which cancelled the call mid-cell before
    any per-cell timeout could fire."""
    from papermill_mcp.tools.kernel_tools import _transport_hard_timeout
    import nbformat

    nb = nbformat.v4.new_notebook()
    nb.cells = [
        nbformat.v4.new_markdown_cell("# md"),
        nbformat.v4.new_code_cell("#r \"nuget: X\""),
        nbformat.v4.new_code_cell("1+1"),
        nbformat.v4.new_code_cell("2+2"),
    ]
    path = tmp_path / "bakeoff.ipynb"
    nbformat.write(nb, str(path))

    assert (
        _transport_hard_timeout("notebook", str(path), 420, 3600) == 420 * 3 + 60
    )
    # Clamped to the configured max
    assert _transport_hard_timeout("notebook", str(path), 1200, 3600) == 3600
    # Other modes keep the flat #2206 bound
    assert _transport_hard_timeout("code", None, 420, 3600) == 450
    assert _transport_hard_timeout("notebook_cell", str(path), 420, 3600) == 450
    # Unreadable notebook falls back to the flat bound
    assert (
        _transport_hard_timeout("notebook", "Z:/nope/missing.ipynb", 420, 3600)
        == 450
    )


# ---------------------------------------------------------------------------
# 6. Repro 2: transport-timeout of notebook_cell -> registry removal AND
#    process-tree termination (the registry alone can look clean while the
#    dotnet.exe wrapper's children survive jupyter_client's direct-child kill)
# ---------------------------------------------------------------------------


def _fake_taskkill_ok():
    """CompletedProcess-like mock for a successful taskkill."""
    return MagicMock(returncode=0, stderr=b"", stdout=b"SUCCESS: process killed.\r\n")


@pytest.mark.asyncio
async def test_transport_timeout_deregisters_and_kills_process_tree(
    manager_with_busy_kernel,
):
    """#3346 repro 2: after a transport-timeout cancellation of a
    notebook_cell-style call on a non-cooperative kernel, BOTH must hold:
    (a) the kernel is removed from the registry, and (b) the OS process tree
    of the spawned kernel is terminated (taskkill /F /T), not just the direct
    child that jupyter_client kills."""
    mgr, kernel_id, km_mock = manager_with_busy_kernel
    # dotnet.exe wrapper PID as jupyter_client 8.x exposes it
    km_mock.provisioner.process.pid = 57328

    async def hang_interrupt(kid):
        await asyncio.sleep(1000)  # non-cooperative .NET kernel

    with patch("sys.platform", "win32"), patch(
        "papermill_mcp.core.jupyter_manager.subprocess.run",
        return_value=_fake_taskkill_ok(),
    ) as tk:
        with patch.object(mgr, "interrupt_kernel", side_effect=hang_interrupt):
            # Simulates the transport hard timeout cancelling the tool call
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(
                    mgr.execute_code(kernel_id, "new Model(modelDir)", timeout=900),
                    timeout=1,
                )

        # (a) registry removal
        assert kernel_id not in mgr._kernel_info
        assert kernel_id not in mgr._active_kernels
        # (b) process-tree termination -- /T is what reaches the grandchild
        tk.assert_called_once()
        args = tk.call_args.args[0]
        assert args[:4] == ["taskkill", "/F", "/T", "/PID"]
        assert "57328" in args
        km_mock.shutdown_kernel.assert_called_once_with(now=True)


@pytest.mark.asyncio
async def test_force_stop_skips_taskkill_without_real_pid(
    manager_with_busy_kernel,
):
    """#3346: no int PID reachable (mocked/absent provisioner) -> tree-kill is
    skipped (never spawns a bogus taskkill), shutdown still runs."""
    mgr, kernel_id, km_mock = manager_with_busy_kernel
    # provisioner.process.pid stays a Mock -> _kernel_pid returns None

    async def hang_interrupt(kid):
        await asyncio.sleep(1000)

    with patch("sys.platform", "win32"), patch(
        "papermill_mcp.core.jupyter_manager.subprocess.run"
    ) as tk:
        with patch.object(mgr, "interrupt_kernel", side_effect=hang_interrupt):
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(
                    mgr.execute_code(kernel_id, "#r \"nuget: X\"", timeout=420),
                    timeout=1,
                )

        tk.assert_not_called()
        km_mock.shutdown_kernel.assert_called_once_with(now=True)
        assert kernel_id not in mgr._kernel_info


@pytest.mark.asyncio
async def test_force_stop_survives_taskkill_failure(manager_with_busy_kernel):
    """#3346: taskkill failing (access denied / pid gone) must not prevent the
    jupyter_client shutdown + deregistration; the outcome reports killed=False."""
    mgr, kernel_id, km_mock = manager_with_busy_kernel
    km_mock.provisioner.process.pid = 57328

    with patch("sys.platform", "win32"), patch(
        "papermill_mcp.core.jupyter_manager.subprocess.run",
        side_effect=OSError("access denied"),
    ):
        result = await mgr._force_stop_kernel(kernel_id)

    # Shutdown still ran and the kernel is deregistered despite taskkill failing
    assert kernel_id not in mgr._kernel_info
    km_mock.shutdown_kernel.assert_called_once_with(now=True)
    assert result["process_tree"]["killed"] is False
    assert result["final_status"] == "removed"


@pytest.mark.asyncio
async def test_start_kernel_failure_kills_process_tree():
    """#3346: a start that fails after spawning must tree-kill the wrapper
    (dotnet.exe -> dotnet-interactive.exe) before the direct-child shutdown."""
    mgr = JupyterManager()

    with patch("papermill_mcp.core.jupyter_manager.KernelManager") as KM:
        km_mock = MagicMock()
        km_mock.client.return_value.wait_for_ready.side_effect = OSError(
            "IOException during handshake"
        )
        km_mock.provisioner.process.pid = 29344
        KM.return_value = km_mock

        with patch("sys.platform", "win32"), patch(
            "papermill_mcp.core.jupyter_manager.subprocess.run",
            return_value=_fake_taskkill_ok(),
        ) as tk:
            with pytest.raises(RuntimeError, match="Failed to start kernel"):
                await mgr.start_kernel(".net-csharp")

            tk.assert_called_once()
            assert "/T" in tk.call_args.args[0]
            km_mock.shutdown_kernel.assert_called_once_with(now=True)

    assert len(mgr._kernel_info) == 0
    assert len(mgr._active_kernels) == 0


# ---------------------------------------------------------------------------
# 7. Legacy tool regression: execute_notebook_cell kwarg mismatch (#3346 comment)
# ---------------------------------------------------------------------------


class TestLegacyExecuteNotebookCellKwarg:
    @pytest.fixture
    def registered_tools(self):
        from papermill_mcp.tools.execution_tools import register_execution_tools
        from mcp.server.fastmcp import FastMCP

        app = MagicMock(spec=FastMCP)
        captured = {}

        def tool_decorator():
            def wrapper(func):
                captured[func.__name__] = func
                return func

            return wrapper

        app.tool.side_effect = tool_decorator
        register_execution_tools(app)
        return captured

    @pytest.mark.asyncio
    async def test_forwards_notebook_path_kwarg(self, registered_tools):
        """The legacy wrapper called the service with `path=` while the service
        parameter is `notebook_path` -- every call died immediately with
        "unexpected keyword argument 'path'" (reported in the #3346 comment)."""
        tool = registered_tools["execute_notebook_cell"]

        nb_service = MagicMock()
        kernel_service = AsyncMock()
        with patch(
            "papermill_mcp.tools.execution_tools.get_services",
            return_value=(nb_service, kernel_service),
        ):
            result = await tool(
                path="10f_ORTGenAI_DotNet_BakeOff.ipynb",
                cell_index=1,
                kernel_id="aec4577f-9a10",
            )

        kwargs = kernel_service.execute_notebook_cell.call_args.kwargs
        assert kwargs["notebook_path"] == "10f_ORTGenAI_DotNet_BakeOff.ipynb"
        assert kwargs["cell_index"] == 1
        assert kwargs["kernel_id"] == "aec4577f-9a10"
        assert result is kernel_service.execute_notebook_cell.return_value
        # And no error payload was returned
        assert "error" not in result
