#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_rate_limit.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Offline tests for deferring a grain killed by GitHub's rate limit — CoursIA#27134, 2026-11-21.

At 04:32Z the shared per-user REST bucket was at 0/5000. The re-offered 2.3c died at its
issue fetch 30 s after launch with `crashed:RuntimeError: issue fetch failed rc=1: {"message":
"API rate limit exceeded for user ID …"}`. The scheduler classed that as a run failure: the
grain's retry was spent and the ramp's promotion blocked, for a refusal that said nothing
about the grain. The driver now names it a deferral with the bucket's reset epoch, and the
scheduler waits until then.

The same contract for a MODEL provider's 429 (23/11, section at the end of this file)."""

import asyncio
import importlib.util
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


d = _load("nb_coder_driver")
S = _load("nb_coder_scheduler")

REAL = ('issue fetch failed rc=1: {\n\t"message": "API rate limit exceeded for user ID 3159389. '
        'If you reach out to GitHub Support for help, please include the request ID '
        'E7C5:21F36A:178589:2ABFAF:6B011EDD and timestamp 2026-11-21 04:32:29 UTC.')


# ---- driver ---------------------------------------------------------------------------
def test_the_real_refusal_is_recognised_and_ordinary_failures_are_not():
    assert d.github_rate_limited(REAL)
    assert d.github_rate_limited("You have exceeded a secondary rate limit. Please wait")
    assert not d.github_rate_limited('issue fetch failed rc=1: {"message": "Not Found"}')
    assert not d.github_rate_limited("")


def test_the_verdict_carries_the_reset_when_it_is_known():
    assert d.rate_limit_verdict(1795237229) == "deferred-by-github-rate-limit:reset=1795237229"
    assert d.rate_limit_verdict(None) == "deferred-by-github-rate-limit"


def test_the_reset_is_read_from_the_free_endpoint(monkeypatch):
    seen = []

    def fake_gh(args, token=None, timeout=60):
        seen.append(args)
        return 0, "1795237229"
    monkeypatch.setattr(d, "gh", fake_gh)
    assert d.github_core_reset() == 1795237229
    assert seen == [["api", "rate_limit", "--jq", ".resources.core.reset"]]
    monkeypatch.setattr(d, "gh", lambda *a, **k: (1, "gh: error"))
    assert d.github_core_reset() is None


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


def test_a_rate_limited_grain_waits_for_the_reset_and_is_not_failed(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, "deferred-by-github-rate-limit:reset=1500", clock)
    sched.tick()
    clock["t"] += 10
    sched.tick()
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    ramp = sched.state["ramp"]
    assert g["status"] == "deferred"
    assert g["not_before"] == 1010.0 + (1500 - 1010) + S.GITHUB_RESET_MARGIN_S
    assert ramp["failed"] == 0 and ramp.get("content_failed", 0) == 0
    clock["t"] = 1400.0
    assert sched.tick()["launched"] == 0          # the bucket is still dry
    clock["t"] = g["not_before"] + 1
    assert sched.tick()["launched"] == 1


def test_without_a_reset_the_ordinary_backoff_applies(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, "deferred-by-github-rate-limit", clock)
    sched.tick()
    clock["t"] += 10
    sched.tick()
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    assert g["status"] == "deferred"
    assert g["not_before"] == 1010.0 + sched.args.backoff_s


def test_an_absurd_reset_is_capped_and_a_past_one_is_not_negative():
    v = "deferred-by-github-rate-limit:reset="
    assert S.github_reset_wait(v + "999999999", 0.0) == S.GITHUB_RESET_MAX_S
    assert S.github_reset_wait(v + "10", 100.0) == S.GITHUB_RESET_MARGIN_S
    assert S.github_reset_wait(v + "oops", 0.0) is None
    assert S.github_reset_wait("deferred-by-capacity-gate", 0.0) is None


# ---- a MODEL provider's 429 (23/11) ---------------------------------------------------
# Verbatim: the `error` of call "2-build+32" in the 23/11 run record of CoursIA#28097
# (po-2028:claudish, batch s6r). With its three siblings (#28064, #28065, #28085) it was
# failed as a run failure on its first launch in that batch and [RELEASED] — a three-day
# fleet-wide lock. The same wall met inside a revision round: test_nb_coder_revise.py.
WALL = ('("<class \'semantic_kernel.connectors.ai.open_ai.services.open_ai_chat_completion.'
        'OpenAIChatCompletion\'> service failed to complete the prompt", RateLimitError('
        '"Error code: 429 - {\'error\': {\'message\': \'Usage limit reached for 5 hour. Your '
        'limit will reset at 2026-11-23 08:48:53\', \'type\': \'rate_limit_error\', '
        '\'code\': None}}"))')
# The transient wording: measured in this fleet's notebook outputs (code 1302), not yet in
# a harness verdict. Named by the same markers, without the wall marker.
TRANSIENT = ("Error code: 429 - {'error': {'code': '1302', "
             "'message': 'Rate limit reached for requests'}}")
# The same class as a 403, when what ran dry is a KEY's CREDIT rather than a usage window.
# Verbatim from the 27/11 run records (`driver.log` of batches o57b and o58b, po-2028:claudish):
# CoursIA#28880 at 15:26:11Z, then MGS-27 at 16:09:59Z — the request reached the seat proxy
# and a cascade leg answered 403. The key URL carries an identifier in the record: here it is
# replaced by an id of the same SHAPE (64 hex), and the mask test below proves the verdict
# never carries one.
KEY_LIMIT = ('("<class \'semantic_kernel.connectors.ai.open_ai.services.open_ai_chat_completion.'
             'OpenAIChatCompletion\'> service failed to complete the prompt", PermissionDeniedError("'
             'Error code: 403 - {\'error\': {\'message\': \'Key limit exceeded (total limit). '
             'Manage it using https://openrouter.ai/workspaces/default/keys/'
             + "0123456789abcdef" * 4 +
             ' $20.58 of $20.00 used; does not reset.\', \'type\': \'permission_error\', '
             '\'code\': None}}"))')


def test_a_key_credit_wall_defers_and_never_takes_the_wall_marker():
    """27/11: two launches were spent on `does not reset` for grains that had done nothing.
    A dead cascade leg is not a clock to wait on, so this takes the ordinary backoff."""
    v = d.provider_rate_refusal({"error": KEY_LIMIT})
    assert v.startswith("deferred-by-provider-rate-limit: ")
    assert ":wall" not in v and "Key limit exceeded" in v


def test_the_key_identifier_never_rides_the_verdict():
    """The message carries the provider's key URL; the verdict is copied into run records,
    dashboards and reports. The identifier is masked there."""
    v = d.provider_rate_refusal({"error": KEY_LIMIT})
    assert "keys/<masque>" in v
    assert not re.search(r"[0-9a-f]{16,}", v)


def test_the_real_wall_is_a_bare_deferral_marked_wall():
    v = d.provider_rate_refusal({"error": WALL})
    assert v.startswith("deferred-by-provider-rate-limit:wall: ")
    # the excerpt is centred on the cause: it names the announced reset and the type
    assert "reset at 2026-11-23 08:48:53" in v and "'type': 'rate_limit_error'" in v


def test_the_transient_wording_is_the_ordinary_deferral():
    v = d.provider_rate_refusal({"error": TRANSIENT})
    assert v.startswith("deferred-by-provider-rate-limit: ")
    assert ":wall" not in v.split(":")[1:] and "Rate limit reached for requests" in v


def test_nothing_else_is_deferred_by_it():
    gate = "capacity gate refused dispatch to model 'x' (verdict yellow); retry after 3600s"
    assert d.provider_rate_refusal({"error": gate}) == ""            # the gate's, not ours
    assert d.gate_refusal({"error": gate}).startswith("deferred-by-capacity-gate")
    assert d.provider_rate_refusal({"error": "401 invalid proxy authentication"}) == ""
    assert d.provider_rate_refusal(
        {"error": "claudish: unknown model nb-luna — not found in any provider catalog"}) == ""
    assert d.provider_rate_refusal({"error": "TimeoutError: read timed out"}) == ""
    # a 403 that names no key wall is not ours either: a wrong key is a wiring bug, not a
    # wall, and deferring it would hide the bug behind a plausible retry
    assert d.provider_rate_refusal(
        {"error": "Error code: 403 - {'error': {'message': 'Forbidden: this key may not "
                  "use this model', 'type': 'permission_error', 'code': None}}"}) == ""
    # GitHub's bucket is the OTHER rate limit: it keeps its own verdict and reset epoch
    assert d.provider_rate_refusal({"error": REAL}) == ""
    assert d.provider_rate_refusal({}) == ""
    assert d.provider_rate_refusal({"response": "an answer"}) == ""


def test_the_diagnostic_naming_of_the_cause_is_untouched():
    assert d.call_failure({"error": WALL}).startswith("call-failed: ")


def test_the_driver_verdict_is_one_the_scheduler_defers_on():
    """The contract between the two modules: the scheduler matches its prefixes from the
    FIRST character, so the verdict must be bare — `stage2-` + deferral still failed."""
    assert S.PROVIDER_RATE_LIMIT_VERDICT == d.PROVIDER_RATE_LIMIT_VERDICT
    assert S.PROVIDER_RATE_LIMIT_VERDICT in S.DEFERRED_VERDICT_PREFIXES
    for env in ({"error": WALL}, {"error": TRANSIENT}, {"error": KEY_LIMIT}):
        assert d.provider_rate_refusal(env).startswith(S.DEFERRED_VERDICT_PREFIXES)


def test_a_walled_build_defers_bare_with_one_call_spent(monkeypatch):
    plan_cells = [{"idx": i, "cell_type": "code", "titre": f"c{i}"} for i in range(8)]
    calls = []

    async def fake(session, args, rec, stage, prompt, conv, max_tokens=None):
        calls.append(stage)
        return {"response": "", "error": WALL, "conversation_id": "cx"}

    monkeypatch.setattr(d, "sk_call_retry", fake)
    rec: dict = {}
    assert asyncio.run(d.create_segments(None, None, rec, None, plan_cells, 8, "")) == {}
    assert calls == ["2-build+0"]                 # neither bisected nor repaired into the wall
    assert rec["verdict"].startswith("deferred-by-provider-rate-limit:wall: ")
    assert "bisected" not in rec


def test_a_walled_format_repair_hands_the_refusal_back(monkeypatch):
    """The build answered, its JSON did not decode, and the repair call met the wall. The
    caller must see the REFUSAL: handed the original error-less answer, it would name the
    grain `unparsed` and fail it."""

    async def fake(session, args, rec, stage, prompt, conv, max_tokens=None):
        return {"response": "", "error": WALL, "conversation_id": "cx"}

    monkeypatch.setattr(d, "sk_call_retry", fake)
    env = {"response": "```json\nceci n'est pas du JSON\n```", "conversation_id": "cx"}
    obj, out = asyncio.run(d.parse_or_repair(None, None, {}, "2-build+0", env, "cx"))
    assert obj is None and out is not env
    assert d.provider_rate_refusal(out).startswith("deferred-by-provider-rate-limit:wall: ")


def _journal(sched, kind):
    path = sched.journal_path
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    return [r for r in rows if r["kind"] == kind]


def test_a_walled_grain_is_probed_hourly_and_never_released(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, "deferred-by-provider-rate-limit:wall: " + WALL[:120], clock)
    released = []
    sched._release_claim = lambda *a, **k: released.append(a)
    sched.tick()
    clock["t"] += 10
    sched.tick()
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    ramp = sched.state["ramp"]
    assert g["status"] == "deferred" and g["attempts"] == 1
    assert g["not_before"] == 1010.0 + S.PROVIDER_WALL_WAIT_S
    assert ramp["failed"] == 0 and ramp.get("content_failed", 0) == 0
    assert ramp["deferred"] == 1
    clock["t"] = g["not_before"] - 1
    assert sched.tick()["launched"] == 0          # the wall is still met
    clock["t"] = g["not_before"] + 1
    assert sched.tick()["launched"] == 1          # probed an hour later, not waited out
    assert released == [] and not _journal(sched, "claim-released")
    assert not _journal(sched, "failed")


def test_without_the_wall_marker_the_ordinary_backoff_applies(tmp_path):
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, "deferred-by-provider-rate-limit: " + TRANSIENT, clock)
    sched.tick()
    clock["t"] += 10
    sched.tick()
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    assert g["status"] == "deferred"
    assert g["not_before"] == 1010.0 + sched.args.backoff_s


def test_an_exhausted_wall_ends_terminal_on_the_path_that_never_releases(tmp_path):
    """A wall that outlasts the launches ends `attempts-exhausted`, never `failed`: the
    claim is kept and no [RELEASED] is posted."""
    clock = {"t": 1000.0}
    sched = _sched(tmp_path, "deferred-by-provider-rate-limit:wall: " + WALL[:120], clock)
    sched.args.max_attempts = 2
    released = []
    sched._release_claim = lambda *a, **k: released.append(a)
    sched.tick()                                  # launch 1
    clock["t"] += 10
    sched.tick()                                  # deferred once
    for _ in range(3):
        g = sched.state["grains"]["#1:Dir/N1.ipynb"]
        clock["t"] = max(clock["t"], (g.get("not_before") or 0)) + 1
        sched.tick()                              # relaunch when due, then the next reap
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


def test_every_deferral_is_named_bare():
    """The invariant the two modules share: a deferral is recognised by its first
    characters, so no caller may assemble one behind a stage prefix."""
    for prefix in S.DEFERRED_VERDICT_PREFIXES:
        assert prefix.startswith("deferred-by-"), prefix


def test_the_wall_marker_is_a_whole_part_never_a_substring():
    w = S.provider_wall_wait
    assert w("deferred-by-provider-rate-limit:wall: x") == S.PROVIDER_WALL_WAIT_S
    assert w("deferred-by-provider-rate-limit: firewall: x") is None
    assert w("deferred-by-provider-rate-limit: x") is None
    assert w("deferred-by-github-rate-limit:reset=5: wall") is None
    assert w("deferred-by-capacity-gate") is None
