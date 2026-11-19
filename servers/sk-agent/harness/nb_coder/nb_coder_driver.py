#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 231c9ad8e9281ee162fc641a11889fc5600f4827
# original path: myia_vllm/scripts/adoption/nb_coder/nb_coder_driver.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
# Ported 18/11 (po-204): vllm#488 (cae11f0d) + vllm#489 (19744028) cutover pre-review r1+r2 — dispatch ai-01 18/11.
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
    - the post-write re-read cannot confirm OUR scoped claim -- the race window the
      guard's own check-then-post cannot close alone.

    This is NOT an atomic reservation and does not claim to be: the re-read narrows
    the window, and the offline two-client witness (test_nb_coder_claim.py) pins the
    admission contract -- at most one start under contention, zero on a failed post.
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
    """Detached worktree of origin/main: the dirty checkout is never read or touched."""
    if dest.exists() and (dest / ".git").exists() and not fresh:
        head = subprocess.run(["git", "-C", str(dest), "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True).stdout.strip()
        return {"path": str(dest), "reused": True, "head": head}
    subprocess.run(["git", "-C", str(repo), "fetch", "origin", "main"],
                   capture_output=True, text=True, timeout=300)
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
    """Creation mode: kernelspec/language_info of the nearest existing TWIN in the target
    folder. The built notebook inherits the series' canonical metadata (its .NET version),
    never the Python twin's — that is what the language-info gate compares against."""
    d = Path(rel).parent
    for sib in sorted((repo / d).glob("*-CSharp.ipynb")):
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


def parse_json_block(text: str) -> dict | None:
    m = re.findall(r"```json\s*(\{.*?\})\s*```", text, re.S)
    for cand in reversed(m or [text]):
        try:
            return json.loads(cand)
        except Exception:
            continue
    return None


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
    with the missing idx listed."""
    all_cells: list = []
    seg_reports: list = []
    for si in range(0, len(plan_cells), CREATE_SEGMENT):
        seg = plan_cells[si:si + CREATE_SEGMENT]
        env = await sk_call_retry(session, args, rec, f"2-build+{si}",
                                  creation_json_prompt(seg, n_src_cells, conventions,
                                                       src_cells), conv)
        conv = env.get("conversation_id") or conv
        chars_first = len(env.get("response") or "")
        part = parse_json_block(env.get("response") or "")
        got = (part or {}).get("cells") or []
        if not part or not got:
            rec["verdict"] = (f"stage2-{call_failure(env) or 'unparsed'}:{si}"
                              if not part else f"stage2-empty-segment:{si}")
            rec["stage2_raw_tail"] = (env.get("response") or "")[-3000:]
            return {}
        kept, missing = segment_keep_valid(got, seg)
        repair = None
        if missing:
            # one repair round for EXACTLY the omitted cells — same prompt shape,
            # smaller tranche, so the omissions cannot hide in a long answer again
            env = await sk_call_retry(session, args, rec, f"2-build+{si}+repair",
                                      creation_json_prompt(missing, n_src_cells,
                                                           conventions), conv)
            conv = env.get("conversation_id") or conv
            part2 = parse_json_block(env.get("response") or "")
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
async def sk_call(session: ClientSession, args, prompt: str, conv: str | None) -> tuple[dict, float]:
    spec = {"extends": args.agent, "sampling": {"max_tokens": args.max_tokens, "temperature": 0.4}}
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
                        conv: str | None) -> dict:
    for attempt in range(2):
        tob = engine_tokens()
        env, dt = await sk_call(session, args, prompt + (RETRY_NOTE if attempt else ""), conv)
        toa = engine_tokens()
        rec["calls"].append({"stage": stage if not attempt else f"{stage}-retry",
                             "elapsed_s": dt, "error": env.get("error"),
                             # model_used/agent_used: the sk-agent envelope's own proof of what
                             # actually served the call (routing evidence, self-service since
                             # the 15/11 pilot where engine_delta alone had to stand in).
                             "model_used": env.get("model_used"),
                             "agent_used": env.get("agent_used"),
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


def call_failure(env: dict) -> str:
    """Verdict for a model call that never produced an answer, or "" when it answered.

    A 401 or a dead MCP spawn is NOT an 'unreadable response': the model was never asked, so
    reporting stage1-unparsed points the operator at the model instead of at the wiring.
    Measured 16/11 (po-2028:claudish): api_key_env unset -> '401 invalid proxy authentication'
    surfaced as stage1-unparsed with the real cause buried in .calls[0].error (F5, vllm#441).
    """
    err = (env.get("error") or "").strip()
    if not err:
        return ""
    low = err.lower()
    kind = ("auth-failed" if _AUTH_CODE_RE.search(low)
            or any(m in low for m in _AUTH_MARKERS) else "call-failed")
    return f"{kind}: {err[:160]}"


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
    """The harness owns execution and the verdict: real outputs, never the model's word."""
    results = []
    for idx in indexes:
        r = await pm_call(pm, "execute_on_kernel", {"kernel_id": kernel_id, "mode": "notebook_cell",
                                                    "path": str(nb_path), "cell_index": idx,
                                                    "timeout": 300})
        status = r.get("status") or r.get("error") or "?"
        outs = r.get("outputs") or []
        err_txt = " ".join(str(o.get("text") or o.get("ename") or "") for o in outs
                           if isinstance(o, dict) and o.get("output_type") == "error")
        results.append({"cell": idx, "status": status, "ok": status == "ok" and not err_txt,
                        "elapsed_s": r.get("execution_time") or r.get("elapsed_s"),
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
    return gates


def strip_dotnet_banner(tool: Path, nb_path: Path) -> dict:
    """Post-execution hygiene the CoursIA issues mandate verbatim: any .NET Interactive
    re-execution injects a probeAddresses JS banner into cell outputs, and
    `scripts/notebook_tools/strip_probe_banner.py --apply <nb>` must run BEFORE commit
    (the canonical-kernel criterion). 17/11 #27104 blank pass: the verify rejected the
    banner as a MAJOR finding. The tool lives in the CoursIA tree (the worktree carries
    it); a missing tool or failure is RECORDED, not fatal — the verify stays the judge
    of the delivered file."""
    if not tool.is_file():
        return {"ok": False, "error": f"strip tool absent: {tool}"}
    try:
        p = subprocess.run([sys.executable, str(tool), "--apply", str(nb_path)],
                           capture_output=True, text=True, timeout=120)
        return {"ok": p.returncode == 0, "rc": p.returncode,
                "out": (p.stdout or p.stderr or "")[-500:]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "strip tool timeout"}


def stage4_verify(args, rec: dict, src_nb: Path, built_nb: Path, out_dir: Path) -> None:
    """Stage 4 — the independent verifier runs as a SEPARATE process and agent
    (producer != verifier, global rule). nb_coder_verify.py exits 0 approve /
    1 reject / 2 instrument error — an error is NEVER read as a reject."""
    facts = out_dir / f"facts-{args.issue}.json"
    facts.write_text(json.dumps(
        {k: rec.get(k) for k in ("plan", "apply", "structure", "exec_mode", "c2",
                                 "execution", "conversation_id")}, ensure_ascii=False),
        encoding="utf-8")
    cmd = [sys.executable, str(HERE / "nb_coder_verify.py"),
           "--issue", str(args.issue), "--source-nb", str(src_nb), "--built-nb", str(built_nb),
           "--facts", str(facts), "--agent", args.verifier_agent,
           "--out-dir", str(out_dir), "--timeout", str(args.verify_timeout)]
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
    trace = out_dir / f"verify-{args.issue}.json"
    if trace.is_file():
        t = json.loads(trace.read_text(encoding="utf-8"))
        entry |= {"verdict": t.get("verdict"), "model_used": t.get("model_used"),
                  "findings": (t.get("answer") or {}).get("findings"),
                  "conversation_id": t.get("conversation_id")}
    rec["verify"] = entry
    rec["stage4_s"] = entry["elapsed_s"]
    if rc == 0 and entry.get("verdict") == "approve":
        rec["verdict"] = "verify-approved"
    elif rc == 1 and entry.get("verdict") == "reject":
        rec["verdict"] = "verify-reject"
    else:
        rec["verdict"] = "verify-error"


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


def _short_desc(args, plan: dict) -> str:
    """One-line gesture description composed from the plan's own 'but' fields —
    harness-only, no model turn. House form: '<notebook stem> cell N — <but>'."""
    stem = Path(args.notebook).stem
    gestes = [g for g in (plan.get("plan") or []) if isinstance(g, dict)]
    if len(gestes) == 1 and gestes[0].get("geste") == "edit" and str(gestes[0].get("cell")).isdigit():
        but = _text(gestes[0].get("but")).strip()
        return f"{stem} cell {gestes[0]['cell']} — {but}"[:140] or f"{stem} — edit"
    kinds = ",".join(sorted({str(g.get("geste")) for g in gestes})) or "edit"
    return f"{stem} — {len(gestes)} gestes ({kinds})" if gestes else f"{stem} — {kinds}"


def stage5_pr(args, rec: dict, wt_path: Path, built_nb: Path, issue: dict,
              token: str | None) -> None:
    """Stage 5 — harness-only GitHub gestures: the model never writes to git or GitHub.
    Fresh branch off the detached worktree, single-notebook commit, REST PR create,
    delivery comment on the issue."""
    t0 = time.time()
    nb_rel = args.notebook.replace("\\", "/")
    branch = args.pr_branch or f"nbcoder/auto-{args.issue}"
    desc = _short_desc(args, rec.get("plan") or {})
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
        + f"\nExécution : kernel {rec.get('kernel', {}).get('kernel_name')}, "
        f"{len(rec.get('execution') or [])} cellules exécutées, C.2 "
        f"{'séquentiel' if (rec.get('c2') or {}).get('sequential') else 'BROKEN'}."
        + "\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>")
    msg_file = built_nb.parent / f"commit-msg-{args.issue}.txt"
    msg_file.write_text(commit_body, encoding="utf-8")
    rc, out = _git(wt_path, "commit", "--file", str(msg_file))
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
    pr_body = (
        f"Grain: auto/notebook-python — lane {args.lane} — issue #{args.issue}\n\n"
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
        f"- **Trace** : conversation producteur `{rec.get('conversation_id')}`, "
        f"conversation vérificateur `{(rec.get('verify') or {}).get('conversation_id')}`, "
        f"run record complet dans le out-dir du harnais.\n\n"
        f"Closes #{args.issue}\n\n"
        "🤖 Generated with [Claude Code](https://claude.com/claude-code)")
    # #433 review: resolve the PR target from the worktree's own origin (or an explicit
    # --pr-repo); never a hard-coded repo. Refusing loudly beats silently targeting the
    # wrong repo -- a wrong-repo PR number recorded in a [DELIVERED] marker poisons the
    # claim registry.
    repo_slug = args.pr_repo or _repo_slug(wt_path)
    if not repo_slug:
        entry["error"] = ("cannot resolve PR target repo (no --pr-repo, origin URL "
                          "unparseable) -- pass --pr-repo owner/repo explicitly")
        rec["verdict"], rec["pr"] = "pr-repo-unresolved", entry
        return
    entry["repo"] = repo_slug
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
    if args.claim:
        rec["stages"]["claim_reservation"] = reserve_claim(
            repo, args.issue, args.lane, args.intention, claim_nb)
        if rec["stages"]["claim_reservation"]["verdict"]:
            rec["verdict"] = rec["stages"]["claim_reservation"]["verdict"]
            return rec
    wt = prepare_worktree(repo, Path(args.worktree), args.fresh_worktree)
    rec["stages"]["worktree"] = wt
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
    if target_nb.is_file():
        if args.source_nb:
            # both present: an operator typo would silently CORRECT the twin instead of
            # creating the target — refuse loud.
            rec["verdict"] = f"target-already-exists:{args.notebook}"
            return rec
    elif args.source_nb:
        src_nb = wt_path / args.source_nb
        if not src_nb.is_file():
            rec["verdict"] = f"source-nb-not-found:{src_nb}"
            return rec
        create_mode = True
        rec["create_mode"] = {"source": args.source_nb, "target": args.notebook}
    else:
        rec["verdict"] = f"notebook-not-found:{target_nb}"
        return rec
    kernel = series_kernel(wt_path, args.notebook)
    rec["kernel"] = kernel
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
            await sk.initialize()
            await pm.initialize()
            # ---- stage 1 PLAN (correction) / CREATION PLAN (--source-nb)
            t1 = time.time()
            if create_mode:
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
            plan = parse_json_block(env.get("response") or "")
            rec["plan"] = plan
            if not plan:
                # raw tail persisted for offline diagnosis (17/11: the unparsed 16 268-char
                # retry left only response_chars — no way to see WHERE parsing broke)
                rec["stage1_raw_tail"] = (env.get("response") or "")[-3000:]
            rec["stage1_s"] = round(time.time() - t1, 1)
            if args.max_stage < 2:
                rec["verdict"] = ("stage1-only" if plan
                                  else f"stage1-{call_failure(env) or 'unparsed'}")
                return rec
            if not plan:
                rec["verdict"] = f"stage1-{call_failure(env) or 'unparsed'}"
                return rec
            exec_idx = plan.get("execute_cells") or []

            # ---- stage 2 BUILD (correction: copy of the target) / CREATION (skeleton + all cells)
            t2 = time.time()
            scratch = Path(scratch_nb)
            if scratch.exists():
                scratch.unlink()
            if create_mode:
                meta = series_canonical_meta(wt_path, args.notebook)
                rec["create_metadata"] = {"kernelspec": (meta.get("kernelspec") or {}).get("name"),
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
                built = await create_segments(sk, args, rec, conv, plan.get("cells") or [],
                                              len(src_cells), conventions,
                                              src_cells=src_cells)
                rec["build_model_answer"] = {"parsed": bool(built),
                                             "segments": rec.pop("segments", [])}
                if built:
                    rec["apply"] = apply_create(scratch, built)
                elif not rec.get("verdict"):
                    rec["verdict"] = "build-no-cells"
                if rec.get("verdict"):     # a failed segment returns NOW (tail persisted)
                    rec["stage2_s"] = round(time.time() - t2, 1)
                    return rec
            else:
                prompt2 = (build_json_prompt(plan, exec_idx, src_cells, len(src_cells), conventions)
                           if args.write_mode == "json"
                           else build_prompt(scratch_nb, plan, exec_idx, src_cells,
                                             len(src_cells), conventions))
                env2 = await sk_call_retry(sk, args, rec, "2-build", prompt2, conv)
                built = parse_json_block(env2.get("response") or "")
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
                                             src_nb.parent)
                    rec["kernel_id"] = kid
                    rec["kernel_cwd"] = str(src_nb.parent)
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
                        # ---- repair loop: the REAL kernel errors go back to the model
                        # (max --repair-rounds, same conversation). A repaired definition
                        # can change downstream semantics -> FRESH kernel per round, then
                        # re-run the same targets (repair replaces sources only, indices
                        # stay valid). Measured on #27099 attempt 3: content-level API
                        # errors (MkNe inexistent, Expr vs ArithExpr) are exactly what
                        # the compiler messages teach back.
                        if exec_targets and rec.get("execution") and args.repair_rounds > 0:
                            kname = args.kernel_override or kernel["kernel_name"]
                            for rnd in range(args.repair_rounds):
                                failing = [e for e in (rec.get("execution") or [])
                                           if not e.get("ok")]
                                if not failing:
                                    break
                                cells_now = _cells(scratch)
                                detail = []
                                for e in failing:
                                    i = e.get("cell")
                                    if not isinstance(i, int) or i >= len(cells_now):
                                        continue
                                    detail.append({
                                        "idx": i,
                                        "source": _text(cells_now[i].get("source"))[-1600:],
                                        "errors": _outputs_text(cells_now[i])[-2000:]})
                                if not detail:
                                    break
                                env = await sk_call_retry(
                                    sk, args, rec, f"2.5-repair+{rnd}",
                                    repair_prompt(detail, conventions), conv)
                                conv = env.get("conversation_id") or conv
                                part = parse_json_block(env.get("response") or "")
                                if not part or not part.get("cells"):
                                    rec.setdefault("repairs", []).append(
                                        {"round": rnd,
                                         "verdict": call_failure(env) or "unparsed",
                                         "raw_tail": (env.get("response") or "")[-1500:]})
                                    break
                                rep = apply_repairs(scratch, part)
                                rec.setdefault("repairs", []).append(
                                    {"round": rnd, "asked": len(detail),
                                     "replaced": rep["replaced"],
                                     "unknown_idx": rep["unknown_idx"],
                                     "bad": rep["bad"]})
                                if not rep["replaced"]:
                                    break
                                await pm_call(pm, "manage_kernel",
                                              {"action": "stop", "kernel_id": kid})
                                kid = await start_kernel(pm, kname, src_nb.parent)
                                rec["kernel_id"] = kid
                                if kid is None:
                                    rec["verdict"] = "kernel-start-failed"
                                    break
                                rec["execution"] = await execute_cells(
                                    pm, scratch, kid, exec_targets)
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
                                    if isinstance(ci, int) and 0 <= ci < len(src_cells):
                                        twin_src = _text(src_cells[ci].get("source"))[:3000]
                                    detail_md.append({"idx": ci,
                                                      "excerpt": h.get("excerpt") or "",
                                                      "twin_source": twin_src})
                                env = await sk_call_retry(
                                    sk, args, rec, "2.6-mdrepair",
                                    md_repair_prompt(detail_md, conventions), conv)
                                conv = env.get("conversation_id") or conv
                                part = parse_json_block(env.get("response") or "")
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
                    counts = [c.get("execution_count") for c in _cells(scratch)
                              if c.get("cell_type") == "code"
                              and _text(c.get("source")).strip()]
                    rec["c2"] = {"counts": counts,
                                 "sequential": counts == list(range(1, len(counts) + 1))}
                    exec_ok = all(e.get("ok") for e in (rec.get("execution") or []))
                    if rec.get("verdict") == "kernel-start-failed":
                        pass   # a dead kernel keeps its failure verdict, never overwritten
                    elif not exec_ok:
                        rec["verdict"] = "built-execution-failed"
                    elif not rec.get("execution") or rec["c2"]["sequential"]:
                        rec["verdict"] = "built-executed-ok"
                    else:
                        rec["verdict"] = "built-executed-counts-broken"
            rec["stage3_s"] = round(time.time() - t3, 1)

    # ---- stages 3-5: harness-only (no model turn inside these)
    built_path = Path((rec.get("built_notebook") or {}).get("path") or "")
    if args.max_stage >= 3 and rec.get("verdict") == "built-executed-ok" and built_path.is_file():
        # .NET post-execution hygiene BEFORE anything reads the file: gates and verify
        # must judge the DELIVERED state (issue-mandated strip, see strip_dotnet_banner)
        kname_used = args.kernel_override or kernel["kernel_name"]
        if kname_used.startswith(".net"):
            rec["banner_strip"] = strip_dotnet_banner(
                Path(wt["path"]) / "scripts" / "notebook_tools" / "strip_probe_banner.py",
                built_path)
        tg = time.time()
        rec["gates"] = run_gates(src_nb, built_path, create_mode=create_mode,
                                 canon_version=(rec.get("create_metadata") or {})
                                 .get("language_version"))
        rec["gates_s"] = round(time.time() - tg, 1)
        bad = [g["gate"] for g in rec["gates"] if not g.get("ok")]
        rec["verdict"] = "gates-ok" if not bad else f"gates-failed:{','.join(bad)}"
    if args.max_stage >= 4 and rec.get("verdict") == "gates-ok":
        stage4_verify(args, rec, src_nb, built_path, out_dir)
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
    if args.max_stage >= 1:   # stage 0 is git-only: a claim must not require the MCP wiring
        _preflight(ap, args)
    rec = {"issue": args.issue, "notebook": args.notebook, "started": utcnow(),
           "lane": args.lane, "dry": args.max_stage < 5, "stages": {}, "calls": [],
           "engine_tokens_before": engine_tokens()}
    try:
        rec = asyncio.run(run(args, rec))
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
                               "calls": len(rec.get("calls") or [])}, ensure_ascii=False) + "\n")
    print(json.dumps({k: rec.get(k) for k in
                      ("issue", "verdict", "stage0_s", "stage1_s", "stage2_s", "stage4_s",
                       "stage5_s", "kernel_id")}
                     | {"verify": (rec.get("verify") or {}).get("verdict"),
                        "pr": (rec.get("pr") or {}).get("number")}, ensure_ascii=False))
    return 0 if rec.get("verdict", "").endswith(
        ("ok", "stage0-only", "stage1-only", "verify-approved", "pr-created")) else 1


if __name__ == "__main__":
    sys.exit(main())