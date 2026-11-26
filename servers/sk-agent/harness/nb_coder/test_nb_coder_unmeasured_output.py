# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# NEW in this tree (26/11): no jsboige/vllm original. The failure class it pins (a twin
# declaring a parity comparison it never ran) was measured on CoursIA batch o41, after the
# 22/11 cutover. This tree is the source of truth; the vllm copy of the sibling tests stays
# frozen at 7a09e1caec22441d9402ab25a222206c8905bfe1 — never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""unmeasured-output gate (26/11, CoursIA batch o41): the producer left its cited-data
collection EMPTY and guarded the parity comparison behind it. The cell ran clean, its
output said « non attestée » / « NON MESURÉ — aucune comparaison exécutée », and the
verifier rejected the same major at every round — 3 of 4 grains, 7 revision turns. The
declaration is deterministic on the OUTPUTS: the gate catches it right after execution,
before a verifier turn is paid, and hands the repair loop the measured remedy."""
import importlib.util
import json
from pathlib import Path

import pytest

pytest.importorskip("mcp")

_DRV = Path(__file__).resolve().parent / "nb_coder_driver.py"
_spec = importlib.util.spec_from_file_location("nbcd_unmeas", _DRV)
nbcd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nbcd)


def _nb(p: Path, cells: list) -> Path:
    p.write_text(json.dumps({"cells": cells, "nbformat": 4, "nbformat_minor": 5,
                             "metadata": {}}), encoding="utf-8")
    return p


def _code(outputs: list, source: str = "x") -> dict:
    return {"cell_type": "code", "source": source, "outputs": outputs, "metadata": {},
            "execution_count": 1}


def _stream(text):
    return {"output_type": "stream", "name": "stdout", "text": text}


def _gate(gates, name):
    return next(g for g in gates if g["gate"] == name)


# The four declarations the three rejected o41 twins printed (read from their built
# notebooks, 26/11) — one per phrasing family, verbatim.
REJECTED_LINES = [
    "Parité EXP3 non attestée : les flux uniformes NumPy cités ne sont pas renseignés.",
    "Bench EXP3 non exécuté : séquence de préférences ou flux uniformes cités incomplets.",
    "Exemple 4 — Contre-exemple : NON MESURÉ — aucune comparaison exécutée.",
    "Corpus exact non fourni : 500 matrices 4x4 (graine Python 2026). "
    "Les écarts C# du corpus ne sont pas mesurés.",
    "Références citées, non recalculées : moyenne 4.83 ; maximum 30 ; "
    "glouton optimal sur 186/500 matrices.",
]


@pytest.mark.parametrize("line", REJECTED_LINES)
def test_declared_non_measure_fails(tmp_path, line):
    src = _nb(tmp_path / "s.ipynb", [_code([_stream("gains: [3.2, 4.83]\n")],
                                          "random.seed(42); print(gains)")])
    built = _nb(tmp_path / "b.ipynb", [_code([_stream(line + "\n")], "if (cites.Count > 0)")])
    g = _gate(nbcd.run_gates(src, built, create_mode=True), "unmeasured-output")
    assert g["ok"] is False
    assert g["detail"]["cells"] == [0]
    assert line.split(":")[0][:20] in g["detail"]["findings"][0]["text"]


def test_measured_comparison_passes(tmp_path):
    src = _nb(tmp_path / "s.ipynb", [_code([_stream("gain moyen 4.83\n")])])
    built = _nb(tmp_path / "b.ipynb", [_code([_stream(
        "Attestation de parité — contrôles numériques du rejeu C# :\n"
        "  §4 : CONFORME, 33 comparaisons ; écart maximal 0.00431356 (tolérance 0.005).\n")],
        "VerifierEcart(4, 4.83, 4.8312, TolerancePubliee(2));")])
    assert _gate(nbcd.run_gates(src, built, create_mode=True), "unmeasured-output")["ok"] is True


def test_out_of_scope_statement_beside_an_attestation_passes(tmp_path):
    """The approved twin of the same batch (CoursIA PR #28659, verify approve round 0)
    prints, in the cell that carries its attestation, one line about facts no twin can
    measure (real HTTP, Python tokens). A bare « non mesuré » is not a skipped comparison."""
    src = _nb(tmp_path / "s.ipynb", [_code([_stream("synthese v2\n")])])
    built = _nb(tmp_path / "b.ipynb", [_code([_stream(
        "Attestation de parité — contrôles numériques du rejeu C# :\n"
        "  §10.3 : CONFORME, 94 comparaisons ; écart maximal 0.00333333 (tolérance 0.005).\n"
        "  Citations seules, non mesurées ici : chargement historique de la clé, "
        "tentatives HTTP réelles, tokens et durée cumulée Python.\n")])])
    g = _gate(nbcd.run_gates(src, built, create_mode=True), "unmeasured-output")
    assert g["ok"] is True and g["detail"]["cells"] == []


def test_declaration_already_in_the_twin_is_not_charged(tmp_path):
    line = "Exemple 4 — Contre-exemple : NON MESURÉ — aucune comparaison exécutée."
    src = _nb(tmp_path / "s.ipynb", [_code([_stream(line + "\n")])])
    built = _nb(tmp_path / "b.ipynb", [_code([_stream(line + "\n")])])
    g = _gate(nbcd.run_gates(src, built), "unmeasured-output")
    assert g["ok"] is True and g["detail"]["cells"] == []


def test_markdown_cell_never_flagged(tmp_path):
    src = _nb(tmp_path / "s.ipynb", [])
    md = {"cell_type": "markdown",
          "source": "Parité non attestée : aucune comparaison exécutée.", "metadata": {},
          "outputs": [_stream("NON MESURÉ")]}
    built = _nb(tmp_path / "b.ipynb", [md])
    assert _gate(nbcd.run_gates(src, built), "unmeasured-output")["ok"] is True


def test_the_gate_declares_it_measured_whatever_it_finds(tmp_path):
    """Review ai-01 (26/11): the detail carried no `measured` key, where `_unmeasured()`
    writes False and prose-counts writes True. The gate always ran on the built cells, so
    both verdicts say so; a pass lands in the measured bucket, a fail in neither."""
    src = _nb(tmp_path / "s.ipynb", [_code([_stream("gain moyen 4.83\n")])])
    for line, ok in (("Parité EXP3 non attestée : les flux cités ne sont pas renseignés.\n",
                      False),
                     ("§4 : CONFORME, 33 comparaisons ; écart maximal 0.00431356.\n", True)):
        built = _nb(tmp_path / "b.ipynb", [_code([_stream(line)], "VerifierEcart(4, 4.83);")])
        g = _gate(nbcd.run_gates(src, built, create_mode=True), "unmeasured-output")
        assert g["ok"] is ok
        assert g["detail"]["measured"] is True
        assert nbcd.split_gates([g]) == (["unmeasured-output"] if ok else [], [])


def test_gate_routes_to_repair_with_the_reconstruction_remedy(tmp_path):
    src = _nb(tmp_path / "s.ipynb", [_code([_stream("4.83\n")]), _code([_stream("30\n")])])
    built = _nb(tmp_path / "b.ipynb", [
        _code([_stream("4.83\n")]),
        _code([_stream("Références citées, non recalculées : maximum 30.\n")])])
    rec = {"gates": nbcd.run_gates(src, built, create_mode=True)}
    findings = [f for f in nbcd.gate_repair_findings(rec) if "unmeasured-output" in f["detail"]]
    assert len(findings) == 1 and findings[0]["cell"] == 1
    assert findings[0]["severity"] == "major"
    assert "non recalculées" in findings[0]["detail"]      # the offending line rides along
    assert "MT19937" in findings[0]["detail"]              # … and the measured remedy
    assert "unmeasured-output" not in nbcd._GATE_NON_REPAIRABLE


def _src_with_output():
    return [_code([_stream("regret moyen 0.31\n")], "rng = random.Random(7)\nprint(regret)")]


def test_tirages_rule_reaches_the_creation_prompt():
    out = nbcd.creation_json_prompt([{"idx": 0, "cell_type": "code"}], 1,
                                    src_cells=_src_with_output())
    assert "- TIRAGES" in out
    assert "MT19937" in out
    # the removed TWIN_VALUES tail let a value the target library cannot reproduce be
    # "said in prose" with the comparison never run — the dormant branch of o41
    assert "affiche l'écart mesuré" not in out
    # the numpy-data clause may keep "cite the drawn data", but a cited literal must be
    # COMPLETE and the recomputed results COMPARED (o41 #28654 printed the opposite)
    assert "COMPLET" in out and "COMPARE ces résultats recalculés" in out


def test_tirages_rule_reaches_the_revision_prompt_with_a_twin_view():
    issue = {"title": "Parité C# — portage", "body": "portage C#"}
    out = nbcd.revision_prompt(issue, "vue", [{"cell": 1, "severity": "major", "detail": "x"}],
                               conventions="", twin_view="code et sorties du jumeau")
    assert "- TIRAGES" in out
    # no twin reference in view: nothing to reconstruct against, the rule stays out
    out2 = nbcd.revision_prompt(issue, "vue", [{"cell": 1, "severity": "major", "detail": "x"}])
    assert "- TIRAGES" not in out2
