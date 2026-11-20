#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 0a301594f2c57519e48251cefdabea483c9f918e
# original path: myia_vllm/scripts/adoption/nb_audit/nb_audit_driver.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Light harness for the CoursIA #17073 notebook audit on the local model, through sk-agent.

Everything deterministic lives here: the notebook view, the organ pass, the series
context, the verbatim validation of findings, the ledger and resume. The model (sk-agent
agent ``notebook-auditor``, Qwen3.6 on ai-01:5002) judges in two rounds around a stage the
harness owns:

  A. the model reads the notebook, lists candidate findings and writes one
     self-contained Python script per checkable claim;
  B. the harness runs those scripts (the model is not trusted to call its tools: in
     pilot 1 it claimed "verified" on 8/9 notebooks without a single tool call);
  C. same conversation, the model keeps only what the outputs confirm.

Pilot mode is dry: nothing is written to GitHub. Findings land in --out-dir.

Run with the sk-agent venv python (it carries the ``mcp`` client package):
    d:/roo-extensions/mcps/internal/servers/sk-agent/venv/Scripts/python.exe \
        nb_audit_driver.py --repo d:/dev/CoursIA-skaudit --out-dir <dir> \
        --concurrency 4 NB_PATH [NB_PATH ...]
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HERE = Path(__file__).resolve().parent


def _sk_dir() -> Path:
    """Where the sk-agent checkout lives (roo-extensions #4781: no seat binding in the tree).
    Order: NB_AUDIT_SK_DIR env, then the sibling layout the harness has once it lives at
    servers/sk-agent/harness/nb_audit/ (its sk-agent root is ../.., recognised by sk_agent.py
    so an unrelated ../.. cannot shadow it), then the legacy absolute path kept for the live
    vllm task until the cutover."""
    env = os.environ.get("NB_AUDIT_SK_DIR")
    if env:
        return Path(env)
    sibling = (HERE / "../..").resolve()
    if (sibling / "sk_agent.py").is_file():
        return sibling
    return Path("d:/roo-extensions/mcps/internal/servers/sk-agent")


SK_DIR = _sk_dir()
SK_PY = Path(os.environ.get("NB_AUDIT_SK_PY", str(SK_DIR / "venv/Scripts/python.exe")))
SK_CONFIG = Path(os.environ.get("NB_AUDIT_SK_CONFIG", str(SK_DIR / "sk_agent_config.json")))

# the six organs #17073 makes mandatory before any finding
ORGANS = [
    ("duplicate_sections", ["check_duplicate_sections.py", "{nb}", "--json"]),
    ("split_reading_cells", ["check_split_reading_cells.py", "{nb}", "--json"]),
    ("interp_positioning", ["check_interp_positioning.py", "{nb}", "--json"]),
    ("output_failure_text", ["check_output_failure_text.py", "{nb}", "--json"]),
    ("cell_source_parses", ["check_cell_source_parses.py", "{nb}", "--json"]),
    ("accents", ["restore_accents_canonical.py", "{nb}", "--check"]),
]

CLASSES = {
    "solution-leak", "block-pasted-wrong-section", "reading-before-code", "orphan-statement",
    "navigation-misplaced", "paraphrase-stack", "progression-break", "stale-claim",
    "prerequisite-gap", "concept-ordering", "difficulty-jump", "output-uninterpreted",
    "figure-unlabelled", "figure-missing", "wall-of-text", "exercise-mismatch",
}

OUT_HEAD, OUT_TAIL = 1500, 500
# organs run on the system python, not the sk-agent venv this driver runs in
ORGAN_PY = shutil.which("python") or "python"
# verification scripts run in a dedicated venv (numpy, scipy, networkx, pandas, z3, matplotlib,
# sympy, pulp) so the host python stays untouched; falls back to the organ interpreter
VERIF_PY_DEFAULT = Path(os.environ.get("LOCALAPPDATA", "")) / "nbaudit/verif-venv/Scripts/python.exe"


def _text(x) -> str:
    return "".join(x) if isinstance(x, list) else (x or "")


def _clip(s: str) -> tuple[str, bool]:
    if len(s) <= OUT_HEAD + OUT_TAIL:
        return s, False
    return s[:OUT_HEAD] + f"\n[... {len(s) - OUT_HEAD - OUT_TAIL} caractères tronqués ...]\n" + s[-OUT_TAIL:], True


def build_view(nb_path: Path, img_dir: Path) -> tuple[str, dict, dict, dict]:
    """Render the notebook as text; return (view, cell_texts_by_id, index_to_id, profile)."""
    nb = json.loads(nb_path.read_text(encoding="utf-8"))
    parts, cell_texts, index_to_id = [], {}, {}
    n_md = n_code = n_img = n_trunc = 0
    for i, cell in enumerate(nb.get("cells", [])):
        cid = cell.get("id") or f"idx{i}"
        index_to_id[i] = cid
        ctype = cell.get("cell_type")
        src = _text(cell.get("source"))
        full = [src]
        if ctype == "markdown":
            n_md += 1
            parts.append(f"=== cellule {i} | id={cid} | markdown ===\n{src}")
            cell_texts[cid] = src
            continue
        n_code += 1
        block = [f"=== cellule {i} | id={cid} | code (exec={cell.get('execution_count')}) ===\n{src}"]
        for k, out in enumerate(cell.get("outputs", []) or []):
            otype = out.get("output_type")
            if otype == "stream":
                t = _text(out.get("text"))
            elif otype in ("execute_result", "display_data"):
                data = out.get("data", {})
                t = _text(data.get("text/plain"))
                for mime in ("image/png", "image/jpeg"):
                    if mime in data:
                        ext = "png" if mime.endswith("png") else "jpg"
                        img = img_dir / f"{cid}_{k}.{ext}"
                        img.write_bytes(base64.b64decode(_text(data[mime])))
                        n_img += 1
                        t += f"\n[figure {mime} enregistrée : {img}]"
            elif otype == "error":
                t = f"{out.get('ename')}: {out.get('evalue')}"
            else:
                continue
            full.append(t)
            shown, cut = _clip(t)
            n_trunc += cut
            block.append(f"--- sortie {k} ({otype}) ---\n{shown}")
        parts.append("\n".join(block))
        cell_texts[cid] = "\n".join(full)
    profile = {"cells": n_md + n_code, "markdown": n_md, "code": n_code,
               "figures": n_img, "outputs_truncated": n_trunc}
    return "\n\n".join(parts), cell_texts, index_to_id, profile


def series_context(repo: Path, rel: str, max_headers: int = 12) -> str:
    """Headers of the notebooks that precede this one in its directory."""
    d = str(Path(rel).parent).replace("\\", "/")
    names = subprocess.run(["git", "-C", str(repo), "ls-files", "-z", f"{d}/*.ipynb"],
                           capture_output=True, text=True, encoding="utf-8").stdout.split("\0")
    names = sorted(n for n in names if n and "/" not in n[len(d) + 1:])
    me = rel.replace("\\", "/")
    lines = [f"Série {d} — {len(names)} notebooks ; celui-ci est en position "
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


def organ_pass(repo: Path, rel: str) -> dict:
    res = {}
    for name, argv in ORGANS:
        cmd = [ORGAN_PY, str(repo / "scripts/notebook_tools" / argv[0])]
        cmd += [a.replace("{nb}", rel) for a in argv[1:]]
        try:
            p = subprocess.run(cmd, cwd=repo, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=120)
            res[name] = (p.stdout or p.stderr).strip()[:1500]
        except subprocess.TimeoutExpired:
            res[name] = "TIMEOUT"
    return res


def _norm(s: str) -> str:
    s = s.replace("’", "'").replace("«", '"').replace("»", '"').replace("“", '"').replace("”", '"')
    s = s.replace("`", "").replace("*", "")  # markdown emphasis is not part of the words
    return re.sub(r"\s+", " ", s).strip().lower()


def _resolve_cell(c, cell_texts: dict, index_to_id: dict):
    """Accept an id, an index (5, "5", "cell 5", "MD[5]") or an idxN placeholder."""
    c = str(c).strip()
    if c in cell_texts:
        return c
    m = re.fullmatch(r"(?:cellule|cell|md|code)?\s*\[?\s*(\d+)\s*\]?", c, re.I)
    if m and int(m.group(1)) in index_to_id:
        return index_to_id[int(m.group(1))]
    return None


def validate(findings: list, cell_texts: dict, index_to_id: dict) -> list:
    """Mechanical Parade 2: cells exist, extract is verbatim, cell attribution is repaired."""
    out = []
    for f in findings if isinstance(findings, list) else [findings]:
        if not isinstance(f, dict):
            out.append({"raw": f, "valid": False, "rejections": ["not-an-object"]})
            continue
        reasons, note = [], None
        raw = f.get("cellules") or []
        raw = [raw] if isinstance(raw, (str, int)) else raw
        cells = [_resolve_cell(c, cell_texts, index_to_id) for c in raw]
        missing = [str(c) for c, r in zip(raw, cells) if r is None]
        cells = [c for c in cells if c]
        if not raw:
            reasons.append("no-cell")
        if missing:
            reasons.append(f"unknown-cell:{','.join(missing)}")
        if f.get("classe") not in CLASSES:
            reasons.append(f"bad-class:{f.get('classe')}")
        if not (f.get("pourquoi") or "").strip():
            reasons.append("no-why")
        frags = [x for x in re.split(r"…|\.\.\.|\[\.\.\.\]| / ", f.get("extrait") or "")
                 if len(_norm(x)) >= 12]
        if not frags:
            reasons.append("no-extract")
        for fr in frags:
            nf = _norm(fr).strip("\"' ")
            if nf in _norm("\n".join(cell_texts.get(c, "") for c in cells)):
                continue
            hosts = [cid for cid, t in cell_texts.items() if nf in _norm(t)]
            if hosts:  # right words, wrong cell: repair the attribution, keep the finding
                cells = list(dict.fromkeys(cells + hosts[:1]))
                reasons = [r for r in reasons if not r.startswith("unknown-cell")]
                note = f"relocated-to:{hosts[0]}"
                continue
            reasons.append("extract-not-verbatim")
            break
        out.append({**f, "cellules": cells or raw, "valid": not reasons, "rejections": reasons,
                    **({"note": note} if note else {})})
    return out


def parse_json_block(text: str) -> dict | None:
    m = re.findall(r"```json\s*(\{.*?\})\s*```", text, re.S)
    for cand in reversed(m or [text]):
        try:
            return json.loads(cand)
        except Exception:
            continue
    return None


def parse_verifs(text: str) -> list[dict]:
    """```python blocks whose first line is '# VERIF V<n> | cellules: ... | affirmation: ...'."""
    out = []
    for code in re.findall(r"```python[^\n]*\n(.*?)```", text, re.S):
        m = re.match(r"\s*#\s*VERIF\s+(\w+)\s*(.*)", code)
        if m:
            out.append({"id": m.group(1), "header": m.group(2).strip(" |")[:300], "code": code})
    return out


def run_verifs(verifs: list[dict], work: Path, py: str, limit_s: int = 90) -> list[dict]:
    """Stage B: the harness, not the model, executes every verification script."""
    work.mkdir(parents=True, exist_ok=True)
    res = []
    for v in verifs:
        f = work / f"verif_{v['id']}.py"
        f.write_text(v["code"], encoding="utf-8")
        t0 = time.time()
        try:
            p = subprocess.run([py, f.name], cwd=work, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=limit_s,
                               env={**os.environ, "PYTHONIOENCODING": "utf-8", "MPLBACKEND": "Agg"})
            err = "\n[stderr]\n" + p.stderr if p.stderr.strip() else ""
            rc, out, so, se = p.returncode, p.stdout + err, p.stdout, p.stderr
        except subprocess.TimeoutExpired:
            rc, out, so, se = "TIMEOUT", f"interrompu après {limit_s} s", "", ""
        # the reviewing bot reads the whole script statically: a (script, output) pair can be
        # self-consistent and still wrong, so the verdict alone is never the evidence. stderr is
        # kept apart: a script that dies quietly must not pass for one that ran clean
        res.append({"id": v["id"], "header": v["header"], "code": v["code"], "rc": rc,
                    "elapsed_s": round(time.time() - t0, 1), "output": out[-2500:],
                    "output_chars": len(out), "stdout_tail": so[-2000:], "stderr_tail": se[-2000:]})
    return res


def notebook_fingerprint(repo: Path, rel: str) -> dict:
    """sha256 + commit + date of the audited file: a dossier without them goes stale at the next push."""
    import hashlib

    def git(*a):
        p = subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        return p.stdout.strip() if p.returncode == 0 else None

    last = git("log", "-1", "--format=%H %cI", "--", rel)
    commit, date = (last.split(" ", 1) + [None])[:2] if last else (None, None)
    return {"sha256": hashlib.sha256((repo / rel).read_bytes()).hexdigest(),
            "head": git("rev-parse", "HEAD"), "last_commit": commit, "last_commit_date": date,
            "dirty": bool(git("status", "--porcelain", "--", rel))}


def link_verifs(findings: list, verifs: list) -> list:
    """Resolve each finding's free-text "verification" to the ids of the scripts that ran."""
    ran = {v["id"] for v in verifs}
    for f in findings:
        if isinstance(f, dict):
            cited = re.findall(r"\bV\d+\b", str(f.get("verification") or ""))
            f["verif_ids"] = [v for v in dict.fromkeys(cited) if v in ran]
    return findings


def build_prompt(rel: str, view: str, ctx: str, organs: dict, profile: dict, work: Path) -> str:
    org = "\n".join(f"- {k} : {v[:600]}" for k, v in organs.items())
    return (f"Audite le notebook `{rel}` (campagne #17073). TOUR 1.\n\n"
            f"Chemin local (lecture seule) : d:/dev/CoursIA-skaudit/{rel}\n"
            f"Dossier de travail (le seul où écrire) : {work.as_posix()}\n"
            f"Profil : {json.dumps(profile, ensure_ascii=False)}\n\n"
            "## Règle de lecture (HARD)\n"
            "La vue intégrée ci-dessous est la source de vérité de l'audit. Ne lis JAMAIS le fichier "
            ".ipynb brut avec read_notebook/read_file sans argument de plage : les notebooks Image/ "
            "embarquent leurs sorties en base64 (jusqu'à des dizaines de Mo) et le résultat de l'outil "
            "dépasse la fenêtre de contexte (400, vécu 10/10). Si tu dois relire une cellule précise, "
            "utilise une lecture par plage bornée (offset/length) sur la cellule ciblée.\n\n"
            f"## Contexte de série (titres des notebooks précédents)\n{ctx}\n\n"
            f"## Passe d'organes (déjà faite — ce qu'elle signale n'est PAS un finding)\n{org}\n\n"
            f"## Notebook complet\n{view}\n\n"
            "Rends le TOUR 1 demandé par tes instructions : le bloc ```json des candidats, "
            "puis un bloc ```python par vérification.")


def build_round2(results: list[dict]) -> str:
    if not results:
        body = "(aucune vérification fournie au tour 1)"
    else:
        body = "\n\n".join(f"### {r['id']} — {r['header']}\nrc={r['rc']} ({r['elapsed_s']} s)\n{_clip(str(r['output']))[0]}"
                           for r in results)
    return ("TOUR 2. Le harnais a exécuté tes vérifications ; voici les résultats bruts.\n\n"
            f"{body}\n\n"
            "Finalise : garde un candidat calculable seulement si un résultat ci-dessus le confirme ; "
            "retire ceux que les résultats infirment ou n'établissent pas ; ajoute tout défaut qu'un "
            "MISMATCH révèle. Une vérification en erreur ne confirme rien. "
            "Rends l'unique bloc ```json de SORTIE (format final de tes instructions).")


async def _call(session: ClientSession, args, prompt: str, conv: str | None,
                attach: list[str] | None = None) -> tuple[dict, float]:
    spec = {"extends": args.agent, "sampling": {"max_tokens": args.max_tokens, "temperature": 0.6}}
    payload = {"prompt": prompt, "agent": args.agent, "timeout": args.timeout,
               "include_steps": True, "agent_spec": json.dumps(spec)}
    if conv:
        payload["conversation_id"] = conv
    if attach:  # sk-agent takes a JSON list of paths; prod accepts 4 images per prompt
        payload["attachment"] = json.dumps(attach)
    t0 = time.time()
    try:
        res = await session.call_tool("call_agent", payload,
                                      read_timeout_seconds=timedelta(seconds=args.timeout + 120))
        raw = "\n".join(getattr(c, "text", "") for c in res.content)
    except Exception as exc:  # timeouts and transport errors are recorded, not fatal
        raw = json.dumps({"error": f"{type(exc).__name__}: {exc}"})
    try:
        env = json.loads(raw)
    except Exception:
        env = {"response": raw}
    return env, round(time.time() - t0, 1)


# empty answers: pilot 1 2/11, pilot 2 1/11 (127 s, far from max_tokens) - cause not established;
# one retry asking for shorter reasoning recovered the pilot-2 case
RETRY_NOTE = ("\n\nNB : une tentative précédente n'a rien rendu. "
              "Réfléchis plus court (quelques centaines de mots), puis rends directement ta sortie.")


async def _call_retry(session, args, rec, stage, prompt, conv, attach=None):
    for attempt in range(2):
        env, dt = await _call(session, args, prompt + (RETRY_NOTE if attempt else ""), conv, attach)
        rec["calls"].append({"stage": stage, "elapsed_s": dt, "error": env.get("error"),
                             "steps": len(env.get("steps") or [])})
        if not (env.get("error") or "").startswith("empty model response"):
            break
    return env


def _slug(rel: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", rel)[-120:]


async def audit_one(session: ClientSession, sem: asyncio.Semaphore, args, rel: str) -> dict:
    done = Path(args.out_dir) / f"{_slug(rel)}.json"
    if done.exists():
        rec = json.loads(done.read_text(encoding="utf-8"))
        if rec.get("parsed"):
            print(f"[  skip ] {rel} (already audited {rec.get('started')})", flush=True)
            return rec
    try:
        return await _audit_one(session, sem, args, rel)
    except Exception as exc:  # one notebook never takes the batch down
        print(f"[ crash ] {rel} {type(exc).__name__}: {exc}", flush=True)
        return {"notebook": rel, "parsed": False, "error": f"{type(exc).__name__}: {exc}", "verifs": []}


async def _audit_one(session: ClientSession, sem: asyncio.Semaphore, args, rel: str) -> dict:
    async with sem:
        repo, out = Path(args.repo), Path(args.out_dir)
        slug = _slug(rel)
        img_dir = out / "images" / slug
        img_dir.mkdir(parents=True, exist_ok=True)
        work = Path(args.work_root) / slug
        work.mkdir(parents=True, exist_ok=True)
        view, cell_texts, index_to_id, profile = build_view(repo / rel, img_dir)
        organs = organ_pass(repo, rel)
        prompt = build_prompt(rel, view, series_context(repo, rel), organs, profile, work)
        # the committed figures go to the model's vision, in notebook order, up to the prod limit
        figs = re.findall(r"\[figure image/\w+ enregistrée : ([^\]]+)\]", view)[:args.max_figures]
        if figs:
            prompt += ("\n\nFigures jointes, dans l'ordre : "
                       + ", ".join(Path(f).stem for f in figs)
                       + " (nom = <id de cellule>_<n° de sortie>). Confronte chacune à la prose qui la commente.")
        rec = {"notebook": rel, "started": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "fingerprint": notebook_fingerprint(repo, rel), "profile": profile,
               "prompt_chars": len(prompt), "organs": organs, "calls": [],
               "figures_attached": [Path(f).name for f in figs]}
        t_all = time.time()
        # stage A — read, list candidates, write the verification scripts
        env = await _call_retry(session, args, rec, "A", prompt, None,
                                [Path(f).as_posix() for f in figs])
        conv, answer_a = env.get("conversation_id"), env.get("response") or ""
        rec["answer_a"] = answer_a
        # stage B — the harness executes them
        rec["verifs"] = run_verifs(parse_verifs(answer_a), work, args.verif_python)
        final = None
        if answer_a and conv:
            # stage C — judge against the evidence, same conversation (prefix-cached on vLLM)
            env = await _call_retry(session, args, rec, "C", build_round2(rec["verifs"]), conv)
            rec["answer_c"] = env.get("response") or ""
            final = parse_json_block(rec["answer_c"]) if rec["answer_c"] else None
            final = final if isinstance(final, dict) else None
        rec["elapsed_s"] = round(time.time() - t_all, 1)
        rec["error"] = None if final else next((c["error"] for c in reversed(rec["calls"]) if c["error"]),
                                               "unparsed")
        rec["parsed"] = final is not None
        cand = parse_json_block(answer_a)
        rec["candidates"] = validate(cand.get("candidats") or [] if isinstance(cand, dict) else [],
                                     cell_texts, index_to_id)
        if final:
            rec["verdict"] = final.get("verdict")
            rec["resume"] = final.get("resume")
            rec["partiel"] = final.get("partiel")
            rec["findings"] = validate(final.get("findings") or [], cell_texts, index_to_id)
        rec["findings"] = link_verifs(rec.get("findings") or [], rec["verifs"])
        (out / f"{slug}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
        nf = rec.get("findings") or []
        vok = sum(v["rc"] == 0 for v in rec["verifs"])
        with open(out / "ledger.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps({k: rec.get(k) for k in ("notebook", "started", "elapsed_s", "error",
                                                          "parsed", "verdict")}
                                | {"n_verifs": len(rec["verifs"]), "n_verifs_ok": vok,
                                   "n_candidates": len(rec["candidates"]),
                                   "n_findings": len(nf), "n_valid": sum(f["valid"] for f in nf)},
                                ensure_ascii=False) + "\n")
        print(f"[{rec['elapsed_s']:>6}s] {rel} verdict={rec.get('verdict')} cand={len(rec['candidates'])} "
              f"verifs={vok}/{len(rec['verifs'])} findings={len(nf)} "
              f"valid={sum(f['valid'] for f in nf)} err={rec['error']}", flush=True)
        return rec


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("notebooks", nargs="+", help="repo-relative notebook paths")
    ap.add_argument("--repo", default=os.environ.get("NB_AUDIT_REPO", ""),
                    help="CoursIA checkout (required, or NB_AUDIT_REPO): an input of the run, "
                         "not a harness binding (F2, vllm#438)")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--agent", default="notebook-auditor")
    ap.add_argument("--concurrency", type=int, default=2)
    ap.add_argument("--timeout", type=int, default=1500, help="call_agent budget per notebook (s)")
    ap.add_argument("--max-tokens", type=int, default=16384,
                    help="per LLM turn; sk-agent's model client times out at 300 s per turn")
    ap.add_argument("--max-figures", type=int, default=4,
                    help="committed figures attached to stage A (prod: --limit-mm-per-prompt image=4)")
    ap.add_argument("--verif-python", default=str(VERIF_PY_DEFAULT) if VERIF_PY_DEFAULT.is_file() else ORGAN_PY,
                    help="interpreter for the stage-B verification scripts")
    ap.add_argument("--work-root", default=str(Path(os.environ.get("TEMP", "/tmp")) / "nbaudit"),
                    help="per-notebook scratch dirs for the verification scripts")
    args = ap.parse_args()
    if not args.repo:
        ap.error("--repo is required (or NB_AUDIT_REPO): the CoursIA checkout is an input of the "
                 "run, not a harness binding (F2, vllm#438)")
    Path(args.out_dir).mkdir(parents=True, exist_ok=True)
    # cwd = work root: sk-agent's child MCPs (papermill's ./outputs) must not write into the repo
    Path(args.work_root).mkdir(parents=True, exist_ok=True)
    params = StdioServerParameters(command=str(SK_PY), args=[str(SK_DIR / "sk_agent.py")],
                                   env={**os.environ, "SK_AGENT_CONFIG": str(SK_CONFIG)},
                                   cwd=args.work_root)
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as session:
            await session.initialize()
            sem = asyncio.Semaphore(args.concurrency)
            recs = await asyncio.gather(*(audit_one(session, sem, args, nb) for nb in args.notebooks))
    ok = [r for r in recs if r.get("parsed")]
    print(f"DONE {len(ok)}/{len(recs)} parsed, "
          f"{sum(sum(v['rc'] == 0 for v in r['verifs']) for r in recs)}/"
          f"{sum(len(r['verifs']) for r in recs)} verifs ran clean, "
          f"{sum(len(r.get('findings') or []) for r in ok)} findings, "
          f"{sum(f['valid'] for r in ok for f in r.get('findings') or [])} valid", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
