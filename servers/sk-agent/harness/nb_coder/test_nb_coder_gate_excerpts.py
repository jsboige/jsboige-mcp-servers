# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_gate_excerpts.py
# Source of truth: jsboige/jsboige-mcp-servers since ms#1860.
# -----------------------------------------------------------------------------
#!/usr/bin/env python3
"""Offline tests: gate findings a reviser can act on — 2026-11-22 salvage.

Two grains failed every revision round on a gate whose finding did not say what to fix:
- CoursIA#28104 (coord-refs): the finding read "cross-cell references are inconsistent"
  with the cell index alone; the offender was the provenance note, in the wrong cell and
  with a typographic apostrophe the exemption did not accept.
- CoursIA#27742 (foreign-script): the finding named `cell None` — the hits carried the
  cell and excerpt, the finding dropped them.
Excerpts are verbatim from the built notebooks of runs issue-28104-eda14444 (cell 22) and
issue-27742-a872e2f7 (cell 22). No engine, no MCP, no GitHub."""

import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)

NOTE_28104 = ("la construction de la matrice dans la cellule de code 9.\n\n"
              "> Carnet issu de l’EPIC #26534.")
NAV_28104 = ("le carnet [05 (vérification formelle)](Argumentation-05-Formal-Verification-"
             "Python.ipynb) montre ce que « décider substantivement » veut dire.\n")
FS_27742 = ("## Vérifiez votre compréhension\n\nLes valeurs下列 sont les **observations de "
            "référence Python** publiées par")


def md(src):
    return {"cell_type": "markdown", "metadata": {}, "source": src}


def code(src):
    return {"cell_type": "code", "metadata": {}, "source": src, "execution_count": None,
            "outputs": []}


def nb(path: Path, cells: list) -> Path:
    path.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                                "nbformat_minor": 5}), encoding="utf-8")
    return path


def _gates(tmp_path, built):
    src = nb(tmp_path / "twin.ipynb", [md("# T"), code("x = 1")])
    bp = nb(tmp_path / "built.ipynb", built)
    return {g["gate"]: g for g in D.run_gates(src, bp, create_mode=True)}


def test_the_typographic_apostrophe_is_the_same_provenance_note(tmp_path):
    g = _gates(tmp_path, [md("# T"), code("var x = 1;"), md(NOTE_28104)])["coord-refs"]
    assert g["ok"] is True                     # last markdown cell: the legit footer
    assert D.PROVENANCE_RE.search("> Carnet issu de l'EPIC #26534.")


def test_a_coord_ref_finding_quotes_its_excerpt_and_says_what_the_gate_refuses(tmp_path):
    # 28104: the note sits in cell 2, a navigation cell follows — not the last markdown
    g = _gates(tmp_path, [md("# T"), code("var x = 1;"), md(NOTE_28104), md(NAV_28104)])
    cr = g["coord-refs"]
    assert cr["ok"] is False and cr["detail"]["cells"] == [2]
    assert cr["detail"]["hits"][0]["cell"] == 2 and "EPIC #26534" in cr["detail"]["hits"][0]["excerpt"]
    f, = D.gate_repair_findings({"gates": [cr]})
    assert f["cell"] == 2 and "EPIC #26534" in f["detail"]
    assert "`lane`" in f["detail"] and "DERNIÈRE cellule" in f["detail"]
    assert "renvois entre cellules" not in f["detail"]


def test_a_foreign_script_finding_names_its_cell_and_excerpt(tmp_path):
    g = _gates(tmp_path, [md("# T"), code("var x = 1;"), md(FS_27742), md("fin")])
    fs = g["foreign-script"]
    assert fs["ok"] is False
    f, = D.gate_repair_findings({"gates": [fs]})
    assert f["cell"] == 2 and "valeurs下列" in f["detail"]
    assert "en français" in f["detail"]


def test_each_offending_cell_gets_its_own_finding(tmp_path):
    g = _gates(tmp_path, [md("# T"), code("// see #12373\nvar x = 1;"),
                          md("Suivi par la lane po-2028."), md("fin")])
    cells = [f["cell"] for f in D.gate_repair_findings({"gates": [g["coord-refs"]]})]
    assert cells == [1, 2]


def test_a_secrets_detail_is_never_quoted_back():
    rec = {"gates": [{"gate": "secrets", "ok": False,
                      "detail": {"cells": [3], "hits": [{"cell": 3, "excerpt": "ghp_XXXX"}]}}]}
    f, = D.gate_repair_findings(rec)
    assert f["cell"] == 3 and "extrait fautif" not in f["detail"]
