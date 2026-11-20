"""#4814 review pt 2 — runtime refusals for an unresolved base_url.

A seat rebuilt from the shared template before provisioning resolves
``${HUB_BASE_URL}`` to nothing. The load-time counterpart
(``base_url_error`` on ModelConfig, set in ``_parse_config``) is tested in
``test_config.py``; these tests pin the runtime contract:

- the model stays OUT of the pool (fail closed — no client built on a
  placeholder), while the other models stay callable;
- agent resolution refuses, typed, naming the variable — same contract
  as McpRuntimeUnavailableError (#4741) / McpConfigRejectedError (#4755),
  never an invalid-URL error at call time far from its cause.
"""

import asyncio

import pytest

import sk_agent
from sk_agent_config import AgentConfig, ModelConfig

_ERROR = (
    "base_url placeholder(s) ${HUB_BASE_URL} unresolved at load — set it "
    "in the sk-agent server environment (#4814); there is deliberately "
    "no default"
)


def _manager():
    return sk_agent.SKAgentManager(
        sk_agent.SKAgentConfig(
            models=[
                ModelConfig(
                    id="hub",
                    base_url="${HUB_BASE_URL}",
                    base_url_error=_ERROR,
                ),
                ModelConfig(id="local", base_url="http://localhost:8000/v1"),
            ],
            agents=[AgentConfig(id="needer", model="hub")],
        )
    )


def test_pool_skips_unresolved_base_url_model():
    mgr = _manager()
    asyncio.run(mgr._init_model_pool())
    assert "hub" not in mgr._openai_clients
    assert "local" in mgr._openai_clients


def test_agent_with_unresolved_base_url_refused_typed():
    mgr = _manager()
    with pytest.raises(sk_agent.ModelBaseUrlUnresolvedError) as ei:
        asyncio.run(mgr._get_or_create_agent("needer"))
    assert ei.value.to_payload() == {
        "error": "model_base_url_unresolved",
        "agent_id": "needer",
        "model_id": "hub",
        "reason": _ERROR,
    }
    # Refusal happens BEFORE creation: no agent may exist afterwards.
    assert "needer" not in mgr._sk_agents


def test_refusal_payload_names_the_variable():
    """The medium reading the tool result must see WHICH variable to set,
    without opening the config (#4814 review pt 2)."""
    payload = sk_agent.ModelBaseUrlUnresolvedError(
        "needer", "hub", _ERROR
    ).to_payload()
    assert "HUB_BASE_URL" in payload["reason"]
    assert "sk-agent server environment" in payload["reason"]
