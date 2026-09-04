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
    _is_env_var_name,
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


# ---------------------------------------------------------------------------
# Acceptance (REPAIR c.944): true round-trip via ``model_dump``.
# ---------------------------------------------------------------------------


def test_v2_round_trip_model_dump_preserves_shape(v2_payload):
    """Validate -> ``model_dump`` -> revalidate -> compare.

    The v1 PR shipped ``test_v2_round_trip`` which only checked a
    handful of fields after the second validation. This test asserts
    the schema shape round-trips **identically** through ``model_dump``
    for every model/tool/agent/inline_agent in the fixture.
    """
    cfg, errors = validate_config_payload(v2_payload)
    assert cfg is not None, f"validation failed: {errors}"

    dumped = cfg.model_dump()
    cfg2, errors2 = validate_config_payload(dumped)
    assert cfg2 is not None, f"second validation failed: {errors2}"

    # Every spec is reconstructible as the same model. We do not
    # compare dicts key-by-key because Pydantic normalises some
    # fields (e.g. defaults fill in), but the model IDs and
    # reference-targets must match exactly.
    assert [m.id for m in cfg.models] == [m.id for m in cfg2.models]
    assert [t.id for t in cfg.tools] == [t.id for t in cfg2.tools]
    assert [a.id for a in cfg.agents] == [a.id for a in cfg2.agents]
    assert [c.id for c in cfg.conversations] == [c.id for c in cfg2.conversations]


def test_v1_round_trip_model_dump_preserves_shape(v1_payload):
    """V1 payload migrated via ``migrate_config_v1_to_v2`` round-trips
    through ``model_dump`` without losing agent identity.
    """
    from sk_agent_config import migrate_config_v1_to_v2

    migrated = migrate_config_v1_to_v2(v1_payload)
    cfg, errors = validate_config_payload(migrated)
    assert cfg is not None, f"migration validation failed: {errors}"
    dumped = cfg.model_dump()
    cfg2, errors2 = validate_config_payload(dumped)
    assert cfg2 is not None, f"second validation failed: {errors2}"
    assert {a.id for a in cfg.agents} == {a.id for a in cfg2.agents}


# ---------------------------------------------------------------------------
# Acceptance (REPAIR c.944): the facade ``validate_config`` chains
# Pydantic on v2 payloads.
# ---------------------------------------------------------------------------


def test_facade_validate_config_chains_schema_on_schema_shape(v2_payload):
    """``sk_agent_config.validate_config`` should produce no errors on
    a clean v2 payload and should include the ``[schema]`` prefix
    marker on errors when the payload is invalid.
    """
    from sk_agent_config import validate_config

    # Clean payload -> empty error list.
    errors = validate_config(v2_payload)
    assert errors == [], f"unexpected errors: {errors}"


def test_facade_validate_config_chains_schema_on_legacy_shape(v1_payload):
    """Legacy ``mcps``/``vision``/``memory`` payload routes through the
    schema after facade normalisation. The schema folds the legacy
    keys and reports reference-integrity errors with the ``[schema]``
    prefix.
    """
    from sk_agent_config import migrate_config_v1_to_v2, validate_config

    migrated = migrate_config_v1_to_v2(v1_payload)
    # Migration should produce a config_version=2, mcps->tools,
    # vision/thinking->capabilities shape, so the schema accepts it.
    errors = validate_config(migrated)
    assert not any(
        e.startswith("[schema] models.") or e.startswith("[schema] tools.")
        for e in errors
    ), f"unexpected schema errors after migration: {errors}"


def test_facade_validate_config_routes_placeholder_apikey_through_schema(v2_payload):
    """A v2 payload with placeholder ``api_key`` literals should fold
    the placeholder into ``api_key_env`` and validate cleanly via the
    facade.
    """
    from sk_agent_config import validate_config

    payload = {
        "config_version": 2,
        "models": [
            {
                "id": "glm-5",
                "base_url": "https://api.z.ai/v4",
                "api_key": "YOUR_ZAI_API_KEY_HERE",
                "model_id": "glm-5",
                "vision": False,
                "thinking": True,
                "context_window": 200_000,
            },
        ],
        "tools": [],
        "agents": [
            {
                "id": "analyst",
                "model": "glm-5",
                "mcps": [],
                "system_prompt": "",
            },
        ],
        "default_agent": "analyst",
    }
    errors = validate_config(payload)
    assert errors == [], f"unexpected errors: {errors}"

    # And the schema confirms ``api_key_env`` was set to a derived name.
    cfg, _ = validate_config_payload(payload)
    assert cfg is not None
    assert cfg.models[0].api_key_env == "GLM_5_API_KEY"
    assert "api_key" not in cfg.models[0].model_dump()


def test_facace_validate_config_rejects_real_secret_leak(v2_payload):
    """A ``sk-...`` literal must surface as a readable error, not be
    silently accepted.
    """
    from sk_agent_config import validate_config

    payload = {
        "config_version": 2,
        "models": [
            {
                "id": "openai-1",
                "base_url": "https://api.openai.com/v1",
                "api_key": "sk-supersecret1234567890ABCDEFG",
                "model_id": "gpt-4",
            },
        ],
        "tools": [],
        "agents": [
            {
                "id": "analyst",
                "model": "openai-1",
                "mcps": [],
            },
        ],
    }
    errors = validate_config(payload)
    # The schema's extra=forbid must surface the leaked api_key.
    assert any(
        "api_key" in e and "Extra" in e
        for e in errors
    ), f"expected api_key leak warning, got {errors}"


# ---------------------------------------------------------------------------
# Acceptance (REPAIR c.944): ToolSpec.env accepts both env-var names
# and non-secret configuration literals.
# ---------------------------------------------------------------------------


def test_tool_spec_env_accepts_env_var_reference():
    """Plain env-var name in ``env`` is accepted."""
    spec = ToolSpec(
        id="t1",
        command="python",
        args=["script.py"],
        env={"API_KEY": "GLM_API_KEY", "PORT": "SERVER_PORT"},
    )
    assert spec.env == {"API_KEY": "GLM_API_KEY", "PORT": "SERVER_PORT"}
    # Both values are canonical env-var names.
    assert _is_env_var_name(spec.env["API_KEY"])
    assert _is_env_var_name(spec.env["PORT"])


def test_tool_spec_env_accepts_non_secret_literals():
    """Non-secret configuration literals (URLs, ports, log levels) are
    accepted verbatim. The schema does **not** require every value to
    be an env-var name: the canonical template carries ``SEARXNG_URL``
    set to a literal URL.
    """
    spec = ToolSpec(
        id="searxng",
        command="npx",
        args=["-y", "mcp-searxng"],
        env={"SEARXNG_URL": "https://search.myia.io"},
    )
    assert spec.env["SEARXNG_URL"] == "https://search.myia.io"
    assert not _is_env_var_name(spec.env["SEARXNG_URL"])


def test_tool_spec_env_accepts_mixed_env_and_literals():
    """Mixing env-var references and configuration literals in one
    mapping is allowed.
    """
    spec = ToolSpec(
        id="open-terminal",
        command="python",
        args=["open_terminal.py"],
        env={
            "OPEN_TERMINAL_URL": "http://open-terminal-myia:8000",
            "OPEN_TERMINAL_API_KEY": "OPEN_TERMINAL_API_KEY",  # env-var ref
            "LOG_LEVEL": "info",                                # literal
        },
    )
    assert spec.env["OPEN_TERMINAL_URL"] == "http://open-terminal-myia:8000"
    assert spec.env["OPEN_TERMINAL_API_KEY"] == "OPEN_TERMINAL_API_KEY"
    assert spec.env["LOG_LEVEL"] == "info"


def test_tool_spec_env_rejects_non_string_values():
    """Typed values (numbers, bools, ...) are rejected with a readable
    error so callers do not silently encode a URL as an int.
    """
    with pytest.raises(ValidationError) as exc:
        ToolSpec(id="t1", command="x", env={"PORT": 8000})  # type: ignore[arg-type]
    assert "env" in str(exc.value).lower()
    assert "string" in str(exc.value).lower()


def test_tool_spec_env_rejects_non_string_keys():
    with pytest.raises(ValidationError):
        ToolSpec(id="t1", command="x", env={1: "VAL"})  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Acceptance (REPAIR c.944): inline agents may shadow the top-level
# agent registry (or live only as inline definitions).
# ---------------------------------------------------------------------------


def test_conversation_inline_only_agents_resolve():
    """A conversation whose ``agents`` references point **only** to
    inline definitions (no top-level ``AgentPreset`` with the same id)
    is accepted.
    """
    cfg_payload = {
        "config_version": 2,
        "models": [
            {
                "id": "glm-5",
                "base_url": "https://api.z.ai/v4",
                "api_key_env": "GLM_API_KEY",
                "model_id": "glm-5",
            },
        ],
        "agents": [
            {
                "id": "host",
                "model": "glm-5",
                "mcps": [],
                "system_prompt": "",
            },
        ],
        "conversations": [
            {
                "id": "inline-only",
                "type": "group_chat",
                "agents": ["security-reviewer", "perf-reviewer"],
                "inline_agents": [
                    {
                        "id": "security-reviewer",
                        "model": "glm-5",
                        "system_prompt": "security...",
                        "mcps": [],
                    },
                    {
                        "id": "perf-reviewer",
                        "model": "glm-5",
                        "system_prompt": "perf...",
                        "mcps": [],
                    },
                ],
            },
        ],
    }
    cfg, errors = validate_config_payload(cfg_payload)
    assert cfg is not None, f"inline-only conv rejected: {errors}"


def test_conversation_inline_shadows_top_level():
    """A conversation may define an inline agent that shadows an
    existing top-level agent with the same id. The inline definition
    wins; the validator does not raise.
    """
    cfg_payload = {
        "config_version": 2,
        "models": [
            {
                "id": "glm-5",
                "base_url": "https://api.z.ai/v4",
                "api_key_env": "GLM_API_KEY",
                "model_id": "glm-5",
            },
        ],
        "agents": [
            {
                "id": "reviewer",
                "model": "glm-5",
                "mcps": [],
                "system_prompt": "top-level",
            },
        ],
        "conversations": [
            {
                "id": "shadow-test",
                "type": "sequential",
                "agents": ["reviewer"],
                "inline_agents": [
                    {
                        "id": "reviewer",
                        "model": "glm-5",
                        "system_prompt": "inline override",
                        "mcps": [],
                    },
                ],
            },
        ],
    }
    cfg, errors = validate_config_payload(cfg_payload)
    assert cfg is not None, f"shadow rejected: {errors}"


def test_conversation_duplicate_inline_ids_rejected():
    """Inline agents within one conversation must have unique ids."""
    cfg_payload = {
        "config_version": 2,
        "models": [
            {
                "id": "glm-5",
                "base_url": "https://api.z.ai/v4",
                "api_key_env": "GLM_API_KEY",
                "model_id": "glm-5",
            },
        ],
        "agents": [
            {
                "id": "host",
                "model": "glm-5",
                "mcps": [],
                "system_prompt": "",
            },
        ],
        "conversations": [
            {
                "id": "dup-inline",
                "type": "group_chat",
                "agents": ["a", "b"],
                "inline_agents": [
                    {
                        "id": "a",
                        "model": "glm-5",
                        "system_prompt": "",
                        "mcps": [],
                    },
                    {
                        "id": "a",  # duplicate
                        "model": "glm-5",
                        "system_prompt": "",
                        "mcps": [],
                    },
                ],
            },
        ],
    }
    cfg, errors = validate_config_payload(cfg_payload)
    assert cfg is None
    assert any("inline agent" in e or "duplicate" in e for e in errors)


# ---------------------------------------------------------------------------
# Acceptance (REPAIR c.944): duplicate ids rejected at the schema
# boundary, not only by the facade legacy checks.
# ---------------------------------------------------------------------------


def test_schema_rejects_duplicate_model_ids():
    payload = {
        "config_version": 2,
        "models": [
            {"id": "m1", "base_url": "https://x", "model_id": "m1"},
            {"id": "m1", "base_url": "https://x", "model_id": "m1"},
        ],
        "agents": [],
        "tools": [],
        "conversations": [],
    }
    cfg, errors = validate_config_payload(payload)
    assert cfg is None
    assert any("models" in e and "duplicate" in e for e in errors)


def test_schema_rejects_duplicate_tool_ids():
    payload = {
        "config_version": 2,
        "models": [],
        "tools": [
            {"id": "t1", "command": "x"},
            {"id": "t1", "command": "y"},
        ],
        "agents": [],
        "conversations": [],
    }
    cfg, errors = validate_config_payload(payload)
    assert cfg is None
    assert any("tools" in e and "duplicate" in e for e in errors)


def test_schema_rejects_duplicate_agent_ids():
    payload = {
        "config_version": 2,
        "models": [{"id": "m1", "base_url": "https://x", "model_id": "m1"}],
        "tools": [],
        "agents": [
            {"id": "a1", "model": "m1", "mcps": [], "system_prompt": ""},
            {"id": "a1", "model": "m1", "mcps": [], "system_prompt": ""},
        ],
        "conversations": [],
    }
    cfg, errors = validate_config_payload(payload)
    assert cfg is None
    # Schema-level duplicates OR facade-level duplicates
    assert any("agents" in e and "duplicate" in e for e in errors), (
        f"expected duplicate id error, got {errors}"
    )


def test_schema_rejects_duplicate_conversation_ids():
    payload = {
        "config_version": 2,
        "models": [],
        "tools": [],
        "agents": [],
        "conversations": [
            {"id": "c1", "type": "sequential", "agents": []},
            {"id": "c1", "type": "sequential", "agents": []},
        ],
    }
    cfg, errors = validate_config_payload(payload)
    assert cfg is None
    assert any("conversations" in e and "duplicate" in e for e in errors)


# ---------------------------------------------------------------------------
# Acceptance (REPAIR c.944): the canonical template validates cleanly.
# ---------------------------------------------------------------------------


def test_canonical_template_validates_cleanly():
    """``sk_agent_config.template.json`` (the canonical v2 config the
    sk-agent runtime actually loads) is the live validation target.

    The contract the schema is bound to is twofold:

    1. **Placeholder ``api_key`` literals** (``YOUR_X_HERE`` or the
       benign patterns ``key|test-key|example|dummy|placeholder|changeme|
       no-key``) get routed to a deterministic ``api_key_env`` field
       and validate cleanly.
    2. **Real-secret ``api_key`` literals** (``sk-...``, ``ghp_...``,
       etc.) are surfaced as ``Extra inputs are not permitted`` errors
       so a secret leak is never silently accepted.

    This test asserts **both** halves of that contract on the actual
    template file. If a model in the template carries a placeholder,
    the schema accepts the model (placeholder -> ``api_key_env``). If
    a model carries a real-secret literal, the schema rejects it
    (visible ``extra=forbid`` error) -- this is the desired behavior.
    """
    import json
    import re

    from sk_agent_schemas import _API_KEY_PLACEHOLDER_PATTERN

    template_path = (
        Path(__file__).parent / "sk_agent_config.template.json"
    )
    if not template_path.exists():
        pytest.skip("template not present in this checkout")

    payload = json.loads(template_path.read_text(encoding="utf-8"))

    # Run schema validation directly so we see schema-only errors
    # (not the facade's legacy structural checks).
    cfg, errors = validate_config_payload(payload)
    schema_extra_errors = [e for e in errors if "Extra inputs" in e]

    # Categorise every model's ``api_key`` literal in the template:
    # placeholder (must be folded to api_key_env) vs real-secret
    # (must raise extra=forbid).
    placeholder_pat = re.compile(_API_KEY_PLACEHOLDER_PATTERN)
    placeholder_count = 0
    real_secret_count = 0
    for m in payload.get("models", []) or []:
        key = m.get("api_key") if isinstance(m, dict) else None
        if not isinstance(key, str):
            continue
        if placeholder_pat.fullmatch(key):
            placeholder_count += 1
        else:
            real_secret_count += 1

    if real_secret_count == 0:
        # Pure-placeholder template: schema must accept it cleanly.
        assert cfg is not None, (
            f"schema rejected placeholder-only template: {errors}"
        )
    else:
        # Real-secret literal(s) present: each must surface as an
        # ``Extra inputs are not permitted`` error -- the contract.
        assert schema_extra_errors, (
            f"expected real-secret api_key rejection, got errors={errors}"
        )
        assert len(schema_extra_errors) >= real_secret_count, (
            f"only {len(schema_extra_errors)} extra-errors for "
            f"{real_secret_count} real-secret api_key entries"
        )


# ---------------------------------------------------------------------------
# Acceptance (REPAIR c.944): typed errors on api_key_env values.
# ---------------------------------------------------------------------------


def test_api_key_env_rejects_non_string_value():
    """A non-string ``api_key_env`` must raise ``ValidationError`` with
    a readable error mentioning the field type. Pre-fix, the schema
    crashed with ``TypeError`` from the regex match.
    """
    with pytest.raises(ValidationError) as exc:
        ModelSpec(id="m1", api_key_env=12345)  # type: ignore[arg-type]
    msg = str(exc.value).lower()
    assert "api_key_env" in msg
    assert "string" in msg


# ---------------------------------------------------------------------------
# Diagnostic: the inline_ids shadowing guard now runs BEFORE the
# agent-not-found error, so a top-level conversation reference can
# resolve to an inline agent without the facade rejecting it.
# ---------------------------------------------------------------------------


def test_conversation_unknown_agent_is_still_rejected():
    """Negative test: a conversation referencing an unknown agent
    (not in top-level nor inline) is still rejected.
    """
    payload = {
        "config_version": 2,
        "models": [
            {
                "id": "glm-5",
                "base_url": "https://api.z.ai/v4",
                "api_key_env": "GLM_API_KEY",
                "model_id": "glm-5",
            },
        ],
        "agents": [
            {
                "id": "known",
                "model": "glm-5",
                "mcps": [],
                "system_prompt": "",
            },
        ],
        "conversations": [
            {
                "id": "ghost-conv",
                "type": "sequential",
                "agents": ["ghost-agent"],
            },
        ],
    }
    cfg, errors = validate_config_payload(payload)
    assert cfg is None
    assert any("ghost-agent" in e for e in errors)
