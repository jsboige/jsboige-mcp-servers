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
- **Canonical-shape round-trip**: ``SKAgentConfig.model_validate`` ->
  ``.model_dump()`` -> ``model_validate`` preserves the schema shape
  (validated by tests). Legacy shapes are normalised in
  ``_normalize_legacy_fields`` so a v1/v2 config can pass through the
  schema without losing information.

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

#: Placeholder pattern used by ``sk_agent_config.template.json`` to mark
#: "fill this in with your real key at deploy time". When a model carries
#: an ``api_key`` literal matching this pattern, the schema routes the
#: value to a deterministic ``api_key_env`` name (derived from the model
#: ``id``) so the legacy template keeps validating.
_API_KEY_PLACEHOLDER_PATTERN: str = r"^YOUR_[A-Z][A-Z0-9_]+_HERE$"

#: A second, more permissive placeholder set used by legacy test
#: fixtures (``"key"``, ``"test-key"``, ``"example"``, ...). These are
#: not real secrets and do not deserve a hard rejection: the schema
#: folds them into a deterministic ``api_key_env`` instead.
_API_KEY_BENIGN_PATTERN: str = (
    r"^(key|test[-_]?key|example|dummy|placeholder|changeme|no-key)$"
)

#: Real-secret prefixes that the schema **rejects** when found on a
#: model ``api_key`` literal. Anything matching one of these prefixes is
#: treated as a real secret leaked into the config and surfaced via
#: ``extra=forbid`` so the caller sees the leak.
_REAL_SECRET_PREFIXES: tuple[str, ...] = (
    "sk-",       # OpenAI / Anthropic API keys
    "ghp_",      # GitHub personal access token
    "xai-",      # xAI
    "AIza",      # Google
    "pplx-",     # Perplexity
    "anthropic-",
    "huggingface_",
    "sk-ant-",
)

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
def _env_var_name_pattern_check(value: Any) -> str:
    """Reject empty / malformed env-var names. Empty is allowed (= no env)."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(
            f"env-var name must be a string (got {type(value).__name__})"
        )
    if value == "":
        return value
    if not re.fullmatch(ENV_VAR_NAME_PATTERN, value):
        raise ValueError(
            f"env-var name {value!r} must match {ENV_VAR_NAME_PATTERN!r}"
        )
    return value


def _is_env_var_name(value: str) -> bool:
    """True iff ``value`` is a canonical env-var name (``UPPER_SNAKE``).

    Used by ``ToolSpec._validate_env`` to distinguish env-var references
    from configuration literals: callers may mix either, depending on
    whether the value is a secret (env-var name) or a non-secret
    configuration literal (URL, port, ...).
    """
    return bool(re.fullmatch(ENV_VAR_NAME_PATTERN, value))


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
        return _env_var_name_pattern_check(value)

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
    """An MCP tool (shared resource pool).

    The ``env`` mapping accepts two kinds of values, both as plain strings:

    - **env-var reference** (e.g. ``{"API_KEY": "GLM_API_KEY"}``): the value
      matches ``ENV_VAR_NAME_PATTERN`` (uppercase, underscore, leading
      letter). The runtime resolves the literal by reading the named
      environment variable.
    - **non-secret configuration literal** (e.g. ``{"SEARXNG_URL":
      "https://search.myia.io"}``): the value is used verbatim. Use this
      for URLs, ports, log-level strings, and other non-secret config.

    Mixing the two within one mapping is allowed. The schema rejects only
    *typed* values (numbers, bools, ...); raw strings are accepted
    regardless of shape. Callers that need to assert "this value is an
    env-var reference" should validate via ``_is_env_var_name`` at the
    call site.
    """

    id: RefId
    description: str = Field(default="", max_length=2048)
    command: str = Field(default="", max_length=512)
    args: list[str] = Field(default_factory=list, max_length=64)
    env: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Tool environment variables. Values may be either env-var "
            "names (uppercase, see ENV_VAR_NAME_PATTERN) or non-secret "
            "configuration literals (URLs, ports, log levels, ...). "
            "Plain strings only."
        ),
    )

    @field_validator("env", mode="before")
    @classmethod
    def _validate_env(cls, value: Any) -> Any:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("env must be a dict[str, str]")
        for key, val in value.items():
            if not isinstance(key, str):
                raise ValueError(
                    f"env keys must be strings (got {type(key).__name__})"
                )
            if not isinstance(val, str):
                raise ValueError(
                    f"env[{key!r}] must be a string (got {type(val).__name__}); "
                    "use api_key_env or a literal env-var name for secrets"
                )
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
        ``migrate_config_v1_to_v2`` or the canonical
        ``sk_agent_config.template.json`` without the schema rejecting
        them as extras.

        The translations are:

          - ``mcps`` (legacy) → ``tools`` (schema)
          - ``models[i].api_key`` is **never silently dropped**: if it
            matches the placeholder pattern (``YOUR_X_HERE``), the schema
            routes the value to a deterministic ``api_key_env`` derived
            from the model ``id``; any other literal is rejected
            (``extra=forbid`` makes the rejection visible to callers —
            acceptance #3406: schemas never store a literal secret).
          - ``models[i].vision`` / ``models[i].thinking`` fold into
            ``capabilities.{vision,thinking}``.
          - ``tools[i].name`` (legacy) → ``tools[i].id`` (schema).
          - ``agents[i].memory`` (legacy dataclass shape) folds into
            ``execution.memory_collection`` when memory is enabled.
          - Top-level ``embeddings`` / ``qdrant`` / ``sampling`` blocks
            are dropped — they live outside the schema today; the facade
            handles them. ``_comment`` keys are dropped too.

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

        # Top-level blocks the schema does not own today. We drop them
        # after a sanity check (must be dict-shaped) so the schema
        # does not raise ``extra=forbid`` on the canonical template.
        for top_level_key in ("embeddings", "qdrant", "sampling"):
            if top_level_key in data:
                block = data.pop(top_level_key)
                if not isinstance(block, dict):
                    raise ValueError(
                        f"{top_level_key!r} must be a dict (got {type(block).__name__})"
                    )

        # Drop ``_comment`` markers anywhere in the tree.
        def _drop_comments(node: Any) -> Any:
            if isinstance(node, dict):
                node.pop("_comment", None)
                for v in node.values():
                    _drop_comments(v)
            elif isinstance(node, list):
                for v in node:
                    _drop_comments(v)
            return node

        _drop_comments(data)

        # models: fold ``vision`` and ``thinking`` into ``capabilities``,
        # and route placeholder ``api_key`` to ``api_key_env``.
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

            # Placeholder ``api_key`` ("YOUR_X_HERE") -> derived
            # ``api_key_env``. The schema also folds a small set of
            # benign placeholder literals (``"key"``, ``"test-key"``,
            # ``"example"``, ...) so legacy test fixtures keep working
            # without leaking real secrets. Anything that looks like a
            # **real** secret (known vendor prefix) is left in place so
            # ``extra=forbid`` surfaces a readable leak warning.
            if "api_key" in model:
                api_key_value = model["api_key"]
                if not isinstance(api_key_value, str):
                    # ``extra=forbid`` will surface a "must be a string"
                    # error; we keep the value as-is so the location is
                    # informative.
                    pass
                elif re.fullmatch(_API_KEY_PLACEHOLDER_PATTERN, api_key_value):
                    model_id = model.get("id", "model")
                    if "api_key_env" not in model:
                        derived = re.sub(
                            r"[^A-Z0-9]+", "_", str(model_id).upper()
                        ).strip("_")
                        if derived:
                            model["api_key_env"] = f"{derived}_API_KEY"
                    model.pop("api_key")
                elif re.fullmatch(
                    _API_KEY_BENIGN_PATTERN, api_key_value, flags=re.IGNORECASE
                ):
                    # Benign placeholder used by test fixtures. Map it to
                    # an explicit ``<MODEL>_TEST_KEY`` env-var name so the
                    # schema no longer carries a literal.
                    model_id = model.get("id", "model")
                    if "api_key_env" not in model:
                        derived = re.sub(
                            r"[^A-Z0-9]+", "_", str(model_id).upper()
                        ).strip("_")
                        if derived:
                            model["api_key_env"] = f"{derived}_TEST_KEY"
                    model.pop("api_key")
                elif any(
                    api_key_value.startswith(prefix)
                    for prefix in _REAL_SECRET_PREFIXES
                ):
                    # Real-looking secret leaked into the config: leave
                    # it in place so ``extra=forbid`` raises a readable
                    # error naming the offending field. This is the
                    # path that makes acceptance #3406 (no secret
                    # literal in models) **visible** to callers.
                    pass
                # else: a string that does not match either placeholder
                # set and does not look like a real secret. Conservatively
                # leave it in place so ``extra=forbid`` surfaces it;
                # tightening this requires explicit user sign-off because
                # we cannot tell apart "real key we don't recognise" from
                # "fixture we don't recognise".

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
    def _validate_unique_ids(self) -> "SKAgentConfig":
        """Reject duplicate ids in models/tools/agents/conversations.

        Duplicates silently shadow the first occurrence at runtime and
        produce flaky behaviour; surfacing them at validation time
        removes the ambiguity. This check is intentionally separate from
        ``_validate_references`` so that the message names the offending
        registry and the duplicate values explicitly.
        """
        for registry_name, items in (
            ("models", self.models),
            ("tools", self.tools),
            ("agents", self.agents),
            ("conversations", self.conversations),
        ):
            seen: set[str] = set()
            duplicates: list[str] = []
            for item in items:
                if item.id in seen:
                    duplicates.append(item.id)
                seen.add(item.id)
            if duplicates:
                raise ValueError(
                    f"{registry_name} registry contains duplicate ids: "
                    f"{sorted(set(duplicates))}"
                )
        return self

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
            # A conversation's ``agents`` list may reference names that
            # are either defined at the top level (``agents``) or inline
            # in ``inline_agents`` — both are valid resolutions.
            inline_ids = {a.id for a in conv.inline_agents}
            valid_ids = agent_ids | inline_ids
            unknown = [a for a in conv.agents if a not in valid_ids]
            if unknown:
                raise ValueError(
                    f"conversation {conv.id!r} references unknown agents {unknown}; "
                    f"known agents: {sorted(agent_ids)}, "
                    f"inline agents: {sorted(inline_ids)}"
                )

            # Inline agents shadowing top-level agents with the same id
            # are tolerated: the inline definition wins. We log nothing
            # here — the caller decides via ``get_agent`` resolution.

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

            # Inline agents inside one conversation must have unique ids.
            seen_inline: set[str] = set()
            dup_inline: list[str] = []
            for inline in conv.inline_agents:
                if inline.id in seen_inline:
                    dup_inline.append(inline.id)
                seen_inline.add(inline.id)
            if dup_inline:
                raise ValueError(
                    f"conversation {conv.id!r} has duplicate inline agent ids: "
                    f"{sorted(set(dup_inline))}"
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

    def get_agent(self, agent_id: str) -> "AgentPreset | None":
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
    "_is_env_var_name",
    "_env_var_name_pattern_check",
    "_format_errors",
]
