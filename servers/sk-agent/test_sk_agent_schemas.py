#!/usr/bin/env python3
"""
Unit tests for ``sk_agent_schemas`` (Pydantic v2 schema for sk-agent).

These tests cover the acceptance criteria of roo-extensions#3406:
- Suite ``test_config.py`` is unchanged (covered by ``test_config.py``).
- V1 / V2 payloads round-trip through ``SKAgentConfig.model_validate``.
- Invalid references (``agent.model``, ``agent.mcps``, ``default_agent``,
  ``default_vision_agent``, ``conversation.agents``) fail with readable
  error messages.
- Profiles, capabilities and env-var fields are typed and constrained.
- No secret literal: ``api_key`` is not a field on ``ModelSpec``; only
  ``api_key_env`` (env-var name, validated against ``ENV_VAR_NAME_PATTERN``)
  is accepted.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from sk_agent_schemas import (
    AgentPreset,
    CapabilityProfile,
    ConversationPreset,
    ConversationType,
    ENV_VAR_NAME_PATTERN,
    EnvVarName,
    ExecutionProfile,
    ModelSpec,
    SCHEMA_VERSION,
    SKAgentConfig,
    ToolSpec,
    validate_config_payload,
)

#: Adapter used to validate raw strings against the EnvVarName alias.
_env_var_name_adapter = TypeAdapter(EnvVarName)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def v2_payload() -> dict:
    """A representative v2 payload that should validate cleanly."""
    return {
        "config_version": 2,
        "max_recursion_depth": 2,
        "default_agent": "analyst",
        "default_vision_agent": "vision-analyst",
        "system_prompt": "You are a helpful assistant.",
        "models": [
            {
                "id": "glm-5",
                "base_url": "https://api.z.ai/v4",
                "api_key_env": "GLM_API_KEY",
                "model_id": "glm-5",
                "capabilities": {"vision": False, "thinking": True},
                "context_window": 200_000,
                "description": "GLM-5 reasoning",
            },
            {
                "id": "glm-4.6v",
                "base_url": "https://api.z.ai/v4",
                "api_key_env": "GLM_API_KEY",
                "model_id": "glm-4.6v",
                "capabilities": {"vision": True, "thinking": False},
                "context_window": 128_000,
                "description": "GLM-4.6V vision",
            },
        ],
        "tools": [
            {
                "id": "searxng",
                "description": "Web search",
                "command": "npx",
                "args": ["-y", "mcp-searxng"],
                "env": {"SEARXNG_URL": "SEARXNG_URL"},
            },
            {
                "id": "playwright",
                "description": "Browser",
                "command": "npx",
                "args": ["-y", "@playwright/mcp"],
            },
        ],
        "agents": [
            {
                "id": "analyst",
                "description": "General analyst",
                "model": "glm-5",
                "system_prompt": "You are an analyst.",
                "mcps": ["searxng", "playwright"],
                "execution": {
                    "temperature": 0.2,
                    "max_tokens": 8192,
                    "memory_collection": "analyst-memory",
                },
            },
            {
                "id": "vision-analyst",
                "description": "Image analyst",
                "model": "glm-4.6v",
                "system_prompt": "You are a vision analyst.",
                "mcps": [],
            },
        ],
        "conversations": [
            {
                "id": "review-handover",
                "description": "Analyst + vision analyst",
                "type": "handoff",
                "agents": ["analyst", "vision-analyst"],
                "max_rounds": 5,
            }
        ],
    }


@pytest.fixture
def v1_payload() -> dict:
    """A v1 (model-centric) payload, NOT pre-migrated.

    ``validate_config_payload`` works on v2 only; callers run
    ``migrate_config_v1_to_v2`` first (the facade already does so in
    ``load_config``). This fixture documents the expected migration
    input shape.

    Note: ``api_key`` is intentionally omitted. The schema rejects
    literal API keys (``extra=forbid``); legacy configs that stored
    one should be migrated to ``api_key_env`` (or stripped) before
    they reach the schema. The legacy facade kept a default of
    ``"no-key"`` for this exact reason, and the migration only needs
    to demonstrate the structural translation ``mcps`` -> ``tools``
    and ``vision`` -> ``capabilities.vision``.
    """
    return {
        "default_ask_model": "glm-5",
        "default_vision_model": "glm-4.6v",
        "max_recursion_depth": 2,
        "models": [
            {
                "id": "glm-5",
                "enabled": True,
                "base_url": "https://api.z.ai/v4",
                "model_id": "glm-5",
                "vision": False,
                "description": "Text model",
                "context_window": 200_000,
            },
            {
                "id": "glm-4.6v",
                "enabled": True,
                "base_url": "https://api.z.ai/v4",
                "model_id": "glm-4.6v",
                "vision": True,
                "description": "Vision model",
                "context_window": 128_000,
            },
        ],
        "mcps": [
            {
                "name": "searxng",
                "description": "Web search",
                "command": "npx",
                "args": ["-y", "mcp-searxng"],
            }
        ],
        "system_prompt": "You are a helpful assistant.",
    }


# ---------------------------------------------------------------------------
# Acceptance: round-trip v1/v2
# ---------------------------------------------------------------------------


def test_v2_round_trip(v2_payload):
    """A v2 payload validates and produces a queryable SKAgentConfig."""
    cfg, errors = validate_config_payload(v2_payload)
    assert cfg is not None, f"validation failed: {errors}"
    assert errors == []
    assert isinstance(cfg, SKAgentConfig)
    assert cfg.config_version == SCHEMA_VERSION
    assert {m.id for m in cfg.models} == {"glm-5", "glm-4.6v"}
    assert {t.id for t in cfg.tools} == {"searxng", "playwright"}
    assert cfg.get_model("glm-5") is not None
    assert cfg.get_model("glm-5").capabilities.thinking is True
    assert cfg.get_tool("searxng").args == ["-y", "mcp-searxng"]


def test_v1_payload_validates_after_migration(v1_payload):
    """A v1 payload must be migrated before schema validation.

    This documents the contract: the facade migrates then validates;
    here we exercise the migration explicitly so the test stays
    independent of the facade module.
    """
    # Imported lazily so the test does not depend on the facade when
    # only the schema is exercised.
    from sk_agent_config import migrate_config_v1_to_v2

    migrated = migrate_config_v1_to_v2(v1_payload)
    cfg, errors = validate_config_payload(migrated)
    assert cfg is not None, f"validation failed: {errors}"
    assert any(a.id == "glm-5" for a in cfg.agents)
    assert any(a.id == "glm-4.6v" for a in cfg.agents)


def test_config_version_must_be_2():
    """``config_version`` is pinned to 2; v1 configs are migrated upstream."""
    with pytest.raises(ValidationError) as exc:
        SKAgentConfig.model_validate({"config_version": 1})
    assert "config_version" in str(exc.value)


# ---------------------------------------------------------------------------
# Acceptance: invalid references → readable errors
# ---------------------------------------------------------------------------


def test_agent_model_reference_unknown(v2_payload):
    v2_payload["agents"][0]["model"] = "ghost-model"
    cfg, errors = validate_config_payload(v2_payload)
    assert cfg is None
    assert any("agent" in e and "ghost-model" in e for e in errors), errors


def test_agent_mcp_reference_unknown(v2_payload):
    v2_payload["agents"][0]["mcps"] = ["ghost-mcp"]
    cfg, errors = validate_config_payload(v2_payload)
    assert cfg is None
    assert any("tools" in e and "ghost-mcp" in e for e in errors), errors


def test_default_agent_unknown(v2_payload):
    v2_payload["default_agent"] = "ghost-default"
    cfg, errors = validate_config_payload(v2_payload)
    assert cfg is None
    assert any("default_agent" in e and "ghost-default" in e for e in errors), errors


def test_default_vision_agent_unknown(v2_payload):
    v2_payload["default_vision_agent"] = "ghost-vision"
    cfg, errors = validate_config_payload(v2_payload)
    assert cfg is None
    assert any("default_vision_agent" in e for e in errors), errors


def test_conversation_unknown_agent(v2_payload):
    v2_payload["conversations"][0]["agents"].append("ghost-conv-agent")
    cfg, errors = validate_config_payload(v2_payload)
    assert cfg is None
    assert any("conversation" in e and "ghost-conv-agent" in e for e in errors), errors


def test_inline_agent_unknown_model(v2_payload):
    v2_payload["conversations"][0]["inline_agents"] = [
        {
            "id": "ephemeral",
            "model": "ghost-model",
            "system_prompt": "",
            "mcps": [],
        }
    ]
    cfg, errors = validate_config_payload(v2_payload)
    assert cfg is None
    assert any("ghost-model" in e for e in errors), errors


# ---------------------------------------------------------------------------
# Acceptance: profiles / capabilities / env-vars typed
# ---------------------------------------------------------------------------


def test_capability_profile_defaults():
    cap = CapabilityProfile()
    assert cap.vision is False
    assert cap.thinking is False
    assert cap.description == ""


def test_execution_profile_ranges_rejected():
    with pytest.raises(ValidationError):
        ExecutionProfile(temperature=3.0)
    with pytest.raises(ValidationError):
        ExecutionProfile(max_tokens=0)
    with pytest.raises(ValidationError):
        ExecutionProfile(top_k=-2)


def test_env_var_name_pattern_enforced():
    """Uppercase / underscore / single letter OK; lowercase / digit-start / mixed rejected."""
    # Validate via ``ModelSpec`` because the pattern check lives in
    # ``_validate_api_key_env`` (a model-level field validator), not on
    # the bare ``Annotated`` alias.
    ModelSpec(id="m1", api_key_env="OPENAI_API_KEY")
    ModelSpec(id="m1", api_key_env="GLM_API_KEY")
    ModelSpec(id="m1", api_key_env="A")
    # Empty: OK (= no env var).
    ModelSpec(id="m1", api_key_env="")
    # Lowercase: rejected.
    with pytest.raises(ValidationError):
        ModelSpec(id="m1", api_key_env="openai_api_key")
    # Starts with a digit: rejected.
    with pytest.raises(ValidationError):
        ModelSpec(id="m1", api_key_env="1FOO")
    # Mixed case: rejected on purpose (see module docstring).
    with pytest.raises(ValidationError):
        ModelSpec(id="m1", api_key_env="Mixed_Case")


def test_env_var_name_matches_documented_pattern():
    """The pattern itself is part of the public contract."""
    import re

    pat = re.compile(ENV_VAR_NAME_PATTERN)
    assert pat.fullmatch("OPENAI_API_KEY")
    assert pat.fullmatch("GLM_API_KEY")
    assert pat.fullmatch("A")
    assert not pat.fullmatch("openai_api_key"), "lowercase rejected"
    assert not pat.fullmatch("1FOO"), "digit prefix rejected"


def test_model_base_url_must_be_http_or_https():
    with pytest.raises(ValidationError) as exc:
        ModelSpec(id="m1", base_url="ftp://example.com")
    assert "base_url" in str(exc.value)

    ModelSpec(id="m1", base_url="https://example.com")
    ModelSpec(id="m1", base_url="http://localhost:8000")


def test_tool_command_and_args_must_be_consistent():
    # args without command: rejected.
    with pytest.raises(ValidationError):
        ToolSpec(id="t1", args=["-y", "foo"])
    # command without args: OK.
    ToolSpec(id="t1", command="foo")
    # command + args: OK.
    ToolSpec(id="t1", command="foo", args=["-y", "bar"])


# ---------------------------------------------------------------------------
# Acceptance: no secret literal
# ---------------------------------------------------------------------------


def test_model_spec_has_no_api_key_field():
    """``api_key`` must not be a model field; only ``api_key_env`` is."""
    fields = set(ModelSpec.model_fields.keys())
    assert "api_key" not in fields, (
        f"ModelSpec must not accept literal api_key; got fields={fields}"
    )
    assert "api_key_env" in fields


def test_api_key_env_empty_is_allowed():
    """Empty env-var name is allowed (= "no env var")."""
    ModelSpec(id="m1", api_key_env="")


def test_model_spec_extra_forbidden():
    with pytest.raises(ValidationError) as exc:
        SKAgentConfig.model_validate(
            {
                "config_version": 2,
                "models": [
                    {
                        "id": "m1",
                        "api_key": "literal-secret",  # forbidden
                        "model_id": "m1",
                        "base_url": "https://x",
                    }
                ],
            }
        )
    # ``extra=forbid`` rejects the unknown field; the readable error
    # makes the rejection obvious.
    msg = str(exc.value)
    assert "api_key" in msg or "Extra" in msg


def test_model_spec_resolves_api_key_from_env(monkeypatch):
    """``ModelSpec.resolve_api_key`` must look at the env-var name only."""
    monkeypatch.setenv("MY_TEST_API_KEY", "env-value")
    spec = ModelSpec(id="m1", api_key_env="MY_TEST_API_KEY")
    assert spec.resolve_api_key() == "env-value"
    monkeypatch.delenv("MY_TEST_API_KEY", raising=False)
    # When env var is missing, the legacy fallback string is returned.
    assert spec.resolve_api_key(legacy_key="no-key") == "no-key"


# ---------------------------------------------------------------------------
# Acceptance: conversation type whitelist
# ---------------------------------------------------------------------------


def test_conversation_type_literal_enforced(v2_payload):
    v2_payload["conversations"][0]["type"] = "round-robin"
    cfg, errors = validate_config_payload(v2_payload)
    assert cfg is None
    assert any("type" in e for e in errors), errors


def test_conversation_type_accepts_all_documented_values():
    for t in ("sequential", "concurrent", "group_chat", "handoff", "magentic"):
        ConversationPreset(id="c1", type=t)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Diagnostic: show what an error looks like to a human
# ---------------------------------------------------------------------------


def test_error_messages_are_human_readable(v2_payload):
    v2_payload["agents"][0]["model"] = "ghost-model"
    _, errors = validate_config_payload(v2_payload)
    assert errors, "expected at least one error"
    # Pydantic v2 errors include the dotted path of the offending field
    # plus a short message; concatenate so the test asserts on
    # *readable* text, not the full ``ValidationError`` repr.
    joined = " | ".join(errors)
    assert "ghost-model" in joined
    assert "agent" in joined
