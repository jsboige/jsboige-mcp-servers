# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_repo_guards.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Regression pins for the stage-3 repo guards and the twin-comment injection (21/11).

The first three Swift Rust ports (CoursIA#27803/#27804/#27805) all came back
CHANGES_REQUESTED on defects the repo's CI names and the harness never looked at:
links to `-Rust` neighbours that do not exist, long code cells with no comment (the
twin's comments lost in the port), and prose counts copied verbatim from the twin.
These tests pin the harness side: the creation prompt carries the twin's code comments
and the delivery rules, and stage 3 replays the three guards in creation mode, each
failing cell becoming a finding for the constructive loop.

Skipped when `mcp` is not importable (the driver imports the MCP client at load).
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

_DRV = Path(__file__).resolve().parent / "nb_coder_driver.py"
_spec = importlib.util.spec_from_file_location("nbcd_repo_guards", _DRV)
nbcd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nbcd)


def _nb(path: Path, cells: list) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                                "nbformat_minor": 5}), encoding="utf-8")
    return path


def _md(src: str) -> dict:
    return {"cell_type": "markdown", "source": src, "metadata": {}}


def _code(src: str) -> dict:
    return {"cell_type": "code", "source": src, "outputs": [], "metadata": {},
            "execution_count": 1}


def _tool(repo: Path, name: str, body: str) -> None:
    d = repo / "scripts" / "notebook_tools"
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(body, encoding="utf-8")


# ------------------------------------------------------------------ twin comments

def test_twin_comments_python_skips_strings_and_shebang():
    src = ('#!/usr/bin/env python\n'
           '# Terrain pondéré : chaque case a un coût\n'
           'x = "# pas un commentaire"\n'
           'y = 1  # f(n) = g(n) + W*h(n)\n')
    assert nbcd.twin_code_comments(src) == ["Terrain pondéré : chaque case a un coût",
                                            "f(n) = g(n) + W*h(n)"]


def test_twin_comments_csharp_fallback():
    src = "// reconstruire le chemin\nvar p = new List<int>();\n  // borne W\n"
    assert nbcd.twin_code_comments(src) == ["reconstruire le chemin", "borne W"]


def test_twin_comments_capped():
    src = "\n".join(f"# commentaire numéro {i:03d}" for i in range(200))
    out = nbcd.twin_code_comments(src, cap=100)
    assert out[-1].startswith("[…") and len(out) < 20


def test_creation_prompt_carries_twin_comments_and_rules():
    twin = [_md("# Titre\n\nUne solution compacte."),
            _code("# Terrain pondéré : chaque case a un coût\ngrid = []\n")]
    seg = [{"idx": 0, "cell_type": "markdown", "role": "titre"},
           {"idx": 1, "cell_type": "code", "role": "grille"}]
    p = nbcd.creation_json_prompt(seg, 2, src_cells=twin)
    assert "COMMENTAIRES DE LECTURE DU JUMEAU" in p
    assert "Terrain pondéré : chaque case a un coût" in p
    assert "Ne translittère JAMAIS" in p and "retire la mesure" in p
    assert "code .NET" not in p


def test_creation_prompt_without_code_comments_has_no_comment_block():
    twin = [_md("# Titre"), _code("grid = []\n")]
    seg = [{"idx": 1, "cell_type": "code", "role": "grille"}]
    assert "COMMENTAIRES DE LECTURE DU JUMEAU" not in nbcd.creation_json_prompt(
        seg, 2, src_cells=twin)


# ------------------------------------------------------------------ dead links

def test_dead_links_flags_only_absent_relative_targets(tmp_path):
    repo = tmp_path / "repo"
    rel = "MyIA.AI.Notebooks/Sudoku/Sudoku-07-Norvig-Rust.ipynb"
    folder = repo / "MyIA.AI.Notebooks" / "Sudoku"
    folder.mkdir(parents=True)
    (folder / "Sudoku-06-AIMA-CSP-Python.ipynb").write_text("{}", encoding="utf-8")
    (folder / "Sudoku 09.ipynb").write_text("{}", encoding="utf-8")
    cells = [
        _md("[prev](Sudoku-06-AIMA-CSP-Rust.ipynb) | [ok](Sudoku-06-AIMA-CSP-Python.ipynb)"),
        _md("[web](https://example.org/x) [ancre](#plan) [moi](Sudoku-07-Norvig-Rust.ipynb)"
            " [espace](Sudoku%2009.ipynb#top)"),
        _md('<a href="Sudoku-08-HumanStrategies-Rust.ipynb">suivant</a>'),
        _code("// [faux](absent.ipynb) dans du code : non jugé"),
    ]
    hits = nbcd.dead_link_hits(cells, repo, rel)
    assert [(h["cell"], h["target"]) for h in hits] == [
        (0, "Sudoku-06-AIMA-CSP-Rust.ipynb"), (2, "Sudoku-08-HumanStrategies-Rust.ipynb")]


def _lean19(tmp_path):
    """The CoursIA#27932 layout: four Lean-19 Python twins, the Rust port being built."""
    repo = tmp_path / "repo"
    folder = repo / "MyIA.AI.Notebooks" / "SymbolicAI" / "Lean"
    folder.mkdir(parents=True)
    for n in ("Lean-19-Detection-MIMO-Index-Python", "Lean-19b-Borne-Chernoff-Python",
              "Lean-19c-Borne-Bernstein-Python", "Lean-19d-Inference-Bayesian-Beta-Binomial-Python"):
        (folder / f"{n}.ipynb").write_text("{}", encoding="utf-8")
    (folder / "README.md").write_text("x", encoding="utf-8")
    src = _nb(tmp_path / "src.ipynb", [_md(
        "**Navigation** : [<< Lean-19 Hoeffding](Lean-19-Detection-MIMO-Index-Python.ipynb) · "
        "[Lean-19b Chernoff](Lean-19b-Borne-Chernoff-Python.ipynb) · "
        "[Lean-19d Bayésien](Lean-19d-Inference-Bayesian-Beta-Binomial-Python.ipynb) · "
        "[Sommaire série](README.md)")])
    return repo, "MyIA.AI.Notebooks/SymbolicAI/Lean/Lean-19c-Borne-Bernstein-Rust.ipynb", src


def test_resolve_dead_links_rewrites_onto_the_twins_existing_target(tmp_path):
    """22/11 CoursIA#27932: labels changed, file names rebuilt from them — both dead links
    land on the one twin target sharing their series id; live links stay byte-identical."""
    repo, rel, src = _lean19(tmp_path)
    built = _nb(tmp_path / "built.ipynb", [
        _md("**Navigation** : [Index](README.md) · [Lean-19](Lean-19-Borne-Hoeffding-Python.ipynb) · "
            "[Lean-19b](Lean-19b-Borne-Chernoff-Python.ipynb) · "
            "[Python](Lean-19c-Borne-Bernstein-Python.ipynb) · "
            "[Lean-19d](Lean-19d-Borne-Bennett-Python.ipynb)\nsuite"),
        _code("// [faux](absent.ipynb) dans du code : non touché")])
    out = nbcd.resolve_dead_links(built, src, repo, rel)
    assert out["ok"] and [(f["from"], f["to"]) for f in out["fixed"]] == [
        ("Lean-19-Borne-Hoeffding-Python.ipynb", "Lean-19-Detection-MIMO-Index-Python.ipynb"),
        ("Lean-19d-Borne-Bennett-Python.ipynb", "Lean-19d-Inference-Bayesian-Beta-Binomial-Python.ipynb")]
    cells = json.loads(built.read_text(encoding="utf-8"))["cells"]
    assert isinstance(cells[0]["source"], list)  # list-of-lines kept (CoursIA convention)
    assert "".join(cells[0]["source"]) == (
        "**Navigation** : [Index](README.md) · [Lean-19](Lean-19-Detection-MIMO-Index-Python.ipynb) · "
        "[Lean-19b](Lean-19b-Borne-Chernoff-Python.ipynb) · "
        "[Python](Lean-19c-Borne-Bernstein-Python.ipynb) · "
        "[Lean-19d](Lean-19d-Inference-Bayesian-Beta-Binomial-Python.ipynb)\nsuite")
    assert cells[1]["source"] == "// [faux](absent.ipynb) dans du code : non touché"
    assert nbcd.dead_link_hits(cells, repo, rel) == []


def test_resolve_dead_links_label_match_wins_and_ambiguity_is_left_to_the_gate(tmp_path):
    repo, rel, _ = _lean19(tmp_path)
    folder = repo / "MyIA.AI.Notebooks" / "SymbolicAI" / "Lean"
    (folder / "Lean-19-Autre-Python.ipynb").write_text("{}", encoding="utf-8")
    src = _nb(tmp_path / "src2.ipynb", [_md(
        "[Hoeffding](Lean-19-Detection-MIMO-Index-Python.ipynb) [autre](Lean-19-Autre-Python.ipynb) "
        "[Bennett](Lean-19d-Inference-Bayesian-Beta-Binomial-Python.ipynb)")])
    built = _nb(tmp_path / "built2.ipynb", [_md(
        "[Hoeffding](Lean-19-X-Python.ipynb) [suite](Lean-19-Y-Python.ipynb) "
        "[Sans série](Introuvable.ipynb) [Rust](Lean-19d-Borne-Bennett-Rust.ipynb)")])
    out = nbcd.resolve_dead_links(built, src, repo, rel)
    # same label → its target; two twin targets share `Lean-19` → no guess; no series id → no
    # guess; `Lean-19d` has ONE twin target (the Python twin), the advice the gate itself gives
    assert [(f["from"], f["to"]) for f in out["fixed"]] == [
        ("Lean-19-X-Python.ipynb", "Lean-19-Detection-MIMO-Index-Python.ipynb"),
        ("Lean-19d-Borne-Bennett-Rust.ipynb", "Lean-19d-Inference-Bayesian-Beta-Binomial-Python.ipynb")]
    left = nbcd.dead_link_hits(json.loads(built.read_text(encoding="utf-8"))["cells"], repo, rel)
    assert [h["target"] for h in left] == ["Lean-19-Y-Python.ipynb", "Introuvable.ipynb"]


def test_resolve_dead_links_without_dead_links_leaves_the_file_untouched(tmp_path):
    repo, rel, src = _lean19(tmp_path)
    built = _nb(tmp_path / "built3.ipynb", [_md("[Python](Lean-19c-Borne-Bernstein-Python.ipynb)")])
    before = built.read_bytes()
    assert nbcd.resolve_dead_links(built, src, repo, rel) == {"ok": True, "fixed": []}
    assert built.read_bytes() == before


# ------------------------------------------------------------------ uncommented code

_UC_FAKE = r'''
import json, sys
args = sys.argv[1:]
nb = json.load(open(args[args.index("--file") + 1], encoding="utf-8"))
cells = [{"cell": i, "code_lines": len(c["source"].splitlines()), "comments": 0}
         for i, c in enumerate(nb["cells"])
         if c["cell_type"] == "code" and len(c["source"].splitlines()) >= 8
         and "//" not in c["source"]]
rows = [{"path": "x", "cells": cells}] if cells else []
print(json.dumps({"rows": rows}))
sys.exit(1 if rows else 0)
'''


def test_uncommented_code_gate_maps_cells(tmp_path):
    repo = tmp_path / "repo"
    _tool(repo, "check_uncommented_code.py", _UC_FAKE)
    built = _nb(tmp_path / "b.ipynb", [_md("t"), _code("let a = 1;\n" * 9),
                                       _code("// commenté\n" + "let b = 2;\n" * 9)])
    g = nbcd.uncommented_code_gate(repo, built)
    assert g["ok"] is False and g["detail"]["measured"] is True
    assert g["detail"]["cells"] == [1]
    assert "9 lignes de code" in g["detail"]["findings"][0]["text"]


def test_uncommented_code_gate_absent_tool_is_declared_not_failed(tmp_path):
    built = _nb(tmp_path / "b.ipynb", [_code("x\n" * 9)])
    g = nbcd.uncommented_code_gate(tmp_path / "repo", built)
    assert g["ok"] is True and g["detail"]["measured"] is False


def test_uncommented_code_gate_tool_crash_is_declared(tmp_path):
    repo = tmp_path / "repo"
    _tool(repo, "check_uncommented_code.py", "import sys\nsys.exit(3)\n")
    g = nbcd.uncommented_code_gate(repo, _nb(tmp_path / "b.ipynb", [_code("x")]))
    assert g["ok"] is True and g["detail"]["measured"] is False and g["detail"]["rc"] == 3


# ------------------------------------------------------------------ prose counts

_PQC_FAKE = r'''
import sys
print("[REFUS] 3 compteur(s) quantitatif(s) en prose, 1 fichier(s) :\n")
print("  MyIA.AI.Notebooks/Sudoku/S-Rust.ipynb  (3)  9 lignes, ~80 lignes")
print("\nSupprimer la mesure, garder le predicat.")
print("\n[ALLOWLIST] 1 exemption(s) motivee(s) de la classe artifact, 2 compteur(s) couvert(s) :")
print("  Other/README.md  (2)  ^pattern$")
sys.exit(1)
'''


def test_prose_counts_gate_locates_snippets(tmp_path):
    repo = tmp_path / "repo"
    _tool(repo, "check_prose_quantitative_claims.py", _PQC_FAKE)
    rel = "MyIA.AI.Notebooks/Sudoku/S-Rust.ipynb"
    built = _nb(tmp_path / "b.ipynb", [_md("Une solution (~80 lignes)."), _code("x"),
                                       _md("Le cœur tient en 9 lignes.")])
    g = nbcd.prose_counts_gate(repo, rel, built, tmp_path / "out")
    assert g["ok"] is False
    texts = [f["text"] for f in g["detail"]["findings"]]
    assert texts == ["compteur « 9 lignes » (cellule 2)", "compteur « ~80 lignes » (cellule 0)"]
    assert "^pattern$" not in json.dumps(g)
    assert list((tmp_path / "out").iterdir()) == []      # temporary tree cleaned


_PQC_TREE = r'''
import sys
from pathlib import Path
root = Path(sys.argv[sys.argv.index("--root") + 1])
hits = sorted(p.name for p in root.rglob("*.ipynb"))
print("[OK]" if not hits else "\n".join(f"  {h}  (1)  {h}-count" for h in hits))
sys.exit(1 if hits else 0)
'''


def test_prose_counts_gate_judges_only_this_notebook(tmp_path):
    # measured 21/11 on the three real ports: a scratch tree shared across calls made the
    # second notebook inherit the first one's counts
    repo = tmp_path / "repo"
    _tool(repo, "check_prose_quantitative_claims.py", _PQC_TREE)
    out = tmp_path / "out"
    nbcd.prose_counts_gate(repo, "a/first.ipynb", _nb(tmp_path / "1.ipynb", [_md("x")]), out)
    g = nbcd.prose_counts_gate(repo, "b/second.ipynb", _nb(tmp_path / "2.ipynb", [_md("y")]),
                               out)
    assert [f["text"] for f in g["detail"]["findings"]] == ["compteur « second.ipynb-count »"]


def test_prose_counts_gate_clean(tmp_path):
    repo = tmp_path / "repo"
    _tool(repo, "check_prose_quantitative_claims.py",
          'print("[OK] aucun compteur quantitatif en prose.")\n')
    g = nbcd.prose_counts_gate(repo, "a/b.ipynb", _nb(tmp_path / "b.ipynb", [_md("ok")]),
                               tmp_path / "out")
    assert g == {"gate": "prose-counts", "ok": True, "detail": {"measured": True}}


# ------------------------------------------------------------------ wiring

def test_run_gates_adds_repo_guards_in_create_mode_only(tmp_path):
    repo = tmp_path / "repo"
    _tool(repo, "check_uncommented_code.py", _UC_FAKE)
    _tool(repo, "check_prose_quantitative_claims.py", 'print("[OK]")\n')
    src = _nb(tmp_path / "src.ipynb", [_md("# T")])
    built = _nb(tmp_path / "built.ipynb", [_md("# T [x](absent.ipynb)")])
    names = {g["gate"] for g in nbcd.run_gates(src, built, create_mode=True, repo=repo,
                                               rel="d/n.ipynb", scratch=tmp_path / "o")}
    assert {"dead-links", "uncommented-code", "prose-counts"} <= names
    names = {g["gate"] for g in nbcd.run_gates(src, built, create_mode=False, repo=repo,
                                               rel="d/n.ipynb", scratch=tmp_path / "o")}
    assert not names & {"dead-links", "uncommented-code", "prose-counts"}


def test_gate_repair_findings_one_per_entry():
    rec = {"gates": [
        {"gate": "dead-links", "ok": False,
         "detail": {"cells": [0, 2], "findings": [
             {"cell": 0, "text": "cellule 0 : lien vers `a-Rust.ipynb`, absent du dépôt"},
             {"cell": 2, "text": "cellule 2 : lien vers `b-Rust.ipynb`, absent du dépôt"}]}},
        {"gate": "machine-path", "ok": False, "detail": {"cells": [4]}},
        {"gate": "prose-counts", "ok": True, "detail": {"measured": True}},
    ]}
    out = nbcd.gate_repair_findings(rec)
    assert [f["cell"] for f in out] == [0, 2, 4]
    assert "translittère" in out[0]["detail"] and "a-Rust.ipynb" in out[0]["detail"]


def test_prose_counts_repair_keeps_a_data_count_and_renames_its_noun():
    # CoursIA#27929 (22/11): « 10 cellules sur 24 » counted the cases of a matrix; with only
    # "drop the measure" to go on, three revisions kept the number and the grain failed.
    rec = {"gates": [{"gate": "prose-counts", "ok": False, "detail": {"measured": True,
            "cells": [3], "findings": [{"cell": 3, "text": "compteur « 10 cellules » (cellule 3)"}]}}]}
    fix, = nbcd.gate_repair_findings(rec)
    assert fix["cell"] == 3 and "10 cellules" in fix["detail"]
    assert "retire la mesure" in fix["detail"]                 # artifact/duration case kept
    assert "« 10 cases sur 24 »" in fix["detail"]               # data case: rename the noun
    p = nbcd.creation_json_prompt([{"idx": 0, "cell_type": "markdown", "role": "t"}], 1,
                                  src_cells=[_md("# T")])
    assert "« 10 cases sur 24 »" in p and "DONNÉES du calcul" in p


# ------------------------------------------------------------------ prose anchored on outputs

# Fake claims organ: one finding per « NUM ms » in a markdown cell, carrying the cell's
# text as context (the real organ excerpts the sentence) — enough to pin the delta rule.
_ANCHOR_FAKE = r'''import json, re, sys
nb = json.load(open(sys.argv[-1], encoding="utf-8"))
out = []
for i, c in enumerate(nb["cells"]):
    if c["cell_type"] != "markdown":
        continue
    for m in re.finditer(r"(\d+,\d+) ms", c["source"]):
        out.append({"markdown_cell": i, "code_cell": i - 1, "raw": m.group(0),
                    "normalized": m.group(1).replace(",", "."), "context": c["source"]})
print(json.dumps([{"notebook": sys.argv[-1], "findings": out}]))
sys.exit(1 if out else 0)
'''


def _anchor_repo(tmp_path: Path, body: str = _ANCHOR_FAKE) -> Path:
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True, exist_ok=True)
    (repo / "scripts" / "check_markdown_claims_output.py").write_text(body, encoding="utf-8")
    return repo


def test_prose_anchor_flags_a_number_new_to_the_port(tmp_path):
    # CoursIA#27864: the Rust port kept the Python run's timing in its prose
    repo = _anchor_repo(tmp_path)
    src = _nb(tmp_path / "src.ipynb", [_code("t()"), _md("De 1,5 ms à 77,1 ms.")])
    built = _nb(tmp_path / "built.ipynb", [_code("t();"), _md("De 42,7 ms à 77,1 ms.")])
    g = nbcd.prose_anchor_gate(repo, src, built)
    assert g["gate"] == "prose-anchor" and g["ok"] is False
    assert g["detail"]["measured"] is True and g["detail"]["cells"] == [1]
    texts = [f["text"] for f in g["detail"]["findings"]]
    # 77,1 ms sits unanchored in the twin's same cell: stock, only the changed number fails
    assert len(texts) == 1 and "42,7 ms" in texts[0]


def test_prose_anchor_excuses_the_twins_own_stock(tmp_path):
    # same unanchored number in the same markdown cell of the twin: the repo's stock
    repo = _anchor_repo(tmp_path)
    cells = [_code("t()"), _md("Environ 3,0 ms par appel.")]
    src = _nb(tmp_path / "src.ipynb", cells)
    built = _nb(tmp_path / "built.ipynb", [_code("t();"), _md("Environ 3,0 ms par appel.")])
    g = nbcd.prose_anchor_gate(repo, src, built)
    assert g["ok"] is True and g["detail"]["flagged"] == 0
    assert g["detail"]["source_flagged"] == 1


def test_prose_anchor_excuses_the_same_sentence_moved(tmp_path):
    # the port inserted a cell: same sentence, other index — still inherited stock
    repo = _anchor_repo(tmp_path)
    src = _nb(tmp_path / "src.ipynb", [_code("t()"), _md("Environ 3,0 ms par appel.")])
    built = _nb(tmp_path / "built.ipynb", [_md("# Note"), _code("t();"),
                                           _md("Environ 3,0 ms par appel.")])
    assert nbcd.prose_anchor_gate(repo, src, built)["ok"] is True


def test_prose_anchor_absent_tool_is_declared_not_failed(tmp_path):
    src = _nb(tmp_path / "src.ipynb", [_md("1,0 ms")])
    g = nbcd.prose_anchor_gate(tmp_path / "norepo", src, src)
    assert g["ok"] is True and g["detail"]["measured"] is False


def test_prose_anchor_tool_crash_is_declared(tmp_path):
    repo = _anchor_repo(tmp_path, "import sys\nsys.exit(2)\n")
    src = _nb(tmp_path / "src.ipynb", [_md("1,0 ms")])
    g = nbcd.prose_anchor_gate(repo, src, src)
    assert g["ok"] is True and g["detail"]["measured"] is False


def test_run_gates_adds_prose_anchor_in_create_mode_only(tmp_path):
    repo = _anchor_repo(tmp_path)
    src = _nb(tmp_path / "src.ipynb", [_code("t()"), _md("1,5 ms")])
    built = _nb(tmp_path / "built.ipynb", [_code("t();"), _md("42,7 ms")])
    on = {g["gate"]: g for g in nbcd.run_gates(src, built, create_mode=True, repo=repo,
                                               rel="d/n-Rust.ipynb")}
    assert on["prose-anchor"]["ok"] is False
    off = {g["gate"] for g in nbcd.run_gates(src, built, create_mode=False, repo=repo,
                                             rel="d/n-Rust.ipynb")}
    assert "prose-anchor" not in off
    rep = nbcd.gate_repair_findings({"gates": [on["prose-anchor"]]})
    assert rep and "recopié du jumeau" in rep[0]["detail"] and "42,7 ms" in rep[0]["detail"]
