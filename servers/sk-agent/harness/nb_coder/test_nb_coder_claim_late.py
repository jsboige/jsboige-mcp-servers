#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_claim_late.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Offline pins for --claim-late (CoursIA coordinator, 21/11, auto-pick rule Q-A).

Verbatim rule: "pas de [CLAIMED] avant que le run ait une PR ouvrable (stage 4 vert) :
un lancement qui echoue ne verrouille rien". Measured the same morning: 46 Swift launches
on the conveyor, 0 PR -- under the stage-0 reservation each of them posted a [CLAIMED]
the lane then held for a grain that never shipped.

Pinned here: stage 0 defers instead of reserving (the CLEAR pre-check still refuses a
held notebook), late_reservation() reserves through the same lock + reserve_claim before
stage 5 and maps a refusal to late-claim-refused:<v>, a guard timeout is retried once,
the revision path live-rechecks a deferred trace before any spend and reserves late,
the CLI refusals, and the scheduler forwarding + ramp classification. No engine, no MCP
session, no GitHub.
"""
import asyncio
import importlib.util
import inspect
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("mcp")

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import nb_coder_driver as D  # noqa: E402
from test_nb_coder_revise import _rev_args, _resume, _stub_resume, _trace  # noqa: E402

_spec = importlib.util.spec_from_file_location("nb_coder_scheduler",
                                               HERE / "nb_coder_scheduler.py")
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)

HELD = "refused-claim-held-by-another-lane"


def _args(tmp_path, **kw):
    base = dict(out_dir=str(tmp_path / "runs" / "g"), repo="D:/repo", issue=27133,
                notebook="Series\\N.ipynb", source_nb=None, allow_foreign_origin=False,
                lane="lane:a", claim=True, claim_late=True, intention="witness",
                conventions="", max_stage=0, worktree=str(tmp_path / "wt"),
                fresh_worktree=False)
    base.update(kw)
    return SimpleNamespace(**base)


def _stub_stage0(monkeypatch, tmp_path, claim_rc=0, seen=None):
    seen = {} if seen is None else seen
    monkeypatch.setattr(D, "app_token", lambda repo: "")
    monkeypatch.setattr(D, "read_conventions", lambda p: "")
    monkeypatch.setattr(D, "check_claim", lambda *a: {"rc": claim_rc})
    monkeypatch.setattr(D, "fetch_issue", lambda *a: {
        "title": "N", "state": "open", "labels": [], "body": ""})
    monkeypatch.setattr(D, "reserve_claim", lambda *a: (_ for _ in ()).throw(
        AssertionError("--claim-late must not reserve at stage 0")))

    def fake_wt(repo, dest, fresh):
        seen["wt"] = seen.get("wt", 0) + 1
        return {"path": str(tmp_path / "wt"), "reused": False, "head": "deadbee"}

    monkeypatch.setattr(D, "prepare_worktree", fake_wt)
    monkeypatch.setattr(D.subprocess, "run", lambda *a, **kw: SimpleNamespace(
        stdout="https://github.com/jsboige/CoursIA.git\n"))
    return seen


# ---------------------------------------------------------------- stage 0
def test_stage0_defers_the_reservation(monkeypatch, tmp_path):
    seen = _stub_stage0(monkeypatch, tmp_path)
    rec = {"stages": {}, "calls": []}
    got = asyncio.run(D.run(_args(tmp_path), rec))
    assert got["verdict"] == "stage0-only" and seen["wt"] == 1
    cr = got["stages"]["claim_reservation"]
    assert cr["verdict"] is None and cr["deferred"] == "late"
    assert "claim_lock" not in got["stages"]          # no lock taken, nothing posted


def test_stage0_late_still_refuses_a_held_notebook(monkeypatch, tmp_path):
    """Deferring the write is not skipping the check: a notebook another lane holds is
    refused before any worktree or model turn, exactly as without --claim-late."""
    seen = _stub_stage0(monkeypatch, tmp_path, claim_rc=1)
    got = asyncio.run(D.run(_args(tmp_path), {"stages": {}, "calls": []}))
    assert got["verdict"] == HELD and "wt" not in seen


def test_without_claim_late_stage0_still_reserves(monkeypatch, tmp_path):
    seen = _stub_stage0(monkeypatch, tmp_path)
    monkeypatch.setattr(D, "reserve_claim", lambda *a: {
        "before": None, "posted": {"rc": 0}, "verified": {"rc": 0}, "verdict": None})
    got = asyncio.run(D.run(_args(tmp_path, claim_late=False), {"stages": {}, "calls": []}))
    assert got["verdict"] == "stage0-only" and seen["wt"] == 1
    assert "deferred" not in got["stages"]["claim_reservation"]


# ---------------------------------------------------------------- late_reservation
def _deferred_rec():
    return {"stages": {"claim_reservation": dict(D.LATE_CLAIM_DEFERRED)},
            "verdict": "verify-approved"}


def _reserve_seq(monkeypatch, verdicts):
    calls = []

    def fake(repo, n, lane, intention, nb):
        calls.append(nb)
        return {"before": None, "posted": None, "verified": None,
                "verdict": verdicts[len(calls) - 1]}

    monkeypatch.setattr(D, "reserve_claim", fake)
    return calls


def test_late_reservation_is_a_noop_without_deferral(monkeypatch, tmp_path):
    calls = _reserve_seq(monkeypatch, [])
    rec = {"stages": {"claim_reservation": {"verdict": None}}, "verdict": "verify-approved"}
    assert D.late_reservation(_args(tmp_path), rec) is True
    assert calls == [] and "claim_reservation_late" not in rec["stages"]


def test_late_reservation_takes_the_claim(monkeypatch, tmp_path):
    calls = _reserve_seq(monkeypatch, [None])
    rec = _deferred_rec()
    assert D.late_reservation(_args(tmp_path), rec) is True
    assert calls == ["Series/N.ipynb"]                    # POSIX-normalized scope
    assert rec["stages"]["claim_reservation"]["deferred"] == D.LATE_CLAIM_TAKEN
    late = rec["stages"]["claim_reservation_late"]
    assert len(late["attempts"]) == 1 and late["attempts"][0]["lock"]["held"]
    assert rec["verdict"] == "verify-approved"
    # the per-issue lock is released: a sibling grain can reserve next
    assert not (Path(_args(tmp_path).out_dir).parent / D.CLAIM_LOCK_DIRNAME
                / "issue-27133.lock").exists()


def test_late_reservation_refusal_blocks_stage5(monkeypatch, tmp_path):
    _reserve_seq(monkeypatch, [HELD])
    rec = _deferred_rec()
    assert D.late_reservation(_args(tmp_path), rec) is False
    assert rec["verdict"] == f"late-claim-refused:{HELD}"
    assert rec["stages"]["claim_reservation"]["deferred"] == "late"   # never taken


def test_late_reservation_retries_one_guard_timeout(monkeypatch, tmp_path):
    calls = _reserve_seq(monkeypatch, [f"{D.CLAIM_TIMEOUT_VERDICT}:check", None])
    rec = _deferred_rec()
    assert D.late_reservation(_args(tmp_path), rec) is True and len(calls) == 2


def test_late_reservation_gives_up_after_two_timeouts(monkeypatch, tmp_path):
    t = f"{D.CLAIM_TIMEOUT_VERDICT}:check"
    calls = _reserve_seq(monkeypatch, [t, t, None])
    rec = _deferred_rec()
    assert D.late_reservation(_args(tmp_path), rec) is False and len(calls) == 2
    assert rec["verdict"] == f"late-claim-refused:{t}"


def test_both_stage5_sites_go_through_late_reservation():
    """The main path and the revision path each open a PR; neither may skip the gate."""
    for fn in (D.run, D.run_revision):
        src = inspect.getsource(fn)
        assert src.count("stage5_pr(") == 1
        assert src.index("late_reservation(args, rec)") < src.index("stage5_pr(")


# ---------------------------------------------------------------- revision path
def _late_trace(tmp_path, **over):
    stages = {"worktree": {"path": str(tmp_path / "wt"), "ok": True},
              "claim_reservation": dict(D.LATE_CLAIM_DEFERRED)}
    return _trace(tmp_path, stages=stages, **over)


def test_resume_of_a_deferred_trace_reserves_late(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    calls = _reserve_seq(monkeypatch, [None])
    got = _resume(_rev_args(tmp_path, _late_trace(tmp_path), intention="witness"))
    assert got["verdict"] == "pr-created" and seen["loop"] == 1 and seen["pr"] == 1
    assert calls == ["Series/New-08.ipynb"]
    assert got["stages"]["claim_reservation"]["deferred"] == D.LATE_CLAIM_TAKEN


def test_resume_of_a_deferred_trace_livechecks_before_spending(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch, claim_rc=1)
    calls = _reserve_seq(monkeypatch, [])
    got = _resume(_rev_args(tmp_path, _late_trace(tmp_path), intention="witness"))
    assert got["verdict"] == f"refused-revise-no-reservation:{HELD}"
    assert seen["loop"] == 0 and seen["pr"] == 0 and calls == []


def test_resume_late_refusal_opens_no_pr(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    _reserve_seq(monkeypatch, [HELD])
    got = _resume(_rev_args(tmp_path, _late_trace(tmp_path), intention="witness"))
    assert got["verdict"] == f"late-claim-refused:{HELD}"
    assert seen["loop"] == 1 and seen["pr"] == 0


def test_resume_of_a_taken_late_claim_is_attested(monkeypatch, tmp_path):
    """A trace whose late claim WAS taken (stage 5 then failed) holds a reservation:
    the resume neither re-checks live nor re-posts."""
    seen = _stub_resume(monkeypatch)
    calls = _reserve_seq(monkeypatch, [])
    stages = {"worktree": {"path": str(tmp_path / "wt"), "ok": True},
              "claim_reservation": {**D.LATE_CLAIM_DEFERRED,
                                    "deferred": D.LATE_CLAIM_TAKEN}}
    got = _resume(_rev_args(tmp_path, _trace(tmp_path, stages=stages),
                            intention="witness"))
    assert got["verdict"] == "pr-created" and seen["pr"] == 1 and calls == []


# ---------------------------------------------------------------- CLI
@pytest.mark.parametrize("argv, msg", [
    (["--claim-late", "--max-stage", "5"], "pass both"),
    (["--claim", "--claim-late", "--max-stage", "4"], "before stage 5"),
])
def test_cli_refuses_an_incoherent_claim_late(monkeypatch, capsys, argv, msg):
    monkeypatch.setattr(sys, "argv", ["nb_coder_driver.py", "--repo", "D:/repo",
                                      "--issue", "1", "--notebook", "A/B.ipynb",
                                      "--lane", "lane:a", *argv])
    with pytest.raises(SystemExit) as exc:
        D.main()
    assert exc.value.code == 2 and msg in capsys.readouterr().err


# ---------------------------------------------------------------- scheduler
def _sched(tmp_path, items, **over):
    tmp_path.mkdir(parents=True, exist_ok=True)
    q = tmp_path / "queue.jsonl"
    q.write_text("\n".join(__import__("json").dumps(x) for x in items) + "\n",
                 encoding="utf-8")
    args = S.parse_args(["--queue", str(q), "--state-dir", str(tmp_path / "state"),
                         "--repo", "D:/CoursIA", "--max-active", "2"])
    for k, v in over.items():
        setattr(args, k, v)
    sched = S.Scheduler(args, spawn=None, gate=lambda: {"verdict": "green"},
                        sleep=lambda s=0: None, clock=lambda: 1000.0)
    sched.merge_queue(*S.load_queue(q))
    return sched


def test_scheduler_forwards_claim_late(tmp_path):
    sched = _sched(tmp_path, [
        {"issue": 1, "notebook": "A/B.ipynb", "max_stage": 5, "claim": True,
         "claim_late": True},
        {"issue": 2, "notebook": "A/C.ipynb", "max_stage": 5, "claim": True}],
        lane="lane:a")
    one = sched.driver_command(sched.items_by_key["#1:A/B.ipynb"])
    two = sched.driver_command(sched.items_by_key["#2:A/C.ipynb"])
    assert "--claim" in one and "--claim-late" in one
    assert "--claim" in two and "--claim-late" not in two
    # the scheduler-wide default applies when the line says nothing
    sched_default = _sched(tmp_path / "d", [
        {"issue": 2, "notebook": "A/C.ipynb", "max_stage": 5}],
        lane="lane:a", claim=True, claim_late=True)
    assert "--claim-late" in sched_default.driver_command(
        sched_default.items_by_key["#2:A/C.ipynb"])


def test_scheduler_never_forwards_claim_late_without_claim(tmp_path):
    sched = _sched(tmp_path, [{"issue": 1, "notebook": "A/B.ipynb", "max_stage": 5,
                               "claim_late": True}])
    assert "--claim-late" not in sched.driver_command(sched.items_by_key["#1:A/B.ipynb"])


@pytest.mark.parametrize("line, match", [
    ({"claim": False, "claim_late": True}, "contradicts"),
    ({"claim": True, "claim_late": True, "max_stage": 4}, "max_stage must be 5"),
])
def test_queue_refuses_an_incoherent_claim_late(tmp_path, line, match):
    q = tmp_path / "q.jsonl"
    q.write_text(__import__("json").dumps({"issue": 1, "notebook": "A/B.ipynb", **line})
                 + "\n", encoding="utf-8")
    with pytest.raises(S.QueueError, match=match):
        S.load_queue(q)


def test_scheduler_cli_refuses_claim_late_without_claim_or_stage5(tmp_path):
    base = ["--queue", str(tmp_path / "q.jsonl"), "--state-dir", str(tmp_path / "s"),
            "--repo", "D:/CoursIA", "--lane", "lane:a", "--max-active", "2"]
    with pytest.raises(SystemExit):
        S.parse_args(base + ["--claim-late", "--max-stage", "5"])
    with pytest.raises(SystemExit):
        S.parse_args(base + ["--claim", "--claim-late", "--max-stage", "4"])
    ok = S.parse_args(base + ["--claim", "--claim-late", "--max-stage", "5"])
    assert ok.claim_late is True


def test_late_refusal_is_a_served_run_not_a_ramp_blocker():
    assert S.failure_class(f"late-claim-refused:{HELD}") == "content"
    assert S.failure_class(f"late-claim-refused:{D.CLAIM_TIMEOUT_VERDICT}:check") \
        == "content"
