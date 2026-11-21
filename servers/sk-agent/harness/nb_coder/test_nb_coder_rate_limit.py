#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ e94d5f4f3f036aa5f4b42060584f592b3e42e983
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_rate_limit.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Offline tests for deferring a grain killed by GitHub's rate limit — CoursIA#27134, 2026-11-21.

At 04:32Z the shared per-user REST bucket was at 0/5000. The re-offered 2.3c died at its
issue fetch 30 s after launch with `crashed:RuntimeError: issue fetch failed rc=1: {"message":
"API rate limit exceeded for user ID …"}`. The scheduler classed that as a run failure: the
grain's retry was spent and the ramp's promotion blocked, for a refusal that said nothing
about the grain. The driver now names it a deferral with the bucket's reset epoch, and the
scheduler waits until then."""

import importlib.util
import json
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
