"""Per-model max_retries (vllm#506 / vllm#517 follow-up; dashboard demand 21/11).

Acceptance:
- absent field → the chat AsyncOpenAI client keeps the exact legacy
  max_retries=1 (non-regression for every undeclared model);
- a declared ``max_retries: 0`` reaches the client — a timed-out decode
  is no longer replayed (vllm measured a lost 600 s decode replayed into
  a second 600 s decode under load on the nb_coder entry);
- from_dict/to_dict emit the key only when declared;
- a declaration on one model leaves the other models' clients untouched;
- a non-int value isolates the model at pool init (per-model try/except,
  the same failure class as a malformed request_timeout_s) while the
  other models stay callable.
"""

import asyncio
import logging

from sk_agent import SKAgentManager
from sk_agent_config import (
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


def _manager(*models: ModelConfig) -> SKAgentManager:
    return SKAgentManager(
        SKAgentConfig(
            models=list(models),
            agents=[AgentConfig(id=f"a-{m.id}", model=m.id) for m in models],
            sampling=SamplingConfig(top_k=20),
            default_agent=f"a-{models[0].id}",
        )
    )


class TestNonRegressionDefaults:
    def test_absent_field_keeps_legacy_one(self):
        manager = _manager(_model("m-std", model_id="std"))
        _run(manager._init_model_pool())
        assert manager._openai_clients["m-std"].max_retries == 1

    def test_from_dict_absent_omitted(self):
        m = ModelConfig.from_dict({"id": "x"})
        assert m.max_retries is None
        assert "max_retries" not in m.to_dict()


class TestDeclaredZero:
    def test_zero_reaches_client(self):
        manager = _manager(
            _model("m-nb", model_id="nb", max_retries=0),
            _model("m-std", model_id="std"),
        )
        _run(manager._init_model_pool())
        assert manager._openai_clients["m-nb"].max_retries == 0
        # the undeclared neighbour keeps the exact legacy client
        assert manager._openai_clients["m-std"].max_retries == 1

    def test_roundtrip_emits_declared_value(self):
        m = ModelConfig.from_dict({"id": "x", "max_retries": 0})
        assert m.max_retries == 0
        assert m.to_dict()["max_retries"] == 0


class TestInvalidValueIsolated:
    def test_non_int_skips_model_not_seat(self):
        manager = _manager(
            _model("m-bad", model_id="bad", max_retries="fast"),
            _model("m-std", model_id="std"),
        )
        _run(manager._init_model_pool())
        assert "m-bad" not in manager._openai_clients
        assert "m-std" in manager._openai_clients
