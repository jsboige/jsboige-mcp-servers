#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Authored here (#1913 feeder port) — no jsboige/vllm original. The lane-local
# original (D:/vllm/.tmp/nbcoder/feeder/unfold.py on ai-01) hard-coded
# repos/jsboige/CoursIA and the kit/scratch dirs under D:/vllm/.tmp; this port
# parameterises them and injects the GitHub call and the kit runners. This tree
# is the source of truth.
# Harness base is the vllm re-copy @ 7a09e1caec22441d9402ab25a222206c8905bfe1.
# -----------------------------------------------------------------------------
"""Unfold a pre-written spec page ("pli") of a family lot when its lot has room.

Preserved from the lane-local feeder/unfold.py (#1913): a Rust-std lot keeps at most
MAX_OPEN open undelivered spec leaves, and the next page unfolds only when one is
delivered. The lot's room is measured on live REST data, cached for ROOM_TTL so a blocked
lot costs at most one search per window on the shared quota. After a successful unfold the
fold is ticked in the lot issue.

Added by the port (trap 4, the measured stale-reserve replays): the rejection guards. A
publish whose spec key is already in the kit's ``specs.txt`` is DROPPED (the local re-ran
``publish.py`` and re-posted a byte-identical lot comment). A reopen of a leaf that is
already open, delivered, held by another lane, or whose Rust target is already on
origin/main is DROPPED (the local reopened a leaf another lane had delivered). A dropped
item is removed from pending; a deferred/failed one is kept for the next poll.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:                     # import the sibling by name, tests included
    sys.path.insert(0, str(_HERE))
import nb_coder_leaf_check as leaf  # noqa: E402

PARENT_RE = leaf.PARENT_RE
MAX_OPEN = 2                                      # c0021: open undelivered leaves per lot
ROOM_TTL = 600                                    # s: a blocked lot is re-measured at most so often
TITLE = "Spec portage Rust"                       # the leaf issue title fragment


class UnfoldResult(NamedTuple):
    """``action`` in {"fed", "deferred", "failed", "dropped"}; ``out`` is the queue item when
    fed. The feeder removes a dropped item from pending and keeps every other one.
    ``published`` says a publish landed but its queue line was not obtained: the feeder marks
    the pending line so the next poll resumes (reads the line) instead of reading the page as
    'already published' and dropping a grain that was published but never queued."""
    action: str
    out: dict | None = None
    reason: str | None = None
    published: bool = False


def _stamp(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).strftime("%d/%m %H:%MZ")


def undelivered(lot: int, *, gh, cache: dict, now: float, fresh: bool = False,
                repo: str = "jsboige/CoursIA", ttl: float = ROOM_TTL) -> list[int]:
    """Open 'Spec portage Rust' leaves of ``lot`` without a [DELIVERED] marker (REST)."""
    c = cache.get(lot)
    if c and not fresh and now - c[0] < ttl:
        return c[1]
    d = gh("-X", "GET", "search/issues", "-f",
           f'q=repo:{repo} is:issue is:open "{TITLE}" in:title', "-f", "per_page=100")
    und = []
    for it in (d.get("items") if isinstance(d, dict) else None) or []:
        m = PARENT_RE.search(it.get("body") or "")
        if not m or int(m.group(1)) != lot:
            continue
        bodies = (leaf.comment_bodies(it["number"], gh=gh, repo=repo)
                  if it.get("comments") else [])
        if not any(b.lstrip().startswith("[DELIVERED]") for b in bodies):
            und.append(it["number"])
    cache[lot] = (now, und)
    return und


def has_room(u: dict, *, gh, cache: dict, now: float, repo: str = "jsboige/CoursIA") -> bool:
    """Whether ``u["lot"]`` has a free place for one more unfolded leaf. Fail-closed: an
    unreadable GitHub means unfold nothing."""
    try:
        return len(undelivered(u["lot"], gh=gh, cache=cache, now=now, repo=repo)) < MAX_OPEN
    except Exception:
        return False


def specs_published(kit_pub: str | Path, key: str) -> bool:
    """Whether ``key`` is already listed in the kit's ``specs.txt`` (trap 4 guard). The file
    is ``<spec key> <issue>`` per line; a missing file means nothing is published yet."""
    p = Path(kit_pub) / "specs.txt"
    try:
        text = p.read_text(encoding="utf-8")
    except OSError:
        return False
    return any(line.split() and line.split()[0] == key for line in text.splitlines())


def reopen_guard(item: dict, *, gh, tree, lane: str,
                 repo: str = "jsboige/CoursIA") -> str | None:
    """The DROP reason for a reopen, or None. An already-open leaf is refused so no duplicate
    comment is posted; a delivered/held/on-main leaf is refused so delivered work is never
    replayed (trap 4)."""
    n = item["issue"]
    v = leaf.leaf_verdict(n, gh=gh, tree=tree, lane=lane, repo=repo)
    if v["state"] == "open":
        return "already-open"
    if v["delivered_marker"]:
        return "delivered"
    if v["held_by"]:
        return "held-by-another-lane"
    if v["target"] and v["rust_on_main"]:
        return "target-on-main"
    return None


def tick_pli(lot: int, pli: str, n: int, *, gh, tmpdir: str | Path,
             repo: str = "jsboige/CoursIA", now: float | None = None) -> str:
    """Mark the lot's checklist line as unfolded (- [ ] ... -> #n). Returns a status word."""
    body = str(gh(f"repos/{repo}/issues/{lot}").get("body") or "").replace("\r\n", "\n")
    lines = body.split("\n")
    hit = [i for i, l in enumerate(lines) if l.startswith("- [ ] " + pli)]
    if len(hit) != 1:
        return f"pli-line-not-found({len(hit)})"
    i = hit[0]
    lines[i] = "- [x] " + pli + f" — **dépliée en #{n}** ({_stamp(now if now is not None else time.time())})"
    payload = Path(tmpdir) / f"p_lot{lot}.json"
    payload.parent.mkdir(parents=True, exist_ok=True)
    payload.write_text(json.dumps({"body": "\n".join(lines)}, ensure_ascii=False),
                       encoding="utf-8", newline="")
    gh("-X", "PATCH", f"repos/{repo}/issues/{lot}", "--input", str(payload))
    return "ticked"


# ---------------------------------------------------------------- default kit runners
class RunnerResult(NamedTuple):
    rc: int
    stdout: str
    stderr: str


def subprocess_publish(kit: str | Path, fam: str, key: str, *, py=sys.executable) -> RunnerResult:
    p = subprocess.run([py, "-X", "utf8", "-I", str(Path(kit) / "publish.py"), fam, "--only", key],
                       capture_output=True, text=True, encoding="utf-8")
    return RunnerResult(p.returncode, p.stdout or "", p.stderr or "")


def subprocess_feeder_lines(kit: str | Path, fam: str, *, py=sys.executable) -> list[dict]:
    """The kit's queue lines for ``fam``. Raises on a non-zero rc and on an unreadable line:
    a kit that prints a banner or a traceback must not be read as 'no line', and must not
    take the feeder's loop down either — ``do()`` turns both into a kept failure."""
    p = subprocess.run([py, "-X", "utf8", "-I", str(Path(kit) / "feeder_lines.py"), fam],
                       capture_output=True, text=True, encoding="utf-8")
    if p.returncode:
        raise RuntimeError(f"feeder_lines.py {fam}: rc={p.returncode} "
                           f"{(p.stderr or '').strip()[-200:]}")
    return [json.loads(l) for l in (p.stdout or "").splitlines() if l.strip()]


def do(item: dict, *, log, gh, cache: dict, now: float, lane: str, tmpdir: str | Path,
       tree=None, repo: str = "jsboige/CoursIA", publish=subprocess_publish,
       feeder_lines=subprocess_feeder_lines) -> UnfoldResult:
    """Unfold one page; return the queue item (action="fed") or a keep/drop verdict."""
    u = item["unfold"]
    kind = u.get("kind")
    known = specs_published(u["kit"], u["key"]) if kind == "publish" else False
    landed = bool(item.get("published")) and known      # this feeder published it already
    if not landed:
        try:
            und = undelivered(u["lot"], gh=gh, cache=cache, now=now, fresh=True, repo=repo)
        except Exception as exc:                   # unreadable live data: keep, never guess
            log(f"unfold-unmeasured lot #{u.get('lot')} {str(exc)[:120]}")
            return UnfoldResult("deferred", None, "unmeasured")
        if len(und) >= MAX_OPEN:
            log(f"unfold-deferred lot #{u['lot']} undelivered={und}")
            return UnfoldResult("deferred", None, "lot-full")

    if kind == "publish":
        if landed:
            # Published on an earlier poll, queue line never obtained: the leaf is already
            # among the lot's open ones, so no room is measured — republishing is what trap 4
            # forbids, reading the line is the remaining work.
            log(f"unfold-resume-published {u['key']} queue line still missing")
        elif known:
            log(f"unfold-rejected page-already-published {u['key']}")
            return UnfoldResult("dropped", None, "page-already-published")
        else:
            p = publish(u["kit"], u["fam"], u["key"])
            log(f"unfold-publish {u['key']} rc={p.rc} {p.stdout.strip()[-200:]} "
                f"{p.stderr.strip()[-200:]}")
            if p.rc:
                return UnfoldResult("failed", None, f"publish-rc={p.rc}")
        try:
            rows = [r for r in feeder_lines(u["kit"], u["fam"])
                    if u["key"] in str(r.get("notebook", ""))]
        except Exception as exc:                   # kit rc != 0, or a banner on its stdout
            log(f"unfold-no-queue-line {u['key']} kit-error {str(exc)[:120]}")
            return UnfoldResult("failed", None, "feeder-lines-error", published=True)
        if len(rows) != 1:
            log(f"unfold-no-queue-line {u['key']} ({len(rows)})")
            return UnfoldResult("failed", None, "no-queue-line", published=True)
        out = rows[0]
    elif kind == "reopen":
        try:
            reason = reopen_guard(item, gh=gh, tree=tree, lane=lane, repo=repo)
        except Exception as exc:
            log(f"unfold-unmeasured reopen #{item.get('issue')} {str(exc)[:120]}")
            return UnfoldResult("deferred", None, "unmeasured")
        if reason:
            log(f"unfold-rejected reopen-{reason} #{item['issue']}")
            return UnfoldResult("dropped", None, f"reopen-{reason}")
        n = item["issue"]
        body = ("**Redépliée (c0021)** — le lot #%d est repassé sous %d feuilles ouvertes non "
                "livrées (mesure REST : %s). La page et son script de rejeu ci-dessus restent "
                "valables ; prise par le tapis nb_coder de la lane %s."
                % (u["lot"], MAX_OPEN, und or "aucune", lane))
        payload = Path(tmpdir) / f"c_reopen_{n}.json"
        payload.parent.mkdir(parents=True, exist_ok=True)
        payload.write_text(json.dumps({"body": body}, ensure_ascii=False),
                           encoding="utf-8", newline="")
        gh("-X", "PATCH", f"repos/{repo}/issues/{n}", "-f", "state=open")
        gh("-X", "POST", f"repos/{repo}/issues/{n}/comments", "--input", str(payload))
        log(f"unfold-reopen {n}")
        out = {k: v for k, v in item.items() if k != "unfold"}
    else:
        log(f"unfold-rejected unknown-kind {kind}")
        return UnfoldResult("dropped", None, f"unknown-kind {kind}")

    cache.pop(u["lot"], None)
    try:
        log(f"unfold-pli lot #{u['lot']} "
            f"{tick_pli(u['lot'], u['pli'], out['issue'], gh=gh, tmpdir=tmpdir, repo=repo, now=now)}")
    except Exception as exc:
        log(f"unfold-pli lot #{u['lot']} failed {str(exc)[:120]}")
    return UnfoldResult("fed", out)
