#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7416ac16c91e150aae5a75dd251d0c1a4c2f5c2c
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_coord_refs.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Offline tests for the coordination-reference repair (20/11 MGS-29 #27133): the Python
twin's « [EPIC #12373] » lines were pinned as prose « à recopier TELLE QUELLE », the model
obeyed, and the coord-refs gate failed the grain after 44 min of work. Two layers: the pin
drops those lines, and the in-session prose round repairs what still slips through.
Fixture lines are VERBATIM from the MGS-29 twin and build. No engine, no MCP, no GitHub."""

import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)

# ---- verbatim MGS-29 lines (twin MGS-29-GA-vs-Mealpy.ipynb cells 17/18/21, build cells 17/18)
TWIN_PLACE = ("**Place dans l'Epic** : MGS-29 est la **paire 8/9** (Default GA compose MGS vs "
              "BaseGA mealpy) — voir [EPIC #12373](https://github.com/jsboige/CoursIA/issues/12373)"
              ". Paires deja livrees (MGS-22 a MGS-28) : PSO, DifferentialEvolution, "
              "SimulatedAnnealing, WhaleOptimisation, EquilibriumOptimizer, "
              "ForensicBasedInvestigation, BareBonesPSO.")
TWIN_COUNTER = ("**Contre-mesure croisee** : `conflits_C` / `conflits_P` sont "
                "double-comptabilisees et coincident sur les 4 graines ; toute divergence "
                "re-signale une derive du pont.")
TWIN_17 = f"## Resume et suite pour l'EPIC\n\n{TWIN_PLACE}\n\n{TWIN_COUNTER}"
REF_BULLET = ("- Comparaison appariée MGS ↔ mealpy : "
              "[EPIC #12373](https://github.com/jsboige/CoursIA/issues/12373).")
FIX_BULLET = ("- Le correctif atomique de MetaGeneticSharp (#50) rétablit par défaut la "
              "mutation de l'hôte pour le PSO canonique; l'option explicite "
              "`noMutation: true` conserve le comportement historique.")
TWIN_18 = f"## Références et provenance\n\n{REF_BULLET}\n{FIX_BULLET}\n"
LECTURE = ("- **La question directrice de la campagne** : "
           "[EPIC #12373](https://github.com/jsboige/CoursIA/issues/12373) — à budget "
           "d'évaluations égal, les écarts entre la bibliothèque C# et la référence Python "
           "sont-ils **systématiques** (coût) ou **spécifiques** (qualité) ?")
TWIN_21 = f"## Pour aller plus loin\n\n**Lectures.**\n\n{LECTURE}"
FOOTER = "> Carnet issu de l'EPIC #26534."
BUILT_PLACE = ("**Place dans l'Epic** : MGS-29 est la **paire 8/9** (GA canonique noyau vs "
               "port) — voir [EPIC #12373](https://github.com/jsboige/CoursIA/issues/12373).")
BUILT_COUNTER = ("**Contre-mesure croisée** : `conflits_noyau` / `conflits_port` sont "
                 "double-comptabilisées et coïncident sur les 4 graines ; toute divergence "
                 "re-signale une dérive d'implémentation.")
BUILT_17 = f"## Résumé et suite pour l'EPIC\n\n{BUILT_PLACE}\n\n{BUILT_COUNTER}"
BUILT_18 = (f"## Références et provenance\n\n{REF_BULLET}\n{FIX_BULLET}\n- Carnet source C# : "
            "[MGS-29-GA-vs-Mealpy.ipynb](MGS-29-GA-vs-Mealpy.ipynb) — ce carnet Rust en est "
            "le jumeau intra-Rust.")


def md(src):
    return {"cell_type": "markdown", "metadata": {}, "source": src}


def code(src):
    return {"cell_type": "code", "metadata": {}, "source": src, "execution_count": None,
            "outputs": []}


def write_nb(path: Path, cells: list) -> Path:
    path.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                                "nbformat_minor": 5}, ensure_ascii=False), encoding="utf-8")
    return path


def twin_cells():
    return [md("# MGS-29"), code("import mealpy"), md(TWIN_17), md(TWIN_18), md(TWIN_21)]


# ---------------------------------------------------------------- layer 1: the pin
def test_strip_coord_refs_drops_only_reference_lines():
    t, n = D.strip_coord_refs(TWIN_18)
    assert n == 1 and "issues/12373" not in t
    assert "## Références et provenance" in t and FIX_BULLET in t
    t17, n17 = D.strip_coord_refs(TWIN_17)
    assert n17 == 1 and TWIN_COUNTER in t17 and "Place dans l'Epic" not in t17
    assert "\n\n\n" not in t17                       # no hole left where the line was
    # the footer note is the one legit form, and plain « l'EPIC » prose is no reference
    assert D.strip_coord_refs(f"Fin.\n\n{FOOTER}") == (f"Fin.\n\n{FOOTER}", 0)
    assert D.strip_coord_refs("## Resume et suite pour l'EPIC")[1] == 0
    assert D.strip_coord_refs("") == ("", 0)


def _section(prompt: str, idx: int) -> str:
    head = f"<cellule {idx} — prose à recopier>"
    assert head in prompt
    rest = prompt.split(head, 1)[1]
    return rest.split("<cellule ", 1)[0]


def test_creation_prompt_pins_twin_prose_without_coord_refs():
    seg = [{"idx": i, "cell_type": "markdown"} for i in (2, 3, 4)]
    p = D.creation_json_prompt(seg, 5, "", src_cells=twin_cells())
    assert "issues/12373" not in _section(p, 2) and TWIN_COUNTER in _section(p, 2)
    assert "issues/12373" not in _section(p, 3) and FIX_BULLET in _section(p, 3)
    # the footer cell keeps its reading links: the gate exempts it with its note
    assert LECTURE in _section(p, 4)
    assert "2 ligne(s)" in p and "ne les rétablis pas" in p
    assert "> Carnet issu de l'EPIC #N." in p
    # nothing stripped, no notice
    clean = D.creation_json_prompt([{"idx": 0, "cell_type": "markdown"}], 5, "",
                                   src_cells=twin_cells())
    assert "ne les rétablis pas" not in clean and "# MGS-29" in clean


# ---------------------------------------------------------------- shared detector == gate
def _gate_cells(tmp_path, twin, built):
    src = write_nb(tmp_path / "twin.ipynb", twin)
    bp = write_nb(tmp_path / "built.ipynb", built)
    g = {x["gate"]: x for x in D.run_gates(src, bp, create_mode=True)}["coord-refs"]
    return g, [h["cell"] for h in D.coord_ref_hits(D._cells(bp), D._cells(src))]


def test_coord_ref_hits_is_the_gate_rule(tmp_path):
    twin = twin_cells()
    built = [md("# MGS-29"),                          # identical to the twin: not delta
             code("// see #12373 for the protocol\nlet x = 1;"),     # code cell, delta
             md(BUILT_17), md(BUILT_18),
             md(TWIN_21 + "\n\n" + FOOTER)]           # footer cell with its note: exempt
    g, hits = _gate_cells(tmp_path, twin, built)
    assert g["ok"] is False and g["detail"]["cells"] == hits == [1, 2, 3]
    # without the note, the footer cell's link is a reference like any other
    built[4] = md(TWIN_21 + "\n")
    g2, hits2 = _gate_cells(tmp_path, twin, built)
    assert g2["detail"]["cells"] == hits2 == [1, 2, 3, 4]
    # a copy identical to the twin is not the build's doing (delta judgement)
    built[2] = md(TWIN_17)
    _, hits3 = _gate_cells(tmp_path, twin, built)
    assert 2 not in hits3
    clean = [md("# MGS-29"), code("let x = 1;"), md(D.strip_coord_refs(BUILT_17)[0]),
             md(D.strip_coord_refs(BUILT_18)[0]), md(TWIN_21 + "\n\n" + FOOTER)]
    g4, hits4 = _gate_cells(tmp_path, twin, clean)
    assert g4["ok"] is True and hits4 == []


# ---------------------------------------------------------------- layer 2: the prose round
def test_md_defects_merges_and_keeps_to_markdown():
    twin = twin_cells()
    built = [md("# MGS-29"), code("// see #12373\nlet s = \"случай\";"),
             md(BUILT_17.replace("dérive", "дрейф")), md(BUILT_18),
             md(TWIN_21 + "\n\n" + FOOTER)]
    got = D.md_defects(built, twin, create_mode=True, from_spec=False)
    assert [d["idx"] for d in got] == [2, 3]          # code cell 1 left to the gates
    both, coord = got
    assert both["excerpt"] and both["coord_excerpt"]  # one entry, both defects
    assert "issues/12373" not in both["twin_source"] and TWIN_COUNTER in both["twin_source"]
    assert "excerpt" not in coord and "issues/12373" in coord["coord_excerpt"]
    assert coord["current_source"] == BUILT_18
    # correction mode: no twin authority, so only the coordination class is repaired
    fix = D.md_defects(built, twin, create_mode=False, from_spec=False)
    assert all("excerpt" not in d for d in fix) and [d["idx"] for d in fix] == [2, 3]
    # a [SPEC] placeholder is no prose authority
    spec = D.md_defects(built, twin, create_mode=True, from_spec=True)
    assert spec[0]["twin_source"] == ""
    assert len(D.md_defects([md(f"voir l'epic #{i}") for i in range(20)], [], True, False)) \
        == D.MD_REPAIR_MAX_CELLS


def test_md_repair_prompt_renders_coord_entries():
    p = D.md_repair_prompt([{"idx": 3, "coord_excerpt": "mealpy : [EPIC #12373](",
                             "current_source": BUILT_18}], "conv")
    assert "### Cellule 3 (markdown)" in p and "TEXTE ACTUEL (complet)" in p
    assert BUILT_18 in p and "RÉFÉRENCE DE COORDINATION à retirer" in p
    assert "mealpy : [EPIC #12373](" in p and "absente du jumeau" not in p
    assert "> Carnet issu de l'EPIC #N." in p and "index inchangés" in p and "conv" in p
    merged = D.md_repair_prompt([{"idx": 2, "excerpt": "сравнимый", "twin_source": "T",
                                  "coord_excerpt": "voir [EPIC #12373]",
                                  "current_source": "X"}])
    assert "PROSE DU JUMEAU PYTHON" in merged and "RÉFÉRENCE DE COORDINATION" in merged
    assert "TEXTE ACTUEL (complet)" not in merged     # the twin is the authority there


def _round(tmp_path, monkeypatch, built, answer, create_mode=True, rounds=1):
    nb = write_nb(tmp_path / "scratch.ipynb", built)
    prompts = []

    async def fake_retry(sk, args, rec, stage, prompt, conv, max_tokens=None):
        prompts.append((stage, prompt))
        return {"conversation_id": "c2"}

    async def fake_parse(sk, args, rec, stage, env, conv, max_tokens=None):
        return ({"cells": answer} if answer is not None else None), env

    monkeypatch.setattr(D, "sk_call_retry", fake_retry)
    monkeypatch.setattr(D, "parse_or_repair", fake_parse)
    rec = {}
    conv = asyncio.run(D.repair_markdown_defects(
        None, SimpleNamespace(repair_rounds=rounds), rec, nb, twin_cells(), "c1", "",
        create_mode, False))
    return conv, prompts, rec, D._cells(nb)


def _built():
    return [md("# MGS-29"), code("let x = 1;"), md(BUILT_17), md(BUILT_18),
            md(TWIN_21 + "\n\n" + FOOTER)]


def test_prose_round_repairs_mgs29_coord_refs(tmp_path, monkeypatch):
    answer = [{"idx": 2, "cell_type": "markdown", "source": D.strip_coord_refs(BUILT_17)[0]},
              {"idx": 3, "cell_type": "markdown", "source": D.strip_coord_refs(BUILT_18)[0]},
              {"idx": 0, "cell_type": "markdown", "source": "# réécrit"}]   # never asked
    conv, prompts, rec, cells = _round(tmp_path, monkeypatch, _built(), answer)
    assert conv == "c2" and [s for s, _ in prompts] == ["2.6-mdrepair"]
    entry = rec["md_repairs"][0]
    assert entry["defects"] == {"foreign-script": 0, "coord-refs": 2}
    assert sorted(entry["replaced"]) == [2, 3] and entry["out_of_scope"] == [0]
    assert rec["coord_hits_after"] == 0 and rec["md_hits_after"] == 0
    assert D._text(cells[0]["source"]) == "# MGS-29"
    assert BUILT_COUNTER in D._text(cells[2]["source"])


def test_prose_round_correction_mode_and_judge(tmp_path, monkeypatch):
    # an answer that keeps the reference: the round records it, the gates stay the judge
    same = [{"idx": 3, "cell_type": "markdown", "source": BUILT_18}]
    _, _, rec, _ = _round(tmp_path, monkeypatch, _built(), same, create_mode=False)
    assert rec["coord_hits_after"] == 2 and "md_hits_after" not in rec
    # unparsed answer: recorded, nothing applied
    _, _, rec2, cells2 = _round(tmp_path, monkeypatch, _built(), None)
    assert rec2["md_repairs"][0]["verdict"] == "unparsed"
    assert D._text(cells2[3]["source"]) == BUILT_18


def test_prose_round_skips_when_clean_or_disabled(tmp_path, monkeypatch):
    clean = _built()
    clean[2] = md(D.strip_coord_refs(BUILT_17)[0])
    clean[3] = md(D.strip_coord_refs(BUILT_18)[0])
    conv, prompts, rec, _ = _round(tmp_path, monkeypatch, clean, [])
    assert conv == "c1" and prompts == [] and rec == {}
    conv2, prompts2, rec2, _ = _round(tmp_path, monkeypatch, _built(), [], rounds=0)
    assert conv2 == "c1" and prompts2 == [] and rec2 == {}
