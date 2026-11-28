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
   (the write-back preserves post-snapshot appends by identity);
7. no outgoing request carries an unpaired tool message — a call and its
   results are trimmed whole, and a pruned result keeps its call id (#4816).

The engine is a REAL Semantic Kernel loop (scripted model service, real
ChatCompletionAgent auto-invocation, real turn filter) — only the
network is fake. Run:

    python -m pytest test_mid_turn_condensation.py -x -q
"""

import asyncio
import json
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


ARGS_CHARS = 8_000  # big-call / small-result rounds (see _overflow_manager)


def _wire_issues(messages) -> tuple[int, int, int]:
    """(unmatched, blank, unanswered) over the OpenAI wire shape of a request.

    SK renders a TOOL message as ``tool_call_id = items[0].id or ""``. A
    request is well formed when every tool message names a tool call of a
    preceding assistant message and every tool call is answered exactly
    once. Neither this engine nor the replay witness validates the
    pairing, so a broken request travels silently.
    """
    open_ids: list[str] = []
    unmatched = blank = 0
    for wire in (message.to_dict() for message in messages):
        for call in wire.get("tool_calls") or []:
            open_ids.append(call.get("id") or "")
        if wire.get("role") != "tool":
            continue
        call_id = wire.get("tool_call_id")
        if not call_id:
            blank += 1
        elif call_id in open_ids:
            open_ids.remove(call_id)
        else:
            unmatched += 1
    return unmatched, blank, len(open_ids)


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
    args_chars: int = 0  # >0: pad every call's arguments (big-call rounds)
    model_calls: int = 0
    request_chars: list[int] = Field(default_factory=list)
    prompt_seen: list[bool] = Field(default_factory=list)
    request_tool_payloads: list[list[str]] = Field(default_factory=list)
    request_wire_issues: list[tuple[int, int, int]] = Field(default_factory=list)
    SUPPORTS_FUNCTION_CALLING = True

    def __init__(self, final_after: int = ROUNDS, args_chars: int = 0):
        super().__init__(
            ai_model_id="fake-overflow-model", final_after=final_after, args_chars=args_chars
        )

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
        self.request_wire_issues.append(_wire_issues(chat_history.messages))
        # Termination mirrors a real model: read the LATEST round visible
        # (the hot window always carries the most recent results verbatim)
        # — counting visible results would fight the condensation itself.
        if last_round >= self.final_after:
            return [
                ChatMessageContent(role=AuthorRole.ASSISTANT, content="final-answer")
            ]
        args = {"n": last_round + 1}
        if self.args_chars:
            args["pad"] = "A" * self.args_chars
        return [
            ChatMessageContent(
                role=AuthorRole.ASSISTANT,
                items=[
                    FunctionCallContent(
                        id=f"call_{self.model_calls}",
                        name=TOOL_NAME,
                        arguments=json.dumps(args),
                    )
                ],
            )
        ]

    async def _inner_get_streaming_chat_message_contents(self, chat_history, settings):
        raise NotImplementedError("streaming not used in these tests")


def _overflow_manager(
    tmp_path: Path,
    *,
    args_chars: int = 0,
    small_results: bool = False,
    condensation: dict | None = None,
):
    """Manager double with a REAL _handle_text over a real SK agent.

    Same construction as test_turn_control._turn_manager, plus the
    condensation plumbing the mid-turn seam needs: a model with a small
    context window and an agent with condensation enabled. The
    summariser falls back to the local no-LLM one (no openai clients).

    ``args_chars`` pads every call's arguments (the nb_coder shape: long
    arguments, one-line results) and ``condensation`` replaces the agent's
    block when a test needs different knobs.
    """
    model = ModelConfig(id="m-x", context_window=CONTEXT_WINDOW)
    agent_cfg = AgentConfig(
        id="a-x",
        model="m-x",
        condensation=condensation
        or {
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

    service = OverflowChatCompletion(args_chars=args_chars)
    counter: dict = {"calls": 0}

    kernel = Kernel()
    sk_agent_turns.install_turn_filter(kernel)
    kernel.add_service(service)

    class BigPlugin:
        @kernel_function(description="big")
        async def big(self, n: int, pad: str = "") -> str:
            counter["calls"] = counter["calls"] + 1
            return f"round-{n}" if small_results else payload(n)

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

    # (6) Every request is well formed on the wire: each tool message
    # names the call it answers. The pre-#4816 passes rebuilt pruned
    # results without their id, so the request carried
    # ``tool_call_id: ""`` — nothing on the wire said which call that
    # result answered.
    assert len(service.request_wire_issues) == len(service.request_chars)
    malformed = [
        issue for issue in service.request_wire_issues if issue != (0, 0, 0)
    ]
    assert not malformed, (
        f"malformed tool messages on {len(malformed)} request(s): {malformed[:5]}"
    )


@pytest.mark.asyncio
async def test_mid_turn_big_calls_small_results_keep_pairs_whole(tmp_path):
    """The nb_coder shape: 8K-char arguments, one-line results (#4816).

    With big calls and tiny results the soft target is crossed by dropping
    a CALL, so the legacy threshold pass left its result orphaned at the
    head of the trimmed history — the #3944 residual, reachable mid-turn
    since #4816 and measured on the deployed witness. Each pair must now
    go whole, and no outgoing request may carry an unpaired tool message.
    """
    manager, service, counter, agent = _overflow_manager(
        tmp_path,
        args_chars=ARGS_CHARS,
        small_results=True,
        condensation={
            "enabled": True,
            "trigger_fraction": TRIGGER_FRACTION,
            "tool_result_window": TOOL_RESULT_WINDOW,
            # Above the argument size, so the summarise pass leaves the
            # call messages alone: this test isolates the threshold pass.
            "max_tool_chars": ARGS_CHARS + 1_000,
        },
    )

    result = await manager._handle_text("a-x", agent, PROMPT, None, False)

    assert result["status"] == STATUS_COMPLETED
    assert counter["calls"] == ROUNDS
    assert result.get("response") == "final-answer"

    # The trimmed regime was reached more than once, so the requests
    # checked below are requests the condenser had actually rewritten.
    mid = (result.get("condensation") or {}).get("mid_turn")
    assert mid, "no mid_turn metrics in the response envelope"
    assert sum(1 for entry in mid if entry.get("triggered")) >= 2

    peak = max(service.request_chars)
    assert peak <= BUDGET_CHARS, (
        f"outgoing request peaked at {peak} chars > budget {BUDGET_CHARS}"
    )
    assert all(service.prompt_seen), "the user instruction vanished from a request"

    malformed = [
        issue for issue in service.request_wire_issues if issue != (0, 0, 0)
    ]
    assert not malformed, (
        f"unpaired tool messages on {len(malformed)} request(s): {malformed[:5]}"
    )


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


@pytest.mark.asyncio
async def test_post_turn_merge_preserves_mid_turn_metrics():
    """Follow-up ms#1832 (review 21/11): the "merge, never overwrite" path.

    When BOTH legs fire in one turn — mid-turn condensations recorded by
    ``_finish_turn`` (``condensation.mid_turn``) and a post-turn thread
    condensation in ``_maybe_condense_thread`` — the post-turn metrics
    must MERGE into the same dict, never replace it. Hermes mutant 3
    (revert to ``result["condensation"] = metrics.to_dict()``) survived
    the budget test because that path was never exercised with both
    legs firing; this test is the mutant killer.
    """
    from sk_context_condensation import CondensationMetrics

    model = ModelConfig(id="m-x", context_window=CONTEXT_WINDOW)
    agent_cfg = AgentConfig(
        id="a-x", model="m-x", condensation={"enabled": True}
    )
    manager = SKAgentManager.__new__(SKAgentManager)
    manager.config = SKAgentConfig(models=[model], agents=[agent_cfg])
    manager._condensers = {}

    class StubCondenser:
        async def maybe_condense(self, thread, model_context_window=None):
            return CondensationMetrics(
                triggered=True,
                reason="threshold",
                total_duration_s=0.01,
                total_tokens_in=10_000,
                total_tokens_out=4_000,
            )

    manager._get_or_create_condenser = lambda a, m: StubCondenser()

    # What _finish_turn leaves behind when the turn filter fired.
    mid_entries = [{"triggered": True, "round_index": 2}]
    result = {"condensation": {"mid_turn": mid_entries}}

    out = await manager._maybe_condense_thread("a-x", object(), result)

    # Both legs live in the same envelope, at the first level.
    assert out["condensation"]["mid_turn"] is mid_entries  # survived the merge
    assert out["condensation"]["triggered"] is True  # post-turn merged in
    assert out["condensation"]["total_tokens_out"] == 4_000


# ---------------------------------------------------------------------------
# The thread a condensed turn leaves behind (o66b, CoursIA#28976, 28/11)
# ---------------------------------------------------------------------------


def _thread_messages(manager, conv_id: str) -> list:
    return list(manager._threads[conv_id]._chat_history.messages)


# Both shapes the threshold pass meets: big results (pass 2 reduces them,
# the count holds) and the nb_coder shape — big calls, one-line results —
# where only whole pairs DROPPED bring the request under budget, so the
# list the drain indexes into gets shorter.
_SHAPES = {
    "big-results": {},
    "big-calls": {
        "args_chars": ARGS_CHARS,
        "small_results": True,
        "condensation": {
            "enabled": True,
            "trigger_fraction": TRIGGER_FRACTION,
            "tool_result_window": TOOL_RESULT_WINDOW,
            "max_tool_chars": ARGS_CHARS + 1_000,
        },
    },
}


@pytest.mark.asyncio
@pytest.mark.parametrize("shape", sorted(_SHAPES))
async def test_condensed_turn_leaves_a_thread_whose_tool_messages_pair(tmp_path, shape):
    """SK drains a turn into its thread BY INDEX, from the length the request
    history had before the model was called (``_drain_mutated_messages(history,
    start_idx, thread)``). The live condenser shortens that same list in place,
    so on a conversation that already holds a turn the drained slice starts
    INSIDE the new turn: its first messages never reach the thread, and a tool
    result can land there without the call it answers.

    Measured 28/11 on o66b (CoursIA#28976): the next call of the conversation
    sent that orphan and MiniMax refused it, HTTP 400 "tool result's tool
    id(call_…) not found (2013)" — the grain was then released as a CONTENT
    failure. Two turns on one conversation, each condensed mid-turn: after
    each, the thread pairs every tool message with its call, holds no request
    instructions, ends on the turn's answer, and the next turn's requests are
    built well formed from it.
    """
    manager, service, counter, agent = _overflow_manager(tmp_path, **_SHAPES[shape])

    first = await manager._handle_text("a-x", agent, PROMPT, None, False)
    assert first["status"] == STATUS_COMPLETED
    conv = first["conversation_id"]
    assert (first.get("condensation") or {}).get("mid_turn"), "turn 1 never condensed"

    for turn_no in (2, 3):
        service.final_after = turn_no * ROUNDS
        sent_before = len(service.request_wire_issues)
        result = await manager._handle_text("a-x", agent, PROMPT, conv, False)
        assert result["status"] == STATUS_COMPLETED
        assert (result.get("condensation") or {}).get("mid_turn"), (
            f"turn {turn_no} never condensed — the witness would prove nothing"
        )

        # Every request of this turn was built well formed — the first one
        # straight from the thread the previous turn left.
        malformed = [
            issue for issue in service.request_wire_issues[sent_before:]
            if issue != (0, 0, 0)
        ]
        assert not malformed, (
            f"turn {turn_no}: malformed tool messages on {len(malformed)} "
            f"request(s): {malformed[:5]}"
        )

        thread = _thread_messages(manager, conv)
        assert _wire_issues(thread) == (0, 0, 0), (
            f"turn {turn_no}: the thread carries unpaired tool messages "
            f"{_wire_issues(thread)} (unmatched, blank, unanswered)"
        )
        assert not any(m.role == AuthorRole.SYSTEM for m in thread), (
            "the request instructions leaked into the thread"
        )
        assert str(thread[-1]) == "final-answer"
        # Paired is not enough: on HEAD the drain of turn 2 started past the
        # shortened list and the thread kept the prompt and the answer ALONE —
        # 30 tool rounds gone, a clean wire. The turn's last round is in the
        # hot window, so the thread must still carry its result.
        last = turn_no * ROUNDS
        results = [
            str(item.result or "")
            for m in thread
            for item in m.items
            if isinstance(item, FunctionResultContent)
        ]
        assert any(
            r == f"round-{last}" or r.startswith(f"round-{last}-") for r in results
        ), f"turn {turn_no}: the thread lost the turn's tool rounds"
