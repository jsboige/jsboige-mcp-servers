#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Authored here (#1913 feeder port) — no jsboige/vllm original. The lane-local
# original (D:/vllm/.tmp/nbcoder/feeder/feeder.py on ai-01) hard-coded the seat
# (conveyor dir, repos/jsboige/CoursIA, D:/CoursIA, lane myia-ai-01:vllm, the
# mcps-clone path of the drift script); this port parameterises every one of
# them and injects the GitHub/git/subprocess calls. This tree is the source of
# truth.
# Harness base is the vllm re-copy @ 7a09e1caec22441d9402ab25a222206c8905bfe1.
# -----------------------------------------------------------------------------
"""Keep at most CAP grains in flight on the conveyor; the single observer of its slots.

Ported from the lane-local feeder/feeder.py (#1913). Preserved, each one a regression test:

* order and CAP: lines are offered in the order of the feeder's own ``pending.jsonl``, at
  most ``--cap`` (``NBCODER_FEEDER_CAP``) in flight, re-measured before each feed;
* ``not_before`` (UTC ISO) is feeder-only: a line is offered from that time and the field is
  never handed to the scheduler, whose queue schema is closed;
* a grain claimed by another lane (last ``[CLAIMED]``/``[DELIVERED]`` marker, other lane)
  is skipped;
* trap 1 — a grain the scheduler already knows is never re-fed, ``withdrawn`` included
  (``skip already-known``); re-offering needs ``"retry": N+1`` where N is the generation
  recorded in the scheduler state. The scheduler re-offers only ``failed`` (a re-added
  ``withdrawn`` line is requeued by its own explicit re-add branch); a generation raised on
  any other status is absorbed there, and this feeder does not pretend otherwise;
* trap 2 — every retry path re-ADDS the queue line when it left the queue and remembers it
  in ``fed_lines.json``; the local only replaced a line and the scheduler never adopted it;
* trap 3 — ``deferred`` holds no engine slot and no driver, so it holds no CAP slot;
* trap 4 — a measured rejection (closed, delivered, held by another lane, target already on
  origin/main, source twin absent, page already published) DROPS the item, never replays it;
* trap 5 — every pending line is validated on LIVE data just before feeding;
* trap 6 — a stale reserve is therefore harmless: its delivered lines are dropped, and
  ``nb_coder_reserve.py`` rebuilds a fresh one rather than trusting a stored list;
* entrance — a pending line is judged by the scheduler's OWN closed loader before it enters
  ``pending.jsonl`` and before any GitHub call; a line that loader refuses (missing or
  unknown field, wrong type, forbidden combination) is dropped and logged, never awaited
  (review 28/11: it used to escape ``poll()`` and kill the daemon at the next poll);
* every 30 min a drift sweep (``nb_coder_drift.py``, the sibling in THIS tree); a NEW flag
  ends the feeder for the operator;
* a transient verdict re-offers the grain ONCE by the feeder; a qualification pause
  (RELACHEE quarantine) is the coordinator's, never auto-retried; a foreign-ended grain is
  expected, not a defect;
* the flow stops only on ``--breaker`` (``NBCODER_FEEDER_BREAKER``) consecutive content
  failures with nothing delivered between them, on an empty pending with every fed grain
  terminal, or on the 24 h bound when nothing remains.

Nothing runs at import time. Exit codes: 0 breaker / empty / drift-flagged, 3 TIMEOUT-24H,
4 QUALIFICATION-PAUSED.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:                     # import the siblings by name, tests included
    sys.path.insert(0, str(_HERE))
import nb_coder_leaf_check as leaf  # noqa: E402
import nb_coder_unfold as unfold_mod  # noqa: E402

LIVE = ("running", "pending", "deferred")          # watched until terminal
SLOT = ("running", "pending")                      # holds a CAP slot (trap 3: deferred does not)
REOFFERABLE = ("failed", "withdrawn")              # a raised retry generation re-offers these
FOREIGN_VERDICTS = ("late-claim-refused", "refused-claim-held-by-another-lane")
# Failures that judged nothing (verifier crash, driver crash, unreadable stage output, source
# twin moved on main) are re-offered ONCE by the feeder itself instead of waking the operator.
TRANSIENT_VERDICTS = ("verify-error", "crashed:", "source-drifted", "stage1-unparsed",
                      "stage2-unparsed", "kernel-start-failed")
QUALIFICATION_VERDICT = "refused-claim-not-qualified:"
FEEDER_ONLY_FIELDS = ("not_before", "unfold", "published")   # never handed to the scheduler
FED_LOG_RE = re.compile(r"^(\S+)Z (fed|retried) (\d+)")
AUTO_LOG_RE = re.compile(r"^\S+Z retried (\d+) auto")
DRIFT_KINDS = ("structure", "code", "deleted")


def key(item: dict) -> tuple[int, str]:
    return (int(item["issue"]), item["notebook"])


def _scheduler_module():
    """The sibling scheduler module, loaded once per process."""
    name = "nb_coder_scheduler"
    mod = sys.modules.get(name)
    if mod is None:
        spec = importlib.util.spec_from_file_location(name, _HERE / f"{name}.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    return mod


def scheduler_line(item: dict) -> str:
    """The queue line for ``item``: feeder-only fields stripped, and the line VALIDATED by
    the scheduler's own closed loader.

    The loader raises on the WHOLE file it is given, so a line it refuses must never reach
    the queue: it would take the whole conveyor down, not only that grain. The rules are
    read from the loader itself, so the two cannot drift — the feeder used to re-implement
    two of them (unknown field, wrong type) and miss the others (missing ``issue`` or
    ``notebook``, a non-positive issue, a notebook that is not repo-relative, the
    from_spec/meta_from/claim_late combinations)."""
    clean = {k: v for k, v in item.items() if k not in FEEDER_ONLY_FIELDS}
    line = json.dumps(clean, ensure_ascii=False) + "\n"
    _scheduler_refuses(line)
    return line


def _scheduler_refuses(line: str) -> None:
    """Raise ValueError when the scheduler's closed loader refuses ``line``."""
    mod = _scheduler_module()
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "queue.jsonl"
        p.write_text(line, encoding="utf-8", newline="")
        try:
            mod.load_queue(p)
        except mod.QueueError as exc:
            raise ValueError(str(exc).replace("queue line 1: ", "")) from exc


def line_defect(item: dict) -> str | None:
    """Why a parsed pending line can never be fed, or None.

    ``pending.jsonl`` is hand-edited (INVOCATION.md §7.2), so its shape is checked at the
    entrance. A grain line without ``notebook`` raised ``KeyError`` out of ``offer_grain``
    and killed the daemon with no log line; an unfold line without an integer ``lot`` could
    never become due, so the feeder never reached PENDING-EMPTY (review 28/11, defect A).
    A grain line is measured with the scheduler's own closed loader — the same check that
    would have refused it in the queue — and a reopen is measured on the line it queues
    (the leaf itself), so a reopen without its notebook is refused BEFORE it writes
    anything."""
    if "unfold" in item:
        u = item["unfold"]
        if not isinstance(u, dict) or not isinstance(u.get("lot"), int):
            return "unfold needs an integer lot"
        if u.get("kind") == "reopen":
            try:
                scheduler_line({k: v for k, v in item.items() if k != "unfold"})
            except ValueError as exc:
                return str(exc)
        return None
    try:
        scheduler_line(item)
    except ValueError as exc:
        return str(exc)
    return None


def utc_stamp(epoch: float) -> str:
    """``YYYY-MM-DDTHH:MM:SS`` (UTC): the format of both the scheduler's ``finished`` and this
    feeder's ``started``, so the two compare lexically."""
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


class Feeder:
    def __init__(self, args, *, gh=None, tree=None, leaf_verdict=None, unfold=None, drift=None,
                 clock=time.time, sleep=time.sleep, echo=False):
        self.args = args
        self.pending = Path(args.pending)
        self.queue = Path(args.queue)
        self.state_path = Path(args.state_dir) / "state.json"
        self.log_path = Path(args.log)
        self.fed_lines_path = Path(args.fed_lines)
        self.repo, self.lane, self.cap = args.repo, args.lane, args.cap
        self.gh = gh or leaf.default_gh
        self._tree = tree
        self._tree_cache = None
        self.leaf_verdict = leaf_verdict or leaf.leaf_verdict
        self.unfold = unfold or unfold_mod
        self.drift = drift or self._run_drift
        self.clock, self.sleep, self.echo = clock, sleep, echo
        self.fed: set = set()
        self.started: dict = {}          # key -> UTC time it was fed; an older end = previous try
        self.auto_retried: set = set()   # issues the feeder already re-offered on a transient
        self.streak = 0
        self.fed_lines: dict = {}        # key -> queue line this feeder put in the queue (trap 2)
        self.room_cache: dict = {}       # unfold lot-room cache (shared REST budget)
        self.inflight = "?"
        self._state_wait = False         # "state-unreadable waiting" logged once per wait
        self._loop_again = False         # a pending line was consumed: re-measure at once
        self.t0 = clock()
        self.last_drift = 0.0
        self.restore()

    # ---------------------------------------------------------------- paths and IO
    def tree(self):
        """Paths on origin/main: an injected set, an injected callable, or the live git read."""
        if self._tree_cache is None:
            if callable(self._tree):
                self._tree_cache = self._tree()
            elif self._tree is not None:
                self._tree_cache = self._tree
            else:
                self._tree_cache = leaf.tree_on_main(self.args.checkout)
        return self._tree_cache

    def stamp(self) -> str:
        return utc_stamp(self.clock())

    def log(self, msg: str) -> None:
        line = self.stamp() + "Z " + msg
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.log_path, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(line + "\n")
        if self.echo:
            print(line, flush=True)

    def queue_rows(self) -> list[str]:
        """Raw non-blank queue lines, newline-terminated; ``#`` comments kept as the scheduler
        keeps them."""
        if not self.queue.exists():
            return []
        rows = []
        for line in self.queue.read_text(encoding="utf-8-sig").splitlines():
            if not line.strip():
                continue
            rows.append(line if line.endswith("\n") else line + "\n")
        return rows

    @staticmethod
    def _row_item(row: str) -> dict | None:
        if row.lstrip().startswith("#"):
            return None
        try:
            return json.loads(row)
        except ValueError:
            return None

    def queue_keys(self) -> list[tuple]:
        out = []
        for r in self.queue_rows():
            d = self._row_item(r)
            if d is not None and "issue" in d and "notebook" in d:
                out.append(key(d))
        return out

    def write_queue(self, rows: list[str]) -> None:
        if self.queue.exists():
            shutil.copy(self.queue, str(self.queue) + ".bak-feeder")
        self.queue.parent.mkdir(parents=True, exist_ok=True)
        tmp = str(self.queue) + ".tmp-feeder"
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("".join(rows))
        os.replace(tmp, self.queue)                     # never leave a half-written queue

    def remember(self, k: tuple, line: str) -> None:
        self.fed_lines[k] = line
        self.fed_lines_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.fed_lines_path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump([[list(k), v] for k, v in self.fed_lines.items()], fh, ensure_ascii=False)

    def pending_lines(self) -> list[str]:
        if not self.pending.exists():
            return []
        return [l.strip() for l in self.pending.read_text(encoding="utf-8-sig").splitlines()
                if l.strip()]

    def write_pending(self, lines: list[str]) -> None:
        with open(self.pending, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("".join(l + "\n" for l in lines))

    def _consume(self, rest: list[str]) -> None:
        """A pending line was consumed: the next pass re-measures at once, as the local
        feeder did ('re-measure before feeding another'), without waiting a poll."""
        self.write_pending(rest)
        self._loop_again = True

    def read_state(self) -> dict:
        """Scheduler grains keyed by (issue, notebook); raises when unreadable."""
        data = json.loads(self.state_path.read_text(encoding="utf-8"))
        return {(int(v["issue"]), v["notebook"]): v
                for v in data["grains"].values() if "issue" in v and "notebook" in v}

    # ---------------------------------------------------------------- restart memory
    def restore(self) -> None:
        """A restarted feeder keeps watching what an earlier run fed (log lines
        `<ts>Z fed|retried <issue>`) and keeps every queue line it ever put in the queue."""
        if self.fed_lines_path.exists():
            try:
                self.fed_lines = {tuple(k): v for k, v in
                                  json.loads(self.fed_lines_path.read_text(encoding="utf-8"))}
            except Exception:
                self.fed_lines = {}
        by_issue: dict = {}
        for r in self.queue_rows():
            d = self._row_item(r)
            if d is None or "issue" not in d or "notebook" not in d:
                continue
            k = key(d)
            by_issue[k[0]] = k
            self.fed_lines.setdefault(k, r)
        if self.log_path.exists():
            for l in self.log_path.read_text(encoding="utf-8").splitlines():
                m = FED_LOG_RE.match(l)
                if m and int(m.group(3)) in by_issue:
                    k = by_issue[int(m.group(3))]
                    self.fed.add(k)
                    self.started[k] = m.group(1)
                a = AUTO_LOG_RE.match(l)
                if a:
                    self.auto_retried.add(int(a.group(1)))
        try:    # a grain already ended when the feeder (re)starts was seen by the operator
            st = self.read_state()
            self.fed = {k for k in self.fed
                        if st.get(k, {}).get("status") in LIVE or k not in st}
        except Exception:
            pass

    # ---------------------------------------------------------------- live reads
    def foreign_claim(self, issue: int) -> str | None:
        """The lane holding the issue (last marker is another lane's [CLAIMED]/[DELIVERED]),
        None otherwise — or when GitHub does not answer: the scheduler's own late-claim
        check stays the guard."""
        try:
            bodies = leaf.comment_bodies(issue, gh=self.gh, repo=self.repo)
        except Exception:
            return None
        return leaf.holder_of(leaf.parse_marks(bodies), self.lane)

    def live_verdict(self, issue: int, item: dict) -> tuple[dict | None, str | None]:
        """(verdict, reason): ``(v, None)`` feedable, ``(v, reason)`` a measured DROP,
        ``(None, "unmeasured")`` live data unreadable — the line is kept, never dropped."""
        try:
            v = self.leaf_verdict(issue, gh=self.gh, tree=self.tree(), lane=self.lane,
                                  repo=self.repo)
        except Exception as exc:
            self.log(f"kept-unmeasured {issue} {str(exc)[:120]}")
            return None, "unmeasured"
        return v, leaf.reject_reason(v, item)

    # ---------------------------------------------------------------- measures
    def reoffer(self, k: tuple, st: dict) -> bool:
        """Retried by the feeder, the scheduler not yet."""
        v = st.get(k, {})
        return (v.get("status") in REOFFERABLE
                and (v.get("finished") or "")[:19] <= self.started.get(k, ""))

    def count_inflight(self, st: dict) -> int:
        """Grains holding a conveyor slot right now (trap 3: ``deferred`` is excluded — it
        holds no engine slot and no driver)."""
        n = sum(1 for v in st.values() if v.get("status") in SLOT)
        qk = self.queue_keys()
        n += sum(1 for k in qk if k not in st)            # queued, not yet adopted
        n += sum(1 for k in self.fed if self.reoffer(k, st))
        return n

    def work_remains(self) -> bool:
        """A bound that ends the feeder while work remains is the 17.9 h silent stop again,
        on a timer. Pending lines (even future-dated or awaiting lot room) or a live grain."""
        if self.pending_lines():
            return True
        try:
            return any(v.get("status") in LIVE for v in self.read_state().values())
        except Exception:
            return True                                  # unreadable state: never end on a guess

    def pick_due(self, pend: list[str]) -> int | None:
        """The first due line. An 'unfold' item is fed only when its lot has room; a blocked
        one never holds back the items behind it."""
        now_iso = self.stamp()
        for i, l in enumerate(pend):
            d = json.loads(l)
            if str(d.get("not_before", "")) > now_iso:
                continue
            # A line marked "published" is this feeder's own publish whose queue line is
            # still missing: do() measures the room itself unless the page did land.
            if ("unfold" in d and not d.get("published")
                    and not self.has_room(d["unfold"])):
                continue
            return i
        return None

    def has_room(self, u: dict) -> bool:
        return bool(self.unfold.has_room(u, gh=self.gh, cache=self.room_cache,
                                         now=self.clock(), repo=self.repo))

    def prune_bad_lines(self, pend: list[str]) -> list[str]:
        """Unparseable lines and shapeless ones (``line_defect``) leave the list, each with
        its own log line; the rest keeps its order. A shapeless line is a hand-edit, not a
        transient fault: it is dropped, never replayed."""
        good, bad = [], []
        for l in pend:
            try:
                d = json.loads(l)
                if not isinstance(d, dict):
                    raise ValueError("not a JSON object")
            except ValueError:
                bad.append(f"unparseable-line {l[:80]!r}")
                continue
            defect = line_defect(d)
            if defect:
                bad.append(f"{d.get('issue', '?')} bad-line {defect} {l[:80]!r}")
            else:
                good.append(l)
        for why in bad:
            self.log(f"rejected {why}")
        if bad:
            self.write_pending(good)
        return good

    # ---------------------------------------------------------------- queue writes
    def retry_write(self, k: tuple, line: str) -> None:
        """Replace the grain's queue line, or re-ADD it when the line left the queue (trap 2:
        measured 19:12Z — 'retried', counted in flight, never adopted). Remembered so a later
        retry can restore it again."""
        rows = self.queue_rows()
        rows = [line if (d := self._row_item(r)) is not None and "issue" in d
                and "notebook" in d and key(d) == k else r for r in rows]
        if not any((d := self._row_item(r)) is not None and "issue" in d and "notebook" in d
                   and key(d) == k for r in rows):
            rows.append(line)
        self.write_queue(rows)
        self.remember(k, line)

    def feed_write(self, k: tuple, line: str) -> None:
        self.write_queue(self.queue_rows() + [line])
        self.remember(k, line)

    # ---------------------------------------------------------------- drift
    def _run_drift(self):
        return subprocess.run(
            [sys.executable, "-X", "utf8", "-I", str(self.args.drift_script),
             "--repo", self.args.checkout, "--slug", self.repo, "--lane", self.lane,
             "--comment", "--json"],
            capture_output=True, text=True, encoding="utf-8", timeout=self.args.drift_timeout_s)

    def drift_sweep(self) -> int | None:
        """Open nbcoder PRs whose source twin moved on main: flag ours once (idempotent
        comment); exit to the operator on a NEW flag."""
        try:
            p = self.drift()
        except subprocess.TimeoutExpired:
            self.log("drift-sweep timeout")
            return None
        if p.returncode == 2:
            self.log(f"drift-sweep instrument failure: {(p.stderr or '')[:160]}")
            return None
        try:
            rep = json.loads(p.stdout or "[]")
        except ValueError:
            self.log("drift-sweep unreadable output")
            return None
        new = [e for e in rep if e.get("comment") == "posted"]
        drifted = [e["pr"] for e in rep
                   if any(r.get("drift") in DRIFT_KINDS for r in e.get("drift") or [])]
        self.log(f"drift-sweep {len(rep)} PRs, drifted={drifted}")
        if new:
            self.log(f"SOURCE-DRIFT-FLAGGED {[e['pr'] for e in new]}")
            return 0
        return None

    # ---------------------------------------------------------------- end of a fed grain
    def end_of_grain_scan(self, st: dict) -> int | None:
        for k in sorted(self.fed):
            v = st.get(k)
            if v and v.get("status") in REOFFERABLE and \
                    (v.get("finished") or "")[:19] > self.started.get(k, ""):
                lv = str(v.get("last_verdict") or "")
                if lv.startswith(QUALIFICATION_VERDICT):
                    # A guard qualification (RELACHEE/GEL/LABEL/HORSFLOTTE) is not a foreign
                    # collision and not a content verdict. Never auto-retry it: RELACHEE's
                    # three-day quarantine belongs to CoursIA's coordinator, not this feeder.
                    self.log(f"QUALIFICATION-PAUSED {k[0]} {lv}")
                    return 4
                # a grain another lane took while we built it is expected, not a defect
                holder = None if lv.startswith(FOREIGN_VERDICTS) else self.foreign_claim(k[0])
                if lv.startswith(FOREIGN_VERDICTS) or holder:
                    self.log(f"foreign-ended {k[0]} {lv or 'no-verdict'} holder={holder}")
                    self.fed.discard(k)
                    continue
                if v.get("status") == "failed" and k[0] not in self.auto_retried \
                        and (lv == "" or lv.startswith(TRANSIENT_VERDICTS)):
                    action = self.auto_retry(k, v, lv)
                    if action in ("retried", "dropped", "unmeasured"):
                        continue                        # re-offered / dropped / try next poll
                    # "no-base": fall through to the streak, as the local did
                self.streak += 1
                self.log(f"FED-GRAIN-ENDED {k[0]} {v.get('status')} {v.get('last_verdict')} "
                         f"(streak {self.streak}/{self.args.breaker})")
                self.fed.discard(k)
                if self.streak >= self.args.breaker:
                    self.log(f"BREAKER-TRIPPED {self.streak} content failures in a row, "
                             "nothing delivered")
                    return 0
                continue
            if v and v.get("status") == "done":
                self.streak = 0
                self.log(f"done {k[0]} {v.get('last_verdict')}")
                self.fed.discard(k)
        return None

    def auto_retry(self, k: tuple, v: dict, lv: str) -> str:
        """Re-offer a transiently failed grain once. Returns "retried" (re-offered),
        "dropped" (measured rejection), "unmeasured" (live data unreadable, try next poll) or
        "no-base" (no queue line to re-offer — the caller falls through to the streak)."""
        gen = max(int(v.get("retry", 0) or 0), 0) + 1
        rows = self.queue_rows()
        hit = [r for r in rows if (d := self._row_item(r)) is not None and "issue" in d
               and "notebook" in d and key(d) == k]
        base = json.loads(hit[0]) if hit else (
            json.loads(self.fed_lines[k]) if self.fed_lines.get(k) else None)
        if base is None:
            self.log(f"auto-retry-skipped {k[0]} no queue line to re-offer after {lv or 'no-verdict'}")
            return "no-base"
        vv, reason = self.live_verdict(k[0], base)      # trap 4: never replay delivered work
        if vv is None:
            return "unmeasured"
        if reason:
            self.log(f"rejected {k[0]} {reason}")
            self.fed.discard(k)
            return "dropped"
        base["retry"] = max(int(base.get("retry", 0) or 0), gen)
        new = scheduler_line(base)
        rows = [new if (d := self._row_item(r)) is not None and "issue" in d
                and "notebook" in d and key(d) == k else r for r in rows]
        if not hit:
            rows.append(new)                             # the line left the queue: put it back
        self.write_queue(rows)
        self.remember(k, new)
        self.auto_retried.add(k[0])
        self.started[k] = self.stamp()
        self.log(f"retried {k[0]} auto retry={gen} after {lv or 'no-verdict'}")
        return "retried"

    # ---------------------------------------------------------------- feeding
    def offer_unfold(self, item: dict, pend: list[str], idx: int, st: dict) -> None:
        rest = pend[:idx] + pend[idx + 1:]
        try:
            res = self.unfold.do(item, log=self.log, gh=self.gh, cache=self.room_cache,
                                 now=self.clock(), lane=self.lane, tmpdir=self.args.tmpdir,
                                 tree=self.tree(), repo=self.repo)
        except Exception as exc:            # unreadable live data: keep the line, never guess
            self.log(f"unfold-unmeasured {item.get('issue')} {str(exc)[:120]}")
            return                          # the pending line stays, re-measured next poll
        if res.action == "dropped":
            self._consume(rest)                    # logged by unfold: never replayed
            return
        if res.action != "fed" or res.out is None:
            # deferred or failed: logged, item kept. A publish that landed without yielding
            # its queue line is remembered ON the pending line — otherwise the next poll
            # reads the page as 'already published' and drops a grain never queued.
            if res.published and not item.get("published"):
                pend = list(pend)
                pend[idx] = json.dumps({**item, "published": True}, ensure_ascii=False)
                self.write_pending(pend)
            return
        out = res.out
        try:
            line = scheduler_line(out)
            k = key(out)
        except (ValueError, KeyError) as exc:
            self.log(f"rejected {out.get('issue')} bad-line {exc}")
            self._consume(rest)
            return
        if k in st or k in self.queue_keys():  # trap 1, unfold side: never a second line
            self.log(f"skip already-known {k[0]} unfolded")
            self._consume(rest)
            return
        self.feed_write(k, line)
        self.fed.add(k)
        self.started[k] = self.stamp()
        self.log(f"fed {k[0]} unfolded (inflight was {self.inflight})")
        self.write_pending(rest)

    def offer_grain(self, item: dict, pend: list[str], idx: int, st: dict) -> None:
        """Offer one due grain line: feed, retry, or drop it. The pending line always leaves
        the list unless the live data could not be read.

        ``item`` comes through ``prune_bad_lines``: a line the scheduler's loader refuses
        was dropped there, so ``key(item)`` cannot raise here (review 28/11, defect A)."""
        k = key(item)
        rest = pend[:idx] + pend[idx + 1:]
        v, reason = self.live_verdict(k[0], item)       # trap 5: live data just before feeding
        if v is None:
            return                                      # unmeasured: keep, retry next poll
        if reason == "held-by-another-lane":
            self.log(f"rejected {k[0]} held-by-another-lane {v.get('held_by')}")
            self._consume(rest)                         # dropped, never replayed
            return
        if reason:
            self.log(f"rejected {k[0]} {reason}")       # trap 4: dropped, never replayed
            self._consume(rest)
            return
        try:
            line = scheduler_line(item)
        except ValueError as exc:
            self.log(f"rejected {k[0]} bad-line {exc}")  # never poison the scheduler's queue
            self._consume(rest)
            return
        g = st.get(k)
        if g and int(item.get("retry", 0) or 0) > int(g.get("retry", 0) or 0) \
                and g.get("status") in REOFFERABLE:
            self.retry_write(k, line)                   # trap 2: re-added if absent
            self.fed.add(k)
            self.started[k] = self.stamp()
            self.log(f"retried {k[0]} retry={item['retry']} (inflight was {self.inflight})")
        elif k in st or k in self.queue_keys():
            self.log(f"skip already-known {k[0]}")      # trap 1: never a plain re-feed
        else:
            self.feed_write(k, line)
            self.fed.add(k)
            self.started[k] = self.stamp()
            self.log(f"fed {k[0]} (inflight was {self.inflight})")
        self._consume(rest)

    # ---------------------------------------------------------------- the loop
    def poll(self) -> int | None:
        """One pass. Returns an exit code when the feeder must stop, None to poll again."""
        self._tree_cache = None
        self._loop_again = False
        now = self.clock()
        if now - self.t0 > self.args.bound_s:           # also while every item waits for room
            if self.work_remains():
                self.log(f"BOUND-REACHED work remains, continuing (inflight={self.inflight})")
                self.t0 = now
            else:
                self.log("TIMEOUT-24H")
                return 3
        if now - self.last_drift > self.args.drift_every_s:
            self.last_drift = now
            code = self.drift_sweep()
            if code is not None:
                return code
        try:
            st = self.read_state()
            self._state_wait = False
        except Exception as exc:                       # half-written or absent state.json
            if not self._state_wait:                   # say it once, not once per poll
                self.log(f"state-unreadable waiting ({str(exc)[:80]})")
                self._state_wait = True
            return None                               # next poll: never feed on a guess
        code = self.end_of_grain_scan(st)
        if code is not None:
            return code
        self.inflight = self.count_inflight(st)
        pend = self.prune_bad_lines(self.pending_lines())
        if not pend and not any(st.get(k, {}).get("status") in LIVE or k not in st
                                or self.reoffer(k, st) for k in self.fed):
            self.log("PENDING-EMPTY all fed grains terminal")
            return 0
        if pend and self.inflight < self.cap:
            idx = self.pick_due(pend)
            if idx is None:
                return None
            item = json.loads(pend[idx])
            if "unfold" in item:
                self.offer_unfold(item, pend, idx, st)
            else:
                self.offer_grain(item, pend, idx, st)
        return None                                   # re-measure before feeding another

    def run(self) -> int:
        while True:
            code = self.poll()
            if code is not None:
                return code
            if not self._loop_again:                     # a consumed line re-measures at once
                self.sleep(self.args.poll_s)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="the conveyor feeder: at most CAP grains in flight")
    ap.add_argument("--pending", required=True, type=Path, help="ordered pending.jsonl")
    ap.add_argument("--queue", required=True, type=Path, help="the scheduler's queue.jsonl")
    ap.add_argument("--state-dir", required=True, type=Path, help="the scheduler's state dir")
    ap.add_argument("--repo", default="jsboige/CoursIA", help="GitHub slug of the target repo")
    ap.add_argument("--checkout", required=True, help="local clone (origin/main is read there)")
    ap.add_argument("--lane", default=os.environ.get("NBCODER_LANE", ""),
                    help="this lane's claim identity (env NBCODER_LANE)")
    ap.add_argument("--cap", type=int, default=int(os.environ.get("NBCODER_FEEDER_CAP", "5")))
    ap.add_argument("--breaker", type=int,
                    default=int(os.environ.get("NBCODER_FEEDER_BREAKER", "5")))
    ap.add_argument("--poll-s", type=float, default=60.0)
    ap.add_argument("--bound-s", type=float, default=24 * 3600.0)
    ap.add_argument("--drift-every-s", type=float, default=1800.0)
    ap.add_argument("--drift-script", type=Path, default=_HERE / "nb_coder_drift.py",
                    help="the sibling drift sweep, read from THIS tree")
    ap.add_argument("--drift-timeout-s", type=float, default=1200.0)
    ap.add_argument("--log", type=Path, default=None, help="default: <pending dir>/feeder.log")
    ap.add_argument("--fed-lines", type=Path, default=None,
                    help="default: <pending dir>/fed_lines.json")
    ap.add_argument("--tmpdir", type=Path, default=None, help="unfold payloads; default <pending dir>")
    ap.add_argument("--once", action="store_true", help="one poll then exit (observation)")
    a = ap.parse_args(argv)
    a.log = a.log or a.pending.parent / "feeder.log"
    a.fed_lines = a.fed_lines or a.pending.parent / "fed_lines.json"
    a.tmpdir = a.tmpdir or a.pending.parent
    return a


def main(argv: list[str] | None = None) -> int:
    a = parse_args(argv)
    if not a.lane.strip():
        print("refused: no lane (NBCODER_LANE or --lane); a feeder without identity would "
              "re-offer grains under another seat's name", file=sys.stderr)
        return 2
    feeder = Feeder(a, echo=True)
    if a.once:
        return feeder.poll() or 0
    return feeder.run()


if __name__ == "__main__":
    sys.exit(main())
