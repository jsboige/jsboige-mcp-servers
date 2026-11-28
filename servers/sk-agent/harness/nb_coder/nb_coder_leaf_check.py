#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Authored here (#1913 feeder port) — no jsboige/vllm original. The lane-local
# original (D:/vllm/.tmp/nbcoder/feeder/check_leaf.py on ai-01) hard-coded
# repos/jsboige/CoursIA, D:/CoursIA and the lane myia-ai-01:vllm; this port
# parameterises every one of them and injects the GitHub/git calls. This tree is
# the source of truth.
# Harness base is the vllm re-copy @ 7a09e1caec22441d9402ab25a222206c8905bfe1.
# -----------------------------------------------------------------------------
"""Pre-feed validation of one 'Spec portage Rust' leaf on LIVE data (REST + origin/main).

Preserved from the lane-local feeder/check_leaf.py (#1913, trap 5): every line of
``pending.jsonl`` is a stale cache by definition, so each one is re-validated on live data
just before it is fed. The local script printed one JSON verdict and exited 0/1; here the
same verdict is a plain dict, the GitHub and git calls are injected, and nothing runs at
import time.

A leaf is feedable only if: the issue is open, it carries no ``[DELIVERED]`` marker, its
last claim marker is not another lane's ``[CLAIMED]``/``[DELIVERED]``, its body names a
``...-Rust.ipynb`` target, that target is absent from ``origin/main``, and (for a port
grain) its ``-Python.ipynb`` source twin is present there. Creation grains (``from_spec``)
have no source twin and skip that last test.

``reject_reason`` turns a verdict into the closed set of DROP reasons the feeder applies
(trap 4): a measured rejection is removed from pending, never replayed. A live read that
fails is NOT a rejection — ``gh`` raises :class:`LiveDataUnavailable` and the feeder keeps
the line for the next poll, never dropping on a guess.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys

# A claim marker: the first non-space run of an issue comment. Mirrors the local script.
MARK_RE = re.compile(r"^\[(CLAIMED|RELEASED|DELIVERED)\] lane (\S+)")
RUST_PATH_RE = re.compile(r"MyIA\.AI\.Notebooks/\S+?-Rust\.ipynb")
PARENT_RE = re.compile(r"Parent\s*:\s*#(\d+)")
DEP_RE = re.compile(r":dep\s+\S+")

# The reopen comment nb_coder_unfold.py posts on a leaf it unfolds again. It is that
# module's idempotency mark: a resume finds it and does not post a second one. The head
# lives here, with the reader, so the two cannot drift.
REOPEN_HEAD = "**Redépliée (c0021)**"
REOPEN_RE = re.compile(re.escape(REOPEN_HEAD) + r"(?s:.*)\blane (\S+?)\.?\s*$")

CLAIMED, RELEASED, DELIVERED = "CLAIMED", "RELEASED", "DELIVERED"


class LiveDataUnavailable(RuntimeError):
    """A live read (gh/git) failed: the line must be kept, never rejected on a guess."""


def default_gh(*args: str) -> object:
    """``gh api ...`` -> parsed JSON ({} when the call prints nothing). Injected in tests."""
    p = subprocess.run(["gh", "api", *args], capture_output=True, text=True, encoding="utf-8")
    if p.returncode:
        raise LiveDataUnavailable(f"gh api {args[:2]}: {p.stderr[-300:]}")
    return json.loads(p.stdout) if p.stdout.strip() else {}


def comment_bodies(issue: int, *, gh, repo: str = "jsboige/CoursIA", page_size: int = 100,
                   max_pages: int = 200) -> list[str]:
    """Every comment body of the issue, oldest first, every page read.

    A single-page read hid the recent markers of a long thread (measured: marathon leaf
    #27133 at 47 comments on 27/11 and gaining one per grain): past the 100th comment
    ``delivered_of`` answered False on a delivered leaf and trap 4 replayed it — no
    exception, a plausible verdict. Pages are walked until a short one; ``max_pages``
    bounds a runaway (200 pages = 20 000 comments)."""
    out: list[str] = []
    for page in range(1, max_pages + 1):
        raw = gh(f"repos/{repo}/issues/{issue}/comments?per_page={page_size}&page={page}")
        if not isinstance(raw, list):
            break
        out.extend(str(c.get("body") or "") for c in raw if isinstance(c, dict))
        if len(raw) < page_size:
            break
    return out


def parse_marks(bodies: list[str]) -> list[tuple[str, str]]:
    """Every claim marker in the thread, in order: (kind, lane)."""
    out = []
    for b in bodies:
        m = MARK_RE.match(b.strip())
        if m:
            out.append((m.group(1), m.group(2)))
    return out


def delivered_of(marks: list[tuple[str, str]]) -> bool:
    return any(kind == DELIVERED for kind, _ in marks)


def holder_of(marks: list[tuple[str, str]], lane: str) -> str | None:
    """The lane holding the issue: its last marker is another lane's CLAIMED/DELIVERED.
    A trailing RELEASED frees it; our own lane never blocks us."""
    last = marks[-1] if marks else None
    if last and last[0] != RELEASED and last[1] != lane:
        return last[1]
    return None


def reopened_by(bodies: list[str]) -> str | None:
    """The lane named by the last reopen comment on the leaf, or None when there is none.

    A leaf carrying this lane's reopen comment is that lane's own reopen (finished, or
    interrupted before its state change). An OPEN leaf without it was opened by someone
    else: the reopen posts its comment first for exactly that reason (review 28/11)."""
    lanes = [m.group(1) for b in bodies if (m := REOPEN_RE.match(b.strip()))]
    return lanes[-1] if lanes else None


def target_path(body: str) -> str | None:
    paths = RUST_PATH_RE.findall(body or "")
    return paths[0] if paths else None


def source_twin(target: str | None) -> str | None:
    return target.replace("-Rust.ipynb", "-Python.ipynb") if target else None


def csharp_twin(target: str | None) -> str | None:
    return target.replace("-Rust.ipynb", "-CSharp.ipynb") if target else None


def leaf_verdict(issue: int, *, gh, tree, lane: str, repo: str = "jsboige/CoursIA") -> dict:
    """The live picture of one leaf. ``tree`` is the set of paths on origin/main; a missing
    tree is fail-closed (unmeasured), never read as 'target absent'."""
    if tree is None:
        raise LiveDataUnavailable("origin/main tree not read")
    it = gh(f"repos/{repo}/issues/{issue}")
    if not isinstance(it, dict):
        raise LiveDataUnavailable(f"issue {issue}: unreadable answer")
    body = it.get("body") or ""
    bodies = comment_bodies(issue, gh=gh, repo=repo) if it.get("comments") else []
    marks = parse_marks(bodies)
    held = holder_of(marks, lane)
    target = target_path(body)
    src = source_twin(target)
    cs = csharp_twin(target)
    v = {
        "issue": issue,
        "title": str(it.get("title") or "")[:90],
        "state": it.get("state"),
        "delivered_marker": delivered_of(marks),
        "held_by": held,
        "last_marker": marks[-1] if marks else None,
        "reopened_by": reopened_by(bodies),
        "target": target,
        "rust_on_main": (target in tree) if target else None,
        "source_on_main": (src in tree) if src else None,
        "csharp_on_main": (cs in tree) if cs else None,
        "parent": (PARENT_RE.search(body) or [None, None])[1],
        "dep_lines": sorted(set(DEP_RE.findall(body)))[:8],
        "body_len": len(body),
    }
    v["feedable"] = bool(v["state"] == "open" and not v["delivered_marker"] and not held
                         and target and not v["rust_on_main"] and v["source_on_main"])
    return v


def reject_reason(v: dict, item: dict | None = None) -> str | None:
    """The DROP reason for a measured verdict, or None when the line may be fed.

    Closed set (trap 4): ``closed``, ``delivered``, ``held-by-another-lane``,
    ``no-target``, ``target-on-main`` (the ``target-already-exists`` the harness guard
    paid for once), ``source-absent``. A creation grain (``from_spec``) needs no source
    twin, so it skips ``source-absent``.
    """
    item = item or {}
    if v.get("state") != "open":
        return "closed"
    if v.get("delivered_marker"):
        return "delivered"
    if v.get("held_by"):
        return "held-by-another-lane"
    if not v.get("target"):
        return "no-target"
    if v.get("rust_on_main") is True:
        return "target-on-main"
    if not item.get("from_spec") and v.get("source_on_main") is False:
        return "source-absent"
    return None


def tree_on_main(checkout: str, *, fetch: bool = False, run=subprocess.run) -> set[str]:
    """Paths on origin/main of ``checkout`` (optionally fetching first, like the local)."""
    if fetch:
        run(["git", "-C", str(checkout), "fetch", "origin", "main"],
            capture_output=True, text=True, encoding="utf-8")
    p = run(["git", "-C", str(checkout), "ls-tree", "-r", "--name-only", "origin/main"],
            capture_output=True, text=True, encoding="utf-8")
    if getattr(p, "returncode", 0):
        raise LiveDataUnavailable(f"git ls-tree origin/main failed: {(p.stderr or '')[-300:]}")
    return set((p.stdout or "").splitlines())


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="validate one leaf on live data (read-only)")
    ap.add_argument("--issue", type=int, required=True)
    ap.add_argument("--repo", default="jsboige/CoursIA", help="GitHub slug")
    ap.add_argument("--checkout", required=True, help="local clone of the target repo")
    ap.add_argument("--lane", required=True, help="this lane's claim identity")
    ap.add_argument("--no-fetch", action="store_true", help="do not fetch origin/main first")
    ap.add_argument("--from-spec", action="store_true", help="creation grain without a twin")
    a = ap.parse_args(argv)
    try:
        tree = tree_on_main(a.checkout, fetch=not a.no_fetch)
        v = leaf_verdict(a.issue, gh=default_gh, tree=tree, lane=a.lane, repo=a.repo)
    except LiveDataUnavailable as exc:
        print(f"live data unavailable: {exc}", file=sys.stderr)
        return 2
    reason = reject_reason(v, {"from_spec": a.from_spec})
    v["reject_reason"] = reason
    print(json.dumps(v, ensure_ascii=False))
    return 0 if reason is None else 1


if __name__ == "__main__":
    sys.exit(main())
