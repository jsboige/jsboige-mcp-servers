"""
sk-agent configuration module.

Handles loading, validation, and migration of sk-agent configuration.
Supports two config versions:
  - v1: Model-centric (legacy) - models are the primary entities
  - v2: Agent-centric - agents combine model + prompt + MCPs + memory

When v1 config is detected (no config_version field), it is automatically
migrated to v2 format in memory. The file on disk is not modified.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

log = logging.getLogger("sk-agent.config")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CONFIG_PATH = os.environ.get(
    "SK_AGENT_CONFIG",
    str(Path(__file__).parent / "sk_agent_config.json"),
)

SK_AGENT_DEPTH = int(os.environ.get("SK_AGENT_DEPTH", "0"))
DEFAULT_MAX_RECURSION_DEPTH = 2


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class ModelConfig:
    """A model endpoint (shared resource pool)."""
    id: str
    base_url: str = "http://localhost:5001/v1"
    api_key: str = "no-key"
    api_key_env: str = ""
    model_id: str = "default"
    vision: bool = False
    enabled: bool = True
    description: str = ""
    context_window: int = 32_000
    system_prompt: str = ""  # Legacy: per-model prompt (v1 compat)

    @classmethod
    def from_dict(cls, data: dict) -> ModelConfig:
        return cls(
            id=data.get("id", "unknown"),
            base_url=data.get("base_url", "http://localhost:5001/v1"),
            api_key=data.get("api_key", "no-key"),
            api_key_env=data.get("api_key_env", ""),
            model_id=data.get("model_id", data.get("id", "default")),
            vision=data.get("vision", False),
            enabled=data.get("enabled", True),
            description=data.get("description", ""),
            context_window=data.get("context_window", _infer_context_window(data)),
            system_prompt=data.get("system_prompt", ""),
        )

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "base_url": self.base_url,
            "api_key": self.api_key,
            "model_id": self.model_id,
            "vision": self.vision,
            "enabled": self.enabled,
            "description": self.description,
            "context_window": self.context_window,
        }
        if self.api_key_env:
            d["api_key_env"] = self.api_key_env
        if self.system_prompt:
            d["system_prompt"] = self.system_prompt
        return d

    def resolve_api_key(self) -> str:
        """Resolve API key from env var or direct value."""
        if self.api_key_env:
            return os.environ.get(self.api_key_env, self.api_key)
        return self.api_key


@dataclass
class McpConfig:
    """An MCP server (shared resource pool)."""
    id: str
    description: str = ""
    command: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict) -> McpConfig:
        return cls(
            id=data.get("id") or data.get("name", "unknown"),
            description=data.get("description", ""),
            command=data.get("command", ""),
            args=data.get("args", []),
            env=data.get("env", {}),
        )

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "description": self.description,
            "command": self.command,
            "args": self.args,
        }
        if self.env:
            d["env"] = self.env
        return d


@dataclass
class MemoryConfig:
    """Per-agent memory configuration."""
    enabled: bool = False
    collection: str = ""  # Auto-generated if empty: "{agent_id}-memory"

    @classmethod
    def from_dict(cls, data: dict | None) -> MemoryConfig:
        if not data:
            return cls()
        return cls(
            enabled=data.get("enabled", False),
            collection=data.get("collection", ""),
        )

    def to_dict(self) -> dict:
        d: dict[str, Any] = {"enabled": self.enabled}
        if self.collection:
            d["collection"] = self.collection
        return d


@dataclass
class EmbeddingsConfig:
    """Shared embeddings endpoint configuration."""
    base_url: str = ""
    api_key: str = ""
    api_key_env: str = ""
    model_id: str = ""
    dimensions: int = 2560

    @classmethod
    def from_dict(cls, data: dict | None) -> EmbeddingsConfig:
        if not data:
            return cls()
        return cls(
            base_url=data.get("base_url", ""),
            api_key=data.get("api_key", ""),
            api_key_env=data.get("api_key_env", ""),
            model_id=data.get("model_id", ""),
            dimensions=data.get("dimensions", 2560),
        )

    def to_dict(self) -> dict:
        d: dict[str, Any] = {}
        if self.base_url:
            d["base_url"] = self.base_url
        if self.api_key:
            d["api_key"] = self.api_key
        if self.api_key_env:
            d["api_key_env"] = self.api_key_env
        if self.model_id:
            d["model_id"] = self.model_id
        d["dimensions"] = self.dimensions
        return d

    @property
    def is_configured(self) -> bool:
        return bool(self.base_url and self.model_id)

    def resolve_api_key(self) -> str:
        if self.api_key_env:
            return os.environ.get(self.api_key_env, self.api_key)
        return self.api_key


@dataclass
class QdrantConfig:
    """Shared Qdrant vector store configuration."""
    url: str = "http://localhost"
    port: int = 6333
    api_key: str = ""
    api_key_env: str = ""
    default_collection_prefix: str = "sk-agent"

    def resolve_api_key(self) -> str | None:
        """Resolve API key from env var or direct value."""
        if self.api_key_env:
            key = os.environ.get(self.api_key_env, "")
            if key:
                return key
        return self.api_key if self.api_key else None

    @classmethod
    def from_dict(cls, data: dict | None) -> QdrantConfig:
        if not data:
            return cls()
        return cls(
            url=data.get("url", "http://localhost"),
            port=data.get("port", 6333),
            api_key=data.get("api_key", ""),
            api_key_env=data.get("api_key_env", ""),
            default_collection_prefix=data.get("default_collection_prefix", "sk-agent"),
        )

    def to_dict(self) -> dict:
        d = {
            "url": self.url,
            "port": self.port,
            "default_collection_prefix": self.default_collection_prefix,
        }
        if self.api_key:
            d["api_key"] = self.api_key
        if self.api_key_env:
            d["api_key_env"] = self.api_key_env
        return d


@dataclass
class AgentConfig:
    """An agent: model + system prompt + MCP subset + memory + parameters."""
    id: str
    description: str = ""
    model: str = ""  # Reference to a ModelConfig.id
    system_prompt: str = ""
    mcps: list[str] = field(default_factory=list)  # References to McpConfig.id
    memory: MemoryConfig = field(default_factory=MemoryConfig)
    parameters: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict) -> AgentConfig:
        return cls(
            id=data.get("id", "unknown"),
            description=data.get("description", ""),
            model=data.get("model", ""),
            system_prompt=data.get("system_prompt", ""),
            mcps=data.get("mcps", []),
            memory=MemoryConfig.from_dict(data.get("memory")),
            parameters=data.get("parameters", {}),
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "description": self.description,
            "model": self.model,
            "system_prompt": self.system_prompt,
            "mcps": self.mcps,
            "memory": self.memory.to_dict(),
            "parameters": self.parameters,
        }


ConversationType = Literal["sequential", "concurrent", "group_chat", "handoff", "magentic"]


@dataclass
class ConversationConfig:
    """A multi-agent conversation preset."""
    id: str
    description: str = ""
    type: ConversationType = "sequential"
    agents: list[str] = field(default_factory=list)  # Agent IDs
    max_rounds: int = 10
    inline_agents: list[AgentConfig] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict) -> ConversationConfig:
        inline = [AgentConfig.from_dict(a) for a in data.get("inline_agents", [])]
        return cls(
            id=data.get("id", "unknown"),
            description=data.get("description", ""),
            type=data.get("type", "sequential"),
            agents=data.get("agents", []),
            max_rounds=data.get("max_rounds", 10),
            inline_agents=inline,
        )

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "id": self.id,
            "description": self.description,
            "type": self.type,
            "agents": self.agents,
            "max_rounds": self.max_rounds,
        }
        if self.inline_agents:
            d["inline_agents"] = [a.to_dict() for a in self.inline_agents]
        return d


@dataclass
class SKAgentConfig:
    """Top-level configuration for sk-agent v2."""
    config_version: int = 2
    max_recursion_depth: int = DEFAULT_MAX_RECURSION_DEPTH
    default_agent: str = ""
    default_vision_agent: str = ""
    system_prompt: str = ""  # Global fallback

    models: list[ModelConfig] = field(default_factory=list)
    mcps: list[McpConfig] = field(default_factory=list)
    agents: list[AgentConfig] = field(default_factory=list)
    conversations: list[ConversationConfig] = field(default_factory=list)
    embeddings: EmbeddingsConfig = field(default_factory=EmbeddingsConfig)
    qdrant: QdrantConfig = field(default_factory=QdrantConfig)

    # Indexes for fast lookup (built by _build_indexes)
    _model_map: dict[str, ModelConfig] = field(default_factory=dict, repr=False)
    _mcp_map: dict[str, McpConfig] = field(default_factory=dict, repr=False)
    _agent_map: dict[str, AgentConfig] = field(default_factory=dict, repr=False)
    _conversation_map: dict[str, ConversationConfig] = field(default_factory=dict, repr=False)

    def __post_init__(self):
        self._build_indexes()

    def _build_indexes(self):
        self._model_map = {m.id: m for m in self.models}
        self._mcp_map = {m.id: m for m in self.mcps}
        self._agent_map = {a.id: a for a in self.agents}
        self._conversation_map = {c.id: c for c in self.conversations}

    def get_model(self, model_id: str) -> ModelConfig | None:
        return self._model_map.get(model_id)

    def get_mcp(self, mcp_id: str) -> McpConfig | None:
        return self._mcp_map.get(mcp_id)

    def get_agent(self, agent_id: str) -> AgentConfig | None:
        return self._agent_map.get(agent_id)

    def get_conversation(self, conv_id: str) -> ConversationConfig | None:
        return self._conversation_map.get(conv_id)

    def get_default_agent(self) -> AgentConfig | None:
        """Get the default agent for text queries."""
        if self.default_agent:
            return self.get_agent(self.default_agent)
        if self.agents:
            return self.agents[0]
        return None

    def get_default_vision_agent(self) -> AgentConfig | None:
        """Get the default agent for vision queries."""
        if self.default_vision_agent:
            return self.get_agent(self.default_vision_agent)
        # Find first agent whose model supports vision
        for agent in self.agents:
            model = self.get_model(agent.model)
            if model and model.vision:
                return agent
        return None

    def find_agent_for_model(self, model_id: str) -> AgentConfig | None:
        """Find an agent that uses a given model (backward compat)."""
        for agent in self.agents:
            if agent.model == model_id:
                return agent
        return None

    def agent_has_vision(self, agent_id: str) -> bool:
        """Check if an agent's model supports vision."""
        agent = self.get_agent(agent_id)
        if not agent:
            return False
        model = self.get_model(agent.model)
        return bool(model and model.vision)

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "config_version": self.config_version,
            "max_recursion_depth": self.max_recursion_depth,
            "default_agent": self.default_agent,
            "default_vision_agent": self.default_vision_agent,
            "models": [m.to_dict() for m in self.models],
            "mcps": [m.to_dict() for m in self.mcps],
            "agents": [a.to_dict() for a in self.agents],
        }
        if self.system_prompt:
            d["system_prompt"] = self.system_prompt
        if self.conversations:
            d["conversations"] = [c.to_dict() for c in self.conversations]
        if self.embeddings.is_configured:
            d["embeddings"] = self.embeddings.to_dict()
        d["qdrant"] = self.qdrant.to_dict()
        return d


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def _infer_context_window(model_data: dict) -> int:
    """Infer context window from model metadata when not explicitly set."""
    if model_data.get("vision", False):
        return 128_000
    base_url = model_data.get("base_url", "")
    if "z.ai" in base_url or "openai.com" in base_url:
        return 200_000
    return 32_000


def get_model_context_window(config: SKAgentConfig, model_id: str) -> int:
    """Get context window for a model."""
    model = config.get_model(model_id)
    if model:
        return model.context_window
    return 32_000


# ---------------------------------------------------------------------------
# V1 -> V2 Migration
# ---------------------------------------------------------------------------

def migrate_config_v1_to_v2(raw: dict) -> dict:
    """Migrate a v1 (model-centric) config to v2 (agent-centric) format.

    V1 format:
      - models: list of model defs (each is an independent entity)
      - mcps: list of MCP defs (shared by all models)
      - default_ask_model / default_vision_model
      - system_prompt: global prompt

    V2 format:
      - models: shared model pool (unchanged)
      - mcps: shared MCP pool (id field added if missing)
      - agents: one agent per enabled model (1:1 mapping)
      - default_agent / default_vision_agent
      - embeddings, qdrant, conversations: new sections (empty in migrated)

    The file on disk is NOT modified.
    """
    # Already v2
    if raw.get("config_version", 0) >= 2:
        return raw

    log.info("Migrating config from v1 to v2 format")

    # Handle very old single-model format
    if "model" in raw and "models" not in raw:
        old_model = raw["model"]
        model_id = old_model.get("model_id", "default")
        raw["models"] = [{"id": model_id, **old_model}]
        raw.setdefault("default_ask_model", model_id)
        del raw["model"]

    migrated: dict[str, Any] = {
        "config_version": 2,
        "max_recursion_depth": raw.get("max_recursion_depth", DEFAULT_MAX_RECURSION_DEPTH),
    }

    # Copy models as-is (shared pool)
    models = raw.get("models", [])
    migrated["models"] = models

    # Normalize MCPs: ensure each has an "id" field
    mcps = []
    for mcp in raw.get("mcps", []):
        normalized = dict(mcp)
        if "id" not in normalized:
            normalized["id"] = normalized.get("name", "unknown")
        mcps.append(normalized)
    migrated["mcps"] = mcps

    # Collect all MCP IDs
    all_mcp_ids = [m.get("id") or m.get("name", "") for m in mcps]

    # Global system prompt
    global_prompt = raw.get("system_prompt", "")
    if global_prompt:
        migrated["system_prompt"] = global_prompt

    # Set default models
    default_ask = raw.get("default_ask_model", "")
    default_vision = raw.get("default_vision_model", "")

    if not default_ask and models:
        default_ask = models[0].get("id", "")
    if not default_vision and models:
        for m in models:
            if m.get("vision", False):
                default_vision = m.get("id", "")
                break
        else:
            default_vision = models[0].get("id", "")

    # Create one agent per enabled model (1:1 mapping)
    agents = []
    for model in models:
        if not model.get("enabled", True):
            continue

        model_id = model.get("id", "unknown")
        model_prompt = model.get("system_prompt", "")
        agent = {
            "id": model_id,
            "description": model.get("description", ""),
            "model": model_id,
            "system_prompt": model_prompt or global_prompt,
            "mcps": list(all_mcp_ids),  # All MCPs shared in v1
            "memory": {"enabled": False},
            "parameters": {},
        }
        agents.append(agent)

    migrated["agents"] = agents

    # Map default model IDs to agent IDs (same in 1:1 mapping)
    migrated["default_agent"] = default_ask
    migrated["default_vision_agent"] = default_vision

    # Empty advanced sections (not available in v1)
    migrated["conversations"] = []
    # embeddings and qdrant are optional, omit in migrated

    return migrated


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

class ConfigValidationError(Exception):
    """Raised when config validation fails."""
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__(f"Config validation failed: {'; '.join(errors)}")


def validate_config(raw: dict) -> list[str]:
    """Validate a v2 config and return list of error messages (empty = valid)."""
    errors: list[str] = []

    version = raw.get("config_version", 0)
    if version < 2:
        errors.append(f"Invalid config_version: {version} (expected >= 2)")
        return errors  # Can't validate further

    # Validate models
    model_ids = set()
    for i, m in enumerate(raw.get("models", [])):
        mid = m.get("id")
        if not mid:
            errors.append(f"models[{i}]: missing 'id'")
        elif mid in model_ids:
            errors.append(f"models[{i}]: duplicate id '{mid}'")
        else:
            model_ids.add(mid)

    # Validate MCPs
    mcp_ids = set()
    for i, m in enumerate(raw.get("mcps", [])):
        mid = m.get("id") or m.get("name")
        if not mid:
            errors.append(f"mcps[{i}]: missing 'id'")
        elif mid in mcp_ids:
            errors.append(f"mcps[{i}]: duplicate id '{mid}'")
        else:
            mcp_ids.add(mid)

    # Validate agents
    agent_ids = set()
    for i, a in enumerate(raw.get("agents", [])):
        aid = a.get("id")
        if not aid:
            errors.append(f"agents[{i}]: missing 'id'")
        elif aid in agent_ids:
            errors.append(f"agents[{i}]: duplicate id '{aid}'")
        else:
            agent_ids.add(aid)

        # Agent model must reference existing model
        amodel = a.get("model", "")
        if amodel and amodel not in model_ids:
            errors.append(f"agents[{i}] '{aid}': model '{amodel}' not found in models")

        # Agent MCPs must reference existing MCPs
        for mcp_ref in a.get("mcps", []):
            if mcp_ref not in mcp_ids:
                errors.append(f"agents[{i}] '{aid}': mcp '{mcp_ref}' not found in mcps")

    # Validate default agents
    default_agent = raw.get("default_agent", "")
    if default_agent and default_agent not in agent_ids:
        errors.append(f"default_agent '{default_agent}' not found in agents")

    default_vision = raw.get("default_vision_agent", "")
    if default_vision and default_vision not in agent_ids:
        errors.append(f"default_vision_agent '{default_vision}' not found in agents")

    # Validate conversations
    for i, c in enumerate(raw.get("conversations", [])):
        cid = c.get("id")
        if not cid:
            errors.append(f"conversations[{i}]: missing 'id'")

        ctype = c.get("type", "")
        valid_types = ("sequential", "concurrent", "group_chat", "handoff", "magentic")
        if ctype and ctype not in valid_types:
            errors.append(f"conversations[{i}] '{cid}': invalid type '{ctype}'")

        # Build set of inline agent IDs for this conversation
        inline_ids = set()
        for ia in c.get("inline_agents", []):
            iaid = ia.get("id")
            if iaid:
                inline_ids.add(iaid)

        # Each agent ref must be in top-level agents OR inline agents
        for agent_ref in c.get("agents", []):
            if agent_ref not in agent_ids and agent_ref not in inline_ids:
                errors.append(
                    f"conversations[{i}] '{cid}': agent '{agent_ref}' not found "
                    "in top-level agents or inline_agents"
                )

    # Validate embeddings (if memory is used by any agent)
    any_memory = any(
        a.get("memory", {}).get("enabled", False)
        for a in raw.get("agents", [])
    )
    embeddings = raw.get("embeddings", {})
    if any_memory and not (embeddings.get("base_url") and embeddings.get("model_id")):
        errors.append(
            "embeddings.base_url and embeddings.model_id are required "
            "when any agent has memory enabled"
        )

    return errors


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load_config(path: str | None = None) -> SKAgentConfig:
    """Load and parse configuration from JSON file.

    Handles:
    - Missing file (returns empty config)
    - v1 format (auto-migrates to v2)
    - v2 format (parsed directly)
    - Validation warnings (logged, not fatal)
    """
    config_path = Path(path or CONFIG_PATH)

    if not config_path.exists():
        log.warning("Config not found at %s, using defaults", config_path)
        return SKAgentConfig()

    with open(config_path, encoding="utf-8") as f:
        raw = json.load(f)

    # Migrate v1 -> v2 if needed
    if raw.get("config_version", 0) < 2:
        raw = migrate_config_v1_to_v2(raw)

    # Validate
    errors = validate_config(raw)
    if errors:
        for err in errors:
            log.warning("Config validation: %s", err)

    # Parse into dataclasses
    return _parse_config(raw)


def _parse_config(raw: dict) -> SKAgentConfig:
    """Parse a validated v2 config dict into SKAgentConfig."""
    models = [ModelConfig.from_dict(m) for m in raw.get("models", [])]
    mcps = [McpConfig.from_dict(m) for m in raw.get("mcps", [])]
    agents = [AgentConfig.from_dict(a) for a in raw.get("agents", [])]
    conversations = [ConversationConfig.from_dict(c) for c in raw.get("conversations", [])]

    return SKAgentConfig(
        config_version=raw.get("config_version", 2),
        max_recursion_depth=raw.get("max_recursion_depth", DEFAULT_MAX_RECURSION_DEPTH),
        default_agent=raw.get("default_agent", ""),
        default_vision_agent=raw.get("default_vision_agent", ""),
        system_prompt=raw.get("system_prompt", ""),
        models=models,
        mcps=mcps,
        agents=agents,
        conversations=conversations,
        embeddings=EmbeddingsConfig.from_dict(raw.get("embeddings")),
        qdrant=QdrantConfig.from_dict(raw.get("qdrant")),
    )


def save_config(config: SKAgentConfig, path: str | None = None) -> None:
    """Save configuration to JSON file."""
    config_path = Path(path or CONFIG_PATH)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config.to_dict(), f, indent=2, ensure_ascii=False)
