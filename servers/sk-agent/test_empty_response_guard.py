"""#1587 follow-up bench: the empty-output guard on the direct handler layer.

The #1182 fix added the guard to every agent-facing handler, but its tests
covered error *propagation* (review_pr path), not the handlers themselves.
ai-01 review of #1182: the handler guards live in a mocked layer with no
coverage — "_handle_text vide est le banc de suivi recommande en premier".

Fault injection: a fake ChatCompletionAgent whose invoke() yields nothing
(or whitespace-only) must surface the explicit error dict — never a silent
success with response="".
"""

import asyncio

import pytest

import sk_agent
from sk_agent import SKAgentManager
from sk_agent_config import SKAgentConfig

EMPTY_ERROR = "empty model response — agent.invoke produced no output"


class _FakeInvokeResponse:
    """Duck-type of what the invoke loop yields: str() + .thread."""

    def __init__(self, text: str):
        self._text = text
        self.thread = object()

    def __str__(self) -> str:
        return self._text


class _FakeAgent:
    """ChatCompletionAgent stand-in — invoke() returns an async generator."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.invoke_calls: list[dict] = []

    def invoke(self, messages=None, thread=None, on_intermediate_message=None, **kwargs):
        self.invoke_calls.append(kwargs)
        responses = self._responses

        async def _gen():
            for r in responses:
                yield r

        return _gen()


def _run(coro):
    return asyncio.run(coro)


def _manager() -> SKAgentManager:
    """Manager with an empty config: handlers must work without any model."""
    return SKAgentManager(SKAgentConfig())


class TestHandleTextEmptyGuard:
    """_handle_text: the invoke loop producing no output is an error (#1587)."""

    def test_invoke_yields_nothing_returns_error(self):
        manager = _manager()
        agent = _FakeAgent([])  # the injected fault: model loop produced zero output
        result = _run(
            manager._handle_text("ghost", agent, "hello", None, include_steps=False)
        )
        assert result["error"] == EMPTY_ERROR
        assert result["agent_used"] == "ghost"
        assert result["conversation_id"], "error must still identify the thread"
        assert "response" not in result, "must not be a silent success"

    def test_invoke_yields_whitespace_returns_error(self):
        manager = _manager()
        agent = _FakeAgent([_FakeInvokeResponse("   \n\t  ")])
        result = _run(
            manager._handle_text("ghost", agent, "hello", None, include_steps=False)
        )
        assert result["error"] == EMPTY_ERROR
        assert "response" not in result

    def test_real_response_still_succeeds(self):
        """Positive control: a non-empty answer keeps the success contract."""
        manager = _manager()
        agent = _FakeAgent([_FakeInvokeResponse("real answer")])
        result = _run(
            manager._handle_text("ghost", agent, "hello", None, include_steps=False)
        )
        assert "error" not in result
        assert result["response"] == "real answer"
        assert result["conversation_id"]


class TestHandleImageEmptyGuard:
    """_handle_image: same guard, reached after attachment resolution."""

    @pytest.fixture(autouse=True)
    def _fake_attachment(self, monkeypatch):
        async def _fake_resolve(source: str):
            return ("Zm9v", "image/png")

        monkeypatch.setattr(sk_agent, "resolve_attachment", _fake_resolve)

    def test_invoke_yields_nothing_returns_error(self):
        manager = _manager()
        agent = _FakeAgent([])
        result = _run(
            manager._handle_image(
                "ghost", agent, "data:image/png;base64,Zm9v", "what is this",
                None, include_steps=False,
            )
        )
        assert result["error"] == EMPTY_ERROR
        assert "response" not in result

    def test_invoke_yields_whitespace_returns_error(self):
        manager = _manager()
        agent = _FakeAgent([_FakeInvokeResponse("  ")])
        result = _run(
            manager._handle_image(
                "ghost", agent, "data:image/png;base64,Zm9v", "what is this",
                None, include_steps=False,
            )
        )
        assert result["error"] == EMPTY_ERROR

    def test_real_response_still_succeeds(self):
        manager = _manager()
        agent = _FakeAgent([_FakeInvokeResponse("a cat")])
        result = _run(
            manager._handle_image(
                "ghost", agent, "data:image/png;base64,Zm9v", "what is this",
                None, include_steps=False,
            )
        )
        assert "error" not in result
        assert result["response"] == "a cat"
