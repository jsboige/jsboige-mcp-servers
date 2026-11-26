# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_midrun_claim.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Mid-run claim probe under --claim-late (22/11).

Six grains were taken by faster lanes while Swift was building them (CoursIA#27927,
#27928, #27930, #27931, #27935, #27936, 03:50->04:45Z); each refusal surfaced only at
the late reservation, ~1.5 h of engine time after the other lane's marker. These tests
pin the probe: the last-marker reading, the guard confirmation that alone may stop a
run, and the stop before a revision round.

26/11 (CoursIA#28707): the probe sat only at the STAGE boundaries, and the creation
build is one stage of 5+ model calls. A foreign [CLAIMED] landed at 04:02:13Z between
tranche 1 and tranche 2; the "build" probe fired at 04:08:05Z, after four more calls
(347 201 prompt tokens). The second block pins the in-stage probe: before every build
call but the first, on the tranche, bisect and repair sites alike.
"""
import asyncio
import importlib.util
import json
import re
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

_HERE = Path(__file__).resolve().parent
pytest.importorskip("mcp")
_spec = importlib.util.spec_from_file_location("nbcd_midrun", _HERE / "nb_coder_driver.py")
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)

ME = "myia-ai-01:vllm"


def _gh(monkeypatch, bodies, rc=0):
    def fake_run(argv, **kw):
        return subprocess.CompletedProcess(argv, rc, json.dumps(bodies), "")
    monkeypatch.setattr(D.subprocess, "run", fake_run)


@pytest.mark.parametrize("bodies, want", [
    ([], None),
    ([f"[CLAIMED] lane {ME} -- port"], None),
    ([f"[CLAIMED] lane {ME} -- port", "[CLAIMED] lane myia-po-2024:CoursIA -- port"],
     "myia-po-2024:CoursIA"),
    (["[CLAIMED] lane myia-po-2027:CoursIA-2 -- x", "[RELEASED] lane myia-po-2027:CoursIA-2"],
     None),
    (["[CLAIMED] lane myia-po-2023:CoursIA -- x", "texte libre",
      "[DELIVERED] lane myia-po-2023:CoursIA -- PR #27952"], "myia-po-2023:CoursIA"),
    # same machine, other workspace: another lane
    (["[CLAIMED] lane myia-ai-01:CoursIA-2 -- x"], "myia-ai-01:CoursIA-2"),
])
def test_last_foreign_marker(monkeypatch, bodies, want):
    _gh(monkeypatch, bodies)
    assert D.last_foreign_marker(27931, ME) == want


def test_last_foreign_marker_fails_open(monkeypatch):
    _gh(monkeypatch, ["[CLAIMED] lane x:y"], rc=1)
    assert D.last_foreign_marker(1, ME) is None

    def timeout(argv, **kw):
        raise subprocess.TimeoutExpired(argv, 60)
    monkeypatch.setattr(D.subprocess, "run", timeout)
    assert D.last_foreign_marker(1, ME) is None


def _args():
    return SimpleNamespace(issue=27935, lane=ME, repo=".", notebook="Dir/N-Rust.ipynb",
                           revise_rounds=2, max_stage=4, from_spec=True, repair_rounds=0)


def _late_rec():
    return {"verdict": "verify-reject", "calls": [],
            "stages": {"claim_reservation": {"deferred": "late"}},
            "verify": {"verdict": "reject",
                       "findings": [{"cell": 1, "severity": "major", "detail": "x"}]}}


def test_no_probe_when_the_claim_was_not_deferred(monkeypatch):
    seen = []
    monkeypatch.setattr(D, "last_foreign_marker", lambda *a: seen.append(a))
    rec = _late_rec()
    rec["stages"]["claim_reservation"] = {"deferred": D.LATE_CLAIM_TAKEN}
    assert D.midrun_claim_abort(_args(), rec, "plan") is False
    assert seen == [] and "midrun_claim_probes" not in rec


def test_a_quiet_issue_keeps_running_and_is_traced(monkeypatch):
    monkeypatch.setattr(D, "last_foreign_marker", lambda *a: None)
    monkeypatch.setattr(D, "check_claim", lambda *a: pytest.fail("guard must not run"))
    rec = _late_rec()
    assert D.midrun_claim_abort(_args(), rec, "plan") is False
    assert rec["midrun_claim_probes"][0]["holder"] is None


def test_a_confirmed_collision_stops_the_run(monkeypatch):
    monkeypatch.setattr(D, "last_foreign_marker", lambda *a: "myia-po-2027:CoursIA-2")
    monkeypatch.setattr(D, "check_claim", lambda *a: {"ok": False, "rc": 1})
    rec = _late_rec()
    assert D.midrun_claim_abort(_args(), rec, "build") is True
    assert rec["verdict"] == "late-claim-refused:midrun:build:myia-po-2027:CoursIA-2"


@pytest.mark.parametrize("cc", [
    {"ok": None, "timed_out": True},       # guard timed out
    {"ok": None, "rc": None},              # guard broken
    {"ok": True, "rc": 0},                 # the marker does not cover this notebook
    {"ok": False, "rc": 3, "implicit": [{"number": 9, "touches_notebook": False}]},
])
def test_an_unconfirmed_marker_never_stops_the_run(monkeypatch, cc):
    monkeypatch.setattr(D, "last_foreign_marker", lambda *a: "other:lane")
    monkeypatch.setattr(D, "check_claim", lambda *a: cc)
    rec = _late_rec()
    assert D.midrun_claim_abort(_args(), rec, "plan") is False
    assert rec["verdict"] == "verify-reject"


def test_the_revision_loop_stops_before_a_round(monkeypatch, tmp_path):
    monkeypatch.setattr(D, "last_foreign_marker", lambda *a: "myia-po-2024:CoursIA")
    monkeypatch.setattr(D, "check_claim", lambda *a: {"ok": False, "rc": 1})

    def no_session(out_dir):
        raise AssertionError("no model call after a confirmed foreign claim")
    monkeypatch.setattr(D, "mcp_sessions", no_session)
    built = tmp_path / "built.ipynb"
    built.write_text(json.dumps({"cells": [], "metadata": {}, "nbformat": 4,
                                 "nbformat_minor": 5}), encoding="utf-8")
    rec = _late_rec()
    rec["verify"]["source"] = "gates"      # the post-loop rewrite must not mask the stop
    rec["gate_repair"] = {"from": "gates-failed:uncommented-code"}
    asyncio.run(D.revise_loop(_args(), rec, issue={"title": "T", "body": "B"},
                              src_nb=tmp_path / "twin.ipynb", built_path=built,
                              kname="rust", exec_dir=tmp_path, conventions="",
                              create_mode=True, wt_path=tmp_path, out_dir=tmp_path))
    assert rec["verdict"] == "late-claim-refused:midrun:revise+0:myia-po-2024:CoursIA"
    assert rec["revisions"] == []


@pytest.mark.parametrize("label", ["plan", "build", "build+16", "build+0+h1", "build+8+repair"])
def test_the_ramp_reads_a_midrun_stop_as_a_served_run(label):
    spec = importlib.util.spec_from_file_location("nbcs_midrun", _HERE / "nb_coder_scheduler.py")
    sch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sch)
    assert sch.failure_class(f"late-claim-refused:midrun:{label}:x:y") == "content"


# ---------------------------------------------------------------- in-stage probe (26/11)
def _plan(n):
    return [{"idx": i, "cell_type": "markdown" if i % 2 else "code", "titre": f"c{i}"}
            for i in range(n)]


def _build_rec():
    return {"stages": {"claim_reservation": dict(D.LATE_CLAIM_DEFERRED)}}


def _quiet_model(monkeypatch, calls, omit_one=False):
    """Answers every asked idx back; records each model call in `calls`."""
    async def fake(session, args, rec, stage, prompt, conv, max_tokens=None):
        calls.append(stage)
        asked = sorted(int(m) for m in re.findall(r'"idx":\s*(\d+)', prompt))
        if omit_one and asked:
            asked = asked[1:]                 # one omission -> ONE repair re-ask
        cells = [{"idx": i, "cell_type": "markdown", "source": f"src {i}"} for i in asked]
        return {"response": "```json\n" + json.dumps({"cells": cells}) + "\n```",
                "conversation_id": "cx"}
    monkeypatch.setattr(D, "sk_call_retry", fake)


def test_the_build_probe_runs_before_every_tranche_but_the_first(monkeypatch):
    """The "plan" probe covers the first tranche: it runs right before stage 2. Each
    later tranche -- a model call of its own -- gets a probe of its own."""
    calls = []
    _quiet_model(monkeypatch, calls)
    monkeypatch.setattr(D, "last_foreign_marker", lambda *a: None)
    monkeypatch.setattr(D, "check_claim", lambda *a: pytest.fail("a quiet issue never runs the guard"))
    rec = _build_rec()
    out = asyncio.run(D.create_segments(None, _args(), rec, None, _plan(26), 26, ""))
    assert calls == ["2-build+0", "2-build+8", "2-build+16", "2-build+24"]
    assert [p["stage"] for p in rec["midrun_claim_probes"]] == ["build+8", "build+16", "build+24"]
    assert [c["idx"] for c in out["cells"]] == list(range(26))
    assert "verdict" not in rec


def test_no_build_probe_when_the_claim_was_not_deferred(monkeypatch):
    calls = []
    _quiet_model(monkeypatch, calls)
    monkeypatch.setattr(D, "last_foreign_marker", lambda *a: pytest.fail("no probe without --claim-late"))
    rec = {}
    out = asyncio.run(D.create_segments(None, _args(), rec, None, _plan(18), 18, ""))
    assert calls == ["2-build+0", "2-build+8", "2-build+16"]
    assert [c["idx"] for c in out["cells"]] == list(range(18))
    assert "midrun_claim_probes" not in rec


def test_a_claim_taken_between_two_tranches_stops_before_the_next_call(monkeypatch):
    """The exposure is the call in flight: the marker appears after tranche 1 was
    answered, the probe before tranche 2 refuses, tranche 2 is never asked."""
    calls = []
    _quiet_model(monkeypatch, calls)
    readings = iter([None, "myia-po-2024:CoursIA"])
    monkeypatch.setattr(D, "last_foreign_marker", lambda *a: next(readings))
    monkeypatch.setattr(D, "check_claim", lambda *a: {"ok": False, "rc": 1})
    rec = _build_rec()
    out = asyncio.run(D.create_segments(None, _args(), rec, None, _plan(26), 26, ""))
    assert out == {}
    assert calls == ["2-build+0", "2-build+8"], "the tranche after the marker is never asked"
    assert rec["verdict"] == "late-claim-refused:midrun:build+16:myia-po-2024:CoursIA"
    assert [p["stage"] for p in rec["midrun_claim_probes"]] == ["build+8", "build+16"]


def test_the_repair_call_is_probed_too(monkeypatch):
    calls = []
    _quiet_model(monkeypatch, calls, omit_one=True)
    monkeypatch.setattr(D, "last_foreign_marker", lambda *a: "myia-po-2024:CoursIA")
    monkeypatch.setattr(D, "check_claim", lambda *a: {"ok": False, "rc": 1})
    rec = _build_rec()
    out = asyncio.run(D.create_segments(None, _args(), rec, None, _plan(8), 8, ""))
    assert out == {}
    assert calls == ["2-build+0"], "the repair re-ask is a model call: it is probed first"
    assert rec["verdict"] == "late-claim-refused:midrun:build+0+repair:myia-po-2024:CoursIA"


def test_a_bisect_half_is_probed_too(monkeypatch):
    calls = []

    async def one_truncated_tour(session, args, rec, stage, prompt, conv, max_tokens=None):
        assert not calls, f"{stage} asked after a confirmed foreign claim"
        calls.append(stage)
        return {"response": '```json\n{"cells": [{"idx": 0,', "conversation_id": "cx"}

    async def no_parse(session, args, rec, stage, env, conv, max_tokens=None):
        return None, env                      # unparsable AND cut: the bisect path

    monkeypatch.setattr(D, "sk_call_retry", one_truncated_tour)
    monkeypatch.setattr(D, "parse_or_repair", no_parse)
    monkeypatch.setattr(D, "last_foreign_marker", lambda *a: "myia-po-2024:CoursIA")
    monkeypatch.setattr(D, "check_claim", lambda *a: {"ok": False, "rc": 1})
    rec = _build_rec()
    out = asyncio.run(D.create_segments(None, _args(), rec, None, _plan(8), 8, ""))
    assert out == {}
    assert calls == ["2-build+0"]
    assert rec["verdict"] == "late-claim-refused:midrun:build+0+h0:myia-po-2024:CoursIA"
    assert rec.get("bisected") is None, "the stop precedes the bisect bookkeeping"


def test_every_build_call_site_is_guarded_by_a_probe():
    """The structural pin: tranche, bisect half and repair are three model calls, and a
    fourth added later must come with its probe -- or fail here, not in production."""
    src = Path(D.__file__).read_text(encoding="utf-8")
    fn = src.split("async def create_segments", 1)[1].split("\ndef ", 1)[0]
    sites = [m.start() for m in re.finditer(
        r'await (?:ask_tranche\(|sk_call_retry\(session, args, rec, f"2-build\+)', fn)]
    assert len(sites) == 3, f"build call sites: {len(sites)} (each needs its probe)"
    prev = 0
    for pos in sites:
        between = fn[prev:pos]
        assert 'if claim_stop(f"' in between, "a build call with no probe since the previous one"
        prev = pos
