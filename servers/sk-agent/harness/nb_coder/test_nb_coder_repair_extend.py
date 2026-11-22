# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_repair_extend.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for the adaptive repair budget (21/11 conveyor).

The 7 built-execution-failed traces of 20-21/11 all spent their rounds, and 3 of them
were still shrinking on the last one: 2.3d 8 -> 7, Frontieres-01 8 -> 3, Compression-07
4 -> 3. The loop now grants one more round at a time (up to --repair-extend) while the
round just run strictly reduced the failing cells; a round that fixes nothing still ends
it, so the 4 stalled traces (2.3c 9 -> 9, 2.3b 4 -> 4, ...) cost no extra round.

Skipped when `mcp` is not importable (the driver imports the MCP client at load).
"""
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as d  # noqa: E402


@pytest.mark.parametrize("done, budget, cap, before, after, expected", [
    (1, 1, 3, 4, 2, True),     # budget spent, still converging
    (1, 1, 3, 4, 4, False),    # stalled: a round that fixed nothing ends the loop
    (1, 1, 3, 4, 5, False),    # worse
    (1, 1, 3, 4, 0, False),    # cleared: nothing left to repair
    (3, 3, 3, 4, 2, False),    # cap reached
    (1, 2, 4, 4, 2, False),    # budget not spent yet: no extension needed
])
def test_repair_round_extends(done, budget, cap, before, after, expected):
    assert d.repair_round_extends(done, budget, cap, before, after) is expected


def _err_cell(k):
    return {"cell_type": "code", "source": f"int F{k}(int seed = Rng.Next()) => seed;",
            "execution_count": None,
            "outputs": [{"output_type": "stream", "name": "stderr",
                         "text": [f"(1,{k}): error CS1736: valeur par défaut non constante\r\n"]},
                        {"output_type": "error", "ename": "Error",
                         "evalue": "compilation error", "traceback": []}]}


def _run(tmp_path, monkeypatch, failing_after, rounds=1, extend=None, n=4):
    """Drive repair_kernel_errors over `n` independent failing cells; the k-th
    re-execution leaves failing_after[k] of them failing."""
    nb = tmp_path / "nb.ipynb"
    nb.write_text(json.dumps({"cells": [_err_cell(k) for k in range(n)], "metadata": {},
                              "nbformat": 4, "nbformat_minor": 5}), encoding="utf-8")
    calls = []

    async def fake_retry(sk, args, rec, stage, prompt, conv, max_tokens=None):
        calls.append(stage)
        return {"conversation_id": "c1"}

    async def fake_parse(sk, args, rec, stage, env, conv, max_tokens=None):
        idx = [e["cell"] for e in rec["execution"] if not e["ok"]]
        return {"cells": [{"idx": i, "cell_type": "code", "source": f"int F{i}() => {i};"}
                          for i in idx]}, env

    async def fake_pm(pm, name, payload):
        return {}

    async def fake_start(pm, kname, exec_dir):
        return "k2"

    runs = iter(failing_after)

    async def fake_exec(pm, path, kid, targets):
        bad = next(runs)
        return [{"cell": i, "ok": i >= bad} for i in targets]

    monkeypatch.setattr(d, "sk_call_retry", fake_retry)
    monkeypatch.setattr(d, "parse_or_repair", fake_parse)
    monkeypatch.setattr(d, "pm_call", fake_pm)
    monkeypatch.setattr(d, "start_kernel", fake_start)
    monkeypatch.setattr(d, "execute_cells", fake_exec)
    args = SimpleNamespace(repair_rounds=rounds)
    if extend is not None:
        args.repair_extend = extend
    rec = {"execution": [{"cell": i, "ok": False} for i in range(n)]}
    asyncio.run(d.repair_kernel_errors(None, None, args, rec, nb, "csharp", tmp_path, "k1",
                                       list(range(n)), None, ""))
    return rec, calls


def test_a_converging_repair_gets_extra_rounds_up_to_the_cap(tmp_path, monkeypatch):
    rec, calls = _run(tmp_path, monkeypatch, [2, 1, 1], rounds=1, extend=2)
    assert len(calls) == 3 and len(rec["repairs"]) == 3
    assert [x["failing_after"] for x in rec["repair_extensions"]] == [2, 1]
    assert rec["repair_extensions"][-1]["budget"] == 3


def test_a_stalled_round_ends_the_loop_without_extension(tmp_path, monkeypatch):
    rec, calls = _run(tmp_path, monkeypatch, [4], rounds=1, extend=2)
    assert len(calls) == 1
    assert "repair_extensions" not in rec


def test_extension_stops_at_the_first_stalled_round(tmp_path, monkeypatch):
    rec, calls = _run(tmp_path, monkeypatch, [3, 3], rounds=1, extend=2)
    assert len(calls) == 2 and len(rec["repair_extensions"]) == 1


def test_a_cleared_notebook_ends_the_loop(tmp_path, monkeypatch):
    rec, calls = _run(tmp_path, monkeypatch, [2, 0], rounds=1, extend=2)
    assert len(calls) == 2
    assert all(e["ok"] for e in rec["execution"])


def test_repair_extend_zero_keeps_the_fixed_budget(tmp_path, monkeypatch):
    rec, calls = _run(tmp_path, monkeypatch, [2], rounds=1, extend=0)
    assert len(calls) == 1 and "repair_extensions" not in rec


def test_repair_rounds_zero_never_repairs(tmp_path, monkeypatch):
    rec, calls = _run(tmp_path, monkeypatch, [], rounds=0, extend=2)
    assert calls == [] and "repairs" not in rec


def test_the_cli_default_extends_by_two():
    a = d.build_parser().parse_args(["--issue", "1", "--notebook", "x.ipynb"])
    assert a.repair_extend == d.REPAIR_EXTEND_DEFAULT == 2
