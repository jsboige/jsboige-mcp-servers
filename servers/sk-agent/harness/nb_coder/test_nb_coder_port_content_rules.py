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
