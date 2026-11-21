# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7416ac16c91e150aae5a75dd251d0c1a4c2f5c2c
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_gates.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Regression pins for the svg-display gate (jsboige/vllm#464, CoursIA #26921).

The user asked for the organ that catches the defect: a figure cell emitting its SVG as
stdout / text-html instead of a display_data image/svg+xml. The gate is delta-judged like
machine-path: an untouched cell keeps its pre-existing defect (reported, not failing);
only what THIS build introduces fails.

Calibration cells:
  TP  = PR #26921 pre-fix  (stream carries the SVG, no display_data)
  TN  = e5033b5142e0 post-fix (display_data image/svg+xml)

Skipped when `mcp` is not importable (the driver imports the MCP client at load).
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

_DRV = Path(__file__).resolve().parent / "nb_coder_driver.py"
_spec = importlib.util.spec_from_file_location("nbcd_gates", _DRV)
nbcd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nbcd)


def _nb(tmp_path: Path, cells: list, name: str) -> Path:
    p = tmp_path / name
    p.write_text(json.dumps({"cells": cells, "nbformat": 4, "nbformat_minor": 5}),
                 encoding="utf-8")
    return p


def _code(outputs: list, source: str = "fig") -> dict:
    return {"cell_type": "code", "source": source, "outputs": outputs, "metadata": {},
            "execution_count": 1}


def _svg_stream() -> dict:
    return {"output_type": "stream", "name": "stdout", "text": "<svg width='10'><g/></svg>"}


def _svg_display() -> dict:
    return {"output_type": "display_data",
            "data": {"image/svg+xml": "<svg width='10'><g/></svg>"},
            "metadata": {}}


def _gate(gates: list, name: str) -> dict:
    return next(g for g in gates if g["gate"] == name)


def test_tp_26921_svg_in_stdout_fails_when_introduced(tmp_path):
    """Pre-fix #26921 form: the build's figure cell prints the SVG -> gate RED."""
    src = _nb(tmp_path, [_code([{"output_type": "stream", "name": "stdout",
                                 "text": "rendering figure..."}], source="old")], "s.ipynb")
    built = _nb(tmp_path, [_code([_svg_stream()], source="new")], "b.ipynb")
    g = _gate(nbcd.run_gates(src, built), "svg-display")
    assert not g["ok"] and g["detail"]["cells"] == [0]


def test_tp_untouched_preexisting_defect_is_reported_not_failed(tmp_path):
    """Delta rule: identical outputs in source and built = the repo's business."""
    cells = [_code([_svg_stream()])]
    src, built = _nb(tmp_path, cells, "s.ipynb"), _nb(tmp_path, cells, "b.ipynb")
    g = _gate(nbcd.run_gates(src, built), "svg-display")
    assert g["ok"] and g["detail"]["source_hits"] == [0]


def test_tn_svg_display_data_is_clean_even_with_stray_html_copy(tmp_path):
    """Post-fix e5033b5142e0 form: display_data present -> not an offender, even if
    text/html also carries an <svg copy (belt-and-suspenders stays a minor, never RED)."""
    cell = _code([_svg_display(),
                  {"output_type": "display_data",
                   "data": {"text/html": "<div><svg width='10'/></div>"},
                   "metadata": {}}])
    src = _nb(tmp_path, [cell], "s.ipynb")
    built = _nb(tmp_path, [cell], "b.ipynb")
    g = _gate(nbcd.run_gates(src, built), "svg-display")
    assert g["ok"] and g["detail"]["build_hits"] == []


def test_markdown_cell_with_svg_is_never_scanned(tmp_path):
    md = {"cell_type": "markdown", "source": "inline figure <svg width='10'/>", "metadata": {}}
    src = _nb(tmp_path, [md, _code([{"output_type": "stream", "name": "stdout",
                                     "text": "ok"}])], "s.ipynb")
    built = _nb(tmp_path, [md, _code([{"output_type": "stream", "name": "stdout",
                                       "text": "ok 2"}], source="x=2")], "b.ipynb")
    g = _gate(nbcd.run_gates(src, built), "svg-display")
    assert g["ok"]
