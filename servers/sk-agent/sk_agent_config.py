"""
sk-agent configuration module.

Handles loading, validation, and migration of sk-agent configuration.
Supports two config versions:
  - v1: Model-centric (legacy) - models are the primary entities
  - v2: Agent-centric - agents combine model + prompt + MCPs + memory

When v1 config is detected (no config_version field), it is automatically
migrated to v2 format in memory. The file on disk is not modified.

v2 schemas are validated by ``sk_agent_schemas.SKAgentConfig`` (Pydantic
v2). The dataclasses declared here remain the in-memory representation
returned to callers; ``validate_config`` chains the legacy structural
checks with the Pydantic schema check so that both readable error
messages and structured type errors surface.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

try:
    # Pydantic v2 schemas. The import is best-effort: when pydantic is
    # not installed, the legacy structural checks still run and callers
    # see a clear error if they explicitly invoke the schema validator.
    from sk_agent_schemas import (
        SCHEMA_VERSION,
        validate_config_payload as _validate_payload_via_pydantic,
    )
    _HAS_PYDANTIC_SCHEMA = True
except ImportError:  # pragma: no cover - exercised only when pydantic missing
    _HAS_PYDANTIC_SCHEMA = False
    SCHEMA_VERSION = 2

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


def can_spawn_recursive_agent(
    current_depth: int | None = None,
    max_depth: int | None = None,
) -> bool:
    """Centralized guard for self-inclusion recursion (#3409, parent #1748).

    A child sk-agent process running at ``current_depth + 1`` is allowed iff
    ``current_depth + 1 <= max_depth``. With ``DEFAULT_MAX_RECURSION_DEPTH = 2``
    this permits depths 0, 1, 2 (root + 2 levels of self-inclusion) and refuses
    any deeper attempt — including those reached via ``mcp_overrides`` /
    ``agent_spec`` / inline agents / dynamic specs. Centralizing this decision
    keeps the rule authoritative across stdio and streamable-http transports.

    Args:
        current_depth: Parent's recursion depth. Defaults to ``SK_AGENT_DEPTH``
            (process-global env var). Pass an explicit value to evaluate a
            prospective spawn in advance.
        max_depth: Effective ceiling. Defaults to ``DEFAULT_MAX_RECURSION_DEPTH``
            (2). Values <= 0 are clamped to refuse all spawns to avoid
            misconfiguration producing unbounded recursion.

    Returns:
        True iff spawning a child sk-agent at ``current_depth + 1`` is allowed.
    """
    if current_depth is None:
        current_depth = SK_AGENT_DEPTH
    if max_depth is None:
        max_depth = DEFAULT_MAX_RECURSION_DEPTH

    if max_depth <= 0:
        return False
    if current_depth < 0:
        return False
    return current_depth + 1 <= max_depth


def is_self_referential_mcp(mcp_id: str, args: list[str]) -> bool:
    """Detect an MCP entry that launches sk-agent itself (#3415, parent #1748).

    The recursion ceiling only binds when self-inclusion is recognized, so a
    launch form that escapes this predicate escapes the ceiling entirely. Two
    forms reach the same ``sk_agent.py``:

    - script form -- ``python .../sk_agent.py`` (matched on the filename);
    - module form -- ``python -m sk_agent`` (no ``.py`` in the args at all).

    The module form is a valid entry point: ``importlib.util.find_spec
    ("sk_agent")`` resolves to ``sk_agent.py``, whose ``__main__`` block starts
    the very same server. Matching only ``"sk_agent.py"`` therefore let
    ``{"command": "python", "args": ["-m", "sk_agent"]}`` spawn children at any
    depth. Args are tokenized rather than joined so that an unrelated path such
    as ``.../not_sk_agent_helper/run.py`` cannot match by substring.

    Args:
        mcp_id: The MCP entry id, matched case-insensitively on the ``sk_agent``
            / ``sk-agent`` stem (an id naming sk-agent is self-referential
            whatever its args).
        args: The argv tail passed to ``command``.

    Returns:
        True iff the entry launches sk-agent itself.
    """
    normalized_id = (mcp_id or "").lower().replace("-", "_")
    if "sk_agent" in normalized_id:
        return True

    for raw in args or []:
        token = str(raw).replace("\\", "/")
        # Script form: any path ending in sk_agent.py.
        if token.rsplit("/", 1)[-1] == "sk_agent.py":
            return True
        # Module form: `-m sk_agent` and dotted variants (`pkg.sk_agent`).
        if token.split(".")[-1] == "sk_agent":
            return True
    return False


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass
class ModelConfig:
    """A model endpoint (shared resource pool)."""

    id: str
    base_url: str = "https://api.medium.text-generation-webui.myia.io/v1"
    api_key: str = "no-key"
    api_key_env: str = ""
    model_id: str = "default"
    vision: bool = False
    thinking: bool = False
    enabled: bool = True
    description: str = ""
    context_window: int = 32_000
    system_prompt: str = ""  # Legacy: per-model prompt (v1 compat)

    @classmethod
    def from_dict(cls, data: dict) -> ModelConfig:
        return cls(
            id=data.get("id", "unknown"),
            base_url=data.get("base_url", "https://api.medium.text-generation-webui.myia.io/v1"),
            api_key=data.get("api_key", "no-key"),
            api_key_env=data.get("api_key_env", ""),
            model_id=data.get("model_id", data.get("id", "default")),
            vision=data.get("vision", False),
            thinking=data.get("thinking", False),
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
            "thinking": self.thinking,
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
class SamplingConfig:
    """Global sampling parameters for LLM inference."""

    temperature: float = 1.0
    top_p: float = 1.0
    top_k: int = -1  # -1 = disabled (server default)
    min_p: float = 0.0
    presence_penalty: float = 0.0
    repetition_penalty: float = 1.0
    max_tokens: int = 4096

    @classmethod
    def from_dict(cls, data: dict | None) -> SamplingConfig:
        if not data:
            return cls()
        return cls(
            temperature=data.get("temperature", 1.0),
            top_p=data.get("top_p", 1.0),
            top_k=data.get("top_k", -1),
            min_p=data.get("min_p", 0.0),
            presence_penalty=data.get("presence_penalty", 0.0),
            repetition_penalty=data.get("repetition_penalty", 1.0),
            max_tokens=data.get("max_tokens", 4096),
        )

    def to_dict(self) -> dict:
        return {
            "temperature": self.temperature,
            "top_p": self.top_p,
            "top_k": self.top_k,
            "min_p": self.min_p,
            "presence_penalty": self.presence_penalty,
            "repetition_penalty": self.repetition_penalty,
            "max_tokens": self.max_tokens,
        }


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


ConversationType = Literal[
    "sequential", "concurrent", "group_chat", "handoff", "magentic"
]


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
    sampling: SamplingConfig = field(default_factory=SamplingConfig)

    # Indexes for fast lookup (built by _build_indexes)
    _model_map: dict[str, ModelConfig] = field(default_factory=dict, repr=False)
    _mcp_map: dict[str, McpConfig] = field(default_factory=dict, repr=False)
    _agent_map: dict[str, AgentConfig] = field(default_factory=dict, repr=False)
    _conversation_map: dict[str, ConversationConfig] = field(
        default_factory=dict, repr=False
    )

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
        d["sampling"] = self.sampling.to_dict()
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
        "max_recursion_depth": raw.get(
            "max_recursion_depth", DEFAULT_MAX_RECURSION_DEPTH
        ),
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


def _is_schema_shape(raw: dict) -> bool:
    """Return True when ``raw`` is **plausible** as a schema payload so
    that the Pydantic v2 schema can validate it.

    Kept for backward compatibility with external callers; the
    ``validate_config`` function no longer uses this gate, because the
    schema now accepts legacy field names via
    ``_normalize_legacy_fields``.
    """
    return _is_v2_payload(raw)


def _is_v2_payload(raw: dict) -> bool:
    """True when ``raw`` carries ``config_version >= 2`` and is a dict.

    v1 payloads and non-dict inputs are rejected at this gate.
    """
    if not isinstance(raw, dict):
        return False
    version = raw.get("config_version", 0)
    if version < 2:
        return False
    return True


def _normalise_for_schema(raw: dict) -> dict:
    """Return a deep-copied payload with the legacy field names the
    schema expects to translate folded out before validation.

    Mirrors the work done by ``SKAgentConfig._normalize_legacy_fields``
    (mode="before") at the schema boundary, so the schema still sees a
    dict whose keys it can read deterministically even though the
    validator itself runs before the data is bound.

    Kept deliberately small and explicit: any new legacy field name the
    schema can fold should also be folded here so external tooling
    that bypasses ``validate_config`` and calls
    ``validate_config_payload`` directly gets the same shape.
    """
    import copy

    if not _is_v2_payload(raw):
        return raw

    data = copy.deepcopy(raw)

    # mcps -> tools (schema canonical name).
    if "mcps" in data and "tools" not in data:
        data["tools"] = data.pop("mcps")
    elif "mcps" in data:
        data.pop("mcps")

    # Placeholder api_key -> api_key_env (model-level).
    for model in data.get("models", []) or []:
        if not isinstance(model, dict):
            continue
        if "api_key" in model and "api_key_env" not in model:
            val = model["api_key"]
            from sk_agent_schemas import _API_KEY_PLACEHOLDER_PATTERN
            if isinstance(val, str) and (
                __import__("re").fullmatch(_API_KEY_PLACEHOLDER_PATTERN, val)
            ):
                model_id = model.get("id", "model")
                derived = __import__("re").sub(
                    r"[^A-Z0-9]+", "_", str(model_id).upper()
                ).strip("_")
                if derived:
                    model["api_key_env"] = f"{derived}_API_KEY"
                model.pop("api_key")

    return data


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class ConfigValidationError(Exception):
    """Raised when config validation fails."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__(f"Config validation failed: {'; '.join(errors)}")


def validate_config(raw: dict) -> list[str]:
    """Validate a v2 config and return list of error messages (empty = valid).

    Combines two layers:
      1. **Legacy structural checks** (the checks this function performed
         before Pydantic schemas landed): duplicate IDs, dangling
         references, conversation-type whitelist, etc. These remain in
         place because they produce very readable error strings the
         existing test suite asserts on.
      2. **Pydantic v2 schema validation** (``sk_agent_schemas``): runs
         after the legacy checks and contributes typed errors
         (range, pattern, type, reference-integrity) on top.

    The schema accepts legacy field names (``mcps`` -> ``tools``,
    placeholder ``api_key`` -> ``api_key_env``, etc.) via its
    ``_normalize_legacy_fields`` validator. To keep the legacy
    structural checks working on the original payload while the
    schema validates the normalised one, we run a *copy* through the
    normalisation step before handing it to Pydantic.
    """
    errors: list[str] = []

    version = raw.get("config_version", 0)
    if version < 2:
        errors.append(f"Invalid config_version: {version} (expected >= 2)")
        return errors  # Can't validate further

    if _HAS_PYDANTIC_SCHEMA:
        schema_payload = _normalise_for_schema(raw)
        _, pyd_errors = _validate_payload_via_pydantic(schema_payload)
        errors.extend(f"[schema] {msg}" for msg in pyd_errors)

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

    # Validate MCPs / tools. Both keys map to the same registry
    # (schema name: ``tools``; legacy alias: ``mcps``). The schema
    # itself folds ``mcps`` -> ``tools`` before validation, but the
    # legacy structural checks run on the original payload, so we
    # accept either name here.
    mcp_ids: set[str] = set()
    for key in ("mcps", "tools"):
        for i, m in enumerate(raw.get(key, [])):
            mid = m.get("id") or m.get("name")
            if not mid:
                errors.append(f"{key}[{i}]: missing 'id'")
            elif mid in mcp_ids:
                errors.append(f"{key}[{i}]: duplicate id '{mid}'")
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
        a.get("memory", {}).get("enabled", False) for a in raw.get("agents", [])
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
    conversations = [
        ConversationConfig.from_dict(c) for c in raw.get("conversations", [])
    ]

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
        sampling=SamplingConfig.from_dict(raw.get("sampling")),
    )


def save_config(config: SKAgentConfig, path: str | None = None) -> None:
    """Save configuration to JSON file."""
    config_path = Path(path or CONFIG_PATH)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config.to_dict(), f, indent=2, ensure_ascii=False)
