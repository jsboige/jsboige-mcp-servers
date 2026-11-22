# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_midrun_claim.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Mid-run claim probe under --claim-late (22/11).

Six grains were taken by faster lanes while Swift was building them (CoursIA#27927,
#27928, #27930, #27931, #27935, #27936, 03:50->04:45Z); each refusal surfaced only at
the late reservation, ~1.5 h of engine time after the other lane's marker. These tests
pin the probe: the last-marker reading, the guard confirmation that alone may stop a
run, and the stop before a revision round.
"""
import asyncio
import importlib.util
import json
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


def test_the_ramp_reads_a_midrun_stop_as_a_served_run():
    spec = importlib.util.spec_from_file_location("nbcs_midrun", _HERE / "nb_coder_scheduler.py")
    sch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sch)
    assert sch.failure_class("late-claim-refused:midrun:plan:x:y") == "content"
