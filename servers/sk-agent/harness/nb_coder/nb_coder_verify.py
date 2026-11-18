#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 231c9ad8e9281ee162fc641a11889fc5600f4827
# original path: myia_vllm/scripts/adoption/nb_coder/nb_coder_verify.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""nb-coder independent verifier (stage 4) — jsboige/vllm#431.

The verifier is a SEPARATE process and a SEPARATE agent from the builder (producer != verifier,
global rule). Its exit 2 is an INSTRUMENT error, never a reject.

WHAT IT RECEIVES, and why (vllm#440):
    A per-output-BLOCK fingerprint is not a content comparison. Two executions of the same code
    can split the same print differently (stdout buffer boundaries): an untouched cell then
    changes fingerprint although not one byte of content moved. Measured 16/11 (po-2028:claudish,
    CoursIA#26789): three differences flagged, NONE of them a content drift — a signed zero
    (+0.000000 vs -0.000000), a buffer boundary (90 bytes vs 89+1), and an EDITED cell whose
    fingerprint MUST change. No pass could ever be approved on such a notebook.

    So the instrument now gives the verifier what it claims to judge:
      1. a per-CELL text digest — the concatenated text of the cell's outputs, hashed — not a
         per-block digest, so a buffer boundary cannot fake a difference;
      2. the actual TEXT of every cell whose content differs, side by side, bounded — so an
         edited cell is judged on its text and not on the inevitability of its digest.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve()
DRV = HERE.parent / "nb_coder_driver.py"
_spec = importlib.util.spec_from_file_location("nbcd", DRV)
nbcd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nbcd)

from mcp import ClientSession, StdioServerParameters          # noqa: E402
from mcp.client.stdio import stdio_client                      # noqa: E402

# How much of a differing cell's text is shown to the verifier, per cell and in total.
CELL_TEXT_CAP = 1200
TOTAL_TEXT_CAP = 12_000


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _text(x) -> str:
    return "".join(x) if isinstance(x, list) else (x or "")


def cell_output_text(cell: dict) -> str:
    """The DISPLAYED text of a cell's outputs, concatenated.

    Concatenation is the point: stdout buffer boundaries are an artefact of the print, not a
    content difference. What the reader sees is the concatenation.

    Consecutive STREAMS are joined with NO separator (the reader sees one continuous stream);
    a non-stream output (a result, an error) is separated from its neighbours by a newline so
    that two different outputs cannot silently merge into the same string.
    """
    chunks: list[tuple[bool, str]] = []
    for o in cell.get("outputs") or []:
        if not isinstance(o, dict):
            continue
        if o.get("output_type") == "stream":
            chunks.append((True, _text(o.get("text"))))
            continue
        data = o.get("data") or {}
        bits = [_text(data.get(mime)) for mime in ("text/plain", "text/html", "text/markdown")]
        bits.append(_text(o.get("traceback")))
        bits.append(str(o.get("evalue") or ""))
        chunks.append((False, "\n".join(b for b in bits if b)))
    out: list[str] = []
    for is_stream, txt in chunks:
        if not txt:
            continue
        if out and not is_stream:
            out.append("\n")
        out.append(txt)
    return "".join(out)


def outputs_digest(nb_path: Path) -> list[dict]:
    """Per-code-cell OUTPUT TEXT fingerprint (not per block).

    Kept the shape the verifier knows (cell, n, types, bytes, sha) but the sha now covers the
    CONCATENATED text: a buffer boundary can no longer change it. `text` is the exact string
    hashed, so the verifier can compare it with the source's byte for byte if it wants.
    """
    rows = []
    for i, c in enumerate(nbcd._cells(nb_path)):
        if c.get("cell_type") != "code":
            continue
        outs = [o for o in (c.get("outputs") or []) if isinstance(o, dict)]
        text = cell_output_text(c)
        rows.append({"cell": i, "n": len(outs),
                     "types": sorted({o.get("output_type") for o in outs}),
                     "bytes": len(text),
                     "sha": hashlib.sha1(text.encode()).hexdigest()[:8]})
    return rows


def cell_diffs(src_path: Path, built_path: Path) -> list[dict]:
    """Cells whose displayed output text differs, with the text of both sides.

    An edited cell is judged on its TEXT, not on the inevitability of its digest (vllm#440):
    the verifier sees what changed and decides whether the change is legitimate.
    """
    src_cells, built_cells = nbcd._cells(src_path), nbcd._cells(built_path)
    src_by_idx = {i: c for i, c in enumerate(src_cells)}
    built_by_idx = {i: c for i, c in enumerate(built_cells)}
    diffs = []
    for i in sorted(set(src_by_idx) | set(built_by_idx)):
        s, b = src_by_idx.get(i), built_by_idx.get(i)
        if s is None:
            diffs.append({"cell": i, "kind": "added",
                           "src_text": None, "built_text": cell_output_text(b)[:CELL_TEXT_CAP]})
            continue
        if b is None:
            diffs.append({"cell": i, "kind": "removed",
                           "src_text": cell_output_text(s)[:CELL_TEXT_CAP], "built_text": None})
            continue
        st, bt = cell_output_text(s), cell_output_text(b)
        if st == bt:
            continue
        # A cell whose SOURCE code differs is an EDITED cell: its output is expected to change.
        # Say so, so the verifier does not read the change as an unexplained alteration.
        edited = _text(s.get("source")) != _text(b.get("source"))
        diffs.append({"cell": i, "kind": "edited" if edited else "outputs-changed",
                       "src_text": st[:CELL_TEXT_CAP], "built_text": bt[:CELL_TEXT_CAP]})
    budget = TOTAL_TEXT_CAP
    for d in diffs:
        for k in ("src_text", "built_text"):
            if not d.get(k):
                continue
            if budget <= 0:
                d[k] = "[tronqué]"          # the marker itself counts against the budget
                budget -= len(d[k])
                continue
            room = min(len(d[k]), budget)
            d[k] = d[k][:room] + ("…" if room < len(d[k]) else "")
            budget -= room
    return diffs


def verify_prompt(issue: dict, src_view: str, built_view: str, facts: dict,
                  conventions: str, src_digest: list[dict] | None = None,
                  built_digest: list[dict] | None = None,
                  diffs: list[dict] | None = None) -> str:
    annex = ""
    if src_digest is not None and built_digest is not None:
        annex += ("## Annexe sorties — empreintes par cellule code (source | livrable)\n"
                  "Chaque entrée : cell, n=nombre de blocs de sortie, types, bytes, "
                  "sha=empreinte du TEXTE CONCATÉNÉ de la cellule (pas de l'empreinte d'un "
                  "bloc : la frontière de tampon d'un print n'est pas une différence de "
                  "contenu). Une cellule code non éditée dont l'empreinte change entre SOURCE "
                  "et LIVRABLE = sorties réellement altérées. Une cellule code de la SOURCE "
                  "absente du LIVRABLE = contenu perdu.\n"
                  f"SOURCE :\n{json.dumps(src_digest, ensure_ascii=False)}\n\n"
                  f"LIVRABLE :\n{json.dumps(built_digest, ensure_ascii=False)}\n\n")
    if diffs:
        annex += ("## Annexe différences — texte de sortie, cellule par cellule\n"
                  "Pour chaque cellule dont le texte affiché diffère, les DEUX textes sont "
                  "donnés. `kind` : `edited` = le code source de la cellule a changé (l'issue "
                  "demandait cette édition, donc la sortie DOIT changer) ; `outputs-changed` = "
                  "le code est identique mais la sortie a changé (à justifier) ; `added` / "
                  "`removed` = cellule apparue ou disparue. **Juge sur le TEXTE, pas sur le "
                  "fait qu'il diffère** : un changement demandé par l'issue n'est pas une "
                  "altération.\n"
                  f"{json.dumps(diffs, ensure_ascii=False, indent=1)}\n\n")
    return (
        "MODE VÉRIFICATION — tu es le vérificateur INDÉPENDENT d'un carnet produit par un autre "
        "agent. Tu n'as pas produit ce carnet et tu ne dois croire AUCUNE de ses affirmations : "
        "ta référence est la SOURCE (carnet d'origine) et les critères d'acceptation de l'issue.\n\n"
        f"## Issue — critères d'acceptation\nTITRE : {issue['title']}\n\n"
        f"CORPS :\n{nbcd._cut(issue['body'], 30000, 'corps de l issue')}\n\n"
        + (f"## Conventions de livraison (imposées)\n{conventions}\n\n" if conventions else "")
        + f"## SOURCE — carnet d'origine (branche main, RÉFÉRENCE)\n{src_view}\n\n"
        + f"## LIVRABLE — carnet produit (À VÉRIFIER)\n{built_view}\n\n"
        + annex
        + "## Faits mécaniques du harnais (des AFFIRMATIONS du producteur — à contre-vérifier "
        "sur les deux vues, jamais à croire sur parole)\n"
        f"{json.dumps(facts, ensure_ascii=False, indent=1)[:6000]}\n\n"
        "## Ta tâche\n"
        "1. **Contenu perdu ?** Une cellule, un bloc de code ou une sortie de code de la SOURCE "
        "a-t-il disparu du LIVRABLE sans que l'issue le demande ?\n"
        "2. **Contenu inventé ?** Le LIVRABLE contient-il du texte ou du code absents de la "
        "SOURCE et non justifiés par les critères d'acceptation ?\n"
        "3. **Critères satisfaits ?** Les gestes du LIVRABLE satisfont-ils les critères "
        "d'acceptation de l'issue ?\n"
        "4. **Conventions** : en-tête sans référence de coordination, note de provenance en pied "
        "de carnet à la forme exacte, sorties réelles non éditées (pour les cellules NON "
        "éditées, même sha dans l'annexe ; pour les cellules éditées, juge le texte de "
        "l'annexe différences).\n\n"
        "Rends UNIQUEMENT un bloc ```json :\n"
        '{"verdict":"approve|reject","findings":[{"cell":<index du LIVRABLE>,"severity":"major|minor",'
        '"detail":"..."}],"checked":["..."]}\n'
        'Réponds "reject" si un contenu a été perdu, inventé, ou si un critère d\'acceptation '
        'n\'est pas satisfait ; "approve" sinon. Base chaque constat sur les deux vues.'
    )


async def call_verifier(args, prompt: str) -> tuple[dict, float]:
    sk_params = StdioServerParameters(
        command=str(nbcd.SK_PY), args=[str(nbcd.SK_DIR / "sk_agent.py")],
        env={**os.environ, "SK_AGENT_CONFIG": str(nbcd.SK_CONFIG)}, cwd=str(Path(args.out_dir)))
    t0 = time.time()
    async with stdio_client(sk_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            spec = nbcd.agent_spec_for(args.agent, getattr(args, "model", None),
                                       args.max_tokens, 0.2)
            res = await session.call_tool(
                "call_agent",
                {"prompt": prompt, "agent": args.agent, "timeout": args.timeout,
                 "include_steps": False, "agent_spec": json.dumps(spec)},
                read_timeout_seconds=timedelta(seconds=args.timeout + 120))
            raw = "\n".join(getattr(c, "text", "") for c in res.content)
    try:
        return json.loads(raw), round(time.time() - t0, 1)
    except Exception:
        return {"response": raw}, round(time.time() - t0, 1)


def main() -> int:
    ap = argparse.ArgumentParser(description="nb-coder independent verifier (stage 4)")
    ap.add_argument("--issue", type=int, required=True)
    ap.add_argument("--source-nb", required=True, help="pristine notebook (origin/main)")
    ap.add_argument("--built-nb", required=True, help="deliverable produced by the harness")
    ap.add_argument("--facts", default=None, help="builder trace JSON (claims to counter-check)")
    ap.add_argument("--conventions",
                    default=str(nbcd.VLLM_ROOT / "myia_vllm/docs/adoption/nb-coder-conventions.md"))
    ap.add_argument("--agent", default="critic",
                    help="verifier agent — must be a DIFFERENT model from the builder "
                         "(builder = notebook-auditor/Swift; default critic = GLM-5.3)")
    ap.add_argument("--model", default=os.environ.get("NBCODER_VERIFIER_MODEL"),
                    help="model serving this audit turn (#4831, forwarded by the driver's "
                         "--verifier-model) — overrides the agent preset's model")
    ap.add_argument("--out-dir", default=str(nbcd.VLLM_ROOT / ".tmp/nbcoder"))
    ap.add_argument("--timeout", type=int, default=900)
    # 32 768, not 4 096: the default verifier (critic = GLM-5.3, thinking on) burns the
    # WHOLE output budget reasoning and returns HTTP 200 with zero content — measured
    # 16/11 (vllm#446): 4 096 and 16 000 both die as error:unparsable, 32 000 renders
    # the verdict (28 685 tok in / 756 out). Re-confirmed 17/11 on the #27104 blank
    # creation pass: response_chars 0 at the 4 096 default, driver passes no override.
    ap.add_argument("--max-tokens", type=int, default=32768)
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rec = {"issue": args.issue, "agent": args.agent, "started": utcnow(),
           "model": getattr(args, "model", None),
           "source_nb": args.source_nb, "built_nb": args.built_nb}
    try:
        src_p, built_p = Path(args.source_nb), Path(args.built_nb)
        for p in (src_p, built_p):
            if not p.is_file():
                rec["verdict"] = f"error:input-missing:{p}"
                raise SystemExit(2)
        issue = nbcd.fetch_issue("jsboige/CoursIA", args.issue, nbcd.app_token(Path("d:/CoursIA")))
        facts = {}
        if args.facts and Path(args.facts).is_file():
            t = json.loads(Path(args.facts).read_text(encoding="utf-8"))
            facts = {"plan": t.get("plan"), "apply": t.get("apply"),
                     "structure": t.get("structure"), "exec_mode": t.get("exec_mode"),
                     "c2": t.get("c2"),
                     "execution": [{k: e.get(k) for k in ("cell", "ok", "status")}
                                   for e in (t.get("execution") or [])]}
        rec["facts_chars"] = len(json.dumps(facts, ensure_ascii=False))
        conventions = nbcd.read_conventions(args.conventions)
        diffs = cell_diffs(src_p, built_p)
        rec["diff_cells"] = [d["cell"] for d in diffs]
        rec["diff_kinds"] = [d["kind"] for d in diffs]
        prompt = verify_prompt(issue, nbcd.build_view(src_p), nbcd.build_view(built_p),
                               facts, conventions,
                               outputs_digest(src_p), outputs_digest(built_p), diffs)
        rec["prompt_chars"] = len(prompt)
        env, dt = asyncio.run(call_verifier(args, prompt))
        rec["elapsed_s"] = dt
        rec["model_used"] = env.get("model_used")
        rec["conversation_id"] = env.get("conversation_id")
        rec["response_chars"] = len(env.get("response") or "")
        ans = nbcd.parse_json_block(env.get("response") or "")
        rec["answer"] = ans
        if not ans or ans.get("verdict") not in ("approve", "reject"):
            rec["verdict"] = "error:unparsable"
            rc = 2
        else:
            rec["verdict"] = ans["verdict"]
            rc = 0 if ans["verdict"] == "approve" else 1
    except SystemExit:
        rc = 2
    except Exception as exc:
        rec["verdict"] = f"error:{type(exc).__name__}: {exc}"
        rc = 2
    rec["finished"] = utcnow()
    trace = out_dir / f"verify-{args.issue}.json"
    trace.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"verdict": rec.get("verdict"), "trace": str(trace),
                      "findings": (rec.get("answer") or {}).get("findings"),
                      "diff_cells": rec.get("diff_cells"),
                      "elapsed_s": rec.get("elapsed_s"),
                      "model_used": rec.get("model_used")}, ensure_ascii=False, indent=1))
    return rc


if __name__ == "__main__":
    sys.exit(main())
