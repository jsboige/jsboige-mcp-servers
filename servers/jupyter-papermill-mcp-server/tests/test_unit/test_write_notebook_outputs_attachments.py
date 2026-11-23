"""
Régression write_notebook : sorties et attachments (correctif vllm#586).

Avant le correctif, `write_notebook` assignait les sorties reçues en dicts
bruts (`cell.outputs = cell_data["outputs"]`) : le writer nbformat v4 lit
`output.output_type` comme attribut et échoue avec
`'dict' object has no attribute 'output_type'` — aucun carnet avec sorties ne
pouvait être écrit. Les attachments des cellules markdown/raw étaient perdus
(la cellule était reconstruite par `new_markdown_cell` sans les reprendre).

Ces tests écrivent via le service puis relisent LE FICHIER depuis le disque :
c'est la relecture disque qui témoigne, pas l'objet en mémoire.
"""

import asyncio
import sys
from pathlib import Path

import nbformat
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from papermill_mcp.services.notebook_crud_service import NotebookCRUDService


def _write(tmp_path, content):
    service = NotebookCRUDService(str(tmp_path))
    return asyncio.run(service.write_notebook("nb.ipynb", content))


def _read_disk(tmp_path):
    return nbformat.read(str(tmp_path / "nb.ipynb"), as_version=4)


def test_code_cell_outputs_survive_roundtrip(tmp_path):
    """Une cellule code avec sorties (stream + execute_result) s'écrit et
    relit depuis le disque avec ses sorties intactes."""
    outputs = [
        {"output_type": "stream", "name": "stdout", "text": "hello\n"},
        {
            "output_type": "execute_result",
            "execution_count": 7,
            "data": {"text/plain": "42"},
            "metadata": {},
        },
    ]
    result = _write(
        tmp_path,
        {
            "cells": [
                {
                    "cell_type": "code",
                    "source": "print('hello')\n42",
                    "metadata": {},
                    "execution_count": 7,
                    "outputs": outputs,
                }
            ],
            "metadata": {},
        },
    )
    assert result["success"] is True

    nb = _read_disk(tmp_path)
    assert len(nb.cells) == 1
    cell = nb.cells[0]
    assert cell.cell_type == "code"
    assert cell.execution_count == 7
    assert len(cell.outputs) == 2
    assert cell.outputs[0].output_type == "stream"
    assert cell.outputs[0].text == "hello\n"
    assert cell.outputs[1].output_type == "execute_result"
    assert cell.outputs[1]["data"]["text/plain"] == "42"


def test_stock_failure_mode_is_gone(tmp_path):
    """Avant le correctif, l'écriture elle-même levait
    AttributeError: 'dict' object has no attribute 'output_type'."""
    result = _write(
        tmp_path,
        {
            "cells": [
                {
                    "cell_type": "code",
                    "source": "x",
                    "metadata": {},
                    "outputs": [
                        {"output_type": "error", "ename": "E", "evalue": "v", "traceback": []}
                    ],
                }
            ],
            "metadata": {},
        },
    )
    assert result["success"] is True
    nb = _read_disk(tmp_path)
    assert nb.cells[0].outputs[0].output_type == "error"


def test_markdown_and_raw_attachments_survive_roundtrip(tmp_path):
    """Les attachments des cellules markdown et raw ne sont plus perdus."""
    att = {"a.png": {"image/png": "iVBORw0KGgo="}}
    result = _write(
        tmp_path,
        {
            "cells": [
                {
                    "cell_type": "markdown",
                    "source": "![a](attachment:a.png)",
                    "metadata": {},
                    "attachments": att,
                },
                {
                    "cell_type": "raw",
                    "source": "raw",
                    "metadata": {},
                    "attachments": {"b.txt": {"text/plain": "b"}},
                },
            ],
            "metadata": {},
        },
    )
    assert result["success"] is True

    nb = _read_disk(tmp_path)
    assert nb.cells[0].cell_type == "markdown"
    assert nb.cells[0]["attachments"]["a.png"]["image/png"] == "iVBORw0KGgo="
    assert nb.cells[1].cell_type == "raw"
    assert nb.cells[1]["attachments"]["b.txt"]["text/plain"] == "b"


def test_cell_ids_preserved(tmp_path):
    """Les ids de cellules transmis sont conservés (contrat nbformat 4.5)."""
    result = _write(
        tmp_path,
        {
            "cells": [
                {"cell_type": "code", "source": "1", "metadata": {}, "id": "cell-one"},
                {"cell_type": "markdown", "source": "2", "metadata": {}, "id": "cell-two"},
            ],
            "metadata": {},
        },
    )
    assert result["success"] is True
    nb = _read_disk(tmp_path)
    assert [c.id for c in nb.cells] == ["cell-one", "cell-two"]


def test_notebook_without_outputs_unchanged(tmp_path):
    """Un carnet sans sorties ni attachments reste écrit correctement."""
    result = _write(
        tmp_path,
        {
            "cells": [
                {"cell_type": "code", "source": "print('x')", "metadata": {}},
                {"cell_type": "markdown", "source": "# t", "metadata": {}},
            ],
            "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3"}},
        },
    )
    assert result["success"] is True
    assert result["cell_count"] == 2
    nb = _read_disk(tmp_path)
    assert nb.metadata.kernelspec.name == "python3"
    assert nb.cells[0].source == "print('x')"
