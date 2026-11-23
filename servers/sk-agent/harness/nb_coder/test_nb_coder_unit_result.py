# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_unit_result.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""unit-result gate (21/11): a Rust port whose cell ends with a block displays a bare `()`
under evcxr. 11 of 34 verifier traces rejected a port for it; the gate catches it after
execution and routes it to the repair loop with the measured `};` remedy."""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

_DRV = Path(__file__).resolve().parent / "nb_coder_driver.py"
_spec = importlib.util.spec_from_file_location("nbcd_unitres", _DRV)
nbcd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nbcd)


def _nb(p: Path, cells: list) -> Path:
    p.write_text(json.dumps({"cells": cells, "nbformat": 4, "nbformat_minor": 5,
                             "metadata": {}}), encoding="utf-8")
    return p


def _code(outputs: list, source: str = "x") -> dict:
    return {"cell_type": "code", "source": source, "outputs": outputs, "metadata": {},
            "execution_count": 1}


def _unit(text="()"):
    return {"output_type": "execute_result", "execution_count": 1,
            "data": {"text/plain": text}, "metadata": {}}


def _stream(text):
    return {"output_type": "stream", "name": "stdout", "text": text}


def _gate(gates, name):
    return next(g for g in gates if g["gate"] == name)


def test_bare_unit_after_output_fails(tmp_path):
    src = _nb(tmp_path / "s.ipynb", [_code([_stream("1\n2\n")], "for i in r: print(i)")])
    built = _nb(tmp_path / "b.ipynb",
                [_code([_stream("1\n2\n"), _unit()], "for i in 1..3 { println!(\"{i}\"); }")])
    g = _gate(nbcd.run_gates(src, built, create_mode=True), "unit-result")
    assert g["ok"] is False
    assert g["detail"]["cells"] == [0]
    assert "« () »" in g["detail"]["findings"][0]["text"]


def test_unit_with_whitespace_and_list_text_fails(tmp_path):
    src = _nb(tmp_path / "s.ipynb", [_code([])])
    built = _nb(tmp_path / "b.ipynb", [_code([_unit(["()", "\n"])])])
    assert _gate(nbcd.run_gates(src, built), "unit-result")["ok"] is False


def test_real_values_and_streams_pass(tmp_path):
    src = _nb(tmp_path / "s.ipynb", [_code([]), _code([]), _code([])])
    built = _nb(tmp_path / "b.ipynb", [
        _code([_unit("(1, 2)")]),                          # a real tuple value
        _code([_stream("()\n")]),                          # printed, not the unit result
        _code([{"output_type": "execute_result", "execution_count": 1, "metadata": {},
                "data": {"text/plain": "()", "text/html": "<b>()</b>"}}]),  # rich value
    ])
    assert _gate(nbcd.run_gates(src, built), "unit-result")["ok"] is True


def test_unit_already_in_twin_is_not_charged(tmp_path):
    src = _nb(tmp_path / "s.ipynb", [_code([_unit()])])
    built = _nb(tmp_path / "b.ipynb", [_code([_unit()])])
    g = _gate(nbcd.run_gates(src, built), "unit-result")
    assert g["ok"] is True and g["detail"]["cells"] == []


def test_markdown_cell_never_flagged(tmp_path):
    src = _nb(tmp_path / "s.ipynb", [])
    md = {"cell_type": "markdown", "source": "()", "metadata": {},
          "outputs": [_unit()]}
    built = _nb(tmp_path / "b.ipynb", [md])
    assert _gate(nbcd.run_gates(src, built), "unit-result")["ok"] is True


def test_gate_routes_to_repair_with_semicolon_remedy(tmp_path):
    src = _nb(tmp_path / "s.ipynb", [_code([]), _code([])])
    built = _nb(tmp_path / "b.ipynb", [_code([]), _code([_unit()])])
    rec = {"gates": nbcd.run_gates(src, built)}
    findings = nbcd.gate_repair_findings(rec)
    hits = [f for f in findings if "unit-result" in f["detail"]]
    assert len(hits) == 1 and hits[0]["cell"] == 1
    assert "`};`" in hits[0]["detail"]
    assert "unit-result" not in nbcd._GATE_NON_REPAIRABLE
