#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/issue_from_finding.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Deterministic issue-body generator for nb_coder grains (from nb_audit findings).

Zero model tokens: consumes the validated findings of an nb_audit record
(fields: classe, pourquoi, extrait, cellules, valid, rejections) and emits the
issue body in the #26647 format (Mission / Constat relu / Acceptance / paths:).

The output is a DRAFT: the lane validates the constat against the notebook
before creating the GitHub issue (quality gate on false positives — measured
09-22 pilot: ~2/3 of audit findings likely-true).

Usage:
  python issue_from_finding.py <record.json> --notebook <repo-rel> --ref <sha> [--out <file>]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ACCEPTANCE = """- Lire le notebook entier et ses sorties avant toute édition ; requalifier le constat si la tête a changé.
- Modifier uniquement ce notebook via MCP jupyter-papermill ; préserver calculs, exemples résolus, exercices et substance pédagogique.
- Code modifié : exécution complète réelle, zéro erreur et inspection des sorties après modification ; jamais de sortie éditée à la main. Markdown-only : code et sorties byte-identiques.
- Producteur distinct du vérificateur ; vérification contre la source base↔tête, contrôle positif du changement et négatif de non-régression.
- Avant démarrage : recontrôler claims et PRs ouvertes sur le chemin exact, puis poser le claim scoped.
- Tracer le modèle effectivement servi (`model_used` attendu dans les traces) ; publication via l'App de lane, C.1/C.2/B.0 et approbation coordinateur avant merge."""


def fmt_finding(i: int, f: dict) -> str:
    cells = ", ".join(str(c) for c in (f.get("cellules") or []))
    note = f" _(attribution réparée : {f['note']})_" if f.get("note") else ""
    extrait = (f.get("extrait") or "").strip()
    return (f"{i}. **Cellule(s) {cells}**{note} — classe `{f.get('classe')}` : {f.get('pourquoi')}\n"
            f"   > `{extrait}`")


def build_body(record_path: Path, notebook: str, ref: str) -> str:
    rec = json.loads(record_path.read_text(encoding="utf-8"))
    valid = [f for f in (rec.get("findings") or []) if f.get("valid")]
    invalid = [f for f in (rec.get("findings") or []) if not f.get("valid")]
    if not valid:
        raise SystemExit(f"AUCUN finding valide dans {record_path.name} — pas d'issue générée "
                         f"({len(invalid)} rejetés mécaniquement). Ne pas forcer.")
    verdict = rec.get("verdict") or "?"
    lines = [
        "## Mission",
        "",
        "Sous-grain du chantier #18874, file nb_coder (coordination #26534, arbitrage "
        "c.6897892460 : série réservée `MyIA.AI.Notebooks/Physique/`). "
        f"Un seul notebook : `{notebook}`.",
        "",
        "## Constat relu (GÉNÉRÉ depuis finding d'audit — VALIDER À LA LECTURE AVANT CRÉATION)",
        "",
        f"Audit `{record_path.name}` (verdict : {verdict}) — {len(valid)} finding(s) validé(s) "
        f"mécaniquement (extrait verbatim, cellule existante), {len(invalid)} rejeté(s) :",
        "",
    ]
    lines += [fmt_finding(i + 1, f) for i, f in enumerate(valid)]
    lines += [
        "",
        "Le geste attendu par finding : corriger le défaut ÉNONCÉ (verdict dérivé de la valeur "
        "calculée, label dynamique, contrôle effectif), SANS toucher aux calculs, exemples résolus "
        "et exercices. Si plusieurs findings, un geste borné par finding, dans l'ordre listé.",
        "",
        f"Référence lue : `{ref}`. Il s'agit d'un défaut éditorial local, pas d'une preuve que le "
        "carnet entier est dégradé.",
        "",
        "## Acceptance",
        "",
        ACCEPTANCE,
        "",
        f"paths: {notebook}",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("record", help="nb_audit record JSON (one notebook)")
    ap.add_argument("--notebook", required=True, help="repo-relative notebook path")
    ap.add_argument("--ref", required=True, help="commit SHA the audit read")
    ap.add_argument("--out", default=None, help="write to file (default: stdout)")
    args = ap.parse_args()
    body = build_body(Path(args.record), args.notebook, args.ref)
    if args.out:
        Path(args.out).write_text(body, encoding="utf-8", newline="\n")
        print(f"wrote {args.out} ({len(body)} chars)")
    else:
        sys.stdout.write(body)


if __name__ == "__main__":
    main()
