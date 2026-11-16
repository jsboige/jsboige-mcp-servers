#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ f42c52d8fb5f5d64bbae34df7f83d56f7aa284b8
# original path: myia_vllm/scripts/adoption/nb_coder/nb_coder_verify.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""nb-coder stage 4 — independent verifier (CoursIA #26534, dispatch 14/11).

The builder is `notebook-auditor` (Swift, qwen3.6-35b-a3b-audit sampling). The verifier must be
a GENUINELY DIFFERENT model (producer != verifier, global rule) and must compare the BUILT
notebook to the SOURCE notebook — never to the builder's prompt or claims. Mechanical facts
from the builder's trace are passed as claims to be counter-checked against the two views.

Usage:
  python nb_coder_verify.py --issue 20250 \
      --source-nb d:/vllm/.tmp/nbcoder/wt-20250/MyIA.AI.Notebooks/.../nb.ipynb \
      --built-nb  d:/vllm/.tmp/nbcoder/grain1-try4/nb_20250_built.ipynb \
      --agent critic --out-dir d:/vllm/.tmp/nbcoder/grain1-try4

Exit: 0 approve, 1 reject, 2 error (instrument failure — never read as "reject").
"""
import argparse
import asyncio
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


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def outputs_digest(nb_path: Path) -> list[dict]:
    """Per-code-cell outputs fingerprint — the views do not show outputs, so the verifier
    could not check their preservation (it flagged this itself on the grain-1 pass).
    Bounded: type, count, bytes, sha1[:8] of the outputs payload per code cell."""
    import hashlib
    rows = []
    for i, c in enumerate(nbcd._cells(nb_path)):
        if c.get("cell_type") != "code":
            continue
        outs = c.get("outputs") or []
        payload = json.dumps(outs, ensure_ascii=False, sort_keys=True)
        rows.append({"cell": i, "n": len(outs),
                     "types": sorted({o.get("output_type") for o in outs if isinstance(o, dict)}),
                     "bytes": len(payload), "sha": hashlib.sha1(payload.encode()).hexdigest()[:8]})
    return rows


def verify_prompt(issue: dict, src_view: str, built_view: str, facts: dict,
                  conventions: str, src_digest: list[dict] | None = None,
                  built_digest: list[dict] | None = None) -> str:
    return (
        "MODE VÉRIFICATION — tu es le vérificateur INDÉPENDANT d'un carnet produit par un autre "
        "agent. Tu n'as pas produit ce carnet et tu ne dois croire AUCUNE de ses affirmations : "
        "ta référence est la SOURCE (carnet d'origine) et les critères d'acceptation de l'issue.\n\n"
        f"## Issue — critères d'acceptation\nTITRE : {issue['title']}\n\n"
        f"CORPS :\n{nbcd._cut(issue['body'], 30000, 'corps de l issue')}\n\n"
        + (f"## Conventions de livraison (imposées)\n{conventions}\n\n" if conventions else "")
        + f"## SOURCE — carnet d'origine (branche main, RÉFÉRENCE)\n{src_view}\n\n"
        f"## LIVRABLE — carnet produit (À VÉRIFIER)\n{built_view}\n\n"
        + ("## Annexe sorties — empreintes par cellule code (source | livrable)\n"
           "Chaque entrée : cell, n=nombre de blocs de sortie, types, bytes, sha=empreinte du "
           "contenu. Une cellule code non éditée dont l'empreinte change entre SOURCE et "
           "LIVRABLE = sorties altérées. Une cellule code de la SOURCE absente du LIVRABLE = "
           "contenu perdu.\n"
           f"SOURCE :\n{json.dumps(src_digest, ensure_ascii=False)}\n\n"
           f"LIVRABLE :\n{json.dumps(built_digest, ensure_ascii=False)}\n\n"
           if src_digest is not None and built_digest is not None else "")
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
        "de carnet à la forme exacte, sorties réelles non éditées (vérifie les empreintes de "
        "l'annexe : mêmes sha pour les cellules non éditées).\n\n"
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
            spec = {"extends": args.agent,
                    "sampling": {"max_tokens": args.max_tokens, "temperature": 0.2}}
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
    ap.add_argument("--out-dir", default=str(nbcd.VLLM_ROOT / ".tmp/nbcoder"))
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--max-tokens", type=int, default=4096)
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rec = {"issue": args.issue, "agent": args.agent, "started": utcnow(),
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
        prompt = verify_prompt(issue, nbcd.build_view(src_p), nbcd.build_view(built_p),
                               facts, conventions,
                               outputs_digest(src_p), outputs_digest(built_p))
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
                      "elapsed_s": rec.get("elapsed_s"),
                      "model_used": rec.get("model_used")}, ensure_ascii=False, indent=1))
    return rc


if __name__ == "__main__":
    sys.exit(main())