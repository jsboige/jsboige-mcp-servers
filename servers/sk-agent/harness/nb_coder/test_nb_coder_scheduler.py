#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_scheduler.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Offline tests for nb_coder_scheduler.py — fake gate, fake driver, no engine,
no GitHub writes (#468). Run: python -m pytest test_nb_coder_scheduler.py -q
from this directory."""

import importlib.util
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

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


def _parked(tmp_path, verdict="deferred-by-claim-implicit-occupation:#28852,#28861"):
    """One grain launched once and PARKED on the occupation its verdict names (28/11,
    CoursIA#27133 MGS-24: two PRs of myia-po-2028:claudish disjoint from the notebook)."""
    clock = {"t": 1000.0}
    spawn = SpawnRecorder(verdict=verdict, rc=1, done_after=0)
    sched = make_sched(tmp_path, [item(1)], spawn=spawn)
    sched.clock = lambda: clock["t"]
    sched.tick()                                  # launch
    clock["t"] += 10
    sched.tick()                                  # reap -> parked
    return sched, clock, spawn, sched.state["grains"]["#1:Dir/N1.ipynb"]


def _events(sched, kind):
    path = sched.state_dir / "scheduler.jsonl"
    return [json.loads(l) for l in path.read_text().splitlines()
            if json.loads(l)["kind"] == kind]


def test_implicit_occupation_parks_the_grain_instead_of_burning_launches(tmp_path):
    """Measured 28/11 on CoursIA#27133 (MGS-24): the guard's IMPLICIT leg names another
    lane's open PRs (#28852 MGS-28, #28861 MGS-25) whose files are DISJOINT from the
    notebook. The ordinary backoff re-launched the driver six times in 30 minutes -- 3-4
    min of guard enumeration each, the same answer every time -- and the sixth exhausted
    the launches: `attempts-exhausted`, grain `failed`, nothing judged, against an
    occupation that had already lasted a day. A wait whose end is another lane's event
    is PARKED: the launch is refunded, and no timer launches the grain again."""
    sched, clock, spawn, g = _parked(tmp_path)
    assert g["status"] == "deferred"          # not failed
    assert g["occupation_wait"] is True
    assert g["occupation_prs"] == [28852, 28861]
    assert g["attempts"] == 0, "the launch that met the occupation is refunded"
    assert g["not_before"] == 1010.0 + S.IMPLICIT_OCCUPATION_PROBE_S
    clock["t"] = g["not_before"] + 5 * S.IMPLICIT_OCCUPATION_PROBE_S
    assert sched.tick()["launched"] == 0, "a parked grain is never launched on a timer"
    assert len(spawn.calls) == 1
    assert len(_events(sched, "occupation-parked")) == 1
    assert _events(sched, "occupation-parked")[0]["prs"] == ["#28852", "#28861"]


def test_a_parked_grain_never_exhausts_its_launches(tmp_path):
    """The sweep that makes an exhausted deferral terminal skips a parked grain: its
    launches were refunded, and its wait has no end of its own to run out of."""
    sched, clock, spawn, g = _parked(tmp_path)
    sched.args.max_attempts = 0
    sched.state["grains"]["#1:Dir/N1.ipynb"]["attempts"] = 7
    sched.tick()
    assert sched.state["grains"]["#1:Dir/N1.ipynb"]["status"] == "deferred"
    assert not _events(sched, "attempts-exhausted")


def test_a_retry_on_a_parked_grain_is_absorbed_and_keeps_the_park(tmp_path):
    """Measured 28/11 on CoursIA#27133 (MGS-24): two raised retry generations, two
    `retry-ignored`, park intact -- while the code comment claimed the operator's retry
    clears the wait on another lane's PR. A parked grain is `deferred`, never `failed`, so
    it returns before the pops; the park ends when the other lane's PRs close. The event
    now names the park (#1987)."""
    sched, clock, spawn, g = _parked(tmp_path)
    _requeue(sched, tmp_path, item(1) | {"retry": 1})
    g = sched.state["grains"]["#1:Dir/N1.ipynb"]
    assert g["status"] == "deferred", "the park is not released by a retry"
    assert g["retry"] == 1, "the generation is recorded even when it is absorbed"
    assert g["occupation_wait"] is True
    assert g["occupation_prs"] == [28852, 28861]
    assert g.get("occupation_since") is not None
    ev = _events(sched, "retry-ignored")[-1]
    assert ev["status"] == "deferred" and ev["retry"] == 1
    assert ev["occupation_wait"] is True
    assert ev["occupation_prs"] == ["#28852", "#28861"]
    assert len(spawn.calls) == 1, "an absorbed retry never launches the driver"


def test_an_occupation_that_names_no_pr_keeps_the_ordinary_backoff(tmp_path):
    """Nothing can be waited on when the verdict names no PR: the deferral stays the
    ordinary one (deferred, launched again after backoff), never a park without a key."""
    sched, clock, spawn, g = _parked(tmp_path, verdict="deferred-by-claim-implicit-occupation:")
    assert g["status"] == "deferred" and not g.get("occupation_wait")
    assert g["attempts"] == 1, "nothing was refunded: there was no PR to wait on"


def _pr_states(monkeypatch, states):
    """The PR-state reader as the probe calls it: one entry per call, in order."""
    seen = []

    def fake(number):
        seen.append(number)
        return states[number]
    monkeypatch.setattr(S, "pull_request_state", fake)
    return seen


def test_a_parked_grain_is_reoffered_when_the_named_prs_close(tmp_path, monkeypatch):
    """The occupation ends when the PRs close (merged or abandoned): the park clears, the
    launches it burnt are refunded, and the guard alone judges the next launch."""
    sched, clock, spawn, g = _parked(tmp_path)
    seen = _pr_states(monkeypatch, {28852: "closed", 28861: "closed"})
    now = 1010.0 + S.IMPLICIT_OCCUPATION_PROBE_S + 1
    sched._occupation_probe(now=now)
    assert seen == [28852, 28861]
    assert g["occupation_wait"] is False and g["occupation_prs"] == []
    assert g["not_before"] == now and g["attempts"] == 0
    assert len(_events(sched, "occupation-cleared")) == 1
    clock["t"] = now + 1
    sched.clock = lambda: clock["t"]
    assert sched.tick()["launched"] == 1, "the grain is launched again for the guard to judge"


def test_one_pr_still_open_keeps_the_park(tmp_path, monkeypatch):
    sched, clock, spawn, g = _parked(tmp_path)
    seen = _pr_states(monkeypatch, {28852: "closed", 28861: "open"})
    now = 1010.0 + S.IMPLICIT_OCCUPATION_PROBE_S + 1
    sched._occupation_probe(now=now)
    assert seen == [28852, 28861]
    assert g["occupation_wait"] is True and g["occupation_prs"] == [28852, 28861]
    assert g["not_before"] == now + S.IMPLICIT_OCCUPATION_PROBE_S
    assert not _events(sched, "occupation-cleared")
    assert _events(sched, "occupation-holds")[0]["prs"] == {"#28852": "closed", "#28861": "open"}


def test_an_unread_pr_state_keeps_the_park(tmp_path, monkeypatch):
    """A read GitHub does not answer is not a closed PR: the park holds, and the reader
    stops at the first unread state instead of spending the rest of its budget."""
    sched, clock, spawn, g = _parked(tmp_path)
    seen = _pr_states(monkeypatch, {28852: None, 28861: "closed"})
    now = 1010.0 + S.IMPLICIT_OCCUPATION_PROBE_S + 1
    sched._occupation_probe(now=now)
    assert seen == [28852]
    assert g["occupation_wait"] is True and g["occupation_prs"] == [28852, 28861]
    assert not _events(sched, "occupation-cleared")
    assert _events(sched, "occupation-holds")[0]["prs"] == {"#28852": "unknown"}


def test_a_hung_state_read_keeps_the_park_and_the_scheduler(tmp_path, monkeypatch):
    """Review of this PR (myia-po-2028:claudish, replayed on the PR head): the reader's
    docstring said "raises nothing", but a `gh` hung past CLAIM_READ_TIMEOUT_S raises
    TimeoutExpired, and the probe called it with no try. The exception left tick(), and
    run() catches nothing, so the scheduler exited with its running grains orphaned.
    A hung read is a FAILED READ: the park holds and the scheduler survives it."""
    sched, clock, spawn, g = _parked(tmp_path)

    def hung(argv, **kw):
        raise S.subprocess.TimeoutExpired(argv, S.CLAIM_READ_TIMEOUT_S)
    monkeypatch.setattr(S.subprocess, "run", hung)
    assert S.pull_request_state(28852) is None
    clock["t"] = g["not_before"] + 1
    sched.tick()                                # the probe runs inside: must not raise
    assert g["occupation_wait"] is True and g["occupation_prs"] == [28852, 28861]
    assert not _events(sched, "occupation-cleared")
    assert _events(sched, "occupation-holds")[0]["prs"]["#28852"] == "unknown"
    assert len(spawn.calls) == 1, "no launch: the grain stays parked"


def test_a_missing_gh_is_a_failed_read_not_a_crash(monkeypatch):
    """`gh` absent from PATH raises FileNotFoundError before any timeout: an OSError is
    read as "GitHub did not answer", never propagated."""
    def missing(argv, **kw):
        raise FileNotFoundError(argv[0])
    monkeypatch.setattr(S.subprocess, "run", missing)
    assert S.pull_request_state(28861) is None


def test_a_park_outliving_max_future_lets_the_batch_drain(tmp_path, monkeypatch):
    """Review finding 2: each probe pushes the park's `not_before` one interval ahead, so
    a batch that waits on the scheduler PID would never drain on a PR open for days.
    The park is bounded like any deferral: past --max-future-s it is finished FOR NOW --
    the batch drains and names it with its PRs, and the next batch picks it up. The
    park itself is not ended by a drain, and --watch never drains."""
    sched, clock, spawn, g = _parked(tmp_path)
    _pr_states(monkeypatch, {28852: "open", 28861: "open"})
    assert g["occupation_since"] == 1010.0, "the park keeps its own start"
    clock["t"] = 1010.0 + 50 * S.IMPLICIT_OCCUPATION_PROBE_S       # ~4 h of probes
    assert sched.unfinished() is True, "a young park keeps the batch alive"
    sched.args.watch = False
    clock["t"] = 1010.0 + sched.args.max_future_s + 1
    assert sched.unfinished() is False, "a park older than --max-future-s drains the batch"
    assert sched.run() == 0
    drained = _events(sched, "drained")
    assert len(drained) == 1
    assert drained[0]["parked"] == {"#1:Dir/N1.ipynb": ["#28852", "#28861"]}
    assert g["occupation_wait"] is True, "a drain does not end the park itself"
    assert not _events(sched, "occupation-cleared")


def test_the_occupation_probe_reads_one_pr_state_per_call(tmp_path, monkeypatch):
    """The reader asks GitHub for the PR's state only -- never its files, never the
    issue: the probe decides WHEN to re-offer, the guard decides the claim."""
    calls = []

    def fake_run(argv, **kw):
        calls.append((argv, kw))
        return SimpleNamespace(returncode=0, stdout="open\n", stderr="")
    monkeypatch.setattr(S.subprocess, "run", fake_run)
    assert S.pull_request_state(28852) == "open"
    assert calls[0][0] == ["gh", "api", "repos/jsboige/CoursIA/pulls/28852", "--jq", ".state"]
    assert calls[0][1].get("timeout") == S.CLAIM_READ_TIMEOUT_S
    monkeypatch.setattr(S.subprocess, "run",
                        lambda *a, **k: SimpleNamespace(returncode=1, stdout="", stderr="gh: no"))
    assert S.pull_request_state(28852) is None


def test_implicit_occupation_prs_reads_comma_joined_numbers():
    """The driver joins the PRs with commas: a split on `:` would read one number out of
    two, and the park would then wait on the first PR only."""
    assert S.implicit_occupation_prs(
        "deferred-by-claim-implicit-occupation:#28852,#28861") == [28852, 28861]
    assert S.implicit_occupation_prs("deferred-by-claim-implicit-occupation:#27691") == [27691]
    assert S.implicit_occupation_prs("deferred-by-claim-implicit-occupation:") == []
    assert S.implicit_occupation_prs("deferred-by-capacity-gate:#12") == []
    assert S.implicit_occupation_prs("refused-claim-implicit-occupation") == []


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


# ---------------------------------------------------------------- resumed grains (22/11)
def test_driver_command_forwards_revise_from_and_drops_creation_fields(tmp_path):
    """A content failure is RESUMED on its built notebook (--revise-from), never rebuilt:
    41 grains of w3a-w3x were rebuilt from scratch or released because the queue could not
    say it. The resume writes next to its trace and never inherits the scheduler's
    default twin (the driver refuses --source-nb / --meta-from with --revise-from)."""
    trace = str(tmp_path / "runs" / "issue-7-ab" / "issue-7.json")
    sched = make_sched(tmp_path, [{"issue": 7, "notebook": "A/X-CSharp.ipynb",
                                   "revise_from": trace, "max_stage": 5}],
                       source_nb="Default/Twin.ipynb")
    cmd = sched.driver_command(sched.items_by_key["#7:A/X-CSharp.ipynb"])
    joined = " ".join(cmd)
    assert cmd[cmd.index("--revise-from") + 1] == trace
    assert cmd[cmd.index("--out-dir") + 1] == str(Path(trace).parent)
    assert "--source-nb" not in joined and "--meta-from" not in joined
    assert "--from-spec" not in cmd and "--verify-from" not in cmd
    v = make_sched(tmp_path / "v", [{"issue": 8, "notebook": "A/Y-CSharp.ipynb",
                                     "verify_from": trace}])
    cv = v.driver_command(v.items_by_key["#8:A/Y-CSharp.ipynb"])
    assert "--verify-from" in cv and "--revise-from" not in cv
    # an automatic resume (resume_from) keeps its own out-dir: only an EXPLICIT trace moves it
    a = make_sched(tmp_path / "a", [{"issue": 9, "notebook": "A/Z.ipynb"}])
    ca = a.driver_command(a.items_by_key["#9:A/Z.ipynb"], resume_from=trace)
    assert "--verify-from" in ca and ca[ca.index("--out-dir") + 1] != str(Path(trace).parent)


@pytest.mark.parametrize("item,match", [
    ({"revise_from": "t.json", "verify_from": "t.json"}, "exclusive"),
    ({"revise_from": "t.json", "source_nb": "A/T-Python.ipynb"}, "creation mode"),
    ({"verify_from": "t.json", "from_spec": True, "meta_from": "A/M.ipynb"}, "creation mode"),
    ({"revise_from": "t.json", "max_stage": 3}, "max_stage >= 4"),
])
def test_queue_refuses_contradictory_resume(tmp_path, item, match):
    q = tmp_path / "q.jsonl"
    q.write_text(json.dumps({"issue": 9, "notebook": "A/Z.ipynb", **item}) + "\n",
                 encoding="utf-8")
    with pytest.raises(S.QueueError, match=match):
        S.load_queue(q)


def test_refresh_gh_env_is_a_no_op_without_an_app(monkeypatch):
    monkeypatch.delenv("NBCODER_GH_APP_ID", raising=False)
    monkeypatch.delenv("NBCODER_GH_KEY", raising=False)
    monkeypatch.setenv("GH_TOKEN", "keep")
    S.refresh_gh_env("D:/CoursIA")
    assert os.environ["GH_TOKEN"] == "keep"


def test_refresh_gh_env_rebinds_from_the_mint(tmp_path, monkeypatch):
    monkeypatch.setenv("NBCODER_GH_APP_ID", "1")
    monkeypatch.setenv("NBCODER_GH_KEY", str(tmp_path / "k.pem"))
    seen = {}

    def fake_run(argv, **kw):
        seen["argv"] = argv
        return SimpleNamespace(returncode=0, stdout="ghs_new\n", stderr="")

    monkeypatch.setattr(S.subprocess, "run", fake_run)
    monkeypatch.setenv("GH_TOKEN", "stale")
    S.refresh_gh_env(tmp_path)
    assert os.environ["GH_TOKEN"] == "ghs_new"
    assert "--quiet" in seen["argv"]


# ------------------------------------------- RELACHEE override probe (23/11)
def _deferred_relache(tmp_path, items=None):
    """One grain deferred on refused-claim-not-qualified:RELACHEE, not_before 3 days out."""
    s = make_sched(tmp_path, items or [item(1)])
    s.args.lane = "myia-po-2028:claudish"
    key = next(iter(s.state["grains"]))
    g = s.state["grains"][key]
    g.update({"status": "deferred", "last_verdict": S.CLAIM_RELEASED_VERDICT,
              "not_before": 1000.0 + S.CLAIM_RELEASED_WAIT_S})
    return s, key, g


_EPOCH_1000 = "1970-01-01T00:16:40Z"   # the tests' `now=1000.0`, as a GitHub created_at


def _fake_thread(bodies, stamps=None):
    """The timeline reader's stdout: one `[created_at, body]` JSON pair per comment,
    oldest first. Unless given, every comment is created at the test's `now` (epoch
    1000): a release as old as the refusal, whose expiry is the wait already armed."""
    stamps = list(stamps or [_EPOCH_1000] * len(bodies))
    return "\n".join(json.dumps([c, b], ensure_ascii=False) for c, b in zip(stamps, bodies)) + "\n"


def _override(lane="myia-po-2028:claudish", head="Grain rendu a la lane (bénéficiaire ci-dessus)."):
    """The coordinator's re-arm gesture, as measured on CoursIA#28077 (23/11): the
    [OVERRIDE] is its OWN line, the prose after it quotes the marker it lifts."""
    return f"[OVERRIDE] lane {lane} -- paths: Dir/N1.ipynb\n{head}\n" + (
        "Le [RELEASED] de 04:48Z est leve par ce geste ; relire le motif du [RELEASED].")


def test_a_fresh_override_lifts_the_three_day_relache_wait(tmp_path, monkeypatch):
    """Measured 23/11 on CoursIA#28077/#28080/#28050/#28079: the coordinator's four
    [OVERRIDE]s (03:41Z) lifted releases caused by a harness defect, yet the grains
    slept the FULL three-day window from the refusal — and each retry pushed its own
    not_before three days further. A newer [OVERRIDE] marker naming this lane is the
    event the guard itself reads: the probe must drop not_before so the guard re-qualifies."""
    s, key, g = _deferred_relache(tmp_path)
    calls = []

    def fake_run(argv, **kw):
        calls.append((argv, kw))
        return SimpleNamespace(returncode=0, stdout=_fake_thread(
            ["[RELEASED] lane myia-po-2028:claudish -- grain ended without a PR",
             _override()]), stderr="")

    monkeypatch.setattr(S.subprocess, "run", fake_run)
    s._relache_override_probe(now=1000.0)
    assert calls, "the probe reads the issue's marker thread"
    argv, kw = calls[0]
    # Review ms#1875: the WHOLE thread is read -- every page, one comment per line,
    # bounded by the same read timeout as the claim release (the probe is in tick()).
    # 25/11: each line carries the comment's creation time too (the release's own date).
    assert "--paginate" in argv
    assert any(a.startswith("repos/jsboige/CoursIA/issues/1/comments?") for a in argv)
    assert "per_page=100" in next(a for a in argv if a.startswith("repos/"))
    assert argv[-1] == '.[] | [.created_at, (.body // "")] | @json'
    assert kw.get("timeout") == S.CLAIM_READ_TIMEOUT_S
    assert g["not_before"] == 1000.0, "the OVERRIDE lifts the three-day wait"
    events = [l for l in (tmp_path / "state" / "scheduler.jsonl").read_text().splitlines()]
    assert any("relache-override-lifted" in l for l in events)


def test_the_marker_is_found_on_any_line_of_any_comment(tmp_path, monkeypatch):
    """Review ms#1875: the marker is not only the comment's first line. A RELEASED on
    line 1 whose lift sits three lines lower, under a bold header and a quote, still
    lifts -- and a RELEASED quoted mid-sentence is NOT a marker."""
    s, key, g = _deferred_relache(tmp_path)
    body = ("**Reprise** — le [RELEASED] precedent n'etait pas un refus du port :\n"
            "il venait d'un defaut du harnais, corrige depuis.\n"
            "> **[OVERRIDE] lane myia-po-2028:claudish -- paths: Dir/N1.ipynb**\n"
            "Relire le motif du [RELEASED] avant de relancer.")
    monkeypatch.setattr(S.subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=0, stdout=_fake_thread(
            ["[RELEASED] lane myia-po-2028:claudish -- fin", body]), stderr=""))
    s._relache_override_probe(now=1000.0)
    assert g["not_before"] == 1000.0


def test_an_override_naming_another_lane_keeps_the_guard(tmp_path, monkeypatch):
    """The guard grants an [OVERRIDE] to its NAMED lane only: lifting on an override
    addressed to a sibling would send this lane to a refusal and re-arm three days."""
    s, key, g = _deferred_relache(tmp_path)
    before = g["not_before"]
    monkeypatch.setattr(S.subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=0, stdout=_fake_thread(
            ["[RELEASED] lane myia-po-2028:claudish -- fin", _override("myia-ai-01:CoursIA")]),
        stderr=""))
    s._relache_override_probe(now=1000.0)
    assert g["not_before"] == before


def test_a_released_newer_than_the_override_keeps_the_guard(tmp_path, monkeypatch):
    """23/11 generalization (GO ai01-c0025-claudish-ovr5): the probe walks the WHOLE
    marker thread, not just the last comment. The decisive case is a fresh OVERRIDE
    that a subsequent auto-[RELEASED] would have hidden from a last-comment reader —
    but here the RELEASED is NEWER than the OVERRIDE, so the release is still the
    operative event and the three-day guard must HOLD (never retry early)."""
    s, key, g = _deferred_relache(tmp_path)
    monkeypatch.setattr(S.subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=0, stdout=_fake_thread(
            [_override(), "[RELEASED] lane myia-po-2028:claudish — stage2 mur"]), stderr=""))
    s._relache_override_probe(now=1000.0)
    assert g["not_before"] != 1000.0, "a RELEASED newer than the OVERRIDE keeps the guard"


def test_a_released_by_another_lane_buries_the_lift(tmp_path, monkeypatch):
    """The guard (`tapis_attente.relachee`) reads the thread's LAST marker whoever posted
    it: a sibling lane's [RELEASED] buries my lift exactly like my own. Dropping the
    sibling's marker from the walk would launch on a guard that still says RELACHEE."""
    s, key, g = _deferred_relache(tmp_path)
    before = g["not_before"]
    monkeypatch.setattr(S.subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=0, stdout=_fake_thread(
            [_override(), "[RELEASED] lane myia-po-2023:CoursIA-2 -- mur 429"]), stderr=""))
    s._relache_override_probe(now=1000.0)
    assert g["not_before"] == before, "a RELEASED last keeps the guard, whoever signed it"


def test_the_newest_marker_being_an_override_lifts(tmp_path, monkeypatch):
    """A RELEASED followed by a NEWER OVERRIDE lifts: the OVERRIDE is the operative event --
    mine, and also a sibling's (older markers of any lane never block the newest one)."""
    s, key, g = _deferred_relache(tmp_path)
    monkeypatch.setattr(S.subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=0, stdout=_fake_thread(
            ["[RELEASED] lane myia-po-2028:claudish — stage2 mur", _override()]), stderr=""))
    s._relache_override_probe(now=1000.0)
    assert g["not_before"] == 1000.0, "the newest OVERRIDE lifts the wait"
    s, key, g = _deferred_relache(tmp_path / "b", [item(1)])
    monkeypatch.setattr(S.subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=0, stdout=_fake_thread(
            ["[RELEASED] lane myia-po-2023:CoursIA-2 -- mur 429", _override()]), stderr=""))
    s._relache_override_probe(now=1000.0)
    assert g["not_before"] == 1000.0, "a sibling's OLDER RELEASED does not bury my OVERRIDE"


def test_the_probe_is_best_effort_on_a_gh_failure(tmp_path, monkeypatch):
    """A dead gh leaves the three-day guard exactly as before — never an early retry."""
    s, key, g = _deferred_relache(tmp_path)
    before = g["not_before"]
    monkeypatch.setattr(S.subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=1, stdout="", stderr="HTTP 503"))
    s._relache_override_probe(now=1000.0)
    assert g["not_before"] == before
    # A reader timeout is a gh failure like any other: no exception escapes tick().
    monkeypatch.setattr(S.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(
        TimeoutError("gh timed out")))
    s._relache_override_probe(now=1000.0 + S.RELACHEE_PROBE_INTERVAL_S + 1)
    assert g["not_before"] == before


def test_the_probe_is_rate_limited_per_interval(tmp_path, monkeypatch):
    s, key, g = _deferred_relache(tmp_path)
    n = []

    def fake_run(*a, **k):
        n.append(1)
        return SimpleNamespace(returncode=0, stdout=_fake_thread([_override()]), stderr="")

    monkeypatch.setattr(S.subprocess, "run", fake_run)
    s._relache_override_probe(now=1000.0)
    s._relache_override_probe(now=1000.0 + 60)   # inside the interval: no call
    assert len(n) == 1
    # The first probe LIFTED the wait (OVERRIDE seen), so the grain is no longer a
    # deferred candidate. Re-arm the defer to test the interval gate on its own.
    g["not_before"] = 1000.0 + S.CLAIM_RELEASED_WAIT_S
    s._relache_override_probe(now=1000.0 + S.RELACHEE_PROBE_INTERVAL_S + 1)
    assert len(n) == 2


def test_the_probe_is_bounded_per_interval_and_round_robin(tmp_path, monkeypatch):
    """The read is synchronous in tick(), each thread bounded by CLAIM_READ_TIMEOUT_S:
    at most RELACHEE_PROBE_MAX_READS threads per interval, and the grains left over
    come first at the next interval (a starved grain would never see its lift)."""
    s, key, g = _deferred_relache(tmp_path, [item(n) for n in range(1, 9)])   # 2 x 4 grains
    for k, gr in s.state["grains"].items():
        gr.update({"status": "deferred", "last_verdict": S.CLAIM_RELEASED_VERDICT,
                   "not_before": 1000.0 + S.CLAIM_RELEASED_WAIT_S})
    seen = []
    monkeypatch.setattr(S.subprocess, "run", lambda argv, **k: (
        seen.append(next(a for a in argv if a.startswith("repos/"))),
        SimpleNamespace(returncode=0, stdout="", stderr=""))[1])
    s._relache_override_probe(now=1000.0)
    assert len(seen) == S.RELACHEE_PROBE_MAX_READS
    s._relache_override_probe(now=1000.0 + S.RELACHEE_PROBE_INTERVAL_S + 1)
    assert len(seen) == 2 * S.RELACHEE_PROBE_MAX_READS
    assert seen[S.RELACHEE_PROBE_MAX_READS] != seen[0], "the next interval starts elsewhere"
    assert len(set(seen)) == len(seen), "no thread is read twice before the others"


# ------------------------------------------- RELACHEE expiry bound (24/11)
# CoursIA#28018, measured: [RELEASED] 22/11 09:38:20Z by this lane, refused by it
# 24/11 22:50:41Z, deferred to 27/11 22:51:01Z -- for a guard that expires 25/11 09:39:20Z.
_RELEASED_28018 = "2026-11-22T09:38:20Z"
_NOW_28018 = datetime(2026, 11, 24, 22, 50, 41, tzinfo=timezone.utc).timestamp()
_DAY = 86400.0


def _journal(tmp_path):
    return [json.loads(l) for l in
            (tmp_path / "state" / "scheduler.jsonl").read_text(encoding="utf-8").splitlines()
            if l.startswith("{")]


def _thread(monkeypatch, pairs):
    """A fake GitHub answering the timeline reader with (created_at, body), oldest first."""
    monkeypatch.setattr(S.subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=0, stderr="", stdout=_fake_thread([b for _, b in pairs], [c for c, _ in pairs])))


def _ago(now: float, days: float) -> str:
    """A GitHub created_at, `days` before the epoch `now`."""
    return (datetime.fromtimestamp(now, timezone.utc) - timedelta(days=days)).isoformat(
        timespec="seconds").replace("+00:00", "Z")


def _deferred_relache_at(tmp_path, now=_NOW_28018):
    """A grain refused RELACHEE at `now`: deferred for the whole window from that refusal."""
    s, key, g = _deferred_relache(tmp_path)
    g["not_before"] = now + S.CLAIM_RELEASED_WAIT_S
    return s, key, g


def test_the_wait_ends_with_the_release_not_with_the_refusal(tmp_path, monkeypatch):
    """The guard dates a marker on its comment and holds three days from THERE
    (`tapis_attente.relachee`), so the wait is bounded to that same instant instead of
    three days from a refusal that came 2.55 days later."""
    s, key, g = _deferred_relache_at(tmp_path)
    _thread(monkeypatch, [(_RELEASED_28018, "[RELEASED] lane myia-ai-01:vllm -- kernel-start-failed")])
    s._relache_override_probe(now=_NOW_28018)
    assert g["not_before"] == datetime(2026, 11, 25, 9, 39, 20, tzinfo=timezone.utc).timestamp()
    assert g["not_before"] > _NOW_28018, "the bound never makes the grain eligible at once"
    bounded = [e for e in _journal(tmp_path) if e["kind"] == "relache-expiry-bounded"]
    assert len(bounded) == 1 and bounded[0]["issue"] == 1
    assert bounded[0]["released_at"] == "2026-11-22T09:38:20+00:00"
    assert bounded[0]["retry_at"] == "2026-11-25T09:39:20+00:00"
    assert bounded[0]["retry_in_s"] == pytest.approx(S.CLAIM_RELEASED_WAIT_S - (
        _NOW_28018 - datetime(2026, 11, 22, 9, 38, 20, tzinfo=timezone.utc).timestamp()))


def test_the_bound_is_a_min_and_never_lengthens_the_wait(tmp_path, monkeypatch):
    s, key, g = _deferred_relache_at(tmp_path)
    g["not_before"] = _NOW_28018 + 3600.0     # a shorter wait, from whatever armed it before
    _thread(monkeypatch, [(_ago(_NOW_28018, 0.1), "[RELEASED] lane myia-po-2028:claudish -- fin")])
    s._relache_override_probe(now=_NOW_28018)
    assert g["not_before"] == _NOW_28018 + 3600.0
    assert not [e for e in _journal(tmp_path) if e["kind"] == "relache-expiry-bounded"]


def test_an_expired_release_keeps_the_conservative_wait(tmp_path, monkeypatch):
    """A [RELEASED] older than the window does not explain a RELACHEE refusal: the
    thread no longer shows what the guard saw. Nothing is shortened -- the bound moves
    a future wait, it is never what makes a grain eligible."""
    s, key, g = _deferred_relache_at(tmp_path)
    before = g["not_before"]
    _thread(monkeypatch, [(_ago(_NOW_28018, 4.0), "[RELEASED] lane myia-po-2028:claudish -- fin")])
    s._relache_override_probe(now=_NOW_28018)
    assert g["not_before"] == before
    assert not [e for e in _journal(tmp_path) if e["kind"] == "relache-expiry-bounded"]


def test_a_release_in_a_paused_comment_has_no_window_to_bound(tmp_path, monkeypatch):
    """#27726: a comment carrying `attend: #N` poses a PAUSE, which has no delay -- the
    guard's `relachee` returns None on it. The condition is read anywhere in the
    comment, as the guard reads it, quoted code aside."""
    stamped = _ago(_NOW_28018, 2.5)
    bodies = ("[RELEASED] lane myia-po-2028:claudish -- attend: #27726 (question user)",
              "[RELEASED] lane myia-po-2028:claudish -- fin\nL'arbitrage attend : Q61.",
              "```\n[RELEASED] lane x:y -- attend: #1 (du code cite)\n```\n"
              "[RELEASED] lane myia-po-2028:claudish -- fin")
    for i, body in enumerate(bodies):
        # a fresh scheduler each time: the probe reads a thread once per interval
        s, key, g = _deferred_relache_at(tmp_path / str(i))
        before = g["not_before"]
        _thread(monkeypatch, [(stamped, body)])
        s._relache_override_probe(now=_NOW_28018)
        if "du code cite" in body:
            # the fence quotes a condition: the release itself is a plain three-day one
            assert g["not_before"] == (datetime.fromisoformat(stamped.replace("Z", "+00:00"))
                                       .timestamp() + S.CLAIM_RELEASED_WAIT_S)
        else:
            assert g["not_before"] == before, f"body {i} poses a pause"


def test_an_undatable_release_keeps_the_conservative_wait(tmp_path, monkeypatch):
    """Without a parseable date the scheduler is back to the guard's rounded age, and
    keeps the whole window from the refusal -- never a guess."""
    for stamp in ("", "not-a-date", "1969-11-29", "2026-11-22T09:38:20"):
        s, key, g = _deferred_relache_at(tmp_path)
        before = g["not_before"]
        _thread(monkeypatch, [(stamp, "[RELEASED] lane myia-po-2028:claudish -- fin")])
        s._relache_override_probe(now=_NOW_28018)
        assert g["not_before"] == before, stamp


def test_the_bound_follows_the_newest_release_whoever_signed_it(tmp_path, monkeypatch):
    """The guard sorts the markers on their dates (`tapis_marqueurs.evenements`), and
    reads the thread's LAST one whoever posted it: the bound follows the newest."""
    s, key, g = _deferred_relache_at(tmp_path)
    newer = _ago(_NOW_28018, 0.5)
    _thread(monkeypatch, [
        (_ago(_NOW_28018, 2.9), "[RELEASED] lane myia-ai-01:vllm -- kernel-start-failed"),
        (newer, "[RELEASED] lane myia-po-2028:claudish — stage2 mur")])
    s._relache_override_probe(now=_NOW_28018)
    assert g["not_before"] == (datetime.fromisoformat(newer.replace("Z", "+00:00"))
                               .timestamp() + S.CLAIM_RELEASED_WAIT_S)


def test_an_override_still_lifts_at_once_over_a_dated_release(tmp_path, monkeypatch):
    s, key, g = _deferred_relache_at(tmp_path)
    _thread(monkeypatch, [(_RELEASED_28018, "[RELEASED] lane myia-po-2028:claudish -- fin"),
                          (_ago(_NOW_28018, 60.0 / _DAY), _override())])
    s._relache_override_probe(now=_NOW_28018)
    assert g["not_before"] == _NOW_28018
    kinds = [e["kind"] for e in _journal(tmp_path)]
    assert "relache-override-lifted" in kinds and "relache-expiry-bounded" not in kinds


def test_the_timeline_reader_dates_each_comment(tmp_path, monkeypatch):
    """One paginated read, bounded like the claim release: (created_at, body) per
    comment, oldest first. GitHub not answering raises -- never an empty thread."""
    seen = {}

    def fake_run(argv, **kw):
        seen["argv"], seen["kw"] = argv, kw
        return SimpleNamespace(returncode=0, stderr="", stdout="\n".join([
            json.dumps(["2026-11-22T09:38:20Z", "[RELEASED] lane a:b -- fin"]),
            json.dumps(["2026-11-24T08:00:00Z", ""]), ""]) + "\n")

    monkeypatch.setattr(S.subprocess, "run", fake_run)
    assert S.issue_comment_timeline(28018) == [
        ("2026-11-22T09:38:20Z", "[RELEASED] lane a:b -- fin"), ("2026-11-24T08:00:00Z", "")]
    assert "--paginate" in seen["argv"]
    assert any(a.startswith("repos/jsboige/CoursIA/issues/28018/comments?") for a in seen["argv"])
    assert seen["argv"][-1] == '.[] | [.created_at, (.body // "")] | @json'
    assert seen["kw"].get("timeout") == S.CLAIM_READ_TIMEOUT_S
    monkeypatch.setattr(S.subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=1, stdout="", stderr="HTTP 503"))
    with pytest.raises(RuntimeError):
        S.issue_comment_timeline(28018)


def test_relache_release_epoch_refuses_what_it_cannot_date():
    """None -- keep the conservative wait -- for every thread but a plain dated release."""
    released = (_RELEASED_28018, "[RELEASED] lane myia-ai-01:vllm -- kernel-start-failed")
    assert S.relache_release_epoch([released]) == datetime(
        2026, 11, 22, 9, 38, 20, tzinfo=timezone.utc).timestamp()
    assert S.relache_release_epoch([]) is None
    assert S.relache_release_epoch([(_RELEASED_28018, "aucun marqueur ici")]) is None
    # an OVERRIDE last is the lift's to decide, never a date to wait for
    assert S.relache_release_epoch(
        [released, ("2026-11-24T00:00:00Z", _override())]) is None
    # a marker quoted mid-sentence is not a marker (line-anchored, like the guard)
    assert S.relache_release_epoch(
        [(_RELEASED_28018, "le [RELEASED] de 04:48Z est leve par ce geste")]) is None
    # a date without an offset would be read as local time: refused, not guessed
    assert S.relache_release_epoch([("2026-11-22T09:38:20", "[RELEASED] lane a:b -- fin")]) is None
