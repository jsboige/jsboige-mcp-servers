"""
Regression tests for #4716 (third defect): kernel output persistence races
the CRUD mutators.

Relayed 14/11 23:14Z by ai-01 after merging ms#1764: the persistence cycle
in KernelService._persist_cell_execution (read at kernel_service.py:636,
write at :688 on the pre-fix tree) does read -> mutate -> write on the
.ipynb WITHOUT the per-path lock ms#1764 added to NotebookCRUDService. The
CRUD-against-execution race therefore stays open on one notebook -- exactly
the nb-coder flow, where the model add_cell/update_cell while the harness
persists the outputs of the cell it just executed.

The production topology is one OS thread per MCP tool call; the persistence
runs on asyncio.to_thread. These tests reproduce that topology directly.

The schedule is deterministic (same shape as
test_concurrent_notebook_writes.py, ms#1764):

- writer A (persistence) parks AFTER its read and BEFORE its write, until
  writer B (update_cell) has both read the same (still pre-A) file state
  and COMPLETED its own write;
- writer B then reads, mutates and writes.

On unfixed code A's parked write then overwrites B's completed edit with
A's stale snapshot -- the update is silently lost while both callers report
success. On fixed code (persistence takes the CRUD per-path lock) B cannot
read while A holds the lock, so A's park times out (3 s), A completes
alone, then B re-reads the post-A state: both edits survive. The park also
keeps the two physical writes strictly ordered on unfixed code, so Windows
cannot turn the RED phase into a PermissionError race.
"""

import asyncio
import os
import threading
import time

import nbformat
import pytest

from papermill_mcp.config import MCPConfig
from papermill_mcp.core.jupyter_manager import ExecutionOutput, ExecutionResult
from papermill_mcp.services.kernel_service import KernelService
from papermill_mcp.services.notebook_crud_service import NotebookCRUDService
from papermill_mcp.utils.file_utils import FileUtils


@pytest.fixture
def crud_service(temp_dir):
    return NotebookCRUDService(workspace_dir=str(temp_dir))


@pytest.fixture
def kernel_service(crud_service):
    # The server wiring (main.py): persistence shares the CRUD lock map.
    # On the pre-fix tree the wiring argument does not exist yet: build the
    # standalone service so the RACE test below fails on the measured
    # lost-update itself, not on a fixture TypeError.
    try:
        return KernelService(MCPConfig(), notebook_crud=crud_service)
    except TypeError:
        return KernelService(MCPConfig())


def _make_notebook_with_cells(crud_service, name):
    """Set up a 2-cell notebook using the real (unpatched) FileUtils."""
    asyncio.run(crud_service.create_notebook(name, kernel="python3"))
    asyncio.run(crud_service.add_cell(name, "code", "cell-0"))
    asyncio.run(crud_service.add_cell(name, "code", "cell-1"))


def test_persist_vs_update_cell_lose_no_edits(
    crud_service, kernel_service, temp_dir, monkeypatch
):
    """Output persistence + update_cell racing on one notebook: both the
    persisted outputs and the CRUD edit must survive."""
    name = "race-persist.ipynb"
    _make_notebook_with_cells(crud_service, name)

    cell_result = ExecutionResult(
        status="ok",
        execution_count=1,
        outputs=[
            ExecutionOutput(
                output_type="stream",
                content={"name": "stdout", "text": "persisted-output"},
            )
        ],
        text_output="persisted-output",
    )

    real_read = FileUtils.read_notebook
    real_write = FileUtils.write_notebook

    reads = {"n": 0}
    writes = {"n": 0}
    first_read = threading.Event()
    second_write_done = threading.Event()

    def sched_read(path):
        notebook = real_read(path)
        reads["n"] += 1
        if reads["n"] == 1:
            first_read.set()
        return notebook

    def sched_write(notebook, path):
        is_first_write = writes["n"] == 0
        writes["n"] += 1
        if is_first_write:
            # Deterministic production interleaving: park the FIRST writer
            # (the persistence) after its read until the SECOND writer
            # (update_cell) has fully written. On unfixed code this
            # reproduces the relayed lost-update (A then overwrites B's
            # completed edit with its stale snapshot). Under the per-path
            # lock B cannot even read while A holds the lock, so the wait
            # times out and A proceeds alone -- the two physical writes
            # never overlap.
            second_write_done.wait(timeout=3.0)
        result = real_write(notebook, path)
        if not is_first_write:
            second_write_done.set()
        return result

    monkeypatch.setattr(FileUtils, "read_notebook", staticmethod(sched_read))
    monkeypatch.setattr(FileUtils, "write_notebook", staticmethod(sched_write))

    results = {}
    errors = {}

    def run_persist():
        try:
            results["persist"] = kernel_service._persist_cell_execution(
                str(temp_dir / name),
                cell_index=1,
                expected_source="cell-1",
                cell_result=cell_result,
            )
        except BaseException as exc:  # pragma: no cover - diagnostic only
            errors["persist"] = exc

    def run_update():
        try:
            results["update"] = asyncio.run(
                crud_service.update_cell(name, 0, "updated-by-crud")
            )
        except BaseException as exc:  # pragma: no cover - diagnostic only
            errors["update"] = exc

    thread_persist = threading.Thread(target=run_persist)
    thread_persist.start()

    # Start the CRUD writer only once the persistence has read the file.
    deadline = time.monotonic() + 10.0
    while not first_read.is_set():
        if time.monotonic() > deadline:
            thread_persist.join(timeout=5.0)
            pytest.fail("persistence never read the notebook within 10 s")
        time.sleep(0.005)

    thread_update = threading.Thread(target=run_update)
    thread_update.start()

    thread_persist.join(timeout=60.0)
    thread_update.join(timeout=60.0)
    assert not thread_persist.is_alive() and not thread_update.is_alive(), (
        "a writer thread is still running: possible deadlock in the "
        "serialization mechanism"
    )
    assert not errors, f"writer raised: {errors!r}"
    assert results["persist"]["written"], results["persist"]
    assert results["update"]["success"], results["update"]

    final = nbformat.read(str(temp_dir / name), as_version=4)
    sources = [cell.source for cell in final.cells]
    assert "updated-by-crud" in sources, (
        "update_cell edit was lost: the kernel output persistence still "
        "races the CRUD mutators on the same notebook -- #4716 third defect"
    )
    assert "cell-1" in sources, "persistence target cell vanished"
    persisted_texts = [
        out.get("text", "")
        for out in final.cells[1].get("outputs", [])
        if out.get("output_type") == "stream"
    ]
    assert any("persisted-output" in t for t in persisted_texts), (
        "persisted outputs were lost: the CRUD edit still clobbers the "
        "persistence write -- #4716 third defect"
    )


def test_path_write_lock_shares_the_crud_registry(crud_service, temp_dir):
    """path_write_lock must key IDENTICALLY to the CRUD mutators' own lock:
    same lock object for the same notebook, whether the caller passes the
    workspace-relative name or the absolute path -- a divergent key would
    silently guard nothing."""
    name = "keying.ipynb"
    via_relative = crud_service.path_write_lock(name)
    via_absolute = crud_service.path_write_lock(str(temp_dir / name))
    internal = crud_service._lock_for(crud_service.resolve_path(name))
    other = crud_service.path_write_lock("other.ipynb")

    assert via_relative is via_absolute, (
        "relative and absolute forms of one notebook must share one lock"
    )
    assert via_relative is internal, (
        "path_write_lock must return the CRUD mutators' own lock instance"
    )
    assert via_relative is not other, "different notebooks must not share a lock"
    assert via_relative.acquire(blocking=False), "lock must be free between writers"
    via_relative.release()


def test_persistence_without_crud_still_writes(kernel_service_factory, temp_dir):
    """Standalone KernelService (no notebook_crud, legacy/test callers):
    persistence still writes, unserialized -- the None wiring must not
    regress the path, only leave it unlocked."""
    crud = NotebookCRUDService(workspace_dir=str(temp_dir))
    _make_notebook_with_cells(crud, "standalone.ipynb")
    service = kernel_service_factory()
    info = service._persist_cell_execution(
        str(temp_dir / "standalone.ipynb"),
        cell_index=0,
        expected_source="cell-0",
        cell_result=ExecutionResult(
            status="ok",
            execution_count=1,
            outputs=[
                ExecutionOutput(
                    output_type="stream",
                    content={"name": "stdout", "text": "solo"},
                )
            ],
        ),
    )
    assert info["written"], info
    final = nbformat.read(str(temp_dir / "standalone.ipynb"), as_version=4)
    assert final.cells[0].outputs, "standalone persistence wrote no outputs"


@pytest.fixture
def kernel_service_factory():
    """A standalone KernelService without the CRUD wiring."""

    def _make():
        return KernelService(MCPConfig())

    return _make
