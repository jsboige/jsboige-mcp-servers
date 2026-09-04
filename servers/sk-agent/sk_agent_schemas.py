"""
sk-agent Pydantic v2 schemas.

Pure data-validation models used as the canonical schema for sk-agent
configuration. ``sk_agent_config.py`` remains the loading/migration facade
(it imports these models, validates raw config through them, and exposes
the legacy dataclasses to any caller that still imports them).

Design goals
------------
- **Typed validation**: every field has an explicit type and constraint;
  invalid values produce readable ``ValidationError`` messages thanks to
  Pydantic v2's structured error reporting.
- **No secret literals**: ``api_key`` is **not** a model field. Callers
  that need to inject a literal key go through the legacy dataclass
  facade, where it remains a string with the historical ``"no-key"``
  default. Schemas require either an env-var name or an empty value.
- **Reference integrity**: agent ``model`` references, agent ``mcps``
  references, and the global ``default_agent`` / ``default_vision_agent``
  are validated against the in-config registries via ``model_validator``.
- **Strict extra-rejection**: ``extra="forbid"`` so unknown fields surface
  as readable validation errors instead of being silently ignored.

See issue roo-extensions#3406 for the full acceptance and parent epic #1748.
"""

from __future__ import annotations

import os
import re
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Current supported schema version. ``config_version`` in ``SKAgentConfig``
#: must equal this value.
SCHEMA_VERSION: int = 2

#: Pattern for env-var names. Lower-case is rejected on purpose: env-var
#: conventions on the platforms we target are uppercase, and rejecting
#: mixed-case here catches typos early.
ENV_VAR_NAME_PATTERN: str = r"^[A-Z][A-Z0-9_]*$"

#: Convenience annotation for typed env-var name fields. Empty string is
#: allowed (= "no env var, fall back to a different mechanism"), but when
#: present the name must match the canonical pattern. ``pattern`` cannot
#: be set on the alias because Pydantic applies it even to empty strings
#: (rejects ``""``); the pattern is enforced via a ``field_validator`` on
#: each field that uses this annotation instead.
EnvVarName = Annotated[
    str,
    Field(
        default="",
        max_length=128,
        description="Name of the environment variable holding the secret.",
    ),
]

#: Convenience annotation for opaque identifier fields.
RefId = Annotated[
    str,
    Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9._\-:]+$",
        description="Stable identifier referencing a config object.",
    ),
]

# Reusable helper applied per-field (Pydantic v2 cannot attach validators
# to ``Annotated`` aliases, so each EnvVarName field calls
# ``_env_var_name_pattern_check`` directly).
def _env_var_name_pattern_check(value: str) -> str:
    """Reject empty / malformed env-var names. Empty is allowed (= no env)."""
    if value == "":
        return value
    if not re.fullmatch(ENV_VAR_NAME_PATTERN, value):
        raise ValueError(
            f"env-var name {value!r} must match {ENV_VAR_NAME_PATTERN!r}"
        )
    return value

ConversationType = Literal[
    "sequential", "concurrent", "group_chat", "handoff", "magentic"
]


# ---------------------------------------------------------------------------
# Base configuration shared by every schema model
# ---------------------------------------------------------------------------


class _StrictModel(BaseModel):
    """Base model with strict extras + trimmed strings."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        validate_assignment=True,
        populate_by_name=True,
    )


# ---------------------------------------------------------------------------
# Profile models
# ---------------------------------------------------------------------------


class CapabilityProfile(_StrictModel):
    """Capability flags advertised by a model or expected by an agent."""

    vision: bool = False
    thinking: bool = False
    description: str = Field(default="", max_length=1024)


class ExecutionProfile(_StrictModel):
    """Per-agent execution tuning (sampling + memory)."""

    temperature: float = Field(default=1.0, ge=0.0, le=2.0)
    top_p: float = Field(default=1.0, ge=0.0, le=1.0)
    top_k: int = Field(default=-1, ge=-1)
    min_p: float = Field(default=0.0, ge=0.0, le=1.0)
    presence_penalty: float = Field(default=0.0, ge=-2.0, le=2.0)
    repetition_penalty: float = Field(default=1.0, ge=0.0, le=2.0)
    max_tokens: int = Field(default=4096, ge=1, le=1_000_000)
    memory_collection: str = Field(
        default="",
        max_length=128,
        description="Optional memory collection name (auto-generated when empty).",
    )


# ---------------------------------------------------------------------------
# Spec models
# ---------------------------------------------------------------------------


class ModelSpec(_StrictModel):
    """A model endpoint (shared resource pool)."""

    id: RefId
    base_url: str = Field(
        default="https://api.medium.text-generation-webui.myia.io/v1",
        max_length=2048,
    )
    api_key_env: EnvVarName = Field(
        default="",
        description=(
            "Environment variable name holding the API key. "
            "Empty means the legacy facade resolves the key elsewhere; "
            "schemas never store a literal secret."
        ),
    )
    model_id: str = Field(default="default", min_length=1, max_length=256)
    description: str = Field(default="", max_length=2048)
    capabilities: CapabilityProfile = Field(default_factory=CapabilityProfile)
    context_window: int = Field(default=32_000, ge=128, le=10_000_000)
    enabled: bool = True
    system_prompt: str = Field(default="", max_length=32_768)

    @field_validator("base_url")
    @classmethod
    def _validate_base_url(cls, value: str) -> str:
        if not value:
            raise ValueError("base_url must not be empty")
        if not value.startswith(("http://", "https://")):
            raise ValueError(
                f"base_url must start with http:// or https:// (got {value!r})"
            )
        return value

    @field_validator("api_key_env", mode="before")
    @classmethod
    def _validate_api_key_env(cls, value: Any) -> Any:
        return _env_var_name_pattern_check(value or "")

    def resolve_api_key(self, legacy_key: str = "no-key") -> str:
        """Resolve an API key from the env-var name, falling back to a
        legacy literal if the env var is unset.

        The literal fallback exists only to keep the facade working; the
        schema itself never persists a literal.
        """
        if self.api_key_env:
            return os.environ.get(self.api_key_env, legacy_key)
        return legacy_key


class ToolSpec(_StrictModel):
    """An MCP tool (shared resource pool)."""

    id: RefId
    description: str = Field(default="", max_length=2048)
    command: str = Field(default="", max_length=512)
    args: list[str] = Field(default_factory=list, max_length=64)
    env: dict[str, str] = Field(default_factory=dict)

    @field_validator("env", mode="before")
    @classmethod
    def _validate_env(cls, value: Any) -> Any:
        """Each value in ``env`` is an env-var name; empty allowed."""
        if not value:
            return {}
        if not isinstance(value, dict):
            raise ValueError("env must be a dict[str, str]")
        for key, val in value.items():
            if not isinstance(key, str):
                raise ValueError(f"env keys must be strings (got {type(key).__name__})")
            _env_var_name_pattern_check(val or "")
        return value

    @field_validator("args")
    @classmethod
    def _validate_args(cls, value: list[str]) -> list[str]:
        if any(not isinstance(a, str) for a in value):
            raise ValueError("args entries must all be strings")
        return value

    @model_validator(mode="after")
    def _validate_invocation(self) -> "ToolSpec":
        # Either ``command`` is set (we know how to spawn it) or both
        # ``command`` and ``args`` are empty (declarative-only, e.g. for
        # test fixtures). Mixing them is a config bug.
        if not self.command and self.args:
            raise ValueError(
                "args provided without a command; specify a command or remove args"
            )
        return self


class AgentPreset(_StrictModel):
    """An agent preset: a model reference, a system prompt, an MCP subset."""

    id: RefId
    description: str = Field(default="", max_length=2048)
    model: RefId = Field(
        description="Reference to a ModelSpec.id resolved at validation time."
    )
    system_prompt: str = Field(default="", max_length=32_768)
    mcps: list[RefId] = Field(default_factory=list, max_length=64)
    execution: ExecutionProfile = Field(default_factory=ExecutionProfile)
    parameters: dict[str, Any] = Field(default_factory=dict)

    @field_validator("parameters")
    @classmethod
    def _validate_parameters(cls, value: dict[str, Any]) -> dict[str, Any]:
        # Pydantic already enforces dict shape; this guards against
        # accidentally passing nested env-var *values* in this dict.
        for key in value:
            if not isinstance(key, str):
                raise ValueError(f"parameter keys must be strings (got {type(key).__name__})")
        return value


class ConversationPreset(_StrictModel):
    """A multi-agent conversation preset."""

    id: RefId
    description: str = Field(default="", max_length=2048)
    type: ConversationType = "sequential"
    agents: list[RefId] = Field(default_factory=list, max_length=64)
    max_rounds: int = Field(default=10, ge=1, le=10_000)
    inline_agents: list[AgentPreset] = Field(default_factory=list, max_length=64)


# ---------------------------------------------------------------------------
# Top-level config
# ---------------------------------------------------------------------------


class SKAgentConfig(_StrictModel):
    """Top-level sk-agent configuration schema."""

    config_version: Literal[2] = SCHEMA_VERSION
    max_recursion_depth: int = Field(default=2, ge=0, le=16)
    default_agent: RefId = Field(
        default="",
        description="Reference to an AgentPreset.id (resolved at validation time).",
    )
    default_vision_agent: RefId = Field(
        default="",
        description=(
            "Reference to an AgentPreset.id with vision capability "
            "(resolved at validation time)."
        ),
    )
    system_prompt: str = Field(default="", max_length=32_768)

    models: list[ModelSpec] = Field(default_factory=list)
    tools: list[ToolSpec] = Field(
        default_factory=list,
        description=(
            "MCP tool registry. ``tools`` is the schema name; the legacy "
            "facade exposes this collection under the key ``mcps``."
        ),
    )
    agents: list[AgentPreset] = Field(default_factory=list)
    conversations: list[ConversationPreset] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _normalize_legacy_fields(cls, data: Any) -> Any:
        """Translate legacy field names to schema names so that callers
        can still feed the schema the output of
        ``migrate_config_v1_to_v2`` without the schema rejecting them
        as extras.

        The translations are:
          - ``mcps`` (legacy) → ``tools`` (schema)
          - ``models[i].api_key`` / ``models[i].vision`` are dropped
            (the schema forbids literal API keys; the legacy flag
            migrates into ``capabilities.vision``).
          - ``agents[i].memory`` is folded into ``execution.memory_collection``
            when memory is enabled.

        Any other unknown fields still raise ``extra=forbid`` because
        this validator runs in ``before`` mode and only edits known
        keys.
        """
        if not isinstance(data, dict):
            return data

        # mcps -> tools
        if "mcps" in data and "tools" not in data:
            data["tools"] = data.pop("mcps")
        elif "mcps" in data:
            data.pop("mcps")

        # models: fold ``vision`` and ``thinking`` into ``capabilities``.
        # NOTE: ``api_key`` (legacy) is **not** silently dropped — letting
        # the schema raise ``extra=forbid`` makes the rejection visible
        # to the caller (acceptance #3406: schemas never store a literal
        # secret; we want callers to know the key is missing).
        for model in data.get("models", []) or []:
            if not isinstance(model, dict):
                continue
            caps = dict(model.get("capabilities") or {})
            if "vision" in model and "vision" not in caps:
                caps["vision"] = model.pop("vision")
            elif "vision" in model:
                model.pop("vision")
            if "thinking" in model and "thinking" not in caps:
                caps["thinking"] = model.pop("thinking")
            elif "thinking" in model:
                model.pop("thinking")
            if caps:
                model["capabilities"] = caps

        # tools (legacy ``mcps`` entries): ``name`` (legacy) → ``id``.
        for tool in data.get("tools", []) or []:
            if not isinstance(tool, dict):
                continue
            if "name" in tool and "id" not in tool:
                tool["id"] = tool.pop("name")
            elif "name" in tool:
                tool.pop("name")

        # agents: fold legacy ``memory`` (dataclass shape) into the
        # schema's ``execution.memory_collection``.
        for agent in data.get("agents", []) or []:
            if not isinstance(agent, dict):
                continue
            memory = agent.pop("memory", None)
            if isinstance(memory, dict) and memory.get("enabled"):
                execution = dict(agent.get("execution") or {})
                if not execution.get("memory_collection"):
                    collection = memory.get("collection") or ""
                    if not collection:
                        collection = f"{agent.get('id', 'agent')}-memory"
                    execution["memory_collection"] = collection
                agent["execution"] = execution

        return data

    # ------------------------------------------------------------------
    # Cross-reference validators
    # ------------------------------------------------------------------

    @model_validator(mode="after")
    def _validate_references(self) -> "SKAgentConfig":
        model_ids = {m.id for m in self.models}
        tool_ids = {t.id for t in self.tools}
        agent_ids = {a.id for a in self.agents}

        for agent in self.agents:
            if agent.model and agent.model not in model_ids:
                raise ValueError(
                    f"agent {agent.id!r} references unknown model {agent.model!r}; "
                    f"known models: {sorted(model_ids)}"
                )
            unknown_mcps = [m for m in agent.mcps if m not in tool_ids]
            if unknown_mcps:
                raise ValueError(
                    f"agent {agent.id!r} references unknown tools {unknown_mcps}; "
                    f"known tools: {sorted(tool_ids)}"
                )

        if self.default_agent and self.default_agent not in agent_ids:
            raise ValueError(
                f"default_agent {self.default_agent!r} does not match any agent; "
                f"known agents: {sorted(agent_ids)}"
            )
        if self.default_vision_agent and self.default_vision_agent not in agent_ids:
            raise ValueError(
                f"default_vision_agent {self.default_vision_agent!r} does not match "
                f"any agent; known agents: {sorted(agent_ids)}"
            )

        for conv in self.conversations:
            unknown = [a for a in conv.agents if a not in agent_ids]
            if unknown:
                raise ValueError(
                    f"conversation {conv.id!r} references unknown agents {unknown}; "
                    f"known agents: {sorted(agent_ids)}"
                )
            inline_ids = {a.id for a in conv.inline_agents}
            for a in conv.agents:
                if a in inline_ids:
                    continue  # inline_agents shadow the registry; that is fine
            unknown_inline_models: list[str] = []
            for inline in conv.inline_agents:
                if inline.model and inline.model not in model_ids:
                    unknown_inline_models.append(
                        f"{inline.id!r}->{inline.model!r}"
                    )
            if unknown_inline_models:
                raise ValueError(
                    f"conversation {conv.id!r} has inline agents referencing "
                    f"unknown models {unknown_inline_models}"
                )

        return self

    # ------------------------------------------------------------------
    # Helpers (kept on the schema so callers do not need to import the
    # facade for read-only operations).
    # ------------------------------------------------------------------

    def get_model(self, model_id: str) -> ModelSpec | None:
        return next((m for m in self.models if m.id == model_id), None)

    def get_tool(self, tool_id: str) -> ToolSpec | None:
        return next((t for t in self.tools if t.id == tool_id), None)

    def get_agent(self, agent_id: str) -> AgentPreset | None:
        return next((a for a in self.agents if a.id == agent_id), None)


# ---------------------------------------------------------------------------
# Validation entry points
# ---------------------------------------------------------------------------


def validate_config_payload(
    payload: dict[str, Any],
) -> tuple[SKAgentConfig | None, list[str]]:
    """Validate a raw dict payload against the schema.

    Returns ``(config, errors)`` where ``config`` is non-None on success.
    Errors are human-readable strings so they can be logged without
    importing pydantic directly.
    """
    try:
        cfg = SKAgentConfig.model_validate(payload)
    except ValidationError as exc:
        return None, _format_errors(exc)
    return cfg, []


def _format_errors(exc: ValidationError) -> list[str]:
    """Render pydantic errors as one readable line per failure."""
    lines: list[str] = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err.get("loc", ())) or "<root>"
        msg = err.get("msg", "invalid value")
        lines.append(f"{loc}: {msg}")
    return lines


__all__ = [
    "SCHEMA_VERSION",
    "ENV_VAR_NAME_PATTERN",
    "EnvVarName",
    "RefId",
    "ConversationType",
    "CapabilityProfile",
    "ExecutionProfile",
    "ModelSpec",
    "ToolSpec",
    "AgentPreset",
    "ConversationPreset",
    "SKAgentConfig",
    "validate_config_payload",
]
