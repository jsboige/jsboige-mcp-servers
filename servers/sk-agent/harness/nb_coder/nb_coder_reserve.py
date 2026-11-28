#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Authored here (#1913 feeder port) — no jsboige/vllm original. The lane-local
# original (D:/vllm/.tmp/nbcoder/feeder/live_reserve.py on ai-01) hard-coded
# repos/jsboige/CoursIA, D:/CoursIA and the lane myia-ai-01:vllm; this port
# parameterises them and injects the GitHub/git calls. This tree is the source
# of truth.
# Harness base is the vllm re-copy @ 7a09e1caec22441d9402ab25a222206c8905bfe1.
# -----------------------------------------------------------------------------
"""Build a FRESH picture of the Rust-std gisement from live data (REST + origin/main).

Preserved from the lane-local feeder/live_reserve.py (#1913, trap 6): it replaces the
hand-written reserve lists that replayed already-delivered work (an already-merged leaf
relaunched, a lot comment reposted, a leaf another lane delivered reopened; trap 4). The
remedy is the same every cycle: never trust a stored reserve, recompute what is still open
and still ours.

The classification is deliberately read-only and deterministic — ``classify`` and
``build_reserve`` are pure functions over already-fetched data, so tests pin them with
fakes. ``reserve_stale`` flags a reserve whose timestamp is older than the caller's bound:
a stale reserve is rebuilt, never consumed.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:                     # import the sibling by name, tests included
    sys.path.insert(0, str(_HERE))
import nb_coder_leaf_check as leaf  # noqa: E402

MAX_OPEN = 2
PLI_RE = re.compile(r"^- \[( |x)\] (.+)$")
RUST_TWIN_RE = re.compile(r"(MyIA\.AI\.Notebooks/\S+-Rust\.ipynb)")
DEFAULT_MAX_AGE_S = 12 * 3600                      # a reserve older than this is rebuilt


class ReserveUnavailable(RuntimeError):
    """A live read failed: the reserve is unmeasured, never empty-by-accident."""


def search(q: str, *, gh, sleep=time.sleep, max_pages: int = 20) -> list[dict]:
    """Paginate the search API (30 req/min on the shared bucket, hence the 2.1 s pause)."""
    out: list[dict] = []
    for page in range(1, max_pages + 1):
        d = gh("-X", "GET", "search/issues", "-f", f"q={q}", "-f", "sort=created",
               "-f", "order=asc", "-f", "per_page=100", "-f", f"page={page}")
        items = d.get("items") or [] if isinstance(d, dict) else []
        out += items
        if not items or len(out) >= min(int(d.get("total_count", 0)), 1000):
            return out
        sleep(2.1)
    return out


def parse_plis(body: str) -> dict:
    """Split a lot body's checklist into folded texts and unfolded text->issue."""
    folded, unfolded = [], {}
    for line in (body or "").replace("\r\n", "\n").split("\n"):
        m = PLI_RE.match(line)
        if not m:
            continue
        text = m.group(2)
        head = text.split(" — ")[0].strip()
        if m.group(1) == " ":
            folded.append(head)
        else:
            d = re.search(r"#(\d+)", text)
            unfolded[head] = int(d.group(1)) if d else None
    return {"folded": folded, "unfolded": unfolded}


def target_of(body: str) -> str | None:
    m = RUST_TWIN_RE.search(body or "")
    return m.group(1) if m else None


def classify(leaves: list[dict], comments_by_issue: dict[int, list[str]],
             twins: set[str], lane: str) -> dict[int, dict]:
    """Per-leaf live state: delivered (closed / [DELIVERED] / target on main), held_by, target."""
    out: dict[int, dict] = {}
    for it in leaves:
        num = it["number"]
        marks = leaf.parse_marks(comments_by_issue.get(num, []))
        target = target_of(it.get("body") or "")
        on_main = (target in twins) if target else False
        delivered = it.get("state") == "closed" or leaf.delivered_of(marks) or on_main
        out[num] = {"issue": num, "target": target, "delivered": delivered,
                    "on_main": on_main, "held_by": leaf.holder_of(marks, lane)}
    return out


def build_reserve(*, lots: list[dict], leaves: list[dict],
                  comments_by_issue: dict[int, list[str]], twins: set[str], lane: str,
                  kits: dict | None = None, now: float | None = None) -> dict:
    """The reserve JSON of live_reserve.py: pool A, pool B and per-lot rows."""
    kits = kits or {}
    states = classify(leaves, comments_by_issue, twins, lane)
    by_lot: dict[int, list[dict]] = {}
    for it in leaves:
        m = leaf.PARENT_RE.search(it.get("body") or "")
        by_lot.setdefault(int(m.group(1)) if m else 0, []).append(it)

    pool_a, rows = [], []
    for lot in lots:
        n = lot["number"]
        plis = parse_plis(lot.get("body") or "")
        delivered, open_und, held = [], [], {}
        for it in by_lot.get(n, []):
            num = it["number"]
            st = states[num]
            if st["delivered"]:
                delivered.append(num)
            else:
                open_und.append(num)
                if st["held_by"]:
                    held[num] = st["held_by"]
                else:
                    pool_a.append(num)
        title = re.sub(r".*«\s*Rust std\s*·\s*([^»]+)».*", r"\1", lot.get("title") or "")
        rows.append({"lot": n, "fam": title, "state": lot.get("state"),
                     "unfolded": len(plis["unfolded"]), "delivered": len(delivered),
                     "open_undelivered": open_und, "held_by": held,
                     "free_open": [x for x in open_und if x not in held],
                     "folded": plis["folded"]})
    pool_b = []
    for r in rows:
        if len(r["open_undelivered"]) < MAX_OPEN:
            for key_text in r["folded"]:
                key = key_text.replace(" ", "-")
                pool_b.append({"pli": key_text, "key": key, "lot": r["lot"],
                               "fam": r["fam"], "kit": kits.get(key)})
    ts = datetime.fromtimestamp(now if now is not None else time.time(),
                                timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"ts": ts, "pool_a": pool_a, "pool_b": pool_b, "lots": rows}


def reserve_stale(ts: str, now: float, max_age_s: float = DEFAULT_MAX_AGE_S) -> bool:
    """Whether a reserve built at ``ts`` (``YYYY-MM-DDTHH:MM:SSZ``) may no longer be trusted.
    Older than the bound, dated in the future (clock skew), or unparseable: all stale — a
    reserve that cannot be dated trustworthily is rebuilt, never consumed."""
    try:
        built = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return True
    return abs(now - built.timestamp()) > max_age_s


def twins_on_main(checkout: str, *, run=subprocess.run) -> set[str]:
    p = run(["git", "-C", str(checkout), "ls-tree", "-r", "--name-only", "origin/main"],
            capture_output=True, text=True, encoding="utf-8")
    if getattr(p, "returncode", 0):
        raise ReserveUnavailable(f"git ls-tree origin/main failed: {(p.stderr or '')[-300:]}")
    return {l for l in (p.stdout or "").splitlines() if l.endswith("-Rust.ipynb")}


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="rebuild the Rust-std reserve from live data")
    ap.add_argument("--repo", default="jsboige/CoursIA", help="GitHub slug")
    ap.add_argument("--checkout", required=True, help="local clone of the target repo")
    ap.add_argument("--lane", required=True, help="this lane's claim identity")
    ap.add_argument("--json", default=None, help="write the reserve JSON here")
    a = ap.parse_args(argv)
    gh = leaf.default_gh
    try:
        twins = twins_on_main(a.checkout)
        lots = search(f'repo:{a.repo} is:issue "Origami Rust" in:title', gh=gh)
        leaves = search(f'repo:{a.repo} is:issue "Spec portage Rust" in:title', gh=gh)
    except (ReserveUnavailable, leaf.LiveDataUnavailable) as exc:
        print(f"live data unavailable: {exc}", file=sys.stderr)
        return 2
    comments = {}
    for it in leaves:
        if it.get("comments"):
            comments[it["number"]] = leaf.comment_bodies(it["number"], gh=gh, repo=a.repo)
    res = build_reserve(lots=lots, leaves=leaves, comments_by_issue=comments,
                        twins=twins, lane=a.lane)
    print(f"pool_a={len(res['pool_a'])} pool_b={len(res['pool_b'])} lots={len(res['lots'])}")
    if a.json:
        Path(a.json).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    else:
        print(json.dumps(res, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
