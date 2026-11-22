#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_claim_release.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""A failed grain releases our [CLAIMED] on its issue (22/11).

Nothing released the claim of a grain that failed after reserving: the issue stayed locked
for other lanes until the guard's 48 h stale threshold. Offline: fake claims, fake driver,
no GitHub. Run: python -m pytest test_nb_coder_claim_release.py -q from this directory."""

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nbcs_release", HERE / "nb_coder_scheduler.py")
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)

ME = "myia-ai-01:vllm"
GREEN = {"verdict": "green", "running": 0, "waiting": 0, "preemptions": 0}


class FakeClaims:
    def __init__(self, last=("CLAIMED", ME), release_rc=0, read_error=None):
        self.last, self.release_rc, self.read_error = last, release_rc, read_error
        self.reads, self.releases = [], []

    def last_marker(self, issue):
        self.reads.append(issue)
        if self.read_error:
            raise self.read_error
        return self.last

    def release(self, issue, lane, notebook, note):
        self.releases.append((issue, lane, notebook, note))
        return self.release_rc, "posted" if self.release_rc == 0 else "error: 502"


def _sched(tmp_path, items, spawn, claims, claim=True, max_active=2):
    q = tmp_path / "queue.jsonl"
    q.write_text("\n".join(json.dumps(x) for x in items) + "\n", encoding="utf-8")
    argv = ["--queue", str(q), "--state-dir", str(tmp_path / "state"), "--repo", "D:/CoursIA",
            "--max-active", str(max_active), "--lane", ME]
    args = S.parse_args(argv + (["--claim"] if claim else []))
    sched = S.Scheduler(args, spawn=spawn, gate=lambda: dict(GREEN), sleep=lambda s=0: None,
                        clock=lambda: 1000.0, git=lambda argv, timeout=300: (1, "no tree"),
                        claims=claims)
    items_, digest = S.load_queue(q)
    sched.merge_queue(items_, digest)
    return sched


def _events(sched, kind):
    path = sched.journal_path
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    return [r for r in rows if r["kind"] == kind]


def _spawn(verdict, rc, done_after=0):
    return lambda cmd: S.FakeProc(verdict, rc, done_after)


def test_a_failed_claimed_grain_releases_its_notebook(tmp_path):
    claims = FakeClaims()
    sched = _sched(tmp_path, [{"issue": 27931, "notebook": "Dir/A-Rust.ipynb"}],
                   _spawn("built-execution-failed", 1), claims)
    sched.run()
    assert claims.reads == [27931]
    (issue, lane, nb, note), = claims.releases
    assert (issue, lane, nb) == (27931, ME, "Dir/A-Rust.ipynb")
    assert note.startswith("nb_coder: grain ended without a PR (built-execution-failed")
    assert not note.lower().startswith("delivered:#")   # the guard's DELIVERED override
    assert _events(sched, "claim-released")[0]["issue"] == 27931


@pytest.mark.parametrize("last", [
    ("CLAIMED", "myia-po-2023:CoursIA"),   # late-claim refusal: the issue is theirs
    ("DELIVERED", ME),                     # our PR is open: never turn it into RELEASED
    ("RELEASED", ME),
    None,                                  # we never claimed (claim-late, early failure)
])
def test_nothing_of_ours_to_release(tmp_path, last):
    claims = FakeClaims(last=last)
    sched = _sched(tmp_path, [{"issue": 5, "notebook": "Dir/B.ipynb"}],
                   _spawn("late-claim-refused:refused-claim-held-by-another-lane", 1), claims)
    sched.run()
    assert claims.reads == [5] and claims.releases == []
    assert not _events(sched, "claim-released") and not _events(sched, "claim-release-failed")


@pytest.mark.parametrize("verdict,rc", [("built-executed-ok", 0),
                                        ("deferred-by-capacity-gate: red", 1)])
def test_done_and_deferred_grains_keep_their_claim(tmp_path, verdict, rc):
    claims = FakeClaims()
    sched = _sched(tmp_path, [{"issue": 6, "notebook": "Dir/C.ipynb"}], _spawn(verdict, rc),
                   claims)
    sched.tick()                                    # launch
    sched.tick()                                    # reap
    assert sched.state["grains"]["#6:Dir/C.ipynb"]["status"] in ("done", "deferred")
    assert claims.reads == [] and claims.releases == []


def test_an_unclaimed_run_never_reads_github(tmp_path):
    claims = FakeClaims()
    sched = _sched(tmp_path, [{"issue": 7, "notebook": "Dir/D.ipynb"}],
                   _spawn("built-execution-failed", 1), claims, claim=False)
    sched.run()
    assert claims.reads == [] and claims.releases == []


def test_no_claims_wired_means_no_release(tmp_path):
    sched = _sched(tmp_path, [{"issue": 8, "notebook": "Dir/E.ipynb"}],
                   _spawn("built-execution-failed", 1), claims=None)
    sched.run()
    assert not _events(sched, "claim-released")


def test_an_unread_thread_is_never_released_blind(tmp_path):
    claims = FakeClaims(read_error=RuntimeError("gh rc=1: HTTP 502"))
    sched = _sched(tmp_path, [{"issue": 9, "notebook": "Dir/F.ipynb"}],
                   _spawn("built-execution-failed", 1), claims)
    sched.run()
    assert claims.releases == []
    skipped, = _events(sched, "claim-release-skipped")
    assert skipped["reason"] == "marker-unread" and "502" in skipped["detail"]


def test_a_failed_post_is_traced(tmp_path):
    claims = FakeClaims(release_rc=2)
    sched = _sched(tmp_path, [{"issue": 10, "notebook": "Dir/G.ipynb"}],
                   _spawn("built-execution-failed", 1), claims)
    sched.run()
    failed, = _events(sched, "claim-release-failed")
    assert failed["rc"] == 2 and "502" in failed["detail"]


def test_a_sibling_grain_of_the_same_lot_issue_keeps_the_claim(tmp_path):
    claims = FakeClaims()

    def spawn(cmd):
        nb = cmd[cmd.index("--notebook") + 1]
        return (S.FakeProc("built-execution-failed", 1, 0) if nb.endswith("H1.ipynb")
                else S.FakeProc("built-executed-ok", 0, 6))
    sched = _sched(tmp_path, [{"issue": 11, "notebook": "Dir/H1.ipynb"},
                              {"issue": 11, "notebook": "Dir/H2.ipynb"}], spawn, claims)
    sched.run()
    assert claims.releases == []
    skipped, = _events(sched, "claim-release-skipped")
    assert skipped["reason"] == "sibling-grain-active" and skipped["issue"] == 11


@pytest.mark.parametrize("bodies,want", [
    ([], None),
    (["[CLAIMED] lane a:b -- port"], ("CLAIMED", "a:b")),
    (["[CLAIMED] lane a:b -- port", "texte\n[RELEASED] lane a:b -- fin"], ("RELEASED", "a:b")),
    # a marker quoted mid-sentence is not a marker
    (["[CLAIMED] lane a:b", "voir le [RELEASED] lane a:b d'hier"], ("CLAIMED", "a:b")),
    (["**[DELIVERED] lane c:d -- PR #1"], ("DELIVERED", "c:d")),
])
def test_last_claim_marker(bodies, want):
    assert S.last_claim_marker(bodies) == want


def test_guard_claims_reads_every_page(monkeypatch, tmp_path):
    out = "\n".join(json.dumps(b) for b in
                    ["[CLAIMED] lane x:y -- a", "multi\nligne", f"[CLAIMED] lane {ME} -- b"])
    seen = []

    def run(argv, **kw):
        seen.append(argv)
        return subprocess.CompletedProcess(argv, 0, out + "\n", "")
    monkeypatch.setattr(S.subprocess, "run", run)
    assert S.GuardClaims(str(tmp_path)).last_marker(27931) == ("CLAIMED", ME)
    assert "--paginate" in seen[0] and seen[0][-1] == ".[].body | @json"

    monkeypatch.setattr(S.subprocess, "run",
                        lambda argv, **kw: subprocess.CompletedProcess(argv, 1, "", "HTTP 502"))
    with pytest.raises(RuntimeError):
        S.GuardClaims(str(tmp_path)).last_marker(27931)


def test_guard_claims_release_goes_through_the_guard(monkeypatch, tmp_path):
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "check_lane_claim.py").write_text("", encoding="utf-8")
    seen = []

    def run(argv, **kw):
        seen.append((argv, kw.get("cwd")))
        return subprocess.CompletedProcess(argv, 0, "ok", "")
    monkeypatch.setattr(S.subprocess, "run", run)
    rc, _ = S.GuardClaims(str(tmp_path)).release(12, ME, "Dir/I.ipynb", "nb_coder: x")
    argv, cwd = seen[0]
    assert rc == 0 and argv[2:] == ["12", "--lane", ME, "--paths", "Dir/I.ipynb",
                                    "--release", "nb_coder: x"]
    assert Path(cwd) == tmp_path                     # the guard reads its repo from cwd
    assert S.GuardClaims(str(tmp_path / "nowhere")).release(1, ME, "n", "x")[0] == -1

    def timeout(argv, **kw):
        raise subprocess.TimeoutExpired(argv, 240)
    monkeypatch.setattr(S.subprocess, "run", timeout)
    assert S.GuardClaims(str(tmp_path)).release(12, ME, "Dir/I.ipynb", "x")[0] == -1
