#!/usr/bin/env python3
"""
Typed à la carte composition specs for sk-agent (#3407).

Pydantic schemas validating the optional `agent_spec` (call_agent) and
`conversation_spec` (run_conversation) JSON payloads, plus pure resolution
functions implementing the deterministic precedence:

    call-level override  >  spec field  >  extended preset  >  server default

Server policy — specs may only *reference* entities the server already
configured (models, MCPs, presets). They cannot define new endpoints,
credentials, commands, or env vars: those fields simply do not exist in the
schemas, so nothing beyond server policy can be expressed. Reference checks
(model enabled, MCP known, extends known, agent refs resolvable, vision
capability when the call carries an attachment) run at resolution time and
raise SpecError with actionable messages listing the valid values.

Additional policy refusals (PR #1091 review):
- Tool-enabling parameters (``github_tools``) can only NARROW: a spec cannot
  switch on a plugin the extended preset did not grant.
- A vision-requiring attachment (image/video/visual document) refuses a spec
  that resolves to a model without the vision capability.

No secrets: effective-config dicts expose model references, prompts, tool
ids and sampling numbers — never api_key, base_url, or env contents.

The conversation type Literal reuses ``ConversationType`` from
``sk_agent_schemas`` (#1087) — the canonical Pydantic v2 schema set — so the
spec surface and the server config surface stay in lockstep.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from sk_agent_config import (
    AgentConfig,
    ConversationConfig,
    MemoryConfig,
    SKAgentConfig,
)
from sk_agent_schemas import ConversationType

MAX_CONVERSATION_ROUNDS = 50

#: Parameter keys that gate server-side plugins. A spec may only turn these
#: OFF, never ON — enabling a plugin the extended preset did not grant would
#: be a policy elevation (PR #1091 review, concern 3).
SPEC_NARROW_ONLY_PARAMETERS: tuple[str, ...] = ("github_tools",)


class SpecError(Exception):
    """Actionable spec resolution error (unknown reference, policy refusal)."""

    def __init__(self, message: str, details: list[str] | None = None):
        self.details = details or []
        super().__init__(message)


def format_validation_error(exc: ValidationError, spec_name: str) -> dict[str, Any]:
    """Render a pydantic ValidationError as a client-actionable error dict."""
    details = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err["loc"]) or "<root>"
        # Refused-value echo policy (#1091): never repeat the input when it
        # can carry a credential or command. extra_forbidden already names
        # the field via loc; dict/list inputs on type errors dump the whole
        # raw payload (e.g. mcps given as a list of {command: ...} blobs —
        # found by execution: that path is NOT extra_forbidden). Scalars
        # stay echoed — they carry the debug value for honest typos.
        input_val = err.get("input")
        if err["type"] == "extra_forbidden" or isinstance(input_val, (dict, list)):
            details.append(f"{spec_name}.{loc}: {err['msg']}")
        else:
            details.append(f"{spec_name}.{loc}: {err['msg']} (input={input_val!r})")
    return {
        "error": f"{spec_name} validation failed — fix the fields listed in details",
        "spec": spec_name,
        "details": details,
    }


# ---------------------------------------------------------------------------
# MCP delta primitive
# ---------------------------------------------------------------------------


def apply_mcp_delta(base_mcps: list[str], delta: dict | None) -> list[str]:
    """Compute effective MCP ids given a base list and a delta dict.

    Delta format: {"replace": [...]} (full replacement, wins) or
    {"add": [...], "remove": [...]} (ordered: add then remove).
    None/{} -> base unchanged (as a copy).

    Shared by the legacy ``mcp_overrides`` path and the spec path so both
    keep identical semantics (#1091: ``SKAgentManager._resolve_effective_mcp_ids``
    delegates here).
    """
    if not delta:
        return list(base_mcps)

    if "replace" in delta and delta["replace"] is not None:
        replace = delta["replace"]
        seen: list[str] = []
        for mcp_id in replace:
            if mcp_id not in seen:
                seen.append(mcp_id)
        return seen

    result = list(base_mcps)
    for mcp_id in delta.get("add", []):
        if mcp_id not in result:
            result.append(mcp_id)
    for mcp_id in delta.get("remove", []):
        if mcp_id in result:
            result.remove(mcp_id)
    return result


# ---------------------------------------------------------------------------
# Spec schemas
# ---------------------------------------------------------------------------


class McpDeltaSpec(BaseModel):
    """Add/remove/replace MCP tool references (ids must exist server-side)."""

    model_config = ConfigDict(extra="forbid")

    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)
    replace: list[str] | None = None

    def as_delta(self) -> dict:
        if self.replace is not None:
            return {"replace": self.replace}
        delta: dict[str, list[str]] = {}
        if self.add:
            delta["add"] = self.add
        if self.remove:
            delta["remove"] = self.remove
        return delta


class MemorySpec(BaseModel):
    """Memory capability toggle (collection reuse; never creates credentials)."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    collection: str = ""


class SamplingSpec(BaseModel):
    """Bounded per-call inference settings (execution component)."""

    model_config = ConfigDict(extra="forbid")

    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    max_tokens: int | None = Field(default=None, ge=1, le=32_768)

    def overrides(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


class AgentSpec(BaseModel):
    """À la carte agent composition: model + prompt + capabilities + tools + execution.

    Specializes an existing preset via `extends`; every field is optional and
    resolves deterministically (call override > spec > preset > default).
    """

    model_config = ConfigDict(extra="forbid")

    id: str = ""
    extends: str = ""
    model: str = ""
    system_prompt: str | None = None  # None = inherit; "" = explicit override
    description: str = ""
    mcps: McpDeltaSpec | None = None
    memory: MemorySpec | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)
    sampling: SamplingSpec | None = None

    @model_validator(mode="after")
    def _check_replace_exclusive(self) -> AgentSpec:
        if self.mcps is not None and self.mcps.replace is not None:
            if self.mcps.add or self.mcps.remove:
                raise ValueError(
                    "mcps.replace cannot be combined with mcps.add/mcps.remove — "
                    "use either replace or add/remove"
                )
        return self


class InlineAgentSpec(AgentSpec):
    """An agent defined inline in a conversation spec (must carry an id)."""

    id: str = Field(min_length=1)  # required: referenced by the agents list


class ConversationSpec(BaseModel):
    """À la carte conversation composition: agents + coordination + prompts.

    Specializes an existing conversation preset via `extends`.

    Note on ``type``: the Literal is the server's canonical ConversationType
    (#1087). ``handoff`` has no dedicated hand-off strategy in the runner —
    like preset-defined handoff conversations, it executes through the
    group-chat round-robin path (see ConversationRunner.run).
    """

    model_config = ConfigDict(extra="forbid")

    id: str = ""
    extends: str = ""
    description: str = ""
    type: ConversationType | None = None
    agents: list[str] | None = None  # Full replacement of the agent list
    add_agents: list[str] = Field(default_factory=list)
    remove_agents: list[str] = Field(default_factory=list)
    inline_agents: list[InlineAgentSpec] = Field(default_factory=list)
    max_rounds: int | None = Field(
        default=None, ge=1, le=MAX_CONVERSATION_ROUNDS
    )

    @model_validator(mode="after")
    def _check_agents_exclusive(self) -> ConversationSpec:
        if self.agents is not None and (self.add_agents or self.remove_agents):
            raise ValueError(
                "agents cannot be combined with add_agents/remove_agents — "
                "use either the full agents list or the add/remove deltas"
            )
        return self


# ---------------------------------------------------------------------------
# Reference validation helpers
# ---------------------------------------------------------------------------


def _validate_model_ref(config: SKAgentConfig, model_id: str) -> None:
    model = config.get_model(model_id)
    if model is None or not model.enabled:
        enabled = [m.id for m in config.models if m.enabled]
        raise SpecError(
            f"model '{model_id}' not found or disabled",
            details=[f"enabled models: {', '.join(enabled) or '(none)'}"],
        )


def _validate_mcp_refs(config: SKAgentConfig, mcp_ids: list[str]) -> None:
    known = {m.id for m in config.mcps}
    unknown = [m for m in mcp_ids if m not in known]
    if unknown:
        raise SpecError(
            f"unknown mcp id(s): {', '.join(unknown)}",
            details=[f"configured mcps: {', '.join(sorted(known)) or '(none)'}"],
        )


def _validate_vision(config: SKAgentConfig, model_id: str) -> None:
    """A vision-requiring attachment must land on a vision-capable model.

    PR #1091 review concern 4: without this check, extending a text-only
    preset for an image could reach a non-vision service and fail opaquely.
    """
    model = config.get_model(model_id)
    if model is None or not model.vision:
        vision_models = [m.id for m in config.models if m.vision and m.enabled]
        raise SpecError(
            f"agent_spec model '{model_id}' does not support vision, required "
            "by this attachment",
            details=[
                "vision-capable enabled models: "
                + (", ".join(vision_models) or "(none)"),
                "or re-run with options.mode=text for text extraction "
                "(documents only)",
            ],
        )


# ---------------------------------------------------------------------------
# Agent spec resolution (pure)
# ---------------------------------------------------------------------------


def resolve_agent_spec(
    config: SKAgentConfig,
    spec: AgentSpec,
    base_cfg: AgentConfig | None,
    call_model_override: str | None = None,
    call_system_prompt: str | None = None,
    call_mcp_overrides: dict | None = None,
    needs_vision: bool = False,
) -> tuple[AgentConfig, SamplingSpec | None]:
    """Merge spec + base preset + call-level overrides into an AgentConfig.

    Precedence per dimension: call-level param > spec field > base preset >
    server default. Returns (merged AgentConfig, sampling overrides or None).

    Raises SpecError on unknown references (model/mcp), on vision-requirement
    violations (needs_vision=True with a non-vision model), which the caller
    surfaces to the client.
    """
    base = base_cfg or AgentConfig(id="")

    # --- model -------------------------------------------------------------
    model = call_model_override or spec.model or base.model
    if not model:
        default_agent = config.get_default_agent()
        model = default_agent.model if default_agent else ""
    if not model:
        raise SpecError(
            "no model resolved — spec has no model, base preset has no model, "
            "and the server has no default agent",
        )
    _validate_model_ref(config, model)
    if needs_vision:
        _validate_vision(config, model)

    # --- system prompt -----------------------------------------------------
    if call_system_prompt is not None:
        system_prompt = call_system_prompt
    elif spec.system_prompt is not None:
        system_prompt = spec.system_prompt
    else:
        system_prompt = base.system_prompt or config.system_prompt

    # --- mcps (tools): base -> spec delta -> call delta ---------------------
    mcps = list(base.mcps)
    if spec.mcps is not None:
        mcps = apply_mcp_delta(mcps, spec.mcps.as_delta())
    if call_mcp_overrides:
        mcps = apply_mcp_delta(mcps, call_mcp_overrides)
    _validate_mcp_refs(config, mcps)

    # --- memory (capabilities) ----------------------------------------------
    if spec.memory is not None:
        memory = MemoryConfig(
            enabled=spec.memory.enabled, collection=spec.memory.collection
        )
    else:
        memory = MemoryConfig(
            enabled=base.memory.enabled, collection=base.memory.collection
        )

    # --- parameters (merge, spec wins per key) -------------------------------
    # Policy exception: tool-enabling keys can only narrow — a spec must not
    # widen the preset's server-granted tool surface (#1091 review, concern 3).
    parameters = dict(base.parameters)
    parameters.update(spec.parameters)
    for key in SPEC_NARROW_ONLY_PARAMETERS:
        if key in spec.parameters:
            parameters[key] = bool(base.parameters.get(key, False)) and bool(
                spec.parameters[key]
            )

    if spec.id:
        spec_id = spec.id
    elif base.id:
        spec_id = f"{base.id}-spec"
    else:
        spec_id = "spec-agent"

    merged = AgentConfig(
        id=spec_id,
        description=spec.description or base.description,
        model=model,
        system_prompt=system_prompt,
        mcps=mcps,
        memory=memory,
        parameters=parameters,
    )
    return merged, spec.sampling


def effective_agent_config(
    merged: AgentConfig,
    extends: str = "",
    sampling: SamplingSpec | None = None,
    memory_active: bool | None = None,
) -> dict[str, Any]:
    """Render the effective configuration (no secrets) for the result payload."""
    memory_enabled = merged.memory.enabled if memory_active is None else memory_active
    cfg: dict[str, Any] = {
        "agent_id": merged.id,
        "extends": extends or None,
        "model": merged.model,
        "system_prompt": merged.system_prompt,
        "mcps": list(merged.mcps),
        "memory": {"enabled": memory_enabled},
        "parameters": dict(merged.parameters),
    }
    if merged.memory.collection:
        cfg["memory"]["collection"] = merged.memory.collection
    if sampling is not None:
        cfg["sampling"] = sampling.overrides()
    return cfg


# ---------------------------------------------------------------------------
# Conversation spec resolution (pure)
# ---------------------------------------------------------------------------


def resolve_conversation_spec(
    config: SKAgentConfig,
    spec: ConversationSpec,
    base_conv: ConversationConfig | None,
) -> ConversationConfig:
    """Merge conversation spec + base preset into a ConversationConfig.

    Raises SpecError on unresolvable agent references (neither configured
    top-level agents nor spec inline agents).
    """
    base = base_conv or ConversationConfig(id="conversation-spec")

    conv_id = spec.id or (f"{base.id}-spec" if base.id != "conversation-spec" else base.id)

    conv_type = spec.type or base.type

    # --- agents: replace OR base + add - remove -----------------------------
    if spec.agents is not None:
        agents = list(spec.agents)
    else:
        agents = list(base.agents)
        for agent_id in spec.add_agents:
            if agent_id not in agents:
                agents.append(agent_id)
        for agent_id in spec.remove_agents:
            if agent_id in agents:
                agents.remove(agent_id)

    # --- inline agents: base inline + spec inline (spec wins on id) ----------
    inline_by_id: dict[str, AgentConfig] = {a.id: a for a in base.inline_agents}
    for inline_spec in spec.inline_agents:
        inline_cfg, _sampling = resolve_agent_spec(config, inline_spec, None)
        inline_by_id[inline_spec.id] = inline_cfg
    inline_agents = list(inline_by_id.values())

    # --- reference check: every agent id must resolve ------------------------
    config_agent_ids = {a.id for a in config.agents}
    inline_ids = set(inline_by_id)
    unresolved = [
        a for a in agents if a not in config_agent_ids and a not in inline_ids
    ]
    if unresolved:
        raise SpecError(
            f"agent reference(s) not found: {', '.join(unresolved)}",
            details=[
                f"configured agents: {', '.join(sorted(config_agent_ids)) or '(none)'}",
                f"inline agents: {', '.join(sorted(inline_ids)) or '(none)'}",
            ],
        )

    max_rounds = spec.max_rounds or base.max_rounds

    return ConversationConfig(
        id=conv_id,
        description=spec.description or base.description,
        type=conv_type,
        agents=agents,
        max_rounds=max_rounds,
        inline_agents=inline_agents,
    )


def effective_conversation_config(conv: ConversationConfig) -> dict[str, Any]:
    """Render the effective conversation configuration (no prompts, no secrets)."""
    return {
        "conversation_id": conv.id,
        "type": conv.type,
        "agents": list(conv.agents),
        "max_rounds": conv.max_rounds,
        "inline_agents": [
            {
                "id": a.id,
                "model": a.model or "(default)",
                "mcps": list(a.mcps),
                "memory": a.memory.enabled,
            }
            for a in conv.inline_agents
        ],
    }


def parse_agent_spec(raw: dict | str) -> AgentSpec:
    """Parse + validate an agent_spec payload, raising ValidationError."""
    return AgentSpec.model_validate(raw)


def parse_conversation_spec(raw: dict | str) -> ConversationSpec:
    """Parse + validate a conversation_spec payload, raising ValidationError."""
    return ConversationSpec.model_validate(raw)


__all__ = [
    "AgentSpec",
    "ConversationSpec",
    "InlineAgentSpec",
    "McpDeltaSpec",
    "MemorySpec",
    "SamplingSpec",
    "SpecError",
    "SPEC_NARROW_ONLY_PARAMETERS",
    "MAX_CONVERSATION_ROUNDS",
    "apply_mcp_delta",
    "effective_agent_config",
    "effective_conversation_config",
    "format_validation_error",
    "parse_agent_spec",
    "parse_conversation_spec",
    "resolve_agent_spec",
    "resolve_conversation_spec",
]
