# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_conformance_spec_tolerances.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Spec `## Tolerances` contracts in the Rust conformance organ (22/11).

CoursIA#28072 (Sudoku-04, lot Rust std) declared a STOCHASTIC contract by
invariants: the Rust notebook uses its own std RNG, so seed-dependent outputs
can never match the Python twin. The stage-3 gate still demanded strict text
equality, failed twice, and the model's correct contest (quoting the spec's
own table) changed nothing. These tests pin the fix: the spec's
`## Tolerances` table is parsed (multi-cell rows, accents, bold), each row is
classified (invariants / mixed / duration / strict), a spec-declared Rust side
is written `absent:` quoting the row (the repo checker reports an absent side,
it never fails on one), and everything else -- including App-12 #28069's
strict MT19937 contract and a spec without a table -- stays exactly as strict
as before.
"""
import importlib.util
import json
import re
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_integrate_tol",
                                               _HERE / "nb_coder_integrate.py")
nbci = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nbci)

FAMILY = "MyIA.AI.Notebooks/Demo"
PY = f"{FAMILY}/Demo-01-Thing-Python.ipynb"
RS = f"{FAMILY}/Demo-01-Thing-Rust.ipynb"


def _stream(text: str) -> dict:
    return {"output_type": "stream", "name": "stdout", "text": text}


def _code(outputs: list) -> dict:
    return {"cell_type": "code", "source": "x", "outputs": outputs, "metadata": {},
            "execution_count": 1}


def _md() -> dict:
    return {"cell_type": "markdown", "source": "# t", "metadata": {}}


def _nb(path: Path, cells: list, language: str = "python") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"cells": cells, "nbformat": 4, "nbformat_minor": 5,
                                "metadata": {"kernelspec": {"language": language,
                                                            "name": language}}},
                               ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def _repo(tmp_path: Path, py: list, rs: list) -> Path:
    (tmp_path / nbci.RUST_CONFORMANCE_DIR).mkdir(parents=True)
    _nb(tmp_path / PY, py)
    _nb(tmp_path / RS, rs, "rust")
    return tmp_path


def _spec(rows: str, heading: str = "## Tolerances") -> str:
    """A lot-spec body carrying the per-cell tolerance table (lots 1-12 format)."""
    return (f"{heading} (une par cellule numerique)\n\n"
            "Sortes flottantes presentes : oui.\n\n"
            "| Cellule (source) | Grandeur comparee | Tolerance | Compare a |\n"
            "|---|---|---|---|\n"
            f"{rows}\n"
            "\n## Crates cibles\n\n- Aucune.\n")


# The real #28072 table, shape for shape (multi-cell row, bold markup, prose
# between the heading and the table, a section after it).
SPEC_28072 = """# Spec portage Rust -- Sudoku-04

## Contrat stochastique

Le carnet tire au sort ; les valeurs affichees dependent de la graine.

## Tolerances (une par cellule numerique)

Sorties flottantes presentes : oui. Le contrat est celui des invariants.

| Cellule (source) | Grandeur comparee | Tolerance | Compare a |
|---|---|---|---|
| 1 | 1 ligne constante | egalite stricte | sortie Python cellule 1 |
| **13** | **invariants** : permutation par ligne | invariants (voir Contrat) | invariants, pas le committe |
| 18 | **invariants** : echange entre 2 cases non fixes | invariants (voir Contrat) | invariants, pas le committe |
| 23 | en-tete + `Cellules vides: 36` ; duree : presence seule | voir ci-contre | sortie Python cellule 23 + invariants |
| 33 | vides 36/49/51 ; durees : presence seule | voir ci-contre | sortie Python cellule 33 + invariants |
| 48 | structure du tableau + `None` ; SAUF les 6 durees | egalite stricte ; durees : presence seule | sortie Python cellule 48 |
| 9, 16, 32, 39, 41, 43 | lignes d'exercice verbatim | egalite stricte | sorties Python |

## Crates cibles

- Aucune. `std` seulement.
"""


# ------------------------------------------------------------- table parsing

def test_parse_multicell_rows_bold_and_prose():
    rows = nbci.parse_spec_tolerances(SPEC_28072)
    assert set(rows) == {1, 13, 18, 23, 33, 48, 9, 16, 32, 39, 41, 43}
    assert rows[13]["compare"] == "invariants, pas le committe"
    assert rows[13]["tolerance"] == "invariants (voir Contrat)"
    assert "permutation par ligne" in rows[13]["quantity"]
    assert rows[1]["tolerance"] == "egalite stricte"
    assert rows[9] == rows[43] == rows[16]        # every cell of the multi-cell row
    assert rows[48]["tolerance"] == "egalite stricte ; durees : presence seule"


def test_parse_tolerant_of_accents_and_casing():
    body = ("## Tolérances\n\n"
            "| Cellule (source) | Grandeur comparée | Tolérance | Comparé à |\n"
            "|---|---|---|---|\n"
            "| 5 | grille témoin | égalité stricte | sortie Python cellule 5 |\n")
    rows = nbci.parse_spec_tolerances(body)
    assert set(rows) == {5}
    assert rows[5]["compare"] == "sortie Python cellule 5"
    assert rows[5]["tolerance"] == "égalité stricte"   # values keep the spec's wording


@pytest.mark.parametrize("body", [
    None,
    "",
    "## Tolerances\n\nPas de tableau ici, seulement de la prose.\n",
    "Un corps sans aucun heading, avec un | faux | tableau | sur | une ligne.",
    "## Autre section\n\n| Cellule (source) | a | b | c |\n|---|---|---|---|\n| 3 | x | y | z |\n",
])
def test_no_table_means_no_tolerances(body):
    assert nbci.parse_spec_tolerances(body) == {}


def test_row_classification():
    rows = nbci.parse_spec_tolerances(SPEC_28072)
    assert nbci.spec_row_kind(rows[13]) == "invariants"
    assert nbci.spec_row_kind(rows[18]) == "invariants"
    assert nbci.spec_row_kind(rows[23]) == "mixed"
    assert nbci.spec_row_kind(rows[33]) == "mixed"
    assert nbci.spec_row_kind(rows[48]) == "duration"
    assert nbci.spec_row_kind(rows[1]) == "strict"
    assert nbci.spec_row_kind(rows[9]) == "strict"
    assert nbci.spec_row_kind(None) == "strict"          # cell absent from the table


# ------------------------------------------------------------- the behaviour

def _checker_read(text: str, pattern: str):
    m = re.search(pattern, text, re.DOTALL)
    return None if not m else (m.group(1) if m.groups() else m.group(0)).strip()


def _assert_checker_reads_back(wt: Path, built: dict) -> None:
    files = {"python": wt / PY, "rust": wt / RS}
    for m in built["entry"]["measures"]:
        ref = m["sides"]["python"]
        want = _checker_read(nbci.notebook_outputs(files["python"])[ref["cell"]], ref["pattern"])
        assert want is not None, m["id"]
        for side, spec in m["sides"].items():
            if "absent" in spec:
                continue
            got = _checker_read(nbci.notebook_outputs(files[side])[spec["cell"]], spec["pattern"])
            assert got == want, (m["id"], side, got, want)


def test_invariants_row_diverging_is_declared_absent_never_a_divergence(tmp_path):
    spec = _spec("| 1 | **invariants** : grille | invariants (voir Contrat) |"
                 " invariants, pas le committe |\n")
    wt = _repo(tmp_path,
               [_md(), _code([_stream("9 7 2 | 1 8 5\nEnergie initiale: 35\n")])],
               [_md(), _code([_stream("9 6 2 | 1 7 5\nEnergie initiale: 33\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec, spec_ref="#28072")
    assert b["divergences"] == []                      # the cell is never a gate divergence
    rust = b["entry"]["measures"][0]["sides"]["rust"]
    assert rust == {"absent": "contrat a invariants declare par la spec "
                              "(#28072, Tolerances, cellule 1) : invariants, pas le committe"}
    assert b["spec_absent"] == [{"id": "c1_text", "cell": 1,
                                 "reason": rust["absent"]}]
    assert any(s.startswith("c1_text: côté Rust déclaré absent") for s in b["skipped"])
    assert "contrat de la spec" in b["entry"]["measures"][0]["description"]
    _assert_checker_reads_back(wt, b)
    assert nbci.conformance_divergences(wt / PY, wt / RS, spec_body=spec,
                                        spec_ref="#28072") == []
    # without a spec_ref the motif still names the table and the cell
    b2 = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec)
    assert b2["spec_absent"][0]["reason"].startswith(
        "contrat a invariants declare par la spec (Tolerances, cellule 1)")


def test_mixed_row_matching_stays_strict_and_diverging_is_absent(tmp_path):
    spec = _spec("| 1 | en-tete + invariants | voir ci-contre |"
                 " sortie Python cellule 1 + invariants |\n")
    wt = _repo(tmp_path, [_md(), _code([_stream("=== Test ===\nCellules vides: 36\n")])],
               [_md(), _code([_stream("=== Test ===\nCellules vides: 36\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec)
    assert b["divergences"] == [] and b["spec_absent"] == []
    assert b["entry"]["measures"][0]["sides"]["rust"]["cell"] == 1   # strict measure kept
    wt2 = _repo(tmp_path / "div", [_md(), _code([_stream("Temperature Energy\n")])],
                [_md(), _code([_stream("=== Test ===\n")])])
    b2 = nbci.build_conformance_entry(wt2, RS, PY, spec_body=spec, spec_ref="#28072")
    assert b2["divergences"] == []
    assert "contrat a invariants declare par la spec" in \
        b2["entry"]["measures"][0]["sides"]["rust"]["absent"]
    assert len(b2["spec_absent"]) == 1


def test_duration_row_numbers_only_is_absent_a_word_change_is_not(tmp_path):
    spec = _spec("| 1 | tableau ; SAUF les 6 durees |"
                 " egalite stricte ; durees : presence seule | sortie Python cellule 1 |\n")
    py = "Puzzle 1       36        1.8        302.0           None\n"
    wt = _repo(tmp_path, [_md(), _code([_stream(py)])],
               [_md(), _code([_stream("Puzzle 1       36        0.0          0.3           None\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec, spec_ref="#28072")
    assert b["divergences"] == []
    reason = b["entry"]["measures"][0]["sides"]["rust"]["absent"]
    assert reason.startswith("durees en presence seule (spec #28072, Tolerances, cellule 1)")
    assert "egalite stricte ; durees : presence seule" in reason
    assert b["spec_absent"][0]["id"] == "c1_text"
    # the SAME cell where a non-numeric token differs stays a divergence
    # (`None` -> `Some`: a word, not a number -- masking must not hide it)
    wt2 = _repo(tmp_path / "word", [_md(), _code([_stream(py)])],
                [_md(), _code([_stream("Puzzle 1       36        0.0          0.3           Some\n")])])
    b2 = nbci.build_conformance_entry(wt2, RS, PY, spec_body=spec)
    assert [d["id"] for d in b2["divergences"]] == ["c1_text"]
    assert b2["spec_absent"] == []


@pytest.mark.parametrize("tolerance", [
    "egalite stricte ; temps : presence seule",          # App-12 #28069 cell 39
    "egalite stricte ; ms/coup : presence seule",        # App-12 #28069 cell 55
    "egalite stricte ; durées murales : présence seule",
])
def test_duration_row_wordings_seen_in_specs(tolerance):
    row = {"quantity": "tableau du tournoi", "tolerance": tolerance,
           "compare": "sortie Python cellule 39"}
    assert nbci.spec_row_kind(row) == "duration"


def test_duration_word_without_presence_seule_stays_strict():
    row = {"quantity": "temps de calcul", "tolerance": "egalite stricte",
           "compare": "sortie Python cellule 3"}
    assert nbci.spec_row_kind(row) == "strict"


def test_duration_row_never_hides_an_integer_result(tmp_path):
    """App-12 #28069 cell 39: `Greedy 6W-0D-0L ... 2306.2` vs a Rust run that
    wins fewer games. The duration row tolerates the wall-clock DECIMAL, never
    the integer game results printed next to it."""
    spec = _spec("| 1 | tableau du tournoi | egalite stricte ; temps : presence seule |"
                 " sortie Python cellule 1 |\n")
    # a table column with no unit: the duration-LINE detector cannot anchor it,
    # only the spec row can tolerate it
    py = "Greedy      6W-0D-0L   Score 66   2306.2\n"
    wt = _repo(tmp_path, [_md(), _code([_stream(py)])],
               [_md(), _code([_stream("Greedy      6W-0D-0L   Score 66   1.7\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec, spec_ref="#28069")
    assert b["divergences"] == []
    assert b["entry"]["measures"][0]["sides"]["rust"]["absent"].startswith(
        "durees en presence seule (spec #28069, Tolerances, cellule 1)")
    for i, wrong in enumerate(("Greedy      4W-0D-2L   Score 66   1.7\n",     # W/D/L
                               "Greedy      6W-0D-0L   Score 48   1.7\n")):   # score
        wt2 = _repo(tmp_path / f"wrong{i}", [_md(), _code([_stream(py)])],
                    [_md(), _code([_stream(wrong)])])
        b2 = nbci.build_conformance_entry(wt2, RS, PY, spec_body=spec)
        assert [d["id"] for d in b2["divergences"]] == ["c1_text"], wrong
        assert b2["spec_absent"] == []


def test_strict_rows_and_absent_cells_stay_strict(tmp_path):
    """App-12 (#28069) reproduces MT19937 exactly: its rows are all strict, and a
    one-character divergence must still fail the gate. A cell with NO row too."""
    spec = _spec("| 2 | sortie exacte | egalite stricte | sortie Python cellule 2 |\n")
    # cell 1 has NO row, cell 2 a strict row: both must fail on a one-char gap
    wt = _repo(tmp_path, [_md(), _code([_stream("a\n")]), _code([_stream("b\n")])],
               [_md(), _code([_stream("A\n")]), _code([_stream("B\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec)
    assert [d["id"] for d in b["divergences"]] == ["c1_text", "c2_text"]
    assert b["spec_absent"] == []
    assert nbci.conformance_divergences(wt / PY, wt / RS, spec_body=spec) == \
        b["divergences"]


def test_no_table_behaviour_identical_to_today(tmp_path):
    wt = _repo(tmp_path, [_code([_stream("9 7 2\n")]), _code([_stream("ok\n")])],
               [_code([_stream("9 6 2\n")]), _code([_stream("ok\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY)
    assert [d["id"] for d in b["divergences"]] == ["c0_text"]
    assert b["spec_absent"] == []
    # a spec WITHOUT a table changes nothing either
    b2 = nbci.build_conformance_entry(wt, RS, PY, spec_body="## Tolerances\n\nprose\n")
    assert b2["divergences"] == b["divergences"] and b2["spec_absent"] == []


def test_yaml_renders_and_loads_the_absent_side(tmp_path):
    yaml = pytest.importorskip("yaml")
    spec = _spec("| 1 | **invariants** | invariants | invariants, pas le committe |\n")
    wt = _repo(tmp_path, [_md(), _code([_stream("grille A\n")])],
               [_md(), _code([_stream("grille B\n")])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec, spec_ref="#28072")
    text = nbci.render_conformance_yaml(b)
    assert "#   - c1_text: côté Rust déclaré absent -- contrat a invariants" in text
    doc = yaml.safe_load(text)
    assert doc[0]["measures"] == b["entry"]["measures"]
    assert doc[0]["measures"][0]["sides"]["rust"] == \
        {"absent": b["spec_absent"][0]["reason"]}


# ------------------------------------------------------------- driver wiring

def _driver():
    pytest.importorskip("mcp")
    spec = importlib.util.spec_from_file_location("nbcd_tol", _HERE / "nb_coder_driver.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_gate_honours_the_spec_tolerances(tmp_path):
    """#28072's failure mode: the gate turns green on the spec's own contract."""
    nbcd = _driver()
    spec = _spec("| 1 | **invariants** | invariants | invariants, pas le committe |\n")
    src = _nb(tmp_path / "twin.ipynb", [_md(), _code([_stream("9 7 2\n")])])
    built = _nb(tmp_path / "built.ipynb", [_md(), _code([_stream("9 6 2\n")])], "rust")
    strict = nbcd.rust_conformance_gate(src, built)
    assert strict["ok"] is False and strict["detail"]["cells"] == [1]
    tol = nbcd.rust_conformance_gate(src, built, spec_body=spec, spec_ref="#28072")
    assert tol["ok"] is True and tol["detail"]["cells"] == []


def test_run_gates_threads_the_spec_body(tmp_path):
    nbcd = _driver()
    spec = _spec("| 1 | **invariants** | invariants | invariants, pas le committe |\n")
    src = _nb(tmp_path / "twin.ipynb", [_md(), _code([_stream("9 7 2\n")])])
    built = _nb(tmp_path / "built.ipynb", [_md(), _code([_stream("9 6 2\n")])], "rust")
    gates = nbcd.run_gates(src, built, create_mode=True, rel=RS,
                           spec_body=spec, spec_ref="#28072")
    conf = [g for g in gates if g["gate"] == "rust-conformance"][0]
    assert conf["ok"] is True


def test_pr_body_says_the_spec_declared_absent_sides():
    nbcd = _driver()
    body = nbcd.integration_pr_lines({
        "readme": "Rust", "nav": "list",
        "conformance": {"todo": True, "file": "scripts/notebook_tools/rust_conformance.d/x.yaml",
                        "measures": 9, "three_sided": 0,
                        "spec_absent": [{"id": "c1_text", "cell": 1,
                                         "reason": "contrat a invariants declare par la spec "
                                                   "(#28072, Tolerances, cellule 1) : "
                                                   "invariants, pas le committe"}],
                        "divergences": []}})
    assert "Côté Rust déclaré absent c1_text" in body
    assert "contrat a invariants declare par la spec (#28072" in body
    # absent only when the generator declared one
    clean = nbcd.integration_pr_lines({
        "readme": "Rust", "nav": "list",
        "conformance": {"todo": True, "file": "f.yaml", "measures": 3, "three_sided": 0,
                        "spec_absent": [], "divergences": []}})
    assert "déclaré absent" not in clean
