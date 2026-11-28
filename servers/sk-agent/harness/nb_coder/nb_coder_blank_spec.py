#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Authored here (blank-spec generator) — no jsboige/vllm original. The lane-local
# originals (po-2028 batch generators gen-o87/o88/o89.py, 28/11, and the ai-01:vllm
# generator) hard-coded D:/dev/CoursIA, one batch directory and one spec list; this
# port takes the repository, the ref and the specs file as arguments. This tree is
# the source of truth.
# Harness base is the vllm re-copy @ 7a09e1caec22441d9402ab25a222206c8905bfe1.
# -----------------------------------------------------------------------------
"""Blank-spec generator for a parity-twin grain: the issue body IS the spec, measured from the tree.

Zero model tokens. For each spec entry (a JSON file written by the lane), the generator reads the
source notebook from a git ref (default `origin/main`) and writes the issue body of a grain that
ports it to a C# twin (or a Rust twin). Everything the body says about the notebook is MEASURED on
the blob it cites, never asserted from memory:

- the cell inventory, one row per code cell, first non-empty line VERBATIM, with an indicative
  archetype (exemple résolu / exercice / préambule / calcul);
- the import roots;
- ALÉA: the code cells that draw at random, and the literal seeds they pass
  (`default_rng(42)`, `random.seed(7)`, `manual_seed(0)`, `RandomState(3)`, `random_state=5`);
- figures: the code cells that call `plt.` or carry an `image/png` output (SVG expected), or the
  measured statement that the source draws none;
- the libraries with no BCL / std equivalent (scipy entropy, mpmath, networkx, torch, ...):
  « réimplémentation fidèle, jamais une substitution »;
- the twins of the same language already in the folder (`ls-tree`), or « premier de sa série ».

Refusals, measured (the entry is not written, exit 2):
- the target twin is already on the ref (not a grain);
- C# mode: the Rust twin of the source is on the ref (the body would say the opposite);
- Rust mode: the C# twin is ABSENT (a prerequisite of the Rust port: the C# port already did the
  adaptation work), unless the entry sets `"allow_no_csharp": true`.

The output is a DRAFT the lane rereads before creating the issue. Mutualized from the seat
scratch generators (po-2028 batches o87 to o89, 28/11) and the ai-01:vllm generator, so that
both lanes run one tree.

Usage:
  python nb_coder_blank_spec.py --repo <coursia-checkout> --specs <specs.json> --out <dir> [--ref origin/main]

The specs file is a JSON list of entries, or {"defaults": {...}, "specs": [...]}. Keys of an entry:
  file, title, grain, parent, source, target            (required)
  lang            "csharp" (default) or "rust"
  objet           paragraph of the Objet section
  notes           list; an item is a string or {"clause": <name>, ...params} (see CLAUSES)
  readme          text of the README part of the link bullet
  deps_clause     replaces the default dependency bullet
  force_solved / force_exo / force_pre   lists of code-cell indexes overriding the archetype
  allow_no_csharp (Rust mode only)
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Callable

IMPORT_FIRST = re.compile(r"^\s*(from\s+\w|import\s+\w)")
EXO = re.compile(r"(?i)exercice|\bexo\b|todo\s+etudiant|completer")
IMPORT_ROOT = re.compile(r"(?m)^\s*(?:from|import)\s+([\w\.]+)")

# A literal seed handed to a generator. Keyword forms included (`default_rng(seed=42)`).
SEED = re.compile(
    r"\b(default_rng|seed|manual_seed|RandomState|Random)\(\s*(?:seed\s*=\s*)?(\d+)\s*\)"
    r"|\b(random_state)\s*=\s*(\d+)")
# A draw. Deliberately broad on the call names, narrow on the receivers, so a plain
# `random` word in prose or a `rng` variable unrelated to randomness does not count.
DRAW = re.compile(
    r"\b(?:np\.random|numpy\.random|random|rng|torch)\.(?:rand\w*|choice\w*|shuffle|normal|uniform|"
    r"integers|sample|permutation|random\w*|gauss|binomial|poisson|exponential|beta|gamma|"
    r"multinomial|dirichlet|standard_normal|triangular)\b|\bdefault_rng\(|\bRandomState\(")
FIGURE_CODE = re.compile(r"\bplt\.|\.plot\(|\bsns\.")

# Libraries the BCL (C#) / std (Rust) does not carry. Each match is cited with its cells; the
# twin re-implements what the source computes, it never swaps in another method.
NO_EQUIVALENT: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b(?:stats\.entropy|entropy\s*\(|rel_entr|kl_div)"), "scipy `entropy` / `rel_entr`"),
    (re.compile(r"\bscipy\.optimize\b|\bfrom\s+scipy\s+import\s+optimize\b|\bminimize\(|\blinprog\("),
     "scipy `optimize`"),
    (re.compile(r"\bscipy\.stats\b|\bfrom\s+scipy\s+import\s+stats\b"), "scipy `stats`"),
    (re.compile(r"\bcvxpy\b"), "cvxpy"),
    (re.compile(r"\bmpmath\b"), "mpmath"),
    (re.compile(r"\bnetworkx\b"), "networkx"),
    (re.compile(r"\btorch\b"), "torch"),
    (re.compile(r"\bsklearn\b"), "scikit-learn"),
    (re.compile(r"\bsympy\b"), "sympy"),
    (re.compile(r"\bpandas\b"), "pandas"),
]


@dataclass(frozen=True)
class Lang:
    key: str
    label: str            # "C#" / "Rust"
    suffix: str           # notebook suffix of a twin of this language
    kernel: str
    equivalent: str       # column header of the inventory table
    preamble: str
    deps_default: str
    link: str
    pairs: str
    run: str
    figure: str
    gap: str              # name of the missing library family in the NO_EQUIVALENT bullet


LANGS = {
    "csharp": Lang(
        key="csharp", label="C#", suffix="-CSharp.ipynb", kernel="`.net-csharp`",
        equivalent="Équivalent .NET attendu",
        preamble="imports et définitions équivalents en tête du jumeau",
        deps_default="BCL seulement ; aucun NuGet, réseau, Lean, solveur ni accès au compendium privé.",
        link="Lien entrant `[Version C#]` ajouté au Python ; destinations C# réelles ; {readme} ; `_quarto.yml` inchangé.",
        pairs=("Paire `semantic` / `SOTA-OK` enregistrée dans `twin_pairs.d/` avec première attestation réelle ; "
               "hashes régénérées après normalisation/pre-commit et vérifiées contre les blobs Git committés."),
        run=("Exécution intégrale `.net-csharp`, zéro erreur, `git diff --check` propre, aucun avertissement "
             "nullable introduit ; `CATALOG-STATUS` conservé."),
        figure=("restituée en SVG par le pattern de formateur des conventions (formateur enregistré pour "
                "`image/svg+xml` avant le premier affichage, jamais un SVG échappé dans une sortie texte)"),
        gap="BCL"),
    "rust": Lang(
        key="rust", label="Rust", suffix="-Rust.ipynb", kernel="`rust` (evcxr)",
        equivalent="Équivalent Rust attendu",
        preamble="`use`, `fn`, `struct` et `const` équivalents en tête du jumeau (ils persistent sous evcxr)",
        deps_default=("std seulement ; aucune crate, aucune cellule `:dep`, aucun pont Python, ni réseau, Lean, "
                      "solveur ni accès au compendium privé."),
        link="Lien entrant `| [jumeau Rust](…)` ajouté aux cellules de navigation du Python ; {readme}.",
        pairs=("Côté `rust:` de l'entrée `twin_pairs.d/` (avec `known_differences`) et "
               "`rust_conformance.d/<slug>.yaml`, une mesure par cellule comparée."),
        run=("Exécution intégrale sous le kernelspec `rust`, zéro erreur, aucun `execution_count` nul, aucune "
             "cellule terminée par une expression de type unité ; `git diff --check` propre ; "
             "`check_rust_notebook_contract.py` et `check_rust_conformance.py` passent."),
        figure=("restituée en SVG écrit à la main et affiché par "
                "`println!(\"EVCXR_BEGIN_CONTENT image/svg+xml\\n{}\\nEVCXR_END_CONTENT\", svg);` (un "
                "`execute_result`, jamais un SVG imprimé comme texte)"),
        gap="std"),
}


def cell_source(cell: dict) -> str:
    src = cell.get("source", "")
    return "".join(src) if isinstance(src, list) else str(src)


def code_cells(nb: dict) -> list[tuple[int, dict]]:
    return [(i, c) for i, c in enumerate(nb.get("cells", [])) if c.get("cell_type") == "code"]


def inventory(nb: dict, lang: Lang, force_solved=(), force_exo=(), force_pre=()) -> list[dict]:
    """One row per code cell: index, first non-empty line verbatim, archetype, expected equivalent.

    Precedence: force_solved > (force_exo | EXO on the first five lines) > (force_pre | import first) > calcul.
    """
    rows = []
    for i, c in code_cells(nb):
        lines = [ln for ln in cell_source(c).splitlines() if ln.strip()]
        first = lines[0] if lines else ""
        if i in force_solved:
            arch, eq = "exemple résolu", "porté entièrement, assertions comprises (PAS un stub)"
        elif i in force_exo or EXO.search("\n".join(lines[:5])):
            arch, eq = "exercice", "stub compilable // TODO etudiant"
        elif i in force_pre or IMPORT_FIRST.match(first):
            arch, eq = "préambule", lang.preamble
        else:
            arch, eq = "calcul", "mêmes entrées, mêmes calculs, assertions exécutables"
        rows.append({"index": i, "first": first.strip(), "archetype": arch, "equivalent": eq})
    return rows


def render_row(row: dict) -> str:
    first = row["first"].replace("|", "\\|")
    return f"| {row['index']} | `{first}` | {row['archetype']} | {row['equivalent']} |"


def import_roots(nb: dict) -> list[str]:
    return sorted({m for _, c in code_cells(nb) for m in IMPORT_ROOT.findall(cell_source(c))})


def detect_alea(nb: dict) -> dict:
    """Cells that draw at random, and the literal seeds of the source (call text and cell)."""
    draws, seeds = [], []
    for i, c in code_cells(nb):
        src = cell_source(c)
        if DRAW.search(src):
            draws.append(i)
        for m in SEED.finditer(src):
            seeds.append((i, m.group(0)))
            if i not in draws:
                draws.append(i)
    return {"cells": sorted(draws), "seeds": seeds}


def _has_png(cell: dict) -> bool:
    return any("image/png" in (o.get("data") or {}) for o in cell.get("outputs", []) or [])


def detect_figures(nb: dict) -> list[int]:
    return [i for i, c in code_cells(nb) if FIGURE_CODE.search(cell_source(c)) or _has_png(c)]


def detect_no_equivalent(nb: dict) -> list[tuple[str, list[int]]]:
    found = []
    for pat, label in NO_EQUIVALENT:
        cells = [i for i, c in code_cells(nb) if pat.search(cell_source(c))]
        if cells:
            found.append((label, cells))
    return found


def siblings(names: list[str], target: str, lang: Lang) -> list[str]:
    """Twins of the same language already in the target's folder (basenames), the target excluded."""
    tname = PurePosixPath(target).name
    return sorted(PurePosixPath(n).name for n in names
                  if PurePosixPath(n).name.endswith(lang.suffix) and PurePosixPath(n).name != tname)


def twin_of(source: str, lang_key: str) -> str:
    """Path of the source's twin in another language (`X-Python.ipynb` -> `X-CSharp.ipynb`)."""
    p = PurePosixPath(source)
    stem = p.name[:-len("-Python.ipynb")] if p.name.endswith("-Python.ipynb") else p.stem
    return str(p.with_name(stem + LANGS[lang_key].suffix))


def _cells(cells: list[int], article: bool = True) -> str:
    """`la cellule 6` / `les cellules 1, 3` (or without the article)."""
    n = ", ".join(str(i) for i in cells)
    one = len(cells) == 1
    return (("la " if one else "les ") if article else "") + ("cellule " if one else "cellules ") + n


def alea_bullet(alea: dict) -> str:
    if not alea["cells"]:
        return ("ALÉA (mesuré) — aucun appel de générateur aléatoire dans les cellules de code de la source "
                "(motifs `np.random.*`, `random.*`, `rng.*`, `torch.rand*`, `default_rng(`, `RandomState(`).")
    seeds = ("graines littérales de la source : " + ", ".join(f"`{t}` (cellule {i})" for i, t in alea["seeds"])
             if alea["seeds"] else "aucune graine littérale dans la source")
    return (f"ALÉA (mesuré) — tirages aléatoires dans {_cells(alea['cells'])} ; {seeds}. Une valeur "
            "que la source tire au hasard n'est pas une donnée à recopier, et sa non-reconstruction n'est jamais "
            "une dispense de comparaison : la note « Aléa » de ce carnet nomme la voie attendue (générateur "
            "reproduit à l'identique, ou cellule jugée sur invariants déclarés).")


def figure_bullet(figs: list[int], lang: Lang) -> str:
    if not figs:
        return "Figures (mesuré) : la source ne trace aucune figure (ni `plt.` dans le code, ni sortie `image/png`)."
    verb = "trace" if len(figs) == 1 else "tracent"
    return (f"Figures (mesuré) : {_cells(figs)} {verb} (`plt.` dans le code ou sortie `image/png`) ; "
            f"chaque figure est {lang.figure} ; les valeurs qu'elle trace sont imprimées et assertées.")


def no_equivalent_bullet(found: list[tuple[str, list[int]]], lang: Lang) -> str | None:
    if not found:
        return None
    libs = " ; ".join(f"{label} ({_cells(cells, article=False)})" for label, cells in found)
    return (f"Sans équivalent {lang.gap} (mesuré) : {libs}. Le jumeau en fait une réimplémentation fidèle de ce "
            "que la source calcule, jamais une substitution par une autre méthode ; la formule réimplémentée "
            "est écrite dans le carnet.")


def siblings_bullet(sibs: list[str], lang: Lang, folder: str) -> str:
    if not sibs:
        return (f"Fratrie (mesuré) : premier {lang.label} de sa série dans `{folder}/` ; aucun jumeau {lang.label} "
                "voisin dont suivre les conventions, les conventions générales s'appliquent.")
    return (f"Fratrie (mesuré) : jumeaux {lang.label} déjà dans `{folder}/` : " + ", ".join(f"`{s}`" for s in sibs) +
            " ; le jumeau en suit les conventions (en-tête, culture, formateurs, navigation).")


# ---- named clauses, referenced from the specs file by {"clause": <name>, ...params} -------------

def _no_twin(ctx: "Context", **_: object) -> str:
    other = "Rust" if ctx.lang.key == "csharp" else "C#"
    return (f"Aucun jumeau {other} de ce carnet n'est sur `{ctx.ref}` (mesuré {ctx.today}, `{ctx.ref_sha}`) : "
            "la source de vérité est le seul carnet Python, code ET sorties.")


def _readme_defer(ctx: "Context", prs: list, path: str, **_: object) -> str:
    prs = [str(p) for p in prs]
    many = len(prs) > 1
    return ("DÉROGATION MESURÉE à la puce générique « README de série mis à jour » : "
            + ("les PR OUVERTES " if many else "la PR OUVERTE ") + " et ".join(f"#{p}" for p in prs)
            + f" (recensement des PR ouvertes du {ctx.today}) " + ("modifient" if many else "modifie")
            + f" `{path}`. Ce grain n'y touche pas : il livre le carnet {ctx.lang.label}, le lien entrant dans le "
            "carnet Python source (qu'aucune PR ouverte ne modifie) et l'entrée `twin_pairs.d/` ; la ligne README "
            "sera posée après " + ("ces fusions" if many else "cette fusion")
            + ", pour ne jamais modifier le même fichier en parallèle.")


def _const(text: str) -> Callable[..., str]:
    return lambda ctx, **_: text


CLAUSES: dict[str, Callable[..., str]] = {
    "no_twin": _no_twin,
    "readme_defer": _readme_defer,
    "culture": _const(
        "Culture invariante épinglée en tête (`CultureInfo.InvariantCulture`) : le point décimal des sorties ne "
        "dépend pas de la machine, comme dans les jumeaux C# de la série déjà sur `main`."),
    "py_repr": _const(
        "Les sorties qui reproduisent un `repr` Python le font par des fonctions de formatage EXPLICITES, jamais "
        "par le formatage par défaut : `None` pour une référence nulle, `True`/`False`, un flottant entier écrit "
        "`0.0` (jamais `0`), le flottant le plus court qui se relit à l'identique (`0.001`), les dictionnaires "
        "`{'cle': valeur, ...}` dans l'ordre d'insertion de la source. Un pourcentage `{:.2%}` s'écrit "
        "`(100 * x).ToString(\"F2\") + \"%\"` : le format `P2` de la culture invariante insère une espace "
        "(`0.00 %`) que la source n'a pas."),
    "prose_run": lambda ctx, cited="", **_: (
        "Prose et aléa : une phrase markdown de la source qui cite un nombre dépendant du tirage ou d'un solveur "
        f"borné en temps ({cited}) ne se recopie PAS et ne se remplace PAS par le chiffre d'une exécution donnée "
        "(chaque exécution imprime les siens) : elle renvoie à la valeur imprimée par la cellule qui la produit et "
        "ne qualifie rien que cette valeur ne montre. Les valeurs de la source se citent dans le TABLEAU de la "
        "« Note de parité » (une ligne par valeur), jamais dans une phrase."),
    "ortools": lambda ctx, version="9.15.6755", **_: (
        f"NuGet `Google.OrTools` en version `{version}` SEULEMENT (`#r \"nuget: Google.OrTools, {version}\"`, la "
        "version des jumeaux C# voisins de la série sur `main`) ; aucun autre NuGet, ni réseau, ni Lean, ni accès "
        "au compendium privé."),
    "nav": _const(
        "Navigation : `[Version Python]` vers le carnet Python ; les liens de fratrie pointent vers le jumeau du "
        "même langage quand il existe sur `main` (mesuré au moment de l'écrire), sinon vers le carnet Python — "
        "jamais vers un jumeau absent. Ne modifie AUCUN carnet Python de la série, hormis le lien entrant dans le "
        "carnet source."),
    "executed": _const(
        "La comparaison est EXÉCUTÉE et ses données sont NON VIDES : une cellule de code dont la sortie dit « non "
        "mesuré », « non attesté », « non recalculé » ou « aucune comparaison exécutée » est un rejet, sans "
        "exception. Un fait réellement hors de portée du jumeau se dit dans une cellule MARKDOWN, jamais dans la "
        "sortie d'une cellule de code."),
    "printed": _const(
        "Tolérances : une valeur flottante imprimée s'asserte à UNE UNITÉ de son dernier chiffre imprimé "
        "(`1.83e-03` → écart ≤ 1e-5 ; `89.48` → écart ≤ 0.01), jamais plus serré : un port fidèle peut arrondir de "
        "l'autre côté du dernier chiffre. Les entiers s'assertent EXACTEMENT. Les tolérances sont des constantes "
        "nommées, déclarées avant les calculs qui les utilisent."),
}


class SpecError(ValueError):
    """An entry the generator refuses (measured reason in the message)."""


@dataclass
class Context:
    lang: Lang
    ref: str
    ref_sha: str
    today: str


def render_note(item, ctx: Context) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, dict) and "clause" in item:
        params = {k: v for k, v in item.items() if k != "clause"}
        fn = CLAUSES.get(item["clause"])
        if fn is None:
            raise SpecError(f"unknown clause {item['clause']!r} (known: {', '.join(sorted(CLAUSES))})")
        return fn(ctx, **params)
    raise SpecError(f"a note is a string or {{'clause': ...}}, got {item!r}")


REQUIRED = ("file", "title", "grain", "parent", "source", "target")


@dataclass
class Measure:
    sha: str                    # blob id of the source notebook on the ref
    nb: dict
    target_on_ref: bool
    rust_on_ref: bool
    csharp_on_ref: bool
    folder_names: list[str] = field(default_factory=list)


def check_refusals(spec: dict, m: Measure, lang: Lang) -> None:
    if m.target_on_ref:
        raise SpecError(f"{spec['file']}: target {spec['target']} is already on the ref -- not a grain")
    if lang.key == "csharp" and m.rust_on_ref:
        raise SpecError(f"{spec['file']}: the Rust twin is on the ref -- the body would claim none")
    if lang.key == "rust" and not m.csharp_on_ref and not spec.get("allow_no_csharp"):
        raise SpecError(f"{spec['file']}: no C# twin on the ref -- a Rust port starts from the C# port "
                        "(set allow_no_csharp to override, with the reason in the notes)")


def render_body(spec: dict, m: Measure, ctx: Context) -> str:
    missing = [k for k in REQUIRED if not spec.get(k)]
    if missing:
        raise SpecError(f"{spec.get('file', '?')}: missing keys {', '.join(missing)}")
    lang = ctx.lang
    check_refusals(spec, m, lang)
    nb = m.nb
    rows = inventory(nb, lang, tuple(spec.get("force_solved", ())), tuple(spec.get("force_exo", ())),
                     tuple(spec.get("force_pre", ())))
    folder = str(PurePosixPath(spec["target"]).parent)
    notes = [render_note(n, ctx) for n in spec.get("notes", [])]
    gap = no_equivalent_bullet(detect_no_equivalent(nb), lang)
    measured = [alea_bullet(detect_alea(nb)), figure_bullet(detect_figures(nb), lang)]
    measured += [gap] if gap else []
    measured.append(siblings_bullet(siblings(m.folder_names, spec["target"], lang), lang, folder))
    if lang.key == "rust" and m.csharp_on_ref:
        measured.append(f"Jumeau C# sur `{ctx.ref}` : `{twin_of(spec['source'], 'csharp')}` — référence d'IDIOMES "
                        "seulement (le travail d'adaptation du premier portage), sans en copier les sorties.")
    ncode = len(rows)
    readme = spec.get("readme", "ligne du README de série mise à jour")
    bullets = [
        "Rejouer les MÊMES entrées que la source et retrouver les MÊMES valeurs : chaque valeur que la source "
        "affiche est retrouvée par le jumeau et portée par une assertion EXÉCUTABLE qui lève si la valeur diffère "
        "de l'attendu.",
        *measured,
        f"Les données et références que le jumeau Python AFFICHE et que le carnet {lang.label} reprend telles "
        "quelles restent des données CITÉES, marquées comme telles : jamais les présenter comme recalculées ici.",
        "Les exercices de la source deviennent des stubs compilables et exécutables sans erreur volontaire, "
        "`// TODO etudiant`, sans solution et sans indice AJOUTÉ : les consignes et les indices écrits dans la "
        "source sont conservés.",
        *notes,
        spec.get("deps_clause") or lang.deps_default,
        lang.link.format(readme=readme),
        lang.pairs,
        lang.run,
        "Le grain est clos sur une PR vérifiée, pas sur une tentative.",
    ]
    deps = ", ".join(import_roots(nb)) or "aucun import"
    table = "\n".join(render_row(r) for r in rows)
    return (f"{spec['title']}\nGrain: {spec['grain']}\n\nParent : #{spec['parent']}\n\n## Objet\n\n"
            f"{spec.get('objet', '')}\n\n"
            f"- Source Python : `{spec['source']}` ({len(nb.get('cells', []))} cellules, {ncode} code)\n"
            f"- Cible {lang.label} : `{spec['target']}` (à créer)\n"
            f"- Noyau canonique : {lang.kernel} ; toutes cellules code exécutées.\n\n"
            "## Cellules à porter\n\n"
            f"| Index source | Première ligne (verbatim) | Archétype | {lang.equivalent} |\n|---|---|---|---|\n"
            f"{table}\n\n## Acceptation\n\n" + "\n".join(f"- {b}" for b in bullets) +
            f"\n\nDépendances mesurées : {deps}\n\n---\n"
            f"*Depot depuis la spec a blanc (mandat user 20/11) : inventaire de cellules extrait VERBATIM du carnet "
            f"source `{m.sha[:12]}` (arbre `{ctx.ref}` = `{ctx.ref_sha}`) ; ce depot n'affirme aucune valeur "
            "numerique par lui-meme (celles des titres et des notes sont recopiees de la source). Archetype = "
            f"classification indicative, equivalents {lang.label} a affiner par le producteur.*\n")


# ---- the git reader: read-only, one repo given on the command line ------------------------------

class GitTree:
    def __init__(self, repo: str, ref: str = "origin/main") -> None:
        self.repo, self.ref = repo, ref

    def _git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", self.repo, *args], capture_output=True)

    def short_sha(self) -> str:
        return self._git("rev-parse", "--short=10", self.ref).stdout.decode("utf-8").strip()

    def exists(self, path: str) -> bool:
        return self._git("cat-file", "-e", f"{self.ref}:{path}").returncode == 0

    def blob(self, path: str) -> tuple[str, str]:
        r = self._git("rev-parse", f"{self.ref}:{path}")
        if r.returncode != 0:
            raise SpecError(f"{path} is not on {self.ref}")
        sha = r.stdout.decode("utf-8").strip()
        return sha, self._git("cat-file", "-p", sha).stdout.decode("utf-8")

    def list_dir(self, folder: str) -> list[str]:
        r = self._git("ls-tree", "--name-only", self.ref, folder.rstrip("/") + "/")
        return [ln for ln in r.stdout.decode("utf-8").splitlines() if ln]


def measure(tree, spec: dict) -> Measure:
    sha, raw = tree.blob(spec["source"])
    return Measure(sha=sha, nb=json.loads(raw), target_on_ref=tree.exists(spec["target"]),
                   rust_on_ref=tree.exists(twin_of(spec["source"], "rust")),
                   csharp_on_ref=tree.exists(twin_of(spec["source"], "csharp")),
                   folder_names=tree.list_dir(str(PurePosixPath(spec["target"]).parent)))


def load_specs(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    defaults = data.get("defaults", {})
    return [{**defaults, **s} for s in data.get("specs", [])]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", required=True, help="checkout of the notebook repository (read-only use)")
    ap.add_argument("--specs", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--ref", default="origin/main")
    ap.add_argument("--grain-tag", default=None,
                    help="path of grain_tag.py to run on each body (default: <repo>/scripts/grain_tag.py if present)")
    args = ap.parse_args(argv)
    tree = GitTree(args.repo, args.ref)
    ref_sha = tree.short_sha()
    if not ref_sha:
        print(f"cannot resolve {args.ref} in {args.repo}", file=sys.stderr)
        return 1
    today = datetime.now(timezone.utc).strftime("%d/%m")
    tag = Path(args.grain_tag) if args.grain_tag else Path(args.repo) / "scripts" / "grain_tag.py"
    args.out.mkdir(parents=True, exist_ok=True)
    written, refused = [], []
    for spec in load_specs(args.specs):
        ctx = Context(lang=LANGS[spec.get("lang", "csharp")], ref=args.ref, ref_sha=ref_sha, today=today)
        try:
            m = measure(tree, spec)
            body = render_body(spec, m, ctx)
        except SpecError as exc:
            refused.append(str(exc))
            print(f"REFUSED {exc}")
            continue
        p = args.out / f"{spec['file']}.md"
        p.write_text(body, encoding="utf-8", newline="\n")
        tag_rc = None
        if tag.is_file():
            r = subprocess.run([sys.executable, "-X", "utf8", "-I", str(tag), "--body-file", str(p)],
                               capture_output=True, text=True, encoding="utf-8", errors="replace")
            tag_rc = r.returncode
        written.append({"file": spec["file"], "title": spec["title"], "source": spec["source"],
                        "target": spec["target"], "source_blob": m.sha, "ref": ref_sha, "grain_tag_rc": tag_rc})
        print(f"{spec['file']:<20} code={sum(1 for _ in code_cells(m.nb)):2d} bytes={len(body):5d} "
              f"blob={m.sha[:12]} grain_tag rc={tag_rc}")
    (args.out / "specs.json").write_text(json.dumps(written, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"ref {args.ref}={ref_sha} | written {len(written)} | refused {len(refused)}")
    return 2 if refused else 0


if __name__ == "__main__":
    sys.exit(main())
