# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 9683ab2f5165f374bbb387132288c2cbf7cc6084
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_ramp_window.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for the ramp evidence window (20/11).

Two pieces of promotion evidence never expired inside a step, and step 0 has no
demotion to reset them, so the live conveyor sat at its first step all session:
- one red or unknown gate sample set a flag that blocked promotion for good;
- a failure stayed counted after the failed grain had been retried on a fix.
A red/unknown sample now restarts the green window, and the failure count is the
number of grains that failed during the step and are STILL failed.
"""
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_scheduler", HERE / "nb_coder_scheduler.py")
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)


def item(n):
    return {"issue": n, "notebook": f"Dir/N{n}.ipynb"}


def _sched(tmp_path, items, gate, clock, **over):
    q = tmp_path / "queue.jsonl"
    q.write_text("\n".join(json.dumps(x) for x in items) + "\n", encoding="utf-8")
    args = S.parse_args(["--queue", str(q), "--state-dir", str(tmp_path / "state"),
                         "--repo", "D:/CoursIA", "--ramp", "1,2"])
    for k, v in over.items():
        setattr(args, k, v)
    sched = S.Scheduler(args, spawn=lambda cmd: S.FakeProc(done_after=0),
                        gate=lambda: dict(gate), sleep=lambda s=0: None,
                        clock=lambda: clock["t"], probe=lambda pid: None)
    sched.merge_queue(*S.load_queue(q))
    return sched, q


def test_one_unknown_sample_no_longer_freezes_step_zero(tmp_path):
    clock, gate = {"t": 1000.0}, {"verdict": "unknown", "running": 0}
    sched, _ = _sched(tmp_path, [item(i) for i in range(1, 11)], gate, clock,
                      ramp_min_done=1, ramp_green_s=60)
    sched.tick()                                   # unknown: held, step 0 marked dirty
    assert sched.state["ramp"]["dirty"] is True
    gate["verdict"] = "green"
    for _ in range(4):                             # launch #1, reap it done
        clock["t"] += 10
        sched.tick()
    assert sched.state["ramp"]["max_active"] == 1   # green 30 s < 60 s window
    clock["t"] += 60
    sched.tick()
    assert sched.state["ramp"]["max_active"] == 2, sched.state.get("last_promotion_block")
    assert sched.state["ramp_history"][-1]["dirty"] is True   # evidence kept in the report


def test_a_red_sample_restarts_the_green_window(tmp_path):
    clock, gate = {"t": 1000.0}, {"verdict": "green", "running": 0}
    sched, _ = _sched(tmp_path, [item(i) for i in range(1, 11)], gate, clock,
                      ramp_min_done=1, ramp_green_s=60)
    sched.tick()
    clock["t"] += 50
    sched.tick()                                   # #1 done, green 50 s
    gate["verdict"] = "red"
    clock["t"] += 5
    sched.tick()
    gate["verdict"] = "green"
    clock["t"] += 30                               # 85 s since the first green,
    sched.tick()                                   # but only 0 s since the red
    assert sched.state["ramp"]["max_active"] == 1
    assert "green" in sched.state["last_promotion_block"]
    clock["t"] += 61
    sched.tick()
    assert sched.state["ramp"]["max_active"] == 2


def test_a_retried_failure_leaves_the_evidence_and_a_new_failure_counts(tmp_path):
    clock, gate = {"t": 1000.0}, {"verdict": "green", "running": 0}
    sched, q = _sched(tmp_path, [item(1)], gate, clock, ramp_min_done=5, ramp_green_s=0)
    sched.spawn = lambda cmd: S.FakeProc(verdict="stage2-review-failed", rc=1, done_after=0)
    key = "#1:Dir/N1.ipynb"
    sched.tick()
    clock["t"] += 1
    sched.tick()                                   # #1 failed
    assert sched.state["grains"][key]["status"] == "failed"
    sched._maybe_promote(1, clock["t"])
    assert sched.state["ramp"]["failed"] == 1
    # the operator raises the retry generation after the fix
    q.write_text(json.dumps(item(1) | {"retry": 1}) + "\n", encoding="utf-8")
    sched.merge_queue(*S.load_queue(q))
    assert sched.state["grains"][key]["status"] == "pending"
    sched._maybe_promote(1, clock["t"])
    assert sched.state["ramp"]["failed"] == 0      # the retried failure no longer counts
    clock["t"] += 1
    sched.tick()                                   # relaunch
    clock["t"] += 1
    sched.tick()                                   # fails again
    assert sched.state["grains"][key]["status"] == "failed"
    sched._maybe_promote(1, clock["t"])
    assert sched.state["ramp"]["failed"] == 1      # and counts again


def test_a_failure_before_the_step_started_is_not_counted(tmp_path):
    clock, gate = {"t": 1000.0}, {"verdict": "green", "running": 0}
    sched, _ = _sched(tmp_path, [item(1)], gate, clock)
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    g.update({"status": "failed", "ramp_failed_ts": 900.0})
    sched.state["ramp"]["step_started"] = 950.0
    assert sched._step_failures(sched.state["ramp"]) == 0
    g["ramp_failed_ts"] = 960.0
    assert sched._step_failures(sched.state["ramp"]) == 1


def test_legacy_counter_of_a_retried_grain_is_recomputed(tmp_path):
    """The live state of 20/11: failed=1 carried by a grain that is running again."""
    clock, gate = {"t": 1000.0}, {"verdict": "green", "running": 0}
    sched, _ = _sched(tmp_path, [item(1), item(2)], gate, clock)
    sched.state["ramp"]["failed"] = 1
    sched.state["grains"]["#1:Dir/N1.ipynb"].update({"status": "running", "retry": 1})
    sched._maybe_promote(1, clock["t"])
    assert sched.state["ramp"]["failed"] == 0
    assert "failures" not in (sched.state.get("last_promotion_block") or "")
