#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77
# original path: myia_vllm/scripts/adoption/nb_coder/nb_coder_drift.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Source-twin drift: did the notebook a port was made FROM change on origin/main?

Measured 22/11 (CoursIA main red for every open PR): PR #27805 ported
Sudoku-07-Norvig-Python (36 cells) at 14:05Z; #27348 added a measured benchmark
block to that Python twin (39 cells) at 22:44Z, while #27805 was open; #27805 was
squash-merged at 01:14Z on checks that predated the change. The port then lacked
a block of its source, the conformance spec (generated cell-index-aligned) compared
a benchmark against « Singletons caches », and the twin attestation recorded a
Python blob that the squash never wrote. Nothing in the harness looked at the
source twin again after the build.

This module answers one question deterministically, without a model turn:
between the revision a port was built on and origin/main, how did the source
twin change?

- ``none``          : same blob.
- ``markdown-only`` : same cell-type sequence, identical code cells (source AND
                      outputs). The port is still a faithful twin; only the
                      integration (nav link, README row, reseal) must be replayed
                      on the fresh twin -- ``nb_coder_integrate --sync-main``.
- ``structure``     : cells added, removed or re-typed. The cell-index-aligned
                      conformance spec and the parity seal no longer hold: the
                      port must be refreshed from the new source.
- ``code``          : same structure, a code cell's source or outputs changed:
                      the port may now compute something else.
- ``deleted``       : the source is gone from origin/main.
- ``unmeasured``    : nothing to compare (the source is not at the base, or
                      origin/main is unreadable) -- never a refusal.

CLI (sweep of the open PRs of a lane's branches, REST only, one list call plus one
comments call per drifted PR):

    python nb_coder_drift.py --repo D:/CoursIA [--slug jsboige/CoursIA]
        [--branch-prefix nbcoder/] [--comment] [--json]

Exit 0 = no drift needing a refresh, 1 = at least one PR with structure/code/
deleted drift, 2 = instrument failure (list unreadable).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REFRESH_NEEDED = ("structure", "code", "deleted")
MARKER = "<!-- nb-coder:source-drift main={blob} -->"


def _git(repo: Path, *args: str, timeout: int = 300) -> tuple[int, str]:
    p = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    return p.returncode, (p.stdout if p.returncode == 0 else p.stderr).strip()


def _text(value) -> str:
    return "".join(value) if isinstance(value, list) else str(value or "")


def _outputs_text(cell: dict) -> str:
    """Stream text + text/plain, the same reading as the conformance checker."""
    chunks = []
    for o in cell.get("outputs") or []:
        if "text" in o:
            chunks.append(_text(o["text"]))
        data = o.get("data") or {}
        if "text/plain" in data:
            chunks.append(_text(data["text/plain"]))
    return "".join(chunks)


def signature(nb: dict) -> dict:
    cells = nb.get("cells") or []
    return {"types": [c.get("cell_type") for c in cells],
            "code": [(_text(c.get("source")), _outputs_text(c))
                     for c in cells if c.get("cell_type") == "code"]}


def classify_drift(old: dict | None, new: dict | None) -> str:
    if new is None:
        return "deleted"
    if old is None or old == new:
        return "none"
    a, b = signature(old), signature(new)
    if a["types"] != b["types"]:
        return "structure"
    if a["code"] != b["code"]:
        return "code"
    return "markdown-only"


def blob_at(repo: Path, rev: str, path: str) -> str | None:
    rc, out = _git(repo, "rev-parse", f"{rev}:{path}")
    return out if rc == 0 and out else None


def notebook_at(repo: Path, rev: str, path: str) -> dict | None:
    rc, out = _git(repo, "show", f"{rev}:{path}")
    if rc != 0:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return None


def source_drift(repo: Path, base_rev: str, src_rel: str, main_rev: str = "origin/main") -> dict:
    """How the source twin `src_rel` moved between `base_rev` and `main_rev`."""
    src_rel = src_rel.replace("\\", "/")
    a, b = blob_at(repo, base_rev, src_rel), blob_at(repo, main_rev, src_rel)
    rec = {"source": src_rel, "base_blob": (a or "")[:12], "main_blob": (b or "")[:12]}
    if a is None or _git(repo, "rev-parse", "--verify", "-q", main_rev)[0] != 0:
        # Nothing to compare (the source is not at the base, or main is unreadable):
        # an instrument gap, never a refusal.
        return rec | {"drift": "unmeasured"}
    if a == b:
        return rec | {"drift": "none"}
    if b is None:
        return rec | {"drift": "deleted"}
    rec["drift"] = classify_drift(notebook_at(repo, base_rev, src_rel),
                                  notebook_at(repo, main_rev, src_rel))
    rc, log = _git(repo, "log", "--format=%h %cI %s", f"{base_rev}..{main_rev}", "--", src_rel)
    rec["commits"] = log.splitlines()[:5] if rc == 0 else []
    return rec


def modified_notebooks(repo: Path, base: str, head: str) -> list[str]:
    """Notebooks a PR MODIFIES (status M): for a port, the source twin whose
    markdown carries the new nav link. The created port itself is status A."""
    rc, out = _git(repo, "diff", "--name-status", "--diff-filter=M", f"{base}..{head}")
    if rc != 0:
        return []
    return [ln.split("\t", 1)[1] for ln in out.splitlines()
            if "\t" in ln and ln.endswith(".ipynb")]


def already_flagged(comment_bodies: list[str], main_blob: str) -> bool:
    return MARKER.format(blob=main_blob) in "\n".join(comment_bodies)


def drift_comment(rows: list[dict]) -> str:
    worst = rows[0]
    lines = [f"[SOURCE-DRIFT] Le jumeau source de cette PR a changé sur `main` depuis "
             f"sa base — **à rafraîchir avant fusion**.", ""]
    for r in rows:
        lines.append(f"- `{r['source']}` : **{r['drift']}** (blob {r['base_blob']} → "
                     f"{r['main_blob']})")
        lines += [f"  - {c}" for c in r.get("commits", [])]
    lines += ["", "Lecture : `structure` = cellules ajoutées/retirées (la spec de conformité "
              "alignée par index et le sceau de parité ne tiennent plus), `code` = une cellule "
              "de code ou sa sortie a changé. Dans les deux cas le portage doit être repris sur "
              "la nouvelle source ; une fusion en l'état rougit `Scripts Tests` pour toutes "
              "les PR (précédent : #27805 → #27914).",
              "", "Détecté par `nb_coder_drift.py` (déterministe, sans tour de modèle).",
              MARKER.format(blob=worst["main_blob"])]
    return "\n".join(lines)


def _gh_json(args: list[str]):
    p = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=120)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout)[:300])
    return json.loads(p.stdout or "null")


def delivered_by(pr_body: str | None, lane: str) -> bool:
    """The harness PR body names its lane (`**Grain** : lane `<lane>``): another
    lane running the same harness gets a report, never a comment from us."""
    return f"lane `{lane}`" in (pr_body or "")


def sweep(repo: Path, slug: str, prefix: str, comment: bool,
          lane: str = "myia-ai-01:vllm") -> tuple[int, list[dict]]:
    prs = _gh_json(["api", f"repos/{slug}/pulls?state=open&per_page=100"])
    mine = [p for p in prs if p["head"]["ref"].startswith(prefix)
            and (p["head"].get("repo") or {}).get("full_name") == slug]
    if mine:  # one fetch for every head: a fetch per PR cost >120 s on CoursIA
        _git(repo, "fetch", "-q", "origin", "main",
             *[f"+refs/pull/{p['number']}/head:refs/nbdrift/pr{p['number']}" for p in mine],
             timeout=900)
    report, rc = [], 0
    for p in mine:
        n, head = p["number"], f"refs/nbdrift/pr{p['number']}"
        rc_b, base = _git(repo, "merge-base", head, "origin/main")
        if rc_b != 0:
            report.append({"pr": n, "error": "merge-base unreadable"})
            continue
        rows = [source_drift(repo, base, s) for s in modified_notebooks(repo, base, head)]
        rows = [r for r in rows if r["drift"] != "none"]
        rows.sort(key=lambda r: REFRESH_NEEDED.index(r["drift"])
                  if r["drift"] in REFRESH_NEEDED else len(REFRESH_NEEDED))
        ours = delivered_by(p.get("body"), lane)
        entry = {"pr": n, "branch": p["head"]["ref"], "drift": rows, "ours": ours}
        if any(r["drift"] in REFRESH_NEEDED for r in rows):
            rc = 1
            if comment and not ours:
                entry["comment"] = "not-ours"
            elif comment:
                bodies = [c.get("body") or "" for c in _gh_json(
                    ["api", f"repos/{slug}/issues/{n}/comments?per_page=100"])]
                if already_flagged(bodies, rows[0]["main_blob"]):
                    entry["comment"] = "already-flagged"
                else:
                    _gh_json(["api", f"repos/{slug}/issues/{n}/comments",
                              "-f", f"body={drift_comment(rows)}"])
                    entry["comment"] = "posted"
        report.append(entry)
    return rc, report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", required=True, help="local clone of the target repo")
    ap.add_argument("--slug", default="jsboige/CoursIA")
    ap.add_argument("--branch-prefix", default="nbcoder/")
    ap.add_argument("--comment", action="store_true",
                    help="post one [SOURCE-DRIFT] comment per drifted PR of --lane (idempotent)")
    ap.add_argument("--lane", default="myia-ai-01:vllm",
                    help="only PRs whose body names this lane are commented")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    try:
        rc, report = sweep(Path(args.repo), args.slug, args.branch_prefix, args.comment,
                           args.lane)
    except RuntimeError as e:
        print(f"instrument failure: {e}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    else:
        for e in report:
            rows = e.get("drift") or []
            state = ", ".join(f"{r['source'].rsplit('/', 1)[-1]}={r['drift']}" for r in rows)
            print(f"#{e['pr']} {state or e.get('error') or 'no drift'}"
                  + (f" [{e['comment']}]" if e.get("comment") else ""))
    return rc


if __name__ == "__main__":
    sys.exit(main())
