# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_ramp_admission.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Pins for the admission class of ramp failures (21/11).

Measured 21/11 04:50Z: step 0 of the live conveyor stood at "failures 5>0", and all
five were refused-claim-* verdicts (MGS-25 not-verified, MGS-28/MGS-29/Search-11
check-not-scoped, Sudoku-05 held by po-2024). The driver refuses those grains at its
claim step, before any model call: they cost the engine nothing and say nothing about
its capacity. They now neither prove a served run nor block the promotion. Sudoku-05
alone would otherwise have held the ramp for as long as po-2024 holds the notebook.
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
        if not queue:
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


# Every refused-claim verdict the driver returns (nb_coder_driver.py claim step).
ADMISSION_VERDICTS = [
    "refused-claim-implicit-occupation",
    "refused-claim-held-by-another-lane",
    "refused-claim-check-broken",
    "refused-claim-check-not-scoped",
    "refused-claim-post-failed",
    "refused-claim-not-verified",
]


@pytest.mark.parametrize("verdict", ADMISSION_VERDICTS)
def test_refused_claim_verdicts_classify_as_admission(verdict):
    assert S.failure_class(verdict) == "admission"


@pytest.mark.parametrize("verdict", [
    # a prefix match only: a verdict merely CONTAINING the word is not admission
    "x-refused-claim-check-not-scoped", "refused-spec-plan-unusable",
    "refused-revise-not-rejected:verify-reject"])
def test_admission_is_a_prefix_match(verdict):
    assert S.failure_class(verdict) != "admission"


def test_admission_refusals_do_not_block_the_promotion(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [item(i) for i in (1, 2, 3, 4, 5)],
                   [("refused-claim-held-by-another-lane", 1), ("built-executed-ok", 0),
                    ("refused-claim-check-not-scoped", 1), ("built-executed-ok", 0)],
                   clock, ramp_min_done=2, ramp_green_s=0)
    _drive(sched, clock, 6)
    assert sched.state["ramp"]["max_active"] == 2, sched.state.get("last_promotion_block")
    report = sched.state["ramp_history"][-1]
    assert report["done"] == 2 and report["failed"] == 0
    assert report["admission_failed"] == 2 and report["content_failed"] == 0


def test_admission_refusals_alone_are_not_served_runs(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [item(i) for i in (1, 2, 3)],
                   [("refused-claim-not-verified", 1), ("refused-claim-post-failed", 1)],
                   clock, ramp_min_done=1, ramp_green_s=0)
    _drive(sched, clock, 4)
    block = sched.state.get("last_promotion_block") or ""
    assert sched.state["ramp"]["max_active"] == 1
    assert "failures" not in block
    assert "served 0/1 (done 0 + content-failed 0)" in block
    assert sched.state["ramp"]["admission_failed"] == 2
    assert sched.state["ramp"]["failed"] == 0


def test_the_failed_event_carries_the_admission_class_and_the_grain_stays_failed(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [item(1), item(2)],
                   [("refused-claim-check-not-scoped", 1), ("stage2-timeout:0", 1)], clock,
                   ramp=[2], ramp_min_done=9, ramp_green_s=0)
    _drive(sched, clock, 3)
    classes = {e["key"]: e["failure_class"] for e in _events(sched, "failed")}
    assert classes == {"#1:Dir/N1.ipynb": "admission", "#2:Dir/N2.ipynb": "run"}
    assert sched.state["grains"]["#1:Dir/N1.ipynb"]["status"] == "failed"
    ramp = sched.state["ramp"]
    assert ramp["admission_failed"] == 1 and ramp["failed"] == 1


def test_a_refusal_recorded_before_the_class_reclassifies_from_its_verdict(tmp_path):
    """The live state of 21/11: five refusals counted as run failures by the old code."""
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, [item(1), item(2)], [], clock)
    ramp = sched.state["ramp"]
    ramp.pop("admission_failed")
    ramp["failed"] = 1
    sched.state["grains"]["#1:Dir/N1.ipynb"].update(
        {"status": "failed", "ramp_failed_ts": ramp["step_started"] + 1,
         "last_verdict": "refused-claim-held-by-another-lane"})
    sched._maybe_promote(1, clock["t"])
    assert ramp["failed"] == 0 and ramp["admission_failed"] == 1
    assert "failures" not in (sched.state.get("last_promotion_block") or "")
