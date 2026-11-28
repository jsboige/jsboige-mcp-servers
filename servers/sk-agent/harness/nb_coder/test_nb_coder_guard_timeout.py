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
