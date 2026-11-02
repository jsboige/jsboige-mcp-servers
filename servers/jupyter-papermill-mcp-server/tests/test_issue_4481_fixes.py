"""
Tests for #4481 fixes:
- D2: execute_on_kernel(notebook_cell) persists execution_count + outputs to disk
- honest execution_count for errored cells via the shell execute_reply
- shared kernel client lifecycle (no per-execution client leak)
- working_dir honored by manage_kernel(start)
- bounded file operations (transport-level timeout)
"""

import asyncio
import hashlib
import json
import logging
import tempfile
import time
from datetime import datetime
from unittest.mock import AsyncMock, Mock, patch

import pytest

pytestmark = pytest.mark.asyncio

from papermill_mcp.config import MCPConfig
from papermill_mcp.core.jupyter_manager import (
    ExecutionOutput,
    ExecutionResult,
    JupyterManager,
    KernelInfo,
)
from papermill_mcp.services.kernel_service import KernelService
from papermill_mcp.tools.notebook_tools import _bounded_file_op
from papermill_mcp.utils.file_utils import FileUtils


# ---------------------------------------------------------------------------
# Helpers: fake kernel manager/client plumbing (no real kernel spawned)
# ---------------------------------------------------------------------------


class FakeShellChannel:
    def __init__(self, replies):
        self._replies = list(replies)

    def get_msg(self, timeout=None):
        if self._replies:
            return self._replies.pop(0)
        raise Exception("Empty")


class FakeClient:
    """Minimal BlockingKernelClient stand-in for JupyterManager tests.

    A real kernel answers an execute request on the shell channel for the
    msg_id that was just sent, so replies are queued by ``execute()`` -- a
    reply queued up front would be thrown away by the stale-reply drain that
    runs before each execution. A ``__current__`` parent msg_id in a reply
    template is substituted with the msg_id actually returned by execute().
    """

    def __init__(self, iopub_runs, replies, on_execute=None, stale_iopub=None):
        self.shell_channel = FakeShellChannel(replies)
        # A real kernel publishes iopub messages only once the request is on
        # the wire, so each execution consumes the next run's messages.
        self._iopub = list(stale_iopub or [])
        self._iopub_runs = [list(run) for run in iopub_runs]
        self._replies_on_execute = list(on_execute or [])
        self._msgid = 0
        self.stopped = False
        self.started_with = None

    def wait_for_ready(self, timeout=None):
        return None

    def start_channels(self, **kw):
        self.started_with = kw

    def stop_channels(self):
        self.stopped = True

    def execute(self, code):
        self._msgid += 1
        msg_id = f"msg-{self._msgid}"
        if self._iopub_runs:
            for msg in self._iopub_runs.pop(0):
                # A real kernel stamps every iopub message with the msg_id of
                # the request that caused it; #4481 (C1) correlates on it.
                parent = msg.setdefault("parent_header", {})
                if parent.get("msg_id") is None:
                    parent["msg_id"] = msg_id
                self._iopub.append(msg)
        for template in self._replies_on_execute:
            reply = {
                **template,
                "parent_header": dict(template.get("parent_header") or {}),
            }
            if reply["parent_header"].get("msg_id") == "__current__":
                reply["parent_header"]["msg_id"] = msg_id
            self.shell_channel._replies.append(reply)
        return msg_id

    def get_iopub_msg(self, timeout=None):
        if self._iopub:
            return self._iopub.pop(0)
        raise Exception("Empty")


class FakeKernelManager:
    def __init__(self, client):
        self._client = client
        self.start_kwargs = None
        self.connection_file = "fake-conn.json"
        # #4481 (W3): each call here is a client a real kernel manager would
        # create and never close -- the leak. Counting makes the assertion able
        # to fail for the reason the test names.
        self.client_calls = 0

    def start_kernel(self, **kw):
        self.start_kwargs = kw

    def client(self):
        self.client_calls += 1
        return self._client


def make_manager(kernels=None):
    """JupyterManager with an empty (or provided) registry and fakes for the rest."""
    mgr = JupyterManager.__new__(JupyterManager)
    mgr.config = MCPConfig()
    mgr.logger = logging.getLogger("MCP.FakeJupyterManager")
    mgr._active_kernels = {}
    mgr._kernel_info = {}
    mgr._kernel_locks = {}
    mgr._stream_executions = {}
    mgr._kernel_spec_manager = Mock()
    mgr._http_client = None
    for kid, (km, client) in (kernels or {}).items():
        mgr._active_kernels[kid] = km
        mgr._kernel_info[kid] = KernelInfo(
            kernel_id=kid,
            kernel_name="python3",
            connection_file="fake",
            started_at=datetime.now(),
            last_activity=datetime.now(),
            status="idle",
            client=client,
        )
    return mgr


def _msg(msg_type, content):
    return {"msg_type": msg_type, "content": content}


def _iopub_run(stream_text=None, ec=None, error=None):
    msgs = []
    if stream_text is not None:
        msgs.append(_msg("stream", {"name": "stdout", "text": stream_text}))
    if ec is not None:
        msgs.append(
            _msg(
                "execute_result",
                {"data": {"text/plain": str(ec)}, "execution_count": ec},
            )
        )
    if error is not None:
        msgs.append(
            _msg("error", {"ename": error[0], "evalue": error[1], "traceback": ["tb"]})
        )
    msgs.append(_msg("status", {"execution_state": "idle"}))
    return msgs


def _reply(msg_id, status, ec):
    return {
        "msg_type": "execute_reply",
        "parent_header": {"msg_id": msg_id},
        "content": {"status": status, "execution_count": ec},
    }


# ---------------------------------------------------------------------------
# D2: notebook_cell persistence
# ---------------------------------------------------------------------------


@pytest.fixture
def service():
    return KernelService(MCPConfig())


@pytest.fixture
def notebook(tmp_path):
    path = tmp_path / "nb.ipynb"
    nb = FileUtils.create_empty_notebook("python3")
    nb = FileUtils.add_cell(nb, "code", "print('hello')")
    FileUtils.write_notebook(nb, path)
    return path


async def test_notebook_cell_persists_outputs_and_ec(service, notebook):
    result = ExecutionResult(
        status="ok",
        execution_count=7,
        outputs=[
            ExecutionOutput(
                output_type="stream", content={"name": "stdout", "text": "hello\n"}
            ),
            ExecutionOutput(
                output_type="execute_result",
                content={"text/plain": "42"},
                metadata={},
                execution_count=7,
            ),
        ],
        text_output="hello\n",
    )
    with patch.object(
        service.jupyter_manager, "execute_code", new_callable=AsyncMock
    ) as mock_exec:
        mock_exec.return_value = result
        out = await service.execute_notebook_cell(str(notebook), 0, "k1", timeout=5)

    assert out["persisted"]["written"] is True
    assert out["persisted"]["execution_count"] == 7
    assert out["persisted"]["outputs_written"] == 2

    raw = notebook.read_bytes()
    assert out["persisted"]["sha256"] == hashlib.sha256(raw).hexdigest()

    on_disk = json.loads(raw.decode("utf-8"))
    cell = on_disk["cells"][0]
    assert cell["execution_count"] == 7
    assert cell["outputs"][0]["output_type"] == "stream"
    # nbformat's writer normalizes stream text into a list of lines.
    text = cell["outputs"][0]["text"]
    assert (text if isinstance(text, str) else "".join(text)) == "hello\n"
    assert cell["outputs"][1]["output_type"] == "execute_result"
    assert cell["outputs"][1]["execution_count"] == 7


async def test_notebook_cell_persists_error_output_and_ec(service, notebook):
    """An errored cell is a legitimate notebook state: persist it (#4481 D2)."""
    result = ExecutionResult(
        status="error",
        execution_count=9,
        outputs=[
            ExecutionOutput(
                output_type="error",
                content={
                    "ename": "TypeError",
                    "evalue": "bad call",
                    "traceback": ["line 1", "line 2"],
                },
            )
        ],
        text_output="TypeError: bad call",
        error_name="TypeError",
        error_value="bad call",
        traceback=["line 1", "line 2"],
    )
    with patch.object(
        service.jupyter_manager, "execute_code", new_callable=AsyncMock
    ) as mock_exec:
        mock_exec.return_value = result
        out = await service.execute_notebook_cell(str(notebook), 0, "k1", timeout=5)

    assert out["status"] == "error"
    assert out["success"] is False
    assert out["persisted"]["written"] is True

    on_disk = json.loads(notebook.read_text(encoding="utf-8"))
    cell = on_disk["cells"][0]
    assert cell["execution_count"] == 9
    assert cell["outputs"][0]["output_type"] == "error"
    assert cell["outputs"][0]["ename"] == "TypeError"


async def test_false_ok_without_execution_count_keeps_persisted_outputs(
    service, notebook
):
    """#4481 (C1): the destruction the review measured. A first run persists real
    outputs; a later `ok` result carrying no honest counter (foreign idle, or a
    shell reply that never came) must leave the file byte-identical."""
    good = ExecutionResult(
        status="ok",
        execution_count=4,
        outputs=[
            ExecutionOutput(
                output_type="stream", content={"name": "stdout", "text": "kept\n"}
            )
        ],
        text_output="kept\n",
    )
    with patch.object(
        service.jupyter_manager, "execute_code", new_callable=AsyncMock
    ) as mock_exec:
        mock_exec.return_value = good
        first = await service.execute_notebook_cell(str(notebook), 0, "k1", timeout=5)

    assert first["persisted"]["written"] is True
    before = notebook.read_bytes()

    fake_ok = ExecutionResult(status="ok", execution_count=0, outputs=[], text_output="")
    with patch.object(
        service.jupyter_manager, "execute_code", new_callable=AsyncMock
    ) as mock_exec:
        mock_exec.return_value = fake_ok
        second = await service.execute_notebook_cell(str(notebook), 0, "k1", timeout=5)

    assert second["persisted"]["written"] is False
    assert "execution_count" in second["persisted"]["reason"]
    assert notebook.read_bytes() == before, "persisted outputs must survive"


async def test_notebook_cell_timeout_not_persisted(service, notebook):
    before = notebook.read_bytes()
    result = ExecutionResult(status="timeout", execution_count=0, outputs=[])
    with patch.object(
        service.jupyter_manager, "execute_code", new_callable=AsyncMock
    ) as mock_exec:
        mock_exec.return_value = result
        out = await service.execute_notebook_cell(str(notebook), 0, "k1", timeout=5)

    assert out["persisted"]["written"] is False
    assert "timeout" in out["persisted"]["reason"]
    assert notebook.read_bytes() == before


async def test_notebook_cell_source_changed_on_disk_not_persisted(service, notebook):
    """A concurrent edit during execution must not receive stale outputs."""

    async def exec_and_touch_kernel_side_effect(kernel_id, code, timeout=None):
        nb = FileUtils.read_notebook(notebook)
        FileUtils.write_notebook(
            FileUtils.update_cell(nb, 0, "print('CHANGED')"), notebook
        )
        return ExecutionResult(status="ok", execution_count=3, outputs=[])

    with patch.object(
        service.jupyter_manager,
        "execute_code",
        side_effect=exec_and_touch_kernel_side_effect,
    ):
        out = await service.execute_notebook_cell(str(notebook), 0, "k1", timeout=5)

    assert out["persisted"]["written"] is False
    assert "changed on disk" in out["persisted"]["reason"]
    on_disk = json.loads(notebook.read_text(encoding="utf-8"))
    # nbformat writes source as a list of lines; join before comparing.
    assert "".join(on_disk["cells"][0]["source"]) == "print('CHANGED')"
    assert on_disk["cells"][0]["outputs"] == []


async def test_notebook_cell_persistence_failure_reported_not_raised(service, notebook):
    result = ExecutionResult(status="ok", execution_count=1, outputs=[])
    with patch.object(
        service.jupyter_manager, "execute_code", new_callable=AsyncMock
    ) as mock_exec:
        mock_exec.return_value = result
        with patch(
            "papermill_mcp.utils.file_utils.FileUtils.write_notebook",
            side_effect=OSError("disk full"),
        ):
            out = await service.execute_notebook_cell(str(notebook), 0, "k1", timeout=5)

    assert out["persisted"]["written"] is False
    assert "disk full" in out["persisted"]["reason"]
    assert out["status"] == "ok"  # execution itself succeeded


# ---------------------------------------------------------------------------
# Manager: shared client + honest execution_count from execute_reply
# ---------------------------------------------------------------------------


async def test_execute_code_takes_execution_count_from_reply():
    iopub = _iopub_run(error=("TypeError", "boom"))  # no execute_result in iopub
    client = FakeClient([iopub], [], on_execute=[_reply("__current__", "error", 12)])
    mgr = make_manager({"k1": (FakeKernelManager(client), client)})

    result = await mgr.execute_code("k1", "raise TypeError('boom')", timeout=5)

    assert result.status == "error"
    # The reply's count wins over the iopub-derived 0 for errored cells
    assert result.execution_count == 12


async def test_execute_code_reply_missing_falls_back_to_iopub_count():
    iopub = _iopub_run(stream_text="hi\n", ec=4)
    client = FakeClient([iopub], [])  # shell channel never yields the reply
    mgr = make_manager({"k1": (FakeKernelManager(client), client)})

    result = await mgr.execute_code("k1", "42", timeout=5)

    assert result.status == "ok"
    assert result.execution_count == 4


async def test_execute_code_discards_stale_shell_replies():
    stale = _reply("msg-OLD", "ok", 99)
    fresh = _reply("__current__", "ok", 5)
    iopub = _iopub_run(ec=5)
    client = FakeClient([iopub], [], on_execute=[stale, fresh])
    mgr = make_manager({"k1": (FakeKernelManager(client), client)})

    result = await mgr.execute_code("k1", "5", timeout=5)

    assert result.execution_count == 5  # stale reply (other msg_id) discarded


async def test_drains_are_bounded_when_the_client_never_raises():
    """Regression guard: a client whose get_msg never raises must not spin.

    A shared client lives across executions, so the stale-traffic drains run
    on every call. An unbounded drain hung the whole manager on a client that
    did not raise on an empty channel (caught by the #2718 interrupt tests).
    """
    kc = Mock()
    kc.shell_channel.get_msg.return_value = {"msg_type": "execute_reply"}
    kc.get_iopub_msg.return_value = {"msg_type": "status"}

    JupyterManager._drain_shell(kc, max_msgs=10)
    JupyterManager._drain_iopub(kc, max_msgs=10)

    assert kc.shell_channel.get_msg.call_count == 10
    assert kc.get_iopub_msg.call_count == 10


async def test_execute_code_drains_stale_iopub_from_previous_run():
    """A timed-out run leaves its messages in the shared SUB socket; the next
    run must not report them as its own output."""
    stale = _iopub_run(stream_text="OLD\n")
    fresh = _iopub_run(stream_text="NEW\n", ec=2)
    client = FakeClient([fresh], [], stale_iopub=stale)
    mgr = make_manager({"k1": (FakeKernelManager(client), client)})

    result = await mgr.execute_code("k1", "print('NEW')", timeout=5)

    assert result.text_output == "NEW\n"
    assert result.execution_count == 2


async def test_execute_code_ignores_foreign_idle_after_restart():
    """#4481 (C1): with a restart in flight, the restarted kernel publishes its
    own busy/idle cycle. The old code ended the request on that foreign `idle`,
    returned ok / ec=0 / no output, and the caller then wiped the outputs
    already persisted on disk for the cell."""
    foreign = [
        {
            "msg_type": "status",
            "content": {"execution_state": "busy"},
            "parent_header": {"msg_id": "restart-elsewhere"},
        },
        {
            "msg_type": "status",
            "content": {"execution_state": "idle"},
            "parent_header": {"msg_id": "restart-elsewhere"},
        },
    ]
    ours = _iopub_run(stream_text="REAL\n", ec=5)
    client = FakeClient([foreign + ours], [])
    km = FakeKernelManager(client)
    mgr = make_manager({"k1": (km, client)})

    result = await mgr.execute_code("k1", "print('REAL')", timeout=5)

    assert result.status == "ok"
    assert result.execution_count == 5, "a foreign idle must not zero the counter"
    assert result.text_output == "REAL\n", "this request's own output must survive"


async def test_execute_code_reuses_shared_client():
    """#4481 (W3): count the clients the kernel manager hands out -- a mutant
    that restores one fresh ``km.client()`` per execution must turn this red."""
    client = FakeClient([_iopub_run(ec=1), _iopub_run(ec=2)], [])
    km = FakeKernelManager(client)
    # No client in the registry yet: the first execution builds it, the second
    # must reuse it.
    mgr = make_manager({"k1": (km, None)})

    await mgr.execute_code("k1", "1", timeout=5)
    await mgr.execute_code("k1", "2", timeout=5)

    assert mgr._kernel_info["k1"].client is client
    assert km.client_calls == 1, (
        f"one client per kernel expected, got {km.client_calls} -- "
        "a per-execution client leaks the ZMQ context (#4481 D1)"
    )


async def test_stop_kernel_closes_shared_client():
    client = FakeClient([], [])
    km = FakeKernelManager(client)
    km.shutdown_kernel = lambda *a, **kw: None
    mgr = make_manager({"k1": (km, client)})

    assert await mgr.stop_kernel("k1") is True
    assert client.stopped is True
    assert "k1" not in mgr._kernel_info
    assert "k1" not in mgr._kernel_locks


async def test_execute_code_serializes_on_shared_client():
    """Two concurrent executions on one kernel must not poll the same ZMQ
    sockets at once: the second waits for the first's lock."""

    # Plain flags: get_iopub_msg runs in an executor thread, where asyncio
    # primitives (and get_event_loop()) are not usable.
    inner_started = {"flag": False}
    release = {"flag": False}

    class SlowIopubClient(FakeClient):
        def get_iopub_msg(self, timeout=None):
            inner_started["flag"] = True
            if not release["flag"]:
                time.sleep(0.02)
                raise Exception("Empty")  # emulate the poll loop's Empty
            # Hand back the message execute() queued for THIS request: it is
            # stamped with that msg_id, which is what #4481 (C1) correlates on.
            return super().get_iopub_msg(timeout)

    slow = SlowIopubClient([_iopub_run(ec=1), _iopub_run(ec=2)], [])
    mgr = make_manager({"k1": (FakeKernelManager(slow), slow)})

    t1 = asyncio.create_task(mgr.execute_code("k1", "slow()", timeout=30))
    for _ in range(300):
        if inner_started["flag"]:
            break
        await asyncio.sleep(0.01)
    assert inner_started["flag"], "first execution never reached the iopub poll"

    t2 = asyncio.create_task(mgr.execute_code("k1", "fast()", timeout=30))
    await asyncio.sleep(0.2)
    assert not t2.done(), "second execution must be blocked on the kernel lock"
    release["flag"] = True
    r1, r2 = await asyncio.gather(t1, t2)
    assert r1.status == "ok" and r2.status == "ok"


# ---------------------------------------------------------------------------
# working_dir honored
# ---------------------------------------------------------------------------


async def test_start_kernel_forwards_working_dir_as_cwd():
    client = FakeClient([], [])
    km = FakeKernelManager(client)
    mgr = make_manager()

    with tempfile.TemporaryDirectory() as td:
        with patch(
            "papermill_mcp.core.jupyter_manager.KernelManager", return_value=km
        ):
            kid = await mgr.start_kernel("python3", working_dir=td)

    assert km.start_kwargs.get("cwd") == td
    # The handshake client is adopted as the shared client, not leaked.
    assert mgr._kernel_info[kid].client is client


async def test_start_kernel_rejects_missing_working_dir():
    mgr = JupyterManager(MCPConfig())
    with patch(
        "papermill_mcp.core.jupyter_manager.KernelManager",
        return_value=FakeKernelManager(FakeClient([], [])),
    ):
        with pytest.raises(RuntimeError, match="working_dir"):
            await mgr.start_kernel("python3", working_dir=r"C:\definitely\missing\4481")


async def test_manage_kernel_start_passes_working_dir():
    service = KernelService(MCPConfig())
    with patch.object(service, "start_kernel", new_callable=AsyncMock) as mock_start:
        mock_start.return_value = {"kernel_id": "k1", "success": True}
        await service.manage_kernel_consolidated(
            action="start", kernel_name="python3", working_dir=r"D:\workdir"
        )
    mock_start.assert_awaited_once_with("python3", working_dir=r"D:\workdir")


# ---------------------------------------------------------------------------
# Bounded file operations
# ---------------------------------------------------------------------------


async def test_bounded_file_op_times_out():
    # A worker thread cannot be killed: it must finish on its own or the
    # interpreter waits for it at exit. Short sleep, same proof (budget 0.1 s).
    async def stuck():
        await asyncio.sleep(1.0)

    out = await _bounded_file_op(stuck, "read_cells", timeout=0.1)
    assert out["status"] == "timeout"
    assert "timed out" in out["error"]
    assert out["success"] is False


async def test_bounded_file_op_bounds_a_synchronous_body():
    """#4481 (W1): the notebook service bodies are synchronous, so a wait_for
    around the coroutine bounded nothing (measured: a 1e-6 s budget still
    returned a 400-cell notebook). The body now runs in a worker thread, which
    is what makes this assertion able to fail."""
    def slow_sync_read():
        time.sleep(0.5)
        return {"cells": 400}

    started = time.monotonic()
    out = await _bounded_file_op(slow_sync_read, "read_notebook", timeout=0.01)
    elapsed = time.monotonic() - started

    assert out["status"] == "timeout", "a synchronous body must still be bounded"
    assert elapsed < 0.4, f"caller waited {elapsed:.2f}s -- the bound did not bite"


async def test_bounded_file_op_passthrough():
    async def fine():
        return {"cells": 3}

    out = await _bounded_file_op(fine, "read_cells", timeout=5)
    assert out == {"cells": 3}
