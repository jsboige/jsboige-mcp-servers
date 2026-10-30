"""A 4.4 notebook carrying cell IDs must stay writable (CoursIA #23370)."""

import json

import nbformat
import pytest

from papermill_mcp.services.notebook_crud_service import NotebookCRUDService


def _write_minor44(path, with_id=True):
    cell = {"cell_type": "markdown", "source": "# Parameters", "metadata": {}}
    if with_id:
        cell["id"] = "193acf4f"
    path.write_text(
        json.dumps({"nbformat": 4, "nbformat_minor": 4, "metadata": {}, "cells": [cell]}),
        encoding="utf-8",
    )
    return path


@pytest.mark.asyncio
async def test_update_cell_succeeds_on_minor44_notebook_with_ids(tmp_path):
    path = _write_minor44(tmp_path / "n44.ipynb")
    service = NotebookCRUDService(workspace_dir=str(tmp_path))

    result = await service.update_cell("n44.ipynb", 0, "# Parameters\nBATCH_MODE = 'true'\n")

    assert result["success"] is True
    written = nbformat.read(path, as_version=4)
    nbformat.validate(written)
    assert written.nbformat_minor == 5
    assert written.cells[0].id == "193acf4f"


@pytest.mark.asyncio
async def test_minor44_notebook_without_ids_keeps_its_minor(tmp_path):
    path = _write_minor44(tmp_path / "n44_noid.ipynb", with_id=False)
    service = NotebookCRUDService(workspace_dir=str(tmp_path))

    result = await service.update_cell("n44_noid.ipynb", 0, "x")

    assert result["success"] is True
    written = nbformat.read(path, as_version=4)
    assert written.nbformat_minor == 4
