#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Claim-reservation tests born in this repo (ms#1812/#1813) on top of the harness
# copied verbatim from jsboige/vllm @ 231c9ad8e9281ee162fc641a11889fc5600f4827
# (original path: myia_vllm/scripts/adoption/nb_coder/). These tests have no vllm
# counterpart yet -- upstream them at the next sync, do not diverge silently.
# -----------------------------------------------------------------------------
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Imported from jsboige/vllm @ 40ce1b93f15d44848d91cdae4f9e7dd04f126076
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_claim.py
# Canonical home is sk-agent: new harness fixes belong here, not in vllm.
# -----------------------------------------------------------------------------
"""Regression pins for the #466 fixes: scoped claim check + kernel working_dir.

Two measured defects (jsboige/vllm#466, cycle 17/11 00:4xZ):
- `check_claim()` called check_lane_claim.py WITHOUT `--paths`, so the guard answered
  NOT_SCOPED (rc=2) whenever any PR touched the issue but none named this notebook —
  and the driver let rc=2 pass where a scoped check says BLOCKED. Measured on
  CoursIA#27018 vs PR #27025 (po-2023, 21:29Z): scoped = rc=1, unscoped = rc=2.
- The execution kernel started with no `working_dir`, inheriting the MCP server's cwd
  (the out-dir); CoursIA#27021 lost 5 cells on `import ict` — the ICT package sits
  next to the SOURCE notebook in the worktree.

Skipped when `mcp` is not importable (the driver imports the MCP client at load).
"""
import asyncio
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as nbcd  # noqa: E402


def test_check_claim_scopes_to_the_notebook(monkeypatch, tmp_path):
    """The guard must receive --paths <notebook>: unscoped, rc=2 masquerades as clear."""
    seen = {}

    def fake_run(argv, **kw):
        seen["argv"] = argv
        class P:
            returncode = 0
            stdout = "CLEAR"
            stderr = ""
        return P()

    monkeypatch.setattr(nbcd.subprocess, "run", fake_run)
    guard = tmp_path / "scripts" / "check_lane_claim.py"
    guard.parent.mkdir(exist_ok=True)
    guard.write_text("# stub", encoding="utf-8")
    out = nbcd.check_claim(tmp_path, 27018, "myia-ai-01:vllm", "19451-ICT/ICT-18b/nb.ipynb")
    assert seen["argv"][seen["argv"].index("--paths") + 1] == "19451-ICT/ICT-18b/nb.ipynb"
    assert out["rc"] == 0 and out["ok"] is True


def test_claim_verdict_is_fail_closed():
    v = nbcd.claim_verdict
    assert v({"rc": 1}) == "refused-claim-held-by-another-lane"
    # rc=2 passed through before #466 — now it refuses
    assert v({"rc": 2}) == "refused-claim-check-not-scoped"
    # absent guard used to KeyError mid-run; now a crash-free refusal
    assert v({"ok": None, "error": "check_lane_claim.py absent"}) == "refused-claim-check-broken"
    assert v({"rc": 0}) is None


def test_start_kernel_sends_working_dir(monkeypatch, tmp_path):
    """#27021: the kernel cwd must be the source notebook's directory, not the out-dir."""
    captured = {}

    async def fake_pm_call(pm, tool, payload):
        captured["tool"] = tool
        captured["payload"] = payload
        return {"kernel_id": "k-466"}

    monkeypatch.setattr(nbcd, "pm_call", fake_pm_call)
    kid = asyncio.run(nbcd.start_kernel(None, "python3", tmp_path))
    assert kid == "k-466"
    assert captured["tool"] == "manage_kernel"
    assert captured["payload"]["working_dir"] == str(tmp_path)


# ---- reservation gate (#4781 follow-up): admission before any spend ------------
# The two-client witness below models the AUTHORITATIVE guard's documented
# check-then-post semantics over a Manager-shared state. It pins the DRIVER's
# admission contract: AT MOST one start under contention -- exactly one when the
# post leg serializes, ZERO (plus two leaked claim comments) when both posts
# interleave and succeed, zero on a failed post. It is NOT a proof of atomicity
# on GitHub and claims none -- see reserve_claim's docstring.

def _post_claim_argv_seen(monkeypatch, tmp_path, rc, out):
    from types import SimpleNamespace
    seen = {}

    def fake_run(argv, **kw):
        seen["argv"] = argv
        return SimpleNamespace(returncode=rc, stdout=out, stderr="")

    monkeypatch.setattr(nbcd.subprocess, "run", fake_run)
    guard = tmp_path / "scripts" / "check_lane_claim.py"
    guard.parent.mkdir(exist_ok=True)
    guard.write_text("# stub", encoding="utf-8")
    return seen


def test_post_claim_scopes_the_write_to_the_notebook(monkeypatch, tmp_path):
    """The WRITE must carry --paths too: an unscoped marker is a claim on nothing."""
    seen = _post_claim_argv_seen(monkeypatch, tmp_path, 0, "posted")
    out = nbcd.post_claim(tmp_path, 27018, "lane:a", "witness",
                          "19451-ICT/ICT-18b/nb.ipynb")
    argv = seen["argv"]
    assert argv[argv.index("--paths") + 1] == "19451-ICT/ICT-18b/nb.ipynb"
    assert argv[argv.index("--claim") + 1] == "witness"
    assert out["rc"] == 0


def test_reserve_refuses_when_the_guard_refuses_to_post(monkeypatch, tmp_path):
    """rc!=0 from the post leg refuses BEFORE a second read -- nothing was acquired."""
    _post_claim_argv_seen(monkeypatch, tmp_path, 1, "BLOCKED")
    checks = {"n": 0}

    def counting_check(*a):
        checks["n"] += 1
        return {"rc": 0, "ok": True}

    monkeypatch.setattr(nbcd, "check_claim", counting_check)
    res = nbcd.reserve_claim(tmp_path, 42, "lane:a", "witness", "N.ipynb")
    assert res["verdict"] == "refused-claim-post-failed"
    assert checks["n"] == 1, "a refused post must not pay a verify read"


def test_reserve_refuses_when_the_post_write_recheck_cannot_confirm(monkeypatch, tmp_path):
    """The race window: post says 0 but the fresh re-read sees another lane's claim."""
    _post_claim_argv_seen(monkeypatch, tmp_path, 0, "posted")
    reads = iter([{"rc": 0, "ok": True},   # pre-check: clear
                  {"rc": 1, "ok": False}])  # re-read: someone else landed first

    monkeypatch.setattr(nbcd, "check_claim", lambda *a: next(reads))
    res = nbcd.reserve_claim(tmp_path, 42, "lane:a", "witness", "N.ipynb")
    assert res["verdict"] == "refused-claim-not-verified"


def test_reserve_admits_exactly_the_clear_post_verified_path(monkeypatch, tmp_path):
    _post_claim_argv_seen(monkeypatch, tmp_path, 0, "posted")
    monkeypatch.setattr(nbcd, "check_claim", lambda *a: {"rc": 0, "ok": True})
    res = nbcd.reserve_claim(tmp_path, 42, "lane:a", "witness", "N.ipynb")
    assert res["verdict"] is None
    assert res["posted"]["rc"] == 0 and res["verified"]["rc"] == 0


def _witness_child(idx, lane, nb, ready, gate, owner, comments, lock, queue,
                   fail_post, interleave=False, posted=None, verify_gate=None):
    """One admission client. The pre-check signals `ready`, then WAITS on `gate`:
    the adversary's claim can land in the window AFTER this client's pre-check --
    exactly the race the re-read must catch. Never two bare CLEAR pre-checks.

    ``interleave`` models the REAL guard's non-atomic post: both clients' posts
    succeed (each lands its own comment), and BOTH re-reads only start once the
    two posts are in -- the worst case the serialized leg cannot show.
    """
    checks = {"n": 0}

    def fake_check(repo, n, l, nb_arg):
        checks["n"] += 1
        first = checks["n"] == 1
        with lock:
            held = owner.get(nb_arg)
        if first:
            ready.set()
            gate.wait(30)
            if held and held != l:
                return {"rc": 1, "ok": False, "out": "held by another lane"}
            return {"rc": 0, "ok": True, "out": "CLEAR"}
        if interleave:
            verify_gate.wait(30)
            with lock:
                foreign = any(l2 != l for _, l2, n2 in list(comments)
                              if n2 == nb_arg)
            if foreign:
                return {"rc": 1, "ok": False, "out": "another lane's marker"}
            return {"rc": 0, "ok": True, "out": "CLEAR"}
        if held and held != l:
            return {"rc": 1, "ok": False, "out": "held by another lane"}
        return {"rc": 0, "ok": True, "out": "CLEAR"}

    def fake_post(repo, n, l, intention, nb_arg):
        with lock:
            if fail_post:
                return {"rc": 2, "out": "post failed"}
            if interleave:
                # No check-and-write serialization: this post lands unconditionally,
                # exactly two sequential successful posts on the real guard.
                comments.append((idx, l, nb_arg))
                owner[nb_arg] = l
            else:
                held = owner.get(nb_arg)
                if held and held != l:
                    return {"rc": 1, "out": "BLOCKED at write time"}
                owner[nb_arg] = l
                comments.append((idx, l, nb_arg))
        if interleave:
            posted.set()
            verify_gate.wait(30)
        return {"rc": 0, "out": "posted"}

    nbcd.check_claim = fake_check
    nbcd.post_claim = fake_post
    r = nbcd.reserve_claim(Path("repo"), 42, lane, "witness", nb)
    queue.put({"idx": idx, "lane": lane, "nb": nb,
               "admitted": r["verdict"] is None, "verdict": r["verdict"]})


def _run_witness(lanes, notebooks, fail_post=(), interleave=False):
    import multiprocessing as mp
    ctx = mp.get_context("spawn")
    mgr = ctx.Manager()
    owner, comments, lock, queue = mgr.dict(), mgr.list(), mgr.Lock(), mgr.Queue()
    gate, verify_gate = mgr.Event(), mgr.Event()
    procs, readies, posteds = [], [], []
    for i, (lane, nb) in enumerate(zip(lanes, notebooks)):
        ready, posted = mgr.Event(), mgr.Event()
        readies.append(ready)
        posteds.append(posted)
        procs.append(ctx.Process(
            target=_witness_child,
            args=(i, lane, nb, ready, gate, owner, comments, lock, queue,
                  i in fail_post),
            kwargs={"interleave": interleave, "posted": posted,
                    "verify_gate": verify_gate},
            daemon=True))
        procs[-1].start()
    try:
        assert all(e.wait(60) for e in readies), "a child never reached its pre-check"
        gate.set()
        if interleave:
            assert all(e.wait(60) for e in posteds), "a child never posted"
            verify_gate.set()
        results = [queue.get(timeout=60) for _ in procs]
        for p in procs:
            p.join(30)
        return results, list(comments)
    finally:
        for p in procs:
            if p.is_alive():
                p.terminate()


def test_two_clients_same_notebook_serialized_post_admits_exactly_one():
    """Serialized post leg: both pre-checks ran CLEAR, the adversary claim landed in
    the window, and exactly ONE client starts; the loser refuses at the post leg,
    before any worktree or model spend."""
    results, comments = _run_witness(
        ["lane:a", "lane:b"], ["Series/N.ipynb", "Series/N.ipynb"])
    assert sorted(r["admitted"] for r in results) == [False, True]
    loser = next(r for r in results if not r["admitted"])
    assert loser["verdict"] == "refused-claim-post-failed"
    assert len(comments) == 1, "the losing client must not leave a comment behind"


def test_two_interleaved_posts_both_leak_claims_but_admit_zero():
    """The REAL guard's worst case (review ms#1812 finding 2): check-and-post is not
    serialized, so two clients can BOTH post a [CLAIMED] comment. Safety is then
    'at most one start, possibly zero' -- both re-reads see the other lane's marker
    and both refuse. The two leaked comments are the accepted cost, asserted here."""
    results, comments = _run_witness(
        ["lane:a", "lane:b"], ["Series/N.ipynb", "Series/N.ipynb"],
        interleave=True)
    assert not any(r["admitted"] for r in results)
    assert all(r["verdict"] == "refused-claim-not-verified" for r in results)
    assert len(comments) == 2, "both posts landed -- the leak the contract names"


def test_two_clients_disjoint_notebooks_both_admit():
    """Disjoint scopes are not contention: both clients start, two comments."""
    results, comments = _run_witness(
        ["lane:a", "lane:b"], ["Series/A.ipynb", "Series/B.ipynb"])
    assert all(r["admitted"] for r in results)
    assert len(comments) == 2


def test_a_failed_post_write_admits_no_one():
    """Acquisition failure = zero starts, zero comments -- not a degraded start."""
    results, comments = _run_witness(
        ["lane:a", "lane:b"], ["Series/N.ipynb", "Series/N.ipynb"],
        fail_post=(0, 1))
    assert not any(r["admitted"] for r in results)
    assert all(r["verdict"] == "refused-claim-post-failed" for r in results)
    assert comments == []


def test_post_success_with_no_observable_claim_pins_the_narrowed_contract(
        monkeypatch, tmp_path):
    """Review ms#1812 explicit limit: the re-read proves scope-level CLEAR, never
    marker ownership. A post returning 0 while the re-read observes ZERO claim
    comments is ADMITTED -- admission requires no FOREIGN marker, not the presence
    of our own. The real guard makes this state unreachable (it count-verifies its
    write before returning 0); this witness pins the driver-side boundary so a
    future divergence of that guard guarantee surfaces here, not silently."""
    _post_claim_argv_seen(monkeypatch, tmp_path, 0, "posted")
    monkeypatch.setattr(nbcd, "check_claim", lambda *a: {"rc": 0, "ok": True})
    monkeypatch.setattr(nbcd, "post_claim", lambda *a: {"rc": 0, "out": "posted"})
    res = nbcd.reserve_claim(tmp_path, 42, "lane:a", "witness", "N.ipynb")
    assert res["verdict"] is None
    assert res["posted"]["rc"] == 0 and res["verified"]["rc"] == 0


def test_run_gates_worktree_on_a_refused_reservation(monkeypatch, tmp_path):
    """A refused reservation must return BEFORE prepare_worktree: no worktree, no model."""
    from types import SimpleNamespace
    import asyncio
    import subprocess
    rec = {"stages": {}, "calls": []}
    args = SimpleNamespace(out_dir=str(tmp_path), repo="D:/repo", issue=27106,
                           notebook="Series\\N.ipynb", source_nb=None,
                           allow_foreign_origin=False, lane="lane:a", claim=True,
                           intention="witness", conventions="", max_stage=0,
                           worktree=str(tmp_path / "wt"), fresh_worktree=False)
    monkeypatch.setattr(nbcd, "app_token", lambda repo: "")
    monkeypatch.setattr(nbcd, "read_conventions", lambda p: "")
    monkeypatch.setattr(nbcd, "check_claim", lambda *a: {"rc": 0, "ok": True})
    monkeypatch.setattr(nbcd, "fetch_issue", lambda *a: {
        "title": "N", "state": "open", "labels": [], "body": ""})
    monkeypatch.setattr(nbcd, "reserve_claim", lambda *a: {
        "before": None, "posted": {"rc": 1}, "verified": None,
        "verdict": "refused-claim-post-failed"})
    monkeypatch.setattr(nbcd, "prepare_worktree", lambda *a: (_ for _ in ()).throw(
        AssertionError("a refused run must not prepare or mutate a worktree")))
    monkeypatch.setattr(nbcd.subprocess, "run", lambda *a, **kw:
                        SimpleNamespace(stdout="https://github.com/jsboige/CoursIA.git\n"))
    got = asyncio.run(nbcd.run(args, rec))
    assert got["verdict"] == "refused-claim-post-failed"


def test_run_passes_the_normalized_notebook_to_the_reservation(monkeypatch, tmp_path):
    """A Windows backslash CLI path must reach the claim scope POSIX-normalized,
    and an admitted reservation allows exactly one worktree preparation."""
    from types import SimpleNamespace
    import asyncio
    import subprocess
    seen = {}
    rec = {"stages": {}, "calls": []}
    args = SimpleNamespace(out_dir=str(tmp_path), repo="D:/repo", issue=27106,
                           notebook="Series\\N.ipynb", source_nb=None,
                           allow_foreign_origin=False, lane="lane:a", claim=True,
                           intention="witness", conventions="", max_stage=0,
                           worktree=str(tmp_path / "wt"), fresh_worktree=False)
    monkeypatch.setattr(nbcd, "app_token", lambda repo: "")
    monkeypatch.setattr(nbcd, "read_conventions", lambda p: "")
    monkeypatch.setattr(nbcd, "check_claim", lambda *a: {"rc": 0, "ok": True})
    monkeypatch.setattr(nbcd, "fetch_issue", lambda *a: {
        "title": "N", "state": "open", "labels": [], "body": ""})

    def fake_reserve(repo, n, lane, intention, nb):
        seen["notebook"] = nb
        return {"before": None, "posted": {"rc": 0}, "verified": {"rc": 0},
                "verdict": None}

    def fake_wt(repo, dest, fresh):
        seen["wt_calls"] = seen.get("wt_calls", 0) + 1
        return {"path": str(tmp_path / "wt"), "reused": False, "head": "deadbee"}

    monkeypatch.setattr(nbcd, "reserve_claim", fake_reserve)
    monkeypatch.setattr(nbcd, "prepare_worktree", fake_wt)
    monkeypatch.setattr(nbcd.subprocess, "run", lambda *a, **kw:
                        SimpleNamespace(stdout="https://github.com/jsboige/CoursIA.git\n"))
    got = asyncio.run(nbcd.run(args, rec))
    assert seen["notebook"] == "Series/N.ipynb"
    assert seen["wt_calls"] == 1
    assert got["verdict"] == "stage0-only"


def test_a_spending_run_without_claim_refuses_before_worktree(monkeypatch, tmp_path):
    """Review ms#1812 finding 1: --max-stage >= 1 without --claim used to reach the
    worktree and the model on a bare pre-check. A spending run now requires an
    admitted reservation; no reservation -> durable refusal, zero spend."""
    from types import SimpleNamespace
    import asyncio
    import subprocess
    rec = {"stages": {}, "calls": []}
    args = SimpleNamespace(out_dir=str(tmp_path), repo="D:/repo", issue=27106,
                           notebook="Series/N.ipynb", source_nb=None,
                           allow_foreign_origin=False, lane="lane:a", claim=False,
                           intention="witness", conventions="", max_stage=5,
                           worktree=str(tmp_path / "wt"), fresh_worktree=False)
    monkeypatch.setattr(nbcd, "app_token", lambda repo: "")
    monkeypatch.setattr(nbcd, "read_conventions", lambda p: "")
    monkeypatch.setattr(nbcd, "check_claim", lambda *a: {"rc": 0, "ok": True})
    monkeypatch.setattr(nbcd, "fetch_issue", lambda *a: {
        "title": "N", "state": "open", "labels": [], "body": ""})
    monkeypatch.setattr(nbcd, "reserve_claim", lambda *a: (_ for _ in ()).throw(
        AssertionError("a no-claim run must not invent a reservation")))
    monkeypatch.setattr(nbcd, "prepare_worktree", lambda *a: (_ for _ in ()).throw(
        AssertionError("a refused run must not prepare or mutate a worktree")))
    monkeypatch.setattr(nbcd.subprocess, "run", lambda *a, **kw:
                        SimpleNamespace(stdout="https://github.com/jsboige/CoursIA.git\n"))
    got = asyncio.run(nbcd.run(args, rec))
    assert got["verdict"] == "refused-no-reservation"
    assert got["calls"] == []


def test_stage0_only_without_claim_stays_the_sanctioned_exception(monkeypatch, tmp_path):
    """--max-stage 0 is inspection only: it may run without a reservation and still
    must stop before any model stage."""
    from types import SimpleNamespace
    import asyncio
    import subprocess
    seen = {}
    rec = {"stages": {}, "calls": []}
    args = SimpleNamespace(out_dir=str(tmp_path), repo="D:/repo", issue=27106,
                           notebook="Series/N.ipynb", source_nb=None,
                           allow_foreign_origin=False, lane="lane:a", claim=False,
                           intention="witness", conventions="", max_stage=0,
                           worktree=str(tmp_path / "wt"), fresh_worktree=False)
    monkeypatch.setattr(nbcd, "app_token", lambda repo: "")
    monkeypatch.setattr(nbcd, "read_conventions", lambda p: "")
    monkeypatch.setattr(nbcd, "check_claim", lambda *a: {"rc": 0, "ok": True})
    monkeypatch.setattr(nbcd, "fetch_issue", lambda *a: {
        "title": "N", "state": "open", "labels": [], "body": ""})
    monkeypatch.setattr(nbcd, "prepare_worktree", lambda *a: (
        seen.setdefault("wt", True) and {"path": str(tmp_path / "wt"),
                                         "reused": False, "head": "deadbee"}))
    monkeypatch.setattr(nbcd.subprocess, "run", lambda *a, **kw:
                        SimpleNamespace(stdout="https://github.com/jsboige/CoursIA.git\n"))
    got = asyncio.run(nbcd.run(args, rec))
    assert seen.get("wt") is True
    assert got["verdict"] == "stage0-only"
    assert got["calls"] == []
