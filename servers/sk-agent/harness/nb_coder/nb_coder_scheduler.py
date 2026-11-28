#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/nb_coder_scheduler.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
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
import re
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
    "claim_late": bool,        # --claim-late: no [CLAIMED] before an openable PR (CoursIA
                               # auto-pick rule 21/11); needs claim and max_stage 5
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
    "revise_from": str,        # --revise-from <issue-N.json> (22/11): RESUME a content failure
                               # (verify-reject / gates-failed / built-execution-failed) on its
                               # already-built notebook — no new plan, no new build. 41 such
                               # grains were rebuilt from scratch or released instead (w3a-w3x)
    "verify_from": str,        # --verify-from <issue-N.json>: re-verify a crashed verifier
    "retry": int,              # retry generation: raise it to re-offer a FAILED grain once
                               # (scheduler-only, never passed to the driver)
}
# Verdicts the driver itself treats as success (its own exit-0 list, kept in
# sync so a rc!=0 wrapper around a successful verdict is still classified done).
# Verdicts a driver emits when the grain itself did nothing wrong and the same launch
# should simply happen later: the capacity gate refused, or the claim guard never
# answered (deferred-by-claim-timeout, 21/11: it used to surface as `crashed:`).
# deferred-by-claim-implicit-occupation (21/11): another lane's open PR on the same LOT
# issue, disjoint from this notebook, made the guard answer IMPLICIT; it clears when
# that PR merges.
# deferred-by-github-rate-limit (21/11): the shared per-user REST bucket ran dry
# (0/5000) and CoursIA#27134's 2.3c died at its issue fetch, 30 s after launch, as a
# `crashed:` run failure that consumed its retry and blocked the ramp. Nothing in the
# grain was wrong; it waits until the bucket refills (`:reset=<epoch>`, read by the driver
# from the free rate_limit endpoint) and launches again.
# deferred-by-provider-rate-limit (23/11): a MODEL provider's 429. Measured 00:08-00:09Z on
# po-2028:claudish: a five-hour usage window ran dry under two concurrent batches, four
# stage-2 builds died as `stage2-call-failed: … 'rate_limit_error' …` — run failures, each
# one posting [RELEASED], which CoursIA's guard reads as a three-day, fleet-wide RELACHEE on
# notebooks nothing had judged; a fifth, released on the reject a walled revision round never
# answered, met the same refusal one call later. The driver names the refusal bare; `:wall`
# marks a window wall, probed hourly (PROVIDER_WALL_WAIT_S) rather than waited out on its
# announced clock.
# ... the same verdict also carries a KEY's credit wall (27/11), which a provider answers
# with a 403 (`Key limit exceeded (total limit). … does not reset`) instead of a 429: same
# deferral, never `:wall` — a dead cascade leg announces no reset to wait on.
# deferred-by-endpoint-unreachable (26/11): the transport to the model endpoint was CUT.
# Measured 01:27Z on po-2028:claudish (batch o42, CoursIA#28664): the Docker engine of the
# host restarted mid-run, the proxy came back at 01:28:11Z, and a build call died on
# `APIConnectionError('Connection error.')` (httpcore2.ReadError). Classed a run failure, it
# spent the grain's first launch for a refusal the grain never caused. Ordinary backoff: a
# restart is over in seconds to minutes, and the launches are bounded by --max-attempts.
PROVIDER_RATE_LIMIT_VERDICT = "deferred-by-provider-rate-limit"
ENDPOINT_UNREACHABLE_VERDICT = "deferred-by-endpoint-unreachable"
DEFERRED_VERDICT_PREFIXES = (
    "deferred-by-capacity-gate",
    "deferred-by-claim-timeout",
    "deferred-by-claim-implicit-occupation",
    "deferred-by-github-rate-limit",
    PROVIDER_RATE_LIMIT_VERDICT,
    ENDPOINT_UNREACHABLE_VERDICT,
)
# A reset further than this is not believed: the core bucket refills every hour.
GITHUB_RESET_MAX_S = 3700.0
GITHUB_RESET_MARGIN_S = 30.0
# The floor a provider window wall is probed at. The announced reset is not waited on: read
# as UTC, the measured sample (reset at 08:48:53 for a wall met at 00:09Z) outlasts the
# five-hour window the same message names, so its clock's offset is unknown. One hour is the
# finest step that still walks that longest measured wall inside the default six launches —
# the first meets the wall, the next five land at 1h, 2h, 3h, 4h and 5h — and a relaunch into
# a wall that holds costs one short call, so a step too short is cheap where a step too long
# is the grain idle.
PROVIDER_WALL_WAIT_S = 3600.0

# A recent [RELEASED] is a TEMPORARY qualification refusal, not a cross-lane
# collision and not a failed notebook. CoursIA's authoritative guard applies a
# three-day window (coordination/tapis_rapide.py: RELACHE_J = 3). Its current
# machine-facing output exposes only an age rounded to 0.1 day, not released_at,
# so waiting from the rounded age could resume before the real expiry. Until the
# guard exports the exact timestamp, defer for the WHOLE window from this refusal,
# plus a minute. This may retry later than necessary; it can never retry early.
# The next launch starts with the same read-only qualification check, which remains
# the sole authority. Permanent GEL/LABEL/HORSFLOTTE refusals are deliberately absent.
CLAIM_RELEASED_VERDICT = "refused-claim-not-qualified:RELACHEE"
# A --revise-from / --verify-from launch whose reservation step is refused WRAPS its
# inner verdict (ms#1859's driver): "refused-revise-no-reservation:<inner>". Measured
# live 23/11 on CoursIA#28069: the wrapped RELACHEE sailed past the exact-match
# deferral and terminated the grain. Classification, failure_class and last_verdict
# all see the unwrapped inner form; the raw line stays in the driver log.
REVISE_REFUSAL_PREFIX = "refused-revise-no-reservation:"
CLAIM_RELEASED_WAIT_S = 3 * 86400.0 + 60.0
# The whole window from the refusal is the starting point, not the last word: the probe
# below reads the thread and bounds the wait to the guard's own expiry. Measured 24/11 on
# CoursIA#28018: [RELEASED] 22/11 09:38Z, refused by the lane 24/11 22:50Z, deferred to
# 27/11 22:51Z -- 2.6 days past the expiry the guard applies (25/11 09:39Z). The guard
# dates a marker on its comment's `created_at` (coordination/tapis_marqueurs.py) and
# holds while round(age in days, 1) < 3 (coordination/tapis_attente.py): it lets the
# grain through from 2.95 days, so a retry at released_at + CLAIM_RELEASED_WAIT_S is
# still never early. The bound only shortens a FUTURE wait; an [OVERRIDE] still lifts at
# once, and the next launch's qualification check remains the sole authority.
# While deferred on that verdict, how often the scheduler probes the issue for a
# newer [OVERRIDE] marker that lifts the release early. One gh call per issue per
# interval, best-effort; 5 min keeps the App bucket cost negligible.
RELACHEE_PROBE_INTERVAL_S = 300.0
# The probe is synchronous in tick(): at most this many threads are read per interval,
# round-robin over the deferred grains, so a thread GitHub hangs on (each read is bounded
# by CLAIM_READ_TIMEOUT_S) can hold neither the tick nor the grains behind it.
RELACHEE_PROBE_MAX_READS = 4

# An IMPLICIT occupation is a wait on ANOTHER lane's PR, not a refusal of this grain.
# The guard's rc=3 on a lot issue names an open PR of another lane that references the
# issue; the driver READ that PR's files and found them disjoint from this notebook
# (nb_coder_driver.implicit_verdict), so it defers: the occupation ends when the PR closes.
# Measured 28/11 on CoursIA#27133 (MGS-24): PRs #28852 (MGS-28) and #28861 (MGS-25), open
# since 27/11 08:15Z and 09:15Z, disjoint from MGS-24. The ordinary backoff (60 s x
# attempts, 900 s at most) re-launched the driver six times in 30 minutes -- each launch
# spending 3-4 min of guard enumeration (209 open PRs) to read the same answer -- and the
# sixth exhausted --max-attempts: `attempts-exhausted`, grain `failed`, nothing judged,
# against an occupation that had already outlasted the whole budget by a day.
# A wait whose end is another lane's event is PARKED: the launch that met it is refunded,
# the grain leaves the launch loop, and one state read per named PR re-offers it.
IMPLICIT_OCCUPATION_VERDICT = "deferred-by-claim-implicit-occupation"
# How often the named PRs' state is read: one gh call per PR per interval, best-effort.
IMPLICIT_OCCUPATION_PROBE_S = 300.0
# At most this many parked grains are read per interval, round-robin, for the same reason
# as RELACHEE_PROBE_MAX_READS: the read is synchronous in tick().
IMPLICIT_OCCUPATION_MAX_READS = 4


def implicit_occupation_prs(verdict: str) -> list[int]:
    """The PR numbers an IMPLICIT-occupation deferral names, in its order; [] otherwise
    (any other verdict, or one that names none -- then nothing can be waited on).

    The driver joins them with COMMAS (`deferred-by-claim-implicit-occupation:#28852,#28861`),
    so the numbers are read, not split on a separator.
    """
    if not verdict.startswith(IMPLICIT_OCCUPATION_VERDICT):
        return []
    return [int(n) for n in re.findall(r"#(\d+)", verdict[len(IMPLICIT_OCCUPATION_VERDICT):])]


def github_reset_wait(verdict: str, now: float) -> float | None:
    """Seconds until the GitHub bucket named by a rate-limit deferral refills, or None."""
    if not verdict.startswith("deferred-by-github-rate-limit"):
        return None
    for part in verdict.split(":")[1:]:
        if part.startswith("reset="):
            try:
                reset = float(part[len("reset="):])
            except ValueError:
                return None
            return min(max(reset - now, 0.0) + GITHUB_RESET_MARGIN_S, GITHUB_RESET_MAX_S)
    return None


def provider_wall_wait(verdict: str) -> float | None:
    """The hourly floor a provider WINDOW-WALL deferral carries, or None (ordinary backoff).

    `wall` is read as a whole `:`-separated part, never as a substring: the excerpt that
    follows it in the verdict is the provider's own message."""
    if not verdict.startswith(PROVIDER_RATE_LIMIT_VERDICT):
        return None
    return PROVIDER_WALL_WAIT_S if "wall" in verdict.split(":")[1:] else None

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
    # --claim-late: the verifier APPROVED, then the late reservation was refused (another
    # lane took the notebook while we built it). The engine served the whole run, so it
    # proves a served run and never blocks the ramp; the grain itself is not done.
    "late-claim-refused",
    # 22/11 (CoursIA#27805 -> main red): the source twin changed STRUCTURE or CODE on
    # origin/main while the port was built. The engine served the whole run; the port is
    # stale, so stage 5 refuses the push and a retry re-ports from the new source.
    "source-drifted",
)


# Refusals at admission: the driver's claim step declined the grain before any model
# call (the notebook is held by another lane, our claim is not scoped or not verified,
# an IMPLICIT occupation, the guard or the post failed). They cost the engine nothing
# and say nothing about its capacity, so they neither prove a served run nor block the
# promotion. Measured 21/11 04:50Z: step 0 of the live conveyor stood at "failures 5>0",
# and all five were refused-claim-* (MGS-25 not-verified, MGS-28/MGS-29/Search-11
# check-not-scoped, Sudoku-05 held by po-2024). Sudoku-05 would block for as long as
# po-2024 holds it.
ADMISSION_FAILURE_PREFIXES = (
    "refused-claim",
)


def failure_class(verdict: str | None) -> str:
    """'content' for a judged notebook that did not pass, 'admission' for a grain
    refused before any model call, 'run' for everything else."""
    v = (verdict or "").strip()
    if any(v.startswith(p) for p in ADMISSION_FAILURE_PREFIXES):
        return "admission"
    return "content" if any(v.startswith(p) for p in CONTENT_FAILURE_PREFIXES) else "run"


FAILURE_COUNTERS = {"content": "content_failed", "admission": "admission_failed",
                    "run": "failed"}

# A verifier that CRASHED (empty model response, REST bucket out mid-run) judged nothing:
# the build it was handed is still on disk with its trace. Measured 22/11 00:22Z on
# CoursIA#27885: 46 min of engine time (plan, build, repair, gates all passed) were thrown
# away because the critic's call returned an empty response, and nothing re-offered the
# grain. The driver's --verify-from re-gates and re-verifies that build with zero coder
# turn; the scheduler now asks for it once, from the grain's own trace.
VERIFY_RECOVERY_PREFIX = "verify-error"



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
    """A driver that is not our child: launched DETACHED by this instance (see
    _spawn_detached), or by a previous scheduler instance and still running.

    There is no Popen to poll. Its identity is the pid plus
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


class LostLaunch:
    """A detached launch whose launcher never reported a pid (it timed out).

    The driver may or may not have started, so it is NOT relaunched: a duplicate on
    the same grain would collide on worktree, claim and PR. It reaps at once as a run
    failure, read from the log offset of this attempt, so the ramp stops and the
    operator sees it.
    """

    pid = None

    def __init__(self, log: str, log_offset: int):
        self._nb_driver_log = log
        self._nb_log_offset = log_offset

    def poll(self):
        return ADOPTED_RC


DETACH_LAUNCHER = Path(__file__).resolve().with_name("nb_coder_detach.py")


def psutil_available() -> bool:
    import importlib.util
    return importlib.util.find_spec("psutil") is not None


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
        if item.get("revise_from") and item.get("verify_from"):
            raise QueueError(f"queue line {lineno}: revise_from and verify_from are exclusive")
        if item.get("revise_from") or item.get("verify_from"):
            clash = sorted(k for k in ("from_spec", "source_nb", "meta_from") if k in item)
            if clash:
                raise QueueError(f"queue line {lineno}: a resumed grain reads its creation mode "
                                 f"from the trace — drop {clash}")
            if item.get("max_stage", 5) < 4:
                raise QueueError(f"queue line {lineno}: a resumed grain needs max_stage >= 4")
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
        if item.get("claim_late"):
            # The driver's own refusals, when the line itself contradicts them (a
            # contradiction through the scheduler defaults is refused by the driver).
            if item.get("claim") is False:
                raise QueueError(f"queue line {lineno}: claim_late defers claim: "
                                 "claim false contradicts it")
            if "max_stage" in item and item["max_stage"] < 5:
                raise QueueError(f"queue line {lineno}: claim_late reserves before stage 5: "
                                 "max_stage must be 5")
        key = grain_key(item)
        if key in seen:
            raise QueueError(f"queue line {lineno}: duplicate grain {key}")
        seen.add(key)
        items.append(item)
    if not items:
        raise QueueError(f"queue is empty: {path}")
    return items, digest


REPLACE_ATTEMPTS = 40  # ~18 s of patience in total, far above any reader's json.load


def atomic_write_json(path: Path, payload: dict) -> None:
    """Write `payload` to `path` through a temp file and an atomic rename.

    On Windows a reader that holds the target open (the feeder's poll, an
    operator's `json.load`) makes `os.replace` fail with WinError 5 for the
    duration of its read: Python opens files without FILE_SHARE_DELETE. The
    scheduler died on exactly that on 22/11 04:4xZ, mid-run, with five drivers
    in flight. The rename is retried with a short backoff before giving up."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
                   encoding="utf-8")
    for attempt in range(REPLACE_ATTEMPTS):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(min(0.05 * (attempt + 1), 0.5))


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
        "admission_failed": 0,
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
        "content_failed", "admission_failed",
        "deferred", "dirty", "samples", "green_samples", "running_max",
        "waiting_max", "preempt_max")} | {"step_ended": now,
                                          "duration_s": round(now - ramp["step_started"], 1)}


def _reset_step_counters(ramp: dict, now: float) -> None:
    """Keep the ramp position, reset the promotion evidence."""
    ramp.update({"step_started": now, "done": 0, "failed": 0, "content_failed": 0,
                 "admission_failed": 0, "deferred": 0,
                 "first_green_ts": None, "dirty": False, "samples": 0,
                 "green_samples": 0, "running_max": 0.0, "waiting_max": 0.0,
                 "preempt_max": 0.0})


def git_run(argv: list[str], timeout: float = 300) -> tuple[int, str]:
    """(returncode, stdout+stderr) of a git command; -1 when it could not run."""
    try:
        p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout)
    except Exception as exc:
        return -1, str(exc)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


# A grain that fails after posting its [CLAIMED] leaves the issue locked: nothing released
# it, so other lanes' auto-picks were refused for the guard's 48 h stale threshold. That
# is the hazard --claim-late was adopted for (CoursIA rule 21/11), and it still holds
# under --claim-late when the late claim lands and the PR then fails to open. The
# scheduler sees every end, a killed driver included, so the release lives here. It goes
# through the authoritative guard, which posts [DELIVERED] instead of [RELEASED] when an
# open PR of the lane references the issue.
CLAIM_REPO_SLUG = "jsboige/CoursIA"
# Line-anchored, like the guard's reducer: a marker quoted mid-sentence is not a marker.
CLAIM_MARK_RE = re.compile(r"(?m)^[ \t>*_]*\[(CLAIMED|RELEASED|DELIVERED)\] lane (\S+)")
CLAIM_READ_TIMEOUT_S = 120
CLAIM_RELEASE_TIMEOUT_S = 240


def last_claim_marker(bodies: list[str]) -> tuple[str, str] | None:
    """(kind, lane) of the last claim marker across the issue's comments, in order."""
    last = None
    for body in bodies:
        for m in CLAIM_MARK_RE.finditer(body or ""):
            last = (m.group(1), m.group(2))
    return last


def issue_comment_bodies(issue: int) -> list[str]:
    """Every comment body of an issue, oldest first: one `@json` line per comment, every
    page read. Raises when GitHub does not answer."""
    p = subprocess.run(["gh", "api", "--paginate",
                        f"repos/{CLAIM_REPO_SLUG}/issues/{issue}/comments?per_page=100",
                        "--jq", ".[].body | @json"],
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=CLAIM_READ_TIMEOUT_S)
    if p.returncode != 0:
        raise RuntimeError(f"gh rc={p.returncode}: {(p.stderr or '').strip()[:160]}")
    return [json.loads(line) for line in p.stdout.splitlines() if line.strip()]


def issue_comment_timeline(issue: int) -> list[tuple[str, str]]:
    """(created_at, body) of every comment of an issue, oldest first: the same paginated
    read as issue_comment_bodies, plus each comment's creation time -- the instant the
    guard dates a marker on (CoursIA `tapis_marqueurs`: `quand = created_at`). Raises
    when GitHub does not answer."""
    p = subprocess.run(["gh", "api", "--paginate",
                        f"repos/{CLAIM_REPO_SLUG}/issues/{issue}/comments?per_page=100",
                        "--jq", '.[] | [.created_at, (.body // "")] | @json'],
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=CLAIM_READ_TIMEOUT_S)
    if p.returncode != 0:
        raise RuntimeError(f"gh rc={p.returncode}: {(p.stderr or '').strip()[:160]}")
    out: list[tuple[str, str]] = []
    for line in p.stdout.splitlines():
        if not line.strip():
            continue
        created, body = json.loads(line)
        out.append((created or "", body or ""))
    return out


def pull_request_state(number: int) -> str | None:
    """GitHub's `state` of one PR -- `open` or `closed` (a merged PR is `closed`) -- or
    None when GitHub does not answer. Raises nothing: the caller never clears a park on a
    read that failed."""
    p = subprocess.run(["gh", "api", f"repos/{CLAIM_REPO_SLUG}/pulls/{number}",
                        "--jq", ".state"],
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=CLAIM_READ_TIMEOUT_S)
    if p.returncode != 0:
        return None
    return (p.stdout or "").strip() or None


# The two markers the RELACHEE probe reads, line-anchored like CLAIM_MARK_RE and the
# guard's reducer: a marker quoted mid-sentence is not a marker.
RELACHEE_MARK_RE = re.compile(r"(?m)^[ \t>*_]*\[\s*(OVERRIDE|RELEASED)\s*\]([^\n]*)",
                              re.IGNORECASE)
_RELACHEE_LANE_RE = re.compile(r"\blane\s+(\S+)", re.IGNORECASE)


def relache_markers(bodies: list[str]) -> list[tuple[str, str, str]]:
    """(kind, named lane, marker line) of every [OVERRIDE]/[RELEASED] of the thread, in
    order, on EVERY line of EVERY comment -- whatever the lane: the guard decides RELACHEE
    on the thread's LAST marker, whoever posted it (CoursIA `tapis_attente.relachee`), so a
    sibling lane's [RELEASED] buries a lift exactly like my own."""
    out: list[tuple[str, str, str]] = []
    for body in bodies:
        for m in RELACHEE_MARK_RE.finditer(body or ""):
            named = _RELACHEE_LANE_RE.search(m.group(2))
            out.append((m.group(1).upper(), named.group(1) if named else "", m.group(0)))
    return out


def relache_lift(markers: list[tuple[str, str, str]], lane: str) -> str | None:
    """The marker line that lifts the three-day wait for `lane`, or None.

    Lifts only when the NEWEST marker is an [OVERRIDE] naming `lane`: the guard's own
    re-arm gesture (`[OVERRIDE] lane <machine:workspace>` grants the grain to the named
    lane and closes every other one). A [RELEASED] last keeps the guard. An [OVERRIDE]
    for ANOTHER lane, or one naming none, is refused at the next launch: lifting on it
    would burn an attempt and re-arm three more days."""
    if not markers or not lane:
        return None
    kind, named, line = markers[-1]
    return line if kind == "OVERRIDE" and named == lane else None


# The guard's own pause condition (#27726, CoursIA `tapis_marqueurs`): `attend: #N` or
# `attend: Q<id>` anywhere in the comment makes EVERY marker of that comment a PAUSE
# with no delay, not a three-day release. Quoted code poses neither (the guard strips
# its fences before reading), and neither is read here.
_RELACHE_PAUSE_RE = re.compile(r"\battend\s*:\s*[#\w]", re.IGNORECASE)
_RELACHE_FENCE_RE = re.compile(r"```.*?(?:```|\Z)", re.DOTALL)


def _iso_epoch(stamp: str) -> float | None:
    """Epoch seconds of a GitHub `created_at`, or None when it does not parse. A date
    without an offset is refused: read as local time it would date the release wrong."""
    if not stamp:
        return None
    try:
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.timestamp() if moment.tzinfo else None


def relache_release_epoch(timeline: list[tuple[str, str]]) -> float | None:
    """Epoch seconds of the [RELEASED] that ends the marker thread, or None.

    None whenever the three-day window cannot be dated from the thread alone: no marker,
    an [OVERRIDE] last (the lift is `relache_lift`'s to decide), a release whose comment
    carries a pause condition, or a comment whose creation time does not parse. The
    caller then keeps its conservative wait."""
    kind, epoch = "", None
    for created, body in timeline:
        texte = _RELACHE_FENCE_RE.sub("", body or "")
        dated = _iso_epoch(created) if not _RELACHE_PAUSE_RE.search(texte) else None
        for m in RELACHEE_MARK_RE.finditer(texte):
            kind, epoch = m.group(1).upper(), dated
    if kind != "RELEASED" or epoch is None:
        return None
    return epoch


class GuardClaims:
    """The two GitHub legs of a claim release. Injectable as `claims` in offline tests."""

    def __init__(self, repo: str):
        self.repo = Path(repo)

    def last_marker(self, issue: int) -> tuple[str, str] | None:
        """Raises when GitHub does not answer: a release is never decided blind."""
        return last_claim_marker(issue_comment_bodies(issue))

    def release(self, issue: int, lane: str, notebook: str, note: str) -> tuple[int, str]:
        script = self.repo / "scripts" / "check_lane_claim.py"
        if not script.is_file():
            return -1, f"{script} absent"
        # cwd = the target repo, as the driver runs the guard (_run_claim_guard).
        try:
            p = subprocess.run([sys.executable, str(script), str(issue), "--lane", lane,
                                "--paths", notebook, "--release", note],
                               cwd=self.repo, capture_output=True, text=True,
                               encoding="utf-8", errors="replace",
                               timeout=CLAIM_RELEASE_TIMEOUT_S)
        except Exception as exc:
            return -1, str(exc)
        return p.returncode, (p.stdout or "") + (p.stderr or "")



def refresh_gh_env(repo: str | Path) -> None:
    """Keep GH_TOKEN live across a long --watch run (measured 23/11: the 1-hour App token
    exported at launch expired mid-bench and every scheduler-side gh leg 401'd). Re-mint
    once per poll; a failed mint leaves the previous value -- the driver's own refresh is
    the hard gate before any spend.
    """
    app_id, key = os.environ.get("NBCODER_GH_APP_ID"), os.environ.get("NBCODER_GH_KEY")
    if not app_id or not key:
        return
    script = Path(repo) / "scripts/secrets/github_app_token.py"
    try:
        p = subprocess.run([sys.executable, str(script), "--app-id", app_id, "--key", key,
                            "--repo", "jsboige/CoursIA", "--quiet"],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60)
        tok = (p.stdout or "").strip().splitlines()[-1] if p.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        tok = ""
    if tok:
        os.environ["GH_TOKEN"] = tok


class Scheduler:
    """Pure orchestration. spawn/gate/sleep/clock/git/claims are injectable for offline tests."""

    def __init__(self, args, spawn=None, gate=None, sleep=None, clock=None, probe=None,
                 git=None, claims=None):
        self.args = args
        self.git = git or git_run
        # main() wires GuardClaims; left None, nothing is released (offline tests never
        # reach GitHub through a failed claimed grain).
        self.claims = claims
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
                g.pop("resume_from", None)
                g.pop("verify_recoveries", None)
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
        # A retry is a decision on a FAILED grain, usually after its spec or the harness
        # changed: it builds afresh, never from the trace of the run it replaces.
        g.pop("resume_from", None)
        g.pop("verify_recoveries", None)

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
            recorded = g.get("driver_create_time")
            if recorded:
                if abs(create_time - recorded) >= 1.0:
                    return "pid reused: create time differs from the one recorded at launch"
            elif started is None or not (started - ADOPT_START_SLACK_BEFORE_S
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

        A driver that is still the process we launched (same pid, the create time
        recorded at launch or else one inside the launch window, a driver command
        line) is ADOPTED: it is watched by pid and
        its verdict read from its driver.log, so the scheduler can be restarted on new
        code without waiting for the grains in flight.

        Surviving the scheduler is not automatic. On 20/11 a driver outlived the
        scheduler that launched it, but on 21/11 00:45Z stopping the scheduler's
        background task killed both drivers in flight (MGS-25, MGS-28): the stop walks
        the process tree. Probe the same night: a direct child died with plain flags,
        CREATE_NEW_PROCESS_GROUP and CREATE_BREAKAWAY_FROM_JOB alike; only a child of
        an intermediate process that had already exited survived. Hence
        --detach-drivers (default on): every driver is started through that
        intermediate, nb_coder_detach.py.

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
            if getattr(self.args, "detach_drivers", False) and psutil_available():
                detached = self._spawn_detached(cmd, log, offset)
                if detached is not None:
                    return detached
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

    def _spawn_detached(self, cmd: list[str], log: Path, offset: int):
        """Start the driver outside our process tree; None = not started, fall back.

        The launcher starts the driver and exits, so the driver's parent is gone and
        a stop of the scheduler's task no longer reaches it. It is then tracked like
        an adopted driver: by pid and create time, its verdict read from driver.log.
        Without psutil it could not be tracked at all, so the caller only comes here
        when psutil imports.
        """
        try:
            p = subprocess.run([sys.executable, str(DETACH_LAUNCHER), str(log), "--", *cmd],
                               capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=60)
        except subprocess.TimeoutExpired:
            self._event("detach-timeout", log=str(log),
                        note="launcher gave no pid in 60 s; the driver may be running "
                             "untracked, so the grain is NOT relaunched")
            return LostLaunch(str(log), offset)
        lines = (p.stdout or "").strip().splitlines()
        try:
            reply = json.loads(lines[-1]) if lines else {}
        except Exception:
            reply = {}
        pid = reply.get("pid") if isinstance(reply, dict) else None
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            # Every launcher error path is a Popen that raised: nothing was started,
            # so the attached launch the caller falls back to is not a duplicate.
            self._event("detach-failed", rc=p.returncode,
                        error=(reply.get("error") if isinstance(reply, dict) else None)
                        or (p.stdout or p.stderr or "")[:300])
            return None
        ident = self.process_probe(pid)
        # None: the driver already exited (an early crash); it reaps on the next tick.
        create_time = ident[0] if ident is not None else 0.0
        return AdoptedDriver(pid, create_time, str(log), offset, self.process_probe)

    def run_trace(self, item: dict) -> Path | None:
        """The driver's verdict record for this grain (`issue-<N>.json` in its run dir),
        when the run left one: what --verify-from resumes from."""
        try:
            p = (Path(self.args.out_root) / f"issue-{grain_slug(item)}"
                 / f"issue-{item['issue']}.json")
        except Exception:
            return None
        return p if p.is_file() else None

    def driver_command(self, item: dict, resume_from: str | None = None) -> list[str]:
        a = self.args
        # A queue item may name the trace to resume itself (22/11 salvage: a content
        # failure of ANOTHER state dir, resumed on its already-built draft instead of
        # being rebuilt or released). It then writes next to that trace — the driver
        # renames the old record there — and reads worktree + twin from it.
        explicit = item.get("revise_from") or item.get("verify_from")
        resumed = explicit or resume_from
        # --verify-from / --revise-from read the creation mode from the trace and the
        # driver refuses --from-spec / --source-nb / --meta-from next to them.
        from_spec = bool(item.get("from_spec", False)) and not resumed
        out_dir = (Path(explicit).parent if explicit
                   else Path(a.out_root) / f"issue-{grain_slug(item)}")
        worktree = Path(a.worktree_root) / f"wt-{grain_slug(item)}"
        cmd = [sys.executable, str(a.driver),
               "--issue", str(item["issue"]), "--notebook", item["notebook"],
               "--repo", a.repo, "--out-dir", str(out_dir),
               "--worktree", str(worktree), "--gate-mode", a.gate_mode]
        source_nb = (None if (from_spec or resumed)
                     else item.get("source_nb", a.source_nb))
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
            if item.get("claim_late", getattr(a, "claim_late", False)):
                cmd.append("--claim-late")
        if item.get("fresh_worktree", a.fresh_worktree):
            cmd.append("--fresh-worktree")
        if item.get("allow_foreign_origin", False):
            cmd.append("--allow-foreign-origin")
        if item.get("revise_from"):
            cmd += ["--revise-from", str(item["revise_from"])]
        elif item.get("verify_from") or resume_from:
            cmd += ["--verify-from", str(item.get("verify_from") or resume_from)]
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
        ones count as served runs, "admission" ones (refused before any model call) do
        neither. The class is read from the grain's latest verdict, so a failure
        recorded before the split classifies the same way.
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
        ramp["admission_failed"] = self._step_failures(ramp, "admission")
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
            if verdict.startswith(REVISE_REFUSAL_PREFIX):
                verdict = verdict[len(REVISE_REFUSAL_PREFIX):]
            g = self.state["grains"][key]
            elapsed = round(now - entry["started"], 1)
            g.update({"finished": utcnow(), "returncode": rc,
                      "last_verdict": verdict, "elapsed_s": elapsed})
            ramp = self.state["ramp"]
            if verdict == CLAIM_RELEASED_VERDICT:
                g["status"] = "deferred"
                wait = CLAIM_RELEASED_WAIT_S
                g["not_before"] = self.clock() + wait
                ramp["deferred"] += 1
                self._event("qualification-deferred", key=key, rc=rc,
                            verdict=verdict, qualification="RELACHEE",
                            retry_in_s=wait, retry_at=datetime.fromtimestamp(
                                g["not_before"], timezone.utc).isoformat(timespec="seconds"))
            elif (verdict.startswith(IMPLICIT_OCCUPATION_VERDICT)
                  and implicit_occupation_prs(verdict)):
                # PARKED, not deferred: another lane's open PR holds the issue, its files
                # are disjoint from this notebook, and the wait ends when that PR closes.
                # The launch is refunded (it judged nothing) and the grain leaves the
                # launch loop: _occupation_probe re-offers it when the PRs close.
                prs = implicit_occupation_prs(verdict)
                g["status"] = "deferred"
                g["occupation_wait"] = True
                g["occupation_prs"] = prs
                g["attempts"] = max(0, g.get("attempts", 0) - 1)
                g["not_before"] = self.clock() + IMPLICIT_OCCUPATION_PROBE_S
                ramp["deferred"] += 1
                self._event("occupation-parked", key=key, rc=rc, verdict=verdict,
                            prs=[f"#{n}" for n in prs], attempts=g["attempts"],
                            retry_in_s=IMPLICIT_OCCUPATION_PROBE_S)
            elif verdict.startswith(DEFERRED_VERDICT_PREFIXES):
                g["status"] = "deferred"
                # attempts counts LAUNCHES; the backoff grows with each refusal.
                wait = min(self.args.backoff_s * max(1, g["attempts"]),
                           self.args.backoff_max_s)
                reset_wait = github_reset_wait(verdict, self.clock())
                if reset_wait is not None:
                    wait = max(wait, reset_wait)
                wall_wait = provider_wall_wait(verdict)
                if wall_wait is not None:
                    wait = max(wait, wall_wait)
                g["not_before"] = self.clock() + wait
                ramp["deferred"] += 1
                self._event("deferred", key=key, rc=rc, verdict=verdict,
                            retry_in_s=wait)
            elif rc == 0 or any(verdict.endswith(s) for s in DONE_VERDICT_SUFFIXES):
                g["status"] = "done"
                ramp["done"] += 1
                self._event("completed", key=key, rc=rc, verdict=verdict,
                            elapsed_s=elapsed)
            elif (verdict.startswith(VERIFY_RECOVERY_PREFIX)
                  and g.get("verify_recoveries", 0) < getattr(self.args,
                                                              "verify_recoveries", 0)
                  and (trace := self.run_trace(entry.get("item") or {})) is not None):
                # Deferred, not failed: the tree stays (the driver reuses it or re-creates
                # it at the trace's head) and the ramp is not blocked by a crash that
                # judged nothing. A second verify-error on the same grain fails as before.
                g["status"] = "deferred"
                g["verify_recoveries"] = g.get("verify_recoveries", 0) + 1
                g["resume_from"] = str(trace)
                wait = self.args.backoff_s
                g["not_before"] = self.clock() + wait
                ramp["deferred"] += 1
                self._event("verify-recovery", key=key, rc=rc, verdict=verdict,
                            trace=str(trace), recovery=g["verify_recoveries"],
                            retry_in_s=wait)
            else:
                g["status"] = "failed"
                g["ramp_failed_ts"] = now
                cls = failure_class(verdict)
                counter = FAILURE_COUNTERS[cls]
                ramp[counter] = ramp.get(counter, 0) + 1
                self._event("failed", key=key, rc=rc, verdict=verdict,
                            elapsed_s=elapsed, failure_class=cls)
                self._release_claim(key, entry.get("item"), verdict)
            if g["status"] in ("done", "failed"):
                self._release_worktree(key, entry.get("item"))
            del self.active[key]

    def resumable_trace(self, key: str, item: dict | None, verdict: str) -> Path | None:
        """The trace a FIRST content failure left, when its grain can be resumed on it.

        None (the claim is released, as before) for anything else: a non-content verdict,
        a run that left no record, a record that does not parse or carries no
        `built_notebook` (nothing was paid for), or a launch that was itself a resume —
        a second content failure on the same draft is terminal."""
        if getattr(self.args, "release_on_first_content_failure", False):
            return None
        if failure_class(verdict) != "content" or not item:
            return None
        if item.get("revise_from") or item.get("verify_from"):
            return None
        if (self.state.get("grains") or {}).get(key, {}).get("resume_from"):
            return None
        trace = self.run_trace(item)
        if trace is None:
            return None
        try:
            rec = json.loads(trace.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            return None
        return trace if isinstance(rec, dict) and rec.get("built_notebook") else None

    def _release_claim(self, key: str, item: dict | None, verdict: str) -> None:
        """Release our [CLAIMED] on a failed grain's issue, when it is the last marker there.

        Never released: a foreign holder (late-claim refusals), our own [DELIVERED] or
        [RELEASED], an issue without markers, an issue another active grain of ours still
        builds (lot issues carry several notebooks), or an unreadable thread.

        Kept on a first content failure that left a resumable trace (26/11): the claim
        guard reads ANY [RELEASED] as a full close of the lane on the whole ISSUE and
        holds it `RELACHEE` 3 days for every lane, whatever its `paths:` clause — one
        failed path of a lot froze every path of that lot, the lane's own salvage
        included. A kept [CLAIMED] goes stale after the guard's 48 h; the owning lane
        resumes the grain in its next batch (--revise-from / --verify-from on the trace
        named in the grain's `resumable_trace`)."""
        a = self.args
        if self.claims is None or not item or not a.lane \
                or not item.get("claim", getattr(a, "claim", False)):
            return
        issue = int(item["issue"])
        if any(k != key and int((e.get("item") or {}).get("issue", -1)) == issue
               for k, e in self.active.items()):
            return self._event("claim-release-skipped", key=key, issue=issue,
                               reason="sibling-grain-active")
        trace = self.resumable_trace(key, item, verdict)
        if trace is not None:
            # the callee tolerates a key with no grain record (`.get(key, {})`); this write
            # must too -- a KeyError here aborts the release path (review ai-01, 26/11).
            # The trace is named in the event either way.
            grain = (self.state.get("grains") or {}).get(key)
            if grain is not None:
                grain["resumable_trace"] = str(trace)
            return self._event("claim-release-skipped", key=key, issue=issue,
                               reason="resumable-first-content-failure", trace=str(trace))
        try:
            last = self.claims.last_marker(issue)
        except Exception as exc:
            return self._event("claim-release-skipped", key=key, issue=issue,
                               reason="marker-unread", detail=str(exc)[:200])
        if last != ("CLAIMED", a.lane):
            return
        note = f"nb_coder: grain ended without a PR ({(verdict or 'no verdict')[:80]})"
        rc, out = self.claims.release(issue, a.lane, item["notebook"], note)
        self._event("claim-released" if rc == 0 else "claim-release-failed", key=key,
                    issue=issue, rc=rc, detail=(out or "").strip()[-300:])

    def _release_worktree(self, key: str, item: dict | None) -> None:
        """Remove a terminal grain's worktree once nothing in it is unique.

        Each grain checks out the whole target repo (CoursIA: 1.6 GB, 17,700 files),
        and nothing removed it: on 20-21/11 the conveyor's worktrees grew D: by
        ~5 GB/h, and the disk had already filled once. Keeping the tree buys nothing.
        The run's artifacts live in its out-dir. A relaunch reuses a tree only when
        its HEAD is exactly origin/main, which no longer holds once main has moved,
        so prepare_worktree rebuilds it anyway.

        Removed only when the tree is clean AND its HEAD is on a remote-tracking ref
        (a pushed PR branch, or the origin/main it was cut from). Dirty files and
        unpushed commits stay, and a `worktree-kept` event names the reason.
        `git worktree remove` is never forced: git also refuses locked trees and
        untracked files on its own."""
        if getattr(self.args, "keep_worktrees", False) or not item:
            return
        try:
            wt = Path(self.args.worktree_root) / f"wt-{grain_slug(item)}"
        except Exception:
            return
        if not wt.exists():
            return

        def kept(reason: str, detail: str = "") -> None:
            self._event("worktree-kept", key=key, worktree=str(wt), reason=reason,
                        detail=detail.strip()[:300])

        rc, out = self.git(["git", "-C", str(wt), "status", "--porcelain"])
        if rc != 0:
            return kept("status-failed", out)
        if out.strip():
            return kept("dirty", out)
        rc, out = self.git(["git", "-C", str(wt), "for-each-ref", "--contains", "HEAD",
                            "--format=%(refname)", "refs/remotes"])
        if rc != 0:
            return kept("ref-check-failed", out)
        if not out.strip():
            return kept("head-on-no-remote-ref",
                        "HEAD is on no remote-tracking ref: an unpushed commit?")
        rc, out = self.git(["git", "-C", str(self.args.repo), "worktree", "remove", str(wt)])
        if rc != 0:
            return kept("remove-failed", out)
        self._event("worktree-released", key=key, worktree=str(wt))

    def _relache_override_probe(self, now: float) -> None:
        """A deferred-RELACHEE grain is re-offered as soon as a newer marker lifts
        the release, instead of sleeping the guard's whole three-day window.

        Measured 23/11 (CoursIA#28077/#28080/#28050/#28079): the coordinator posted
        four [OVERRIDE]s at 03:41Z to lift releases that were themselves the
        side-effect of a harness defect (ms#1859-squash regression, fixed at
        8e635548). The grains stayed deferred until 03:29Z + 3 days regardless,
        because CLAIM_RELEASED_WAIT_S re-reads the FULL window from the refusal
        (the guard exports only a rounded age, so the deferral plays safe). With
        every deferral sleeping three days, each retry reset its own not_before
        further out -- a self-perpetuating denial of service across every grain the
        coordinator had already re-armed.

        The probe reads the marker comments of each deferred-RELACHEE issue at
        most once every RELACHEE_PROBE_INTERVAL_S, over the SAME paginated
        reader as the claim release (`issue_comment_bodies`, bounded by
        CLAIM_READ_TIMEOUT_S): a thread longer than one page is read whole, and
        the marker is looked for on EVERY line of every comment (review
        ms#1875), never only on the comment's first line. At most
        RELACHEE_PROBE_MAX_READS threads per interval, round-robin, because the
        read is synchronous in tick(): a thread GitHub hangs on must not hold
        the tick nor the grains behind it.

        23/11 generalization (GO coordinator ai01-c0025-claudish-ovr5): reading only
        the LAST comment missed the OVERRIDE whenever the grain's own auto-published
        [RELEASED] (fired by the next failing attempt) buried it -- measured four
        OVERRIDE -> attempt -> RELEASED -> OVERRIDE round-trips in two hours on the
        Integrales grains. The probe now walks the WHOLE marker thread and lifts
        when the NEWEST qualification marker is an [OVERRIDE] that is more recent
        than every [RELEASED] after it. Best-effort: a gh failure leaves the
        three-day guard in place, exactly as before.

        24/11 alignment on the guard (`CoursIA scripts/coordination/
        tapis_attente.relachee`): RELACHEE holds while the thread's LAST marker is
        a [RELEASED] younger than three days, whatever the lane. The probe
        therefore lifts only when the newest marker is an [OVERRIDE] naming THIS
        lane (`[OVERRIDE] lane <machine:workspace>` grants the grain to its named
        beneficiary, #10223): a [RELEASED] last -- mine or a sibling's -- keeps
        the guard, and an [OVERRIDE] for another lane, or one naming none, is
        refused at the next launch, so lifting on it would burn an attempt and
        re-arm three more days. Every read is a pre-offer; the guard alone decides.

        24/11 bound: the same read dates the [RELEASED] the guard is holding on, so a
        grain that is NOT lifted gets its wait bounded to that release's own expiry
        (released_at + CLAIM_RELEASED_WAIT_S) instead of three days from the refusal.
        Measured 24/11 on CoursIA#28018: released 22/11 09:38Z, refused 24/11 22:50Z,
        deferred to 27/11 22:51Z -- for a guard that expires 25/11 09:39Z.
        """
        candidates = [(k, g) for k, g in self.state["grains"].items()
                      if g.get("status") == "deferred"
                      and g.get("last_verdict") == CLAIM_RELEASED_VERDICT
                      and (g.get("not_before") or 0) > now]
        if not candidates:
            return
        last_probe = self.state.get("relache_probe_ts") or 0
        if now - last_probe < RELACHEE_PROBE_INTERVAL_S:
            return
        self.state["relache_probe_ts"] = now
        if candidates:
            offset = int(self.state.get("relache_probe_offset") or 0) % len(candidates)
            ordered = candidates[offset:] + candidates[:offset]
            self.state["relache_probe_offset"] = offset + RELACHEE_PROBE_MAX_READS
        lane = self.args.lane or ""
        for key, g in ordered[:RELACHEE_PROBE_MAX_READS]:
            item = self.items_by_key.get(key) or {}
            issue = item.get("issue")
            if not issue:
                continue
            try:
                timeline = issue_comment_timeline(issue)
            except Exception as exc:
                self._event("relache-probe-error", key=key, detail=str(exc)[:120])
                continue
            # The thread is chronological; the last marker decides. Lift only when
            # that newest marker is an OVERRIDE naming this lane (a RELEASED last
            # means the release is still the operative event -- keep the guard).
            newest = relache_lift(relache_markers([body for _, body in timeline]), lane)
            if newest:
                g["not_before"] = now
                self._event("relache-override-lifted", key=key, issue=issue,
                            marker=newest[:140])
                continue
            # No lift: the guard's window still runs, but from the RELEASE itself, not
            # from this lane's refusal of it. Only a FUTURE expiry is written back -- a
            # release already past the window does not explain the refusal, and the
            # bound must never be what makes a grain eligible.
            released = relache_release_epoch(timeline)
            if released is None:
                continue
            expiry = released + CLAIM_RELEASED_WAIT_S
            if now < expiry < (g.get("not_before") or 0):
                g["not_before"] = expiry
                self._event("relache-expiry-bounded", key=key, issue=issue,
                            released_at=datetime.fromtimestamp(
                                released, timezone.utc).isoformat(timespec="seconds"),
                            retry_in_s=round(expiry - now, 1),
                            retry_at=datetime.fromtimestamp(
                                expiry, timezone.utc).isoformat(timespec="seconds"))

    def _occupation_probe(self, now: float) -> None:
        """A grain parked on another lane's open PR is re-offered when that PR closes.

        The probe reads the STATE of the PRs the deferral named, and nothing else: it
        never decides the claim -- the guard alone decides, at the next launch. A PR that
        is still open keeps the grain parked; one that is closed (merged or abandoned)
        clears the park, refunds the launches the park burnt, and re-offers the grain.

        A read GitHub does not answer keeps the park: an unread state is not a closed PR.
        """
        parked = [(k, g) for k, g in self.state["grains"].items()
                  if g.get("status") == "deferred" and g.get("occupation_wait")
                  and g.get("occupation_prs")
                  and (g.get("not_before") or 0) <= now]   # the park's own interval
        if not parked:
            return
        last = self.state.get("occupation_probe_ts") or 0
        if now - last < IMPLICIT_OCCUPATION_PROBE_S:
            return
        self.state["occupation_probe_ts"] = now
        offset = int(self.state.get("occupation_probe_offset") or 0) % len(parked)
        ordered = parked[offset:] + parked[:offset]
        self.state["occupation_probe_offset"] = offset + IMPLICIT_OCCUPATION_MAX_READS
        for key, g in ordered[:IMPLICIT_OCCUPATION_MAX_READS]:
            states: dict[int, str] = {}
            unread = False
            for number in g.get("occupation_prs") or []:
                state = pull_request_state(number)
                if state is None:
                    unread = True
                    states[number] = "unknown"
                    break
                states[number] = state
            if unread or any(s != "closed" for s in states.values()):
                g["not_before"] = now + IMPLICIT_OCCUPATION_PROBE_S
                self._event("occupation-holds", key=key,
                            prs={f"#{n}": s for n, s in states.items()})
                continue
            g.update({"occupation_wait": False, "occupation_prs": [],
                      "not_before": now, "attempts": 0})
            self._event("occupation-cleared", key=key,
                        prs=[f"#{n}" for n in states], attempts=0)

    def _eligible(self, now: float) -> list[str]:
        out = []
        for key, g in self.state["grains"].items():
            if g.get("status") != "pending" and g.get("status") != "deferred":
                continue
            if g.get("occupation_wait"):
                continue    # parked on another lane's PR: only the probe re-offers it
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
                  "driver_log_offset": getattr(proc, "_nb_log_offset", None),
                  # detached drivers only: their exact create time, a stronger
                  # identity than the launch window when a restarted scheduler adopts
                  "driver_create_time": getattr(proc, "_create_time", None) or None,
                  "detached": isinstance(proc, (AdoptedDriver, LostLaunch))})
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
            if (g.get("status") == "deferred" and g.get("attempts", 0) >= self.args.max_attempts
                    and not g.get("occupation_wait")):
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
        self._relache_override_probe(now)
        self._occupation_probe(now)

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
                # Same-issue grains are NOT serialized here: only their claim
                # reservation races, and the driver serializes that window itself
                # (issue_claim_lock). Holding a whole lot to one grain in flight would
                # starve the conveyor -- its remaining lots carry 3-9 notebooks each.
                for key in pending:
                    if budget <= 0:
                        held = held or "capacity-target"
                        break
                    item = self.items_by_key[key]
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
                    cmd = self.driver_command(
                        item, resume_from=self.state["grains"][key].get("resume_from"))
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
            refresh_gh_env(getattr(self.args, "repo", ""))
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
    ap.add_argument("--claim-late", action="store_true",
                    help="default claim_late for every grain: the driver posts [CLAIMED] "
                         "only once the verifier approved, right before stage 5 (CoursIA "
                         "auto-pick rule 21/11). Needs --claim and --max-stage 5")
    ap.add_argument("--release-on-first-content-failure", action="store_true",
                    help="also release our [CLAIMED] on the FIRST content failure of a "
                         "grain that left a resumable trace (the behavior before 26/11). "
                         "Default keeps it: the claim guard reads any [RELEASED] as a "
                         "close of the whole issue (RELACHEE 3 days for every lane)")
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
    ap.add_argument("--gate-mode", choices=["warn", "block", "off"], default="block",
                    help="capacity gate only (gate_call -> swift_capacity_gate.py): warn = probe "
                         "and record, never refuse; block = refuse the launch on a "
                         "non-zero verdict (deferred-by-capacity-gate); off = no "
                         "probe. Does NOT disarm the structural stage-3 gates "
                         "(execution, conformance, verifier), which have no switch")
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
    ap.add_argument("--verify-recoveries", type=int, default=1,
                    help="times a grain whose verifier crashed (verdict verify-error) is "
                         "relaunched with --verify-from on its own trace, reusing the "
                         "build already paid for (0 = fail it, the old behavior)")
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
    ap.add_argument("--keep-worktrees", action="store_true",
                    help="keep a grain's worktree after it ends. By default a clean tree "
                         "whose HEAD is on a remote ref is removed (a checkout of the "
                         "target repo per grain, 1.6 GB for CoursIA)")
    ap.add_argument("--detach-drivers", action=argparse.BooleanOptionalAction, default=True,
                    help="start each driver through nb_coder_detach.py so that stopping "
                         "the scheduler (TaskStop walks the process tree) does not kill "
                         "the grains in flight; a restarted scheduler adopts them. Needs "
                         "psutil, else the attached launch is used. To stop a detached "
                         "driver, kill the pid recorded in state.json")
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
    if args.claim_late and (not args.claim or args.max_stage < 5):
        ap.error("--claim-late needs --claim and --max-stage 5 (same refusal as the driver)")
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
    sched = Scheduler(args, claims=None if args.dry_run else GuardClaims(args.repo))
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
