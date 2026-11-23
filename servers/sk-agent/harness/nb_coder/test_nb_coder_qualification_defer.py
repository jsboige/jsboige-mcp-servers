#!/usr/bin/env python3
"""Offline tests for CoursIA's temporary RELACHEE qualification refusal.

The driver-side rc=1 classification belongs to ms#1859. These tests pin only the
scheduler contract: a recent [RELEASED] waits for the authoritative quarantine and
is re-qualified; it is not a foreign collision or a terminal content/run failure.
Permanent qualification refusals keep their previous terminal behavior.
"""
import importlib.util
import json
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "nb_coder_scheduler", HERE / "nb_coder_scheduler.py")
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)


def _sched(tmp_path, verdicts, clock):
    q = tmp_path / "queue.jsonl"
    q.write_text(json.dumps({"issue": 1, "notebook": "Dir/N1.ipynb"}) + "\n",
                 encoding="utf-8")
    args = S.parse_args(["--queue", str(q), "--state-dir", str(tmp_path / "state"),
                         "--repo", "D:/CoursIA", "--max-active", "2"])
    remaining = list(verdicts)

    def spawn(cmd):
        if not remaining:
            return S.FakeProc(done_after=10**6)
        return S.FakeProc(remaining.pop(0), 1, 0)

    sched = S.Scheduler(
        args, spawn=spawn,
        gate=lambda: {"verdict": "green", "running": 0, "waiting": 0,
                      "preemptions": 0},
        sleep=lambda s=0: None, clock=lambda: clock["t"])
    sched.merge_queue(*S.load_queue(q))
    sched._save_state()
    return sched


def test_relachee_defers_for_the_full_conservative_window(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [S.CLAIM_RELEASED_VERDICT], clock)
    sched.tick()
    clock["t"] += 10
    sched.tick()
    key = "#1:Dir/N1.ipynb"
    g = sched.state["grains"][key]
    assert g["status"] == "deferred"
    assert g["not_before"] == 1010.0 + S.CLAIM_RELEASED_WAIT_S
    assert sched.state["ramp"]["failed"] == 0
    assert sched.state["ramp"]["admission_failed"] == 0
    assert sched.state["ramp"]["content_failed"] == 0
    events = [json.loads(line) for line in
              (sched.state_dir / "scheduler.jsonl").read_text().splitlines()]
    event = next(e for e in events if e["kind"] == "qualification-deferred")
    assert event["qualification"] == "RELACHEE"
    assert event["retry_in_s"] == S.CLAIM_RELEASED_WAIT_S
    assert not any(e["kind"] in ("failed", "claim-released", "claim-release-failed")
                   for e in events)


@pytest.mark.parametrize("verdict", [
    "refused-claim-not-qualified:GEL",
    "refused-claim-not-qualified:LABEL",
    "refused-claim-not-qualified:HORSFLOTTE",
    # A longer token is not the exact RELACHEE verdict: fail closed, never defer it.
    "refused-claim-not-qualified:RELACHEE_UNKNOWN",
])
def test_permanent_or_unknown_qualification_stays_terminal(tmp_path, verdict):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [verdict], clock)
    sched.tick()
    clock["t"] += 10
    sched.tick()
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    assert g["status"] == "failed"
    assert g["last_verdict"] == verdict
    assert sched.state["ramp"]["admission_failed"] == 1


def test_relachee_requalifies_only_after_the_wait(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [S.CLAIM_RELEASED_VERDICT], clock)
    sched.tick()
    clock["t"] += 10
    sched.tick()
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    clock["t"] = g["not_before"] - 1
    assert sched.tick()["launched"] == 0
    assert g["status"] == "deferred"
    clock["t"] = g["not_before"] + 1
    assert sched.tick()["launched"] == 1
    assert g["status"] == "running" and g["attempts"] == 2
