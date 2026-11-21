# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 9683ab2f5165f374bbb387132288c2cbf7cc6084
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_ramp_content.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for the content/run split of ramp failures (21/11).

Measured 20/11 -> 21/11: one built-execution-failed on CoursIA#27302 (a C# parity grain)
froze the live conveyor at its floor for 7 h ("failures 1>0") while the capacity gate was
green on 791 of 858 samples. That grain's whole conversation was served; the notebook was
judged and did not pass. Such a CONTENT failure now proves a served run for the ramp.
A RUN failure (call failed, timeout, no answer, crash, kernel, verify-error) and any
unknown verdict still block the promotion, exactly as before.
"""
import importlib.util
import json
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_scheduler", HERE / "nb_coder_scheduler.py")
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)


def item(n):
    return {"issue": n, "notebook": f"Dir/N{n}.ipynb"}


def _sched(tmp_path, items, verdicts, clock, **over):
    """verdicts: (verdict, rc) of successive launches; later launches stay in flight."""
    q = tmp_path / "queue.jsonl"
    q.write_text("\n".join(json.dumps(x) for x in items) + "\n", encoding="utf-8")
    args = S.parse_args(["--queue", str(q), "--state-dir", str(tmp_path / "state"),
                         "--repo", "D:/CoursIA", "--ramp", "1,2"])
    for k, v in over.items():
        setattr(args, k, v)
    queue = list(verdicts)

    def spawn(cmd):
        if not queue:                     # past the scripted outcomes: stays in flight
            return S.FakeProc(done_after=10**6)
        verdict, rc = queue.pop(0)
        return S.FakeProc(verdict=verdict, rc=rc, done_after=0)

    sched = S.Scheduler(args, spawn=spawn, gate=lambda: {"verdict": "green", "running": 0},
                        sleep=lambda s=0: None, clock=lambda: clock["t"],
                        probe=lambda pid: None)
    sched.merge_queue(*S.load_queue(q))
    return sched


def _drive(sched, clock, ticks):
    for _ in range(ticks):
        clock["t"] += 1
        sched.tick()


def _events(sched, kind):
    return [e for e in (json.loads(l) for l in
                        (sched.state_dir / "scheduler.jsonl").read_text().splitlines())
            if e["kind"] == kind]


@pytest.mark.parametrize("verdict", [
    "built-execution-failed", "built-structure-mismatch", "built-executed-counts-broken",
    "gates-failed:nav,pair", "verify-reject", "stage1-unaddressable-creation-plan",
    "refused-spec-plan-unusable", "stage2-short-segment:3"])
def test_content_verdicts_classify_as_content(verdict):
    assert S.failure_class(verdict) == "content"


@pytest.mark.parametrize("verdict", [
    "stage2-call-failed:2", "stage2-timeout:1", "spec-no-answer", "crashed:boom",
    "kernel-start-failed", "verify-error", "verify-same-served-model",
    "stage2-review-failed", "stage2-empty-segment:0", "unknown", "", None,
    # a prefix match only: a verdict merely CONTAINING a content word is not content
    "x-built-execution-failed", "refused-revise-not-rejected:verify-reject"])
def test_everything_else_is_a_run_failure(verdict):
    assert S.failure_class(verdict) == "run"


def test_a_content_failure_counts_as_served_and_promotes(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [item(i) for i in (1, 2, 3)],
                   [("built-executed-ok", 0), ("built-execution-failed", 1),
                    ("built-executed-ok", 0)], clock, ramp_min_done=2, ramp_green_s=0)
    _drive(sched, clock, 4)
    assert sched.state["grains"]["#2:Dir/N2.ipynb"]["status"] == "failed"
    assert sched.state["ramp"]["max_active"] == 2, sched.state.get("last_promotion_block")
    report = sched.state["ramp_history"][-1]
    assert report["done"] == 1 and report["content_failed"] == 1 and report["failed"] == 0


def test_a_lone_content_failure_is_short_of_served_runs_not_a_failure(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [item(i) for i in (1, 2, 3)],
                   [("built-execution-failed", 1)], clock, ramp_min_done=3, ramp_green_s=0)
    _drive(sched, clock, 2)
    block = sched.state.get("last_promotion_block") or ""
    assert "failures" not in block
    assert "served 1/3 (done 0 + content-failed 1)" in block
    assert sched.state["ramp"]["content_failed"] == 1
    assert sched.state["ramp"]["failed"] == 0


def test_a_run_failure_still_blocks_the_promotion(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [item(i) for i in (1, 2, 3)],
                   [("built-executed-ok", 0), ("stage2-call-failed:1", 1),
                    ("built-executed-ok", 0)], clock, ramp_min_done=2, ramp_green_s=0)
    _drive(sched, clock, 6)
    assert sched.state["ramp"]["max_active"] == 1
    assert "failures 1>0" in sched.state["last_promotion_block"]


def test_an_unknown_verdict_blocks_like_a_run_failure(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [item(i) for i in (1, 2, 3)],
                   [("built-executed-ok", 0), ("something-new", 1),
                    ("built-executed-ok", 0)], clock, ramp_min_done=2, ramp_green_s=0)
    _drive(sched, clock, 6)
    assert sched.state["ramp"]["max_active"] == 1
    assert "failures 1>0" in sched.state["last_promotion_block"]


def test_the_failed_event_carries_its_class(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [item(1), item(2)],
                   [("verify-reject", 1), ("stage2-timeout:0", 1)], clock,
                   ramp=[2], ramp_min_done=9, ramp_green_s=0)
    _drive(sched, clock, 3)
    classes = {e["key"]: e["failure_class"] for e in _events(sched, "failed")}
    assert classes == {"#1:Dir/N1.ipynb": "content", "#2:Dir/N2.ipynb": "run"}
    assert sched.state["ramp"]["content_failed"] == 1 and sched.state["ramp"]["failed"] == 1


def test_a_failure_recorded_before_the_split_classifies_from_its_verdict(tmp_path):
    """The live state of 21/11: a grain failed by the old code, ramp dict without the key."""
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [item(1), item(2)], [], clock)
    ramp = sched.state["ramp"]
    ramp.pop("content_failed")
    ramp["failed"] = 1
    sched.state["grains"]["#1:Dir/N1.ipynb"].update(
        {"status": "failed", "ramp_failed_ts": ramp["step_started"] + 1,
         "last_verdict": "built-execution-failed"})
    sched._maybe_promote(1, clock["t"])
    assert ramp["failed"] == 0 and ramp["content_failed"] == 1
    assert "failures" not in (sched.state.get("last_promotion_block") or "")
