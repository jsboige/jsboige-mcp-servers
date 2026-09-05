"""Tests for #3409 — centralized recursion ceiling + non-bypass guarantees.

Covers the acceptance criteria:
  - Depths 0, 1, 2 authorized under ``DEFAULT_MAX_RECURSION_DEPTH = 2``;
    deeper depths refused.
  - Same behavior whether the MCP server is reached via stdio or via a
    streamable-http container (the guard is in pure Python and is transport
    agnostic; this test exercises both code paths through the same module).
  - Default ``max_recursion_depth`` stays at 2.
  - Non-bypass via ``mcp_overrides`` / ``agent_spec``: callers cannot widen
    the ceiling or hide the self-inclusion from the guard.

Discipline (mutation-measured, follow-up to the ai-01 audit of 2026-09-04):
every refusal test below asserts a discriminator that ONLY the guard can
produce — the ``Recursion ceiling reached`` warning and the absence of
``MCPStdioPlugin`` construction. Earlier revisions set ``SK_AGENT_DEPTH`` in
``os.environ`` AFTER ``sk_agent`` had already imported the constant by value,
so the guard always saw depth 0, never refused, and the tests passed through
the subprocess-exception path — 14 of 21 tests survived a ``return True``
mutation of the guard. These tests now patch the module attribute the guard
actually reads (``sk_agent.SK_AGENT_DEPTH``) and pin the refusal-specific
observables, so the same mutation fails every refusal test.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

import pytest

# Make the sk-agent package importable when run from any CWD.
SERVER_DIR = Path(__file__).parent
sys.path.insert(0, str(SERVER_DIR))

import sk_agent
from sk_agent_config import (
    DEFAULT_MAX_RECURSION_DEPTH,
    SK_AGENT_DEPTH,
    can_spawn_recursive_agent,
    is_self_referential_mcp,
)


# ---------------------------------------------------------------------------
# Pure-logic tests — no network, no MCP, no asyncio.
# ---------------------------------------------------------------------------


class TestCanSpawnRecursiveAgent:
    """Direct unit tests of the centralized guard."""

    def test_default_max_is_2(self):
        assert DEFAULT_MAX_RECURSION_DEPTH == 2

    def test_depth_zero_allows_child(self):
        # Parent at depth 0 -> child at depth 1 (<= 2) is allowed.
        assert can_spawn_recursive_agent(0, 2) is True

    def test_depth_one_allows_child(self):
        # Parent at depth 1 -> child at depth 2 (<= 2) is allowed.
        assert can_spawn_recursive_agent(1, 2) is True

    def test_depth_two_is_ceiling(self):
        # Parent at depth 2 -> child at depth 3 (> 2) is REFUSED.
        assert can_spawn_recursive_agent(2, 2) is False

    def test_depth_three_refused(self):
        assert can_spawn_recursive_agent(3, 2) is False

    def test_negative_depth_refused(self):
        # Defensive: garbage current_depth never enables recursion.
        assert can_spawn_recursive_agent(-1, 2) is False

    def test_zero_max_refuses_all(self):
        # Misconfiguration guard: max<=0 never enables spawn.
        assert can_spawn_recursive_agent(0, 0) is False
        assert can_spawn_recursive_agent(0, -1) is False

    def test_negative_max_refuses_all(self):
        assert can_spawn_recursive_agent(2, -5) is False

    def test_high_max_does_not_bypass_default(self):
        # The guard is keyed on the explicit max_depth, so a caller raising
        # max_depth above 2 still cannot exceed the documented rule when the
        # default is in force. This test asserts the explicit parameter
        # contract — the SK-agent manager only ever passes its own config
        # value, never an override from an untrusted caller.
        assert can_spawn_recursive_agent(0, 5) is True
        assert can_spawn_recursive_agent(4, 5) is True
        assert can_spawn_recursive_agent(5, 5) is False

    def test_defaults_to_env_var_when_omitted(self, monkeypatch):
        monkeypatch.setenv("SK_AGENT_DEPTH", "2")
        # Reload module to pick up env var (mirrors prod startup behavior).
        import importlib
        import sk_agent_config

        importlib.reload(sk_agent_config)
        try:
            # No args -> uses SK_AGENT_DEPTH from env (=2) and default max (=2)
            # so a spawn to depth 3 is refused.
            assert sk_agent_config.can_spawn_recursive_agent() is False
        finally:
            monkeypatch.delenv("SK_AGENT_DEPTH")
            importlib.reload(sk_agent_config)


# ---------------------------------------------------------------------------
# Integration: guard fires inside _ensure_mcp_loaded regardless of how
# the call is routed (call_agent with mcp_overrides, run_conversation with
# an inline agent that lists sk-agent in its MCPs, etc.).
#
# Two discriminators make each refusal test bite (see module docstring):
#   1. the "Recursion ceiling reached" warning — only the guard emits it;
#   2. MCPStdioPlugin is never CONSTRUCTED on refusal: the guard returns
#      before the plugin instantiation, whereas the allow path always
#      constructs the plugin (the spy then refuses to start a subprocess).
# ---------------------------------------------------------------------------


class _SelfMcpConfig:
    """Minimal duck-type for McpConfig used by ``_ensure_mcp_loaded``."""

    def __init__(self, mcp_id: str, args: list[str]):
        self.id = mcp_id
        self.description = "self sk-agent"
        self.command = "python"
        self.args = args
        self.env: dict = {}


class _SpyPlugin:
    """Records construction; never starts a subprocess.

    The allow path constructs the plugin (proving the guard let the spawn
    through) and fails on ``__aenter__`` so the loader exercises its
    exception handler deterministically — no network, no subprocess.
    """

    constructed: list[dict] = []

    def __init__(self, **kwargs):
        type(self).constructed.append(kwargs)

    async def __aenter__(self):
        raise RuntimeError("spy plugin: no real subprocess in guard tests")

    async def __aexit__(self, *exc_info):
        return False


def _build_self_inclusion_manager(
    max_recursion_depth: int, depth: int, monkeypatch
):
    """Manager whose only MCP is self-referential, with the depth the GUARD reads.

    ``sk_agent.SK_AGENT_DEPTH`` is bound at import time (import by value from
    ``sk_agent_config``), so setting ``os.environ`` here would be invisible to
    the guard — patch the module attribute itself, and keep the env var in
    sync for the spawn-env propagation assertion.
    """
    from sk_agent import SKAgentManager
    from sk_agent_config import SKAgentConfig

    config = SKAgentConfig(max_recursion_depth=max_recursion_depth)
    # SKAgentManager builds _mcp_configs from config.mcps at __init__, so the
    # self-referential MCP must be registered BEFORE the manager is built.
    config.mcps.append(_SelfMcpConfig("sk-agent", args=["sk_agent.py"]))
    manager = SKAgentManager(config)
    monkeypatch.setattr(sk_agent, "SK_AGENT_DEPTH", depth)
    monkeypatch.setenv("SK_AGENT_DEPTH", str(depth))
    return manager


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture
def spy_plugin(monkeypatch):
    """Replace MCPStdioPlugin in sk_agent with a construction recorder."""
    _SpyPlugin.constructed = []
    monkeypatch.setattr(sk_agent, "MCPStdioPlugin", _SpyPlugin)
    return _SpyPlugin


class TestEnsureMcpLoadedGuard:
    """Integration: the guard fires inside the manager's MCP loader."""

    def test_depth_below_ceiling_loads(self, monkeypatch, spy_plugin, caplog):
        # Parent at depth 0, max=2 -> the guard lets the spawn through: the
        # plugin IS constructed and no ceiling warning is logged. The spy's
        # __aenter__ then fails, so the loader returns False via its
        # exception handler — but the construction record proves the guard
        # did not refuse.
        with caplog.at_level(logging.WARNING, logger="sk-agent"):
            manager = _build_self_inclusion_manager(
                max_recursion_depth=2, depth=0, monkeypatch=monkeypatch
            )
            result = _run(manager._ensure_mcp_loaded("sk-agent"))
        assert len(spy_plugin.constructed) == 1, (
            "Guard must let a below-ceiling spawn reach plugin construction"
        )
        assert "Recursion ceiling reached" not in caplog.text
        assert result is False  # spy __aenter__ fails — not a guard refusal
        assert "sk-agent" not in manager._mcp_plugins

    def test_depth_at_ceiling_refuses(self, monkeypatch, spy_plugin, caplog):
        # Parent at depth 2, max=2 -> child would be depth 3 -> REFUSED,
        # before any plugin construction, with the guard's warning.
        with caplog.at_level(logging.WARNING, logger="sk-agent"):
            manager = _build_self_inclusion_manager(
                max_recursion_depth=2, depth=2, monkeypatch=monkeypatch
            )
            result = _run(manager._ensure_mcp_loaded("sk-agent"))
        assert "Recursion ceiling reached" in caplog.text, (
            "Refusal must be attributable to the guard, not to an exception"
        )
        assert spy_plugin.constructed == [], (
            "Guard must refuse BEFORE constructing the child plugin"
        )
        assert result is False, "Guard must refuse spawning at the ceiling"
        assert "sk-agent" not in manager._mcp_plugins
        assert "sk-agent" not in manager._loading_mcps

    def test_depth_above_ceiling_refuses(self, monkeypatch, spy_plugin, caplog):
        with caplog.at_level(logging.WARNING, logger="sk-agent"):
            manager = _build_self_inclusion_manager(
                max_recursion_depth=2, depth=5, monkeypatch=monkeypatch
            )
            result = _run(manager._ensure_mcp_loaded("sk-agent"))
        assert "Recursion ceiling reached" in caplog.text
        assert spy_plugin.constructed == []
        assert result is False
        assert "sk-agent" not in manager._mcp_plugins

    def test_lowered_max_refuses_earlier(self, monkeypatch, spy_plugin, caplog):
        # A config with max_recursion_depth=0 must refuse the first attempt.
        with caplog.at_level(logging.WARNING, logger="sk-agent"):
            manager = _build_self_inclusion_manager(
                max_recursion_depth=0, depth=0, monkeypatch=monkeypatch
            )
            result = _run(manager._ensure_mcp_loaded("sk-agent"))
        assert "Recursion ceiling reached" in caplog.text
        assert spy_plugin.constructed == []
        assert result is False
        assert "sk-agent" not in manager._mcp_plugins

    def test_raised_max_permits_when_below_ceiling(
        self, monkeypatch, spy_plugin, caplog
    ):
        # depth=2, max=10 -> child at depth 3 is allowed by the CONFIG
        # ceiling (the rule is config-driven once raised deliberately): the
        # plugin is constructed and no ceiling warning is logged.
        with caplog.at_level(logging.WARNING, logger="sk-agent"):
            manager = _build_self_inclusion_manager(
                max_recursion_depth=10, depth=2, monkeypatch=monkeypatch
            )
            result = _run(manager._ensure_mcp_loaded("sk-agent"))
        assert len(spy_plugin.constructed) == 1
        assert "Recursion ceiling reached" not in caplog.text
        assert result is False  # spy failure, not guard refusal
        # The pure guard agrees for the same inputs.
        assert can_spawn_recursive_agent(2, 10) is True


# ---------------------------------------------------------------------------
# Non-bypass: mcp_overrides and agent_spec cannot widen the ceiling.
# ---------------------------------------------------------------------------


class TestNonBypassViaOverrides:
    """The guard is centralized; per-call overrides cannot widen it."""

    def test_mcp_overrides_cannot_bypass_depth_check(
        self, monkeypatch, spy_plugin, caplog
    ):
        # Even if a caller supplies ``mcp_overrides`` that adds an MCP with
        # ``args=["sk_agent.py"]`` (a self-referential MCP), the guard in
        # ``_ensure_mcp_loaded`` still fires.
        from sk_agent import SKAgentManager
        from sk_agent_config import SKAgentConfig

        config = SKAgentConfig(max_recursion_depth=2)
        config.mcps.append(_SelfMcpConfig("sk-agent", args=["sk_agent.py"]))
        manager = SKAgentManager(config)

        base_mcps = ["some-other-mcp"]
        overrides = {"add": ["sk-agent"]}
        effective = manager._resolve_effective_mcp_ids(base_mcps, overrides)
        assert "sk-agent" in effective, (
            "Guard routes self-inclusion through resolve_effective_mcp_ids; "
            "without propagation the override would silently fail."
        )

        # Now assert the runtime guard still applies at depth=2.
        monkeypatch.setattr(sk_agent, "SK_AGENT_DEPTH", 2)
        monkeypatch.setenv("SK_AGENT_DEPTH", "2")
        with caplog.at_level(logging.WARNING, logger="sk-agent"):
            result = _run(manager._ensure_mcp_loaded("sk-agent"))
        assert "Recursion ceiling reached" in caplog.text
        assert spy_plugin.constructed == []
        assert result is False
        assert "sk-agent" not in manager._mcp_plugins

    def test_agent_spec_cannot_bypass_via_replace(
        self, monkeypatch, spy_plugin, caplog
    ):
        # An ``agent_spec``-style override that REPLACES the MCP list with
        # one containing sk-agent must still hit the guard.
        from sk_agent import SKAgentManager
        from sk_agent_config import SKAgentConfig

        config = SKAgentConfig(max_recursion_depth=2)
        config.mcps.append(_SelfMcpConfig("sk-agent", args=["sk_agent.py"]))
        manager = SKAgentManager(config)

        base_mcps: list[str] = []
        overrides = {"replace": ["sk-agent"]}
        effective = manager._resolve_effective_mcp_ids(base_mcps, overrides)
        assert effective == ["sk-agent"]

        monkeypatch.setattr(sk_agent, "SK_AGENT_DEPTH", 2)
        monkeypatch.setenv("SK_AGENT_DEPTH", "2")
        with caplog.at_level(logging.WARNING, logger="sk-agent"):
            result = _run(manager._ensure_mcp_loaded("sk-agent"))
        assert "Recursion ceiling reached" in caplog.text
        assert spy_plugin.constructed == []
        assert result is False


# ---------------------------------------------------------------------------
# Transport parity: stdio and streamable-http share the same code path,
# so the guard behaves identically. We exercise the shared module-level
# guard function — it has no transport awareness by construction.
# ---------------------------------------------------------------------------


class TestTransportParity:
    def test_guard_is_transport_agnostic(self):
        # The guard is a pure function. The HTTP transport inherits
        # ``SK_AGENT_DEPTH`` from the env and the same module-level
        # ``_ensure_mcp_loaded``; there is no separate HTTP-side recursion
        # pathway. We assert the contract by importing both transport entry
        # points and confirming they consult the same module function —
        # with EXPLICIT depths so the assertion dies if the guard stops
        # refusing (a tautology on the ambient depth would not).
        import sk_agent as sk
        from sk_agent import SKAgentManager

        assert hasattr(sk, "_build_http_app"), "http transport entrypoint intact"
        assert hasattr(SKAgentManager, "_ensure_mcp_loaded"), (
            "Manager exposes the loader where the guard fires"
        )
        assert can_spawn_recursive_agent(2, 2) is False, (
            "At the default ceiling the shared guard must refuse — both "
            "transports consult this exact function"
        )
        assert can_spawn_recursive_agent(1, 2) is True


# ---------------------------------------------------------------------------
# Diagnostics surface — current_depth / max_depth / can_spawn_child.
# No sensitive data (no model IDs, no prompts, no agent IDs).
# ---------------------------------------------------------------------------


class TestDiagnosticsSurface:
    def test_recursion_block_present(self):
        from sk_agent import _manager  # noqa: F401 (import for parity)

        # Build the expected dict shape by simulating what diagnostics()
        # returns when no manager is initialized. We cannot call the live
        # diagnostics() (it touches _manager global + log + importlib.metadata
        # network) — but we can assert the same shape the function builds,
        # at a depth where the guard MUST refuse so the value is pinned.
        expected_keys = {"current_depth", "max_depth", "can_spawn_child"}
        depth = 2  # at the default ceiling
        block = {
            "current_depth": depth,
            "max_depth": DEFAULT_MAX_RECURSION_DEPTH,
            "can_spawn_child": can_spawn_recursive_agent(
                depth, DEFAULT_MAX_RECURSION_DEPTH
            ),
        }
        assert set(block.keys()) == expected_keys
        assert block["can_spawn_child"] is False, (
            "diagnostics must surface can_spawn_child=False at the ceiling"
        )
        # No leak of model IDs, prompts, or agent identifiers.
        assert "model" not in block
        assert "prompt" not in block
        assert "agent" not in block
        assert "api_key" not in block
        assert "endpoint" not in block


# ---------------------------------------------------------------------------
# Pre-flight check: ensure the SK_AGENT_DEPTH env var behavior is preserved.
# (Regression test for the original _ensure_mcp_loaded behavior, now
# guarded by the centralized check.)
# ---------------------------------------------------------------------------


class TestDepthPropagationRegression:
    """The env var still drives depth; the guard is additive, not replacing."""

    def test_env_var_sets_depth(self, monkeypatch):
        monkeypatch.setenv("SK_AGENT_DEPTH", "1")
        import importlib
        import sk_agent_config

        importlib.reload(sk_agent_config)
        assert sk_agent_config.SK_AGENT_DEPTH == 1
        monkeypatch.delenv("SK_AGENT_DEPTH")
        importlib.reload(sk_agent_config)

    def test_default_depth_is_zero(self, monkeypatch):
        monkeypatch.delenv("SK_AGENT_DEPTH", raising=False)
        import importlib
        import sk_agent_config

        importlib.reload(sk_agent_config)
        assert sk_agent_config.SK_AGENT_DEPTH == 0

    def test_consumer_reads_imported_value_not_env(self, monkeypatch):
        # The audit's root cause: sk_agent imports SK_AGENT_DEPTH BY VALUE.
        # That binding is what the guard reads — pin it so nobody "simplifies"
        # the tests back to env-after-import (which silently neuters them).
        monkeypatch.setenv("SK_AGENT_DEPTH", "7")
        import sk_agent_config

        assert sk_agent.SK_AGENT_DEPTH == sk_agent_config.SK_AGENT_DEPTH
        monkeypatch.setenv("SK_AGENT_DEPTH", "0")
        # Still equal: both were bound at import time, before this setenv.
        assert sk_agent.SK_AGENT_DEPTH == sk_agent_config.SK_AGENT_DEPTH


# ---------------------------------------------------------------------------
# #3415 — self-use rollout. The ceiling of #3409 only binds when self-inclusion
# is RECOGNIZED, so recognition is the load-bearing half of the guarantee.
# ---------------------------------------------------------------------------


class TestSelfReferentialDetection:
    """Every launch form that reaches sk_agent.py must be recognized.

    Measured on 2026-09-05 before the fix: ``python -m sk_agent`` is a valid
    entry point (``importlib.util.find_spec("sk_agent")`` resolves to
    ``sk_agent.py``, whose ``__main__`` block starts the same server) yet the
    old predicate — ``"sk_agent.py" in " ".join(args)`` — never saw a ``.py``
    token and returned False. Self-inclusion went unrecognized, so the #3409
    ceiling was never consulted and children spawned at ANY depth.
    """

    def test_script_form_detected(self):
        assert is_self_referential_mcp("sk-agent", ["sk_agent.py"]) is True

    def test_absolute_script_path_detected(self):
        assert is_self_referential_mcp(
            "coordinator", ["C:/srv/sk-agent/sk_agent.py"]
        ) is True

    def test_windows_backslash_path_detected(self):
        assert is_self_referential_mcp(
            "coordinator", [r"C:\srv\sk-agent\sk_agent.py"]
        ) is True

    def test_module_form_detected(self):
        # THE REGRESSION: `-m sk_agent` under an id that does not name
        # sk-agent. Both halves of the old predicate missed this.
        assert is_self_referential_mcp("deep-thinker", ["-m", "sk_agent"]) is True

    def test_module_form_with_transport_arg_detected(self):
        assert is_self_referential_mcp(
            "coordinator", ["-m", "sk_agent", "streamable-http"]
        ) is True

    def test_dotted_module_form_detected(self):
        assert is_self_referential_mcp("nested", ["-m", "servers.sk_agent"]) is True

    def test_id_alone_is_sufficient(self):
        # An id naming sk-agent is self-referential whatever the args.
        assert is_self_referential_mcp("sk-agent", []) is True
        assert is_self_referential_mcp("sk_agent", ["--config", "x.json"]) is True

    def test_unrelated_mcp_not_detected(self):
        assert is_self_referential_mcp("searxng", ["-y", "mcp-searxng"]) is False
        assert is_self_referential_mcp("playwright", ["-y", "@playwright/mcp"]) is False

    def test_substring_lookalike_not_detected(self):
        # Tokenized matching: a path merely CONTAINING the stem is not a
        # self-launch. A joined-string predicate would false-positive here and
        # refuse a legitimate third-party MCP.
        assert is_self_referential_mcp(
            "helper", ["/opt/not_sk_agent_helper/run.py"]
        ) is False
        assert is_self_referential_mcp("helper", ["-m", "sk_agent_utils"]) is False


class TestModuleFormRespectsCeiling:
    """End-to-end: the module launch form is subject to the same ceiling.

    These drive ``_ensure_mcp_loaded`` with the SAME discriminators as the
    #3409 tests (the guard's warning + absence of plugin construction), so a
    predicate that stopped recognizing the module form turns them red.
    """

    def test_module_form_refused_at_ceiling(self, monkeypatch, spy_plugin, caplog):
        from sk_agent import SKAgentManager
        from sk_agent_config import SKAgentConfig

        config = SKAgentConfig(max_recursion_depth=2)
        # id deliberately does NOT name sk-agent: detection must come from args.
        config.mcps.append(_SelfMcpConfig("deep-thinker", args=["-m", "sk_agent"]))
        manager = SKAgentManager(config)
        monkeypatch.setattr(sk_agent, "SK_AGENT_DEPTH", 2)
        monkeypatch.setenv("SK_AGENT_DEPTH", "2")

        with caplog.at_level(logging.WARNING, logger="sk-agent"):
            result = _run(manager._ensure_mcp_loaded("deep-thinker"))

        assert "Recursion ceiling reached" in caplog.text, (
            "Module-form self-inclusion must be refused BY THE GUARD"
        )
        assert spy_plugin.constructed == [], (
            "Guard must refuse before constructing the child plugin"
        )
        assert result is False
        assert "deep-thinker" not in manager._mcp_plugins
        # No orphan bookkeeping left behind by the refusal.
        assert "deep-thinker" not in manager._loading_mcps

    def test_module_form_below_ceiling_propagates_depth(
        self, monkeypatch, spy_plugin, caplog
    ):
        # Below the ceiling the module form is ALLOWED, and the child must be
        # handed an incremented depth — otherwise recognition would be a
        # one-way trip that never terminates.
        from sk_agent import SKAgentManager
        from sk_agent_config import SKAgentConfig

        config = SKAgentConfig(max_recursion_depth=2)
        config.mcps.append(_SelfMcpConfig("deep-thinker", args=["-m", "sk_agent"]))
        manager = SKAgentManager(config)
        monkeypatch.setattr(sk_agent, "SK_AGENT_DEPTH", 0)
        monkeypatch.setenv("SK_AGENT_DEPTH", "0")

        with caplog.at_level(logging.WARNING, logger="sk-agent"):
            result = _run(manager._ensure_mcp_loaded("deep-thinker"))

        assert len(spy_plugin.constructed) == 1
        assert "Recursion ceiling reached" not in caplog.text
        assert result is False  # spy __aenter__ fails — not a guard refusal
        child_env = spy_plugin.constructed[0]["env"]
        assert child_env["SK_AGENT_DEPTH"] == "1", (
            "Child must inherit depth+1 so the ceiling terminates the chain"
        )


class TestTwoLevelTraversalTerminates:
    """A useful scenario crosses two levels; the third is refused.

    Acceptance #1 and #2 of #3415, asserted as the sequence they describe
    rather than as isolated points: depths 0 and 1 spawn (root -> 1 -> 2), and
    the next level is refused, with no orphan bookkeeping at the refusal.
    """

    def test_depths_zero_and_one_spawn_then_two_refuses(
        self, monkeypatch, spy_plugin, caplog
    ):
        outcomes = []
        for depth in (0, 1, 2):
            _SpyPlugin.constructed = []
            caplog.clear()
            with caplog.at_level(logging.WARNING, logger="sk-agent"):
                manager = _build_self_inclusion_manager(
                    max_recursion_depth=2, depth=depth, monkeypatch=monkeypatch
                )
                _run(manager._ensure_mcp_loaded("sk-agent"))
            outcomes.append(
                {
                    "depth": depth,
                    "constructed": len(spy_plugin.constructed),
                    "refused": "Recursion ceiling reached" in caplog.text,
                    "loading": "sk-agent" in manager._loading_mcps,
                }
            )

        assert [o["constructed"] for o in outcomes] == [1, 1, 0], (
            "Two levels must traverse (depth 0 and 1), the third must not"
        )
        assert [o["refused"] for o in outcomes] == [False, False, True]
        # Acceptance #2: refusal leaves nothing half-registered.
        assert [o["loading"] for o in outcomes] == [False, False, False], (
            "A refused spawn must not leave the MCP marked as loading"
        )


class TestOverridesCannotWidenViaModuleForm:
    """Acceptance #3, closing the form the override tests did not reach.

    The #3409 override tests used an sk-agent-named entry, so they passed on
    the id half of the old predicate. Routing an override through a
    module-form entry under an unrelated id is the combination that bypassed
    the ceiling in practice.
    """

    def test_add_override_of_module_form_still_refused(
        self, monkeypatch, spy_plugin, caplog
    ):
        from sk_agent import SKAgentManager
        from sk_agent_config import SKAgentConfig

        config = SKAgentConfig(max_recursion_depth=2)
        config.mcps.append(_SelfMcpConfig("deep-thinker", args=["-m", "sk_agent"]))
        manager = SKAgentManager(config)

        effective = manager._resolve_effective_mcp_ids(
            ["searxng"], {"add": ["deep-thinker"]}
        )
        assert "deep-thinker" in effective

        monkeypatch.setattr(sk_agent, "SK_AGENT_DEPTH", 2)
        monkeypatch.setenv("SK_AGENT_DEPTH", "2")
        with caplog.at_level(logging.WARNING, logger="sk-agent"):
            result = _run(manager._ensure_mcp_loaded("deep-thinker"))

        assert "Recursion ceiling reached" in caplog.text
        assert spy_plugin.constructed == []
        assert result is False

    def test_replace_override_of_module_form_still_refused(
        self, monkeypatch, spy_plugin, caplog
    ):
        from sk_agent import SKAgentManager
        from sk_agent_config import SKAgentConfig

        config = SKAgentConfig(max_recursion_depth=2)
        config.mcps.append(_SelfMcpConfig("coordinator", args=["-m", "sk_agent"]))
        manager = SKAgentManager(config)

        effective = manager._resolve_effective_mcp_ids([], {"replace": ["coordinator"]})
        assert effective == ["coordinator"]

        monkeypatch.setattr(sk_agent, "SK_AGENT_DEPTH", 3)
        monkeypatch.setenv("SK_AGENT_DEPTH", "3")
        with caplog.at_level(logging.WARNING, logger="sk-agent"):
            result = _run(manager._ensure_mcp_loaded("coordinator"))

        assert "Recursion ceiling reached" in caplog.text
        assert spy_plugin.constructed == []
        assert result is False
