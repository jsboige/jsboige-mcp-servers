#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77
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


SPEC_ITEM = {"issue": 27460, "notebook": "IC/IT/IT-08.ipynb", "from_spec": True,
             "meta_from": "Cx/Cx-03c.ipynb", "max_stage": 5, "claim": True}


def test_driver_command_passes_spec_fields(tmp_path):
    """A no-twin creation grain (--from-spec) forwards --from-spec + --meta-from and
    never the scheduler's default --source-nb (the driver refuses the pair)."""
    sched = make_sched(tmp_path, [dict(SPEC_ITEM)], lane="myia-ai-01:nb-coder",
                       source_nb="Default/Twin.ipynb")
    cmd = sched.driver_command(sched.items_by_key["#27460:IC/IT/IT-08.ipynb"])
    joined = " ".join(cmd)
    assert "--from-spec" in cmd and "--meta-from Cx/Cx-03c.ipynb" in joined
    assert "--source-nb" not in joined
    assert "--claim" in cmd and "--max-stage 5" in joined
    # a twin grain next to it keeps the scheduler default and gets no spec flag
    sched2 = make_sched(tmp_path / "t", [{"issue": 44, "notebook": "A/D.ipynb"}],
                        source_nb="Default/Twin.ipynb")
    cmd2 = sched2.driver_command(sched2.items_by_key["#44:A/D.ipynb"])
    assert "--from-spec" not in cmd2 and "--meta-from" not in cmd2
    assert "--source-nb Default/Twin.ipynb" in " ".join(cmd2)


@pytest.mark.parametrize("patch,match", [
    ({"source_nb": "A/Twin.ipynb"}, "exclusive"),
    ({"meta_from": None}, "requires meta_from"),
    ({"write_mode": "mcp"}, "write_mode json"),
    ({"from_spec": False}, "only read in creation mode"),
    ({"meta_from": "../out.ipynb"}, "meta_from must be repo-relative"),
    ({"meta_from": "C:/abs.ipynb"}, "meta_from must be repo-relative"),
    ({"meta_from": "Cx/notes.md"}, "meta_from must be a repo-relative .ipynb"),
    ({"from_spec": "yes"}, "must be bool"),
])
def test_queue_rejects_bad_spec_grain(tmp_path, patch, match):
    it = dict(SPEC_ITEM)
    for k, v in patch.items():
        if v is None:
            it.pop(k)
        else:
            it[k] = v
    q = tmp_path / "q.jsonl"
    q.write_text(json.dumps(it) + "\n")
    with pytest.raises(S.QueueError, match=match):
        S.load_queue(q)


def test_port_grain_forwards_meta_from(tmp_path):
    """A twin port may name its metadata source: the first Rust notebook of a series has
    no *-Rust sibling to inherit from (claudish PROPOSAL 20/11)."""
    port = {"issue": 45, "notebook": "Su/Su-02-X-Rust.ipynb",
            "source_nb": "Su/Su-02-X.ipynb", "meta_from": "Su/Su-01-Rust.ipynb"}
    q = tmp_path / "q.jsonl"
    q.write_text(json.dumps(port) + "\n")
    items, _ = S.load_queue(q)
    assert items[0]["meta_from"] == "Su/Su-01-Rust.ipynb"
    sched = make_sched(tmp_path / "s", [dict(port)])
    joined = " ".join(sched.driver_command(sched.items_by_key["#45:Su/Su-02-X-Rust.ipynb"]))
    assert "--source-nb Su/Su-02-X.ipynb" in joined
    assert "--meta-from Su/Su-01-Rust.ipynb" in joined and "--from-spec" not in joined


def test_queue_refuses_meta_from_on_a_correction(tmp_path):
    q = tmp_path / "q.jsonl"
    q.write_text(json.dumps({"issue": 46, "notebook": "A/E.ipynb",
                             "meta_from": "A/M.ipynb"}) + "\n")
    with pytest.raises(S.QueueError, match="only read in creation mode"):
        S.load_queue(q)


def test_queue_accepts_spec_grain(tmp_path):
    q = tmp_path / "q.jsonl"
    q.write_text(json.dumps(SPEC_ITEM) + "\n")
    items, _ = S.load_queue(q)
    assert items[0]["from_spec"] is True and items[0]["meta_from"] == "Cx/Cx-03c.ipynb"


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
    sched.args.detach_drivers = False          # pins the attached path (Popen.wait below)
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


# ---------------------------------------------------------------- #506 palier 1: canon
def test_launch_gap_starts_grains_in_canon_not_in_one_tick(tmp_path):
    """Four free slots, three pending grains, gap 300 s, poll 30 s: the grains must
    start at t, t+300, t+600 — never two in the same tick (the cohort of 18/11)."""
    clock = {"t": 1000.0}
    spawn = SpawnRecorder(done_after=99)           # every grain stays in flight
    sched = make_sched(tmp_path, [item(i) for i in (1, 2, 3)], spawn=spawn,
                       max_active=4, launch_gap_s=300.0)
    sched.clock = lambda: clock["t"]
    starts = []
    while clock["t"] <= 1900:
        r = sched.tick()
        starts += [clock["t"]] * r["launched"]
        assert r["launched"] <= 1
        clock["t"] += 30
    assert starts == [1000.0, 1300.0, 1600.0]
    held = [json.loads(l) for l in (sched.state_dir / "scheduler.jsonl").read_text().splitlines()
            if '"held"' in l]
    gaps = [e for e in held if e["reason"] == "launch-gap"]
    assert gaps and all(0 < e["next_launch_in_s"] <= 300 for e in gaps)


def test_zero_gap_keeps_the_old_same_tick_behavior(tmp_path):
    spawn = SpawnRecorder(done_after=99)
    sched = make_sched(tmp_path, [item(i) for i in (1, 2, 3)], spawn=spawn,
                       max_active=4)
    assert sched.tick()["launched"] == 3


def test_launch_gap_survives_a_scheduler_restart(tmp_path):
    clock = {"t": 1000.0}
    spawn = SpawnRecorder(done_after=99)
    first = make_sched(tmp_path, [item(1), item(2)], spawn=spawn, max_active=4,
                       launch_gap_s=300.0)
    first.clock = lambda: clock["t"]
    assert first.tick()["launched"] == 1
    # a new instance on the same state dir, 100 s later: the gap still holds
    clock["t"] = 1100.0
    reborn = S.Scheduler(first.args, spawn=spawn, gate=lambda: dict(GREEN),
                         sleep=lambda s=0: None, clock=lambda: clock["t"])
    loaded, digest = S.load_queue(Path(first.args.queue))
    reborn.merge_queue(loaded, digest)
    r = reborn.tick()
    assert r["launched"] == 0 and r["held"] == "launch-gap"
    clock["t"] = 1300.0
    assert reborn.tick()["launched"] == 1


def test_launch_gap_never_bypasses_the_capacity_target(tmp_path):
    clock = {"t": 1000.0}
    spawn = SpawnRecorder(done_after=99)
    sched = make_sched(tmp_path, [item(i) for i in (1, 2, 3)], spawn=spawn,
                       max_active=1, launch_gap_s=60.0)
    sched.clock = lambda: clock["t"]
    assert sched.tick()["launched"] == 1
    clock["t"] = 2000.0                              # gap long elapsed
    r = sched.tick()
    assert r["launched"] == 0 and r["held"] == "capacity-target"


def test_parse_args_refuses_a_negative_launch_gap(tmp_path):
    with pytest.raises(SystemExit):
        S.parse_args(["--queue", "q.jsonl", "--state-dir", str(tmp_path), "--repo", "R",
                      "--max-active", "2", "--launch-gap-s", "-5"])


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))


# ---------------------------------------------------------------- retry generation
# A failed grain is terminal, and the queue it was alone in cannot be emptied to withdraw
# it (an empty queue is a reload error). Measured 20/11 on CoursIA#27314: the defect that
# failed it was merged (#509) while the scheduler kept it terminal for want of a gesture.
def _events(sched, kind):
    return [json.loads(l) for l in
            (sched.state_dir / "scheduler.jsonl").read_text().splitlines()
            if json.loads(l)["kind"] == kind]


def _requeue(sched, tmp_path, line):
    q = write_queue(tmp_path, [line])
    sched.args.queue = q
    sched.merge_queue(*S.load_queue(q))


def test_a_raised_retry_reoffers_a_failed_grain_once(tmp_path):
    spawn = SpawnRecorder(verdict="built-execution-failed", rc=1, done_after=0)
    sched = make_sched(tmp_path, [item(1)], spawn=spawn)
    sched.run()
    key = "#1:Dir/N1.ipynb"
    assert sched.state["grains"][key]["status"] == "failed"

    _requeue(sched, tmp_path, item(1) | {"retry": 1})
    g = sched.state["grains"][key]
    assert g["status"] == "pending" and g["attempts"] == 0 and g["retry"] == 1
    ev = _events(sched, "requeued")[-1]
    assert ev["retry"] == 1 and ev["previous_attempts"] == 1
    assert ev["previous_verdict"] == "built-execution-failed"

    sched.run()                                   # the retry fails too
    assert len(spawn.calls) == 2
    _requeue(sched, tmp_path, item(1) | {"retry": 1})   # same generation: no second run
    assert sched.state["grains"][key]["status"] == "failed"
    _requeue(sched, tmp_path, item(1) | {"retry": 2})   # a new generation is a new decision
    assert sched.state["grains"][key]["status"] == "pending"


def test_a_retry_never_reruns_a_done_grain(tmp_path):
    sched = make_sched(tmp_path, [item(1)], spawn=SpawnRecorder(done_after=0))
    sched.run()
    key = "#1:Dir/N1.ipynb"
    assert sched.state["grains"][key]["status"] == "done"
    _requeue(sched, tmp_path, item(1) | {"retry": 1})
    assert sched.state["grains"][key]["status"] == "done"
    assert _events(sched, "retry-ignored")[-1]["status"] == "done"


def test_a_retry_written_before_the_failure_is_absorbed(tmp_path):
    # Raised while the grain is still pending, the generation must not fire later on a
    # failure nobody had seen when writing it.
    spawn = SpawnRecorder(verdict="built-execution-failed", rc=1, done_after=0)
    sched = make_sched(tmp_path, [item(1) | {"retry": 1}], spawn=spawn)
    key = "#1:Dir/N1.ipynb"
    assert sched.state["grains"][key]["status"] == "pending"
    sched.run()
    assert sched.state["grains"][key]["status"] == "failed"
    _requeue(sched, tmp_path, item(1) | {"retry": 1})
    assert sched.state["grains"][key]["status"] == "failed"
    assert len(spawn.calls) == 1


def test_retry_is_scheduler_only_and_never_reaches_the_driver(tmp_path):
    sched = make_sched(tmp_path, [item(1) | {"retry": 3}])
    cmd = sched.driver_command(item(1) | {"retry": 3})
    assert "--retry" not in cmd


def test_retry_must_be_an_integer(tmp_path):
    q = tmp_path / "q.jsonl"
    q.write_text(json.dumps(item(1) | {"retry": "1"}) + "\n")
    with pytest.raises(S.QueueError, match="retry must be int"):
        S.load_queue(q)


# ---------------------------------------------------------------- worktree release
class FakeGit:
    """Answers the three git questions of _release_worktree; records every call."""

    def __init__(self, status="", refs="refs/remotes/origin/main\n", remove_rc=0):
        self.calls = []
        self.status, self.refs, self.remove_rc = status, refs, remove_rc

    def __call__(self, argv, timeout=300):
        self.calls.append(argv)
        if "status" in argv:
            return 0, self.status
        if "for-each-ref" in argv:
            return 0, self.refs
        if "remove" in argv:
            return self.remove_rc, "" if self.remove_rc == 0 else "fatal: locked"
        return 1, "unexpected"


def _sched_with_tree(tmp_path, git, verdict="built-executed-ok", rc=0, **over):
    spawn = SpawnRecorder(verdict=verdict, rc=rc, done_after=0)
    sched = make_sched(tmp_path, [item(1)], spawn=spawn, **over)
    sched.git = git
    wt = Path(sched.args.worktree_root) / f"wt-{S.grain_slug(item(1))}"
    wt.mkdir(parents=True)
    return sched, wt


def _removes(git):
    return [c for c in git.calls if "remove" in c]


@pytest.mark.parametrize("verdict,rc", [("built-executed-ok", 0),
                                        ("built-execution-failed", 1)])
def test_a_clean_pushed_tree_is_released_when_the_grain_ends(tmp_path, verdict, rc):
    git = FakeGit()
    sched, wt = _sched_with_tree(tmp_path, git, verdict=verdict, rc=rc)
    sched.run()
    assert len(_removes(git)) == 1
    cmd = _removes(git)[0]
    assert cmd[:4] == ["git", "-C", "D:/CoursIA", "worktree"] and cmd[-1] == str(wt)
    assert "--force" not in cmd and "-f" not in cmd
    assert _events(sched, "worktree-released")[-1]["worktree"] == str(wt)


@pytest.mark.parametrize("git,reason", [
    (FakeGit(status=" M MyIA.AI.Notebooks/X.ipynb\n"), "dirty"),
    (FakeGit(status="?? new.ipynb\n"), "dirty"),
    (FakeGit(refs=""), "head-on-no-remote-ref"),
    (FakeGit(remove_rc=128), "remove-failed"),
])
def test_a_tree_holding_something_unique_is_kept(tmp_path, git, reason):
    sched, wt = _sched_with_tree(tmp_path, git)
    sched.run()
    kept = _events(sched, "worktree-kept")
    assert kept and kept[-1]["reason"] == reason and kept[-1]["worktree"] == str(wt)
    assert not _events(sched, "worktree-released")
    if reason != "remove-failed":
        assert not _removes(git)


def test_keep_worktrees_flag_never_touches_the_tree(tmp_path):
    git = FakeGit()
    sched, _ = _sched_with_tree(tmp_path, git, keep_worktrees=True)
    sched.run()
    assert git.calls == []


def test_a_deferred_or_running_grain_keeps_its_tree(tmp_path):
    git = FakeGit()
    sched, _ = _sched_with_tree(tmp_path, git, verdict="deferred-by-capacity-gate: red",
                                rc=3)
    sched.tick()                                    # launch
    sched.tick()                                    # reap: the driver deferred
    assert sched.state["grains"]["#1:Dir/N1.ipynb"]["status"] == "deferred"
    assert git.calls == []
    spawn = SpawnRecorder(done_after=99)            # stays in flight
    sched2 = make_sched(tmp_path / "b", [item(1)], spawn=spawn)
    sched2.git = git
    (Path(sched2.args.worktree_root) / f"wt-{S.grain_slug(item(1))}").mkdir(parents=True)
    sched2.tick()
    assert git.calls == []


def test_parse_args_keeps_worktrees_off_by_default(tmp_path):
    base = ["--queue", "q.jsonl", "--repo", "D:/CoursIA", "--state-dir", str(tmp_path),
            "--max-active", "1"]
    assert S.parse_args(base).keep_worktrees is False
    assert S.parse_args(base + ["--keep-worktrees"]).keep_worktrees is True


# ---------------------------------------------------------------- same-issue claims (21/11)
def _lot(n, name):
    return {"issue": n, "notebook": f"Lot/{name}.ipynb"}


def test_same_issue_grains_are_not_serialized_by_the_scheduler(tmp_path):
    """The claim race is the reservation window only; the driver locks that window.
    A lot issue must keep several grains in flight (#27134: 2.3b + 2.3d together)."""
    spawn = SpawnRecorder(done_after=99)
    sched = make_sched(tmp_path, [_lot(7, "A"), _lot(7, "B")], spawn=spawn,
                       max_active=2, claim=True)
    assert sched.tick()["launched"] == 2


def test_implicit_occupation_deferral_is_retried_not_failed(tmp_path):
    clock = {"t": 1000.0}
    spawn = SpawnRecorder(verdict="deferred-by-claim-implicit-occupation:#27691",
                          rc=1, done_after=0)
    sched = make_sched(tmp_path, [item(1)], spawn=spawn)
    sched.clock = lambda: clock["t"]
    sched.tick()
    clock["t"] += 10
    sched.tick()
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    assert g["status"] == "deferred" and g["not_before"] > clock["t"]


# ---------------------------------------------------------------- verify-error recovery
PORT = {"issue": 1, "notebook": "Dir/N1-Rust.ipynb", "source_nb": "Dir/N1-Python.ipynb",
        "meta_from": "Dir/M-Rust.ipynb", "claim": True}


def _trace(sched, it):
    d = Path(sched.args.out_root) / f"issue-{S.grain_slug(it)}"
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"issue-{it['issue']}.json"
    p.write_text(json.dumps({"issue": it["issue"], "verdict": "verify-error"}))
    return p


def _flag(cmd, name):
    return cmd[cmd.index(name) + 1] if name in cmd else None


def test_a_verifier_crash_is_resumed_once_from_its_own_trace(tmp_path):
    clock = {"t": 1000.0}
    spawn = SpawnRecorder(verdict="verify-error", rc=1, done_after=0)
    sched = make_sched(tmp_path, [PORT], spawn=spawn)
    sched.clock = lambda: clock["t"]
    trace = _trace(sched, PORT)
    key = S.grain_key(PORT)
    sched.tick()                                  # launch: a full build
    assert "--source-nb" in spawn.calls[0] and "--verify-from" not in spawn.calls[0]
    clock["t"] += 10
    sched.tick()                                  # reap: verify-error -> deferred
    g = sched.state["grains"][key]
    assert g["status"] == "deferred" and g["resume_from"] == str(trace)
    assert g["verify_recoveries"] == 1
    ev = _events(sched, "verify-recovery")[-1]
    assert ev["trace"] == str(trace) and ev["recovery"] == 1
    assert not _events(sched, "failed")
    clock["t"] = g["not_before"] + 1
    assert sched.tick()["launched"] == 1
    cmd = spawn.calls[1]
    # the driver refuses the creation flags next to --verify-from
    assert _flag(cmd, "--verify-from") == str(trace)
    for absent in ("--source-nb", "--meta-from", "--from-spec"):
        assert absent not in cmd
    assert "--claim" in cmd and _flag(cmd, "--issue") == "1"
    clock["t"] += 10
    sched.tick()                                  # the recovery crashes too: failed
    assert g["status"] == "failed" and len(spawn.calls) == 2
    assert len(_events(sched, "verify-recovery")) == 1


def test_a_verifier_crash_without_a_trace_fails_as_before(tmp_path):
    spawn = SpawnRecorder(verdict="verify-error", rc=1, done_after=0)
    sched = make_sched(tmp_path, [PORT], spawn=spawn)
    sched.run()
    g = sched.state["grains"][S.grain_key(PORT)]
    assert g["status"] == "failed" and "resume_from" not in g
    assert _events(sched, "failed")[-1]["failure_class"] == "run"


def test_verify_recoveries_zero_keeps_the_old_behavior(tmp_path):
    spawn = SpawnRecorder(verdict="verify-error", rc=1, done_after=0)
    sched = make_sched(tmp_path, [PORT], spawn=spawn, verify_recoveries=0)
    _trace(sched, PORT)
    sched.run()
    assert sched.state["grains"][S.grain_key(PORT)]["status"] == "failed"
    assert len(spawn.calls) == 1


def test_a_content_rejection_is_never_resumed(tmp_path):
    # verify-reject is a JUDGEMENT: the verifier read the build and refused it
    spawn = SpawnRecorder(verdict="verify-reject", rc=1, done_after=0)
    sched = make_sched(tmp_path, [PORT], spawn=spawn)
    _trace(sched, PORT)
    sched.run()
    assert sched.state["grains"][S.grain_key(PORT)]["status"] == "failed"
    assert not _events(sched, "verify-recovery")


def test_a_raised_retry_builds_afresh_after_a_failed_recovery(tmp_path):
    spawn = SpawnRecorder(verdict="verify-error", rc=1, done_after=0)
    sched = make_sched(tmp_path, [PORT], spawn=spawn, backoff_s=0.0)
    _trace(sched, PORT)
    sched.run()
    key = S.grain_key(PORT)
    assert sched.state["grains"][key]["status"] == "failed" and len(spawn.calls) == 2
    _requeue(sched, tmp_path, PORT | {"retry": 1})
    g = sched.state["grains"][key]
    assert "resume_from" not in g and "verify_recoveries" not in g
    cmd = sched.driver_command(PORT, resume_from=g.get("resume_from"))
    assert "--verify-from" not in cmd and "--source-nb" in cmd


def test_a_verifier_crash_keeps_its_tree_for_the_resume(tmp_path):
    git = FakeGit()
    sched, _ = _sched_with_tree(tmp_path, git, verdict="verify-error", rc=1)
    _trace(sched, item(1))
    sched.tick()
    sched.tick()
    assert sched.state["grains"]["#1:Dir/N1.ipynb"]["status"] == "deferred"
    assert git.calls == []


# ---------------------------------------------------------------- state.json rename (22/11)

def test_state_rename_retries_while_a_reader_holds_the_file(tmp_path, monkeypatch):
    """22/11 04:4xZ: the scheduler died on `os.replace` -> WinError 5 because the
    feeder had state.json open; the rename now waits for the reader."""
    target = tmp_path / "live" / "state.json"
    calls, real = [], S.os.replace

    def flaky(src, dst):
        calls.append(dst)
        if len(calls) < 3:
            raise PermissionError(5, "Accès refusé")
        real(src, dst)

    monkeypatch.setattr(S.os, "replace", flaky)
    monkeypatch.setattr(S.time, "sleep", lambda s: None)
    S.atomic_write_json(target, {"grains": {}})
    assert len(calls) == 3
    assert json.loads(target.read_text(encoding="utf-8")) == {"grains": {}}


def test_state_rename_gives_up_after_bounded_attempts(tmp_path, monkeypatch):
    def denied(src, dst):
        raise PermissionError(5, "Accès refusé")

    monkeypatch.setattr(S.os, "replace", denied)
    monkeypatch.setattr(S.time, "sleep", lambda s: None)
    with pytest.raises(PermissionError):
        S.atomic_write_json(tmp_path / "state.json", {})


@pytest.mark.skipif(sys.platform != "win32", reason="the sharing violation is Windows-only")
def test_state_rename_survives_a_real_open_reader(tmp_path):
    import threading
    target = tmp_path / "state.json"
    target.write_text("{}", encoding="utf-8")
    reader = open(target, encoding="utf-8")  # Python opens without FILE_SHARE_DELETE
    threading.Timer(0.3, reader.close).start()
    S.atomic_write_json(target, {"v": 1})
    assert json.loads(target.read_text(encoding="utf-8")) == {"v": 1}
