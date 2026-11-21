#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7416ac16c91e150aae5a75dd251d0c1a4c2f5c2c
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_dep_timeout.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for the per-cell execution budget (21/11, CoursIA#27134 4.1 Rust twin).

Measured: the notebook's `:dep` cell (ndarray, rand, rand_distr, plotters, burn, image)
hit the flat 300 s limit at 04:51Z while cargo was still compiling the crates cold. The
10 cells after it failed on names it never got to define, and two repair rounds (~240K
prompt tokens) could not fix a cell that was never wrong. A cell that declares
dependencies now gets DEP_CELL_TIMEOUT_S; every other cell keeps CELL_TIMEOUT_S, and the
client waits past the server's own budget."""

import asyncio
import importlib.util
import json
from datetime import timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)

# Verbatim head of cell 5, live/runs/issue-27134-a76e3760/nb_27134_built.ipynb.
CELL5_4_1 = (
    ':dep ndarray = "0.17"\n'
    ':dep rand = "0.10"\n'
    ':dep rand_distr = "0.6"\n'
    ':dep plotters = { version = "0.3", default-features = false, features = ["evcxr", "line_series"] }\n'
    ':dep burn = { version = "0.22", default-features = false, features = ["std", "ndarray"] }\n'
    ':dep image = { version = "0.25", default-features = false, features = ["jpeg"] }\n'
    "\n"
    "use ndarray::Array2;\n")


def _nb(tmp_path, sources: list[tuple[str, str]]) -> Path:
    cells = [{"cell_type": t, "source": s, "metadata": {}, "outputs": [], "execution_count": None}
             if t == "code" else {"cell_type": t, "source": s, "metadata": {}}
             for t, s in sources]
    p = tmp_path / "nb.ipynb"
    p.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                             "nbformat_minor": 5}), encoding="utf-8")
    return p


def _timeouts(monkeypatch, nb_path: Path, indexes: list[int]) -> dict[int, int]:
    seen = {}

    async def fake_pm_call(session, tool, payload):
        seen[payload["cell_index"]] = payload["timeout"]
        return {"status": "ok", "outputs": []}

    monkeypatch.setattr(D, "pm_call", fake_pm_call)
    asyncio.run(D.execute_cells(object(), nb_path, "k1", indexes))
    return seen


def test_the_4_1_dep_cell_gets_the_long_budget_and_the_others_the_short(tmp_path, monkeypatch):
    nb = _nb(tmp_path, [("markdown", "# 4.1"), ("code", CELL5_4_1),
                        ("code", "let x = 1;\nx"), ("code", "// :dep in a comment is not one\n1")])
    assert _timeouts(monkeypatch, nb, [1, 2, 3]) == {
        1: D.DEP_CELL_TIMEOUT_S, 2: D.CELL_TIMEOUT_S, 3: D.CELL_TIMEOUT_S}
    assert D.CELL_TIMEOUT_S == 300 and D.DEP_CELL_TIMEOUT_S > 300


def test_a_nuget_reference_is_a_dependency_cell(tmp_path):
    nb = _nb(tmp_path, [("code", '#r "nuget: Microsoft.Z3, 4.12.2"\nusing Microsoft.Z3;'),
                        ("code", '#r "System.Runtime"\n1'),
                        ("code", "#!csharp\nvar x = 1;")])
    assert D.dependency_cells(nb) == {0}


def test_list_sources_and_indented_declarations_count(tmp_path):
    nb = _nb(tmp_path, [("code", ["use std::fmt;\n", "  :dep serde = \"1\"\n"]),
                        ("markdown", ':dep rand = "0.10"')])
    assert D.dependency_cells(nb) == {0}


def test_an_unreadable_notebook_declares_no_dependency_cell(tmp_path, monkeypatch):
    bad = tmp_path / "bad.ipynb"
    bad.write_text("{not json", encoding="utf-8")
    assert D.dependency_cells(bad) == set()
    assert D.dependency_cells(tmp_path / "missing.ipynb") == set()
    # existing callers pass a scratch path that is not on disk: the short budget applies
    assert _timeouts(monkeypatch, tmp_path / "missing.ipynb", [4]) == {4: D.CELL_TIMEOUT_S}


def test_the_client_waits_past_the_servers_budget():
    assert D.pm_read_timeout_s({"timeout": D.DEP_CELL_TIMEOUT_S}) == D.DEP_CELL_TIMEOUT_S + 60
    assert D.pm_read_timeout_s({"timeout": D.CELL_TIMEOUT_S}) == D.CELL_TIMEOUT_S + 60
    # tools without a timeout keep the old flat client cap
    assert D.pm_read_timeout_s({"action": "start"}) == D.PM_READ_TIMEOUT_S
    assert D.pm_read_timeout_s({"timeout": "junk"}) == D.PM_READ_TIMEOUT_S


def test_pm_call_passes_the_derived_read_timeout():
    seen = {}

    class Session:
        async def call_tool(self, tool, payload, read_timeout_seconds=None):
            seen["read"] = read_timeout_seconds

            class R:
                content = []
            return R()

    asyncio.run(D.pm_call(Session(), "execute_on_kernel", {"timeout": D.DEP_CELL_TIMEOUT_S}))
    assert seen["read"] == timedelta(seconds=D.DEP_CELL_TIMEOUT_S + 60)
