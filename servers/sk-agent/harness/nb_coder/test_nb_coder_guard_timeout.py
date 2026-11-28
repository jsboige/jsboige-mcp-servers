#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# NEW in this tree (27/11): no jsboige/vllm original. The failure class it pins (a stage-5
# guard replay wedged by a grandchild that keeps the stdout pipe open) was measured on the
# CoursIA grain MGS-28 (#27133), po-2028:claudish, 27/11, after the 22/11 cutover. This
# tree is the source of truth; the vllm copy of the sibling tests stays frozen at
# 7a09e1caec22441d9402ab25a222206c8905bfe1 — never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Pins for `run_guard_bounded` -- the stage-5 guard runner must never wedge the driver.

Founder incident (po-2028, 27/11): CoursIA#27133's MGS-28 grain committed its delivery
at 06:51:27Z, entered stage 5's guard replay, and 45 min later its driver was still
parked: alive, ZERO child processes, one thread in a pipe read, 5 s of CPU, and no
further write on disk. The branch had never been pushed; the notebook was built AND
approved, so the PR had to be pushed by hand.

The mechanism is CPython's, not ours: `subprocess.run(..., timeout=T)` kills the CHILD
at the deadline and then re-calls `communicate()` with NO timeout. A grandchild that
inherited the stdout handle keeps the pipe open, so that second read blocks forever.

These tests pin the three defences (stdin closed, one pipe instead of two, tree killed
then a BOUNDED second read) by making a guard that deliberately reproduces the shape.

28/11 (review of jsboige-mcp-servers#1950): a row says what was MEASURED. The first version
wrote "pipe abandoned after 30s" for every timeout -- also when the post-kill read had
returned in under a second -- and let its own prefix eat the END of the guard's output, the
only part that carries the verdict. The tests below pin both: `kill_how`, `pipe_abandoned`
and `grace_wait_s` are read from the run, and `_tail_with_prefix` keeps the end.

28/11, later the same day: the ORACLE was over-trusted. `taskkill`'s exit code says what a
tree walk did on THIS machine, not whether the pipe's holder is dead: the exact CI selection
reported `kill_how == "child"` once (08:01Z) and green on the same selection re-run (08:15Z),
while 30 trials under 10 busy children never did. The contract pinned here is therefore the
holder being dead (pipe closed inside the grace), and every fallback must carry the kill
command's own words (`kill_detail`), so a recurrence explains itself. Measured separately,
10 of 10 trials: a guard that EXITS after spawning its grandchild leaves `taskkill` nothing to
walk -- "not found" (128) -- so the row says "child already exited", never a kill that did not
happen.
"""
import importlib.util
import time
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "nb_coder_integrate",
    Path(__file__).resolve().parent / "nb_coder_integrate.py")
nbci = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nbci)


# A guard that spawns a GRANDCHILD inheriting its stdout pipe, then sleeps. The grandchild
# is what holds the pipe open after the guard itself is killed -- the measured shape.
GUARD_WITH_GRANDCHILD = (
    "import subprocess, sys, time\n"
    "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
    "print('guard alive', flush=True)\n"
    "time.sleep(120)\n"
)


def test_a_grandchild_holding_the_pipe_does_not_wedge_the_caller():
    t0 = time.time()
    proc = nbci.run_guard_bounded(["-c", GUARD_WITH_GRANDCHILD], cwd=Path.cwd(),
                                  timeout=2, grace=5)
    elapsed = time.time() - t0
    assert getattr(proc, "timed_out", False) is True
    assert proc.returncode is None
    # 2 s deadline + 5 s grace, with room for process creation on Windows
    assert elapsed < 30, f"caller was held {elapsed:.1f}s by a pipe it does not own"
    assert "guard alive" in (proc.stdout or "")     # the tail we did get is kept


def test_a_normal_guard_still_reports_rc_and_stdout():
    proc = nbci.run_guard_bounded(["-c", "print('hello from guard')"], cwd=Path.cwd(),
                                  timeout=30)
    assert proc.returncode == 0
    assert "hello from guard" in proc.stdout
    assert getattr(proc, "timed_out", False) is False


def test_a_prompting_guard_reads_eof_instead_of_waiting_on_us():
    # stdin=DEVNULL: input() raises EOFError immediately rather than blocking on the parent
    proc = nbci.run_guard_bounded(
        ["-c", "import sys\nprint('eof' if sys.stdin.read() == '' else 'data')"],
        cwd=Path.cwd(), timeout=10)
    assert proc.returncode == 0
    assert "eof" in proc.stdout


# Same shape as GUARD_WITH_GRANDCHILD, short sleeps: used when the kill is DISABLED, so both
# processes die by themselves once the test is over instead of outliving it.
GUARD_WITH_GRANDCHILD_SHORT = (
    "import subprocess, sys, time\n"
    "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(12)'])\n"
    "print('guard alive', flush=True)\n"
    "time.sleep(12)\n"
)

# What a row says about the kill and about the post-kill read -- every word of it measured.
# The optional `[...]` is `kill_detail`: what the kill command said when the tree kill fell back.
NOTE_RE = r"TimeoutExpired after {timeout:g}s \((?P<kill>[a-z ]+)(?P<detail> \[[^\]]*\])?, " \
          r"pipe (?P<how>closed|abandoned) after (?P<wait>\d+\.\d)s\): "


def test_the_kill_takes_the_whole_tree_so_the_pipe_closes():
    proc = nbci.run_guard_bounded(["-c", GUARD_WITH_GRANDCHILD], cwd=Path.cwd(),
                                  timeout=2, grace=10)
    assert proc.timed_out is True
    note = nbci._timed_out_note(proc, 2)
    # The CONTRACT is the pipe's holder being dead, not `taskkill`'s exit code: a surviving
    # grandchild keeps the pipe, so the read would run the grace out and be abandoned.
    assert proc.pipe_abandoned is False, note
    assert proc.grace_wait_s < 10, note
    assert "guard alive" in (proc.stdout or "")         # what was read before the deadline is kept
    # taskkill's verdict on a tree walk is an instrument: when it falls back, the row says why.
    assert proc.kill_how == "tree" or (proc.kill_how == "child" and proc.kill_detail), \
        f"a fallback must say why: {note}"


# A guard that spawns a grandchild and RETURNS: at the deadline the guard is already gone and the
# orphan keeps the inherited pipe. Short sleep, so it dies by itself once the test is over.
GUARD_THAT_EXITS_AND_LEAVES_A_CHILD = (
    "import subprocess, sys\n"
    "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(9)'])\n"
    "print('guard alive', flush=True)\n"
)


def test_a_guard_that_already_exited_is_not_reported_as_killed():
    # Measured 28/11, 10 of 10 trials: `taskkill /T` answers 128 "not found" for a pid that is
    # gone -- it walks the tree from a LIVE parent. The first version turned that into
    # "child killed only": a kill that never happened, and an orphan nobody was told about.
    proc = nbci.run_guard_bounded(["-c", GUARD_THAT_EXITS_AND_LEAVES_A_CHILD], cwd=Path.cwd(),
                                  timeout=2, grace=2)
    assert proc.timed_out is True
    assert proc.kill_how == "exited", (proc.kill_how, proc.kill_detail)
    assert proc.kill_detail is None                     # nothing was attempted: nothing to explain
    assert proc.pipe_abandoned is True                  # the orphan holds the pipe: said, not hidden
    assert 1.9 <= proc.grace_wait_s < 10, proc.grace_wait_s
    assert nbci._timed_out_note(proc, 2) == \
        "TimeoutExpired after 2s (child already exited, pipe abandoned after 2.0s): "


def test_a_live_child_whose_tree_kill_failed_falls_alone_and_says_what_the_kill_command_did(
        monkeypatch):
    # The fallback path itself, forced on a LIVE child (the real one needs taskkill to fail,
    # which happened once in a CI selection and never under load): only the child falls, the
    # grandchild keeps the pipe, and the record carries the kill command's own words.
    asked = []

    def _failed_tree_kill(pid):
        asked.append(pid)
        return 1, f"taskkill exit 1: pid {pid} refusé"

    monkeypatch.setattr(nbci, "_taskkill_tree", _failed_tree_kill)
    proc = nbci.run_guard_bounded(["-c", GUARD_WITH_GRANDCHILD_SHORT], cwd=Path.cwd(),
                                  timeout=1, grace=2)
    assert proc.timed_out is True
    assert len(asked) == 1, "the tree kill is asked once, for the guard's own pid"
    assert proc.kill_how == "child"
    assert proc.kill_detail == f"taskkill exit 1: pid {asked[0]} refusé"
    assert proc.pipe_abandoned is True and 1.9 <= proc.grace_wait_s < 10
    assert nbci._timed_out_note(proc, 1) == \
        f"TimeoutExpired after 1s (child killed only [taskkill exit 1: pid {asked[0]} refusé], " \
        "pipe abandoned after 2.0s): "


def test_a_fallback_that_said_something_lands_in_the_row_prefix():
    # The unexplained `child` of 28/11: the next one must arrive with the kill command's words.
    import re

    class _Run:                        # what run_guard_bounded hands back, attribute for attribute
        pass

    proc = _Run()
    proc.timed_out, proc.kill_how, proc.kill_detail = True, "child", "taskkill exit 1: Accès refusé."
    proc.pipe_abandoned, proc.grace_wait_s = True, 30.0
    note = nbci._timed_out_note(proc, 900)
    m = re.fullmatch(NOTE_RE.format(timeout=900) + r"verdict\n", note + "verdict\n")
    assert m, note
    assert (m["kill"], m["detail"], m["how"]) == (
        "child killed only", " [taskkill exit 1: Accès refusé.]", "abandoned")
    proc.kill_how, proc.kill_detail = "tree", None
    assert nbci._timed_out_note(proc, 900) == \
        "TimeoutExpired after 900s (tree killed, pipe abandoned after 30.0s): "
    assert nbci._kill_detail("a  b\n\nc\t d") == "a b c d"
    assert len(nbci._kill_detail("x" * 500)) == nbci.KILL_DETAIL_CAP == 120
    assert nbci._kill_detail(None) == ""


def test_a_pipe_that_outlives_the_grace_is_reported_as_abandoned(monkeypatch):
    # Only the child falls (the tree kill is faked as failed): the grandchild keeps the pipe
    # open past the grace -- the ONE shape where "abandoned" is true.
    import re
    monkeypatch.setattr(nbci, "_kill_guard_tree", lambda proc: ("child", None))
    proc = nbci.run_guard_bounded(["-c", GUARD_WITH_GRANDCHILD_SHORT], cwd=Path.cwd(),
                                  timeout=1, grace=3)
    assert proc.timed_out is True and proc.pipe_abandoned is True
    assert 2.9 <= proc.grace_wait_s < 10, proc.grace_wait_s      # the wait ran the grace out
    note = nbci._timed_out_note(proc, 1)
    m = re.fullmatch(NOTE_RE.format(timeout=1), note)
    assert m and (m["kill"], m["how"]) == ("child killed only", "abandoned"), note


def test_a_closed_pipe_is_reported_as_closed_with_its_measured_wait(monkeypatch, tmp_path):
    import re
    monkeypatch.setattr(nbci, "GUARDS", (("wedge", ["-c", GUARD_WITH_GRANDCHILD]),))
    monkeypatch.setattr(nbci, "GUARD_TIMEOUT_S", 2)
    monkeypatch.setattr(nbci, "GUARD_KILL_GRACE_S", 20)
    row = nbci.replay_guards(tmp_path)[0]
    assert row["rc"] is None and row["timed_out"] is True
    m = re.fullmatch(NOTE_RE.format(timeout=2) + r"guard alive\n", row["tail"])
    assert m, row["tail"]
    assert (m["kill"], m["how"]) == ("tree killed", "closed")
    assert float(m["wait"]) < 20, "the wait reported is the grace, not what was measured"
    assert row["tail"].endswith("guard alive\n")        # the END of the output survives the prefix


def test_a_guard_that_finishes_carries_no_timeout(monkeypatch, tmp_path):
    monkeypatch.setattr(nbci, "GUARDS", (("fast", ["-c", "print('all good')"]),))
    row = nbci.replay_guards(tmp_path)[0]
    assert (row["rc"], row["timed_out"], row["tail"]) == (0, False, "all good\n")


def test_a_prefix_eats_the_head_of_the_output_never_its_verdict():
    out = "".join(f"line {i:03d}\n" for i in range(60))            # 540 chars
    prefix = "TimeoutExpired after 900s (tree killed, pipe closed after 0.1s): "
    tail = nbci._tail_with_prefix(prefix, out)
    assert len(prefix) + len(out) > nbci.GUARD_TAIL_CAP == 400
    assert len(tail) == 400 and tail.startswith(prefix)
    assert tail.endswith("line 059\n")            # the last line -- the guard's verdict
    assert "line 000" not in tail                 # the head is what the prefix eats
    assert nbci._tail_with_prefix("", "abc") == "abc"
    assert nbci._tail_with_prefix(prefix, "") == prefix
    assert len(nbci._tail_with_prefix("x" * 500, out)) == 400      # never raises, never overflows
