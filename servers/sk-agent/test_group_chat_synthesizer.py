"""#1587: the round-robin runner must return the synthesizer's message.

ai-01 measured `code-review` (24/09, container rebuilt at 02:36Z): six turns,
and `response` was perf-reviewer's 5th-turn echo — the synthesizer had spoken
at turn 3. In between, every reviewer answered the previous review as if it
were its own words ("That's my own review echoed back verbatim").

Contract under test, for a 4-agent chat (3 reviewers + synthesizer):
  - each turn reaches its agent as a *user* message, peers attributed
    `[reviewer] …` — never as an unattributed assistant turn;
  - the synthesizer speaks last;
  - `response` is the synthesizer's message, not the round's last.
"""

import asyncio
import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).parent))

from sk_agent_config import _parse_config
from sk_conversations import ConversationRunner

PROMPT = "Review this diff."
SEC, PERF, MAINT, SYNTH = (
    "security-reviewer",
    "perf-reviewer",
    "maintainability-reviewer",
    "code-synthesizer",
)


class _RecordingAgent:
    """ChatCompletionAgent stand-in recording the user content it receives."""

    def __init__(self, name: str, reply: str):
        self.name = name
        self.kernel = MagicMock()
        self.reply = reply
        self.seen: list[str] = []

    def invoke(self, messages=None, thread=None, **kwargs):
        self.seen.append(messages.content)
        reply = self.reply

        class _Response:
            def __str__(self) -> str:
                return reply

        async def _gen():
            yield _Response()

        return _gen()


def _runner(conv_type: str, agent_ids: list[str], max_rounds: int = 6):
    agents = {a: _RecordingAgent(a, f"{a}-reply") for a in agent_ids}
    config = _parse_config(
        {
            "config_version": 2,
            "models": [{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            "agents": [{"id": a, "model": "m1"} for a in agent_ids],
            "conversations": [
                {
                    "id": "conv",
                    "description": "test",
                    "type": conv_type,
                    "agents": agent_ids,
                    "max_rounds": max_rounds,
                }
            ],
            "default_agent": agent_ids[0],
        }
    )
    return ConversationRunner(config, agents), agents


def _run(conv_type: str, agent_ids: list[str], max_rounds: int = 6):
    runner, agents = _runner(conv_type, agent_ids, max_rounds)
    result = asyncio.run(runner.run(PROMPT, conversation_id="conv"))
    return result, agents


class TestGroupChatRoundRobin:
    def test_synthesizer_speaks_last_and_is_returned(self):
        result, _ = _run("group_chat", [SEC, PERF, MAINT, SYNTH])
        assert "error" not in result
        spoken = [s["agent"] for s in result["steps"]]
        assert spoken[-1] == SYNTH, "the round must not end mid-cycle"
        assert result["response"] == f"{SYNTH}-reply", (
            "the returned message is the synthesizer's, not the round's last"
        )
        assert result["rounds"] == len(result["steps"]) == 6

    def test_reviewers_run_first_then_the_synthesizer(self):
        result, _ = _run("group_chat", [SEC, PERF, MAINT, SYNTH])
        assert [s["agent"] for s in result["steps"]] == [
            SEC, PERF, MAINT, SEC, PERF, SYNTH,
        ]

    def test_peers_reach_each_agent_as_attributed_user_content(self):
        result, agents = _run("group_chat", [SEC, PERF, MAINT, SYNTH])
        assert agents[SEC].seen[0] == PROMPT, "the first turn is the bare prompt"
        second = agents[PERF].seen[0]
        assert "[security-reviewer]" in second, "peers must be attributed, not named"
        assert f"{SEC}-reply" in second

    def test_each_turn_is_a_single_user_message(self):
        result, agents = _run("group_chat", [SEC, PERF, MAINT, SYNTH])
        assert len(agents[SEC].seen) == 2  # two reviewer turns
        assert len(agents[SYNTH].seen) == 1  # one concluding turn
        synth_view = agents[SYNTH].seen[0]
        for name in (SEC, PERF, MAINT):
            assert f"[{name}]" in synth_view
        assert synth_view.count(f"{PERF}-reply") == 2  # both reviewer turns kept

    def test_round_budget_is_honoured(self):
        result, _ = _run("group_chat", [SEC, PERF, MAINT, SYNTH], max_rounds=3)
        assert [s["agent"] for s in result["steps"]] == [SEC, PERF, SYNTH]


class TestSequentialRoundRobin:
    def test_each_agent_speaks_once_in_order(self):
        result, _ = _run("sequential", [SEC, PERF, MAINT, SYNTH])
        assert [s["agent"] for s in result["steps"]] == [SEC, PERF, MAINT, SYNTH]
        assert result["response"] == f"{SYNTH}-reply"

    def test_sequential_ignores_the_round_budget(self):
        result, _ = _run("sequential", [SEC, PERF, SYNTH], max_rounds=99)
        assert result["rounds"] == 3


class TestHandoffRoundRobin:
    def test_handoff_concludes_on_the_synthesizer(self):
        result, _ = _run("handoff", [SEC, PERF, SYNTH], max_rounds=5)
        assert result["steps"][-1]["agent"] == SYNTH
        assert result["response"] == f"{SYNTH}-reply"


class TestSingleAgentConversation:
    def test_lone_agent_is_its_own_synthesizer(self):
        result, agents = _run("group_chat", [SYNTH], max_rounds=6)
        assert [s["agent"] for s in result["steps"]] == [SYNTH]
        assert result["response"] == f"{SYNTH}-reply"
        assert len(agents[SYNTH].seen) == 1