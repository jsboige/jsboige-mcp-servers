"""#4969 -- ``update_cell`` must echo the cell it wrote and accept id addressing.

The CoursIA lane lost the content of 18 cells out of 30: it addressed every
write by an index map built before the batch, the map had gone stale, and the
server faithfully overwrote whatever sat at the requested index without ever
saying which cell that was. The four invariants measured on the minimal repro
(write lands at the requested index, cell id preserved, source kept byte for
byte, out-of-range refused loudly) are frozen here, next to the three
behaviours added to make a fine addressing error detectable:

* ``cell_id`` addressing, immune to an index shift caused by an insertion;
* an echo of the written cell (``index``, ``id``, ``previous_source``);
* ``dry_run``, which validates the addressing without writing.
"""

import hashlib

import nbformat
import pytest

from papermill_mcp.services.notebook_crud_service import NotebookCRUDService

REPRO_CELLS = [
    {"cell_type": "code", "source": "A", "id": "4387fdaa"},
    {"cell_type": "code", "source": "B", "id": "cfedaca8"},
    {"cell_type": "markdown", "source": "## C", "id": "066dca13"},
]


async def _seed_repro(tmp_path):
    service = NotebookCRUDService(workspace_dir=str(tmp_path))
    await service.write_notebook(
        "repro.ipynb",
        {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": REPRO_CELLS},
    )
    return service


def _read(tmp_path, name="repro.ipynb"):
    return nbformat.read(tmp_path / name, as_version=4)


@pytest.mark.asyncio
async def test_update_by_index_echoes_written_cell_and_preserves_id(tmp_path):
    service = await _seed_repro(tmp_path)

    result = await service.update_cell("repro.ipynb", 1, 'print("B2")')

    assert result["success"] is True
    assert result["index"] == 1
    assert result["updated_index"] == 1
    assert result["id"] == "cfedaca8"
    assert result["previous_source"] == "B"
    assert result["dry_run"] is False

    written = _read(tmp_path)
    assert written.cells[1].source == 'print("B2")'
    assert written.cells[1].id == "cfedaca8"


@pytest.mark.asyncio
async def test_update_by_cell_id_follows_the_cell_after_an_insertion(tmp_path):
    service = await _seed_repro(tmp_path)
    await service.add_cell("repro.ipynb", "code", 'print("D")', index=1)

    result = await service.update_cell("repro.ipynb", cell_id="cfedaca8", source='print("B3")')

    assert result["index"] == 2
    assert result["id"] == "cfedaca8"
    assert result["previous_source"] == "B"

    written = _read(tmp_path)
    assert [cell.source for cell in written.cells] == ["A", 'print("D")', 'print("B3")', "## C"]
    assert written.cells[0].id == "4387fdaa"
    assert written.cells[2].id == "cfedaca8"
    assert written.cells[3].id == "066dca13"

    # Control: the stale index the caller would have used (1) now designates
    # the inserted cell, which is exactly how the 18 cells were lost.
    stale = await service.read_cells("repro.ipynb", mode="single", index=1)
    assert stale["cell"]["id"] != "cfedaca8"


@pytest.mark.asyncio
async def test_matching_index_and_cell_id_are_accepted(tmp_path):
    service = await _seed_repro(tmp_path)

    result = await service.update_cell("repro.ipynb", index=1, cell_id="cfedaca8", source="B2")

    assert result["success"] is True
    assert result["index"] == 1
    assert _read(tmp_path).cells[1].source == "B2"


@pytest.mark.asyncio
async def test_mismatched_index_and_cell_id_are_refused_without_writing(tmp_path):
    service = await _seed_repro(tmp_path)
    before = (tmp_path / "repro.ipynb").read_bytes()

    with pytest.raises(IndexError, match="Addressing mismatch"):
        await service.update_cell("repro.ipynb", index=0, cell_id="cfedaca8", source="X")

    assert (tmp_path / "repro.ipynb").read_bytes() == before


@pytest.mark.asyncio
async def test_no_address_is_refused(tmp_path):
    service = await _seed_repro(tmp_path)

    with pytest.raises(ValueError, match="either 'index' or 'cell_id'"):
        await service.update_cell("repro.ipynb", source="X")


@pytest.mark.asyncio
async def test_unknown_cell_id_is_refused_and_lists_available_ids(tmp_path):
    service = await _seed_repro(tmp_path)
    before = (tmp_path / "repro.ipynb").read_bytes()

    with pytest.raises(ValueError, match="not found in notebook"):
        await service.update_cell("repro.ipynb", cell_id="deadbeef", source="X")

    assert (tmp_path / "repro.ipynb").read_bytes() == before


@pytest.mark.asyncio
async def test_dry_run_validates_the_address_and_writes_nothing(tmp_path):
    service = await _seed_repro(tmp_path)
    await service.add_cell("repro.ipynb", "code", 'print("D")', index=1)
    before = (tmp_path / "repro.ipynb").read_bytes()

    result = await service.update_cell("repro.ipynb", cell_id="cfedaca8", dry_run=True)

    assert result["success"] is True
    assert result["dry_run"] is True
    assert result["index"] == 2
    assert result["id"] == "cfedaca8"
    assert result["previous_source"] == "B"
    assert (tmp_path / "repro.ipynb").read_bytes() == before


@pytest.mark.asyncio
async def test_dry_run_still_refuses_a_mismatched_address(tmp_path):
    service = await _seed_repro(tmp_path)

    with pytest.raises(IndexError, match="Addressing mismatch"):
        await service.update_cell("repro.ipynb", index=2, cell_id="cfedaca8", dry_run=True)


@pytest.mark.asyncio
async def test_source_is_required_outside_dry_run(tmp_path):
    service = await _seed_repro(tmp_path)
    before = (tmp_path / "repro.ipynb").read_bytes()

    with pytest.raises(ValueError, match="requires 'source'"):
        await service.update_cell("repro.ipynb", index=1)

    assert (tmp_path / "repro.ipynb").read_bytes() == before


@pytest.mark.asyncio
async def test_out_of_range_index_is_still_refused_loudly(tmp_path):
    service = await _seed_repro(tmp_path)
    before = (tmp_path / "repro.ipynb").read_bytes()

    with pytest.raises(IndexError, match=r"Cell index 10 out of range \(0-2\)"):
        await service.update_cell("repro.ipynb", 10, "x")

    assert (tmp_path / "repro.ipynb").read_bytes() == before


@pytest.mark.asyncio
async def test_trailing_newline_is_preserved_byte_for_byte(tmp_path):
    service = await _seed_repro(tmp_path)
    source = "print('one')\nprint('two')\n"

    result = await service.update_cell("repro.ipynb", 1, source)

    assert result["previous_source"] == "B"
    assert _read(tmp_path).cells[1].source == source


@pytest.mark.asyncio
async def test_echo_carries_the_sha256_of_the_overwritten_source(tmp_path):
    service = await _seed_repro(tmp_path)

    result = await service.update_cell("repro.ipynb", 1, 'print("B2")')

    assert result["previous_sha256"] == hashlib.sha256(b"B").hexdigest()
    assert result["new_sha256"] == hashlib.sha256(b'print("B2")').hexdigest()
    assert result["previous_source_truncated"] is False


@pytest.mark.asyncio
async def test_echo_hash_identifies_the_cell_that_was_actually_overwritten(tmp_path):
    """The whole point of the echo: with a stale index map, the hash says
    exactly which content was lost. The hash identifies that content; restoring
    it takes a copy kept upstream, or ``previous_source`` when it is not
    truncated."""
    service = await _seed_repro(tmp_path)
    await service.add_cell("repro.ipynb", "code", 'print("D")', index=1)

    # The caller still believes the target cell sits at index 1.
    stale = await service.update_cell("repro.ipynb", 1, 'print("WRONG")')

    assert stale["id"] != "cfedaca8"
    assert stale["previous_sha256"] == hashlib.sha256(b'print("D")').hexdigest()
    assert stale["previous_sha256"] != hashlib.sha256(b"B").hexdigest()

    # Addressing by id lands on the intended cell and says so.
    addressed = await service.update_cell(
        "repro.ipynb", cell_id="cfedaca8", source='print("B3")'
    )
    assert addressed["previous_sha256"] == hashlib.sha256(b"B").hexdigest()


@pytest.mark.asyncio
async def test_long_previous_source_is_bounded_but_its_hash_is_not(tmp_path):
    service = await _seed_repro(tmp_path)
    long_source = "x" * 5000
    await service.update_cell("repro.ipynb", 1, long_source)

    result = await service.update_cell("repro.ipynb", 1, "short")

    assert result["previous_source_truncated"] is True
    assert len(result["previous_source"]) == 4000
    assert result["previous_sha256"] == hashlib.sha256(long_source.encode()).hexdigest()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "length, expect_truncated",
    [(3999, False), (4000, False), (4001, True)],
)
async def test_truncation_boundary_is_exact(tmp_path, length, expect_truncated):
    """The bound is on CHARACTERS, and it is exact: a source of exactly the
    limit is not truncated, one character more is."""
    service = await _seed_repro(tmp_path)
    await service.update_cell("repro.ipynb", 1, "y" * length)

    result = await service.update_cell("repro.ipynb", 1, "short")

    assert result["previous_source_truncated"] is expect_truncated
    assert len(result["previous_source"]) == min(length, 4000)
    assert result["previous_sha256"] == hashlib.sha256(("y" * length).encode()).hexdigest()


@pytest.mark.asyncio
async def test_the_hash_is_over_the_utf8_encoding_of_the_source(tmp_path):
    """The fingerprint is the sha256 of the source encoded in UTF-8, so a
    non-ASCII source is identified by its bytes, not by its code points."""
    service = await _seed_repro(tmp_path)
    source = 'print("é中文")'

    result = await service.update_cell("repro.ipynb", 1, source)

    # previous = what was there ("B"), new = what was written.
    assert result["previous_sha256"] == hashlib.sha256(b"B").hexdigest()
    assert result["new_sha256"] == hashlib.sha256(source.encode("utf-8")).hexdigest()
    assert result["previous_source"] == "B"

    # The fingerprint of the written cell, read back, is the one reported.
    again = await service.update_cell("repro.ipynb", 1, "after")
    assert again["previous_sha256"] == result["new_sha256"]
    assert again["previous_source"] == source


@pytest.mark.asyncio
async def test_an_empty_previous_source_is_reported_as_such(tmp_path):
    """An empty cell that gets overwritten is not 'nothing to report': the
    empty source has a fingerprint of its own, distinct from a missing one."""
    service = await _seed_repro(tmp_path)
    await service.update_cell("repro.ipynb", 1, "")

    result = await service.update_cell("repro.ipynb", 1, "x")

    assert result["previous_source"] == ""
    assert result["previous_source_truncated"] is False
    assert result["previous_sha256"] == hashlib.sha256(b"").hexdigest()


@pytest.mark.asyncio
async def test_dry_run_echo_has_no_new_hash(tmp_path):
    service = await _seed_repro(tmp_path)

    result = await service.update_cell("repro.ipynb", 1, dry_run=True)

    assert result["previous_sha256"] == hashlib.sha256(b"B").hexdigest()
    assert result["new_sha256"] is None


@pytest.mark.asyncio
async def test_the_hash_chain_is_stable_across_successive_writes(tmp_path):
    """The point of hashing the full source: the fingerprint of what a write
    left behind is the fingerprint the next write reports as overwritten, so a
    caller can audit a whole chain of edits without re-reading the notebook."""
    service = await _seed_repro(tmp_path)

    first = await service.update_cell("repro.ipynb", 1, 'print("B2")\n')
    second = await service.update_cell("repro.ipynb", 1, 'print("B3")')

    assert second["previous_sha256"] == first["new_sha256"]
    assert first["new_sha256"] == hashlib.sha256(b'print("B2")\n').hexdigest()
    assert second["new_sha256"] == hashlib.sha256(b'print("B3")').hexdigest()


@pytest.mark.asyncio
async def test_registered_tool_exposes_the_new_contract_end_to_end(tmp_path, monkeypatch):
    import inspect

    from mcp.server.fastmcp import FastMCP

    import papermill_mcp.tools.notebook_tools as notebook_tools
    from papermill_mcp.config import MCPConfig
    from papermill_mcp.tools.notebook_tools import (
        initialize_notebook_tools,
        register_notebook_tools,
    )

    # The #4481 transport guard runs the service coroutine on a loop it owns in
    # a worker thread; other test modules patch nest_asyncio process-wide, which
    # makes that loop unusable depending on collection order. The guard has its
    # own tests, so this one exercises the tool contract on a plain passthrough.
    async def _passthrough(op, op_name, timeout=None):
        result = op()
        return await result if inspect.isawaitable(result) else result

    monkeypatch.setattr(notebook_tools, "_bounded_file_op", _passthrough)

    service = await _seed_repro(tmp_path)
    await service.add_cell("repro.ipynb", "code", 'print("D")', index=1)
    before = (tmp_path / "repro.ipynb").read_bytes()

    initialize_notebook_tools(MCPConfig())
    app = FastMCP("test_update_cell")
    register_notebook_tools(app)
    tool = app._tool_manager.get_tool("update_cell")

    assert {"path", "index", "source", "cell_id", "dry_run"} <= set(
        tool.parameters["properties"]
    )

    preview = await tool.run(
        {"path": str(tmp_path / "repro.ipynb"), "cell_id": "cfedaca8", "dry_run": True},
        None,
        None,
    )
    assert preview["dry_run"] is True
    assert preview["index"] == 2
    assert preview["previous_source"] == "B"
    assert preview["previous_sha256"] == hashlib.sha256(b"B").hexdigest()
    assert preview["new_sha256"] is None
    assert (tmp_path / "repro.ipynb").read_bytes() == before

    written = await tool.run(
        {
            "path": str(tmp_path / "repro.ipynb"),
            "cell_id": "cfedaca8",
            "source": 'print("B3")',
        },
        None,
        None,
    )
    assert written["success"] is True
    assert written["id"] == "cfedaca8"
    assert written["previous_source"] == "B"
    assert written["previous_source_truncated"] is False
    assert written["previous_sha256"] == hashlib.sha256(b"B").hexdigest()
    assert written["new_sha256"] == hashlib.sha256(b'print("B3")').hexdigest()
    assert _read(tmp_path).cells[2].source == 'print("B3")'

    refused = await tool.run(
        {"path": str(tmp_path / "repro.ipynb"), "index": 0, "cell_id": "cfedaca8", "source": "X"},
        None,
        None,
    )
    assert refused["success"] is False
    assert "Addressing mismatch" in refused["error"]
