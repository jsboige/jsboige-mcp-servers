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


# =============================================================================
# CoursIA#28944 (28/11) : le vocabulaire du coordinateur -- « non comparee »,
# « forme seulement », « ecart declare » -- et le MASQUE qui les honore.
#
# Ces trois lignes ne disent PAS « cette cellule n'est pas comparee » : elles
# nomment UNE valeur. L'organe les lisait comme `strict` (toute la table
# d'etre stricte), donc la porte de l'etape 3 exigeait l'egalite stricte du
# texte -- et le producteur recopiait les constantes du jumeau Python au lieu
# de ses durees mesurees (deux refus successifs, 22/11 et 28/11).
#
# Le masque remplace la valeur nommee par une classe non capturante et compare
# TOUT LE RESTE, morceau par morceau : un compteur change, une ligne en trop,
# un mot ajoute restent des divergences.
# =============================================================================

_TEMPS_HEADER = "Strategie                    Assigns   Backtracks    Temps(ms)   Succes"
_TEMPS_PY = ("=== Benchmark sur 2 puzzles faciles ===\n"
             + _TEMPS_HEADER + "\n"
             "BACKTRACKING SIMPLE          2889322       499461         1613 2/2\n"
             "FORWARD CHECKING                  81            0            9 2/2\n")
_TEMPS_RS = ("=== Benchmark sur 2 puzzles faciles ===\n"
             + _TEMPS_HEADER + "\n"
             "BACKTRACKING SIMPLE          2889322       499461           15 2/2\n"
             "FORWARD CHECKING                  81            0           11 2/2\n")

_ROW_NON_COMPARABLE = ("| 1 | `Temps(ms)` (2 valeurs) | **non comparee** |"
                       " declaree non comparable (machines et langages differents) |\n")
# Une grandeur qui n'est PAS une duree : une ligne de duree est deja portee par
# le mecanisme des ancres (decimales en presence seule, le reste du modele
# compare) ; le masque `forme seulement` est ce qui reste quand elle ne l'est pas.
_ROW_FORM = ("| 1 | `Taux de resolution: …%` | **forme seulement** |"
             " regex `Taux de resolution: [0-9.]+ % \\(81 grilles, 0 echec\\)` |\n")
_ROW_GAP = ("| 1 | separateur de chemin | **ecart declare** |"
            " `/` au lieu de `\\`, une seule ligne concernee |\n")


def test_parse_keeps_every_row_of_a_cell():
    """Une cellule peut porter PLUSIEURS lignes de tolerance (#28944 cellule 33
    : les compteurs exacts ET la duree non comparee). Jusqu'ici la derniere
    ligne ecrasait les precedentes : une ligne stricte disparaissait sous la
    ligne toleree posee en dessous."""
    spec = _spec(_ROW_NON_COMPARABLE
                 + "| 1 | `assignations`, `backtracks` | **exacte** (entiers) |"
                   " sortie Python cellule 1 |\n")
    rows = nbci.parse_spec_tolerance_rows(spec)
    assert len(rows[1]) == 2
    assert rows[1][0]["tolerance"] == "**non comparee**"
    assert rows[1][1]["tolerance"] == "**exacte** (entiers)"
    merged = nbci.parse_spec_tolerances(spec)[1]
    assert merged["rows"] == rows[1]
    assert "non comparee" in merged["tolerance"] and "exacte" in merged["tolerance"]


def test_new_vocabulary_is_classified():
    assert nbci._spec_one_row_kind(
        {"quantity": "`Temps(ms)` (6 valeurs)", "tolerance": "**non comparee**",
         "compare": "declaree non comparable"}) == "non_comparable"
    assert nbci._spec_one_row_kind(
        {"quantity": "`Solution (MAC)`", "tolerance": "**forme seulement**",
         "compare": "regex `x`"}) == "form"
    assert nbci._spec_one_row_kind(
        {"quantity": "separateur", "tolerance": "**ecart declare**",
         "compare": "`/` au lieu de `\\`"}) == "declared_gap"
    # accents et casse : la table du coordinateur les porte
    assert nbci._spec_one_row_kind(
        {"quantity": "x", "tolerance": "**non comparée**", "compare": "y"}) == "non_comparable"
    assert nbci._spec_one_row_kind(
        {"quantity": "x", "tolerance": "**forme seule**", "compare": "y"}) == "form"
    assert nbci._spec_one_row_kind(
        {"quantity": "x", "tolerance": "**écart déclaré**", "compare": "y"}) == "declared_gap"


def test_rows_kind_never_loses_a_strict_row():
    """Le kind d'une CELLULE vient de TOUTES ses lignes, et fail-closed : une
    ligne qui exige l'egalite exacte n'est jamais absorbee par une ligne
    tolerante."""
    exact = {"quantity": "a", "tolerance": "**exacte**", "compare": "sortie Python"}
    noncomp = {"quantity": "`Temps(ms)`", "tolerance": "**non comparee**", "compare": "x"}
    inv = {"quantity": "a", "tolerance": "invariants", "compare": "invariants, pas le committe"}
    dur = {"quantity": "a", "tolerance": "durees : presence seule", "compare": "sortie Python"}
    assert nbci.spec_rows_kind([exact, noncomp]) == "strict"
    assert nbci.spec_rows_kind([noncomp, exact]) == "strict"
    assert nbci.spec_rows_kind([inv, inv]) == "invariants"
    assert nbci.spec_rows_kind([inv, exact]) == "strict"
    assert nbci.spec_rows_kind([dur, noncomp]) == "duration"
    assert nbci.spec_rows_kind([noncomp]) == "strict"
    # la ligne fusionnee d'une cellule multi-lignes porte le kind de ses lignes
    # (#28944 cellule 33 : la duree non comparee POSEE SOUS les compteurs exacts)
    merged = nbci.parse_spec_tolerances(_spec(
        _ROW_NON_COMPARABLE
        + "| 1 | `assignations`, `backtracks` | **exacte** (entiers) |"
          " sortie Python cellule 1 |\n"))[1]
    assert merged["rows"] and nbci.spec_row_kind(merged) == "strict"


def test_non_comparable_masks_the_duration_and_keeps_the_counters(tmp_path):
    """La duree n'est pas comparee ; le compteur qui l'accompagne, si."""
    spec = _spec(_ROW_NON_COMPARABLE)
    wt = _repo(tmp_path, [_md(), _code([_stream(_TEMPS_PY)])],
               [_md(), _code([_stream(_TEMPS_RS)])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec, spec_ref="#28944")
    assert b["divergences"] == []
    assert len(b["spec_masked"]) == 1 and b["spec_masked"][0]["cell"] == 1
    ids = [m["id"] for m in b["entry"]["measures"]]
    assert "c1_text_structure" in ids           # l'ordre des lignes et des jetons
    assert "c1_text_l1" in ids                  # la ligne de titre
    assert len(ids) == 7                        # titre + en-tete + 4 morceaux + structure
    assert ids[:2] == ["c1_text_l1", "c1_text_l2"]
    _assert_checker_reads_back(wt, b)
    # le compteur qui suit la duree ne voyage PAS avec elle
    bad = _TEMPS_RS.replace("2889322", "2889323")
    wt2 = _repo(tmp_path / "counter", [_md(), _code([_stream(_TEMPS_PY)])],
                [_md(), _code([_stream(bad)])])
    b2 = nbci.build_conformance_entry(wt2, RS, PY, spec_body=spec, spec_ref="#28944")
    assert [d["id"] for d in b2["divergences"]] == ["c1_text"]
    assert "ne couvre que la valeur qu'elle nomme" in b2["divergences"][0]["text"]
    # le message nomme le compteur fautif et JAMAIS la duree toleree : un
    # message qui montre d'abord l'ecart de duree envoie le producteur recopier
    # les constantes du jumeau Python (defaut mesure sur #28944)
    text = b2["divergences"][0]["text"]
    assert "« 2889323 » côté Rust contre « 2889322 » côté Python" in text
    assert "1613" not in text and "15 2/2" not in text


def test_an_invariants_row_beside_an_exact_row_is_named(tmp_path):
    """Deux lignes pour une cellule : des compteurs EXACTS et une grandeur
    « invariants ». La cellule reste stricte (fail-closed : le contrat
    `invariants` declare TOUT le cote Rust absent, les compteurs avec) et la
    divergence dit laquelle de ses lignes n'a pas pu s'appliquer, et comment
    l'ecrire pour qu'elle le soit."""
    spec = _spec("| 1 | `Temps(ms)` (2 valeurs) : durees non reproductibles |"
                 " **invariants** | invariants, pas le committe |\n"
                 "| 1 | `Assigns`, `Backtracks` | **exacte** (entiers) |"
                 " sortie Python cellule 1 |\n")
    wt = _repo(tmp_path, [_md(), _code([_stream(_TEMPS_PY)])],
               [_md(), _code([_stream(_TEMPS_RS)])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec, spec_ref="#28944")
    assert [d["id"] for d in b["divergences"]] == ["c1_text"]
    assert b["spec_masked"] == [] and b["spec_absent"] == []
    text = b["divergences"][0]["text"]
    assert "tenues pour strictes" in text and "**invariants**" in text
    assert "« non comparée »" in text


def test_non_comparable_refuses_when_the_declared_count_is_not_read(tmp_path):
    """La ligne declare SIX valeurs ; la colonne n'en porte que deux : le
    masque ne s'applique pas et le dit."""
    spec = _spec("| 1 | `Temps(ms)` (6 valeurs) | **non comparee** | x |\n")
    wt = _repo(tmp_path, [_md(), _code([_stream(_TEMPS_PY)])],
               [_md(), _code([_stream(_TEMPS_RS)])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec, spec_ref="#28944")
    assert [d["id"] for d in b["divergences"]] == ["c1_text"]
    assert "6 valeur(s)" in b["divergences"][0]["text"]
    assert b["spec_masked"] == []


def test_non_comparable_refuses_a_value_that_is_not_a_number(tmp_path):
    spec = _spec(_ROW_NON_COMPARABLE)
    bad = _TEMPS_RS.replace("           15 2/2", "           abc 2/2")
    wt = _repo(tmp_path, [_md(), _code([_stream(_TEMPS_PY)])],
               [_md(), _code([_stream(bad)])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec, spec_ref="#28944")
    assert [d["id"] for d in b["divergences"]] == ["c1_text"]
    assert "un nombre est attendu" in b["divergences"][0]["text"]


def test_non_comparable_refuses_a_line_more(tmp_path):
    spec = _spec(_ROW_NON_COMPARABLE)
    bad = _TEMPS_RS + "MAC                               81            0           11 2/2\n"
    wt = _repo(tmp_path, [_md(), _code([_stream(_TEMPS_PY)])],
               [_md(), _code([_stream(bad)])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec, spec_ref="#28944")
    assert [d["id"] for d in b["divergences"]] == ["c1_text"]
    assert "lignes côté Python" in b["divergences"][0]["text"]


def test_form_masks_the_number_and_pins_the_counters(tmp_path):
    """`forme seulement` : la regex de la ligne est satisfaite par les DEUX
    cotes, et seule la partie variable (le nombre) est masquee."""
    py = "Taux de resolution: 33.7 % (81 grilles, 0 echec)\n"
    rs = "Taux de resolution: 6.1 % (81 grilles, 0 echec)\n"
    spec = _spec(_ROW_FORM)
    wt = _repo(tmp_path, [_md(), _code([_stream(py)])],
               [_md(), _code([_stream(rs)])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec, spec_ref="#28944")
    assert b["divergences"] == []
    assert len(b["spec_masked"]) == 1 and b["spec_masked"][0]["cell"] == 1
    ids = [m["id"] for m in b["entry"]["measures"]]
    assert len(ids) == 3 and "c1_text_structure" in ids   # 2 morceaux + structure
    _assert_checker_reads_back(wt, b)
    # le compteur que la regex pinne reste compare : la sortie Rust ne
    # satisfait plus la forme declaree -- le masque ne s'applique pas et le dit
    bad = rs.replace("81 grilles", "82 grilles")
    wt2 = _repo(tmp_path / "counter", [_md(), _code([_stream(py)])],
                [_md(), _code([_stream(bad)])])
    b2 = nbci.build_conformance_entry(wt2, RS, PY, spec_body=spec, spec_ref="#28944")
    assert [d["id"] for d in b2["divergences"]] == ["c1_text"]
    assert "ne satisfait pas la regex" in b2["divergences"][0]["text"]
    assert b2["spec_masked"] == []


def test_declared_gap_masks_the_named_difference_only(tmp_path):
    py = "Dossier Puzzles: <repo>MyIA.AI.Notebooks\\Sudoku\\Puzzles\n"
    rs = "Dossier Puzzles: <repo>MyIA.AI.Notebooks/Sudoku/Puzzles\n"
    spec = _spec(_ROW_GAP)
    wt = _repo(tmp_path, [_md(), _code([_stream(py)])],
               [_md(), _code([_stream(rs)])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec, spec_ref="#28944")
    assert b["divergences"] == []
    assert len(b["spec_masked"]) == 1
    _assert_checker_reads_back(wt, b)
    # une AUTRE difference sur la meme ligne : l'ecart declare n'est pas la
    # seule difference -- le masque ne s'applique pas et le dit
    bad = rs.replace("Dossier Puzzles:", "Dossier Puzzles extra:")
    wt2 = _repo(tmp_path / "word", [_md(), _code([_stream(py)])],
                [_md(), _code([_stream(bad)])])
    b2 = nbci.build_conformance_entry(wt2, RS, PY, spec_body=spec, spec_ref="#28944")
    assert [d["id"] for d in b2["divergences"]] == ["c1_text"]
    assert "n'est pas la seule différence" in b2["divergences"][0]["text"]
    assert b2["spec_masked"] == []


def test_masked_cell_is_written_in_the_yaml_with_its_reason(tmp_path):
    yaml = pytest.importorskip("yaml")
    spec = _spec(_ROW_NON_COMPARABLE)
    wt = _repo(tmp_path, [_md(), _code([_stream(_TEMPS_PY)])],
               [_md(), _code([_stream(_TEMPS_RS)])])
    b = nbci.build_conformance_entry(wt, RS, PY, spec_body=spec, spec_ref="#28944")
    text = nbci.render_conformance_yaml(b)
    assert "Valeurs non comparées" in text
    assert "c1_text : valeur non comparée" in text
    doc = yaml.safe_load(text)
    assert doc[0]["measures"] == b["entry"]["measures"]


def test_gate_goes_green_on_a_masked_cell_and_red_on_a_counter(tmp_path):
    """La porte de l'etape 3 : sous la table du #28944, la duree mesuree par
    le port Rust est acceptee ; un compteur change reste un echec."""
    nbcd = _driver()
    spec = _spec(_ROW_NON_COMPARABLE)
    src = _nb(tmp_path / "twin.ipynb", [_md(), _code([_stream(_TEMPS_PY)])])
    built = _nb(tmp_path / "built.ipynb", [_md(), _code([_stream(_TEMPS_RS)])], "rust")
    strict = nbcd.rust_conformance_gate(src, built)
    assert strict["ok"] is False
    tol = nbcd.rust_conformance_gate(src, built, spec_body=spec, spec_ref="#28944")
    assert tol["ok"] is True and tol["detail"]["cells"] == []
    bad = _nb(tmp_path / "bad.ipynb", [_md(), _code([_stream(_TEMPS_RS.replace(
        "2889322", "2889323"))])], "rust")
    red = nbcd.rust_conformance_gate(src, bad, spec_body=spec, spec_ref="#28944")
    assert red["ok"] is False and red["detail"]["cells"] == [1]


def test_pr_body_says_the_masked_value():
    nbcd = _driver()
    body = nbcd.integration_pr_lines({
        "readme": "Rust", "nav": "list",
        "conformance": {"todo": True, "file": "f.yaml", "measures": 6, "three_sided": 0,
                        "spec_absent": [],
                        "spec_masked": [{"id": "c1_text", "cell": 1,
                                         "reason": "valeur non comparée, déclarée par la spec "
                                                   "(#28944, Tolerances, cellule 1) : "
                                                   "**non comparee**"}],
                        "divergences": []}})
    assert "Valeur non comparée c1_text" in body
    assert "tout le reste comparé" in body
