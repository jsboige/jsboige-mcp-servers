#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Authored here (blank-spec generator) — no jsboige/vllm original. The lane-local
# originals (po-2028 batch generators gen-o87/o88/o89.py, 28/11, and the ai-01:vllm
# generator) hard-coded D:/dev/CoursIA, one batch directory and one spec list; this
# port takes the repository, the ref and the specs file as arguments. This tree is
# the source of truth.
# Harness base is the vllm re-copy @ 7a09e1caec22441d9402ab25a222206c8905bfe1.
# -----------------------------------------------------------------------------
"""Tests of the blank-spec generator: every statement of the body is measured on the notebook it cites.

Synthetic notebooks and a fake tree: no git, no network. One end-to-end test builds a throwaway git
repository in tmp_path to exercise the real reader and the CLI (skipped when git is absent).
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_blank_spec", HERE / "nb_coder_blank_spec.py")
bs = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = bs  # dataclasses resolve their module through sys.modules
_spec.loader.exec_module(bs)

FOLDER = "Nb/Search/Part1"
SRC = f"{FOLDER}/Search-07-Demo-Python.ipynb"
CS = f"{FOLDER}/Search-07-Demo-CSharp.ipynb"
RS = f"{FOLDER}/Search-07-Demo-Rust.ipynb"


def code(src: str, outputs=None) -> dict:
    return {"cell_type": "code", "source": src, "outputs": outputs or [], "metadata": {}, "execution_count": 1}


def md(src: str) -> dict:
    return {"cell_type": "markdown", "source": src, "metadata": {}}


def notebook(*cells) -> dict:
    return {"cells": list(cells), "metadata": {}, "nbformat": 4, "nbformat_minor": 5}


NB = notebook(
    md("# Search-07"),
    code("import numpy as np\nimport matplotlib.pyplot as plt"),
    code("rng = np.random.default_rng(42)\nx = rng.normal(size=3)\nprint(x | 1)"),
    code("plt.plot([1, 2])\nplt.show()"),
    code("# Exercice 1 : completer la fonction\ndef f():\n    pass"),
    code("# Exemple guide\nprint(1)"),
    code("from scipy.stats import entropy\nprint(entropy([0.5, 0.5]))"),
    code("print('done')", outputs=[{"output_type": "display_data", "data": {"image/png": "AAAA"}}]),
)

SPEC = {"file": "search-07", "title": "Parité C# : Search-07-Demo", "grain": "parite-csharp/search",
        "parent": 26070, "source": SRC, "target": CS, "objet": "Porter le carnet.",
        "notes": ["Note propre au carnet.", {"clause": "culture"}]}


def ctx(lang="csharp") -> "bs.Context":
    return bs.Context(lang=bs.LANGS[lang], ref="origin/main", ref_sha="abcdef1234", today="28/11")


def measure(nb=NB, target=False, rust=False, csharp=False, names=()) -> "bs.Measure":
    return bs.Measure(sha="0123456789abcdef0123", nb=nb, target_on_ref=target, rust_on_ref=rust,
                      csharp_on_ref=csharp, folder_names=list(names))


# ---- inventory ---------------------------------------------------------------------------------

def test_inventory_archetype_precedence_and_verbatim_first_line():
    rows = bs.inventory(NB, bs.LANGS["csharp"], force_solved=(5,), force_exo=(), force_pre=())
    by = {r["index"]: r for r in rows}
    assert [r["index"] for r in rows] == [1, 2, 3, 4, 5, 6, 7]
    assert by[1]["archetype"] == "préambule"
    assert by[2]["archetype"] == "calcul" and by[2]["first"] == "rng = np.random.default_rng(42)"
    assert by[4]["archetype"] == "exercice"
    assert by[5]["archetype"] == "exemple résolu" and "PAS un stub" in by[5]["equivalent"]


def test_force_solved_beats_the_exercise_regex():
    nb = notebook(code("# Exercice guide resolu\nprint(2)"))
    assert bs.inventory(nb, bs.LANGS["csharp"], force_solved=(0,))[0]["archetype"] == "exemple résolu"
    assert bs.inventory(nb, bs.LANGS["csharp"])[0]["archetype"] == "exercice"


def test_a_pipe_in_the_first_line_is_escaped_in_the_table():
    row = bs.inventory(notebook(code("print(a | b)")), bs.LANGS["csharp"])[0]
    assert bs.render_row(row) == "| 0 | `print(a \\| b)` | calcul | mêmes entrées, mêmes calculs, assertions exécutables |"


def test_import_roots_are_sorted_and_deduplicated():
    assert bs.import_roots(NB) == ["matplotlib.pyplot", "numpy", "scipy.stats"]


# ---- the four measured detections ---------------------------------------------------------------

def test_alea_cites_the_literal_seeds_with_their_cells():
    nb = notebook(code("import random\nrandom.seed(7)\nprint(random.random())"),
                  code("torch.manual_seed(0)"), code("g = np.random.default_rng(seed=3)"),
                  code("m = KMeans(random_state=5)"), code("print(1)"))
    alea = bs.detect_alea(nb)
    assert alea["cells"] == [0, 1, 2, 3]
    assert [s for _, s in alea["seeds"]] == ["seed(7)", "manual_seed(0)", "default_rng(seed=3)", "random_state=5"]
    text = bs.alea_bullet(alea)
    assert "`seed(7)` (cellule 0)" in text and "`random_state=5` (cellule 3)" in text


def test_alea_draw_without_a_literal_seed_says_so():
    alea = bs.detect_alea(notebook(code("x = np.random.rand(3)")))
    assert alea == {"cells": [0], "seeds": []}
    assert "aucune graine littérale" in bs.alea_bullet(alea)


def test_alea_none_is_a_measured_statement_not_a_determinism_claim():
    text = bs.alea_bullet(bs.detect_alea(notebook(code("print('random words in a string')"))))
    assert text.startswith("ALÉA (mesuré) — aucun appel de générateur aléatoire")
    assert "déterministe" not in text


def test_figures_from_plt_calls_and_png_outputs():
    assert bs.detect_figures(NB) == [3, 7]  # the import cell draws nothing
    assert "SVG" in bs.figure_bullet([3], bs.LANGS["csharp"])
    assert "la cellule 3 trace (" in bs.figure_bullet([3], bs.LANGS["csharp"])
    assert "EVCXR_BEGIN_CONTENT" in bs.figure_bullet([3], bs.LANGS["rust"])


def test_no_figure_is_said_as_measured():
    assert bs.figure_bullet([], bs.LANGS["csharp"]) == (
        "Figures (mesuré) : la source ne trace aucune figure (ni `plt.` dans le code, ni sortie `image/png`).")


def test_libraries_without_a_bcl_equivalent_are_cited_with_their_cells():
    nb = notebook(code("from scipy.special import rel_entr"), code("import networkx as nx"),
                  code("import mpmath"), code("import torch"), code("import math"))
    found = dict(bs.detect_no_equivalent(nb))
    assert found["scipy `entropy` / `rel_entr`"] == [0]
    assert found["networkx"] == [1] and found["mpmath"] == [2] and found["torch"] == [3]
    text = bs.no_equivalent_bullet(bs.detect_no_equivalent(nb), bs.LANGS["csharp"])
    assert "réimplémentation fidèle" in text and "jamais une substitution" in text
    assert bs.no_equivalent_bullet([], bs.LANGS["csharp"]) is None


def test_siblings_of_the_same_language_exclude_the_target():
    names = [f"{FOLDER}/Search-01-A-CSharp.ipynb", f"{FOLDER}/Search-01-A-Python.ipynb", CS,
             f"{FOLDER}/Search-02-B-Rust.ipynb", f"{FOLDER}/README.md"]
    assert bs.siblings(names, CS, bs.LANGS["csharp"]) == ["Search-01-A-CSharp.ipynb"]
    assert bs.siblings(names, RS, bs.LANGS["rust"]) == ["Search-02-B-Rust.ipynb"]
    assert "premier C# de sa série" in bs.siblings_bullet([], bs.LANGS["csharp"], FOLDER)
    assert "`Search-01-A-CSharp.ipynb`" in bs.siblings_bullet(["Search-01-A-CSharp.ipynb"], bs.LANGS["csharp"], FOLDER)


def test_twin_of_swaps_the_language_suffix():
    assert bs.twin_of(SRC, "csharp") == CS
    assert bs.twin_of(SRC, "rust") == RS


# ---- refusals -----------------------------------------------------------------------------------

def test_target_already_on_the_ref_is_refused():
    with pytest.raises(bs.SpecError, match="already on the ref"):
        bs.render_body(SPEC, measure(target=True), ctx())


def test_csharp_grain_refused_when_the_rust_twin_is_on_the_ref():
    with pytest.raises(bs.SpecError, match="Rust twin is on the ref"):
        bs.render_body(SPEC, measure(rust=True), ctx())


def test_rust_grain_needs_the_csharp_twin_unless_overridden():
    spec = {**SPEC, "lang": "rust", "target": RS}
    with pytest.raises(bs.SpecError, match="no C# twin"):
        bs.render_body(spec, measure(), ctx("rust"))
    assert "Cible Rust" in bs.render_body({**spec, "allow_no_csharp": True}, measure(), ctx("rust"))
    body = bs.render_body(spec, measure(csharp=True), ctx("rust"))
    assert f"`{CS}` — référence d'IDIOMES" in body


def test_missing_required_keys_are_refused():
    with pytest.raises(bs.SpecError, match="missing keys parent"):
        bs.render_body({k: v for k, v in SPEC.items() if k != "parent"}, measure(), ctx())


def test_unknown_clause_is_refused():
    with pytest.raises(bs.SpecError, match="unknown clause"):
        bs.render_body({**SPEC, "notes": [{"clause": "nope"}]}, measure(), ctx())


# ---- the body -----------------------------------------------------------------------------------

def test_body_shape_cites_the_blob_and_the_measures():
    body = bs.render_body(SPEC, measure(names=[f"{FOLDER}/Search-01-A-CSharp.ipynb"]), ctx())
    head = body.splitlines()
    assert head[:4] == ["Parité C# : Search-07-Demo", "Grain: parite-csharp/search", "", "Parent : #26070"]
    assert f"- Source Python : `{SRC}` (8 cellules, 7 code)" in body
    assert "| 2 | `rng = np.random.default_rng(42)` | calcul |" in body
    assert "`default_rng(42)` (cellule 2)" in body
    assert "les cellules 3, 7 tracent" in body
    assert "scipy `entropy` / `rel_entr` (cellule 6)" in body and "scipy `stats` (cellule 6)" in body
    assert "`Search-01-A-CSharp.ipynb`" in body
    assert "- Note propre au carnet." in body and "CultureInfo.InvariantCulture" in body
    assert "BCL seulement" in body
    assert "Dépendances mesurées : matplotlib.pyplot, numpy, scipy.stats" in body
    assert "`0123456789ab` (arbre `origin/main` = `abcdef1234`)" in body
    assert "sans solution et sans indice AJOUTÉ" in body


def test_readme_defer_clause_singular_and_plural():
    one = bs.render_note({"clause": "readme_defer", "prs": [29124], "path": f"{FOLDER}/README.md"}, ctx())
    two = bs.render_note({"clause": "readme_defer", "prs": [1, 2], "path": f"{FOLDER}/README.md"}, ctx())
    assert "la PR OUVERTE #29124" in one and "cette fusion" in one and "du 28/11" in one
    assert "les PR OUVERTES #1 et #2" in two and "modifient" in two and "ces fusions" in two


def test_no_twin_clause_names_the_other_language_and_the_measure():
    assert bs.render_note({"clause": "no_twin"}, ctx()).startswith(
        "Aucun jumeau Rust de ce carnet n'est sur `origin/main` (mesuré 28/11, `abcdef1234`)")
    assert "Aucun jumeau C#" in bs.render_note({"clause": "no_twin"}, ctx("rust"))


def test_load_specs_merges_defaults(tmp_path):
    p = tmp_path / "s.json"
    p.write_text(json.dumps({"defaults": {"parent": 1, "grain": "g"}, "specs": [{"file": "a", "parent": 2}]}),
                 encoding="utf-8")
    assert bs.load_specs(p) == [{"parent": 2, "grain": "g", "file": "a"}]


# ---- end to end, real git reader ----------------------------------------------------------------

def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.mark.skipif(shutil.which("git") is None, reason="git not available")
def test_cli_end_to_end_on_a_throwaway_repository(tmp_path):
    repo = tmp_path / "repo"
    (repo / FOLDER).mkdir(parents=True)
    (repo / SRC).write_text(json.dumps(NB), encoding="utf-8")
    (repo / f"{FOLDER}/Search-01-A-CSharp.ipynb").write_text(json.dumps(notebook()), encoding="utf-8")
    _git(repo, "init", "-q")
    _git(repo, "add", "-A")
    _git(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init")
    specs = tmp_path / "specs.json"
    refused = {**SPEC, "file": "taken", "target": f"{FOLDER}/Search-01-A-CSharp.ipynb"}
    specs.write_text(json.dumps([SPEC, refused]), encoding="utf-8")
    out = tmp_path / "out"
    rc = bs.main(["--repo", str(repo), "--specs", str(specs), "--out", str(out), "--ref", "HEAD",
                  "--grain-tag", str(tmp_path / "absent.py")])
    assert rc == 2  # one entry refused, the other written
    body = (out / "search-07.md").read_text(encoding="utf-8")
    blob = subprocess.run(["git", "-C", str(repo), "rev-parse", f"HEAD:{SRC}"], capture_output=True,
                          encoding="utf-8").stdout.strip()
    assert f"`{blob[:12]}`" in body and "`Search-01-A-CSharp.ipynb`" in body
    written = json.loads((out / "specs.json").read_text(encoding="utf-8"))
    assert [w["file"] for w in written] == ["search-07"] and written[0]["source_blob"] == blob
    assert not (out / "taken.md").exists()
