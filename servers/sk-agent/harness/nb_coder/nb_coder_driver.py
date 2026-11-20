#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 0a301594f2c57519e48251cefdabea483c9f918e
# original path: myia_vllm/scripts/adoption/nb_coder/nb_coder_driver.py
# LOCAL DIVERGENCE (ms#1823): creation_plan_repair_prompt / repair_creation_plan is
# NOT in that upstream tree — ported upstream as jsboige/vllm#519 (same code, with
# parse_json_block in place of this copy's parse_or_repair). Drop this line at the
# next re-copy once #519 merges.
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""nb-coder driver — stages 0-5 of the issue -> notebook -> PR harness (jsboige/vllm#431).

Stage 0 CLAIM : check_lane_claim.py on the CoursIA checkout (read), optional [CLAIMED] comment.
Stage 1 PLAN  : sk-agent model turn -> cell plan JSON (kernel, edits, expected outputs).
Stage 2 BUILD : the HARNESS copies the source notebook (outputs preserved) and the model
                edits ONLY the planned cells on that copy (update_cell/add_cell/remove_cell);
                the harness then proves the result is a minimal edit (structure diff) and runs
                every planned cell with execute_on_kernel, deciding success alone.
Stage 3 GATES : harness-only checks on the built notebook — coordination refs added outside
                the exact provenance-footer form, secrets, language_info drift vs source.
Stage 4 VERIFY: independent verifier (nb_coder_verify.py, SEPARATE process and agent —
                producer != verifier; its exit 2 is an instrument error, never a reject).
Stage 5 PR    : harness-only GitHub gestures — fresh branch, single-notebook commit, REST PR
                create, delivery comment. The MODEL never writes to git or GitHub.

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
import contextlib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

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


def app_token(repo_dir: Path) -> str | None:
    """Requirement #5: 1-hour installation token, never persisted, never in the model context."""
    app_id = os.environ.get("NBCODER_GH_APP_ID")
    key = os.environ.get("NBCODER_GH_KEY")
    if not app_id or not key:
        return None
    script = repo_dir / "scripts/secrets/github_app_token.py"
    if not script.is_file():
        return None
    p = subprocess.run([sys.executable, str(script), "--app-id", app_id, "--key", key,
                        "--repo", "jsboige/CoursIA", "--quiet"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    tok = (p.stdout or "").strip().splitlines()[-1] if p.returncode == 0 else ""
    return tok or None


# ---------------------------------------------------------------- stage 0
def fetch_issue(slug: str, n: int, token: str | None) -> dict:
    rc, out = gh(["api", f"repos/{slug}/issues/{n}",
                  "--jq", '{"title":.title,"state":.state,"body":(.body // ""),"labels":[.labels[].name]}'],
                 token)
    if rc != 0:
        raise RuntimeError(f"issue fetch failed rc={rc}: {out[:300]}")
    issue = json.loads(out)
    rc, out = gh(["api", f"repos/{slug}/issues/{n}/comments", "--paginate",
                  "--jq", r'.[] | "--- \(.user.login) \(.created_at)\n\(.body)"'], token)
    issue["comments"] = out if rc == 0 else f"(comments fetch failed rc={rc})"
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
    p = subprocess.run([sys.executable, str(script), str(n), "--lane", lane,
                        "--paths", notebook,
                        *(["--from-json", from_json] if from_json else [])],
                       cwd=repo, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=120)
    return {"ok": p.returncode == 0, "rc": p.returncode,
            "out": (p.stdout or p.stderr).strip()[:2000]}


def claim_verdict(cc: dict) -> str | None:
    """Fail-closed reading of a SCOPED claim check (#466).

    rc=1  -> a live claim conflicts on THIS notebook's path: refuse.
    rc=2  -> the scoped check still cannot decide (old script without --paths, path
             absent from every open diff): refuse rather than run unprotected -- the
             pre-#466 driver treated this as pass-through.
    no rc -> the guard itself is absent/broken: refuse crash-free (it used to KeyError).
    rc=0  -> clear, proceed.
    """
    rc = cc.get("rc")
    if rc == 1:
        return "refused-claim-held-by-another-lane"
    if rc is None:
        return "refused-claim-check-broken"
    if rc != 0:
        return "refused-claim-check-not-scoped"
    return None


def post_claim(repo: Path, n: int, lane: str, intention: str,
               notebook: str, from_json: str | None = None) -> dict:
    """Acquire this notebook's claim through the authoritative guard, not a bare comment.

    The guard rechecks collisions and verifies its write before returning 0. The caller
    must gate the worktree/model stages on this result, then re-read the claim below.
    ``from_json`` is only for offline two-client admission tests, never production.
    """
    script = repo / "scripts/check_lane_claim.py"
    if not script.is_file():
        return {"rc": None, "out": "check_lane_claim.py absent"}
    p = subprocess.run([sys.executable, str(script), str(n), "--lane", lane,
                        "--paths", notebook, "--claim", intention,
                        *(["--from-json", from_json] if from_json else [])],
                       cwd=repo, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=120)
    return {"rc": p.returncode, "out": (p.stdout or p.stderr).strip()[:2000]}


def claim_reservation_verdict(post: dict, verify: dict) -> str | None:
    """A model run starts only after an admitted, freshly re-read scoped claim."""
    if post.get("rc") != 0:
        return "refused-claim-post-failed"
    if claim_verdict(verify) is not None:
        return "refused-claim-not-verified"
    return None


def reserve_claim(repo: Path, n: int, lane: str, intention: str,
                  notebook: str) -> dict:
    """Admission gate for a model run: scoped check -> authoritative post -> fresh re-read.

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
    posted = post_claim(repo, n, lane, intention, notebook)
    verified = (check_claim(repo, n, lane, notebook)
                if posted.get("rc") == 0
                else {"rc": None, "skipped": "claim acquisition failed"})
    return {"before": before, "posted": posted, "verified": verified,
            "verdict": claim_reservation_verdict(posted, verified)}


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
                   capture_output=True, text=True, timeout=300)
    origin_main = subprocess.run(["git", "-C", str(repo), "rev-parse", "origin/main"],
                                 capture_output=True, text=True).stdout.strip()
    if dest.exists() and (dest / ".git").exists() and not fresh:
        head_full = subprocess.run(["git", "-C", str(dest), "rev-parse", "HEAD"],
                                   capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(dest), "status", "--porcelain"],
                               capture_output=True, text=True).stdout.strip()
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
                       capture_output=True, text=True)
    p = subprocess.run(["git", "-C", str(repo), "worktree", "add", str(dest), "--detach", "origin/main"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    head = subprocess.run(["git", "-C", str(dest), "rev-parse", "--short", "HEAD"],
                          capture_output=True, text=True).stdout.strip()
    return {"path": str(dest), "reused": False, "head": head,
            "ok": p.returncode == 0, "err": (p.stderr or "").strip()[:500]}


def engine_tokens() -> dict:
    """Engine-side prompt/generation counters, for a per-pass token delta (CR CoursIA#26534)."""
    try:
        p = subprocess.run(["curl", "-s", "--max-time", "5", ENGINE_METRICS],
                           capture_output=True, text=True, timeout=10)
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
def creation_prompt(issue_n: int, issue: dict, rel: str, source_rel: str, kernel: dict,
                    ctx: str, view: str, conventions: str = "") -> str:
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
        "Le jumeau C# rejoue le MÊME fil pédagogique : une cellule du jumeau Python = une "
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


def creation_json_prompt(segment_cells: list, n_src_cells: int, conventions: str = "",
                         src_cells: list | None = None) -> str:
    """Stage 2 in creation mode, ONE SEGMENT at a time: the model returns the sources of
    the plan's cells i..j only. Measured 17/11: the whole-notebook single-shot answer
    does not survive the output budget. The harness assembles every segment.
    src_cells: the TWIN's cells — when present, the authoritative French prose of every
    MARKDOWN cell of this segment is injected verbatim (17/11 #27104: prose REGENERATED
    from memory came back corrupted — «случай», CJK — the model must COPY, not reinvent;
    code cells keep deriving from the plan, only prose is pinned to the twin)."""
    prose = ""
    if src_cells:
        parts = []
        for c in segment_cells:
            if not isinstance(c, dict) or c.get("cell_type") != "markdown":
                continue
            try:
                i = int(c.get("idx"))
            except (TypeError, ValueError):
                continue
            if 0 <= i < len(src_cells):
                t = _text(src_cells[i].get("source"))
                if t.strip():
                    parts.append(f"<cellule {i} — prose à recopier>\n{t[:2500]}")
        if parts:
            prose = ("\n\nPROSE DU JUMEAU PYTHON — AUTORITÉ pour les cellules MARKDOWN de "
                     "cette tranche : recopie cette prose TELLE QUELLE en n'adaptant QUE les "
                     "termes propres au code .NET (noms d'API, en-têtes d'implémentation). "
                     "N'invente, ne traduis et ne reformule AUCUNE phrase — la prose "
                     "réinventée arrive corrompue (mesuré 17/11) :\n"
                     + "\n\n".join(parts)[:16000] + "\n")
    return (
        "TOUR 2 — CRÉATION, TRANCHE COURANTE : rends les sources COMPLÈTES des cellules "
        "listées ci-dessous, et rien d'autre. Le harnais assemble lui-même le fichier "
        "(squelette + metadata de série déjà posés) ; tu n'écris aucun fichier et tu "
        "n'appelles aucun outil d'écriture.\n\n"
        f"Cellules de cette tranche (index du PLAN, ordre du carnet) :\n"
        + json.dumps(segment_cells, ensure_ascii=False)[:9000] + "\n"
        + prose + "\n"
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
    return errors


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
    plan, env = await parse_or_repair(session, args, rec, "1-plan-repair", env, conv)
    cells = (plan or {}).get("cells") or []
    return cells or None


async def create_segments(session, args, rec: dict, conv: str | None, plan_cells: list,
                          n_src_cells: int, conventions: str,
                          src_cells: list | None = None) -> dict:
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
    with the missing idx listed.
    An UNADDRESSABLE plan gets ONE bounded re-ask (CoursIA#27580, 20/11: 24 plan entries
    for a 22-cell source) before the terminal verdict — the build path is still never
    entered on a plan that cannot be addressed."""
    all_cells: list = []
    seg_reports: list = []
    addressing_errors = creation_plan_addressing(plan_cells, n_src_cells)
    if addressing_errors and session is not None:
        repaired = await repair_creation_plan(session, args, rec, conv,
                                              addressing_errors, n_src_cells)
        after = creation_plan_addressing(repaired or [], n_src_cells)
        rec["creation_plan_repair"] = {"errors_before": addressing_errors,
                                       "errors_after": after, "kept": not after}
        if not after:
            plan_cells[:] = repaired   # the caller's rec['plan'] stays the BUILT plan
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
                                                       src_cells), conv,
                                  max_tokens=BUILD_MAX_TOKENS)
        part, env = await parse_or_repair(session, args, rec, stage, env, conv,
                                          max_tokens=BUILD_MAX_TOKENS)
        kept, missing = segment_keep_valid((part or {}).get("cells") or [], tranche)
        return kept, missing, part, env

    def truncated(env: dict) -> bool:
        r = (env.get("response") or "").rstrip()
        return bool(r) and not (r.endswith("```") or r.endswith("}"))

    for si in range(0, len(plan_cells), CREATE_SEGMENT):
        seg = plan_cells[si:si + CREATE_SEGMENT]
        kept, missing, part, env = await ask_tranche(seg, f"2-build+{si}")
        conv = env.get("conversation_id") or conv
        chars_first = len(env.get("response") or "")
        if not part and truncated(env):
            # 18/11 wave-1c: two grains died here — the JSON was CUT mid-cell (raw
            # tails end inside a "source" string) because thinking counts toward
            # max_tokens. Bisect ONCE: halves the output AND the thinking a tour
            # needs; each half parses or the grain fails named, never silent.
            halves = [seg[:max(1, len(seg) // 2)], seg[max(1, len(seg) // 2):]]
            kept, missing, chars_first = [], [], 0
            for hi, half in enumerate(h for h in halves if h):
                hkept, hmiss, hpart, henv = await ask_tranche(half, f"2-build+{si}+h{hi}")
                conv = henv.get("conversation_id") or conv
                chars_first += len(henv.get("response") or "")
                if not hpart or not (hpart.get("cells") or []):
                    if gate_refusal(henv):
                        rec["verdict"] = gate_refusal(henv)   # scheduler defer contract
                    else:
                        rec["verdict"] = (f"stage2-truncated:{si}+h{hi}"
                                          if truncated(henv)
                                          else f"stage2-{call_failure(henv) or 'unparsed'}:{si}+h{hi}")
                    rec["stage2_raw_tail"] = (henv.get("response") or "")[-3000:]
                    return {}
                kept += hkept
                missing += hmiss
            kept.sort(key=lambda c: int(c["idx"]))
            missing.sort(key=lambda c: int(c["idx"]))
            rec.setdefault("bisected", []).append(si)
        elif not part or not (part.get("cells") or []):
            if gate_refusal(env):
                rec["verdict"] = gate_refusal(env)   # scheduler defer contract
            elif not part:
                rec["verdict"] = f"stage2-{call_failure(env) or 'unparsed'}:{si}"
            else:
                rec["verdict"] = f"stage2-empty-segment:{si}"
            rec["stage2_raw_tail"] = (env.get("response") or "")[-3000:]
            return {}
        repair = None
        if missing:
            # one repair round for EXACTLY the omitted cells — same prompt shape,
            # smaller tranche, so the omissions cannot hide in a long answer again
            env = await sk_call_retry(session, args, rec, f"2-build+{si}+repair",
                                      creation_json_prompt(missing, n_src_cells,
                                                           conventions), conv,
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


def repair_prompt(failing: list[dict], conventions: str = "") -> str:
    """One repair round: the REAL kernel errors of the failing cells (line + cause, as
    persisted by execution) and a demand for corrected FULL sources of those cells only.
    Measured on #27099 attempt 3: the model ports Python idioms that do not exist in the
    .NET Z3 API (MkNe, Expr where ArithExpr is required) — the compiler messages cite
    exactly what a repair round needs; the harness never shows the model its own claims."""
    blocks = [f"### Cellule {f['idx']} (code)\nSOURCE ACTUELLE :\n{f['source']}\n\n"
              f"ERREURS RÉELLES (compilation/exécution sur le noyau de la série) :\n{f['errors']}"
              for f in failing]
    return (
        "TOUR RÉPARATION — les cellules ci-dessous ont ÉCHOUÉ à l'exécution réelle. Corrige "
        "leur code : même rôle pédagogique, API de la série correcte — les messages du "
        "compilateur citent la ligne et la cause exactes. Ne réécris pas les cellules qui "
        "passent.\n\n" + "\n\n".join(blocks)
        + (f"\n\nConventions de livraison (imposées) :\n{conventions}\n" if conventions else "")
        + "\nRends UNIQUEMENT un bloc ```json :\n"
        '{"cells":[{"idx":<index inchangé>,"cell_type":"code",'
        '"source":"<source CORRIGÉ et COMPLET>"}]}\n'
        "TOUTES les cellules listées, index inchangés, aucune autre cellule."
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
    model COPIES it instead of re-deriving)."""
    blocks = [f"### Cellule {f['idx']} (markdown)\n"
              f"TEXTE ACTUEL (corrompu, extrait autour des caractères étrangers) :\n"
              f"…{f['excerpt']}…\n\n"
              f"PROSE DU JUMEAU PYTHON (autorité — recopie-la) :\n{f.get('twin_source') or '(absente du jumeau — réécris la cellule en français propre, sans caractère étranger)'}"
              for f in failing]
    return (
        "TOUR RÉPARATION PROSE — les cellules markdown ci-dessous contiennent des caractères "
        "d'alphabets étrangers insérés dans la prose française. Réécris chaque cellule en "
        "recopiant la prose du jumeau Python fournie, en n'adaptant QUE les termes propres "
        "au code .NET. Ne change aucune autre cellule, ne reformule rien.\n\n"
        + "\n\n".join(blocks)
        + (f"\n\nConventions de livraison (imposées) :\n{conventions}\n" if conventions else "")
        + "\nRends UNIQUEMENT un bloc ```json :\n"
        '{"cells":[{"idx":<index inchangé>,"cell_type":"markdown",'
        '"source":"<source CORRIGÉ et COMPLET>"}]}\n'
        "TOUTES les cellules listées, index inchangés, aucune autre cellule."
    )


# ---------------------------------------------------------------- constructive-review loop
# 20/11, IT08 CoursIA#27460: a verify-reject ended the grain, so a first draft could never
# be improved by the review it had just received (user mandate 18/11: "Un premier jet
# perfectible doit être améliorable après review constructive"). The revision round below
# closes that loop; --revise-from resumes it on an already-built, already-rejected grain.
REVISION_OUT_CAP = 1_500
REVISION_VIEW_CAP = 90_000


def revision_view(nb_path: Path, out_cap: int = REVISION_OUT_CAP,
                  max_chars: int = REVISION_VIEW_CAP) -> str:
    """The notebook as the REVISER must see it: every cell's source AND, for code cells, the
    execution count and the text really displayed. build_view shows sources only — enough to
    plan a build, not to answer a reviewer who judges displayed values. Cuts are declared."""
    parts = []
    for i, c in enumerate(_cells(nb_path)):
        ct = c.get("cell_type")
        block = f"=== cellule {i} | {ct} ===\n{_text(c.get('source'))}"
        if ct == "code":
            out = _outputs_text(c)
            shown = out[:out_cap]
            if len(out) > out_cap:
                shown += f"\n…[sortie tronquée : {len(out) - out_cap} caractères non affichés]"
            block += (f"\n--- sortie réelle (execution_count={c.get('execution_count')}) ---\n"
                      f"{shown or '(aucune sortie)'}")
        parts.append(block)
    return _cut("\n\n".join(parts), max_chars, "vue du carnet")


def revision_prompt(issue: dict, view: str, findings: list[dict], conventions: str = "",
                    spec: bool = False) -> str:
    """Self-contained on purpose: the build conversation may be gone (sk-agent keeps no
    durable store here, and --revise-from runs in a new process). The reviser gets the
    spec, the whole notebook with its REAL outputs, and the findings — and may contest a
    finding instead of bending the notebook to a wrong one."""
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
        f"## Constats du vérificateur\n{json.dumps(fl, ensure_ascii=False, indent=1)}\n\n"
        "## Règles\n"
        "- Ne crée ni ne supprime aucune cellule : index et types inchangés (le plan est "
        "imposé). Tu peux modifier toute cellule existante, code ou markdown, y compris une "
        "voisine de la cellule citée quand le constat l'exige.\n"
        "- Les sorties viennent de l'EXÉCUTION : le harnais réexécute TOUT le carnet dans un "
        "noyau neuf après ta révision. N'écris jamais une sortie toi-même ; ne code jamais en "
        "dur une valeur présentée comme calculée.\n"
        "- Une valeur attendue doit être AFFICHÉE par une sortie réelle, avec la précision "
        "que l'issue demande.\n"
        "- Si un constat te paraît faux, ne modifie rien pour lui donner raison : explique "
        "pourquoi dans `contested`, en t'appuyant sur une sortie ou un calcul. Le vérificateur "
        "relira ta réponse.\n\n"
        "Rends UNIQUEMENT un bloc ```json :\n"
        '{"cells":[{"idx":<index inchangé>,"cell_type":"code|markdown",'
        '"source":"<source COMPLET>"}],"addressed":[{"cell":<index>,"how":"..."}],'
        '"contested":[{"cell":<index>,"why":"..."}]}\n'
        "Seules les cellules que tu modifies figurent dans `cells`, chacune avec son source COMPLET."
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


async def sk_call(session: ClientSession, args, prompt: str, conv: str | None,
                  max_tokens: int | None = None) -> tuple[dict, float]:
    spec = {"extends": args.agent,
            "sampling": {"max_tokens": max_tokens or args.max_tokens, "temperature": 0.4}}
    payload = {"prompt": prompt, "agent": args.agent, "timeout": args.timeout,
               "include_steps": True, "agent_spec": json.dumps(spec)}
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


async def sk_call_retry(session: ClientSession, args, rec: dict, stage: str, prompt: str,
                        conv: str | None, max_tokens: int | None = None) -> dict:
    for attempt in range(2):
        tob = engine_tokens()
        env, dt = await sk_call(session, args, prompt + (RETRY_NOTE if attempt else ""), conv,
                                max_tokens)
        toa = engine_tokens()
        rec["calls"].append({"stage": stage if not attempt else f"{stage}-retry",
                             "elapsed_s": dt, "error": env.get("error"),
                             # model_used/agent_used: the sk-agent ENTRY that routed the call,
                             # not proof of the model that answered (20/11: a hub reroute left
                             # `nb-minimax` here while glm-5.3 served). What served comes from
                             # served_fields, when the envelope carries it.
                             "model_used": env.get("model_used"),
                             "agent_used": env.get("agent_used"),
                             **served_fields(env),
                             "response_chars": len(env.get("response") or ""),
                             "engine_delta": ({k: round(toa[k] - tob[k]) for k in toa if k in tob}
                                              or None)})
        if not (env.get("error") or "").startswith("empty model response"):
            break
    return env


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
    # A gate refusal on the repair call is a deferral, and the caller reads it from env.
    return (obj2, env2) if obj2 is not None or gate_refusal(env2) else (None, env)


async def pm_call(session: ClientSession, tool: str, payload: dict) -> dict:
    try:
        res = await session.call_tool(tool, payload, read_timeout_seconds=timedelta(seconds=300))
        raw = "\n".join(getattr(c, "text", "") for c in res.content)
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}
    try:
        return json.loads(raw)
    except Exception:
        return {"raw": raw}


async def execute_cells(pm: ClientSession, nb_path: Path, kernel_id: str,
                        indexes: list[int]) -> list[dict]:
    """The harness owns execution and the verdict: real outputs, never the model's word.

    persist_error_outputs is opted IN (#4817 / ms#1803): the MCP default refuses to write a
    raised cell's error output into the .ipynb (committed sources stay intangible), but this
    path only ever executes the SCRATCH copy — and the repair rounds plus the verify critic
    read that artifact back from disk after the process is gone. Without the opt-in, a
    compiler error lives only in the in-memory response and the evidence dies with it
    (the exact hole ms#1799 closed for committed sources; the scratch contract is the
    mirror image, which is why the flag exists at all)."""
    results = []
    for idx in indexes:
        r = await pm_call(pm, "execute_on_kernel", {"kernel_id": kernel_id, "mode": "notebook_cell",
                                                    "path": str(nb_path), "cell_index": idx,
                                                    "persist_error_outputs": True,
                                                    "timeout": 300})
        status = r.get("status") or r.get("error") or "?"
        outs = r.get("outputs") or []
        err_txt = " ".join(str(o.get("text") or o.get("ename") or "") for o in outs
                           if isinstance(o, dict) and o.get("output_type") == "error")
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
    then CS0246 cascade on every cell that used the Z3 namespace)."""
    r = await pm_call(pm, "manage_kernel", {"action": "start", "kernel_name": kernel_name,
                                            "working_dir": str(working_dir)})
    return r.get("kernel_id")


# ---------------------------------------------------------------- stages 3-5
# Convention forms (nb-coder-conventions.md): a coordination reference only ever survives
# as the exact footer note; anything else the BUILD adds is a violation.
# NB: the bare word `lane` in the alternation is deliberately broad -- ANY use of the
# word in a built cell is a candidate violation, whitelisted only by the footer note
# (PROVENANCE_RE). This is prose-vocabulary policing, not claim-marker matching: the
# registry's own markers live on issue comments, never inside notebooks.
COORD_REF_RE = re.compile(r"(?i)\b(?:epic|see|part\s+of)\s*#|\blane\b")
PROVENANCE_RE = re.compile(r"Carnet issu de l'EPIC #\d+")
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


def run_gates(src_nb: Path, built_nb: Path, create_mode: bool = False,
              canon_version: str | None = None) -> list[dict]:
    """Stage 3 — harness-only gates on the BUILT notebook, no model turn.

    Judged on the DELTA (cells the build touched): the source's own prose is the repo's
    business, not the gate's — a pre-existing footer stays legit untouched.
    In creation mode every cell is delta, and language-info compares against the series'
    canonical .NET twin (canon_version), never the Python twin."""
    src_cells, built_cells = _cells(src_nb), _cells(built_nb)
    gates: list[dict] = []
    last_md = max((i for i, c in enumerate(built_cells) if c.get("cell_type") == "markdown"),
                  default=-1)
    offenders = []
    for i, c in enumerate(built_cells):
        txt = _text(c.get("source"))
        if i < len(src_cells) and txt == _text(src_cells[i].get("source")):
            continue                      # untouched by the build
        if COORD_REF_RE.search(txt) and not (i == last_md and PROVENANCE_RE.search(txt)):
            offenders.append(i)
    gates.append({"gate": "coord-refs", "ok": not offenders,
                  "detail": {"cells": offenders[:10]}})
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
    return gates


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
                           capture_output=True, text=True, timeout=120)
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
SERVED_FIELDS = ("served_model", "failover_notice")


def served_fields(env: dict) -> dict:
    return {k: env[k] for k in SERVED_FIELDS if env.get(k)}


def served_identity(calls: list, verify: dict) -> dict:
    """Producer vs verifier, by the model that SERVED them, as far as the envelopes say.

    `same`: the verifier's served model also served a producer call -> the producer judged
    its own work, and no approval stands. `distinct`: every answered producer call names its
    served model and none is the verifier's. `unknown` otherwise: said in clear, never read
    as distinct. Failover notices are listed whatever the status."""
    answered = [c for c in calls or [] if c.get("response_chars") and not c.get("error")]
    prod = sorted({c["served_model"] for c in answered if c.get("served_model")})
    ver = verify.get("served_model")
    if ver and ver in prod:
        status = "same"
    elif ver and answered and all(c.get("served_model") for c in answered):
        status = "distinct"
    else:
        status = "unknown"
    fo = [{"stage": c.get("stage"), "notice": str(c["failover_notice"])[:300]}
          for c in calls or [] if c.get("failover_notice")]
    if verify.get("failover_notice"):
        fo.append({"stage": "4-verify", "notice": str(verify["failover_notice"])[:300]})
    return {"status": status, "producer": prod, "verifier": ver, "failovers": fo}


def identity_line(identity: dict | None) -> str:
    """One PR-body line: what served, or that it is not known."""
    st = (identity or {}).get("status")
    if st == "distinct":
        head = (f"producteur {', '.join(identity['producer'])} ≠ vérificateur "
                f"{identity['verifier']}")
    elif st == "same":
        head = f"MÊME modèle servi des deux côtés ({identity['verifier']})"
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
        rec["verdict"] = "verify-same-served-model"
    elif rc == 0 and entry.get("verdict") == "approve":
        rec["verdict"] = "verify-approved"
    elif rc == 1 and entry.get("verdict") == "reject":
        rec["verdict"] = "verify-reject"
    else:
        rec["verdict"] = "verify-error"


# Inline commit identity (ms#1813, restored after the af41a7ae re-copy dropped
# it): a CI runner has no user.name/user.email configured, and the stage5
# commit is the FIRST commit of a fresh worktree — without these two `-c`
# pairs it dies "Author identity unknown" and the whole grain fails at the
# last step.
_GIT_IDENTITY = ("-c", "user.name=nb-coder",
                 "-c", "user.email=nb-coder@users.noreply.github.com")


def _git(wt: Path, *git_args: str, timeout: int = 300) -> tuple[int, str]:
    p = subprocess.run(["git", "-C", str(wt), *git_args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    return p.returncode, (p.stdout or p.stderr).strip()


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


def stage5_pr(args, rec: dict, wt_path: Path, built_nb: Path, issue: dict,
              token: str | None) -> None:
    """Stage 5 — harness-only GitHub gestures: the model never writes to git or GitHub.
    Fresh branch off the detached worktree, single-notebook commit, REST PR create,
    delivery comment on the issue."""
    t0 = time.time()
    nb_rel = args.notebook.replace("\\", "/")
    branch = args.pr_branch or f"nbcoder/auto-{args.issue}"
    desc = _short_desc(args, rec.get("plan") or {}, rec.get("create_mode"))
    entry: dict = {"branch": branch}

    rc, out = _git(wt_path, "checkout", "-b", branch)
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

    commit_body = (
        f"{desc}\n\n"
        + "\n".join(f"- cell {g.get('cell')} ({g.get('geste')}): {_text(g.get('but')).strip()}"
                    for g in (rec.get("plan") or {}).get("plan") or [] if isinstance(g, dict))
        + f"\n\nProducteur : {args.agent} (harnais nb_coder, stages 0-5)."
        + f"\nVérification indépendante : {args.verifier_agent} — "
        f"{(rec.get('verify') or {}).get('verdict')} "
        f"(modèle {(rec.get('verify') or {}).get('model_used')})."
        + f"\nModèle servi : {identity_line((rec.get('verify') or {}).get('identity'))}."
        + f"\nExécution : kernel {rec.get('kernel', {}).get('kernel_name')}, "
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
    entry["commit"], _ = _git(wt_path, "rev-parse", "--short", "HEAD")

    rc, out = _git(wt_path, "push", "-u", "origin", branch)
    if rc != 0:
        entry["error"] = f"push: {out[:300]}"
        rec["verdict"], rec["pr"] = "pr-push-failed", entry
        return

    n_exec = len(rec.get("execution") or [])
    gates_ok = [g["gate"] for g in rec.get("gates") or [] if g.get("ok")]
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
        f"**Livraison AUTONOME** — harnais nb_coder stages 0-5 : producteur `{args.agent}` "
        f"(`{(rec.get('calls') or [{}])[-1].get('model_used') if rec.get('calls') else 'n/a'}`), "
        f"vérificateur indépendant `{args.verifier_agent}` "
        f"(`{(rec.get('verify') or {}).get('model_used')}`).\n\n"
        f"## Geste\n\n{desc}\n\n"
        + "\n".join(f"- cell {g.get('cell')} ({g.get('geste')}): {_text(g.get('but')).strip()}"
                    for g in (rec.get("plan") or {}).get("plan") or [] if isinstance(g, dict))
        + "\n\n## Mesures\n\n"
        f"- **Exécution réelle** (execute_on_kernel, kernel `{rec.get('kernel', {}).get('kernel_name')}`) : "
        f"{n_exec} cellules, 0 erreur. C.2 : execution_count séquentiel — "
        f"{'oui' if (rec.get('c2') or {}).get('sequential') else 'NON'}.\n"
        f"- **Gates** : {', '.join(gates_ok) or 'aucun'} OK.\n"
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
        f"run record complet dans le out-dir du harnais.\n\n"
        f"Closes #{args.issue}\n\n"
        "🤖 Generated with [Claude Code](https://claude.com/claude-code)")
    body_file = built_nb.parent / f"pr-body-{args.issue}.md"
    body_file.write_text(pr_body, encoding="utf-8")
    rc, out = gh(["api", f"repos/{repo_slug}/pulls",
                  "-f", f"title=Fix(notebooks,#{args.issue}): {desc}",
                  "-f", f"head={branch}", "-f", f"base={args.pr_base}",
                  "-F", f"body=@{body_file}"], token, timeout=120)
    body_file.unlink(missing_ok=True)
    if rc != 0:
        entry["error"] = f"pr create: {out[:300]}"
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
async def repair_kernel_errors(sk, pm, args, rec: dict, scratch: Path, kname: str,
                               exec_dir: Path, kid: str | None, exec_targets: list[int],
                               conv: str | None, conventions: str,
                               stage: str = "2.5-repair") -> tuple[str | None, str | None]:
    """Repair loop: the REAL kernel errors go back to the model (max --repair-rounds, same
    conversation). A repaired definition can change downstream semantics -> FRESH kernel per
    round, then re-run the same targets (repair replaces sources only, indices stay valid).
    Measured on #27099 attempt 3: content-level API errors (MkNe inexistent, Expr vs
    ArithExpr) are exactly what the compiler messages teach back. Returns (kid, conv)."""
    for rnd in range(args.repair_rounds):
        failing = [e for e in (rec.get("execution") or []) if not e.get("ok")]
        if not failing:
            break
        cells_now = _cells(scratch)
        detail = []
        for e in failing:
            i = e.get("cell")
            if not isinstance(i, int) or i >= len(cells_now):
                continue
            detail.append({"idx": i,
                           "source": _text(cells_now[i].get("source"))[-1600:],
                           "errors": _outputs_text(cells_now[i])[-2000:]})
        if not detail:
            break
        env = await sk_call_retry(sk, args, rec, f"{stage}+{rnd}",
                                  repair_prompt(detail, conventions), conv,
                                  max_tokens=BUILD_MAX_TOKENS)
        conv = env.get("conversation_id") or conv
        part, env = await parse_or_repair(sk, args, rec, f"{stage}+{rnd}", env, conv,
                                          max_tokens=BUILD_MAX_TOKENS)
        if not part or not part.get("cells"):
            rec.setdefault("repairs", []).append(
                {"stage": stage, "round": rnd, "verdict": call_failure(env) or "unparsed",
                 "raw_tail": (env.get("response") or "")[-1500:]})
            break
        rep = apply_repairs(scratch, part)
        rec.setdefault("repairs", []).append(
            {"stage": stage, "round": rnd, "asked": len(detail), "replaced": rep["replaced"],
             "unknown_idx": rep["unknown_idx"], "bad": rep["bad"]})
        if not rep["replaced"]:
            break
        await pm_call(pm, "manage_kernel", {"action": "stop", "kernel_id": kid})
        kid = await start_kernel(pm, kname, exec_dir)
        rec["kernel_id"] = kid
        if kid is None:
            rec["verdict"] = "kernel-start-failed"
            break
        rec["execution"] = await execute_cells(pm, scratch, kid, exec_targets)
    return kid, conv


def execution_verdict(rec: dict, scratch: Path) -> None:
    """C.2 proof (execution_count sequential 1..N over non-empty code cells) + the
    execution verdict. A dead kernel keeps its failure verdict, never overwritten."""
    counts = [c.get("execution_count") for c in _cells(scratch)
              if c.get("cell_type") == "code" and _text(c.get("source")).strip()]
    rec["c2"] = {"counts": counts, "sequential": counts == list(range(1, len(counts) + 1))}
    exec_ok = all(e.get("ok") for e in (rec.get("execution") or []))
    if rec.get("verdict") == "kernel-start-failed":
        pass
    elif not exec_ok:
        rec["verdict"] = "built-execution-failed"
    elif not rec.get("execution") or rec["c2"]["sequential"]:
        rec["verdict"] = "built-executed-ok"
    else:
        rec["verdict"] = "built-executed-counts-broken"


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


def gates_then_verify(args, rec: dict, src_nb: Path, built_path: Path, create_mode: bool,
                      kname: str, wt_path: Path, out_dir: Path,
                      prior: dict | None = None) -> None:
    """Stages 3-4, harness-only (no model turn inside). .NET post-execution hygiene runs
    BEFORE anything reads the file: gates and verify judge the DELIVERED state."""
    if args.max_stage >= 3 and rec.get("verdict") == "built-executed-ok" and built_path.is_file():
        if kname.startswith(".net"):
            rec["banner_strip"] = strip_dotnet_banner(
                wt_path / "scripts" / "notebook_tools" / "strip_probe_banner.py", built_path)
        tg = time.time()
        rec["gates"] = run_gates(src_nb, built_path, create_mode=create_mode,
                                 canon_version=(rec.get("create_metadata") or {})
                                 .get("language_version"))
        rec["gates_s"] = round(time.time() - tg, 1)
        bad = [g["gate"] for g in rec["gates"] if not g.get("ok")]
        rec["verdict"] = "gates-ok" if not bad else f"gates-failed:{','.join(bad)}"
    if args.max_stage >= 4 and rec.get("verdict") == "gates-ok":
        stage4_verify(args, rec, src_nb, built_path, out_dir, prior=prior)


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
    for rnd in range(first, first + args.revise_rounds):
        if rec.get("verdict") != "verify-reject":
            break
        findings = [f for f in (rec.get("verify") or {}).get("findings") or []
                    if isinstance(f, dict)]
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
        async with mcp_sessions(out_dir) as (sk, pm):
            env = await sk_call_retry(
                sk, args, rec, f"6-revise+{rnd}",
                revision_prompt(issue, revision_view(built_path), findings, conventions,
                                spec=bool(getattr(args, "from_spec", False))),
                None, max_tokens=BUILD_MAX_TOKENS)
            entry["conversation_id"] = env.get("conversation_id")
            part, env = await parse_or_repair(sk, args, rec, f"6-revise+{rnd}", env, None,
                                              max_tokens=BUILD_MAX_TOKENS)
            if not part or not part.get("cells"):
                entry["result"] = (gate_refusal(env) or call_failure(env) or "unparsed")
                entry["raw_tail"] = (env.get("response") or "")[-1500:]
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
        entry["elapsed_build_s"] = round(time.time() - t0, 1)
        if not applied:
            break                       # the draft is untouched; verdict stays verify-reject
        # No structure re-check: apply_revision never inserts, deletes or re-types a cell,
        # and verify_structure_create would now flag the re-executed outputs as stale.
        entry["exec_verdict"] = rec["verdict"]
        prior = {"round": rnd, "findings": findings, "addressed": entry.get("addressed"),
                 "contested": entry.get("contested")}
        gates_then_verify(args, rec, src_nb, built_path, create_mode, kname, wt_path, out_dir,
                          prior=prior)
        entry["result"] = rec["verdict"]
        if str(rec["verdict"]).startswith("verify-"):
            entry["findings_out"] = len((rec.get("verify") or {}).get("findings") or [])
        entry["elapsed_s"] = round(time.time() - t0, 1)


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
                 "verify", "revisions", "exec_mode", "repo_origin")


async def run_revision(args, rec: dict) -> dict:
    """--revise-from <issue-N.json>: resume a grain the verifier REJECTED without re-paying
    plan and build (IT08 #27460: 22.9 min and 4 calls already spent). Fail-closed before any
    spend: same issue + notebook, a verify-reject verdict, a successful reservation in the
    trace re-read NOW by the scoped claim guard (no new [CLAIMED] comment), and the
    worktree, source/twin and built notebook still on disk."""
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    trace_p = Path(args.revise_from)
    if not trace_p.is_file():
        rec["verdict"] = f"refused-revise-trace-missing:{trace_p}"
        return rec
    prior = json.loads(trace_p.read_text(encoding="utf-8"))
    rec["revised_from"] = {"trace": str(trace_p), "verdict": prior.get("verdict"),
                           "started": prior.get("started")}
    if (prior.get("issue") != args.issue
            or _norm_rel(prior.get("notebook") or "") != _norm_rel(args.notebook)):
        rec["verdict"] = "refused-revise-trace-mismatch"
        return rec
    if prior.get("verdict") != "verify-reject":
        rec["verdict"] = f"refused-revise-not-rejected:{prior.get('verdict')}"
        return rec
    if ((prior.get("stages") or {}).get("claim_reservation") or {}).get("verdict", "x") is not None:
        rec["verdict"] = "refused-revise-no-reservation"
        return rec
    for k in _REVISE_CARRY:
        if k in prior:
            rec[k] = prior[k]
    rec["stages"]["worktree"] = (prior.get("stages") or {}).get("worktree")
    rec["stages"]["claim_reservation"] = (prior.get("stages") or {}).get("claim_reservation")
    wt_path = Path(((prior.get("stages") or {}).get("worktree") or {}).get("path") or "")
    built = Path((prior.get("built_notebook") or {}).get("path") or "")
    src_nb = _prior_src_nb(prior, wt_path, args.notebook)
    exec_dir = Path(prior.get("kernel_cwd") or "")
    for label, p in (("worktree", wt_path), ("built", built), ("source", src_nb),
                     ("kernel-cwd", exec_dir)):
        if not str(p) or not p.exists():
            rec["verdict"] = f"refused-revise-{label}-missing:{p}"
            return rec
    repo = Path(args.repo)
    origin = subprocess.run(["git", "-C", str(repo), "remote", "get-url", "origin"],
                            capture_output=True, text=True).stdout.strip()
    if "jsboige/CoursIA" not in origin and not args.allow_foreign_origin:
        rec["verdict"] = f"refused-foreign-origin:{origin or 'no-origin'}"
        return rec
    rec["stages"]["claim_check"] = check_claim(repo, args.issue, args.lane,
                                               _norm_rel(args.notebook))
    refused = claim_verdict(rec["stages"]["claim_check"])
    if refused:
        rec["verdict"] = refused
        return rec
    token = app_token(repo)
    issue = fetch_issue("jsboige/CoursIA", args.issue, token)
    conventions = read_conventions(args.conventions)
    gate = gate_call(args.gate_mode, getattr(args, "gate", None))
    rec["gate"] = gate
    if gate["blocking_refusal"]:
        rec["verdict"] = "deferred-by-capacity-gate"
        return rec
    create_mode = bool(prior.get("create_mode"))
    args.from_spec = bool((prior.get("create_mode") or {}).get("spec_twin"))
    kname = args.kernel_override or (prior.get("kernel") or {}).get("kernel_name") or ""
    rec["verdict"] = prior["verdict"]
    await revise_loop(args, rec, issue=issue, src_nb=src_nb, built_path=built, kname=kname,
                      exec_dir=exec_dir, conventions=conventions, create_mode=create_mode,
                      wt_path=wt_path, out_dir=out_dir)
    if args.max_stage >= 5 and rec.get("verdict") == "verify-approved":
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
                            capture_output=True, text=True).stdout.strip()
    rec["repo_origin"] = origin
    if "jsboige/CoursIA" not in origin and not args.allow_foreign_origin:
        rec["verdict"] = f"refused-foreign-origin:{origin or 'no-origin'}"
        return rec
    token = app_token(repo)
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
    issue = fetch_issue("jsboige/CoursIA", args.issue, token)
    rec["stages"]["issue"] = {"title": issue["title"], "state": issue["state"],
                              "labels": issue["labels"], "body_chars": len(issue["body"])}
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
    if args.claim:
        rec["stages"]["claim_reservation"] = reserve_claim(
            repo, args.issue, args.lane, args.intention, claim_nb)
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
        if twin_kernel:
            kernel["kernel_name"] = twin_kernel
            kernel["kernel_source"] = "canonical-twin-kernelspec"
            if spec_meta_d:
                kernel["kernel_source"] = "meta-from-kernelspec"
        else:
            # No canonical metadata: the skeleton would carry {} and the language-info gate
            # would fail only AFTER the whole build was paid (claudish PROPOSAL, 20/11).
            # Refuse before the capacity gate and any token; --meta-from is the remedy.
            rec["kernel"] = kernel
            rec["verdict"] = ("create-no-canonical-meta:"
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
            # ---- stage 1 PLAN (correction) / CREATION PLAN (--source-nb)
            t1 = time.time()
            if from_spec:
                prompt = spec_creation_prompt(args.issue, issue, args.notebook, kernel,
                                              series_context(wt_path, args.notebook),
                                              build_view(src_nb), conventions)
            elif create_mode:
                prompt = creation_prompt(args.issue, issue, args.notebook, args.source_nb,
                                         kernel, series_context(wt_path, args.notebook),
                                         build_view(src_nb), conventions)
            else:
                prompt = plan_prompt(args.issue, issue, args.notebook, kernel,
                                     series_context(wt_path, args.notebook),
                                     build_view(src_nb), conventions)
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
                                  else gate_refusal(env)
                                  or f"stage1-{call_failure(env) or 'unparsed'}")
                return rec
            if not plan:
                # a mid-flight gate refusal defers (scheduler retries with backoff),
                # everything else that killed the plan call stays terminal — 18/11
                # wave-1c #27103 burned terminally on exactly this distinction.
                rec["verdict"] = (gate_refusal(env)
                                  or f"stage1-{call_failure(env) or 'unparsed'}")
                return rec
            exec_idx = plan.get("execute_cells") or []

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
            rec["write_mode"] = args.write_mode
            env2: dict = {}                # correction branch fills it; creation never reads it
            if create_mode:
                # from-spec: no prose pin — the [SPEC] cells describe, they are not
                # authoritative text (a twin's prose pin would copy the placeholders).
                built = await create_segments(sk, args, rec, conv, plan.get("cells") or [],
                                              len(src_cells), conventions,
                                              src_cells=None if from_spec else src_cells)
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
                rec["verdict"] = f"build-{call_failure(env2) or 'no-change'}"
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
                    # (state-safe: dependencies run first, execution_count sequential 1..N —
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
                        # ---- markdown prose repair: the foreign-script class caught by
                        # the gate is REPAIRABLE in-session (17/11 #27104 blank pass 2:
                        # Cyrillic/CJK hallucinated inside regenerated French prose —
                        # verify rejected 5 majors). One round, while the sk session is
                        # still open (stage-3 gates run after it closes). Markdown has
                        # no outputs: apply_repairs(allow_markdown=True) replaces the
                        # source only, no kernel cycle. The stage-3 gate re-measures
                        # and stays the judge of what remains.
                        if create_mode and args.repair_rounds > 0:
                            fs_hits = foreign_script_hits(_cells(scratch), src_cells)
                            if fs_hits:
                                detail_md = []
                                for h in fs_hits[:8]:
                                    twin_src = ""
                                    ci = h.get("cell")
                                    if (not from_spec and isinstance(ci, int)
                                            and 0 <= ci < len(src_cells)):
                                        # a [SPEC] placeholder is no prose authority: an
                                        # empty twin_source asks for a clean French rewrite
                                        twin_src = _text(src_cells[ci].get("source"))[:3000]
                                    detail_md.append({"idx": ci,
                                                      "excerpt": h.get("excerpt") or "",
                                                      "twin_source": twin_src})
                                env = await sk_call_retry(
                                    sk, args, rec, "2.6-mdrepair",
                                    md_repair_prompt(detail_md, conventions), conv)
                                conv = env.get("conversation_id") or conv
                                part, env = await parse_or_repair(sk, args, rec,
                                                                  "2.6-mdrepair", env, conv)
                                if part and part.get("cells"):
                                    # Scope the prose round to the cells it asked for
                                    # (finding 1): a response editing any other cell is
                                    # refused, not applied.
                                    _md_idx = {d["idx"] for d in detail_md
                                               if isinstance(d.get("idx"), int)}
                                    rep_md = apply_repairs(scratch, part,
                                                           allow_markdown=True,
                                                           only_idx=_md_idx)
                                    rec.setdefault("md_repairs", []).append(
                                        {"asked": len(detail_md),
                                         "replaced": rep_md["replaced"],
                                         "unknown_idx": rep_md["unknown_idx"],
                                         "bad": rep_md["bad"]})
                                else:
                                    rec.setdefault("md_repairs", []).append(
                                        {"verdict": call_failure(env) or "unparsed",
                                         "raw_tail": (env.get("response") or "")[-1500:]})
                                rec["md_hits_after"] = len(
                                    foreign_script_hits(_cells(scratch), src_cells))
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
    gates_then_verify(args, rec, src_nb, built_path, create_mode, kname_used,
                      Path(wt["path"]), out_dir)
    if rec.get("verdict") == "verify-reject":
        await revise_loop(args, rec, issue=issue, src_nb=src_nb, built_path=built_path,
                          kname=kname_used, exec_dir=exec_dir, conventions=conventions,
                          create_mode=create_mode, wt_path=Path(wt["path"]), out_dir=out_dir)
    if args.max_stage >= 5 and rec.get("verdict") == "verify-approved":
        stage5_pr(args, rec, Path(wt["path"]), built_path, issue, token)
    rec["finished"] = utcnow()
    return rec


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
    """
    missing = [f"{name}={path}" for name, path, ok in (
        ("sk_agent.py (NBCODER_SK_DIR)", SK_DIR / "sk_agent.py", (SK_DIR / "sk_agent.py").is_file()),
        ("NBCODER_SK_PY", SK_PY, SK_PY.is_file()),
        ("NBCODER_SK_CONFIG", SK_CONFIG, SK_CONFIG.is_file()),
        ("NBCODER_PM_PY", PM_PY, PM_PY.is_file()),
        ("NBCODER_PM_CWD", PM_CWD, PM_CWD.is_dir()),
    ) if not ok]
    if not missing:
        return
    detail = "seat wiring does not resolve here — point the env var at a real path: " \
             + " | ".join(missing)
    out_dir = Path(args.out_dir)
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        rec = {"issue": args.issue, "notebook": args.notebook, "started": utcnow(),
               "finished": utcnow(), "lane": args.lane, "dry": True, "calls": [],
               "verdict": "refused-wiring-unresolved",
               "wiring_missing": missing}
        (out_dir / f"issue-{args.issue}.json").write_text(
            json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
        with open(out_dir / "ledger.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps({k: rec.get(k) for k in
                                 ("issue", "notebook", "started", "finished", "verdict", "lane")}
                                | {"calls": 0}, ensure_ascii=False) + "\n")
    except OSError:
        pass          # the refusal must not be masked by a failed trace write
    ap.error(detail)


def main() -> int:
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
    ap.add_argument("--gate-mode", choices=["warn", "block", "off"], default="warn")
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
    ap.add_argument("--verify-timeout", type=int, default=900)
    ap.add_argument("--pr-base", default="main")
    ap.add_argument("--pr-repo", default=None,
                    help="PR target as owner/repo (default: derived from the worktree's "
                         "origin remote; the run refuses with pr-repo-unresolved if "
                         "unparseable -- never a hard-coded fallback)")
    ap.add_argument("--pr-branch", default=None,
                    help="branch name (default nbcoder/auto-<issue>; seat-neutral, "
                         "#433 review)")
    ap.add_argument("--timeout", type=int, default=1500)
    ap.add_argument("--max-tokens", type=int, default=16384)
    ap.add_argument("--repair-rounds", type=int, default=2,
                    help="model repair rounds on real kernel errors (0 disables)")
    ap.add_argument("--revise-rounds", type=int, default=2,
                    help="constructive-review rounds after a verify-reject WITH findings: "
                         "the builder rewrites cells from the findings, the harness "
                         "re-executes, re-gates and re-verifies (0 disables; needs "
                         "--max-stage >= 4)")
    ap.add_argument("--revise-from", default=None,
                    help="resume a REJECTED grain from its issue-<N>.json trace: no new "
                         "plan/build, no new [CLAIMED] comment (the reservation in the "
                         "trace is re-read by the scoped claim guard); runs the review "
                         "loop, then stage 5 if approved and --max-stage 5")
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
    if args.from_spec and args.source_nb:
        ap.error("--from-spec and --source-nb are exclusive: a twin port is --source-nb, "
                 "a new notebook with no twin is --from-spec")
    if args.from_spec and not args.meta_from:
        ap.error("--from-spec requires --meta-from <repo-relative notebook>: the deliverable "
                 "inherits that notebook's kernelspec + language_info (no default kernel)")
    if args.meta_from and not (args.from_spec or args.source_nb or args.revise_from):
        ap.error("--meta-from is only read in creation mode (--from-spec or --source-nb): "
                 "a correction keeps the existing notebook's metadata")
    if args.from_spec and args.write_mode == "mcp":
        ap.error("--from-spec requires --write-mode json (one harness write, like --source-nb)")
    if args.max_stage >= 1:   # stage 0 is git-only: a claim must not require the MCP wiring
        _preflight(ap, args)
    rec = {"issue": args.issue, "notebook": args.notebook, "started": utcnow(),
           "lane": args.lane, "dry": args.max_stage < 5, "stages": {}, "calls": [],
           "engine_tokens_before": engine_tokens()}
    try:
        rec = asyncio.run(run_revision(args, rec) if args.revise_from else run(args, rec))
    except Exception as exc:  # a trace is always written: a dead harness must not look like a quiet one
        # Keep what was already paid for, and keep WHY (F4, vllm#441). Rebuilding rec here threw
        # away the calls, the last stage and the plan: a stage-5 crash produced the same
        # 'calls: 0' trace as a pre-stage-0 one, and str(ExceptionGroup) renders as
        # '(1 sub-exception)' — an operator-visible crash with no operator-readable cause.
        rec["crash"] = {"type": type(exc).__name__, "message": str(exc)[:500],
                        "traceback_tail": traceback.format_exc()[-2000:]}
        rec["verdict"] = f"crashed:{type(exc).__name__}: {str(exc)[:300]}"
        # `dry` is NOT forced here: it says "the run stopped before stage 5", which a crash on
        # --max-stage 5 does not mean (co-review of #442, F4-1). rec already carries the true
        # value from main() — a crash is a crash, not a dry run.
    rec["engine_tokens_after"] = engine_tokens()
    b, a = rec.get("engine_tokens_before") or {}, rec.get("engine_tokens_after") or {}
    rec["engine_tokens_delta"] = {k: round(a[k] - b[k]) for k in a if k in b} or None
    out = Path(args.out_dir) / f"issue-{args.issue}.json"
    if args.revise_from and out.is_file():
        # the trace being revised is usually THIS file: keep it, renamed, never overwritten
        keep = out.with_name(f"issue-{args.issue}.pre-revise-"
                             f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json")
        shutil.copy2(out, keep)
        rec["revised_from"] = (rec.get("revised_from") or {}) | {"kept_as": str(keep)}
    out.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    with open(Path(args.out_dir) / "ledger.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps({k: rec.get(k) for k in
                             ("issue", "notebook", "started", "finished", "verdict", "lane")}
                            | {"stage0_s": rec.get("stage0_s"), "stage1_s": rec.get("stage1_s"),
                               "stage2_s": rec.get("stage2_s"), "stage4_s": rec.get("stage4_s"),
                               "stage5_s": rec.get("stage5_s"),
                               "gate": (rec.get("gate") or {}).get("verdict"),
                               "verify": (rec.get("verify") or {}).get("verdict"),
                               "pr": (rec.get("pr") or {}).get("number"),
                               "calls": len(rec.get("calls") or []),
                               "revisions": len(rec.get("revisions") or []),
                               "revised_from": bool(args.revise_from)},
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