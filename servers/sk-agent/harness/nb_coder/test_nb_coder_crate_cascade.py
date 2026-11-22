#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_crate_cascade.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Offline tests for root-first repair on Rust crate cascades — #27134 (2.3c), 2026-11-21.

Cell 2 of the Rust twin carried all six `:dep` lines and failed on two missing trait
imports (`sample` on `rand_distr::Normal`, `shuffle` on a slice). evcxr links none of a
cell's crates while it fails, so the twelve cells below failed on `unlinked crate
ndarray/rand/rand_distr` alone. The repair round asked all thirteen at once: a
151,446-token prompt, a 59,993-character answer that did not parse, and the loop broke.
A cell failing only because an EARLIER failing cell's `:dep` never linked now waits for
that cell, exactly as a cell failing on a name that cell declares (#27302)."""

import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
d = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(d)

# Verbatim fragments from live/runs/issue-27134-5790c26b/nb_27134_built.ipynb.
ERR_DEP_CELL = ("\x1b[31m[E0599] Error:\x1b[0m no method named `sample` found for struct "
                "`rand_distr::Normal<F>` in the current scope    \x1b[38;5;246m╭\x1b[0m "
                "command_2:1:1\n")
ERR_CASCADE = ("use of unresolved module or unlinked crate `ndarray`unresolved import "
               "`ndarray`\x1b[1mhelp\x1b[0m: if you wanted to use a crate named `ndarray`, "
               "use `cargo add ndarray` to add it to your `Cargo.toml`\nunresolved import "
               "`ndarray`\nuse of unresolved module or unlinked crate `ndarray`unresolved "
               "import `ndarray`\nuse of unresolved module or unlinked crate `rand`cannot "
               "find module or crate `rand` in this scope\x1b[1mhelp\x1b[0m: if you wanted to "
               "use a crate named `rand`, use `cargo add rand` to add it to your "
               "`Cargo.toml`\n")
ERR_DISTR = ("use of unresolved module or unlinked crate `rand_distr`unresolved import "
             "`rand_distr`\x1b[1mhelp\x1b[0m: if you wanted to use a crate named "
             "`rand_distr`, use `cargo add rand_distr` to add it to your `Cargo.toml`\n")
ERR_OWN = "\x1b[31m[E0308] Error:\x1b[0m mismatched types\n"
# The other E0433 wording, verbatim from the same run directory at 21/11 08:3xZ (cells 5,
# 21, 27, 30, 35 of the next 2.3c attempt said only this): same failure, not read before.
ERR_E0433 = ("\x1b[31m[E0433] Error:\x1b[0m cannot find module or crate `plotters` in this "
             "scope\n\x1b[31m[E0433] Error:\x1b[0m cannot find module or crate `rand` in this "
             "scope\n\x1b[31m[E0432] Error:\x1b[0m unresolved import `rand_distr`\n")

DEPS = (':dep ndarray = "0.16"\n:dep rand = "0.8"\n:dep rand_distr = "0.4"\n'
        'use rand_distr::Normal;\nlet n = Normal::new(0.0, 1.0).unwrap();\n'
        'let x: f64 = n.sample(&mut rand::thread_rng());')

REPLAY = (Path("D:/vllm/.tmp/nbcoder/conveyor-20261120/live/runs/issue-27134-5790c26b")
          / "nb_27134_built.ipynb")
REPLAY_FAILING = 13      # the recorded case: the `:dep` cell 2 + its twelve crate cascades


def _code(src: str, err: str | None = None) -> dict:
    c = {"cell_type": "code", "metadata": {}, "source": src, "execution_count": None,
         "outputs": []}
    if err is not None:
        c["outputs"] = [{"output_type": "stream", "name": "stderr", "text": err},
                        {"output_type": "error", "ename": "Error",
                         "evalue": "compilation error", "traceback": []}]
    return c


def _notebook() -> list[dict]:
    """The 2.3c shape, shrunk: the `:dep` cell fails (2), two cells fail on its crates
    alone (3, 5), one fails on its own (4), one passes (6)."""
    return [
        {"cell_type": "markdown", "metadata": {}, "source": "# Régression"},
        _code("let a = 1;"),
        _code(DEPS, ERR_DEP_CELL),
        _code("use ndarray::Array2;\nuse rand::Rng;\nlet m = Array2::<f64>::zeros((2, 2));",
              ERR_CASCADE),
        _code("let k: u8 = 300u16;", ERR_OWN),
        _code("use rand_distr::Uniform;\nlet u = Uniform::new(0.0, 1.0);", ERR_DISTR),
        _code("let b = 2;"),
    ]


def _detail(cells: list[dict]) -> list[dict]:
    return [{"idx": i, "_raw_errors": d._outputs_text(c)} for i, c in enumerate(cells)
            if c.get("cell_type") == "code" and c["outputs"]]


# ---- unlinked_crates -------------------------------------------------------------------
def test_unlinked_crates_reads_evcxr_messages_in_order_once_each():
    assert d.unlinked_crates(ERR_CASCADE) == ["ndarray", "rand"]
    assert d.unlinked_crates(ERR_DISTR) == ["rand_distr"]
    assert d.unlinked_crates(ERR_DEP_CELL) == [] and d.unlinked_crates("") == []


def test_unlinked_crates_reads_the_cannot_find_module_or_crate_wording():
    assert d.unlinked_crates(ERR_E0433) == ["plotters", "rand"]


def test_the_cannot_find_wording_is_a_cascade_too():
    """2.3c, 21/11 08:3xZ: five of the twelve cascaded cells said only this form, so
    they were asked in the same round as the `:dep` cell they depend on."""
    cells = _notebook()
    cells[2] = _code(DEPS + '\n:dep plotters = "0.3"', ERR_DEP_CELL)
    cells[4] = _code("use plotters::prelude::*;\nlet r: f64 = rand::random();", ERR_E0433)
    assert d.cascade_roots(cells, _detail(cells)) == {3: [2], 4: [2], 5: [2]}


def test_the_cannot_find_wording_is_digested_as_a_crate_link_miss():
    kinds = {(e["kind"], e["item"]) for e in d.rust_api_errors(ERR_E0433)}
    assert ("crate", "plotters") in kinds and ("crate", "rand") in kinds


# ---- cascade_roots ---------------------------------------------------------------------
def test_a_cell_failing_on_crates_of_a_failing_dep_cell_waits_for_it():
    cells = _notebook()
    assert d.cascade_roots(cells, _detail(cells)) == {3: [2], 5: [2]}


def test_a_dep_cell_that_ran_is_not_a_root():
    """The crates were linked: an `unlinked crate` below is that cell's own problem."""
    cells = _notebook()
    cells[2] = _code(DEPS)
    assert d.cascade_roots(cells, _detail(cells)) == {}


def test_a_crate_no_cell_declares_is_asked_not_held():
    """Nothing above can link it (#533 advises the `:dep` to add): the cell is asked."""
    cells = _notebook()
    cells[3] = _code("use polars::prelude::*;",
                     "use of unresolved module or unlinked crate `polars`\n")
    assert 3 not in d.cascade_roots(cells, _detail(cells))


def test_a_dep_cell_below_is_never_a_root():
    cells = _notebook()
    cells[2], cells[3] = cells[3], cells[2]
    assert 2 not in d.cascade_roots(cells, _detail(cells))


def test_crate_names_match_across_dash_and_underscore():
    cells = _notebook()
    cells[2] = _code(DEPS.replace(":dep rand_distr", ":dep rand-distr"), ERR_DEP_CELL)
    assert d.cascade_roots(cells, _detail(cells))[5] == [2]


def _replay_cells() -> list[dict]:
    """The artefact is LIVE: a later 2.3c attempt rewrites the same run directory (21/11
    05:2xZ it held 0 cells mid-run, and the suite failed on main). Replay only while it
    still shows the recorded case -- the `:dep` cell 2 failing -- and skip otherwise."""
    try:
        cells = json.loads(REPLAY.read_text(encoding="utf-8"))["cells"]
    except (OSError, ValueError, KeyError, TypeError):
        pytest.skip("live run artefact unreadable (rewritten by a later attempt?)")
    dep = cells[2] if len(cells) > 2 and isinstance(cells[2], dict) else {}
    failing = any(o.get("output_type") == "error" for o in dep.get("outputs", []))
    n_failing = sum(1 for c in cells if isinstance(c, dict) and c.get("cell_type") == "code"
                    and any(o.get("output_type") == "error" for o in c.get("outputs", [])))
    if not (dep.get("cell_type") == "code" and ":dep" in d._text(dep.get("source"))
            and failing and n_failing == REPLAY_FAILING):
        pytest.skip("live run artefact no longer shows the replayed case "
                    "(a later attempt rewrote it)")
    return cells


def _write_nb(path: Path, cells: list[dict]) -> Path:
    path.write_text(json.dumps({"cells": cells}), encoding="utf-8")
    return path


def test_the_replay_guard_skips_a_rewritten_artefact(tmp_path, monkeypatch):
    for cells in ([], [_code("x"), _code("y"), _code(DEPS)],          # empty / dep cell ran
                  [_code("x"), _code("y"), _code("let z = 1;", ERR_DEP_CELL)]):  # no :dep
        monkeypatch.setattr(sys.modules[__name__], "REPLAY",
                            _write_nb(tmp_path / "nb.ipynb", cells))
        with pytest.raises(pytest.skip.Exception):
            _replay_cells()
    monkeypatch.setattr(sys.modules[__name__], "REPLAY", tmp_path / "missing.ipynb")
    with pytest.raises(pytest.skip.Exception):
        _replay_cells()


def test_the_replay_guard_keeps_the_recorded_case(tmp_path, monkeypatch):
    cells = [_code("x"), _code("y"), _code(DEPS, ERR_DEP_CELL), _code("z", ERR_E0433)]
    monkeypatch.setattr(sys.modules[__name__], "REPLAY", _write_nb(tmp_path / "nb.ipynb", cells))
    monkeypatch.setattr(sys.modules[__name__], "REPLAY_FAILING", 2)
    assert _replay_cells() == json.loads(json.dumps(cells))


def test_the_replay_guard_skips_another_failure_count(tmp_path, monkeypatch):
    """A later attempt can fail cell 2 again with a different set below it: the twelve
    asserted cascades would then be a statement about another run."""
    cells = [_code("x"), _code("y"), _code(DEPS, ERR_DEP_CELL), _code("z", ERR_E0433)]
    monkeypatch.setattr(sys.modules[__name__], "REPLAY", _write_nb(tmp_path / "nb.ipynb", cells))
    with pytest.raises(pytest.skip.Exception):
        _replay_cells()


@pytest.mark.skipif(not REPLAY.exists(), reason="live run artefact not on this machine")
def test_replay_2_3c_asks_the_dep_cell_alone():
    cells = _replay_cells()
    detail = [{"idx": i, "_raw_errors": d._outputs_text(c)} for i, c in enumerate(cells)
              if c.get("cell_type") == "code"
              and any(o.get("output_type") == "error" for o in c.get("outputs", []))]
    roots = d.cascade_roots(cells, detail)
    assert [x["idx"] for x in detail if x["idx"] not in roots] == [2]
    assert len(roots) == 12 and all(r == [2] for r in roots.values())


# ---- a repair round --------------------------------------------------------------------
def _run_round(tmp_path, monkeypatch, cells, answer):
    nb = tmp_path / "nb.ipynb"
    nb.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                              "nbformat_minor": 5}), encoding="utf-8")
    prompts, executed, api_errors = [], [], []

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
        executed.append(list(targets))
        return [{"cell": i, "ok": True} for i in targets]

    def fake_api(cells_now, errors, roots=None, absent=()):
        api_errors.append(list(errors))
        return "", {}

    monkeypatch.setattr(d, "sk_call_retry", fake_retry)
    monkeypatch.setattr(d, "parse_or_repair", fake_parse)
    monkeypatch.setattr(d, "pm_call", fake_pm)
    monkeypatch.setattr(d, "start_kernel", fake_start)
    monkeypatch.setattr(d, "execute_cells", fake_exec)
    monkeypatch.setattr(d, "crate_api_block", fake_api)
    targets = [i for i, c in enumerate(cells) if c["cell_type"] == "code"]
    rec = {"execution": [{"cell": i, "ok": not cells[i]["outputs"]} for i in targets]}
    asyncio.run(d.repair_kernel_errors(None, None, SimpleNamespace(repair_rounds=1), rec, nb,
                                       "rust", tmp_path, "k1", targets, None, ""))
    return prompts, rec["repairs"][0], executed, api_errors


def test_a_round_asks_the_dep_cell_and_holds_its_crate_cascades(tmp_path, monkeypatch):
    answer = [{"idx": 2, "cell_type": "code",
               "source": DEPS.replace("use rand_distr::Normal;",
                                      "use rand_distr::{Distribution, Normal};")},
              {"idx": 4, "cell_type": "code", "source": "let k: u16 = 300u16;"}]
    prompts, r, executed, api_errors = _run_round(tmp_path, monkeypatch, _notebook(), answer)
    p = prompts[0]
    assert "### Cellule 2 (code)" in p and "### Cellule 4 (code)" in p
    assert "### Cellule 3 (code)" not in p and "### Cellule 5 (code)" not in p
    assert "CELLULES EN ATTENTE (3, 5)" in p
    assert ("- cellule 2 : porte les `:dep` de ndarray, rand, rand_distr ; tant qu'elle "
            "échoue, evcxr ne lie aucune de ces crates (cellules 3, 5)") in p
    assert "doit continuer à définir" not in p           # no name cascade here
    assert r["asked"] == 2 and r["deferred"] == [3, 5] and r["replaced"] == [2, 4]
    assert executed == [[1, 2, 3, 4, 5, 6]]              # the held cells re-run
    assert not any("unlinked crate" in e for errs in api_errors for e in errs)
