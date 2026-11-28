#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_claim_release.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""A failed grain releases our [CLAIMED] on its issue (22/11).

Nothing released the claim of a grain that failed after reserving: the issue stayed locked
for other lanes until the guard's 48 h stale threshold. Offline: fake claims, fake driver,
no GitHub. Run: python -m pytest test_nb_coder_claim_release.py -q from this directory.

26/11 — one failure no longer releases: a FIRST content failure whose run left a resumable
trace keeps the claim (bottom of this file). The claim guard reads any [RELEASED] as a
close of the whole issue for 3 days, which froze the lane's own salvage."""

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


def _sched(tmp_path, items, spawn, claims, claim=True, max_active=2, extra=()):
    q = tmp_path / "queue.jsonl"
    q.write_text("\n".join(json.dumps(x) for x in items) + "\n", encoding="utf-8")
    argv = ["--queue", str(q), "--state-dir", str(tmp_path / "state"), "--repo", "D:/CoursIA",
            "--max-active", str(max_active), "--lane", ME]
    args = S.parse_args(argv + (["--claim"] if claim else []) + list(extra))
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


# --- 26/11: a FIRST content failure keeps the claim when its trace is resumable ---------
# Measured on CoursIA#27133 (lot 5, five Rust ports): the o39b batch ended on one
# built-execution-failed (Search-11); the scheduler posted `[RELEASED] … -- paths:
# …/Search-11-Metaheuristics-Rust.ipynb` (comment 7183109434, 05:01:21Z). The claim guard
# reads ANY [RELEASED] as a full close of the lane on the whole ISSUE (RELACHEE 3 days,
# every lane), so the two salvage launches of the next batch (05:04:30Z, 05:06:35Z) were
# refused before any model call — on drafts already built and paid for.

LOT5 = {"issue": 27133, "notebook": "Dir/Search-11-Rust.ipynb"}
BUILT = {"verdict": "built-execution-failed", "built_notebook": "nb_27133_built.ipynb"}


def _leaving(rec, verdict, rc):
    """A driver that leaves `rec` in ITS --out-dir (where the scheduler reads it back),
    then ends on (verdict, rc). `rec=None` leaves no record at all."""
    def spawn(cmd):
        if rec is not None:
            out = Path(cmd[cmd.index("--out-dir") + 1])
            out.mkdir(parents=True, exist_ok=True)
            (out / f"issue-{cmd[cmd.index('--issue') + 1]}.json").write_text(
                rec if isinstance(rec, str) else json.dumps(rec), encoding="utf-8")
        return S.FakeProc(verdict, rc, 0)
    return spawn


def test_a_first_content_failure_on_a_built_notebook_keeps_the_claim(tmp_path):
    claims = FakeClaims()
    spawn = _leaving(BUILT, "built-execution-failed", 1)
    sched = _sched(tmp_path, [LOT5], spawn, claims)
    sched.run()
    assert claims.reads == [] and claims.releases == []   # nothing is asked of GitHub
    assert not _events(sched, "claim-released")
    skipped, = _events(sched, "claim-release-skipped")
    assert skipped["reason"] == "resumable-first-content-failure" and skipped["issue"] == 27133
    assert Path(skipped["trace"]) == sched.run_trace(LOT5)
    g = sched.state["grains"]["#27133:Dir/Search-11-Rust.ipynb"]
    assert g["status"] == "failed"                       # the grain itself is still a failure
    assert g["resumable_trace"] == skipped["trace"]      # and the salvage is one flag away


def test_a_grain_with_no_record_in_state_never_crashes_the_release(tmp_path):
    """Review ai-01 (26/11): resumable_trace() tolerates a key with no grain record
    (`.get(key, {})`); the write beside it assumed one and would have raised KeyError --
    in a release path, which aborts the cycle. The trace stays named in the event."""
    spawn = _leaving(BUILT, "built-execution-failed", 1)
    sched = _sched(tmp_path, [LOT5], spawn, FakeClaims())
    sched.run()
    key = "#27133:Dir/Search-11-Rust.ipynb"
    recorded = sched.state["grains"].pop(key)
    assert recorded["resumable_trace"]                    # the run itself had the record
    sched._release_claim(key, LOT5, "built-execution-failed")
    skipped = _events(sched, "claim-release-skipped")[-1]
    assert skipped["reason"] == "resumable-first-content-failure"
    assert Path(skipped["trace"]) == sched.run_trace(LOT5)
    assert key not in sched.state["grains"], "no empty grain record is invented"


@pytest.mark.parametrize("verdict", [
    "gates-failed: conformance",
    "verify-reject: findings",
    "built-structure-mismatch: 3 cells",
])
def test_every_judged_notebook_verdict_qualifies(tmp_path, verdict):
    spawn = _leaving(BUILT, verdict, 1)
    sched = _sched(tmp_path, [LOT5], spawn, FakeClaims())
    sched.run()
    skipped, = _events(sched, "claim-release-skipped")
    assert skipped["reason"] == "resumable-first-content-failure"


@pytest.mark.parametrize("verdict", [
    "call-failed: timeout",             # a run failure: nothing was judged
    "refused-claim-held-by-another-lane",
    "",
])
def test_a_non_content_failure_releases_as_before(tmp_path, verdict):
    spawn = _leaving(BUILT, verdict, 1)
    sched = _sched(tmp_path, [LOT5], spawn, FakeClaims())
    sched.run()
    sched_claims = sched.claims
    assert len(sched_claims.releases) == 1 and sched_claims.reads == [27133]
    assert _events(sched, "claim-released")


@pytest.mark.parametrize("rec", [
    {},                                              # nothing was built: nothing to resume
    {"verdict": "built-execution-failed"},           # judged, but no notebook behind it
    "{not json",
    None,                                            # the run left no record at all
])
def test_without_a_built_notebook_behind_it_the_claim_is_released(tmp_path, rec):
    sched = _sched(tmp_path, [LOT5], _leaving(rec, "built-execution-failed", 1), FakeClaims())
    sched.run()
    if rec is None:
        assert sched.run_trace(LOT5) is None         # no record: nothing to resume from
    assert len(sched.claims.releases) == 1


def test_a_second_content_failure_on_a_resumed_grain_releases(tmp_path):
    """The salvage round itself ends on a content verdict: the draft had its chance."""
    prior = tmp_path / "o39b" / "runs" / "x" / "issue-27133.json"
    prior.parent.mkdir(parents=True)
    prior.write_text(json.dumps(BUILT), encoding="utf-8")
    item = dict(LOT5, revise_from=str(prior))
    sched = _sched(tmp_path, [item], _leaving(BUILT, "built-execution-failed", 1), FakeClaims())
    sched.run()
    assert len(sched.claims.releases) == 1
    assert _events(sched, "claim-released")


def test_a_launch_resumed_after_a_verifier_crash_releases_on_a_content_failure(tmp_path):
    """`resume_from` (the verify-error recovery) is a resume too."""
    claims = FakeClaims()
    sched = _sched(tmp_path, [LOT5], _leaving(BUILT, "verify-reject: findings", 1), claims)
    sched.state["grains"]["#27133:Dir/Search-11-Rust.ipynb"]["resume_from"] = "t.json"
    sched.run()
    assert len(claims.releases) == 1


def _write_record(sched, item, rec):
    """Put a grain's verdict record where run_trace() reads it (the driver's job)."""
    path = (Path(sched.args.out_root) / f"issue-{S.grain_slug(item)}"
            / f"issue-{item['issue']}.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(rec if isinstance(rec, str) else json.dumps(rec), encoding="utf-8")
    return path


def test_the_resume_signal_alone_decides_not_the_record(tmp_path):
    """Unit-level pin of the two resume checks: the resumable record IS present at the
    grain's own run dir (the witness below returns it for a plain item), and an explicit
    --revise-from / --verify-from must still keep nothing — the end-to-end resumed test
    only proves the release, because a resumed driver writes next to its trace."""
    key = "#27133:Dir/Search-11-Rust.ipynb"
    item = dict(LOT5, revise_from=str(tmp_path / "old" / "issue-27133.json"))
    sched = _sched(tmp_path, [item], _leaving(BUILT, "built-execution-failed", 1), FakeClaims())
    rec = _write_record(sched, LOT5, BUILT)
    assert sched.run_trace(LOT5) == rec                          # the witness
    assert sched.resumable_trace(key, LOT5, "built-execution-failed") == rec
    assert sched.resumable_trace(key, item, "built-execution-failed") is None
    assert sched.resumable_trace(key, dict(LOT5, verify_from="t.json"),
                                 "built-execution-failed") is None


def test_the_old_behavior_is_one_flag_away(tmp_path):
    sched = _sched(tmp_path, [LOT5], _leaving(BUILT, "built-execution-failed", 1), FakeClaims(),
                   extra=["--release-on-first-content-failure"])
    sched.run()
    assert len(sched.claims.releases) == 1
    assert "resumable_trace" not in sched.state["grains"]["#27133:Dir/Search-11-Rust.ipynb"]


# --- 28/11: the [RELEASED] note cites the cause read from the run's own record ------------
# CoursIA#28944: the second verify-reject of a resumed Rust port posted `[RELEASED] … (nb_coder:
# grain ended without a PR (verify-reject))` — no cell, no reason. The coordinator requires a
# release without a PR to cite the verifier's rejecting line (c0177); it was posted by hand
# (comment 7238434630). Shapes below are the record's real ones (o67b trace of #28944).

SUDOKU = {"issue": 28944, "notebook": "MyIA.AI.Notebooks/Sudoku/Sudoku-06-AIMA-CSP-Rust.ipynb"}
BASE = "nb_coder: grain ended without a PR (verify-reject); motif: verify-reject"
REJECTED = {
    "verdict": "verify-reject", "built_notebook": "nb_28944_built.ipynb",
    "verify": {"agent": "critic-terra", "served_model": "gpt-6.1-terra", "verdict": "reject",
               "findings": [
                   {"cell": 12, "severity": "minor", "detail": "Libellé de section à reprendre."},
                   {"cell": 33, "severity": "major",
                    "detail": "Preuve forte — la cellule 33 affiche uniquement les durées Rust ;\n"
                              "les sorties commitées donnent 9 672 ms en Python."},
               ]},
}


def _resumed(tmp_path, rec, verdict):
    """A revise_from launch on a COPY of the first round's trace (the salvage recipe): the
    driver writes its record next to that copy, which is where the release must read it."""
    copy = tmp_path / "o68" / "copy" / "issue-28944.json"
    copy.parent.mkdir(parents=True)
    copy.write_text(json.dumps(REJECTED), encoding="utf-8")
    item = dict(SUDOKU, revise_from=str(copy))
    claims = FakeClaims()
    sched = _sched(tmp_path, [item], _leaving(rec, verdict, 1), claims)
    sched.run()
    (_, _, _, note), = claims.releases
    return sched, note


def test_a_second_verify_reject_cites_the_verifier_line(tmp_path):
    sched, note = _resumed(tmp_path, REJECTED, "verify-reject")
    assert note.startswith(BASE)                          # the prefix readers already match
    assert ("verifier critic-terra (served gpt-6.1-terra): cell 33, major: "
            "\u00abPreuve forte") in note                  # the MOST severe, not the first
    assert note.endswith("(+1 other finding)")
    released, = _events(sched, "claim-released")
    assert released["cause"] and released["cause"] in note


def test_the_cause_stays_on_the_marker_head_line(tmp_path):
    """The guard writes `[RELEASED] lane L -- <note> -- paths: <nb>` and reads the clause on
    that line only: a newline in the note would make the release issue-wide."""
    long = dict(REJECTED, verify=dict(REJECTED["verify"], findings=[
        {"cell": 4, "severity": "major", "detail": "ligne\n" * 400}]))
    _, note = _resumed(tmp_path, long, "verify-reject")
    assert "\n" not in note and "\r" not in note
    assert len(note) <= len(BASE) + 2 + S.RELEASE_CAUSE_MAX


def test_a_record_left_by_another_round_is_never_cited(tmp_path):
    """A resumed driver that dies before writing leaves the previous record in place: its
    verdict is not the one reaped, so nothing from it reaches the note."""
    stale = dict(REJECTED, verdict="gates-failed:prose-counts")
    _, note = _resumed(tmp_path, stale, "verify-reject")
    assert note == BASE


def test_a_plain_launch_reads_its_own_run_dir(tmp_path):
    """No built notebook behind the failure: released at once, cause from the grain's run dir."""
    rec = {"verdict": "gates-failed:prose-counts", "gates": [
        {"gate": "secrets", "ok": True, "detail": {"cells": []}},
        {"gate": "prose-counts", "ok": False, "detail": {"cells": [7], "claims": ["11 cellules"]}},
    ]}
    claims = FakeClaims()
    sched = _sched(tmp_path, [SUDOKU], _leaving(rec, "gates-failed:prose-counts", 1), claims)
    sched.run()
    (_, _, _, note), = claims.releases
    assert note == ('nb_coder: grain ended without a PR (gates-failed:prose-counts); motif: '
                    'gates-failed; gate prose-counts: {"cells": [7], "claims": ["11 cellules"]}')


def test_a_non_content_failure_carries_no_cause(tmp_path):
    rec = dict(REJECTED, verdict="call-failed: timeout")
    claims = FakeClaims()
    sched = _sched(tmp_path, [SUDOKU], _leaving(rec, "call-failed: timeout", 1), claims)
    sched.run()
    (_, _, _, note), = claims.releases
    assert note == "nb_coder: grain ended without a PR (call-failed: timeout); motif: call-failed"


def test_release_cause_reads_an_execution_failure():
    """Shape of o39b's Search-11 record: the error output is a repr'd list in outputs_tail."""
    rec = {"verdict": "built-execution-failed", "execution": [
        {"cell": 0, "ok": True},
        {"cell": 1, "ok": False, "outputs_tail": "[{'output_type': 'error', 'ename': 'Error', "
         "'evalue': 'expected one of `!`, `.`, `::`, `;`, found `System`', 'traceback': []}]"}]}
    assert S.release_cause(rec, "built-execution-failed") == (
        "cell 1 failed: expected one of `!`, `.`, `::`, `;`, found `System`")


@pytest.mark.parametrize("rec,verdict", [
    (None, "verify-reject"),
    ("not a dict", "verify-reject"),
    ({"verdict": "verify-reject", "verify": "garbled"}, "verify-reject"),
    ({"verdict": "verify-reject", "verify": {"findings": ["x", 3]}}, "verify-reject"),
    ({"verdict": "verify-reject", "verify": {"findings": []}}, "verify-reject"),
    ({"verdict": "gates-failed:x", "gates": [{"gate": "a", "ok": True}]}, "gates-failed:x"),
    ({"verdict": "built-execution-failed", "execution": "garbled"}, "built-execution-failed"),
    (REJECTED, ""),
])
def test_release_cause_degrades_to_empty(rec, verdict):
    assert S.release_cause(rec, verdict) == ""


# 28/11 — the release declares its motif. CoursIA's RELACHEE organ freezes a fresh [RELEASED]
# for the WHOLE fleet unless its motif is positively identified (`motif: <code>` in the
# marker block, code alone in its `;` clause, no historical word beside it); a bare
# `(verify-reject)` never was, so every automatic release froze every lane for 3 days.
# Measured against the organ at CoursIA origin/main 330e29d7eb: with the clause, a
# verify-reject / built-structure-mismatch release freezes only the releasing lane.

@pytest.mark.parametrize("verdict,code", [
    ("verify-reject", "verify-reject"),
    ("gates-failed:prose-counts", "gates-failed"),
    ("built-structure-mismatch: 3 cells", "built-structure-mismatch"),
    ("refused-claim-not-qualified:RELACHEE", "refused-claim-not-qualified"),
    ("Stage2-Call-Failed", "stage2-call-failed"),
])
def test_the_motif_is_the_verdict_code_alone_in_its_clause(verdict, code):
    clauses = [c.strip() for c in S.release_note(verdict, "cell 3, major: «x»").split(";")]
    assert clauses[1] == f"motif: {code}"
    assert len(clauses) == 3 and "\n" not in S.release_note(verdict, "cell 3, major: «x»")


@pytest.mark.parametrize("verdict", ["", "   ", ":x", None])
def test_no_code_no_motif(verdict):
    note = S.release_note(verdict)
    assert "motif" not in note
    assert note.startswith("nb_coder: grain ended without a PR (")


def test_the_motif_clause_precedes_the_cause():
    """The cause quotes the verifier (free text, may say « dernière cellule ») — it must
    never share the motif's clause, or the organ reads the code as cited in the past."""
    note = S.release_note("verify-reject", "cell 33, major: «la dernière cellule»")
    head, motif, cause = note.split("; ", 2)
    assert motif == "motif: verify-reject" and "dernière" in cause and "dernière" not in motif


# 28/11 — a SEAT refusal keeps the claim. CoursIA#29058: the queue item named no source_nb,
# the driver refused before any call (refused-target-unresolved, calls 0), the verdict line
# was missing from stdout, the grain reaped as a run failure and its claim was released —
# the path frozen 3 days for a launch error. driver.log mixes the verdict line with
# argparse's usage and error on stderr: the reap must find the line among them.

class _RefusedDriver:
    """A detached driver's log after `_preflight`: verdict line, then ap.error's stderr."""
    def __init__(self, verdict):
        self.verdict = verdict

    def poll(self):
        return S.ADOPTED_RC

    def communicate(self, timeout=None):
        return (json.dumps({"issue": 29058, "verdict": self.verdict, "calls": 0}) + "\n"
                "usage: nb_coder_driver.py [-h] --issue ISSUE --notebook NOTEBOOK\n"
                "                          [--verify-from VERIFY_FROM]\n"
                "nb_coder_driver.py: error: X-Rust.ipynb is absent from origin/main\n"), ""


@pytest.mark.parametrize("verdict", S.SEAT_REFUSAL_VERDICTS)
def test_a_seat_refusal_keeps_the_claim(tmp_path, verdict):
    claims = FakeClaims()
    item = {"issue": 29058, "notebook": "SocialChoice/ChoixSocial-10-Rust.ipynb"}
    sched = _sched(tmp_path, [item], lambda cmd: _RefusedDriver(verdict), claims)
    sched.run()
    assert claims.releases == [] and claims.reads == []
    (skip,) = _events(sched, "claim-release-skipped")
    assert skip["reason"] == "seat-refusal" and skip["verdict"] == verdict
    (failed,) = _events(sched, "failed")
    assert failed["verdict"] == verdict and failed["failure_class"] == "admission"


def test_a_driver_that_prints_no_verdict_still_releases_as_before(tmp_path):
    """The kept claim is bound to the refusal's own verdict, never to a missing one."""
    class _Silent(_RefusedDriver):
        def communicate(self, timeout=None):
            return "Traceback (most recent call last):\nRuntimeError: boom\n", ""
    claims = FakeClaims()
    sched = _sched(tmp_path, [{"issue": 7, "notebook": "Dir/D.ipynb"}],
                   lambda cmd: _Silent(""), claims)
    sched.run()
    assert len(claims.releases) == 1
    (failed,) = _events(sched, "failed")
    assert failed["verdict"] == "" and failed["failure_class"] == "run"
