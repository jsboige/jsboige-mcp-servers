#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 9683ab2f5165f374bbb387132288c2cbf7cc6084
# original path: myia_vllm/scripts/adoption/nb_coder/nb_coder_scheduler.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
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
    "from_spec": bool,         # creation with NO twin (--from-spec): the issue's cell plan is
                               # the reference; exclusive with source_nb, requires meta_from
    "meta_from": str,          # --meta-from: repo-relative notebook whose kernelspec the new one
                               # inherits; required with from_spec, optional with source_nb
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
    "spec_mode": str,           # "skip" (default) | "run" -- the skip is a DECLARED choice
                                # of the calling lane, traced on the driver's run record
    "timeout": int,
    "max_tokens": int,
    "repair_rounds": int,
    "revise_rounds": int,      # constructive-review rounds after a verify-reject
    "allow_foreign_origin": bool,
    "retry": int,              # retry generation: raise it to re-offer a FAILED grain once
                               # (scheduler-only, never passed to the driver)
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

# Failures where the engine served the whole conversation and the harness reached a
# CONTENT judgement: the notebook did not pass, the capacity did not fail. They prove a
# served run for the ramp and never block its promotion. Measured 20/11 -> 21/11: one
# built-execution-failed on CoursIA#27302 (a C# parity grain, the hard class) froze the
# ramp at its floor for 7 h ("failures 1>0"), with the gate green 791/858 samples. Every
# other failure (call-failed, timeouts, no-answer, crash, kernel, verify-error, an
# unknown verdict) stays a run failure and blocks, as before: unknown is never content.
CONTENT_FAILURE_PREFIXES = (
    "built-execution-failed",
    "built-structure-mismatch",
    "built-executed-counts-broken",
    "gates-failed",
    "verify-reject",
    "stage1-unaddressable-creation-plan",
    "refused-spec-plan-unusable",
    "stage2-short-segment",
)


def failure_class(verdict: str | None) -> str:
    """'content' for a judged notebook that did not pass, 'run' for everything else."""
    v = (verdict or "").strip()
    return "content" if any(v.startswith(p) for p in CONTENT_FAILURE_PREFIXES) else "run"



class QueueError(ValueError):
    pass


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _iso_to_epoch(stamp) -> float | None:
    try:
        return datetime.fromisoformat(str(stamp)).timestamp()
    except (TypeError, ValueError):
        return None


def process_identity(pid) -> tuple[float, str] | None:
    """(create_time, command line) of a live process, None when gone or unreadable.

    Needs psutil. Without it every probe answers None, so a restarted scheduler
    marks its previous grains orphaned, which is the behaviour from before adoption.
    """
    try:
        import psutil
        p = psutil.Process(int(pid))
        return p.create_time(), " ".join(p.cmdline())
    except Exception:
        return None


# A driver started before the window opened, or after it closed, is another process
# that reused the pid. psutil's create_time and our own `started` stamp are both
# taken around the Popen call; the slack covers Windows process start-up time.
ADOPT_START_SLACK_BEFORE_S = 5.0
ADOPT_START_SLACK_AFTER_S = 120.0
# The return code of a process we did not spawn is unknowable. The driver exits 0
# exactly when its verdict ends with a DONE suffix (driver main()), so _reap
# classifies an adopted driver on its verdict alone. This sentinel is never 0.
ADOPTED_RC = -1


class AdoptedDriver:
    """A driver launched by a previous scheduler instance and still running.

    It is not our child, so there is no Popen to poll. Its identity is the pid plus
    the process create time read at adoption; poll() reports it finished as soon as
    that pair no longer names a live process. Its output is the driver.log the
    previous instance redirected it to, read from the offset recorded at launch.
    """

    def __init__(self, pid: int, create_time: float, log: str,
                 log_offset: int | None, probe):
        self.pid = pid
        self._create_time = create_time
        self._nb_driver_log = log
        self._nb_log_offset = log_offset
        self._probe = probe

    def poll(self):
        ident = self._probe(self.pid)
        if ident is not None and abs(ident[0] - self._create_time) < 1.0:
            return None
        return ADOPTED_RC


def grain_key(item: dict) -> str:
    return f"#{item['issue']}:{item['notebook']}"


def grain_slug(item: dict) -> str:
    """Per-GRAIN name for the run dir and the worktree: `<issue>-<8 hex of the notebook>`.

    A lot issue carries several notebooks (CoursIA#27133: five Rust ports). Named
    `issue-<N>` / `wt-<N>`, two grains of one lot shared one run dir (driver.log,
    the built notebook and the verdict record overwritten) and one worktree: the
    second driver's prepare_worktree reuses a tree that is still clean while the
    first builds in it, then both write there. The hash keeps the Windows path short
    (the CoursIA notebook paths are already long) and is stable across reloads."""
    nb = "/".join(seg for seg in str(item["notebook"]).replace("\\", "/").split("/")
                  if seg not in ("", "."))
    return f"{item['issue']}-{hashlib.sha1(nb.encode('utf-8')).hexdigest()[:8]}"


def _check_repo_rel_nb(lineno: int, field: str, nb) -> None:
    if not isinstance(nb, str) or not nb.endswith(".ipynb"):
        raise QueueError(f"queue line {lineno}: {field} must be a repo-relative .ipynb path")
    if ":" in nb[:3] or nb.startswith(("/", "\\")) or ".." in Path(nb).parts:
        raise QueueError(f"queue line {lineno}: {field} must be repo-relative, no ..: {nb}")


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
        _check_repo_rel_nb(lineno, "notebook", item["notebook"])
        for k, ty in ITEM_FIELDS.items():
            if k in item and not isinstance(item[k], ty):
                raise QueueError(f"queue line {lineno}: field {k} must be {ty.__name__}")
        # Same refusals as the driver's CLI guards, raised at load: a bad spec grain
        # fails loud here instead of burning an attempt on a driver exit 2.
        if item.get("from_spec"):
            if "source_nb" in item:
                raise QueueError(f"queue line {lineno}: from_spec and source_nb are exclusive")
            if "meta_from" not in item:
                raise QueueError(f"queue line {lineno}: from_spec requires meta_from")
            if item.get("write_mode") == "mcp":
                raise QueueError(f"queue line {lineno}: from_spec requires write_mode json")
        elif "meta_from" in item and "source_nb" not in item:
            raise QueueError(f"queue line {lineno}: meta_from is only read in creation mode "
                             "(from_spec or source_nb)")
        if "meta_from" in item:
            _check_repo_rel_nb(lineno, "meta_from", item["meta_from"])
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
        "content_failed": 0,
        "deferred": 0,
        "first_green_ts": None,
        "dirty": False,          # red or unknown seen since the step started (evidence)
        "samples": 0,
        "green_samples": 0,
        "running_max": 0.0,
        "waiting_max": 0.0,
        "preempt_max": 0.0,
    }


def _step_report(ramp: dict, now: float) -> dict:
    return {k: ramp.get(k) for k in (
        "steps", "step_index", "max_active", "step_started", "done", "failed",
        "content_failed",
        "deferred", "dirty", "samples", "green_samples", "running_max",
        "waiting_max", "preempt_max")} | {"step_ended": now,
                                          "duration_s": round(now - ramp["step_started"], 1)}


def _reset_step_counters(ramp: dict, now: float) -> None:
    """Keep the ramp position, reset the promotion evidence."""
    ramp.update({"step_started": now, "done": 0, "failed": 0, "content_failed": 0,
                 "deferred": 0,
                 "first_green_ts": None, "dirty": False, "samples": 0,
                 "green_samples": 0, "running_max": 0.0, "waiting_max": 0.0,
                 "preempt_max": 0.0})


class Scheduler:
    """Pure orchestration. spawn/gate/sleep/clock are injectable for offline tests."""

    def __init__(self, args, spawn=None, gate=None, sleep=None, clock=None, probe=None):
        self.args = args
        self.process_probe = probe or process_identity
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
                               "status": "pending", "attempts": 0, "not_before": None,
                               "retry": item.get("retry", 0)}
                self._event("queued", key=key)
            elif g.get("status") == "withdrawn":
                # an explicit re-add after a withdrawal is an operator decision
                g.update({"status": "pending", "not_before": None,
                          "requeued": utcnow(), "retry": item.get("retry", 0)})
                self._event("requeued", key=key)
            elif item.get("retry", 0) > g.get("retry", 0):
                self._apply_retry(key, g, item["retry"])
        self.state["queue_sha256"] = digest
        self.items_by_key = by_key
        return [by_key[k] for k in by_key]

    def _apply_retry(self, key: str, g: dict, retry: int) -> None:
        """A raised `retry` generation re-offers a FAILED grain, once per generation.

        A failed grain is terminal, and withdrawing it is no way out: the queue it was alone
        in cannot be emptied (an empty queue is a reload error, fail-safe against a
        half-written file), and a withdraw/re-add dance costs two watched edits. Measured
        20/11 on CoursIA#27314: the harness defect that failed the grain was fixed and merged
        (#509) while the scheduler kept it terminal for want of a gesture.

        Only `failed` is re-offered. `done` delivered a PR, so running it again is a new grain
        and not a retry. `orphaned` may still have a live driver, and its recovery is the
        reconciliation gesture. A generation raised on any other status is absorbed, so it
        can never fire later on a failure it was not written for. Attempts restart at 0
        because they count deferrals of one try, and the previous count is kept in the event.
        """
        status = g.get("status")
        g["retry"] = retry
        if status != "failed":
            self._event("retry-ignored", key=key, retry=retry, status=status)
            return
        self._event("requeued", key=key, retry=retry, previous_attempts=g.get("attempts", 0),
                    previous_verdict=g.get("last_verdict"))
        g.update({"status": "pending", "not_before": None, "attempts": 0,
                  "requeued": utcnow()})

    def _legacy_driver_log(self, key: str, pid) -> str | None:
        """driver.log of a grain launched before `driver_log` was recorded in the state.

        Read from the journal's last `launched` event for this key and pid: its command
        carries the --out-dir the driver was redirected to. Recomputing the command
        instead would name the CURRENT layout, which a driver started by older code
        does not write to.
        """
        found = None
        try:
            with open(self.journal_path, encoding="utf-8") as fh:
                for line in fh:
                    if '"launched"' not in line:
                        continue
                    try:
                        ev = json.loads(line)
                    except Exception:
                        continue
                    if ev.get("kind") == "launched" and ev.get("key") == key and ev.get("pid") == pid:
                        found = ev.get("cmd")
        except OSError:
            return None
        if found and "--out-dir" in found:
            return str(Path(found[found.index("--out-dir") + 1]) / "driver.log")
        return None

    def _try_adopt(self, key: str, g: dict) -> str | None:
        """Adopt a running grain's driver if it is still the process we launched.

        Returns a reason string when adoption is refused, None once adopted.
        """
        pid = g.get("pid")
        if not pid:
            return "no pid recorded"
        log = g.get("driver_log") or self._legacy_driver_log(key, pid)
        if not log:
            return "driver log unknown"
        started = _iso_to_epoch(g.get("started"))
        ident = self.process_probe(pid)
        if ident is None:
            # The driver is gone. Its verdict is in the log only if the offset of this
            # attempt is known: from 0, a log appended across attempts could hand back
            # an earlier attempt's last line.
            if g.get("driver_log_offset") is None:
                return "driver exited while no scheduler watched it; its attempt offset is unknown"
            create_time = 0.0
        else:
            create_time, cmdline = ident
            if "nb_coder_driver" not in cmdline:
                return "pid reused by another program"
            if started is None or not (started - ADOPT_START_SLACK_BEFORE_S
                                       <= create_time
                                       <= started + ADOPT_START_SLACK_AFTER_S):
                return "pid reused by a process started outside the launch window"
        proc = AdoptedDriver(pid, create_time, log, g.get("driver_log_offset"),
                             self.process_probe)
        item = self.items_by_key.get(key) or {"issue": g.get("issue"),
                                              "notebook": g.get("notebook")}
        self.active[key] = {"proc": proc, "item": item, "pid": pid,
                            "started": started if started is not None else self.clock()}
        g["adopted"] = True
        self._event("adopted", key=key, pid=pid, alive=ident is not None, log=log,
                    log_offset=g.get("driver_log_offset"))
        return None

    def _reconcile_previous_runs(self) -> None:
        """A scheduler that died left 'running' entries it can no longer wait on.

        A driver that is still the process we launched (same pid, a create time inside
        the launch window, a driver command line) is ADOPTED: it is watched by pid and
        its verdict read from its driver.log, so the scheduler can be restarted on new
        code without waiting for the grains in flight. Measured 20/11: a driver
        survives the death of the scheduler that launched it.

        Anything else is marked orphaned, never silently relaunched: a duplicate
        driver on the same grain would collide on worktree, claim and PR. Recovery
        is then an explicit operator gesture.
        """
        for key, g in self.state["grains"].items():
            if g.get("status") != "running":
                continue
            refused = self._try_adopt(key, g)
            if refused is None:
                continue
            g["status"] = "orphaned"
            g["finished"] = utcnow()
            self._event("orphaned", key=key, pid=g.get("pid"), reason=refused,
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
        # Wave-1b hang (18/11 00:27->03:35Z, py-spy post-mortem in the state dir):
        # PIPE + read-at-reap-only means NOBODY drains the driver's output while
        # it runs. The driver relays its MCP children's stderr (stdio_client
        # errlog defaults to the parent's stderr), so a chatty child fills the
        # 64 KiB OS pipe, the child then blocks inside StreamHandler.emit, the
        # MCP initialize handshake never completes and the driver waits forever.
        # Writing straight to runs/issue-N/driver.log removes the cap AND gives
        # the operator live logs (this post-mortem took hours without them).
        if "--out-dir" in cmd:
            out_dir = Path(cmd[cmd.index("--out-dir") + 1])
            out_dir.mkdir(parents=True, exist_ok=True)
            log = out_dir / "driver.log"
            # The log is appended across attempts. Reading it from the start made a
            # relaunch that died without a verdict inherit the previous attempt's
            # last JSON line (a deferral read as a deferral again, for instance).
            offset = log.stat().st_size if log.is_file() else 0
            fh = open(log, "ab")
            try:
                proc = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT)
            finally:
                fh.close()
            proc._nb_driver_log = str(log)          # reap-side marker
            proc._nb_log_offset = offset
            return proc
        return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace")

    def driver_command(self, item: dict) -> list[str]:
        a = self.args
        from_spec = bool(item.get("from_spec", False))
        out_dir = Path(a.out_root) / f"issue-{grain_slug(item)}"
        worktree = Path(a.worktree_root) / f"wt-{grain_slug(item)}"
        cmd = [sys.executable, str(a.driver),
               "--issue", str(item["issue"]), "--notebook", item["notebook"],
               "--repo", a.repo, "--out-dir", str(out_dir),
               "--worktree", str(worktree), "--gate-mode", a.gate_mode]
        source_nb = None if from_spec else item.get("source_nb", a.source_nb)
        opt = [
            ("--lane", a.lane), ("--agent", item.get("agent", a.agent)),
            # round 2: forward the RESOLVED gate path so a custom --gate / $NBCODER_GATE
            # set on the scheduler reaches the driver child without env mutation —
            # the child's env default only fires when this scheduler runs standalone.
            ("--gate", a.gate),
            ("--conventions", a.conventions), ("--intention", item.get("intention", a.intention)),
            # a spec grain never inherits the scheduler's default twin: the driver
            # refuses --from-spec together with --source-nb
            ("--source-nb", source_nb),
            # creation grains only: mandatory for from_spec, optional for a port whose
            # folder has no sibling with the target's language tag
            ("--meta-from", item.get("meta_from") if (from_spec or source_nb) else None),
            ("--max-stage", item.get("max_stage", a.max_stage)),
            ("--write-mode", item.get("write_mode", a.write_mode)),
            ("--exec-mode", item.get("exec_mode", a.exec_mode)),
            ("--kernel-override", item.get("kernel_override", a.kernel_override)),
            ("--verifier-agent", item.get("verifier_agent", a.verifier_agent)),
            # per-step models (#4831): grain value > scheduler default > (driver) preset.
            # spec_mode always forwards -- the skip must be DECLARED on the driver command
            # line and traced in its run record, never left to a distant default.
            ("--coder-model", item.get("coder_model", a.coder_model)),
            ("--verifier-model", item.get("verifier_model", a.verifier_model)),
            ("--spec-model", item.get("spec_model", a.spec_model)),
            ("--spec-mode", item.get("spec_mode", a.spec_mode)),
            ("--timeout", item.get("timeout", a.timeout)),
            ("--max-tokens", item.get("max_tokens", a.max_tokens)),
            ("--repair-rounds", item.get("repair_rounds", a.repair_rounds)),
            ("--revise-rounds", item.get("revise_rounds", a.revise_rounds)),
        ]
        for flag, val in opt:
            if val not in (None, ""):
                cmd += [flag, str(val)]
        if from_spec:
            cmd.append("--from-spec")
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
            # A red or unknown sample restarts the green window. It used to set a flag
            # that blocked promotion for the rest of the step, and step 0 has no demotion
            # to reset it: one unknown probe at 13:00 froze the ramp at its first step for
            # the whole session (measured 20/11, "red/unknown seen at this step" while the
            # gate had been green for hours). The step must now hold ramp_green_s of
            # continuous green after its last red or unknown sample.
            ramp["first_green_ts"] = None
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

    def _step_failures(self, ramp: dict, cls: str = "run") -> int:
        """Grains that failed during this step and are still failed.

        A counter incremented at each failure kept a grain's failure as evidence after
        the grain had been retried: CoursIA#27314 failed on a harness defect, the fix
        was merged (#509) and the grain relaunched, and its failure still blocked the
        promotion of step 0. The latest outcome of a grain is what counts; a retried
        grain that fails again counts again. A failure recorded before this rule
        carries no `ramp_failed_ts` and is not counted.

        cls splits them by failure_class: "run" failures block the promotion, "content"
        ones count as served runs. The class is read from the grain's latest verdict, so
        a failure recorded before the split classifies the same way.
        """
        since = ramp.get("step_started") or 0
        return sum(1 for g in self.state["grains"].values()
                   if g.get("status") == "failed"
                   and g.get("ramp_failed_ts") is not None
                   and g["ramp_failed_ts"] >= since
                   and failure_class(g.get("last_verdict")) == cls)

    def _maybe_promote(self, pending_count: int, now: float) -> None:
        ramp = self.state["ramp"]
        if ramp.get("fixed") or ramp["step_index"] >= len(ramp["steps"]) - 1:
            return
        first_green = ramp.get("first_green_ts")
        green_s = (now - first_green) if first_green is not None else -1
        reasons = []
        ramp["content_failed"] = self._step_failures(ramp, "content")
        served = ramp["done"] + ramp["content_failed"]
        if served < self.args.ramp_min_done:
            reasons.append(f"served {served}/{self.args.ramp_min_done} "
                           f"(done {ramp['done']} + content-failed {ramp['content_failed']})")
        ramp["failed"] = self._step_failures(ramp, "run")
        if ramp["failed"] > self.args.ramp_max_failures:
            reasons.append(f"failures {ramp['failed']}>{self.args.ramp_max_failures}")
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
    def _driver_output(self, entry: dict) -> str:
        """Final driver output: the pipe for piped children (tests/fakes), the
        driver.log tail for file-redirected ones (see _spawn_driver)."""
        proc = entry["proc"]
        log = getattr(proc, "_nb_driver_log", None)
        if log:                                        # file-redirected real child
            try:
                data = Path(log).read_bytes()
            except Exception:
                return ""
            offset = getattr(proc, "_nb_log_offset", None) or 0
            return data[offset:].decode("utf-8", errors="replace")
        if hasattr(proc, "communicate"):               # piped Popen and test fakes
            try:
                out, _ = proc.communicate(timeout=5)
                return out or ""
            except Exception:
                return ""
        return getattr(proc, "stdout", "") or ""

    def _reap(self, now: float) -> None:
        for key, entry in list(self.active.items()):
            proc = entry["proc"]
            rc = proc.poll()
            if rc is None:
                continue
            out = self._driver_output(entry)
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
                g["ramp_failed_ts"] = now
                cls = failure_class(verdict)
                counter = "content_failed" if cls == "content" else "failed"
                ramp[counter] = ramp.get(counter, 0) + 1
                self._event("failed", key=key, rc=rc, verdict=verdict,
                            elapsed_s=elapsed, failure_class=cls)
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
                  "not_before": None,
                  # what a restarted scheduler needs to adopt this driver
                  "driver_log": getattr(proc, "_nb_driver_log", None),
                  "driver_log_offset": getattr(proc, "_nb_log_offset", None)})
        g.pop("adopted", None)
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
        held_extra: dict = {}
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
                gap = float(getattr(self.args, "launch_gap_s", 0) or 0)
                for key in pending:
                    if budget <= 0:
                        held = held or "capacity-target"
                        break
                    # #506 palier 1 — launch in canon, not in cohorts. Every launch
                    # in one tick makes a homogeneous cohort whose conversations all
                    # grow together (the funnel). With a gap, at most one grain starts
                    # per gap, so the grains in flight sit at different stages. The
                    # timestamp is persisted: a restarted scheduler keeps the spacing.
                    if gap > 0:
                        last = self.state.get("last_launch_ts")
                        wait = (last + gap - self.clock()) if last is not None else 0.0
                        if wait > 0:
                            held = "launch-gap"
                            held_extra["next_launch_in_s"] = round(wait, 1)
                            break
                    item = self.items_by_key[key]
                    cmd = self.driver_command(item)
                    self.state["last_launch_ts"] = self.clock()
                    if self.args.dry_run:
                        self._event("dry-launch", key=key, cmd=cmd)
                        budget -= 1
                        continue
                    self._launch(key, item, cmd, self.clock())
                    launched += 1
                    budget -= 1
        if held:
            self._event("held", reason=held, pending=len(pending),
                        active=len(self.active), gate=gate.get("verdict"), **held_extra)
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
    ap.add_argument("--revise-rounds", type=int, default=2,
                    help="constructive-review rounds after a verify-reject with findings "
                         "(driver flag, 0=off)")
    ap.add_argument("--gate-mode", choices=["warn", "block", "off"], default="block")
    ap.add_argument("--max-active", type=int, default=0,
                    help="fixed total-request target (or use --ramp)")
    ap.add_argument("--ramp", type=lambda s: [int(x) for x in s.split(",")],
                    help="measured ramp, e.g. 2,3,4")
    ap.add_argument("--ramp-min-done", type=int, default=3,
                    help="served runs required before promotion: clean completions + "
                         "content failures (a judged notebook that did not pass)")
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
    ap.add_argument("--launch-gap-s", type=float, default=0.0,
                    help="minimum seconds between two grain launches, so grains in flight "
                         "sit at different stages instead of one cohort (#506 palier 1; "
                         "0 = every free slot is filled in the same tick, the old behavior)")
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
    if args.launch_gap_s < 0:
        ap.error("--launch-gap-s must be >= 0")
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
