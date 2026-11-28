#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/nb_coder_driver.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""nb-coder driver — stages 0-5 of the issue -> notebook -> PR harness (jsboige/vllm#431).

Stage 0 CLAIM : check_lane_claim.py on the CoursIA checkout (read), optional [CLAIMED] comment.
Stage ½ SPEC  : OPTIONAL (--spec-mode run, roo-extensions #4831): --spec-model pre-chews a rough
                issue into a hyper-detailed one that becomes stage 1's issue body. The default
                skip is DECLARED by the caller and traced on the run record (never a heuristic).
                Not to be confused with --from-spec (a NEW notebook built from the issue's
                « Plan des cellules » table): both may combine, the spec turn runs first.
Stage 1 PLAN  : sk-agent model turn -> cell plan JSON (kernel, edits, expected outputs).
Stage 2 BUILD : the HARNESS copies the source notebook (outputs preserved) and the model
                edits ONLY the planned cells on that copy (update_cell/add_cell/remove_cell);
                the harness then proves the result is a minimal edit (structure diff) and runs
                every planned cell with execute_on_kernel, deciding success alone.
Stage 3 GATES : harness-only checks on the built notebook — coordination refs added outside
                the exact provenance-footer form, secrets, language_info drift vs source.
Stage 4 VERIFY: independent verifier (nb_coder_verify.py, SEPARATE process and agent —
                producer != verifier; its exit 2 is an instrument error, never a reject).
Stage 5 PR    : harness-only GitHub gestures — fresh branch, integration commit (notebook +
                README row + inbound nav link + C# pair registration, nb_coder_integrate),
                twin-parity reseal LAST, REST PR create, delivery comment. The MODEL never
                writes to git or GitHub.

Model per step (#4831): --coder-model serves every in-process turn (plan, build, segments,
repairs, revisions), --verifier-model the stage-4 audit, --spec-model the spec pre-chew. Unset
= the --agent / --verifier-agent preset's own model (seat default). The difficulty->model
mapping is documented in the README — never hardcoded; the calling lane picks per pass/grain.

Dry below --max-stage 5: no branch, no commit, no push, no PR.

Run with the sk-agent venv python (it carries the ``mcp`` client package):
    d:/roo-extensions/mcps/internal/servers/sk-agent/venv/Scripts/python.exe \
        nb_coder_driver.py --issue 20250 --notebook IIT/ICT-Series/ICT-40b-...ipynb \
        --out-dir d:/vllm/.tmp/nbcoder --worktree d:/vllm/.tmp/nbcoder/wt-20250

Seat wiring (sk-agent dir/config, papermill python/cwd, lane, gate, engine metrics,
kernel map) is env-overridable via NBCODER_* — one driver, every seat of the fleet.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import fnmatch
import hashlib
import html
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tokenize
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HERE = Path(__file__).resolve().parent
# Anchor for the vllm-side defaults (scratch dirs, conventions doc). Inside the jsboige/vllm
# fork this is the repo root; installed anywhere else -- the mutualised copy under
# servers/sk-agent/harness/ (roo-extensions #4781) -- it falls back to this directory so the
# defaults stay on-disk instead of naming a seat's tree.
_VLLM_CAND = HERE.parents[3]
VLLM_ROOT = _VLLM_CAND if (_VLLM_CAND / "myia_vllm").is_dir() else HERE


def _sk_dir() -> Path:
    """Where the sk-agent checkout lives (roo-extensions #4781: no seat binding in the tree).
    Order: NBCODER_SK_DIR env, then the sibling layout the harness has once it lives at
    servers/sk-agent/harness/nb_coder/ (its sk-agent root is ../.., recognised by sk_agent.py
    so an unrelated ../.. cannot shadow it), then the legacy absolute path kept for the live
    ai-01 seat until the cutover."""
    env = os.environ.get("NBCODER_SK_DIR")
    if env:
        return Path(env)
    sibling = (HERE / "../..").resolve()
    if (sibling / "sk_agent.py").is_file():
        return sibling
    return Path("d:/roo-extensions/mcps/internal/servers/sk-agent")


# Seat wiring is env-overridable: the same driver serves any seat of the fleet (mutualised
# harness, #431). e.g. po-2028 sets NBCODER_SK_DIR, NBCODER_PM_PY, NBCODER_LANE (and
# NBCODER_GATE/GATE-MODE=off where capacity is enforced server-side by claudis lane budgets
# instead of a local Swift gate).
SK_DIR = _sk_dir()
SK_PY = Path(os.environ.get("NBCODER_SK_PY", str(SK_DIR / "venv/Scripts/python.exe")))
SK_CONFIG = Path(os.environ.get("NBCODER_SK_CONFIG", str(SK_DIR / "sk_agent_config.json")))
# The papermill MCP server is a separate process with its own dependencies (papermill_mcp):
# env, then the recorded ai-01 conda env when it exists, then the interpreter running this
# driver (the honest "no seat binding" default; seats install papermill_mcp or set NBCODER_PM_PY).
_LEGACY_PM_PY = Path(r"C:\Users\MYIA\miniconda3\envs\mcp-jupyter\python.exe")
PM_PY = Path(os.environ.get("NBCODER_PM_PY",
                            str(_LEGACY_PM_PY if _LEGACY_PM_PY.is_file() else Path(sys.executable))))
_PM_CWD_SIBLING = (HERE / "../../../jupyter-papermill-mcp-server").resolve()
PM_CWD = Path(os.environ.get("NBCODER_PM_CWD",
                             str(_PM_CWD_SIBLING if _PM_CWD_SIBLING.is_dir()
                                 else Path(r"D:\roo-extensions\mcps\internal\servers\jupyter-papermill-mcp-server"))))
GATE = Path(os.environ.get("NBCODER_GATE",
                           str(VLLM_ROOT / "myia_vllm/scripts/adoption/swift_capacity_gate.py")))
# No seat default (F1, vllm#438): this value reaches the claim text, the [DELIVERED] marker and
# the claim guard. A seat that forgets the variable would claim under ANOTHER seat's identity —
# the exact failure the claim registry exists to prevent. Empty means "refuse at --claim time".
LANE = os.environ.get("NBCODER_LANE", "")
ENGINE_METRICS = os.environ.get("NBCODER_ENGINE_METRICS", "http://localhost:5002/metrics")

# requirement #3: canonical kernel per series, version read from the neighbours on main.
# NBCODER_KERNEL_MAP (JSON, {"Series dir": "kernel"}) merges seat-local series over these.
KERNEL_MAP = {
    "Audio": "coursia-genai-audio",
    "GameTheory": "python3",
    "IIT": "python3",
    "Complexity": "python3",
    "Image": "python3",
    "Video": "python3",
}
if os.environ.get("NBCODER_KERNEL_MAP"):
    KERNEL_MAP.update(json.loads(os.environ["NBCODER_KERNEL_MAP"]))
DEFAULT_KERNEL = "python3"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _text(x) -> str:
    return "".join(x) if isinstance(x, list) else (x or "")


def _lines(x):
    """Cell source in nbformat list-of-lines form (CoursIA convention, cf. fix_epic_refs.py:150-154).
    A str source written back reformats the whole cell JSON: every harness PR would inflate its diff
    (CR CoursIA 14/11, point 1a)."""
    return x.splitlines(keepends=True) if isinstance(x, str) else (x or [])


def normalize_sources(nb_path: Path) -> int:
    """Rewrite any str-form cell source into list-of-lines form; returns the count converted.
    Covers the MCP write mode (update_cell/add_cell write strings). No-op when nothing to convert."""
    nb = json.loads(nb_path.read_text(encoding="utf-8"))
    n = 0
    for c in nb.get("cells", []):
        if isinstance(c.get("source"), str):
            c["source"] = c["source"].splitlines(keepends=True)
            n += 1
    if n:
        nb_path.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return n


def gh(args: list[str], token: str | None = None, timeout: int = 60) -> tuple[int, str]:
    """REST-only GitHub calls (GraphQL bucket is fleet-shared)."""
    env = {**os.environ}
    if token:
        env["GH_TOKEN"] = token
    p = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=timeout, env=env)
    return p.returncode, (p.stdout or p.stderr).strip()


# GitHub's two refusals for a drained bucket: "API rate limit exceeded for user ID …" (core)
# and "You have exceeded a secondary rate limit" (abuse). Neither says anything about the
# grain, so a run that dies on one is deferred, not failed (21/11, CoursIA#27134 2.3c).
_GH_RATE_LIMIT_RE = re.compile(r"API rate limit exceeded|secondary rate limit", re.I)


def github_rate_limited(text: str) -> bool:
    return bool(_GH_RATE_LIMIT_RE.search(text or ""))


def github_core_reset(token: str | None = None) -> int | None:
    """Epoch at which the core bucket refills. /rate_limit does not count against it."""
    try:
        rc, out = gh(["api", "rate_limit", "--jq", ".resources.core.reset"], token, timeout=20)
        return int(out) if rc == 0 else None
    except (ValueError, OSError, subprocess.SubprocessError):
        return None


def rate_limit_verdict(reset: int | None) -> str:
    return "deferred-by-github-rate-limit" + (f":reset={reset}" if reset else "")


def refresh_gh_token(repo_dir: Path) -> str | None:
    """Mint a fresh installation token and rebind GH_TOKEN for this process.

    Measured 2026-11-23: the scheduler exported a 1-hour App token at launch; one hour
    later every gh leg 401'd ("Bad credentials"). The verify stage recorded verify-error,
    the claim guard inherited the dead GH_TOKEN and answered rc=2
    (refused-claim-check-not-scoped), and reprises refused at reservation. Rebinding here
    covers every child of the run -- claim guard, verifier, PR stage -- with a live token.
    Returns the token (None when no App is configured: the logged-in account's own).
    """
    tok = app_token(repo_dir)
    if tok:
        os.environ["GH_TOKEN"] = tok
    return tok


_CONTENT_VERDICTS = ("verify-reject", "verify-approved", "verify-same-served-model",
                     "gates-ok", "built-executed-ok", "built-executed-counts-broken")


def content_verdict_class(verdict: str | None) -> bool:
    """True for verdicts that JUDGE the artifact, never for infra refusals/errors.

    The trace's top-level verdict is the run's honest terminal state, but a later refusal
    OVERWRITES it -- a 401 on verify (verify-error) or a starved claim guard
    (refused-claim-check-not-scoped) then re-refused every reprise
    (refused-revise-not-rejected:..., measured twice on 23/11). last_content_verdict
    carries the last real judgment past those overwrites; run_revision reads it.
    """
    v = str(verdict or "")
    return v in _CONTENT_VERDICTS or v.startswith(("gates-failed", "built-execution-failed"))


def note_content_verdict(rec: dict, verdict: str) -> str:
    """Set the run's verdict, remembering it when it judges the artifact."""
    rec["verdict"] = verdict
    if content_verdict_class(verdict):
        rec["last_content_verdict"] = verdict
    return verdict


def app_token(repo_dir: Path) -> str | None:
    """Requirement #5: 1-hour installation token, never persisted, never in the model context.
    Without a GitHub App, the token of a logged-in gh account that can push (pinned_gh_token)."""
    app_id = os.environ.get("NBCODER_GH_APP_ID")
    key = os.environ.get("NBCODER_GH_KEY")
    if not app_id or not key:
        return pinned_gh_token()
    script = repo_dir / "scripts/secrets/github_app_token.py"
    if not script.is_file():
        return pinned_gh_token()
    p = subprocess.run([sys.executable, str(script), "--app-id", app_id, "--key", key,
                        "--repo", "jsboige/CoursIA", "--quiet"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    tok = (p.stdout or "").strip().splitlines()[-1] if p.returncode == 0 else ""
    if tok:
        GH_IDENTITY.update(source="github-app", login=None)
    return tok or None


# Without a token, every gh call runs as the ACTIVE gh account, and other sessions on the
# machine switch it (`gh auth switch`). On 21/11 CoursIA#27781 was approved, its branch pushed
# (git has its own credentials), and the PR create died in 422 "must be a collaborator": the
# active account had drifted to one with no push right while the driver ran. The driver now
# pins, once per process, the token of ONE account: NBCODER_GH_USER when set (explicit, never
# second-guessed), otherwise the first logged-in account -- active one first -- whose token
# can push to the target repo. The pinned token is that account's own: a later switch cannot
# move it. GH_IDENTITY records who was pinned and why, for the PR record.
GH_IDENTITY: dict = {}
_GH_PIN_REPO = "jsboige/CoursIA"


def _gh_out(argv: list[str], timeout: int = 20, token: str | None = None) -> str | None:
    env = {**os.environ}
    if token:
        env["GH_TOKEN"] = token
    else:
        env.pop("GH_TOKEN", None)
    try:
        p = subprocess.run(["gh", *argv], capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout, env=env)
    except (OSError, subprocess.SubprocessError):
        return None
    return (p.stdout or "").strip() if p.returncode == 0 else None


def gh_logins() -> list[str]:
    """Logged-in github.com accounts, the active one first."""
    out = _gh_out(["auth", "status", "--json", "hosts"])
    try:
        accts = (json.loads(out or "{}").get("hosts") or {}).get("github.com") or []
    except ValueError:
        return []
    ok = [a for a in accts if isinstance(a, dict) and a.get("state") == "success" and a.get("login")]
    return [a["login"] for a in sorted(ok, key=lambda a: not a.get("active"))]


def gh_can_push(token: str, repo: str = _GH_PIN_REPO) -> bool:
    return _gh_out(["api", f"repos/{repo}", "--jq", ".permissions.push"], token=token) == "true"


def pinned_gh_token(repo: str = _GH_PIN_REPO) -> str | None:
    if GH_IDENTITY.get("pinned"):
        return GH_IDENTITY.get("_token")
    if os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"):
        # an operator-provided token already fixes the identity; never override it
        GH_IDENTITY.update(pinned=True, _token=None, login=None, source="env-token")
        return None
    want = os.environ.get("NBCODER_GH_USER", "").strip()
    tried: list[str] = []
    for login in ([want] if want else gh_logins()):
        tok = _gh_out(["auth", "token", "-u", login])
        tried.append(login)
        if tok and (want or gh_can_push(tok, repo)):
            GH_IDENTITY.update(pinned=True, _token=tok, login=login, tried=tried,
                               source="NBCODER_GH_USER" if want else "push-probe")
            return tok
    GH_IDENTITY.update(pinned=True, _token=None, login=None, tried=tried,
                       source="NBCODER_GH_USER-unavailable" if want else "no-account-can-push")
    return None


def gh_identity_record() -> dict:
    return {k: v for k, v in GH_IDENTITY.items() if not k.startswith("_") and k != "pinned"}


# ---------------------------------------------------------------- stage 0
# A lot issue (one issue, several notebooks) carries one `[SPEC-DRAFT]` comment per notebook,
# each naming its own « Cible : `…ipynb` ». The prompts see the issue BODY (30 000 chars) and
# only the TAIL of the thread (8 000 chars): on CoursIA#27133 that tail is the end of the
# lot's LAST spec (Sudoku-05), so MGS-25 would have been built against another notebook's
# plan. With a target, the target's own spec moves into the body and every other spec of
# the lot leaves the thread, replaced by a line naming the notebook it specifies.
SPEC_DRAFT_TAG = "[SPEC-DRAFT]"
SPEC_DRAFT_TARGET_RE = re.compile(r"^[ \t>*-]*\**Cible\**[ \t]*:[ \t]*`([^`\n]+?\.ipynb)`", re.M)


def spec_draft_target(body: str) -> str | None:
    """The notebook a `[SPEC-DRAFT]` comment specifies (its first « Cible : `…` » line),
    repo-relative and posix-normalized. None for any other comment, and for a spec
    draft that names no target (it is then left in the thread as it was)."""
    if not (body or "").lstrip().startswith(SPEC_DRAFT_TAG):
        return None
    m = SPEC_DRAFT_TARGET_RE.search(body)
    return _norm_rel(m.group(1)) if m else None


def _json_values(text: str) -> list:
    """Concatenated JSON values (gh --paginate --jq prints one per line)."""
    dec, i, out = json.JSONDecoder(), 0, []
    text = text or ""
    while True:
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            return out
        v, i = dec.raw_decode(text, i)
        out.append(v)


def _thread_entry(c: dict, body: str | None = None) -> str:
    return f"--- {c.get('login')} {c.get('created_at')}\n{c.get('body') if body is None else body}"


def select_target_spec(issue: dict, comments: list[dict], target: str | None) -> dict:
    """Rewrite ``issue`` body/thread for ``target`` and return what was decided.

    status:
      - ``no-target``         no target given: thread kept verbatim (pre-lot behavior)
      - ``no-spec-comments``  the thread has no targeted spec draft: nothing changes
      - ``selected``          the target's spec (the LATEST one if revised) joins the body
      - ``none-for-target``   the lot has specs, none for this notebook: the caller refuses
    """
    specs = [(k, t) for k, c in enumerate(comments)
             if (t := spec_draft_target(c.get("body") or ""))]
    tgt = _norm_rel(target) if target else None
    mine = [k for k, t in specs if t == tgt] if tgt else []
    info: dict = {"status": "no-target" if not tgt else
                  ("selected" if mine else ("none-for-target" if specs else "no-spec-comments")),
                  "spec_comments": len(specs)}
    if specs and tgt:
        info["lot_targets"] = sorted({t for _, t in specs})
    chosen = mine[-1] if mine else None
    entries = []
    for k, c in enumerate(comments):
        t = next((t for kk, t in specs if kk == k), None)
        if not tgt or t is None:
            entries.append(_thread_entry(c))
        elif k == chosen:
            entries.append(_thread_entry(c, f"{SPEC_DRAFT_TAG} (spécification de ce carnet : "
                                            "reportée en entier dans le corps ci-dessus)"))
        elif t == tgt:
            entries.append(_thread_entry(c, f"{SPEC_DRAFT_TAG} (version antérieure de la "
                                            "spécification de ce carnet : remplacée par la "
                                            "plus récente, reportée dans le corps)"))
        else:
            entries.append(_thread_entry(c, f"{SPEC_DRAFT_TAG} (spécification d'un AUTRE carnet "
                                            f"du lot : `{t}` — omise, hors de ce grain)"))
    issue["comments"] = "\n".join(entries)
    if chosen is not None:
        c = comments[chosen]
        info.update({"comment_id": c.get("id"), "created_at": c.get("created_at"),
                     "chars": len(c.get("body") or ""), "versions": len(mine)})
        issue["body"] = (f"{issue.get('body') or ''}\n\n"
                         f"## Spécification de ce carnet (commentaire {SPEC_DRAFT_TAG} "
                         f"{c.get('id')} du {c.get('created_at')})\n\n{c.get('body') or ''}")
    return info


def fetch_issue(slug: str, n: int, token: str | None, target: str | None = None) -> dict:
    """Issue body + thread. ``target`` (repo-relative notebook) scopes a lot issue's spec
    drafts to that notebook — see select_target_spec. ``issue["spec_comment"]`` records
    the decision; ``none-for-target`` must stop the run before any token is spent."""
    rc, out = gh(["api", f"repos/{slug}/issues/{n}",
                  "--jq", '{"title":.title,"state":.state,"body":(.body // ""),"labels":[.labels[].name]}'],
                 token)
    if rc != 0:
        raise RuntimeError(f"issue fetch failed rc={rc}: {out[:300]}")
    issue = json.loads(out)
    rc, out = gh(["api", f"repos/{slug}/issues/{n}/comments", "--paginate",
                  "--jq", '.[] | {id: .id, login: .user.login, created_at: .created_at, body: (.body // "")}'],
                 token)
    if rc != 0:
        issue["comments"] = f"(comments fetch failed rc={rc})"
        issue["spec_comment"] = {"status": "comments-unreadable"}
        return issue
    try:
        comments = [c for c in _json_values(out) if isinstance(c, dict)]
    except ValueError as e:
        issue["comments"] = f"(comments unparsable: {e})"
        issue["spec_comment"] = {"status": "comments-unreadable"}
        return issue
    issue["spec_comment"] = select_target_spec(issue, comments, target)
    return issue


def check_claim(repo: Path, n: int, lane: str, notebook: str,
                from_json: str | None = None) -> dict:
    """#466: the check is SCOPED to this run's notebook (--paths). Unscoped, the guard
    answers NOT_SCOPED (rc=2) whenever any PR touches the issue but none names this
    notebook -- and the pre-#466 driver let rc=2 pass where a scoped check says BLOCKED
    (measured on CoursIA#27018 vs PR #27025).

    ``from_json`` is reserved for offline admission witnesses. It must never be passed
    by production runs: the claim guard explicitly skips open-PR legs in that mode."""
    script = repo / "scripts/check_lane_claim.py"
    if not script.is_file():
        return {"ok": None, "error": "check_lane_claim.py absent"}
    p = _run_claim_guard([sys.executable, str(script), str(n), "--lane", lane,
                          "--paths", notebook,
                          *(["--from-json", from_json] if from_json else [])], repo)
    if p is None:
        return {"ok": None, "rc": None, "timed_out": True,
                "error": f"claim guard timed out after {CLAIM_GUARD_TIMEOUT_S}s"}
    res = {"ok": p.returncode == 0, **_guard_result(p, notebook)}
    if res["rc"] == 3 and not from_json:
        feed_occupation(repo, n, lane, notebook, res)
    return res


# The guard reads GitHub (issue thread, open PRs, their diffs): 44 s for one scoped check
# on a calm bucket (measured 21/11 02:5xZ), and a reservation makes three calls. Under
# load one call passed 120 s and the TimeoutExpired escaped as `crashed:` (21/11 02:35Z,
# MGS-28, #27133) -- a terminal failure for a grain that had done nothing wrong.
#
# 24/11: 300 was AT PARITY with the guard's own budget. The guard bounds its complete
# open-PR enumeration itself (`CHECK_LANE_CLAIM_GH_TIMEOUT_TOTAL`, 300 s,
# check_lane_claim.py) and answers a fail-closed UNKNOWN when it cannot be established;
# it still has to read the thread and fetch PR heads around it. A harness budget equal to
# that inner budget kills every slow call BEFORE the guard can answer, and the leaf reads
# as unschedulable. Measured on CoursIA#28017 (192 open PRs): one scoped check took 181 s
# standalone (23:14->23:17Z); the scheduler's first two attempts were killed at 300 s and
# cost 2 x 5.6 min of launch + backoff, the third was admitted in under 250 s (launched
# 23:15:04Z, next stage 23:19:13Z). 600 keeps the guard's own verdict reachable (inner
# 300 + thread and head legs) and stays ~3x the standalone measurement.
CLAIM_GUARD_TIMEOUT_S = 600
CLAIM_TIMEOUT_VERDICT = "deferred-by-claim-timeout"


def _run_claim_guard(argv: list[str], repo: Path):
    """CompletedProcess of one guard call, or None when it outlived its budget."""
    try:
        return subprocess.run(argv, cwd=repo, capture_output=True, text=True,
                              encoding="utf-8", errors="replace",
                              timeout=CLAIM_GUARD_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return None


# rc=3 is the guard's IMPLICIT verdict (#14300): no [CLAIMED] marker blocks, but an OPEN
# PR of another lane references the issue. On a LOT issue the guard does not intersect
# that PR's files with --paths: CoursIA#27133 carries five Rust ports, and po-2024's open
# PR #27691 (Sudoku-05 only) made the guard answer 3 for MGS-28, MGS-29 and Search-11,
# whose files it never touches (21/11 03:14Z). The driver read every rc outside {0,1} as
# "not scoped" and burned the three grains. Now: an occupying PR that touches THIS
# notebook (or whose file list cannot be trusted) still refuses; a disjoint one defers,
# because the occupation ends when that PR merges -- the scheduler retries with backoff.
CLAIM_IMPLICIT_VERDICT = "deferred-by-claim-implicit-occupation"
# 22/11 (salvage, CoursIA#28064..#28081): the guard's consumer-side QUALIFICATION also
# exits 1, before any claim is read -- e.g. RELACHEE, the issue's last marker is a
# [RELEASED] younger than the window, OUR OWN lane's included. The driver read every
# rc=1 as "held by another lane": seven grains were reported as cross-lane collisions
# that did not exist. The code is read from the guard's `[QUALIFICATION] <CODE> :` line.
CLAIM_NOT_QUALIFIED_VERDICT = "refused-claim-not-qualified"
_QUALIFICATION_RE = re.compile(r"\[QUALIFICATION\]\s+([A-Z][A-Z_]*)\s*:")
# GitHub's PR payload previews at most 100 files: a list that long may hide ours.
_PR_FILES_PREVIEW_CAP = 100


def _guard_report(stdout: str) -> dict | None:
    """The guard prints ONE JSON summary first, then its verdict lines."""
    text = (stdout or "").lstrip()
    if not text.startswith("{"):
        return None
    try:
        doc, _ = json.JSONDecoder().raw_decode(text)
    except ValueError:
        return None
    return doc if isinstance(doc, dict) else None


def _guard_result(p, notebook: str) -> dict:
    """rc + a bounded copy of the guard's output that keeps its VERDICT.

    The verdict lines follow the JSON summary: the old `[:2000]` kept the head of the
    JSON and cut the verdict off, so a refusal recorded no reason (#27133, rc=3)."""
    text = (p.stdout or p.stderr or "").strip()
    out = text if len(text) <= 2000 else text[:1200] + "\n[...]\n" + text[-800:]
    res: dict = {"rc": p.returncode, "out": out}
    if p.stdout and p.stderr:
        res["warnings"] = p.stderr.strip()[-600:]
    doc = _guard_report(p.stdout) or {}
    mine = (doc.get("active_claims") or {}).get(doc.get("my_lane") or "")
    if isinstance(mine, dict):
        res["my_claim"] = {
            "marker": mine.get("marker"), "claimed_at": mine.get("claimed_at"),
            "url": mine.get("url"), "pr_ref": mine.get("pr_ref"),
            "locked": mine.get("locked"),
            "paths": [_norm_rel(g) for g in (mine.get("paths") or [])
                      if isinstance(g, str)][:_PR_FILES_PREVIEW_CAP],
        }
    if p.returncode == 3:
        target = _norm_rel(notebook)
        res["implicit"] = [
            _implicit_entry(pr.get("number"), pr.get("lane"), [
                _norm_rel(f) for f in (pr.get("files") or []) if isinstance(f, str)], target)
            for pr in (doc.get("implicit_occupation") or []) if isinstance(pr, dict)]
    return res


def _implicit_entry(number, lane, files: list[str], target: str) -> dict:
    """One occupying PR as implicit_verdict reads it. `files` are repo-relative.

    The file list is READ when it names this notebook, and not trusted when it is empty
    or as long as GitHub's 100-path preview (which may hide ours)."""
    return {
        "number": number, "lane": lane,
        "files": files[:5], "file_count": len(files),
        "touches_notebook": (target in files
                             or not files
                             or len(files) >= _PR_FILES_PREVIEW_CAP),
    }


# 25/11 -- the occupation BELT on the guard's rc=3 -----------------------------------------------
# The guard's IMPLICIT leg keeps, for a lane that already holds its claim, only the open
# PRs of other lanes ANTERIOR to that claim (CoursIA scripts/check_lane_claim.py 6076-6099,
# #26751: a PR opened later "reste subsumee par le claim"). A third-party PR opened AFTER
# the lane's marker therefore never reaches `implicit_occupation`, although it may hold
# the notebook. One cause, two answers: with an anterior PR left the guard answers rc=3
# and names the wrong PR; with none left it answers rc=0, CLEAR. CoursIA#27130 got the
# SECOND on 25/11 14:42Z -- with PR #28250 (opened 23/11, after the claim of 20/11)
# carrying the five targets of lot 2. Called WITHOUT the date filter, the guard's own
# reader names it.
#
# This is NOT a second guard. On rc=3 only -- where implicit_verdict is consulted -- it
# hands that one decision point the open PRs of other lanes that occupy the issue, with NO
# date filter, and refuses nothing itself. WHICH PRs occupy is read by the guard's OWN
# reader (`_find_open_prs_referencing_issue`, through its documented `prs` injection
# seam): the reference predicate, the enumeration guard (#24788) and the own-lane
# exclusion are not duplicated here. The files come from `pulls/N/files` -- never from a
# title or a branch (#28250's branch carries no notebook name).
#
# Bounded, and fail-soft. At most OCCUPATION_PR_CAP PRs' files per pass, one deadline for
# the pass. A PR whose files were not read is not added; a failed leg voids the pass: it
# adds nothing and records `occupation_check: unavailable` -- no refusal on a broken
# instrument, no silent green either (the trace names the leg that died).
#
# Out of reach, on purpose: the rc=0 CLEAR the guard gives when NO anterior PR is left
# never passes here -- and that is the answer #27130 got. This belt does not cover the
# measured incident; that class stays with the preflight bar and the organ's own fix.
#
# REMOVAL CONDITION: delete this block once the guard itself reports, in
# `implicit_occupation`, the PR posterior to the claim (posed to the CoursIA coordinator
# 25/11). harness/README.md, Requirements, carries the same sentence.
OCCUPATION_PR_CAP = 20
OCCUPATION_PAGE_CAP = 5      # 100 open PRs per REST page
OCCUPATION_CALL_S = 45       # one REST call
OCCUPATION_BUDGET_S = 120    # the whole pass


def occupation_reader(repo: Path):
    """The guard's module, loaded from the run's checkout (`<repo>/scripts/check_lane_claim.py`).

    The checkout is an INPUT of the run, like the guard call itself: this is the reader the
    guard answers with, so the two cannot drift apart. Loaded by path, never from the import
    cache. Raises when the checkout carries no importable guard, or no reader."""
    import importlib.util
    import warnings
    path = repo / "scripts" / "check_lane_claim.py"
    if not path.is_file():
        raise ImportError("check_lane_claim.py absent")
    spec = importlib.util.spec_from_file_location("check_lane_claim", path)
    if spec is None or spec.loader is None:
        raise ImportError("check_lane_claim.py has no import spec")
    scripts = str(path.parent)
    saved = sys.modules.get("check_lane_claim")
    sys.path.append(scripts)      # the guard's `from grain_tag import ...` and siblings
    try:
        reader = importlib.util.module_from_spec(spec)
        sys.modules["check_lane_claim"] = reader
        with warnings.catch_warnings():
            # The guard's own compile-time warnings are not this run's (a SyntaxWarning
            # in a docstring must neither reach the run's log nor fail the load).
            warnings.simplefilter("ignore")
            try:
                spec.loader.exec_module(reader)
            except SystemExit as e:   # a guard without a __main__ guard runs at import
                raise ImportError(
                    f"check_lane_claim.py exited at import (code {e.code})") from None
    finally:
        if sys.path[-1:] == [scripts]:
            sys.path.pop()
        if saved is None:
            sys.modules.pop("check_lane_claim", None)
        else:
            sys.modules["check_lane_claim"] = saved
    if not callable(getattr(reader, "_find_open_prs_referencing_issue", None)):
        raise AttributeError("check_lane_claim.py carries no _find_open_prs_referencing_issue")
    return reader


def _occupation_call(argv: list[str], deadline: float):
    """One REST leg of the belt: the decoded document, or an exception -- rc != 0, a call
    that outlives its timeout, an unparsable body, an exhausted budget."""
    left = deadline - time.monotonic()
    if left < 2:
        raise TimeoutError(f"occupation belt out of budget ({OCCUPATION_BUDGET_S}s)")
    rc, out = gh(argv, timeout=max(2, min(OCCUPATION_CALL_S, int(left))))
    if rc != 0:
        raise OSError(f"gh {argv[-1]} rc={rc}: {(out or '')[-160:]}")
    return json.loads(out)


def _occupation_open_prs(slug: str, deadline: float) -> tuple[list[dict], bool]:
    """Every open PR as the guard's reader takes it -- number, title, body, created_at --
    and whether the listing stopped at OCCUPATION_PAGE_CAP. No head is carried: provenance
    stays unestablished for the reader, which then keeps the REST paths it is handed."""
    prs: list[dict] = []
    for page in range(1, OCCUPATION_PAGE_CAP + 1):
        items = _occupation_call(
            ["api", f"repos/{slug}/pulls?state=open&per_page=100&page={page}"], deadline)
        if not isinstance(items, list):
            raise ValueError("open PR listing is not a list")
        for it in items:
            if isinstance(it, dict) and isinstance(it.get("number"), int):
                prs.append({"number": it["number"], "title": it.get("title") or "",
                            "body": it.get("body") or "",
                            "created_at": it.get("created_at")})
        if len(items) < 100:
            return prs, False
    return prs, True


def occupation_belt(repo: Path, n: int, lane: str, notebook: str,
                    slug: str = _GH_PIN_REPO) -> dict:
    """Open PRs of other lanes that occupy issue `n`, each with the files READ for it, plus
    the pass's trace -- or `status: unavailable` with the leg that died.

    Findings carry no PR whose files were not read: over the cap, or no diff at all. The
    reader is loaded FIRST, so no REST call leaves without a reader to answer it."""
    deadline = time.monotonic() + OCCUPATION_BUDGET_S
    trace: dict = {"status": "ok"}
    try:
        reader = occupation_reader(repo)
        prs, trace["listing_truncated"] = _occupation_open_prs(slug, deadline)
        trace["listed"] = len(prs)
        citing = reader._find_open_prs_referencing_issue(n, lane, prs=prs)
        numbers = sorted(c["number"] for c in citing
                         if isinstance(c, dict) and isinstance(c.get("number"), int))
        trace["citing"] = len(numbers)
        by_number = {pr["number"]: pr for pr in prs}
        for number in numbers[:OCCUPATION_PR_CAP]:
            files = _occupation_call(
                ["api", f"repos/{slug}/pulls/{number}/files?per_page=100"], deadline)
            if not isinstance(files, list):
                raise ValueError(f"files of #{number} are not a list")
            by_number[number]["files"] = [{"path": f["filename"]} for f in files
                                          if isinstance(f, dict) and f.get("filename")]
        trace["read"] = min(len(numbers), OCCUPATION_PR_CAP)
        target = _norm_rel(notebook)
        findings = []
        for c in reader._find_open_prs_referencing_issue(n, lane, prs=prs):
            if not isinstance(c, dict) or not isinstance(c.get("number"), int):
                continue
            files = [x for x in (c.get("files") or []) if isinstance(x, str)]
            if not files:
                continue          # not read (over the cap), or no diff: nothing to say
            entry = _implicit_entry(c["number"], c.get("lane"),
                                    [_norm_rel(x) for x in files], target)
            entry["source"] = "belt"
            findings.append(entry)
        trace["unread"] = len(numbers) - len(findings)
        return {**trace, "findings": findings}
    except (OSError, ValueError, TypeError, AttributeError, KeyError, IndexError,
            ImportError, SyntaxError, subprocess.SubprocessError, RuntimeError) as e:
        return {**trace, "status": "unavailable",
                "error": f"{type(e).__name__}: {str(e)[:200]}"}


def feed_occupation(repo: Path, n: int, lane: str, notebook: str, res: dict) -> None:
    """rc=3 only: complete the guard's implicit list with the belt's findings.

    Entries are ADDED, deduped by number; the guard's own entries are never rewritten, so
    a verdict can only tighten (defer -> refuse on a read collision) or name more PRs."""
    try:
        belt = occupation_belt(repo, n, lane, notebook)
        added = [f for f in belt.pop("findings", None) or []
                 if f["number"] not in {i.get("number") for i in res.get("implicit") or []}]
        res["implicit"] = list(res.get("implicit") or []) + added
        res["occupation_check"] = {**belt, "added": [f["number"] for f in added]}
        note = (f"error: {belt['error']}" if belt["status"] != "ok"
                else f"added={[f['number'] for f in added]}")
    except Exception as e:  # noqa: BLE001 -- the belt never decides: its own crash adds nothing
        res["occupation_check"] = {"status": "unavailable", "added": [],
                                   "error": f"{type(e).__name__}: {str(e)[:200]}"}
        note = f"error: {res['occupation_check']['error']}"
    print(f"[claim] occupation_check: {res['occupation_check']['status']} ({note})",
          file=sys.stderr)


def implicit_verdict(cc: dict) -> str:
    """rc=3: refuse when the occupying PR may touch this notebook, defer when disjoint."""
    implicit = cc.get("implicit") or []
    if not implicit or any(i.get("touches_notebook") for i in implicit):
        # unreadable report, or a real collision on our file: fail closed
        return "refused-claim-implicit-occupation"
    return CLAIM_IMPLICIT_VERDICT + ":" + ",".join(
        f"#{i.get('number')}" for i in implicit)


def qualification_code(cc: dict) -> str | None:
    """The guard's `[QUALIFICATION] <CODE>` (RELACHEE, GEL, LABEL, HORSFLOTTE...), or None.

    Printed on stderr; `_guard_result` keeps it in `out` (no stdout) or `warnings`."""
    for key in ("out", "warnings"):
        m = _QUALIFICATION_RE.search(cc.get(key) or "")
        if m:
            return m.group(1)
    return None


def claim_verdict(cc: dict) -> str | None:
    """Fail-closed reading of a SCOPED claim check (#466).

    rc=1  -> the grain is not qualified (`[QUALIFICATION] <CODE>`, e.g. a recent
             [RELEASED]): refuse under that code, never as a cross-lane collision.
             Otherwise a live claim conflicts on THIS notebook's path: refuse.
    rc=2  -> the scoped check still cannot decide (old script without --paths, path
             absent from every open diff): refuse rather than run unprotected -- the
             pre-#466 driver treated this as pass-through.
    rc=3  -> IMPLICIT: an open PR of another lane references the issue. Refused if it
             may touch this notebook, deferred if its files are disjoint (#27133).
    no rc -> the guard itself is absent/broken: refuse crash-free (it used to KeyError).
    rc=0  -> clear, proceed.
    """
    if cc.get("timed_out"):
        # Not a verdict on the claim: the guard never answered. Deferred, so the
        # scheduler retries with backoff instead of burning the grain.
        return f"{CLAIM_TIMEOUT_VERDICT}:check"
    rc = cc.get("rc")
    if rc == 1:
        code = qualification_code(cc)
        if code:
            return f"{CLAIM_NOT_QUALIFIED_VERDICT}:{code}"
        return "refused-claim-held-by-another-lane"
    if rc is None:
        return "refused-claim-check-broken"
    if rc == 3:
        return implicit_verdict(cc)
    if rc != 0:
        return "refused-claim-check-not-scoped"
    return None


def post_claim(repo: Path, n: int, lane: str, intention: str,
               notebook: str, from_json: str | None = None,
               scope: list[str] | None = None) -> dict:
    """Acquire this notebook's claim through the authoritative guard, not a bare comment.

    The guard rechecks collisions and verifies its write before returning 0. The caller
    must gate the worktree/model stages on this result, then re-read the claim below.
    ``from_json`` is only for offline two-client admission tests, never production.
    ``scope`` replaces the written paths (it must contain ``notebook``): the guard keeps
    ONE active claim per lane and issue, so a write scoped to this notebook alone would
    drop the lane's other paths on the issue (see lane_claim_scope).
    """
    script = repo / "scripts/check_lane_claim.py"
    if not script.is_file():
        return {"rc": None, "out": "check_lane_claim.py absent"}
    p = _run_claim_guard([sys.executable, str(script), str(n), "--lane", lane,
                          "--paths", *(scope or [notebook]), "--claim", intention,
                          *(["--from-json", from_json] if from_json else [])], repo)
    if p is None:
        return {"rc": None, "timed_out": True,
                "out": f"claim guard timed out after {CLAIM_GUARD_TIMEOUT_S}s"}
    res = _guard_result(p, notebook)
    if res["rc"] == 3 and not from_json:
        feed_occupation(repo, n, lane, notebook, res)
    return res


def claim_reservation_verdict(post: dict, verify: dict) -> str | None:
    """A model run starts only after an admitted, freshly re-read scoped claim.

    A guard that timed out is deferred, never admitted: after a post timeout the
    comment state is UNKNOWN (same residue as refused-claim-post-failed), and the
    retry's first act is the scoped pre-check -- the re-read of the thread that
    residue requires. The guard resumes our own claim instead of colliding with it."""
    if post.get("timed_out"):
        return f"{CLAIM_TIMEOUT_VERDICT}:post"
    if post.get("rc") == 3:
        # The guard runs the IMPLICIT leg BEFORE writing and refuses the post on rc=3
        # (#26751): nothing landed, so this is not the UNKNOWN residue of a failed post.
        return implicit_verdict(post)
    if post.get("rc") != 0:
        return "refused-claim-post-failed"
    if verify.get("timed_out"):
        return f"{CLAIM_TIMEOUT_VERDICT}:verify"
    if verify.get("rc") == 3:
        # Our post is now the lane's latest claim, so every older open PR of another
        # lane on the issue reads as IMPLICIT. Residue: one claim comment, no admission.
        v = implicit_verdict(verify)
        return v if v.startswith(CLAIM_IMPLICIT_VERDICT) else "refused-claim-not-verified"
    if claim_verdict(verify) is not None:
        return "refused-claim-not-verified"
    return None


# The guard keeps ONE active [CLAIMED] per lane and issue. Two grains of a lot issue
# that reserve at the same time overwrite each other's claim between post and re-read:
# CoursIA#27133, 21/11 02:08Z, MGS-25 posted, MGS-28 posted, and MGS-25's re-read saw
# MGS-28's paths -> refused-claim-not-verified. Only that window races, so only that
# window is serialized: a local lock per issue around reserve_claim. Grains of the same
# lot still run side by side once admitted (the conveyor's lots carry 5-9 notebooks).
CLAIM_LOCK_DIRNAME = ".claim-locks"
# A reservation is three guard calls of at most CLAIM_GUARD_TIMEOUT_S each.
CLAIM_LOCK_WAIT_S = 3 * CLAIM_GUARD_TIMEOUT_S + 120
CLAIM_LOCK_POLL_S = 5.0


@contextlib.contextmanager
def issue_claim_lock(lock_dir: Path, n: int, wait_s: float = CLAIM_LOCK_WAIT_S,
                     poll_s: float = CLAIM_LOCK_POLL_S, clock=time.time,
                     sleep=time.sleep):
    """Exclusive local lock on issue `n`'s reservation window; yields {"held": bool}.

    A lock file older than `wait_s` is stale (its holder died mid-reservation: a live
    one finishes within three guard timeouts) and is taken over. Not held after
    `wait_s` -> the caller defers; it never reserves unlocked."""
    lock_dir.mkdir(parents=True, exist_ok=True)
    path = lock_dir / f"issue-{n}.lock"
    start = clock()
    info = {"held": False, "path": str(path), "waited_s": 0.0}
    while True:
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                age = clock() - path.stat().st_mtime
            except OSError:
                continue                      # released between the two calls
            if age > wait_s:
                with contextlib.suppress(OSError):
                    path.unlink()
                info["took_over_stale_s"] = round(age, 1)
                continue
            if clock() - start >= wait_s:
                info["waited_s"] = round(clock() - start, 1)
                break
            sleep(poll_s)
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps({"pid": os.getpid(), "ts": utcnow()}))
        info.update(held=True, waited_s=round(clock() - start, 1))
        break
    try:
        yield info
    finally:
        if info["held"]:
            with contextlib.suppress(OSError):
                path.unlink()


# The guard keeps ONE active [CLAIMED] per lane and issue (the latest wins) and writes
# exactly the --paths it is given. Measured on CoursIA#27133, 21/11: the coordinator had
# claimed the whole lot for this lane at 20/11 18:22Z; every grain's reservation then
# re-posted a claim scoped to its own notebook, so (1) the lane's claim shrank to one
# notebook and the siblings in flight lost their cover, and (2) the claim was re-dated.
# The IMPLICIT leg counts another lane's open PR only when it is OLDER than the caller's
# claim (check_lane_claim.py, #26751): po-2024's PR #27691 (21/11 02:26Z) was newer than
# the coordinator's claim and older than ours (03:14Z), so every sibling was refused.
# Now a notebook the lane's live claim already names is admitted on the pre-check alone
# (nothing re-posted, nothing re-dated), and a write never carries fewer paths than the
# lane's claim had.
# Past this age the claim is re-posted anyway: other lanes read a claim older than 48 h
# (the guard's default threshold) as stale.
LANE_CLAIM_REFRESH_S = 24 * 3600


def _parse_utc(ts) -> datetime | None:
    try:
        at = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


# An amend is a claim too (check_lane_claim.py `_OPEN`, #13022): the coordinator asked on
# 21/11 that a lot reservation be re-posted as `[CLAIMED-AMEND] ... -- paths: <full list>`,
# and the guard reports that comment with marker "CLAIMED-AMEND". Read as "no live
# claim", every grain after the amend would re-post its notebook alone and narrow the
# lot again, the very defect lane_claim_scope exists to prevent.
LIVE_CLAIM_MARKERS = frozenset({"CLAIMED", "CLAIMED-AMEND"})


def _live_lane_claim(my_claim) -> bool:
    """A [CLAIMED] or [CLAIMED-AMEND] of our lane that still reserves: not delivered, not
    locked to a PR."""
    return (isinstance(my_claim, dict)
            and str(my_claim.get("marker") or "").upper() in LIVE_CLAIM_MARKERS
            and not my_claim.get("locked") and not my_claim.get("pr_ref"))


def lane_claim_covers(my_claim, notebook: str, now: datetime | None = None) -> bool:
    """True when our lane's live, fresh claim already names this notebook (fnmatch, as
    the guard reads `paths:`). An issue-wide claim (no paths) does not count: the guard
    filters those by scope, so it is no proof of cover."""
    if not _live_lane_claim(my_claim):
        return False
    at = _parse_utc(my_claim.get("claimed_at"))
    if at is None:
        return False
    now = now or datetime.now(timezone.utc)
    if (now - at).total_seconds() > LANE_CLAIM_REFRESH_S:
        return False
    target = _norm_rel(notebook)
    return any(fnmatch.fnmatchcase(target, g) for g in my_claim.get("paths") or [])


def lane_claim_scope(my_claim, notebook: str) -> list[str] | None:
    """Paths for a write that keeps the lane's live claim: its paths plus this notebook.
    None when the lane holds no scoped live claim (the write is the notebook alone)."""
    if not _live_lane_claim(my_claim) or not my_claim.get("paths"):
        return None
    paths = list(my_claim["paths"])
    target = _norm_rel(notebook)
    if target not in paths:
        paths.append(target)
    return paths


def reserve_claim(repo: Path, n: int, lane: str, intention: str,
                  notebook: str) -> dict:
    """Admission gate for a model run: scoped check -> authoritative post -> fresh re-read.

    Short path: when the CLEAR pre-check shows a live, fresh claim of our lane that
    already names this notebook (a coordinator's lot claim), the run is admitted
    without writing -- see lane_claim_covers. Otherwise the write carries the lane's
    existing paths plus this notebook (lane_claim_scope), never this notebook alone.

    Three refusals, each before any worktree or model spend:
    - the pre-check is not CLEAR (claim held, guard broken, check not scoped);
    - the guard refuses to post (collision seen at write time, write unverified);
    - the post-write re-read is not a CLEAR scoped check. It proves scope-level
      clearance, not marker-level ownership: the guard verifies that ONE comment
      landed, not which lane's marker the reader resolves to.

    Refusal residues are NOT alike -- cleanup treats them separately:
    - refused-claim-post-failed: the comment state is UNKNOWN. The guard may have
      written a comment before failing to verify it, so no cleanup may assume
      "nothing landed"; it re-reads the thread before touching anything.
    - refused-claim-not-verified: exactly ONE [CLAIMED] comment by OUR lane
      landed (the guard count-verified its write) while a FOREIGN marker sits on
      the same path. Residue = one leaked comment, zero admissions.

    This is NOT an atomic reservation and does not claim to be. The re-read narrows
    the window; the offline two-client witness (test_nb_coder_claim.py) pins the
    admission contract -- AT MOST one start under contention (the both-posts-succeed
    interleave admits ZERO and leaks two claim comments), zero on a failed post.
    A post returning 0 while the re-read observes NO claim at all is ADMITTED under
    this contract: admission requires the absence of a foreign marker, not the
    presence of our own. The guard's count-verified write is what makes that state
    unreachable with the real guard (pinned as a named witness, not assumed).
    """
    before = check_claim(repo, n, lane, notebook)
    refused = claim_verdict(before)
    if refused:
        return {"before": before, "posted": None, "verified": None,
                "verdict": refused}
    mine = before.get("my_claim")
    if lane_claim_covers(mine, notebook):
        # The pre-check IS the fresh read: CLEAR on this notebook, under a live claim
        # of our lane that already names it. A later post by another lane would see
        # that claim and be refused, so there is no window for a re-read to close.
        return {"before": before, "posted": None, "verified": None,
                "covered_by": {k: mine.get(k) for k in ("url", "claimed_at", "paths")},
                "verdict": None}
    scope = lane_claim_scope(mine, notebook)
    if scope:
        posted = post_claim(repo, n, lane, intention, notebook, scope=scope)
        if posted.get("rc") == 1:
            # The guard refused the union BEFORE writing (one of the lane's other
            # paths is now held elsewhere): nothing landed. Fall back to this
            # notebook alone -- the narrow write, which the pre-check just cleared.
            union = posted
            posted = post_claim(repo, n, lane, intention, notebook)
            posted["union_refused"] = {"rc": union.get("rc"),
                                       "out": (union.get("out") or "")[-400:]}
    else:
        posted = post_claim(repo, n, lane, intention, notebook)
    verified = (check_claim(repo, n, lane, notebook)
                if posted.get("rc") == 0
                else {"rc": None, "skipped": "claim acquisition failed"})
    return {"before": before, "posted": posted, "verified": verified,
            **({"scope": scope} if scope else {}),
            "verdict": claim_reservation_verdict(posted, verified)}


# --claim-late (CoursIA coordinator, 21/11, auto-pick rule Q-A): "pas de [CLAIMED] avant
# que le run ait une PR ouvrable (stage 4 vert) : un lancement qui echoue ne verrouille
# rien". Stage 0 records this deferral instead of reserving; late_reservation() takes the
# reservation, through the same lock + reserve_claim admission, right before stage 5.
LATE_CLAIM_DEFERRED = {"verdict": None, "deferred": "late",
                       "note": "no [CLAIMED] before an openable PR (CoursIA rule 21/11); "
                               "reserved by late_reservation() before stage 5"}
LATE_CLAIM_TAKEN = "late-taken"
LATE_CLAIM_REFUSED = "late-claim-refused"
# A guard timeout at this point would throw away a verified build: retry it once.
LATE_CLAIM_ATTEMPTS = 2


def late_reservation(args, rec: dict) -> bool:
    """True when stage 5 may run. A no-op (True) unless stage 0 deferred the claim.

    Deferred: reserve now, under the per-issue lock, with the same fail-closed admission
    as stage 0 (scoped pre-check -> authoritative post -> re-read). A refusal means another
    lane took the notebook while we built it: the verdict becomes late-claim-refused:<v>
    and nothing is posted -- the built notebook and its worktree stay on disk. A guard
    timeout is retried once before it counts as a refusal."""
    cr = rec["stages"].get("claim_reservation") or {}
    if cr.get("deferred") != "late":
        return True
    attempts = []
    for _ in range(LATE_CLAIM_ATTEMPTS):
        with issue_claim_lock(Path(args.out_dir).parent / CLAIM_LOCK_DIRNAME,
                              args.issue) as lock:
            late = (reserve_claim(Path(args.repo), args.issue, args.lane, args.intention,
                                  _norm_rel(args.notebook))
                    if lock["held"] else
                    {"verdict": f"{CLAIM_TIMEOUT_VERDICT}:lock",
                     "note": "a sibling grain of this issue held its reservation too long"})
        late["lock"] = lock
        attempts.append(late)
        if not str(late.get("verdict") or "").startswith(CLAIM_TIMEOUT_VERDICT):
            break
    rec["stages"]["claim_reservation_late"] = {"at": utcnow(), "attempts": attempts}
    verdict = attempts[-1].get("verdict")
    if verdict:
        rec["verdict"] = f"{LATE_CLAIM_REFUSED}:{verdict}"
        return False
    rec["stages"]["claim_reservation"] = {**cr, "deferred": LATE_CLAIM_TAKEN}
    return True


# 22/11 (conveyor, 03:50->04:45Z): under --claim-late six grains were taken by faster
# lanes while Swift was building them (CoursIA#27927, #27928, #27930, #27931, #27935,
# #27936). The refusal only surfaced at the late reservation, ~1.5 h of engine time
# after the other lane's marker. A cheap probe (one REST call) at the stage boundaries
# stops the run as soon as another lane's marker is the issue's last word -- confirmed
# by the same scoped guard as the reservation before anything is thrown away.
_CLAIM_MARK_RE = re.compile(r"^\s*\[(CLAIMED|RELEASED|DELIVERED)\] lane (\S+)")
MIDRUN_REFUSED = f"{LATE_CLAIM_REFUSED}:midrun"
MIDRUN_COLLISIONS = ("refused-claim-held-by-another-lane", "refused-claim-implicit-occupation")


def last_foreign_marker(issue_n: int, lane: str, slug: str = _GH_PIN_REPO) -> str | None:
    """The other lane whose [CLAIMED]/[DELIVERED] is the issue's LAST claim marker.

    None when the last marker is ours or a [RELEASED], when there is none, or when GitHub
    does not answer: fail-open, the late reservation stays the authority."""
    try:
        p = subprocess.run(["gh", "api", f"repos/{slug}/issues/{issue_n}/comments?per_page=100",
                            "--jq", "[.[].body]"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=60)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if p.returncode != 0:
        return None
    try:
        bodies = json.loads(p.stdout or "[]")
    except ValueError:
        return None
    last = None
    for body in bodies if isinstance(bodies, list) else []:
        m = _CLAIM_MARK_RE.match(body or "")
        if m:
            last = m.groups()
    if last and last[0] != "RELEASED" and last[1] != lane:
        return last[1]
    return None


def midrun_armed(rec: dict) -> bool:
    """True when the claim was DEFERRED (--claim-late): the only state in which a mid-run
    probe has anything to guard."""
    cr = (rec.get("stages") or {}).get("claim_reservation") or {}
    return cr.get("deferred") == "late"


def midrun_claim_abort(args, rec: dict, stage: str) -> bool:
    """True when the run must stop now: the claim was deferred (--claim-late), another
    lane's marker is the issue's last word, and the scoped guard sees a COLLISION on this
    notebook (held by another lane, or an occupying PR that may touch it). A guard that
    times out, is broken, or answers a disjoint occupation never stops the run."""
    if not midrun_armed(rec):
        return False
    holder = last_foreign_marker(args.issue, args.lane)
    probe: dict = {"stage": stage, "at": utcnow(), "holder": holder}
    rec.setdefault("midrun_claim_probes", []).append(probe)
    if not holder:
        return False
    cc = check_claim(Path(args.repo), args.issue, args.lane, _norm_rel(args.notebook))
    verdict = claim_verdict(cc)
    probe["guard"] = {"rc": cc.get("rc"), "verdict": verdict}
    if verdict in MIDRUN_COLLISIONS:
        rec["verdict"] = f"{MIDRUN_REFUSED}:{stage}:{holder}"
        return True
    return False


def prepare_worktree(repo: Path, dest: Path, fresh: bool) -> dict:
    """Detached worktree of origin/main: the dirty checkout is never read or touched.

    Reuse contract (#460): the shared default worktree is reused ONLY if it is
    clean and its HEAD is exactly origin/main. A worktree left on the previous
    run's branch (PR still open) must not be reused: stage 5 is born
    `checkout -b` off the worktree HEAD, so that run's unmerged commit would
    ride into the next PR as a stowaway (measured 16/11: CoursIA#26986 was born
    with two files). Clean-but-elsewhere is rebuilt (the branch itself survives
    in the repo — only the scratch checkout is discarded); dirty is REFUSED,
    because rebuilding would discard uncommitted work."""
    subprocess.run(["git", "-C", str(repo), "fetch", "origin", "main"],
                   capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    origin_main = subprocess.run(["git", "-C", str(repo), "rev-parse", "origin/main"],
                                 capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()
    if dest.exists() and (dest / ".git").exists() and not fresh:
        head_full = subprocess.run(["git", "-C", str(dest), "rev-parse", "HEAD"],
                                   capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()
        dirty = subprocess.run(["git", "-C", str(dest), "status", "--porcelain"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()
        if head_full == origin_main and not dirty:
            return {"path": str(dest), "reused": True, "head": head_full[:9], "ok": True}
        if dirty:
            return {"path": str(dest), "refused": "dirty", "head": head_full[:9],
                    "origin_main": origin_main[:9], "ok": False,
                    "err": ("shared worktree holds uncommitted changes; refusing to rebuild "
                            "-- commit or stash them, or use --fresh-worktree / another "
                            "--worktree")}
        # clean but not at origin/main: previous run's branch or stale base -> rebuild
    if dest.exists():
        subprocess.run(["git", "-C", str(repo), "worktree", "remove", "--force", str(dest)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    p = subprocess.run(["git", "-C", str(repo), "worktree", "add", str(dest), "--detach", "origin/main"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    head = subprocess.run(["git", "-C", str(dest), "rev-parse", "--short", "HEAD"],
                          capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()
    return {"path": str(dest), "reused": False, "head": head,
            "ok": p.returncode == 0, "err": (p.stderr or "").strip()[:500]}


def restore_worktree(repo: Path, dest: Path, head: str | None) -> dict:
    """Re-create a resumed grain's detached worktree at the head its trace recorded.

    The scheduler releases the worktree of a failed grain (`worktree-released`), so
    a resume of that grain found it missing and refused (21/11: #27851, approved and
    built, refused by the late-claim guard, then [RELEASED] by the holder 13 min
    later). Same head as the run: the source twin and kernel cwd are byte-identical
    to what was built and verified; stage 5 branches off it exactly as a first run.
    A missing head refuses (never a silent re-base on today's origin/main)."""
    if not head:
        return {"ok": False, "err": "no worktree head in the trace"}
    subprocess.run(["git", "-C", str(repo), "worktree", "prune"],
                   capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    p = subprocess.run(["git", "-C", str(repo), "worktree", "add", "--detach", str(dest), head],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=600)
    rc = getattr(p, "returncode", 1)
    return {"ok": rc == 0 and dest.exists(), "head": head, "path": str(dest),
            "err": (getattr(p, "stderr", "") or "").strip()[-300:]}


def engine_tokens() -> dict:
    """Engine-side prompt/generation counters, for a per-pass token delta (CR CoursIA#26534)."""
    try:
        p = subprocess.run(["curl", "-s", "--max-time", "5", ENGINE_METRICS],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10)
        vals = {}
        for ln in (p.stdout or "").splitlines():
            for key in ("prompt_tokens_total", "generation_tokens_total"):
                if ln.startswith(f"vllm:{key}"):
                    vals[key] = float(ln.rsplit(" ", 1)[-1])
        return vals
    except Exception:
        return {}


def gate_call(mode: str, gate_path: Path | None = None) -> dict:
    """Requirement: capacity gate before every notebook. warn = non-blocking (24 h window).
    off = no local gate: capacity is enforced elsewhere (MiniMax variant -> claudish lane
    budgets + stop file, server-side #1060/#1063 — a local Swift gate would be dead code).

    ``gate_path`` (pre-review round 2): an explicitly propagated probe path wins over the
    module-level env default — the scheduler resolves its own ``--gate`` (incl. $NBCODER_GATE)
    and forwards it, so a custom probe set on the parent reaches the child WITHOUT the
    operator having to export the env var in the parent shell."""
    if mode == "off":
        return {"verdict": "off", "mode": "off", "exit": None, "blocking_refusal": False}
    p = subprocess.run([sys.executable, str(gate_path or GATE)], capture_output=True,
                       text=True, encoding="utf-8", errors="replace", timeout=60)
    try:
        verdict = json.loads((p.stdout or "").strip().splitlines()[-1])
    except Exception:
        verdict = {"verdict": "unknown", "raw": (p.stdout or p.stderr)[:500]}
    verdict["exit"] = p.returncode
    verdict["mode"] = mode
    verdict["blocking_refusal"] = mode == "block" and p.returncode != 0
    return verdict


# ---------------------------------------------------------------- notebook view
def series_kernel(repo: Path, rel: str) -> dict:
    """Kernel name from the series map + canonical python version from the neighbours."""
    d = Path(rel).parent
    segs = rel.replace("\\", "/").split("/")[:-1]
    name = next((KERNEL_MAP[s] for s in segs if s in KERNEL_MAP), DEFAULT_KERNEL)
    versions = {}
    for sib in sorted((repo / d).glob("*.ipynb")):
        if sib.name == Path(rel).name:
            continue
        try:
            meta = json.loads(sib.read_text(encoding="utf-8")).get("metadata", {})
            v = (meta.get("language_info") or {}).get("version")
            if v:
                versions[v] = versions.get(v, 0) + 1
        except Exception:
            continue
    canon = max(versions, key=versions.get) if versions else None
    return {"kernel_name": name, "canonical_version": canon,
            "neighbour_versions": versions}


def series_canonical_meta(repo: Path, rel: str) -> dict:
    """Creation mode: kernelspec/language_info of the nearest existing sibling in the target
    folder that carries the TARGET's language tag (the last '-' segment of its stem:
    X-08-CSharp -> *-CSharp, X-08-Rust -> *-Rust). The built notebook inherits the series'
    canonical metadata, never the Python twin's — that is what the language-info gate
    compares against. A hard-coded *-CSharp glob handed a Rust port the .NET kernelspec.
    No tag or no such sibling -> {} : the caller refuses unless --meta-from names one."""
    d, stem = Path(rel).parent, Path(rel).stem
    if "-" not in stem:
        return {}
    tag = stem.rsplit("-", 1)[1]
    for sib in sorted((repo / d).glob(f"*-{tag}.ipynb")):
        if sib.name == Path(rel).name:
            continue
        try:
            meta = json.loads(sib.read_text(encoding="utf-8")).get("metadata", {})
            if meta.get("kernelspec") or meta.get("language_info"):
                return meta
        except Exception:
            continue
    return {}


# A target's language tag names the only kernelspec its notebook may declare. Measured
# 22/11 on CoursIA#27996 (Complexity-07c-…-Rust): the queue's --meta-from pointed at the
# C# twin (the porting reference), so the Rust port shipped `.net-csharp` metadata while
# --kernel-override rust executed it — every gate green, the maintainer's review red.
TAG_KERNELS = {"Rust": "rust", "CSharp": ".net-csharp"}


def tag_kernel(rel: str) -> str | None:
    """Kernelspec name the target's language tag requires (None: tag not constrained)."""
    stem = Path(rel or "").stem
    return TAG_KERNELS.get(stem.rsplit("-", 1)[1]) if "-" in stem else None


def meta_for_kernel(repo: Path, rel: str, kernel_name: str) -> dict:
    """kernelspec + language_info of an existing notebook whose kernelspec IS kernel_name:
    the target's folder first (tag siblings, then any), then the notebook tree's siblings
    carrying the same tag. {} when none — the caller refuses before any spend."""
    d, stem = Path(rel).parent, Path(rel).stem
    tag = stem.rsplit("-", 1)[1] if "-" in stem else ""
    pools = [sorted((repo / d).glob(f"*-{tag}.ipynb")) if tag else [],
             sorted((repo / d).glob("*.ipynb"))]
    if tag:
        pools.append(sorted(repo.glob(f"MyIA.AI.Notebooks/**/*-{tag}.ipynb")))
    seen: set = set()
    for pool in pools:
        for nb in pool:
            if nb.name == Path(rel).name or nb in seen:
                continue
            seen.add(nb)
            try:
                meta = json.loads(nb.read_text(encoding="utf-8")).get("metadata", {})
            except Exception:
                continue
            if (meta.get("kernelspec") or {}).get("name") == kernel_name:
                out = {k: meta[k] for k in ("kernelspec", "language_info") if k in meta}
                out["_from"] = nb.relative_to(repo).as_posix()
                return out
    return {}


def align_kernelspec(built_nb: Path, repo: Path, rel: str, kname: str) -> dict | None:
    """Deterministic metadata repair before the gates: a draft whose declared kernelspec is
    not the kernel that executed it (and that the target's tag requires) gets the metadata
    of a notebook that declares that kernel. Outputs are untouched — they came from kname.
    None when nothing to do or no donor (the kernelspec gate then reports it)."""
    want = tag_kernel(rel) or kname
    if not want or (kname and want != kname):
        return None                      # executed on another kernel: the gate must refuse
    nb = json.loads(built_nb.read_text(encoding="utf-8"))
    meta = nb.get("metadata") or {}
    have = (meta.get("kernelspec") or {}).get("name")
    if have == want:
        return None
    donor = meta_for_kernel(repo, rel, want)
    if not donor:
        return None
    meta.update({k: v for k, v in donor.items() if k != "_from"})
    nb["metadata"] = meta
    built_nb.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return {"from": have, "to": want, "donor": donor["_from"],
            "language_version": (donor.get("language_info") or {}).get("version")}


CS_VIEW_MAX = 40_000   # a REFERENCE view (C# twin), smaller than the authoritative Python one


def csharp_sibling(src_nb: Path) -> Path | None:
    """The C# twin of a Python source when the series ported one (user 22/11: read Python
    AND C# when porting — the C# port's structure, translation comments and library choices
    inform the target port; the Python stays authoritative for prose and values). The model
    cannot read it itself: its terminal cwd is not the grain's worktree (measured 21/11,
    10 293 tokens walking the wrong tree), so the harness inlines the view instead."""
    name = src_nb.name
    if not name.endswith("-Python.ipynb"):
        return None
    cand = src_nb.with_name(name[: -len("-Python.ipynb")] + "-CSharp.ipynb")
    return cand if cand.is_file() else None


def build_view(nb_path: Path, max_chars: int = 120_000) -> str:
    """Whole-notebook view. Overflow is DECLARED, never silent: a cut view makes the model
    plan against a notebook whose footer it cannot see (measured 14/11: 37-cell notebook,
    view cut at 20 000 chars -> plan said "insert a footer after cell 19", 17 cells lost)."""
    nb = json.loads(nb_path.read_text(encoding="utf-8"))
    cells = nb.get("cells", [])
    parts, used, shown = [], 0, 0
    for i, cell in enumerate(cells):
        block = f"=== cellule {i} | {cell.get('cell_type')} ===\n{_text(cell.get('source'))}"
        if used + len(block) > max_chars and shown:
            break
        parts.append(block)
        used += len(block)
        shown += 1
    head = f"[Vue : {len(cells)} cellules au total ; {shown} affichées en entier.]"
    if shown < len(cells):
        rest = [f"ATTENTION — vue TRONQUÉE : les cellules {shown}..{len(cells) - 1} ne sont pas "
                "affichées ; le carnet CONTINUE après la dernière cellule montrée "
                "(ce n'est pas le pied de carnet). Index du reste :"]
        for j in range(shown, len(cells)):
            first = next((ln.strip() for ln in _text(cells[j].get("source")).splitlines()
                          if ln.strip()), "")
            rest.append(f"- {j} | {cells[j].get('cell_type')} | {first[:120]}")
        rest.append("Si ton plan touche une cellule non affichée, dis-le explicitement et "
                    "n'invente pas son contenu.")
        parts.append("\n".join(rest))
    return head + "\n\n" + "\n\n".join(parts)


def series_context(repo: Path, rel: str, max_headers: int = 10) -> str:
    d = str(Path(rel).parent).replace("\\", "/")
    names = subprocess.run(["git", "-C", str(repo), "ls-files", "-z", f"{d}/*.ipynb"],
                           capture_output=True, text=True, encoding="utf-8").stdout.split("\0")
    names = sorted(n for n in names if n and "/" not in n[len(d) + 1:])
    me = rel.replace("\\", "/")
    lines = [f"Série {d} — {len(names)} carnets ; celui-ci en position "
             f"{names.index(me) + 1 if me in names else '?'}."]
    for n in names:
        if n >= me:
            break
        try:
            nb = json.loads((repo / n).read_text(encoding="utf-8"))
        except Exception:
            continue
        heads = [ln.strip() for c in nb.get("cells", []) if c.get("cell_type") == "markdown"
                 for ln in _text(c.get("source")).splitlines() if ln.startswith("#")]
        lines.append(f"- {Path(n).name} : " + " | ".join(heads[:max_headers]))
    return "\n".join(lines)


def _json_candidates(text: str) -> list[str]:
    """Where the answer's JSON object may sit, most plausible first.

    The LAST fenced block is the model's final answer. The outermost-brace slice comes after
    it: it catches an unfenced answer behind a reasoning preamble, and a fenced answer the
    non-greedy fence regex cut short because a cell's own source contains a ``` fence."""
    cands = list(reversed(re.findall(r"```json\s*(\{.*?\})\s*```", text, re.S)))
    i, j = text.find("{"), text.rfind("}")
    if i >= 0 and j > i and text[i:j + 1] not in cands:
        cands.append(text[i:j + 1])
    return cands


def parse_json_report(text: str) -> tuple[dict | None, str]:
    """(parsed object, "") or (None, the decoder's error on the most plausible candidate).

    `strict=False` accepts raw control characters inside strings: a literal newline or tab
    in a cell's source is the commonest malformation of a long build answer, and its
    meaning is unambiguous (po-2028:claudish, 20/11 — stage-2 answers unreadable on literal
    newlines). An unescaped quote is NOT guessed here: where the string ends is ambiguous,
    and a wrong guess would write a silently different cell. That case goes back to the
    model with this error (`parse_or_repair`)."""
    bare = text.strip()
    if bare[:1] in ("{", "["):
        # A bare answer that decodes is final, whatever its shape: a well-formed list is a
        # wrong answer, not a format slip, and is never mined for an inner object.
        try:
            obj = json.loads(bare, strict=False)
        except json.JSONDecodeError:
            pass
        else:
            if isinstance(obj, dict):
                return obj, ""
            return None, f"la réponse est un JSON {type(obj).__name__}, pas un objet"
    err = ""
    for cand in _json_candidates(text):
        try:
            obj = json.loads(cand, strict=False)
        except json.JSONDecodeError as exc:
            if not err:
                lo = max(0, exc.pos - 80)
                err = (f"{exc.msg} (ligne {exc.lineno}, colonne {exc.colno}), "
                       f"près de : {cand[lo:exc.pos + 80]!r}")
            continue
        if isinstance(obj, dict):
            return obj, ""
    return None, err or "aucun objet JSON dans la réponse"


def parse_json_block(text: str) -> dict | None:
    return parse_json_report(text)[0]


# ---------------------------------------------------------------- prompts
def _cut(text: str, limit: int, label: str, tail: bool = False) -> str:
    """Cut with a DECLARED marker: a silent cut makes the model invent what it cannot see
    (measured 14/11: Epic body 20 245 chars cut at 6 000 -> the canonical footer wording,
    which lives at char ~16 700, was never shown and the plan invented a `## Provenance`)."""
    text = text or ""
    if len(text) <= limit:
        return text
    body = text[-limit:] if tail else text[:limit]
    where = f"les {limit} derniers" if tail else f"les {limit} premiers"
    return (f"{body}\n\n[ATTENTION — {label} TRONQUÉ : {len(text)} caractères au total, "
            f"{where} seulement sont affichés.]")


def read_conventions(path: str | None) -> str:
    if not path:
        return ""
    p = Path(path)
    try:
        return p.read_text(encoding="utf-8").strip() if p.is_file() else ""
    except Exception:
        return ""


def plan_prompt(issue_n: int, issue: dict, rel: str, kernel: dict, ctx: str, view: str,
                conventions: str = "") -> str:
    return (
        f"MODE CONSTRUCTION — tu n'audites pas, tu prépares une modification de carnet pour l'issue "
        f"jsboige/CoursIA#{issue_n}.\n\n"
        f"## Issue\nTITRE : {issue['title']}\n\n"
        f"CORPS :\n{_cut(issue['body'], 30000, 'corps de l issue')}\n\n"
        f"## Fil (extrait récent)\n{_cut(issue['comments'], 8000, 'fil de l issue', tail=True)}\n\n"
        + (f"## Conventions de livraison (imposées)\n{conventions}\n\n" if conventions else "")
        + f"## Carnet cible : {rel} (branche origin/main)\n"
        f"Noyau canonique de la série : {kernel['kernel_name']} "
        f"(version des voisins : {kernel['canonical_version']} — {kernel['neighbour_versions']})\n\n"
        f"## Contexte de série\n{ctx}\n\n"
        f"## Carnet actuel\n{view}\n\n"
        "Rends UNIQUEMENT un bloc ```json :\n"
        '{"plan":[{"cell":<index>,"geste":"edit|insert_after|delete",'
        '"to":"<code|markdown — uniquement si le geste convertit le type de la cellule>",'
        '"but":"..."}],'
        '"execute_cells":[<index des cellules code concernées, carnet d ORIGINE>],'
        '"expectations":["..."],"risques":["..."]}\n'
        "`execute_cells` vide si le geste est markdown seul. Tout index (`cell`, `after`, "
        "`execute_cells`) est un index du carnet d'ORIGINE ; le harnais remappe après "
        "suppressions/insertions."
    )


def spec_prompt(issue_n: int, issue: dict, rel: str, kernel: dict, ctx: str, view: str,
                conventions: str = "") -> str:
    """Pre-chew turn (#4831): a rough issue becomes a hyper-detailed one, READY FOR THE
    CODER. The output is the working issue body of stage 1 — prose, not JSON: the coder
    turn parses it as an issue, exactly like a human-detailed issue would be parsed."""
    return (
        f"MODE SPÉCIFICATION — l'issue jsboige/CoursIA#{issue_n} est trop grossière pour être "
        f"donnée telle quelle au codeur. Tu la pré mâches : tu réécris l'issue en une issue "
        f"HYPER-DÉTAILLÉE, prête pour le codeur.\n\n"
        f"## Issue brute\nTITRE : {issue['title']}\n\n"
        f"CORPS :\n{_cut(issue['body'], 30000, 'corps de l issue')}\n\n"
        f"## Fil (extrait récent)\n{_cut(issue['comments'], 8000, 'fil de l issue', tail=True)}\n\n"
        + (f"## Conventions de livraison (imposées)\n{conventions}\n\n" if conventions else "")
        + f"## Carnet cible : {rel} (branche origin/main)\n"
        f"Noyau canonique de la série : {kernel['kernel_name']} "
        f"(version des voisins : {kernel['canonical_version']} — {kernel['neighbour_versions']})\n\n"
        f"## Contexte de série\n{ctx}\n\n"
        f"## Carnet actuel\n{view}\n\n"
        "Rends UNIQUEMENT le corps de l'issue rédigée (markdown, pas de bloc json, pas de "
        "préambule). Elle doit contenir, dans cet ordre :\n"
        "1. **Objectif** — ce que le carnet doit démontrer, en une phrase.\n"
        "2. **Critères d'acceptation** — une liste cochable, chaque critère testable sur le "
        "contenu du carnet (pas sur l'intention).\n"
        "3. **Plan cellule par cellule** — pour CHAQUE cellule à créer ou modifier : index "
        "(carnet d'origine), type, contenu attendu décrit assez précisément pour écrire le "
        "code sans rouvrir l'issue brute, dépendances entre cellules.\n"
        "4. **Sorties attendues** — ce que l'exécution doit afficher/produire, cellule par "
        "cellule concernée.\n"
        "5. **Pièges** — erreurs classiques du domaine (API, noyau, sérialisation), ce qu'il "
        "faut éviter.\n"
        "Reprends TOUT le contenu utile de l'issue brute et du fil : la spec REMPLACE "
        "l'issue pour le codeur, elle ne la résume pas — une information perdue ici est "
        "perdue pour la livraison."
    )

SPEC_BODY_CAP = 30_000   # the spec becomes stage 1's issue body: same cap as plan_prompt's


def spec_skip_trace(issue_body_chars: int) -> dict:
    """Trace of the declared short-circuit (#4831): the spec step is skipped because the
    CALLER declared the issue detailed enough — never a harness heuristic."""
    return {"mode": "skip", "skipped": True, "declared": "--spec-mode skip",
            "issue_body_chars": issue_body_chars}


def build_prompt(scratch_nb: str, plan: dict, execute_ids: list, src_cells: list,
                 n_cells: int, conventions: str = "") -> str:
    """Edit prompt: the harness already made the copy, the model only applies the plan.

    Measured 14/11 (attempt 2): asking for "the entirety of the notebook, exact sources, no
    outputs" made the model re-emit what it had seen and drop everything past the view."""
    current = []
    for p in plan.get("plan") or []:
        if p.get("geste") != "edit":
            continue
        try:
            i = int(p["cell"])
            current.append(f"=== cellule {i} — source ACTUELLE (à remplacer intégralement) ===\n"
                           f"{_text(src_cells[i].get('source'))}")
        except Exception:
            continue
    return (
        "TOUR 2 — applique le plan sur le carnet de travail. "
        f"Le fichier EXISTE DÉJÀ à {scratch_nb} : c'est une copie exacte du carnet cible "
        f"({n_cells} cellules, outputs inclus). N'utilise PAS create_notebook — il écraserait "
        "la copie.\n\n"
        "Outils papermill autorisés, rien d'autre :\n"
        "- `update_cell` {path, index, source} pour un geste `edit` ;\n"
        "- `add_cell` {path, cell_type, source, index} pour un geste `insert_after` "
        "(index = position d'insertion 0-based = cellule_ancre + 1) ;\n"
        "- `remove_cell` {path, index} pour un geste `delete`.\n"
        "N'ÉCRIS QUE les cellules du plan ; toute autre cellule doit rester intacte — le harnais "
        "compare le résultat à la source et rejette tout écart (nombre de cellules, cellules non "
        "prévues modifiées, outputs perdus).\n\n"
        f"Plan validé : {json.dumps(plan, ensure_ascii=False)[:6000]}\n\n"
        + (f"Conventions de livraison (imposées) :\n{conventions}\n\n" if conventions else "")
        + ("\n\n".join(current) + "\n\n" if current else "")
        + "Puis rends UNIQUEMENT un bloc ```json :\n"
        '{"cells_written":<n>,"gestures_done":[{"cell":<index>,"tool":"update_cell|add_cell|remove_cell"}],'
        '"notes":"..."}\n'
        f"Cellules que le harnais exécutera ensuite : {execute_ids or 'aucune'}."
    )


# ---------------------------------------------------------------- structural verdict
def build_json_prompt(plan: dict, execute_ids: list, src_cells: list, n_cells: int,
                      conventions: str = "") -> str:
    """JSON write mode: the model returns the new cell sources, the harness applies them with
    ONE write. Measured 14/11: three parallel MCP write calls -> two silent lost updates."""
    current = []
    for p in plan.get("plan") or []:
        if p.get("geste") != "edit":
            continue
        try:
            i = int(p["cell"])
            current.append(f"=== cellule {i} — source ACTUELLE (à remplacer intégralement) ===\n"
                           f"{_text(src_cells[i].get('source'))}")
        except Exception:
            continue
    return (
        "TOUR 2 — rends les cellules à écrire. Le harnais les appliquera lui-même sur une copie "
        f"exacte du carnet ({n_cells} cellules, outputs inclus) ; tu n'écris aucun fichier et tu "
        "n'appelles aucun outil d'écriture.\n\n"
        f"Plan validé : {json.dumps(plan, ensure_ascii=False)[:6000]}\n\n"
        + (f"Conventions de livraison (imposées) :\n{conventions}\n\n" if conventions else "")
        + ("\n\n".join(current) + "\n\n" if current else "")
        + "Rends UNIQUEMENT un bloc ```json :\n"
        '{"edits":[{"cell":<index>,"source":"<source COMPLET de remplacement>",'
        '"cell_type":"<code|markdown — UNIQUEMENT si le plan déclare une conversion de type>"}],'
        '"deletes":[<index du carnet d ORIGINE>...],'
        '"inserts":[{"after":<index>,"cell_type":"markdown|code","source":"<source complet>"}],'
        '"notes":"..."}\n'
        "Règles : source COMPLET (pas un diff), aucune cellule hors plan, `after` = index de "
        "l'ancre dans le carnet d'origine, une seule entrée par geste du plan ; `deletes` "
        "reprend les gestes delete du plan (tableau vide s'il n'y en a pas)."
    )


def apply_edits(nb_path: Path, payload: dict) -> dict:
    """Deterministic applier: one read-modify-write, indexes taken on the ORIGINAL notebook.

    Order (must stay consistent with verify_structure's shift): edits on original indexes,
    then deletes (desc), then inserts (anchor desc, anchor = ORIGINAL index). A delete
    shifts every later cell by -1, so an insert anchored at `a` lands at
    a - #(deletes < a) + 1 in the post-delete array."""
    raw = nb_path.read_text(encoding="utf-8")
    nb = json.loads(raw)
    cells = nb["cells"]
    rep = {"roundtrip_ok": json.dumps(nb, ensure_ascii=False, indent=1) + "\n" == raw,
           "edits": [], "deletes": [], "inserts": [], "errors": []}
    for e in payload.get("edits") or []:
        try:
            i, new = int(e["cell"]), e["source"]
            if not 0 <= i < len(cells):
                raise IndexError(f"cell {i} hors bornes (0..{len(cells) - 1})")
            old = _text(cells[i].get("source"))
            cells[i]["source"] = _lines(new)
            entry = {"cell": i, "changed": new != old, "chars": len(new)}
            if e.get("cell_type") in ("code", "markdown"):
                ct = e["cell_type"]
                if ct != cells[i].get("cell_type"):          # declared type conversion
                    entry["type"] = f"{cells[i].get('cell_type')}->{ct}"
                    cells[i]["cell_type"] = ct
                    if ct == "markdown":
                        cells[i].pop("execution_count", None)
                        cells[i].pop("outputs", None)
                    else:
                        cells[i]["execution_count"] = None
                        cells[i]["outputs"] = []
            rep["edits"].append(entry)
        except Exception as exc:
            rep["errors"].append(f"edit: {exc}")
    deletes = sorted({int(k) for k in payload.get("deletes") or []}, reverse=True)
    n_src = len(cells)
    for k in deletes:
        try:
            if not 0 <= k < len(cells):
                raise IndexError(f"delete {k} hors bornes (0..{n_src - 1})")
            cells.pop(k)                                     # desc: earlier indexes stay valid
            rep["deletes"].append(k)
        except Exception as exc:
            rep["errors"].append(f"delete: {exc}")
    taken = {c.get("id") for c in cells}
    for x in sorted(payload.get("inserts") or [],
                    key=lambda v: int(v.get("after", -1)), reverse=True):
        try:
            a, src = int(x["after"]), x["source"]
            below = sum(1 for k in rep["deletes"] if k < a)
            if not 0 <= a < n_src:
                raise IndexError(f"ancre {a} hors bornes")
            pos = a - below + 1
            if any(d == a for d in rep["deletes"]):
                raise ValueError(f"ancre {a} supprimée — ancre le prédécesseur")
            cid = hashlib.sha1((str(a) + src).encode("utf-8")).hexdigest()[:8]
            while cid in taken:
                cid = hashlib.sha1((cid + src).encode("utf-8")).hexdigest()[:8]
            taken.add(cid)
            ct = x.get("cell_type") or "markdown"
            new_cell = {"cell_type": ct, "id": cid, "metadata": {}, "source": _lines(src)}
            if ct == "code":
                new_cell |= {"execution_count": None, "outputs": []}
            cells.insert(pos, new_cell)
            rep["inserts"].append({"after": a, "built_pos": pos, "type": ct,
                                   "chars": len(src), "id": cid})
        except Exception as exc:
            rep["errors"].append(f"insert: {exc}")
    nb_path.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    rep["wrote"] = True
    return rep


def _cells(path: Path) -> list:
    return json.loads(path.read_text(encoding="utf-8")).get("cells", [])


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def verify_structure(src_path: Path, built_path: Path, plan: dict) -> dict:
    """Mechanical proof the deliverable is a MINIMAL EDIT of the source, not a rewrite.

    The first dry pass (14/11) produced a 21-cell notebook from a 37-cell source and the
    "file exists" verdict accepted it: that is the hole this closes."""
    src, built = _cells(src_path), _cells(built_path)
    gestures = plan.get("plan") or []
    edits = {int(p["cell"]) for p in gestures
             if p.get("geste") == "edit" and str(p.get("cell", "")).isdigit()}
    deletes = {int(p["cell"]) for p in gestures
               if p.get("geste") == "delete" and str(p.get("cell", "")).isdigit()}
    anchors = [int(p["cell"]) for p in gestures
               if p.get("geste") == "insert_after" and str(p.get("cell", "")).isdigit()]
    convert = {int(p["cell"]): p["to"] for p in gestures
               if p.get("geste") == "edit" and str(p.get("cell", "")).isdigit()
               and p.get("to") in ("code", "markdown")}
    s_src = [_text(c.get("source")) for c in src]
    s_b = [_text(c.get("source")) for c in built]

    def shift(i: int) -> int:
        return i + sum(1 for a in anchors if a < i) - sum(1 for k in deletes if k < i)

    d = {"src_cells": len(src), "built_cells": len(built),
         "edits": sorted(edits), "deletes": sorted(deletes), "inserts": len(anchors),
         "type_conversions": sorted(convert)}
    d["count_ok"] = len(built) == len(src) - len(deletes) + len(anchors)
    d["anchors_on_deleted"] = sorted(set(anchors) & deletes)

    untouched = [i for i in range(len(src)) if i not in edits | deletes]
    j, missing = 0, None
    for i in untouched:                      # verbatim, in order (index-agnostic)
        while j < len(s_b) and s_b[j] != s_src[i]:
            j += 1
        if j >= len(s_b):
            missing = i
            break
        j += 1
    d["untouched_ok"] = missing is None
    d["missing_cell"] = missing

    detail, edits_ok = [], True
    for i in sorted(edits):
        pos = shift(i)
        want_type = convert.get(i) or src[i].get("cell_type")
        detail.append({"cell": i, "built_pos": pos,
                       "type_ok": 0 <= pos < len(built)
                                  and built[pos].get("cell_type") == want_type,
                       "changed": 0 <= pos < len(s_b) and s_b[pos] != s_src[i]})
        edits_ok = edits_ok and detail[-1]["type_ok"] and detail[-1]["changed"]
    d["edits_detail"] = detail
    d["edits_ok"] = edits_ok

    lost = []
    for i in untouched:
        if src[i].get("cell_type") == "code" and (src[i].get("outputs") or []):
            pos = shift(i)
            if pos >= len(built) or not (built[pos].get("outputs") or []):
                lost.append(i)
    d["outputs_lost"] = lost
    d["outputs_ok"] = not lost

    # an insert_after must actually land right after its anchor: a Provenance block dropped in
    # the middle of a 37-cell notebook passes count/order checks but is not the intended footer
    ins_detail, ins_ok = [], True
    for a in anchors:
        pos_a = shift(a)
        nxt = pos_a + 1
        if a + 1 >= len(src):
            # insert after the LAST source cell: it must really be the tail of the notebook
            landed = nxt < len(built) and s_b[len(built) - 1] != s_src[len(src) - 1]
        else:
            landed = nxt < len(built) and s_b[nxt] != s_src[a + 1]
        ins_detail.append({"anchor": a, "built_pos": pos_a + 1, "landed": landed})
        ins_ok = ins_ok and landed
    d["inserts_detail"] = ins_detail
    d["inserts_ok"] = ins_ok
    d["ok"] = (all(d[k] for k in ("count_ok", "untouched_ok", "edits_ok", "outputs_ok", "inserts_ok"))
               and not d["anchors_on_deleted"])
    return d


# ---------------------------------------------------------------- creation mode (--source-nb)
LOCAL_MODULE_DEF_CAP = 24   # signatures listed per local module
LOCAL_MODULE_FILE_CAP = 12  # files listed per imported package
LOCAL_MODULE_TOTAL_CAP = 24  # entries across every import, prompt stays bounded
                             # (o14: 7 named leaves + up to 4 promoted siblings must
                             # fit before the alphabetical signature fill)
LOCAL_MODULE_RENDER_DEF_CAP = 6   # signatures RENDERED per module in the prompt block
                                   # (o8 ICT: 24x13 rendered signatures = ~61k-token stage-2
                                   #  prompts, unparseable stub answers)
LOCAL_MODULE_BLOCK_CHAR_CAP = 6000  # signature-listing part of the block
LOCAL_MODULE_SOURCE_FILE_CAP = 30000   # chars of ONE imported leaf's full source
LOCAL_MODULE_SOURCE_TOTAL_CAP = 140000  # chars across every inlined source
LOCAL_MODULE_SIBLING_SOURCE_CAP = 4    # extra leaves promoted to SOURCE (pass 1b):
                                       # the named leaves' own relative imports (o14)
# (o9 ICT, 23/11: with signatures only, the build call — a tool-less single shot —
#  answered « le contenu de basin_family.py … n'est pas disponibles dans le message,
#  et la lecture demandée précédemment a échoué » and died stage2-short-segment:0 on
#  every ICT grain. The leaf the notebook imports gets its SOURCE inline; the rest of
#  the package stays signature-only. Measured leaves: 9.8-22.8 KB each, 1-2 per grain.
#  o10 ICT, 23/11 soir: 70k was too tight for a real dependency set — ICT-15j names
#  SEVEN leaves (98 583 chars measured) and the 5th in render order (bistable.py,
#  cumulative 72 568) fell off the budget; the model's refusal named exactly that
#  file. 140k fits every measured set while still bounding the 2.5 MB package.)


def _top_level_defs(p: Path) -> list[str]:
    try:
        txt = p.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []
    # the signature may span lines (detect_regime does) — `[^)]*` crosses newlines
    return [f"{fn}({' '.join(a.split())})"[:160]
            for fn, a in re.findall(r"^def\s+(\w+)\s*\(([^)]*)\)", txt, re.M)
            ][:LOCAL_MODULE_DEF_CAP]


def _ancestor_roots(folder: Path) -> list[Path]:
    """The notebook's folder and its first two ancestors -- never past the worktree root.

    The root is the first `.git` walking up (a FILE in a linked worktree, a dir in a main
    checkout): the anchor `_worktree_rel` already reads. The runs' worktrees lie side by
    side (`.tmp/nbst/o14/worktrees/<grain>/…`), so a notebook sitting AT its worktree root
    walked two levels up, into its neighbours' material (#1885 review). With no `.git`
    above -- a bare folder, a relative path in a test -- no boundary is known and the walk
    stays what it was."""
    stop = next((d for d in (folder, *folder.parents) if (d / ".git").exists()), None)
    # a root is kept when it IS the worktree root or lies inside it -- dropped when the
    # root is one of ITS parents (it sits above the boundary)
    return [r for r in (folder, *list(folder.parents)[:2])
            if stop is None or r == stop or stop in r.parents]


def _resolve_import(folder: Path, dotted: str) -> list[Path]:
    """Files one import names: `<module>.py`, or every `<pkg>/*.py` for a package.

    Searched in the notebook's folder, then its first two ancestors inside its worktree
    (`_ancestor_roots`). Series
    folders keep their package one level ABOVE the notebook folder (measured
    23/11, CoursIA#27740/#27737: `ICT-Series/ict/` imported from
    `ICT-Series/ICT-15-IntegratedComplexity/ICT-15j-…`); the beside-the-notebook
    rule alone found nothing, the coder refused to invent the module — correctly —
    and stage 2 died `short-segment` on both grains. The notebook's own
    `sys.path.insert(0, Path('.').resolve())` is what makes those ancestors
    importable at execution time; this walk mirrors it, bounded to two levels.
    """
    parts = [p for p in dotted.split(".") if p]
    if not parts:
        return []
    for root in _ancestor_roots(folder):
        base = root.joinpath(*parts)
        if base.with_suffix(".py").is_file():
            return [base.with_suffix(".py")]
        if (base / "__init__.py").is_file():
            return [base / "__init__.py"] + sorted(base.glob("*.py"))[:LOCAL_MODULE_FILE_CAP]
    return []


def _logical_lines(src: str) -> list[str]:
    """A cell's source as LOGICAL lines: a parenthesised continuation is ONE item.

    Built from the tokens, so a bracket inside a string or a comment opens nothing and
    a line of a docstring is never a statement. Two tokens of one row keep the SOURCE
    text between them (`import os.path` keeps its dots); a continuation joins with one
    space, and a comment leaves with its token. A cell the lexer refuses (an unterminated
    quote in a `%%bash` cell, an indentation it cannot read) falls back to its physical
    lines -- the scan as it was before #1885's review."""
    src = src.replace("\r\n", "\n").replace("\r", "\n")
    lines = src.splitlines()

    def gap(before, after) -> str:
        return lines[before[0] - 1][before[1]:after[1]] if before[0] == after[0] else " "

    out: list[str] = []
    buf: list[str] = []
    prev = None
    try:
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type in (tokenize.NEWLINE, tokenize.ENDMARKER):
                if buf:
                    out.append("".join(buf))
                buf, prev = [], None
            elif tok.type in (tokenize.NL, tokenize.COMMENT, tokenize.INDENT,
                              tokenize.DEDENT):
                continue
            else:
                if prev is not None:
                    buf.append(gap(prev, tok.start))
                buf.append(tok.string)
                prev = tok.end
    except Exception:
        return src.splitlines()
    if buf:
        out.append("".join(buf))
    return out


def _import_statements(nb) -> list[tuple[str, list[str]]]:
    """(dotted_module, [imported_names]) per import statement, in cell order.

    `from ict import basin_family as bf` -> ("ict", ["basin_family"]) — the LEAF,
    which `_resolve_import` alone never sees. `import ict.meta_proxy` ->
    ("ict.meta_proxy", []). Names strip their `as` alias and the parenthesised
    form, on one line or across several (`_logical_lines`).
    """
    out: list[tuple[str, list[str]]] = []
    for cell in nb.get("cells") or []:
        if cell.get("cell_type") != "code":
            continue
        for line in _logical_lines(_text(cell.get("source"))):
            m = re.match(r"\s*from\s+([A-Za-z_][\w.]*)\s+import\s+(.+?)\s*$", line)
            if m:
                names = [n.strip().split(" as ")[0].strip()
                         for n in m.group(2).strip("()").split(",")]
                out.append((m.group(1), [n for n in names if n]))
                continue
            m = re.match(r"\s*import\s+([A-Za-z_][\w.]*)", line)
            if m:
                out.append((m.group(1), []))
    return out


def _module_entry(folder: Path, p: Path, name: str, source: bool) -> dict:
    """One material entry. `source=True` inlines the file's text (capped); the
    build call has no tools, « lire le fichier » n'y résout rien (mesuré o9)."""
    e = {"name": name,
         "file": p.name if p.parent == folder else _worktree_rel(p),
         "defs": _top_level_defs(p)}
    if source:
        try:
            txt = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            txt = ""
        if len(txt) > LOCAL_MODULE_SOURCE_FILE_CAP:
            txt = txt[:LOCAL_MODULE_SOURCE_FILE_CAP] + \
                f"\n# … source tronquée ({len(txt)} caractères au total)\n"
        e["source"] = txt
    return e


def _sibling_imports(txt: str) -> set[str]:
    """Module names a leaf imports from its OWN package.

    Relative (`from .time_arrow import transition_matrix`, `from . import x`) and
    absolute intra-package (`from ict.time_arrow import y`) styles both reduce to
    the last segment; names that do not resolve beside the leaf drop out at the
    `.is_file()` check. Measured 23/11 (o14, CoursIA#27740):
    `ict/spectral.py:50` is `from .time_arrow import transition_matrix` — and
    time_arrow.py reached no prompt at all (pass-2 lists the package's first 12
    files alphabetically; `t` sorts past them), so the model refused to invent
    the normalisation. A founded refusal, and a material gap.
    """
    out: set[str] = set()
    for m in re.finditer(r"^\s*from\s+\.(\w+)\s+import\b", txt, re.M):
        out.add(m.group(1))
    for m in re.finditer(r"^\s*from\s+\.\s+import\s+([\w, ()]+)", txt, re.M):
        out.update(n.strip().split(" as ")[0].strip()
                   for n in m.group(1).strip("()").split(","))
    for m in re.finditer(r"^\s*(?:from|import)\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)", txt, re.M):
        out.add(m.group(1).split(".")[-1])
    return {n for n in out if n and re.fullmatch(r"\w+", n)}


def local_modules(src_nb) -> list[dict]:
    """Python modules a source notebook imports that live in its worktree.

    23/11 (CoursIA#28208): six creation turns died on the same pair of findings —
    « RegimeRps est une heuristique nouvelle, pas un port de detect_regime ». The module
    (GameTheory/limit_sets.py) sits in the worktree beside the source notebook, but no
    prompt ever showed it: the coder received the twin's CELLS only (plus prose, comments
    and outputs), then invented a replacement that the verifier rejected every round. A
    port's material is the notebook PLUS the local modules it imports.

    23/11, same day (#27740/#27737): the module is not always BESIDE the notebook —
    `ICT-Series/ict/` is a package one level above the notebook folder, so the
    beside-only rule found nothing and the model again refused to invent
    (`NerveB1Result`, `nerve_b1_substrats`, …) — both grains died
    `stage2-short-segment:0`. Imports now resolve against the notebook folder AND
    its first two ancestors, packages expand to their files, and a package named
    twice (`import ict`, `from ict.x import y`) is listed once.

    23/11 soir (fournée o9, mêmes grains, correctif borné en vol) : signatures seules =
    refus fondé — l'appel de build est un single-shot SANS outils, la réponse mesurée
    fut « le contenu de basin_family.py … ne sont pas disponibles dans le message, et
    la lecture demandée précédemment a échoué » (5 grains ICT morts
    `stage2-short-segment:0`, prompts sains à 13-19k tokens — la taille n'était plus
    en cause). Ce que le carnet NOMME (`from ict import basin_family`,
    `import ict.meta_proxy`, module beside) résout maintenant vers sa FEUILLE et
    porte sa SOURCE COMPLÈTE (bornée) ; un paquet nu (`import ict`) reste en
    signatures — la feuille importée porte ce qui manque.

    Only paths that resolve to a real `.py` are returned (numpy and friends drop
    out here).
    """
    if not src_nb:
        return []
    try:
        nb = json.loads(Path(src_nb).read_text(encoding="utf-8"))
    except Exception:
        return []
    folder = Path(src_nb).parent
    stmts = _import_statements(nb)
    out: list[dict] = []
    seen: set = set()

    def _emit(p: Path, name: str, source: bool) -> bool:
        key = p.as_posix()
        if key in seen or len(out) >= LOCAL_MODULE_TOTAL_CAP:
            return False
        seen.add(key)
        out.append(_module_entry(folder, p, name, source))
        return True

    src_paths: list[Path] = []

    # pass 1 — the leaves the notebook NAMES: from-import names that are files,
    # and every import resolving to a SINGLE file (dotted leaf, beside module)
    for dotted, names in stmts:
        for leaf in names:
            parts = [p for p in dotted.split(".") if p] + [leaf]
            for root in _ancestor_roots(folder):
                cand = root.joinpath(*parts).with_suffix(".py")
                if cand.is_file():
                    if _emit(cand, f"{dotted}.{leaf}", True):
                        src_paths.append(cand)
                    break
    for dotted, _ in stmts:
        files = _resolve_import(folder, dotted)
        if len(files) == 1:
            if _emit(files[0], dotted, True):
                src_paths.append(files[0])

    # pass 1b — the named leaves' OWN imports, one relative level (bounded): the
    # material a leaf needs is not only the leaf. o14 (23/11, CoursIA#27740):
    # spectral.py carries `from .time_arrow import transition_matrix`, time_arrow
    # never reached the prompt, and the model's refusal named exactly that gap
    # (« sa seule signature ne permet pas d'établir les conventions exactes »).
    promoted = 0
    for leaf in src_paths:
        if promoted >= LOCAL_MODULE_SIBLING_SOURCE_CAP:
            break
        try:
            txt = leaf.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for name in sorted(_sibling_imports(txt)):
            if promoted >= LOCAL_MODULE_SIBLING_SOURCE_CAP:
                break
            cand = leaf.parent / f"{name}.py"
            if cand.is_file() and _emit(cand, f"{leaf.parent.name}.{name}", True):
                promoted += 1

    # pass 2 — bare packages: signature listing only (capped), never crowding
    # out the leaves above
    for dotted, _ in stmts:
        for p in _resolve_import(folder, dotted):
            _emit(p, dotted, False)
    return out


def _worktree_rel(p: Path) -> str:
    """`p` relative to its worktree root — NEVER the absolute machine path.

    Measured 23/11 (o8, ICT grains): the ancestor-resolved files fell back to
    `p.as_posix()`, i.e. `D:/dev/claudish/.tmp/nbst/o8/worktrees/…` leaked into
    the prompt while its own header said « chemin relatif à la racine du
    worktree ». The model was told one thing and shown another. Two anchors,
    in order: the process cwd when `p` sits under it (a driver launched from
    the worktree root — and every test that chdir's into its tmp repo), then
    the first `.git` walking up (a FILE in a linked worktree, a dir in a main
    checkout). Bare filename as the last resort.
    """
    try:
        return p.resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        pass
    for d in (p.parent, *p.parent.parents):
        if (d / ".git").exists():
            try:
                return p.relative_to(d).as_posix()
            except ValueError:
                break
    return p.name


def local_module_block(modules: list | None) -> str:
    """Prompt block for the source notebook's local modules. '' when none.

    Two sections. SOURCES COMPLÈTES: every module the notebook NAMES (`from ict
    import basin_family`, `import ict.meta_proxy`, module beside the notebook)
    renders its full text, bounded per file and in total — the build call is a
    tool-less single shot, and signatures alone drew a founded refusal on every
    ICT grain of fournée o9 (23/11 : « le contenu de basin_family.py … pas
    disponibles dans le message, et la lecture demandée précédemment a échoué »,
    `stage2-short-segment:0`). SIGNATURES: the rest of a bare package stays
    listed — six signatures per file, the whole listing under
    LOCAL_MODULE_BLOCK_CHAR_CAP (the o8 lesson: 24x13 rendered signatures pushed
    stage-2 prompts to ~61k tokens and answers degraded to unparseable stubs)."""
    if not modules:
        return ""
    src_parts, list_lines, overflow = _local_module_render(modules)
    head = ("\n\nMODULES PYTHON LOCAUX DU DOSSIER SOURCE — ce carnet les importe "
            "(chemins relatifs à la racine du worktree).\n")
    parts = []
    if src_parts:
        parts.append("SOURCES COMPLÈTES des modules importés (le port se fait À PARTIR "
                     "D'ELLES — tu n'as pas d'outil de lecture) :\n\n" + "\n\n".join(src_parts))
    if list_lines:
        parts.append("Autres fichiers du paquet (signatures seulement) :\n" + "\n".join(list_lines))
    if overflow:
        parts.append(f"(+{overflow} autres modules non montrés — mêmes règles : ne rien "
                     f"inventer, porteur = le carnet source)")
    return (head + "\n\n".join(parts) +
            "\nPORTE les fonctions utilisées — mêmes seuils, mêmes constantes, mêmes "
            "libellés de verdict. N'invente JAMAIS une heuristique à la place d'une "
            "fonction d'un module ci-dessus : le vérificateur compare au module source "
            "et rejette toute réimplémentation non équivalente (mesuré CoursIA#28208 : "
            "six tours perdus à ce motif).\n")


def _local_module_render(modules: list) -> tuple[list[str], list[str], int]:
    """The two renderings a local-module list splits into, shared by every prompt that
    carries them: full sources (bounded per file and in total), signature lines for the
    rest, and the overflow count (23/11: the builder's and the verifier's block must show
    the SAME definitions — a verifier reading less than the builder cannot judge it)."""
    src_parts: list[str] = []
    src_total = 0
    list_lines: list[str] = []
    list_total = 0
    overflow = 0
    for m in modules:
        txt = m.get("source")
        if txt is not None:
            txt = txt[:LOCAL_MODULE_SOURCE_FILE_CAP]   # defensive: _module_entry
            if src_total + len(txt) <= LOCAL_MODULE_SOURCE_TOTAL_CAP or not src_parts:
                src_parts.append(f"### `{m['file']}` — module `{m['name']}`, SOURCE COMPLÈTE\n"
                                 f"```python\n{txt}\n```")
                src_total += len(txt)
                continue
            overflow += 1   # budget spent: falls through to its signature line
        defs = m["defs"][:LOCAL_MODULE_RENDER_DEF_CAP]
        more = len(m["defs"]) - len(defs)
        s = ", ".join(defs) if defs else "(aucune fonction de premier niveau)"
        if more > 0:
            s += f" … +{more} autres dans le fichier"
        line = f"- `{m['file']}` — {s}"
        if list_total + len(line) > LOCAL_MODULE_BLOCK_CHAR_CAP:
            overflow += len(modules)
            break
        list_lines.append(line)
        list_total += len(line)
    return src_parts, list_lines, overflow


def local_module_verifier_block(modules: list | None) -> str:
    """The SAME module sources, framed for the verifier. '' when none.

    23/11 soir (CoursIA#27742, fournée o18): the revision prompt had just been given the
    modules, the builder produced a faithful reimplementation and argued it — and the
    verifier rejected with « le degré du graphe des transitions observées ne peut pas
    être vérifié, à partir de la SOURCE fournie, comme équivalent à la sensibilité
    calculée par sensitivity_distribution ». Its own words named the gap: the verifier
    read less than the builder. `local_sensitivity` counts exactly those neighbours
    (`observed_adjacency`, f(y) ≠ f(x)) — the source says so, and the verifier never
    saw the source. Material AND rule travel together, on both sides of the parity."""
    if not modules:
        return ""
    src_parts, list_lines, overflow = _local_module_render(modules)
    head = ("\n\nMODULES PYTHON LOCAUX QUE LA SOURCE IMPORTE — leurs définitions ne figurent "
            "dans aucune cellule du jumeau ; la recette qu'ils portent est ici.\n")
    parts = []
    if src_parts:
        parts.append("SOURCES COMPLÈTES des modules importés — DÉFINITIONS DE RÉFÉRENCE, la "
                     "partie de la SOURCE qui ne vit pas dans ses cellules :\n\n"
                     + "\n\n".join(src_parts))
    if list_lines:
        parts.append("Autres fichiers du paquet (signatures seulement) :\n" + "\n".join(list_lines))
    if overflow:
        parts.append(f"(+{overflow} autres modules non montrés — signatures et seuls)")
    return (head + "\n\n".join(parts) +
            "\nJuge la RECETTE À L'IDENTIQUE **sur ces définitions**. Un LIVRABLE qui réécrit "
            "en C# la MÊME définition (mêmes entrées, mêmes paramètres, même quantité mesurée, "
            "mêmes sorties) est une RÉIMPLÉMENTATION FIDÈLE — le geste attendu quand la "
            "bibliothèque n'a pas d'équivalent .NET — et n'est PAS une substitution, même "
            "s'il ne subsiste aucun appel de bibliothèque dans le carnet. SUBSTITUTION, c'est "
            "une AUTRE méthode qui mesure autre chose : là, rejette en nommant, ligne à ligne, "
            "ce que la définition ci-dessus calcule et ce que le LIVRABLE calcule à sa place. "
            "N'écris jamais « ne peut pas être vérifié à partir de la SOURCE fournie » : la "
            "définition est ci-dessus, compare-les (mesuré CoursIA#27742 : huit tours de "
            "révision perdus à cette phrase, le port étant fidèle).\n")


def creation_prompt(issue_n: int, issue: dict, rel: str, source_rel: str, kernel: dict,
                    ctx: str, view: str, conventions: str = "", cs_view: str = "",
                    modules: list | None = None) -> str:
    """Stage 1 in creation mode: the target notebook does NOT exist on origin/main — the
    model plans the COMPLETE twin from the Python source + the issue's cell table.
    Measured 17/11 (#27099 dry pass): asking for FULL cell sources here returned a
    16 268-char response that never parsed — the sources belong to stage 2, in SEGMENTS.
    Stage 1 stays a LIGHT plan: one line per cell, no sources."""
    return (
        f"MODE CRÉATION — tu n'édites pas un carnet existant : tu prépares la CRÉATION COMPLÈTE "
        f"du jumeau C# pour l'issue jsboige/CoursIA#{issue_n}.\n\n"
        f"## Issue\nTITRE : {issue['title']}\n\n"
        f"CORPS :\n{_cut(issue['body'], 30000, 'corps de l issue')}\n\n"
        f"## Fil (extrait récent)\n{_cut(issue['comments'], 8000, 'fil de l issue', tail=True)}\n\n"
        + (f"## Conventions de livraison (imposées)\n{conventions}\n\n" if conventions else "")
        + f"## Carnet à CRÉER : {rel} (absent d'origin/main — sa création EST la livraison)\n"
        f"## Jumeau Python source : {source_rel} (vue complète ci-dessous)\n"
        f"Noyau canonique d'exécution : {kernel['kernel_name']}\n\n"
        f"## Contexte de série\n{ctx}\n\n"
        f"## Jumeau Python (structure à porter)\n{view}\n\n"
        + local_module_block(modules)
        + (f"## Jumeau C# du même carnet (portage antérieur — RÉFÉRENCE de traduction)\n"
           f"{cs_view}\n\n"
           "Ce port C# du même carnet éclaire ton portage : structure retenue, découpage des "
           "cellules, commentaires de traduction, choix de bibliothèques (prends les "
           "équivalents dans le langage cible de ses libs quand la spec les permet). Le "
           "jumeau PYTHON ci-dessus reste l'AUTORITÉ : prose reprise telle quelle, valeurs "
           "et ordre des sorties identiques au Python.\n\n" if cs_view else "")
        + "Le jumeau C# rejoue le MÊME fil pédagogique : une cellule du jumeau Python = une "
        "cellule du jumeau C# (markdown adapté au contexte .NET, code traduit selon la table "
        "de l'issue). Respecte les interdits de l'issue (pas de NotImplementedException, "
        "stubs `// TODO étudiant` + valeur neutre, pas d'appel réseau). La dernière cellule "
        "markdown est le pied de provenance.\n\n"
        "Rends UNIQUEMENT un bloc ```json — le PLAN, SANS les sources complètes :\n"
        '{"cells":[{"idx":<0..N-1>,"cell_type":"markdown|code","titre":"<titre ou 1ère ligne>'
        '","role":"<ce que fait cette cellule en une phrase>"}],'
        '"expectations":["..."],"risques":["..."]}\n'
        "UNE ligne par cellule du jumeau, dans l'ordre, du titre au pied de provenance. "
        "Les sources seront réclamées au tour suivant, par tranches."
    )


TWIN_COMMENTS_CAP = 1500   # chars of twin comments injected per code cell


def twin_code_comments(src: str, cap: int = TWIN_COMMENTS_CAP) -> list[str]:
    """Reading comments of a TWIN code cell, in order: Python ``#`` comments through the
    tokenizer (a ``#`` inside a string is not a comment), else ``//`` line comments (a C#
    twin). 21/11 (CoursIA#27803 review): the creation prompt pinned the twin's PROSE but
    never its code comments, so the Rust port came back with 0 comment on 106-179-line
    cells while the Python twin carried 13 — the repo's `Uncommented code` guard (#26690)
    and the reviewer both rejected it."""
    py: list[str] = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type == tokenize.COMMENT and not tok.string.startswith("#!"):
                t = tok.string.lstrip("#").strip()
                if t:
                    py.append(t)
    except (tokenize.TokenError, IndentationError, SyntaxError):
        py = []
    found = py or [ln.strip()[2:].strip() for ln in src.splitlines()
                   if ln.strip().startswith("//") and ln.strip()[2:].strip()]
    kept: list[str] = []
    used = 0
    for t in found:
        if used + len(t) > cap:
            kept.append(f"[… {len(found) - len(kept)} commentaire(s) de plus, coupés ici]")
            break
        kept.append(t)
        used += len(t)
    return kept


# Rules every creation segment carries (21/11, Hermes reviews of CoursIA#27803/#27804/#27805:
# links translit'd to `-Rust` neighbours that do not exist, twin prose counts copied
# verbatim and refused by prose-counts #17636). The stage-3 repo guards check the same.
CREATION_LINK_COUNT_RULES = (
    "Règles de livraison vérifiées par les gardes du dépôt :\n"
    "- LIENS : aucun lien vers un fichier qui n'existe pas. Ne translittère JAMAIS le "
    "suffixe d'un voisin (`…-Python.ipynb` → `…-Rust.ipynb`) : un voisin n'existe dans le "
    "langage cible que si le dépôt le contient. En cas de doute, garde la cible du jumeau.\n"
    "- COMPTAGES : la garde du dépôt refuse en markdown tout chiffre suivi de « lignes », "
    "« cellules », « modules », « fichiers » ou « notebooks » (règle #9377). Si la phrase "
    "recopiée mesure un artefact ou une durée (« ~80 lignes », « ~20 min »), retire la "
    "mesure et garde le prédicat. Si le chiffre compte des DONNÉES du calcul (les cellules "
    "d'une matrice ou d'une grille), garde le chiffre et change le nom : « 10 cellules sur "
    "24 » devient « 10 cases sur 24 ». Ce sont les SEULES retouches permises de la prose "
    "du jumeau.\n"
    "- COMMENTAIRES : une cellule de code longue (8 lignes ou plus) porte des commentaires "
    "de lecture ; reporte ceux du jumeau quand ils sont fournis.\n")

# 22/11 salvage: two reject classes the verifier kept finding round after round.
# (1) CoursIA#28102 — every exercise stub was paired with an « expected results » block
#     that computed the answer, hidden behind a `false` switch: 4 major findings.
# (2) ICT-15 c/d/j/k — the twin draws its data from numpy (PCG64 + SeedSequence +
#     ziggurat normals); hand-rolled generators drew other data, so every value diverged,
#     and pasting the twin's OUTPUTS under computed columns was rejected as well.
PORT_CONTENT_RULES = (
    "Règles de contenu vérifiées par le relecteur indépendant :\n"
    "- EXERCICES : une cellule d'exercice ne contient JAMAIS sa solution, ni active, ni "
    "désactivée par un commutateur, ni rangée dans un bloc de « résultats attendus » qui la "
    "calcule. Le stub rend une valeur neutre ; un contrôle éventuel compare à des valeurs "
    "de référence FIGÉES (littéraux), jamais à un calcul qui implémente la réponse.\n"
    "- CALCULS ≠ EXERCICES : toutes les mesures, comparaisons et verdicts que le jumeau "
    "Python affiche doivent être CALCULÉS ET EXÉCUTÉS par les cellules ORDINAIRES de ton "
    "carnet, avec leurs sorties réelles. Une cellule d'exercice est un AJOUT pédagogique "
    "(stub // TODO étudiant) : jamais le remplacement d'un calcul de la source. Un carnet "
    "dont les cellules principales rendent des zéros neutres, des TODO, ou renvoient à "
    "l'exercice pour obtenir le résultat est rejeté (mesuré 23/11, fournée o13 : 2 carnets "
    "rejetés sur 4 tours à ce seul motif). De même, TOUS les régimes et étapes que la "
    "source calcule doivent être calculés — jamais « R0/R1 restent à compléter ».\n"
    "- EXERCICES DE LA SOURCE, RIEN DE PLUS : les cellules d'exercice de ton carnet "
    "reproduisent les exercices que le jumeau Python pose LUI-MÊME, et seulement ceux-là. "
    "Une cellule de DÉFINITION de la source — une fonction qu'elle donne toute faite, "
    "`centre_m`, `predire_recolle`, `session_bookmaker` — se reproduit à l'identique comme "
    "cellule ORDINAIRE, jamais convertie en stub. Ne dédouble jamais une fonction de la "
    "source en un stub `<nom>` plus une cellule `<nom>_calcule` qui en donne la réponse : "
    "le stub n'est alors pas sans solution et le calcul est un doublon (mesuré 23/11, "
    "fournée o14, CoursIA#27741 : 2 findings majeurs « solution révélée », les stubs "
    "`centre_m`/`predire_recolle` doublés par `centre_calcule`/`predire_calcule`). Si la "
    "source ne pose pas d'exercice sur un point, tu n'en inventes pas. Le tableau "
    "« Cellules à porter » de l'issue est INDICATIF (archetype = « classification "
    "voltron heuristique », équivalents .NET « indicatifs à affiner par le producteur ») : "
    "une cellule que le jumeau EXÉCUTE et dont il affiche les sorties reste une cellule "
    "ordinaire même si la colonne dit « exercice » — la stubber casse la clause de "
    "parité numérique. Le quota d'exercices se satisfait sur les cellules d'exercice "
    "RÉELLES du jumeau (« Exercice N » en markdown, `# TODO etudiant`).\n"
    "- AUCUNE CELLULE OMISE : rendre un segment partiel (des cellules absentes de ta "
    "réponse) tue la génération ENTIÈRE — le harnais s'arrête sur le premier segment "
    "incomplet (mesuré 23/11, fournée o14 : « cellules 12 et 14 non fournies » = "
    "stage2-short-segment:8, zéro tour de vérification). Une dépendance absente des "
    "cellules précédentes ne justifie ni une cellule vide, ni une cellule retirée : le "
    "jumeau Python porte le code de référence, écris-le toi-même dans la cellule. "
    "Chaque cellule du segment demandé est livrée, entière.\n"
    "- RECETTE À L'IDENTIQUE : si la source obtient une mesure par un appel de "
    "bibliothèque (`SP.spectral_summary`, `SE.sensitivity_distribution`, "
    "`SM.make_strategies`…), appelle l'équivalent C# de CETTE bibliothèque. Ne lui "
    "substitue jamais un proxy, une approximation ou une implémentation maison qui mesure "
    "AUTRE CHOSE (mesuré 23/11, fournée o13 : proxys de graphe à la place du spectre, "
    "simulation manuelle à la place de l'évolution de population). Réimplémenter est "
    "légitime quand l'équivalent C# n'existe pas, à condition de reproduire l'ALGORITHME "
    "de la source à l'identique — mêmes définitions, mêmes paramètres, même quantité "
    "mesurée.\n"
    "- BIBLIOTHÈQUE PYTHON SANS ÉQUIVALENT C# (gudhi, networkx, scipy.stats…) : ce "
    "n'est ni un motif de refus, ni une raison de cellule vide. Réimplémente "
    "l'ALGORITHME de la bibliothèque sur les structures C# standard (union-find, tri, "
    "BFS, tableau), borné à la taille que le carnet utilise réellement (un nuage de "
    "30 points → filtration de Rips complète, triviale à cette taille), vérifie-le sur "
    "un cas jouet à réponse connue et atteste-le en prose. Un refus de génération "
    "invoquant une simulation, un proxy ou une bibliothèque « impossibles à porter » "
    "est un ÉCHEC du carnet : le port est toujours faisable en découpant le calcul en "
    "étapes DANS la cellule et en bornant les tailles (grilles, pas de temps, "
    "itérations, tous déjà fixés par le jumeau). Mesuré 23/11, fournée o15, "
    "CoursIA#27740 : « Je ne peux pas fournir un port complet et fidèle des "
    "simulations et des proxys dans cette tranche » → stage2-short-segment:0, deux "
    "tours perdus alors que la source était dans le prompt.\n"
    "  · La frontière du droit de réécrire est celle du CALCUL, pas de la main qui "
    "l'écrit : réécrire en C# la MÊME définition que la fonction source (mêmes "
    "entrées, mêmes paramètres, même quantité, mêmes sorties) est une "
    "RÉIMPLÉMENTATION — le geste ATTENDU quand la bibliothèque manque — jamais une "
    "substitution. Substituer, c'est mettre à sa place une AUTRE méthode qui mesure "
    "autre chose (un TPM/laplacien à la place de `spectral_summary`, un proxy de "
    "graphe à la place de la persistance de Rips) : celle-là est interdite. Refuser "
    "d'écrire le calcul parce qu'on craint de « substituer un calcul non "
    "équivalent » est donc un ÉCHEC : écris la réimplémentation fidèle, compare au "
    "jumeau, et si un écart subsiste, nomme-le et déclare la tolérance (règle "
    "RECETTE À L'IDENTIQUE). Mesuré 23/11, fournée o16, CoursIA#27740 : refus à la "
    "première cellule, « sans risquer de substituer un calcul non équivalent ».\n"
    "- ALÉA NUMPY : si le jumeau tire ses DONNÉES d'un générateur numpy (`default_rng`, "
    "PCG64, SeedSequence, `normal`), deux cas :\n"
    "  · tirage PETIT et VISIBLE dans les sorties du jumeau → reprends les données "
    "d'ENTRÉE tirées par le jumeau sous forme de tableau littéral COMPLET — jamais "
    "tronqué, jamais laissé vide (26/11, o41 : un carnet a rejeté « les flux uniformes "
    "NumPy cités ne sont pas renseignés »). Dis-le en prose (« données tirées par le "
    "jumeau, reprises telles quelles »), puis CALCULE tous les résultats à partir d'elles "
    "ET COMPARE ces résultats recalculés à ceux que le jumeau affiche, sous une "
    "tolérance déclarée. Ne recopie jamais une SORTIE du jumeau à la place d'un calcul, "
    "et ne garde jamais la comparaison derrière un test que le tableau vide rend faux.\n"
    "  · protocole MONTE-CARLO (trajectoires, milliers de tirages, seuls des agrégats "
    "sont visibles) → PORTE LE PROTOCOLE : même graine déclarée, même loi, même taille "
    "d'échantillon, mêmes seuils, avec un RNG cible seedé (convention des jumeaux "
    "ICT-15/15h, #27734 : xorshift64*). Les quantités DÉTERMINISTES sortent identiques "
    "au dernier chiffre affiché ; les quantités STOCHASTIQUES sont TES résultats réels, "
    "et la prose nomme l'écart (« graine fixe, RNG différent de numpy : source +0.471, "
    "ce carnet +0.427 »). Un jumeau C# exécute POUR DE VRAI : jamais de cellule "
    "« indisponible », « non calculé » ni message d'excuse à la place d'un calcul "
    "(rejet vérificateur garanti — mesuré 23/11, fournée o11 : 4 carnets rejetés à ce "
    "seul motif après 3-4 tours de révision). Ce port est LIVRABLE et approuvé dans ce "
    "dépôt : le jumeau mergé ICT-15h en est la preuve de bout en bout (RNG xorshift64* "
    "seedé, protocole identique, écarts nommés en prose). L'équivalence exigée est "
    "celle du PROTOCOLE, pas celle des tirages.\n")


def creation_json_prompt(segment_cells: list, n_src_cells: int, conventions: str = "",
                         src_cells: list | None = None,
                         cs_cells: list | None = None,
                         modules: list | None = None) -> str:
    """Stage 2 in creation mode, ONE SEGMENT at a time: the model returns the sources of
    the plan's cells i..j only. Measured 17/11: the whole-notebook single-shot answer
    does not survive the output budget. The harness assembles every segment.
    src_cells: the TWIN's cells — when present, the authoritative French prose of every
    MARKDOWN cell of this segment is injected verbatim (17/11 #27104: prose REGENERATED
    from memory came back corrupted — «случай», CJK — the model must COPY, not reinvent).
    Code cells derive from the plan, with the twin's code AND real outputs shown as the
    reference to reproduce (22/11: values reinvented without it, 25/105 reject findings)."""
    prose = ""
    comments = ""
    refs = ""
    csparts: list[str] = []
    if src_cells:
        parts, stripped = [], 0
        cparts: list[str] = []
        rparts: list[str] = []
        footer = last_md_index(src_cells)
        for c in segment_cells:
            if isinstance(c, dict) and c.get("cell_type") == "code":
                try:
                    ci = int(c.get("idx"))
                except (TypeError, ValueError):
                    ci = -1
                if 0 <= ci < len(src_cells) and src_cells[ci].get("cell_type") == "code":
                    cm = twin_code_comments(_text(src_cells[ci].get("source")))
                    if cm:
                        cparts.append(f"<cellule {ci} — commentaires du jumeau>\n"
                                      + "\n".join(f"- {t}" for t in cm))
                    rparts.extend(twin_reference_blocks(src_cells, idxs={ci}))
                # the C# twin's // comments for the SAME cell, when the series ported one
                # (user 22/11): the previous porter's translation notes — a reference, the
                # Python above stays the authority for prose and values
                if cs_cells and 0 <= ci < len(cs_cells) and cs_cells[ci].get("cell_type") == "code":
                    ccm = twin_code_comments(_text(cs_cells[ci].get("source")))
                    if ccm:
                        csparts.append(f"<cellule {ci} — commentaires du porteur C#>\n"
                                       + "\n".join(f"- {t}" for t in ccm[:8]))
                continue
            if not isinstance(c, dict) or c.get("cell_type") != "markdown":
                continue
            try:
                i = int(c.get("idx"))
            except (TypeError, ValueError):
                continue
            if 0 <= i < len(src_cells):
                # the pin must never carry what the coord-refs gate refuses (MGS-29);
                # the footer cell keeps its links — the gate exempts it with its note
                t, n = _text(src_cells[i].get("source")), 0
                if i != footer:
                    t, n = strip_coord_refs(t)
                stripped += n
                if t.strip():
                    parts.append(f"<cellule {i} — prose à recopier>\n{t[:2500]}")
        if parts:
            prose = ("\n\nPROSE DU JUMEAU PYTHON — AUTORITÉ pour les cellules MARKDOWN de "
                     "cette tranche : recopie cette prose TELLE QUELLE en n'adaptant QUE les "
                     "termes propres au langage cible (noms d'API, en-têtes "
                     "d'implémentation). "
                     "N'invente, ne traduis et ne reformule AUCUNE phrase — la prose "
                     "réinventée arrive corrompue (mesuré 17/11) :\n"
                     + "\n\n".join(parts)[:16000] + "\n")
            if stripped:
                prose += (f"({stripped} ligne(s) du jumeau portant une référence de "
                          "coordination — Epic, lane, « voir #N » — ont été retirées de cette "
                          "prose : ne les rétablis pas. La provenance ne vit qu'en note de pied "
                          "de la dernière cellule, sous la forme `> Carnet issu de l'EPIC #N.`)\n")
        if cparts:
            comments = ("\n\nCOMMENTAIRES DE LECTURE DU JUMEAU — pour les cellules de CODE de "
                        "cette tranche : reporte chacun d'eux, dans le même ordre et au même "
                        "endroit logique, dans la syntaxe de commentaire du langage cible "
                        "(`//` en Rust et en C#). Un portage qui les perd est refusé par la "
                        "garde `Uncommented code` du dépôt (mesuré 21/11) :\n"
                        + "\n\n".join(cparts)[:8000] + "\n")
        if rparts:
            refs = ("\n\nCODE ET SORTIES DE RÉFÉRENCE DU JUMEAU — pour les cellules de CODE de "
                    "cette tranche : porte ce code, et fais en sorte que ton exécution affiche "
                    "les MÊMES valeurs que la sortie réelle ci-dessous (1er motif de rejet "
                    "mesuré 22/11 : valeurs réinventées faute d'avoir vu la référence) :\n"
                    + "\n\n".join(rparts)[:24000] + "\n" + TWIN_VALUES_RULE)
        if csparts:
            comments += ("\n\nCOMMENTAIRES DU JUMEAU C# (portage antérieur du même carnet) — "
                         "choix de traduction notés par le porteur précédent, pour les "
                         "cellules CODE de cette tranche. Ils éclairent ton port (structures, "
                         "API, bibliothèques) ; le jumeau PYTHON reste l'autorité pour la "
                         "prose et les valeurs :\n"
                         + "\n\n".join(csparts)[:6000] + "\n")
    return (
        "TOUR 2 — CRÉATION, TRANCHE COURANTE : rends les sources COMPLÈTES des cellules "
        "listées ci-dessous, et rien d'autre. Le harnais assemble lui-même le fichier "
        "(squelette + metadata de série déjà posés) ; tu n'écris aucun fichier et tu "
        "n'appelles aucun outil d'écriture.\n\n"
        f"Cellules de cette tranche (index du PLAN, ordre du carnet) :\n"
        + json.dumps(segment_cells, ensure_ascii=False)[:9000] + "\n"
        + prose + comments + refs + local_module_block(modules) + "\n"
        + CREATION_LINK_COUNT_RULES + "\n"
        + PORT_CONTENT_RULES + "\n"
        + (f"Conventions de livraison (imposées) :\n{conventions}\n\n" if conventions else "")
        + f"Le jumeau complet compte {n_src_cells} cellules — cette tranche n'en couvre "
        "qu'une partie, ne rends QUE celles listées.\n\n"
        "Rends UNIQUEMENT un bloc ```json :\n"
        '{"cells":[{"idx":<index du plan>,"cell_type":"markdown|code",'
        '"source":"<source COMPLET>"}],"notes":"..."}'
    )


# ---------------------------------------------------------------- creation from a spec (--from-spec)
# 20/11 (InformationTheory, CoursIA#27077): a NEW series has no twin to port from, so
# --source-nb cannot apply and the driver answered notebook-not-found. The spec issue's
# « Plan des cellules » table becomes a harness-made SPEC TWIN: one [SPEC] cell per plan
# row, same type. Structure, gates and the verifier keep a mechanical reference; nothing
# of the twin's prose is pinned (the [SPEC] cells describe, they are not text to copy).
SPEC_PLAN_RE = re.compile(r"^#{2,4}[ \t]*Plan des cellules\b.*$", re.I | re.M)
SPEC_SEP_RE = re.compile(r"^\|?[\s:\-|]+\|?$")
SPEC_TYPES = {"markdown": "markdown", "md": "markdown", "code": "code"}


def _spec_row(line: str) -> list[str]:
    """Split one markdown table row on UNESCAPED pipes (a formula may carry `\\|x\\|`)."""
    inner = line.strip()
    inner = inner[1:] if inner.startswith("|") else inner
    inner = inner[:-1] if inner.endswith("|") and not inner.endswith("\\|") else inner
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", inner)]


def parse_spec_cells(body: str) -> tuple[list[dict], list[str]]:
    """The issue's « Plan des cellules » table -> [{idx, cell_type, titre, role}].

    Fail-closed: every defect is named and the plan is refused whole — an approximate
    plan would only surface at the final verify, after every token was spent. Required:
    a `Type` column (markdown|md|code) and a content column (`Contenu`/`Rôle`/`Attendu`);
    optional `#`/`Idx` column, contiguous from 0 or 1; a title cell (markdown) first, a
    provenance footer (markdown) last, at least one code cell."""
    m = SPEC_PLAN_RE.search(body or "")
    if not m:
        return [], ["no « Plan des cellules » section (## heading) in the issue body"]
    rows: list[str] = []
    for line in (body or "")[m.end():].splitlines():
        s = line.strip()
        if s.startswith("|"):
            rows.append(s)
        elif rows or s.startswith("#"):
            break                              # table ended, or next section reached
    if len(rows) < 3:
        return [], ["« Plan des cellules » has no table (header + separator + rows)"]
    header = [h.strip("`* ").lower() for h in _spec_row(rows[0])]

    def col(*names: str) -> int | None:
        for i, h in enumerate(header):
            if any(h == n or h.startswith(n) for n in names):
                return i
        return None

    ci_type = col("type")
    ci_idx = col("#", "idx", "index", "cellule")
    ci_title = col("titre", "title")
    ci_role = col("contenu", "rôle", "role", "attendu", "ce que")
    if ci_type is None:
        return [], ["plan table has no « Type » column"]
    errors: list[str] = []
    if ci_role is None:
        errors.append("plan table has no content column (Contenu / Rôle / Attendu)")
    cells, idx_raw = [], []
    for pos, r in enumerate(rows[1:]):
        if SPEC_SEP_RE.match(r):
            continue
        parts = _spec_row(r)
        if len(parts) != len(header):
            errors.append(f"row {pos}: {len(parts)} columns, header has {len(header)} "
                          "(escape a literal pipe as \\|)")
            continue
        t = SPEC_TYPES.get(parts[ci_type].strip("`* ").lower())
        if t is None:
            errors.append(f"row {pos}: type {parts[ci_type]!r} is not markdown|code")
            continue
        idx_raw.append(parts[ci_idx] if ci_idx is not None else None)
        cells.append({"cell_type": t,
                      "titre": parts[ci_title] if ci_title is not None else "",
                      "role": parts[ci_role] if ci_role is not None else ""})
    if ci_idx is not None and cells:
        try:
            nums = [int(str(v).strip("`* ")) for v in idx_raw]
        except ValueError:
            errors.append("index column is not integer")
        else:
            if not nums or nums[0] not in (0, 1) \
                    or nums != list(range(nums[0], nums[0] + len(nums))):
                errors.append(f"index column not contiguous from 0 or 1: {nums[:8]}")
    if len(cells) < 3:
        errors.append(f"plan has {len(cells)} usable rows, at least 3 required")
    if cells and cells[0]["cell_type"] != "markdown":
        errors.append("first plan cell must be markdown (the title)")
    if cells and cells[-1]["cell_type"] != "markdown":
        errors.append("last plan cell must be markdown (the provenance footer)")
    if cells and not any(c["cell_type"] == "code" for c in cells):
        errors.append("plan has no code cell")
    empty = [i for i, c in enumerate(cells) if not (c["role"] or c["titre"]).strip()]
    if empty:
        errors.append(f"plan rows with no title and no content: {empty[:8]}")
    if errors:
        return [], errors
    for i, c in enumerate(cells):
        c["idx"] = i
    return cells, []


def spec_twin(cells: list[dict], meta: dict) -> dict:
    """The harness-made reference notebook for --from-spec: one [SPEC] cell per plan row,
    no outputs. It is written to the OUT dir, never to the worktree, and never committed."""
    out = []
    for c in cells:
        head = f"[SPEC cellule {c['idx']} — {c['cell_type']}] {c.get('titre') or ''}".rstrip()
        role = (c.get("role") or "").strip()
        if c["cell_type"] == "markdown":
            out.append({"cell_type": "markdown", "id": f"spec-{c['idx']}", "metadata": {},
                        "source": f"{head}\n\n{role}".rstrip()})
        else:
            lines = [head] + (role.splitlines() if role else [])
            out.append({"cell_type": "code", "id": f"spec-{c['idx']}", "metadata": {},
                        "execution_count": None, "outputs": [],
                        "source": "\n".join("# " + ln for ln in lines)})
    return {"cells": out, "metadata": meta, "nbformat": 4, "nbformat_minor": 5}


def spec_meta(meta_nb: Path) -> dict:
    """kernelspec + language_info of the --meta-from notebook: the series' canonical
    metadata a from-spec deliverable inherits (nothing else of that notebook is read)."""
    full = json.loads(meta_nb.read_text(encoding="utf-8")).get("metadata") or {}
    return {k: full[k] for k in ("kernelspec", "language_info") if k in full}


def spec_creation_prompt(issue_n: int, issue: dict, rel: str, kernel: dict,
                         ctx: str, view: str, conventions: str = "") -> str:
    """Stage 1 of --from-spec: same LIGHT plan contract as creation_prompt, without a
    twin — the issue's spec is the only reference, the [SPEC] twin fixes the skeleton."""
    return (
        f"MODE CRÉATION DEPUIS LA SPEC — tu prépares la CRÉATION COMPLÈTE d'un carnet NEUF "
        f"pour l'issue jsboige/CoursIA#{issue_n}. Il n'existe AUCUN carnet source : la spec "
        "de l'issue est la seule référence.\n\n"
        f"## Issue — la spec\nTITRE : {issue['title']}\n\n"
        f"CORPS :\n{_cut(issue['body'], 30000, 'corps de l issue')}\n\n"
        f"## Fil (extrait récent)\n{_cut(issue['comments'], 8000, 'fil de l issue', tail=True)}\n\n"
        + (f"## Conventions de livraison (imposées)\n{conventions}\n\n" if conventions else "")
        + f"## Carnet à CRÉER : {rel} (absent d'origin/main — sa création EST la livraison)\n"
        f"Noyau d'exécution : {kernel['kernel_name']}\n\n"
        f"## Contexte de série\n{ctx}\n\n"
        "## Jumeau de spec (structure IMPOSÉE, générée par le harnais depuis la table "
        f"« Plan des cellules » de l'issue)\n{view}\n\n"
        "Chaque cellule `[SPEC cellule i — type]` du jumeau de spec est UNE cellule du carnet : "
        "même index, même type, même ordre — le harnais refuse un carnet dont la signature de "
        "types diffère. Les cellules [SPEC] DÉCRIVENT la cellule à écrire ; ce ne sont pas des "
        "textes à recopier. Respecte les interdits et les attendus de l'issue : sorties "
        "réelles, aucune valeur annoncée sans le calcul qui l'affiche, stubs d'exercice "
        "exécutables avec valeur neutre, aucun appel réseau, aucune source citée que l'issue "
        "ne fournit pas. La dernière cellule markdown est le pied de provenance.\n\n"
        "Rends UNIQUEMENT un bloc ```json — le PLAN, SANS les sources complètes :\n"
        '{"cells":[{"idx":<0..N-1>,"cell_type":"markdown|code","titre":"<titre ou 1ère ligne>'
        '","role":"<ce que fait cette cellule en une phrase>"}],'
        '"expectations":["..."],"risques":["..."]}\n'
        "UNE ligne par cellule du jumeau de spec, dans l'ordre. Les sources seront réclamées "
        "au tour suivant, par tranches."
    )


CREATE_SEGMENT = 8   # cells per stage-2 tour in creation mode — measured 17/11 (#27099):
                     # a whole-notebook single-shot answer (16 268 chars) never parsed;
                     # the sources of ~29 cells do not fit one output budget


def segment_keep_valid(got: list, seg: list) -> tuple[list, list]:
    """Keep only answers whose idx matches an ASKED plan cell of this segment, with a
    non-empty source; returns (kept in plan order, missing plan cells). Duplicates keep
    the first occurrence; out-of-segment and unusable idx are dropped (they would shift
    every later cell and fail only at the final verify). A plan cell without a usable
    int idx always lands in 'missing' — the fail-fast verdict names it, nothing is
    silently dropped."""
    def _int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None
    asked = {}
    for c in seg:
        i = _int(c.get("idx") if isinstance(c, dict) else None)
        if i is not None:
            asked[i] = c
    kept: dict[int, dict] = {}
    for c in got:
        i = _int(c.get("idx") if isinstance(c, dict) else None)
        if i is None or i not in asked or i in kept:
            continue
        if not str(c.get("source") or "").strip():
            continue
        kept[i] = c
    return ([kept[i] for i in sorted(kept)],
            [asked[i] for i in sorted(asked) if i not in kept])


def creation_plan_addressing(plan_cells: list, n_src_cells: int) -> list[str]:
    """Validate the addresses stage 2 will use, before paying for any build call.

    CoursIA#27106 rerun: MiniMax returned 12 valid-looking plan entries with no idx.
    segment_keep_valid() correctly dropped every one, but an empty repair then returned
    parsed JSON and apply_create reported success with cells_written=0. Never invent the
    indices: an unaddressable plan is a stage-1 defect and must say so, with every reason.

    CoursIA#27305 (23/11, Terra): a well-formed, in-bounds, duplicate-free plan of 10
    entries for a 36-cell SOURCE passed validation here and the grain died
    stage2-empty-segment — the model itself contested the truncated plan ("il ne
    couvrait que les indices 0 a 9"). Addressing alone was necessary, not sufficient:
    a plan that does not COVER every source cell would have shipped a truncated port.
    Missing coverage is an error like any other; the repair re-ask names it.
    """
    errors = []
    seen = set()
    if not plan_cells:
        return ["cells is empty"]
    for pos, cell in enumerate(plan_cells):
        try:
            idx = int(cell.get("idx")) if isinstance(cell, dict) else None
        except (TypeError, ValueError):
            idx = None
        if idx is None:
            errors.append(f"position {pos}: missing/non-integer idx")
        elif not 0 <= idx < n_src_cells:
            errors.append(f"position {pos}: idx {idx} outside 0..{n_src_cells - 1}")
        elif idx in seen:
            errors.append(f"position {pos}: duplicate idx {idx}")
        else:
            seen.add(idx)
    missing = sorted(set(range(n_src_cells)) - seen)
    if missing:
        head = ", ".join(str(i) for i in missing[:12])
        errors.append(f"coverage: {len(missing)} source cell(s) unaddressed "
                      f"({head}{'...' if len(missing) > 12 else ''}) — the plan must "
                      f"address every one of the {n_src_cells} source cells exactly once")
    return errors


def creation_plan_seq_fill(cells: list, n_src_cells: int) -> bool:
    """Fill sequential idx 0..N-1 into a plan that carries NONE of them.

    CoursIA#28079 (23/11, Terra): the coder agent's system prompt (sk_agent_config)
    documents a plan schema of {"type","intent","expects"} with no idx, and the model
    answers its system prompt over the harness schema — twice, repair re-ask included.
    The repair prompt itself says the contract is "idx entiers distincts couvrant 0..last,
    dans l'ordre — ni plus, ni moins": a plan with NO idx, EXACTLY n_src_cells entries,
    in notebook order, satisfies that contract as-is. Only that case is filled — a count
    that does not match, or any partial idx, keeps the honest #27106 verdict.
    Mutates in place (the caller's rec['plan']['cells'] is the same list); returns True
    when the fill applied.
    """
    if not cells or len(cells) != n_src_cells:
        return False
    for c in cells:
        idx = None
        if isinstance(c, dict):
            try:
                idx = int(c.get("idx"))
            except (TypeError, ValueError):
                idx = None
        if idx is not None:
            return False           # partial addressing is a real defect, never filled
    for i, c in enumerate(cells):
        c["idx"] = i
    return True


def creation_plan_repair_prompt(errors: list[str], n_src_cells: int) -> str:
    """Name the EXACT addressing constraint the corrected plan must satisfy.

    CoursIA#27580 (20/11): MiniMax planned 24 cells for a 22-cell source — idx 22 and 23
    address nothing. The plan is validated before any build call (CoursIA#27106), but
    that defect then terminated the grain; one bounded re-ask can convert it into a
    plan the harness can actually build.
    """
    last = n_src_cells - 1
    reasons = "\n".join(f"- {e}" for e in errors)
    return (
        "TON PLAN NE PEUT PAS ÊTRE ADRESSÉ : le carnet source a exactement "
        f"{n_src_cells} cellules, idx 0..{last}.\n{reasons}\n\n"
        "Rends UNIQUEMENT un bloc ```json corrigé, de la MÊME forme que le plan :\n"
        '{"stage":"plan","cells":[{"idx":<entier 0..' + str(last) + '>,'
        '"cell_type":"markdown|code","titre":"<titre>","role":"<rôle en une phrase>"}]}\n'
        "avec EXACTEMENT une entrée par cellule source, idx entiers distincts couvrant "
        f"0..{last}, dans l'ordre — ni plus, ni moins."
    )


async def repair_creation_plan(session, args, rec: dict, conv: str | None,
                               errors: list[str], n_src_cells: int) -> list | None:
    """ONE bounded corrected-plan re-ask on the same conversation.

    Returns the plan's cells, or None when nothing usable came back. The caller
    re-validates: a repair that still overruns keeps the terminal verdict, with both
    error sets recorded in rec['creation_plan_repair']."""
    env = await sk_call_retry(session, args, rec, "1-plan-repair",
                              creation_plan_repair_prompt(errors, n_src_cells), conv)
    plan = parse_json_block(env.get("response") or "")
    cells = (plan or {}).get("cells") or []
    return cells or None


async def create_segments(session, args, rec: dict, conv: str | None, plan_cells: list,
                          n_src_cells: int, conventions: str,
                          src_cells: list | None = None,
                          cs_cells: list | None = None) -> dict:
    """Stage 2 of creation mode, SEGMENT by SEGMENT. Each tour renders the sources of
    the plan's cells i..i+CREATE_SEGMENT only; the harness concatenates in plan order
    and hands ONE payload to apply_create (the single-write discipline holds). Returns
    {} with rec['verdict'] set on the first segment that fails to answer or parse —
    with the raw tail persisted for offline diagnosis (the 17/11 pass stored none,
    leaving only response_chars to guess from).
    A segment answering FEWER cells than asked gets ONE repair re-ask for exactly the
    missing idx (17/11, #27104 blank pass: segment 3 answered 6/8 and the loop
    appended silently — the notebook was 2 cells short and only the FINAL verify
    caught it, after every token was spent). Still short after the repair fails fast
    with the missing idx listed."""
    all_cells: list = []
    seg_reports: list = []
    # 23/11: the source notebook's local .py modules are part of the material a port must
    # reproduce — computed once, injected into every segment prompt (CoursIA#28208)
    mods = local_modules(getattr(args, "source_nb", None)) if src_cells else []
    if creation_plan_seq_fill(plan_cells, n_src_cells):
        # A count-exact, order-only plan (the agent system prompt's own schema,
        # CoursIA#28079) is addressable as-is — recorded, then validated below
        # like any other plan.
        rec["creation_plan_seq_fill"] = {"cells": len(plan_cells), "source": "plan"}
    addressing_errors = creation_plan_addressing(plan_cells, n_src_cells)
    if addressing_errors and session is not None:
        # ONE bounded repair re-ask before the terminal verdict (CoursIA#27580,
        # 20/11: 3 of 7 recent attempts died on an overrunning plan while the
        # defect is the cheapest one to state back). The repaired plan is
        # re-validated; a still-unaddressable answer keeps the honest verdict
        # with BOTH error sets recorded.
        repaired = await repair_creation_plan(session, args, rec, conv,
                                              addressing_errors, n_src_cells)
        if creation_plan_seq_fill(repaired or [], n_src_cells):
            rec["creation_plan_seq_fill"] = {"cells": len(repaired), "source": "repair"}
        after = creation_plan_addressing(repaired or [], n_src_cells)
        rec["creation_plan_repair"] = {"errors_before": addressing_errors,
                                       "errors_after": after, "kept": not after}
        if not after:
            plan_cells[:] = repaired   # in place: rec['plan']['cells'] is this same list,
                                       # so the trace carries the REPAIRED (built) plan
        addressing_errors = after
    if addressing_errors:
        rec["verdict"] = "stage1-unaddressable-creation-plan"
        rec["creation_plan_addressing_errors"] = addressing_errors
        return {}

    async def ask_tranche(tranche: list, stage: str):
        """One build tour; returns (kept, missing, parsed, env). Raises nothing — an
        unparsed/empty answer returns parsed=None and the caller decides."""
        env = await sk_call_retry(session, args, rec, stage,
                                  creation_json_prompt(tranche, n_src_cells, conventions,
                                                       src_cells, cs_cells, modules=mods), conv,
                                  max_tokens=BUILD_MAX_TOKENS)
        part, env = await parse_or_repair(session, args, rec, stage, env, conv,
                                          max_tokens=BUILD_MAX_TOKENS)
        kept, missing = segment_keep_valid((part or {}).get("cells") or [], tranche)
        return kept, missing, part, env

    def truncated(env: dict) -> bool:
        r = (env.get("response") or "").rstrip()
        return bool(r) and not (r.endswith("```") or r.endswith("}"))

    def why_bisect(env: dict) -> str:
        """'truncated', 'timeout' or '' — the two failures a smaller tranche can cure."""
        if truncated(env):
            return "truncated"
        return "timeout" if call_timed_out(env) else ""

    # 26/11 (myia-po-2028:claudish, CoursIA#28707): the mid-run probe ran only at the
    # stage boundaries, and the creation build is ONE stage of 5+ model calls over ~8
    # min. The foreign [CLAIMED] landed at 04:02:13Z, between tranche 1 and tranche 2;
    # the "build" probe fired at 04:08:05Z, after four more calls -- 347 201 prompt
    # tokens spent building a notebook another lane already held. A probe before every
    # build call but the FIRST (the "plan" probe covers that one) bounds the exposure
    # to the call in flight. Inert unless --claim-late deferred the claim.
    # The one skip is RUN-scoped, not invocation-scoped (review ai-01, 26/11): the stage it
    # covered is named in the record the one time it is skipped, so an entry into this
    # function that did not pass the "plan" probe (a second call site added later, a resume
    # that does not replay plan) finds the name and probes its own first tranche.
    def claim_stop(stage: str) -> bool:
        if rec.get("midrun_claim_plan_covered"):
            return midrun_claim_abort(args, rec, stage)
        if midrun_armed(rec):
            rec["midrun_claim_plan_covered"] = stage
        return False

    for si in range(0, len(plan_cells), CREATE_SEGMENT):
        seg = plan_cells[si:si + CREATE_SEGMENT]
        if claim_stop(f"build+{si}"):
            return {}
        kept, missing, part, env = await ask_tranche(seg, f"2-build+{si}")
        conv = env.get("conversation_id") or conv
        chars_first = len(env.get("response") or "")
        cause = "" if part else why_bisect(env)
        if cause:
            # 18/11 wave-1c: two grains died here — the JSON was CUT mid-cell (raw
            # tails end inside a "source" string) because thinking counts toward
            # max_tokens. Bisect ONCE: halves the output AND the thinking a tour
            # needs; each half parses or the grain fails named, never silent.
            # 20/11 conveyor (MGS-28, #27133): the same tour TIMED OUT instead — 8 Rust
            # cells at ~25-35 tok/s per stream under 4-6 concurrent streams do not fit
            # the model's 600 s request budget (x2 with the client's own retry: 1 201 s,
            # 0 char). Half the tranche is half the output: the same cure.
            halves = [seg[:max(1, len(seg) // 2)], seg[max(1, len(seg) // 2):]]
            kept, missing, chars_first = [], [], 0
            for hi, half in enumerate(h for h in halves if h):
                if claim_stop(f"build+{si}+h{hi}"):
                    return {}
                hkept, hmiss, hpart, henv = await ask_tranche(half, f"2-build+{si}+h{hi}")
                conv = henv.get("conversation_id") or conv
                chars_first += len(henv.get("response") or "")
                if not hpart or not (hpart.get("cells") or []):
                    if gate_refusal(henv):
                        rec["verdict"] = gate_refusal(henv)   # scheduler defer contract
                    elif truncated(henv):
                        rec["verdict"] = f"stage2-truncated:{si}+h{hi}"
                    elif call_timed_out(henv):
                        rec["verdict"] = f"stage2-timeout:{si}+h{hi}"
                    else:
                        # scheduler defer contract: a 429 or a cut transport stays unprefixed
                        rec["verdict"] = (
                            defer_refusal(henv)
                            or f"stage2-{call_failure(henv) or 'unparsed'}:{si}+h{hi}")
                    rec["stage2_raw_tail"] = (henv.get("response") or "")[-3000:]
                    return {}
                kept += hkept
                missing += hmiss
            kept.sort(key=lambda c: int(c["idx"]))
            missing.sort(key=lambda c: int(c["idx"]))
            rec.setdefault("bisected", []).append(si)
            rec.setdefault("bisect_cause", {})[str(si)] = cause
        elif not part or not (part.get("cells") or []):
            if gate_refusal(env):
                rec["verdict"] = gate_refusal(env)   # scheduler defer contract
            elif not part:
                # scheduler defer contract: a 429 or a cut transport stays unprefixed
                # (23/11: four builds walled mid-flight were failed and released as
                # stage2-call-failed; 26/11: a Docker restart cut #28664 the same way)
                rec["verdict"] = (
                    defer_refusal(env)
                    or f"stage2-{call_failure(env) or 'unparsed'}:{si}")
            else:
                rec["verdict"] = f"stage2-empty-segment:{si}"
            rec["stage2_raw_tail"] = (env.get("response") or "")[-3000:]
            return {}
        repair = None
        if missing:
            if claim_stop(f"build+{si}+repair"):
                return {}
            # one repair round for EXACTLY the omitted cells — same prompt shape,
            # smaller tranche, so the omissions cannot hide in a long answer again
            env = await sk_call_retry(session, args, rec, f"2-build+{si}+repair",
                                      creation_json_prompt(missing, n_src_cells,
                                                           conventions, modules=mods), conv,
                                      max_tokens=BUILD_MAX_TOKENS)
            conv = env.get("conversation_id") or conv
            part2, env = await parse_or_repair(session, args, rec, f"2-build+{si}+repair",
                                               env, conv, max_tokens=BUILD_MAX_TOKENS)
            extra, missing = segment_keep_valid((part2 or {}).get("cells") or [], missing)
            kept += extra
            kept.sort(key=lambda c: int(c["idx"]))   # repair fills holes mid-segment
            repair = {"filled": [int(c["idx"]) for c in extra],
                      "chars": len(env.get("response") or "")}
        if missing:
            # 28/11 (o66b, CoursIA#28976): the repair CALL died — the provider refused
            # the request, HTTP 400 2013, nothing answered — and the grain was minted
            # stage2-short-segment, a content failure, then released. A repair that never
            # answered judged nothing: its verdict is the call's, read from its envelope
            # like every build call's (scheduler defer contract first, unprefixed).
            if repair is not None and (env.get("error") or "").strip():
                rec["verdict"] = (
                    defer_refusal(env)
                    or (f"stage2-timeout:{si}+repair" if call_timed_out(env) else "")
                    or f"stage2-{call_failure(env)}:{si}+repair")
            else:
                rec["verdict"] = f"stage2-short-segment:{si}"
            rec["stage2_raw_tail"] = (env.get("response") or "")[-3000:]
            rec["stage2_missing_idx"] = [c.get("idx") for c in missing]
            return {}
        all_cells.extend(kept)                # plan order, by construction of the helper
        seg_reports.append({"from": si, "asked": len(seg), "got": len(kept),
                            "chars": chars_first, "repair": repair})
    rec["segments"] = seg_reports
    return {"cells": all_cells, "notes": f"assembled from {len(seg_reports)} segments"}


def apply_create(nb_path: Path, payload: dict) -> dict:
    """Creation-mode applier: fill the harness-made skeleton with every model cell, ONE
    read-modify-write. Ids follow nbformat 4.5+ (required by the papermill server)."""
    raw = nb_path.read_text(encoding="utf-8")
    nb = json.loads(raw)
    cells_in = payload.get("cells") or []
    rep = {"cells_written": 0, "types": [], "empty_sources": [], "errors": []}
    new_cells = []
    for k, c in enumerate(cells_in):
        ctype = c.get("cell_type")
        src = c.get("source") or ""
        if ctype not in ("code", "markdown"):
            rep["errors"].append(f"cell {k}: cell_type invalide {ctype!r}")
            continue
        if not src.strip():
            rep["empty_sources"].append(k)
            continue
        cell = {"cell_type": ctype, "id": f"cell-{k:03d}", "metadata": {},
                "source": _lines(src)}
        if ctype == "code":
            cell["execution_count"] = None
            cell["outputs"] = []
        new_cells.append(cell)
    nb["cells"] = new_cells
    nb_path.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n",
                       encoding="utf-8")
    rep["cells_written"] = len(new_cells)
    rep["types"] = [c["cell_type"] for c in new_cells]
    return rep


# A repair round shows the model the cell it must rewrite IN FULL. The old tail cut
# (`source[-1600:]`) hid the head of every cell above 1 600 chars: on #27314 (20/11) the
# compiler cited `(47,37): error CS0023` in a 2 876-char cell whose line 47 sat in the
# cut-off head, and two rounds re-sent the cell without ever seeing the faulty line.
REPAIR_SOURCE_CAP = 12000
# Upstream cells a round may add because the error's stack crosses them (#27314: the
# exception was raised in `Decouper`, defined 8 cells above the cell that displayed it).
REPAIR_UPSTREAM_MAX = 3

# Rounds a repair loop may add past --repair-rounds while it is still converging (21/11
# conveyor): the 7 built-execution-failed traces of 20-21/11 all ran out of rounds, and 3
# of them were still shrinking on the last one (2.3d 8 -> 7, Frontieres-01 8 -> 3,
# Compression-07 4 -> 3). A round that fixes nothing ends the loop as before.
REPAIR_EXTEND_DEFAULT = 2


def repair_round_extends(rounds_done: int, budget: int, cap: int, before: int,
                         after: int) -> bool:
    """One more repair round when the budget is spent, the cap is not reached, and the
    round just run strictly reduced the failing cells without clearing them."""
    return rounds_done >= budget and budget < cap and 0 < after < before


# Rounds the constructive-review loop may add past --revise-rounds while it is still
# converging (21/11 conveyor, CoursIA#27747 Sudoku-07): majors 6 -> 4 -> 1 over the two
# budgeted rounds, then the loop stopped on its budget with ONE major left, a one-line
# hint fix the verifier had spelled out. A round that does not strictly reduce the
# majors ends the loop as before ([2, 1, 1] and [4, 4, 4] on the same day stay as they are).
REVISE_EXTEND_DEFAULT = 2
# Harness-synthesized finding sources: deterministic, narrow (one gate, one failing cell).
DETERMINISTIC_SOURCES = ("gates", "execution")


def revise_round_extends(rounds_done: int, budget: int, cap: int, source_in, source_out,
                         majors_in, majors_out) -> bool:
    """One more revision round when the budget is spent, the cap is not reached, and either

    - the round just run strictly reduced the major findings — measured on findings of the
      SAME source (verifier vs verifier, execution vs execution, gates vs gates): a
      synthesized execution finding and a verifier major are not on one scale; or
    - the round answered one source and its rewrite broke a DETERMINISTIC one (a gate, or
      execution) that the builder has never been shown. 22/11, CoursIA#27930: the last
      budgeted round fixed a real verifier major (Pauli Y anti-diagonal) but rewrote cell
      11 without its `//` comments; `uncommented-code` then ended the grain terminal with
      no round ever spent on it. A new deterministic finding gets one round; ping-pong
      stays bounded by the cap, and a verifier that comes back is not extended here."""
    if not (isinstance(majors_in, int) and isinstance(majors_out, int)):
        return False
    if rounds_done < budget or budget >= cap:
        return False
    if source_in == source_out:
        return majors_out < majors_in
    return source_out in DETERMINISTIC_SOURCES and majors_out > 0

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
# Frame names a kernel error carries: .NET Interactive `at Submission#5.Decouper(`,
# IPython `Cell In[5], line 3, in decouper(` / classic `File "x.py", line 3, in decouper`.
_FRAME_RES = (
    re.compile(r"\bat\s+Submission#\d+\.(?:<<)?([A-Za-z_]\w*)"),
    re.compile(r", line \d+, in ([A-Za-z_]\w*)"),
    # evcxr backtrace: `3: ctx::run_woa`, `<ctx::Swarm>::step`, `ctx::f::{{closure}}` —
    # user code lives in module `ctx`; the LAST plain path segment is the function.
    re.compile(r"^\s*\d+:\s+<?ctx::(?:\w+>?::)*([A-Za-z_]\w*)", re.M),
)
# A Rust panic as evcxr prints it on stderr: `thread '<unnamed>' (64040) panicked at …`.
_RUST_PANIC_RE = re.compile(r"thread '[^']*'(?: \(\d+\))? panicked at ")


def rust_panic_text(outputs: list) -> str:
    """The panic, from its first line on, if a stderr stream carries one; else ''.
    Only stderr and only the panic signature: warnings on stderr never fail a cell."""
    text = "".join(_text(o.get("text")) for o in outputs or []
                   if isinstance(o, dict) and o.get("output_type") == "stream"
                   and o.get("name") == "stderr")
    m = _RUST_PANIC_RE.search(text)
    return text[m.start():] if m else ""
_FRAME_SKIP = frozenset({"Initialize", "MoveNext", "module", "lambda", "genexpr",
                         "listcomp", "dictcomp", "setcomp"})
# Line citations that are relative to the FAILING cell: every .NET compiler diagnostic
# `(47,37): error`, and only the OUTERMOST IPython frame `Cell In[9], line 2` (the next
# `Cell In[5], line 14` frames number OTHER cells' lines).
_DOTNET_CITE_RE = re.compile(r"\((\d+),\d+\):\s*(?:error|warning)")
_IPY_CITE_RE = re.compile(r"Cell In\[\d+\], line (\d+)")
# Statement keywords that may precede `name(` on a line that CALLS rather than declares.
_CALL_LEADERS = ("return", "await", "throw", "yield", "else", "new", "case", "using",
                 "var", "foreach", "for", "if", "while", "switch", "lock", "from", "in",
                 "let!", "do")


def error_frame_names(errors: str) -> list[str]:
    """User-code function names a kernel error's stack trace crosses, in trace order."""
    text = _ANSI_RE.sub("", errors or "")
    names: list[str] = []
    for rx in _FRAME_RES:
        for m in rx.finditer(text):
            n = m.group(1)
            if n not in _FRAME_SKIP and n not in names:
                names.append(n)
    return names


def declares(source: str, name: str) -> bool:
    """Does this cell DECLARE `name` (function/method/type), as opposed to calling it?
    Heuristic across the series' kernels (Python, C#, F#, Rust). A false positive only
    widens a repair round's scope by one cell; it never edits anything by itself."""
    n = re.escape(name)
    leaders = "|".join(re.escape(k) for k in _CALL_LEADERS)
    pats = (
        rf"^\s*(?:async\s+)?def\s+{n}\b",                                    # Python
        rf"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+{n}\b",  # Rust
        rf"^\s*(?:[\w\[\]]+\s+)*(?:class|record|struct|enum|interface|trait|type)\s+{n}\b",
        rf"^\s*let\s+(?:rec\s+|inline\s+)?{n}\b",                            # F#
        # C#-style method / local function: a return type (generics, arrays, tuples,
        # nullable) then the name and its parameter list — never after a statement keyword.
        rf"^\s*(?=\S)(?:(?:public|private|protected|internal|static|async|override|virtual|"
        rf"sealed|unsafe|partial|extern)\s+)*(?!(?:{leaders})\b)"
        rf"[\w.<>\[\],?() ]*?[\w>\]?)]\s+{n}\s*(?:<[^>()]*>)?\s*\(",
    )
    return any(re.search(p, source or "", re.M) for p in pats)


def defining_cell(cells: list[dict], name: str, before: int) -> int | None:
    """Index of the LAST code cell above `before` that declares `name` (a notebook
    redefinition shadows the earlier one), or None."""
    for j in range(min(before, len(cells)) - 1, -1, -1):
        c = cells[j]
        if c.get("cell_type") == "code" and declares(_text(c.get("source")), name):
            return j
    return None


def source_cell(cells: list[dict], name: str, before: int) -> int | None:
    """Index of the LAST code cell above `before` that declares OR binds `name`, or None.
    For cascade detection only: a failed .NET or evcxr submission defines none of its
    names, functions and `var` alike. `defining_cell` stays declarations-only, since the
    stack frames it resolves name functions, never values."""
    for j in range(min(before, len(cells)) - 1, -1, -1):
        c = cells[j]
        if c.get("cell_type") == "code":
            src = _text(c.get("source"))
            if declares(src, name) or binds(src, name):
                return j
    return None


# A name the compiler or interpreter reports as nonexistent (#27302 attempt 2, 20/11).
_UNDEFINED_NAME_RES = (
    re.compile(r"error CS0103: (?:Le nom|The name) '(\w+)'"),
    re.compile(r"error CS0246: (?:Le nom de type ou d'espace de noms|"
               r"The type or namespace name) '(\w+)'"),
    re.compile(r"NameError: name '(\w+)' is not defined"),
    re.compile(r"error\[E04(?:12|25|33)\]: [^`\n]*`(\w+)`"),
)


def undefined_names(errors: str) -> list[str]:
    """The names an error text says do not exist, in order of first mention."""
    seen: list[str] = []
    for rx in _UNDEFINED_NAME_RES:
        for m in rx.finditer(errors or ""):
            if m.group(1) not in seen:
                seen.append(m.group(1))
    return seen


def cascade_roots(cells: list[dict], detail: list[dict]) -> dict[int, list[int]]:
    """failing idx -> the EARLIER failing cells that declare a name it reports undefined.

    #27302 attempt 2: cell 10 did not compile (a type the OR-Tools C# API lacks), so the
    five functions it declares never existed and seven cells below failed with CS0103 on
    them. Each round re-asked all of them (13, 12, 10 cells) and the root error survived
    three rounds. A cell listed here fails because of its root: repairing it before the
    root can only work around a definition that is about to change. Values count too
    (#27314 attempt 1: cell 22 failed on `ARCHIVE` and `CERTIFICAT`, which cell 19 binds
    with `var` and never ran).

    Crates count too (2.3c, #27134, 21/11): cell 2 carried every `:dep` and failed on two
    missing trait imports, so evcxr linked none of its crates and the twelve cells below
    failed on `unlinked crate ndarray/rand/…` alone. The round asked all thirteen at once:
    a 151K-token prompt, a 60K-character answer that did not parse, the grain lost."""
    failing = {d["idx"] for d in detail}
    dep_cell = {_crate_norm(n): s["idx"] for n, s in cell_deps(cells).items()}
    out: dict[int, list[int]] = {}
    for d in detail:
        roots = set()
        errs = d.get("_raw_errors") or d.get("errors") or ""
        for name in undefined_names(errs):
            j = source_cell(cells, name, before=d["idx"])
            if j is not None and j in failing:
                roots.add(j)
        for crate in unlinked_crates(errs):
            j = dep_cell.get(_crate_norm(crate))
            if j is not None and j < d["idx"] and j in failing:
                roots.add(j)
        if roots:
            out[d["idx"]] = sorted(roots)
    return out


# rustc names the same linking failure two ways: E0433 "use of unresolved module or
# unlinked crate `X`" and E0433 "cannot find module or crate `X` in this scope". 2.3c
# (#27134, 21/11 08:3xZ): cell 2's `:dep rand`/`plotters` failed and five of the 12
# cells below said the second form only -- not read as cascades, they were asked in
# the same round as their root.
_UNLINKED_CRATE_RE = re.compile(r"(?:unlinked crate|cannot find module or crate) `(\w+)`")


def unlinked_crates(errors: str) -> list[str]:
    """Crates an evcxr error says are not linked, in order of first mention."""
    seen: list[str] = []
    for m in _UNLINKED_CRATE_RE.finditer(_ANSI_RE.sub("", errors or "")):
        if m.group(1) not in seen:
            seen.append(m.group(1))
    return seen


# 2.3b, #27134 (21/11): the model declared `:dep linfa-core = "0.8"`, a crate that does not
# exist (linfa's traits live in `linfa`). Cargo answered "no matching package named
# `linfa-core` found"; round 1 dropped the line and the `:dep` cell passed, then round 2's
# link advice read cell 4's "unlinked crate `linfa_core`" as an undeclared crate and told
# the model to ADD `:dep linfa_core` -- the grain looped until its rounds ran out. A name
# cargo refused is remembered for the whole run: never advised, named in every later
# round, and a `:dep` line that brings it back is struck (that line can only fail).
_NO_PACKAGE_RE = re.compile(r"no matching package named `([A-Za-z0-9_-]+)` found")


def absent_packages(errors: str) -> list[str]:
    """Package names cargo could not find in the registry index, in order, once each."""
    seen: list[str] = []
    for m in _NO_PACKAGE_RE.finditer(_ANSI_RE.sub("", errors or "")):
        if m.group(1) not in seen:
            seen.append(m.group(1))
    return seen


def strike_absent_deps(nb_path: Path, absent: list[str], only_idx) -> list[dict]:
    """Remove `:dep <name>` lines naming a crate cargo already refused, in the given code
    cells only (the ones a repair just rewrote). Returns [{idx, line}] of what was struck."""
    gone = {_crate_norm(a) for a in absent}
    if not gone:
        return []
    nb = json.loads(nb_path.read_text(encoding="utf-8"))
    struck: list[dict] = []
    for i in sorted(only_idx or []):
        if not (0 <= i < len(nb["cells"])) or nb["cells"][i].get("cell_type") != "code":
            continue
        lines = _text(nb["cells"][i].get("source")).split("\n")
        kept = []
        for ln in lines:
            m = re.match(r"^\s*:dep\s+([A-Za-z0-9_-]+)\s*=", ln)
            if m and _crate_norm(m.group(1)) in gone:
                struck.append({"idx": i, "line": ln.strip()})
            else:
                kept.append(ln)
        if len(kept) != len(lines):
            nb["cells"][i]["source"] = _lines("\n".join(kept))
    if struck:
        nb_path.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n",
                           encoding="utf-8")
    return struck


# What a failing cell USES (#27302, 20/11): every identifier outside strings and `//`
# comments. Only names some upstream cell declares or binds ever matter (`using_cells`),
# so the free names of the cell are filtered by the notebook itself; keywords are skipped
# because `declares` would read `else if (` as a method named `if`.
_IDENT_RE = re.compile(r"\b[A-Za-z_]\w+\b")
_DQ_STRING_RE = re.compile(r'@?\$?"(?:[^"\\\n]|\\.)*"')
# A compiler diagnostic names its own line: the cause is in the cell, not upstream.
_COMPILE_ERROR_RE = re.compile(r"\(\d+,\d+\):\s*error\b|error\[E\d{4}\]|"
                               r"\b(?:SyntaxError|IndentationError)\b")
_USE_SKIP = frozenset(_CALL_LEADERS) | frozenset((
    "nameof typeof sizeof default print len range str int float list dict set tuple super "
    "self this base Self if elif else while for foreach do switch match when case return "
    "break continue pass try catch except finally throw raise assert using import use mod "
    "crate pub fn def class struct record enum interface trait impl type let mut var const "
    "static readonly public private protected internal sealed abstract override virtual "
    "async await yield lambda with global del is as not and or in out ref params new true "
    "false null None True False void object string char bool byte long double decimal short "
    "uint ulong usize isize i32 i64 u8 u32 u64 f32 f64 get value loop where").split())


def used_names(source: str) -> list[str]:
    """Identifiers a cell uses outside strings and comments, in order of first use."""
    names: list[str] = []
    for line in (source or "").split("\n"):
        code = _DQ_STRING_RE.sub(" ", line)              # strings first: "https://…"
        code = code.split("//", 1)[0]
        for m in _IDENT_RE.finditer(code):
            n = m.group(0)
            if n not in _USE_SKIP and n not in names:
                names.append(n)
    return names


def binds(source: str, name: str) -> bool:
    """Does this cell BIND `name` as a value (`var TEMOINS = …`, `G = …`, `let mut g = …`)?
    Complements `declares` for data: a witness graph built upstream is a value, not a
    function. A false positive only widens a repair round's offer by one cell."""
    n = re.escape(name)
    return re.search(
        rf"^\s*(?:(?:var|let|mut|const|static|readonly|public|private|internal)\s+"
        rf"|[\w<>\[\],?.]+\s+)*{n}\s*(?::[^=\n]+)?=(?![=>])", source or "", re.M) is not None


def using_cells(cells: list[dict], failing_idx: int, limit: int,
                exclude: set[int] | frozenset[int] = frozenset()) -> list[tuple[int, list[str]]]:
    """Upstream code cells that declare or bind what the failing cell uses, ranked by how
    many of its names each defines (then nearest first). Names the failing cell declares
    itself are its own business; `exclude` cells (already shown as failing) are skipped,
    and the search for that name continues further up."""
    src = _text(cells[failing_idx].get("source")) if failing_idx < len(cells) else ""
    found: dict[int, list[str]] = {}
    for name in used_names(src):
        if declares(src, name) or binds(src, name):
            continue
        for j in range(min(failing_idx, len(cells)) - 1, -1, -1):
            c = cells[j]
            if c.get("cell_type") != "code":
                continue
            s = _text(c.get("source"))
            if declares(s, name) or binds(s, name):
                if j not in exclude:
                    found.setdefault(j, []).append(name)
                break
    ranked = sorted(found.items(), key=lambda kv: (-len(kv[1]), -kv[0]))
    return ranked[:limit]


def cap_source(src: str, cap: int = REPAIR_SOURCE_CAP) -> str:
    """The cell's source for a repair round: whole up to `cap`, else head + tail around an
    explicit marker — never a silent cut (the model is asked for the COMPLETE source)."""
    if len(src) <= cap:
        return src
    half = cap // 2
    return (src[:half] + f"\n[… {len(src) - 2 * half} caractères omis au milieu de la "
            "cellule : reprends-les à l'identique depuis ta version précédente …]\n"
            + src[-half:])


# evcxr reports every rustc diagnostic as its own `error` output, lints included. Measured
# 21/11 on CoursIA#27134 (2.3c Rust twin, three repair rounds lost): cell 24 carried 31 of
# them, 11,538 characters with 156 ANSI codes, for about ten distinct causes. The round
# showed `errs[-2000:]`, which started mid-diagnostic and held three of them (two
# `mismatched types`, one `outer`), the same three every round. Above the cut stayed
# `v_t` being an `Option`, the missing `SliceRandom` / `Distribution` imports, and two
# methods that do not exist.
REPAIR_ERRORS_CAP = 2000
REPAIR_DIAG_BODY_CAP = 600
_DIAG_WARNING_RE = re.compile(r"\bwarning:")


def _diag_lines(o: dict) -> list[str]:
    """One diagnostic's lines, ANSI stripped, consecutive repeats dropped (evcxr prints
    the offending code line twice)."""
    out: list[str] = []
    for part in o.get("traceback") or []:
        for line in _ANSI_RE.sub("", part if isinstance(part, str) else _text(part)).split("\n"):
            if line.strip() and (not out or out[-1] != line):
                out.append(line.rstrip())
    return out


def error_digest(cell: dict, raw: str, cap: int = REPAIR_ERRORS_CAP) -> str:
    """The cell's errors for a repair round, each distinct cause once.

    With several `error` outputs (evcxr, one per rustc diagnostic), the outputs are grouped
    by message and errors come before warnings. Each group shows its first diagnostic in
    full, the code lines of its other sites, and a count. Groups that do not fit are named
    on a closing line, never cut silently. A single error output (an IPython or .NET
    traceback) keeps the tail of `raw`, because there the decisive line comes last."""
    outs = [o for o in cell.get("outputs") or []
            if isinstance(o, dict) and o.get("output_type") == "error"]
    if len(outs) < 2:
        return (raw or "")[-cap:]
    groups: dict[str, dict] = {}
    for k, o in enumerate(outs):
        msg = _ANSI_RE.sub("", str(o.get("evalue") or o.get("ename") or "")).strip()
        lines = _diag_lines(o)
        g = groups.setdefault(msg, {"msg": msg, "first": k, "n": 0, "lines": lines,
                                    "sites": [], "warning": False, "sited": False})
        g["n"] += 1
        g["warning"] |= any(_DIAG_WARNING_RE.search(x) for x in lines)
        site = _first_site(lines, msg)
        g["sited"] |= site is not None
        if (site and g["n"] > 1 and site not in g["sites"]
                and site != _first_site(g["lines"], msg)):
            g["sites"].append(site)
    order = sorted(groups.values(), key=lambda g: (g["warning"], not g["sited"], g["first"]))
    head = f"{len(outs)} diagnostics, {len(order)} causes distinctes (chacune une fois) :"
    blocks: list[str] = []
    omitted: list[dict] = []
    room = cap - len(head) - 300  # the closing line naming what did not fit
    for g in order:
        tag = " [avertissement]" if g["warning"] else ""
        count = f" ×{g['n']}" if g["n"] > 1 else ""
        # The caret line repeats the message after `error:`; the carets alone point the column.
        body = "\n".join("  " + x.replace(f"error: {g['msg']}", "")
                         .replace(f"warning: {g['msg']}", "").rstrip()
                         for x in g["lines"] if x.strip() != g["msg"])
        if len(body) > REPAIR_DIAG_BODY_CAP:
            body = body[:REPAIR_DIAG_BODY_CAP] + " …"
        others = ("\n  autres sites : " + " ; ".join(f"`{s}`" for s in g["sites"][:4])
                  if g["sites"] else "")
        full = f"- {g['msg']}{count}{tag}" + (f"\n{body}" if body else "") + others
        if len(full) + 1 <= room:
            blocks.append(full)
            room -= len(full) + 1
            continue
        first = _first_site(g["lines"], g["msg"])
        short = f"- {g['msg']}{count}{tag}" + (f"\n  `{first}`" if first else "")
        if len(short) + 1 <= room:
            blocks.append(short)
            room -= len(short) + 1
        else:
            omitted.append(g)
    tail = ""
    if omitted:
        names, used = [], 0
        for g in omitted:
            n = g["msg"][:90]
            if used + len(n) > 240:
                break
            names.append(n)
            used += len(n) + 3
        rest = len(omitted) - len(names)
        tail = (f"\n[… {len(omitted)} autre(s) cause(s) non détaillée(s) faute de place : "
                + " ; ".join(names) + (f" ; et {rest} de plus" if rest else "") + "]")
    return head + "\n" + "\n".join(blocks) + tail


def _first_site(lines: list[str], msg: str) -> str | None:
    """The offending code line of a diagnostic: neither its message, nor a caret line,
    nor a `help:` hint."""
    return next((x.strip() for x in lines if x.strip() != msg and "^" not in x
                 and not x.lstrip().startswith("help:")), None)


def cited_lines(source: str, errors: str, limit: int = 6) -> list[tuple[int, str]]:
    """The source lines the compiler/interpreter cites, quoted from the CURRENT source so
    the model does not have to count lines."""
    lines = (source or "").split("\n")
    text = _ANSI_RE.sub("", errors or "")
    nums = [int(m.group(1)) for m in _DOTNET_CITE_RE.finditer(text)]
    first_ipy = _IPY_CITE_RE.search(text)
    if first_ipy:
        nums.append(int(first_ipy.group(1)))
    out: list[tuple[int, str]] = []
    for k in nums:
        if 1 <= k <= len(lines) and all(k != o[0] for o in out):
            out.append((k, lines[k - 1]))
            if len(out) >= limit:
                break
    return out


# ---- Crate API grounding (Rust; MGS-25 #27133 + 2.3b #27134, 20/11) ----------------------
# MGS-25 spent three repair rounds on `rng.next_f64()` under `:dep rand = "0.10"`. The
# compiler's only hint was "there is a method `next_u64`"; the model's memory of rand stops
# at 0.8, and rand 0.10 moved sampling to the extension trait `RngExt` (`random`,
# `random_range`). 2.3b failed the same way on linfa (`GaussianNb::params()`, not
# `default()`) and plotters (`BitMapBackend`, behind the `bitmap_backend` feature). The
# kernel compiled exact crate sources that sit in the local cargo registry: a round that
# quotes them teaches what the compiler hint cannot.
CRATE_API_CAP = 3200
CRATE_API_MAX_CRATES = 3
_DEP_LINE_RE = re.compile(r"^\s*:dep\s+([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$", re.M)
_CRATE_DIR_RE = re.compile(r"^([A-Za-z0-9_-]+?)-(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$")
_RUST_API_ERR_RES = (
    ("method", re.compile(r"no method named `(\w+)` found for [\w ]*?`([^`]+)`")),
    ("assoc", re.compile(r"no (?:associated function or constant|associated function|"
                         r"associated item|function or associated item|"
                         r"variant or associated item|variant) named `(\w+)` found for "
                         r"[\w ]*?`([^`]+)`")),
    ("name", re.compile(r"cannot find (?:type|value|function|struct|macro|trait|"
                        r"struct, variant or union type|derive macro|attribute macro) "
                        r"`(\w+)` in (?:this scope|module `([^`]+)`|crate `([^`]+)`)")),
    ("name", re.compile(r"use of undeclared type `(\w+)`")),
    ("import", re.compile(r"unresolved import `([\w:]+)`")),
    ("import", re.compile(r"could not find `(\w+)` in `([\w:]+)`")),
    # Linking, not API (2.3b, #27134): a crate the kernel did not link (its `:dep` cell
    # failed, or no `:dep` declares it) and a crate linked at two versions. Neither is a
    # name to look up INSIDE a crate; `_crate_link_lines` advises them.
    ("crate", _UNLINKED_CRATE_RE),
    ("version", re.compile(r"(?:two|multiple) different versions of crate `(\w+)`")),
    # E0603 (2.3b, 21/11): `use rand::{Rng, SeedableRng, Distribution}` under rand 0.10 —
    # `rand::Distribution` is a PRIVATE import of the crate root, and the compiler's
    # "import `Distribution` directly" names `rand::distr::distribution::Distribution`,
    # which crosses the private module `distribution`. The public paths are
    # `rand::distr::Distribution` and `rand::prelude::Distribution`: only the sources say so.
    # Methods and associated functions (E0624) are a different privacy and stay out.
    ("private", re.compile(r"(?<!associated )\b(trait|struct|enum|union|function|module|"
                           r"constant|static|type alias|macro) `(\w+)` is private")),
)


def _crate_norm(name: str) -> str:
    return (name or "").replace("-", "_").lower()


def cell_deps(cells: list[dict]) -> dict[str, dict]:
    """`:dep` declarations of an evcxr notebook: name -> {req, features, default_features,
    idx}. `:dep x = "0.10"` and `:dep x = { version = "0.3", default-features = false,
    features = ["evcxr"] }`; path/git deps carry no registry version (req None)."""
    out: dict[str, dict] = {}
    for idx, c in enumerate(cells):
        if c.get("cell_type") != "code":
            continue
        for m in _DEP_LINE_RE.finditer(_text(c.get("source"))):
            name, spec = m.group(1), m.group(2)
            req, feats, dflt = None, [], True
            if spec.startswith('"'):
                req = spec.strip('"').strip()
            else:
                v = re.search(r'\bversion\s*=\s*"([^"]+)"', spec)
                req = v.group(1) if v else None
                f = re.search(r"\bfeatures\s*=\s*\[([^\]]*)\]", spec)
                feats = re.findall(r'"([^"]+)"', f.group(1)) if f else []
                d = re.search(r"\bdefault[-_]features\s*=\s*(true|false)", spec)
                dflt = not (d and d.group(1) == "false")
            out.setdefault(name, {"req": req, "features": feats, "default_features": dflt,
                                  "idx": idx})
    return out


def _req_matches(req: str | None, ver: tuple[int, int, int]) -> bool:
    """Cargo's default (caret) requirement, plus `=`, `~`, `>=` and `*`."""
    r = (req or "*").split(",")[0].strip()
    if r in ("", "*"):
        return True
    op = ""
    for o in (">=", "^", "=", "~"):
        if r.startswith(o):
            op, r = o, r[len(o):].strip()
            break
    m = re.match(r"(\d+)(?:\.(\d+|\*))?(?:\.(\d+|\*))?", r)
    if not m:
        return False
    parts = [int(x) if x and x != "*" else None for x in m.groups()]
    floor = tuple(p or 0 for p in parts)
    if op == ">=":
        return ver >= floor
    if op == "=":
        return all(p is None or p == v for p, v in zip(parts, ver))
    if ver < floor:
        return False
    maj, mnr, pat = parts
    if op == "~":
        return ver[0] == maj and (mnr is None or ver[1] == mnr)
    if maj > 0:
        return ver[0] == maj
    if mnr is None:
        return ver[0] == 0
    if mnr > 0:
        return ver[:2] == (0, mnr)
    return ver[:2] == (0, 0) if pat is None else ver == (0, 0, pat)


def cargo_registry_roots() -> list[Path]:
    home = Path(os.environ.get("CARGO_HOME") or (Path.home() / ".cargo"))
    src = home / "registry" / "src"
    return sorted(p for p in src.iterdir() if p.is_dir()) if src.is_dir() else []


def registry_crate_dir(name: str, req: str | None,
                       roots: list[Path] | None = None) -> tuple[Path, str] | None:
    """The highest stable version of `name` in the local cargo registry that `req` accepts —
    the copy evcxr resolved and compiled on this host — as (dir, "X.Y.Z")."""
    best: tuple[tuple[int, int, int], Path] | None = None
    for root in roots if roots is not None else cargo_registry_roots():
        for d in root.iterdir():
            m = _CRATE_DIR_RE.match(d.name)
            if not m or m.group(5) or _crate_norm(m.group(1)) != _crate_norm(name):
                continue
            ver = (int(m.group(2)), int(m.group(3)), int(m.group(4)))
            if _req_matches(req, ver) and (best is None or ver > best[0]):
                best = (ver, d)
    return (best[1], ".".join(map(str, best[0]))) if best else None


def rust_api_errors(errors: str) -> list[dict]:
    """API misses a rustc diagnostic names: {kind, item, owner, crate}. `owner` is the type a
    method/associated item was looked up on, generics and path stripped; `crate` is the
    path's first segment when the diagnostic spells one (`plotters::series::LineSeries`)."""
    text = _ANSI_RE.sub("", errors or "")
    out: list[dict] = []
    for kind, rx in _RUST_API_ERR_RES:
        for m in rx.finditer(text):
            g = [x for x in m.groups()]
            item, owner, path = g[0], None, None
            if kind == "private":
                # The defining path the compiler advises — a crate name, and the path the
                # block must warn against when it crosses a private module.
                item = g[1]
                hint = re.search(rf"import `{re.escape(item)}` directly\s*\n(?:\s*\n)*\s*"
                                 r"([A-Za-z_][\w:]*)", text[m.end():m.end() + 400])
                path = hint.group(1) if hint else None
                e = {"kind": kind, "item": item, "owner": None,
                     "crate": path.split("::")[0] if path else None,
                     "noun": g[0], "hint": path}
                if e not in out:
                    out.append(e)
                continue
            if kind in ("method", "assoc"):
                full = re.sub(r"<.*$", "", g[1]).lstrip("&").strip()
                full = re.sub(r"^(?:mut|dyn|impl)\s+", "", full)
                segs = full.split("::")
                owner, path = segs[-1], (full if len(segs) > 1 else None)
            elif kind == "name":
                path = next((x for x in g[1:] if x), None)
            elif kind == "import":
                if len(g) > 1 and g[1]:
                    path = g[1]
                else:
                    segs = item.split("::")
                    item, path = segs[-1], ("::".join(segs[:-1]) or None)
            e = {"kind": kind, "item": item, "owner": owner,
                 "crate": path.split("::")[0] if path else None}
            if e not in out:
                out.append(e)
    return out


def _crate_files(crate_dir: Path) -> list[tuple[str, list[str]]]:
    """(relpath, lines) of the crate's library sources, tests/benches/examples excluded."""
    src = crate_dir / "src"
    out = []
    for p in sorted(src.rglob("*.rs")) if src.is_dir() else []:
        rel = p.relative_to(crate_dir).as_posix()
        if re.search(r"(^|/)(tests?|benches|examples)(/|\.rs$)", rel[4:]):
            continue
        try:
            out.append((rel, p.read_text(encoding="utf-8", errors="replace").split("\n")))
        except OSError:
            continue
    return out


def _code_part(line: str) -> str:
    """The line without `//` comments and string/char literals (for brace counting)."""
    s = re.sub(r'"(?:[^"\\]|\\.)*"', '""', line)
    s = re.sub(r"'(?:\\.|[^'\\])'", "''", s)
    return s.split("//", 1)[0]


def _signature(lines: list[str], i: int) -> str:
    """One declaration, joined over up to 5 lines, cut before its body or `where` clause."""
    buf = []
    for line in lines[i:i + 5]:
        buf.append(_code_part(line).strip())
        if re.search(r"[{;]", buf[-1]) or re.search(r"^\s*where\b", buf[-1]):
            break
    sig = re.sub(r"\s+", " ", " ".join(buf))
    sig = re.split(r"\s*\{|\s+where\b|;", sig)[0].replace("( ", "(").replace(" )", ")")
    return sig[:220]


def _block_end(lines: list[str], i: int) -> int:
    """Index of the line closing the `{` block opened at (or just after) line i."""
    depth, opened = 0, False
    for j in range(i, len(lines)):
        code = _code_part(lines[j])
        depth += code.count("{") - code.count("}")
        opened = opened or "{" in code
        if opened and depth <= 0:
            return j
    return len(lines) - 1


def _feature_gates(lines: list[str], i: int) -> list[str]:
    """Features of the `#[cfg(feature = "...")]` attributes right above line i."""
    gates: list[str] = []
    j = i - 1
    while j >= 0 and re.match(r"^\s*(#\[|///|//!|$)", lines[j]) and lines[j].strip():
        if re.match(r"^\s*#\[cfg\(", lines[j]):
            gates += re.findall(r'feature\s*=\s*"([^"]+)"', lines[j])
        j -= 1
    return gates


def _module_path(crate: str, rel: str, lines: list[str], i: int) -> str:
    """`crate::a::b` of the item at line i: file path + enclosing inline `mod x {`."""
    mods = [m for m in rel[4:-3].split("/") if m not in ("lib", "mod", "main")]
    inline: list[str] = []
    depth = 0
    for j in range(i - 1, -1, -1):
        code = _code_part(lines[j])
        depth += code.count("}") - code.count("{")
        if depth < 0:
            m = re.match(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)", code)
            if m:
                inline.insert(0, m.group(1))
            depth = 0
    return "::".join([_crate_norm(crate)] + mods + inline)


def _crate_features(crate_dir: Path) -> dict[str, list[str]]:
    try:
        toml = (crate_dir / "Cargo.toml").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    m = re.search(r"^\[features\]\s*$(.*?)(?=^\[|\Z)", toml, re.M | re.S)
    if not m:
        return {}
    return {k: re.findall(r'"([^"]+)"', v)
            for k, v in re.findall(r"^([A-Za-z0-9_-]+)\s*=\s*\[(.*?)\]", m.group(1), re.M | re.S)}


def _enabled_features(spec: dict, table: dict[str, list[str]]) -> set[str]:
    todo = list(spec.get("features") or []) + (["default"] if spec.get("default_features", True)
                                              else [])
    seen: set[str] = set()
    while todo:
        f = todo.pop()
        if f in seen:
            continue
        seen.add(f)
        todo.extend(x for x in table.get(f, []) if x in table)
    return seen


_PUB_DEF_RE = r"^\s*pub(?:\([^)]*\))?\s+(?:struct|enum|type|trait|union)\s+{n}\b"
# What DECLARES or re-exports a name; the broad form (any `pub` line naming it, e.g. a
# return type) is only the fallback when nothing declares it.
_PUB_NAME_RE = (r"^\s*pub(?:\([^)]*\))?\s+(?:use\s+[^;]*\b{n}\b|(?:struct|enum|type|trait|"
                r"union|fn|mod|const|static)\s+{n}\b)")


def _find_name(files, item: str, limit: int = 3):
    n = re.escape(item)
    return (_find(files, _PUB_NAME_RE.format(n=n), re.I, limit=limit)
            or _find(files, rf"^\s*pub\b.*\b{n}\b", re.I, limit=limit))


def _find(files, pattern: str, flags: int = 0, limit: int = 4):
    rx = re.compile(pattern, flags)
    hits = []
    for rel, lines in files:
        for i, line in enumerate(lines):
            if not line.lstrip().startswith("//") and rx.search(line):
                hits.append((rel, lines, i))
                if len(hits) >= limit:
                    return hits
    return hits


def _impl_header_type(header: str) -> tuple[str | None, str | None]:
    """(trait, self type name) of an `impl<...> Trait for Type<...>` header line."""
    h = _code_part(header).strip()
    if not h.startswith("impl"):
        return None, None
    h = h[4:].lstrip()
    if h.startswith("<"):                        # skip the balanced generic list
        depth = 0
        for k, ch in enumerate(h):
            depth += (ch == "<") - (ch == ">")
            if depth == 0:
                h = h[k + 1:].lstrip()
                break
    m = re.match(r"(?:(.+?)\s+for\s+)?&?(?:mut\s+)?([\w:]+)", h)
    if not m:
        return None, None
    trait = re.sub(r"<.*$", "", m.group(1)).split("::")[-1] if m.group(1) else None
    return trait, m.group(2).split("::")[-1]


def _qualified_fn(lines: list[str], i: int) -> str:
    """`Type::name(…)` for a method, from the nearest enclosing less-indented `impl`."""
    sig = re.sub(r"^pub(?:\([^)]*\))?\s+(?:const\s+)?(?:unsafe\s+)?fn\s+", "",
                 _signature(lines, i))
    indent = len(lines[i]) - len(lines[i].lstrip())
    for j in range(i - 1, -1, -1):
        line = lines[j]
        if line.strip() and len(line) - len(line.lstrip()) < indent:
            if re.match(r"^\s*impl\b", line):
                trait, ty = _impl_header_type(_signature(lines, j))
                if ty:
                    return f"{ty}::{sig}"
            if re.match(r"^\s*(?:pub\s+)?(?:mod|fn|trait)\b", line):
                break
    return f"fn {sig}"


def _owner_api(files, owner: str) -> list[str]:
    """Inherent `pub fn` signatures of `owner` and the traits it implements."""
    out, traits = [], []
    for rel, lines in files:
        for i, line in enumerate(lines):
            if not re.match(r"^\s*impl\b", line) or owner not in line:
                continue
            trait, ty = _impl_header_type(_signature(lines, i))
            if ty != owner:
                continue
            if trait:
                if trait not in traits:
                    traits.append(trait)
                continue
            end = _block_end(lines, i)
            for k in range(i + 1, end):
                if re.match(r"^\s*pub(?:\([^)]*\))?\s+(?:const\s+)?(?:unsafe\s+)?fn\s+\w+",
                            lines[k]):
                    sig = re.sub(r"^pub(?:\([^)]*\))?\s+(?:const\s+)?(?:unsafe\s+)?fn\s+",
                                 "", _signature(lines, k))
                    out.append(f"  {owner}::{sig}   [{rel}:{k + 1}]")
    if traits:
        out.append(f"  {owner} implémente : {', '.join(traits[:12])}")
    return out[:14]


def _extension_traits(files, crate: str) -> list[str]:
    """Methods of the traits the crate DEFINES and re-exports at its root (`pub use
    rng::{Fill, RngExt}`): an extension trait must be imported for its methods to exist."""
    lib = next((ls for rel, ls in files if rel == "src/lib.rs"), [])
    names: list[str] = []
    for line in lib:
        if re.match(r"^pub use\b", line):
            names += [n for n in re.findall(r"\b([A-Z]\w*)\b", line) if n not in names]
    out = []
    for n in names:
        for rel, lines, i in _find(files, rf"^\s*pub\s+trait\s+{re.escape(n)}\b", limit=1):
            end = _block_end(lines, i)
            meths = [f"    {_signature(lines, k)}" for k in range(i + 1, end)
                     if re.match(r"^\s{4}fn\s+\w+", lines[k])]
            if meths:
                out.append(f"  trait {_crate_norm(crate)}::{n} (à importer : "
                           f"`use {_crate_norm(crate)}::{n};`) [{rel}:{i + 1}]")
                out += meths[:9]
    return out[:22]


def _crate_dep_req(crate_dir: Path, dep: str) -> str | None:
    """The version requirement `crate_dir`'s Cargo.toml puts on `dep`, if it depends on it
    (registry-normalized `[dependencies.x]` tables, or inline `x = "..."` / `x = {...}`)."""
    try:
        toml = (crate_dir / "Cargo.toml").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    for m in re.finditer(r"^\[dependencies\.([A-Za-z0-9_-]+)\]\s*$(.*?)(?=^\[|\Z)", toml,
                         re.M | re.S):
        if _crate_norm(m.group(1)) == _crate_norm(dep):
            v = re.search(r'^\s*version\s*=\s*"([^"]+)"', m.group(2), re.M)
            return v.group(1) if v else None
    m = re.search(r"^\[dependencies\]\s*$(.*?)(?=^\[|\Z)", toml, re.M | re.S)
    for k, v in re.findall(r"^([A-Za-z0-9_-]+)\s*=\s*(.+)$", m.group(1) if m else "", re.M):
        if _crate_norm(k) == _crate_norm(dep):
            if v.strip().startswith('"'):
                return v.strip().strip('"')
            vv = re.search(r'\bversion\s*=\s*"([^"]+)"', v)
            return vv.group(1) if vv else None
    return None


def _cell_fails(cell: dict) -> bool:
    return any(isinstance(o, dict) and o.get("output_type") == "error"
               for o in cell.get("outputs") or [])


def _ver_tuple(v: str) -> tuple[int, int, int]:
    return tuple((list(map(int, re.findall(r"\d+", v)[:3])) + [0, 0, 0])[:3])


def _mod_is_public(files, crate: str, path: str) -> bool:
    """Every module on `crate::a::b` is declared plain `pub mod` in its parent. A re-export
    reached through a private (or `pub(crate)`) module is not importable from a notebook."""
    segs = path.split("::")[1:]
    for k, seg in enumerate(segs):
        parent = "::".join([_crate_norm(crate)] + segs[:k])
        decl = next((ls[i] for rel, ls, i in
                     _find(files, rf"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+{re.escape(seg)}\b",
                           limit=20)
                     if _module_path(crate, rel, ls, i) == parent), None)
        if decl is None or not re.match(r"^\s*pub\s+mod\b", _code_part(decl)):
            return False
    return True


def _use_statement(lines: list[str], i: int) -> str:
    """The `use` statement starting at line i, joined up to its `;` (12 lines at most)."""
    buf = []
    for line in lines[i:i + 12]:
        buf.append(_code_part(line).strip())
        if ";" in buf[-1]:
            break
    return re.sub(r"\s+", " ", " ".join(buf)).split(";", 1)[0]


def _private_item_lines(files, crate: str, e: dict) -> list[str]:
    """E0603: the importable paths of a name the notebook reached through a private path —
    its plain `pub use` re-exports and its `pub` definition, each kept only when every
    module on the way is `pub mod` — plus the private paths not to follow."""
    item, n = e["item"], re.escape(e["item"])
    noun = e.get("noun") or ""
    public: list[tuple[str, str]] = []
    private: list[str] = []
    if noun == "module":
        # A private module: what its items are re-exported as, and where.
        lines = [f"- le module `{item}` est privé ; ses éléments sont réexportés par :"]
        for rel, ls, i in _find(files, r"^\s*pub\s+use\b", limit=400):
            stmt = _use_statement(ls, i)
            if re.search(rf"\b{n}::", stmt):
                mp = _module_path(crate, rel, ls, i)
                if _mod_is_public(files, crate, mp):
                    lines.append(f"  {stmt}   [{rel}:{i + 1}, dans {mp}]")
        return lines if len(lines) > 1 else [lines[0] + " (aucune réexportation publique)"]
    for rel, ls, i in _find(files, r"^\s*pub\s+use\b", limit=400):
        stmt = _use_statement(ls, i)
        # The name itself is re-exported (last segment, not renamed, not a path prefix).
        if not re.search(rf"\b{n}\b(?!\s*::)(?!\s+as\b)", stmt):
            continue
        mp = _module_path(crate, rel, ls, i)
        (public.append((f"{mp}::{item}", f"{rel}:{i + 1}"))
         if _mod_is_public(files, crate, mp) else private.append(f"{mp}::{item}"))
    defined = ""
    for rel, ls, i in _find(files, rf"^\s*pub\s+(?:struct|enum|type|trait|union|fn|const|"
                                   rf"static|mod)\s+{n}\b", limit=1):
        mp = _module_path(crate, rel, ls, i)
        open_ = _mod_is_public(files, crate, mp)
        (public.append((f"{mp}::{item}", f"{rel}:{i + 1}"))
         if open_ else private.append(f"{mp}::{item}"))
        defined = (f"  défini ici : {_signature(ls, i)}   [{rel}:{i + 1}, module {mp}"
                   + ("]" if open_ else ", privé]"))
    # A private `use` at the crate root is the path the notebook most likely wrote
    # (`rand::Distribution` is `use crate::distr::{Distribution, …}` in src/lib.rs). Deeper
    # private imports are the crate's own plumbing (rand's `distr::uniform`), not advice.
    roots = [f"{_crate_norm(crate)}::{item}"
             for rel, ls, i in _find(files, rf"^\s*use\s+[^;]*\b{n}\b", limit=200)
             if _module_path(crate, rel, ls, i) == _crate_norm(crate)][:1]
    public = sorted(dict(public).items(), key=lambda kv: (kv[0].count("::"), kv[0]))[:4]
    lines = [f"- `{item}` n'est pas importable par le chemin écrit"
             + (" ; chemins publics :" if public else " ; aucun chemin public trouvé :")]
    lines += [f"  use {p};   [{where}]" for p, where in public]
    bad = [p for p in dict.fromkeys(([e["hint"]] if e.get("hint") else []) + private + roots)
           if p not in dict(public)]
    if bad:
        lines.append("  NE PAS utiliser (import privé ou module privé, y compris le chemin "
                     "que conseille le compilateur) : "
                     + ", ".join(f"`{p}`" for p in bad[:4]))
    if defined:
        lines.append(defined)
    return lines


def _absent_line(name: str, deps: dict[str, dict]) -> str:
    """The fact cargo established, and the declared crate whose name it extends, if any."""
    norm = _crate_norm(name)
    near = sorted((n for n in deps if _crate_norm(n) != norm
                   and norm.startswith(_crate_norm(n) + "_")), key=len, reverse=True)
    hint = (f" ; la crate déclarée la plus proche est `{near[0]}` (cellule "
            f"{deps[near[0]]['idx']}) : cherche ces items dans ses sources") if near else ""
    return (f"- `{name}` N'EXISTE PAS sur crates.io (cargo : « no matching package named "
            f"`{name}` found ») : n'écris jamais `:dep {name}`, ni `use {norm}::…` ; les "
            f"cellules qui l'importent doivent prendre ces items dans une crate qui "
            f"existe{hint}.")


def _crate_link_lines(errs: list[dict], deps: dict[str, dict],
                      resolved: dict[str, tuple[Path, str]], cells: list[dict],
                      roots: list[Path] | None,
                      absent: list[str] | tuple = ()) -> tuple[list[str], list[str]]:
    """Advice on LINKING, before any API lookup (2.3b, #27134). Three causes, each with its
    own remedy:
      - a crate declared in a `:dep` cell that itself fails: evcxr links none of that cell's
        crates, so every later `unlinked crate` is a cascade — repair that cell first;
      - a crate used but never declared: add its `:dep`, at the requirement the notebook's
        other crates write in their Cargo.toml when they depend on it;
      - a declared version their dependents do not accept (`:dep ndarray = "0.17"` next to
        linfa 0.8.1, which requires "0.16"): two copies get linked and their types never
        match — align it.
    A crate in ``absent`` (cargo: "no matching package named … found", earlier in the run)
    is never advised as missing: its line says it does not exist, every round.
    Returns (lines, names of the crates whose errors are cascades/advice, not API misses)."""
    dep_norm = {_crate_norm(n): n for n in deps}
    gone = {_crate_norm(a) for a in absent}
    first_dep = min((s["idx"] for s in deps.values()), default=None)
    unlinked: list[str] = []
    for e in errs:
        if e["kind"] in ("crate", "version") and e["item"] not in unlinked:
            unlinked.append(e["item"])

    def users_of(x: str) -> list[tuple[str, str, str]]:
        return [(n, resolved[n][1], r) for n in resolved if _crate_norm(n) != _crate_norm(x)
                and (r := _crate_dep_req(resolved[n][0], x))]

    lines: list[str] = []
    linked: list[str] = []
    blocked: dict[int, list[str]] = {}
    for x in unlinked:
        if _crate_norm(x) in gone:
            linked.append(x)                  # advised by its absent line, never "add it"
            continue
        declared = dep_norm.get(_crate_norm(x))
        if declared and 0 <= deps[declared]["idx"] < len(cells) \
                and _cell_fails(cells[deps[declared]["idx"]]):
            blocked.setdefault(deps[declared]["idx"], []).append(x)
            linked.append(x)
        elif not declared:
            users = users_of(x)
            req = users[0][2] if users else None
            local = registry_crate_dir(x, req, roots)
            by = ("; " + ", ".join(f"{n} {v} en dépend en \"{r}\"" for n, v, r in users)) \
                if users else ""
            loc = f" (copie locale : {x} {local[1]})" if local else ""
            where = f" dans la cellule {first_dep}" if first_dep is not None else ""
            lines.append(f"- `{x}` n'est déclarée dans aucun `:dep` : ajoute "
                         f"`:dep {x} = \"{req or (local[1] if local else '…')}\"`{where}"
                         f"{loc}{by}.")
            linked.append(x)
    for idx, xs in sorted(blocked.items()):
        lines.insert(0, f"- La cellule {idx} déclare les `:dep` mais elle ÉCHOUE : tant qu'elle "
                        f"échoue, evcxr ne lie aucune de ses crates, d'où les « unlinked crate » "
                        f"plus bas ({', '.join(f'`{x}`' for x in xs)}). Répare d'abord ses "
                        f"propres erreurs ; ces erreurs-là disparaîtront avec elles.")
    for a in reversed(list(absent)):
        lines.insert(0, _absent_line(a, deps))
    # Version coherence among the declared crates, checked on every Rust round: rustc only
    # names the clash ("two different versions of crate") once a value crosses the boundary.
    for x, spec in deps.items():
        if x not in resolved:
            continue
        have = _ver_tuple(resolved[x][1])
        bad = [(n, v, r) for n, v, r in users_of(x) if n in deps and not _req_matches(r, have)]
        if not bad:
            continue
        req = bad[0][2]
        local = registry_crate_dir(x, req, roots)
        loc = f" (copie locale : {x} {local[1]})" if local else ""
        lines.append(f"- `:dep {x} = \"{spec['req']}\"` (cellule {spec['idx']}) donne {x} "
                     f"{resolved[x][1]}, mais " + ", ".join(f"{n} {v}" for n, v, _ in bad)
                     + f" en dépend{'ent' if len(bad) > 1 else ''} en \"{req}\" : deux copies de "
                     f"`{x}` seront liées, et une valeur de l'une n'est pas acceptée là où l'autre "
                     f"est attendue — si le notebook passe des valeurs `{x}` à ces crates, écris "
                     f"`:dep {x} = \"{req}\"`{loc}.")
        if x not in linked:
            linked.append(x)
    return lines, linked


def crate_api_block(cells: list[dict], errors: list[str],
                    roots: list[Path] | None = None,
                    absent: list[str] | tuple = ()) -> tuple[str, dict]:
    """The REAL API of the crates a Rust repair round's errors touch, quoted from the
    registry copy the kernel compiled. Returns (block, info) — info = {crates, dep_cell,
    gated, unknown} for the round record; ("", {}) when nothing applies."""
    deps = cell_deps(cells)
    errs: list[dict] = []
    for t in errors:
        errs += [e for e in rust_api_errors(t) if e not in errs]
    if (not deps or not errs) and not absent:
        return "", {}
    resolved: dict[str, tuple[Path, str]] = {}
    for name, spec in deps.items():
        hit = registry_crate_dir(name, spec["req"], roots)
        if hit:
            resolved[name] = hit
    link_lines, linked = _crate_link_lines(errs, deps, resolved, cells, roots, absent)
    # A missing or doubled crate is advised once, never searched as a name inside another
    # crate (`ndarray` would match any linfa line that spells `ndarray::Dimension`).
    errs = [e for e in errs if e["kind"] not in ("crate", "version")
            and not (e["kind"] == "import" and e["crate"] is None and e["item"] in linked)
            and not (e["crate"] in linked and e["crate"] not in resolved)]
    if not resolved and not link_lines:
        return "", {}
    files_of: dict[str, list] = {}

    def files(name):
        if name not in files_of:
            files_of[name] = _crate_files(resolved[name][0])
        return files_of[name]

    by_norm = {_crate_norm(n): n for n in resolved}
    per_crate: dict[str, list[dict]] = {}
    unknown: list[str] = []
    for e in errs:
        target = by_norm.get(_crate_norm(e["crate"])) if e["crate"] else None
        key = e["owner"] or e["item"]
        if target is None:
            for name in resolved:
                if e["kind"] in ("method", "assoc"):
                    if _find(files(name), _PUB_DEF_RE.format(n=re.escape(key)), limit=1):
                        target = name
                        break
                elif _find_name(files(name), e["item"], limit=1):
                    target = name
                    break
        if target is not None:
            per_crate.setdefault(target, []).append(e)
        elif (e["kind"] in ("name", "import") and e["item"][:1].isupper()
              and not any(c.get("cell_type") == "code"
                          and (declares(_text(c.get("source")), e["item"])
                               or binds(_text(c.get("source")), e["item"]))
                          for c in cells) and e["item"] not in unknown):
            unknown.append(e["item"])
    if not per_crate and not unknown and not link_lines:
        return "", {}
    parts: list[str] = (["Crates à lier :\n" + "\n".join(link_lines)] if link_lines else [])
    gated: list[str] = []
    for name in list(per_crate)[:CRATE_API_MAX_CRATES]:
        crate_dir, version = resolved[name]
        spec, fl = deps[name], files(name)
        table = _crate_features(crate_dir)
        enabled = _enabled_features(spec, table)
        lines = [f"crate {name} {version} — `:dep` demande "
                 f"\"{spec['req']}\" (cellule {spec['idx']})"]
        for e in per_crate[name]:
            if e["kind"] in ("method", "assoc"):
                lines.append(f"- `{e['owner']}` n'a pas `{e['item']}` ; ce qui existe :")
                for rel, ls, i in _find(fl, _PUB_DEF_RE.format(n=re.escape(e["owner"])),
                                        limit=1):
                    lines.append(f"  {_signature(ls, i)}   [{rel}:{i + 1}]")
                lines += _owner_api(fl, e["owner"])
                if e["kind"] == "method":
                    lines += _extension_traits(fl, name)
                near = _find(fl, rf"^\s*pub\s+fn\s+(?:\w+_)?{re.escape(e['item'])}(?:_\w+)?\b",
                             re.I, limit=4)
                lines += [f"  voisin : {_qualified_fn(ls, i)}   [{rel}:{i + 1}]"
                          for rel, ls, i in near]
            elif e["kind"] == "private":
                lines += _private_item_lines(fl, name, e)
            else:
                hits = _find_name(fl, e["item"])
                lines.append(f"- `{e['item']}` introuvable tel quel ; dans les sources :")
                for rel, ls, i in hits:
                    gates = _feature_gates(ls, i)
                    off = [g for g in gates if g not in enabled]
                    gated += [g for g in off if g not in gated]
                    lines.append(f"  {_signature(ls, i)}   [{rel}:{i + 1}, chemin "
                                 f"{_module_path(name, rel, ls, i)}"
                                 + (f", feature {', '.join(gates)}"
                                    + (" NON activée" if off else " activée") if gates else "")
                                 + "]")
        if table:
            lines.append(f"  features de {name} : {', '.join(sorted(table)[:30])} ; "
                         f"activées ici : {', '.join(sorted(f for f in enabled if f in table)) or 'aucune'}")
        parts.append("\n".join(dict.fromkeys(lines)))
    if unknown:
        parts.append(f"Introuvables dans les sources de {', '.join(resolved)} : "
                     + ", ".join(f"`{u}`" for u in unknown)
                     + " — ces noms n'existent pas dans ces versions, ne les utilise pas.")
    block = "\n\n".join(parts)
    if len(block) > CRATE_API_CAP:
        block = block[:CRATE_API_CAP].rsplit("\n", 1)[0] + "\n[… extrait tronqué …]"
    used = list(per_crate)[:CRATE_API_MAX_CRATES]
    dep_cells = sorted({deps[n]["idx"] for n in used})
    if not dep_cells and link_lines and deps:
        dep_cells = [min(s["idx"] for s in deps.values())]
    info = {"crates": [f"{n} {resolved[n][1]}" for n in used],
            "dep_cell": dep_cells[0] if dep_cells else None,
            "gated": gated, "unknown": unknown}
    if linked:
        info["link"] = linked
    if absent:
        info["absent"] = list(absent)
    return block, info


# ------------------------------------------------------------ .NET API grounding (22/11)
# Measured 22/11 on the ICT-15 C# salvage (CoursIA#27735/27736/27740/27741): every grain
# died on ScottPlot 5 members the model remembered from another version — `LineStyle.Dash`
# (real: `LinePattern.Dashed`), `Heatmap.ColorScale` (real: `Colormap`), `DefaultGrid
# .AddSubplot`, `ScottPlot.TickGenerators.FixedLabels` — and four repair rounds per grain
# rewrote the same figure cell with a new invented name each time. The compiler message
# names the member that is missing, never the ones that exist. The Rust rounds get that
# truth from the registry sources (crate_api_block); the .NET rounds get it from the
# kernel that just compiled the cell: reflection over the package assemblies, exact
# version. A package assembly is loaded lazily, so a cell that failed to compile never
# loaded it — the probe loads it from the NuGet cache first (measured: ScottPlot absent
# from the AppDomain after `#r "nuget: ScottPlot, 5.0.55"` alone).
DOTNET_API_HEAD = "API RÉELLE DES PAQUETS .NET"
DOTNET_API_CAP = 4800
DOTNET_API_SECTION_MIN = 500
DOTNET_API_MAX_QUERIES = 6
DOTNET_PROBE_TIMEOUT_S = 120
_CS_DIAG_RE = re.compile(r"error (CS\d{4}):\s*([^\r\n]*)")
_CS_MEMBER_RE = re.compile(r"'([^']+)' (?:does not contain a definition for|"
                           r"ne contient pas de définition pour) '([^']+)'")
_CS_NS_RE = re.compile(r"(?:The type or namespace name|Le nom de type ou d'espace de noms) "
                       r"'([^']+)' (?:does not exist in the namespace|"
                       r"n'existe pas dans l'espace de noms) '([^']+)'")
_CS_TYPE_RE = re.compile(r"(?:The type or namespace name|Le nom de type ou d'espace de noms) "
                         r"'([^']+)' (?:could not be found|est introuvable)")
_CS_PARAM_RE = re.compile(r"(?:parameter|paramètre)\b[^']*'[^']+' (?:of|de) '([^'(]+)\(")
_CS_OVERLOAD_RE = re.compile(r"(?:No overload for method|Aucune surcharge pour la méthode) "
                             r"'([^']+)'")
_CS_CTOR_RE = re.compile(r"'([^']+)' (?:does not contain a constructor that takes|"
                         r"ne contient pas de constructeur qui accepte)")
_CS_READONLY_RE = re.compile(r"(?:Property or indexer|propriété ou l'indexeur) '([^']+)\.([^'.]+)'")
_CS_BUILTIN = {"bool", "byte", "char", "decimal", "double", "float", "int", "long", "object",
               "sbyte", "short", "string", "uint", "ulong", "ushort", "void", "var", "dynamic"}
_NUGET_REF_RE = re.compile(r'^\s*#r\s+"nuget:\s*([A-Za-z0-9_.\-]+)\s*(?:,\s*([^"]*?))?\s*"',
                           re.M)
_DLL_REF_RE = re.compile(r'^\s*#r\s+"(?!nuget:)([^"]+\.dll)"', re.M | re.I)


def _cs_simple(name: str) -> str:
    """`ScottPlot.Plottables.Heatmap` / `List<double>` / `double[]` -> the bare type name."""
    base = re.sub(r"<.*$", "", re.sub(r"\[[,\s]*\]$", "", (name or "").strip()))
    return base.rsplit(".", 1)[-1].strip()


def dotnet_api_queries(errors: list[str], cells: list[dict]) -> list[tuple[str, str, str]]:
    """(kind, owner, item) probes from the compiler diagnostics of a .NET repair round:
    `member` (CS0117/CS1061/CS1929 — owner lacks item; CS0200 — item is read-only), `ns`
    (CS0234 — namespace lacks item), `call` (CS7036/CS1501/CS1729 — overloads of
    owner.item, constructors when item == owner), `type` (CS0246 — no type item).
    A name the notebook itself declares is the cell's business, never a package's: skipped,
    as are the C# keyword types. Deduplicated, capped at DOTNET_API_MAX_QUERIES."""
    srcs = [_text(c.get("source")) for c in cells or [] if c.get("cell_type") == "code"]

    def own(name: str) -> bool:
        return any(declares(s, name) for s in srcs)

    out: list[tuple[str, str, str]] = []

    def add(q):
        if q not in out and len(out) < DOTNET_API_MAX_QUERIES:
            out.append(q)

    for text in errors or []:
        for code, msg in _CS_DIAG_RE.findall(_ANSI_RE.sub("", text or "")):
            if code in ("CS0117", "CS1061", "CS1929"):
                m = _CS_MEMBER_RE.search(msg)
                if m:
                    owner = _cs_simple(m.group(1))
                    if owner and owner not in _CS_BUILTIN and not own(owner):
                        add(("member", owner, m.group(2)))
            elif code == "CS0234":
                m = _CS_NS_RE.search(msg)
                if m:
                    add(("ns", m.group(2).strip(), m.group(1).strip()))
            elif code == "CS7036":
                m = _CS_PARAM_RE.search(msg)
                if m and "." in m.group(1):
                    owner, meth = m.group(1).rsplit(".", 1)
                    owner = _cs_simple(owner)
                    if owner not in _CS_BUILTIN and not own(owner):
                        add(("call", owner, meth.strip()))
            elif code == "CS1501":
                m = _CS_OVERLOAD_RE.search(msg)
                if m and not own(m.group(1)):
                    add(("call", "", m.group(1).strip()))
            elif code == "CS1729":
                m = _CS_CTOR_RE.search(msg)
                if m:
                    owner = _cs_simple(m.group(1))
                    if owner and owner not in _CS_BUILTIN and not own(owner):
                        add(("call", owner, owner))
            elif code == "CS0200":
                m = _CS_READONLY_RE.search(msg)
                if m:
                    owner = _cs_simple(m.group(1))
                    if owner and owner not in _CS_BUILTIN and not own(owner):
                        add(("member", owner, m.group(2)))
            elif code == "CS0246":
                m = _CS_TYPE_RE.search(msg)
                if m:
                    name = _cs_simple(m.group(1))
                    if name and name not in _CS_BUILTIN and not own(name):
                        add(("type", "", name))
    return out


def _version_key(v: str) -> tuple:
    return tuple(int(p) if p.isdigit() else -1 for p in re.split(r"[.\-+]", v))


def nuget_load_paths(cells: list[dict], root: Path | None = None) -> list[str]:
    """What the probe must load before reflecting: for each `#r "nuget: Id[, Ver]"`, the
    package's version directory in the NuGet cache (exact version; a `5.*` prefix or no
    version takes the highest stable one present), and each `#r "<file>.dll"` as written
    (the kernel resolves it from its own cwd). The TFM is chosen kernel-side, against the
    runtime that will load it."""
    root = Path(root) if root else Path.home() / ".nuget" / "packages"
    out: list[str] = []
    for c in cells or []:
        if c.get("cell_type") != "code":
            continue
        src = _text(c.get("source"))
        for pid, ver in _NUGET_REF_RE.findall(src):
            pdir = root / pid.lower()
            try:
                have = [d.name for d in pdir.iterdir() if d.is_dir()]
            except OSError:
                continue
            ver = (ver or "").strip()
            if ver and "*" not in ver:
                pick = ver if ver in have else next((h for h in have if h.lower() == ver.lower()), None)
            else:
                pre = ver.split("*", 1)[0]
                stable = [h for h in have if h.startswith(pre) and "-" not in h]
                pick = max(stable, key=_version_key) if stable else None
            if pick and str(pdir / pick) not in out:
                out.append(str(pdir / pick))
        out += [p for p in _DLL_REF_RE.findall(src) if p not in out]
    return out


def _cs_str(s: str) -> str:
    return '@"' + str(s).replace('"', '""') + '"'


# Kernel-side half of the probe. One block scope: it defines nothing in the submission, and
# the repair round stops this kernel right after anyway. Every reflective call is guarded;
# a type that cannot load is skipped, never an exception out of the cell.
_DOTNET_PROBE_CS = r"""{
var __q = new (string k, string o, string i)[] { /*QUERIES*/ };
var __loads = new string[] { /*LOADS*/ };
var __bf = System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance
         | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.DeclaredOnly;
var __have = new System.Collections.Generic.HashSet<string>(System.AppDomain.CurrentDomain.GetAssemblies()
  .Select(a => a.GetName().Name));
var __mine = new System.Collections.Generic.List<string>();
System.Action<string> __load = p => {
  try {
    var n = System.Reflection.AssemblyName.GetAssemblyName(p).Name;
    if (!__have.Contains(n)) { System.Reflection.Assembly.LoadFrom(p); __have.Add(n); }
    __mine.Add(n);
  } catch { }
};
foreach (var __p in __loads) {
  try {
    var full = System.IO.Path.GetFullPath(__p);
    if (full.EndsWith(".dll", System.StringComparison.OrdinalIgnoreCase)) { __load(full); continue; }
    var lib = System.IO.Path.Combine(full, "lib");
    if (!System.IO.Directory.Exists(lib)) continue;
    var major = System.Environment.Version.Major;
    string best = null; int bestRank = -1;
    foreach (var d in System.IO.Directory.GetDirectories(lib)) {
      var t = System.IO.Path.GetFileName(d).ToLowerInvariant(); int rank = -1;
      var m = System.Text.RegularExpressions.Regex.Match(t, @"^net(\d+)\.(\d+)");
      var c = System.Text.RegularExpressions.Regex.Match(t, @"^netcoreapp(\d+)\.(\d+)");
      var s = System.Text.RegularExpressions.Regex.Match(t, @"^netstandard(\d+)\.(\d+)");
      if (m.Success && int.Parse(m.Groups[1].Value) >= 5 && int.Parse(m.Groups[1].Value) <= major)
        rank = 3000 + int.Parse(m.Groups[1].Value) * 10 + int.Parse(m.Groups[2].Value);
      else if (c.Success) rank = 2000 + int.Parse(c.Groups[1].Value) * 10 + int.Parse(c.Groups[2].Value);
      else if (s.Success) rank = 1000 + int.Parse(s.Groups[1].Value) * 10 + int.Parse(s.Groups[2].Value);
      if (rank > bestRank) { bestRank = rank; best = d; }
    }
    if (best != null) foreach (var f in System.IO.Directory.GetFiles(best, "*.dll")) __load(f);
  } catch { }
}
var __all = System.AppDomain.CurrentDomain.GetAssemblies()
  .Where(a => !a.IsDynamic && (__mine.Contains(a.GetName().Name)
    || (a.Location ?? "").Replace('\\', '/').ToLowerInvariant().Contains("/.nuget/packages/")))
  .SelectMany(a => { try { return a.GetExportedTypes(); }
    catch (System.Reflection.ReflectionTypeLoadException e) { return e.Types.Where(t => t != null && t.IsPublic).ToArray(); }
    catch { return new System.Type[0]; } }).Where(t => !t.IsNested || t.IsNestedPublic).ToArray();
System.Func<System.Type, string> __tn = null;
__tn = t => {
  if (t == null) return "?";
  if (t.IsByRef) return __tn(t.GetElementType());
  if (t.IsArray) return __tn(t.GetElementType()) + "[" + new string(',', t.GetArrayRank() - 1) + "]";
  if (t.IsGenericType) {
    var n = t.Name.Split('`')[0];
    if (n == "Nullable") return __tn(t.GetGenericArguments()[0]) + "?";
    return n + "<" + string.Join(", ", t.GetGenericArguments().Select(__tn)) + ">";
  }
  switch (t.FullName) {
    case "System.Int32": return "int"; case "System.Double": return "double";
    case "System.String": return "string"; case "System.Boolean": return "bool";
    case "System.Single": return "float"; case "System.Void": return "void";
    case "System.Object": return "object"; case "System.Int64": return "long";
    case "System.Byte": return "byte";
  }
  return t.Name;
};
System.Func<System.Reflection.ParameterInfo[], string> __ps = ps => string.Join(", ",
  ps.Select(p => __tn(p.ParameterType) + " " + p.Name + (p.IsOptional ? " = …" : "")));
System.Func<System.Reflection.MemberInfo, string> __m = m => {
  try {
    switch (m) {
      case System.Reflection.ConstructorInfo c: return "new " + __tn(c.DeclaringType) + "(" + __ps(c.GetParameters()) + ")";
      case System.Reflection.MethodInfo mi when !mi.IsSpecialName:
        return (mi.IsStatic ? "static " : "") + __tn(mi.ReturnType) + " " + mi.Name + "(" + __ps(mi.GetParameters()) + ")";
      case System.Reflection.PropertyInfo pi:
        return ((pi.GetMethod ?? pi.SetMethod)?.IsStatic == true ? "static " : "") + __tn(pi.PropertyType) + " " + pi.Name
          + " { " + (pi.GetMethod?.IsPublic == true ? "get; " : "") + (pi.SetMethod?.IsPublic == true ? "set; " : "") + "}";
      case System.Reflection.FieldInfo fi:
        return fi.DeclaringType.IsEnum ? (fi.IsStatic ? "enum " + fi.Name : null)
          : (fi.IsStatic ? "static " : "") + __tn(fi.FieldType) + " " + fi.Name;
    }
  } catch { }
  return null;
};
System.Func<System.Reflection.MemberInfo, bool> __special = m => m is System.Reflection.MethodBase mb && mb.IsSpecialName && !(m is System.Reflection.ConstructorInfo);
// 0 same name · 1 one prefixes the other · 2 one contains the other, or a shared stem of
// 4+ letters (Colormap ~ ColorScale) · 3 unrelated. A name under 3 letters only matches
// itself (measured: `A`, `D` listed as neighbours of `Dash`).
System.Func<string, string, int> __near = (n, i) => {
  var a = n.ToLowerInvariant(); var b = i.ToLowerInvariant();
  if (a == b) return 0;
  if (a.Length < 3 || b.Length < 3) return 3;
  if (a.StartsWith(b) || b.StartsWith(a)) return 1;
  if (a.Contains(b) || b.Contains(a)) return 2;
  var k = 0; while (k < a.Length && k < b.Length && a[k] == b[k]) k++;
  return k >= 4 ? 2 : 3;
};
System.Func<System.Type, string, System.Collections.Generic.List<(int r, string s)>> __members = (t, i) => {
  var ms = new System.Collections.Generic.List<System.Reflection.MemberInfo>();
  for (var b = t; b != null && b.FullName != "System.Object" && b.FullName != "System.ValueType" && b.FullName != "System.Enum"; b = b.BaseType)
    try { ms.AddRange(b.GetMembers(__bf).Where(m => m.MemberType != System.Reflection.MemberTypes.NestedType)); } catch { }
  return ms.Select(m => (r: __near(m.Name, i), s: __m(m))).Where(p => p.s != null)
    .GroupBy(p => p.s).Select(g => g.First()).OrderBy(p => p.r).ToList();
};
foreach (var q in __q) {
  var outl = new System.Collections.Generic.List<string>();
  // the type's members unrelated to the cited name go AFTER the neighbours: a long member
  // list must not push the real answer (LinePattern.Dashed for `Dash`) past the cut
  var rest = new System.Collections.Generic.List<string>();
  if (q.k == "member" || q.k == "call") {
    var owners = q.o == "" ? __all.Where(x => { try { return x.GetMember(q.i, __bf).Length > 0; } catch { return false; } }).Take(3)
                           : __all.Where(x => x.Name.Split('`')[0] == q.o).Take(2);
    foreach (var t in owners) {
      var ms = __members(t, q.i);
      if (q.k == "call") ms = ms.Where(p => q.i == t.Name ? p.s.StartsWith("new " + t.Name + "(") : (p.s.Contains(" " + q.i + "(") || p.s.Contains("." + q.i + "("))).ToList();
      outl.Add("type " + t.FullName + (t.IsEnum ? " (enum)" : "") + (q.k == "member" ? " — membres publics (l'erreur cite `" + q.i + "`) :" : q.i == t.Name ? " — constructeurs :" : " — surcharges de " + q.i + " :"));
      var shown = ms.Take(45).ToList();
      outl.AddRange(shown.Where(p => q.k == "call" || p.r < 3).Select(p => "  " + p.s));
      if (q.k == "member" && shown.Any(p => p.r >= 3))
        rest.Add("autres membres de " + t.Name + " :");
      rest.AddRange(shown.Where(p => q.k == "member" && p.r >= 3).Select(p => "  " + p.s));
      if (ms.Count > 45) rest.Add("  … " + (ms.Count - 45) + " autres membres non listés");
      if (q.k == "member")
        try {
          foreach (var e in __all.Where(x => x.IsAbstract && x.IsSealed)
                     .SelectMany(x => x.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static))
                     .Where(mi => mi.IsDefined(typeof(System.Runtime.CompilerServices.ExtensionAttribute), false)
                       && mi.GetParameters().Length > 0 && !mi.ContainsGenericParameters
                       && mi.GetParameters()[0].ParameterType.IsAssignableFrom(t)).OrderBy(mi => __near(mi.Name, q.i)).Take(10))
            (__near(e.Name, q.i) < 3 ? outl : rest).Add("  extension " + e.DeclaringType.Name + "." + __m(e));
        } catch { }
    }
  }
  if (q.k == "ns") {
    var inNs = __all.Where(x => x.Namespace == q.o).Select(x => x.Name.Split('`')[0]).Distinct().OrderBy(s => s).ToList();
    if (inNs.Count > 0) outl.Add("espace " + q.o + " (n'a pas `" + q.i + "`) : " + string.Join(", ", inNs.Take(60)) + (inNs.Count > 60 ? ", …" : ""));
  }
  if (q.k == "type" || q.k == "ns")
    foreach (var t in __all.Where(x => x.Name.Split('`')[0] == q.i).Take(4)) outl.Add("type " + q.i + " = " + t.FullName);
  if (q.i.Length >= 3) {
    // the faulty type's own package first (measured: SkiaSharp names crowded out ScottPlot's)
    var __root = ((q.k == "ns" ? q.o : __all.FirstOrDefault(x => x.Name.Split('`')[0] == q.o)?.Namespace) ?? "").Split('.')[0];
    System.Func<System.Type, int> __pref = x => __root != "" && (x.Namespace ?? "").Split('.')[0] == __root ? 0 : 1;
    var near = __all.Where(x => __near(x.Name.Split('`')[0], q.i) < 3 && x.Name.Split('`')[0] != q.i)
        .Select(x => (r: __near(x.Name.Split('`')[0], q.i), f: __pref(x), s: "type " + x.FullName))
      .Concat(__all.Where(x => x.IsPublic).SelectMany(x => { try { return x.GetMembers(__bf).Select(m => (x, m)); } catch { return new (System.Type, System.Reflection.MemberInfo)[0]; } })
        .Where(p => !__special(p.Item2) && p.Item2.MemberType != System.Reflection.MemberTypes.NestedType && p.Item2.MemberType != System.Reflection.MemberTypes.Constructor
          && __near(p.Item2.Name, q.i) < 3 && !(p.Item1.Name.Split('`')[0] == q.o))
        .Select(p => (r: __near(p.Item2.Name, q.i), f: __pref(p.Item1), s: p.Item1.Name + "." + p.Item2.Name + " — " + (__m(p.Item2) ?? ""))))
      .OrderBy(p => p.f).ThenBy(p => p.r).Select(p => p.s).Distinct().Take(8).ToList();
    outl.AddRange(near.Select(s => "  voisin : " + s));
  }
  outl.AddRange(rest);
  if (outl.Count > 0) {
    System.Console.WriteLine("@@ " + (q.k == "member" ? q.o + "." + q.i : q.k == "ns" ? q.o + "." + q.i : q.k == "call" ? (q.o == "" ? q.i : q.o + "." + q.i) + "(…)" : q.i));
    foreach (var l in outl) System.Console.WriteLine(l);
  }
}
}"""


def dotnet_probe_code(queries: list[tuple[str, str, str]], loads: list[str],
                      refs: list[str] | None = None) -> str:
    """The kernel-side probe with its queries and load paths spliced in as verbatim C#
    string literals (a `"` doubled), so no value can close a literal early. ``refs`` (the
    notebook's own `#r "nuget: …"` lines) go first on a FRESH kernel: they register the
    package's dependency resolution, which a bare LoadFrom does not."""
    q = ", ".join(f"({_cs_str(k)}, {_cs_str(o)}, {_cs_str(i)})" for k, o, i in queries)
    body = (_DOTNET_PROBE_CS.replace("/*QUERIES*/", q)
            .replace("/*LOADS*/", ", ".join(_cs_str(p) for p in loads)))
    return ("\n".join(refs) + "\n" + body) if refs else body


def nuget_ref_lines(cells: list[dict]) -> list[str]:
    """The notebook's `#r "nuget: …"` directives, verbatim and deduplicated."""
    out: list[str] = []
    for c in cells or []:
        if c.get("cell_type") == "code":
            for m in _NUGET_REF_RE.finditer(_text(c.get("source"))):
                line = m.group(0).strip()
                if line not in out:
                    out.append(line)
    return out


def cap_probe_sections(text: str, cap: int = DOTNET_API_CAP) -> str:
    """Each `@@` section (one diagnostic) gets an equal share of the cap, cut at a line
    boundary: a large type's member list must not crowd the other diagnostics out of the
    block (measured 22/11: Heatmap + LineStyle filled 3 600 chars, GetImage / Bar / Ticks
    never shown). The headers always survive."""
    secs = [s for s in re.split(r"(?m)^(?=@@ )", text) if s.strip()]
    if len(text) <= cap or not secs:
        return text
    per = max(DOTNET_API_SECTION_MIN, cap // len(secs))
    out = []
    for s in secs:
        s = s.rstrip("\n")
        if len(s) > per:
            s = s[:per].rsplit("\n", 1)[0] + "\n  [… section tronquée …]"
        out.append(s)
    return "\n".join(out)


def _probe_stdout(r: dict) -> str:
    outs = [wire_output(o) for o in (r or {}).get("outputs") or []]
    return "".join(str(o.get("text") or "") for o in outs
                   if isinstance(o, dict) and o.get("output_type") == "stream"
                   and o.get("name", "stdout") == "stdout")


async def dotnet_api_block(pm, kid: str | None, cells: list[dict], errors: list[str],
                           root: Path | None = None, fresh: bool = False) -> tuple[str, dict]:
    """The REAL API of the .NET package types a repair round's diagnostics name, read by
    reflection on the kernel that compiled the cells (``fresh``: a kernel started for the
    probe alone, which first replays the notebook's `#r "nuget:"` lines). Returns (block,
    info) — ("", {}) when no diagnostic names a package member; ("", info) when the
    notebook declares no package or the probe printed nothing. Never raises past its own
    guard: grounding is an aid."""
    queries = dotnet_api_queries(errors, cells)
    if not queries or not kid:
        return "", {}
    loads = nuget_load_paths(cells, root)
    if not loads:
        return "", {"kind": "dotnet", "queries": len(queries), "skipped": "no-package"}
    code = dotnet_probe_code(queries, loads, nuget_ref_lines(cells) if fresh else None)
    r = await pm_call(pm, "execute_on_kernel", {"kernel_id": kid, "mode": "code",
                                                "code": code,
                                                "timeout": DOTNET_PROBE_TIMEOUT_S})
    text = _probe_stdout(r).replace("\r\n", "\n").strip()
    info = {"kind": "dotnet", "queries": len(queries),
            "packages": [Path(p).parent.name + " " + Path(p).name if not p.lower().endswith(".dll")
                         else Path(p).name for p in loads]}
    if not text:
        info["empty"] = str(r.get("status") or r.get("error") or "")[:200]
        return "", info
    text = cap_probe_sections(text)
    info["chars"] = len(text)
    block = (f"{DOTNET_API_HEAD} — réflexion sur le noyau qui a compilé ces cellules "
             f"(assemblies chargées, version exacte : {', '.join(info['packages'])}). Ta mémoire "
             "de ces bibliothèques peut dater d'une autre version : là où elle diverge, ces "
             "signatures font foi. Un membre que l'erreur dit absent n'existe pas dans cette "
             "version — prends-en un listé ici (membres du type, extensions, voisins), "
             "n'en invente pas un autre.\n" + text)
    return block, info


async def dotnet_ground_execution(pm, kid: str | None, nb_path: Path, execution: list[dict],
                                  fresh: bool = False) -> dict | None:
    """dotnet_api_block over the cells an execution left failing, read back from the
    notebook's persisted error outputs: {"cells", "block", "info"}, or None when nothing
    fails or a failure is not a plain error (a timed-out cell may still hold the kernel:
    the probe would queue behind it). Never raises."""
    failing = [e for e in execution or [] if isinstance(e, dict) and not e.get("ok")]
    if not failing or not kid or any(e.get("status") != "error" for e in failing):
        return None
    idx = [e.get("cell") for e in failing]
    try:
        cells = _cells(nb_path)
        errs = [_outputs_text(cells[i]) for i in idx if isinstance(i, int) and 0 <= i < len(cells)]
        block, info = await dotnet_api_block(pm, kid, cells, errs, fresh=fresh)
    except Exception as ex:  # grounding is an aid: never fail the caller on it
        block, info = "", {"kind": "dotnet", "error": f"{type(ex).__name__}: {ex}"[:300]}
    return {"cells": idx, "block": block, "info": info}


def repair_prompt(failing: list[dict], conventions: str = "",
                  upstream: list[dict] | None = None,
                  deferred: list[dict] | None = None, crate_api: str = "") -> str:
    """One repair round: the REAL kernel errors of the failing cells (line + cause, as
    persisted by execution) and a demand for corrected FULL sources of those cells only.
    Measured on #27099 attempt 3: the model ports Python idioms that do not exist in the
    .NET Z3 API (MkNe, Expr where ArithExpr is required) — the compiler messages cite
    exactly what a repair round needs; the harness never shows the model its own claims.

    ``upstream`` (#27314, 20/11): cells ABOVE the failing ones whose definitions the error's
    stack trace crosses. The exception raised in `Decouper` (cell 8) surfaced in cell 16;
    a round that may only rewrite cell 16 can work around the call, never fix its cause.
    They are offered as optional edits, never demanded.

    ``deferred`` (#27302, 20/11): failing cells held back this round because they fail on
    names an earlier failing cell declares. They are named, not shown: the model must keep
    those names defined, and must not rewrite the cells around a definition it is fixing."""
    blocks = []
    for f in failing:
        cites = f.get("cited") or []
        cite_txt = ("\nLIGNES CITÉES (source actuelle) :\n"
                    + "\n".join(f"  {k} | {line}" for k, line in cites)) if cites else ""
        blocks.append(f"### Cellule {f['idx']} (code)\nSOURCE ACTUELLE :\n{f['source']}\n\n"
                      f"ERREURS RÉELLES (compilation/exécution sur le noyau de la série) :\n"
                      f"{f['errors']}{cite_txt}")
    if crate_api.startswith(DOTNET_API_HEAD):      # .NET: the block carries its own heading
        api_txt = "\n\n" + crate_api
    else:
        api_txt = ("\n\nAPI RÉELLE DES CRATES — extraite des sources exactes que le noyau a "
                   "compilées (registre cargo local). Ta mémoire de ces crates peut dater d'une "
                   "autre version : là où elle diverge de ces signatures, ce sont elles qui font "
                   "foi (imports, noms, features).\n" + crate_api) if crate_api else ""
    up = upstream or []
    dep_up = [u for u in up if u.get("via") == "dep"]
    up = [u for u in up if u.get("via") != "dep"]
    up_txt = ""
    if up:
        def _why(u: dict) -> str:
            if u.get("via") == "use":
                return f"utilisé par la cellule {u['for']}"
            return f"traversé par la trace de la cellule {u['for']}"
        up_blocks = [f"### Cellule {u['idx']} (code, AMONT — définit {', '.join(u['names'])}, "
                     f"{_why(u)})\nSOURCE ACTUELLE :\n{u['source']}" for u in up]
        by_use = any(u.get("via") == "use" for u in up)
        up_txt = ("\n\nCELLULES AMONT — la trace d'erreur traverse ces définitions"
                  + (", ou la cellule en échec les utilise (une assertion qui échoue désigne "
                     "souvent une donnée ou une fonction définie plus haut)" if by_use else "")
                  + ". Si la cause est là (exception levée, donnée fausse ou comportement "
                  "divergent du jumeau dans une définition plus haut), corrige-la ICI plutôt "
                  "que de contourner l'appel ou d'affaiblir le test ; sinon ne les rends pas."
                  "\n\n" + "\n\n".join(up_blocks))
    if dep_up:
        up_txt += ("\n\nCELLULE DES DÉPENDANCES — elle fixe versions et features des crates "
                   "ci-dessus. Rends-la seulement si la correction l'exige (feature à activer, "
                   "autre version), et adapte alors les cellules qui en dépendent.\n\n"
                   + "\n\n".join(f"### Cellule {u['idx']} (code, `:dep` — "
                                 f"{', '.join(u['names'])})\nSOURCE ACTUELLE :\n{u['source']}"
                                 for u in dep_up))
        up = up + dep_up
    dfr_txt = ""
    if deferred:
        by_root: dict[int, list[dict]] = {}
        for x in deferred:
            for r in x["roots"]:
                by_root.setdefault(r, []).append(x)
        lines = []
        for r in sorted(by_root):
            names = sorted({n for x in by_root[r] for n in x["names"]})
            crates = sorted({c for x in by_root[r] for c in x.get("crates") or []})
            cells = ", ".join(str(x["idx"]) for x in sorted(by_root[r], key=lambda x: x["idx"]))
            if names:
                lines.append(f"- cellule {r} : doit continuer à définir {', '.join(names)} "
                             f"(utilisés par les cellules {cells})")
            if crates:
                lines.append(f"- cellule {r} : porte les `:dep` de {', '.join(crates)} ; tant "
                             f"qu'elle échoue, evcxr ne lie aucune de ces crates (cellules "
                             f"{cells}) — garde ces `:dep` et rends-la compilable")
        waiting = ", ".join(str(x["idx"]) for x in sorted(deferred, key=lambda x: x["idx"]))
        dfr_txt = (f"\n\nCELLULES EN ATTENTE ({waiting}) — elles échouent seulement parce que "
                   "des noms ou des crates déclarés dans une cellule ci-dessus n'existent pas "
                   "tant qu'elle ne compile pas. Elles seront ré-exécutées après ta correction : "
                   "ne les rends pas, et garde ces noms, leurs signatures et ces `:dep` dans la "
                   "cellule qui les déclare."
                   + ("\n" + "\n".join(lines) if lines else ""))
    return (
        "TOUR RÉPARATION — les cellules ci-dessous ont ÉCHOUÉ à l'exécution réelle. Corrige "
        "leur code : même rôle pédagogique, API de la série correcte — les messages du "
        "compilateur citent la ligne et la cause exactes. Ne réécris pas les cellules qui "
        "passent.\n\n" + "\n\n".join(blocks) + api_txt + up_txt + dfr_txt
        + (f"\n\nConventions de livraison (imposées) :\n{conventions}\n" if conventions else "")
        + "\nRends UNIQUEMENT un bloc ```json :\n"
        '{"cells":[{"idx":<index inchangé>,"cell_type":"code",'
        '"source":"<source CORRIGÉ et COMPLET>"}]}\n'
        "TOUTES les cellules en échec listées, index inchangés"
        + (", plus les cellules amont que tu corriges" if up else "")
        + " ; aucune autre cellule."
    )


def apply_repairs(nb_path: Path, payload: dict, allow_markdown: bool = False,
                  only_idx: set[int] | None = None) -> dict:
    """Replace the sources of the given cells (by idx) in ONE write. A repaired CODE cell
    loses its outputs and execution_count: they must come back from EXECUTION, never
    from the repair itself (same rule as creation). MARKDOWN cells are accepted only
    with allow_markdown=True (the prose-repair round): source replaced, nothing to
    reset — markdown has no outputs, execution stays valid.

    ``only_idx`` (pre-review cutover finding 1): when given, ONLY those indices may be
    replaced — a response naming any other cell (code out of scope, an idx the round
    never asked for) is refused into ``out_of_scope`` and left untouched. The prose
    round passes the failing cells' idx so a hallucinated extra edit cannot silently
    rewrite an uninvolved cell. In markdown mode a cell whose payload declares
    ``cell_type: "code"`` is also refused: the prose round must not reset a code cell's
    outputs by smuggling it in as a markdown edit.
    """
    nb = json.loads(nb_path.read_text(encoding="utf-8"))
    rep = {"replaced": [], "unknown_idx": [], "bad": [], "out_of_scope": []}
    for c in payload.get("cells") or []:
        try:
            i = int(c.get("idx"))
        except (TypeError, ValueError):
            rep["bad"].append(c)
            continue
        if not (0 <= i < len(nb["cells"])):
            rep["unknown_idx"].append(i)
            continue
        if only_idx is not None and i not in only_idx:
            rep["out_of_scope"].append(i)
            continue
        ct = nb["cells"][i].get("cell_type")
        if ct != "code" and not (ct == "markdown" and allow_markdown):
            rep["unknown_idx"].append(i)
            continue
        # In the prose round, a cell whose REAL type is code is out of scope WHATEVER
        # the payload declares (round 2: a payload declaring markdown, or omitting
        # cell_type entirely, sailed past the declared-type check and then reset the
        # real code cell's outputs at the `ct == "code"` branch below).
        if allow_markdown and ct == "code":
            rep["out_of_scope"].append(i)
            continue
        # And refuse a payload that re-labels ANY cell as CODE in the prose round:
        # applying it on a markdown cell is a type-confusion the round never asked
        # for (finding 1 — CODE smuggled under allow_markdown).
        if allow_markdown and (c.get("cell_type") or "").lower() == "code":
            rep["out_of_scope"].append(i)
            continue
        src = c.get("source") or ""
        if not src.strip():
            rep["bad"].append(i)
            continue
        cell = nb["cells"][i]
        cell["source"] = _lines(src)
        if ct == "code":
            cell["outputs"] = []
            cell["execution_count"] = None
        rep["replaced"].append(i)
    nb_path.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n",
                       encoding="utf-8")
    return rep


def md_repair_prompt(failing: list[dict], conventions: str = "") -> str:
    """One PROSE repair round for markdown cells carrying foreign-script corruption
    (17/11 #27104: Cyrillic/CJK hallucinated inside regenerated French prose — the
    gate catches the script class; the twin's own prose is the authority, so the
    model COPIES it instead of re-deriving).
    An entry carrying `coord_excerpt` also (or only) has a coordination reference to drop
    (20/11 MGS-29 #27133: « [EPIC #12373] » copied from the twin failed coord-refs after
    44 min of work — the round now repairs it while the session is still open)."""
    blocks = []
    for f in failing:
        b = [f"### Cellule {f['idx']} (markdown)"]
        if f.get("excerpt"):
            b.append(f"TEXTE ACTUEL (corrompu, extrait autour des caractères étrangers) :\n"
                     f"…{f['excerpt']}…\n\n"
                     f"PROSE DU JUMEAU PYTHON (autorité — recopie-la) :\n"
                     f"{f.get('twin_source') or '(absente du jumeau — réécris la cellule en français propre, sans caractère étranger)'}")
        elif f.get("coord_excerpt"):
            b.append(f"TEXTE ACTUEL (complet) :\n{f.get('current_source') or ''}")
        if f.get("coord_excerpt"):
            b.append(f"RÉFÉRENCE DE COORDINATION à retirer : « …{f['coord_excerpt']}… ». "
                     "Supprime-la sans la reformuler ni la déplacer ailleurs dans la cellule ; "
                     "garde tout le reste à l'identique.")
        blocks.append("\n".join(b))
    return (
        "TOUR RÉPARATION PROSE — les cellules markdown ci-dessous portent un défaut relevé "
        "par les portes du harnais : des caractères d'alphabets étrangers insérés dans la "
        "prose française (réécris la cellule en recopiant la prose du jumeau Python fournie, "
        "en n'adaptant QUE les termes propres au code), et/ou une référence de coordination "
        "(Epic, lane, « voir #N ») qu'un carnet livré ne porte pas — seule exception, la note "
        "de pied de la DERNIÈRE cellule sous la forme exacte `> Carnet issu de l'EPIC #N.`. "
        "Ne change aucune autre cellule, ne reformule rien d'autre.\n\n"
        + "\n\n".join(blocks)
        + (f"\n\nConventions de livraison (imposées) :\n{conventions}\n" if conventions else "")
        + "\nRends UNIQUEMENT un bloc ```json :\n"
        '{"cells":[{"idx":<index inchangé>,"cell_type":"markdown",'
        '"source":"<source CORRIGÉ et COMPLET>"}]}\n'
        "TOUTES les cellules listées, index inchangés, aucune autre cellule."
    )


MD_REPAIR_MAX_CELLS = 8


def md_defects(built_cells: list, src_cells: list, create_mode: bool,
               from_spec: bool) -> list[dict]:
    """The markdown cells the prose round can repair, one entry per cell (both defects
    merged): foreign-script corruption (creation only — the twin is the authority) and
    coordination references (both modes — the fix is a deletion, no authority needed).
    Code cells are left to the gates: the prose round cannot touch them (apply_repairs)."""
    def is_md(i):
        return 0 <= i < len(built_cells) and built_cells[i].get("cell_type") == "markdown"
    by_idx: dict[int, dict] = {}
    footer = last_md_index(src_cells)
    if create_mode:
        for h in foreign_script_hits(built_cells, src_cells):
            ci = h.get("cell")
            if not isinstance(ci, int) or not is_md(ci):
                continue
            twin = ""
            if not from_spec and 0 <= ci < len(src_cells):
                # a [SPEC] placeholder is no prose authority: an empty twin_source asks
                # for a clean French rewrite; the twin itself is shown WITHOUT its
                # coordination lines, or the repair would re-inject them
                twin = _text(src_cells[ci].get("source"))
                if ci != footer:
                    twin = strip_coord_refs(twin)[0]
                twin = twin[:3000]
            by_idx[ci] = {"idx": ci, "excerpt": h.get("excerpt") or "", "twin_source": twin}
    for h in coord_ref_hits(built_cells, src_cells):
        ci = h["cell"]
        if not is_md(ci):
            continue
        e = by_idx.setdefault(ci, {"idx": ci})
        e["coord_excerpt"] = h["excerpt"]
        e["current_source"] = _text(built_cells[ci].get("source"))[:6000]
    return [by_idx[i] for i in sorted(by_idx)][:MD_REPAIR_MAX_CELLS]


async def repair_markdown_defects(sk, args, rec: dict, scratch: Path, src_cells: list,
                                  conv, conventions: str, create_mode: bool,
                                  from_spec: bool):
    """One in-session prose round on md_defects (17/11 #27104 foreign script; 20/11
    MGS-29 coordination references), while the sk session is still open — stage-3 gates
    run after it closes. Markdown has no outputs: apply_repairs(allow_markdown=True)
    replaces the source only, no kernel cycle. The stage-3 gates re-measure and stay the
    judges of what remains. Returns the conversation id."""
    if args.repair_rounds <= 0:
        return conv
    detail_md = md_defects(_cells(scratch), src_cells, create_mode, from_spec)
    if not detail_md:
        return conv
    env = await sk_call_retry(sk, args, rec, "2.6-mdrepair",
                              md_repair_prompt(detail_md, conventions), conv)
    conv = env.get("conversation_id") or conv
    part, env = await parse_or_repair(sk, args, rec, "2.6-mdrepair", env, conv)
    entry = {"asked": len(detail_md),
             "defects": {"foreign-script": sum(1 for d in detail_md if d.get("excerpt")),
                         "coord-refs": sum(1 for d in detail_md if d.get("coord_excerpt"))}}
    if part and part.get("cells"):
        # Scope the round to the cells it asked for (finding 1): a response editing any
        # other cell is refused, not applied.
        rep = apply_repairs(scratch, part, allow_markdown=True,
                            only_idx={d["idx"] for d in detail_md})
        entry.update({"replaced": rep["replaced"], "unknown_idx": rep["unknown_idx"],
                      "bad": rep["bad"], "out_of_scope": rep["out_of_scope"]})
    else:
        entry.update({"verdict": call_failure(env) or "unparsed",
                      "raw_tail": (env.get("response") or "")[-1500:]})
    rec.setdefault("md_repairs", []).append(entry)
    after = _cells(scratch)
    if create_mode:
        rec["md_hits_after"] = len(foreign_script_hits(after, src_cells))
    rec["coord_hits_after"] = len(coord_ref_hits(after, src_cells))
    return conv


# ---------------------------------------------------------------- constructive-review loop
# 20/11, IT08 CoursIA#27460: a verify-reject ended the grain, so a first draft could never
# be improved by the review it had just received (user mandate 18/11: "Un premier jet
# perfectible doit être améliorable après review constructive"). The revision round below
# closes that loop; --revise-from resumes it on an already-built, already-rejected grain.
REVISION_OUT_CAP = 1_500
REVISION_VIEW_CAP = 90_000


def _revision_block(i: int, cell: dict, out_cap: int) -> str:
    """One cell as the reviser reads it: its whole source and, for code cells, the execution
    count and the text really displayed (a per-cell output cut is declared)."""
    ct = cell.get("cell_type")
    block = f"=== cellule {i} | {ct} ===\n{_text(cell.get('source'))}"
    if ct == "code":
        out = _outputs_text(cell)
        shown = out[:out_cap]
        if len(out) > out_cap:
            shown += f"\n…[sortie tronquée : {len(out) - out_cap} caractères non affichés]"
        witness = nontext_witness(cell)   # outside the cut: a figure is never starved
        block += (f"\n--- sortie réelle (execution_count={cell.get('execution_count')}) ---\n"
                  f"{shown if (shown or witness) else '(aucune sortie)'}"
                  + "".join(f"\n{line}" for line in witness))
    return block


def cited_cells(findings) -> list[int]:
    """Every cell a finding names, ascending, without duplicates. The verifier and the gates
    both write `cell`; a gate detail also carries `cells` (its own list is capped at 10, the
    `findings` list is not). Anything that is not a non-negative integer is ignored, never
    guessed."""
    found: set[int] = set()
    for f in findings or []:
        if not isinstance(f, dict):
            continue
        raw = [f.get("cell")]
        extra = f.get("cells")
        if isinstance(extra, (list, tuple)):
            raw.extend(extra)
        for v in raw:
            if isinstance(v, bool):
                continue
            if isinstance(v, str) and v.strip().isdigit():
                v = int(v.strip())
            if isinstance(v, int) and v >= 0:
                found.add(v)
    return sorted(found)


def revision_view(nb_path: Path, out_cap: int = REVISION_OUT_CAP,
                  max_chars: int = REVISION_VIEW_CAP, cited=()) -> str:
    """The notebook as the REVISER must see it: every cell's source AND, for code cells, the
    execution count and the text really displayed. build_view shows sources only — enough to
    plan a build, not to answer a reviewer who judges displayed values. Cuts are declared.

    `cited` — the cells the findings name — come FIRST, whole, and are never cut, because the
    reviser must return each one's COMPLETE replacement source. The other cells fill what is
    left of `max_chars`, in notebook order; the ones that do not fit are NAMED, never
    silently dropped. Measured on CoursIA#28880 (27/11, 75 cells): the plain view made
    199 554 characters, was cut at 90 000, showed 28 cells, the cut falling inside cell 27's
    source; the reviser answered « la source actuelle de cette cellule est tronquée dans le
    message », rewrote nothing, and the grain was released after a second content failure.
    Without `cited` the output is exactly the old one."""
    blocks = [_revision_block(i, c, out_cap) for i, c in enumerate(_cells(nb_path))]
    first: list[int] = []
    for i in cited:
        if (isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(blocks)
                and i not in first):
            first.append(i)
    if not first:
        return _cut("\n\n".join(blocks), max_chars, "vue du carnet")
    head = [blocks[i] for i in first]
    rest_ids = [i for i in range(len(blocks)) if i not in set(first)]
    lead = "\n\n".join(head)
    shown_ids: list[int] = []
    used = len(lead)
    for i in rest_ids:
        if used + 2 + len(blocks[i]) > max_chars:
            break
        used += 2 + len(blocks[i])
        shown_ids.append(i)
    hidden = rest_ids[len(shown_ids):]
    listed = ", ".join(str(i) for i in first)
    note = (f"[Ordre de lecture — les cellules citées par les constats ({listed}) sont "
            f"affichées EN TÊTE et EN ENTIER : ce sont leurs sources complètes qu'il faut "
            f"renvoyer. Les autres suivent dans l'ordre du carnet.")
    if hidden:
        named = ", ".join(str(i) for i in hidden[:30]) + (", …" if len(hidden) > 30 else "")
        note += (f" Budget de {max_chars} caractères épuisé : NON affichées ({len(hidden)}) — "
                 f"{named}.]")
    else:
        note += "]"
    return note + "\n\n" + "\n\n".join(head + [blocks[i] for i in shown_ids])


# 22/11 (w3w+w3x, 105 verify-reject findings read): the FIRST reject cause (25/105) was a
# displayed value diverging from the twin's (C# « 0.000 » where the Python twin shows
# « 3.97 »). Neither the creation segments nor the reviser had ever SEEN the twin's real
# outputs — only its prose and its comments — so the values were reinvented. The twin's
# code cells, with what they really display, are now the reference both stages copy.
TWIN_REF_SRC_CAP = 2_500
TWIN_REF_OUT_CAP = 1_500
TWIN_REF_VIEW_CAP = 60_000


def twin_reference_blocks(src_cells: list, idxs=None, src_cap: int = TWIN_REF_SRC_CAP,
                          out_cap: int = TWIN_REF_OUT_CAP) -> list[str]:
    """One block per CODE cell of the twin (restricted to `idxs` when given): its source and
    the text it really displays. A twin cell without outputs (a SPEC twin, an unexecuted
    cell) says so — the absence is declared, never filled in."""
    out: list[str] = []
    for i, c in enumerate(src_cells or []):
        if idxs is not None and i not in idxs:
            continue
        if not isinstance(c, dict) or c.get("cell_type") != "code":
            continue
        src = _text(c.get("source"))
        shown_src = src[:src_cap] + (f"\n…[source coupée : {len(src) - src_cap} caractères]"
                                     if len(src) > src_cap else "")
        txt = _outputs_text(c)
        shown = txt[:out_cap] + (f"\n…[sortie coupée : {len(txt) - out_cap} caractères]"
                                 if len(txt) > out_cap else "")
        witness = nontext_witness(c)          # outside the cut: a figure is never starved
        out.append(f"<cellule {i} — code du jumeau>\n{shown_src}\n"
                   f"<cellule {i} — SORTIE RÉELLE du jumeau (référence)>\n"
                   f"{shown if (shown or witness) else '(aucune sortie enregistrée)'}"
                   + "".join(f"\n{line}" for line in witness))
    return out


def twin_reference_view(nb_path, max_chars: int = TWIN_REF_VIEW_CAP) -> str:
    """The twin's code cells + real outputs, for the reviser. Empty when the twin is absent
    or carries no code cell — the prompt then simply has no reference section."""
    try:
        cells = _cells(Path(nb_path))
    except Exception:
        return ""
    blocks = twin_reference_blocks(cells)
    if not blocks:
        return ""
    return _cut("\n\n".join(blocks), max_chars, "vue de référence du jumeau")


TWIN_VALUES_RULE = (
    "- VALEURS : chaque valeur DÉTERMINISTE affichée par le jumeau (nombre, tableau, "
    "verdict, booléen) doit sortir À L'IDENTIQUE de ton exécution — mêmes instances, "
    "mêmes paramètres, même précision d'affichage. Une valeur qui dépend d'un TIRAGE "
    "aléatoire n'est pas reproductible à l'identique : porte le protocole (même graine "
    "déclarée, RNG cible seedé) et affiche TON résultat réel, l'écart nommé en prose. "
    "Un écart sur une valeur déterministe est un rejet garanti ; une cellule "
    "« indisponible » à la place d'un calcul l'est tout autant.\n"
    # 26/11, CoursIA batch o41: the former tail (« si la bibliothèque cible ne peut pas
    # reproduire une valeur, dis-le en prose et affiche l'écart mesuré ») is where the
    # dormant branch was born — the producer "said it in prose" from an `else` that printed
    # « non mesuré », with the comparison never run; 3 of 4 grains lost. A draw is not a
    # cited datum, and the comparison is EXECUTED on either route.
    "- TIRAGES : une valeur que la source obtient par un tirage (`random.seed`, "
    "`random.Random(graine)`, `random.choice`, `np.random.default_rng`) n'est pas une donnée "
    "à recopier, et son absence ne dispense d'AUCUNE comparaison. Deux voies, et la "
    "comparaison est EXÉCUTÉE dans les deux : (a) RECONSTRUIS le générateur de la source "
    "dans le langage cible (`random.Random(graine)` se rejoue : MT19937, `getrandbits`, "
    "rejet jusqu'à un indice valide) puis compare à tolérance déclarée ; (b) générateur non "
    "reconstructible à coût raisonnable (PCG64 de NumPy, module local) : compare les valeurs "
    "que tu recalculeras à celles que la source AFFICHE, citées comme telles et NON VIDES, "
    "sous tolérance déclarée, ou asserte un invariant (régime, ordre, signe). INTERDIT : "
    "garder la comparaison derrière un test qui n'est jamais pris parce que la collection "
    "de valeurs citées est VIDE, et afficher sinon « non mesuré » / « non attesté » — la "
    "cellule tourne, la comparaison n'a jamais eu lieu, le vérificateur rejette à chaque "
    "tour. Un fait réellement hors de portée du jumeau (HTTP réel, tokens Python, durée) se "
    "dit dans une cellule MARKDOWN, jamais dans la sortie d'une cellule de code.\n")


def revision_prompt(issue: dict, view: str, findings: list[dict], conventions: str = "",
                    spec: bool = False, twin_view: str = "", api_block: str = "",
                    modules: list | None = None) -> str:
    """Self-contained on purpose: the build conversation may be gone (sk-agent keeps no
    durable store here, and --revise-from runs in a new process). The reviser gets the
    spec, the whole notebook with its REAL outputs, the twin's code cells with THEIR real
    outputs (the values to reproduce, 22/11), and the findings — and may contest a finding
    instead of bending the notebook to a wrong one. ``api_block`` (.NET exec-reject,
    22/11): the real API of the package members the failing cells' diagnostics name.
    ``modules`` (23/11): the source notebook's local .py modules, rendered by the SAME
    block the creation prompt uses. A revision used to carry the twin's CALLS
    (`SP.spectral_summary(...)`) but never the module defining them, so the only move
    left was a substitute — CoursIA#27742 lost six rounds to « le message ne fournit
    pas les algorithmes de spectral_… » while the 14 KB source sat one pass away."""
    fl = [{"cell": f.get("cell"), "severity": f.get("severity"), "detail": f.get("detail")}
          for f in findings if isinstance(f, dict)]
    return (
        "TOUR RÉVISION — un vérificateur INDÉPENDANT a rejeté ce carnet. Ses constats sont "
        "ci-dessous. Corrige ce qu'ils exigent, et seulement cela : chaque constat `major` doit "
        "être traité ; un `minor` l'est s'il ne coûte qu'une retouche locale.\n\n"
        + ("## Issue — spec (plan des cellules, attendus, interdits)\n" if spec
           else "## Issue — critères d'acceptation\n")
        + f"TITRE : {issue['title']}\n\nCORPS :\n{_cut(issue['body'], 30000, 'corps de l issue')}\n\n"
        + (f"## Conventions de livraison (imposées)\n{conventions}\n\n" if conventions else "")
        + f"## Carnet actuel — sources ET sorties réelles\n{view}\n\n"
        + (f"## Jumeau source — code ET sorties de RÉFÉRENCE (les valeurs à reproduire)\n"
           f"{twin_view}\n\n" if twin_view else "")
        + local_module_block(modules)
        + (f"## {api_block}\n\n" if api_block else "")
        + f"## Constats du vérificateur\n{json.dumps(fl, ensure_ascii=False, indent=1)}\n\n"
        "## Règles\n"
        + (TWIN_VALUES_RULE if twin_view else "")
        + PORT_CONTENT_RULES.split("\n", 1)[1]
        + "- Ne crée ni ne supprime aucune cellule : index et types inchangés (le plan est "
        "imposé). Tu peux modifier toute cellule existante, code ou markdown, y compris une "
        "voisine de la cellule citée quand le constat l'exige.\n"
        "- Les sorties viennent de l'EXÉCUTION : le harnais réexécute TOUT le carnet dans un "
        "noyau neuf dès qu'une cellule de CODE change. Une révision qui ne touche QUE du "
        "markdown conserve les sorties affichées ci-dessus telles quelles : une cellule "
        "markdown peut alors citer une valeur en la LISANT dans une sortie affichée "
        "(jamais en la recalculant d'après une autre exécution), et la citation reste vraie "
        "du carnet livré. N'écris jamais une sortie toi-même ; dans une cellule de CODE, ne "
        "code jamais en dur une valeur présentée comme calculée.\n"
        "- Une valeur attendue doit être AFFICHÉE par une sortie réelle, avec la précision "
        "que l'issue demande.\n"
        "- Si un constat te paraît faux, ne modifie rien pour lui donner raison : explique "
        "pourquoi dans `contested`, en t'appuyant sur une sortie ou un calcul. Le vérificateur "
        "relira ta réponse.\n\n"
        "Rends UNIQUEMENT un bloc ```json :\n"
        '{"cells":[{"idx":<index inchangé>,"cell_type":"code|markdown",'
        '"source":"<source COMPLET>"}],"addressed":[{"cell":<index>,"how":"..."}],'
        '"contested":[{"cell":<index>,"why":"..."}]}\n'
        "Seules les cellules que tu modifies figurent dans `cells`, chacune avec son source "
        "COMPLET. Une cellule citée par un constat garde le numéro EXACT de son en-tête "
        "« === cellule N === » : `cells` et `addressed` nomment ce numéro-là, jamais un "
        "autre — une réponse portant sur une cellule non citée ne corrige aucun constat."
    )


def apply_revision(nb_path: Path, payload: dict) -> dict:
    """A revision may rewrite ANY existing cell, code or markdown — never its TYPE, never the
    cell count (the plan of cells is imposed; the structure gate re-checks it). A rewritten
    code cell loses its outputs: the harness re-executes the whole notebook afterwards.
    Nothing is written when nothing is applicable."""
    nb = json.loads(nb_path.read_text(encoding="utf-8"))
    rep: dict = {"replaced": [], "unknown_idx": [], "bad": [], "type_changed": []}
    for c in payload.get("cells") or []:
        if not isinstance(c, dict):
            rep["bad"].append(None)
            continue
        try:
            i = int(c.get("idx"))
        except (TypeError, ValueError):
            rep["bad"].append(c.get("idx"))
            continue
        if not (0 <= i < len(nb["cells"])):
            rep["unknown_idx"].append(i)
            continue
        cell = nb["cells"][i]
        ct = cell.get("cell_type")
        if ct not in ("code", "markdown"):
            rep["unknown_idx"].append(i)
            continue
        if (c.get("cell_type") or ct).lower() != ct:
            rep["type_changed"].append(i)
            continue
        src = _text(c.get("source"))
        if not src.strip() or i in rep["replaced"]:     # empty, or a duplicate idx
            rep["bad"].append(i)
            continue
        cell["source"] = _lines(src)
        if ct == "code":
            cell["outputs"] = []
            cell["execution_count"] = None
        rep["replaced"].append(i)
    if rep["replaced"]:
        nb_path.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n",
                           encoding="utf-8")
    return rep


def verify_structure_create(src_path: Path, built_path: Path) -> dict:
    """Mechanical proof for a CREATION: same cell count as the twin, same type signature.
    Minimal-edit is meaningless here (everything is new); the pedagogical-thread rule
    ('one source cell = one twin cell') is what stays provable."""
    src, built = _cells(src_path), _cells(built_path)
    sig_src = [c.get("cell_type") for c in src]
    sig_b = [c.get("cell_type") for c in built]
    d = {"src_cells": len(src), "built_cells": len(built),
         "type_signature_ok": sig_src == sig_b,
         "counts_ok": len(src) == len(built)}
    # every code cell must be non-empty (no degenerate twin) and carry NO output yet
    d["empty_code_cells"] = [i for i, c in enumerate(built)
                             if c.get("cell_type") == "code"
                             and not _text(c.get("source")).strip()]
    d["stale_outputs"] = [i for i, c in enumerate(built)
                          if c.get("cell_type") == "code" and (c.get("outputs") or [])]
    d["ok"] = (d["counts_ok"] and d["type_signature_ok"]
               and not d["empty_code_cells"] and not d["stale_outputs"])
    return d


# ---------------------------------------------------------------- sk-agent / papermill calls
# Build/repair tours emit JSON with FULL cell sources, and Swift's thinking counts
# toward the sampling max_tokens — a thinking-heavy tour truncates its visible JSON
# mid-cell. Measured 18/11 wave-1c (7/7 failed): segment answers cut at 9.8K and
# 28.5K chars, both raw tails ending mid-`"source"` string. 32 768 leaves the JSON
# whole even when the tour thinks at length (same figure the verifier needed, 16/11).
BUILD_MAX_TOKENS = 32768


def agent_spec_for(agent: str, model: str | None, max_tokens: int, temperature: float,
                   tools: bool = True) -> dict:
    """call_agent composition spec (#4831: model per step). The `model` key is present
    ONLY when a per-step model is declared — absent, the extends preset's own model
    serves the call (the seat default). The server validates the ref against its
    config (enabled models only); what actually served the turn is read from the
    envelope (served_fields), never from this declaration.

    tools=False strips every MCP and the GitHub read tools from THIS turn only (the
    preset, its model and its capacity gate are kept). See TOOLLESS_STAGE_RE."""
    spec: dict = {"extends": agent,
                  "sampling": {"max_tokens": max_tokens, "temperature": temperature}}
    if model:
        spec["model"] = model
    if not tools:
        spec["mcps"] = {"replace": []}
        spec["parameters"] = {"github_tools": False}
    return spec


# Repair, revision and format tours carry everything they need in their prompt (the cells,
# the real kernel errors, the critic's findings) and answer with a JSON the harness applies.
# Tools there are pure cost. Measured 21/11 on MGS-29 (#27133): the revision tour walked
# read_cells / glob_search / list_files / list_kernels / manage_kernel on the agent's own
# cwd (d:\dev\CoursIA — not the grain's worktree), first attempt empty after 10 293
# completion tokens, retry killed by the 1 530 s call budget. And the schemas alone weigh:
# the same 1-line prompt costs 32 167 prompt tokens with the coder's tools, 707 without
# (live probes on qwen3.6-35b-a3b-nbcoder; 1 505 with the MCPs stripped but GitHub kept).
# Plan, build and spec tours keep their tools.
TOOLLESS_STAGE_RE = re.compile(r"repair|-format$|^6-revise")


def stage_uses_tools(stage: str) -> bool:
    return not TOOLLESS_STAGE_RE.search(stage)


# The preset's system prompt still tells the coder to write cells with add_cell /
# update_cell: on a tool-less tour it must hear, in the turn itself, that the answer is the
# JSON and nothing else (otherwise it may narrate a tool call it cannot make).
TOOLLESS_NOTE = ("\n\nCe tour n'a AUCUN outil : tout ce qu'il te faut est dans ce message. "
                 "Rends directement le bloc ```json demandé, sans appeler ni annoncer d'outil.")


async def sk_call(session: ClientSession, args, prompt: str, conv: str | None,
                  max_tokens: int | None = None, model: str | None = None,
                  tools: bool = True, resume: bool = False) -> tuple[dict, float]:
    # model: explicit per-turn override (the spec turn passes --spec-model); every other
    # call site is a coder turn and falls back to --coder-model (#4831).
    # resume: re-enter the PAUSED loop of `conv` (sk-agent #4742 options.continue). No new
    # user message is added, and the tool rounds already run are never re-run.
    spec = agent_spec_for(args.agent, model or getattr(args, "coder_model", None),
                          max_tokens or args.max_tokens, 0.4, tools=tools)
    payload = {"prompt": "" if resume else prompt, "agent": args.agent,
               "timeout": args.timeout, "include_steps": True,
               "agent_spec": json.dumps(spec)}
    if resume:
        payload["options"] = json.dumps({"continue": True})
    if conv:
        payload["conversation_id"] = conv
    t0 = time.time()
    try:
        res = await session.call_tool("call_agent", payload,
                                      read_timeout_seconds=timedelta(seconds=args.timeout + 120))
        raw = "\n".join(getattr(c, "text", "") for c in res.content)
    except Exception as exc:
        raw = json.dumps({"error": f"{type(exc).__name__}: {exc}"})
    try:
        env = json.loads(raw)
    except Exception:
        env = {"response": raw}
    return env, round(time.time() - t0, 1)


# empty answers: nbaudit pilots 2/11 and 1/11 — one retry asking for shorter reasoning
# recovered the pilot-2 case; measured again here on stage 2 (14/11 dry pass, 482 s, 0 char)
RETRY_NOTE = ("\n\nNB : une tentative précédente n'a rien rendu. "
              "Réfléchis plus court (quelques centaines de mots), puis rends directement ta sortie.")


# A capacity-gate refusal in the MIDDLE of a grain used to defer the whole grain: the
# scheduler re-ran it from stage 0, re-paying the claim (~250 s), the plan and every build
# tour. Measured 20-21/11 on MGS-28 (#27133): three deferrals after 1 112, 2 977 and 413 s
# of build, never past stage 2. sk-agent commits nothing on a refused turn (its own seam,
# sk_agent.py: "A refused fresh turn committed nothing … it is RETRY-ONLY — repeat the
# same call"), its verdict is cached 10 s, and the gate's non-green spells are short (39
# spells over 9 h of scheduler ticks, median one tick, longest past the start 20 min). So
# the grain waits IN PLACE and repeats the same call; only a refusal that outlasts the
# whole budget still defers it.
GATE_WAIT_POLL_S = 60
GATE_WAIT_MAX_S = 1800
_gate_sleep = asyncio.sleep     # seam for tests

# A MID-TURN pause is a different envelope from the refusal above: the turn had started,
# its tool rounds are committed, and sk-agent (#4742) stopped the loop between two rounds,
# because the gate turned non-green (`capacity_gate`) or because a round budget was reached
# (`round_budget`). Its `response` is the banner "[paused: <reason>] resume with
# options.continue on conversation_id '…'", not an answer. Read as one, it became
# `stage1-unparsed`. Measured 22/11 on App-12 (#28069): paused at round 3 after 545 s, with
# 3 reads of the source and its C# twin already paid, and the grain burned. The way out is
# `options.continue` on the same conversation. The rounds already paid are kept, and a
# refused continue keeps its paused epoch, so it is repeated as a continue.
MAX_CONTINUES = 8               # round_budget continues are free of the gate: bound them


def resumable_pause(env: dict) -> str:
    """The pause reason when `env` is a resumable mid-turn pause, else ""."""
    if env.get("error") or not (env.get("paused") and env.get("resumable")):
        return ""
    return str((env.get("pause") or {}).get("reason") or "paused")


async def sk_call_retry(session: ClientSession, args, rec: dict, stage: str, prompt: str,
                        conv: str | None, max_tokens: int | None = None,
                        model: str | None = None) -> dict:
    tools = stage_uses_tools(stage)
    attempt = 0
    waited = 0
    continues = 0
    resume = False
    while True:
        tob = engine_tokens()
        env, dt = await sk_call(session, args,
                                prompt + ("" if tools else TOOLLESS_NOTE)
                                + (RETRY_NOTE if attempt else ""), conv,
                                max_tokens, model=model, tools=tools, resume=resume)
        toa = engine_tokens()
        pause = resumable_pause(env)
        label = stage if not attempt else f"{stage}-retry"
        rec["calls"].append({"stage": f"{label}-continue" if resume else label,
                             "tools": tools,
                             **({"gate_waited_s": waited} if waited else {}),
                             **({"paused": pause, "round_index": env.get("round_index")}
                                if pause else {}),
                             "elapsed_s": dt, "error": env.get("error"),
                             # model_used/agent_used: the sk-agent ENTRY that routed the call,
                             # not proof of the model that answered (20/11: a hub reroute left
                             # `nb-minimax` here while glm-5.3 served). What served comes from
                             # served_fields, when the envelope carries it.
                             "model_used": env.get("model_used"),
                             "agent_used": env.get("agent_used"),
                             # which conversation the call grew: what sizes the next turn on it
                             "conversation_id": env.get("conversation_id") or conv,
                             **served_fields(env),
                             **usage_fields(env),
                             "response_chars": len(env.get("response") or ""),
                             "engine_delta": ({k: round(toa[k] - tob[k]) for k in toa if k in tob}
                                              or None)})
        if pause:
            conv = env.get("conversation_id") or conv
            if continues < MAX_CONTINUES and (pause != "capacity_gate"
                                              or waited < GATE_WAIT_MAX_S):
                continues += 1
                resume = True
                if pause == "capacity_gate":
                    await _gate_sleep(GATE_WAIT_POLL_S)
                    waited += GATE_WAIT_POLL_S
                continue
            # Out of budget: a deferral like an outlasting refusal, never a banner to parse.
            return {**env, "response": "",
                    "error": (f"capacity gate refused: mid-turn pause ({pause}) still "
                              f"unresolved after {continues} continue(s), {waited}s waited"
                              if pause == "capacity_gate" else
                              f"mid-turn pause ({pause}) still unresolved after "
                              f"{continues} continue(s)")}
        if gate_refusal(env) and waited < GATE_WAIT_MAX_S:
            await _gate_sleep(GATE_WAIT_POLL_S)
            waited += GATE_WAIT_POLL_S
            continue        # same call: a refused fresh turn committed nothing, a refused
            #                 continue keeps its paused epoch (resume stays set)
        if attempt == 0 and (env.get("error") or "").startswith("empty model response"):
            attempt = 1
            resume = False  # the retry is a fresh prompt: an emptied epoch cannot continue
            continue
        return env


async def spec_stage(sk, args, rec: dict, issue: dict, kernel: dict, ctx: str, view: str,
                     conventions: str, out_dir: Path) -> dict | None:
    """Stage ½ SPEC (#4831): pre-chew a rough issue before the coder sees it.

    Not to be confused with --from-spec (the issue's « Plan des cellules » builds a new
    notebook): this turn rewrites the ISSUE, whatever the build mode. Skipped = DECLARED by
    the caller (--spec-mode skip: the lane judged the issue detailed enough); both modes
    trace on the run record, never silently.

    Returns the issue stage 1 must read — the raw one on skip, the pre-chewed one on run —
    or None when the spec turn died (rec["verdict"] is then set): a dead pre-chew must not
    fall back to the rough issue it exists to fix, the coder would burn its pass on the
    exact failure mode the spec step prevents (same fail-loud as stage 1, F5/vllm#441)."""
    if getattr(args, "spec_mode", "skip") == "skip":
        rec["spec"] = spec_skip_trace(len(issue.get("body") or ""))
        return issue
    tspec = time.time()
    env_s = await sk_call_retry(sk, args, rec, "spec",
                                spec_prompt(args.issue, issue, args.notebook, kernel, ctx,
                                            view, conventions),
                                None, model=args.spec_model)
    spec_text = (env_s.get("response") or "").strip()
    rec["spec"] = {"mode": "run", "skipped": False, "model": args.spec_model,
                   "conversation_id": env_s.get("conversation_id"),
                   "chars": len(spec_text), "elapsed_s": round(time.time() - tspec, 1)}
    if not spec_text:
        rec["spec"]["failed"] = True
        rec["verdict"] = (defer_refusal(env_s)   # scheduler defer contract
                          or f"spec-{call_failure(env_s) or 'no-answer'}")
        return None
    spec_body = _cut(spec_text, SPEC_BODY_CAP, "spec")
    spec_path = Path(out_dir) / f"spec-{args.issue}.md"
    spec_path.write_text(spec_body, encoding="utf-8")
    rec["spec"]["path"] = str(spec_path)
    return {**issue, "body": spec_body}


# Codes are matched on word boundaries, never as substrings: a raw `in` test turns
# 'timeout after 1401 ms' and 'listening on port 8403' into auth failures — the exact mirror
# of the bug this classification removes (a timeout blamed on the wiring). Measured in
# co-review of #442 (po-2028:claudish), F5-1.
_AUTH_CODE_RE = re.compile(r"\b(?:401|403)\b")
_AUTH_MARKERS = ("unauthorized", "authentication", "invalid proxy")

# A 403 is not a credential verdict: a proxy that cannot RESOLVE the model name answers 403
# too — `permission_error` on the OpenAI wire. The status is ambiguous, the wording is not,
# so the body is read before the code and a code only decides when the body is silent.
# Measured 16/11 (po-2028:claudish): 'claudish: unknown model nb-luna — not found in any
# provider catalog or routing map' surfaced as `stage1-auth-failed`, sending the operator
# after a credential that had not moved (vllm#457).
_MODEL_UNRESOLVED_MARKERS = ("unknown model", "not found in any provider catalog",
                             "routing map", "use provider@model")


def _excerpt(err: str, marker: str = "", budget: int = 160) -> str:
    """The part of an error that explains it, bounded.

    Head+tail by default: the head names the exception, the tail names the cause. When the
    verdict rests on a MARKER, the window is centred on that marker instead — on the measured
    luna run the model name sat at char ~185, past the head slice and before the tail slice,
    so head+tail alone kept the right verdict and lost the word that justified it. That gap
    was found by the pin, not by reading the code (vllm#457).
    """
    if len(err) <= budget:
        return err
    if marker:
        i = err.lower().find(marker)
        if i >= 0:
            start = max(0, i - budget // 4)
            # The slice can open mid-token (' 403 - {...'): the verdict is read by a human
            # first, so it starts on the token, not inside it.
            return err[start:start + budget].strip()
    head = budget * 2 // 3
    return f"{err[:head]} … {err[-(budget - head - 3):]}"


def call_failure(env: dict) -> str:
    """Verdict for a model call that never produced an answer, or "" when it answered.

    A 401 or a dead MCP spawn is NOT an 'unreadable response': the model was never asked, so
    reporting stage1-unparsed points the operator at the model instead of at the wiring.
    Measured 16/11 (po-2028:claudish): api_key_env unset -> '401 invalid proxy authentication'
    surfaced as stage1-unparsed with the real cause buried in .calls[0].error (F5, vllm#441).

    The MODEL-unresolved test comes first, before any status code: same day, same seat, a
    403 carrying 'unknown model nb-luna' was read as auth-failed, and the repair it named
    (find the key) was not the repair needed (publish the alias) — vllm#457.
    """
    err = (env.get("error") or "").strip()
    if not err:
        return ""
    low = err.lower()
    hit = next((m for m in _MODEL_UNRESOLVED_MARKERS if m in low), "")
    if hit:
        kind = "model-unresolved"
    elif _AUTH_CODE_RE.search(low) or any(m in low for m in _AUTH_MARKERS):
        kind = "auth-failed"
    else:
        kind = "call-failed"
    return f"{kind}: {_excerpt(err, hit)}"


_TIMEOUT_RE = re.compile(r"APITimeoutError|ReadTimeout|TimeoutError|timed out", re.I)


def call_timed_out(env: dict) -> bool:
    """True when the call died on a time budget (model client or MCP read), not a refusal.

    Only the error is read: a timed-out tour comes back with no response at all, which is
    exactly why the truncation test never sees it (20/11, MGS-28: 1 201 s, 0 char).
    """
    err = env.get("error") or ""
    if not err or gate_refusal(env):
        return False
    return (not call_failure(env).startswith(("auth-failed", "model-unresolved"))
            and bool(_TIMEOUT_RE.search(err)))


_GATE_REFUSAL_RE = re.compile(r"capacity gate refused", re.I)


def gate_refusal(env: dict) -> str:
    """A mid-flight capacity-gate refusal (the sk-agent pre-dispatch gate) is a
    DEFERRABLE condition, not a harness failure: the scheduler retries any verdict
    starting with `deferred-by-capacity-gate` with backoff. Measured 18/11 wave-1c
    (#27103): 'capacity gate refused dispatch ... (verdict yellow); retry after
    3600s' arrived as stage1-call-failed and terminally burned the grain — the
    refusal's own message says retry, the verdict must say it too."""
    err = (env.get("error") or "").strip()
    if _GATE_REFUSAL_RE.search(err):
        return f"deferred-by-capacity-gate: {err[:160]}"
    return ""


# A MODEL provider's 429 says as little about the grain as the capacity gate's refusal — but
# not every 429 lasts the same. Measured in nb_coder records 23/11 00:08-00:09Z
# (po-2028:claudish, batches s6g and s6r): 'Usage limit reached for 5 hour. Your limit will
# reset at …' — a five-hour WINDOW WALL that ran dry under two concurrent batches. Four
# stage-2 builds died as `stage2-call-failed: … 'rate_limit_error' …`, the scheduler classed
# each a run failure and posted [RELEASED], which CoursIA's guard reads as a three-day,
# fleet-wide RELACHEE on notebooks nothing had judged. A fifth (#28069) met it one call
# later, on a revision round, and was released on the reject that round never answered --
# revise_loop carries the same reading there. The transient wording ('Error code: 429 - {…
# 'code': '1302', 'message': 'Rate limit reached for requests'}}') is measured in this
# fleet's notebook outputs, not yet in a harness verdict: the same markers name it, and it
# takes the ordinary backoff — only the wall waits.
#
# The same class wears a 403 when what ran dry is a KEY's credit rather than a usage window.
# Measured 27/11 on po-2028:claudish, two grains of one batch: `Error code: 403 - {'error':
# {'message': 'Key limit exceeded (total limit). … $20.58 of $20.00 used; does not reset.',
# 'type': 'permission_error', 'code': None}}` — a cascade step served by OpenRouter, hit at
# 15:26:11Z (CoursIA#28880) then 16:09:59Z (MGS-27). Nothing in it says 429 and nothing says
# "will reset at", so both launches were classed run failures and [RELEASED]; the grain had
# done nothing. "does not reset" must NOT take the wall marker: a dead leg is not a clock to
# wait on, and the ordinary backoff is what the grain needs.
_PROVIDER_RATE_LIMIT_MARKERS = ("rate_limit_error", "ratelimiterror", "error code: 429",
                                "rate limit reached", "too many requests",
                                "key limit exceeded")
_PROVIDER_WALL_RE = re.compile(r"usage limit reached|will reset at", re.I)
# This class's message carries the provider's key URL. A verdict is copied into run records,
# dashboards and reports: the identifier must not travel with it (never propagate a key id).
_PROVIDER_KEY_ID_RE = re.compile(r"keys/[0-9a-f]{16,}", re.I)
PROVIDER_RATE_LIMIT_VERDICT = "deferred-by-provider-rate-limit"


def provider_rate_refusal(env: dict) -> str:
    """The bare scheduler deferral for a provider 429 carried by an envelope, or "".

    Read at every site that assembles a VERDICT from a model call that never answered,
    before `call_failure` — which keeps naming the cause `call-failed` for the diagnostic
    records. The verdict must stay unprefixed: the scheduler matches its deferral prefixes
    from the first character (`stage2-deferred-…` would fail the grain all the same).

    `:wall` marks a window wall. Its announced clock is NOT waited on: read as UTC, the
    measured sample (reset at 08:48:53 for a wall hit at 00:09Z) outlasts the five-hour
    window the same message names, so its offset is unknown. The scheduler probes hourly
    instead (PROVIDER_WALL_WAIT_S, there); the other form takes the ordinary backoff.

    A KEY's credit wall arrives as a 403 rather than a 429 and is named by its own marker;
    its message carries the provider's key URL, which the verdict masks before it travels."""
    err = (env.get("error") or "").strip()
    if not err:
        return ""
    low = err.lower()
    hit = next((m for m in _PROVIDER_RATE_LIMIT_MARKERS if m in low), "")
    if not hit:
        return ""
    wall = ":wall" if _PROVIDER_WALL_RE.search(err) else ""
    excerpt = _PROVIDER_KEY_ID_RE.sub("keys/<masque>", _excerpt(err, hit))
    return f"{PROVIDER_RATE_LIMIT_VERDICT}{wall}: {excerpt}"


# A TRANSPORT CUT says as little about the grain as the refusal above: measured 26/11 01:27Z
# (po-2028:claudish, batch o42, CoursIA#28664 ANALYSE-09-Tuilage-Aperiodique). The Docker
# engine of that host restarted (not by the lane: the daemon's event log BEGINS at
# 01:28:11Z with both containers starting; `claudish-proxy` finishedAt 01:28:09Z, startedAt
# 01:28:11Z, restartCount 0, created 11/16 — no earlier event survives); the cut itself was
# observed from 01:27:06Z (the openai client's own retry) to 01:27:33Z, and the build call
# "2-build+0" died after 63.8 s with 0 char:
#   ("<class 'semantic_kernel.connectors.ai.open_ai.services.open_ai_chat_completion.
#    OpenAIChatCompletion'> service failed to complete the prompt",
#    APIConnectionError('Connection error.'))
# chained httpcore2.ReadError -> httpx2.ReadError -> openai.APIConnectionError. The
# scheduler classed it a run failure and spent the grain's first launch — but the endpoint
# was the thing that was down, not the grain. The client's exception CLASS NAMES are the
# markers (they name the transport, whatever the wire); a client-side TIME BUDGET keeps its
# own cure and is excluded even when wrapped in a connection error; a 401/403/404 stays a
# wiring failure — that endpoint answered. The bare words 'connection error' are NOT a
# marker: a dead kernel or MCP server reports itself that way, and that one IS the harness's
# to repair.
_ENDPOINT_UNREACHABLE_MARKERS = ("apiconnectionerror", "error code: 502", "error code: 503",
                                 "error code: 504", "bad gateway", "service unavailable",
                                 "gateway timeout")
# The httpx class names are generic: `tarfile.ReadError` is not a cut transport. They count
# only when the transport MODULE names them (`httpcore2.ReadError`, `httpx2.WriteError`),
# which is how Python reprs them in a chained cause (review ai-01, 26/11 — the measured
# chain httpcore2.ReadError -> httpx2.ReadError -> APIConnectionError keeps matching on the
# qualified form or on `apiconnectionerror` alone).
_QUALIFIED_TRANSPORT_RE = re.compile(
    r"\b(?:httpx|httpcore)\w*\.(?:readerror|writeerror|connecterror|remoteprotocolerror)\b",
    re.I)
ENDPOINT_UNREACHABLE_VERDICT = "deferred-by-endpoint-unreachable"


def endpoint_unreachable(env: dict) -> str:
    """The bare scheduler deferral for a call that died on a CUT transport, or "".

    Read at every site that assembles a verdict from a call that never answered, through
    `defer_refusal`, exactly where the provider 429 is read. The verdict must stay
    unprefixed like every other deferral: the scheduler matches its prefixes from the first
    character."""
    err = (env.get("error") or "").strip()
    if not err:
        return ""
    low = err.lower()
    hit = next((m for m in _ENDPOINT_UNREACHABLE_MARKERS if m in low), "")
    if not hit:
        q = _QUALIFIED_TRANSPORT_RE.search(err)
        # the excerpt is centred on the CLASS name, as it is for the bare markers
        hit = q.group(0).rsplit(".", 1)[-1].lower() if q else ""
    if not hit or _TIMEOUT_RE.search(err):
        return ""
    return f"{ENDPOINT_UNREACHABLE_VERDICT}: {_excerpt(err, hit)}"


def defer_refusal(env: dict) -> str:
    """Every refusal that says RETRY rather than FAIL, read once: gate, provider 429, cut
    transport. The verdict sites call this single helper so a new deferrable class is wired
    everywhere at once, not into six of the seven places a verdict is minted."""
    return (gate_refusal(env) or provider_rate_refusal(env)
            or endpoint_unreachable(env))


def looks_truncated(env: dict) -> bool:
    """An answer cut by max_tokens ends inside the JSON, not on its fence or brace. Asking
    the model to re-emit it under the same budget would cut it again: that case is the
    bisect's (create segments), never the format repair's."""
    r = (env.get("response") or "").rstrip()
    return bool(r) and not (r.endswith("```") or r.endswith("}"))


FORMAT_REPAIR_PROMPT = (
    "Ta réponse précédente ne se lit pas comme du JSON. Erreur du décodeur : {err}\n\n"
    "Rends EXACTEMENT le même contenu (mêmes cellules, mêmes champs, aucune modification "
    "de fond) dans un seul bloc ```json valide, sans texte autour. Dans les chaînes JSON : "
    "guillemet = \\\", retour à la ligne = \\n, tabulation = \\t, antislash = \\\\.{prev}")


async def parse_or_repair(session: ClientSession, args, rec: dict, stage: str, env: dict,
                          conv: str | None, max_tokens: int | None = None
                          ) -> tuple[dict | None, dict]:
    """Parse a model answer; if it does not decode, ONE format-repair turn, then give up.

    The repair sends the decoder's own error back on the same conversation and asks for the
    same content re-emitted. It is skipped when there is nothing to repair: an error envelope
    or a gate refusal (no answer at all), an empty answer, or a truncated one (see
    `looks_truncated`). Returns (parsed, env): the repair's env when it parsed, the original
    otherwise, so the caller's raw-tail diagnostics keep showing the answer that broke."""
    text = env.get("response") or ""
    obj, err = parse_json_report(text)
    if obj is not None or env.get("error") or not text.strip() or looks_truncated(env):
        return obj, env
    rconv = env.get("conversation_id") or conv
    # No conversation to continue: the model would not see the answer it must re-emit.
    prev = "" if rconv else f"\n\nRéponse à reprendre :\n{text}"
    env2 = await sk_call_retry(session, args, rec, f"{stage}-format",
                               FORMAT_REPAIR_PROMPT.format(err=err, prev=prev), rconv,
                               max_tokens=max_tokens)
    obj2, err2 = parse_json_report(env2.get("response") or "")
    rec.setdefault("format_repairs", []).append(
        {"stage": stage, "error": err[:400], "ok": obj2 is not None,
         "error_after": err2[:400] if obj2 is None else "",
         "failure": call_failure(env2) or gate_refusal(env2)})
    # A gate refusal, a provider 429 or a cut transport on the repair call is a deferral,
    # and the caller reads it from env: handing back the ORIGINAL (unparsed, error-less)
    # answer would name the grain `unparsed` — a failure — for a refusal that says retry.
    return ((obj2, env2) if obj2 is not None or defer_refusal(env2)
            else (None, env))


PM_READ_TIMEOUT_S = 300


def pm_read_timeout_s(payload: dict) -> int:
    """The client waits past the server's own budget: for one cell, the MCP's transport
    limit is the kernel timeout + 30 s (kernel_tools.py `_transport_hard_timeout`). A client
    cap at the old flat 300 s would cut a 1,800 s dependency cell at 300 s."""
    try:
        asked = int(payload.get("timeout") or 0)
    except (TypeError, ValueError):
        asked = 0
    return max(PM_READ_TIMEOUT_S, asked + 60)


async def pm_call(session: ClientSession, tool: str, payload: dict) -> dict:
    try:
        res = await session.call_tool(tool, payload,
                                      read_timeout_seconds=timedelta(seconds=pm_read_timeout_s(payload)))
        raw = "\n".join(getattr(c, "text", "") for c in res.content)
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}
    try:
        return json.loads(raw)
    except Exception:
        return {"raw": raw}


def wire_output(o):
    """An execute_on_kernel output in the nbformat layout the checks read.

    The MCP answers `{"output_type", "content": {name, text} | {ename, evalue, traceback}}`
    (kernel_service.py:249-251) and only the copy it persists to disk is nbformat
    (kernel_service.py:570-608). Read raw, every stream and error field sat one level
    down: the per-cell `error` was null on every failure, and the stderr panic check
    (#518) never saw a stream (#27302 attempt 2, outputs_tail, 2026-11-20)."""
    if not isinstance(o, dict) or not isinstance(o.get("content"), dict):
        return o
    if o.get("output_type") not in ("stream", "error"):
        return o
    flat = {k: v for k, v in o.items() if k != "content"}
    flat.update(o["content"])
    return flat


def _error_head(o: dict) -> str:
    ename, evalue = str(o.get("ename") or ""), str(o.get("evalue") or "")
    return f"{ename}: {evalue}" if ename and evalue else (ename or evalue)


# A cell that declares dependencies compiles or restores them, once per kernel. Measured
# 21/11 on CoursIA#27134 (4.1 Rust twin): its `:dep` cell (ndarray, rand, rand_distr,
# plotters, burn, image) hit the flat 300 s limit at 04:51Z while cargo was still compiling
# the crates cold. The 10 cells after it then failed on names that cell never got to
# define, and two repair rounds (~240K prompt tokens of engine time) could not fix a cell
# that was never wrong. Such cells get the long budget; every other cell keeps the short one
# so a cell that really hangs still fails fast. Both stay under the MCP's 3,600 s cap
# (config.py `transport_max_timeout`).
CELL_TIMEOUT_S = 300
DEP_CELL_TIMEOUT_S = 1800
_DEP_DECL_RE = re.compile(r'^\s*(?::dep\s+[A-Za-z0-9_-]+\s*=|#r\s+"nuget:)', re.M)


def dependency_cells(nb_path: Path) -> set[int]:
    """Indexes of the code cells that declare an evcxr `:dep` or a .NET `#r "nuget:`.
    Read from the notebook being executed; an unreadable file declares none."""
    try:
        nb = json.loads(Path(nb_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    cells = nb.get("cells") if isinstance(nb, dict) else None
    return {i for i, c in enumerate(cells or [])
            if isinstance(c, dict) and c.get("cell_type") == "code"
            and _DEP_DECL_RE.search(_text(c.get("source")))}


async def execute_cells(pm: ClientSession, nb_path: Path, kernel_id: str,
                        indexes: list[int]) -> list[dict]:
    """The harness owns execution and the verdict: real outputs, never the model's word.

    persist_error_outputs is opted IN (#4817 / ms#1803): the MCP default refuses to write a
    raised cell's error output into the .ipynb (committed sources stay intangible), but this
    path only ever executes the SCRATCH copy — and the repair rounds plus the verify critic
    read that artifact back from disk after the process is gone. Without the opt-in, a
    compiler error lives only in the in-memory response and the evidence dies with it
    (the exact hole ms#1799 closed for committed sources; the scratch contract is the
    mirror image, which is why the flag exists at all).

    A cell that declares dependencies gets DEP_CELL_TIMEOUT_S instead of CELL_TIMEOUT_S
    (see dependency_cells)."""
    dep_cells = dependency_cells(nb_path)
    results = []
    for idx in indexes:
        timeout = DEP_CELL_TIMEOUT_S if idx in dep_cells else CELL_TIMEOUT_S
        r = await pm_call(pm, "execute_on_kernel", {"kernel_id": kernel_id, "mode": "notebook_cell",
                                                    "path": str(nb_path), "cell_index": idx,
                                                    "persist_error_outputs": True,
                                                    "timeout": timeout})
        status = r.get("status") or r.get("error") or "?"
        outs = [wire_output(o) for o in r.get("outputs") or []]
        err_txt = " ".join(str(o.get("text") or _error_head(o)) for o in outs
                           if isinstance(o, dict) and o.get("output_type") == "error")
        # evcxr reports a Rust panic as stderr text only, with status "ok" (#27133 MGS-25).
        err_txt = err_txt or rust_panic_text(outs)
        results.append({"cell": idx, "status": status, "ok": status == "ok" and not err_txt,
                        "elapsed_s": r.get("execution_time") or r.get("elapsed_s"),
                        "error_outputs_persisted": r.get("error_outputs_persisted"),
                        "outputs_tail": str(outs)[-800:], "error": err_txt[:500] or None})
    return results


async def start_kernel(pm: ClientSession, kernel_name: str, working_dir: Path) -> str | None:
    """The kernel runs with the SOURCE notebook's directory as cwd. Without it the MCP
    server's own cwd wins, and any notebook loading a sibling file of its series dies —
    measured twice: CoursIA#27021 (`import ict`, PR #467) and #27099 in CREATION mode
    (`#load "Z3NativeLoader.cs"` -> CS1504 while the file sits next to the Python twin,
    then CS0246 cascade on every cell that used the Z3 namespace).

    A start that returns no kernel id is retried (20/11): the MCP server gives a kernel
    30 s to answer, and the evcxr `rust` kernel's first start of a session overshoots it
    (`Kernel didn't respond in 30 seconds`) while the next one passes — measured on
    CoursIA#27133, where the miss came at stage 3 after 1,273 s of paid model work. The
    server cleans up the spawned process of a failed start, so a retry leaks nothing."""
    payload = {"action": "start", "kernel_name": kernel_name, "working_dir": str(working_dir)}
    for attempt in range(1, KERNEL_START_ATTEMPTS + 1):
        r = await pm_call(pm, "manage_kernel", payload)
        kid = r.get("kernel_id")
        if kid:
            if attempt > 1:
                print(f"[kernel] {kernel_name} started on attempt {attempt}", file=sys.stderr)
            return kid
        why = str(r.get("error") or r.get("raw") or r)[:300]
        print(f"[kernel] start of {kernel_name} failed (attempt {attempt}/"
              f"{KERNEL_START_ATTEMPTS}): {why}", file=sys.stderr)
        if attempt < KERNEL_START_ATTEMPTS:
            await _kernel_retry_sleep(KERNEL_START_BACKOFF_S * attempt)
    return None


def _kernel_start_attempts_from_env(default: int = 3) -> int:
    """The kernel-start retry count (#1913): ``NBCODER_KERNEL_START_ATTEMPTS`` overrides it, so
    a seat whose evcxr kernel start is slower than ai-01's can raise it without editing the
    shared harness. Unset keeps the historical 3. A non-integer or a value < 1 is refused
    loud — the driver must not start with a retry bound it cannot honour. The refusal fires
    when the driver module is imported, so it blocks every entry point that imports it
    (kernel start included), not only the kernel start. It is an env var,
    not a driver CLI flag, because a new driver option would first have to be threaded
    through nb_coder_invoke.py's closed parameter set (INVOCATION.md §5)."""
    raw = os.environ.get("NBCODER_KERNEL_START_ATTEMPTS", "").strip()
    if not raw:
        return default
    try:
        n = int(raw)
    except ValueError:
        raise ValueError(f"NBCODER_KERNEL_START_ATTEMPTS must be an integer, got {raw!r}") from None
    if n < 1:
        raise ValueError(f"NBCODER_KERNEL_START_ATTEMPTS must be >= 1, got {n}")
    return n


KERNEL_START_ATTEMPTS = _kernel_start_attempts_from_env()
KERNEL_START_BACKOFF_S = 5.0
_kernel_retry_sleep = asyncio.sleep


# ---------------------------------------------------------------- stages 3-5
# Convention forms (nb-coder-conventions.md): a coordination reference only ever survives
# as the exact footer note; anything else the BUILD adds is a violation.
# NB: the bare word `lane` in the alternation is deliberately broad -- ANY use of the
# word in a built cell is a candidate violation, whitelisted only by the footer note
# (PROVENANCE_RE). This is prose-vocabulary policing, not claim-marker matching: the
# registry's own markers live on issue comments, never inside notebooks.
COORD_REF_RE = re.compile(r"(?i)\b(?:epic|see|part\s+of)\s*#|\blane\b")
# The typographic apostrophe is the same note (22/11, CoursIA#28104: « Carnet issu de
# l’EPIC #26534. » refused for its U+2019 alone).
PROVENANCE_RE = re.compile(r"Carnet issu de l['’]EPIC #\d+")


def strip_coord_refs(text: str) -> tuple[str, int]:
    """The text without its lines carrying a coordination reference (the footer note
    excepted), and how many were dropped. MGS-29 (#27133, 20/11): the Python twin's
    « Place dans l'Epic … [EPIC #12373] » was pinned as prose « à recopier TELLE QUELLE »;
    the model obeyed and the coord-refs gate failed the grain after 44 min of work."""
    kept, dropped = [], 0
    for line in (text or "").split("\n"):
        if COORD_REF_RE.search(line) and not PROVENANCE_RE.search(line):
            dropped += 1
        else:
            kept.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip("\n"), dropped


def last_md_index(cells: list) -> int:
    """Index of the last markdown cell (-1 if none) — the footer cell, where the
    provenance note and the « pour aller plus loin » issue links are legit."""
    return max((i for i, c in enumerate(cells) if c.get("cell_type") == "markdown"),
               default=-1)


def coord_ref_hits(built_cells: list, src_cells: list) -> list[dict]:
    """Coordination references on BUILD-CHANGED cells — the coord-refs gate's own rule
    (delta-judged; the footer note in the last markdown cell is legit). Shared by
    run_gates and the in-session prose round, which can still repair them."""
    last_md = last_md_index(built_cells)
    hits: list[dict] = []
    for i, c in enumerate(built_cells):
        txt = _text(c.get("source"))
        if i < len(src_cells) and txt == _text(src_cells[i].get("source")):
            continue                      # untouched by the build
        m = COORD_REF_RE.search(txt)
        if m and not (i == last_md and PROVENANCE_RE.search(txt)):
            hits.append({"cell": i, "cell_type": c.get("cell_type"),
                         "excerpt": txt[max(0, m.start() - 60):m.end() + 60]})
    return hits
SECRET_RE = re.compile(r"(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
                       r"sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[bap]-[A-Za-z0-9-]{10,})")
# CoursIA acceptance contract, trigger 2 (2026-11-16): a machine path surfaced in an OUTPUT
# is a change-request — it proves the notebook ran on someone's box rather than in the
# canonical environment. Outputs only: the same string in the SOURCE is prose or config.
# `Loading extensions from` is evcxr's own banner, the Rust form of the same leak.
MACHINE_PATH_RE = re.compile(
    r"(?:[A-Za-z]:[\\/](?:[^\\/\s\"']+[\\/])+"      # C:\Users\... , d:/vllm/... (>= 2 segments)
    r"|\\\\wsl(?:\.localhost|\$)[\\/]"              # \\wsl.localhost\Ubuntu\...
    r"|/home/[A-Za-z_][A-Za-z0-9._-]*/"
    r"|/Users/[A-Za-z][A-Za-z0-9._-]*/"
    r"|Loading extensions from\b)")


# Foreign-script corruption, 17/11 #27104 blank pass: the builder regenerating FRENCH
# prose hallucinated Cyrillic and CJK+CJK-punctuation inside markdown cells ("ni случай generateur", "il serait。德onnant"). A French/English/code corpus has no
# legitimate Cyrillic, kana, Hangul or CJK-ideograph text. Greek is DELIBERATELY excluded:
# math prose legitimately uses lambda/phi/Delta. The verify critic caught all instances as
# major findings; this gate makes the class mechanical.
FOREIGN_SCRIPT_RE = re.compile("[\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF"
                               "\uAC00-\uD7AF\u3000-\u303F]")


def foreign_script_hits(built_cells: list, src_cells: list) -> list[dict]:
    """Foreign-script corruption hits on BUILD-CHANGED cells (delta rule, same as
    coord-refs/secrets). Shared by the run_gates gate and the IN-SESSION pre-check
    that arms the markdown prose-repair round — the round needs the sk session,
    which is closed by the time stage-3 gates run."""
    hits: list[dict] = []
    for i, c in enumerate(built_cells):
        txt = _text(c.get("source"))
        if i < len(src_cells) and txt == _text(src_cells[i].get("source")):
            continue                      # untouched by the build
        m = FOREIGN_SCRIPT_RE.search(txt)
        if m:
            hits.append({"cell": i,
                         "excerpt": txt[max(0, m.start() - 30):m.end() + 30]})
    return hits


# CoursIA #26921 (user ask 16/11, scoping jsboige/vllm#464): a figure cell emitting its SVG
# as stdout / text-html instead of a display_data image/svg+xml renders inconsistently and
# hides from every mime-keyed digest. The series idiom (record Svg + Formatter.Register)
# produces display_data; <svg in a code cell's TEXT output with no svg display_data in the
# SAME cell is the defect. Markdown cells are never scanned.
SVG_RE = re.compile(r"(?i)<svg")


def _has_svg_display(cell: dict) -> bool:
    for o in cell.get("outputs") or []:
        if isinstance(o, dict) and "image/svg+xml" in (o.get("data") or {}):
            return True
    return False


def _svg_text_offenders(cells: list) -> list[int]:
    """Code cells whose SVG travels as text (stream or text-html) with no svg display_data."""
    out = []
    for i, c in enumerate(cells):
        if c.get("cell_type") != "code" or _has_svg_display(c):
            continue
        for o in c.get("outputs") or []:
            if not isinstance(o, dict):
                continue
            hay = _text(o.get("text")) if o.get("output_type") == "stream" else ""
            hay += "\n" + _text((o.get("data") or {}).get("text/html"))
            if SVG_RE.search(hay):
                out.append(i)
                break
    return out


def _outputs_text(cell: dict) -> str:
    """What a cell DISPLAYS: streams, the text stubs of its rich data, and error tracebacks."""
    parts: list[str] = []
    for o in cell.get("outputs") or []:
        parts.append(_text(o.get("text")))
        data = o.get("data") or {}
        for mime in ("text/plain", "text/html", "text/markdown"):
            parts.append(_text(data.get(mime)))
        parts.append(_text(o.get("traceback")))
        parts.append(str(o.get("evalue") or ""))
    return "\n".join(p for p in parts if p)


# ---------------------------------------------------------- non-text payloads (24/11)
# A figure IS part of what a cell displays, and no text rendering shows it. Measured on
# CoursIA#28338 (fournée o30): the C# port displayed a 152 KB image/svg+xml after a 154 KB
# stream. The reviser's view rendered the cell as its stream alone, the twin reference
# rendered the Python figure as « (aucune sortie enregistrée) », and the verifier's diff
# annex cut the cell at 1 200 characters — before the fingerprint. Five rounds long, neither
# the reviser nor the critic ever saw the figure: the critic could only report it
# unverifiable and the reviser had nothing to show. A view that claims to show what a cell
# displays DECLARES its non-text payloads: their absence is otherwise a false statement made
# to the model. `_outputs_text` itself is NOT touched — the error digests and the delta
# gates (machine-path, svg-display) compare its text.
NON_TEXT_ELEMENTS_MAX = 12       # SVG element kinds listed
NON_TEXT_LABEL_MAX = 10          # SVG labels quoted
NON_TEXT_LABEL_CHARS = 40        # per label
NON_TEXT_STRUCTURE_CAP = 480     # a structure line never exceeds this, its cut declared


def is_nontext_mime(mime) -> bool:
    """False for what the text renderings already show (text/*, JSON)."""
    return not (mime.startswith("text/") or mime == "application/json")


def nontext_payloads(cell: dict) -> list[tuple[str, str]]:
    """`(mime, payload-as-text)` of every non-text payload of a cell's outputs — a figure, a
    PDF — in output order, each output's mimes sorted: the order every consumer shares."""
    rows: list[tuple[str, str]] = []
    for o in cell.get("outputs") or []:
        if not isinstance(o, dict) or o.get("output_type") == "stream":
            continue
        data = o.get("data") or {}
        for mime in (sorted(data) if isinstance(data, dict) else []):
            if is_nontext_mime(mime):
                blob = _text(data.get(mime))
                if blob:
                    rows.append((mime, blob))
    return rows


def nontext_marker(mime: str, blob: str) -> str:
    """The ONE fingerprint of a non-text payload: the digests hash it, the annexes show it.
    A silent image swap must move every digest that carries it (finding 26858 c.17)."""
    return f"[{mime} {len(blob)}b sha1:{hashlib.sha1(blob.encode()).hexdigest()[:12]}]"


_SVG_ROOT_RE = re.compile(r"<svg\b([^>]*)>")
_SVG_TAG_RE = re.compile(r"<([A-Za-z][\w:.-]*)")
_SVG_ATTR_RE = re.compile(r"([\w:.-]+)\s*=\s*([\"'])(.*?)\2")
_SVG_TEXT_RE = re.compile(r"<text\b[^>]*>(.*?)</text>", re.S)


def _svg_structure(blob: str) -> str:
    """What an SVG draws, in one bounded line: its canvas, its element counts, its labels.
    The bytes are fingerprinted by `nontext_marker`; this is what tells two figures of equal
    size apart, and lets a reader check a label against the code that claims to draw it.

    Bounded by WHOLE labels, never by characters: a label is either quoted whole or counted
    in « +N étiquettes non listées » — a cut by characters would drop that very count."""
    counts: dict[str, int] = {}
    for tag in _SVG_TAG_RE.findall(blob):
        counts[tag] = counts.get(tag, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    elements = ", ".join(f"{tag[:24]}×{n}" for tag, n in ranked[:NON_TEXT_ELEMENTS_MAX])
    if len(ranked) > NON_TEXT_ELEMENTS_MAX:
        elements += f", +{len(ranked) - NON_TEXT_ELEMENTS_MAX} autres"
    labels: list[str] = []
    for inner in _SVG_TEXT_RE.findall(blob):
        label = " ".join(re.sub(r"<[^>]+>", "", inner).split())
        if label and label not in labels:
            labels.append(label)
    canvas = ""
    root = _SVG_ROOT_RE.search(blob)
    if root:
        attrs = {k: v for k, _q, v in _SVG_ATTR_RE.findall(root.group(1))}
        canvas = " ".join(f"{k}={attrs[k][:NON_TEXT_LABEL_CHARS]}"
                          for k in ("width", "height", "viewBox") if attrs.get(k))
    head = " | ".join(p for p in (canvas, f"éléments : {elements}" if elements else "") if p)
    hidden_tail = 32                 # room kept for «  ; +NNN étiquettes non listées »
    room = NON_TEXT_STRUCTURE_CAP - len(head) - len(" | étiquettes : ") - hidden_tail
    quoted: list[str] = []
    for label in labels:
        text = f"«{label[:NON_TEXT_LABEL_CHARS]}{'…' if len(label) > NON_TEXT_LABEL_CHARS else ''}»"
        cost = len(text) + (3 if quoted else 0)
        if len(quoted) >= NON_TEXT_LABEL_MAX or sum(map(len, quoted)) + 3 * len(quoted) + cost > room:
            break
        quoted.append(text)
    hidden = len(labels) - len(quoted)
    if hidden > 0:
        quoted.append(f"+{hidden} étiquettes non listées")
    line = " | ".join(p for p in (head, f"étiquettes : {' ; '.join(quoted)}" if quoted else "")
                      if p)
    if len(line) > NON_TEXT_STRUCTURE_CAP:       # last resort: a hostile canvas or tag names
        line = (line[:NON_TEXT_STRUCTURE_CAP]
                + f"…[+{len(line) - NON_TEXT_STRUCTURE_CAP} caractères]")
    return line


def _png_structure(blob: str) -> str:
    """`PNG <width>x<height>`, read from the IHDR of a base64 payload; "" when the payload is
    not a PNG. The header is 33 bytes, so a 150 KB figure costs 44 characters decoded."""
    try:
        head = base64.b64decode(blob[:44], validate=False)[:33]
    except (ValueError, TypeError):
        return ""
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        return ""
    return f"PNG {int.from_bytes(head[16:20], 'big')}x{int.from_bytes(head[20:24], 'big')}"


def nontext_witness(cell: dict) -> list[str]:
    """One line per non-text payload a cell displays: the marker, then what is readable of
    the drawing. Every view that claims to show what a cell displays appends these lines
    OUTSIDE its text cuts — a verbose stream must never hide the figure that follows it."""
    lines: list[str] = []
    for mime, blob in nontext_payloads(cell):
        structure = (_svg_structure(blob) if mime == "image/svg+xml"
                     else _png_structure(blob) if mime == "image/png" else "")
        lines.append(f"[affichage non textuel {nontext_marker(mime, blob)[1:-1]}]"
                     + (f" — {structure}" if structure else ""))
    return lines


# Relative link targets in markdown: `](target)` / `](<target> "title")` and href="...".
MD_LINK_RE = re.compile(r"\]\(\s*<?([^)\s>]+)>?(?:\s+[\"'][^\"']*[\"'])?\s*\)"
                        r"|href=[\"']([^\"']+)[\"']")
LINK_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:")
# One finding line of check_prose_quantitative_claims.py (legacy artifact format, the CI
# contract): `  <path>  (<n>)  <snippet>, <snippet>, ...`
PROSE_COUNT_ROW_RE = re.compile(r"^\s+(\S.*?)\s{2}\((\d+)\)\s{2}(.*)$")
REPO_GUARD_TIMEOUT_S = 180
REPO_GUARD_FINDINGS_MAX = 12


def dead_link_hits(built_cells: list, repo: Path, rel: str) -> list[dict]:
    """Markdown links of the built notebook whose RELATIVE target does not exist in the
    worktree (resolved against the target notebook's folder). 21/11 (CoursIA#27805 review):
    the port linked `Sudoku-06-AIMA-CSP-Rust.ipynb` and `Sudoku-08-HumanStrategies-Rust`,
    neither in the repo — the twin's neighbour names translit'd to the target language.
    URLs, anchors and the notebook's own name are not judged."""
    base = (repo / rel).parent
    own = (repo / rel).resolve()
    hits: list[dict] = []
    for i, c in enumerate(built_cells):
        if c.get("cell_type") != "markdown":
            continue
        for m in MD_LINK_RE.finditer(_text(c.get("source"))):
            target = (m.group(1) or m.group(2) or "").strip()
            if not target or target.startswith(("#", "/")) or LINK_SCHEME_RE.match(target):
                continue
            path = unquote(target.split("#", 1)[0].split("?", 1)[0])
            if not path:
                continue
            p = base / path
            if p.resolve() == own or p.exists():
                continue
            hits.append({"cell": i, "target": target})
    return hits


# `[label](target "title")`: the label and target of one markdown link, for the rewrite below.
MD_LABELED_LINK_RE = re.compile(r"\[([^\]\n]*)\]\(\s*(<?)([^)\s>]+)(>?)((?:\s+[\"'][^\"']*[\"'])?)\s*\)")


def _series_id(target: str) -> str | None:
    """`dir/Lean-19d-Borne-Bennett-Python.ipynb` -> `dir/Lean-19d`: the file name up to its
    first token that carries a digit (the series position), directory kept. None when no
    token carries one (nothing safe to match on)."""
    path = unquote(target.split("#", 1)[0].split("?", 1)[0])
    head, _, name = path.rpartition("/")
    toks = name.split("-")
    for k, t in enumerate(toks[:-1]):
        if any(ch.isdigit() for ch in t):
            return f"{head}/{'-'.join(toks[:k + 1])}" if head else "-".join(toks[:k + 1])
    return None


def resolve_dead_links(built_nb: Path, src_nb: Path, repo: Path, rel: str) -> dict:
    """Rewrite, before the gates read it, a dead relative link of the built notebook onto
    the EXISTING target its source twin links for the same neighbour (22/11, CoursIA#27932:
    asked by the verifier to restore the twin's sibling links, Swift rebuilt their file
    names from the labels — `Lean-19-Borne-Hoeffding-Python.ipynb`, `Lean-19d-Borne-Bennett-
    Python.ipynb`, neither in the repo — and the dead-links gate failed the grain after its
    last round, 29 min of engine time). The twin's cell 0 had the right names all along.
    Match, in order: a twin link with the SAME label; else the ONE twin target sharing the
    dead target's series id (`Lean-19d`, directory included). Candidates are only twin links
    whose target exists. No unique match = no rewrite: the gate stays the judge."""
    try:
        nb = json.loads(built_nb.read_text(encoding="utf-8"))
        src_cells = _cells(src_nb)
    except (OSError, ValueError) as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    base = (repo / rel).parent

    def alive(target: str) -> bool:
        path = unquote(target.split("#", 1)[0].split("?", 1)[0])
        return bool(path) and (base / path).exists()

    by_label: dict[str, set] = {}
    by_series: dict[str, set] = {}
    for c in src_cells:
        if c.get("cell_type") != "markdown":
            continue
        for m in MD_LABELED_LINK_RE.finditer(_text(c.get("source"))):
            t = m.group(3).strip()
            if t.startswith(("#", "/")) or LINK_SCHEME_RE.match(t) or not alive(t):
                continue
            by_label.setdefault(m.group(1).strip(), set()).add(t)
            sid = _series_id(t)
            if sid:
                by_series.setdefault(sid, set()).add(t)
    dead = {(h["cell"], h["target"]) for h in dead_link_hits(nb.get("cells") or [], repo, rel)}
    fixed: list[dict] = []
    for i, c in enumerate(nb.get("cells") or []):
        if c.get("cell_type") != "markdown":
            continue

        def swap(m, i=i):
            t = m.group(3).strip()
            if (i, t) not in dead:
                return m.group(0)
            cand = by_label.get(m.group(1).strip()) or set()
            if len(cand) != 1:
                cand = by_series.get(_series_id(t) or "") or set()
            if len(cand) != 1:
                return m.group(0)
            new = next(iter(cand))
            fixed.append({"cell": i, "from": t, "to": new})
            return f"[{m.group(1)}]({m.group(2)}{new}{m.group(4)}{m.group(5)})"

        text = _text(c.get("source"))
        out = MD_LABELED_LINK_RE.sub(swap, text)
        if out != text:
            c["source"] = _lines(out)
    if fixed:
        built_nb.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return {"ok": True, "fixed": fixed}


def _repo_guard_tool(repo: Path, name: str) -> Path:
    return repo / "scripts" / "notebook_tools" / name


def _guard_env() -> dict[str, str]:
    """UTF-8 mode for a repo-guard subprocess. The guards print a French report holding
    glyphs outside cp1252 (U+2192 in the exemption rationales): on a Windows seat without
    UTF-8 mode ``print`` raises UnicodeEncodeError, the process exits 1 with its stdout cut
    mid-report, and rc 1 reads as « counter found » (measured 26/11, batch o40: #28644 and
    #28645 were rejected on the tail of an audit their notebooks never entered)."""
    return {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}


def _unmeasured(gate: str, **why) -> dict:
    """A repo guard that could not run is DECLARED (measured: false), never a silent pass
    and never a build failure: the PR's CI stays the judge of what the harness missed."""
    return {"gate": gate, "ok": True, "detail": {"measured": False, **why}}


def split_gates(gates: list) -> tuple[list[str], list[str]]:
    """(passed-and-measured, passed-but-unmeasured) gate names. An _unmeasured() guard keeps
    ok: True so an instrument failure never blocks delivery, but the PR body must not list it
    as "OK" -- that would claim a check nobody ran (21/11, claudish-bc review)."""
    def measured(g: dict) -> bool:
        d = g.get("detail")
        return d.get("measured", True) is not False if isinstance(d, dict) else True
    passed = [g for g in gates if isinstance(g, dict) and g.get("ok")]
    return ([g["gate"] for g in passed if measured(g)],
            [g["gate"] for g in passed if not measured(g)])


def uncommented_code_gate(repo: Path, built_nb: Path) -> dict:
    """The repo's own `Uncommented code` guard (#26690, check_uncommented_code.py --file):
    a code cell of 8 lines or more with no comment."""
    tool = _repo_guard_tool(repo, "check_uncommented_code.py")
    if not tool.is_file():
        return _unmeasured("uncommented-code", skipped=f"tool absent: {tool.name}")
    try:
        pr = subprocess.run([sys.executable, str(tool), "--file", str(built_nb), "--json"],
                            cwd=str(repo), capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=REPO_GUARD_TIMEOUT_S,
                            env=_guard_env())
        data = json.loads(pr.stdout or "{}") if pr.returncode in (0, 1) else None
    except (subprocess.TimeoutExpired, ValueError, OSError) as e:
        return _unmeasured("uncommented-code", error=f"{type(e).__name__}: {e}"[:300])
    if not isinstance(data, dict):
        return _unmeasured("uncommented-code", rc=pr.returncode,
                           error=(pr.stderr or pr.stdout or "")[-300:])
    cells = [f for row in data.get("rows") or [] for f in row.get("cells") or []
             if isinstance(f, dict)]
    findings = [{"cell": f.get("cell"),
                 "text": f"cellule {f.get('cell')} : {f.get('code_lines')} lignes de code, "
                         f"{f.get('comments', 0)} commentaire(s)"} for f in cells]
    return {"gate": "uncommented-code", "ok": not findings,
            "detail": {"measured": True, "cells": [f["cell"] for f in findings][:10],
                       "flagged": len(findings),
                       "findings": findings[:REPO_GUARD_FINDINGS_MAX]}}


def prose_counts_gate(repo: Path, rel: str, built_nb: Path, scratch: Path) -> dict:
    """The repo's own prose-counts guard (#17636, check_prose_quantitative_claims.py, CI
    class `artifact`, --strict). The checker judges a TREE, so the built notebook is copied
    alone in a fresh temporary tree under ``scratch``, same relative path. Its report names the
    snippet, not the cell: each snippet is located back in the built markdown cells."""
    tool = _repo_guard_tool(repo, "check_prose_quantitative_claims.py")
    if not tool.is_file():
        return _unmeasured("prose-counts", skipped=f"tool absent: {tool.name}")
    try:
        scratch.mkdir(parents=True, exist_ok=True)
        # a FRESH tree per call: a tree left by an earlier call would be judged too
        with tempfile.TemporaryDirectory(prefix="repo-guards-", dir=str(scratch)) as root:
            dest = Path(root) / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(built_nb.read_bytes())
            pr = subprocess.run([sys.executable, str(tool), "--all", "--root", root,
                                 "--strict"], cwd=str(repo), capture_output=True, text=True,
                                encoding="utf-8", errors="replace",
                                timeout=REPO_GUARD_TIMEOUT_S, env=_guard_env())
    except (subprocess.TimeoutExpired, OSError) as e:
        return _unmeasured("prose-counts", error=f"{type(e).__name__}: {e}"[:300])
    if pr.returncode == 0:
        return {"gate": "prose-counts", "ok": True, "detail": {"measured": True}}
    if pr.returncode != 1:
        return _unmeasured("prose-counts", rc=pr.returncode,
                           error=(pr.stderr or pr.stdout or "")[-300:])
    snippets: list[str] = []
    refus_header = False
    for ln in (pr.stdout or "").splitlines():
        if ln.startswith("[ALLOWLIST"):
            break                      # the exemption audit reuses the row format
        refus_header = refus_header or ln.startswith("[REFUS")
        m = PROSE_COUNT_ROW_RE.match(ln)
        if m:
            snippets += [x.strip() for x in m.group(3).split(", ") if x.strip()]
    if not snippets:
        # rc 1 names a counter ONLY through its rows. None before [ALLOWLIST] is the
        # instrument failing (a report that crashed, a row format that moved), not a
        # count: the reviser has nothing to act on, and the rounds it burns damage the
        # notebook (26/11, o40 #28645: two revisions, the bibliography gone).
        return _unmeasured("prose-counts", rc=pr.returncode, refus_header=refus_header,
                           error=(pr.stderr or pr.stdout or "")[-300:])
    md = [(i, _text(c.get("source"))) for i, c in enumerate(_cells(built_nb))
          if c.get("cell_type") == "markdown"]
    findings = []
    for sn in snippets[:REPO_GUARD_FINDINGS_MAX]:
        where = [i for i, t in md if sn in t]
        findings.append({"cell": where[0] if where else None,
                         "text": f"compteur « {sn} »"
                                 + (f" (cellule {', '.join(map(str, where))})" if where else "")})
    return {"gate": "prose-counts", "ok": False,
            "detail": {"measured": True,
                       "cells": [f["cell"] for f in findings if f["cell"] is not None][:10],
                       "findings": findings}}


PROSE_ANCHOR_TOOL = Path("scripts") / "check_markdown_claims_output.py"


def _anchor_findings(tool: Path, repo: Path, nb: Path) -> list[dict] | None:
    """The `findings` list of the repo's claims organ on one notebook (numeric values
    in a markdown cell absent from the preceding code cells' outputs); None when the
    organ did not answer with its JSON (rc 2, timeout, unparsable)."""
    pr = subprocess.run([sys.executable, str(tool), "--json", str(nb)], cwd=str(repo),
                        capture_output=True, text=True, encoding="utf-8",
                        errors="replace", timeout=REPO_GUARD_TIMEOUT_S,
                        env=_guard_env())
    if pr.returncode not in (0, 1):
        return None
    try:
        data = json.loads(pr.stdout)
    except ValueError:
        return None
    rows = data if isinstance(data, list) else [data]
    return [f for r in rows if isinstance(r, dict) for f in (r.get("findings") or [])
            if isinstance(f, dict)]


def prose_anchor_gate(repo: Path, src_nb: Path, built_nb: Path) -> dict:
    """Prose re-anchored on the BUILT notebook's own outputs (CoursIA#27864, 21/11): the
    Rust port re-ran the 3SUM timing (1,5 → 77,1 ms, slope 1,927) while its « À retenir »
    and quiz still quoted the Python run (42,7 → 2 836,7 ms, slope 2,016) — Hermes
    CHANGES_REQUESTED. The repo's claims organ (markdown-claims-output-advisory) flags a
    markdown number absent from the preceding outputs; judged on the DELTA: a finding
    the source twin already has (same value in the same markdown cell, or the same
    sentence) is the repo's stock, not this build's."""
    tool = repo / PROSE_ANCHOR_TOOL
    if not tool.is_file():
        return _unmeasured("prose-anchor", skipped=f"tool absent: {PROSE_ANCHOR_TOOL.as_posix()}")
    try:
        built, src = _anchor_findings(tool, repo, built_nb), _anchor_findings(tool, repo, src_nb)
    except (subprocess.TimeoutExpired, OSError) as e:
        return _unmeasured("prose-anchor", error=f"{type(e).__name__}: {e}"[:300])
    if built is None or src is None:
        return _unmeasured("prose-anchor", error="claims organ gave no JSON report")
    known_cell = {(f.get("markdown_cell"), f.get("normalized")) for f in src}
    known_text = {(f.get("normalized"), (f.get("context") or "").strip()) for f in src}
    new = [f for f in built
           if (f.get("markdown_cell"), f.get("normalized")) not in known_cell
           and (f.get("normalized"), (f.get("context") or "").strip()) not in known_text]
    findings = [{"cell": f.get("markdown_cell"),
                 "text": f"cellule {f.get('markdown_cell')} : « {str(f.get('raw')).strip()} » "
                         f"n'apparaît dans aucune des sorties qui la précèdent "
                         f"(« …{(f.get('context') or '').strip()}… ») : réaligner la prose "
                         "sur les sorties de CE carnet, ou la formuler sans le chiffre"}
                for f in new]
    return {"gate": "prose-anchor", "ok": not findings,
            "detail": {"measured": True,
                       "cells": sorted({f["cell"] for f in findings
                                        if f["cell"] is not None})[:10],
                       "flagged": len(findings), "source_flagged": len(src),
                       "findings": findings[:REPO_GUARD_FINDINGS_MAX]}}


def repo_guard_gates(repo: Path, rel: str, built_nb: Path, scratch: Path) -> list[dict]:
    """Stage-3 gates the repo's CI raises on the BUILT notebook itself (21/11: the first
    three Swift Rust ports, CoursIA#27803/#27804/#27805, all came back CHANGES_REQUESTED
    on exactly these). Creation mode only: a new file is 100 % delta, so a whole-file
    check equals the CI's added-lines check; on an EDITED notebook it would charge the
    build with the repo's pre-existing stock. The guards that live in OTHER files —
    readme-notebook-coverage (README row), check-nav-chain (inbound nav edge) and the
    twin-parity seal that nav edge breaks — are applied deterministically at stage 5
    (nb_coder_integrate.integrate, before the commit) and replayed there on the
    committed branch."""
    hits = dead_link_hits(_cells(built_nb), repo, rel)
    gates = [{"gate": "dead-links", "ok": not hits,
              "detail": {"cells": sorted({h["cell"] for h in hits})[:10],
                         "findings": [{"cell": h["cell"],
                                       "text": f"cellule {h['cell']} : lien vers "
                                               f"`{h['target']}`, absent du dépôt"}
                                      for h in hits][:REPO_GUARD_FINDINGS_MAX]}}]
    gates.append(uncommented_code_gate(repo, built_nb))
    gates.append(prose_counts_gate(repo, rel, built_nb, scratch))
    return gates


def _shows_unit_result(cell: dict) -> bool:
    """True when the cell's only displayed value is the unit `()` — an execute_result whose
    data is text/plain `()` and nothing else. evcxr emits it whenever a cell ENDS with a
    block (`for`/`while`/`if`/`{…}`) without a trailing `;` (measured 21/11)."""
    if cell.get("cell_type") != "code":
        return False
    for o in cell.get("outputs") or []:
        if not isinstance(o, dict) or o.get("output_type") != "execute_result":
            continue
        data = o.get("data") or {}
        if set(data) <= {"text/plain"} and _text(data.get("text/plain")).strip() == "()":
            return True
    return False


def unit_result_hits(built_cells: list, src_cells: list) -> list[int]:
    """Built code cells displaying a bare `()` that the twin cell at the same index does
    not display. 21/11: 11 of 34 verifier traces rejected a port for exactly this stray
    `()` — a cosmetic defect the verifier pays a whole turn to find, and a deterministic
    check finds for free before it."""
    return [i for i, c in enumerate(built_cells)
            if _shows_unit_result(c)
            and not (i < len(src_cells) and _shows_unit_result(src_cells[i]))]


# A twin that SAYS a comparison was not made. Measured 26/11 (CoursIA batch o41): 3 of 4
# creation grains ended verify-reject on this one major, restated at every round — the
# producer left its cited-data collection EMPTY and guarded the parity comparison behind
# it, so the cell ran clean and printed « Parité … non attestée », « NON MESURÉ — aucune
# comparaison exécutée », « Références citées, non recalculées ». Deterministic on the
# OUTPUTS: catch it right after execution, before a verifier turn is paid.
# Deliberately NARROW — a bare « non mesuré » is not charged: the approved twin of the same
# batch prints « Citations seules, non mesurées ici : … HTTP réelles, tokens … » beside its
# attestation (facts no twin can measure), and it must pass. Only a phrasing that states a
# comparison did not happen is; the past participle carries the accent on purpose (`mesuré`
# ≠ the noun `mesure`, and « pas de mesure » must not match).
_UNMEASURED_RE = re.compile(
    r"non\s+attest|aucune\s+comparaison|non\s+recalcul|non\s+ex[éÉ]cut"
    r"|\bpas\s+(?:été\s+|encore\s+|jamais\s+)?(?:mesur|recalcul|rejou|ex[éÉ]cut|compar)[éÉ]e?s?\b"
    r"|not\s+measured|unmeasured|not\s+replayed", re.I)


def _unmeasured_line(cell: dict) -> str:
    """First output line of a CODE cell that declares a comparison was not made ('' = none)."""
    if cell.get("cell_type") != "code":
        return ""
    for line in _outputs_text(cell).splitlines():
        if _UNMEASURED_RE.search(line):
            return line.strip()[:240]
    return ""


def unmeasured_output_hits(built_cells: list, src_cells: list) -> list[tuple[int, str]]:
    """(cell index, offending output line) for every built cell that declares a comparison
    was not made while the twin at the same index does not — the twin's own declaration
    (a genuinely out-of-scope measure it prints too) is the repo's business, not this
    build's."""
    return [(i, line) for i, c in enumerate(built_cells)
            if (line := _unmeasured_line(c))
            and not (i < len(src_cells) and _unmeasured_line(src_cells[i]))]


def run_gates(src_nb: Path, built_nb: Path, create_mode: bool = False,
              canon_version: str | None = None, repo: Path | None = None,
              rel: str | None = None, scratch: Path | None = None,
              spec_body: str | None = None, spec_ref: str | None = None,
              kernel_name: str | None = None) -> list[dict]:
    """Stage 3 — harness-only gates on the BUILT notebook, no model turn.

    Judged on the DELTA (cells the build touched): the source's own prose is the repo's
    business, not the gate's — a pre-existing footer stays legit untouched.
    In creation mode every cell is delta, and language-info compares against the series'
    canonical .NET twin (canon_version), never the Python twin."""
    src_cells, built_cells = _cells(src_nb), _cells(built_nb)
    gates: list[dict] = []
    cr_hits = coord_ref_hits(built_cells, src_cells)
    offenders = [h["cell"] for h in cr_hits]
    # The excerpts ride along (22/11, CoursIA#28104): from the cell index alone, five
    # revision rounds could not find what to remove.
    gates.append({"gate": "coord-refs", "ok": not offenders,
                  "detail": {"cells": offenders[:10],
                             "hits": [{"cell": h["cell"], "excerpt": h["excerpt"]}
                                      for h in cr_hits[:10]]}})
    # Foreign-script corruption (#27104 blank pass, 17/11): delta-judged like coord-refs —
    # pre-existing script in the SOURCE is the repo's business, not this build's.
    fs_hits = foreign_script_hits(built_cells, src_cells)
    gates.append({"gate": "foreign-script", "ok": not fs_hits,
                  "detail": {"hits": fs_hits[:10]}})
    # Delta-judged like coord-refs (#433 review): a secret sitting UNTOUCHED in the
    # source is the repo's business -- reported in the detail, it does not fail THIS
    # build. The detail keeps the full picture (source_hits = pre-existing,
    # build_hits = everything seen in the built nb) so a reviewer never confuses
    # "the build introduced one" with "the repo already had one".
    src_secret_hits = [i for i, c in enumerate(src_cells)
                       if SECRET_RE.search(_text(c.get("source")))]
    build_secret_hits = [i for i, c in enumerate(built_cells)
                         if SECRET_RE.search(_text(c.get("source")))]
    new_secret_hits = [i for i in build_secret_hits
                       if not (i < len(src_cells)
                               and _text(built_cells[i].get("source"))
                               == _text(src_cells[i].get("source")))]
    gates.append({"gate": "secrets", "ok": not new_secret_hits,
                  "detail": {"cells": new_secret_hits[:10],
                             "source_hits": src_secret_hits[:10],
                             "build_hits": build_secret_hits[:10]}})
    sv = (json.loads(src_nb.read_text(encoding="utf-8")).get("metadata") or {}) \
        .get("language_info", {}).get("version")
    bv = (json.loads(built_nb.read_text(encoding="utf-8")).get("metadata") or {}) \
        .get("language_info", {}).get("version")
    if create_mode:
        # the built notebook must carry the series' canonical .NET version, not the
        # Python twin's (parité porte sur les verdicts, pas sur la langue du jumeau)
        gates.append({"gate": "language-info", "ok": bv is not None and bv == canon_version,
                      "detail": {"canon": canon_version, "built": bv}})
    else:
        gates.append({"gate": "language-info", "ok": sv is not None and sv == bv,
                      "detail": {"src": sv, "built": bv}})
    # The declared kernelspec must be the kernel that executed the outputs AND the one the
    # target's language tag requires (#27996: a Rust port declared `.net-csharp`, every
    # gate green). Creation only: a corrected notebook keeps its own metadata (the series
    # path map names kernels by folder, not by declared spec — judging it would fail
    # pre-existing notebooks for what this build never touched). Judged only when the
    # caller knows the kernel / the target path.
    bks = ((json.loads(built_nb.read_text(encoding="utf-8")).get("metadata") or {})
           .get("kernelspec") or {}).get("name")
    want_tag = tag_kernel(rel) if rel else None
    if create_mode and (kernel_name or want_tag):
        gates.append({"gate": "kernelspec",
                      "ok": (not kernel_name or bks == kernel_name)
                      and (not want_tag or bks == want_tag),
                      "detail": {"built": bks, "executed": kernel_name, "tag": want_tag}})
    # Delta judged on the OUTPUTS themselves: a cell whose displayed text the build did not
    # change keeps its pre-existing path without failing this build (same rule as secrets).
    src_hits = [i for i, c in enumerate(src_cells) if MACHINE_PATH_RE.search(_outputs_text(c))]
    built_hits = [i for i, c in enumerate(built_cells) if MACHINE_PATH_RE.search(_outputs_text(c))]
    new_hits = [i for i in built_hits
                if not (i < len(src_cells)
                        and _outputs_text(built_cells[i]) == _outputs_text(src_cells[i]))]
    gates.append({"gate": "machine-path", "ok": not new_hits,
                  "detail": {"cells": new_hits[:10], "source_hits": src_hits[:10],
                             "build_hits": built_hits[:10]}})
    # Delta judged like machine-path (#464): an untouched cell keeps its pre-existing
    # SVG-as-text defect (the repo's business, reported in detail); only what THIS build
    # introduces or rewrites fails the gate.
    svg_src = _svg_text_offenders(src_cells)
    svg_built = _svg_text_offenders(built_cells)
    svg_new = [i for i in svg_built
               if not (i < len(src_cells)
                       and _outputs_text(built_cells[i]) == _outputs_text(src_cells[i]))]
    gates.append({"gate": "svg-display", "ok": not svg_new,
                  "detail": {"cells": svg_new[:10], "source_hits": svg_src[:10],
                             "build_hits": svg_built[:10]}})
    unit_hits = unit_result_hits(built_cells, src_cells)
    gates.append({"gate": "unit-result", "ok": not unit_hits,
                  "detail": {"cells": unit_hits[:10],
                             "findings": [{"cell": i,
                                           "text": f"cellule {i} : affiche « () », que le "
                                                   f"jumeau n'affiche pas"}
                                          for i in unit_hits][:REPO_GUARD_FINDINGS_MAX]}})
    um_hits = unmeasured_output_hits(built_cells, src_cells)
    # `measured: True` is explicit here: split_gates() reads an absent key as measured, but a
    # reader that asks the detail directly would see None (review ai-01, 26/11).
    gates.append({"gate": "unmeasured-output", "ok": not um_hits,
                  "detail": {"measured": True, "cells": [i for i, _ in um_hits][:10],
                             "findings": [{"cell": i,
                                           "text": f"cellule {i} : la sortie déclare une "
                                                   f"mesure non faite — « {line} »"}
                                          for i, line in um_hits][:REPO_GUARD_FINDINGS_MAX]}})
    if create_mode and repo is not None and rel and scratch is not None \
            and (repo / "scripts").is_dir():
        gates += repo_guard_gates(repo, rel, built_nb, scratch)
    if create_mode and repo is not None:
        # Prose re-anchored on the built notebook's own outputs (CoursIA#27864): a port
        # re-runs every measure, so prose copied from the twin can quote numbers this
        # notebook never printed. Delta-judged against the twin's own unanchored stock.
        gates.append(prose_anchor_gate(repo, src_nb, built_nb))
    if create_mode and rel and _norm_rel(rel).endswith("-Rust.ipynb"):
        conf = rust_conformance_gate(src_nb, built_nb, spec_body=spec_body,
                                     spec_ref=spec_ref)
        if conf is not None:
            gates.append(conf)
    return gates


def _kernel_language(nb_path: Path) -> str | None:
    meta = (json.loads(nb_path.read_text(encoding="utf-8")).get("metadata") or {})
    return ((meta.get("kernelspec") or {}).get("language")
            or (meta.get("language_info") or {}).get("name"))


def _spec_ref(args, issue: dict | None = None) -> str | None:
    """`#28072` for a spec-declared-absent motif: the CLI's `--issue` when the
    args namespace carries it (tests build minimal namespaces without one),
    else the fetched issue's own number, else no anchor at all -- the motif
    still names the `Tolerances` table and the cell."""
    num = getattr(args, "issue", None) or (issue or {}).get("number")
    return f"#{num}" if num else None


def rust_conformance_gate(src_nb: Path, built_nb: Path, spec_body: str | None = None,
                          spec_ref: str | None = None) -> dict | None:
    """Stage-3 gate for a Rust port of a Python twin (CoursIA c0018, 21/11): the
    `rust_conformance.d` entry written at delivery compares each Rust cell's output to
    the twin's same-index cell, strict text equality, durations by presence only. The
    three lot-1 PRs came back from review on exactly that (a stray `()`, a count the
    outputs did not show). Measured here BEFORE the PR, so the constructive loop
    repairs it instead of a review round. None when there is no Python twin to compare
    to (a spec twin carries no outputs; a C# source is not the registry's reference).
    `spec_body` (the lot spec's issue body, `spec_ref` e.g. `#28072`): its
    `## Tolerances` table downgrades the strict rule per cell -- a stochastic
    port judged against text its own RNG can never reproduce failed #28072
    twice while the model correctly contested it."""
    if (_kernel_language(src_nb) or "").lower() != "python":
        return None
    try:
        divs = _load_integrate_module().conformance_divergences(
            src_nb, built_nb, spec_body=spec_body, spec_ref=spec_ref)
    except Exception as e:  # the gate measures, it never crashes a build
        return {"gate": "rust-conformance", "ok": True,
                "detail": {"measured": False, "error": f"{type(e).__name__}: {e}"[:300]}}
    return {"gate": "rust-conformance", "ok": not divs,
            "detail": {"measured": True,
                       "cells": sorted({d["cell"] for d in divs})[:10],
                       "findings": [{"cell": d["cell"],
                                     "text": f"cellule {d['cell']} ({d['id']}) : {d['text']}"}
                                    for d in divs][:REPO_GUARD_FINDINGS_MAX]}}


# The kernel's own extension-loading notice, one line per loaded package:
#   Loading extensions from `C:\Users\<user>\.nuget\packages\skiasharp\2.88.9\interactive-extensions\dotnet\…dll`
# 21/11 (po-2028, batch w3e2): 5 of 6 C# failures were gates-failed:machine-path on THIS
# line alone — source_hits empty, the same cell flagged in every built notebook, 5 repair
# rounds unable to remove it (a cell edit cannot remove a kernel output). Every ScottPlot
# grain was structurally blocked. The canonical environment prints it too (`/root/.nuget`,
# measured in ChoixSocial-01-…-CSharp.ipynb on CoursIA main), so the line is never content.
EXT_BANNER_LINE_RE = re.compile(r"^\s*Loading extensions from\s+`?[^`\n]+`?\s*\.?\s*$")
_TEXT_MIMES = ("text/plain", "text/html", "text/markdown")


def _is_ext_banner_text(t: str) -> bool:
    lines = [ln for ln in html.unescape(re.sub(r"<[^>]+>", "", t)).splitlines() if ln.strip()]
    return bool(lines) and all(EXT_BANNER_LINE_RE.match(ln) for ln in lines)


def _is_ext_banner_output(o: dict) -> bool:
    """A DISPLAY output (display_data / execute_result) whose only content is the
    kernel's extension notice. Streams are never touched: a line the MODEL prints to
    stdout stays judged by the machine-path gate."""
    if not isinstance(o, dict) or o.get("output_type") not in ("display_data", "execute_result"):
        return False
    data = o.get("data") or {}
    if not data or any(k not in _TEXT_MIMES for k in data):
        return False
    texts = [_text(data[k]) for k in data]
    return any(t.strip() for t in texts) and all(_is_ext_banner_text(t) for t in texts if t.strip())


def strip_kernel_extension_banner(nb_path: Path) -> dict:
    """Drop the kernel's `Loading extensions from <path>` display outputs from the built
    notebook BEFORE the gates read it and before delivery: the line names a user profile
    (`C:/Users/<user>/…`), so a merged notebook carrying it is a real machine-path leak,
    and the build cannot repair it. Model-written text keeps facing the gate."""
    try:
        nb = json.loads(nb_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    removed = []
    for i, c in enumerate(nb.get("cells") or []):
        outs = c.get("outputs")
        if c.get("cell_type") != "code" or not outs:
            continue
        kept = [o for o in outs if not _is_ext_banner_output(o)]
        if len(kept) != len(outs):
            removed.append({"cell": i, "outputs": len(outs) - len(kept)})
            c["outputs"] = kept
    if removed:
        nb_path.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n",
                           encoding="utf-8")
    return {"ok": True, "removed": removed}


def strip_dotnet_banner(tool: Path, nb_path: Path) -> dict:
    """Post-execution hygiene the CoursIA issues mandate verbatim: any .NET Interactive
    re-execution injects a probeAddresses JS banner into cell outputs, and
    `scripts/notebook_tools/strip_probe_banner.py --apply <nb>` must run BEFORE commit
    (the canonical-kernel criterion). 17/11 #27104 blank pass: the verify rejected the
    banner as a MAJOR finding. The tool lives in the CoursIA tree (the worktree carries
    it); a missing tool or failure is RECORDED, not fatal — the verify stays the judge
    of the delivered file. 18/11 #482: --variant BOTH, not the probe default — a
    creation-mode .NET notebook carries the DISCOVERY bootstrap (`dotnet-interactive-
    this-cell` + require.js fetch), a disjoint signature set on purpose (#22728: the
    repo-wide COMMITTED-corpus guard stays probe-only until the 177 inherited
    notebooks are swept; that constraint binds the guard, never a fresh deliverable).
    Measured: probe-only strip reported ok while the verify rejected the discovery
    banner as MAJOR; `--variant both` removed exactly that output."""
    if not tool.is_file():
        return {"ok": False, "error": f"strip tool absent: {tool}"}
    try:
        p = subprocess.run([sys.executable, str(tool), "--apply", str(nb_path),
                            "--variant", "both"],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=120, env=_guard_env())
        return {"ok": p.returncode == 0, "rc": p.returncode,
                "out": (p.stdout or p.stderr or "")[-500:]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "strip tool timeout"}


def _archive_verify_trace(out_dir: Path, issue: int, tag: str) -> str | None:
    """Move an existing verify trace aside (renamed, never deleted). stage4_verify reads
    verify-<issue>.json after the child exits: a child that dies before writing would
    otherwise hand back the PREVIOUS verdict — certain to happen once a grain is verified
    more than once (revision rounds, --revise-from)."""
    trace = out_dir / f"verify-{issue}.json"
    if not trace.is_file():
        return None
    dest = trace.with_name(f"verify-{issue}.{tag}.json")
    k = 1
    while dest.exists():
        dest = trace.with_name(f"verify-{issue}.{tag}-{k}.json")
        k += 1
    trace.replace(dest)
    return str(dest)


# `model_used` is the sk-agent ENTRY id, not the model that answered. 20/11, po-2028: 11
# requests of the `nb-minimax` entry were served by glm-5.3 through a local sidecar reroute,
# the verifier being glm-5.3 too, and the traces still read `nb-minimax`. These two envelope
# fields carry what actually served the call (claudish `x-claudish-failover-notice` #229,
# served model claudish#1128); they are recorded when present and NEVER inferred from the
# requested id.
# One call_agent call can make several HTTP round-trips (agent rounds, SDK retries). When
# they disagree, sk-agent (ms#1824, squash 756dd4f4) puts the LAST value in `served_model`
# and every distinct value in `served_model_variants` -- the latter only exists when there
# is more than one. Comparing `served_model` alone misses a round served by the verifier's
# model that was not the last one (#4844 c.7042525323).
SERVED_FIELDS = ("served_model", "served_model_variants",
                 "failover_notice", "failover_notice_variants")


def served_fields(env: dict) -> dict:
    return {k: env[k] for k in SERVED_FIELDS if env.get(k)}


def usage_fields(env: dict) -> dict:
    """The call's OWN tokens, as sk-agent reports them (#506 palier 0).

    `engine_delta` is the whole-engine counter delta over the call, Claude Code traffic
    included (IT08 `1-plan`: +569 630 prompt tokens for one 93.7 s call), so it cannot
    size a turn. sk-agent's UsageMeter sums `usage` over EVERY completion of one
    call_agent (one per tool round), so `prompt_tokens` here is a cumulated cost, not the
    resident context of the last round: the largest round is <= this value. Recorded only
    when the envelope carries it; never zero-filled (a zero would read as a free call).
    """
    usage = env.get("usage")
    if not isinstance(usage, dict):
        return {}
    out = {k: int(usage[k]) for k in ("prompt_tokens", "completion_tokens")
           if isinstance(usage.get(k), (int, float)) and not isinstance(usage.get(k), bool)}
    return {"usage": out} if out else {}


def served_models(env: dict) -> set[str]:
    """Every concrete model the envelope says served the call; empty = not known."""
    out = {str(v) for v in (env.get("served_model_variants") or []) if v}
    if env.get("served_model"):
        out.add(str(env["served_model"]))
    return out


def _notices(env: dict) -> list[str]:
    seen = [str(v) for v in (env.get("failover_notice_variants") or []) if v]
    if env.get("failover_notice") and str(env["failover_notice"]) not in seen:
        seen.append(str(env["failover_notice"]))
    return seen


def served_identity(calls: list, verify: dict) -> dict:
    """Producer vs verifier, by the models that SERVED them, as far as the envelopes say.

    `same`: a model that served the verifier also served a producer call (any round, not
    only the last) -> the producer judged its own work, and no approval stands. `distinct`:
    every answered producer call names what served it and no model is on both sides.
    `unknown` otherwise: said in clear, never read as distinct. Failover notices are listed
    whatever the status."""
    answered = [c for c in calls or [] if c.get("response_chars") and not c.get("error")]
    prod_sets = [served_models(c) for c in answered]
    prod = set().union(*prod_sets)
    ver = served_models(verify)
    shared = sorted(prod & ver)
    if shared:
        status = "same"
    elif ver and answered and all(prod_sets):
        status = "distinct"
    else:
        status = "unknown"
    fo = [{"stage": c.get("stage"), "notice": " | ".join(_notices(c))[:300]}
          for c in calls or [] if _notices(c)]
    if _notices(verify):
        fo.append({"stage": "4-verify", "notice": " | ".join(_notices(verify))[:300]})
    return {"status": status, "producer": sorted(prod),
            "verifier": ", ".join(sorted(ver)) or None, "shared": shared, "failovers": fo}


def configured_target(entry_id: str | None, config: Path | None = None) -> str | None:
    """What an sk-agent model ENTRY points at, as the seat's config declares it.

    `model_used` is the sk-agent entry id, and entry ids keep historical names: on ai-01,
    `qwen3.6-35b-a3b-nbcoder` points at :5002 with model `swift-1.5-27b`. A PR that cited the
    entry id alone named the legacy MoE as producer, so Swift's work was counted as nobody's
    (claudish #445 tally, 20/11: "0 PR où Swift est nommé producteur", while #27481 was Swift).

    This is a CONFIGURED target, not a served model: an endpoint behind a hub can fail over
    elsewhere, and only `served_model` in the envelope says what answered (#504). The PR body
    labels it accordingly. Only the model id and the port are returned, never the host or a
    key. None when the config is unreadable or has no such entry: unknown stays unknown.
    """
    if not entry_id:
        return None
    try:
        cfg = json.loads(Path(config or SK_CONFIG).read_text(encoding="utf-8"))
    except Exception:
        return None
    for m in cfg.get("models") or []:
        if isinstance(m, dict) and m.get("id") == entry_id:
            model = m.get("model_id") or m.get("model")
            if not model:
                return None
            port = re.search(r":(\d+)(?:/|$)", str(m.get("base_url") or ""))
            return f"{model} sur :{port.group(1)}" if port else str(model)
    return None


def producer_label(agent: str, entry_id: str | None, config: Path | None = None) -> str:
    """`agent` (entrée `id` → cible configurée `model`), or as much of it as is known."""
    if not entry_id:
        return f"`{agent}` (entrée sk-agent inconnue)"
    target = configured_target(entry_id, config)
    if not target:
        return f"`{agent}` (entrée sk-agent `{entry_id}`, cible non lue)"
    return f"`{agent}` (entrée sk-agent `{entry_id}` → cible configurée `{target}`)"


def identity_line(identity: dict | None) -> str:
    """One PR-body line: what served, or that it is not known."""
    st = (identity or {}).get("status")
    if st == "distinct":
        head = (f"producteur {', '.join(identity['producer'])} ≠ vérificateur "
                f"{identity['verifier']}")
    elif st == "same":
        both = identity.get("shared") or [identity["verifier"]]   # records before variants
        head = f"MÊME modèle servi des deux côtés ({', '.join(map(str, both))})"
    else:
        head = "modèle servi inconnu (l'enveloppe sk-agent ne le publie pas)"
    if (identity or {}).get("failovers"):
        head += " ; bascule au hub sur " + ", ".join(
            str(f["stage"]) for f in identity["failovers"])
    return head


def stage4_verify(args, rec: dict, src_nb: Path, built_nb: Path, out_dir: Path,
                  prior: dict | None = None) -> None:
    """Stage 4 — the independent verifier runs as a SEPARATE process and agent
    (producer != verifier, global rule). nb_coder_verify.py exits 0 approve /
    1 reject / 2 instrument error — an error is NEVER read as a reject.

    ``prior`` (revision rounds): the verifier's previous findings and the builder's
    addressed/contested answer, passed as claims to counter-check."""
    facts = out_dir / f"facts-{args.issue}.json"
    facts.write_text(json.dumps(
        {k: rec.get(k) for k in ("plan", "apply", "structure", "exec_mode", "c2",
                                 "execution", "conversation_id")}, ensure_ascii=False),
        encoding="utf-8")
    stale = _archive_verify_trace(out_dir, args.issue,
                                  datetime.now(timezone.utc).strftime("pre%Y%m%dT%H%M%SZ"))
    cmd = [sys.executable, str(HERE / "nb_coder_verify.py"),
           "--issue", str(args.issue), "--source-nb", str(src_nb), "--built-nb", str(built_nb),
           "--facts", str(facts), "--agent", args.verifier_agent,
           "--out-dir", str(out_dir), "--timeout", str(args.verify_timeout)]
    if getattr(args, "verifier_model", None):    # #4831: the audit step's model, per pass
        cmd += ["--model", args.verifier_model]
    if getattr(args, "notebook", None):
        # same spec scoping as the producer: on a lot issue, THIS notebook's [SPEC-DRAFT]
        cmd += ["--target", _norm_rel(args.notebook)]
    if getattr(args, "from_spec", False):
        # the SOURCE is a [SPEC] twin, not an origin notebook: the correction-mode task
        # ("content lost / invented vs SOURCE") would reject every new cell by design
        cmd += ["--mode", "spec"]
    if prior:
        prior_p = out_dir / f"prior-{args.issue}.json"
        prior_p.write_text(json.dumps(prior, ensure_ascii=False), encoding="utf-8")
        cmd += ["--prior", str(prior_p)]
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}   # the child prints non-ASCII JSON
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=args.verify_timeout + 300, env=env)
        rc, out = p.returncode, (p.stdout or p.stderr or "")
    except subprocess.TimeoutExpired:
        rc, out = 2, "verify subprocess timeout"
    entry: dict = {"rc": rc, "agent": args.verifier_agent,
                   "elapsed_s": round(time.time() - t0, 1), "tail": out.strip()[-1500:]}
    if stale:
        entry["previous_trace"] = stale
    trace = out_dir / f"verify-{args.issue}.json"
    if trace.is_file():
        t = json.loads(trace.read_text(encoding="utf-8"))
        entry |= {"verdict": t.get("verdict"), "model_used": t.get("model_used"),
                  "findings": (t.get("answer") or {}).get("findings"),
                  "conversation_id": t.get("conversation_id"), **served_fields(t)}
    entry["identity"] = served_identity(rec.get("calls") or [], entry)
    rec["verify"] = entry
    rec["stage4_s"] = entry["elapsed_s"]
    if rc == 0 and entry.get("verdict") == "approve" and entry["identity"]["status"] == "same":
        # producer != verifier is a rule on MODELS, not on agent names: an approval signed by
        # the model that wrote the draft is no verification, so it never reaches a PR.
        note_content_verdict(rec, "verify-same-served-model")
    elif rc == 0 and entry.get("verdict") == "approve":
        note_content_verdict(rec, "verify-approved")
        # The approval is bound to the bytes judged: a resume that re-runs stage 5 alone
        # (23/11) refuses a build written since this verdict.
        with contextlib.suppress(OSError):
            entry["built_sha256"] = hashlib.sha256(built_nb.read_bytes()).hexdigest()
    elif rc == 1 and entry.get("verdict") == "reject":
        note_content_verdict(rec, "verify-reject")
    else:
        rec["verdict"] = "verify-error"


# Inline commit identity (ms#1813, upstreamed here after two re-copies dropped it
# from the sk-agent harness): a CI runner configures no user.name/user.email and
# the stage5 commit is the FIRST commit of a fresh worktree — without these two
# `-c` pairs git dies "Author identity unknown" and the whole grain fails at the
# last step, after every token was spent.
_GIT_IDENTITY = ("-c", "user.name=nb-coder",
                 "-c", "user.email=nb-coder@nb-coder.invalid")


def _git(wt: Path, *git_args: str, timeout: int = 300) -> tuple[int, str]:
    p = subprocess.run(["git", "-C", str(wt), *git_args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    return p.returncode, (p.stdout or p.stderr).strip()


PUSH_TIMEOUT_S = 900


def _push_branch(wt: Path, branch: str, timeout: int = PUSH_TIMEOUT_S,
                 lease: str | None = None) -> tuple[int, str]:
    """`git push -u origin <branch>` that never crashes the grain (22/11, CoursIA#28018).

    CoursIA's pre-push hook is `git lfs pre-push`: a manual push of #28018 took 85 s, the
    driver's took more than its 300 s timer, and the uncaught TimeoutExpired crashed a
    grain whose notebook was built AND approved. A timed-out push is judged by the remote,
    not the timer: if origin's branch already points at HEAD the push landed and stage 5
    goes on; otherwise it is a plain push failure, recorded, never a crash.

    `lease` is the full sha of the commit a PREVIOUS attempt of the same grain pushed
    (a resume from `pr-create-failed`, #1885 review). The push then carries
    `--force-with-lease=refs/heads/<branch>:<sha>`: origin is replaced only while it still
    sits on that commit, and refuses anything else. Never set on a first run, or on a
    resume that has no such record -- a same-named branch is then refused, as before."""
    extra = [f"--force-with-lease=refs/heads/{branch}:{lease}"] if lease else []
    try:
        return _git(wt, "push", "-u", *extra, "origin", branch, timeout=timeout)
    except subprocess.TimeoutExpired:
        pass
    try:
        _, head = _git(wt, "rev-parse", "HEAD", timeout=60)
        lrc, lout = _git(wt, "ls-remote", "origin", f"refs/heads/{branch}", timeout=120)
    except subprocess.TimeoutExpired:
        return 1, f"push timed out after {timeout} s; remote not readable either"
    if lrc == 0 and lout.split()[:1] == [head]:
        return 0, f"push timed out after {timeout} s, but origin/{branch} is at HEAD"
    return 1, f"push timed out after {timeout} s (origin/{branch} not at HEAD)"


def _repo_slug(wt: Path) -> str | None:
    """owner/repo parsed from the worktree's origin URL (#433 review: no hard-coded
    repo -- the PR targets wherever the branch is pushed, neutral by construction).
    Handles https://github.com/o/r(.git) and git@github.com:o/r(.git)."""
    _, out = _git(wt, "remote", "get-url", "origin")
    m = re.search(r"[:/]([^/:]+/[^/]+?)(?:\.git)?$", out or "")
    return m.group(1) if m else None


def _short_desc(args, plan: dict, create_mode: dict | None = None) -> str:
    """One-line gesture description composed from the plan's own 'but' fields —
    harness-only, no model turn. House form: '<notebook stem> cell N — <but>'.

    A creation (spec twin or port) has no 'plan.plan' list — its plan carries
    'cells' instead — so it gets its own form; without it the title fell back
    to '— edit', which mislabels a whole new notebook (CoursIA#27481)."""
    stem = Path(args.notebook).stem
    if isinstance(create_mode, dict):
        n = len([c for c in (plan.get("cells") or []) if isinstance(c, dict)])
        cells = f" ({n} cellules)" if n else ""
        if create_mode.get("source"):
            return f"{stem} — portage depuis {Path(str(create_mode['source'])).stem}{cells}"[:140]
        return f"{stem} — création depuis spec{cells}"[:140]
    gestes = [g for g in (plan.get("plan") or []) if isinstance(g, dict)]
    if len(gestes) == 1 and gestes[0].get("geste") == "edit" and str(gestes[0].get("cell")).isdigit():
        but = _text(gestes[0].get("but")).strip()
        return f"{stem} cell {gestes[0]['cell']} — {but}"[:140] or f"{stem} — edit"
    kinds = ",".join(sorted({str(g.get("geste")) for g in gestes})) or "edit"
    return f"{stem} — {len(gestes)} gestes ({kinds})" if gestes else f"{stem} — {kinds}"


def _norm_rel(p: str) -> str:
    """Repo-relative path, posix-normalized: issue declarations use forward slashes,
    a Windows CLI arg may use backslashes — both must compare on the same plane."""
    parts = [seg for seg in re.split(r"[\\/]+", (p or "").strip()) if seg not in ("", ".")]
    return "/".join(parts)


# CoursIA's parser knows exactly these three tiers; anything else is refused downstream.
GRAIN_TIERS = ("DEEP", "MED", "LIGHT")


# CoursIA's canonical tag line (variation-protocol §1). The `prev:` field is REQUIRED there:
# `variation-tag-prev-absent` is posed on any tag that declares no predecessor, because
# G-VAR-3 adjacency ("never the same LIGHT genre twice in a row") is evaluated from it.
# Measured 16/11 on CoursIA#26943: the harness tag carried no `prev:` and the guard labelled
# the PR the moment it opened -- the same class as `Grain: auto` (#459), one field further.
GRAIN_PREV_FIRST = "none (premier grain)"
# `<TIER>/<GENRE>` + optional ` #<PR>`. Strict on purpose: a stray value here would be read
# as a predecessor and make an adjacency verdict on a citation that is not one.
_GRAIN_PREV_RE = re.compile(r"^(?:%s)/[A-Za-z0-9._-]+(?: #\d+)?$" % "|".join(GRAIN_TIERS))
# What the lane's own PR bodies say a grain line looks like. `--`, `-` and the em dash are
# all accepted: the guard normalises dashes, and a driver that only read its own dialect
# would report "no predecessor" precisely when another writer used the documented `--`.
_GRAIN_LINE_RE = re.compile(
    r"Grain:\s*(%s)\s*/\s*([A-Za-z0-9._-]+)\s*(?:—|--|-)\s*lane\s+(\S+)"
    % "|".join(GRAIN_TIERS))


def lane_predecessor(repo_slug: str, lane: str, token: str | None) -> str | None:
    """The lane's most recent grain in `repo_slug`, as `prev:` wants it (vllm#459).

    `prev:` is lane HISTORY, not a value this run can know: only GitHub holds it. Three
    outcomes, each named rather than guessed --
      * `"none (premier grain)"` — the lane has no earlier grain in this repo (the
        protocol's documented exemption: not a claim of priority, an absence of predecessor);
      * `"<TIER>/<GENRE> #<PR>"` — the predecessor as its own body declares it;
      * `None` — the history could not be read, so the tag declares no predecessor instead
        of inventing one. The label that follows is then TRUE, and the trace says why.

    Never a fourth outcome: citing an ISSUE number as a PR number (a `#N` sitting on the
    same line) is exactly the wrong-pointer defect this function exists to avoid -- hence
    the `prev:` field is the last field of the tag, with nothing scannable after it.
    """
    rc, out = gh(["pr", "list", "--repo", repo_slug, "--state", "all",
                  "--search", f'in:body "lane {lane}"',
                  "--json", "number,body", "--limit", "30"], token, timeout=90)
    if rc != 0:
        return None
    try:
        prs = json.loads(out or "[]")
    except Exception:
        return None
    best: tuple[int, str] | None = None
    for pr in prs:
        body = pr.get("body") or ""
        for m in _GRAIN_LINE_RE.finditer(body):
            # The search is a substring match: `lane a` also returns `lane ab`. The tag's
            # own lane field is what decides, so an older grain of a sibling lane is skipped
            # rather than cited as this lane's predecessor.
            if m.group(3).rstrip(".,;") != lane:
                continue
            try:
                num = int(pr.get("number") or 0)
            except (TypeError, ValueError):
                continue
            # By NUMBER, not by list order: GitHub's search ordering is not creation order
            # (measured 16/11 on CoursIA -- #26790 came back before #26806), and the
            # predecessor is whichever grain has the highest number below this run's PR.
            if best is None or num > best[0]:
                best = (num, f"{m.group(1)}/{m.group(2)} #{num}")
    return best[1] if best else GRAIN_PREV_FIRST


def grain_tag(tier: str, lane: str, genre: str = "notebook-python",
              prev: str | None = GRAIN_PREV_FIRST) -> str:
    """The PR's leading `Grain: <TIER>/<GENRE> — lane … — prev: …` line, CoursIA's grammar.

    `auto` is NOT a tier. CoursIA's shared parser (`scripts/grain_tag.py`) reads
    `auto/notebook-python` as `grain-tier-unknown:AUTO`, and `merge_ready` refuses such a PR
    **even approved and green** — the harness was producing merges that could not merge
    (measured by ai-01:CoursIA the 16/11, #26943 retagged by hand the same day).

    The tier is a CLAIM the lane makes about the grain's weight, so it comes from a flag and
    is never inferred here: a harness that guesses DEEP on a one-cell edit buys its own
    review cost. Normalisation is argparse's job (`type=str.upper`); this function is strict
    on purpose, so a caller that bypasses the flag gets a loud refusal, not a silent `auto`.

    `prev=None` means the lane history was UNREADABLE: the field is then omitted and the
    guard's `variation-tag-prev-absent` is the honest verdict. Writing `none (premier grain)`
    instead would assert a first grain nobody checked.
    """
    if tier not in GRAIN_TIERS:
        raise ValueError(f"grain tier must be one of {GRAIN_TIERS}, got {tier!r}")
    head = f"Grain: {tier}/{genre} — lane {lane}"
    if prev is None:
        return head
    if prev != GRAIN_PREV_FIRST and not _GRAIN_PREV_RE.match(prev):
        raise ValueError(f"prev must be {GRAIN_PREV_FIRST!r} or '<TIER>/<GENRE> #<PR>', "
                         f"got {prev!r}")
    return f"{head} — prev: {prev}"


def default_pr_branch(issue_n: int, notebook: str) -> str:
    """`nbcoder/auto-<issue>-<notebook stem>-<6 hex>`: one branch per GRAIN.

    `nbcoder/auto-<issue>` alone made the second grain of a lot issue fail at
    `checkout -b` (the branch is held by the first grain's PR), after the whole
    model run had been paid. The stem keeps the branch readable for the reviewer,
    the hash of the repo-relative path keeps two same-stem notebooks apart."""
    nb = _norm_rel(notebook)
    stem = re.sub(r"[^a-z0-9]+", "-", Path(nb).stem.lower()).strip("-")[:40].rstrip("-")
    h = hashlib.sha1(nb.encode("utf-8")).hexdigest()[:6]
    return f"nbcoder/auto-{issue_n}-{stem or 'nb'}-{h}"


def pr_title(issue_n: int, desc: str, create_mode) -> str:
    """House form. A creation (port or spec twin) ADDS a notebook: `Add(notebooks,…)`.
    Titling a port `Fix(notebooks,…) — portage` was a maintainer Concern on CoursIA#27598."""
    kind = "Add" if isinstance(create_mode, dict) else "Fix"
    return f"{kind}(notebooks,#{issue_n}): {desc}"


def issue_link_line(issue_n: int, issue: dict | None, target: str) -> str:
    """`Closes #N`, except on a LOT issue (several [SPEC-DRAFT] targets): the first PR of
    the lot must not close the issue the other notebooks still hang on."""
    sc = (issue or {}).get("spec_comment") or {}
    lot = [t for t in sc.get("lot_targets") or [] if t]
    if sc.get("status") == "selected" and len(lot) > 1:
        return (f"Refs #{issue_n} — lot de {len(lot)} carnets : cette PR livre "
                f"`{_norm_rel(target)}` seulement, l'issue reste ouverte pour les autres.")
    return f"Closes #{issue_n}"


def _load_integrate_module():
    """nb_coder_integrate.py loaded BY PATH: stdlib-only sibling, so tests that
    exec the driver via importlib (no driver dir on sys.path) can still reach
    it, and the driver's own import graph stays mcp-free at this edge."""
    import importlib.util
    path = Path(__file__).with_name("nb_coder_integrate.py")
    spec = importlib.util.spec_from_file_location("nb_coder_integrate", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_drift_module():
    """nb_coder_drift.py, loaded by path like the integration module."""
    import importlib.util
    path = Path(__file__).with_name("nb_coder_drift.py")
    spec = importlib.util.spec_from_file_location("nb_coder_drift", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def stage5_base_rev(wt_path: Path, rec: dict) -> str:
    """The revision the port was BUILT on: the worktree head its trace recorded.

    On a resume that failed past the branch (a push or a create failure) the worktree sits
    on the previous attempt's commit, whose twin already carries the integration's nav
    link: measured from THERE, a markdown cell the source gained since reads ``structure``
    and the approved build is refused again (23/11). HEAD only when the trace records no
    head this repository still resolves."""
    head = ((rec.get("stages") or {}).get("worktree") or {}).get("head")
    if head:
        rc, _ = _git(wt_path, "rev-parse", "-q", "--verify", f"{head}^{{commit}}", timeout=60)
        if rc == 0:
            return str(head)
    return "HEAD"


def stage5_source_drift(wt_path: Path, src_twin: str, rebase: bool = True,
                        base_rev: str = "HEAD", old_blob: str | None = None) -> dict:
    """Did the port's source twin move on origin/main since the port was built?

    22/11, CoursIA main red for every open PR: #27805 ported Sudoku-07-Norvig while
    #27348 added three cells to its Python twin; merged on stale checks, the port
    lacked a block of its source, the index-aligned conformance spec diverged and
    the attestation named a blob the squash never wrote. Read BEFORE the branch:
    `markdown-only` re-bases the detached worktree on origin/main so the
    integration edits (nav link, README row, reseal) land on the fresh twin;
    `structure`/`code`/`deleted` refuse the push (the port is stale, a retry
    re-ports from the new source). A fetch that fails leaves the comparison to
    the last known origin/main and says so -- fail-open, as before this guard.

    ``rebase=False`` measures and leaves the worktree on the build's base: stage 5
    grafts first when the source only gained markdown cells (23/11), then re-bases.
    ``base_rev`` is the revision the port was built on (``stage5_base_rev``);
    ``old_blob`` the source as a previous delivery attempt measured it (a build
    already grafted is aligned with THAT source)."""
    rc_f, out_f = _git(wt_path, "fetch", "-q", "origin", "main")
    try:
        drift = _load_drift_module().source_drift(wt_path, base_rev, src_twin,
                                                  old_blob=old_blob)
    except Exception as e:  # never a blocker on an instrument failure
        return {"drift": "unmeasured", "error": f"{type(e).__name__}: {e}"[:300]}
    if rc_f != 0:
        drift["fetch_error"] = out_f[:200]
    if rebase and drift.get("drift") in ("markdown-only", "markdown-added"):
        rc, out = _git(wt_path, "checkout", "-q", "--detach", "origin/main")
        drift["rebased"] = rc == 0
        if rc != 0:
            drift["rebase_error"] = out[:300]
    return drift


def _nb_style(text: str, nb: dict) -> dict:
    """How a notebook file was serialised, found by round-trip: the style whose
    re-serialisation of the parsed notebook gives back its own text. A rewrite then
    differs from the file only by what was changed in it, never by indent, key order,
    escapes or a trailing newline. Falls back to nbformat's own style."""
    for indent in (1, 2, None):
        for sort_keys in (True, False):
            for ascii_ in (False, True):
                for tail in ("\n", ""):
                    kw = {"indent": indent, "sort_keys": sort_keys, "ensure_ascii": ascii_}
                    if indent is None:
                        kw["separators"] = (",", ":")
                    if json.dumps(nb, **kw) + tail == text:
                        return {"kw": kw, "tail": tail}
    return {"kw": {"indent": 1, "sort_keys": True, "ensure_ascii": False}, "tail": "\n"}


def stage5_graft_markdown(wt_path: Path, src_twin: str, drift: dict,
                          built_nb: Path, base_rev: str = "HEAD",
                          old_blob: str | None = None) -> dict:
    """Copy into the built port the markdown cells its source twin gained on origin/main.

    Admitted only by `graft_markdown` (the port is cell-aligned with the source it was
    built on; the source gained markdown cells and nothing else). The source the port is
    aligned with is read where `stage5_source_drift` measured from: ``old_blob`` when
    readable, else ``base_rev``. The build is rewritten
    in the run dir, its previous bytes kept next to it (`<build>.pre-graft-<ts>Z.ipynb`),
    in the file's own serialisation and line endings -- the notebook that will be pushed
    differs from the approved one by the added cells and nothing else. Deterministic:
    no model turn, no git gesture."""
    try:
        mod = _load_drift_module()
        raw = built_nb.read_bytes()
        text = raw.decode("utf-8-sig").replace("\r\n", "\n")
        port = json.loads(text)
        old_nb = ((mod.blob_notebook(wt_path, old_blob) if old_blob else None)
                  or mod.notebook_at(wt_path, base_rev, src_twin))
        res = mod.graft_markdown(port, old_nb,
                                 mod.notebook_at(wt_path, "origin/main", src_twin))
        if res.get("error"):
            return {"ok": False, "error": res["error"]}
        cells, already = res.pop("cells"), res.pop("already")
        backup = None
        if not already:
            backup = built_nb.with_name(
                f"{built_nb.stem}.pre-graft-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.ipynb")
            shutil.copy2(built_nb, backup)
            style = _nb_style(text, port)
            out = json.dumps(port | {"cells": cells}, **style["kw"]) + style["tail"]
            if b"\r\n" in raw:
                out = out.replace("\n", "\r\n")
            try:
                with open(built_nb, "w", encoding="utf-8", newline="") as fh:
                    fh.write(out)
            except Exception:
                # the file is truncated by now: ANY failure of the write restores it -- a
                # disk error, and an encoding one too (UnicodeEncodeError is a ValueError)
                shutil.copy2(backup, built_nb)     # never leave a half-written approved build
                raise
    except Exception as e:  # refuses loudly; an approved build is never shipped half-grafted
        return {"ok": False, "error": f"{type(e).__name__}: {e}"[:200]}
    return {"ok": True, "inserted": res["inserted"], "count": res["count"], "already": already,
            "backup": backup.name if backup else None,
            "sha256": hashlib.sha256(built_nb.read_bytes()).hexdigest()}


def integration_pr_lines(integ: dict | None) -> str:
    """PR-body section for the stage-5 repo integration (21/11): one line per
    replayed guard with its exit code. A guard still red AFTER integration is
    reported as such -- never hidden, never a reason to abort the PR."""
    if not isinstance(integ, dict):
        return ""
    if integ.get("error"):
        return (f"\n\n## Intégration dépôt\n\n- Échec de l'intégration : "
                f"`{integ['error']}` -- les gardes README/nav/parité peuvent "
                f"rester rouges.")
    if integ.get("skipped"):
        return f"\n\n## Intégration dépôt\n\n- {integ['skipped']}."
    lines = ["## Intégration dépôt\n"]
    if integ.get("readme"):
        note = f" -- {integ['nav_note']}" if integ.get("nav_note") else ""
        lines.append(f"- Ligne README (`{integ['readme']}`) et arête nav "
                     f"(`{integ.get('nav')}`) ajoutées sur le jumeau Python{note}.")
    if integ.get("back"):
        lines.append(f"- Lien retour vers le jumeau d'origine ajouté au nouveau carnet "
                     f"(`{integ['back']}`, markdown seul).")
    conf = integ.get("conformance") or {}
    if conf.get("todo") and conf.get("file"):
        cs = (f", côté C# `{conf['csharp']}` comparé où il imprime le même texte, "
              "sinon déclaré absent avec l'écart mesuré") if conf.get("csharp") \
            else ", pas de jumeau C#"
        lines.append(f"- Entrée de conformité Rust `{conf['file']}` écrite : "
                     f"{conf.get('measures', 0)} mesures, dont "
                     f"{conf.get('three_sided', 0)} à trois côtés{cs}.")
        for d in (conf.get("spec_absent") or [])[:8]:
            lines.append(f"  - Côté Rust déclaré absent {d.get('id')} : {d.get('reason')}.")
        for d in (conf.get("spec_masked") or [])[:8]:
            lines.append(f"  - Valeur non comparée {d.get('id')} : {d.get('reason')} "
                         f"(mesure écrite morceau par morceau, tout le reste comparé).")
        for d in (conf.get("divergences") or [])[:5]:
            lines.append(f"  - Divergence mesurée {d.get('id')} : {d.get('text')}.")
    elif conf.get("file") and conf.get("why"):
        lines.append(f"- Entrée de conformité Rust `{conf['file']}` : {conf['why']}.")
    reg = integ.get("registered") or {}
    if reg.get("registered"):
        lines.append(f"- Paire « {reg['pair']} » enregistrée à la livraison "
                     f"(`{reg['file']}`).")
    reseal = integ.get("reseal") or {}
    if reseal.get("pair"):
        tail = "" if reseal.get("ok") else f" -- ÉCHEC rc={reseal.get('rc')}"
        lines.append(f"- Paire « {reseal['pair']} » rescellée, attestation en "
                     f"dernière opération{tail}.")
    for g in integ.get("guards") or []:
        mark = "OK" if g.get("rc") == 0 else f"ÉCHEC"
        lines.append(f"- Garde `{g['guard']}` : exit {g.get('rc')} ({mark}).")
    if integ.get("guards_error"):
        lines.append(f"- Gardes non rejouées : `{integ['guards_error']}`.")
    return "\n\n" + "\n".join(lines)


# A delivery names the kernel that EXECUTED the deliverable. `rec["kernel"]` is not it:
# on a creation that is the kernel the metadata was lent from, and a --revise-from resume
# carries it untouched. Measured on CoursIA#28332 (24/11, Planners-05c-…-Rust): every
# kernel the harness started was `rust` (driver log, `kernelspec_align.to`) while the
# commit and the PR body said `.net-csharp`. Stage 5 reads the execution record instead.
# The record is written where an execution RESULT exists (`note_execution_kernel`), never
# at a kernel start alone.
# A trace that holds none (written before the record existed, or no kernel ever started)
# is READ, never measured -- and the published line says so.
_KERNEL_READ_SOURCES = {"align": "alignement kernelspec",
                        "override": "--kernel-override",
                        "selection": "sélection d'avant-exécution"}


def published_execution_kernel(args, rec: dict) -> tuple[str | None, str]:
    """(kernel to publish at delivery, provenance note -- "" when measured).

    Precedence: the recorded execution; then, on a trace that recorded none, readings --
    the alignment (align_kernelspec refuses to write unless its target equals the
    kernel the execution path named), --kernel-override (the resume's own precedence,
    #27996), and the pre-execution selection, which is what every body published
    before. A reading is NOT a measurement: its note says where it was read and
    that no execution was recorded.
    """
    measured = (rec.get("executed_kernel") or {}).get("name")
    if measured:
        return measured, ""

    def read(source: str, value: str | None) -> tuple[str | None, str]:
        return value, f" (noyau lu : {_KERNEL_READ_SOURCES[source]}, exécution non enregistrée)"

    aligned = (rec.get("kernelspec_align") or {}).get("to")
    if aligned:
        return read("align", aligned)
    override = getattr(args, "kernel_override", None)
    if override:
        return read("override", override)
    return read("selection", (rec.get("kernel") or {}).get("kernel_name"))


def note_execution_kernel(rec: dict, kname: str) -> None:
    """Record the kernel that PRODUCED the trace's execution result. Called right
    after `execution_verdict` read `rec["execution"]`. A kernel id alone is not an
    execution: exec mode `none` starts a kernel and runs nothing, and a repair
    restart that returned none leaves the cells of its round unexecuted
    (`rec["kernel_id"]` is then none). Never called for the .NET API probe."""
    if kname and rec.get("kernel_id") and rec.get("execution"):
        rec["executed_kernel"] = {"name": kname, "kernel_id": rec["kernel_id"],
                                  "source": "manage_kernel-start"}


def stage5_pr(args, rec: dict, wt_path: Path, built_nb: Path, issue: dict,
              token: str | None) -> None:
    """Stage 5 — harness-only GitHub gestures: the model never writes to git or GitHub.
    Fresh branch off the detached worktree, integration commit (notebook + README
    row + inbound nav link + C# pair registration), twin-parity reseal LAST, REST
    PR create, delivery comment on the issue."""
    t0 = time.time()
    nb_rel = args.notebook.replace("\\", "/")
    branch = args.pr_branch or default_pr_branch(args.issue, args.notebook)
    desc = _short_desc(args, rec.get("plan") or {}, rec.get("create_mode"))
    entry: dict = {"branch": branch}
    executed_as, kernel_note = published_execution_kernel(args, rec)
    entry["published_kernel"] = {"name": executed_as, "note": kernel_note,
                                 "record": rec.get("executed_kernel")}

    cm0 = rec.get("create_mode") or {}
    src0 = cm0.get("source") if isinstance(cm0, dict) else None
    pr_resume = bool((rec.get("stages") or {}).get("pr_resume"))

    def _rebase() -> bool:
        """Detach onto today's origin/main. False when it failed -- and the refusal is
        written: an integration replayed on a stale base is not pushed on a guess."""
        rc, out = _git(wt_path, "checkout", "-q", "--detach", "origin/main")
        if rc == 0:
            entry["rebased"] = True
            return True
        entry["error"] = f"re-base on origin/main failed: {out[:300]}"
        rec["verdict"], rec["pr"] = "pr-rebase-failed", entry
        return False

    if src0:
        # Measured BEFORE any git gesture, so that a graft refused below leaves HEAD where
        # it was -- a worktree left on origin/main would read "no drift" on the next
        # attempt and push a port without the cells the source gained. Measured FROM the
        # source the port is aligned with, never from wherever a previous attempt left
        # the worktree: that attempt's main blob when it delivered an already-grafted
        # build (stages.pr_resume carries it), else the build's base, the head the
        # trace recorded (stage5_base_rev).
        base_rev = stage5_base_rev(wt_path, rec)
        old_blob = ((rec.get("stages") or {}).get("pr_resume") or {}).get("main_blob")
        drift = stage5_source_drift(wt_path, str(src0), rebase=False, base_rev=base_rev,
                                    old_blob=old_blob)
        entry["source_drift"] = drift
        entry["base_rev"] = base_rev
        if drift.get("drift") in ("structure", "code", "deleted"):
            entry["error"] = (f"source twin {src0} changed on origin/main since the build "
                              f"({drift['drift']}): the port is stale, no PR")
            rec["verdict"], rec["pr"] = f"source-drifted:{drift['drift']}", entry
            return
        if drift.get("drift") == "markdown-added":
            # 23/11, CoursIA#28209: an APPROVED 44-cell port, then #28239 inserted ONE
            # markdown cell at index 43 of the 44-cell Python twin and stage 5 read it
            # "structure" -> the port was refused. An addition of markdown cells changes
            # no cell the verifier judged: the added cells are copied verbatim into the
            # port at the index they hold in the fresh source (deterministic, no model
            # turn), and the approval stays true for everything it judged.
            grafted = stage5_graft_markdown(wt_path, str(src0), drift, built_nb,
                                            base_rev=base_rev, old_blob=old_blob)
            entry["graft"] = {k: v for k, v in grafted.items() if k != "cells"}
            if not grafted.get("ok"):
                entry["error"] = f"markdown-added drift, graft refused: {grafted.get('error')}"
                rec["verdict"], rec["pr"] = "source-drifted:graft-failed", entry
                return
        # The integration lands on the fresh twin. Every refusal above has returned
        # already, so nothing below finds the worktree on origin/main by accident.
        if drift.get("drift") in ("markdown-only", "markdown-added"):
            if _rebase():
                drift["rebased"] = True
            else:
                return
        elif pr_resume and not _rebase():
            return
    elif pr_resume and not _rebase():
        # no source twin to measure (edit mode, spec twin): the same start
        return

    # A resume re-creates its branch from origin/main as a first run does, drift or not
    # (above): the worktree may sit on the previous attempt's branch, and a second commit
    # stacked on that one would be empty (the same build, an idempotent integration).
    # It also meets the branch its previous attempt left in the repo (the scheduler
    # releases a failed grain's worktree, never its branch). Nothing is force-pushed -- a
    # branch already on origin with other bytes is refused by the push below, as before.
    rc, out = _git(wt_path, "checkout", "-B" if pr_resume else "-b", branch)
    if rc != 0:
        entry["error"] = out[:300]
        rec["verdict"], rec["pr"] = "pr-branch-failed", entry
        return
    shutil.copy2(built_nb, wt_path / args.notebook)
    rc, out = _git(wt_path, "add", "--", nb_rel)
    if rc != 0:
        entry["error"] = f"add: {out[:300]}"
        rec["verdict"], rec["pr"] = "pr-git-failed", entry
        return

    # Repo integration (21/11, coordinator + po-2028 measurements): a NEW port
    # notebook trips readme-notebook-coverage (no README row) and check-nav-chain
    # (orphan_entry: no inbound nav edge); fixing the latter edits the Python
    # twin's markdown, which breaks the twin-parity seal -> reseal LAST. All
    # deterministic (nb_coder_integrate, no model turn), applied BEFORE the
    # commit so the PR carries it on first push; a failure never aborts the PR,
    # it is recorded and said in the body.
    cm = rec.get("create_mode") or {}
    src_twin = cm.get("source") if isinstance(cm, dict) else None
    if src_twin:
        try:
            nbci = _load_integrate_module()
            integ = nbci.integrate(wt_path, nb_rel, str(src_twin),
                                   spec_body=(issue.get("body")
                                              if isinstance(issue, dict) else None),
                                   spec_ref=_spec_ref(args, issue))
            if integ.get("error"):
                entry["integration"] = integ
            else:
                for f in integ.get("touched", []):
                    _git(wt_path, "add", "--", f)
                facts = {"kernel": executed_as,
                         "kernel_read": bool(kernel_note),
                         "executed_cells": len(rec.get("execution") or []),
                         "verdict": (rec.get("verify") or {}).get("verdict")}
                reg = nbci.register_pair(wt_path, str(src_twin), nb_rel,
                                         args.lane, facts=facts)
                if reg.get("registered"):
                    _git(wt_path, "add", "--", reg["file"])
                entry["integration"] = {"files": integ["touched"],
                                        "nav": (integ["nav"] or {}).get("how"),
                                        "nav_note": (integ["nav"] or {}).get("note"),
                                        "back": (integ.get("back") or {}).get("how")
                                        if (integ.get("back") or {}).get("todo") else None,
                                        "readme": (integ["readme"] or {}).get("label"),
                                        "conformance": integ.get("conformance"),
                                        "registered": reg,
                                        "pair": integ.get("pair")}
        except Exception as e:  # integration is an optimisation, never a blocker
            entry["integration"] = {"error": f"{type(e).__name__}: {e}"[:300]}
    else:
        entry["integration"] = {"skipped": "no source twin in the repo "
                                           "(edit mode or spec twin)"}

    graft = entry.get("graft") or {}
    graft_idx = ", ".join(str(g["index"]) for g in graft.get("inserted") or [])
    commit_body = (
        f"{desc}\n\n"
        + "\n".join(f"- cell {g.get('cell')} ({g.get('geste')}): {_text(g.get('but')).strip()}"
                    for g in (rec.get("plan") or {}).get("plan") or [] if isinstance(g, dict))
        + (f"\n\nCellule(s) markdown {graft_idx} : ajoutées au jumeau source sur main après "
          f"la construction du portage, recopiées telles quelles aux mêmes indices "
          f"(greffe déterministe, code inchangé)." if graft.get("count") else "")
        + f"\n\nProducteur : {args.agent} (harnais nb_coder, stages 0-5)."
        + f"\nVérification indépendante : {args.verifier_agent} — "
        f"{(rec.get('verify') or {}).get('verdict')} "
        f"(modèle {(rec.get('verify') or {}).get('model_used')})."
        + f"\nModèle servi : {identity_line((rec.get('verify') or {}).get('identity'))}."
        + f"\nExécution : kernel {executed_as}{kernel_note}, "
        f"{len(rec.get('execution') or [])} cellules exécutées, C.2 "
        f"{'séquentiel' if (rec.get('c2') or {}).get('sequential') else 'BROKEN'}."
        + "\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>")
    msg_file = built_nb.parent / f"commit-msg-{args.issue}.txt"
    msg_file.write_text(commit_body, encoding="utf-8")
    rc, out = _git(wt_path, *_GIT_IDENTITY, "commit", "--file", str(msg_file))
    if rc != 0:
        # Pre-commit auto-fixer pattern (measured 2/2 on fresh .ipynb grains,
        # CoursIA #27113 + #27102): an auto-fix hook rewrites the staged file
        # during the first commit, which fails and leaves status `AM`. Re-add
        # the fixed file and retry ONCE -- blocking hooks never touch the file,
        # so they keep failing on the replay, and the retry stays bounded.
        st_rc, st_out = _git(wt_path, "status", "--porcelain", "--", nb_rel)
        if st_rc == 0 and st_out.strip().startswith("AM"):
            entry["commit_retry"] = "pre-commit-auto-fix-read"
            _git(wt_path, "add", "--", nb_rel)
            rc, out = _git(wt_path, *_GIT_IDENTITY, "commit", "--file", str(msg_file))
    msg_file.unlink(missing_ok=True)
    if rc != 0:
        entry["error"] = f"commit: {out[:300]}"
        rec["verdict"], rec["pr"] = "pr-git-failed", entry
        return
    # `_git` returns (rc, out): the sha is the SECOND element (this read recorded `0`
    # until #1885's review measured it).
    _, entry["commit"] = _git(wt_path, "rev-parse", "--short", "HEAD")

    # Twin-parity reseal, AFTER the integration commit (the tool records the
    # git blob SHAs at HEAD: notebook, README row and inbound link must be in
    # already -- po-2028 measured the attestation written LAST on 14 PRs, else
    # the re-read of the source twin rejects it), then the three repo guards
    # replayed on the committed branch before the push.
    integ = entry.get("integration") or {}
    if src_twin and isinstance(integ, dict) and not integ.get("error"):
        try:
            nbci = _load_integrate_module()
            pair = nbci.find_twin_pair(wt_path, str(src_twin))
            if pair:
                reseal = nbci.reseal_pair(wt_path, pair, args.lane)
                if reseal.get("audit_files"):
                    _git(wt_path, "add", "--",
                         "scripts/notebook_tools/twin_pairs.d")
                    _git(wt_path, *_GIT_IDENTITY, "commit", "-m",
                         f"Chore(twin-parity,#{args.issue}): rescelle « {pair} » "
                         "après l'ajout du lien jumeau\n\n"
                         "Le jumeau Python ne change qu'en markdown (navigation). "
                         "Attestation écrite en DERNIÈRE opération, après carnet, "
                         "ligne README et arête nav.\n\n"
                         f"Lane: {args.lane}\n"
                         "Co-Authored-By: Claude Sonnet 5.5 "
                         "<noreply@anthropic.com>\n")
                integ["reseal"] = reseal
            else:
                integ["reseal"] = {"why": "source twin not in a registered pair"}
            integ["guards"] = nbci.replay_guards(wt_path, nb_rel)
        except Exception as e:
            integ["guards_error"] = f"{type(e).__name__}: {e}"[:300]

    # A resume from `pr-create-failed` finds its OWN branch on origin: the previous attempt
    # pushed it, then died at `gh pr create`. Rebuilt on today's origin/main the new commit
    # is not its descendant, so a plain push is refused (non-fast-forward) and the grain
    # would loop to `pr-push-failed` (ai-01, #1885). The lease is the commit that attempt
    # recorded at its push: origin is replaced only while it still sits there. A first run,
    # and every other resume, pushes without one and is refused as before.
    lease = ((rec.get("stages") or {}).get("pr_resume") or {}).get("pushed_sha")
    rc, out = _push_branch(wt_path, branch, lease=lease)
    if rc != 0:
        entry["error"] = f"push: {out[:300]}"
        rec["verdict"], rec["pr"] = "pr-push-failed", entry
        return
    # The full commit origin now holds: what a later resume may replace, under lease.
    _, entry["head_sha"] = _git(wt_path, "rev-parse", "HEAD")

    n_exec = len(rec.get("execution") or [])
    gates_ok, gates_unmeasured = split_gates(rec.get("gates") or [])
    findings = (rec.get("verify") or {}).get("findings") or []
    # #433 review: resolve the PR target from the worktree's own origin (or an explicit
    # --pr-repo); never a hard-coded repo. Refusing loudly beats silently targeting the
    # wrong repo -- a wrong-repo PR number recorded in a [DELIVERED] marker poisons the
    # claim registry. Resolved HERE, before the body is composed, because the `prev:` field
    # is read from that same repo's lane history (vllm#459).
    repo_slug = args.pr_repo or _repo_slug(wt_path)
    if not repo_slug:
        entry["error"] = ("cannot resolve PR target repo (no --pr-repo, origin URL "
                          "unparseable) -- pass --pr-repo owner/repo explicitly")
        rec["verdict"], rec["pr"] = "pr-repo-unresolved", entry
        return
    entry["repo"] = repo_slug
    prev = lane_predecessor(repo_slug, args.lane, token)
    entry["grain_prev"] = prev if prev else "unreadable (tag declares no predecessor)"
    pr_body = (
        f"{grain_tag(args.grain_tier, args.lane, prev=prev)}\n\n"
        f"**Grain** : lane `{args.lane}`. Issue #{args.issue}. "
        f"**Livraison AUTONOME** — harnais nb_coder stages 0-5 : producteur "
        f"{producer_label(args.agent, (rec.get('calls') or [{}])[-1].get('model_used'))}, "
        f"vérificateur indépendant "
        f"{producer_label(args.verifier_agent, (rec.get('verify') or {}).get('model_used'))}"
        f".\n\n"
        f"## Geste\n\n{desc}\n\n"
        + "\n".join(f"- cell {g.get('cell')} ({g.get('geste')}): {_text(g.get('but')).strip()}"
                    for g in (rec.get("plan") or {}).get("plan") or [] if isinstance(g, dict))
        + "\n\n## Mesures\n\n"
        f"- **Exécution réelle** (execute_on_kernel, kernel `{executed_as}`{kernel_note}) : "
        f"{n_exec} cellules, 0 erreur. C.2 : execution_count séquentiel — "
        f"{'oui' if (rec.get('c2') or {}).get('sequential') else 'NON'}.\n"
        f"- **Gates** : {', '.join(gates_ok) or 'aucun'} OK"
        + (f" ; **non mesurés** (outil indisponible, la CI de la PR tranche) : "
           f"{', '.join(gates_unmeasured)}" if gates_unmeasured else "")
        + ".\n"
        f"- **Vérification indépendante** : `{(rec.get('verify') or {}).get('verdict')}` par "
        f"`{args.verifier_agent}`, {len(findings)} constat(s). Modèle "
        f"`{(rec.get('verify') or {}).get('model_used')}`.\n"
        f"- **Modèle servi** : {identity_line((rec.get('verify') or {}).get('identity'))}.\n"
        + (f"- **Revue constructive** : approuvé après {len(rec['revisions'])} tour(s) de "
           f"révision (constats en entrée par tour : "
           f"{', '.join(str(r.get('findings_in')) for r in rec['revisions'])}), chaque tour "
           f"réexécuté en noyau neuf et re-vérifié.\n" if rec.get("revisions") else "")
        + f"- **Trace** : conversation producteur `{rec.get('conversation_id')}`, "
        f"conversation vérificateur `{(rec.get('verify') or {}).get('conversation_id')}`, "
        f"run record complet dans le out-dir du harnais.\n"
        + integration_pr_lines(entry.get("integration"))
        + ("\n- Jumeau source modifié **en markdown seul** sur `main` depuis la construction "
           f"(blob {(entry.get('source_drift') or {}).get('base_blob')} → "
           f"{(entry.get('source_drift') or {}).get('main_blob')}, cellules de code "
           "identiques) : intégration rejouée sur la version fraîche."
           if (entry.get("source_drift") or {}).get("rebased") else "")
        + (f"\n- Le jumeau source a **gagné {graft['count']} cellule(s) markdown** sur `main` "
           f"depuis la construction (indice(s) {graft_idx} sur le jumeau frais) : recopiée(s) "
           "telles quelles dans le portage aux mêmes indices — greffe déterministe, aucun "
           "tour de modèle ; aucune cellule jugée par le vérificateur n'a changé."
           if graft.get("count") else "")
        + f"\n{issue_link_line(args.issue, issue, args.notebook)}\n\n"
        "🤖 Generated with [Claude Code](https://claude.com/claude-code)")
    body_file = built_nb.parent / f"pr-body-{args.issue}.md"
    body_file.write_text(pr_body, encoding="utf-8")
    entry["gh_identity"] = gh_identity_record()
    rc, out = gh(["api", f"repos/{repo_slug}/pulls",
                  "-f", f"title={pr_title(args.issue, desc, rec.get('create_mode'))}",
                  "-f", f"head={branch}", "-f", f"base={args.pr_base}",
                  "-F", f"body=@{body_file}"], token, timeout=120)
    body_file.unlink(missing_ok=True)
    if rc != 0:
        who = entry["gh_identity"].get("login") or "active gh account"
        entry["error"] = f"pr create (as {who}): {out[:300]}"
        rec["verdict"], rec["pr"] = "pr-create-failed", entry
        return
    pr = json.loads(out)
    entry |= {"number": pr.get("number"), "url": pr.get("html_url")}

    # #433 review: the claim registry (CoursIA check_lane_claim.py) parses the marker
    # grammar `[DELIVERED] lane <lane> -- PR #N ... paths: <list>`: the marker must
    # START a line, `PR #N` (prefix required) is the only PR ref it captures -- prose
    # `issue #N` never matches -- and the `paths:` clause is read as the FINAL segment
    # of the marker line. Producer/verifier/trace stay on separate prose lines BELOW,
    # never on the marker line.
    comment = (f"[DELIVERED] lane {args.lane} -- PR #{pr.get('number')} -- paths: {nb_rel}\n\n"
               f"Livraison harnais nb_coder : issue #{args.issue}.\n"
               f"Producteur : `{args.agent}`. Vérificateur : `{args.verifier_agent}` "
               f"({(rec.get('verify') or {}).get('verdict')}). "
               f"Trace : conversation `{rec.get('conversation_id')}`.")
    rc_c, out_c = gh(["api", f"repos/{repo_slug}/issues/{args.issue}/comments",
                      "-f", f"body={comment}"], token, timeout=120)
    entry["delivery_comment"] = rc_c == 0
    if rc_c != 0:
        entry["delivery_comment_error"] = out_c[:200]
    rec["pr"] = entry
    rec["verdict"] = "pr-created"
    rec["stage5_s"] = round(time.time() - t0, 1)


# ---------------------------------------------------------------- shared build/revise steps
# Swift's window (--max-model-len). Every repair round and bisect half used to continue the
# build conversation. 21/11 conveyor (#27134 2.3d): prompt tokens 77 112 at 2.5-repair+0,
# 208 828 at +2, 238 335 at +2+h0, then the second half was refused in 1.1 s (400 "This
# model's maximum context length is 262144 tokens. However, your prompt contains at least
# 262145 input tokens") and the grain ended with the first half's four cells repaired. A
# repair prompt carries what its turn needs (failing sources, real errors, upstream cells,
# conventions), so the turn can start a fresh conversation instead.
CTX_WINDOW = 262144
# chars -> tokens, rounded DOWN on purpose: the estimate must overstate, never understate
CTX_CHARS_PER_TOKEN = 3
_CTX_OVERFLOW_RE = re.compile(r"maximum context length is \d+ tokens")

FRESH_REPAIR_HEAD = (
    "NOUVELLE CONVERSATION — l'historique de ce carnet a rempli la fenêtre du modèle, ce "
    "tour repart à vide. Carnet cible : `{nb}` (noyau {kernel}){twin}. Tout ce qu'il te faut "
    "pour ce tour est dans ce message : les cellules en échec, leurs erreurs réelles et les "
    "cellules amont utiles.\n\n")


def context_overflow(env: dict) -> bool:
    """The engine refused the prompt as longer than its window (a 400 on input tokens)."""
    return bool(_CTX_OVERFLOW_RE.search(str(env.get("error") or "")))


def conv_tokens(rec: dict, conv: str | None) -> int | None:
    """Tokens `conv` holds after its last answered call: that call's prompt + completion.

    An upper bound (the completion counts reasoning the history may drop). None when it
    cannot be told: no answered call on `conv`, or the last one used tools — sk-agent then
    sums usage over every tool round, which overstates the context by the round count."""
    if not conv:
        return None
    for c in reversed(rec.get("calls") or []):
        if c.get("conversation_id") != conv:
            continue
        u = c.get("usage") or {}
        if "prompt_tokens" not in u:
            continue        # refused or failed call: it committed nothing to size
        if c.get("tools"):
            return None
        return int(u["prompt_tokens"]) + int(u.get("completion_tokens") or 0)
    return None


def ctx_overrun(rec: dict, conv: str | None, prompt: str, max_tokens: int,
                budget: int) -> dict | None:
    """The estimate, when continuing `conv` with `prompt` could not fit `budget`."""
    resident = conv_tokens(rec, conv)
    if resident is None:
        return None
    need = resident + len(prompt) // CTX_CHARS_PER_TOKEN + int(max_tokens or 0)
    return {"resident": resident, "need": need, "budget": budget} if need > budget else None


def fresh_repair_head(args, kname: str) -> str:
    nb = getattr(args, "notebook", None) or "?"
    twin = getattr(args, "source_nb", None)
    return FRESH_REPAIR_HEAD.format(nb=nb, kernel=kname,
                                    twin=f", portage de `{twin}`" if twin else "")


async def repair_call(sk, args, rec: dict, stage: str, prompt: str, conv: str | None,
                      head: str = "") -> dict:
    """One repair turn, on `conv` while it has room, else in a fresh conversation.

    Before the call: the estimate says whether `conv` can take the prompt and the answer.
    After it: a 400 on the window (the estimate is blind after a tool turn) sends the same
    prompt again, fresh. Either way the switch is recorded in rec["fresh_conversations"]."""
    budget = int(getattr(args, "ctx_window", None) or CTX_WINDOW)
    why = ctx_overrun(rec, conv, prompt, BUILD_MAX_TOKENS, budget)
    if why is None:
        env = await sk_call_retry(sk, args, rec, stage, prompt, conv,
                                  max_tokens=BUILD_MAX_TOKENS)
        if not (conv and context_overflow(env)):
            return env
        why = {"refused": True, "budget": budget}
    env = await sk_call_retry(sk, args, rec, f"{stage}-fresh", head + prompt, None,
                              max_tokens=BUILD_MAX_TOKENS)
    rec.setdefault("fresh_conversations", []).append(
        {"stage": stage, "from": conv, "to": env.get("conversation_id"), **why})
    return env


def repair_bisect_cause(env: dict) -> str:
    """'truncated', 'timeout' or '' — the two repair failures a smaller request can cure.
    A refusal, an auth error or a well-formed but wrong answer is not one of them."""
    if gate_refusal(env):
        return ""
    if looks_truncated(env):
        return "truncated"
    return "timeout" if call_timed_out(env) else ""


# Levels of halving a repair round may go down (halves, quarters, eighths). 21/11 conveyor
# (#27134 2.3c): six root cells asked at once, then both halves of three, were each cut
# mid-source at 15.7K / 25.7K / 23.6K chars with 9.0K / 11.8K / 10.2K completion tokens of
# a 32 768 budget — the answer stops near the same length whatever is asked, so halving
# once left 3-cell requests still above it and the grain was lost on a missing `use`.
# Three levels take six cells down to one; a half that parses is never split further.
REPAIR_SPLIT_DEPTH = 3


async def _repair_halves(sk, args, rec: dict, stage: str, detail: list[dict],
                         conventions: str, upstream: list[dict], deferred: list[dict],
                         crate_api: str, conv: str | None, head: str = "",
                         depth: int = 1) -> tuple[dict | None, str | None, dict]:
    """Ask the failing cells in two halves, as the build does. Every half that parses
    contributes its cells; a half that fails is named, the other still counts. A half
    cut again on the same two failures (truncated, timeout) is itself halved, down to
    REPAIR_SPLIT_DEPTH levels or one cell. Returns (merged part or None, conversation,
    bisect record)."""
    mid = max(1, len(detail) // 2)
    merged: list[dict] = []
    halves: list[dict] = []
    for hi, half in enumerate(h for h in (detail[:mid], detail[mid:]) if h):
        hidx = {x["idx"] for x in half}
        hup = [u for u in upstream if u["for"] in hidx]
        hdef = [x for x in deferred if set(x["roots"]) & hidx]
        hstage = f"{stage}+h{hi}"
        henv = await repair_call(sk, args, rec, hstage,
                                 repair_prompt(half, conventions, hup, hdef, crate_api),
                                 conv, head=head)
        conv = henv.get("conversation_id") or conv
        hpart, henv = await parse_or_repair(sk, args, rec, hstage, henv, conv,
                                            max_tokens=BUILD_MAX_TOKENS)
        hcells = (hpart or {}).get("cells") or []
        verdict, split = "", None
        if not hcells:
            verdict = (gate_refusal(henv) or call_failure(henv)
                       or repair_bisect_cause(henv) or "unparsed")
            if (verdict in ("truncated", "timeout") and len(half) > 1
                    and depth < REPAIR_SPLIT_DEPTH):
                spart, conv, split = await _repair_halves(
                    sk, args, rec, hstage, half, conventions, hup, hdef, crate_api, conv,
                    head=head, depth=depth + 1)
                hcells = (spart or {}).get("cells") or []
        halves.append({"asked": sorted(hidx), "got": len(hcells),
                       "upstream": [u["idx"] for u in hup],
                       "deferred": [x["idx"] for x in hdef],
                       **({"verdict": verdict} if verdict else {}),
                       **({"split": split} if split else {})})
        merged += hcells
    return ({"cells": merged} if merged else None), conv, {"halves": halves}


async def repair_kernel_errors(sk, pm, args, rec: dict, scratch: Path, kname: str,
                               exec_dir: Path, kid: str | None, exec_targets: list[int],
                               conv: str | None, conventions: str,
                               stage: str = "2.5-repair") -> tuple[str | None, str | None]:
    """Repair loop: the REAL kernel errors go back to the model (max --repair-rounds, same
    conversation). A repaired definition can change downstream semantics -> FRESH kernel per
    round, then re-run the same targets (repair replaces sources only, indices stay valid).
    Measured on #27099 attempt 3: content-level API errors (MkNe inexistent, Expr vs
    ArithExpr) are exactly what the compiler messages teach back. Returns (kid, conv).

    The budget is --repair-rounds, extended one round at a time (up to --repair-extend
    more) while the last round strictly reduced the failing cells: see
    repair_round_extends."""
    budget = args.repair_rounds
    extend = max(0, int(getattr(args, "repair_extend", REPAIR_EXTEND_DEFAULT) or 0))
    cap = budget + extend if budget > 0 else 0
    rnd = 0
    dotnet = kname.startswith(".net")
    probed = None              # the execution list the last .NET probe read
    if dotnet:
        rec.pop("dotnet_api_last", None)
    while rnd < budget:
        failing = [e for e in (rec.get("execution") or []) if not e.get("ok")]
        if not failing:
            break
        cells_now = _cells(scratch)
        detail = []
        for e in failing:
            i = e.get("cell")
            if not isinstance(i, int) or i >= len(cells_now):
                continue
            src = _text(cells_now[i].get("source"))
            errs = _outputs_text(cells_now[i])
            detail.append({"idx": i, "source": cap_source(src),
                           "errors": error_digest(cells_now[i], errs),
                           "cited": cited_lines(src, errs),
                           "_frames": error_frame_names(errs), "_raw_errors": errs})
        if not detail:
            break
        # Crates cargo refused ("no matching package named … found", #27134 2.3b): kept for
        # the whole run. Once the `:dep` line is gone, cargo no longer names the crate; only
        # `unlinked crate` remains below, and the link advice would ask to add it back.
        absent: list[str] = rec.setdefault("absent_crates", []) if kname == "rust" else []
        for d in detail if kname == "rust" else ():
            absent += [a for a in absent_packages(d["_raw_errors"]) if a not in absent]
        # Root cause first (#27302 attempt 2): a cell failing on a name an EARLIER failing
        # cell declares waits for that cell's repair; it is re-executed after the round.
        all_failing = {d["idx"] for d in detail}
        roots = cascade_roots(cells_now, detail)
        deferred: list[dict] = []
        if roots and len(roots) < len(detail):
            deps_now = {_crate_norm(n): s["idx"] for n, s in cell_deps(cells_now).items()}
            for d in detail:
                if d["idx"] in roots:
                    # Only roots asked this round are named; a cell waiting on another
                    # waiting cell (29 on 20, #27302) follows it transitively.
                    kept = [r for r in roots[d["idx"]] if r not in roots]
                    names = [n for n in undefined_names(d["_raw_errors"])
                             if source_cell(cells_now, n, before=d["idx"]) in kept]
                    crates = [c for c in unlinked_crates(d["_raw_errors"])
                              if deps_now.get(_crate_norm(c)) in kept]
                    deferred.append({"idx": d["idx"], "roots": kept, "names": names,
                                     "crates": crates})
            detail = [d for d in detail if d["idx"] not in roots]
        # Rust: the real API of the crates the errors touch (MGS-25, 2.3b), from the
        # registry copy the kernel compiled.
        crate_api, api_info = ("", {})
        if kname == "rust":
            try:
                crate_api, api_info = crate_api_block(cells_now,
                                                      [d["_raw_errors"] for d in detail],
                                                      absent=absent)
            except Exception as ex:  # grounding is an aid: never fail the round on it
                api_info = {"error": f"{type(ex).__name__}: {ex}"[:300]}
        # .NET: the same truth by reflection on the kernel that just compiled the cells
        # (ICT-15, 22/11: four rounds per grain re-invented ScottPlot members).
        elif dotnet and kid:
            g = await dotnet_ground_execution(pm, kid, scratch, rec.get("execution"))
            probed = rec.get("execution")
            if g:
                crate_api, api_info = g["block"], g["info"]
                rec["dotnet_api_last"] = g
            else:
                rec.pop("dotnet_api_last", None)
        # Upstream definitions the stack crosses (#27314): offered, bounded, never demanded.
        failing_idx = {d["idx"] for d in detail}
        upstream: list[dict] = []
        for d in detail:
            for name in d.pop("_frames"):
                j = defining_cell(cells_now, name, before=d["idx"])
                if j is None or j in all_failing:
                    continue
                known = next((u for u in upstream if u["idx"] == j), None)
                if known is not None:
                    if name not in known["names"]:
                        known["names"].append(name)
                    continue
                if len(upstream) >= REPAIR_UPSTREAM_MAX:
                    continue
                upstream.append({"idx": j, "names": [name], "for": d["idx"],
                                 "via": "trace",
                                 "source": cap_source(_text(cells_now[j].get("source")))})
        # Fallback by USE (#27302, 20/11): an assertion raised in the cell itself crosses no
        # upstream frame, yet its cause is often data or a function defined above (the
        # Petersen witness graph of cell 5). Runtime errors only: a compiler diagnostic
        # names its own line, and the cause is in the cell.
        traced = {u["for"] for u in upstream}
        for d in detail:
            if d["idx"] in traced or _COMPILE_ERROR_RE.search(d.pop("_raw_errors", "")):
                continue
            for j, names in using_cells(cells_now, d["idx"], REPAIR_UPSTREAM_MAX,
                                        exclude=all_failing):
                known = next((u for u in upstream if u["idx"] == j), None)
                if known is not None:
                    known["names"].extend(n for n in names if n not in known["names"])
                    continue
                if len(upstream) >= REPAIR_UPSTREAM_MAX:
                    break
                upstream.append({"idx": j, "names": list(names), "for": d["idx"],
                                 "via": "use",
                                 "source": cap_source(_text(cells_now[j].get("source")))})
        for d in detail:
            d.pop("_raw_errors", None)
        # The `:dep` cell decides versions and features: offered next to the grounding (a
        # feature gate such as plotters' `bitmap_backend` is fixed there, never in the cell).
        dep_idx = api_info.get("dep_cell")
        if (crate_api and isinstance(dep_idx, int) and dep_idx not in all_failing
                and dep_idx in exec_targets and dep_idx < len(cells_now)
                and all(u["idx"] != dep_idx for u in upstream)):
            upstream.append({"idx": dep_idx, "names": list(api_info.get("crates") or []),
                             "for": detail[0]["idx"], "via": "dep",
                             "source": cap_source(_text(cells_now[dep_idx].get("source")))})
        head = fresh_repair_head(args, kname)
        env = await repair_call(sk, args, rec, f"{stage}+{rnd}",
                                repair_prompt(detail, conventions, upstream, deferred,
                                              crate_api), conv, head=head)
        conv = env.get("conversation_id") or conv
        part, env = await parse_or_repair(sk, args, rec, f"{stage}+{rnd}", env, conv,
                                          max_tokens=BUILD_MAX_TOKENS)
        bisect = None
        cause = "" if (part and part.get("cells")) else repair_bisect_cause(env)
        if cause and len(detail) > 1:
            # 21/11 conveyor (#27134 2.3d): six cells asked at once, the answer stopped
            # mid-source after 644.7 s with no error raised, and the grain was lost. The
            # build already halves a tranche on exactly these two failures (#517); a
            # repair round is the same request shape: half the cells, half the output.
            # Each half carries the upstream cells and held cells that concern it.
            part, conv, bisect = await _repair_halves(
                sk, args, rec, f"{stage}+{rnd}", detail, conventions, upstream, deferred,
                crate_api, conv, head=head)
            bisect["cause"] = cause
        if not part or not part.get("cells"):
            rec.setdefault("repairs", []).append(
                {"stage": stage, "round": rnd,
                 "verdict": (call_failure(env) or (f"bisect-{cause}" if bisect else "")
                             or "unparsed"),
                 "raw_tail": (env.get("response") or "")[-1500:],
                 **({"bisect": bisect} if bisect else {})})
            break
        # Scope = what the round showed: the failing cells + the upstream ones offered.
        rep = apply_repairs(scratch, part,
                            only_idx=failing_idx | {u["idx"] for u in upstream})
        # A `:dep` to a crate that does not exist fails its cell every time, whatever else
        # the repair fixed: struck mechanically from the cells this round rewrote.
        struck = (strike_absent_deps(scratch, absent, rep["replaced"])
                  if kname == "rust" and absent and rep["replaced"] else [])
        rec.setdefault("repairs", []).append(
            {"stage": stage, "round": rnd, "asked": len(detail), "replaced": rep["replaced"],
             "upstream": [u["idx"] for u in upstream],
             "deferred": [x["idx"] for x in deferred],
             "crate_api": api_info or None,
             "unknown_idx": rep["unknown_idx"], "bad": rep["bad"],
             "out_of_scope": rep["out_of_scope"],
             **({"struck_deps": struck} if struck else {}),
             **({"bisect": bisect} if bisect else {})})
        if not rep["replaced"]:
            break
        await pm_call(pm, "manage_kernel", {"action": "stop", "kernel_id": kid})
        kid = await start_kernel(pm, kname, exec_dir)
        rec["kernel_id"] = kid
        if kid is None:
            rec["verdict"] = "kernel-start-failed"
            break
        rec["execution"] = await execute_cells(pm, scratch, kid, exec_targets)
        rnd += 1
        after = sum(1 for e in rec["execution"] if not e.get("ok"))
        if repair_round_extends(rnd, budget, cap, len(failing), after):
            budget += 1
            rec.setdefault("repair_extensions", []).append(
                {"stage": stage, "after_round": rnd - 1, "failing_before": len(failing),
                 "failing_after": after, "budget": budget})
    # Rounds spent, cells still failing: the probe reads the FINAL execution while its
    # kernel is alive, so the constructive loop's first round gets the API too
    # (exec-reject findings, revise_loop). The caller stops the kernel.
    if dotnet and kid and rec.get("execution") is not probed:
        g = await dotnet_ground_execution(pm, kid, scratch, rec.get("execution"))
        if g:
            rec["dotnet_api_last"] = g
        else:
            rec.pop("dotnet_api_last", None)
    return kid, conv


def counts_contiguous(counts: list) -> bool:
    """One top-to-bottom run: each count is the previous one + 1, from an int start ≥ 1.
    The start is the kernel's: IPython and .NET begin at 1, evcxr at 2 — CoursIA's own
    accepted Sudoku-02-DancingLinks-Rust.ipynb reads [2, 3, 4, …] and its validator only
    demands a non-null count (MGS-25 #27133 was failed on that offset alone)."""
    if not counts:
        return True
    first = counts[0]
    if not isinstance(first, int) or isinstance(first, bool) or first < 1:
        return False
    return counts == list(range(first, first + len(counts)))


def execution_verdict(rec: dict, scratch: Path) -> None:
    """C.2 proof (execution_count contiguous k..k+N-1 over non-empty code cells) + the
    execution verdict. A dead kernel keeps its failure verdict, never overwritten."""
    counts = [c.get("execution_count") for c in _cells(scratch)
              if c.get("cell_type") == "code" and _text(c.get("source")).strip()]
    rec["c2"] = {"counts": counts, "sequential": counts_contiguous(counts)}
    exec_ok = all(e.get("ok") for e in (rec.get("execution") or []))
    if rec.get("verdict") == "kernel-start-failed":
        pass
    elif not exec_ok:
        rec["verdict"] = "built-execution-failed"
    elif not rec.get("execution") or rec["c2"]["sequential"]:
        rec["verdict"] = "built-executed-ok"
    else:
        rec["verdict"] = "built-executed-counts-broken"


def revision_touches_code(built_path: Path, replaced) -> bool:
    """True when the round rewrote at least one CODE cell — the only case whose outputs
    a new execution must produce."""
    cells = _cells(built_path)
    return any(isinstance(i, int) and 0 <= i < len(cells)
               and cells[i].get("cell_type") == "code" for i in replaced)


def kept_outputs_sound(rec: dict, scratch: Path) -> bool:
    """The outputs on disk may stand for the round only when they ARE a complete,
    successful execution of the current code cells: one recorded run per code cell, each
    ok, and no error output anywhere. The records are what makes it sound — a cell that
    raised does not always leave an error output in the file (the papermill session does
    not persist them by default). Anything else, including nothing recorded, is a
    re-execution (fail-closed)."""
    cells = _cells(scratch)
    code_idx = [i for i, c in enumerate(cells) if c.get("cell_type") == "code"]
    runs = rec.get("execution")
    if not isinstance(runs, list) or len(runs) != len(code_idx):
        return False
    recorded = [e.get("cell") if isinstance(e, dict) else None for e in runs]
    if (not all(isinstance(x, int) for x in recorded) or sorted(recorded) != code_idx
            or not all(e.get("ok") for e in runs)):
        return False
    return not any(isinstance(o, dict) and o.get("output_type") == "error"
                   for i in code_idx for o in (cells[i].get("outputs") or []))


def kept_outputs_verdict(rec: dict, scratch: Path) -> None:
    """C.2 proof over the KEPT counts: a markdown-only round executes nothing, so the
    execution that produced these outputs is the previous run's (carried by
    _REVISE_CARRY). The contiguity proof is the one execution_verdict applies to a
    fresh run."""
    counts = [c.get("execution_count") for c in _cells(scratch)
              if c.get("cell_type") == "code" and _text(c.get("source")).strip()]
    rec["c2"] = {"counts": counts, "sequential": counts_contiguous(counts)}
    rec["verdict"] = ("built-executed-ok" if rec["c2"]["sequential"]
                      else "built-executed-counts-broken")


@contextlib.asynccontextmanager
async def mcp_sessions(out_dir: Path):
    """sk-agent + papermill MCP sessions, handshake bounded (the 18/11 wave-1b hang:
    a child blocked in StreamHandler.emit never answered initialize, 2h30 lost)."""
    sk_params = StdioServerParameters(command=str(SK_PY), args=[str(SK_DIR / "sk_agent.py")],
                                      env={**os.environ, "SK_AGENT_CONFIG": str(SK_CONFIG)},
                                      cwd=str(out_dir))
    pm_params = StdioServerParameters(command=str(PM_PY), args=["-u", "-m", "papermill_mcp.main"],
                                      env={**os.environ, "PYTHONUNBUFFERED": "1"},
                                      cwd=str(PM_CWD))
    async with stdio_client(sk_params) as (r1, w1), stdio_client(pm_params) as (r2, w2):
        async with ClientSession(r1, w1) as sk, ClientSession(r2, w2) as pm:
            try:
                await asyncio.wait_for(sk.initialize(), 180.0)
                await asyncio.wait_for(pm.initialize(), 180.0)
            except asyncio.TimeoutError:
                raise RuntimeError("MCP initialize handshake timed out after 180s") from None
            yield sk, pm


# Gates whose failure a builder turn CANNOT repair: metadata is harness-owned (stamped
# from the canon/create_metadata, not from cell sources), so routing them into the
# constructive loop would burn model rounds on an unfixable target (measured 20/11:
# language-info failed with canon None AND built None — nothing a cell edit can do).
_GATE_NON_REPAIRABLE = {"language-info", "kernelspec"}

# Actionable phrasing per measured failing gate (20/11 funnel: machine-path 3,
# svg-display 2, coord-refs 1). Falls back to a generic instruction for new gates.
_GATE_FIX_TEXT = {
    "machine-path": "un chemin local de machine (absolu) figure dans la cellule : remplace-le "
                    "par un chemin relatif au dépôt ou par un littéral de données",
    "svg-display": "la cellule doit AFFICHER une figure vectorielle SVG (sortie réelle), pas "
                   "une image encodée ni un chemin de fichier",
    # 22/11, CoursIA#28104: the former text ("cross-cell references are inconsistent")
    # described another defect; five revision rounds aligned cell numbers and the
    # `lane` word stayed. The gate is COORD_REF_RE: an issue-tracker reference.
    "coord-refs": "la cellule porte une référence de coordination — `EPIC #…`, `see #…`, "
                  "`part of #…` ou le mot `lane` (toute casse) : supprime cette mention ou "
                  "reformule sans elle (« voie », « filière », ou rien) ; aucun numéro "
                  "d'issue dans les cellules. Seule exception : la note de provenance "
                  "`> Carnet issu de l'EPIC #N.`, admise UNIQUEMENT dans la DERNIÈRE cellule "
                  "markdown du carnet — si l'extrait est cette note placée ailleurs, "
                  "retire-la de cette cellule (au besoin, remets-la en fin de la dernière "
                  "cellule markdown)",
    # 22/11, CoursIA#27742: « Les valeurs下列 sont… » survived three rounds told only
    # "fix the cell", with no cell named (the hits carried it, the finding did not).
    "foreign-script": "la cellule contient des caractères d'un autre système d'écriture "
                      "(cyrillique, kana, hangul, idéogrammes CJK) glissés par la génération : "
                      "réécris la phrase de l'extrait en français correct, sans aucun de ces "
                      "caractères ; ne touche pas au reste de la cellule",
    "dead-links": "lien vers un fichier absent du dépôt : pointe un carnet voisin qui EXISTE "
                  "(souvent le jumeau Python ou C# de ce voisin) ou retire le lien — ne "
                  "translittère jamais un suffixe `-Python` en `-Rust`",
    "uncommented-code": "cellule de code longue sans commentaire : reporte les commentaires "
                        "de lecture du jumeau dans la syntaxe du langage cible (`//` en "
                        "Rust/C#) et commente les étapes du calcul (garde du dépôt #26690)",
    # 22/11, CoursIA#27929: "10 cellules sur 24" counted the cases of a matrix; told only to
    # drop the measure, three revisions in a row kept the number and the grain failed.
    "prose-counts": "compteur quantitatif en prose (chiffre suivi de lignes, cellules, modules, "
                    "fichiers, ou une durée ; garde du dépôt #17636). S'il mesure un artefact "
                    "ou une durée, retire la mesure et garde le prédicat — « une solution "
                    "compacte (~80 lignes) » devient « une solution compacte ». S'il compte des "
                    "données du calcul (cases d'une matrice, d'une grille), garde le chiffre et "
                    "change le nom — « 10 cellules sur 24 » devient « 10 cases sur 24 »",
    "unit-result": "la cellule affiche la valeur unité `()` parce qu'elle se termine par un "
                   "bloc (`for`, `while`, `if` ou `{ … }`) sans point-virgule : termine ce "
                   "dernier bloc par `};` — sous evcxr cela supprime la sortie `()` sans "
                   "avertissement ; ne touche pas au reste de la cellule",
    # 26/11, CoursIA batch o41: three twins printed « non attestée », « NON MESURÉ — aucune
    # comparaison exécutée », « non recalculées »; the verifier restated the same major
    # through seven revision rounds told only what was wrong. The remedy is the shape the
    # approved twin of the batch used (reconstructed CPython draws, declared tolerance,
    # « N comparaisons ; écart maximal … »).
    "unmeasured-output": "la cellule déclare qu'une comparaison n'a pas eu lieu (« non "
                         "attesté », « NON MESURÉ », « non recalculées ») : la collection de "
                         "valeurs citées est vide et le test qui la garde n'est jamais pris. "
                         "Refais la comparaison pour de vrai — (a) RECONSTRUIS le "
                         "générateur de la source dans le langage cible "
                         "(`random.Random(graine)` : MT19937, `getrandbits`, rejet jusqu'à un "
                         "indice valide) et compare à tolérance déclarée ; (b) générateur "
                         "non reconstructible à coût raisonnable (PCG64 de NumPy, module "
                         "local) : compare les valeurs que tu recalculeras à celles que la "
                         "source AFFICHE, citées comme telles et NON VIDES, sous tolérance "
                         "déclarée, ou asserte un invariant (régime, ordre, signe). Supprime "
                         "le message « non mesuré » et son garde ; n'affiche jamais une autre "
                         "valeur comme si c'était la même. Un fait réellement hors de portée "
                         "du jumeau (HTTP réel, tokens, durée) se dit dans une cellule "
                         "MARKDOWN, jamais dans la sortie d'une cellule de code",
    "prose-anchor": "la prose (markdown) cite un chiffre que les sorties de CE carnet "
                    "n'affichent pas — souvent recopié du jumeau, dont les mesures "
                    "diffèrent : remplace-le par la valeur imprimée par la cellule de code "
                    "qui précède, ou reformule sans chiffre (« la pente reste proche de "
                    "2 ») ; ne modifie pas le code pour retrouver l'ancien chiffre",
    "rust-conformance": "la sortie de cette cellule Rust doit être le texte EXACT de la "
                        "sortie de la même cellule du jumeau Python (registre "
                        "rust_conformance.d, égalité stricte ; seules les valeurs de durée "
                        "peuvent varier) : aligne les `println!` (libellés, ordre, "
                        "formatage des nombres et des booléens) sur le jumeau, sans rien "
                        "imprimer de plus",
}


# Gates whose detail carries {"cell", "excerpt"} hits that are safe to quote back to the
# model (never `secrets`: its detail holds indices only, and must stay that way).
_GATE_EXCERPT_GATES = {"coord-refs", "foreign-script"}


def gate_repair_findings(rec: dict) -> list[dict]:
    """Synthesize verifier-shaped findings from the failing gates, so the EXISTING
    constructive loop can repair a gates-failed build instead of dying terminal.
    Measured 20/11: gates-failed killed ~8 grains with no retry path at all — the
    revise loop only triggered on a verify-reject."""
    out: list[dict] = []
    for g in rec.get("gates") or []:
        if g.get("ok") or g.get("gate") in _GATE_NON_REPAIRABLE:
            continue
        entries = (g.get("detail") or {}).get("findings") \
            if isinstance(g.get("detail"), dict) else None
        if entries:
            # repo guards (21/11) name one defect per cell: one finding each, so the round
            # sees every cell to fix and not the first one only
            fix = _GATE_FIX_TEXT.get(g.get("gate"), "corrige la cellule pour satisfaire la porte")
            for e in entries:
                out.append({"cell": e.get("cell"), "severity": "major",
                            "detail": f"porte {g.get('gate')} en échec — {fix} ; {e.get('text')}"})
            continue
        hits = (g.get("detail") or {}).get("hits") \
            if isinstance(g.get("detail"), dict) and g.get("gate") in _GATE_EXCERPT_GATES else None
        if hits:
            # one finding per offending cell, WITH the offending excerpt (#28104/#27742)
            fix = _GATE_FIX_TEXT[g["gate"]]
            for h in hits:
                if isinstance(h, dict):
                    out.append({"cell": h.get("cell"), "severity": "major",
                                "detail": f"porte {g['gate']} en échec — {fix} ; extrait "
                                          f"fautif : « {str(h.get('excerpt') or '').strip()} »"})
            continue
        detail = g.get("detail") if isinstance(g.get("detail"), (str, int, float)) else json.dumps(
            g.get("detail") or {}, ensure_ascii=False)
        cells = (g.get("detail") or {}).get("cells") if isinstance(g.get("detail"), dict) else None
        out.append({"cell": (cells or [None])[0], "severity": "major",
                    "detail": f"porte {g.get('gate')} en échec — "
                              f"{_GATE_FIX_TEXT.get(g.get('gate'), 'corrige la cellule pour satisfaire la porte')}"
                              f" ; détail porte : {detail}"})
    return out


# Execution-repair findings (21/11, po-2028 report): a cut per finding and a cap on how
# many root failures are detailed; the reviser also sees every real output in the view.
EXEC_FINDING_CAP = 1200
EXEC_CASCADE_EXCERPT = 300
EXEC_FINDINGS_MAX = 12


def exec_repair_findings(rec: dict, built_path: Path) -> list[dict]:
    """Verifier-shaped findings from the cells that STILL fail after the kernel-repair
    rounds, so a built-execution-failed grain gets the constructive loop instead of dying.

    Measured 21/11 (Swift conveyor, 46 launches): built-execution-failed was the dominant
    class (18) and terminal (`revisions: []`) — the repair rounds work inside the build
    conversation, the constructive loop (fresh conversation, whole notebook with real
    outputs) never ran on it. A cell that fails only because an earlier failing cell
    defines what it uses is named as a cascade of that root, with a short excerpt, so the
    round fixes the root first. Roots beyond EXEC_FINDINGS_MAX are listed, never dropped
    silently."""
    failing = [e for e in rec.get("execution") or [] if isinstance(e, dict) and not e.get("ok")]
    if not failing:
        return []
    try:
        cells = _cells(built_path)
    except (OSError, ValueError):
        cells = []
    detail = []
    for e in failing:
        i = e.get("cell")
        cell = cells[i] if isinstance(i, int) and 0 <= i < len(cells) else {}
        raw = _outputs_text(cell) if cell else ""
        digest = error_digest(cell, raw, cap=EXEC_FINDING_CAP) if raw.strip() else ""
        detail.append({"idx": i, "status": e.get("status"), "_raw_errors": raw,
                       "errors": digest or str(e.get("error") or "")})
    roots = cascade_roots(cells, [d for d in detail if isinstance(d["idx"], int)]) if cells else {}
    out: list[dict] = []
    skipped: list = []
    for d in detail:
        r = roots.get(d["idx"])
        if r:
            text = (f"échoue par CASCADE de la cellule {', '.join(map(str, r))} (un nom ou une "
                    f"crate qu'elle devait définir) : corrige d'abord la racine ; extrait : "
                    f"{d['errors'][:EXEC_CASCADE_EXCERPT]}")
        elif sum(1 for f in out if "CASCADE" not in f["detail"]) >= EXEC_FINDINGS_MAX:
            skipped.append(d["idx"])
            continue
        else:
            status = (f"(statut {d['status']}) "
                      if d["status"] not in (None, "ok", "error") else "")
            text = (f"échec d'EXÉCUTION réel du noyau {status}après les tours de réparation — "
                    f"{d['errors'] or 'aucune sortie d erreur persistée'}")
        out.append({"cell": d["idx"], "severity": "major", "detail": text})
    if skipped:
        out.append({"cell": None, "severity": "major",
                    "detail": f"{len(skipped)} autres cellules en échec non détaillées ici "
                              f"(voir leurs sorties réelles dans le carnet) : {skipped}"})
    return out


def gates_then_verify(args, rec: dict, src_nb: Path, built_path: Path, create_mode: bool,
                      kname: str, wt_path: Path, out_dir: Path,
                      prior: dict | None = None, spec_body: str | None = None,
                      spec_ref: str | None = None) -> None:
    """Stages 3-4, harness-only (no model turn inside). .NET post-execution hygiene runs
    BEFORE anything reads the file: gates and verify judge the DELIVERED state.
    `spec_body`/`spec_ref` carry the lot spec's issue body to the rust-conformance
    gate (its `## Tolerances` table downgrades the strict rule per cell)."""
    if args.max_stage >= 3 and rec.get("verdict") == "built-executed-ok" and built_path.is_file():
        if kname.startswith(".net"):
            rec["banner_strip"] = strip_dotnet_banner(
                wt_path / "scripts" / "notebook_tools" / "strip_probe_banner.py", built_path)
        rec["ext_banner_strip"] = strip_kernel_extension_banner(built_path)
        rel = _norm_rel(getattr(args, "notebook", None) or "")
        if create_mode and rel:
            rec["link_fix"] = resolve_dead_links(built_path, src_nb, wt_path, rel)
            align = align_kernelspec(built_path, wt_path, rel, kname)
            if align:
                rec["kernelspec_align"] = align
                rec.setdefault("create_metadata", {}).update(
                    {"kernelspec": align["to"], "language_version": align["language_version"]})
        tg = time.time()
        rec["gates"] = run_gates(src_nb, built_path, create_mode=create_mode,
                                 canon_version=(rec.get("create_metadata") or {})
                                 .get("language_version"),
                                 repo=wt_path, rel=_norm_rel(getattr(args, "notebook", None) or ""),
                                 scratch=out_dir, spec_body=spec_body, spec_ref=spec_ref,
                                 kernel_name=kname)
        rec["gates_s"] = round(time.time() - tg, 1)
        bad = [g["gate"] for g in rec["gates"] if not g.get("ok")]
        note_content_verdict(rec, "gates-ok" if not bad else f"gates-failed:{','.join(bad)}")
    if args.max_stage >= 4 and rec.get("verdict") == "gates-ok":
        stage4_verify(args, rec, src_nb, built_path, out_dir, prior=prior)
    # A gate failure is actionable by the builder (a cell to rewrite), and until now it
    # was TERMINAL — the constructive loop only ever ran on a verify-reject. Route the
    # failing gates through that same loop by seeding verifier-shaped findings; the
    # honest verdict comes back from the re-run gates below inside the loop. Rounds and
    # the stage guard stay those of the review loop (no second budget to reason about).
    if (str(rec.get("verdict") or "").startswith("gates-failed")
            and getattr(args, "revise_rounds", 0) > 0 and args.max_stage >= 4):
        findings = gate_repair_findings(rec)
        if findings:
            rec["gate_repair"] = {"from": rec["verdict"], "findings": len(findings)}
            rec["verify"] = {"verdict": "gate-reject", "findings": findings, "source": "gates"}
            rec["verdict"] = "verify-reject"
    # Same route for an execution that still fails after the kernel-repair rounds (21/11,
    # po-2028 report: built-execution-failed was terminal, `revisions: []`). Inside the
    # loop a revised draft that fails again is re-seeded from ITS errors, so each round
    # answers the current failures, not the first ones.
    if (rec.get("verdict") == "built-execution-failed"
            and getattr(args, "revise_rounds", 0) > 0 and args.max_stage >= 4
            and built_path.is_file()):
        findings = exec_repair_findings(rec, built_path)
        if findings:
            er = rec.setdefault("exec_repair", {"from": "built-execution-failed", "seeded": 0})
            er["seeded"] = er.get("seeded", 0) + 1
            er["findings"] = len(findings)
            rec["verify"] = {"verdict": "exec-reject", "findings": findings,
                             "source": "execution"}
            rec["verdict"] = "verify-reject"


async def revision_dotnet_api(pm, rec: dict, kname: str, exec_dir: Path, built_path: Path,
                              entry: dict) -> str:
    """The .NET API block for an exec-reject revision round: the one the last repair
    rounds probed when it covers the cells failing NOW, else a probe on a kernel started
    for it alone (a --revise-from resume: the build's kernel died with its process).
    Recorded on the revision entry; "" when nothing applies. Never raises."""
    now = [e.get("cell") for e in rec.get("execution") or []
           if isinstance(e, dict) and not e.get("ok")]
    g = rec.get("dotnet_api_last")
    if not g or g.get("cells") != now:
        g, pkid = None, None
        try:
            pkid = await start_kernel(pm, kname, exec_dir)
            if pkid:
                g = await dotnet_ground_execution(pm, pkid, built_path, rec.get("execution"),
                                                  fresh=True)
        except Exception as ex:  # grounding is an aid: never fail the round on it
            g = {"cells": now, "block": "",
                 "info": {"kind": "dotnet", "error": f"{type(ex).__name__}: {ex}"[:300]}}
        finally:
            if pkid:
                await pm_call(pm, "manage_kernel", {"action": "stop", "kernel_id": pkid})
        if g:
            g["info"] = {**(g.get("info") or {}), "fresh": True}
            rec["dotnet_api_last"] = g
    if g:
        entry["dotnet_api"] = g.get("info")
    return (g or {}).get("block") or ""


def _cell_ids(items) -> set:
    return {i.get("cell") for i in (items or []) if isinstance(i, dict)
            and isinstance(i.get("cell"), int)}


def contest_maintained(contested, findings) -> bool:
    """Whether a verifier that re-judged an UNCHANGED draft still rejects on a cell the
    builder CONTESTED. Read only by the stop rule of a contested-only round: a maintained
    contest is final for the invocation (looping would ask the builder the same question
    again, CoursIA#27288), while a reject whose contested cells were all LIFTED rests on
    findings the builder has never seen and must be handed over. Measured fournée o20,
    CoursIA#27742 (23/11): the builder contested cell 2; the verifier, reading the module
    sources for the first time, lifted cell 2 and rejected on cell 10 instead — the old
    rule stopped there and the new finding never reached the builder. No usable cell on
    the contested side is NOT a proven lift: the reject stands (stop)."""
    cells = _cell_ids(contested)
    return not cells or bool(cells & _cell_ids(findings))


async def revise_loop(args, rec: dict, *, issue: dict, src_nb: Path, built_path: Path,
                      kname: str, exec_dir: Path, conventions: str, create_mode: bool,
                      wt_path: Path, out_dir: Path) -> None:
    """Constructive-review loop (20/11, IT08 #27460). Up to --revise-rounds rounds while the
    independent verifier rejects WITH findings: the findings go to the builder agent in a
    FRESH self-contained conversation (spec + whole notebook with real outputs + findings);
    the harness applies the rewritten cells (no structural change), re-executes the WHOLE
    notebook in a fresh kernel with the kernel-error repair rounds, re-runs the gates and
    the verifier, which sees its previous findings and the builder's addressed/contested
    answer. Every rejected draft is kept next to the deliverable (`.r<k>` copy)."""
    if getattr(args, "revise_rounds", 0) <= 0 or args.max_stage < 4:
        return
    revisions = rec.setdefault("revisions", [])
    first = len(revisions)
    budget = args.revise_rounds
    extend = max(0, int(getattr(args, "revise_extend", REVISE_EXTEND_DEFAULT) or 0))
    cap = budget + extend
    done = 0
    while done < budget:
        rnd = first + done
        if rec.get("verdict") != "verify-reject":
            break
        if midrun_claim_abort(args, rec, f"revise+{rnd}"):
            break
        findings = [f for f in (rec.get("verify") or {}).get("findings") or []
                    if isinstance(f, dict)]
        source_in = (rec.get("verify") or {}).get("source")
        entry: dict = {"round": rnd, "started": utcnow(), "findings_in": len(findings),
                       "majors_in": sum(1 for f in findings if f.get("severity") == "major")}
        revisions.append(entry)
        if not findings:
            entry["result"] = "no-findings"          # nothing actionable: the reject stands
            break
        backup = built_path.with_name(f"{built_path.stem}.r{rnd}{built_path.suffix}")
        shutil.copy2(built_path, backup)
        entry["draft_backup"] = str(backup)
        t0 = time.time()
        applied = False
        contested_only = False
        async with mcp_sessions(out_dir) as (sk, pm):
            api_block = ""
            if source_in == "execution" and kname.startswith(".net"):
                api_block = await revision_dotnet_api(pm, rec, kname, exec_dir, built_path,
                                                      entry)
            env = await sk_call_retry(
                sk, args, rec, f"6-revise+{rnd}",
                revision_prompt(issue, revision_view(built_path, cited=cited_cells(findings)),
                                findings, conventions,
                                spec=bool(getattr(args, "from_spec", False)),
                                twin_view=(twin_reference_view(src_nb)
                                           if src_nb and Path(src_nb) != Path(built_path)
                                           else ""),
                                api_block=api_block,
                                modules=(local_modules(src_nb)
                                         if src_nb and Path(src_nb) != Path(built_path)
                                         else None)),
                None, max_tokens=BUILD_MAX_TOKENS)
            entry["conversation_id"] = env.get("conversation_id")
            part, env = await parse_or_repair(sk, args, rec, f"6-revise+{rnd}", env, None,
                                              max_tokens=BUILD_MAX_TOKENS)
            if not part:
                entry["result"] = (gate_refusal(env) or call_failure(env) or "unparsed")
                entry["raw_tail"] = (env.get("response") or "")[-1500:]
                refusal = defer_refusal(env)
                if refusal:
                    # scheduler defer contract: the round was never held, so the reject it
                    # would have answered is not this run's last word either. Measured 23/11
                    # 00:08Z (CoursIA#28069, batch s6r): an execution the builder had to
                    # answer, and the revise call met the five-hour wall — left on its
                    # reject the grain was failed and [RELEASED], a three-day fleet-wide
                    # lock for a repair the provider refused to hear. The reject is kept in
                    # last_content_verdict for a --revise-from resume; the entry keeps
                    # naming the cause.
                    rec["last_content_verdict"] = rec["verdict"]
                    rec["verdict"] = refusal
            elif not part.get("cells") and part.get("contested"):
                # A valid, cell-free answer is the documented contest path, not a malformed
                # reply. CoursIA#27288 (23/11, o1/Terra): the builder correctly explained
                # that the twin's gitignored Ciqual/RecipeML corpora were absent; the old
                # branch discarded that reply as "unparsed". No cell changed, so the draft
                # needs neither a new kernel nor the gates. The independent verifier sees
                # the contest, and a maintained reject stops this invocation.
                entry["apply"] = {"replaced": [], "unknown_idx": [], "bad": [],
                                  "type_changed": []}
                entry["addressed"] = part.get("addressed") or []
                entry["contested"] = part.get("contested")
                entry["result"] = "contested-only"
            else:
                rep = apply_revision(built_path, part)
                entry["apply"] = rep
                entry["addressed"] = part.get("addressed") or []
                entry["contested"] = part.get("contested") or []
                if not rep["replaced"]:
                    entry["result"] = "nothing-applied"
                else:
                    applied = True
                    normalize_sources(built_path)
                    rec["verdict"] = "revising"
                    if (not revision_touches_code(built_path, rep["replaced"])
                            and kept_outputs_sound(rec, built_path)):
                        # A round that rewrote only markdown changed nothing the notebook
                        # computes: the outputs on disk are still the ones the previous
                        # execution produced, and they are what the verifier compares the
                        # text with. Re-executing here only redrew the measured durations,
                        # so every value the reviser had just quoted from the displayed
                        # outputs was stale before the verifier read it (CoursIA#28944,
                        # 28/11: the verifier cited 1 403 ms as the committed output, the
                        # reviser computed the ratio it asked for from that value, and the
                        # post-edit re-execution committed 1 366 ms — rejected as stale).
                        entry["exec_skipped"] = "markdown-only"
                        kept_outputs_verdict(rec, built_path)
                    else:
                        kid = await start_kernel(pm, kname, exec_dir)
                        rec["kernel_id"] = kid
                        if kid is None:
                            rec["verdict"] = "kernel-start-failed"
                        else:
                            code_idx = [i for i, c in enumerate(_cells(built_path))
                                        if c.get("cell_type") == "code"]
                            rec["execution"] = await execute_cells(pm, built_path, kid, code_idx)
                            if code_idx and rec.get("execution") and args.repair_rounds > 0:
                                await repair_kernel_errors(
                                    sk, pm, args, rec, built_path, kname, exec_dir, kid, code_idx,
                                    entry["conversation_id"], conventions,
                                    stage=f"6-revise+{rnd}-repair")
                        if rec.get("kernel_id"):
                            rec["kernel_stop"] = await pm_call(
                                pm, "manage_kernel", {"action": "stop",
                                                      "kernel_id": rec["kernel_id"]})
                        execution_verdict(rec, built_path)
                        note_execution_kernel(rec, kname)
        entry["elapsed_build_s"] = round(time.time() - t0, 1)
        contested_only = entry.get("result") == "contested-only"
        if not applied and not contested_only:
            break                       # the draft is untouched; verdict stays verify-reject
        if contested_only:
            # No cell changed: re-execution and gates would only rewrite the artifact
            # that was just judged. Re-enter ONLY the independent verification stage,
            # with the builder's contest attached as the claims to counter-check.
            rec["verdict"] = "gates-ok"
        entry["exec_verdict"] = "contested-only" if contested_only else rec["verdict"]
        prior = {"round": rnd, "findings": findings, "addressed": entry.get("addressed"),
                 "contested": entry.get("contested")}
        gates_then_verify(args, rec, src_nb, built_path, create_mode, kname, wt_path, out_dir,
                          prior=prior, spec_body=issue.get("body"),
                          spec_ref=_spec_ref(args, issue))
        entry["result"] = rec["verdict"]
        if str(rec["verdict"]).startswith("verify-"):
            out = [f for f in (rec.get("verify") or {}).get("findings") or []
                   if isinstance(f, dict)]
            entry["findings_out"] = len(out)
            entry["majors_out"] = sum(1 for f in out if f.get("severity") == "major")
        entry["elapsed_s"] = round(time.time() - t0, 1)
        done += 1
        if contested_only:
            # The unchanged draft was independently judged once more. A reject that still
            # stands on a cell the builder CONTESTED is final for this invocation: looping
            # would ask it to contest the same finding again (CoursIA#27288), and a resumed
            # invocation may add missing data or a new strategy before paying another
            # revision. A reject whose contested cells were all LIFTED is another matter:
            # it rests on findings the builder has never seen, and the loop goes on to hand
            # them over (fournée o20, CoursIA#27742 — contest_maintained).
            out = [f for f in (rec.get("verify") or {}).get("findings") or []
                   if isinstance(f, dict)]
            if (not str(rec.get("verdict") or "").startswith("verify-") or not out):
                break               # not re-judged, or nothing actionable: as before
            entry["contest"] = ("maintained" if contest_maintained(entry.get("contested"), out)
                                else "lifted")
            if entry["contest"] == "maintained":
                break
        if (rec.get("verdict") == "verify-reject"
                and revise_round_extends(done, budget, cap, source_in,
                                         (rec.get("verify") or {}).get("source"),
                                         entry["majors_in"], entry.get("majors_out"))):
            budget += 1
            entry["extended"] = {"budget": budget, "cap": cap}
    # Gate-repair exhaustion: the seeded verdict must not survive as a verify-reject — a
    # gate failure that survived its repair rounds is reported as what it is (and a
    # later --revise-from refuses it for the right reason). A REAL verify that ran after
    # the gates were fixed overwrote verify.source, so this only touches the never-fixed
    # case. Execution repair follows the same rule (verify.source "execution"); a kernel
    # that died during a round keeps its own verdict instead of being masked.
    # A deferral (capacity gate, provider 429) met during a round is the run's verdict too:
    # the scheduler defers, and the repair is had when the refusal lifts, instead of the
    # grain being released on a repair nobody could attempt (CoursIA#28069, 23/11 00:08Z).
    src = (rec.get("verify") or {}).get("source")
    if (src in ("gates", "execution")
            and not str(rec.get("verdict") or "").startswith(("verify-approved",
                                                               MIDRUN_REFUSED))
            and not str(rec.get("verdict") or "").startswith("deferred-by-")
            and rec.get("verdict") != "kernel-start-failed"):
        origin = rec.get("gate_repair" if src == "gates" else "exec_repair") or {}
        rec["verdict"] = origin.get("from") or rec["verdict"]


def _prior_src_nb(prior: dict, wt_path: Path, notebook: str) -> Path:
    if prior.get("src_nb"):
        return Path(prior["src_nb"])
    cm = prior.get("create_mode") or {}
    if cm.get("spec_twin"):
        return Path(cm["spec_twin"])
    if cm.get("source"):
        return wt_path / cm["source"]
    return wt_path / notebook


# Keys a revised trace inherits so that it can itself be revised again (--revise-from chains)
# and so that stage 5 composes the same PR body as an uninterrupted run.
_REVISE_CARRY = ("plan", "kernel", "kernel_cwd", "create_mode", "create_metadata", "src_nb",
                 "built_notebook", "conversation_id", "execution", "c2", "gates", "structure",
                 "verify", "revisions", "exec_mode", "repo_origin", "last_content_verdict",
                 "executed_kernel", "kernelspec_align")

# Stage 5 refused to DELIVER an approved build. The content was judged; only the delivery
# gestures are worth retrying -- on the build as it is.
PR_REFUSED_VERDICTS = ("source-drifted:", "pr-branch-failed", "pr-git-failed",
                       "pr-push-failed", "pr-repo-unresolved", "pr-create-failed",
                       "pr-rebase-failed")


def approved_build_state(prior: dict, built: Path, out_dir: Path, issue) -> dict:
    """Is the build on disk the one the verifier approved? (stage-5-only resume, 23/11)

    ``changed`` False only on a measured proof. A trace written since 23/11 binds the
    approval to the build's sha256 (and a graft binds its own: the approved cells plus
    the markdown the source gained). An older trace is held to its last verify record:
    the build must not have been written after that verification finished. No record,
    no proof. Fail-closed before anything is pushed."""
    out: dict = {"changed": True}
    try:
        digest = hashlib.sha256(built.read_bytes()).hexdigest()
    except OSError as e:
        return out | {"why": f"build unreadable: {e}"[:160]}
    out["sha256"] = digest[:16]
    bound = {(prior.get("verify") or {}).get("built_sha256"),
             ((prior.get("pr") or {}).get("graft") or {}).get("sha256")} - {None}
    if bound:
        return out | {"by": "sha256", "changed": digest not in bound}
    try:
        last = json.loads((out_dir / f"verify-{issue}.json").read_text(encoding="utf-8"))
        t = datetime.fromisoformat(str(last["finished"]).replace("Z", "+00:00"))
    except (OSError, ValueError, KeyError, TypeError):
        return out | {"why": "no verify record to hold the build to"}
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    mtime = datetime.fromtimestamp(built.stat().st_mtime, timezone.utc)
    return out | {"by": "mtime-vs-last-verify", "changed": mtime > t,
                  "built_mtime": mtime.isoformat(timespec="seconds"),
                  "verify_finished": t.isoformat(timespec="seconds")}


async def run_revision(args, rec: dict) -> dict:
    """--revise-from <issue-N.json> / --verify-from <issue-N.json>: resume a grain without
    re-paying plan and build (IT08 #27460: 22.9 min and 4 calls already spent). Fail-closed
    before any spend: same issue + notebook, the expected prior verdict (verify-reject for
    a revise, verify-error for a crash recovery), a successful reservation in the
    trace re-read NOW by the scoped claim guard (no new [CLAIMED] comment), and the
    worktree, source/twin and built notebook still on disk."""
    # Two resume modes on the same fail-closed skeleton:
    #   --revise-from : the verifier DELIVERED a verdict — reject with findings to answer;
    #   --verify-from : the verifier CRASHED (instrument failure, e.g. the GitHub REST
    #                   bucket exhausted mid-run on 20/11) — a build already paid for is
    #                   re-gated and re-verified instead of being thrown away.
    resume_from = getattr(args, "verify_from", None)
    gate_resume = None              # set when the trace is a repairable gates failure
    exec_resume = None              # set when the trace is a repairable execution failure
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    trace_p = Path(resume_from or args.revise_from)
    if not trace_p.is_file():
        rec["verdict"] = f"refused-revise-trace-missing:{trace_p}"
        return rec
    prior = json.loads(trace_p.read_text(encoding="utf-8"))
    rec["revised_from"] = {"trace": str(trace_p), "verdict": prior.get("verdict"),
                           "started": prior.get("started"),
                           "mode": "verify" if resume_from else "revise"}
    if (prior.get("issue") != args.issue
            or _norm_rel(prior.get("notebook") or "") != _norm_rel(args.notebook)):
        rec["verdict"] = "refused-revise-trace-mismatch"
        return rec
    late_refused = False
    # A refusal/error may have OVERWRITTEN the top-level verdict after the real judgment
    # (23/11: verify-error from a dead token, refused-claim-check-not-scoped from the same).
    # The content field, when present, is what this gate decides on; old traces fall back
    # to the top-level verdict unchanged.
    content_prior = prior.get("last_content_verdict") or prior.get("verdict")
    stage5_only = False
    if resume_from:
        # a late-claim refusal is resumable once the holder RELEASED the notebook: the
        # build was approved and only the reservation failed (21/11, #27851). The live
        # scoped claim re-read below refuses again while another lane still holds it.
        late_refused = (str(prior.get("verdict") or "").startswith(LATE_CLAIM_REFUSED)
                        and (prior.get("verify") or {}).get("verdict") == "approve")
        # 23/11 (#28209): stage 5 refused to DELIVER an approved build (a source drift
        # made of one markdown cell). The build on disk is the one the verifier
        # approved: stage 5 is re-run on it as it is -- no gate, no verify, no model turn.
        stage5_only = (str(prior.get("verdict") or "").startswith(PR_REFUSED_VERDICTS)
                       and content_prior == "verify-approved"
                       and (prior.get("verify") or {}).get("verdict") == "approve")
        if prior.get("verdict") != "verify-error" and not late_refused and not stage5_only:
            rec["verdict"] = f"refused-verify-not-crashed:{prior.get('verdict')}"
            return rec
    elif content_prior != "verify-reject":
        # gates-failed:<gates> is resumable too (20/11: w2u lost 2 grains to it one
        # base BEFORE gate-repair landed): the trace carries the failing gates and the
        # build on disk — repair findings are synthesized from the gates exactly like
        # the in-run path, and the paid build is re-used instead of rebuilt.
        gate_resume = None
        if str(content_prior or "").startswith("gates-failed"):
            gate_resume = gate_repair_findings({"gates": prior.get("gates") or []})
            if not gate_resume:
                rec["verdict"] = f"refused-gate-repair-unrepairable:{content_prior}"
                return rec
        elif content_prior == "built-execution-failed":
            # the build on disk carries its persisted error outputs: findings come from
            # them, the paid build is repaired instead of rebuilt (a missing build is
            # refused below by the on-disk checks, before any spend)
            built_p = Path((prior.get("built_notebook") or {}).get("path") or "")
            if built_p.is_file():
                exec_resume = exec_repair_findings({"execution": prior.get("execution") or []},
                                                   built_p)
                if not exec_resume:
                    rec["verdict"] = "refused-exec-repair-unrepairable:built-execution-failed"
                    return rec
        else:
            rec["verdict"] = f"refused-revise-not-rejected:{content_prior}"
            return rec
    prior_cr = (prior.get("stages") or {}).get("claim_reservation")
    live_cr = None
    if prior_cr and prior_cr.get("verdict") is None and prior_cr.get("deferred") == "late":
        # --claim-late trace: that run reserved NOTHING, so the trace attests no claim.
        # Re-read the LIVE scoped claim before any spend (another lane may have taken
        # the notebook since); the reservation itself stays deferred -- the carried
        # stage below makes late_reservation() take it right before stage 5.
        live = check_claim(Path(args.repo), args.issue, args.lane, _norm_rel(args.notebook))
        live_v = claim_verdict(live)
        if live_v is not None:
            rec["stages"]["claim_reservation"] = {**prior_cr, "live_recheck": live_v}
            rec["verdict"] = f"refused-revise-no-reservation:{live_v}"
            return rec
    elif prior_cr and prior_cr.get("verdict") is None:
        # A reservation attested in an OLD trace is not a reservation held NOW. Measured
        # 24/11 (salvage o33): the paid trace of #28082 carried a claim_reservation with
        # verdict None, and run_revision() admitted the resume on it -- while the grain had
        # been [RELEASED] on 24/11 00:06Z. The grain would have been built unreserved, and
        # under CoursIA's RELACHEE rule a recent [RELEASED] (< RELACHE_J days) disqualifies
        # re-claiming, so the reservation could not have been taken again either. Re-read
        # the LIVE scoped claim exactly like the no-attestation branch below: still ours,
        # admitted; released or held elsewhere, refused with the guard's own code.
        live = check_claim(Path(args.repo), args.issue, args.lane, _norm_rel(args.notebook))
        live_v = claim_verdict(live)
        if live_v is not None:
            rec["stages"]["claim_reservation"] = {**prior_cr, "live_recheck": live_v}
            rec["verdict"] = f"refused-revise-no-reservation:{live_v}"
            return rec
    elif prior_cr:
        rec["verdict"] = "refused-revise-no-reservation"
        return rec
    else:
        # No attestation in the trace (pre-#466-era drivers, w1* runs 18-19/11 carry
        # no claim_reservation stage): fail-closed fallback — re-read the LIVE scoped
        # claim. Admitted only if our lane still holds the claim on this path; no new
        # [CLAIMED] comment is posted either way.
        live = check_claim(Path(args.repo), args.issue, args.lane, _norm_rel(args.notebook))
        live_v = claim_verdict(live)
        live_cr = {"verdict": live_v, "live_recheck": True}
        if live_v is not None:
            rec["stages"]["claim_reservation"] = live_cr
            rec["verdict"] = f"refused-revise-no-reservation:{live_v}"
            return rec
    for k in _REVISE_CARRY:
        if k in prior:
            rec[k] = prior[k]
    if gate_resume:
        # AFTER the carry: a trace-carried "verify" (meaningless — stage 4 never ran
        # on a gates-failed grain) must not clobber the synthesized repair findings.
        rec["gate_repair"] = {"from": prior.get("verdict"), "findings": len(gate_resume),
                              "resumed": True}
        rec["verify"] = {"verdict": "gate-reject", "findings": gate_resume,
                         "source": "gates"}
    if exec_resume:
        rec["exec_repair"] = {"from": "built-execution-failed", "findings": len(exec_resume),
                              "seeded": 1, "resumed": True}
        rec["verify"] = {"verdict": "exec-reject", "findings": exec_resume,
                         "source": "execution"}
    rec["stages"]["worktree"] = (prior.get("stages") or {}).get("worktree")
    rec["stages"]["claim_reservation"] = live_cr or (prior.get("stages") or {}).get("claim_reservation")
    wt_path = Path(((prior.get("stages") or {}).get("worktree") or {}).get("path") or "")
    built = Path((prior.get("built_notebook") or {}).get("path") or "")
    if str(wt_path) and wt_path != Path("") and not wt_path.exists() and built.is_file():
        rec["stages"]["worktree_restored"] = restore_worktree(
            Path(args.repo), wt_path,
            ((prior.get("stages") or {}).get("worktree") or {}).get("head"))
    src_nb = _prior_src_nb(prior, wt_path, args.notebook)
    exec_dir = Path(prior.get("kernel_cwd") or "")
    for label, p in (("worktree", wt_path), ("built", built), ("source", src_nb),
                     *(() if stage5_only else (("kernel-cwd", exec_dir),))):
        if not str(p) or not p.exists():
            rec["verdict"] = f"refused-revise-{label}-missing:{p}"
            return rec
    repo = Path(args.repo)
    origin = subprocess.run(["git", "-C", str(repo), "remote", "get-url", "origin"],
                            capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()
    if "jsboige/CoursIA" not in origin and not args.allow_foreign_origin:
        rec["verdict"] = f"refused-foreign-origin:{origin or 'no-origin'}"
        return rec
    token = refresh_gh_token(repo)
    if not token and (os.environ.get("NBCODER_GH_APP_ID") or os.environ.get("NBCODER_GH_KEY")):
        # spending under dead credentials cost two waves of poisoned traces on 23/11
        rec["verdict"] = "refused-gh-token-refresh"
        return rec
    rec["stages"]["claim_check"] = check_claim(repo, args.issue, args.lane,
                                               _norm_rel(args.notebook))
    refused = claim_verdict(rec["stages"]["claim_check"])
    if refused:
        rec["verdict"] = refused
        return rec
    issue = fetch_issue("jsboige/CoursIA", args.issue, token, _norm_rel(args.notebook))
    if (issue.get("spec_comment") or {}).get("status") == "none-for-target":
        rec["verdict"] = "refused-no-spec-for-target"
        return rec
    conventions = read_conventions(args.conventions)
    gate = gate_call(args.gate_mode, getattr(args, "gate", None))
    rec["gate"] = gate
    if gate["blocking_refusal"]:
        rec["verdict"] = "deferred-by-capacity-gate"
        return rec
    create_mode = bool(prior.get("create_mode"))
    args.from_spec = bool((prior.get("create_mode") or {}).get("spec_twin"))
    # A creation's trace may record the --meta-from kernel while --kernel-override executed
    # it (#27996: trace `.net-csharp`, outputs from `rust`) — the target's language tag
    # outranks the recorded name, or the resume would re-execute Rust cells on .NET.
    tgt = (getattr(args, "notebook", None)
           or (prior.get("create_mode") or {}).get("target") or "")
    kname = (args.kernel_override or (tag_kernel(tgt) if create_mode else None)
             or (prior.get("kernel") or {}).get("kernel_name") or "")
    if stage5_only:
        # Only a build PROVEN untouched since its approval is delivered; the worktree is
        # the one the run recorded (restored above at its head when the scheduler had
        # released it), so stage 5 measures the drift against the build's own base.
        state = approved_build_state(prior, built, out_dir, args.issue)
        # The source as the previous attempt measured it, when the build it delivered
        # from is aligned with it (no drift, markdown-only drift, or a graft that
        # succeeded): a cell the source gained SINCE is grafted onto the grafted build.
        # A build the previous attempt could not align (graft refused, structure/code
        # drift) is measured from its own base again.
        prev_pr = prior.get("pr") if isinstance(prior.get("pr"), dict) else {}
        prev_drift, prev_graft = prev_pr.get("source_drift") or {}, prev_pr.get("graft") or {}
        aligned = (prev_drift.get("drift") in ("none", "markdown-only")
                   or (prev_drift.get("drift") == "markdown-added" and prev_graft.get("ok")))
        rec["stages"]["pr_resume"] = {
            "from": prior.get("verdict"), "build": state,
            "main_blob": prev_drift.get("main_blob")
            if aligned and prev_drift.get("main_blob") else None,
            # The commit the previous attempt pushed before dying at `gh pr create`: the
            # stage-5 push may replace exactly that one, under lease (#1885). Absent from an
            # older trace -> no lease -> a same-named branch is refused, never force-replaced.
            "pushed_sha": (prev_pr.get("head_sha") or None)
            if prior.get("verdict") == "pr-create-failed" else None}
        rec["revised_from"]["mode"] = "pr"
        if state["changed"]:
            rec["verdict"] = ("refused-pr-resume-build-changed:"
                              f"{state.get('by') or state.get('why') or 'unproven'}")
            return rec
        note_content_verdict(rec, "verify-approved")
        if args.max_stage >= 5 and late_reservation(args, rec):
            stage5_pr(args, rec, wt_path, built, issue, token)
        rec["finished"] = utcnow()
        return rec
    if resume_from:
        # verify-error is NOT a verdict: the verifier process crashed on an instrument
        # failure (20/11: the shared GitHub REST bucket ran out mid-run), so the build was
        # executed and the gates passed before stage 4 died. Re-gate and re-verify the SAME
        # on-disk build — zero model turn — then let the normal loop take over (a reject
        # gets its constructive rounds; an approval opens the PR).
        rec["verdict"] = "built-executed-ok"
        gates_then_verify(args, rec, src_nb, built, create_mode, kname, wt_path, out_dir,
                          spec_body=issue.get("body"), spec_ref=_spec_ref(args, issue))
    else:
        # a seeded gate repair enters the loop as a reject; the exhaustion-restore
        # inside revise_loop brings the honest gates-failed verdict back if the
        # repair never succeeds
        rec["verdict"] = "verify-reject"
    await revise_loop(args, rec, issue=issue, src_nb=src_nb, built_path=built, kname=kname,
                      exec_dir=exec_dir, conventions=conventions, create_mode=create_mode,
                      wt_path=wt_path, out_dir=out_dir)
    if (args.max_stage >= 5 and rec.get("verdict") == "verify-approved"
            and late_reservation(args, rec)):
        stage5_pr(args, rec, wt_path, built, issue, token)
    rec["finished"] = utcnow()
    return rec


# ---------------------------------------------------------------- main flow
async def run(args, rec: dict) -> dict:
    """Fill the caller-owned trace. `rec` is created in main() and passed in so a crash keeps
    everything already paid for: calls made, stages timed, plan received (F4, vllm#441)."""
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    repo = Path(args.repo)
    # refuse a --repo whose origin is not jsboige/CoursIA: the claim guard infers its slug from
    # the remote of ITS cwd (check_lane_claim.py), and a wrong --repo silently serves another
    # repo's issue numbers (measured 14/11: a manual claim check run from d:/vllm queried
    # jsboige/vllm#20250 — right number, wrong repo; multi-remote checkouts also hide this,
    # `git remote -v | head` shows only the alphabetically first remote).
    origin = subprocess.run(["git", "-C", str(repo), "remote", "get-url", "origin"],
                            capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()
    rec["repo_origin"] = origin
    if "jsboige/CoursIA" not in origin and not args.allow_foreign_origin:
        rec["verdict"] = f"refused-foreign-origin:{origin or 'no-origin'}"
        return rec
    token = refresh_gh_token(repo)
    if not token and (os.environ.get("NBCODER_GH_APP_ID") or os.environ.get("NBCODER_GH_KEY")):
        rec["verdict"] = "refused-gh-token-refresh"
        return rec
    conventions = read_conventions(args.conventions)
    rec["conventions"] = {"path": args.conventions, "chars": len(conventions)}

    # ---- stage 0
    t0 = time.time()
    claim_nb = _norm_rel(args.notebook)
    rec["stages"]["claim_check"] = check_claim(repo, args.issue, args.lane, claim_nb)
    refused = claim_verdict(rec["stages"]["claim_check"])
    if refused:
        rec["verdict"] = refused
        return rec
    issue = fetch_issue("jsboige/CoursIA", args.issue, token, claim_nb)
    rec["stages"]["issue"] = {"title": issue["title"], "state": issue["state"],
                              "labels": issue["labels"], "body_chars": len(issue["body"]),
                              "spec_comment": issue.get("spec_comment")}
    if (issue.get("spec_comment") or {}).get("status") == "none-for-target":
        # A lot issue whose spec drafts all name OTHER notebooks: building this one would
        # follow nobody's plan. Refused before the reservation, the worktree and any token.
        rec["verdict"] = "refused-no-spec-for-target"
        return rec
    from_spec = bool(getattr(args, "from_spec", False))
    spec_cells: list[dict] = []
    if from_spec:
        # Parsed BEFORE the reservation: a spec without a usable cell plan must never
        # post a [CLAIMED] comment, open a worktree or pay a token.
        spec_cells, spec_errors = parse_spec_cells(issue["body"])
        rec["stages"]["spec_plan"] = {"cells": len(spec_cells), "errors": spec_errors,
                                      "types": [c["cell_type"] for c in spec_cells]}
        if spec_errors:
            rec["verdict"] = "refused-spec-plan-unusable"
            return rec
    if args.claim and getattr(args, "claim_late", False):
        # CoursIA rule (coordinator 21/11, auto-pick Q-A): no [CLAIMED] before the run
        # holds an openable PR. The CLEAR pre-check above already refused a notebook
        # someone else holds; the reservation itself is taken by late_reservation()
        # right before stage 5, so a failed launch locks nothing.
        rec["stages"]["claim_reservation"] = dict(LATE_CLAIM_DEFERRED)
    elif args.claim:
        with issue_claim_lock(Path(args.out_dir).parent / CLAIM_LOCK_DIRNAME,
                              args.issue) as lock:
            rec["stages"]["claim_lock"] = lock
            rec["stages"]["claim_reservation"] = (
                reserve_claim(repo, args.issue, args.lane, args.intention, claim_nb)
                if lock["held"] else
                {"verdict": f"{CLAIM_TIMEOUT_VERDICT}:lock",
                 "note": "a sibling grain of this issue held its reservation too long"})
        if rec["stages"]["claim_reservation"]["verdict"]:
            rec["verdict"] = rec["stages"]["claim_reservation"]["verdict"]
            return rec
    elif args.max_stage >= 1:
        # Review ms#1812 finding 1: a spending run is not admitted on a bare
        # pre-check. Without --claim there is no reservation to re-read, so the
        # only sanctioned no-claim run is the explicit stage-0-only inspection.
        rec["verdict"] = "refused-no-reservation"
        rec["stages"]["claim_reservation"] = {
            "verdict": "refused-no-reservation",
            "note": "pass --claim to reserve, or --max-stage 0 to inspect only"}
        return rec
    wt = prepare_worktree(repo, Path(args.worktree), args.fresh_worktree)
    rec["stages"]["worktree"] = wt
    if not wt.get("ok", True):
        # #460: a refused/broken worktree must stop the run BEFORE any stage pays a
        # token -- and a rebuild failure must not fall through to stage 1 either.
        rec["verdict"] = f"worktree-refused:{wt.get('refused', 'rebuild-failed')}"
        return rec
    rec["stage0_s"] = round(time.time() - t0, 1)
    if args.max_stage < 1:
        rec["verdict"] = "stage0-only"
        return rec

    # Target resolution: correction (target exists on origin/main) or creation (--source-nb:
    # target absent, twin provided — the parity grains #27099-#27116 are all creations).
    wt_path = Path(wt["path"])
    target_nb = wt_path / args.notebook
    src_nb = target_nb
    create_mode = False
    spec_meta_d: dict = {}
    if target_nb.is_file():
        if args.source_nb or from_spec:
            # both present: an operator typo would silently CORRECT the twin instead of
            # creating the target — refuse loud.
            rec["verdict"] = f"target-already-exists:{args.notebook}"
            return rec
    else:
        meta_rel = getattr(args, "meta_from", None)
        if (from_spec or args.source_nb) and meta_rel:
            # --meta-from is mandatory for --from-spec and optional for --source-nb (a port
            # whose folder holds no sibling with the target's language tag, e.g. the first
            # Rust notebook of a series). Checked before any token is spent.
            meta_nb = wt_path / meta_rel
            if not meta_nb.is_file():
                rec["verdict"] = f"meta-from-not-found:{meta_nb}"
                return rec
            spec_meta_d = spec_meta(meta_nb)
            if not (spec_meta_d.get("kernelspec") or {}).get("name"):
                rec["verdict"] = f"meta-from-no-kernelspec:{meta_rel}"
                return rec
        if from_spec:
            # The twin lives in the OUT dir: never in the worktree, never committed.
            src_nb = out_dir / f"spec-twin-{args.issue}.ipynb"
            src_nb.write_text(json.dumps(spec_twin(spec_cells, spec_meta_d),
                                         ensure_ascii=False, indent=1) + "\n",
                              encoding="utf-8")
            create_mode = True
            rec["create_mode"] = {"spec_twin": str(src_nb), "target": args.notebook,
                                  "meta_from": meta_rel}
        elif args.source_nb:
            src_nb = wt_path / args.source_nb
            if not src_nb.is_file():
                rec["verdict"] = f"source-nb-not-found:{src_nb}"
                return rec
            create_mode = True
            rec["create_mode"] = {"source": args.source_nb, "target": args.notebook}
            if meta_rel:
                rec["create_mode"]["meta_from"] = meta_rel
        else:
            rec["verdict"] = f"notebook-not-found:{target_nb}"
            return rec
    kernel = series_kernel(wt_path, args.notebook)
    if create_mode:
        # The target is absent, so the path map can only describe its Python neighbours.
        # The canonical C# twin owns the deliverable's kernelspec: execution must use the
        # same kernel, before the builder even sees the plan. Measured on CoursIA#27106:
        # metadata .net-csharp, but every C# cell sent to python3 (SyntaxError on //).
        # --meta-from wins when given (mandatory for --from-spec); otherwise the sibling
        # that carries the target's language tag.
        twin_meta = spec_meta_d or series_canonical_meta(wt_path, args.notebook)
        twin_kernel = (twin_meta.get("kernelspec") or {}).get("name")
        # The deliverable declares the kernel that EXECUTES it: --kernel-override, else the
        # one the target's language tag requires. A --meta-from naming another language
        # (the C# twin used as porting reference for a Rust port) only lends its metadata
        # when it matches; otherwise a sibling that does is used, or the grain is refused
        # here, before any token (#27996: `.net-csharp` shipped on a Rust notebook).
        need = getattr(args, "kernel_override", None) or tag_kernel(args.notebook)
        mismatch = None
        if need and twin_kernel != need:
            alt = meta_for_kernel(wt_path, args.notebook, need)
            rec["meta_kernel_fix"] = {"meta_kernel": twin_kernel, "required": need,
                                      "replaced_from": alt.get("_from")}
            if alt:
                twin_meta = {k: v for k, v in alt.items() if k != "_from"}
                twin_kernel = need
                spec_meta_d = {}
            elif twin_kernel:
                mismatch = f"create-meta-kernel-mismatch:{twin_kernel}!={need}"
            # no metadata at all and no donor: the create-no-canonical-meta refusal below
        if twin_kernel and not mismatch:
            kernel["kernel_name"] = twin_kernel
            kernel["kernel_source"] = "canonical-twin-kernelspec"
            if spec_meta_d:
                kernel["kernel_source"] = "meta-from-kernelspec"
        else:
            # No canonical metadata (or only one naming another kernel): the skeleton would
            # carry {} / the wrong kernelspec and a gate would fail only AFTER the whole
            # build was paid (claudish PROPOSAL, 20/11; #27996). Refuse before the capacity
            # gate and any token; --meta-from naming the required kernel is the remedy.
            rec["kernel"] = kernel
            rec["verdict"] = mismatch or ("create-no-canonical-meta:"
                                          f"{Path(args.notebook).parent.as_posix()}")
            return rec
    rec["kernel"] = kernel
    rec["src_nb"] = str(src_nb)
    # The kernel runs where the DELIVERABLE will live: a from-spec twin sits in the out
    # dir, so its parent would make every relative path resolve outside the series.
    exec_dir = target_nb.parent if from_spec else src_nb.parent
    if from_spec:
        exec_dir.mkdir(parents=True, exist_ok=True)
    gate = gate_call(args.gate_mode, getattr(args, "gate", None))
    rec["gate"] = gate
    if gate["blocking_refusal"]:
        rec["verdict"] = "deferred-by-capacity-gate"
        return rec

    scratch_nb = (out_dir / f"nb_{args.issue}_built.ipynb").as_posix()
    sk_params = StdioServerParameters(command=str(SK_PY), args=[str(SK_DIR / "sk_agent.py")],
                                      env={**os.environ, "SK_AGENT_CONFIG": str(SK_CONFIG)},
                                      cwd=str(out_dir))
    pm_params = StdioServerParameters(command=str(PM_PY), args=["-u", "-m", "papermill_mcp.main"],
                                      env={**os.environ, "PYTHONUNBUFFERED": "1"},
                                      cwd=str(PM_CWD))
    async with stdio_client(sk_params) as (r1, w1), stdio_client(pm_params) as (r2, w2):
        async with ClientSession(r1, w1) as sk, ClientSession(r2, w2) as pm:
            # The initialize roundtrip is the ONE MCP wait with no per-call
            # read_timeout: per-call timeouts (sk_call: args.timeout+120,
            # pm_call: 300s) only arm AFTER the handshake. Measured 18/11
            # 00:27->03:35Z (wave-1b, py-spy stacks in the state-dir post-mortem):
            # a child blocked in StreamHandler.emit never answered initialize and
            # both drivers hung 2h30 with zero LLM traffic. Fail loud instead.
            try:
                await asyncio.wait_for(sk.initialize(), 180.0)
                await asyncio.wait_for(pm.initialize(), 180.0)
            except asyncio.TimeoutError:
                raise RuntimeError(
                    "MCP initialize handshake timed out after 180s (child never "
                    "answered; suspect an undrained stderr pipe blocking the "
                    "child's logging — see the wave-1b post-mortem 18/11)") from None
            view = build_view(src_nb)
            # user 22/11: a port reads the Python AND the C# twin when one exists
            cs_nb = csharp_sibling(src_nb) if (create_mode and not from_spec) else None
            cs_view = build_view(cs_nb, CS_VIEW_MAX) if cs_nb else ""
            if cs_nb:
                rec["csharp_twin"] = cs_nb.name
            ctx = series_context(wt_path, args.notebook)
            # ---- stage ½ SPEC (#4831), see spec_stage
            issue_eff = await spec_stage(sk, args, rec, issue, kernel, ctx, view,
                                         conventions, out_dir)
            if issue_eff is None:
                return rec
            # ---- stage 1 PLAN (correction) / CREATION PLAN (--source-nb)
            t1 = time.time()
            if from_spec:
                prompt = spec_creation_prompt(args.issue, issue_eff, args.notebook, kernel,
                                              ctx, view, conventions)
            elif create_mode:
                prompt = creation_prompt(args.issue, issue_eff, args.notebook, args.source_nb,
                                         kernel, ctx, view, conventions, cs_view,
                                         modules=local_modules(src_nb))
            else:
                prompt = plan_prompt(args.issue, issue_eff, args.notebook, kernel,
                                     ctx, view, conventions)
            env = await sk_call_retry(sk, args, rec, "1-plan", prompt, None)
            conv = env.get("conversation_id")
            rec["conversation_id"] = conv      # the agentic trace the PR body must carry
            plan, env = await parse_or_repair(sk, args, rec, "1-plan", env, conv)
            rec["plan"] = plan
            if not plan:
                # raw tail persisted for offline diagnosis (17/11: the unparsed 16 268-char
                # retry left only response_chars — no way to see WHERE parsing broke)
                rec["stage1_raw_tail"] = (env.get("response") or "")[-3000:]
            rec["stage1_s"] = round(time.time() - t1, 1)
            if args.max_stage < 2:
                rec["verdict"] = ("stage1-only" if plan
                                  else defer_refusal(env)
                                  or f"stage1-{call_failure(env) or 'unparsed'}")
                return rec
            if not plan:
                # a mid-flight gate refusal defers (scheduler retries with backoff),
                # everything else that killed the plan call stays terminal — 18/11
                # wave-1c #27103 burned terminally on exactly this distinction. A provider
                # 429 defers for the same reason (23/11), and so does a cut transport (26/11).
                rec["verdict"] = (defer_refusal(env)
                                  or f"stage1-{call_failure(env) or 'unparsed'}")
                return rec
            exec_idx = plan.get("execute_cells") or []
            if midrun_claim_abort(args, rec, "plan"):
                return rec

            # ---- stage 2 BUILD (correction: copy of the target) / CREATION (skeleton + all cells)
            t2 = time.time()
            scratch = Path(scratch_nb)
            if scratch.exists():
                scratch.unlink()
            if create_mode:
                meta = twin_meta
                rec["create_metadata"] = {"kernelspec": (twin_meta.get("kernelspec") or {}).get("name"),
                                          "language_version":
                                              (meta.get("language_info") or {}).get("version")}
                skeleton = {"cells": [], "metadata": meta,
                            "nbformat": 4, "nbformat_minor": 5}
                scratch.write_text(json.dumps(skeleton, ensure_ascii=False, indent=1) + "\n",
                                   encoding="utf-8")
            else:
                shutil.copy2(src_nb, scratch)     # outputs preserved: nothing to re-create
            sha_before = _sha(scratch)
            src_cells = _cells(src_nb)
            cs_cells = _cells(cs_nb) if cs_nb else None
            rec["write_mode"] = args.write_mode
            env2: dict = {}                # correction branch fills it; creation never reads it
            if create_mode:
                # from-spec: no prose pin — the [SPEC] cells describe, they are not
                # authoritative text (a twin's prose pin would copy the placeholders).
                built = await create_segments(sk, args, rec, conv, plan.get("cells") or [],
                                              len(src_cells), conventions,
                                              src_cells=None if from_spec else src_cells,
                                              cs_cells=None if from_spec else cs_cells)
                rec["build_model_answer"] = {"parsed": bool(built),
                                             "segments": rec.pop("segments", [])}
                if not built or not built.get("cells"):
                    if not rec.get("verdict"):
                        rec["verdict"] = "build-no-cells"
                elif built:
                    rec["apply"] = apply_create(scratch, built)
                if rec.get("verdict"):     # a failed segment returns NOW (tail persisted)
                    rec["stage2_s"] = round(time.time() - t2, 1)
                    return rec
            else:
                prompt2 = (build_json_prompt(plan, exec_idx, src_cells, len(src_cells), conventions)
                           if args.write_mode == "json"
                           else build_prompt(scratch_nb, plan, exec_idx, src_cells,
                                             len(src_cells), conventions))
                env2 = await sk_call_retry(sk, args, rec, "2-build", prompt2, conv)
                built, env2 = await parse_or_repair(sk, args, rec, "2-build", env2, conv)
                rec["build_model_answer"] = {"parsed": built,
                                             "chars": len(env2.get("response") or "")}
                if args.write_mode == "json" and built:
                    rec["apply"] = apply_edits(scratch, built)
            if scratch.is_file():
                rec["sources_normalized"] = normalize_sources(scratch)   # CR 1a, couvre le mode mcp
            rec["stage2_s"] = round(time.time() - t2, 1)
            if midrun_claim_abort(args, rec, "build"):
                return rec

            # ---- harness: structural diff first, then execution; the harness judges alone
            t3 = time.time()
            exists = scratch.is_file()
            rec["built_notebook"] = {"path": scratch_nb, "exists": exists,
                                     "bytes": scratch.stat().st_size if exists else 0,
                                     "changed": exists and _sha(scratch) != sha_before}
            # A dead stage-2 call leaves the copy untouched: 'build-no-change' would then blame
            # the model for an edit it was never asked to make (same lie as stage 1, F5).
            if not exists:
                rec["verdict"] = "build-no-notebook"
            elif not rec["built_notebook"]["changed"]:
                rec["verdict"] = (defer_refusal(env2)   # scheduler defer contract
                                  or f"build-{call_failure(env2) or 'no-change'}")
            else:
                rec["structure"] = (verify_structure_create(src_nb, scratch) if create_mode
                                    else verify_structure(src_nb, scratch, plan))
                if not rec["structure"]["ok"]:
                    rec["verdict"] = "built-structure-mismatch"
                else:
                    kid = await start_kernel(pm, args.kernel_override or kernel["kernel_name"],
                                             exec_dir)
                    rec["kernel_id"] = kid
                    rec["kernel_cwd"] = str(exec_dir)
                    if kid is None and args.exec_mode != "none":
                        # a kernel that fails to start must never read as a pass: without
                        # this, an absent .net-csharp kernelspec would produce a
                        # built-executed-ok verdict with ZERO executed cells
                        rec["verdict"] = "kernel-start-failed"
                    # exec policy: plan indexes are SOURCE-space and shift with deletes/inserts.
                    # auto = run ALL built code cells in order when the plan touches code
                    # (state-safe: dependencies run first, execution_count contiguous —
                    # the C.2 proof), none for a markdown-only gesture.
                    exec_targets: list[int] = []
                    if kid:
                        code_idx = [i for i, c in enumerate(_cells(scratch))
                                    if c.get("cell_type") == "code"]
                        touches_code = (
                            create_mode
                            or any(src_cells[int(p["cell"])].get("cell_type") == "code"
                                   for p in plan.get("plan") or []
                                   if p.get("geste") in ("edit", "delete")
                                   and str(p.get("cell", "")).isdigit()
                                   and int(p["cell"]) < len(src_cells))
                            or any(x.get("type") == "code"
                                   for x in (rec.get("apply") or {}).get("inserts") or []))
                        mode = "all" if (args.exec_mode == "auto" and touches_code) \
                            else ("none" if args.exec_mode == "auto" else args.exec_mode)
                        rec["exec_mode"] = f"{args.exec_mode}->{mode}"
                        rec["exec_planned_idx"] = exec_idx
                        if mode == "all":
                            exec_targets = code_idx
                        elif mode == "plan":
                            exec_targets = [int(i) for i in exec_idx if int(i) in code_idx]
                        rec["execution"] = (await execute_cells(pm, scratch, kid, exec_targets)
                                            if exec_targets else [])
                        # ---- repair loop on REAL kernel errors (repair_kernel_errors)
                        if exec_targets and rec.get("execution") and args.repair_rounds > 0:
                            kid, conv = await repair_kernel_errors(
                                sk, pm, args, rec, scratch,
                                args.kernel_override or kernel["kernel_name"], exec_dir,
                                kid, exec_targets, conv, conventions)
                        # ---- markdown prose repair (repair_markdown_defects): foreign-script
                        # corruption (creation) and coordination references (both modes) are
                        # REPAIRABLE in-session; the stage-3 gates stay the judges.
                        conv = await repair_markdown_defects(sk, args, rec, scratch, src_cells,
                                                             conv, conventions, create_mode,
                                                             from_spec)
                    # kernel hygiene: an hourly cadence must not leak one kernel per run
                    if rec.get("kernel_id"):
                        rec["kernel_stop"] = await pm_call(
                            pm, "manage_kernel", {"action": "stop",
                                                  "kernel_id": rec["kernel_id"]})
                    execution_verdict(rec, scratch)
            rec["stage3_s"] = round(time.time() - t3, 1)

    # ---- stages 3-5: harness-only (no model turn inside these), then the review loop
    built_path = Path((rec.get("built_notebook") or {}).get("path") or "")
    kname_used = args.kernel_override or kernel["kernel_name"]
    if rec.get("kernel_id"):
        note_execution_kernel(rec, kname_used)
    gates_then_verify(args, rec, src_nb, built_path, create_mode, kname_used,
                      Path(wt["path"]), out_dir,
                      spec_body=issue.get("body"), spec_ref=_spec_ref(args, issue))
    if rec.get("verdict") == "verify-reject":
        await revise_loop(args, rec, issue=issue, src_nb=src_nb, built_path=built_path,
                          kname=kname_used, exec_dir=exec_dir, conventions=conventions,
                          create_mode=create_mode, wt_path=Path(wt["path"]), out_dir=out_dir)
    if (args.max_stage >= 5 and rec.get("verdict") == "verify-approved"
            and late_reservation(args, rec)):
        stage5_pr(args, rec, Path(wt["path"]), built_path, issue, token)
    rec["finished"] = utcnow()
    return rec


def _keep_prior_trace(out: Path, prefix: str) -> str:
    """Snapshot `out` next to itself and return the copy's path; never replace a copy.

    A second-resolution timestamp collides on any retry inside the same second (a scheduler
    relaunching a refusal is exactly that case), and shutil.copy2 would silently replace the
    earlier snapshot -- the very loss this function exists to prevent. O_EXCL makes the race
    a fresh suffix instead of a lost record.
    """
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for n in range(1000):
        keep = out.with_name(f"issue-{out.stem.removeprefix('issue-')}.{prefix}-{stamp}"
                             + ("" if n == 0 else f"-{n}") + ".json")
        try:
            fd = os.open(keep, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
        except FileExistsError:
            continue
        with os.fdopen(fd, "wb") as dst, open(out, "rb") as src:
            shutil.copyfileobj(src, dst)
        shutil.copystat(out, keep)
        return str(keep)
    raise OSError(f"no free snapshot name beside {out}")   # never fall back to overwriting


def _seat_credential_gaps(args) -> list[str]:
    """Model entries whose key cannot resolve in THIS environment (24/11, o34b).

    Measured 24/11 19:13Z (po-2028:claudish, CoursIA#28079): the `nb-*` entries of the
    seat's config name their key through `api_key_env: ZAI_API_KEY`, nothing defined that
    variable on the seat, and sk-agent's `resolve_api_key()` fell back to its `no-key`
    default. The launch paid stage 0 (worktree, claim pre-check, issue read -- 60 s),
    opened the two MCP sessions, and its first model call answered
    `401 invalid proxy authentication`: a 125 s corpse, one call, verdict
    `stage1-auth-failed`. The seat's launcher knew the export; the harness never asked.

    Refuses on NAMES only -- role, agent, model entry, environment variable -- never on a
    value, and only the certain case: the variable sk-agent will read is empty here AND the
    entry carries no literal it would fall back to. Everything this cannot read (an
    unreadable config, an unknown preset, a model entry it cannot find) is left to sk-agent,
    which refuses those by name. `NBCODER_PREFLIGHT_CREDENTIALS=0` disables the check for a
    seat whose endpoint serves without a key.
    """
    if os.environ.get("NBCODER_PREFLIGHT_CREDENTIALS", "").strip() == "0":
        return []
    try:
        cfg = json.loads(Path(SK_CONFIG).read_text(encoding="utf-8"))
        agents = {a["id"]: a for a in cfg.get("agents") or [] if isinstance(a, dict) and a.get("id")}
        models = {m["id"]: m for m in cfg.get("models") or [] if isinstance(m, dict) and m.get("id")}
    except Exception:
        return []                 # not this check's question: the path check above already ran
    roles = [("coder", args.agent, args.coder_model)]
    if args.max_stage >= 4:       # the verifier is a separate process on the same config + env
        roles.append(("verifier", args.verifier_agent, args.verifier_model))
    if args.spec_mode == "run":
        roles.append(("spec", args.agent, args.spec_model))
    gaps: list[str] = []
    judged: set[str] = set()
    for role, agent_id, override in roles:
        ref = override or (agents.get(agent_id) or {}).get("model")
        model = models.get(ref)
        if not ref or not model or ref in judged:
            continue
        judged.add(ref)
        var = str(model.get("api_key_env") or "").strip()
        literal = model.get("api_key")
        usable = isinstance(literal, str) and literal.strip() not in ("", "no-key")
        if var and not usable and not (os.environ.get(var) or "").strip():
            gaps.append(f"{role}: agent {agent_id} -> model {ref} reads its key from "
                        f"${var}, which is not set in this environment")
    return gaps


def _tree_has(repo: Path, rev: str, rel: str) -> str | None:
    """Is `rel` in `rev`'s tree? "in-tree", "absent" (provably) or None (git cannot answer).

    `git cat-file -e` exits 128 for an absent path and for everything it cannot read (no
    such rev, not a repository), so the verdict is read from its message: only `does not
    exist in` is an absence. A path that `exists on disk, but not in` the rev (measured
    24/11: a spelling that differs by case, on a case-insensitive filesystem) is neither:
    the main checkout's working tree says nothing about the fresh worktree, so the check
    stays out of the way.
    """
    p = subprocess.run(["git", "-C", str(repo), "cat-file", "-e", f"{rev}:{rel}"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       env={**os.environ, "GIT_TERMINAL_PROMPT": "0"}, timeout=120)
    if p.returncode == 0:
        return "in-tree"
    return "absent" if "does not exist in" in (p.stderr or "") else None


def _launch_target_gap(args) -> dict | None:
    """A launch whose own target, twin or metadata cannot be reached (24/11, o34).

    Measured 24/11 (po-2028:claudish, CoursIA#28079): a creation grain queued without its
    twin. The driver built the worktree, ran the claim pre-check and read the issue before
    `run()` found an absent target and no `--source-nb`: 95 s, verdict
    `notebook-not-found`, nothing on the issue naming what was missing. The answer needed
    only the ref the worktree is cut from, which was known before any of that was paid.

    The same holds for the three other answers `run()`'s target resolution draws from that
    ref alone (`target-already-exists`, `meta-from-not-found`, `source-nb-not-found`), so
    they are asked here too, in `run()`'s own order. Read against a FRESH origin/main -- the
    fetch `prepare_worktree` makes: on a stale ref the check would refuse a correction
    whose target merged since the last fetch. A resume (`--revise-from` / `--verify-from`)
    reads its creation mode from the trace and is not asked. When git cannot answer,
    nothing is refused.
    """
    if args.revise_from or args.verify_from:
        return None
    repo = Path(args.repo)

    def norm(s) -> str:
        return str(s).replace("\\", "/")
    try:
        fetched = subprocess.run(["git", "-C", str(repo), "fetch", "-q", "origin", "main"],
                                 capture_output=True, text=True, encoding="utf-8",
                                 errors="replace", env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
                                 timeout=120)
        if fetched.returncode != 0:
            return None                # an unreadable or stale ref is never an answer
        rev = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "--quiet",
                              "origin/main^{commit}"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=60).stdout.strip()
        if not rev:
            return None
        gap = {"origin_main": rev[:10]}
        target = _tree_has(repo, rev, norm(args.notebook))
        creation = bool(args.source_nb or args.from_spec)
        if target == "in-tree" and creation:
            return gap | {"reason": "target-already-exists", "target": norm(args.notebook)}
        if creation and args.meta_from and _tree_has(repo, rev, norm(args.meta_from)) == "absent":
            return gap | {"reason": "meta-from-not-found", "meta_from": norm(args.meta_from)}
        if args.source_nb:
            twin = _tree_has(repo, rev, norm(args.source_nb))
            if twin == "absent":
                return gap | {"reason": "source-nb-absent", "source_nb": norm(args.source_nb),
                              "target": norm(args.notebook)}
            return None                # the twin resolves (or git cannot say): the creation proceeds
        if not creation and target == "absent":
            return gap | {"reason": "creation-grain-without-twin", "target": norm(args.notebook)}
    except (OSError, subprocess.SubprocessError):
        return None
    return None


def _preflight(ap, args) -> None:
    """Refuse before any spend when a wired path cannot exist (F3, vllm#441).

    On a foreign checkout PM_CWD fell through to a non-existent legacy path, so the two MCP
    spawns died with NotADirectoryError [WinError 267] AFTER the engine-token baseline: what
    the operator saw was 'crashed:ExceptionGroup ... (1 sub-exception)' with calls: 0, which
    reads like a model or protocol defect. A missing SK_PY / config dies the same opaque way
    inside stdio_client, so the check covers the whole wiring, not just the reported field.

    A refusal still leaves a TRACE (F3-1, co-review of #442): a scheduled loop cannot tell
    "ran and refused" from "never ran" if the refusal leaves no out-dir and no ledger line.
    The trace is written here, before ap.error, with the refusal itself as the verdict.

    An existing record is PRESERVED, never overwritten (24/11, o33): a resumed grain's
    out_dir is the OLD run directory, so writing here replaced the PAID record -- execution,
    findings, gates, worktree head -- with the refusal, BEFORE main()'s pre-revise rename
    could keep it, and the scheduler's run_trace() then read back the refusal and posted
    [RELEASED] on a grain that had never been judged. Keep it renamed, exactly as main()
    does, and name what was kept in the refusal itself.

    The kept name has only a SECOND of resolution, and a retry loop is precisely the case
    where two refusals land in the same second: the second copy would silently replace the
    first. `_keep_prior_trace` never replaces an existing copy, it adds a suffix instead.

    Three refusals, one per thing a seat gets wrong (24/11): a wired PATH that does not
    resolve here, a model CREDENTIAL that does not resolve here (`_seat_credential_gaps`), a
    TARGET the launch cannot reach (`_launch_target_gap`). Each is asked only once the
    previous one is clean, and each names its own remedy in its own verdict.
    """
    missing = [f"{name}={path}" for name, path, ok in (
        ("sk_agent.py (NBCODER_SK_DIR)", SK_DIR / "sk_agent.py", (SK_DIR / "sk_agent.py").is_file()),
        ("NBCODER_SK_PY", SK_PY, SK_PY.is_file()),
        ("NBCODER_SK_CONFIG", SK_CONFIG, SK_CONFIG.is_file()),
        ("NBCODER_PM_PY", PM_PY, PM_PY.is_file()),
        ("NBCODER_PM_CWD", PM_CWD, PM_CWD.is_dir()),
    ) if not ok]
    credential = [] if missing else _seat_credential_gaps(args)
    target_gap = None if (missing or credential) else _launch_target_gap(args)
    if not missing and not credential and not target_gap:
        return
    if missing:
        verdict = "refused-wiring-unresolved"
        detail = ("seat wiring does not resolve here — point the env var at a real path: "
                  + " | ".join(missing))
    elif credential:
        verdict = "refused-credential-unresolved"
        detail = ("a model this launch calls cannot authenticate here — export the named "
                  "environment variable in the launching shell (never write a key in the "
                  "config or on a command line); sk-agent sends no usable key and the first "
                  "call answers 401: " + " | ".join(credential)
                  + " | NBCODER_PREFLIGHT_CREDENTIALS=0 disables this check")
    else:
        verdict = "refused-target-unresolved"
        gap = target_gap or {}
        sha = gap.get("origin_main")
        reason = gap.get("reason")
        if reason == "source-nb-absent":
            detail = (f"--source-nb {gap.get('source_nb')} is absent from origin/main ({sha}): "
                      "a creation grain's twin must exist there")
        elif reason == "target-already-exists":
            detail = (f"{gap.get('target')} already exists on origin/main ({sha}) and this "
                      "launch declares a creation (--source-nb / --from-spec): a correction "
                      "drops those flags, a creation names a target that does not exist yet")
        elif reason == "meta-from-not-found":
            detail = (f"--meta-from {gap.get('meta_from')} is absent from origin/main ({sha}): "
                      "the created deliverable inherits that notebook's kernelspec and "
                      "language_info")
        else:
            detail = (f"{gap.get('target')} is absent from origin/main ({sha}) and this launch "
                      "names no twin — a creation grain passes --source-nb <repo-relative twin> "
                      "(or --from-spec with --meta-from); a correction names a notebook that "
                      "exists on origin/main")
    out_dir = Path(args.out_dir)
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / f"issue-{args.issue}.json"
        kept = None
        if out.is_file():
            prefix = ("pre-verify" if args.verify_from
                      else "pre-revise" if args.revise_from else "pre-refusal")
            kept = _keep_prior_trace(out, prefix)
        rec = {"issue": args.issue, "notebook": args.notebook, "started": utcnow(),
               "finished": utcnow(), "lane": args.lane, "dry": True, "calls": [],
               "verdict": verdict, "refusal": detail}
        if missing:
            rec["wiring_missing"] = missing
        if credential:
            rec["credential_missing"] = credential
        if target_gap:
            rec["target_gap"] = target_gap
        if kept:
            rec["preserved_prior_trace"] = kept
        out.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
        with open(out_dir / "ledger.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps({k: rec.get(k) for k in
                                 ("issue", "notebook", "started", "finished", "verdict", "lane")}
                                | {"calls": 0, "preserved_prior_trace": kept,
                                   "refusal": detail[:600]}, ensure_ascii=False) + "\n")
    except OSError:
        pass          # the refusal must not be masked by a failed trace write
    # The verdict line on stdout, like main()'s: a detached driver reaps with an unknown
    # return code, so its scheduler reads the verdict from this line alone. Without it the
    # refusal read as '' (a run failure) and released the grain's claim -- measured 28/11 on
    # CoursIA#29058: a queue item without source_nb, zero calls, path frozen 3 days.
    print(json.dumps({"issue": args.issue, "verdict": verdict, "calls": 0},
                     ensure_ascii=False), flush=True)
    ap.error(detail)


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--issue", type=int, required=True, help="CoursIA issue number")
    ap.add_argument("--notebook", required=True, help="repo-relative target notebook")
    ap.add_argument("--source-nb", default=None,
                    help="repo-relative TWIN notebook (creation mode: the target is ABSENT "
                         "from origin/main and gets created from this source, e.g. the "
                         "C# parity wave-1 grains #27099-#27116)")
    ap.add_argument("--from-spec", action="store_true",
                    help="creation of a NEW notebook with no twin (new series): the issue's "
                         "« Plan des cellules » table is the reference; requires --meta-from")
    ap.add_argument("--meta-from", default=None,
                    help="repo-relative notebook whose kernelspec + language_info the "
                         "created deliverable inherits (nothing else is read from it); "
                         "required with --from-spec, optional with --source-nb where it "
                         "overrides the sibling carrying the target's language tag")
    ap.add_argument("--repo", default=os.environ.get("NBCODER_REPO", ""),
                    help="CoursIA checkout (claim guard + worktree source); required — a "
                         "per-seat default path is not a harness binding (F2, vllm#438)")
    ap.add_argument("--allow-foreign-origin", action="store_true",
                    help="accept a --repo checkout whose origin is not jsboige/CoursIA (default: "
                         "refuse — the claim guard infers its slug from its cwd's origin, so a "
                         "wrong --repo silently serves another repo's issue numbers)")
    ap.add_argument("--worktree", default=str(VLLM_ROOT / ".tmp/nbcoder/wt"))
    ap.add_argument("--fresh-worktree", action="store_true")
    ap.add_argument("--out-dir", default=str(VLLM_ROOT / ".tmp/nbcoder"))
    ap.add_argument("--agent", default="notebook-auditor", help="sk-agent agent id")
    ap.add_argument("--conventions",
                    default=str(VLLM_ROOT / "myia_vllm/docs/adoption/nb-coder-conventions.md"),
                    help="house rules injected into the prompts ('' disables)")
    ap.add_argument("--intention", default="volet vllm du harnais nb-coder (passe a blanc)")
    ap.add_argument("--claim", action="store_true", help="post the [CLAIMED] comment (off in dry)")
    ap.add_argument("--claim-late", action="store_true",
                    help="with --claim: run stages 1-4 on the CLEAR pre-check alone and "
                         "post the [CLAIMED] only once the verifier approved, right before "
                         "stage 5 (CoursIA auto-pick rule 21/11: a failed launch locks "
                         "nothing). Requires --max-stage 5")
    ap.add_argument("--gate-mode", choices=["warn", "block", "off"], default="warn",
                    help="capacity gate only (gate_call -> swift_capacity_gate.py): warn = probe "
                         "and record, never refuse; block = refuse the launch on a "
                         "non-zero verdict (deferred-by-capacity-gate); off = no "
                         "probe. Does NOT disarm the structural stage-3 gates "
                         "(execution, conformance, verifier), which have no switch")
    ap.add_argument("--gate", type=Path, default=None,
                    help="capacity-gate probe script (default: $NBCODER_GATE env, else the "
                         "bundled swift_capacity_gate.py). The scheduler forwards its own "
                         "resolved --gate here, so parent-side custom paths propagate "
                         "without env mutation (pre-review round 2)")
    ap.add_argument("--lane", default=LANE,
                    help="claim lane id, form <machine>:nb-coder (default: NBCODER_LANE env; "
                         "no fallback — --claim refuses without it, F1/vllm#438)")
    ap.add_argument("--grain-tier", type=str.upper, choices=list(GRAIN_TIERS), default="MED",
                    help="the tier claimed on the PR's `Grain:` line (DEEP/MED/LIGHT). "
                         "CoursIA's merge gate refuses an unknown tier even when the PR is "
                         "approved and green — `auto` was never a tier, it read as "
                         "grain-tier-unknown:AUTO (ai-01:CoursIA, 16/11). Default MED: the "
                         "harness's own grains are full notebook builds, not one-cell edits. "
                         "Lowercase is accepted and normalised.")
    ap.add_argument("--write-mode", choices=["json", "mcp"], default="json",
                    help="json = harness applies the model's cell sources in one write; "
                         "mcp = the model calls the papermill write tools (lost-update hazard "
                         "when it parallelises its calls, measured 14/11)")
    ap.add_argument("--kernel-override", default=None)
    ap.add_argument("--exec-mode", choices=["auto", "all", "plan"], default="auto",
                    help="auto: run ALL built code cells in order when the plan touches code "
                         "(state-safe, execution_count sequential — C.2 proof), none for "
                         "markdown-only; all: always; plan: the plan's execute_cells "
                         "(SOURCE indexes, shift hazard with deletes/inserts)")
    ap.add_argument("--max-stage", type=int, choices=[0, 1, 2, 3, 4, 5], default=2,
                    help="0 claim+issue · +1 plan · +2 build/exec · +3 gates · "
                         "+4 independent verify · +5 PR (the only GitHub-writing stage; "
                         "the model never performs it)")
    ap.add_argument("--verifier-agent",
                    default=os.environ.get("NBCODER_VERIFIER", "critic"),
                    help="stage-4 verifier agent — must be a DIFFERENT model from the "
                         "builder (default critic = GLM-5.3 vs builder MiniMax)")
    # ---- per-step model selection (#4831): the difficulty->model mapping lives in the
    # harness README (documented, NOT hardcoded) -- the calling lane picks per pass/grain.
    # Unset = the --agent preset's own model serves the turn (seat default, unchanged
    # behavior). sk-agent validates the ref (enabled models only) and every call trace
    # carries model_used, the envelope's record of the entry that routed the turn.
    ap.add_argument("--coder-model", default=os.environ.get("NBCODER_CODER_MODEL"),
                    help="model serving EVERY coder turn (plan, build, segments, repairs, "
                         "revisions) -- overrides the --agent preset's model for those turns only")
    ap.add_argument("--verifier-model", default=os.environ.get("NBCODER_VERIFIER_MODEL"),
                    help="model serving the stage-4 audit (overrides the verifier agent "
                         "preset's model)")
    ap.add_argument("--spec-mode", choices=["skip", "run"],
                    default=os.environ.get("NBCODER_SPEC_MODE", "skip"),
                    help="skip (default): the issue is detailed enough, the spec step is "
                         "short-circuited -- DECLARED and traced on the run record; run: "
                         "--spec-model pre-chews the rough issue into a hyper-detailed one "
                         "that becomes stage 1's issue body (not --from-spec, which builds a "
                         "new notebook from the issue's cell plan)")
    ap.add_argument("--spec-model", default=os.environ.get("NBCODER_SPEC_MODEL"),
                    help="model serving the spec pre-chew turn (required with "
                         "--spec-mode run)")
    ap.add_argument("--verify-timeout", type=int, default=900)
    ap.add_argument("--pr-base", default="main")
    ap.add_argument("--pr-repo", default=None,
                    help="PR target as owner/repo (default: derived from the worktree's "
                         "origin remote; the run refuses with pr-repo-unresolved if "
                         "unparseable -- never a hard-coded fallback)")
    ap.add_argument("--pr-branch", default=None,
                    help="branch name (default nbcoder/auto-<issue>-<notebook stem>-<hash>: "
                         "one branch per grain, a lot issue holds several; seat-neutral, "
                         "#433 review)")
    ap.add_argument("--timeout", type=int, default=1500)
    ap.add_argument("--max-tokens", type=int, default=16384)
    ap.add_argument("--repair-rounds", type=int, default=2,
                    help="model repair rounds on real kernel errors (0 disables)")
    ap.add_argument("--repair-extend", type=int, default=REPAIR_EXTEND_DEFAULT,
                    help="extra repair rounds granted one at a time while the last round "
                         "strictly reduced the failing cells (0 = fixed budget)")
    ap.add_argument("--ctx-window", type=int, default=CTX_WINDOW,
                    help="tokens a repair turn may need on its conversation (history + "
                         "prompt + answer) before it starts a fresh one (default: the "
                         "served --max-model-len)")
    ap.add_argument("--revise-rounds", type=int, default=2,
                    help="constructive-review rounds after a verify-reject WITH findings: "
                         "the builder rewrites cells from the findings, the harness "
                         "re-executes, re-gates and re-verifies (0 disables; needs "
                         "--max-stage >= 4)")
    ap.add_argument("--revise-extend", type=int, default=REVISE_EXTEND_DEFAULT,
                    help="extra review rounds granted one at a time while the last round "
                         "strictly reduced the major findings of the same source "
                         "(0 = fixed budget)")
    ap.add_argument("--revise-from", default=None,
                    help="resume a REJECTED grain from its issue-<N>.json trace: no new "
                         "plan/build, no new [CLAIMED] comment (the reservation in the "
                         "trace is re-read by the scoped claim guard); runs the review "
                         "loop, then stage 5 if approved and --max-stage 5")
    ap.add_argument("--verify-from", default=None,
                    help="recover a grain whose VERIFIER CRASHED (trace verdict "
                         "verify-error, e.g. the GitHub REST bucket ran out mid-run), or an "
                         "APPROVED grain refused by the late-claim guard once the holder "
                         "released the notebook: the build already paid for is re-gated and "
                         "re-verified with zero coder turn, then the review loop and stage 5 "
                         "as usual (a released worktree is re-created at the trace's head)")
    return ap


def main() -> int:
    ap = build_parser()
    args = ap.parse_args()
    # Fail loud, never quiet (F1/F2, vllm#438): a claim under an identity the operator did not
    # choose breaks the registry guard itself, and a per-seat --repo default is a fourth
    # resolution path the README does not document.
    if not args.repo:
        ap.error("--repo is required (or NBCODER_REPO): the CoursIA checkout is an input of the "
                 "run, not a harness binding (F2, vllm#438)")
    if args.claim and not args.lane:
        ap.error("--claim requires --lane or NBCODER_LANE, form '<machine>:nb-coder' — a "
                 "default identity would let two seats share one claim lane (F1, vllm#438)")
    if args.claim_late and not args.claim:
        ap.error("--claim-late defers the reservation of --claim: pass both")
    if args.claim_late and args.max_stage < 5:
        ap.error("--claim-late reserves right before stage 5: a run stopping earlier would "
                 "spend model turns under no reservation and never take one")
    if args.source_nb and args.write_mode == "mcp":
        ap.error("creation mode (--source-nb) requires --write-mode json: the harness "
                 "assembles the whole notebook in one write, MCP cell tools would race "
                 "on an empty skeleton")
    if args.revise_from and (args.from_spec or args.source_nb or args.meta_from):
        ap.error("--revise-from reads the creation mode from the trace: do not pass "
                 "--from-spec / --source-nb / --meta-from with it")
    if args.revise_from and args.revise_rounds <= 0:
        ap.error("--revise-from needs --revise-rounds >= 1")
    if args.revise_from and args.max_stage < 4:
        ap.error("--revise-from needs --max-stage >= 4 (the review loop re-verifies)")
    if args.revise_from and args.verify_from:
        ap.error("--revise-from and --verify-from are exclusive: a delivered reject is "
                 "revised, a crashed verifier is re-verified")
    if args.verify_from and (args.from_spec or args.source_nb or args.meta_from):
        ap.error("--verify-from reads the creation mode from the trace: do not pass "
                 "--from-spec / --source-nb / --meta-from with it")
    if args.verify_from and args.max_stage < 4:
        ap.error("--verify-from needs --max-stage >= 4 (that is the stage being resumed)")
    if args.from_spec and args.source_nb:
        ap.error("--from-spec and --source-nb are exclusive: a twin port is --source-nb, "
                 "a new notebook with no twin is --from-spec")
    if args.from_spec and not args.meta_from:
        ap.error("--from-spec requires --meta-from <repo-relative notebook>: the deliverable "
                 "inherits that notebook's kernelspec + language_info (no default kernel)")
    if args.meta_from and not (args.from_spec or args.source_nb or args.revise_from
                               or args.verify_from):
        ap.error("--meta-from is only read in creation mode (--from-spec or --source-nb): "
                 "a correction keeps the existing notebook's metadata")
    if args.from_spec and args.write_mode == "mcp":
        ap.error("--from-spec requires --write-mode json (one harness write, like --source-nb)")
    if args.spec_mode == "run" and not args.spec_model:
        ap.error("--spec-mode run requires --spec-model (or NBCODER_SPEC_MODEL): the spec turn "
                 "is the one step that pre-chews a rough issue -- running it on the seat "
                 "default would silently defeat the per-step difficulty mapping (#4831)")
    if args.spec_mode == "run" and args.from_spec:
        ap.error("--spec-mode run and --from-spec are exclusive: --from-spec builds from the "
                 "issue's cell plan, parsed from the RAW body -- a pre-chewed body would make "
                 "the prompt and the gated plan diverge")
    if args.spec_mode == "run" and args.revise_from:
        ap.error("--spec-mode run has no effect with --revise-from: a revision re-plans "
                 "nothing, the spec turn would never run (declare --spec-mode skip)")
    if args.max_stage >= 1:   # stage 0 is git-only: a claim must not require the MCP wiring
        _preflight(ap, args)
    rec = {"issue": args.issue, "notebook": args.notebook, "started": utcnow(),
           "lane": args.lane, "dry": args.max_stage < 5, "stages": {}, "calls": [],
           # declared per-step models (#4831): what the lane asked for -- what each turn
           # actually got stays in calls[].model_used / served fields and verify.model_used
           "models": {"spec": args.spec_model, "coder": args.coder_model,
                      "verifier": args.verifier_model},
           "engine_tokens_before": engine_tokens()}
    try:
        rec = asyncio.run(run_revision(args, rec)
                          if (args.revise_from or args.verify_from) else run(args, rec))
    except Exception as exc:  # a trace is always written: a dead harness must not look like a quiet one
        # Keep what was already paid for, and keep WHY (F4, vllm#441). Rebuilding rec here threw
        # away the calls, the last stage and the plan: a stage-5 crash produced the same
        # 'calls: 0' trace as a pre-stage-0 one, and str(ExceptionGroup) renders as
        # '(1 sub-exception)' — an operator-visible crash with no operator-readable cause.
        rec["crash"] = {"type": type(exc).__name__, "message": str(exc)[:500],
                        "traceback_tail": traceback.format_exc()[-2000:]}
        rec["verdict"] = f"crashed:{type(exc).__name__}: {str(exc)[:300]}"
        if github_rate_limited(str(exc)):
            rec["verdict"] = rate_limit_verdict(github_core_reset())
        # `dry` is NOT forced here: it says "the run stopped before stage 5", which a crash on
        # --max-stage 5 does not mean (co-review of #442, F4-1). rec already carries the true
        # value from main() — a crash is a crash, not a dry run.
    rec["engine_tokens_after"] = engine_tokens()
    b, a = rec.get("engine_tokens_before") or {}, rec.get("engine_tokens_after") or {}
    rec["engine_tokens_delta"] = {k: round(a[k] - b[k]) for k in a if k in b} or None
    out = Path(args.out_dir) / f"issue-{args.issue}.json"
    if (args.revise_from or args.verify_from) and out.is_file():
        # the trace being resumed is usually THIS file: keep it, renamed, never overwritten
        prefix = "pre-verify" if args.verify_from else "pre-revise"
        keep = _keep_prior_trace(out, prefix)
        rec["revised_from"] = (rec.get("revised_from") or {}) | {"kept_as": keep}
    if content_verdict_class(rec.get("verdict")):
        rec["last_content_verdict"] = rec["verdict"]
    out.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    with open(Path(args.out_dir) / "ledger.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps({k: rec.get(k) for k in
                             ("issue", "notebook", "started", "finished", "verdict", "lane")}
                            | {"stage0_s": rec.get("stage0_s"), "stage1_s": rec.get("stage1_s"),
                               "stage2_s": rec.get("stage2_s"), "stage4_s": rec.get("stage4_s"),
                               "stage5_s": rec.get("stage5_s"),
                               "spec": (rec.get("spec") or {}).get("mode"),
                               "gate": (rec.get("gate") or {}).get("verdict"),
                               "verify": (rec.get("verify") or {}).get("verdict"),
                               "pr": (rec.get("pr") or {}).get("number"),
                               "calls": len(rec.get("calls") or []),
                               "revisions": len(rec.get("revisions") or []),
                               "revised_from": bool(args.revise_from or args.verify_from)},
                              ensure_ascii=False) + "\n")
    print(json.dumps({k: rec.get(k) for k in
                      ("issue", "verdict", "stage0_s", "stage1_s", "stage2_s", "stage4_s",
                       "stage5_s", "kernel_id")}
                     | {"verify": (rec.get("verify") or {}).get("verdict"),
                        "revisions": [r.get("result") for r in rec.get("revisions") or []],
                        "pr": (rec.get("pr") or {}).get("number")}, ensure_ascii=False))
    return 0 if rec.get("verdict", "").endswith(
        ("ok", "stage0-only", "stage1-only", "verify-approved", "pr-created")) else 1


if __name__ == "__main__":
    sys.exit(main())