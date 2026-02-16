#!/usr/bin/env python3
"""
Unit tests for sk_agent_config module.

Tests cover:
- V1 -> V2 config migration
- Config validation
- Dataclass parsing (round-trip)
- Edge cases (missing fields, duplicates, etc.)
- Default agent resolution
"""

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
            {"id": "searxng", "description": "Web search", "command": "npx", "args": ["-y", "mcp-searxng"]},
            {"id": "playwright", "description": "Browser", "command": "npx", "args": ["-y", "@playwright/mcp"]},
        ],
        "agents": [
            {
                "id": "analyst",
                "description": "General analyst",
                "model": "glm-5",
                "system_prompt": "You are an analyst.",
                "mcps": ["searxng", "playwright"],
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
        assert m.base_url == "http://localhost:5001/v1"
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
