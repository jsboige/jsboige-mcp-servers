# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7416ac16c91e150aae5a75dd251d0c1a4c2f5c2c
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_claim.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
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


# ---- rc=3 IMPLICIT on a lot issue (CoursIA#27133, 21/11 03:14Z) ------------------
MGS28 = "MyIA.AI.Notebooks/Search/Part4-Metaheuristics/MGS-vs-mealpy/MGS-28-BareBonesPSO-vs-Mealpy-Rust.ipynb"
SUDOKU05 = "MyIA.AI.Notebooks/Sudoku/Sudoku-05-PSO-Rust.ipynb"


def _guard_proc(rc, implicit, filler=0):
    import json as _json
    doc = {"issue": 27133, "my_lane": "myia-ai-01:vllm", "blocking_lanes": [],
           "delivered_claims": [{"paths": ["x" * 40] * filler}],
           "implicit_occupation": implicit}
    tail = "\nIMPLICIT: lane myia-po-2024:CoursIA a une PR ouverte (#27691) sans [CLAIMED] pose."

    class P:
        returncode = rc
        stdout = _json.dumps(doc, indent=2) + tail
        stderr = "WARN: enumeration incomplete"
    return P()


def _po2024(files):
    return [{"number": 27691, "lane": "myia-po-2024:CoursIA", "files": files,
             "created_at": "2026-11-21T02:26:34Z"}]


def test_disjoint_implicit_occupation_defers_instead_of_burning_the_grain():
    cc = nbcd._guard_result(_guard_proc(3, _po2024([SUDOKU05, "README.md"])), MGS28)
    assert cc["implicit"][0]["touches_notebook"] is False
    assert nbcd.claim_verdict(cc) == "deferred-by-claim-implicit-occupation:#27691"


def test_implicit_occupation_on_our_own_file_still_refuses():
    cc = nbcd._guard_result(_guard_proc(3, _po2024([MGS28])), MGS28)
    assert nbcd.claim_verdict(cc) == "refused-claim-implicit-occupation"


def test_unreadable_or_truncated_implicit_report_fails_closed():
    assert nbcd.claim_verdict({"rc": 3}) == "refused-claim-implicit-occupation"
    many = [f"f{i}.py" for i in range(100)]
    cc = nbcd._guard_result(_guard_proc(3, _po2024(many)), MGS28)
    assert cc["implicit"][0]["touches_notebook"] is True
    assert nbcd.claim_verdict(cc) == "refused-claim-implicit-occupation"


def test_recorded_output_keeps_the_verdict_line_past_2000_chars():
    """The old `[:2000]` cut the guard's verdict off: the refusal recorded no reason."""
    cc = nbcd._guard_result(_guard_proc(3, _po2024([SUDOKU05]), filler=80), MGS28)
    assert len(cc["out"]) <= 2100
    assert "IMPLICIT: lane myia-po-2024:CoursIA" in cc["out"]
    assert cc["warnings"].startswith("WARN")


def test_post_refused_by_implicit_leg_defers_without_unknown_residue():
    post = nbcd._guard_result(_guard_proc(3, _po2024([SUDOKU05])), MGS28)
    assert nbcd.claim_reservation_verdict(post, {"rc": None}) == (
        "deferred-by-claim-implicit-occupation:#27691")
    # a real collision at write time still refuses
    post = nbcd._guard_result(_guard_proc(3, _po2024([MGS28])), MGS28)
    assert nbcd.claim_reservation_verdict(post, {"rc": None}) == (
        "refused-claim-implicit-occupation")


def test_verify_seeing_an_older_disjoint_pr_defers():
    verify = nbcd._guard_result(_guard_proc(3, _po2024([SUDOKU05])), MGS28)
    assert nbcd.claim_reservation_verdict({"rc": 0}, verify) == (
        "deferred-by-claim-implicit-occupation:#27691")
    verify = nbcd._guard_result(_guard_proc(3, _po2024([MGS28])), MGS28)
    assert nbcd.claim_reservation_verdict({"rc": 0}, verify) == "refused-claim-not-verified"


# ---- per-issue reservation lock (CoursIA#27133, MGS-25 vs MGS-28, 21/11 02:08Z) ------
def test_reservation_lock_is_exclusive_and_released(tmp_path):
    with nbcd.issue_claim_lock(tmp_path, 27133) as a:
        assert a["held"] is True
        t = {"now": 0.0}
        with nbcd.issue_claim_lock(tmp_path, 27133, wait_s=30, poll_s=10,
                                   clock=lambda: t["now"],
                                   sleep=lambda s: t.__setitem__("now", t["now"] + s)) as b:
            # the sibling waits, then gives up without reserving
            assert b["held"] is False and b["waited_s"] >= 30
        with nbcd.issue_claim_lock(tmp_path, 27134) as other:
            assert other["held"] is True          # another issue is not blocked
    assert not (tmp_path / "issue-27133.lock").exists()
    with nbcd.issue_claim_lock(tmp_path, 27133) as again:
        assert again["held"] is True


def test_a_stale_lock_from_a_dead_holder_is_taken_over(tmp_path):
    import os as _os
    lock = tmp_path / "issue-27133.lock"
    lock.write_text("{}", encoding="utf-8")
    old = lock.stat().st_mtime - 10_000
    _os.utime(lock, (old, old))
    with nbcd.issue_claim_lock(tmp_path, 27133, wait_s=60) as got:
        assert got["held"] is True and got["took_over_stale_s"] > 60


def test_a_lock_timeout_defers_the_grain():
    assert nbcd.claim_verdict({"timed_out": True}).startswith("deferred-by-claim-timeout")
    assert f"{nbcd.CLAIM_TIMEOUT_VERDICT}:lock".startswith("deferred-by-claim-timeout")


# ---- the lane's lot claim is kept, not narrowed (CoursIA#27133, 21/11 03:14Z) ----------
# The guard keeps ONE active [CLAIMED] per lane and issue and writes exactly --paths:
# a grain re-posting its own notebook shrank the coordinator's lot claim to one path and
# re-dated it past po-2024's PR #27691, which the IMPLICIT leg then counted.
MGS25 = "MyIA.AI.Notebooks/Search/Part4-Metaheuristics/MGS-vs-mealpy/MGS-25-DE-vs-Mealpy-Rust.ipynb"
LOT_GLOB = "MyIA.AI.Notebooks/Search/Part4-Metaheuristics/MGS-vs-mealpy/*-Rust.ipynb"


def _ago(hours):
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _claim(paths, hours=1.0, **kw):
    return {"marker": "CLAIMED", "claimed_at": _ago(hours), "url": "u#1",
            "pr_ref": None, "locked": False, "paths": paths, **kw}


def test_guard_result_extracts_our_lane_claim():
    import json as _json
    doc = {"issue": 27133, "my_lane": "myia-ai-01:vllm",
           "active_claims": {"myia-ai-01:vllm": {
               "marker": "CLAIMED", "claimed_at": "2026-11-21T03:14:07Z",
               "url": "u#7056461759", "pr_ref": None, "locked": False,
               "paths": ["./" + MGS25]},
               "myia-po-2024:CoursIA": {"marker": "CLAIMED", "paths": [SUDOKU05]}}}

    class P:
        returncode = 0
        stdout = _json.dumps(doc) + "\nCLEAR"
        stderr = ""
    mine = nbcd._guard_result(P(), MGS28)["my_claim"]
    assert mine["claimed_at"] == "2026-11-21T03:14:07Z"
    assert mine["paths"] == [MGS25]           # normalised, and only OUR lane's


def test_a_fresh_lot_claim_covers_its_notebooks_by_glob():
    assert nbcd.lane_claim_covers(_claim([LOT_GLOB]), MGS28)
    assert nbcd.lane_claim_covers(_claim([MGS28]), MGS28)
    assert not nbcd.lane_claim_covers(_claim([MGS25]), MGS28)
    assert not nbcd.lane_claim_covers(_claim([]), MGS28)        # issue-wide: no proof


def test_a_stale_delivered_or_locked_claim_does_not_cover():
    assert not nbcd.lane_claim_covers(_claim([LOT_GLOB], hours=30), MGS28)
    assert not nbcd.lane_claim_covers(_claim([LOT_GLOB], marker="DELIVERED"), MGS28)
    assert not nbcd.lane_claim_covers(_claim([LOT_GLOB], pr_ref="#27700"), MGS28)
    assert not nbcd.lane_claim_covers(_claim([LOT_GLOB], locked=True), MGS28)
    assert not nbcd.lane_claim_covers(_claim([LOT_GLOB], claimed_at="?"), MGS28)
    assert nbcd.lane_claim_scope(_claim([MGS25], marker="DELIVERED"), MGS28) is None


def test_an_amended_lot_claim_covers_and_scopes_like_a_claim():
    """CoursIA asked (21/11 04:19Z) for the lot to be re-posted as [CLAIMED-AMEND]; the
    guard reports that marker verbatim. It must cover and keep its paths, or the next
    grain re-posts its notebook alone and narrows the lot again."""
    amend = _claim([MGS25, MGS28], marker="CLAIMED-AMEND")
    assert nbcd.lane_claim_covers(amend, MGS28)
    assert nbcd.lane_claim_scope(amend, SUDOKU05) == [MGS25, MGS28, SUDOKU05]
    assert nbcd.lane_claim_covers(_claim([MGS28], marker="claimed-amend"), MGS28)
    assert not nbcd.lane_claim_covers(_claim([MGS28], marker="RELEASED"), MGS28)


def test_union_scope_keeps_the_lane_paths_and_adds_ours_once():
    assert nbcd.lane_claim_scope(_claim([MGS25]), MGS28) == [MGS25, MGS28]
    assert nbcd.lane_claim_scope(_claim([MGS25, MGS28]), MGS28) == [MGS25, MGS28]
    assert nbcd.lane_claim_scope(_claim([]), MGS28) is None
    assert nbcd.lane_claim_scope(None, MGS28) is None


def test_covered_notebook_is_admitted_without_any_write(monkeypatch, tmp_path):
    reads = {"n": 0}

    def check(*a):
        reads["n"] += 1
        return {"rc": 0, "ok": True, "my_claim": _claim([LOT_GLOB])}
    monkeypatch.setattr(nbcd, "check_claim", check)
    monkeypatch.setattr(nbcd, "post_claim", lambda *a, **kw: (_ for _ in ()).throw(
        AssertionError("a covered notebook must not re-post (it re-dates the claim)")))
    res = nbcd.reserve_claim(tmp_path, 27133, "myia-ai-01:vllm", "w", MGS28)
    assert res["verdict"] is None and res["posted"] is None
    assert res["covered_by"]["paths"] == [LOT_GLOB]
    assert reads["n"] == 1


def test_covered_but_implicit_disjoint_still_defers(monkeypatch, tmp_path):
    """Cover does not bypass the pre-check verdict: rc=3 is read first."""
    pre = nbcd._guard_result(_guard_proc(3, _po2024([SUDOKU05])), MGS28)
    pre["my_claim"] = _claim([LOT_GLOB])
    monkeypatch.setattr(nbcd, "check_claim", lambda *a: pre)
    res = nbcd.reserve_claim(tmp_path, 27133, "myia-ai-01:vllm", "w", MGS28)
    assert res["verdict"] == "deferred-by-claim-implicit-occupation:#27691"


def test_uncovered_notebook_writes_the_union_of_the_lane_paths(monkeypatch, tmp_path):
    seen = _post_claim_argv_seen(monkeypatch, tmp_path, 0, "posted")
    monkeypatch.setattr(nbcd, "check_claim",
                        lambda *a: {"rc": 0, "ok": True, "my_claim": _claim([MGS25])})
    res = nbcd.reserve_claim(tmp_path, 27133, "myia-ai-01:vllm", "w", MGS28)
    argv = seen["argv"]
    i, j = argv.index("--paths"), argv.index("--claim")
    assert argv[i + 1:j] == [MGS25, MGS28]
    assert res["scope"] == [MGS25, MGS28] and res["verdict"] is None


def test_refused_union_falls_back_to_the_notebook_alone(monkeypatch, tmp_path):
    writes = []

    def post(repo, n, lane, intention, notebook, from_json=None, scope=None):
        writes.append(scope)
        return {"rc": 1, "out": "BLOCKED: MGS-25 held"} if scope else {"rc": 0}
    monkeypatch.setattr(nbcd, "post_claim", post)
    monkeypatch.setattr(nbcd, "check_claim",
                        lambda *a: {"rc": 0, "ok": True, "my_claim": _claim([MGS25])})
    res = nbcd.reserve_claim(tmp_path, 27133, "myia-ai-01:vllm", "w", MGS28)
    assert writes == [[MGS25, MGS28], None]
    assert res["posted"]["union_refused"]["rc"] == 1
    assert res["verdict"] is None


def test_no_live_lane_claim_keeps_the_narrow_write(monkeypatch, tmp_path):
    seen = _post_claim_argv_seen(monkeypatch, tmp_path, 0, "posted")
    monkeypatch.setattr(nbcd, "check_claim", lambda *a: {
        "rc": 0, "ok": True, "my_claim": _claim([MGS25], pr_ref="#27700")})
    res = nbcd.reserve_claim(tmp_path, 27133, "myia-ai-01:vllm", "w", MGS28)
    argv = seen["argv"]
    assert argv[argv.index("--paths") + 1:argv.index("--claim")] == [MGS28]
    assert "scope" not in res and res["verdict"] is None
