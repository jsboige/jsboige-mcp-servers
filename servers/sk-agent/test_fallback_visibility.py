"""#3411 (web2 + po-2024 fleet cells): fallback visibility in call_agent.

An explicitly requested agent that is not in the served catalogue used to
resolve silently to the default agent — the call "succeeded" on the wrong
(and costlier) agent, `agent_used` naming what answered but nothing naming
what was ASKED. Post-deployment smokes then validated the default agent,
not the preset under test (po-2024 measured `mini-summarizer` "answering"
while `analyst` was actually running; web2 measured the same on
`fast-local`).

Contract under test: the substitution is surfaced as data — `fallback_from`
names the requested id, `fallback_reason` says what was served instead —
and an exactly-served agent gets NO fallback fields (no false positive from
the model_override "[model]" suffix either; that guard is the
`split("[")[0]` in the post-process block).
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from sk_agent import SKAgentManager
from sk_agent_config import SKAgentConfig


class _HealthyAgent:
    """ChatCompletionAgent stand-in that answers normally."""

    class _Resp:
        def __init__(self, text):
            self._t = text
            self.thread = object()

        def __str__(self):
            return self._t

    def invoke(self, messages=None, thread=None, on_intermediate_message=None, **kw):
        async def _gen():
            yield self._Resp("answer from the default agent")

        return _gen()


def _manager() -> SKAgentManager:
    """Two configured agents; the first (mini-coder-fix) is the default.

    Model endpoints are dead ports on purpose — the seeded fake agent in the
    lazy-creation cache answers before any call reaches the network.
    """
    from sk_agent_config import AgentConfig, ModelConfig

    cfg = SKAgentConfig(
        models=[
            ModelConfig.from_dict({
                "id": "frognano-4b", "enabled": True,
                "base_url": "http://127.0.0.1:9/v1", "api_key": "dummy",
                "model_id": "frognano-4b", "vision": False, "thinking": False,
                "description": "mini", "context_window": 32768,
            }),
        ],
        agents=[
            AgentConfig.from_dict({
                "id": "mini-coder-fix", "description": "mini",
                "model": "frognano-4b", "system_prompt": "x",
                "mcps": [], "memory": {"enabled": False},
            }),
            AgentConfig.from_dict({
                "id": "swift-delegator", "description": "medium",
                "model": "frognano-4b", "system_prompt": "x",
                "mcps": [], "memory": {"enabled": False},
            }),
        ],
    )
    return SKAgentManager(cfg)


def test_unknown_explicit_agent_fallback_is_flagged():
    """Requesting an unconfigured agent surfaces the substitution.

    `mini-summarizer` is not in the catalogue; the default (first agent,
    mini-coder-fix) answers. The result must carry fallback_from/reason —
    without them the smoke reads as a clean success on the requested preset.
    """
    mgr = _manager()
    mgr._sk_agents["mini-coder-fix"] = _HealthyAgent()

    result = asyncio.run(
        mgr.call_agent(prompt="summarize this", agent_id="mini-summarizer")
    )
    assert "response" in result, "the default agent's answer still comes back"
    assert result["agent_used"] == "mini-coder-fix", (
        "control: the default agent is what actually answered"
    )
    assert result.get("fallback_from") == "mini-summarizer", (
        f"fallback_from must name the requested id: {result!r}"
    )
    assert result.get("fallback_reason", "").startswith(
        "agent 'mini-summarizer' not in the served catalogue"
    ), f"fallback_reason must say what was served: {result.get('fallback_reason')!r}"


def test_exactly_served_agent_gets_no_fallback_fields():
    """An explicit request that resolves to itself carries no fallback data.

    swift-delegator is configured (not the default): asking for it by name
    must answer as swift-delegator with NO fallback_from — the flag means
    "you got something else", not "you named an agent".
    """
    mgr = _manager()
    mgr._sk_agents["swift-delegator"] = _HealthyAgent()

    result = asyncio.run(
        mgr.call_agent(prompt="delegate this", agent_id="swift-delegator")
    )
    assert "response" in result
    assert result["agent_used"] == "swift-delegator"
    assert "fallback_from" not in result, (
        f"exact match must not be flagged as fallback: {result!r}"
    )
    assert "fallback_reason" not in result
