#!/usr/bin/env python3
"""
Validate that the canonical template config and the README example blocks
all parse via the existing schema (sk_agent_config.validate_config).

Issue: #3410 — Acceptance criterion 2:
"Les exemples de configuration sont validés par Pydantic."

The schema in sk_agent_config.py uses dataclasses (not Pydantic), but the
project's validate_config() is the equivalent contract. This test exercises:
  1. The canonical template (sk_agent_config.template.json) validates cleanly
  2. The minimal example in mcps/internal/servers/sk-agent/README.md validates
  3. All model/agent/MCP references in the template resolve correctly
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from sk_agent_config import (  # noqa: E402
    SKAgentConfig,
    load_config,
    validate_config,
)

TEMPLATE_PATH = HERE / "sk_agent_config.template.json"
README_PATH = HERE / "README.md"


# ---------------------------------------------------------------------------
# Template config validation (acceptance criterion 2)
# ---------------------------------------------------------------------------


def test_template_loads_without_errors():
    """The canonical template config must load without errors."""
    cfg = load_config(str(TEMPLATE_PATH))
    assert isinstance(cfg, SKAgentConfig)
    assert cfg.config_version == 2
    assert cfg.default_agent == "analyst"
    assert cfg.default_vision_agent == "vision-analyst"


def test_template_validate_returns_no_errors():
    """The validate_config() function must return no errors for the template."""
    with open(TEMPLATE_PATH, encoding="utf-8") as f:
        raw = json.load(f)
    errors = validate_config(raw)
    assert errors == [], f"Template validation errors: {errors}"


def test_template_counts_match_expected_baseline():
    """Lock in the canonical counts derived from the template (frozen 2026-09-04).

    If you legitimately change these counts, update both the template and the
    test in the same commit.
    """
    cfg = load_config(str(TEMPLATE_PATH))
    assert len(cfg.models) == 16, f"models: {len(cfg.models)}"
    assert len(cfg.agents) == 32, f"agents: {len(cfg.agents)}"
    assert len(cfg.mcps) == 5, f"mcps: {len(cfg.mcps)}"
    assert len(cfg.conversations) == 11, f"conversations: {len(cfg.conversations)}"

    inline_total = sum(len(c.inline_agents) for c in cfg.conversations)
    assert inline_total == 15, f"inline agents: {inline_total}"

    enabled = sum(1 for m in cfg.models if m.enabled)
    assert enabled == 12, f"enabled models: {enabled}"

    mem_agents = sum(1 for a in cfg.agents if a.memory.enabled)
    assert mem_agents == 5, f"memory-enabled agents: {mem_agents}"


def test_template_all_agent_model_refs_resolve():
    """Every agent's model must reference an existing model in the pool."""
    cfg = load_config(str(TEMPLATE_PATH))
    model_ids = {m.id for m in cfg.models}
    for a in cfg.agents:
        assert a.model in model_ids, (
            f"agent {a.id!r} references unknown model {a.model!r}"
        )


def test_template_all_agent_mcp_refs_resolve():
    """Every agent's MCPs must reference existing MCPs in the pool."""
    cfg = load_config(str(TEMPLATE_PATH))
    mcp_ids = {m.id for m in cfg.mcps}
    for a in cfg.agents:
        for mcp_ref in a.mcps:
            assert mcp_ref in mcp_ids, (
                f"agent {a.id!r} references unknown mcp {mcp_ref!r}"
            )


def test_template_default_agents_exist():
    """default_agent and default_vision_agent must reference existing agents."""
    cfg = load_config(str(TEMPLATE_PATH))
    assert cfg.get_default_agent() is not None
    assert cfg.get_default_vision_agent() is not None
    assert cfg.get_default_agent().id == "analyst"
    assert cfg.get_default_vision_agent().id == "vision-analyst"


def test_template_conversation_agent_refs_resolve():
    """Every agent ref in a conversation must exist in agents OR inline_agents."""
    cfg = load_config(str(TEMPLATE_PATH))
    top_level = {a.id for a in cfg.agents}
    for conv in cfg.conversations:
        inline = {ia.id for ia in conv.inline_agents}
        for ref in conv.agents:
            assert ref in top_level or ref in inline, (
                f"conversation {conv.id!r} references unknown agent {ref!r}"
            )


def test_template_all_conversation_types_valid():
    """All conversation types must be in the allowed Literal set."""
    cfg = load_config(str(TEMPLATE_PATH))
    valid = {"sequential", "concurrent", "group_chat", "handoff", "magentic"}
    for conv in cfg.conversations:
        assert conv.type in valid, (
            f"conversation {conv.id!r} has invalid type {conv.type!r}"
        )


# ---------------------------------------------------------------------------
# README inline example validation
# ---------------------------------------------------------------------------


def _extract_readme_json_block() -> dict:
    """Extract the v2 config ```json ... ``` block from the README."""
    text = README_PATH.read_text(encoding="utf-8")
    # Find the v2 config example block by anchor then take the first fenced JSON
    anchor = "### v2 Config (agent-centric)"
    idx = text.find(anchor)
    assert idx >= 0, "No v2 Config section in README"
    sub = text[idx:]
    match = re.search(r"```json\s*(\{.*?\})\s*```", sub, re.DOTALL)
    assert match is not None, "No v2 config JSON example found in README"
    return json.loads(match.group(1))


def test_readme_v2_example_validates():
    """The v2 Config JSON example embedded in README.md must validate."""
    example = _extract_readme_json_block()
    errors = validate_config(example)
    assert errors == [], f"README example validation errors: {errors}"


def test_readme_v2_example_loads():
    """The v2 Config JSON example must be parseable by load_config()."""
    example = _extract_readme_json_block()
    # load_config() expects a file path; parse manually
    from sk_agent_config import _parse_config  # noqa: PLC0415
    cfg = _parse_config(example)
    assert cfg.config_version == 2
    assert cfg.default_agent == "analyst"
    # The example has 2 models (text + vision) and 2 agents
    assert len(cfg.models) == 2
    assert len(cfg.agents) == 2
    assert cfg.default_vision_agent == "vision-analyst"


# ---------------------------------------------------------------------------
# Inventory doc / generator check (acceptance criterion 1)
# ---------------------------------------------------------------------------


def test_inventory_generator_check_mode_passes():
    """generate_inventory.py --check must succeed (no drift)."""
    import subprocess  # noqa: PLC0415
    result = subprocess.run(
        [sys.executable, str(HERE / "generate_inventory.py"), "--check"],
        capture_output=True,
        text=True,
        cwd=str(HERE),
    )
    assert result.returncode == 0, (
        f"drift detected:\nSTDOUT: {result.stdout}\nSTDERR: {result.stderr}"
    )
    assert "OK:" in result.stdout
