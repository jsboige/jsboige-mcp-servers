# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_detach.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for detached driver launch (21/11).

Measured 21/11 00:45Z: stopping the scheduler's background task killed both drivers
in flight (MGS-25 at 1,464 s, MGS-28 at 283 s), because the stop walks the process
tree. A direct child died whatever its creation flags; only a child of an
intermediate process that had already exited survived. The scheduler now starts every
driver through that intermediate, nb_coder_detach.py, and tracks it by pid and create
time like an adopted driver.
"""
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_scheduler", HERE / "nb_coder_scheduler.py")
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)
_dspec = importlib.util.spec_from_file_location("nb_coder_detach", HERE / "nb_coder_detach.py")
D = importlib.util.module_from_spec(_dspec)
_dspec.loader.exec_module(D)

psutil = pytest.importorskip("psutil")

NB = "MyIA.AI.Notebooks/X/Y.ipynb"
KEY = f"#27133:{NB}"


def _sched(tmp_path, *extra, probe=None, clock=None):
    q = tmp_path / "queue.jsonl"
    q.write_text(json.dumps({"issue": 27133, "notebook": NB}) + "\n", encoding="utf-8")
    args = S.parse_args(["--queue", str(q), "--state-dir", str(tmp_path / "state"),
                         "--repo", "D:/CoursIA", "--max-active", "4", *extra])
    sched = S.Scheduler(args, gate=lambda: {"verdict": "green", "running": 0,
                                            "waiting": 0, "preemptions": 0},
                        sleep=lambda s=0: None, clock=clock, probe=probe)
    items, digest = S.load_queue(q)
    sched.merge_queue(items, digest)
    return sched


def _events(sched, kind):
    if not sched.journal_path.is_file():
        return []
    return [json.loads(l) for l in sched.journal_path.read_text(encoding="utf-8").splitlines()
            if json.loads(l)["kind"] == kind]


def _kill(pid):
    try:
        psutil.Process(pid).kill()
    except psutil.NoSuchProcess:
        pass


def _wait_gone(proc, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return True
        time.sleep(0.2)
    return False


def _driver_cmd(out_dir, body):
    return [sys.executable, "-c", body, "--out-dir", str(out_dir)]


# ------------------------------------------------------------------ the default
def test_detach_is_the_default_and_can_be_turned_off(tmp_path):
    q = tmp_path / "q.jsonl"
    base = ["--queue", str(q), "--state-dir", str(tmp_path), "--repo", "R", "--max-active", "1"]
    assert S.parse_args(base).detach_drivers is True
    assert S.parse_args(base + ["--no-detach-drivers"]).detach_drivers is False


# ------------------------------------------------------------------ the launcher
def test_launcher_refuses_a_bad_argv(capsys):
    assert D.main(["only-a-log"]) == 1
    assert "usage" in json.loads(capsys.readouterr().out)["error"]
    # a runnable command after a missing separator is still refused, never run
    assert D.main(["log", "not-a-separator", sys.executable, "-c", "pass"]) == 1


def test_launcher_reports_a_start_failure_as_json(tmp_path, capsys):
    assert D.main([str(tmp_path / "log"), "--", str(tmp_path / "no-such-program.exe")]) == 1
    assert "error" in json.loads(capsys.readouterr().out)


def test_launcher_child_outlives_a_tree_kill_of_its_caller(tmp_path):
    """The 21/11 measurement as a test: a caller runs the launcher, then the caller's
    whole tree is killed the way TaskStop does it. The detached child survives."""
    pid_file = tmp_path / "pid.json"
    caller = subprocess.Popen([sys.executable, "-c", (
        "import subprocess, sys, time\n"
        f"r = subprocess.run([sys.executable, {str(HERE / 'nb_coder_detach.py')!r}, "
        f"{str(tmp_path / 'sleeper.log')!r}, '--', sys.executable, '-c', "
        "'import time; time.sleep(120)'], capture_output=True, text=True)\n"
        f"open({str(pid_file)!r}, 'w').write(r.stdout)\n"
        "time.sleep(120)\n")])
    try:
        deadline = time.time() + 30
        while not (pid_file.is_file() and pid_file.read_text().strip()):
            assert time.time() < deadline, "launcher never reported"
            time.sleep(0.2)
        child = json.loads(pid_file.read_text().strip().splitlines()[-1])["pid"]
        assert psutil.pid_exists(child)
        root = psutil.Process(caller.pid)
        tree = root.children(recursive=True)
        assert child not in {p.pid for p in tree}, "the child is still inside the caller's tree"
        for p in tree:
            p.kill()
        root.kill()
        caller.wait(timeout=30)
        time.sleep(0.5)
        assert psutil.pid_exists(child) and psutil.Process(child).status() != psutil.STATUS_ZOMBIE
    finally:
        _kill(caller.pid)
        try:
            _kill(json.loads(pid_file.read_text().strip().splitlines()[-1])["pid"])
        except Exception:
            pass


# ------------------------------------------------------------------ the scheduler side
def test_detached_driver_is_tracked_by_pid_and_reaped_from_its_log(tmp_path):
    sched = _sched(tmp_path)
    out = tmp_path / "runs" / "g"
    out.mkdir(parents=True)
    (out / "driver.log").write_bytes(b'{"verdict": "stale-previous-attempt"}\n')
    cmd = _driver_cmd(out, "import json, time; time.sleep(2); "
                           "print(json.dumps({'verdict': 'built-executed-ok'}), flush=True)")
    proc = sched._spawn_driver(cmd)
    try:
        assert isinstance(proc, S.AdoptedDriver)
        assert proc._nb_log_offset == len(b'{"verdict": "stale-previous-attempt"}\n')
        assert proc._create_time > 0
        assert psutil.Process(proc.pid).ppid() != os.getpid(), "driver is our direct child"
        assert proc.poll() is None                         # alive, not yet reaped
        assert _wait_gone(proc)
        assert proc.poll() == S.ADOPTED_RC
        out_text = sched._driver_output({"proc": proc})
        assert "built-executed-ok" in out_text and "stale-previous-attempt" not in out_text
    finally:
        _kill(proc.pid)


def test_launch_records_the_create_time_and_reap_classifies_on_the_verdict(tmp_path):
    sched = _sched(tmp_path)
    out = tmp_path / "runs" / "g"
    sched._launch(KEY, sched.items_by_key[KEY],
                  _driver_cmd(out, "import json; print(json.dumps({'verdict': 'built-executed-ok'}))"),
                  time.time())
    g = sched.state["grains"][KEY]
    assert g["detached"] is True and g["pid"] and g["driver_create_time"]
    proc = sched.active[KEY]["proc"]
    assert _wait_gone(proc)
    sched._reap(time.time())
    assert g["status"] == "done" and g["returncode"] == S.ADOPTED_RC
    assert g["last_verdict"] == "built-executed-ok"


def test_detached_driver_without_a_done_verdict_is_a_run_failure(tmp_path):
    sched = _sched(tmp_path)
    out = tmp_path / "runs" / "g"
    sched._launch(KEY, sched.items_by_key[KEY],
                  _driver_cmd(out, "import sys; sys.exit(0)"), time.time())
    proc = sched.active[KEY]["proc"]
    assert _wait_gone(proc)
    sched._reap(time.time())
    g = sched.state["grains"][KEY]
    # exit 0 is unknowable for a process we did not spawn: no DONE verdict, no done
    assert g["status"] == "failed"
    assert _events(sched, "failed")[-1]["failure_class"] == "run"


def test_without_psutil_the_attached_launch_is_used(tmp_path, monkeypatch):
    sched = _sched(tmp_path)
    monkeypatch.setattr(S, "psutil_available", lambda: False)
    out = tmp_path / "runs" / "g"
    proc = sched._spawn_driver(_driver_cmd(out, "pass"))
    assert isinstance(proc, subprocess.Popen)
    proc.wait(timeout=60)


def test_no_detach_flag_uses_the_attached_launch(tmp_path):
    sched = _sched(tmp_path, "--no-detach-drivers")
    proc = sched._spawn_driver(_driver_cmd(tmp_path / "runs" / "g", "pass"))
    assert isinstance(proc, subprocess.Popen)
    proc.wait(timeout=60)


def test_a_launcher_error_falls_back_to_the_attached_launch(tmp_path, monkeypatch):
    fake = tmp_path / "fake_launcher.py"
    fake.write_text('import json; print(json.dumps({"error": "OSError: refused"}))\n',
                    encoding="utf-8")
    monkeypatch.setattr(S, "DETACH_LAUNCHER", fake)
    sched = _sched(tmp_path)
    proc = sched._spawn_driver(_driver_cmd(tmp_path / "runs" / "g", "pass"))
    assert isinstance(proc, subprocess.Popen)
    proc.wait(timeout=60)
    ev = _events(sched, "detach-failed")
    assert ev and "refused" in ev[-1]["error"]


@pytest.mark.parametrize("stdout", ['{"pid": 0}', '{"pid": true}', '{"pid": "12"}',
                                    "not json", ""])
def test_an_unusable_pid_reply_falls_back(tmp_path, monkeypatch, stdout):
    fake = tmp_path / "fake_launcher.py"
    fake.write_text(f"print({stdout!r})\n", encoding="utf-8")
    monkeypatch.setattr(S, "DETACH_LAUNCHER", fake)
    sched = _sched(tmp_path)
    proc = sched._spawn_driver(_driver_cmd(tmp_path / "runs" / "g", "pass"))
    assert isinstance(proc, subprocess.Popen)
    proc.wait(timeout=60)
    assert _events(sched, "detach-failed")


def test_a_launcher_timeout_is_never_relaunched(tmp_path, monkeypatch):
    def run(*a, **k):
        raise subprocess.TimeoutExpired(a[0], 60)

    def popen(*a, **k):
        raise AssertionError("a timed-out detach must not fall back to a second launch")

    monkeypatch.setattr(S.subprocess, "run", run)
    monkeypatch.setattr(S.subprocess, "Popen", popen)
    sched = _sched(tmp_path)
    sched._launch(KEY, sched.items_by_key[KEY],
                  _driver_cmd(tmp_path / "runs" / "g", "pass"), time.time())
    g = sched.state["grains"][KEY]
    assert g["pid"] is None and g["detached"] is True
    assert _events(sched, "detach-timeout")
    sched._reap(time.time())
    assert g["status"] == "failed"
    assert _events(sched, "failed")[-1]["failure_class"] == "run"


def test_a_driver_that_died_before_the_probe_reaps_at_once(tmp_path, monkeypatch):
    fake = tmp_path / "fake_launcher.py"
    fake.write_text('print(\'{"pid": 2147480000}\')\n', encoding="utf-8")
    monkeypatch.setattr(S, "DETACH_LAUNCHER", fake)
    sched = _sched(tmp_path, probe=lambda pid: None)
    proc = sched._spawn_driver(_driver_cmd(tmp_path / "runs" / "g", "pass"))
    assert isinstance(proc, S.AdoptedDriver) and proc._create_time == 0.0
    assert proc.poll() == S.ADOPTED_RC


# ------------------------------------------------------------------ re-adoption
def _running(tmp_path, **extra):
    log = tmp_path / "driver.log"
    log.write_bytes(b"")
    g = {"issue": 27133, "notebook": NB, "status": "running", "attempts": 1,
         "started": "2026-11-21T01:00:00+00:00", "pid": 777, "driver_log": str(log),
         "driver_log_offset": 0}
    g.update(extra)
    return g


CMD = "python D:/vllm/myia_vllm/scripts/adoption/nb_coder/nb_coder_driver.py --issue 27133"


def test_recorded_create_time_adopts_even_outside_the_launch_window(tmp_path):
    """A detached launch on a loaded host can land outside the 5 s window; the create
    time recorded at launch is the stronger identity and wins."""
    ct = 1_000.0                                     # far from `started`
    sched = _sched(tmp_path, probe=lambda pid: (ct + 0.3, CMD) if pid == 777 else None)
    sched.state["grains"][KEY] = _running(tmp_path, driver_create_time=ct)
    sched._reconcile_previous_runs()
    assert KEY in sched.active and sched.state["grains"][KEY]["adopted"] is True


def test_recorded_create_time_mismatch_refuses_adoption(tmp_path):
    from datetime import datetime
    started = datetime.fromisoformat("2026-11-21T01:00:00+00:00").timestamp()
    # inside the launch window, but not the process recorded at launch
    sched = _sched(tmp_path, probe=lambda pid: (started + 1.0, CMD) if pid == 777 else None)
    sched.state["grains"][KEY] = _running(tmp_path, driver_create_time=started - 3.0)
    sched._reconcile_previous_runs()
    assert KEY not in sched.active
    g = sched.state["grains"][KEY]
    assert g["status"] == "orphaned"
    assert "create time differs" in _events(sched, "orphaned")[-1]["reason"]
