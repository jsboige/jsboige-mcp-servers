"""Behavioral regression tests for notebook cell identifier preservation."""

import nbformat
import pytest

from papermill_mcp.services.notebook_crud_service import NotebookCRUDService


@pytest.mark.asyncio
@pytest.mark.parametrize("cell_type", ["code", "markdown", "raw"])
async def test_write_read_roundtrip_preserves_supplied_id(tmp_path, cell_type):
    service = NotebookCRUDService(workspace_dir=str(tmp_path))
    content = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [{"cell_type": cell_type, "source": "original", "metadata": {}, "id": "aaaaaaaa"}],
    }
    await service.write_notebook("first.ipynb", content)
    first = nbformat.read(tmp_path / "first.ipynb", as_version=4)
    assert first.cells[0].id == "aaaaaaaa"

    returned = await service.read_notebook("first.ipynb")
    assert returned["cells"][0]["id"] == "aaaaaaaa"
    await service.write_notebook("second.ipynb", returned)
    second = nbformat.read(tmp_path / "second.ipynb", as_version=4)
    nbformat.validate(second)
    assert second.cells[0].id == "aaaaaaaa"
    assert second.cells[0].source == "original"


@pytest.mark.asyncio
async def test_missing_ids_are_generated_and_update_add_preserve_existing_ids(tmp_path):
    service = NotebookCRUDService(workspace_dir=str(tmp_path))
    content = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "cells": [
            {"cell_type": "markdown", "source": "title", "id": "aaaaaaaa"},
            {"cell_type": "code", "source": "original"},
        ],
    }
    await service.write_notebook("generated.ipynb", content)
    before = nbformat.read(tmp_path / "generated.ipynb", as_version=4)
    ids = [cell.id for cell in before.cells]
    assert ids[0] == "aaaaaaaa"
    assert ids[1] and ids[1] != ids[0]

    await service.update_cell("generated.ipynb", 1, "updated")
    await service.add_cell("generated.ipynb", "raw", "new")
    after = nbformat.read(tmp_path / "generated.ipynb", as_version=4)
    nbformat.validate(after)
    assert [cell.id for cell in after.cells[:2]] == ids
    assert after.cells[1].source == "updated"
    assert after.cells[2].id not in ids
