#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# NEW in this tree (26/11): no jsboige/vllm original. The failure class it pins (a grain
# spent its first launch on a transport cut) was measured on CoursIA batch o42,
# po-2028:claudish, 26/11 01:27Z, after the 22/11 cutover. This tree is the source of
# truth; the vllm copy of the sibling tests stays frozen at
# 7a09e1caec22441d9402ab25a222206c8905bfe1 — never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Offline tests for deferring a grain killed by a CUT transport — CoursIA#28664, 2026-11-26.

At 01:27Z the Docker engine of po-2028 restarted mid-batch (not by the lane); the proxy
container came back at 01:28:11Z. The build call "2-build+0" of #28664 (ANALYSE-09-
Tuilage-Aperiodique) died after 63.8 s with 0 char on `APIConnectionError('Connection
error.')`, chained httpcore2.ReadError -> httpx2.ReadError. The scheduler classed the run a
FAILURE: the grain's first launch was spent on a refusal that said nothing about the grain.
The driver now names it a deferral, read where the provider 429 is read; the scheduler
gives it the ordinary backoff and never releases the claim for it.

The same contract, for the other two deferrable refusals: test_nb_coder_rate_limit.py."""
import ast
import asyncio
import contextlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).resolve().parent


def _load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


d = _load("nb_coder_driver")
S = _load("nb_coder_scheduler")

# Verbatim: the `error` of call "2-build+0" in the 26/11 run record of CoursIA#28664
# (po-2028:claudish, batch o42, run issue-28664-33fb2ed0). 184 characters, read back from
# the record; the length is pinned so a retyped constant cannot pass for the measured one.
CUT = ('("<class \'semantic_kernel.connectors.ai.open_ai.services.open_ai_chat_completion.'
       'OpenAIChatCompletion\'> service failed to complete the prompt", '
       'APIConnectionError(\'Connection error.\'))')
# The same envelope family on a TIME BUDGET — the MGS-28 sample of test_nb_coder_create.py.
# It keeps its own cure (the bisect): a smaller tranche is the remedy for a budget, never
# for a cut.
TIMEOUT = ('("<class \'semantic_kernel.connectors.ai.open_ai.services.open_ai_chat_completion.'
           'OpenAIChatCompletion\'> service failed to complete the prompt", '
           'APITimeoutError(\'Request timed out.\'))')
GATE = ("capacity gate refused dispatch to model 'x' (verdict yellow); retry after 3600s")
RATE_LIMIT = ("Error code: 429 - {'error': {'code': '1302', "
              "'message': 'Rate limit reached for requests'}}")
GITHUB = 'issue fetch failed rc=1: {"message": "API rate limit exceeded for user ID 3159389.'


# ---- the predicate --------------------------------------------------------------------
def test_the_measured_envelope_is_pinned_character_for_character():
    assert len(CUT) == 184 and CUT.endswith("APIConnectionError('Connection error.'))")


def test_the_real_cut_is_a_bare_deferral_naming_the_transport():
    v = d.endpoint_unreachable({"error": CUT})
    assert v.startswith("deferred-by-endpoint-unreachable: ")
    # the excerpt is centred on the cause: the client's exception class survives the bound
    assert "APIConnectionError('Connection error.')" in v
    assert len(v) <= len("deferred-by-endpoint-unreachable: ") + 162


def test_the_excerpt_keeps_the_marker_when_it_sits_deep_in_a_long_error():
    err = "x" * 400 + " httpx2.ReadError " + "y" * 100
    v = d.endpoint_unreachable({"error": err})
    assert v.startswith("deferred-by-endpoint-unreachable: ") and "httpx2.ReadError" in v


def test_a_generic_class_name_only_counts_under_the_transport_module():
    """Review ai-01 (26/11): `readerror`/`writeerror` were bare substrings, and those class
    names exist outside the transport (`tarfile.ReadError`). The measured chain names the
    module, so the qualified form is the whole of what was measured — and the bare one buys
    a deferral that would loop a grain on a defect retrying cannot cure."""
    assert d.endpoint_unreachable(
        {"error": "tarfile.ReadError: not a gzip file"}) == ""
    assert d.endpoint_unreachable({"error": "ReadError: bad header"}) == ""
    assert d.endpoint_unreachable({"error": "sqlite3.WriteError: disk I/O error"}) == ""
    # the qualified forms the client really emits still defer
    for err in ("httpcore2.ConnectError: [Errno 111] Connection refused",
                "httpx.WriteError('broken pipe')",
                "httpcore2.RemoteProtocolError: peer closed the connection"):
        assert d.endpoint_unreachable({"error": err}).startswith(
            "deferred-by-endpoint-unreachable: "), err


def test_nothing_else_is_deferred_by_it():
    assert d.endpoint_unreachable({"error": GATE}) == ""              # the gate's, not ours
    assert d.endpoint_unreachable({"error": RATE_LIMIT}) == ""        # the 429's, not ours
    assert d.endpoint_unreachable({"error": TIMEOUT}) == ""           # a budget: the bisect
    # a cut whose text also names a time budget is read as the budget — never deferred
    assert d.endpoint_unreachable(
        {"error": CUT[:-2] + " — ReadTimeout: read timed out)"}) == ""
    # the bare words are NOT a marker: a dead kernel or MCP server says them, and that
    # one is the harness's to repair, not a condition to wait out
    assert d.endpoint_unreachable({"error": "Connection error."}) == ""
    assert d.endpoint_unreachable({"error": "401 invalid proxy authentication"}) == ""
    assert d.endpoint_unreachable(
        {"error": "claudish: unknown model nb-luna — not found in any provider catalog"}) == ""
    assert d.endpoint_unreachable({"error": GITHUB}) == ""             # the OTHER rate limit
    assert d.endpoint_unreachable({}) == ""
    assert d.endpoint_unreachable({"error": "   "}) == ""
    assert d.endpoint_unreachable({"response": "an answer"}) == ""


@pytest.mark.parametrize("err", [
    "Error code: 502 - {'error': {'message': 'Bad gateway'}}",
    "Error code: 503 - {'error': {'message': 'Service Unavailable'}}",
    "Error code: 504 - {'error': {'message': 'Gateway timeout'}}",
])
def test_a_gateway_status_is_a_deferral(err):
    """Standard gateway statuses: the endpoint did not answer. Not yet measured in a
    harness verdict — named here on the statuses' own meaning, like the transient 429."""
    assert d.endpoint_unreachable({"error": err}).startswith(
        "deferred-by-endpoint-unreachable: ")


def test_the_three_refusals_are_read_through_one_helper_in_order():
    assert d.defer_refusal({"error": GATE}).startswith("deferred-by-capacity-gate")
    assert d.defer_refusal({"error": RATE_LIMIT}).startswith(
        "deferred-by-provider-rate-limit: ")
    assert d.defer_refusal({"error": CUT}).startswith("deferred-by-endpoint-unreachable: ")
    assert d.defer_refusal({}) == ""
    assert d.defer_refusal({"error": "401 invalid proxy authentication"}) == ""


def test_the_diagnostic_naming_of_the_cause_is_untouched():
    assert d.call_failure({"error": CUT}).startswith("call-failed: ")


def test_the_driver_verdict_is_one_the_scheduler_defers_on():
    """The contract between the two modules: the scheduler matches its prefixes from the
    FIRST character, so the verdict must be bare — `stage2-` + deferral still failed."""
    assert S.ENDPOINT_UNREACHABLE_VERDICT == d.ENDPOINT_UNREACHABLE_VERDICT
    assert S.ENDPOINT_UNREACHABLE_VERDICT in S.DEFERRED_VERDICT_PREFIXES
    assert d.endpoint_unreachable({"error": CUT}).startswith(S.DEFERRED_VERDICT_PREFIXES)


def test_no_special_wait_is_attached_to_it():
    """Not a window wall and not a REST bucket: a restart is over in seconds to minutes,
    so the ordinary backoff is the whole wait."""
    v = "deferred-by-endpoint-unreachable: x"
    assert S.provider_wall_wait(v) is None
    assert S.github_reset_wait(v, 0.0) is None


# ---- every verdict site ----------------------------------------------------------------
def test_every_verdict_that_names_call_failure_reads_the_refusals_first():
    """The structural pin, by AST — the stage-1 and build sites are reached only through a
    full run, so they are pinned here rather than by an engine. Any assignment to
    `…["verdict"]` whose value names `call_failure(` must name `defer_refusal(` in front:
    that is the whole fix, and a new verdict site cannot be added without it."""
    src = (HERE / "nb_coder_driver.py").read_text(encoding="utf-8")
    rows = []
    for node in ast.walk(ast.parse(src)):
        if not isinstance(node, ast.Assign):
            continue
        for tgt in node.targets:
            sl = tgt.slice if isinstance(tgt, ast.Subscript) else None
            if isinstance(sl, ast.Constant) and sl.value == "verdict":
                seg = ast.get_source_segment(src, node.value) or ""
                if "call_failure(" in seg:
                    rows.append((node.lineno, "defer_refusal(" in seg))
    assert len(rows) >= 6                                  # the scan sees the sites
    assert all(ok for _, ok in rows), [ln for ln, ok in rows if not ok]


def test_a_cut_build_defers_bare_with_one_call_spent(monkeypatch):
    """The measured path (#28664, call "2-build+0"): neither bisected nor repaired into the
    cut, and the verdict is the deferral — it was `stage2-call-failed: (…):0`."""
    plan_cells = [{"idx": i, "cell_type": "code", "titre": f"c{i}"} for i in range(8)]
    calls = []

    async def fake(session, args, rec, stage, prompt, conv, max_tokens=None):
        calls.append(stage)
        return {"response": "", "error": CUT, "conversation_id": "cx"}

    monkeypatch.setattr(d, "sk_call_retry", fake)
    rec: dict = {}
    assert asyncio.run(d.create_segments(None, None, rec, None, plan_cells, 8, "")) == {}
    assert calls == ["2-build+0"]
    assert rec["verdict"].startswith("deferred-by-endpoint-unreachable: ")
    assert "APIConnectionError" in rec["verdict"]
    assert "bisected" not in rec and "format_repairs" not in rec


def test_a_cut_half_of_a_bisected_build_defers_bare(monkeypatch):
    """The first tour was CUT BY MAX_TOKENS (the bisect's own case); the half met the cut."""
    plan_cells = [{"idx": i, "cell_type": "code", "titre": f"c{i}"} for i in range(8)]
    calls = []

    async def fake(session, args, rec, stage, prompt, conv, max_tokens=None):
        calls.append(stage)
        if stage == "2-build+0":
            return {"response": '```json\n{"cells":[{"idx":0,"source": "coupé',
                    "conversation_id": "cx"}
        return {"response": "", "error": CUT, "conversation_id": "cx"}

    monkeypatch.setattr(d, "sk_call_retry", fake)
    rec: dict = {}
    assert asyncio.run(d.create_segments(None, None, rec, None, plan_cells, 8, "")) == {}
    assert calls == ["2-build+0", "2-build+0+h0"]
    assert rec["verdict"].startswith("deferred-by-endpoint-unreachable: ")
    # the truncated first answer was BISECTED, not format-repaired (it would be cut again),
    # and the half that met the cut ended the segment: no bisect bookkeeping is written
    assert "format_repairs" not in rec and "bisected" not in rec


def test_a_time_budget_keeps_its_own_verdict_next_to_the_cut(monkeypatch):
    """The control, same envelope family: APITimeoutError is NOT a cut. It names the
    timeout, because a smaller tranche cures it — pinned since 20/11 (MGS-28)."""
    plan_cells = [{"idx": i, "cell_type": "code", "titre": f"c{i}"} for i in range(8)]

    async def fake(session, args, rec, stage, prompt, conv, max_tokens=None):
        return {"response": "", "error": TIMEOUT, "conversation_id": "cx"}

    monkeypatch.setattr(d, "sk_call_retry", fake)
    rec: dict = {}
    assert asyncio.run(d.create_segments(None, None, rec, None, plan_cells, 8, "")) == {}
    assert rec["verdict"] == "stage2-timeout:0+h0"


def test_a_cut_format_repair_hands_the_refusal_back(monkeypatch):
    """The build answered, its JSON did not decode, and the repair call met the cut. The
    caller must see the REFUSAL: handed the original error-less answer, it would name the
    grain `unparsed` and fail it."""

    async def fake(session, args, rec, stage, prompt, conv, max_tokens=None):
        return {"response": "", "error": CUT, "conversation_id": "cx"}

    monkeypatch.setattr(d, "sk_call_retry", fake)
    env = {"response": "```json\nceci n'est pas du JSON\n```", "conversation_id": "cx"}
    obj, out = asyncio.run(d.parse_or_repair(None, None, {}, "2-build+0", env, "cx"))
    assert obj is None and out is not env
    assert d.endpoint_unreachable(out).startswith("deferred-by-endpoint-unreachable: ")


@pytest.mark.parametrize("err, verdict", [
    (CUT, "deferred-by-endpoint-unreachable"),
    (GATE, "deferred-by-capacity-gate"),
])
def test_the_spec_turn_defers_bare(monkeypatch, tmp_path, err, verdict):
    """A dead spec turn hands nothing back to stage 1 (same fail-loud as stage 1). The
    gate line is a CHANGE: the spec site used to read the 429 only, so a gate refusal
    there came out `spec-call-failed: …` — a failure for a refusal that says retry."""
    calls = []

    async def fake(session, args, rec, stage, prompt, conv, max_tokens=None, model=None):
        calls.append(stage)
        return {"response": "", "error": err, "conversation_id": "cx"}

    monkeypatch.setattr(d, "sk_call_retry", fake)
    monkeypatch.setattr(d, "spec_prompt", lambda *a, **k: "P")
    args = SimpleNamespace(spec_mode="run", issue=7, spec_model="m", notebook="N.ipynb")
    rec: dict = {}
    out = asyncio.run(d.spec_stage(None, args, rec, {"title": "T", "body": "B"}, {}, "",
                                   "", "", tmp_path))
    assert out is None and calls == ["spec"]
    assert rec["verdict"].startswith(verdict)


# ---- a revision round -------------------------------------------------------------------
FINDINGS = [{"cell": 0, "severity": "major", "detail": "précision"}]


def _built(tmp_path: Path) -> Path:
    p = tmp_path / "built.ipynb"
    p.write_text(json.dumps({"nbformat": 4, "nbformat_minor": 5,
                             "metadata": {"kernelspec": {"name": "python3"}}, "cells": [
        {"cell_type": "code", "metadata": {}, "execution_count": 1,
         "source": ["print(1 - 0.5)"], "outputs": []}]}), encoding="utf-8")
    return p


def test_a_cut_revision_round_defers_the_run_and_keeps_the_reject(monkeypatch, tmp_path):
    """Same rule as the walled round (CoursIA#28069, test_nb_coder_revise.py): the
    refusal is the run's verdict, the reject it interrupted is kept for a --revise-from
    resume, and the refused round pays no kernel, no gate and no verifier."""
    built = _built(tmp_path)
    before = built.read_bytes()
    calls = []

    @contextlib.asynccontextmanager
    async def fake_sessions(out_dir):
        yield "SK", "PM"

    async def fake_sk(sk, args, rec, stage, prompt, conv, max_tokens=None, model=None):
        calls.append(stage)
        return {"response": "", "error": CUT, "conversation_id": "cx"}

    def never(*a, **k):
        raise AssertionError("a refused round pays no kernel, no gate and no verifier")

    monkeypatch.setattr(d, "mcp_sessions", fake_sessions)
    monkeypatch.setattr(d, "sk_call_retry", fake_sk)
    monkeypatch.setattr(d, "start_kernel", never)
    monkeypatch.setattr(d, "run_gates", never)
    monkeypatch.setattr(d, "stage4_verify", never)
    rec = {"verdict": "verify-reject", "calls": [], "stages": {}, "conversation_id": "c-build",
           "verify": {"verdict": "reject", "findings": list(FINDINGS)}}
    args = SimpleNamespace(revise_rounds=2, max_stage=4, from_spec=True, repair_rounds=0)
    asyncio.run(d.revise_loop(
        args, rec, issue={"title": "T", "body": "B"}, src_nb=tmp_path / "twin.ipynb",
        built_path=built, kname="python3", exec_dir=tmp_path, conventions="",
        create_mode=True, wt_path=tmp_path, out_dir=tmp_path))
    assert calls == ["6-revise+0"]
    assert rec["verdict"].startswith("deferred-by-endpoint-unreachable: ")
    assert rec["last_content_verdict"] == "verify-reject"
    assert rec["revisions"][0]["result"].startswith("call-failed: ")   # the cause, by name
    assert built.read_bytes() == before


# ---- scheduler ------------------------------------------------------------------------
def _sched(tmp_path, verdict, clock):
    q = tmp_path / "queue.jsonl"
    q.write_text(json.dumps({"issue": 1, "notebook": "Dir/N1.ipynb"}) + "\n", encoding="utf-8")
    args = S.parse_args(["--queue", str(q), "--state-dir", str(tmp_path / "state"),
                         "--repo", "D:/CoursIA", "--max-active", "2"])
    sched = S.Scheduler(args, spawn=lambda cmd: S.FakeProc(verdict, 1, 0),
                        gate=lambda: {"verdict": "green", "running": 0, "waiting": 0,
                                      "preemptions": 0},
                        sleep=lambda s=0: None, clock=lambda: clock["t"])
    loaded, digest = S.load_queue(q)
    sched.merge_queue(loaded, digest)
    sched._save_state()
    return sched


def _journal(sched, kind):
    path = sched.journal_path
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    return [r for r in rows if r["kind"] == kind]


CUT_VERDICT = "deferred-by-endpoint-unreachable: " + CUT[:120]


def test_a_cut_grain_takes_the_ordinary_backoff_and_is_never_released(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, CUT_VERDICT, clock)
    released = []
    sched._release_claim = lambda *a, **k: released.append(a)
    sched.tick()
    clock["t"] += 10
    sched.tick()
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    ramp = sched.state["ramp"]
    assert g["status"] == "deferred" and g["attempts"] == 1
    assert g["not_before"] == 1010.0 + sched.args.backoff_s     # no wall, no reset epoch
    assert ramp["failed"] == 0 and ramp.get("content_failed", 0) == 0
    assert ramp["deferred"] == 1
    clock["t"] = g["not_before"] + 1
    assert sched.tick()["launched"] == 1                         # retried, not waited out
    assert released == [] and not _journal(sched, "claim-released")
    assert not _journal(sched, "failed")


def test_an_outlasting_cut_ends_attempts_exhausted_never_released(tmp_path):
    """A cut that outlasts the launches ends `attempts-exhausted`, never `failed`: no
    [RELEASED] is posted, so nothing locks the notebook for three days."""
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, CUT_VERDICT, clock)
    sched.args.max_attempts = 2
    released = []
    sched._release_claim = lambda *a, **k: released.append(a)
    sched.tick()                                  # launch 1
    clock["t"] += 10
    sched.tick()                                  # deferred once
    for _ in range(3):
        g = sched.state["grains"]["#1:Dir/N1.ipynb"]
        clock["t"] = max(clock["t"], (g.get("not_before") or 0)) + 1
        sched.tick()
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    assert g["status"] == "failed" and g["attempts"] == 2
    assert released == [] and not _journal(sched, "failed")
    assert not _journal(sched, "claim-released")
    assert _journal(sched, "attempts-exhausted")


def test_the_control_an_ordinary_failure_does_release(tmp_path):
    """Proves the recorder above is live: an ordinary failure does reach the release."""
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, "stage2-call-failed: something else", clock)
    released = []
    sched._release_claim = lambda *a, **k: released.append(a)
    sched.tick()
    clock["t"] += 10
    sched.tick()
    assert sched.state["grains"]["#1:Dir/N1.ipynb"]["status"] == "failed"
    assert released and _journal(sched, "failed")
