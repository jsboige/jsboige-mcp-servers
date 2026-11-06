"""Stale Papermill metadata strip (vendored organ, CoursIA #12722 / #11155).

``execute_notebook_cell`` rewrites a notebook's outputs WITHOUT going through
Papermill, so a ``metadata.papermill`` left by an earlier Papermill pass keeps
dating the fresh outputs to that old run (STALE_BLOCK defect of the CoursIA
ratchet). The persist path must strip the stale blocks (top-level and per-cell,
``papermill`` and ``execution`` wrappers) via the shared organ -- never strip
after a real Papermill run, whose block is fresh.
"""

import json

import pytest
from unittest.mock import AsyncMock, patch

from papermill_mcp.config import MCPConfig
from papermill_mcp.core.jupyter_manager import ExecutionOutput, ExecutionResult
from papermill_mcp.services.kernel_service import KernelService
from papermill_mcp.utils.file_utils import FileUtils
from papermill_mcp.utils.papermill_meta import strip_stale_papermill_metadata


def test_strip_removes_stale_blocks_on_plain_dicts():
    """Unit check of the vendored organ itself (dict-likes, no nbformat)."""
    nb = {
        "metadata": {
            "kernelspec": {"name": "python3"},
            "papermill": {"start_time": "2026-08-20T10:00:00", "duration": 12.3},
            "execution": {"iopub.status.busy": "2026-08-20T10:00:00"},
        },
        "cells": [
            {
                "cell_type": "code",
                "metadata": {
                    "papermill": {"start_time": "2026-08-20T10:00:00", "duration": 1.0},
                    "execution": {"iopub.status.idle": "2026-08-20T10:00:01"},
                },
            },
            {"cell_type": "markdown", "metadata": {}},
            {"cell_type": "code"},  # no metadata key at all
        ],
    }

    strip_stale_papermill_metadata(nb)

    assert "papermill" not in nb["metadata"]
    assert "execution" not in nb["metadata"]
    assert nb["metadata"]["kernelspec"] == {"name": "python3"}
    assert nb["cells"][0]["metadata"] == {}
    assert nb["cells"][1]["metadata"] == {}
    assert nb["cells"][2] == {"cell_type": "code"}


def test_strip_is_inert_on_a_clean_notebook():
    nb = {
        "metadata": {"kernelspec": {"name": "python3"}},
        "cells": [{"cell_type": "code", "metadata": {"tags": ["keep"]}}],
    }
    before = json.dumps(nb, sort_keys=True)

    strip_stale_papermill_metadata(nb)

    assert json.dumps(nb, sort_keys=True) == before


def _notebook_with_stale_blocks(path):
    """A notebook whose latest run was a Papermill pass, then partially
    re-executed by hand: every wrapper the organ targets is present."""
    nb = FileUtils.create_empty_notebook("python3")
    nb = FileUtils.add_cell(nb, "code", "print('hello')")
    nb = FileUtils.add_cell(nb, "code", "1 + 1")
    nb.metadata.papermill = {
        "start_time": "2026-08-20T10:00:00",
        "end_time": "2026-08-20T10:02:30",
        "duration": 150.0,
        "exception": None,
    }
    for cell in nb.cells:
        cell.metadata.execution = {"iopub.status.busy": "2026-08-20T10:00:00"}
        cell.metadata.papermill = {"start_time": "2026-08-20T10:00:00", "duration": 5.0}
    FileUtils.write_notebook(nb, path)
    return path


@pytest.mark.asyncio
async def test_cell_persist_strips_stale_papermill_metadata(tmp_path):
    """The defect the organ exists for: a kernel-cell rewrite must not leave
    the previous Papermill pass's blocks dating the fresh outputs."""
    path = _notebook_with_stale_blocks(tmp_path / "stale.ipynb")
    service = KernelService(MCPConfig())
    result = ExecutionResult(
        status="ok",
        execution_count=42,
        outputs=[
            ExecutionOutput(
                output_type="stream", content={"name": "stdout", "text": "hello\n"}
            )
        ],
        text_output="hello\n",
    )
    with patch.object(
        service.jupyter_manager, "execute_code", new_callable=AsyncMock
    ) as mock_exec:
        mock_exec.return_value = result
        out = await service.execute_notebook_cell(str(path), 0, "k1", timeout=5)

    assert out["persisted"]["written"] is True
    stripped = out["persisted"]["stale_papermill_metadata_stripped"]
    assert "metadata.papermill" in stripped
    assert "cells[0].metadata.execution" in stripped
    assert "cells[1].metadata.papermill" in stripped

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    # Top-level: the stale Papermill pass is gone, the kernelspec survives.
    assert "papermill" not in on_disk["metadata"]
    assert "kernelspec" in on_disk["metadata"]
    # Per-cell: no wrapper of the old pass remains on ANY cell.
    for cell in on_disk["cells"]:
        assert "papermill" not in cell.get("metadata", {})
        assert "execution" not in cell.get("metadata", {})
    # The fresh outputs of THIS run are what the notebook now carries.
    cell0 = on_disk["cells"][0]
    assert cell0["execution_count"] == 42
    text = cell0["outputs"][0]["text"]
    assert (text if isinstance(text, str) else "".join(text)) == "hello\n"


@pytest.mark.asyncio
async def test_cell_persist_clean_notebook_reports_empty_strip(tmp_path):
    """A notebook that never met Papermill: nothing stripped, nothing lost."""
    path = tmp_path / "clean.ipynb"
    nb = FileUtils.create_empty_notebook("python3")
    nb = FileUtils.add_cell(nb, "code", "print('clean')")
    FileUtils.write_notebook(nb, path)

    service = KernelService(MCPConfig())
    result = ExecutionResult(
        status="ok",
        execution_count=3,
        outputs=[],
        text_output="",
    )
    with patch.object(
        service.jupyter_manager, "execute_code", new_callable=AsyncMock
    ) as mock_exec:
        mock_exec.return_value = result
        out = await service.execute_notebook_cell(str(path), 0, "k1", timeout=5)

    assert out["persisted"]["written"] is True
    assert out["persisted"]["stale_papermill_metadata_stripped"] == []

    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert "kernelspec" in on_disk["metadata"]
    assert on_disk["cells"][0]["execution_count"] == 3
