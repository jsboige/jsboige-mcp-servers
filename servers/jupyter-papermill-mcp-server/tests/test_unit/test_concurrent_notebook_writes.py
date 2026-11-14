"""
Regression tests for #4716 (second defect): concurrent notebook writes.

Measured 14/11 by ai-01:vllm at the tool layer: three parallel writes on the
same notebook (two update_cell + one add_cell) all report success, but the
edits are silently dropped -- each mutating method does
read -> mutate -> write with no serialization, so the last writer wins and
the others' edits are lost.

The production topology is: one OS thread per MCP tool call (asyncio.to_thread
driving asyncio.run on a fresh per-thread loop), all sharing one
NotebookCRUDService. These tests reproduce that topology directly.

The schedule is deterministic (no sleeps racing each other):

- writer A parks AFTER its read and BEFORE its write, until writer B has
  both read the same (still pre-A) file state and COMPLETED its own write;
- writer B then reads, mutates and writes.

On unfixed code B builds on stale state and its completed edit is then
overwritten by A's parked write -- one edit silently lost, both writers
reporting success. On fixed code (per-path lock in NotebookCRUDService)
B's read cannot start while A holds the path lock, so A's park times out
(3 s), A completes alone, then B re-reads the post-A state: both edits
survive. The park also keeps the two physical writes strictly ordered on
unfixed code, so Windows cannot turn the RED phase into a PermissionError
race between two simultaneous opens of the same file.
"""

import asyncio
import os
import threading
import time

import nbformat
import pytest

from papermill_mcp.services.notebook_crud_service import NotebookCRUDService
from papermill_mcp.utils.file_utils import FileUtils


@pytest.fixture
def crud_service(temp_dir):
    return NotebookCRUDService(workspace_dir=str(temp_dir))


def _make_notebook_with_cells(crud_service, name):
    """Set up a 2-cell notebook using the real (unpatched) FileUtils."""
    asyncio.run(crud_service.create_notebook(name, kernel="python3"))
    asyncio.run(crud_service.add_cell(name, "code", "cell-0"))
    asyncio.run(crud_service.add_cell(name, "code", "cell-1"))


def test_concurrent_update_and_add_lose_no_edits(
    crud_service, temp_dir, monkeypatch
):
    """update_cell + add_cell racing on one path: both edits must survive."""
    name = "race.ipynb"
    _make_notebook_with_cells(crud_service, name)

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
            # after its read until the SECOND writer has fully written. On
            # unfixed code this reproduces the measured lost-update (A then
            # overwrites B's completed edit). Under a per-path lock B cannot
            # even read while A holds the lock, so the wait times out and A
            # proceeds alone -- and the two physical writes never overlap.
            second_write_done.wait(timeout=3.0)
        result = real_write(notebook, path)
        if not is_first_write:
            second_write_done.set()
        return result

    monkeypatch.setattr(FileUtils, "read_notebook", staticmethod(sched_read))
    monkeypatch.setattr(FileUtils, "write_notebook", staticmethod(sched_write))

    results = {}
    errors = {}

    def run_update():
        try:
            results["update"] = asyncio.run(
                crud_service.update_cell(name, 0, "updated-by-task-1")
            )
        except BaseException as exc:  # pragma: no cover - diagnostic only
            errors["update"] = exc

    def run_add():
        try:
            results["add"] = asyncio.run(
                crud_service.add_cell(name, "markdown", "added-by-task-2")
            )
        except BaseException as exc:  # pragma: no cover - diagnostic only
            errors["add"] = exc

    thread_update = threading.Thread(target=run_update)
    thread_update.start()

    # Start the second writer only once the first one has read the file.
    deadline = time.monotonic() + 10.0
    while not first_read.is_set():
        if time.monotonic() > deadline:
            thread_update.join(timeout=5.0)
            pytest.fail("update_cell never read the notebook within 10 s")
        time.sleep(0.005)

    thread_add = threading.Thread(target=run_add)
    thread_add.start()

    thread_update.join(timeout=60.0)
    thread_add.join(timeout=60.0)
    assert not thread_update.is_alive() and not thread_add.is_alive(), (
        "a writer thread is still running: possible deadlock in the "
        "serialization mechanism"
    )
    assert not errors, f"writer raised: {errors!r}"
    assert results["update"]["success"], results["update"]
    assert results["add"]["success"], results["add"]

    final = nbformat.read(str(temp_dir / name), as_version=4)
    sources = [cell.source for cell in final.cells]
    assert "updated-by-task-1" in sources, (
        "update_cell edit was lost: concurrent writers on the same notebook "
        "still race (last writer wins) -- #4716 second defect"
    )
    assert "added-by-task-2" in sources, (
        "add_cell edit was lost: concurrent writers on the same notebook "
        "still race (last writer wins) -- #4716 second defect"
    )
    # Sanity: the untouched cell survived too.
    assert "cell-1" in sources


def test_write_lock_is_per_path(crud_service, temp_dir):
    """The lock registry keys by resolved path: same path -> same lock,
    different paths -> different locks, and the lock is free after use."""
    lock_a1 = crud_service._lock_for(os.path.join(str(temp_dir), "a.ipynb"))
    lock_a2 = crud_service._lock_for(os.path.join(str(temp_dir), "a.ipynb"))
    lock_b = crud_service._lock_for(os.path.join(str(temp_dir), "b.ipynb"))

    assert lock_a1 is lock_a2, "same notebook path must share one lock"
    assert lock_a1 is not lock_b, "different notebooks must not share a lock"

    # The lock is a plain (non-reentrant) lock and is currently free.
    assert lock_a1.acquire(blocking=False), "lock must be free between writers"
    lock_a1.release()


@pytest.mark.skipif(os.name != "nt", reason="normcase is case-folding on Windows only")
def test_write_lock_folds_path_case(crud_service, temp_dir):
    """Windows paths are case-insensitive: 'A.ipynb' and 'a.ipynb' are the
    same notebook and must share one lock."""
    upper = crud_service._lock_for(os.path.join(str(temp_dir), "A.IPYNB"))
    lower = crud_service._lock_for(os.path.join(str(temp_dir), "a.ipynb"))
    assert upper is lower, "case variants of one path must share one lock"
