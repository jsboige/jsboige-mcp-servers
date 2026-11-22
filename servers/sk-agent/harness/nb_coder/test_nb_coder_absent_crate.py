#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_absent_crate.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Offline tests for crates cargo refused — #27134 (2.3b), conveyor 2026-11-21.

The `:dep` cell of the Rust twin declared `linfa-core = "0.8"`, which does not exist on
crates.io; cargo answered "no matching package named `linfa-core` found". Round 1 removed
the line. Round 2 then saw only `unlinked crate `linfa_core`` in cell 4, and the link
advice (#533) told the model to ADD `:dep linfa_core`. It did, so the `:dep` cell failed
again and the grain ended `built-execution-failed` after 1,674.6 s and 11 calls.

A crate cargo refused is now remembered for the whole run: it is never advised as
missing, its line says it does not exist on every round, and a repair that writes its
`:dep` back gets that line struck mechanically. The error texts below are verbatim from
live/runs/issue-27134-ec0bbb6d/nb_27134_built.ipynb."""

import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
d = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(d)

# Verbatim: cell 1 (the `:dep` cell), its error output.
EV_NO_PKG = ("    Blocking waiting for file lock on package cache\n    Updating crates.io index\n"
             "error: no matching package named `linfa-core` found\n"
             "location searched: crates.io index")
TB_NO_PKG = [':dep linfa-core = "0.8"', "\x1b[91m     ^^^^^^^^^^^^^^^^^^\x1b[0m \x1b[94m\x1b[0m",
             EV_NO_PKG]
# Verbatim: cell 4, its linfa_core error output.
EV_UNLINKED = "cannot find module or crate `linfa_core` in this scope"
TB_UNLINKED = ["use linfa_core::prelude::*;",
               "\x1b[91m    ^^^^^^^^^^\x1b[0m \x1b[94muse of unresolved module or unlinked "
               "crate `linfa_core`\x1b[0m",
               EV_UNLINKED,
               "\x1b[1mhelp\x1b[0m: if you wanted to use a crate named `linfa_core`, use "
               "`cargo add linfa_core` to add it to your `Cargo.toml`"]
DEPS = (':dep ndarray = "0.16"\n:dep rand = "0.9"\n:dep rand_distr = "0.5"\n'
        ':dep linfa = "0.8"\n:dep linfa-core = "0.8"\n:dep linfa-bayes = "0.8"\n'
        ':dep linfa-linear = "0.8"\n'
        ':dep plotters = { version = "0.3", default-features = false, features = '
        '["evcxr", "line_series"] }\n\n'
        'use ndarray::{Array1, Array2};\nuse rand::rngs::StdRng;\nuse rand::SeedableRng;\n\n'
        'println!("ndarray 0.16 prêt ; graine 7");')
DEPS_ROUND1 = DEPS.replace(':dep linfa-core = "0.8"\n', "")
CELL4 = ("use linfa_bayes::GaussianNb;\nuse linfa_core::prelude::*;\n\n"
         "struct MyGaussianNb { classes: Vec<i32> }")


def _code(src: str, evalue: str | None = None, traceback=None) -> dict:
    c = {"cell_type": "code", "metadata": {}, "source": src, "execution_count": None,
         "outputs": []}
    if evalue is not None:
        c["outputs"] = [{"output_type": "error", "ename": "Error", "evalue": evalue,
                         "traceback": traceback or [evalue]}]
    return c


def _no_registry(tmp_path, monkeypatch):
    """Hermetic: no local cargo registry, so nothing resolves from this host's ~/.cargo."""
    monkeypatch.setenv("CARGO_HOME", str(tmp_path / "cargo-empty"))


# ---- absent_packages -------------------------------------------------------------------
def test_absent_packages_reads_cargo_refusals_once_each():
    nb_out = d._outputs_text(_code(DEPS, EV_NO_PKG, TB_NO_PKG))
    assert d.absent_packages(nb_out) == ["linfa-core"]
    assert d.absent_packages("\x1b[31merror: no matching package named `foo_bar` found\x1b[0m"
                             "\nerror: no matching package named `foo_bar` found") == ["foo_bar"]
    assert d.absent_packages(EV_UNLINKED) == [] and d.absent_packages("") == []


# ---- the link advice -------------------------------------------------------------------
def _round2_cells() -> list[dict]:
    """Round 2 as recorded: the `:dep` line gone, so cell 1 ran; cell 4 still imports it."""
    return [{"cell_type": "markdown", "metadata": {}, "source": "# 2.3b"},
            _code(DEPS_ROUND1), _code(CELL4, EV_UNLINKED, TB_UNLINKED)]


def test_round2_advice_names_the_absent_crate_and_never_says_add_it(tmp_path, monkeypatch):
    _no_registry(tmp_path, monkeypatch)
    cells = _round2_cells()
    errors = [d._outputs_text(cells[2])]
    old, _ = d.crate_api_block(cells, errors)               # without the memory: the bug
    assert "ajoute `:dep linfa_core" in old
    block, info = d.crate_api_block(cells, errors, absent=["linfa-core"])
    assert "ajoute `:dep linfa_core" not in block
    assert "`linfa-core` N'EXISTE PAS sur crates.io" in block
    assert "la crate déclarée la plus proche est `linfa` (cellule 1)" in block
    assert info["absent"] == ["linfa-core"] and "linfa_core" in info["link"]


def test_an_absent_crate_is_advised_even_with_no_api_error_to_ground(tmp_path, monkeypatch):
    """Round 0: the `:dep` cell's own error is cargo's refusal, not a rustc diagnostic."""
    _no_registry(tmp_path, monkeypatch)
    cells = [_code(DEPS, EV_NO_PKG, TB_NO_PKG)]
    assert d.crate_api_block(cells, [d._outputs_text(cells[0])]) == ("", {})
    block, info = d.crate_api_block(cells, [d._outputs_text(cells[0])], absent=["linfa-core"])
    assert "`linfa-core` N'EXISTE PAS" in block and info["absent"] == ["linfa-core"]


def test_no_hint_when_no_declared_crate_is_a_prefix(tmp_path, monkeypatch):
    _no_registry(tmp_path, monkeypatch)
    cells = [_code(':dep ndarray = "0.16"'),
             _code("use polars_core::frame::DataFrame;",
                   "cannot find module or crate `polars_core` in this scope",
                   ["use of unresolved module or unlinked crate `polars_core`"])]
    block, _ = d.crate_api_block(cells, [d._outputs_text(cells[1])], absent=["polars-core"])
    assert "N'EXISTE PAS" in block and "la plus proche" not in block


# ---- strike_absent_deps ----------------------------------------------------------------
def _write(tmp_path, cells) -> Path:
    nb = tmp_path / "nb.ipynb"
    nb.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                              "nbformat_minor": 5}), encoding="utf-8")
    return nb


def test_strike_removes_only_absent_dep_lines_in_the_given_cells(tmp_path):
    nb = _write(tmp_path, [_code(DEPS), _code(DEPS), _code("// :dep linfa-core is gone")])
    struck = d.strike_absent_deps(nb, ["linfa-core"], [0, 2])
    assert struck == [{"idx": 0, "line": ':dep linfa-core = "0.8"'}]
    cells = json.loads(nb.read_text(encoding="utf-8"))["cells"]
    src0 = d._text(cells[0]["source"])
    assert ":dep linfa-core" not in src0 and ':dep linfa = "0.8"' in src0
    assert ':dep linfa-bayes = "0.8"' in src0 and "use rand::SeedableRng;" in src0
    assert ":dep linfa-core" in d._text(cells[1]["source"])     # not rewritten this round
    assert d._text(cells[2]["source"]) == "// :dep linfa-core is gone"


def test_strike_matches_dash_and_underscore_spellings(tmp_path):
    nb = _write(tmp_path, [_code(':dep linfa_core = "0.8"\n:dep linfa = "0.8"')])
    assert d.strike_absent_deps(nb, ["linfa-core"], [0]) == [
        {"idx": 0, "line": ':dep linfa_core = "0.8"'}]
    assert d.strike_absent_deps(nb, [], [0]) == []


# ---- a repair round --------------------------------------------------------------------
def _run_round(tmp_path, monkeypatch, cells, answer, rec_extra=None):
    nb = _write(tmp_path, cells)
    prompts = []

    async def fake_retry(sk, args, rec, stage, prompt, conv, max_tokens=None):
        prompts.append(prompt)
        return {"conversation_id": "c1"}

    async def fake_parse(sk, args, rec, stage, env, conv, max_tokens=None):
        return {"cells": answer}, env

    async def fake_pm(pm, name, payload):
        return {}

    async def fake_start(pm, kname, exec_dir):
        return "k2"

    async def fake_exec(pm, path, kid, targets):
        return [{"cell": i, "ok": True} for i in targets]

    monkeypatch.setattr(d, "sk_call_retry", fake_retry)
    monkeypatch.setattr(d, "parse_or_repair", fake_parse)
    monkeypatch.setattr(d, "pm_call", fake_pm)
    monkeypatch.setattr(d, "start_kernel", fake_start)
    monkeypatch.setattr(d, "execute_cells", fake_exec)
    targets = [i for i, c in enumerate(cells) if c["cell_type"] == "code"]
    rec = {"execution": [{"cell": i, "ok": not cells[i]["outputs"]} for i in targets],
           **(rec_extra or {})}
    asyncio.run(d.repair_kernel_errors(None, None, SimpleNamespace(repair_rounds=1), rec, nb,
                                       "rust", tmp_path, "k1", targets, None, ""))
    return prompts, rec, json.loads(nb.read_text(encoding="utf-8"))["cells"]


def test_round0_remembers_the_refusal_and_strikes_a_dep_written_back(tmp_path, monkeypatch):
    """The dep cell is asked alone (cell 2 waits on it); its answer keeps `linfa-core`."""
    _no_registry(tmp_path, monkeypatch)
    cells = [{"cell_type": "markdown", "metadata": {}, "source": "# 2.3b"},
             _code(DEPS, EV_NO_PKG, TB_NO_PKG), _code(CELL4, EV_UNLINKED, TB_UNLINKED)]
    answer = [{"idx": 1, "cell_type": "code",
               "source": DEPS.replace('rand = "0.9"', 'rand = "0.8"')}]
    prompts, rec, out = _run_round(tmp_path, monkeypatch, cells, answer)
    assert rec["absent_crates"] == ["linfa-core"]
    assert "`linfa-core` N'EXISTE PAS sur crates.io" in prompts[0]
    r = rec["repairs"][0]
    assert r["replaced"] == [1] and r["deferred"] == [2]
    assert r["struck_deps"] == [{"idx": 1, "line": ':dep linfa-core = "0.8"'}]
    src = d._text(out[1]["source"])
    assert ":dep linfa-core" not in src and ':dep rand = "0.8"' in src
    assert d._text(out[2]["source"]) == CELL4              # held, untouched


def test_round2_never_advises_adding_it_back(tmp_path, monkeypatch):
    """The recorded round 2: the run remembers the refusal from round 0."""
    _no_registry(tmp_path, monkeypatch)
    answer = [{"idx": 2, "cell_type": "code",
               "source": CELL4.replace("use linfa_core::prelude::*;\n",
                                       "use linfa::prelude::*;\n")}]
    prompts, rec, out = _run_round(tmp_path, monkeypatch, _round2_cells(), answer,
                                   {"absent_crates": ["linfa-core"]})
    p = prompts[0]
    assert "ajoute `:dep linfa_core" not in p
    assert "`linfa-core` N'EXISTE PAS" in p and "plus proche est `linfa`" in p
    r = rec["repairs"][0]
    assert r["replaced"] == [2] and "struck_deps" not in r
    assert r["crate_api"]["absent"] == ["linfa-core"]


def test_a_python_round_ignores_cargo_text(tmp_path, monkeypatch):
    """Only Rust rounds read cargo: a Python cell quoting the message changes nothing."""
    cells = [_code("print('no matching package named `x` found')", "boom", ["boom"])]
    nb = _write(tmp_path, cells)

    async def fake_retry(sk, args, rec, stage, prompt, conv, max_tokens=None):
        return {"conversation_id": "c1"}

    async def fake_parse(sk, args, rec, stage, env, conv, max_tokens=None):
        return {"cells": []}, env

    monkeypatch.setattr(d, "sk_call_retry", fake_retry)
    monkeypatch.setattr(d, "parse_or_repair", fake_parse)
    rec = {"execution": [{"cell": 0, "ok": False}]}
    asyncio.run(d.repair_kernel_errors(None, None, SimpleNamespace(repair_rounds=1), rec, nb,
                                       "python3", tmp_path, "k1", [0], None, ""))
    assert "absent_crates" not in rec
