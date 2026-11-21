"""#4816 volet 1: differential condensation DURING the turn (mid-turn).

Measured defect (jsboige/vllm#466, run CoursIA#27027, 17/11 00:24Z): an
nb_coder pass overflowed the model's 262 144-token window MID-TURN — the
outgoing request grew round over round inside one ``agent.invoke`` until
the engine rejected it with HTTP 400 (262 145 > 262 144). The #3944
condenser runs at call boundaries only; a turn that saturates itself is
dead before it ever reaches one.

These tests pin the mid-turn seam: the turn filter condenses the LIVE
request chat history once per tool round, so that

1. every outgoing request stays under the model's window budget
   (chars = context_window * 4, the engine's chars-per-token ratio);
2. the user's instruction rides every request verbatim;
3. the K most recent tool results stay in full (hot window);
4. older tool results are reduced (differential: tools condense,
   instructions do not);
5. the response envelope reports the mid-turn condensations;
6. a sibling tool result appended while the passes run is never lost
   (the write-back preserves post-snapshot appends by identity).

The engine is a REAL Semantic Kernel loop (scripted model service, real
ChatCompletionAgent auto-invocation, real turn filter) — only the
network is fake. Run:

    python -m pytest test_mid_turn_condensation.py -x -q
"""

import asyncio
import os
import sys
from pathlib import Path

import pytest
from pydantic import Field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.chat_completion_client_base import (
    ChatCompletionClientBase,
)
from semantic_kernel.connectors.ai.function_choice_behavior import (
    FunctionChoiceBehavior,
)
from semantic_kernel.contents import (
    AuthorRole,
    ChatMessageContent,
    FunctionCallContent,
    FunctionResultContent,
    TextContent,
)
from semantic_kernel.contents.chat_history import ChatHistory
from semantic_kernel.functions import kernel_function

import sk_agent_turns
from sk_agent import SKAgentManager, STATUS_COMPLETED
from sk_agent_config import AgentConfig, ModelConfig, SKAgentConfig
from sk_agent_turns import ConversationStore
from sk_context_condensation import (
    CondensationConfig,
    ContextCondenser,
    _DEFAULT_CHARS_PER_TOKEN,
)

TOOL_NAME = "probe-big"
ROUNDS = 30
MAX_ATTEMPTS = 40  # SK auto-invoke cap raised: one long turn, 30 rounds
PAYLOAD_CHARS = 8_000  # ≤ max_tool_chars so hot-window results stay intact
CONTEXT_WINDOW = 24_000  # tokens → budget 96K chars
BUDGET_CHARS = int(CONTEXT_WINDOW * _DEFAULT_CHARS_PER_TOKEN)
TRIGGER_FRACTION = 0.5  # arm at 12K tokens (48K chars)
# Hot window K is configurable (criterion d) — pinned to 3 here so the
# numbers compose: 3 x 8K full results ≈ 6K tokens, under the threshold
# pass target (window x fraction x 0.6 = 7.2K tokens), while 30 raw
# rounds (~60K tokens) blow the 24K window — the #4816 defect shape.
TOOL_RESULT_WINDOW = 3
MAX_TOOL_CHARS = 8_000  # hot-window results fit: full, never head-truncated
PROMPT = "Build the notebook — mid-turn differential condensation witness."


def payload(round_no: int) -> str:
    return f"round-{round_no}-" + ("D" * (PAYLOAD_CHARS - 10))


# ---------------------------------------------------------------------------
# Fake engine — scripted model capturing every outgoing request
# ---------------------------------------------------------------------------


class OverflowChatCompletion(ChatCompletionClientBase):
    """One tool call per round until ``final_after`` results are visible.

    Captures, for every model request: its total size in chars, whether
    the user instruction rides it verbatim, and the tool-result payloads
    it carries. Distinct arguments per round so the lossless-dedup pass
    never collapses two different rounds.
    """

    final_after: int = ROUNDS
    model_calls: int = 0
    request_chars: list[int] = Field(default_factory=list)
    prompt_seen: list[bool] = Field(default_factory=list)
    request_tool_payloads: list[list[str]] = Field(default_factory=list)
    SUPPORTS_FUNCTION_CALLING = True

    def __init__(self, final_after: int = ROUNDS):
        super().__init__(ai_model_id="fake-overflow-model", final_after=final_after)

    async def _inner_get_chat_message_contents(self, chat_history, settings):
        self.model_calls += 1
        chars = 0
        prompt_seen = False
        payloads: list[str] = []
        last_round = 0
        for msg in chat_history.messages:
            for item in msg.items:
                text = ""
                if isinstance(item, TextContent):
                    text = item.text or ""
                    if text == PROMPT:
                        prompt_seen = True
                elif isinstance(item, FunctionResultContent):
                    text = str(getattr(item, "result", "") or "")
                    payloads.append(text)
                    if text.startswith("round-"):
                        try:
                            last_round = max(
                                last_round, int(text.split("-", 2)[1])
                            )
                        except (IndexError, ValueError):
                            pass
                elif isinstance(item, FunctionCallContent):
                    text = str(getattr(item, "arguments", "") or "")
                chars += len(text)
        self.request_chars.append(chars)
        self.prompt_seen.append(prompt_seen)
        self.request_tool_payloads.append(payloads)
        # Termination mirrors a real model: read the LATEST round visible
        # (the hot window always carries the most recent results verbatim)
        # — counting visible results would fight the condensation itself.
        if last_round >= self.final_after:
            return [
                ChatMessageContent(role=AuthorRole.ASSISTANT, content="final-answer")
            ]
        return [
            ChatMessageContent(
                role=AuthorRole.ASSISTANT,
                items=[
                    FunctionCallContent(
                        id=f"call_{self.model_calls}",
                        name=TOOL_NAME,
                        arguments=f'{{"n": {last_round + 1}}}',
                    )
                ],
            )
        ]

    async def _inner_get_streaming_chat_message_contents(self, chat_history, settings):
        raise NotImplementedError("streaming not used in these tests")


def _overflow_manager(tmp_path: Path):
    """Manager double with a REAL _handle_text over a real SK agent.

    Same construction as test_turn_control._turn_manager, plus the
    condensation plumbing the mid-turn seam needs: a model with a small
    context window and an agent with condensation enabled. The
    summariser falls back to the local no-LLM one (no openai clients).
    """
    model = ModelConfig(id="m-x", context_window=CONTEXT_WINDOW)
    agent_cfg = AgentConfig(
        id="a-x",
        model="m-x",
        condensation={
            "enabled": True,
            "trigger_fraction": TRIGGER_FRACTION,
            "tool_result_window": TOOL_RESULT_WINDOW,
            "max_tool_chars": MAX_TOOL_CHARS,
        },
    )
    manager = SKAgentManager.__new__(SKAgentManager)
    manager.config = SKAgentConfig(models=[model], agents=[agent_cfg])
    manager._threads = {}
    manager._execution_settings = None
    manager._conv_locks = {}
    manager._turn_counts = {}
    manager._epochs = {}
    manager._store = ConversationStore(tmp_path)
    manager._turn_counter = 0
    manager._condensers = {}
    manager._openai_clients = {}
    manager._turn_marks = {}

    service = OverflowChatCompletion()
    counter: dict = {"calls": 0}

    kernel = Kernel()
    sk_agent_turns.install_turn_filter(kernel)
    kernel.add_service(service)

    class BigPlugin:
        @kernel_function(description="big")
        async def big(self, n: int) -> str:
            counter["calls"] = counter["calls"] + 1
            return payload(n)

    kernel.add_plugin(BigPlugin(), plugin_name="probe")
    agent = ChatCompletionAgent(
        kernel=kernel,
        name="sk-agent-fake",
        instructions="test",
        # Long nb_coder-style turns: the SK default cap (5 rounds) is
        # raised the way a long tool-loop pass requires — the defect
        # (#4816) is a turn that saturates ITSELF, round after round.
        function_choice_behavior=FunctionChoiceBehavior.Auto(
            maximum_auto_invoke_attempts=MAX_ATTEMPTS
        ),
    )

    async def fake_resolve(**kwargs):
        return ("a-x", agent)

    manager._resolve_agent = fake_resolve
    return manager, service, counter, agent


# ---------------------------------------------------------------------------
# Integration: the real loop, measured end to end
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mid_turn_requests_stay_under_model_budget(tmp_path):
    manager, service, counter, agent = _overflow_manager(tmp_path)

    result = await manager._handle_text("a-x", agent, PROMPT, None, False)

    # The turn completes: every round ran, exactly once, and the model
    # produced the final answer.
    assert result["status"] == STATUS_COMPLETED
    assert counter["calls"] == ROUNDS
    assert service.model_calls >= ROUNDS + 1
    assert result.get("response") == "final-answer"

    # (1) Criterion: every outgoing request stays under the model budget.
    # On HEAD the requests grow monotonically to ~246K chars (30 x 8.2K)
    # against a 96K budget — the mid-turn 400 defect, measured.
    assert service.request_chars, "no model requests captured"
    peak = max(service.request_chars)
    assert peak <= BUDGET_CHARS, (
        f"outgoing request peaked at {peak} chars > budget {BUDGET_CHARS}"
    )

    # (2) The user's instruction rides EVERY request verbatim.
    assert all(service.prompt_seen), "the user instruction vanished from a request"

    # (3) The K most recent tool results stay in full (hot window).
    last_payloads = service.request_tool_payloads[-1]
    for k in range(ROUNDS - TOOL_RESULT_WINDOW + 1, ROUNDS + 1):
        assert payload(k) in last_payloads, f"hot-window result round {k} not in full"

    # (4) Older tool results are reduced: not all of the pre-window
    # rounds survive in full.
    early = [k for k in range(1, ROUNDS - TOOL_RESULT_WINDOW + 1)
             if payload(k) in last_payloads]
    assert len(early) < (ROUNDS - TOOL_RESULT_WINDOW), (
        f"no differential reduction: all early rounds intact ({len(early)})"
    )

    # (5) The envelope reports the mid-turn condensations.
    mid = (result.get("condensation") or {}).get("mid_turn")
    assert mid, "no mid_turn metrics in the response envelope"
    assert any(entry.get("triggered") for entry in mid)


@pytest.mark.asyncio
async def test_mid_turn_condensation_off_when_agent_not_configured(tmp_path):
    """No condensation block → the seam is inert: requests grow freely.

    Guards the no-op path: an agent without ``condensation`` keeps
    today's behaviour byte-for-byte (the hook is not even attached).
    """
    model = ModelConfig(id="m-x", context_window=CONTEXT_WINDOW)
    agent_cfg = AgentConfig(id="a-x", model="m-x")
    manager = SKAgentManager.__new__(SKAgentManager)
    manager.config = SKAgentConfig(models=[model], agents=[agent_cfg])
    manager._threads = {}
    manager._execution_settings = None
    manager._conv_locks = {}
    manager._turn_counts = {}
    manager._epochs = {}
    manager._store = ConversationStore(tmp_path)
    manager._turn_counter = 0
    manager._condensers = {}
    manager._openai_clients = {}
    manager._turn_marks = {}

    service = OverflowChatCompletion(final_after=3)  # noqa: F841 — reads as intent
    kernel = Kernel()
    sk_agent_turns.install_turn_filter(kernel)
    kernel.add_service(service)

    class BigPlugin:
        @kernel_function(description="big")
        async def big(self, n: int) -> str:
            return payload(n)

    kernel.add_plugin(BigPlugin(), plugin_name="probe")
    agent = ChatCompletionAgent(
        kernel=kernel,
        name="sk-agent-fake",
        instructions="test",
        function_choice_behavior=FunctionChoiceBehavior.Auto(),
    )

    async def fake_resolve(**kwargs):
        return ("a-x", agent)

    manager._resolve_agent = fake_resolve
    result = await manager._handle_text("a-x", agent, PROMPT, None, False)

    assert result["status"] == STATUS_COMPLETED
    # Requests grow monotonically — nothing condensed mid-turn.
    chars = service.request_chars
    assert chars == sorted(chars)
    assert "condensation" not in result or not (
        result.get("condensation") or {}
    ).get("mid_turn")


# ---------------------------------------------------------------------------
# Unit: the live-history race — sibling appends survive the write-back
# ---------------------------------------------------------------------------


def _big_history(n_results: int = 10) -> ChatHistory:
    history = ChatHistory()
    for k in range(1, n_results + 1):
        history.add_message(
            ChatMessageContent(
                role=AuthorRole.ASSISTANT,
                items=[
                    FunctionCallContent(
                        id=f"c{k}", name=TOOL_NAME, arguments=f'{{"n": {k}}}'
                    )
                ],
            )
        )
        history.add_message(
            ChatMessageContent(
                role=AuthorRole.TOOL,
                items=[FunctionResultContent(function_name=TOOL_NAME, result=payload(k))],
            )
        )
    return history


@pytest.mark.asyncio
async def test_live_condense_preserves_sibling_appends(monkeypatch):
    """A tool result appended while the passes run is never dropped.

    SK 1.42 appends each tool's FunctionResultContent AFTER its filter
    chain returns; siblings of the condensing round can therefore land
    during the passes' awaits. The live write-back must carry them over
    (identity-based tail preservation).
    """
    condenser = ContextCondenser(
        config=CondensationConfig(enabled=True, trigger_fraction=0.5)
    )
    history = _big_history(10)  # ~82K chars ≈ 20K tokens > 50% of window 4K
    sentinel = ChatMessageContent(
        role=AuthorRole.TOOL,
        items=[FunctionResultContent(function_name="sibling", result="late-append")],
    )

    original = ContextCondenser._run_passes

    async def racing_passes(messages, model_context_window):
        history.messages.append(sentinel)  # sibling lands mid-passes
        await asyncio.sleep(0)  # the real race window: an await
        return await original(condenser, messages, model_context_window)

    monkeypatch.setattr(condenser, "_run_passes", racing_passes)
    metrics = await condenser.maybe_condense_live(
        history, model_context_window=4_000
    )

    assert metrics.triggered, "condensation should have triggered"
    assert any(m is sentinel for m in history.messages), (
        "sibling append lost by the write-back"
    )


@pytest.mark.asyncio
async def test_live_condense_below_threshold_is_noop():
    condenser = ContextCondenser(
        config=CondensationConfig(enabled=True, trigger_fraction=0.9)
    )
    history = _big_history(1)  # ~8.4K chars ≈ 2.1K tokens < 90% of 4K
    before = list(history.messages)

    metrics = await condenser.maybe_condense_live(history, model_context_window=4_000)

    assert not metrics.triggered
    assert history.messages == before  # untouched — identity and order
