#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 231c9ad8e9281ee162fc641a11889fc5600f4827
# original path: myia_vllm/scripts/adoption/nb_coder/nb_coder_scheduler.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
# Ported 18/11 (po-204): vllm#488 (cae11f0d) + vllm#489 (19744028) cutover pre-review r1+r2 — dispatch ai-01 18/11.
"""nb_coder_scheduler.py — capacity-aware batch scheduler above nb_coder_driver (#468).

The driver already refuses a notebook when swift_capacity_gate.py is not green
(--gate-mode block -> verdict deferred-by-capacity-gate). What was missing for
opportunistic batch filling is the LOOP above it:

  * keep at most N grains in flight, counted against the live engine `running`
    gauge (the ramp target is a TOTAL request target, not a private slot count);
  * launch only while the gate is green; yellow/red/unknown hold NEW launches and
    NEVER terminate a driver already in flight (the standing admission contract:
    no kill in flight, no tool replay);
  * re-offer capacity-deferred grains after a backoff instead of losing them;
  * promote a measured ramp step (2 -> 3 -> 4) only after enough clean
    completions, sustained green, and no red/unknown since the step started.

Everything is persisted: state.json (recoverable queue status + ramp report) and
scheduler.jsonl (one JSON event per decision). A STOP file freezes new launches
without touching the grains already running.

Input: a JSONL queue, one grain per line, exactly the fields the driver knows:

    {"issue":26997,"notebook":"MyIA.AI.Notebooks/Physique/.../X.ipynb"}
    {"issue":26998,"notebook":"...","max_stage":2,"claim":true,"agent":"notebook-coder"}

Run (foreground, Ctrl-C leaves children running and marks them orphaned):

    python nb_coder_scheduler.py --queue grains.jsonl --repo D:/CoursIA \
        --lane myia-ai-01:nb-coder --claim --ramp 2,3,4 --gate-mode block

Offline tests: test_nb_coder_scheduler.py (fake gate + fake driver, no engine,
no GitHub).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Item fields are a closed set: a queue line is operator-authored input, and an
# unknown key almost always means a typo ("notebok") silently falling back to a
# default. Refuse loud instead.
ITEM_FIELDS = {
    "issue": int,
    "notebook": str,
    "source_nb": str,          # creation mode (--source-nb): the Python twin's repo-relative
                               # path — every wave-1 parity grain (#27099-#27116) is a CREATION
    "max_stage": int,
    "claim": bool,
    "fresh_worktree": bool,
    "agent": str,
    "intention": str,
    "write_mode": str,
    "exec_mode": str,
    "kernel_override": str,
    "verifier_agent": str,
    "coder_model": str,         # per-step model selection (#4831): unset = the --agent
                                # preset's own model (seat default)
    "verifier_model": str,
    "spec_model": str,
    "spec_mode": str,           # "skip" (default) | "run" — the skip is a DECLARED choice
                                # of the calling lane, traced on the driver's run record
    "timeout": int,
    "max_tokens": int,
    "repair_rounds": int,
    "allow_foreign_origin": bool,
}
# Verdicts the driver itself treats as success (its own exit-0 list, kept in
# sync so a rc!=0 wrapper around a successful verdict is still classified done).
DONE_VERDICT_SUFFIXES = (
    "built-executed-ok",
    "gates-ok",
    "stage0-only",
    "stage1-only",
    "verify-approved",
    "pr-created",
)


class QueueError(ValueError):
    pass


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def grain_key(item: dict) -> str:
    return f"#{item['issue']}:{item['notebook']}"


def load_queue(path: Path) -> tuple[list[dict], str]:
    """Parse + validate the queue; returns (items, sha256 of the raw file)."""
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    items: list[dict] = []
    seen: set[str] = set()
    for lineno, line in enumerate(raw.decode("utf-8-sig").splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        try:
            item = json.loads(line)
        except Exception as exc:
            raise QueueError(f"queue line {lineno}: invalid JSON: {exc}") from exc
        unknown = sorted(set(item) - set(ITEM_FIELDS))
        if unknown:
            raise QueueError(f"queue line {lineno}: unknown field(s) {unknown}")
        missing = [k for k in ("issue", "notebook") if k not in item]
        if missing:
            raise QueueError(f"queue line {lineno}: missing field(s) {missing}")
        if not isinstance(item["issue"], int) or isinstance(item["issue"], bool) or item["issue"] <= 0:
            raise QueueError(f"queue line {lineno}: issue must be a positive integer")
        nb = item["notebook"]
        if not isinstance(nb, str) or not nb.endswith(".ipynb"):
            raise QueueError(f"queue line {lineno}: notebook must be a repo-relative .ipynb path")
        if ":" in nb[:3] or nb.startswith(("/", "\\")) or ".." in Path(nb).parts:
            raise QueueError(f"queue line {lineno}: notebook must be repo-relative, no ..: {nb}")
        for k, ty in ITEM_FIELDS.items():
            if k in item and not isinstance(item[k], ty):
                raise QueueError(f"queue line {lineno}: field {k} must be {ty.__name__}")
        key = grain_key(item)
        if key in seen:
            raise QueueError(f"queue line {lineno}: duplicate grain {key}")
        seen.add(key)
        items.append(item)
    if not items:
        raise QueueError(f"queue is empty: {path}")
    return items, digest


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
                   encoding="utf-8")
    os.replace(tmp, path)


def new_ramp(steps: list[int], now: float, fixed: bool = False) -> dict:
    return {
        "steps": steps,
        "step_index": 0,
        "max_active": steps[0],
        "fixed": fixed,
        "step_started": now,
        "done": 0,
        "failed": 0,
        "deferred": 0,
        "first_green_ts": None,
        "dirty": False,          # red or unknown seen since the step started
        "samples": 0,
        "green_samples": 0,
        "running_max": 0.0,
        "waiting_max": 0.0,
        "preempt_max": 0.0,
    }


def _step_report(ramp: dict, now: float) -> dict:
    return {k: ramp.get(k) for k in (
        "steps", "step_index", "max_active", "step_started", "done", "failed",
        "deferred", "dirty", "samples", "green_samples", "running_max",
        "waiting_max", "preempt_max")} | {"step_ended": now,
                                          "duration_s": round(now - ramp["step_started"], 1)}


def _reset_step_counters(ramp: dict, now: float) -> None:
    """Keep the ramp position, reset the promotion evidence."""
    ramp.update({"step_started": now, "done": 0, "failed": 0, "deferred": 0,
                 "first_green_ts": None, "dirty": False, "samples": 0,
                 "green_samples": 0, "running_max": 0.0, "waiting_max": 0.0,
                 "preempt_max": 0.0})


class Scheduler:
    """Pure orchestration. spawn/gate/sleep/clock are injectable for offline tests."""

    def __init__(self, args, spawn=None, gate=None, sleep=None, clock=None):
        self.args = args
        self.state_dir = Path(args.state_dir)
        self.state_path = self.state_dir / "state.json"
        self.journal_path = self.state_dir / "scheduler.jsonl"
        self.spawn = spawn or self._spawn_driver
        self.gate = gate or self._probe_gate
        self.sleep = sleep or time.sleep
        self.clock = clock or time.time
        self.active: dict[str, dict] = {}   # key -> {proc, item, pid, started}
        self.items_by_key: dict[str, dict] = {}
        self.session_launches = 0
        self._stop_announced = False
        self.state = self._load_state()

    # ---------------------------------------------------------------- persistence
    def _load_state(self) -> dict:
        if self.state_path.is_file():
            try:
                return json.loads(self.state_path.read_text(encoding="utf-8"))
            except Exception as exc:
                raise RuntimeError(f"state unreadable ({self.state_path}): {exc}") from exc
        return {"version": 1, "created": utcnow(), "grains": {},
                "ramp": new_ramp(self._steps(), self.clock(), fixed=not self.args.ramp),
                "queue_sha256": None}

    def _save_state(self) -> None:
        self.state["updated"] = utcnow()
        atomic_write_json(self.state_path, self.state)

    def _event(self, kind: str, **fields) -> None:
        rec = {"ts": utcnow(), "kind": kind} | fields
        self.state_dir.mkdir(parents=True, exist_ok=True)
        with open(self.journal_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def _steps(self) -> list[int]:
        if self.args.ramp:
            return list(self.args.ramp)
        return [self.args.max_active]

    # ---------------------------------------------------------------- queue merge
    def merge_queue(self, items: list[dict], digest: str) -> list[dict]:
        """Sync state with the queue without ever deleting history."""
        by_key = {grain_key(i): i for i in items}
        grains = self.state["grains"]
        for key in list(grains):
            if key not in by_key and grains[key].get("status") != "withdrawn":
                grains[key]["status"] = "withdrawn"
                grains[key]["finished"] = utcnow()
                self._event("withdrawn", key=key)
        for key, item in by_key.items():
            g = grains.get(key)
            if g is None:
                grains[key] = {"issue": item["issue"], "notebook": item["notebook"],
                               "status": "pending", "attempts": 0, "not_before": None}
                self._event("queued", key=key)
            elif g.get("status") == "withdrawn":
                # an explicit re-add after a withdrawal is an operator decision
                g.update({"status": "pending", "not_before": None,
                          "requeued": utcnow()})
                self._event("requeued", key=key)
        self.state["queue_sha256"] = digest
        self.items_by_key = by_key
        return [by_key[k] for k in by_key]

    def _reconcile_previous_runs(self) -> None:
        """A scheduler that died left 'running' entries it can no longer wait on.

        They are marked orphaned, never silently relaunched: the child process may
        still be alive and a duplicate driver on the same issue would collide on
        worktree, claim and PR. Recovery is an explicit operator gesture.
        """
        for key, g in self.state["grains"].items():
            if g.get("status") == "running":
                g["status"] = "orphaned"
                g["finished"] = utcnow()
                self._event("orphaned", key=key, pid=g.get("pid"),
                            note="previous scheduler instance died; inspect the driver trace before requeueing")

    # ---------------------------------------------------------------- driver/gate
    def _probe_gate(self) -> dict:
        # gate-mode off = no probe at all (finding 2: off was ignored, the probe ran
        # anyway and a missing/custom probe file then read as a blocking verdict).
        if getattr(self.args, "gate_mode", "block") == "off":
            return {"verdict": "green", "running": 0, "waiting": 0,
                    "preemptions": 0, "gate_mode": "off"}
        gate_path = Path(self.args.gate)
        if not gate_path.is_file():
            # A missing probe is NOT a green light and NOT a saturation: fail loud
            # as unknown so the hold reason names the real cause (finding 2).
            return {"verdict": "unknown", "running": 0, "waiting": 0,
                    "error": f"gate probe not found: {gate_path}"}
        p = subprocess.run([sys.executable, str(gate_path)],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=30)
        line = (p.stdout or "").strip().splitlines()[-1] if p.stdout.strip() else ""
        try:
            out = json.loads(line)
        except Exception:
            out = {"verdict": "unknown", "error": (p.stdout or p.stderr)[:300]}
        out["exit"] = p.returncode
        return out

    def _spawn_driver(self, cmd: list[str]):
        return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace")

    def driver_command(self, item: dict) -> list[str]:
        a = self.args
        out_dir = Path(a.out_root) / f"issue-{item['issue']}"
        worktree = Path(a.worktree_root) / f"wt-{item['issue']}"
        cmd = [sys.executable, str(a.driver),
               "--issue", str(item["issue"]), "--notebook", item["notebook"],
               "--repo", a.repo, "--out-dir", str(out_dir),
               "--worktree", str(worktree), "--gate-mode", a.gate_mode]
        opt = [
            ("--lane", a.lane), ("--agent", item.get("agent", a.agent)),
            # round 2: forward the RESOLVED gate path so a custom --gate / $NBCODER_GATE
            # set on the scheduler reaches the driver child without env mutation —
            # the child's env default only fires when this scheduler runs standalone.
            ("--gate", a.gate),
            ("--conventions", a.conventions), ("--intention", item.get("intention", a.intention)),
            ("--source-nb", item.get("source_nb", a.source_nb)),
            ("--max-stage", item.get("max_stage", a.max_stage)),
            ("--write-mode", item.get("write_mode", a.write_mode)),
            ("--exec-mode", item.get("exec_mode", a.exec_mode)),
            ("--kernel-override", item.get("kernel_override", a.kernel_override)),
            ("--verifier-agent", item.get("verifier_agent", a.verifier_agent)),
            # per-step models (#4831): grain value > scheduler default > (driver) preset.
            # spec_mode always forwards — the skip must be DECLARED on the driver command
            # line and traced in its run record, never left to a distant default.
            ("--coder-model", item.get("coder_model", a.coder_model)),
            ("--verifier-model", item.get("verifier_model", a.verifier_model)),
            ("--spec-model", item.get("spec_model", a.spec_model)),
            ("--spec-mode", item.get("spec_mode", a.spec_mode)),
            ("--timeout", item.get("timeout", a.timeout)),
            ("--max-tokens", item.get("max_tokens", a.max_tokens)),
            ("--repair-rounds", item.get("repair_rounds", a.repair_rounds)),
        ]
        for flag, val in opt:
            if val not in (None, ""):
                cmd += [flag, str(val)]
        if item.get("claim", a.claim):
            cmd.append("--claim")
        if item.get("fresh_worktree", a.fresh_worktree):
            cmd.append("--fresh-worktree")
        if item.get("allow_foreign_origin", False):
            cmd.append("--allow-foreign-origin")
        return cmd

    # ---------------------------------------------------------------- ramp
    def _observe_gate(self, gate: dict, now: float) -> None:
        ramp = self.state["ramp"]
        verdict = gate.get("verdict")
        ramp["samples"] += 1
        if verdict == "green":
            ramp["green_samples"] += 1
            if ramp["first_green_ts"] is None:
                ramp["first_green_ts"] = now
        for field, metric in (("running_max", "running"), ("waiting_max", "waiting"),
                              ("preempt_max", "preemptions")):
            v = gate.get(metric)
            if isinstance(v, (int, float)) and v > ramp[field]:
                ramp[field] = v
        if verdict in ("red", "unknown"):
            ramp["dirty"] = True
            if verdict == "red" and not ramp.get("fixed") and self.args.ramp_demote \
               and ramp["step_index"] > 0:
                old = ramp["max_active"]
                report = _step_report(ramp, now)
                ramp["step_index"] -= 1
                ramp["max_active"] = ramp["steps"][ramp["step_index"]]
                self.state.setdefault("ramp_history", []).append(
                    report | {"demoted_from": old, "demoted_to": ramp["max_active"],
                              "reason": "red-gate"})
                _reset_step_counters(ramp, now)
                self._event("ramp-demoted", reason="red-gate",
                            max_active=ramp["max_active"], previous=old)

    def _maybe_promote(self, pending_count: int, now: float) -> None:
        ramp = self.state["ramp"]
        if ramp.get("fixed") or ramp["step_index"] >= len(ramp["steps"]) - 1:
            return
        first_green = ramp.get("first_green_ts")
        green_s = (now - first_green) if first_green is not None else -1
        reasons = []
        if ramp["done"] < self.args.ramp_min_done:
            reasons.append(f"done {ramp['done']}/{self.args.ramp_min_done}")
        if ramp["failed"] > self.args.ramp_max_failures:
            reasons.append(f"failures {ramp['failed']}>{self.args.ramp_max_failures}")
        if ramp.get("dirty"):
            reasons.append("red/unknown seen at this step")
        if green_s < self.args.ramp_green_s:
            reasons.append(f"green {max(green_s, 0):.0f}/{self.args.ramp_green_s}s")
        if pending_count <= 0:
            reasons.append("no pending grain needs the next step")
        if reasons:
            self.state["last_promotion_block"] = "; ".join(reasons)
            return
        report = _step_report(ramp, now)
        ramp["step_index"] += 1
        ramp["max_active"] = ramp["steps"][ramp["step_index"]]
        self.state.setdefault("ramp_history", []).append(report | {"promoted_to": ramp["max_active"]})
        _reset_step_counters(ramp, now)
        self._event("ramp-promoted", max_active=ramp["max_active"],
                    previous=report["max_active"])

    # ---------------------------------------------------------------- lifecycle
    def _reap(self, now: float) -> None:
        for key, entry in list(self.active.items()):
            proc = entry["proc"]
            rc = proc.poll()
            if rc is None:
                continue
            try:
                out, _ = proc.communicate(timeout=5)
            except Exception:
                out = ""
            verdict = ""
            for line in reversed((out or "").strip().splitlines()):
                line = line.strip()
                if line.startswith("{"):
                    try:
                        verdict = json.loads(line).get("verdict") or ""
                    except Exception:
                        continue
                    break
            g = self.state["grains"][key]
            elapsed = round(now - entry["started"], 1)
            g.update({"finished": utcnow(), "returncode": rc,
                      "last_verdict": verdict, "elapsed_s": elapsed})
            ramp = self.state["ramp"]
            if verdict.startswith("deferred-by-capacity-gate"):
                g["status"] = "deferred"
                # attempts counts LAUNCHES; the backoff grows with each refusal.
                wait = min(self.args.backoff_s * max(1, g["attempts"]),
                           self.args.backoff_max_s)
                g["not_before"] = self.clock() + wait
                ramp["deferred"] += 1
                self._event("deferred", key=key, rc=rc, verdict=verdict,
                            retry_in_s=wait)
            elif rc == 0 or any(verdict.endswith(s) for s in DONE_VERDICT_SUFFIXES):
                g["status"] = "done"
                ramp["done"] += 1
                self._event("completed", key=key, rc=rc, verdict=verdict,
                            elapsed_s=elapsed)
            else:
                g["status"] = "failed"
                ramp["failed"] += 1
                self._event("failed", key=key, rc=rc, verdict=verdict,
                            elapsed_s=elapsed)
            del self.active[key]

    def _eligible(self, now: float) -> list[str]:
        out = []
        for key, g in self.state["grains"].items():
            if g.get("status") != "pending" and g.get("status") != "deferred":
                continue
            if g.get("status") == "deferred" and (g.get("not_before") or 0) > now:
                continue
            if g.get("attempts", 0) >= self.args.max_attempts:
                continue
            out.append(key)
        return out

    def _launch(self, key: str, item: dict, cmd: list[str], now: float) -> None:
        proc = self.spawn(cmd)
        g = self.state["grains"][key]
        g.update({"status": "running", "attempts": g.get("attempts", 0) + 1,
                  "started": utcnow(), "pid": getattr(proc, "pid", None),
                  "not_before": None})
        self.active[key] = {"proc": proc, "item": item,
                            "pid": getattr(proc, "pid", None), "started": now}
        self.session_launches += 1
        self._event("launched", key=key, pid=g["pid"], attempt=g["attempts"],
                    gate_mode=self.args.gate_mode, cmd=cmd)

    def tick(self) -> dict:
        now = self.clock()
        # A deferred grain that exhausted its launches must become terminal,
        # otherwise it keeps the scheduler alive forever while never being
        # eligible again.
        for key, g in self.state["grains"].items():
            if g.get("status") == "deferred" and g.get("attempts", 0) >= self.args.max_attempts:
                g["status"] = "failed"
                g["finished"] = utcnow()
                self._event("attempts-exhausted", key=key,
                            attempts=g["attempts"], last_verdict=g.get("last_verdict"))
                self.state["ramp"]["deferred"] = max(
                    self.state["ramp"]["deferred"] - 1, 0)
        self._reap(now)
        gate = self.gate()
        self.state["last_gate"] = gate
        self._observe_gate(gate, now)

        pending = self._eligible(now)
        held = None
        launched = 0
        stop = Path(self.args.stop_file)
        stop_now = stop.is_file()
        if stop_now and not self._stop_announced:
            self._event("stop-file", action="holding-new-launches",
                        running=len(self.active))
            self._stop_announced = True
        if not stop_now:
            self._stop_announced = False

        if stop_now:
            held = "stop-file"
        else:
            # Promotion is evaluated BEFORE the launch loop: otherwise the last
            # pending grain is consumed at the old step and the promotion is
            # deferred one full poll cycle for no reason.
            self._maybe_promote(len(pending), now)
            if gate.get("verdict") != "green":
                held = f"gate-{gate.get('verdict')}"
            elif self.args.max_launch and self.session_launches >= self.args.max_launch:
                held = "session-max-launch"
            else:
                # The ramp target bounds TOTAL engine requests. max(len(active), gate.running)
                # is deliberately conservative: a just-launched driver whose model call has
                # not started yet is counted through len(active), a model call already visible
                # to /metrics through gate.running.
                floor = max(len(self.active), int(gate.get("running") or 0))
                budget = self.state["ramp"]["max_active"] - floor
                for key in pending:
                    if budget <= 0:
                        held = held or "capacity-target"
                        break
                    item = self.items_by_key[key]
                    cmd = self.driver_command(item)
                    if self.args.dry_run:
                        self._event("dry-launch", key=key, cmd=cmd)
                        budget -= 1
                        continue
                    self._launch(key, item, cmd, self.clock())
                    launched += 1
                    budget -= 1
        if held:
            self._event("held", reason=held, pending=len(pending),
                        active=len(self.active), gate=gate.get("verdict"))
        self._save_state()
        return {"gate": gate.get("verdict"), "launched": launched,
                "active": len(self.active), "held": held,
                "max_active": self.state["ramp"]["max_active"]}

    def unfinished(self) -> bool:
        now = self.clock()
        return bool(self.active) or any(
            g.get("status") in ("pending", "running", "deferred")
            and not (g.get("status") == "deferred"
                     and (g.get("not_before") or 0) > now + self.args.max_future_s)
            for g in self.state["grains"].values())

    def run(self) -> int:
        self._reconcile_previous_runs()
        deadline = self.clock() + self.args.timeout_s if self.args.timeout_s else None
        while True:
            summary = self.tick()
            if self.args.once:
                return 0
            if deadline and self.clock() >= deadline:
                self._event("timeout", active=len(self.active))
                return 0
            if not self.args.watch and not self.unfinished():
                self._event("drained", done=sum(g.get("status") == "done"
                                                for g in self.state["grains"].values()),
                            failed=sum(g.get("status") == "failed"
                                       for g in self.state["grains"].values()),
                            ramp=self.state["ramp"])
                return 0
            if self.args.watch:
                # finding 3 (--watch never reloaded the queue): re-read the file each
                # poll and merge on digest change, so grains APPENDED after the queue
                # drained are picked up without a scheduler restart. merge_queue keeps
                # history (running grains untouched, missing -> withdrawn, re-added ->
                # requeued). A parse/read error keeps the last good queue (fail-safe:
                # never wipe state on a half-written file).
                try:
                    items, digest = load_queue(Path(self.args.queue))
                    if digest != self.state.get("queue_sha256"):
                        self.merge_queue(items, digest)
                        self._event("queue-reloaded", digest=digest[:12],
                                    grains=len(items))
                except Exception as exc:
                    self._event("queue-reload-error", error=str(exc)[:200])
            self.sleep(self.args.poll_s)


class FakeProc:
    """Test double for a driver subprocess: completes after `done_after` polls."""

    def __init__(self, verdict="built-executed-ok", rc=0, done_after=1):
        self.verdict = verdict
        self.rc = rc
        self.pid = 4242
        self.done_after = done_after
        self._polls = 0

    def poll(self):
        self._polls += 1
        return self.rc if self._polls > self.done_after else None

    def communicate(self, timeout=None):
        return json.dumps({"issue": 0, "verdict": self.verdict}), ""


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--queue", required=True, type=Path)
    ap.add_argument("--state-dir", required=True, type=Path)
    ap.add_argument("--driver", type=Path,
                    default=HERE / "nb_coder_driver.py")
    ap.add_argument("--gate", type=Path,
                    default=Path(os.environ["NBCODER_GATE"]) if os.environ.get("NBCODER_GATE")
                    else HERE.parent / "swift_capacity_gate.py",
                    help="capacity-gate probe script (default: $NBCODER_GATE if set, "
                         "else the sibling swift_capacity_gate.py)")
    ap.add_argument("--repo", required=True,
                    help="CoursIA checkout (passed through to the driver)")
    ap.add_argument("--lane", default=os.environ.get("NBCODER_LANE", ""),
                    help="claim lane id, e.g. myia-ai-01:nb-coder")
    ap.add_argument("--claim", action="store_true")
    ap.add_argument("--agent", default="notebook-coder")
    ap.add_argument("--conventions", default="")
    ap.add_argument("--intention", default="volet vllm du harnais nb-coder (passe planifiee)")
    ap.add_argument("--max-stage", type=int, choices=[0, 1, 2, 3, 4, 5], default=2)
    ap.add_argument("--write-mode", choices=["json", "mcp"], default="json")
    ap.add_argument("--exec-mode", choices=["auto", "all", "plan"], default="auto")
    ap.add_argument("--kernel-override", default=None)
    ap.add_argument("--source-nb", default=None,
                    help="default --source-nb (creation mode) for queue items without one")
    ap.add_argument("--verifier-agent", default="critic")
    # per-step model selection (#4831): scheduler-level defaults, overridable PER GRAIN in
    # the queue (item keys coder_model/verifier_model/spec_model/spec_mode). The
    # difficulty->model mapping is documented in the harness README, never hardcoded.
    ap.add_argument("--coder-model", default=os.environ.get("NBCODER_CODER_MODEL"))
    ap.add_argument("--verifier-model", default=os.environ.get("NBCODER_VERIFIER_MODEL"))
    ap.add_argument("--spec-model", default=os.environ.get("NBCODER_SPEC_MODEL"))
    ap.add_argument("--spec-mode", choices=["skip", "run"],
                    default=os.environ.get("NBCODER_SPEC_MODE", "skip"))
    ap.add_argument("--timeout", type=int, default=1500)
    ap.add_argument("--max-tokens", type=int, default=16384)
    ap.add_argument("--repair-rounds", type=int, default=2,
                    help="model repair rounds on real kernel errors (driver flag, 0=off)")
    ap.add_argument("--gate-mode", choices=["warn", "block", "off"], default="block")
    ap.add_argument("--max-active", type=int, default=0,
                    help="fixed total-request target (or use --ramp)")
    ap.add_argument("--ramp", type=lambda s: [int(x) for x in s.split(",")],
                    help="measured ramp, e.g. 2,3,4")
    ap.add_argument("--ramp-min-done", type=int, default=3,
                    help="clean completions required before promotion")
    ap.add_argument("--ramp-green-s", type=float, default=600,
                    help="cumulative green time required before promotion")
    ap.add_argument("--ramp-max-failures", type=int, default=0)
    ap.add_argument("--ramp-demote", action="store_true",
                    help="step DOWN one ramp level on a red gate (in-flight grains continue)")
    ap.add_argument("--poll-s", type=float, default=30.0)
    ap.add_argument("--backoff-s", type=float, default=60.0)
    ap.add_argument("--backoff-max-s", type=float, default=900.0)
    ap.add_argument("--max-attempts", type=int, default=6)
    ap.add_argument("--max-launch", type=int, default=0,
                    help="cap launches in THIS scheduler run (0 = unlimited)")
    ap.add_argument("--max-future-s", type=float, default=86400.0,
                    help="a deferred grain further than this still counts as unfinished")
    ap.add_argument("--timeout-s", type=float, default=0,
                    help="wall-clock budget for the scheduler itself (0 = none)")
    ap.add_argument("--out-root", default=None,
                    help="driver run roots (default <state-dir>/runs)")
    ap.add_argument("--worktree-root", default=None,
                    help="driver worktrees (default <state-dir>/worktrees)")
    ap.add_argument("--fresh-worktree", action="store_true")
    ap.add_argument("--stop-file", default=None,
                    help="freeze new launches when this file exists (default <state-dir>/STOP)")
    ap.add_argument("--watch", action="store_true",
                    help="keep running after the queue drains (wait for new lines)")
    ap.add_argument("--once", action="store_true",
                    help="one reconciliation pass, then exit (tests / inspection)")
    ap.add_argument("--dry-run", action="store_true",
                    help="log the exact driver commands without spawning anything")
    args = ap.parse_args(argv)
    if not args.ramp:
        if args.max_active < 1:
            ap.error("give either --ramp 2,3,4 or --max-active N")
    else:
        if any(s <= 0 for s in args.ramp):
            ap.error("--ramp steps must be >= 1")
        if len(set(args.ramp)) != len(args.ramp):
            ap.error("--ramp steps must be distinct")
        if args.ramp != sorted(args.ramp):
            ap.error("--ramp steps must be increasing (a ramp that starts high measures nothing)")
    if args.claim and not args.lane:
        ap.error("--claim requires --lane or NBCODER_LANE (same refusal as the driver, F1)")
    if not args.out_root:
        args.out_root = str(Path(args.state_dir) / "runs")
    if not args.worktree_root:
        args.worktree_root = str(Path(args.state_dir) / "worktrees")
    if not args.stop_file:
        args.stop_file = str(Path(args.state_dir) / "STOP")
    # Paths handed to the DRIVER must be ABSOLUTE. The worktree path reaches
    # `git -C <repo> worktree add <path>`, which resolves a relative path against
    # the REPO root, while the driver resolves the same path against its own cwd —
    # the two disagree and the driver then reports source-nb-not-found on a
    # worktree that exists (measured 17/11 21:30Z: 10/10 wave-1 grains failed,
    # worktrees materialized under <repo>/.tmp/... instead of <vllm>/.tmp/...).
    for name in ("state_dir", "out_root", "worktree_root", "stop_file"):
        setattr(args, name, str(Path(getattr(args, name)).resolve()))
    return args


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        items, digest = load_queue(args.queue)
    except QueueError as exc:
        print(json.dumps({"verdict": "queue-invalid", "error": str(exc)}))
        return 2
    sched = Scheduler(args)
    sched.merge_queue(items, digest)
    try:
        return sched.run()
    except KeyboardInterrupt:
        # No child is killed: the admission contract protects calls in flight.
        # They are left running and marked for explicit operator reconciliation.
        for key, entry in list(sched.active.items()):
            sched.state["grains"][key]["status"] = "running"
            sched._event("scheduler-interrupted", key=key, pid=entry.get("pid"),
                         action="child-left-running")
        sched._save_state()
        print(json.dumps({"verdict": "interrupted", "active": len(sched.active),
                          "pids": [e.get("pid") for e in sched.active.values()]}))
        return 130


if __name__ == "__main__":
    sys.exit(main())
