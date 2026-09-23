"""#3797: per-model request_timeout_s / max_tokens / extra_body + coupled ceiling.

Acceptance mapping (issue roo-extensions#3797):

- non-regression: a config without the three fields keeps the 300 s client
  budget, the global sampling max_tokens and the sampling-only extra_body;
- a model's ``request_timeout_s`` must reach its AsyncOpenAI client;
- a model's ``max_tokens`` must win over the global sampling value;
- a model's ``extra_body`` must reach the settings without clobbering
  sampling-derived keys or the enable_thinking injection;
- the ``call_agent`` wait_for ceiling for a model declaring
  ``request_timeout_s=600`` must be >= 600 (the coupling).
"""

import asyncio
import logging

import pytest

import sk_agent
from sk_agent import SKAgentManager
from sk_agent_config import (
    DEFAULT_REQUEST_TIMEOUT_S,
    AgentConfig,
    ModelConfig,
    SamplingConfig,
    SKAgentConfig,
)

logging.disable(logging.INFO)


def _run(coro):
    return asyncio.run(coro)


def _model(mid: str, **kw) -> ModelConfig:
    kw.setdefault("base_url", "http://localhost:9/v1")
    return ModelConfig(id=mid, **kw)


def _config() -> SKAgentConfig:
    """Three models: undeclared, slow (declared 600 s), budget (tokens +
    extra_body); three agents, one per model."""
    return SKAgentConfig(
        models=[
            _model("m-std", model_id="std"),
            _model("m-slow", model_id="slow", request_timeout_s=600.0),
            _model(
                "m-budget",
                model_id="budget",
                thinking=True,
                max_tokens=8000,
                extra_body={
                    "top_k": 50,
                    "chat_template_kwargs": {"thinking_budget": 2048},
                },
            ),
        ],
        agents=[
            AgentConfig(id="a-std", model="m-std"),
            AgentConfig(id="a-slow", model="m-slow"),
            AgentConfig(id="a-budget", model="m-budget"),
        ],
        sampling=SamplingConfig(top_k=20),
        default_agent="a-std",
    )


def _manager() -> SKAgentManager:
    return SKAgentManager(_config())


def _settings(invoke_kwargs: dict):
    """Extract the single execution settings object from invoke kwargs."""
    ka = invoke_kwargs["arguments"]
    values = list(ka.execution_settings.values())
    assert values, "execution settings must be present"
    return values[0]


# ---------------------------------------------------------------------------
# (a) Non-regression: absent fields = exact legacy behaviour
# ---------------------------------------------------------------------------


class TestNonRegressionDefaults:
    def test_dataclass_defaults_without_fields(self):
        m = ModelConfig.from_dict({"id": "x"})
        assert m.request_timeout_s is None
        assert m.max_tokens is None
        assert m.extra_body == {}
        # to_dict only emits the fields when declared
        d = m.to_dict()
        assert "request_timeout_s" not in d
        assert "max_tokens" not in d
        assert "extra_body" not in d

    def test_client_budget_still_300_without_field(self):
        manager = _manager()
        _run(manager._init_model_pool())
        client = manager._openai_clients["m-std"]
        assert client.timeout == DEFAULT_REQUEST_TIMEOUT_S == 300.0

    def test_global_max_tokens_and_sampling_extra_body_without_field(self):
        manager = _manager()
        s = _settings(manager._get_invoke_kwargs("a-std"))
        assert s.max_tokens == 4096  # global sampling default
        # sampling-derived keys only (+ the legacy enable_thinking injection
        # for a non-thinking model) — no model-declared keys anywhere
        assert s.extra_body == {
            "top_k": 20,
            "chat_template_kwargs": {"enable_thinking": False},
        }

    def test_ceiling_untouched_without_declaration(self):
        manager = _manager()
        assert manager._effective_call_timeout(120, agent_id="a-std") == 120
        # legacy tier ceilings (review_pr) flow through unchanged as well
        assert manager._effective_call_timeout(180, agent_id="a-std") == 180
        assert manager._effective_call_timeout(300, agent_id="a-std") == 300

    def test_enable_thinking_injection_unchanged_without_extra_body(self):
        manager = SKAgentManager(
            SKAgentConfig(
                models=[_model("m-not-think", model_id="nt", thinking=False)],
                agents=[AgentConfig(id="a-nt", model="m-not-think")],
                sampling=SamplingConfig(top_k=20),
            )
        )
        s = _settings(manager._get_invoke_kwargs("a-nt"))
        assert s.extra_body["chat_template_kwargs"] == {"enable_thinking": False}


# ---------------------------------------------------------------------------
# (b) request_timeout_s reaches the AsyncOpenAI client
# ---------------------------------------------------------------------------


class TestClientTimeoutPerModel:
    def test_declared_timeout_reaches_openai_client(self):
        manager = _manager()
        _run(manager._init_model_pool())
        assert manager._openai_clients["m-slow"].timeout == 600.0

    def test_default_model_unaffected_by_other_model_declaration(self):
        manager = _manager()
        _run(manager._init_model_pool())
        assert manager._openai_clients["m-std"].timeout == 300.0


# ---------------------------------------------------------------------------
# (c) model max_tokens beats the global budget
# ---------------------------------------------------------------------------


class TestModelMaxTokens:
    def test_model_max_tokens_wins_over_global(self):
        manager = _manager()
        s = _settings(manager._get_invoke_kwargs("a-budget"))
        assert s.max_tokens == 8000

    def test_global_for_undeclared_model(self):
        manager = _manager()
        s = _settings(manager._get_invoke_kwargs("a-std"))
        assert s.max_tokens == 4096

    def test_call_sampling_override_beats_model_default(self):
        manager = _manager()
        s = _settings(
            manager._get_invoke_kwargs(
                "a-budget", sampling_override={"max_tokens": 1000}
            )
        )
        assert s.max_tokens == 1000

    def test_model_override_uses_override_model_budget(self):
        manager = _manager()
        s = _settings(
            manager._get_invoke_kwargs("a-std", model_override="m-budget")
        )
        assert s.max_tokens == 8000

    def test_thinking_model_max_tokens_without_extra_body(self):
        # The #3797 target shape: a thinking model (glm-5.3 is thinking=True)
        # that declares ONLY max_tokens — no extra_body, no per-call override.
        # No other branch rebuilds the settings in that case, so the model
        # budget must be applied on its own, and the sampling-derived
        # extra_body must survive the rebuild.
        manager = SKAgentManager(
            SKAgentConfig(
                models=[
                    _model("m-tok", model_id="tok", thinking=True, max_tokens=12000)
                ],
                agents=[AgentConfig(id="a-tok", model="m-tok")],
                sampling=SamplingConfig(top_k=20),
                default_agent="a-tok",
            )
        )
        s = _settings(manager._get_invoke_kwargs("a-tok"))
        assert s.max_tokens == 12000
        assert s.extra_body == {"top_k": 20}


# ---------------------------------------------------------------------------
# (d) extra_body passthrough + merge precedence
# ---------------------------------------------------------------------------


class TestExtraBodyPassthrough:
    def test_model_keys_override_sampling_derived_keys(self):
        manager = _manager()
        s = _settings(manager._get_invoke_kwargs("a-budget"))
        assert s.extra_body["top_k"] == 50  # model wins over sampling top_k=20
        assert s.extra_body["chat_template_kwargs"] == {"thinking_budget": 2048}

    def test_enable_thinking_merges_without_clobbering_model_keys(self):
        manager = SKAgentManager(
            SKAgentConfig(
                models=[
                    _model(
                        "m-nt-budget",
                        model_id="ntb",
                        thinking=False,
                        extra_body={
                            "chat_template_kwargs": {"thinking_budget": 2048}
                        },
                    )
                ],
                agents=[AgentConfig(id="a-nt-budget", model="m-nt-budget")],
                sampling=SamplingConfig(top_k=20),
            )
        )
        s = _settings(manager._get_invoke_kwargs("a-nt-budget"))
        assert s.extra_body["chat_template_kwargs"] == {
            "thinking_budget": 2048,  # model key preserved
            "enable_thinking": False,  # code injection still wins on its key
        }

    def test_sampling_override_preserves_model_extra_body(self):
        manager = _manager()
        s = _settings(
            manager._get_invoke_kwargs(
                "a-budget", sampling_override={"temperature": 0.3}
            )
        )
        assert s.extra_body["top_k"] == 50
        assert s.extra_body["chat_template_kwargs"] == {"thinking_budget": 2048}


# ---------------------------------------------------------------------------
# (e) wait_for ceiling coupling
# ---------------------------------------------------------------------------


class TestCeilingCoupling:
    def test_declared_600_raises_ceiling_at_least_to_600(self):
        manager = _manager()
        ceiling = manager._effective_call_timeout(120, agent_id="a-slow")
        assert ceiling >= 600

    def test_caller_timeout_higher_wins(self):
        manager = _manager()
        assert manager._effective_call_timeout(700, agent_id="a-slow") == 700

    def test_zero_and_none_mean_no_limit(self):
        manager = _manager()
        assert manager._effective_call_timeout(0, agent_id="a-slow") == 0
        assert manager._effective_call_timeout(None, agent_id="a-slow") is None

    def test_model_override_resolves_declared_model(self):
        manager = _manager()
        assert (
            manager._effective_call_timeout(
                120, agent_id="a-std", model_override="m-slow"
            )
            >= 600
        )

    def test_agent_spec_model_resolves_declared_model(self):
        manager = _manager()
        assert (
            manager._effective_call_timeout(
                120, agent_id="a-std", agent_spec={"model": "m-slow"}
            )
            >= 600
        )

    def test_call_agent_wait_for_actually_uses_coupled_ceiling(
        self, monkeypatch
    ):
        """End-to-end: a call that outlives the caller timeout but fits the
        coupled ceiling must COMPLETE, not time out."""
        monkeypatch.setattr(sk_agent, "CALL_CEILING_MARGIN_S", 0.1)
        manager = _manager()
        # a-slow's model declares 0.5 s → floor 0.6 s. The caller asks 0.1 s.
        manager.config.get_model("m-slow").request_timeout_s = 0.5

        async def _slow_resolve(**kwargs):
            await asyncio.sleep(0.25)  # > caller 0.1 s, < coupled 0.6 s
            return "a-slow", object()

        manager._resolve_agent = _slow_resolve

        async def _ok_text(*a, **k):
            return {
                "response": "ok",
                "conversation_id": "c1",
                "agent_used": "a-slow",
                "model_used": "m-slow",
            }

        manager._handle_text = _ok_text

        result = _run(
            manager.call_agent(prompt="hello", agent_id="a-slow", timeout=0.1)
        )
        assert "error" not in result, f"coupling failed: {result}"
        assert result["response"] == "ok"

    def test_timeout_error_reports_effective_ceiling(self, monkeypatch):
        monkeypatch.setattr(sk_agent, "CALL_CEILING_MARGIN_S", 0.05)
        manager = _manager()
        # caller asks 0.02 s; the declared budget (0.05) + margin (0.05)
        # raises the ceiling to 0.1 — the error must report the EFFECTIVE
        # ceiling, not the caller's raw value.
        manager.config.get_model("m-slow").request_timeout_s = 0.05

        async def _hung_resolve(**kwargs):
            await asyncio.sleep(5)
            return "a-slow", object()

        manager._resolve_agent = _hung_resolve

        result = _run(
            manager.call_agent(prompt="hello", agent_id="a-slow", timeout=0.02)
        )
        assert "timed out" in result["error"]
        assert result["timeout"] == pytest.approx(0.1)


# ---------------------------------------------------------------------------
# Schema layer: the fields validate (extra=forbid) and are bounded
# ---------------------------------------------------------------------------


class TestSchemaFields:
    def _payload(self, **model_kw):
        model = {"id": "m1"}
        model.update(model_kw)
        return {
            "config_version": 2,
            "models": [model],
            "tools": [],
            "agents": [],
            "conversations": [],
        }

    def test_schema_accepts_all_three_fields(self):
        from sk_agent_schemas import validate_config_payload

        cfg, errors = validate_config_payload(
            self._payload(
                request_timeout_s=600.0,
                max_tokens=8000,
                extra_body={"reasoning_budget": 2048},
            )
        )
        assert cfg is not None, f"schema rejected the fields: {errors}"

    def test_schema_defaults_keep_fields_optional(self):
        from sk_agent_schemas import validate_config_payload

        cfg, errors = validate_config_payload(self._payload())
        assert cfg is not None, f"errors: {errors}"
        m = cfg.models[0]
        assert m.request_timeout_s is None
        assert m.max_tokens is None
        assert m.extra_body == {}

    def test_schema_bounds_reject_out_of_range(self):
        from sk_agent_schemas import validate_config_payload

        for bad in (
            {"request_timeout_s": 0},
            {"request_timeout_s": -5},
            {"request_timeout_s": 7200},
            {"max_tokens": 0},
            {"max_tokens": 2_000_000},
        ):
            cfg, errors = validate_config_payload(self._payload(**bad))
            assert cfg is None, f"out-of-range {bad} accepted"

    def test_facade_validates_config_with_new_fields(self):
        from sk_agent_config import validate_config

        assert (
            validate_config(
                self._payload(
                    request_timeout_s=600.0,
                    max_tokens=8000,
                    extra_body={"chat_template_kwargs": {"x": 1}},
                )
            )
            == []
        )
