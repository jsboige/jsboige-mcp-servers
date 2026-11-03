"""#1748: per-agent rate_limit admission control in call_agent.

Acceptance mapping (dispatch ``ai01-queue-20261102d-web1`` item 1, issue
roo-extensions#1748):

- config: an absent ``rate_limit`` keeps the exact legacy behaviour
  (unlimited); invalid values are REFUSED at parse (a dead bound is worse
  than none — the caller would believe the agent capped); the field
  round-trips through ``to_dict`` only when declared;
- enforcement: N calls admitted, call N+1 gets an explicit refusal naming
  the agent, the limit and ``retry_after_s``; a refused call consumes no
  slot; sliding-window expiry re-admits;
- scope: the counter is per server instance (process memory) — two
  managers each carry their own window, which is the measured scope stated
  in the PR (stdio = one process per MCP session, streamable-http = one
  process shared by its sessions, restart resets);
- sync: ``apply_oracle_rate_defaults`` stamps 5/3600 on oracle agents that
  lack a bound — whichever path carried them into the final config — and
  never overrides an explicit operator bound;
- the gate is reachable through the FULL ``call_agent`` path (after agent
  resolution, before any model invocation), and ``model_override`` /
  ``mcp_overrides`` do not bypass it (keyed on the resolved base agent).
"""

import asyncio
import os
import sys
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sk_agent
from sk_agent import SKAgentManager
from sk_agent_config import AgentConfig, ModelConfig, RateLimitConfig, SKAgentConfig
from sync_from_template import (
    ORACLE_AGENT_IDS,
    ORACLE_RATE_LIMIT_DEFAULT,
    apply_oracle_rate_defaults,
)


def _gated_agent(agent_id: str = "a-gated", max_calls: int = 3, window_s: int = 100):
    return AgentConfig(
        id=agent_id,
        model="m-x",
        rate_limit=RateLimitConfig(max_calls=max_calls, window_s=window_s),
    )


def _gate_manager(agent=None):
    """Manager via __new__ (see test_call_agent_timeout.py): no __init__,
    no services — _rate_gate only touches config + its own counters."""
    manager = SKAgentManager.__new__(SKAgentManager)
    manager.config = SKAgentConfig(models=[ModelConfig(id="m-x")], agents=[agent])
    return manager


def _call_manager(agent=None):
    """call_agent-path manager: same minimal attrs as the #2046 timeout
    tests plus the mocked resolution/handler seams."""
    manager = _gate_manager(agent)
    manager._threads = {}
    manager._thread_counter = 0
    manager._execution_settings = None
    manager._resolve_agent = AsyncMock(return_value=(agent.id, object()))
    manager._handle_text = AsyncMock(
        return_value={
            "response": "ok",
            "conversation_id": "c1",
            "agent_used": agent.id,
            "model_used": "m-x",
        }
    )
    return manager


# ---------------------------------------------------------------------------
# (a) Config parsing — absent = legacy, invalid = refused at load
# ---------------------------------------------------------------------------


class TestRateLimitParsing:
    def test_absent_means_unlimited(self):
        a = AgentConfig.from_dict({"id": "x"})
        assert a.rate_limit is None
        assert "rate_limit" not in a.to_dict()

    def test_explicit_none_means_unlimited(self):
        a = AgentConfig.from_dict({"id": "x", "rate_limit": None})
        assert a.rate_limit is None

    def test_valid_values_parse_and_roundtrip(self):
        a = AgentConfig.from_dict(
            {"id": "x", "rate_limit": {"max_calls": 5, "window_s": 3600}}
        )
        assert a.rate_limit.max_calls == 5
        assert a.rate_limit.window_s == 3600
        assert a.to_dict()["rate_limit"] == {"max_calls": 5, "window_s": 3600}

    @pytest.mark.parametrize(
        "bad",
        [
            {"max_calls": 0, "window_s": 60},  # zero calls = dead bound
            {"max_calls": -1, "window_s": 60},
            {"max_calls": "5", "window_s": 60},  # JSON string
            {"max_calls": 2.5, "window_s": 60},
            {"max_calls": True, "window_s": 60},  # bool is an int subclass
            {"max_calls": 5, "window_s": 0},
            {"max_calls": 5, "window_s": -3600},
            {"max_calls": 5},  # missing window_s
            {"window_s": 3600},  # missing max_calls
            ["5", "3600"],  # not an object
            "5/3600",
        ],
    )
    def test_invalid_refused_at_parse(self, bad):
        with pytest.raises(ValueError):
            AgentConfig.from_dict({"id": "x", "rate_limit": bad})


# ---------------------------------------------------------------------------
# (b) Gate semantics — sliding window, admission-time counting
# ---------------------------------------------------------------------------


class TestRateGate:
    def test_admits_then_refuses_with_explicit_payload(self, monkeypatch):
        agent = _gated_agent(max_calls=3, window_s=100)
        manager = _gate_manager(agent)
        clock = {"now": 1000.0}
        monkeypatch.setattr(sk_agent.time, "monotonic", lambda: clock["now"])

        for i in range(3):
            assert manager._rate_gate(agent) is None, f"call {i + 1} must pass"

        refusal = manager._rate_gate(agent)
        assert refusal is not None
        assert refusal["rate_limited"] is True
        assert refusal["agent"] == "a-gated"
        assert refusal["limit"] == {"max_calls": 3, "window_s": 100}
        assert "rate limit exceeded" in refusal["error"]
        assert "a-gated" in refusal["error"]

    def test_refusal_consumes_no_slot(self, monkeypatch):
        agent = _gated_agent(max_calls=1, window_s=100)
        manager = _gate_manager(agent)
        monkeypatch.setattr(sk_agent.time, "monotonic", lambda: 1000.0)

        assert manager._rate_gate(agent) is None
        for _ in range(3):  # hammering must not extend the window
            refusal = manager._rate_gate(agent)
            assert refusal is not None
            assert refusal["retry_after_s"] == 100  # oldest admitted call

    def test_window_expiry_readmits(self, monkeypatch):
        agent = _gated_agent(max_calls=1, window_s=100)
        manager = _gate_manager(agent)
        clock = {"now": 1000.0}
        monkeypatch.setattr(sk_agent.time, "monotonic", lambda: clock["now"])

        assert manager._rate_gate(agent) is None
        assert manager._rate_gate(agent) is not None

        clock["now"] += 100.0  # exactly at the horizon: the slot expired
        assert manager._rate_gate(agent) is None

    def test_retry_after_s_ceil(self, monkeypatch):
        agent = _gated_agent(max_calls=1, window_s=100)
        manager = _gate_manager(agent)
        clock = {"now": 1000.0}
        monkeypatch.setattr(sk_agent.time, "monotonic", lambda: clock["now"])

        assert manager._rate_gate(agent) is None
        clock["now"] += 40.5  # 59.5 s remain in the window
        refusal = manager._rate_gate(agent)
        assert refusal["retry_after_s"] == 60  # ceil(59.5)

    def test_no_rate_limit_always_passes(self):
        agent = AgentConfig(id="a-free", model="m-x")  # no rate_limit
        manager = _gate_manager(agent)
        for _ in range(10):
            assert manager._rate_gate(agent) is None

    def test_none_agent_config_passes(self):
        manager = _gate_manager(_gated_agent())
        assert manager._rate_gate(None) is None

    def test_non_typed_rate_limit_passes(self):
        """Regression guard (measured while building #1748): agent doubles
        with auto-created attributes — MagicMock(id=...) — expose a
        truthy non-None ``rate_limit`` that is NOT a RateLimitConfig. The
        gate must treat anything untyped as unlimited, never crash."""
        from unittest.mock import MagicMock

        mock_agent = MagicMock(id="test-agent")  # auto .rate_limit = MagicMock
        manager = _gate_manager(_gated_agent())
        for _ in range(5):
            assert manager._rate_gate(mock_agent) is None


# ---------------------------------------------------------------------------
# (c) Counter scope — per server instance (the PR's stated measurement)
# ---------------------------------------------------------------------------


class TestCounterScope:
    def test_two_instances_independent_windows(self, monkeypatch):
        monkeypatch.setattr(sk_agent.time, "monotonic", lambda: 1000.0)
        agent = _gated_agent(max_calls=1, window_s=3600)
        m1, m2 = _gate_manager(agent), _gate_manager(agent)

        assert m1._rate_gate(agent) is None  # instance 1 spends its slot
        assert m2._rate_gate(agent) is None  # instance 2 still has its own
        assert m1._rate_gate(agent) is not None
        assert m2._rate_gate(agent) is not None

    def test_counters_are_process_memory_not_config(self, monkeypatch):
        monkeypatch.setattr(sk_agent.time, "monotonic", lambda: 1000.0)
        agent = _gated_agent(max_calls=1, window_s=3600)
        manager = _gate_manager(agent)
        assert manager._rate_gate(agent) is None
        # The slot lives on the instance, not on the shared AgentConfig:
        # a second manager built from the SAME config object is unspent.
        assert _gate_manager(agent)._rate_gate(agent) is None


# ---------------------------------------------------------------------------
# (d) Full call_agent path — refusal before any model invocation
# ---------------------------------------------------------------------------


class TestCallAgentEnforcement:
    def test_call_agent_refuses_at_limit_without_invoking(self):
        agent = _gated_agent(max_calls=2, window_s=3600)
        manager = _call_manager(agent)

        for _ in range(2):
            result = asyncio.run(manager.call_agent(prompt="hi"))
            assert result.get("response") == "ok"

        result = asyncio.run(manager.call_agent(prompt="hi"))
        assert result.get("rate_limited") is True
        assert result["agent"] == "a-gated"
        assert result["limit"] == {"max_calls": 2, "window_s": 3600}
        assert result["retry_after_s"] >= 1
        # The handler seam ran exactly twice — the refused call never
        # reached any model invocation.
        assert manager._handle_text.call_count == 2

    def test_model_override_does_not_bypass_the_gate(self):
        """The limit is keyed on the resolved agent: switching the model
        for one call must not dodge the bound (that is the whole point of
        capping the oracle agents)."""
        agent = _gated_agent(max_calls=1, window_s=3600)
        manager = _call_manager(agent)

        ok = asyncio.run(manager.call_agent(prompt="hi"))
        assert ok.get("response") == "ok"

        refused = asyncio.run(
            manager.call_agent(prompt="hi", model_override="m-x")
        )
        assert refused.get("rate_limited") is True
        assert manager._handle_text.call_count == 1


# ---------------------------------------------------------------------------
# (e) Oracle defaults in sync_from_template
# ---------------------------------------------------------------------------


class TestSyncOracleDefaults:
    def _config_with_agents(self, *agents):
        return {"models": [], "mcps": [], "agents": list(agents)}

    def test_oracle_without_bound_gets_default(self):
        cfg = self._config_with_agents({"id": "oracle-sonnet", "model": "m"})
        assert apply_oracle_rate_defaults(cfg) == 1
        assert cfg["agents"][0]["rate_limit"] == dict(ORACLE_RATE_LIMIT_DEFAULT)
        assert cfg["agents"][0]["rate_limit"] == {"max_calls": 5, "window_s": 3600}

    def test_explicit_bound_never_overridden(self):
        explicit = {"id": "oracle-opus", "model": "m",
                    "rate_limit": {"max_calls": 1, "window_s": 60}}
        cfg = self._config_with_agents(explicit)
        assert apply_oracle_rate_defaults(cfg) == 0
        assert cfg["agents"][0]["rate_limit"] == {"max_calls": 1, "window_s": 60}

    def test_non_oracle_agents_untouched(self):
        cfg = self._config_with_agents({"id": "analyst", "model": "m"})
        assert apply_oracle_rate_defaults(cfg) == 0
        assert "rate_limit" not in cfg["agents"][0]

    def test_both_oracles_and_malformed_entries(self):
        cfg = {
            "agents": [
                {"id": "oracle-sonnet"},
                {"id": "oracle-opus", "rate_limit": {"max_calls": 9, "window_s": 9}},
                {"id": "analyst"},
                "not-a-dict",  # guard: skip without crashing
            ]
        }
        assert apply_oracle_rate_defaults(cfg) == 1
        assert cfg["agents"][0]["rate_limit"] == dict(ORACLE_RATE_LIMIT_DEFAULT)
        assert cfg["agents"][1]["rate_limit"] == {"max_calls": 9, "window_s": 9}

    def test_default_matches_the_dispatch(self):
        # The dispatch pins 5 calls / 3600 s — a drifted constant would
        # silently change the fleet's oracle budget.
        assert ORACLE_RATE_LIMIT_DEFAULT == {"max_calls": 5, "window_s": 3600}
        assert set(ORACLE_AGENT_IDS) == {"oracle-sonnet", "oracle-opus"}


# ---------------------------------------------------------------------------
# (f) Test-of-the-test — the enforcement tests above assert THE gate
# ---------------------------------------------------------------------------


class TestMutantDiscriminance:
    """With the gate neutralized (the mutant), the very same scenario must
    NOT refuse: this proves the (d) enforcement tests discriminate the gate
    itself. If someone deletes the ``_rate_gate`` call site in call_agent,
    class (d) goes red (no refusal produced) while this class stays green —
    together they mean the assertions carry the signal, not an artefact."""

    def test_neutralized_gate_never_refuses(self):
        agent = _gated_agent(max_calls=1, window_s=3600)
        manager = _call_manager(agent)
        manager._rate_gate = lambda cfg: None  # the mutant

        for _ in range(5):
            result = asyncio.run(manager.call_agent(prompt="hi"))
            assert "rate_limited" not in result
            assert result.get("response") == "ok"

    def test_neutralized_parser_never_binds(self):
        """Mutant on the config side: a from_dict that swallows invalid
        values (returns None) would make the parse-refusal tests dead. The
        parametrized refusals in class (a) carry that signal; this stub
        documents the failure shape they guard against."""
        def swallowing_from_dict(data):  # the mutant
            return None

        assert swallowing_from_dict({"max_calls": 0, "window_s": 60}) is None
        # The real parser refuses where the mutant swallows:
        with pytest.raises(ValueError):
            RateLimitConfig.from_dict({"max_calls": 0, "window_s": 60})
