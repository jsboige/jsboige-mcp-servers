#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/nb_coder_drift.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
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
- ``markdown-added``: cells were only ADDED and every added cell is markdown --
                      nothing removed, nothing changed (measured 23/11,
                      CoursIA#28209: one « ancres Lectures » cell inserted at index
                      43 of a 44-cell twin, read ``structure`` while the port was
                      approved on the 44). The port keeps every cell the verifier
                      judged; the added cells are grafted verbatim at the index they
                      hold in the new source (``graft_markdown``) and the
                      integration is replayed on the fresh twin.
- ``structure``     : any other change of the cell list: cells removed, re-typed
                      or added that are not markdown. The cell-index-aligned
                      conformance spec and the parity seal no longer hold: the port
                      must be refreshed from the new source.
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
deleted/markdown-added drift (an OPEN PR holds none of the added cells: the graft
is a stage-5 gesture, it never edits a pushed branch), 2 = instrument failure
(list unreadable).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REFRESH_NEEDED = ("structure", "code", "deleted", "markdown-added")
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


def _cell_key(cell: dict) -> tuple:
    """What makes a cell 'the same cell' across two revisions of a notebook."""
    return (cell.get("cell_type"), _text(cell.get("source")), _outputs_text(cell))


def markdown_insertions(old: dict | None, new: dict | None) -> list[int] | None:
    """Indices, in ``new``, of the cells a source only GAINED between two revisions.

    Admitted only when every cell of ``old`` is found unchanged, in order, in
    ``new`` and every cell of ``new`` that is not one of them is markdown: nothing
    removed, nothing changed, no code cell added. None otherwise -- a removed or
    re-typed cell, or an added code cell, is still ``structure``.
    """
    if not old or not new:
        return None
    ko = [_cell_key(c) for c in old.get("cells") or []]
    kn = [_cell_key(c) for c in new.get("cells") or []]
    i = j = 0
    inserted: list[int] = []
    while i < len(kn):
        if j < len(ko) and kn[i] == ko[j]:
            i, j = i + 1, j + 1
        elif (new["cells"][i].get("cell_type") == "markdown"):
            inserted.append(i)
            i += 1
        else:
            return None
    return inserted if j == len(ko) and inserted else None


def graft_markdown(port: dict, old: dict, new: dict) -> dict:
    """Copy into a PORT built on ``old`` the markdown cells the source gained in ``new``.

    Admitted only when the port is cell-aligned with the source it was built on --
    same count, same cell types in the same order: the added cells then land at the
    index they hold in the new source and every cell the verifier judged keeps its
    content. A port that already holds them (a resume) grafts nothing twice.

    Returns ``{"inserted": [{"index", "preview"}], "count", "already", "cells"}``
    (``cells`` = the port's cells to write back) or ``{"error": why}``.
    """
    idx = markdown_insertions(old, new)
    if idx is None:
        return {"error": "the source did not only gain markdown cells"}
    pcells = list(port.get("cells") or [])
    types_p = [c.get("cell_type") for c in pcells]
    types_o = [c.get("cell_type") for c in old.get("cells") or []]
    types_n = [c.get("cell_type") for c in new.get("cells") or []]
    if types_p == types_n:
        held = all(_cell_key(pcells[i]) == _cell_key(new["cells"][i]) for i in idx)
        return ({"inserted": [], "count": 0, "already": True, "cells": pcells} if held
                else {"error": "the port has the new source's shape but not its added cells"})
    if types_p != types_o:
        return {"error": (f"the port is not cell-aligned with the source it was built on "
                          f"({len(types_p)} cells, the source had {len(types_o)})")}
    # A port whose ids are the cell index (cell-000, cell-001...) keeps that invariant.
    sequential = all(c.get("id") == f"cell-{k:03d}" for k, c in enumerate(pcells))
    ids = {c.get("id") for c in pcells if c.get("id")}
    done, cells = [], [dict(c) for c in pcells]     # the caller's notebook is never mutated
    for i in idx:
        cell = json.loads(json.dumps(new["cells"][i]))    # never the source object itself
        cid = cell.get("id")
        if cid and not sequential and cid in ids:
            k = 2
            while f"{cid[:60]}-{k}" in ids:
                k += 1
            cell["id"] = f"{cid[:60]}-{k}"
        ids.add(cell.get("id"))
        cells.insert(i, cell)
        done.append({"index": i, "preview": _text(cell.get("source")).strip()[:160]})
    if sequential:
        for k, c in enumerate(cells):
            c["id"] = f"cell-{k:03d}"
    return {"inserted": done, "count": len(done), "already": False, "cells": cells}


def classify_drift(old: dict | None, new: dict | None) -> str:
    if new is None:
        return "deleted"
    if old is None or old == new:
        return "none"
    a, b = signature(old), signature(new)
    if a["types"] != b["types"]:
        return "markdown-added" if markdown_insertions(old, new) is not None else "structure"
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


def blob_notebook(repo: Path, blob: str) -> dict | None:
    """The notebook a blob holds (as `source_drift` reports it: a SHA prefix)."""
    rc, out = _git(repo, "cat-file", "-p", blob)
    if rc != 0:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return None


def source_drift(repo: Path, base_rev: str, src_rel: str, main_rev: str = "origin/main",
                 old_blob: str | None = None) -> dict:
    """How the source twin `src_rel` moved between `base_rev` and `main_rev`.

    ``old_blob``: the twin's blob on main as a PREVIOUS delivery attempt measured it
    (its trace's ``main_blob``). A resume whose build was already grafted is aligned
    with THAT source, not with the build's base: it measures from there, and a cell the
    source gained since is grafted onto the grafted build. A blob this clone cannot
    read falls back to the build's base."""
    src_rel = src_rel.replace("\\", "/")
    a, b = blob_at(repo, base_rev, src_rel), blob_at(repo, main_rev, src_rel)
    rec = {"source": src_rel, "base_blob": (a or "")[:12], "main_blob": (b or "")[:12]}
    old_nb = blob_notebook(repo, old_blob) if old_blob else None
    if old_nb is not None:
        a = old_blob
        rec["base_blob"] = old_blob[:12]
        rec["measured_from"] = "previous-attempt-main-blob"
    if a is None or _git(repo, "rev-parse", "--verify", "-q", main_rev)[0] != 0:
        # Nothing to compare (the source is not at the base, or main is unreadable):
        # an instrument gap, never a refusal.
        return rec | {"drift": "unmeasured"}
    if a[:12] == (b or "")[:12]:
        return rec | {"drift": "none"}
    if b is None:
        return rec | {"drift": "deleted"}
    old_nb = old_nb if old_nb is not None else notebook_at(repo, base_rev, src_rel)
    new_nb = notebook_at(repo, main_rev, src_rel)
    rec["drift"] = classify_drift(old_nb, new_nb)
    if rec["drift"] == "markdown-added":
        rec["inserted"] = markdown_insertions(old_nb, new_nb)
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
              "les PR (précédent : #27805 → #27914). `markdown-added` = le jumeau a seulement "
              "gagné des cellules markdown (code inchangé) : à recopier dans le portage aux "
              "mêmes indices — `nb_coder` le fait à la livraison (`graft_markdown`), jamais "
              "sur une branche déjà poussée.",
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
