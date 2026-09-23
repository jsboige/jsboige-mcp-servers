"""#1587 follow-up bench: the empty-output guard on the conversation layer.

The #1182/#1192 guards cover the direct handler layer (_handle_text,
_handle_image, _handle_video) and review_pr. The run_conversation path was
not covered: ConversationRunner.run() collects per-step content with
`str(message.content) if message.content else ""` (group chat) or joins
non-empty steps (concurrent) — a thinking model that exhausts its budget
(observed glm-5.3, 4096-token thinking budget) returns a valid assistant
message with EMPTY content, so the conversation completes "successfully"
with response="" and no error key.

Fault injection: a stubbed ConversationRunner returning crafted results —
the guard must surface an explicit error dict, never a silent empty success,
and must NOT re-wrap the runner's own error dicts.
"""

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest

from sk_agent import run_conversation

EMPTY_ERROR = "empty model response — conversation produced no output"


class _StubRunner:
    """ConversationRunner stand-in — run() returns the injected result."""

    def __init__(self, result):
        self._result = result
        self.calls = []

    async def run(self, **kwargs):
        self.calls.append(kwargs)
        return self._result


def _run(coro):
    return asyncio.run(coro)


def _run_with(result):
    """Call run_conversation with a stubbed runner returning `result`."""
    stub = _StubRunner(result)
    with patch(
        "sk_agent._get_conversation_runner", AsyncMock(return_value=stub)
    ):
        raw = _run(run_conversation(prompt="test question"))
    return json.loads(raw)


class TestGroupChatEmptyGuard:
    """The RX26 incident shape: every step empty after thinking-budget burn."""

    def test_all_steps_empty_returns_error(self):
        result = _run_with(
            {
                "response": "",
                "conversation_type": "group_chat",
                "conversation_id": "deep-think",
                "agents_used": ["analyst", "critic", "synthesizer"],
                "rounds": 4,
                "steps": [
                    {"agent": "analyst", "content": ""},
                    {"agent": "critic", "content": ""},
                    {"agent": "analyst", "content": ""},
                    {"agent": "synthesizer", "content": ""},
                ],
            }
        )
        assert result["error"] == EMPTY_ERROR
        assert "response" not in result, "must not be a silent success"
        assert result["empty_steps"] == "4/4"
        assert len(result["steps"]) == 4, "steps preserved for diagnosis"
        assert result["conversation_type"] == "group_chat"

    def test_whitespace_final_returns_error(self):
        result = _run_with(
            {
                "response": "   \n\t  ",
                "conversation_type": "group_chat",
                "conversation_id": "deep-think",
                "agents_used": ["analyst"],
                "rounds": 1,
                "steps": [{"agent": "analyst", "content": "   \n\t  "}],
            }
        )
        assert result["error"] == EMPTY_ERROR
        assert "response" not in result
        assert result["empty_steps"] == "1/1"


class TestConcurrentEmptyGuard:
    """Concurrent steps carry a `response` key, not `content` — same guard."""

    def test_all_agents_empty_returns_error(self):
        result = _run_with(
            {
                "response": "",
                "conversation_type": "concurrent",
                "conversation_id": "adversarial",
                "agents_used": ["proposer", "critic"],
                "rounds": 1,
                "steps": [
                    {"agent": "proposer", "response": ""},
                    {"agent": "critic", "response": "   "},
                ],
            }
        )
        assert result["error"] == EMPTY_ERROR
        assert "response" not in result
        assert result["empty_steps"] == "2/2", "counts the response-key shape too"


class TestGuardDoesNotOverreach:
    """The guard must not swallow runner errors nor flag partial successes."""

    def test_runner_error_passthrough(self):
        runner_error = {
            "error": "Conversation 'ghost' not found. Available: [...]",
        }
        result = _run_with(runner_error)
        assert result == runner_error, "runner error dicts are not re-wrapped"
        assert "empty_steps" not in result

    def test_intermediate_empty_final_ok_passes_through(self):
        """Empty intermediate steps with a non-empty final answer are NOT the
        tool's failure contract — only the final response is (#1587 scope)."""
        payload = {
            "response": "Final synthesis: the answer is 42.",
            "conversation_type": "group_chat",
            "conversation_id": "deep-think",
            "agents_used": ["analyst", "critic", "synthesizer"],
            "rounds": 6,
            "steps": [
                {"agent": "analyst", "content": ""},
                {"agent": "critic", "content": "critique text"},
                {"agent": "analyst", "content": ""},
                {"agent": "synthesizer", "content": "Final synthesis: the answer is 42."},
            ],
        }
        result = _run_with(payload)
        assert "error" not in result
        assert result == payload, "success path is untouched"

    def test_positive_control_full_success(self):
        payload = {
            "response": "complete answer",
            "conversation_type": "concurrent",
            "conversation_id": "adversarial",
            "agents_used": ["proposer", "critic"],
            "rounds": 1,
            "steps": [
                {"agent": "proposer", "response": "proposal"},
                {"agent": "critic", "response": "critique"},
            ],
        }
        result = _run_with(payload)
        assert result == payload
