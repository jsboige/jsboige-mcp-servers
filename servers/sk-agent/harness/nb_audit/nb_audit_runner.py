#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ f42c52d8fb5f5d64bbae34df7f83d56f7aa284b8
# original path: myia_vllm/scripts/adoption/nb_audit/nb_audit_runner.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Scheduled pre-audit runner for the CoursIA #17073 campaign (mode (b), agreed 2026-09-23).

One run = one bounded batch, then exit; a user-level scheduled task calls it hourly.

  1. refresh the read-only CoursIA clone (fast-forward only);
  2. read the checklists of the configured series issues (gh, read-only) and keep the
     unchecked notebooks, in checklist order;
  3. skip every notebook whose current sha256 already has a record in the landing dir,
     so a record is only redone after a corrective push changed the file; stop once
     --lookahead fresh records sit ahead of the bot, so production follows reading;
  4. run nb_audit_driver.py on at most --per-series notebooks per series;
  5. scan each record for secrets, then publish it to <landing>/<series>/ with a
     per-series index.json (notebook, owner bot, fingerprint, verdict, counts).

Nothing is posted anywhere from here: nb_audit_deliver.py sends the new records to each
bot on the channel it reads, and the bot's FULL READ decides.
A lock file prevents overlapping runs; a run killed mid-batch resumes at the next one.

    python nb_audit_runner.py --series 17107 17239 --per-series 4 --dry-run
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DRIVER = HERE / "nb_audit_driver.py"


def _sk_dir() -> Path:
    """Where the sk-agent checkout lives (roo-extensions #4781: no seat binding in the tree).
    Order: NB_AUDIT_SK_DIR env, then the sibling layout the harness has once it lives at
    servers/sk-agent/harness/nb_audit/ (its sk-agent root is ../.., recognised by sk_agent.py
    so an unrelated ../.. cannot shadow it), then the legacy absolute path kept for the live
    vllm task until the cutover. Its venv carries the `mcp` package the driver imports, so the
    runner launches the driver with it."""
    env = os.environ.get("NB_AUDIT_SK_DIR")
    if env:
        return Path(env)
    sibling = (HERE / "../..").resolve()
    if (sibling / "sk_agent.py").is_file():
        return sibling
    return Path("d:/roo-extensions/mcps/internal/servers/sk-agent")


SK_PY = Path(os.environ.get("NB_AUDIT_SK_PY", str(_sk_dir() / "venv/Scripts/python.exe")))
GH_REPO = "jsboige/CoursIA"
NB_ROOT = "MyIA.AI.Notebooks/"

# a record holds notebook text, model answers and script outputs; none of these should ever
# carry a credential, but the landing dir is shared, so the check is mechanical, not trusted
SECRET_PATTERNS = [
    r"\bsk-[A-Za-z0-9_-]{20,}", r"\bhf_[A-Za-z0-9]{30,}", r"\bghp_[A-Za-z0-9]{30,}",
    r"\bgithub_pat_[A-Za-z0-9_]{40,}", r"\bAKIA[0-9A-Z]{16}\b", r"\bxox[abp]-[A-Za-z0-9-]{20,}",
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
]


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%SZ')}] {msg}", flush=True)


def slug(rel: str) -> str:  # same rule as the driver, which names its records with it
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", rel)[-120:]


def git(repo: Path, *a: str) -> str:
    p = subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if p.returncode:
        raise RuntimeError(f"git {' '.join(a)}: {p.stderr.strip()[:300]}")
    return p.stdout


def gh_api(*path: str) -> str:
    """A REST call. Deliberately `gh api` and never `gh issue view` -- see series_checklist."""
    p = subprocess.run(["gh", "api", *path], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if p.returncode:
        raise RuntimeError(f"gh api {' '.join(path)}: {p.stderr.strip()[:300]}")
    return p.stdout


def open_pr_notebooks(limit: int = 50) -> tuple[dict[str, list[int]], int]:
    """Notebooks touched by recently-updated open PRs: {repo-relative path: [PR numbers]}.

    A pre-audit of a file an open PR is about to change is work thrown away: the merge
    changes the sha and the sha-keyed record goes stale (never wrong -- just wasted).
    The bots apply the same rule when they read. Wave 1 was ordered 08/10 against a
    static 5-name list derived from PR #19868; that list was stale within hours (the PR
    closed superseded, the fix landed via #19854 instead) -- derive per pass, never
    hardcode. Only the `limit` most-recently-updated open PRs are scanned (a PR quiet
    for weeks is not about to collide, and a later merge is absorbed by the sha check);
    the caller logs the cap so the cut is never silent.
    """
    prs = json.loads(gh_api(
        f"repos/{GH_REPO}/pulls?state=open&sort=updated&direction=desc&per_page={limit}"))
    touched: dict[str, list[int]] = {}
    for pr in prs:
        files = json.loads(gh_api(f"repos/{GH_REPO}/pulls/{pr['number']}/files?per_page=100"))
        if len(files) == 100:
            log(f"  PR #{pr['number']}: 100+ files, collision scan truncated at 100")
        for f in files:
            fn = f.get("filename") or ""
            if fn.startswith(NB_ROOT) and fn.endswith(".ipynb"):
                touched.setdefault(fn, []).append(pr["number"])
    return touched, len(prs)


def refresh_clone(repo: Path) -> str:
    """Refuse to audit on a clone carrying real local work.

    Line-ending-only differences are NOT real work. This repo ships `*.py text eol=lf`
    in .gitattributes, yet some blobs were committed carrying CRLF, so a handful of files
    read as permanently modified whatever the worktree does (HEAD blob and index both
    hold the CRs; the clone cannot be cleaned without committing upstream, which we must
    not do). Treating that as dirt took the hourly runner down for 37 h -- 07/10 00:05Z to
    08/10 13:05Z, rc=1 on every pass, and silently, because the deliverer still exits 0
    with nothing to send. Compare content, not bytes.
    """
    dirty = git(repo, "status", "--porcelain").strip()
    if dirty:
        untracked = [l[3:] for l in dirty.splitlines() if l.startswith("??")]
        # Read the TEXTUAL diff, never `--name-only`: name-only reports a file whenever its
        # blob differs, even when git's own text diff (with the CR ignored) is empty -- which
        # is exactly our case, since the repo's blobs carry CRLF against a `text eol=lf`
        # attribute. Verified on the live clone: identical content, `diff` of both files
        # stripped of CR is empty, yet `--name-only` lists both.
        tracked = git(repo, "diff", "--ignore-cr-at-eol").strip()
        tracked += git(repo, "diff", "--cached", "--ignore-cr-at-eol").strip()
        if tracked or untracked:
            raise RuntimeError(
                f"{repo} has local changes; the audit clone must stay pristine "
                f"(untracked={untracked[:5]})\n{tracked[:600]}")
        log(f"{repo}: ignoring {len(dirty.splitlines())} line-ending-only modification(s)")

    # A fast-forward can still be refused while that dirt is present: git's merge safety
    # check does not honour the CR ignore, only the textual diff does (measured: the guard
    # passes, then `git pull --ff-only` dies with "local changes would be overwritten").
    # A refused refresh must not take the workload down a second time -- log it and audit
    # whatever commit we already have.
    head = git(repo, "rev-parse", "HEAD").strip()
    try:
        git(repo, "pull", "--ff-only", "--quiet")
        head = git(repo, "rev-parse", "HEAD").strip()
    except RuntimeError as exc:
        log(f"{repo}: fast-forward refused ({str(exc)[:180]}); auditing at {head[:8]} "
            f"-- the clone is NOT refreshed on this pass")
    return head


AUDIT_TS = re.compile(r"audit\s+(\d\d)/(\d\d)\s+(\d\d):(\d\d)Z", re.I)


def series_checklist(number: int) -> tuple[str, str, list[str], int]:
    """Notebooks the owner bot has not audited yet, in the order it is expected to read them.

    Done = a checked box, or a comment on the series issue whose first line announces the
    audit of that notebook (Hermes records its audits as comments and leaves the boxes).
    Order = checklist order, restarted just after the most recent timestamped audit line,
    since a bot that skips a notebook (open PR) moves on and does not come back soon.
    """
    # REST, never `gh issue view`. GraphQL's budget is spent per USER, so every lane on every machine
    # shares one 5,000/h bucket and exhausts it -- measured 08/10: every GraphQL call, down to
    # `{viewer{login}}`, was refused with "API rate limit already exceeded", while REST still had
    # 5,000/5,000 free. `gh api rate_limit` reported .resources.graphql = 4967/5000 at that same
    # moment, so that field cannot be used to detect it. Two REST calls cost nothing here.
    issue = json.loads(gh_api(f"repos/{GH_REPO}/issues/{number}"))
    raw = gh_api(f"repos/{GH_REPO}/issues/{number}/comments", "--paginate", "--jq", ".[]")
    d = {"title": issue.get("title") or "", "body": issue.get("body") or "",
         "comments": [json.loads(l) for l in raw.splitlines() if l.strip()]}
    m = re.search(r"partition\s+(\w+)", d["title"], re.I)
    owner = m.group(1) if m else "?"
    audited = set()
    for c in d.get("comments") or []:
        first = (c.get("body") or "").strip().splitlines()[:1]
        if first and "audit" in first[0].lower():
            audited.update(n.rsplit("/", 1)[-1] for n in re.findall(r"[\w./-]+\.ipynb", first[0]))
    # series issues write items with or without backticks
    items = re.findall(r"^\s*- \[([ xX])\]\s+`?([^`\s]+\.ipynb)`?(.*)$", d["body"], re.M)
    stamps = [(i, (int(t[1]), int(t[0]), int(t[2]), int(t[3])))  # (month, day, hour, minute)
              for i, (_, _, rest) in enumerate(items) for t in AUDIT_TS.findall(rest)]
    cursor = max(stamps, key=lambda s: s[1])[0] + 1 if stamps else 0
    order = items[cursor:] + items[:cursor]
    todo = [name for box, name, _ in order if box == " " and name.rsplit("/", 1)[-1] not in audited]
    return d["title"], owner, todo, len(audited)


def resolve(item: str, catalogue: list[str]) -> str | None:
    """Checklist items are a basename or a path relative to the series; match on suffix."""
    item = item.strip().lstrip("./")
    hits = [p for p in catalogue if p == item or p.endswith("/" + item)]
    return hits[0] if len(hits) == 1 else None


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_index(d: Path) -> dict:
    f = d / "index.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.is_file() else {"records": {}}


def secret_hits(text: str) -> list[str]:
    return [pat for pat in SECRET_PATTERNS if re.search(pat, text)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--series", type=int, nargs="+", required=True, help="#17073 series issue numbers")
    ap.add_argument("--per-series", type=int, default=3, help="max notebooks per series and run")
    ap.add_argument("--subpath", action="append", default=[], metavar="ISSUE:PREFIX[,PREFIX...]",
                    help="per series, keep only items resolving under one of these path prefixes "
                         "-- wave scoping inside a wide series (e.g. 19451:Audio/ for GenAI/Audio)")
    ap.add_argument("--lookahead", type=int, default=6,
                    help="fresh records kept ahead of the bot per series (a bot reads ~1 notebook/h)")
    ap.add_argument("--concurrency", type=int, default=6,
                    help="6 needs sk-agent's 600 s turn for notebook-auditor (roo-extensions #3797, in service)")
    ap.add_argument("--repo", default="d:/dev/CoursIA-skaudit")
    # local on purpose: neither bot can read the GDrive share, and DriveFS is the slow link on ai-01
    ap.add_argument("--landing", default=str(Path(os.environ.get("LOCALAPPDATA", "/tmp")) / "nbaudit" / "landing"))
    ap.add_argument("--work-dir", default=str(Path(os.environ.get("TEMP", "/tmp")) / "nbaudit-runner"))
    ap.add_argument("--dry-run", action="store_true", help="select and print; no model call, no write")
    args = ap.parse_args()

    landing, work = Path(args.landing), Path(args.work_dir)
    work.mkdir(parents=True, exist_ok=True)
    lock = work / "runner.lock"
    if lock.exists() and time.time() - lock.stat().st_mtime < 3 * 3600:
        log(f"another run holds {lock} (age {int(time.time() - lock.stat().st_mtime)} s); exit")
        return 0
    lock.write_text(str(os.getpid()), encoding="utf-8")
    try:
        repo = Path(args.repo)
        head = refresh_clone(repo) if not args.dry_run else git(repo, "rev-parse", "HEAD").strip()
        catalogue = [p for p in git(repo, "ls-files", "*.ipynb").splitlines() if p.startswith(NB_ROOT)]
        log(f"clone {repo} @ {head[:10]}, {len(catalogue)} notebooks")

        plan: list[tuple[int, str, str, str, str]] = []  # (issue, series slug, owner, rel, sha)
        # A series whose checklist cannot be read (GitHub unreadable -- the 5,000/h GraphQL quota is
        # shared fleet-wide and fails transiently, measured 08/10 14:05Z) is skipped rather than
        # aborting the whole pass: the other series are still worth reading. But the pass is then NOT
        # clean and must not report success, hence `errors` in the returns below.
        errors = 0
        # per-series wave scoping: keep only items resolving under one of the prefixes
        sub = {int(k): [p.strip() for p in v.split(",") if p.strip()]
               for k, v in (s.split(":", 1) for s in args.subpath)}
        # notebooks an open PR is about to change: auditing them now is thrown-away work.
        # A failed scan fails OPEN (no skipping): a stale record is harmless, a stalled
        # workload is not -- same isolation philosophy as the per-series guard below.
        try:
            pr_notebooks, n_prs = open_pr_notebooks()
            log(f"open-PR collision scan: {len(pr_notebooks)} notebook(s) touched by the "
                f"{n_prs} most-recently-updated open PRs")
        except RuntimeError as exc:
            pr_notebooks, n_prs = {}, 0
            log(f"open-PR collision scan unreadable ({str(exc)[:160]}) -- NOT skipping on "
                f"collisions this pass")
        for n in args.series:
            try:
                title, owner, unchecked, n_commented = series_checklist(n)
            except RuntimeError as exc:
                log(f"#{n}: checklist unreadable ({str(exc)[:160]}) -- series skipped this pass")
                errors += 1
                continue
            sdir = f"{n}-" + slug(re.sub(r"^\[Audit #17073\]\s*Série\s*|\s*—\s*partition.*$", "", title))[:60]
            index = load_index(landing / sdir)["records"]
            picked, ahead, unresolved, waved, pr_skip = 0, 0, [], 0, []
            for item in unchecked:
                if ahead + picked >= args.lookahead or picked >= args.per_series:
                    break
                rel = resolve(item, catalogue)
                if rel is None:
                    unresolved.append(item)
                    continue
                prefixes = sub.get(n)
                if prefixes and not any(f"/{p}" in rel for p in prefixes):
                    waved += 1  # inside the series, outside the armed wave
                    continue
                if pr_notebooks.get(rel):
                    pr_skip.append((rel, pr_notebooks[rel]))
                    continue
                digest = sha256(repo / rel)
                if index.get(rel, {}).get("sha256") == digest:
                    ahead += 1  # fresh record already published for this exact file
                    continue
                plan.append((n, sdir, owner, rel, digest))
                picked += 1
            log(f"#{n} {owner}: {len(unchecked)} to audit ({n_commented} audited in comments), "
                f"{ahead} fresh ahead, {picked} picked"
                + (f", {waved} outside subpath" if waved else "")
                + (f", {len(unresolved)} unresolved {unresolved[:3]}" if unresolved else "")
                + (f", {len(pr_skip)} open-PR skip "
                   f"{[(r.rsplit('/', 1)[-1], p) for r, p in pr_skip[:3]]}" if pr_skip else ""))
        if not plan:
            log("nothing to do" if not errors
                else f"nothing to do, but {errors} series were unreadable")
            return 1 if errors else 0
        for n, sdir, owner, rel, digest in plan:
            log(f"  plan #{n} {owner} {rel} sha256:{digest[:12]}")
        if args.dry_run:
            log(f"DRY-RUN: {len(plan)} notebooks would be audited; nothing written")
            return 0

        # the driver resumes on parsed records: a per-run out dir forces a fresh audit
        run_dir = work / datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ")
        cmd = [str(SK_PY), str(DRIVER), "--repo", str(repo), "--out-dir", str(run_dir),
               "--concurrency", str(args.concurrency), *[p[3] for p in plan]]
        t0 = time.time()
        rc = subprocess.run(cmd, cwd=str(HERE)).returncode
        log(f"driver rc={rc} in {time.time() - t0:.0f} s")

        published = 0
        for n, sdir, owner, rel, digest in plan:
            src = run_dir / f"{slug(rel)}.json"
            if not src.is_file():
                log(f"  no record for {rel}")
                continue
            text = src.read_text(encoding="utf-8")
            hits = secret_hits(text)
            if hits:
                log(f"  WITHHELD {rel}: secret-like pattern {hits}")
                continue
            rec = json.loads(text)
            if not rec.get("parsed") or (rec.get("fingerprint") or {}).get("sha256") != digest:
                log(f"  not published {rel}: parsed={rec.get('parsed')} error={rec.get('error')}")
                continue
            dest = landing / sdir
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest / src.name)
            idx = load_index(dest)
            nf = rec.get("findings") or []
            idx["records"][rel] = {
                "file": src.name, "owner": owner, "issue": n, "audited_at": rec.get("started"),
                **(rec.get("fingerprint") or {}), "verdict": rec.get("verdict"),
                "findings_valid": sum(bool(f.get("valid")) for f in nf), "findings_total": len(nf),
                "verifs_clean": sum(v.get("rc") == 0 for v in rec.get("verifs") or []),
                "verifs_total": len(rec.get("verifs") or []),
            }
            idx["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            (dest / "index.json").write_text(json.dumps(idx, ensure_ascii=False, indent=1), encoding="utf-8")
            published += 1
        log(f"published {published}/{len(plan)} records under {landing}")
        return 0 if (published or rc == 0) and not errors else 1
    finally:
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
