# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_toolless_gatewait.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Pins for three grain-killers measured on the 20-21/11 conveyor.

1. Repair, revision and format tours run WITHOUT tools. MGS-29 (#27133): the revision
   tour walked read_cells / glob_search / list_kernels / manage_kernel on the agent's own
   cwd, first attempt empty after 10 293 completion tokens, retry killed at 1 530 s. The
   schemas alone cost 32 167 prompt tokens for a 1-line prompt, 707 without.
2. A mid-grain capacity-gate refusal is waited out IN PLACE (same call repeated), not
   turned into a whole-grain deferral. MGS-28: three deferrals after 413-2 977 s of build.
3. A claim guard that outlives its budget is a deferral, not `crashed:TimeoutExpired`.

Skipped when `mcp` is not importable (the driver imports the MCP client at load).
"""
import asyncio
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("mcp")

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import nb_coder_driver as d  # noqa: E402

_spec = importlib.util.spec_from_file_location("nb_coder_scheduler_tg",
                                               HERE / "nb_coder_scheduler.py")
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)

REFUSAL = {"error": "capacity gate refused dispatch to model 'qwen3.6-35b-a3b-nbcoder' "
                    "(verdict yellow); retry after 3600s",
           "status": "paused"}


# ---------------------------------------------------------------- 1. tool-less tours
@pytest.mark.parametrize("stage", ["1-plan", "2-build", "2-build+0", "2-build+3+h1", "spec"])
def test_plan_build_and_spec_tours_keep_their_tools(stage):
    assert d.stage_uses_tools(stage) is True


@pytest.mark.parametrize("stage", [
    "1-plan-repair", "2-build+2+repair", "2.6-mdrepair", "2.5-repair+1",
    "1-plan-format", "2-build+1-format", "2-build-format",
    "6-revise+1", "6-revise+2-format", "6-revise+1-repair+2",
])
def test_repair_revision_and_format_tours_are_toolless(stage):
    assert d.stage_uses_tools(stage) is False


def test_a_toolless_spec_strips_every_mcp_and_the_github_tools():
    spec = d.agent_spec_for("notebook-coder", "m", 4096, 0.4, tools=False)
    assert spec["mcps"] == {"replace": []}
    assert spec["parameters"] == {"github_tools": False}
    assert spec["extends"] == "notebook-coder" and spec["model"] == "m"


def test_a_tool_spec_declares_no_mcp_override():
    spec = d.agent_spec_for("notebook-coder", None, 4096, 0.4)
    assert "mcps" not in spec and "parameters" not in spec and "model" not in spec


class FakeSession:
    def __init__(self):
        self.payloads = []

    async def call_tool(self, name, payload, read_timeout_seconds=None):
        self.payloads.append(payload)
        return SimpleNamespace(content=[SimpleNamespace(text=json.dumps({"response": "ok"}))])


def _args():
    return SimpleNamespace(agent="notebook-coder", timeout=60, max_tokens=4096,
                           coder_model=None)


@pytest.mark.parametrize("stage, stripped", [("6-revise+1", True), ("2-build", False)])
def test_the_wire_payload_follows_the_stage(monkeypatch, stage, stripped):
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    sess = FakeSession()
    rec = {"calls": []}
    env = asyncio.run(d.sk_call_retry(sess, _args(), rec, stage, "p", "conv-1"))
    assert env["response"] == "ok"
    spec = json.loads(sess.payloads[0]["agent_spec"])
    assert ("mcps" in spec) is stripped
    assert sess.payloads[0]["conversation_id"] == "conv-1"
    assert rec["calls"][0]["tools"] is (not stripped)
    # the turn itself says it has no tool; a tool tour's prompt is untouched
    assert sess.payloads[0]["prompt"] == ("p" + d.TOOLLESS_NOTE if stripped else "p")


# ---------------------------------------------------------------- 2. gate wait in place
def _scripted_sk(envs, seen):
    async def fake_sk(session, args, prompt, conv, max_tokens=None, model=None, **kw):
        seen.append({"prompt": prompt, "conv": conv, **kw})
        return dict(envs.pop(0)), 1.0
    return fake_sk


def test_a_refused_turn_is_repeated_in_place_until_the_gate_opens(monkeypatch):
    seen, sleeps = [], []
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    monkeypatch.setattr(d, "sk_call", _scripted_sk([REFUSAL, REFUSAL, {"response": "done"}],
                                                   seen))

    async def fake_sleep(s):
        sleeps.append(s)
    monkeypatch.setattr(d, "_gate_sleep", fake_sleep)
    rec = {"calls": []}
    env = asyncio.run(d.sk_call_retry(None, None, rec, "2-build+1", "P", "conv-9"))
    assert env == {"response": "done"}
    assert sleeps == [d.GATE_WAIT_POLL_S] * 2
    # the SAME call each time: same prompt (no retry note), same conversation
    assert [s["prompt"] for s in seen] == ["P"] * 3
    assert {s["conv"] for s in seen} == {"conv-9"}
    assert [c.get("gate_waited_s", 0) for c in rec["calls"]] == [0, 60, 120]
    assert [c["stage"] for c in rec["calls"]] == ["2-build+1"] * 3
    assert not d.gate_refusal(env)


def test_a_refusal_that_outlasts_the_budget_still_defers_the_grain(monkeypatch):
    n = d.GATE_WAIT_MAX_S // d.GATE_WAIT_POLL_S + 1
    seen, sleeps = [], []
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    monkeypatch.setattr(d, "sk_call", _scripted_sk([REFUSAL] * (n + 5), seen))

    async def fake_sleep(s):
        sleeps.append(s)
    monkeypatch.setattr(d, "_gate_sleep", fake_sleep)
    rec = {"calls": []}
    env = asyncio.run(d.sk_call_retry(None, None, rec, "2-build", "P", None))
    assert len(seen) == n and sum(sleeps) == d.GATE_WAIT_MAX_S
    assert d.gate_refusal(env).startswith("deferred-by-capacity-gate")


def test_an_empty_answer_still_gets_its_one_retry_after_a_gate_wait(monkeypatch):
    seen = []
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    monkeypatch.setattr(d, "sk_call", _scripted_sk(
        [REFUSAL, {"error": "empty model response"}, REFUSAL, {"response": "ok"}], seen))

    async def fake_sleep(s):
        return None
    monkeypatch.setattr(d, "_gate_sleep", fake_sleep)
    rec = {"calls": []}
    env = asyncio.run(d.sk_call_retry(None, None, rec, "1-plan", "P", None))
    assert env == {"response": "ok"}
    assert [s["prompt"] for s in seen] == ["P", "P", "P" + d.RETRY_NOTE, "P" + d.RETRY_NOTE]
    assert [c["stage"] for c in rec["calls"]] == ["1-plan", "1-plan",
                                                  "1-plan-retry", "1-plan-retry"]


def test_a_second_empty_answer_is_returned_not_retried_forever(monkeypatch):
    seen = []
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    monkeypatch.setattr(d, "sk_call", _scripted_sk(
        [{"error": "empty model response"}] * 3, seen))
    rec = {"calls": []}
    env = asyncio.run(d.sk_call_retry(None, None, rec, "1-plan", "P", None))
    assert env["error"] == "empty model response" and len(seen) == 2


# ------------------------------------------------- 2b. mid-turn pause resumed by continue
# 22/11, App-12 (#28069): sk-agent paused the build turn at round 3 (`capacity_gate`) and
# its banner was parsed as the answer -> stage1-unparsed after 545 s.
def _paused(reason="capacity_gate", conv="conv-p", rnd=3):
    return {"status": "paused", "paused": True, "resumable": True, "round_index": rnd,
            "conversation_id": conv, "pause": {"reason": reason, "round_index": rnd},
            "response": f"[paused: {reason}] resume with options.continue on "
                        f"conversation_id '{conv}'"}


REFUSED_CONTINUE = {**REFUSAL, "resumable": True, "conversation_id": "conv-p"}


def _sleeps(monkeypatch):
    sleeps = []

    async def fake_sleep(s):
        sleeps.append(s)
    monkeypatch.setattr(d, "_gate_sleep", fake_sleep)
    return sleeps


def test_a_mid_turn_pause_is_continued_not_parsed(monkeypatch):
    seen = []
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    monkeypatch.setattr(d, "sk_call", _scripted_sk([_paused(), {"response": "done"}], seen))
    sleeps = _sleeps(monkeypatch)
    rec = {"calls": []}
    env = asyncio.run(d.sk_call_retry(None, None, rec, "1-plan", "P", None))
    assert env == {"response": "done"}
    # first call is the fresh turn, the second resumes the SAME conversation
    assert [s.get("resume", False) for s in seen] == [False, True]
    assert seen[1]["conv"] == "conv-p"
    assert sleeps == [d.GATE_WAIT_POLL_S]
    assert [c["stage"] for c in rec["calls"]] == ["1-plan", "1-plan-continue"]
    assert rec["calls"][0]["paused"] == "capacity_gate"
    assert rec["calls"][0]["round_index"] == 3


def test_a_refused_continue_is_repeated_as_a_continue(monkeypatch):
    seen = []
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    monkeypatch.setattr(d, "sk_call", _scripted_sk(
        [_paused(), REFUSED_CONTINUE, REFUSED_CONTINUE, {"response": "done"}], seen))
    sleeps = _sleeps(monkeypatch)
    rec = {"calls": []}
    env = asyncio.run(d.sk_call_retry(None, None, rec, "2-build", "P", "conv-p"))
    assert env == {"response": "done"}
    assert [s.get("resume", False) for s in seen] == [False, True, True, True]
    assert {s["conv"] for s in seen} == {"conv-p"}
    assert sum(sleeps) == 3 * d.GATE_WAIT_POLL_S


def test_a_round_budget_pause_continues_without_waiting(monkeypatch):
    seen = []
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    monkeypatch.setattr(d, "sk_call", _scripted_sk(
        [_paused("round_budget"), {"response": "done"}], seen))
    sleeps = _sleeps(monkeypatch)
    env = asyncio.run(d.sk_call_retry(None, None, {"calls": []}, "2-build", "P", None))
    assert env == {"response": "done"} and sleeps == []
    assert seen[1].get("resume") is True


def test_a_pause_that_outlasts_the_budget_defers_never_parses(monkeypatch):
    n = d.GATE_WAIT_MAX_S // d.GATE_WAIT_POLL_S + 2
    seen = []
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    monkeypatch.setattr(d, "sk_call", _scripted_sk([_paused()] * (n + 20), seen))
    _sleeps(monkeypatch)
    env = asyncio.run(d.sk_call_retry(None, None, {"calls": []}, "1-plan", "P", None))
    assert env["response"] == ""
    assert d.gate_refusal(env).startswith("deferred-by-capacity-gate")
    assert len(seen) == d.MAX_CONTINUES + 1


def test_round_budget_continues_are_bounded(monkeypatch):
    seen = []
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    monkeypatch.setattr(d, "sk_call", _scripted_sk([_paused("round_budget")] * 30, seen))
    _sleeps(monkeypatch)
    env = asyncio.run(d.sk_call_retry(None, None, {"calls": []}, "1-plan", "P", None))
    assert len(seen) == d.MAX_CONTINUES + 1
    assert env["response"] == "" and "round_budget" in env["error"]
    assert not d.gate_refusal(env)


def test_the_continue_payload_is_options_continue_with_no_prompt():
    sess = FakeSession()
    env, _ = asyncio.run(d.sk_call(sess, _args(), "P", "conv-p", resume=True))
    p = sess.payloads[0]
    assert json.loads(p["options"]) == {"continue": True}
    assert p["prompt"] == "" and p["conversation_id"] == "conv-p"
    env, _ = asyncio.run(d.sk_call(sess, _args(), "P", "conv-p"))
    assert "options" not in sess.payloads[1] and sess.payloads[1]["prompt"] == "P"


def test_an_error_envelope_is_never_a_resumable_pause():
    assert d.resumable_pause(REFUSED_CONTINUE) == ""
    assert d.resumable_pause({"response": "x"}) == ""
    assert d.resumable_pause(_paused("round_budget")) == "round_budget"


# ---------------------------------------------------------------- 3. claim guard timeout
@pytest.fixture
def guard_repo(tmp_path):
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "check_lane_claim.py").write_text("", encoding="utf-8")
    return tmp_path


def _timeout(*a, **k):
    raise subprocess.TimeoutExpired(cmd=a[0] if a else "guard", timeout=k.get("timeout"))


def test_a_check_that_times_out_is_deferred_not_crashed(monkeypatch, guard_repo):
    monkeypatch.setattr(d.subprocess, "run", _timeout)
    cc = d.check_claim(guard_repo, 27133, "lane", "Dir/N.ipynb")
    assert cc["timed_out"] and cc["rc"] is None
    assert d.claim_verdict(cc) == "deferred-by-claim-timeout:check"


def test_the_guard_budget_is_the_new_one(monkeypatch, guard_repo):
    seen = {}

    def fake_run(argv, **k):
        seen.update(k)
        return SimpleNamespace(returncode=0, stdout="CLEAR", stderr="")
    monkeypatch.setattr(d.subprocess, "run", fake_run)
    assert d.claim_verdict(d.check_claim(guard_repo, 1, "lane", "N.ipynb")) is None
    assert seen["timeout"] == d.CLAIM_GUARD_TIMEOUT_S == 600


def test_the_guard_budget_outlives_the_guard_own_budget():
    """24/11 (CoursIA#28017, 192 open PRs): the guard bounds its complete open-PR
    enumeration itself (300 s, `CHECK_LANE_CLAIM_GH_TIMEOUT_TOTAL`) and answers a
    fail-closed UNKNOWN past it. At parity the harness killed every slow call first
    (two attempts at 300 s) while the same check took 181 s standalone and under 250 s
    on the third attempt. The budget must stay strictly above the guard's, so that a slow
    GitHub yields the guard's own verdict instead of a kill."""
    assert d.CLAIM_GUARD_TIMEOUT_S > 300
    assert d.CLAIM_LOCK_WAIT_S == 3 * d.CLAIM_GUARD_TIMEOUT_S + 120


def test_a_post_that_times_out_is_deferred(monkeypatch, guard_repo):
    monkeypatch.setattr(d.subprocess, "run", _timeout)
    post = d.post_claim(guard_repo, 1, "lane", "intent", "N.ipynb")
    assert post["timed_out"] and post["rc"] is None
    assert d.claim_reservation_verdict(post, {"skipped": "x"}) == "deferred-by-claim-timeout:post"


def test_a_verify_that_times_out_is_deferred():
    v = d.claim_reservation_verdict({"rc": 0}, {"rc": None, "timed_out": True})
    assert v == "deferred-by-claim-timeout:verify"


def test_a_real_post_failure_keeps_its_refusal():
    assert d.claim_reservation_verdict({"rc": 1}, {"rc": 0}) == "refused-claim-post-failed"
    assert d.claim_reservation_verdict({"rc": 0}, {"rc": 1}) == "refused-claim-not-verified"


def test_a_reservation_whose_precheck_times_out_never_posts(monkeypatch, guard_repo):
    calls = []

    def fake_run(argv, **k):
        calls.append(argv)
        raise subprocess.TimeoutExpired(cmd=argv, timeout=k.get("timeout"))
    monkeypatch.setattr(d.subprocess, "run", fake_run)
    r = d.reserve_claim(guard_repo, 1, "lane", "intent", "N.ipynb")
    assert r["verdict"] == "deferred-by-claim-timeout:check" and r["posted"] is None
    assert len(calls) == 1 and "--claim" not in calls[0]


# ---------------------------------------------------------------- scheduler side
@pytest.mark.parametrize("verdict", ["deferred-by-claim-timeout:check",
                                     "deferred-by-claim-timeout:post",
                                     "deferred-by-capacity-gate: yellow"])
def test_the_scheduler_defers_both_kinds(tmp_path, verdict):
    queue = tmp_path / "queue.jsonl"
    queue.write_text(json.dumps({"issue": 1, "notebook": "Dir/N1.ipynb"}) + "\n",
                     encoding="utf-8")
    args = S.parse_args(["--queue", str(queue), "--state-dir", str(tmp_path / "state"),
                         "--repo", "D:/CoursIA", "--max-active", "1", "--keep-worktrees"])
    clock = {"t": 1000.0}
    sched = S.Scheduler(args, spawn=lambda cmd: S.FakeProc(verdict, 1, 0),
                        gate=lambda: {"verdict": "green", "running": 0, "waiting": 0,
                                      "preemptions": 0},
                        sleep=lambda s=0: None, clock=lambda: clock["t"])
    loaded, digest = S.load_queue(queue)
    sched.merge_queue(loaded, digest)
    sched.tick()
    clock["t"] += 10
    sched.tick()
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    assert g["status"] == "deferred" and g["not_before"] > clock["t"]
