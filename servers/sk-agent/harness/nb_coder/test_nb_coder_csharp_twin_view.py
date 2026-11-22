#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_csharp_twin_view.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Offline pins for the C# twin reference (user 22/11: « Pour les jumeaux Rust, n'oublie
pas de passer par le port C# — la lecture du Python ET du C# devrait éclairer le
portage, modulo les bonnes libs »).

The model cannot read the C# twin itself — its terminal cwd is not the grain's worktree
(measured 21/11, 10 293 completion tokens walking the wrong tree) — so the harness
inlines it: a capped whole-notebook REFERENCE view in the creation plan prompt, and the
previous porter's // comments per build segment. These tests pin:

- csharp_sibling: the -CSharp.ipynb sibling is found when present, None otherwise, and a
  non-Python source never matches;
- creation_prompt: the reference section appears only when a view is given, always with
  the authority line that keeps the Python twin authoritative for prose and values;
- creation_json_prompt: the C# // comments of the segment's CODE cells are inlined as
  porter notes, the Python prose pin stays the ONLY prose pin, a short/absent C# twin
  never fabricates a block and never crashes."""
import json
from pathlib import Path

import nb_coder_driver as D


# ------------------------------------------------------------------ sibling lookup
def test_csharp_sibling_finds_the_port_when_present(tmp_path):
    (tmp_path / "Serie-01-Essai-Python.ipynb").write_text("{}", encoding="utf-8")
    cs = tmp_path / "Serie-01-Essai-CSharp.ipynb"
    cs.write_text("{}", encoding="utf-8")
    assert D.csharp_sibling(tmp_path / "Serie-01-Essai-Python.ipynb") == cs


def test_csharp_sibling_is_none_without_a_port(tmp_path):
    (tmp_path / "Serie-01-Essai-Python.ipynb").write_text("{}", encoding="utf-8")
    assert D.csharp_sibling(tmp_path / "Serie-01-Essai-Python.ipynb") is None


def test_csharp_sibling_never_matches_a_non_python_source(tmp_path):
    other = tmp_path / "Serie-01-Essai-Rust.ipynb"
    other.write_text("{}", encoding="utf-8")
    (tmp_path / "Serie-01-Essai-CSharp.ipynb").write_text("{}", encoding="utf-8")
    assert D.csharp_sibling(other) is None


# ------------------------------------------------------------------ plan prompt
def _plan_prompt(cs_view=""):
    return D.creation_prompt(27999, {"title": "t", "body": "b", "comments": ""}, "rel-Rust.ipynb",
                             "rel-Python.ipynb", {"kernel_name": "rust"}, "ctx", "vue python",
                             "", cs_view)


def test_creation_prompt_carries_the_reference_section_when_given():
    p = _plan_prompt(cs_view="=== cellule 0 | code ===\n// note du porteur")
    assert "Jumeau C# du même carnet" in p
    assert "RÉFÉRENCE de traduction" in p
    assert "// note du porteur" in p
    # the authority line keeps the Python twin authoritative
    assert "l'AUTORITÉ" in p and "identiques au Python" in p


def test_creation_prompt_has_no_csharp_section_without_a_twin():
    p = _plan_prompt()
    assert "Jumeau C# du même carnet" not in p
    assert "RÉFÉRENCE de traduction" not in p


# ------------------------------------------------------------------ build segments
def _cell(i, kind, src):
    return {"idx": i, "cell_type": kind, "source": src}


def _nb(cells):
    return {"cells": [{"cell_type": t, "source": [s], "metadata": {}, "outputs": [],
                       "execution_count": None} if t == "code" else
                      {"cell_type": t, "source": [s], "metadata": {}, "id": f"c{i}"}
                      for i, t, s in cells],
            "metadata": {}, "nbformat": 4, "nbformat_minor": 5}


PY = _nb([(0, "markdown", "# Titre python"),
          (1, "code", "# commentaire python\nprint(1)"),
          (2, "markdown", "## Conclusion python")])
CS = _nb([(0, "markdown", "# Titre csharp"),
          (1, "code", "// BinaryTree pour la file de priorite\nvar x = 1; // init"),
          (2, "markdown", "## Conclusion csharp")])


def test_creation_json_prompt_inlines_the_porter_comments():
    p = D.creation_json_prompt([_cell(1, "code", "")], 3, "",
                               src_cells=PY["cells"], cs_cells=CS["cells"])
    assert "commentaires du porteur C#" in p
    assert "BinaryTree pour la file de priorite" in p      # the // note, translated choice
    assert "commentaires du jumeau" in p                   # the python # comments stay
    assert "COMMENTAIRES DU JUMEAU C#" in p


def test_creation_json_prompt_keeps_python_as_the_only_prose_pin():
    p = D.creation_json_prompt([_cell(0, "markdown", ""), _cell(2, "markdown", "")], 3, "",
                               src_cells=PY["cells"], cs_cells=CS["cells"])
    assert "# Titre python" in p and "## Conclusion python" in p
    assert "# Titre csharp" not in p and "## Conclusion csharp" not in p
    assert "PROSE DU JUMEAU PYTHON — AUTORITÉ" in p


def test_creation_json_prompt_without_a_csharp_twin_changes_nothing():
    plain = D.creation_json_prompt([_cell(1, "code", "")], 3, "", src_cells=PY["cells"])
    with_cs_absent = D.creation_json_prompt([_cell(1, "code", "")], 3, "",
                                            src_cells=PY["cells"], cs_cells=None)
    assert plain == with_cs_absent
    assert "porteur C#" not in with_cs_absent


def test_creation_json_prompt_tolerates_a_shorter_csharp_twin():
    short_cs = CS["cells"][:1]
    p = D.creation_json_prompt([_cell(1, "code", "")], 3, "",
                               src_cells=PY["cells"], cs_cells=short_cs)
    assert "commentaires du porteur C#" not in p          # no fabricated block, no crash
