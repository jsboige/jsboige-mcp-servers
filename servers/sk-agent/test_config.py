#!/usr/bin/env python3
"""
Unit tests for sk_agent_config module.

Tests cover:
- V1 -> V2 config migration
- Config validation
- Dataclass parsing (round-trip)
- Edge cases (missing fields, duplicates, etc.)
- Default agent resolution
- Loader contract on the PARSED config (v1 witness, duplicate-id fusion)
"""

import copy
import json
import os
import sys
from pathlib import Path

import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from sk_agent_config import (
    AgentConfig,
    ConfigValidationError,
    ConversationConfig,
    EmbeddingsConfig,
    McpConfig,
    MemoryConfig,
    ModelConfig,
    QdrantConfig,
    SKAgentConfig,
    load_config,
    migrate_config_v1_to_v2,
    validate_config,
    _infer_context_window,
    _parse_config,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def v1_config() -> dict:
    """A typical v1 config (no config_version field)."""
    return {
        "default_ask_model": "glm-5",
        "default_vision_model": "glm-4.6v",
        "max_recursion_depth": 2,
        "models": [
            {
                "id": "glm-4.6v",
                "enabled": True,
                "base_url": "https://api.z.ai/api/coding/paas/v4",
                "api_key": "test-key",
                "model_id": "glm-4.6v",
                "vision": True,
                "description": "Vision model",
                "context_window": 128000,
            },
            {
                "id": "glm-5",
                "enabled": True,
                "base_url": "https://api.z.ai/api/coding/paas/v4",
                "api_key": "test-key",
                "model_id": "glm-5",
                "vision": False,
                "description": "Text model",
                "context_window": 200000,
            },
            {
                "id": "disabled-model",
                "enabled": False,
                "base_url": "http://localhost/v1",
                "api_key": "key",
                "model_id": "disabled",
                "vision": False,
            },
        ],
        "mcps": [
            {
                "name": "searxng",
                "description": "Web search",
                "command": "npx",
                "args": ["-y", "mcp-searxng"],
                "env": {"SEARXNG_URL": "https://search.myia.io"},
            },
            {
                "name": "playwright",
                "description": "Browser",
                "command": "npx",
                "args": ["-y", "@playwright/mcp@latest"],
            },
        ],
        "system_prompt": "You are a helpful assistant.",
    }


@pytest.fixture
def v2_config() -> dict:
    """A valid v2 config."""
    return {
        "config_version": 2,
        "max_recursion_depth": 2,
        "default_agent": "analyst",
        "default_vision_agent": "vision-analyst",
        "models": [
            {
                "id": "glm-5",
                "base_url": "https://api.z.ai/v4",
                "api_key": "key",
                "model_id": "glm-5",
                "vision": False,
                "context_window": 200000,
                "description": "GLM-5 reasoning",
            },
            {
                "id": "glm-4.6v",
                "base_url": "https://api.z.ai/v4",
                "api_key": "key",
                "model_id": "glm-4.6v",
                "vision": True,
                "context_window": 128000,
                "description": "GLM-4.6V vision",
            },
        ],
        "mcps": [
            {
                "id": "searxng",
                "description": "Web search",
                "command": "npx",
                "args": ["-y", "mcp-searxng"],
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
                "capabilities": ["memory"],
                "memory": {"enabled": True, "collection": "analyst-memory"},
            },
            {
                "id": "vision-analyst",
                "description": "Vision analysis",
                "model": "glm-4.6v",
                "system_prompt": "You are a vision specialist.",
                "mcps": ["searxng"],
                "memory": {"enabled": False},
            },
            {
                "id": "fast",
                "description": "Quick responses",
                "model": "glm-5",
                "system_prompt": "Be concise.",
                "mcps": [],
                "memory": {"enabled": False},
            },
        ],
        "embeddings": {
            "base_url": "https://embeddings.myia.io/v1",
            "api_key": "emb-key",
            "model_id": "Qwen3-4B-AWQ-embedding",
            "dimensions": 2560,
        },
        "qdrant": {
            "url": "http://localhost",
            "port": 6333,
            "default_collection_prefix": "sk-agent",
        },
        "conversations": [
            {
                "id": "deep-search",
                "description": "Multi-agent research",
                "type": "magentic",
                "agents": ["researcher", "synthesizer"],
                "max_rounds": 10,
                "inline_agents": [
                    {"id": "researcher", "model": "glm-5", "mcps": ["searxng"]},
                    {"id": "synthesizer", "model": "glm-5", "mcps": []},
                ],
            },
        ],
    }


@pytest.fixture
def config_file(tmp_path, v1_config):
    """Write v1 config to a temp file."""
    path = tmp_path / "config.json"
    path.write_text(json.dumps(v1_config), encoding="utf-8")
    return str(path)


# ---------------------------------------------------------------------------
# Migration Tests
# ---------------------------------------------------------------------------


class TestMigrateV1ToV2:
    """Test v1 -> v2 config migration."""

    def test_already_v2_passthrough(self, v2_config):
        """V2 config should pass through unchanged."""
        result = migrate_config_v1_to_v2(v2_config)
        assert result["config_version"] == 2
        assert "agents" in result
        assert result is v2_config  # Same object, not copied

    def test_basic_migration(self, v1_config):
        """V1 config gets config_version=2 and agents section."""
        result = migrate_config_v1_to_v2(v1_config)
        assert result["config_version"] == 2
        assert "agents" in result
        assert "models" in result
        assert "mcps" in result

    def test_agent_per_enabled_model(self, v1_config):
        """One agent per enabled model, disabled models skipped."""
        result = migrate_config_v1_to_v2(v1_config)
        agents = result["agents"]
        # 2 enabled models -> 2 agents
        assert len(agents) == 2
        agent_ids = [a["id"] for a in agents]
        assert "glm-4.6v" in agent_ids
        assert "glm-5" in agent_ids
        assert "disabled-model" not in agent_ids

    def test_agents_get_all_mcps(self, v1_config):
        """In v1, all MCPs are shared -> each agent gets all MCP IDs."""
        result = migrate_config_v1_to_v2(v1_config)
        for agent in result["agents"]:
            assert "searxng" in agent["mcps"]
            assert "playwright" in agent["mcps"]

    def test_agents_inherit_system_prompt(self, v1_config):
        """Agents inherit the global system_prompt."""
        result = migrate_config_v1_to_v2(v1_config)
        for agent in result["agents"]:
            assert agent["system_prompt"] == "You are a helpful assistant."

    def test_default_agent_mapped(self, v1_config):
        """default_ask_model -> default_agent, default_vision_model -> default_vision_agent."""
        result = migrate_config_v1_to_v2(v1_config)
        assert result["default_agent"] == "glm-5"
        assert result["default_vision_agent"] == "glm-4.6v"

    def test_mcps_get_id_field(self, v1_config):
        """MCPs with only 'name' get an 'id' field from name."""
        result = migrate_config_v1_to_v2(v1_config)
        for mcp in result["mcps"]:
            assert "id" in mcp

    def test_empty_conversations(self, v1_config):
        """Migrated config has empty conversations (no auto-generation)."""
        result = migrate_config_v1_to_v2(v1_config)
        assert result["conversations"] == []

    def test_legacy_single_model_format(self):
        """Very old format with single 'model' key."""
        legacy = {
            "model": {
                "model_id": "old-model",
                "base_url": "http://localhost/v1",
                "api_key": "key",
            },
            "mcps": [],
            "system_prompt": "Hello",
        }
        result = migrate_config_v1_to_v2(legacy)
        assert result["config_version"] == 2
        assert len(result["models"]) == 1
        assert result["models"][0]["id"] == "old-model"
        assert len(result["agents"]) == 1
        assert result["agents"][0]["id"] == "old-model"

    def test_no_models(self):
        """Config with no models -> no agents."""
        result = migrate_config_v1_to_v2({"models": [], "mcps": []})
        assert result["agents"] == []
        assert result["default_agent"] == ""

    def test_model_specific_prompt_overrides_global(self):
        """Per-model system_prompt takes precedence over global."""
        raw = {
            "models": [
                {
                    "id": "m1",
                    "enabled": True,
                    "base_url": "http://x/v1",
                    "api_key": "k",
                    "model_id": "m1",
                    "system_prompt": "I am special",
                },
            ],
            "mcps": [],
            "system_prompt": "I am global",
        }
        result = migrate_config_v1_to_v2(raw)
        assert result["agents"][0]["system_prompt"] == "I am special"


# ---------------------------------------------------------------------------
# Validation Tests
# ---------------------------------------------------------------------------


class TestValidation:
    """Test config validation."""

    def test_valid_config(self, v2_config):
        """Valid config returns no errors."""
        errors = validate_config(v2_config)
        assert errors == []

    def test_rejects_v1(self):
        """Config without version >= 2 is rejected."""
        errors = validate_config({"config_version": 1})
        assert any("config_version" in e for e in errors)

    def test_duplicate_model_ids(self, v2_config):
        v2_config["models"].append({"id": "glm-5", "model_id": "dup"})
        errors = validate_config(v2_config)
        assert any("duplicate id 'glm-5'" in e for e in errors)

    def test_duplicate_agent_ids(self, v2_config):
        v2_config["agents"].append({"id": "analyst", "model": "glm-5"})
        errors = validate_config(v2_config)
        assert any("duplicate id 'analyst'" in e for e in errors)

    def test_agent_references_missing_model(self, v2_config):
        v2_config["agents"].append({"id": "bad-agent", "model": "nonexistent"})
        errors = validate_config(v2_config)
        assert any("nonexistent" in e for e in errors)

    def test_agent_references_missing_mcp(self, v2_config):
        v2_config["agents"][0]["mcps"].append("nonexistent-mcp")
        errors = validate_config(v2_config)
        assert any("nonexistent-mcp" in e for e in errors)

    def test_default_agent_missing(self, v2_config):
        v2_config["default_agent"] = "nonexistent-agent"
        errors = validate_config(v2_config)
        assert any("nonexistent-agent" in e for e in errors)

    def test_conversation_missing_agent(self, v2_config):
        """Conversation referencing non-existent agent (not in top-level or inline)."""
        v2_config["conversations"][0]["agents"].append("ghost")
        errors = validate_config(v2_config)
        assert any("ghost" in e for e in errors)

    def test_conversation_inline_agent_valid(self, v2_config):
        """Inline agent refs should be valid."""
        # researcher and synthesizer are inline agents -> no error
        errors = validate_config(v2_config)
        assert not any("researcher" in e for e in errors)

    def test_invalid_conversation_type(self, v2_config):
        v2_config["conversations"][0]["type"] = "invalid_type"
        errors = validate_config(v2_config)
        assert any("invalid_type" in e for e in errors)

    def test_memory_without_embeddings(self, v2_config):
        """Memory enabled but no embeddings configured -> error."""
        v2_config.pop("embeddings", None)
        errors = validate_config(v2_config)
        assert any("embeddings" in e for e in errors)

    def test_memory_with_embeddings_ok(self, v2_config):
        """Memory with proper embeddings -> no error."""
        errors = validate_config(v2_config)
        assert not any("embeddings" in e for e in errors)


# ---------------------------------------------------------------------------
# Parsing / Round-trip Tests
# ---------------------------------------------------------------------------


class TestParsing:
    """Test parsing raw dict into SKAgentConfig and back."""

    def test_parse_v2(self, v2_config):
        cfg = _parse_config(v2_config)
        assert type(cfg).__name__ == "SKAgentConfig"
        assert cfg.config_version == 2
        assert len(cfg.models) == 2
        assert len(cfg.mcps) == 2
        assert len(cfg.agents) == 3
        assert len(cfg.conversations) == 1

    def test_roundtrip(self, v2_config):
        cfg = _parse_config(v2_config)
        exported = cfg.to_dict()
        # Re-parse
        cfg2 = _parse_config(exported)
        assert cfg2.config_version == cfg.config_version
        assert len(cfg2.models) == len(cfg.models)
        assert len(cfg2.agents) == len(cfg.agents)

    def test_model_lookup(self, v2_config):
        cfg = _parse_config(v2_config)
        m = cfg.get_model("glm-5")
        assert m is not None
        assert m.context_window == 200000
        assert m.vision is False

    def test_agent_lookup(self, v2_config):
        cfg = _parse_config(v2_config)
        a = cfg.get_agent("analyst")
        assert a is not None
        assert a.model == "glm-5"
        assert a.memory.enabled is True
        assert a.memory.collection == "analyst-memory"

    def test_default_agent(self, v2_config):
        cfg = _parse_config(v2_config)
        default = cfg.get_default_agent()
        assert default is not None
        assert default.id == "analyst"

    def test_default_vision_agent(self, v2_config):
        cfg = _parse_config(v2_config)
        vision = cfg.get_default_vision_agent()
        assert vision is not None
        assert vision.id == "vision-analyst"

    def test_find_agent_for_model(self, v2_config):
        cfg = _parse_config(v2_config)
        agent = cfg.find_agent_for_model("glm-4.6v")
        assert agent is not None
        assert agent.id == "vision-analyst"

    def test_agent_has_vision(self, v2_config):
        cfg = _parse_config(v2_config)
        assert cfg.agent_has_vision("vision-analyst") is True
        assert cfg.agent_has_vision("analyst") is False

    def test_conversation_inline_agents(self, v2_config):
        cfg = _parse_config(v2_config)
        conv = cfg.get_conversation("deep-search")
        assert conv is not None
        assert conv.type == "magentic"
        assert len(conv.inline_agents) == 2
        assert conv.inline_agents[0].id == "researcher"

    def test_embeddings_configured(self, v2_config):
        cfg = _parse_config(v2_config)
        assert cfg.embeddings.is_configured is True
        assert cfg.embeddings.dimensions == 2560

    def test_embeddings_not_configured(self):
        cfg = _parse_config({"config_version": 2})
        assert cfg.embeddings.is_configured is False


# ---------------------------------------------------------------------------
# Dataclass Tests
# ---------------------------------------------------------------------------


class TestDataclasses:
    """Test individual dataclass behavior."""

    def test_model_config_defaults(self):
        m = ModelConfig(id="test")
        assert m.base_url == "https://api.medium.text-generation-webui.myia.io/v1"
        assert m.vision is False
        assert m.enabled is True
        assert m.context_window == 32_000

    def test_model_resolve_api_key_env(self, monkeypatch):
        monkeypatch.setenv("MY_KEY", "secret-from-env")
        m = ModelConfig(id="test", api_key_env="MY_KEY", api_key="fallback")
        assert m.resolve_api_key() == "secret-from-env"

    def test_model_resolve_api_key_direct(self):
        m = ModelConfig(id="test", api_key="direct-key")
        assert m.resolve_api_key() == "direct-key"

    def test_mcp_from_dict_with_name(self):
        """MCPs with 'name' instead of 'id' should work."""
        mcp = McpConfig.from_dict({"name": "my-mcp", "command": "npx"})
        assert mcp.id == "my-mcp"
        assert mcp.command == "npx"

    def test_memory_config_defaults(self):
        m = MemoryConfig()
        assert m.enabled is False
        assert m.collection == ""

    def test_memory_config_from_none(self):
        m = MemoryConfig.from_dict(None)
        assert m.enabled is False

    def test_agent_config_defaults(self):
        a = AgentConfig(id="test")
        assert a.mcps == []
        assert a.memory.enabled is False
        assert a.parameters == {}

    def test_conversation_config_defaults(self):
        c = ConversationConfig(id="test")
        assert c.type == "sequential"
        assert c.max_rounds == 10
        assert c.inline_agents == []

    def test_qdrant_config_defaults(self):
        q = QdrantConfig()
        assert q.url == "http://localhost"
        assert q.port == 6333


# ---------------------------------------------------------------------------
# Load from file Tests
# ---------------------------------------------------------------------------


class TestLoadConfig:
    """Test loading config from files."""

    def test_load_missing_file(self, tmp_path):
        """Missing config file returns empty config."""
        cfg = load_config(str(tmp_path / "nonexistent.json"))
        assert type(cfg).__name__ == "SKAgentConfig"
        assert cfg.models == []
        assert cfg.agents == []

    def test_load_v1_auto_migrates(self, config_file):
        """V1 file is auto-migrated to v2."""
        cfg = load_config(config_file)
        assert cfg.config_version == 2
        assert len(cfg.agents) == 2  # 2 enabled models -> 2 agents

    def test_load_v2_direct(self, tmp_path, v2_config):
        """V2 file is loaded directly."""
        path = tmp_path / "v2.json"
        path.write_text(json.dumps(v2_config), encoding="utf-8")
        cfg = load_config(str(path))
        assert cfg.config_version == 2
        assert len(cfg.agents) == 3

    def test_load_v2_expands_model_base_url_placeholder(
        self, tmp_path, v2_config, monkeypatch
    ):
        """``${HUB_BASE_URL}`` resolves from the server environment (#4814)."""
        v2_config["models"][0]["base_url"] = "${HUB_BASE_URL}"
        path = tmp_path / "v2.json"
        path.write_text(json.dumps(v2_config), encoding="utf-8")
        monkeypatch.setenv("HUB_BASE_URL", "http://hub.example.test/v1")
        cfg = load_config(str(path))
        assert cfg.models[0].base_url == "http://hub.example.test/v1"
        assert cfg.models[0].base_url_error is None

    def test_load_v2_unset_model_base_url_placeholder_is_typed_error(
        self, tmp_path, v2_config, monkeypatch
    ):
        """No default: an unset hub variable is a typed load error naming
        the variable, not a literal URL that fails at call time (#4814
        review pt 2). The placeholder stays verbatim (save_config never
        destroys it) and the model is isolated, not dropped."""
        v2_config["models"][0]["base_url"] = "${HUB_BASE_URL}"
        path = tmp_path / "v2.json"
        path.write_text(json.dumps(v2_config), encoding="utf-8")
        monkeypatch.delenv("HUB_BASE_URL", raising=False)
        cfg = load_config(str(path))
        assert cfg.models[0].base_url == "${HUB_BASE_URL}"
        error = cfg.models[0].base_url_error
        assert error is not None
        assert "HUB_BASE_URL" in error
        assert "sk-agent server environment" in error

    def test_load_v2_empty_base_url_expansion_is_typed_error(
        self, tmp_path, v2_config, monkeypatch
    ):
        """A set-but-empty variable must not silently degrade to a model
        without an endpoint (#4814 review; NanoClaw reserve 1)."""
        v2_config["models"][0]["base_url"] = "${HUB_BASE_URL}"
        path = tmp_path / "v2.json"
        path.write_text(json.dumps(v2_config), encoding="utf-8")
        monkeypatch.setenv("HUB_BASE_URL", "")
        cfg = load_config(str(path))
        assert cfg.models[0].base_url == ""
        error = cfg.models[0].base_url_error
        assert error is not None
        assert "empty string" in error
        assert "HUB_BASE_URL" in error

    def test_load_v2_literal_base_url_has_no_error(self, tmp_path, v2_config):
        """A resolved literal URL never carries a load error (#4814)."""
        path = tmp_path / "v2.json"
        path.write_text(json.dumps(v2_config), encoding="utf-8")
        cfg = load_config(str(path))
        assert cfg.models[0].base_url_error is None

    def test_load_v1_default_agents(self, config_file):
        """After migration, default agents are set correctly."""
        cfg = load_config(config_file)
        assert cfg.default_agent == "glm-5"
        assert cfg.default_vision_agent == "glm-4.6v"


# ---------------------------------------------------------------------------
# Helper Tests
# ---------------------------------------------------------------------------


class TestHelpers:
    """Test helper functions."""

    def test_infer_context_window_vision(self):
        assert _infer_context_window({"vision": True}) == 128_000

    def test_infer_context_window_cloud(self):
        assert _infer_context_window({"base_url": "https://api.z.ai/v4"}) == 200_000

    def test_infer_context_window_local(self):
        assert _infer_context_window({"base_url": "http://localhost/v1"}) == 32_000

    def test_infer_context_window_default(self):
        assert _infer_context_window({}) == 32_000


# ---------------------------------------------------------------------------
# Loader contract on the PARSED config (vllm#627 follow-up)
# ---------------------------------------------------------------------------
#
# A clean `validate_config` is not a sound config. Fusing two files by block
# (append the second file's ``models`` / ``agents`` to the first's) produces
# duplicate ids that validation only LOGS; ``load_config`` then keeps every
# entry in the list while ``get_agent`` / ``get_model`` resolve the LAST one
# (``_agent_map = {a.id: a for a in agents}``), so the earlier entry stays in
# ``cfg.agents`` and no lookup reaches it. The witness below is the reverse
# check: a form the loader demonstrably degrades must FAIL the same criteria
# the healthy forms PASS — a harness that only ever says OK proves nothing
# (measured outside the repo on vllm#627; frozen here at po-2028's request).
#
# These tests live in this file, not in a new ``test_config_*.py``, on
# purpose: CI runs an explicit file list (``.github/workflows/ci.yml``, job
# ``test-sk-agent``) and a file missing from it never runs — the stale assert
# of ``test_inventory_validation.py`` sat red, unseen, for exactly that
# reason.

TEMPLATE_PATH = Path(__file__).parent / "sk_agent_config.template.json"

# The pre-fix example file declared these 10 presets (vllm#627 old head).
V1_WITNESS_PRESETS = [
    "analyst",
    "fast",
    "classifier-local",
    "summarizer-local",
    "formatter-local",
    "vision-local",
    "voltron-extract",
    "voltron-classify",
    "voltron-numbers",
    "voltron-diff",
]


def _set_placeholder_env(monkeypatch) -> None:
    """Deterministic placeholder resolution: CI carries no fleet environment."""
    monkeypatch.setenv("HUB_BASE_URL", "http://hub.example.test/v1")
    monkeypatch.setenv("OPEN_TERMINAL_URL", "http://open-terminal.example.test:8000")
    monkeypatch.setenv("SEARXNG_URL", "http://searxng.example.test")


def _load_doc(tmp_path, doc: dict, name: str = "cfg.json"):
    """Write ``doc`` and load it through the real entry point.

    ``sk_agent_config`` is imported at CALL time: ``test_recursion_guard``
    reloads the module into the same pytest process (see
    ``test_inventory_validation.py``), so a name bound at collection time can
    belong to the pre-reload class.
    """
    import sk_agent_config  # noqa: PLC0415

    path = tmp_path / name
    path.write_text(json.dumps(doc), encoding="utf-8")
    return sk_agent_config.load_config(str(path))


def _duplicates(values) -> list[str]:
    seen, dups = set(), set()
    for value in values:
        if value in seen:
            dups.add(value)
        seen.add(value)
    return sorted(dups)


def _resolution(cfg) -> dict[str, bool]:
    """Per-agent verdict read from the PARSE: can a call reach a model?"""
    out = {}
    for agent in cfg.agents:
        model = cfg.get_model(agent.model) if agent.model else None
        out[agent.id] = bool(
            agent.config_error is None
            and model is not None
            and model.enabled
            and model.base_url_error is None
        )
    return out


def _publication_report(cfg, declared_ids) -> dict[str, list[str]]:
    """The criteria a published config must satisfy, all read from the parse."""
    parsed = [agent.id for agent in cfg.agents]
    resolved = _resolution(cfg)
    return {
        "missing": sorted(set(declared_ids) - set(parsed)),
        "duplicates": _duplicates(parsed),
        "unresolved": sorted(agent_id for agent_id, ok in resolved.items() if not ok),
    }


class TestLoaderContractOnParsedConfig:
    """The loader's contract, asserted on what ``load_config`` RETURNS."""

    @pytest.fixture
    def v1_single_model_witness(self) -> dict:
        """The pre-fix shape (vllm#627 old head ``fe831e5e62``), sanitised.

        No ``config_version``; a SINGULAR ``model`` block carrying
        ``default_model`` and ``sampling``; an ``agents`` array of 10 presets.
        Every value is a dummy — the shape is the point, not the values.
        """
        return {
            "_comment": "v1-shaped: singular model block, preset list below",
            "model": {
                "base_url": "https://models.example.test/v1",
                "api_key_env": "VLLM_API_KEY_SWIFT",
                "default_model": "swift-1.5-27b",
                "vision": True,
                "sampling": {
                    "temperature": 0.7,
                    "top_p": 0.95,
                    "top_k": 20,
                    "presence_penalty": 1.5,
                    "max_tokens": 4096,
                },
            },
            "agents": [
                {"id": agent_id, "model": "swift-1.5-27b", "system_prompt": "p"}
                for agent_id in V1_WITNESS_PRESETS
            ],
            "mcps": [],
        }

    def test_v1_single_model_witness_fails_the_publication_criteria(
        self, tmp_path, v1_single_model_witness
    ):
        """Witness: the old head does not survive the loader.

        ``migrate_config_v1_to_v2`` turns the singular ``model`` block into a
        one-entry pool with id ``default`` and derives ONE agent from it; the
        declared ``agents`` array is never copied, so all 10 presets are lost
        before any parse. The declared sampling is ignored too: it sits inside
        the model entry, so the global sampling keeps its defaults — the block
        was not merely superfluous, it was unread.
        """
        import sk_agent_config  # noqa: PLC0415

        cfg = _load_doc(tmp_path, v1_single_model_witness, "witness.json")

        # The file is migrated, not rejected: nothing raises.
        assert cfg.config_version == 2
        assert [model.id for model in cfg.models] == ["default"]
        assert [agent.id for agent in cfg.agents] == ["default"]
        assert cfg.sampling.temperature == 1.0
        assert cfg.sampling.top_p == 1.0
        assert cfg.sampling.top_k == -1

        # The criteria the healthy forms PASS report the amputation.
        report = _publication_report(cfg, V1_WITNESS_PRESETS)
        assert report["missing"] == sorted(V1_WITNESS_PRESETS)  # 10 declared, 0 kept

        # Validation names the two leftovers that leaked into the model entry.
        # The errors exist, but they are NOT what makes this file broken: the
        # presets are already gone by then.
        migrated = sk_agent_config.migrate_config_v1_to_v2(
            copy.deepcopy(v1_single_model_witness)
        )
        errors = sk_agent_config.validate_config(migrated)
        assert any("models.0.default_model" in error for error in errors), errors
        assert any("models.0.sampling" in error for error in errors), errors

    def test_shipped_template_parses_every_declared_agent(self, monkeypatch):
        """The versioned template must come back entry for entry.

        ``test_inventory_validation`` guards it at the VALIDATION level; this
        asserts the PARSE — no entry dropped, none rejected, every agent
        reaching an enabled model without a base_url error.
        """
        import sk_agent_config  # noqa: PLC0415

        _set_placeholder_env(monkeypatch)
        raw = json.loads(TEMPLATE_PATH.read_text(encoding="utf-8"))
        declared = [agent["id"] for agent in raw.get("agents", [])]

        cfg = sk_agent_config.load_config(str(TEMPLATE_PATH))

        assert [agent.id for agent in cfg.agents] == declared
        assert all(agent.config_error is None for agent in cfg.agents)
        report = _publication_report(cfg, declared)
        assert report == {"missing": [], "duplicates": [], "unresolved": []}

    def test_additive_publication_keeps_every_template_agent_intact(
        self, monkeypatch, tmp_path
    ):
        """The publication path measured on vllm#627: additive, distinct ids.

        Base + one model + four presets at ids the template does not carry.
        Every template agent must come back identical — same model, same MCP
        list, same memory flag, same prompt — and the presets must resolve.
        This is the positive control: the criteria above can PASS.
        """
        import sk_agent_config  # noqa: PLC0415

        _set_placeholder_env(monkeypatch)
        base_raw = json.loads(TEMPLATE_PATH.read_text(encoding="utf-8"))
        base = sk_agent_config.load_config(str(TEMPLATE_PATH))
        declared = [agent["id"] for agent in base_raw.get("agents", [])]
        # Test-owned ids. The scenario is "one model + four presets the base
        # does not carry", so the ids must stay distinct from the template
        # even on the day the real voltron-* presets are published to it —
        # hard-coding their names would turn this test red on that
        # legitimate change instead of on the regression it guards.
        model_id = "publication-test-harness"
        preset_ids = [
            "publication-test-" + suffix
            for suffix in ("extract", "classify", "numbers", "diff")
        ]

        additive = copy.deepcopy(base_raw)
        model_ids = {m.get("id") for m in additive.get("models", [])}
        assert model_id not in model_ids  # distinct id, by construction
        assert not set(preset_ids) & set(declared)
        additive["models"].append(
            {
                "id": model_id,
                "enabled": True,
                "base_url": "https://harness.example.test/v1",
                "api_key_env": "VLLM_API_KEY_SWIFT",
                "model_id": model_id,
            }
        )
        additive["agents"].extend(
            {
                "id": agent_id,
                "model": model_id,
                "system_prompt": "p",
                "mcps": [],
                "memory": {"enabled": False},
            }
            for agent_id in preset_ids
        )

        assert sk_agent_config.validate_config(additive) == []

        cfg = _load_doc(tmp_path, additive, "additive.json")

        assert [agent.id for agent in cfg.agents] == declared + preset_ids
        for agent in base.agents:
            grown = cfg.get_agent(agent.id)
            assert grown is not None
            assert grown.model == agent.model
            assert grown.mcps == agent.mcps
            assert grown.memory.enabled == agent.memory.enabled
            assert grown.system_prompt == agent.system_prompt
        report = _publication_report(cfg, declared + preset_ids)
        assert report == {"missing": [], "duplicates": [], "unresolved": []}

    def test_block_fusion_last_id_wins_and_amputates_the_parse(self, tmp_path):
        """The trap: fusing two files by appending the second one's lists.

        Measured on vllm#627: validation LOGS the duplicate ids and lets the
        load through, and on the PARSED config the later entry wins — the
        earlier one keeps its place in ``cfg.agents`` but no lookup reaches
        it. Assertions below read the parse, never the log: a test that only
        reads the errors reports them and still calls the file sound.
        """
        import sk_agent_config  # noqa: PLC0415

        base = {
            "config_version": 2,
            "models": [
                {
                    "id": "swift-1.5-27b",
                    "enabled": True,
                    "base_url": "https://medium.example.test/v1",
                    "api_key_env": "VLLM_API_KEY_SWIFT",
                    "model_id": "swift-1.5-27b",
                },
                {
                    "id": "swift-1.5-27b-no-thinking",
                    "enabled": True,
                    "base_url": "https://medium.example.test/v1",
                    "api_key_env": "VLLM_API_KEY_SWIFT",
                    "model_id": "swift-1.5-27b-no-thinking",
                },
                {
                    "id": "frognano-4b",
                    "enabled": True,
                    "base_url": "https://nano.example.test/v1",
                    "api_key_env": "FROGNANO_API_KEY",
                    "model_id": "frognano-4b",
                },
            ],
            "mcps": [
                {"id": "searxng", "command": "npx", "args": ["-y", "mcp-searxng"]},
                {"id": "playwright", "command": "npx", "args": ["-y", "@playwright/mcp"]},
                {"id": "markitdown", "command": "uvx", "args": ["markitdown-mcp"]},
            ],
            "agents": [
                {
                    "id": "analyst",
                    "model": "swift-1.5-27b",
                    "system_prompt": "base analyst",
                    "mcps": ["searxng", "playwright", "markitdown"],
                    "memory": {"enabled": True},
                },
                {
                    "id": "vision-local",
                    "model": "swift-1.5-27b",
                    "system_prompt": "base vision",
                    "mcps": ["searxng", "playwright", "markitdown"],
                    "memory": {"enabled": False},
                },
                {
                    "id": "summarizer-local",
                    "model": "frognano-4b",
                    "system_prompt": "base summarizer",
                    "mcps": [],
                    "memory": {"enabled": False},
                },
            ],
            "embeddings": {"base_url": "https://emb.example.test", "model_id": "emb"},
        }
        # The example file's shape: agent ids already in the base, with no
        # MCPs and no memory of their own, plus a new model and a new preset.
        overlay = {
            "config_version": 2,
            "models": [
                {**base["models"][0], "base_url": "https://hub.example.test/v1"},
                {**base["models"][1], "base_url": "https://hub.example.test/v1"},
                {
                    "id": "voltron-harness",
                    "enabled": True,
                    "base_url": "https://harness.example.test/v1",
                    "api_key_env": "VLLM_API_KEY_SWIFT",
                    "model_id": "voltron-harness",
                },
            ],
            "agents": [
                {
                    "id": "analyst",
                    "model": "swift-1.5-27b",
                    "system_prompt": "overlay analyst",
                },
                {
                    "id": "vision-local",
                    "model": "swift-1.5-27b",
                    "system_prompt": "overlay vision",
                },
                {
                    "id": "summarizer-local",
                    "model": "swift-1.5-27b-no-thinking",
                    "system_prompt": "overlay summarizer",
                },
                {
                    "id": "voltron-extract",
                    "model": "voltron-harness",
                    "system_prompt": "overlay extract",
                },
            ],
            "mcps": [],
        }
        fused = copy.deepcopy(base)
        fused["models"].extend(copy.deepcopy(overlay["models"]))
        fused["agents"].extend(copy.deepcopy(overlay["agents"]))

        # Validation SEES the duplicates — and lets the load through anyway.
        errors = sk_agent_config.validate_config(fused)
        for duplicated_id in ("swift-1.5-27b", "analyst", "vision-local", "summarizer-local"):
            assert any(duplicated_id in error for error in errors), (
                duplicated_id,
                errors,
            )

        cfg = _load_doc(tmp_path, fused, "fused.json")

        # Nothing is dropped: the earlier entries are still in the list...
        ids = [agent.id for agent in cfg.agents]
        assert len(ids) == len(base["agents"]) + len(overlay["agents"])
        assert _duplicates(ids) == ["analyst", "summarizer-local", "vision-local"]

        # ...but every lookup resolves the LAST entry, so the earlier one is
        # unreachable by id — the amputation. Only the parse shows it.
        analyst = cfg.get_agent("analyst")
        assert analyst is not None
        assert analyst.system_prompt == "overlay analyst"
        assert analyst.mcps == []
        assert analyst.memory.enabled is False
        first_analyst = [agent for agent in cfg.agents if agent.id == "analyst"][0]
        assert first_analyst.mcps == ["searxng", "playwright", "markitdown"]
        assert first_analyst.memory.enabled is True

        assert cfg.get_agent("vision-local").mcps == []
        assert cfg.get_agent("summarizer-local").model == "swift-1.5-27b-no-thinking"
        assert cfg.get_model("swift-1.5-27b").base_url == "https://hub.example.test/v1"

        # The file is not rejected: the new preset resolves fine, and the
        # shared criteria report the duplicates.
        assert _resolution(cfg)["voltron-extract"] is True
        report = _publication_report(cfg, [a["id"] for a in base["agents"]])
        assert report["duplicates"] == ["analyst", "summarizer-local", "vision-local"]
        assert report["unresolved"] == []
