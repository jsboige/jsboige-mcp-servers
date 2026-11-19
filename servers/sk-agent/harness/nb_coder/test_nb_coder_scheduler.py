#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 8c0e0230e37e1543dcdaf3f0a00f5de8857273e7
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_scheduler.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Offline tests for nb_coder_scheduler.py — fake gate, fake driver, no engine,
no GitHub writes (#468). Run: python -m pytest test_nb_coder_scheduler.py -q
from this directory."""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "nb_coder_scheduler", HERE / "nb_coder_scheduler.py")
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)

GREEN = {"verdict": "green", "running": 0, "waiting": 0, "preemptions": 0}


def write_queue(tmp_path: Path, lines: list[dict]) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    q = tmp_path / "queue.jsonl"
    q.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
    return q


def make_sched(tmp_path, items, gate=None, spawn=None, ramp=None,
               max_active=2, **arg_overrides):
    queue = write_queue(tmp_path, items)
    args = S.parse_args([
        "--queue", str(queue), "--state-dir", str(tmp_path / "state"),
        "--repo", "D:/CoursIA", "--max-active", str(max_active)])
    if ramp:
        args.ramp = ramp
        args.max_active = 0
    for k, v in arg_overrides.items():
        setattr(args, k, v)
    sched = S.Scheduler(args, spawn=spawn, gate=gate or (lambda: dict(GREEN)),
                        sleep=lambda s=0: None, clock=lambda: 1000.0)
    loaded, digest = S.load_queue(queue)
    sched.merge_queue(loaded, digest)
    sched._save_state()      # a reborn instance must see this queue in state.json
    return sched


class SpawnRecorder:
    def __init__(self, verdict="built-executed-ok", rc=0, done_after=2):
        self.calls = []
        self.verdict, self.rc, self.done_after = verdict, rc, done_after

    def __call__(self, cmd):
        self.calls.append(cmd)
        return S.FakeProc(self.verdict, self.rc, self.done_after)


def item(n):
    return {"issue": n, "notebook": f"Dir/N{n}.ipynb"}


# ---------------------------------------------------------------- queue validation
def test_queue_rejects_unknown_field(tmp_path):
    q = tmp_path / "q.jsonl"
    q.write_text(json.dumps({"issue": 1, "notebook": "A.ipynb",
                             "notebok": "typo.ipynb"}) + "\n")
    with pytest.raises(S.QueueError, match="unknown field"):
        S.load_queue(q)


def test_queue_rejects_duplicate_and_bad_paths(tmp_path):
    q = tmp_path / "q.jsonl"
    q.write_text(json.dumps(item(1)) + "\n" + json.dumps(item(1)) + "\n")
    with pytest.raises(S.QueueError, match="duplicate"):
        S.load_queue(q)
    q.write_text(json.dumps({"issue": 2, "notebook": "../escape.ipynb"}) + "\n")
    with pytest.raises(S.QueueError, match="repo-relative"):
        S.load_queue(q)
    q.write_text(json.dumps({"issue": 3, "notebook": "A.ipynb",
                             "claim": "yes"}) + "\n")
    with pytest.raises(S.QueueError, match="must be bool"):
        S.load_queue(q)


# ---------------------------------------------------------------- admission
def test_green_launches_only_up_to_target(tmp_path):
    spawn = SpawnRecorder(done_after=99)     # stays in flight
    sched = make_sched(tmp_path, [item(i) for i in (1, 2, 3)], spawn=spawn,
                       max_active=2)
    r = sched.tick()
    assert r["launched"] == 2 and len(spawn.calls) == 2 and r["active"] == 2
    assert r["held"] == "capacity-target"
    # budget also honours the engine gauge, not just our own children
    sched2 = make_sched(tmp_path / "g", [item(i) for i in (1, 2)], spawn=spawn,
                        gate=lambda: {**GREEN, "running": 2}, max_active=2)
    assert sched2.tick()["launched"] == 0


def test_yellow_red_unknown_hold_new_launches(tmp_path):
    for verdict in ("yellow", "red", "unknown"):
        spawn = SpawnRecorder()
        sched = make_sched(tmp_path / verdict, [item(1)], spawn=spawn,
                           gate=lambda: {"verdict": verdict, "running": 0})
        r = sched.tick()
        assert r["launched"] == 0 and r["held"] == f"gate-{verdict}"
    assert spawn.calls == []


def test_yellow_never_touches_in_flight(tmp_path):
    gate = {"verdict": "green", "running": 0}
    spawn = SpawnRecorder(done_after=99)
    sched = make_sched(tmp_path, [item(1), item(2)], spawn=spawn,
                       gate=lambda: dict(gate), max_active=2)
    sched.tick()
    assert len(sched.active) == 2
    gate["verdict"] = "yellow"
    r = sched.tick()
    assert r["launched"] == 0 and len(sched.active) == 2  # still alive
    for entry in sched.active.values():
        assert entry["proc"].poll() is None


def test_stop_file_freezes_new_launches(tmp_path):
    spawn = SpawnRecorder()
    sched = make_sched(tmp_path, [item(1)], spawn=spawn)
    Path(sched.args.stop_file).write_text("pause\n")
    r = sched.tick()
    assert r["launched"] == 0 and r["held"] == "stop-file"
    Path(sched.args.stop_file).unlink()
    assert sched.tick()["launched"] == 1


# ---------------------------------------------------------------- deferred / retry
def test_capacity_deferred_is_retried_after_backoff(tmp_path):
    clock = {"t": 1000.0}
    spawn = SpawnRecorder(verdict="deferred-by-capacity-gate", rc=1,
                          done_after=0)
    sched = make_sched(tmp_path, [item(1)], spawn=spawn)
    sched.clock = lambda: clock["t"]
    sched.tick()                                  # launch
    clock["t"] += 10
    sched.tick()                                  # reap -> deferred
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    assert g["status"] == "deferred" and g["attempts"] == 1
    assert g["not_before"] > clock["t"]
    clock["t"] += 5                               # still inside backoff
    assert sched.tick()["launched"] == 0
    clock["t"] = g["not_before"] + 1
    assert sched.tick()["launched"] == 1 and g["attempts"] == 2


def test_attempts_exhausted_becomes_terminal(tmp_path):
    clock = {"t": 1000.0}
    spawn = SpawnRecorder(verdict="deferred-by-capacity-gate", rc=1,
                          done_after=0)
    sched = make_sched(tmp_path, [item(1)], spawn=spawn, max_attempts=1)
    sched.clock = lambda: clock["t"]
    sched.tick()
    clock["t"] += 10
    sched.tick()
    key = "#1:Dir/N1.ipynb"
    assert sched.state["grains"][key]["status"] == "deferred"
    clock["t"] = sched.state["grains"][key]["not_before"] + 1
    sched.tick()                                  # exhausted -> failed, no relaunch
    assert sched.state["grains"][key]["status"] == "failed"
    events = [json.loads(l) for l in
              (sched.state_dir / "scheduler.jsonl").read_text().splitlines()]
    assert any(e["kind"] == "attempts-exhausted" for e in events)


# ---------------------------------------------------------------- ramp
def test_ramp_promotion_measured(tmp_path):
    clock = {"t": 1000.0}
    spawn = SpawnRecorder(done_after=0)
    sched = make_sched(tmp_path, [item(i) for i in (1, 2, 3)], spawn=spawn,
                       ramp=[1, 2], ramp_min_done=2, ramp_green_s=0)
    sched.clock = lambda: clock["t"]
    sched.tick()                                  # launch #1 (step max 1)
    clock["t"] += 1
    sched.tick()                                  # reap #1 done, launch #2
    clock["t"] += 1
    sched.tick()                                  # reap #2 -> promote -> launch #3 at target 2
    assert sched.state["ramp"]["max_active"] == 2
    assert sched.state["ramp"]["done"] == 0        # counters reset for step 2
    assert sched.state["ramp_history"][-1]["promoted_to"] == 2
    assert len(spawn.calls) == 3
    clock["t"] += 1
    sched.tick()                                  # step 2 holds until re-proven
    assert sched.state["ramp"]["max_active"] == 2


def test_red_gates_block_promotion_and_demote(tmp_path):
    clock = {"t": 1000.0}
    gate = {"verdict": "green", "running": 0}
    spawn = SpawnRecorder(done_after=0)
    sched = make_sched(tmp_path, [item(i) for i in (1, 2, 3)], spawn=spawn,
                       gate=lambda: dict(gate), ramp=[1, 2], ramp_min_done=1,
                       ramp_green_s=1, ramp_demote=True)
    sched.clock = lambda: clock["t"]
    sched.tick()
    clock["t"] += 1
    sched.tick()                                  # done=1, green 1s -> promoted to 2
    assert sched.state["ramp"]["max_active"] == 2
    gate["verdict"] = "red"
    clock["t"] += 1
    sched.tick()                                  # demotion one step down
    assert sched.state["ramp"]["max_active"] == 1
    assert sched.state["ramp"]["dirty"] is False   # reset with the demotion
    gate["verdict"] = "green"
    clock["t"] += 1
    sched.tick()
    assert sched.state["ramp"]["max_active"] == 1  # green clock restarted at demotion


# ---------------------------------------------------------------- persistence
def test_previous_run_running_grain_marked_orphaned(tmp_path):
    sched = make_sched(tmp_path, [item(1)], spawn=SpawnRecorder(done_after=0))
    sched.run()                                   # queue drains cleanly
    # simulate a scheduler that died mid-grain
    key = "#1:Dir/N1.ipynb"
    sched.state["grains"][key].update({"status": "running", "pid": 123})
    sched._save_state()
    # reborn instance: gate forced red so the offline test never touches /metrics
    reborn = S.Scheduler(sched.args, gate=lambda: {"verdict": "red"},
                         sleep=lambda: None, clock=lambda: 2000.0)
    reborn.merge_queue(*S.load_queue(sched.args.queue))
    reborn.run()
    assert reborn.state["grains"][key]["status"] == "orphaned"
    assert reborn.state["grains"][key]["status"] != "pending"  # never auto-relaunched


def test_withdrawn_then_readded_is_requeued(tmp_path):
    sched = make_sched(tmp_path, [item(1), item(2)])   # no run: merge only
    args = sched.args
    q1 = write_queue(tmp_path, [item(1)])              # N2 disappears
    args.queue = q1
    sched2 = S.Scheduler(args, gate=lambda: {"verdict": "red"},
                         sleep=lambda: None, clock=lambda: 1.0)
    sched2.merge_queue(*S.load_queue(q1))
    assert sched2.state["grains"]["#2:Dir/N2.ipynb"]["status"] == "withdrawn"
    q2 = write_queue(tmp_path, [item(1), item(2)])     # N2 comes back
    args.queue = q2
    sched3 = S.Scheduler(args, gate=lambda: {"verdict": "red"},
                         sleep=lambda: None, clock=lambda: 1.0)
    sched3.merge_queue(*S.load_queue(q2))
    assert sched3.state["grains"]["#2:Dir/N2.ipynb"]["status"] == "pending"


def test_dry_run_logs_command_without_spawning(tmp_path):
    spawn = SpawnRecorder()
    sched = make_sched(tmp_path, [item(1)], spawn=spawn, dry_run=True)
    r = sched.tick()
    assert r["launched"] == 0 and spawn.calls == []
    events = [json.loads(l) for l in
              (sched.state_dir / "scheduler.jsonl").read_text().splitlines()]
    dry = [e for e in events if e["kind"] == "dry-launch"]
    assert dry and "--gate-mode" in dry[0]["cmd"] and "--issue" in dry[0]["cmd"]
    assert sched.state["grains"]["#1:Dir/N1.ipynb"]["status"] == "pending"


def test_driver_command_carries_known_fields_only(tmp_path):
    sched = make_sched(tmp_path, [{
        "issue": 42, "notebook": "A/B.ipynb", "max_stage": 2, "claim": True,
        "agent": "notebook-coder", "intention": "test"}],
        lane="myia-ai-01:nb-coder", claim=True)
    cmd = sched.driver_command(sched.items_by_key["#42:A/B.ipynb"])
    joined = " ".join(cmd)
    assert "--issue 42" in joined and "--notebook A/B.ipynb" in joined
    assert "--claim" in joined and "--lane myia-ai-01:nb-coder" in joined
    assert "--gate-mode block" in joined
    assert "--max-stage 2" in joined


def test_driver_command_passes_creation_fields(tmp_path):
    """Wave-1 parity grains are CREATIONS: the queue carries source_nb + kernel_override
    + repair_rounds per item, and driver_command must forward them to the driver."""
    sched = make_sched(tmp_path, [{
        "issue": 27099, "notebook": "Ser/Z3-10-CSharp.ipynb",
        "source_nb": "Ser/Z3-10-Python.ipynb", "kernel_override": ".net-csharp",
        "max_stage": 3, "repair_rounds": 2}],
        lane="myia-ai-01:nb-coder")
    cmd = sched.driver_command(sched.items_by_key["#27099:Ser/Z3-10-CSharp.ipynb"])
    joined = " ".join(cmd)
    assert "--source-nb Ser/Z3-10-Python.ipynb" in joined
    assert "--kernel-override .net-csharp" in joined
    assert "--max-stage 3" in joined and "--repair-rounds 2" in joined
    # no item value -> the scheduler default applies; None default means the flag
    # is OMITTED (a correction grain must not inherit a creation source_nb)
    sched2 = make_sched(tmp_path, [{
        "issue": 43, "notebook": "A/C.ipynb", "max_stage": 2}])
    joined2 = " ".join(sched2.driver_command(sched2.items_by_key["#43:A/C.ipynb"]))
    assert "--source-nb" not in joined2


def test_parse_args_makes_driver_paths_absolute():
    # 17/11 21:30Z wave-1 incident: a relative --state-dir produced a relative
    # --worktree path, which `git -C <repo> worktree add` resolved against the
    # REPO root while the driver resolved it against its own cwd -> 10/10 grains
    # failed source-nb-not-found on worktrees that DID exist (under <repo>/.tmp).
    args = S.parse_args(["--queue", "q.jsonl", "--state-dir", "rel-state",
                         "--repo", "D:/CoursIA", "--max-active", "2"])
    for name in ("state_dir", "out_root", "worktree_root"):
        assert Path(getattr(args, name)).is_absolute(), name


def test_spawn_driver_writes_log_file_and_reap_reads_it(tmp_path):
    """Wave-1b hang (18/11 00:27->03:35Z): PIPE + read-at-reap meant nobody
    drained the driver's output while it ran; a chatty MCP child filled the
    64 KiB pipe and deadlocked the handshake. The fix redirects driver output
    to runs/issue-N/driver.log — this pins both the redirect and the reap-side
    reader (verdict parsed from the FILE, not from a pipe)."""
    import subprocess as sp
    sched = make_sched(tmp_path, [item(1)], spawn=SpawnRecorder())
    sched.args.out_root = str(tmp_path / "runs")
    out_dir = tmp_path / "runs" / "issue-1"
    cmd = [sys.executable, "-c",
           "import json; print(json.dumps({'verdict': 'built-executed-ok'}))",
           "--out-dir", str(out_dir)]     # extra argv: for _spawn_driver to find
    proc = sched._spawn_driver(cmd)
    rc = proc.wait(timeout=60)
    assert rc == 0
    assert getattr(proc, "stdout", None) is None          # file-redirected, not piped
    assert (out_dir / "driver.log").is_file()
    out = sched._driver_output({"proc": proc, "item": item(1)})
    assert "built-executed-ok" in out
    # and the verdict parser still finds the JSON line from the file output
    verdict = ""
    for line in reversed(out.strip().splitlines()):
        if line.strip().startswith("{"):
            verdict = json.loads(line).get("verdict") or ""
            break
    assert verdict == "built-executed-ok"
    del sp  # silence linters; subprocess is used inside _spawn_driver


# ------------------------------------------------- cutover findings (18/11)
def test_gate_mode_off_never_probes(tmp_path):
    """Finding 2: --gate-mode off must not spawn the probe at all (a missing/custom
    probe file used to read as a blocking verdict even with off)."""
    sched = make_sched(tmp_path, [item(1)], gate_mode="off",
                       gate=str(tmp_path / "does-not-exist.py"))
    sched.gate = sched._probe_gate            # bypass the injected fake
    out = sched._probe_gate()
    assert out["verdict"] == "green" and out["gate_mode"] == "off"


def test_missing_gate_probe_is_unknown_not_green(tmp_path):
    """Finding 2: a missing probe file must NOT read as green (fail loud, named)."""
    sched = make_sched(tmp_path, [item(1)])
    sched.args.gate = str(tmp_path / "absent.py")
    out = sched._probe_gate()
    assert out["verdict"] == "unknown" and "not found" in out["error"]


def test_gate_default_reads_env_nbcoder_gate(tmp_path, monkeypatch):
    """Finding 2: a custom probe path via NBCODER_GATE env must be honoured."""
    monkeypatch.setenv("NBCODER_GATE", str(tmp_path / "custom_gate.py"))
    args = S.parse_args(["--queue", "q.jsonl", "--state-dir", "s",
                         "--repo", "D:/CoursIA", "--max-active", "2"])
    assert Path(args.gate) == tmp_path / "custom_gate.py"


def test_driver_command_propagates_resolved_gate(tmp_path):
    """Round 2 (finding 2): the scheduler's resolved --gate (explicit or $NBCODER_GATE)
    must reach the DRIVER child via its own --gate flag — the child's env default only
    fires when the operator exported the var, which a CLI-only custom path never did."""
    custom = tmp_path / "seat_gate.py"
    sched = make_sched(tmp_path / "g", [item(1)])
    sched.args.gate = str(custom)       # post-construction: "gate" is the injected
    #                                  probe callable in make_sched's signature, an
    #                                  arg_overrides passthrough would never land here
    cmd = sched.driver_command(sched.items_by_key["#1:Dir/N1.ipynb"])
    joined = " ".join(cmd)
    assert f"--gate {custom}" in joined


def test_watch_run_picks_up_appended_grain(tmp_path):
    """Finding 3, ROUND 2 — this test goes through run() itself. The previous version
    called load_queue/merge_queue manually and stayed green with the reload deleted
    from run(); here the ONLY path grain #2 can take into spawn.calls is the watch
    branch's reload inside run(). Mutation witness: remove that reload -> the grain
    appended by the fake sleep is never merged -> never launched -> this FAILS."""
    clock = {"t": 1000.0}
    state = {"appended": False}
    spawn = SpawnRecorder(done_after=0)
    sched = make_sched(tmp_path, [item(1)], spawn=spawn)
    sched.args.watch = True
    sched.args.timeout_s = 40          # deadline = 1040 -> bounded run()
    sched.clock = lambda: clock["t"]

    def fake_sleep(_s=0):
        if not state["appended"]:
            state["appended"] = True
            # the operator appends grain #2 to the SAME queue file mid-run
            write_queue(tmp_path, [item(1), item(2)])
        clock["t"] += 10
    sched.sleep = fake_sleep
    sched.run()                        # returns at the timeout deadline

    assert state["appended"]
    launched = {c[c.index("--issue") + 1] for c in spawn.calls if "--issue" in c}
    assert "2" in launched, "appended grain never launched: run() reload missing?"
    assert sched.state["grains"]["#2:Dir/N2.ipynb"]["status"] in ("done", "failed")
    events = [json.loads(l) for l in
              (sched.state_dir / "scheduler.jsonl").read_text().splitlines()]
    assert any(e["kind"] == "queue-reloaded" for e in events)



if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
