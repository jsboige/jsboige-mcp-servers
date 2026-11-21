# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 9683ab2f5165f374bbb387132288c2cbf7cc6084
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_adopt.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for hot adoption of live drivers by a restarted scheduler (20/11).

A scheduler restarted on new code used to mark every running grain orphaned, so the
grains in flight became terminal and a code change had to wait for the whole lot.
Measured 20/11: a driver survives the death of the scheduler that launched it. The
restarted scheduler now adopts a driver that is still the process it launched (same
pid, create time inside the launch window, driver command line), watches it by pid
and reads its verdict from its driver.log, from the offset of the attempt.
"""
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_scheduler", HERE / "nb_coder_scheduler.py")
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)

NB = "MyIA.AI.Notebooks/X/Y.ipynb"
KEY = f"#27133:{NB}"
STARTED = "2026-11-20T20:35:00+00:00"
T0 = datetime.fromisoformat(STARTED).timestamp()
DRIVER_CMD = "python D:/vllm/myia_vllm/scripts/adoption/nb_coder/nb_coder_driver.py --issue 27133"


class Probe:
    """Fake process table: pid -> (create_time, cmdline); a missing pid is a dead one."""

    def __init__(self, table):
        self.table = dict(table)

    def __call__(self, pid):
        return self.table.get(pid)


def _state(tmp_path, grain, journal=()):
    sd = tmp_path / "state"
    sd.mkdir(parents=True, exist_ok=True)
    (sd / "state.json").write_text(json.dumps({
        "version": 1, "created": STARTED, "grains": {KEY: grain},
        "ramp": S.new_ramp([4], T0, fixed=True),
    }), encoding="utf-8")
    if journal:
        (sd / "scheduler.jsonl").write_text(
            "".join(json.dumps(e) + "\n" for e in journal), encoding="utf-8")
    return sd


def _sched(tmp_path, grain, probe, journal=()):
    sd = _state(tmp_path, grain, journal)
    q = tmp_path / "queue.jsonl"
    q.write_text(json.dumps({"issue": 27133, "notebook": NB}) + "\n", encoding="utf-8")
    args = S.parse_args(["--queue", str(q), "--state-dir", str(sd),
                         "--repo", "D:/CoursIA", "--max-active", "4"])
    sched = S.Scheduler(args, spawn=lambda *a, **k: None,
                        gate=lambda: {"verdict": "green", "running": 0, "waiting": 0,
                                      "preemptions": 0},
                        sleep=lambda s=0: None, clock=lambda: T0 + 600, probe=probe)
    items, digest = S.load_queue(q)
    sched.merge_queue(items, digest)
    return sched


def _grain(log, offset=None, pid=11944, **extra):
    g = {"issue": 27133, "notebook": NB, "status": "running", "attempts": 1,
         "started": STARTED, "pid": pid, "driver_log": str(log)}
    if offset is not None:
        g["driver_log_offset"] = offset
    g.update(extra)
    return g


def _events(sched, kind):
    return [json.loads(l) for l in sched.journal_path.read_text(encoding="utf-8").splitlines()
            if json.loads(l)["kind"] == kind]


def test_live_driver_is_adopted_not_orphaned(tmp_path):
    log = tmp_path / "driver.log"
    log.write_text("", encoding="utf-8")
    probe = Probe({11944: (T0 + 0.4, DRIVER_CMD)})
    sched = _sched(tmp_path, _grain(log, 0), probe)
    sched._reconcile_previous_runs()
    g = sched.state["grains"][KEY]
    assert g["status"] == "running" and g["adopted"] is True
    assert KEY in sched.active
    assert _events(sched, "adopted")[0]["pid"] == 11944
    # still alive: one tick leaves it running and counts it against the ramp
    out = sched.tick()
    assert out["active"] == 1 and g["status"] == "running"


def test_adopted_driver_is_reaped_on_its_verdict_from_the_attempt_offset(tmp_path):
    log = tmp_path / "driver.log"
    old = json.dumps({"verdict": "stage2-review-failed"}) + "\n"
    log.write_text(old, encoding="utf-8")
    offset = len(old.encode())
    probe = Probe({11944: (T0 + 0.4, DRIVER_CMD)})
    sched = _sched(tmp_path, _grain(log, offset), probe)
    sched._reconcile_previous_runs()
    with open(log, "a", encoding="utf-8") as fh:
        fh.write("progress...\n" + json.dumps({"verdict": "pr-created"}) + "\n")
    del probe.table[11944]                       # the driver exits
    sched.tick()
    g = sched.state["grains"][KEY]
    assert g["status"] == "done", g
    assert g["last_verdict"] == "pr-created"
    assert g["returncode"] == S.ADOPTED_RC


def test_a_dead_attempt_does_not_inherit_the_previous_attempts_verdict(tmp_path):
    """The latent bug the offset closes: the log is appended across attempts."""
    log = tmp_path / "driver.log"
    old = json.dumps({"verdict": "pr-created"}) + "\n"      # attempt 1 (say, an old grain)
    log.write_text(old + "Traceback: killed\n", encoding="utf-8")
    probe = Probe({11944: (T0 + 0.4, DRIVER_CMD)})
    sched = _sched(tmp_path, _grain(log, len(old.encode())), probe)
    sched._reconcile_previous_runs()
    del probe.table[11944]
    sched.tick()
    g = sched.state["grains"][KEY]
    assert g["status"] == "failed" and g["last_verdict"] == ""


def test_pid_reused_by_another_program_is_orphaned(tmp_path):
    log = tmp_path / "driver.log"
    log.write_text("", encoding="utf-8")
    sched = _sched(tmp_path, _grain(log, 0), Probe({11944: (T0 + 0.4, "chrome.exe")}))
    sched._reconcile_previous_runs()
    g = sched.state["grains"][KEY]
    assert g["status"] == "orphaned" and KEY not in sched.active
    assert _events(sched, "orphaned")[0]["reason"] == "pid reused by another program"


def test_pid_reused_by_a_later_driver_is_orphaned(tmp_path):
    """Same program, same pid, but started an hour later: another grain's driver."""
    log = tmp_path / "driver.log"
    log.write_text("", encoding="utf-8")
    sched = _sched(tmp_path, _grain(log, 0), Probe({11944: (T0 + 3600, DRIVER_CMD)}))
    sched._reconcile_previous_runs()
    assert sched.state["grains"][KEY]["status"] == "orphaned"


def test_dead_driver_with_a_known_offset_is_classified_from_its_log(tmp_path):
    log = tmp_path / "driver.log"
    log.write_text(json.dumps({"verdict": "verify-approved"}) + "\n", encoding="utf-8")
    sched = _sched(tmp_path, _grain(log, 0), Probe({}))
    sched._reconcile_previous_runs()
    assert sched.state["grains"][KEY]["adopted"] is True
    sched.tick()
    assert sched.state["grains"][KEY]["status"] == "done"


def test_dead_driver_without_an_offset_stays_orphaned(tmp_path):
    log = tmp_path / "driver.log"
    log.write_text(json.dumps({"verdict": "pr-created"}) + "\n", encoding="utf-8")
    sched = _sched(tmp_path, _grain(log), Probe({}))     # legacy grain, offset unknown
    sched._reconcile_previous_runs()
    assert sched.state["grains"][KEY]["status"] == "orphaned"


def test_legacy_grain_finds_its_log_in_the_journal_launch_event(tmp_path):
    """Grains launched by older code carry no driver_log: the journal names it,
    and the current layout (per-grain run dir) must NOT be used for them."""
    legacy_dir = tmp_path / "runs" / "issue-27133"
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "driver.log").write_text("", encoding="utf-8")
    journal = [
        {"ts": STARTED, "kind": "launched", "key": KEY, "pid": 999,
         "cmd": ["python", "d.py", "--out-dir", str(tmp_path / "runs" / "other")]},
        {"ts": STARTED, "kind": "launched", "key": KEY, "pid": 11944,
         "cmd": ["python", "d.py", "--out-dir", str(legacy_dir)]},
    ]
    g = _grain("x")
    del g["driver_log"]
    sched = _sched(tmp_path, g, Probe({11944: (T0 + 0.4, DRIVER_CMD)}), journal)
    sched._reconcile_previous_runs()
    ev = _events(sched, "adopted")[0]
    assert Path(ev["log"]) == legacy_dir / "driver.log"
    assert sched.state["grains"][KEY]["status"] == "running"


def test_launch_records_what_a_restart_needs(tmp_path):
    class P(S.FakeProc):
        pass
    proc = P(done_after=99)
    proc._nb_driver_log = str(tmp_path / "driver.log")
    proc._nb_log_offset = 123
    sched = _sched(tmp_path, {"issue": 27133, "notebook": NB, "status": "pending",
                              "attempts": 0}, Probe({}))
    sched.spawn = lambda cmd: proc
    sched._launch(KEY, sched.items_by_key[KEY], ["x"], T0)
    g = sched.state["grains"][KEY]
    assert g["driver_log"] == proc._nb_driver_log and g["driver_log_offset"] == 123
    assert "adopted" not in g


def test_spawn_driver_records_the_offset_before_appending(tmp_path, monkeypatch):
    out = tmp_path / "run"
    out.mkdir()
    (out / "driver.log").write_bytes(b"previous attempt\n")
    seen = {}

    class Popen:
        def __init__(self, cmd, stdout=None, stderr=None):
            seen["cmd"] = cmd
            self.pid = 1

    monkeypatch.setattr(S.subprocess, "Popen", Popen)
    sched = _sched(tmp_path, {"issue": 27133, "notebook": NB, "status": "pending"}, Probe({}))
    proc = S.Scheduler._spawn_driver(sched, ["python", "--out-dir", str(out)])
    assert proc._nb_log_offset == len(b"previous attempt\n")


def test_default_probe_answers_for_this_process_and_none_for_a_dead_pid():
    import os
    ident = S.process_identity(os.getpid())
    if ident is not None:                      # psutil present
        assert ident[0] > 0 and "python" in ident[1].lower()
    assert S.process_identity(2 ** 30) is None
