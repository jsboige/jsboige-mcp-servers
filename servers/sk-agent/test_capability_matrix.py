"""Unit tests for the capability matrix (issue #3408).

These tests cover the five acceptance criteria of roo-extensions#3408:

1. The agents -> capabilities -> tools matrix is derived from the config
   (``CAPABILITY_CATALOG`` / ``RISK_CLASS_REQUIRED_CAPABILITIES``).
2. Negative tests: tools of class ``exec`` / ``browser`` / ``stateful``
   are invisible / refused for agents that do not declare the matching
   capability. The check fires both on the static config and on a
   per-call ``mcp_overrides`` payload.
3. A client override cannot widen rights:
   ``resolve_effective_mcp_ids`` raises ``ValueError`` when the
   effective MCP list would require capabilities the agent does not
   advertise.
4. Smoke matrices for the six documented profiles (light, search,
   vision, review, code/exec, coordination-heavy).
5. The configuration retains agents without tools (and without
   capabilities) when coherent — i.e. an empty capability list is the
   legitimate "light" default, not an error.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from sk_agent_schemas import (
    CAPABILITY_CATALOG,
    RISK_CLASS_REQUIRED_CAPABILITIES,
    SKAgentConfig,
    ToolRiskClass,
    resolve_effective_mcp_ids,
    validate_effective_capabilities,
)


# ---------------------------------------------------------------------------
# Fixtures: minimal valid payloads (issue #3408 acceptance #1)
# ---------------------------------------------------------------------------


def _tool_payload(
    tool_id: str,
    *,
    risk_class: str = "read",
    allowed_capabilities: list[str] | None = None,
) -> dict:
    return {
        "id": tool_id,
        "command": "noop",
        "risk_class": risk_class,
        "allowed_capabilities": allowed_capabilities or [],
    }


def _agent_payload(
    agent_id: str,
    model_id: str = "m-fast",
    *,
    mcps: list[str] | None = None,
    capabilities: list[str] | None = None,
) -> dict:
    payload: dict = {
        "id": agent_id,
        "model": model_id,
        "mcps": list(mcps or []),
    }
    if capabilities is not None:
        payload["capabilities"] = list(capabilities)
    return payload


def _model_payload(model_id: str = "m-fast") -> dict:
    return {"id": model_id, "context_window": 4096}


@pytest.fixture
def read_only_tool() -> dict:
    """No-capability read tool (e.g. cached file reader)."""
    return _tool_payload("cached_reader", risk_class="read")


@pytest.fixture
def web_search_tool() -> dict:
    return _tool_payload(
        "web_search", risk_class="read", allowed_capabilities=["web"]
    )


@pytest.fixture
def browser_tool() -> dict:
    return _tool_payload(
        "headless_browser",
        risk_class="browser",
        allowed_capabilities=["browser", "web"],
    )


@pytest.fixture
def exec_tool() -> dict:
    return _tool_payload(
        "shell_exec", risk_class="exec", allowed_capabilities=["shell"]
    )


@pytest.fixture
def repl_tool() -> dict:
    return _tool_payload(
        "jupyter_repl", risk_class="exec", allowed_capabilities=["repl"]
    )


@pytest.fixture
def stateful_tool() -> dict:
    return _tool_payload(
        "vector_memory",
        risk_class="stateful",
        allowed_capabilities=["memory", "recursive_agents"],
    )


# ---------------------------------------------------------------------------
# Acceptance #1 — catalog + matrix derivable from the config
# ---------------------------------------------------------------------------


class TestCatalogSurface:
    """The catalog is exposed and constant."""

    def test_catalog_is_closed_set(self):
        # Adding a capability is a code change, not a config value
        # (issue #3408 scope §1). The catalog is the canonical surface.
        assert "web" in CAPABILITY_CATALOG
        assert "shell" in CAPABILITY_CATALOG
        assert "repl" in CAPABILITY_CATALOG
        # Unknown literals must be rejected by the Pydantic Literal alias.
        with pytest.raises(ValidationError):
            SKAgentConfig.model_validate(
                {
                    "models": [_model_payload()],
                    "tools": [
                        _tool_payload(
                            "rogue",
                            allowed_capabilities=["shell", "rogue-cap"],
                        )
                    ],
                    "agents": [_agent_payload("a", mcps=["rogue"], capabilities=["shell", "rogue-cap"])],
                }
            )

    def test_risk_class_required_capabilities_is_total(self):
        # Every risk class maps to a (possibly empty) capability set so
        # the matrix validator has a single source of truth.
        for cls in ("read", "browser", "stateful", "exec"):
            assert cls in RISK_CLASS_REQUIRED_CAPABILITIES
            assert isinstance(
                RISK_CLASS_REQUIRED_CAPABILITIES[cls], frozenset
            )

    def test_risk_class_alias_typed(self):
        # ToolRiskClass is a closed Literal — invalid values surface as
        # readable ValidationErrors, not silent downgrades.
        assert ToolRiskClass.__args__ == ("read", "browser", "stateful", "exec")


# ---------------------------------------------------------------------------
# Acceptance #2 — negative tests: exec invisible outside profile
# ---------------------------------------------------------------------------


class TestNegativeExecInvisible:
    """An agent without ``shell`` cannot list an ``exec`` tool in ``mcps``."""

    def test_exec_tool_rejected_without_shell(self, exec_tool):
        with pytest.raises(ValidationError) as exc_info:
            SKAgentConfig.model_validate(
                {
                    "models": [_model_payload()],
                    "tools": [exec_tool],
                    "agents": [
                        _agent_payload(
                            "vision-only",
                            mcps=["shell_exec"],
                            capabilities=["vision"],
                        )
                    ],
                }
            )
        msg = str(exc_info.value)
        assert "shell_exec" in msg
        assert "shell" in msg  # the missing capability

    def test_exec_tool_accepted_with_shell(self, exec_tool):
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "tools": [exec_tool],
                "agents": [
                    _agent_payload(
                        "coder",
                        mcps=["shell_exec"],
                        capabilities=["shell"],
                    )
                ],
            }
        )
        assert cfg.agents[0].id == "coder"

    def test_repl_satisfies_exec(self, repl_tool):
        # ``exec`` is satisfied by ``shell`` OR ``repl`` per the catalog.
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "tools": [repl_tool],
                "agents": [
                    _agent_payload(
                        "data-scientist",
                        mcps=["jupyter_repl"],
                        capabilities=["repl"],
                    )
                ],
            }
        )
        assert cfg.agents[0].id == "data-scientist"


class TestNegativeBrowserInvisible:
    def test_browser_tool_rejected_without_browser(self, browser_tool):
        with pytest.raises(ValidationError) as exc_info:
            SKAgentConfig.model_validate(
                {
                    "models": [_model_payload()],
                    "tools": [browser_tool],
                    "agents": [
                        _agent_payload(
                            "text-only",
                            mcps=["headless_browser"],
                            capabilities=["web"],
                        )
                    ],
                }
            )
        assert "browser" in str(exc_info.value)


class TestNegativeCapabilityMissing:
    """The capabilities the tool *requires* must be in the agent set."""

    def test_web_search_requires_web_capability(self, web_search_tool):
        with pytest.raises(ValidationError) as exc_info:
            SKAgentConfig.model_validate(
                {
                    "models": [_model_payload()],
                    "tools": [web_search_tool],
                    "agents": [
                        _agent_payload(
                            "no-web",
                            mcps=["web_search"],
                            capabilities=["vision"],
                        )
                    ],
                }
            )
        assert "web" in str(exc_info.value)


class TestMultipleCapabilityRequirement:
    """A tool listing multiple capabilities requires all of them."""

    def test_all_capabilities_required(self, browser_tool):
        # browser_tool declares ``["browser", "web"]``; granting only
        # ``web`` leaves ``browser`` ungranted.
        with pytest.raises(ValidationError):
            SKAgentConfig.model_validate(
                {
                    "models": [_model_payload()],
                    "tools": [browser_tool],
                    "agents": [
                        _agent_payload(
                            "partial",
                            mcps=["headless_browser"],
                            capabilities=["web"],
                        )
                    ],
                }
            )


# ---------------------------------------------------------------------------
# Acceptance #3 — override cannot widen rights
# ---------------------------------------------------------------------------


class TestOverrideCannotElaborate:
    """``mcp_overrides`` cannot grant capabilities the agent lacks."""

    def test_replace_exec_blocked(self, exec_tool):
        # Agent has no ``shell`` capability; client tries to install
        # ``shell_exec`` via ``replace``. Must be refused.
        with pytest.raises(ValueError) as exc_info:
            resolve_effective_mcp_ids(
                base_mcps=["web_search"],
                mcp_overrides={"replace": ["shell_exec"]},
                agent_capabilities=["web"],
                tools=[exec_tool, _tool_payload("web_search", risk_class="read", allowed_capabilities=["web"])],
            )
        assert "shell" in str(exc_info.value)

    def test_replace_exec_allowed_when_shell_present(self, exec_tool):
        result = resolve_effective_mcp_ids(
            base_mcps=[],
            mcp_overrides={"replace": ["shell_exec"]},
            agent_capabilities=["shell"],
            tools=[exec_tool],
        )
        assert result == ["shell_exec"]

    def test_add_exec_blocked(self, exec_tool):
        # Adding an exec tool to a non-shell agent must be refused.
        with pytest.raises(ValueError):
            resolve_effective_mcp_ids(
                base_mcps=["web_search"],
                mcp_overrides={"add": ["shell_exec"]},
                agent_capabilities=["web"],
                tools=[exec_tool, _tool_payload("web_search", risk_class="read", allowed_capabilities=["web"])],
            )

    def test_legacy_mode_no_capability_check(self, exec_tool):
        # Without capability context (legacy callers / test_mcp_overrides
        # parity), the helper falls back to plain resolution.
        result = resolve_effective_mcp_ids(
            base_mcps=["web_search"],
            mcp_overrides={"replace": ["shell_exec"]},
        )
        assert result == ["shell_exec"]

    def test_override_cannot_remove_only_capability_grant(
        self, exec_tool, web_search_tool
    ):
        # Override cannot strand the agent without its only capability.
        # Base mcps requires ``web``; override removes web_search and
        # adds shell_exec (no shell granted) -> refused on the add.
        with pytest.raises(ValueError):
            resolve_effective_mcp_ids(
                base_mcps=["web_search"],
                mcp_overrides={"add": ["shell_exec"], "remove": ["web_search"]},
                agent_capabilities=["web"],
                tools=[exec_tool, web_search_tool],
            )

    def test_override_browser_blocked(self, browser_tool):
        with pytest.raises(ValueError):
            resolve_effective_mcp_ids(
                base_mcps=[],
                mcp_overrides={"add": ["headless_browser"]},
                agent_capabilities=["web"],
                tools=[browser_tool],
            )


# ---------------------------------------------------------------------------
# Acceptance #4 — smoke matrices for the six documented profiles
# ---------------------------------------------------------------------------


class TestSmokeProfiles:
    """Six profile smokes (light, search, vision, review, code/exec,
    coordination-heavy). Each profile is a self-contained config
    payload that the schema accepts and the matrix derives.
    """

    def test_profile_light(self, read_only_tool):
        """Light agent: zero tools, zero capabilities."""
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "tools": [read_only_tool],
                "agents": [_agent_payload("light", mcps=[], capabilities=[])],
            }
        )
        assert cfg.agents[0].capabilities == []

    def test_profile_search(self, web_search_tool):
        """Search agent: web capability + web_search tool."""
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "tools": [web_search_tool],
                "agents": [
                    _agent_payload(
                        "searcher", mcps=["web_search"], capabilities=["web"]
                    )
                ],
            }
        )
        assert cfg.agents[0].capabilities == ["web"]

    def test_profile_vision(self, browser_tool, web_search_tool):
        """Vision agent: web + browser (no exec)."""
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "tools": [web_search_tool, browser_tool],
                "agents": [
                    _agent_payload(
                        "vision",
                        mcps=["web_search", "headless_browser"],
                        capabilities=["web", "browser"],
                    )
                ],
            }
        )
        assert cfg.agents[0].id == "vision"

    def test_profile_review(self, web_search_tool):
        """Review agent: web only (no shell). Cannot escalate via override."""
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "tools": [web_search_tool, _tool_payload("shell_exec", risk_class="exec", allowed_capabilities=["shell"])],
                "agents": [
                    _agent_payload(
                        "reviewer", mcps=["web_search"], capabilities=["web"]
                    )
                ],
            }
        )
        # A reviewer trying to ``replace`` shell_exec must be refused.
        with pytest.raises(ValueError):
            resolve_effective_mcp_ids(
                base_mcps=["web_search"],
                mcp_overrides={"replace": ["shell_exec"]},
                agent_capabilities=list(cfg.agents[0].capabilities),
                tools=list(cfg.tools),
            )

    def test_profile_code_exec(self, exec_tool, web_search_tool):
        """Code/exec agent: shell + web (no repl)."""
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "tools": [web_search_tool, exec_tool],
                "agents": [
                    _agent_payload(
                        "coder",
                        mcps=["web_search", "shell_exec"],
                        capabilities=["web", "shell"],
                    )
                ],
            }
        )
        assert cfg.agents[0].capabilities == ["web", "shell"]

    def test_profile_coordination_heavy(self, exec_tool, stateful_tool):
        """Coordination-heavy: shell + recursive_agents."""
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "tools": [exec_tool, stateful_tool],
                "agents": [
                    _agent_payload(
                        "coordinator",
                        mcps=["shell_exec", "vector_memory"],
                        capabilities=["shell", "memory", "recursive_agents"],
                    )
                ],
            }
        )
        assert cfg.agents[0].id == "coordinator"


# ---------------------------------------------------------------------------
# Acceptance #5 — agents without tools keep an empty capability set
# ---------------------------------------------------------------------------


class TestAgentsWithoutToolsRetained:
    """The configuration retains agents with no MCPs and no capabilities
    when coherent (issue #3408 acceptance #5)."""

    def test_no_tools_no_caps_accepted(self, read_only_tool):
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "tools": [read_only_tool],
                "agents": [_agent_payload("naked", mcps=[], capabilities=[])],
            }
        )
        assert cfg.agents[0].mcps == []
        assert cfg.agents[0].capabilities == []

    def test_no_tools_no_caps_field_optional(self, read_only_tool):
        # The ``capabilities`` field defaults to ``[]`` so callers do not
        # need to declare an empty list explicitly.
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "tools": [read_only_tool],
                "agents": [_agent_payload("naked", mcps=[])],
            }
        )
        assert cfg.agents[0].capabilities == []

    def test_no_tools_default_risk_class_read(self):
        # Tools default to ``risk_class="read"`` and an empty capability
        # set; an agent without MCPs is not constrained.
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "tools": [{"id": "noop"}],
                "agents": [_agent_payload("any", mcps=[])],
            }
        )
        assert cfg.tools[0].risk_class == "read"
        assert cfg.tools[0].allowed_capabilities == []


# ---------------------------------------------------------------------------
# Round-trip + structured introspection helpers
# ---------------------------------------------------------------------------


class TestValidateEffectiveCapabilities:
    """``validate_effective_capabilities`` is reusable at runtime."""

    def test_returns_granted_required_missing(self, web_search_tool):
        granted, required, missing = validate_effective_capabilities(
            agent_capabilities=["web"],
            effective_mcp_ids=["web_search"],
            tools=[web_search_tool],
        )
        assert granted == {"web"}
        assert required == {"web"}
        assert missing == []

    def test_returns_missing_when_capability_absent(self, web_search_tool):
        granted, required, missing = validate_effective_capabilities(
            agent_capabilities=[],
            effective_mcp_ids=["web_search"],
            tools=[web_search_tool],
        )
        assert missing == ["web"]
        assert granted == set()

    def test_no_capabilities_required_for_read_tool(self, read_only_tool):
        granted, required, missing = validate_effective_capabilities(
            agent_capabilities=[],
            effective_mcp_ids=["cached_reader"],
            tools=[read_only_tool],
        )
        assert missing == []
        assert required == set()


# ---------------------------------------------------------------------------
# Round-trip via ``SKAgentConfig.model_dump`` (issue #3408 acceptance #1)
# ---------------------------------------------------------------------------


class TestMatrixDerivationFromConfig:
    """The matrix is derived *from* the config — operators can dump the
    validated config and reconstruct the matrix without re-reading the
    template."""

    def test_dump_preserves_capability_fields(self):
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "tools": [
                    _tool_payload(
                        "web_search",
                        risk_class="read",
                        allowed_capabilities=["web"],
                    ),
                    _tool_payload(
                        "shell_exec",
                        risk_class="exec",
                        allowed_capabilities=["shell"],
                    ),
                ],
                "agents": [
                    _agent_payload(
                        "coder",
                        mcps=["web_search", "shell_exec"],
                        capabilities=["web", "shell"],
                    )
                ],
            }
        )
        dumped = cfg.model_dump()
        # The dumped shape carries the matrix fields so the operator
        # can derive a per-agent allowed-tool table from the dump alone.
        assert dumped["tools"][0]["risk_class"] == "read"
        assert dumped["tools"][1]["risk_class"] == "exec"
        assert dumped["tools"][1]["allowed_capabilities"] == ["shell"]
        assert dumped["agents"][0]["capabilities"] == ["web", "shell"]

    def test_legacy_mcps_field_still_normalised(self):
        # The legacy ``mcps`` key is still translated to ``tools`` at
        # validation time (issue #3408 must not regress #3406).
        cfg = SKAgentConfig.model_validate(
            {
                "models": [_model_payload()],
                "mcps": [
                    _tool_payload("web_search", risk_class="read", allowed_capabilities=["web"]),
                ],
                "agents": [_agent_payload("a", mcps=["web_search"], capabilities=["web"])],
            }
        )
        assert cfg.tools[0].id == "web_search"
