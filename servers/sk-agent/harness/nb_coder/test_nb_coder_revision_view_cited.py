# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# NEW in this tree (27/11): no jsboige/vllm original. The failure class it pins (the
# reviser shown the head of a long notebook, its findings naming cells the cut removed)
# was measured on CoursIA batch o58b, issue #28880 / MGS-23 and MGS-26. This tree is the
# source of truth; the vllm copy of the sibling tests stays frozen at
# 7a09e1caec22441d9402ab25a222206c8905bfe1 — never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Pins for the reviser's view of a LONG notebook (27/11, CoursIA#28880).

`revision_view()` handed the reviser the first 90 000 characters of a 199 554-character
view: 28 cells of 75, the cut landing inside cell 27's source. All 24 findings named cells
5..31, and the reviser declined the one it could not read whole (« la source actuelle de
cette cellule est tronquée dans le message »); the two rounds then rewrote cells 1 and 3,
which no finding names, and the grain was released after a second content failure.

Pinned here: without `cited` the view is exactly the old one; with `cited` the cells the
findings name come first, whole, never cut, even alone over the budget; the cells that do
not fit are NAMED; the prompt states that a cited cell keeps its exact header number; and
the revision loop does pass the findings. No engine, no MCP session, no GitHub.
"""
import json
import re
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as D  # noqa: E402

_HEAD = re.compile(r"=== cellule (\d+) \| code ===\n")


def _long_nb(tmp_path: Path, n: int = 40, chars: int = 3000) -> Path:
    """`n` code cells of about `chars` characters, each ending in a unique marker."""
    cells = []
    for i in range(n):
        head = f"let x{i} = {i}; // "
        tail = f" // TAIL-{i:02d}\n"
        cells.append({"cell_type": "code", "metadata": {}, "execution_count": i + 1,
                      "source": [head + "p" * (chars - len(head) - len(tail)) + tail],
                      "outputs": []})
    path = tmp_path / "long.ipynb"
    path.write_text(json.dumps({"nbformat": 4, "nbformat_minor": 5, "metadata": {},
                                "cells": cells}), encoding="utf-8")
    return path


def _heads(view: str) -> list[int]:
    return [int(x) for x in _HEAD.findall(view)]


def _block_whole(view: str, i: int) -> bool:
    """Cell `i` appears with its last line: nothing of its source was cut."""
    return f" // TAIL-{i:02d}\n" in view


def test_without_cited_the_view_is_the_old_cut(tmp_path: Path):
    view = D.revision_view(_long_nb(tmp_path))
    heads = _heads(view)
    assert view.startswith("=== cellule 0 | code ===\n")
    assert "Ordre de lecture" not in view
    assert heads == list(range(len(heads)))            # notebook order, from the first cell
    assert len(heads) < 40                             # ... and it does not reach the end
    assert view.rstrip().endswith("les 90000 premiers seulement sont affichés.]")
    assert not _block_whole(view, 39)


def test_cited_cells_come_first_whole_and_never_cut(tmp_path: Path):
    path = _long_nb(tmp_path)
    view = D.revision_view(path, cited=[5, 8, 31])
    heads = _heads(view)
    assert heads[:3] == [5, 8, 31]                     # the cited cells lead, ascending
    assert all(_block_whole(view, i) for i in (5, 8, 31))
    assert "(5, 8, 31)" in view and "EN TÊTE et EN ENTIER" in view
    assert heads[3:] == sorted(heads[3:])              # the rest keeps notebook order
    assert not {5, 8, 31} & set(heads[3:])             # ... and cites nothing twice
    assert len(heads) == len(set(heads))
    assert _block_whole(view, 31) and not _block_whole(D.revision_view(path), 31)


def test_cells_that_do_not_fit_are_named_not_dropped(tmp_path: Path):
    view = D.revision_view(_long_nb(tmp_path), max_chars=12_000, cited=[35, 36])
    heads = _heads(view)
    shown_rest = [i for i in heads if i not in (35, 36)]
    assert heads[:2] == [35, 36]
    assert shown_rest == list(range(len(shown_rest)))  # cells 0, 1, 2, ... until the budget
    first_hidden = len(shown_rest)
    hidden = 40 - 2 - len(shown_rest)
    assert hidden > 0
    assert f"NON affichées ({hidden}) — {first_hidden}" in view
    assert first_hidden not in heads
    assert len(view) <= 12_000 + 480                  # the note is the only overshoot


def test_cited_cells_are_never_cut_even_alone_over_budget(tmp_path: Path):
    view = D.revision_view(_long_nb(tmp_path), max_chars=2_000, cited=[7, 9])
    assert _heads(view) == [7, 9]                     # nothing else fits; both stay whole
    assert _block_whole(view, 7) and _block_whole(view, 9)
    assert "Budget de 2000 caractères épuisé : NON affichées (38) — 0, 1, 2" in view
    assert "TRONQUÉ" not in view                       # the old blind cut is not applied


def test_everything_fitting_leaves_no_warning(tmp_path: Path):
    view = D.revision_view(_long_nb(tmp_path, n=4, chars=200), cited=[2, 0])
    assert _heads(view) == [2, 0, 1, 3]
    assert "NON affichées" not in view and "TRONQUÉ" not in view
    assert view.startswith("[Ordre de lecture — les cellules citées par les constats (2, 0)")


def test_out_of_range_duplicate_and_non_integer_citations_are_ignored(tmp_path: Path):
    view = D.revision_view(_long_nb(tmp_path, n=6, chars=200), cited=[3, 3, 999, -1, True, "5"])
    assert _heads(view) == [3, 0, 1, 2, 4, 5]


def test_cited_cells_reads_both_finding_shapes():
    findings = [{"cell": 11}, {"cell": "8"}, {"cells": [10, 5, 5]}, {"cell": None},
                {"cell": True}, {"cell": -3}, "junk", None, {"cells": "31"}]
    assert D.cited_cells(findings) == [5, 8, 10, 11]
    assert D.cited_cells(None) == [] and D.cited_cells([]) == []


def test_the_28880_shape_reaches_the_cells_the_old_view_never_showed(tmp_path: Path):
    """Twelve cited cells at the end of the notebook: the old view stopped before cell 29."""
    path = _long_nb(tmp_path)
    cited = [5, 8, 10, 13, 15, 17, 21, 23, 25, 27, 29, 31]
    assert not _block_whole(D.revision_view(path), 29)
    view = D.revision_view(path, cited=cited)
    assert _heads(view)[:12] == cited
    assert all(_block_whole(view, i) for i in cited)
    assert D.cited_cells([{"cell": c, "severity": "major", "detail": "d"} for c in cited] * 2) == cited


def test_prompt_states_that_a_cited_cell_keeps_its_number():
    prompt = D.revision_prompt({"title": "t", "body": "b"}, "vue du carnet",
                               [{"cell": 5, "severity": "major", "detail": "d"}])
    assert "numéro EXACT de son en-tête" in prompt
    assert "une réponse portant sur une cellule non citée ne corrige aucun constat" in prompt
    assert '"source":"<source COMPLET>"' in prompt   # the schema itself is unchanged


def test_the_revision_loop_passes_the_findings_to_the_view():
    source = Path(D.__file__).read_text(encoding="utf-8")
    assert source.count("revision_view(built_path, cited=cited_cells(findings))") == 1
    assert source.count("revision_view(built_path)") == 0
