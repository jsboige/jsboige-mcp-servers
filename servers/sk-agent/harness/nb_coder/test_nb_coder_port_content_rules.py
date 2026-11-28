# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_port_content_rules.py
# Source of truth: jsboige/jsboige-mcp-servers since ms#1860.
# -----------------------------------------------------------------------------
#!/usr/bin/env python3
"""Offline tests: the two content rules a port must follow, in the prompts that write code.

2026-11-22 salvage — two reject classes the verifier kept finding round after round:
- CoursIA#28102: each exercise stub was paired with an « expected results » block that
  computed the answer behind a `false` switch (4 major findings at round 8).
- ICT-15 c/d/j/k: the twin draws its data from numpy (PCG64 + SeedSequence + normals);
  hand-rolled generators drew other data, and pasting the twin's outputs was rejected too.
The rule must reach the code-writing stage (creation slices) AND every revision round,
whether or not the twin view is attached. No engine, no MCP, no GitHub."""

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)

ISSUE = {"title": "T", "body": "B"}
FINDINGS = [{"cell": 14, "severity": "major", "detail": "le bloc resultatsAttendus donne la solution"}]


def _body(rules: str) -> str:
    """The rules without their header line (the revision prompt has its own header)."""
    return rules.split("\n", 1)[1]


def test_the_rules_name_both_classes():
    r = D.PORT_CONTENT_RULES
    assert "EXERCICES" in r and "JAMAIS sa solution" in r and "commutateur" in r
    assert "ALÉA NUMPY" in r and "PCG64" in r and "tableau littéral" in r
    # the literal is the INPUT data; outputs stay computed (27735/27740 rejected pasted outputs)
    assert "Ne recopie jamais une SORTIE du jumeau" in r


def test_the_rules_forbid_stub_results_and_recipe_substitution():
    """2026-11-23 batch o13: two builder-side classes the verifier rejected 4 rounds each.
    - 27741: every source computation was delegated to exercise stubs (neutral zeros, TODO);
    - 27742: library calls replaced by graph proxies / a hand-rolled simulation, and the
      regimes R0/R1 left «à compléter». Both rules must reach creation AND revision."""
    r = D.PORT_CONTENT_RULES
    assert "CALCULS ≠ EXERCICES" in r
    assert "jamais le remplacement d'un calcul de la source" in r
    assert "R0/R1 restent à compléter" in r
    assert "RECETTE À L'IDENTIQUE" in r
    assert "équivalent C#" in r and "mesure " in r and "AUTRE CHOSE" in r
    assert "mêmes définitions, mêmes paramètres, même quantité" in r
    body = _body(r)
    assert body in D.revision_prompt(ISSUE, "view", FINDINGS, twin_view="<twin>")


def test_the_rules_pin_exercises_to_the_source_and_forbid_partial_segments():
    """2026-11-23 batch o14, two classes measured on the same material:
    - CoursIA#27741 (verify-reject, 2 major): the builder converted source
      *definitions* (`centre_m`, `predire_recolle`, `session_bookmaker`) into
      exercise stubs and doubled each with a `<name>_calcule` ordinary cell — the
      stub was not solution-free AND the computation was a duplicate. The source's
      own exercises are elsewhere (cells 29-34); those, and only those, are the
      additions.
    - CoursIA#27742 (stage2-short-segment:8): the model withheld cells 12 and 14
      because a dependency « n'existe pas dans les cellules précédentes ». A partial
      segment kills the whole generation, so creation must say so outright.
    """
    r = D.PORT_CONTENT_RULES
    assert "EXERCICES DE LA SOURCE, RIEN DE PLUS" in r
    assert "jamais convertie en stub" in r
    assert "<nom>_calcule" in r
    assert "AUCUNE CELLULE OMISE" in r
    assert "segment partiel" in r
    # 2026-11-23 batch o15, CoursIA#27740: the model refused twice (« Je ne peux pas
    # fournir un port complet et fidèle des simulations et des proxys dans cette
    # tranche ») although the sources were in the prompt — the twin uses gudhi, which
    # has no C# equivalent, and no rule turned that into a legal move.
    assert "BIBLIOTHÈQUE PYTHON SANS ÉQUIVALENT C#" in r
    assert "union-find" in r
    assert "est un ÉCHEC du carnet" in r
    # 2026-11-23 batch o15, CoursIA#27741/#27742: the issues' « Cellules à porter »
    # table marks executed cells as « exercice » (⇒ stub) and names ScottPlot, yet the
    # acceptance demands numeric parity and the conventions mandate SVG. The table is
    # the issue's own heuristic classification — the builder must not let it convert
    # an executed cell into a stub nor swap the house figure convention for a package.
    assert "Le tableau « Cellules à porter » de l'issue est INDICATIF" in r
    assert "la stubber casse la clause de parité numérique" in r
    # 2026-11-23 batch o16, CoursIA#27740: the model refused at the FIRST cell —
    # « sans risquer de substituer un calcul non équivalent » — because the RECETTE
    # rule read as a ban on any hand-written reimplementation. The doctrine must
    # name the frontier: same definition = réimplémentation (expected), another
    # method = substitution (forbidden).
    assert "est une RÉIMPLÉMENTATION" in r
    assert "mesure autre chose" in r
    assert "craint de « substituer un calcul non " in r
    body = _body(r)
    assert body in D.creation_json_prompt(
        [{"idx": 1, "cell_type": "code", "titre": "x"}], 3, "")


def test_every_creation_slice_carries_the_rules():
    seg = [{"idx": 3, "cell_type": "code", "titre": "x"}]
    assert D.PORT_CONTENT_RULES in D.creation_json_prompt(seg, 5, "")
    twin = [{"cell_type": "markdown", "source": "# T"}, {"cell_type": "code", "source": "x = 1"},
            {"cell_type": "markdown", "source": "fin"}]
    assert D.PORT_CONTENT_RULES in D.creation_json_prompt(
        [{"idx": 1, "cell_type": "code"}], 3, "conv", src_cells=twin)


def test_every_revision_round_carries_the_rules_with_or_without_twin_view():
    body = _body(D.PORT_CONTENT_RULES)
    plain = D.revision_prompt(ISSUE, "view", FINDINGS)
    with_twin = D.revision_prompt(ISSUE, "view", FINDINGS, twin_view="<twin>")
    for p in (plain, with_twin):
        assert body in p
        # inside the Règles section, before the answer format
        assert p.index("## Règles") < p.index(body) < p.index("Rends UNIQUEMENT")
