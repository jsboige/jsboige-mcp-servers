#!/usr/bin/env python3
"""
Unit tests for sk_context_condensation module.

Tests cover:
- Configuration: from_dict / to_dict / preset resolution
- Pass 1 (lossless dedup) — collapses identical consecutive tool calls
- Pass 2 (truncate old tools) — keeps the recent window, prunes the rest
- Pass 3 (summarise) — uses fallback summariser when no client
- Pass 4 (threshold) — drops oldest NON-SYSTEM messages until under target
- Trigger logic — tokens threshold and fraction threshold
- Thread write-back — replaced history reflects the new messages
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from semantic_kernel.contents import (
    AuthorRole,
    ChatMessageContent,
    FunctionCallContent,
    FunctionResultContent,
    TextContent,
)

from sk_context_condensation import (
    CondensationConfig,
    CondensationMetrics,
    CondensationPreset,
    ContextCondenser,
    _FallbackSummariser,
    _message_chars,
    _message_text,
    _message_tokens,
    _tool_call_signature,
)


# ---------------------------------------------------------------------------
# Fixtures: fake "threads" with chat_history list
# ---------------------------------------------------------------------------


class FakeThread:
    """Minimal stand-in for ChatHistoryAgentThread."""

    def __init__(self, messages: list[ChatMessageContent]) -> None:
        self.chat_history = list(messages)


def _text_msg(role: AuthorRole, text: str) -> ChatMessageContent:
    return ChatMessageContent(role=role, items=[TextContent(text=text)])


def _tool_call_msg(role: AuthorRole, name: str, args: dict | str) -> ChatMessageContent:
    return ChatMessageContent(
        role=role,
        items=[FunctionCallContent(function_name=name, arguments=args)],
    )


def _tool_result_msg(role: AuthorRole, name: str, result: str) -> ChatMessageContent:
    return ChatMessageContent(
        role=role,
        items=[FunctionResultContent(function_name=name, result=result)],
    )


# ---------------------------------------------------------------------------
# Config tests
# ---------------------------------------------------------------------------


def test_config_defaults_to_balanced_disabled():
    cfg = CondensationConfig()
    assert cfg.enabled is False
    assert cfg.preset == CondensationPreset.BALANCED
    assert cfg.recent_message_window == 6
    assert cfg.tool_result_window == 8
    assert cfg.summarise_max_tokens == 1024
    assert cfg.max_tool_chars == 8000


def test_config_from_dict_preserves_overrides():
    cfg = CondensationConfig.from_dict(
        {
            "enabled": True,
            "preset": "aggressive",
            "trigger_fraction": 0.5,
            "summarise_max_tokens": 256,
        }
    )
    assert cfg.enabled is True
    assert cfg.preset == CondensationPreset.AGGRESSIVE
    assert cfg.trigger_fraction == 0.5
    assert cfg.summarise_max_tokens == 256


def test_config_to_dict_roundtrip():
    cfg = CondensationConfig.from_dict(
        {"enabled": True, "trigger_tokens": 5000, "preset": "conservative"}
    )
    d = cfg.to_dict()
    assert d["enabled"] is True
    assert d["trigger_tokens"] == 5000
    assert d["preset"] == "conservative"
    cfg2 = CondensationConfig.from_dict(d)
    assert cfg2.enabled == cfg.enabled
    assert cfg2.trigger_tokens == cfg.trigger_tokens
    assert cfg2.preset == cfg.preset


def test_config_resolved_uses_preset_bundle():
    cfg = CondensationConfig(enabled=True, preset=CondensationPreset.AGGRESSIVE)
    resolved = cfg.resolved()
    # Aggressive: trigger_fraction=0.55, recent_window=4, tool_window=5
    assert resolved.trigger_fraction == 0.55
    assert resolved.recent_message_window == 4
    assert resolved.tool_result_window == 5


# ---------------------------------------------------------------------------
# Pass 1 — lossless dedup
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lossless_dedup_collapses_identical_consecutive_calls():
    messages = [
        _tool_call_msg(AuthorRole.ASSISTANT, "search", {"q": "x"}),
        _tool_result_msg(AuthorRole.TOOL, "search", "result-1"),
        _tool_call_msg(AuthorRole.ASSISTANT, "search", {"q": "x"}),
        _tool_result_msg(AuthorRole.TOOL, "search", "result-2"),
    ]
    condenser = ContextCondenser(config=CondensationConfig(enabled=True))
    out, m = await condenser._pass_lossless_dedup(messages)
    # Same sig twice — the duplicate call AND its result drop together
    # (review #3944 pt 2: an orphan FunctionResultContent without its
    # call breaks the thread on SK / OpenAI-compatible endpoints).
    assert m.messages_in == 4
    assert m.messages_out == 2
    assert m.reduction_ratio > 0
    kept_results = [
        str(item.result)
        for msg in out
        for item in msg.items
        if isinstance(item, FunctionResultContent)
    ]
    assert kept_results == ["result-1"]
    kept_calls = [
        item.function_name
        for msg in out
        for item in msg.items
        if isinstance(item, FunctionCallContent)
    ]
    assert kept_calls == ["search"]


@pytest.mark.asyncio
async def test_lossless_dedup_text_breaks_the_run():
    # Review #3944 pt 3: a call repeated AFTER intervening text is not a
    # duplicate — the run resets on signature-less non-result messages.
    messages = [
        _tool_call_msg(AuthorRole.ASSISTANT, "search", {"q": "x"}),
        _text_msg(AuthorRole.USER, "intervening text"),
        _tool_call_msg(AuthorRole.ASSISTANT, "search", {"q": "x"}),
    ]
    condenser = ContextCondenser(config=CondensationConfig(enabled=True))
    out, m = await condenser._pass_lossless_dedup(messages)
    assert m.messages_in == 3
    assert m.messages_out == 3


@pytest.mark.asyncio
async def test_lossless_dedup_keeps_distinct_calls():
    messages = [
        _tool_call_msg(AuthorRole.ASSISTANT, "search", {"q": "x"}),
        _tool_result_msg(AuthorRole.TOOL, "search", "result-1"),
        _tool_call_msg(AuthorRole.ASSISTANT, "search", {"q": "y"}),
        _tool_result_msg(AuthorRole.TOOL, "search", "result-2"),
    ]
    condenser = ContextCondenser(config=CondensationConfig(enabled=True))
    out, m = await condenser._pass_lossless_dedup(messages)
    assert m.messages_in == 4
    assert m.messages_out == 4
    assert m.reduction_ratio == 0


# ---------------------------------------------------------------------------
# Pass 2 — truncate old tools
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_truncate_old_tools_keeps_recent_window():
    messages = []
    # 10 tool-result messages
    for i in range(10):
        messages.append(_tool_result_msg(AuthorRole.TOOL, "f", f"r{i}"))
    cfg = CondensationConfig(enabled=True, tool_result_window=3)
    condenser = ContextCondenser(config=cfg)
    out, m = await condenser._pass_truncate_old_tools(messages, cfg)
    # 7 dropped, 3 kept (the 3 most recent)
    assert m.messages_in == 10
    assert m.messages_out == 10
    # Find FunctionResultContent items and check their result payloads
    kept_texts = []
    for msg in out:
        for item in msg.items:
            if isinstance(item, FunctionResultContent):
                kept_texts.append(str(item.result))
    # Last three messages must retain their original payload; earlier
    # ones get the pruned marker.
    assert "r7" in kept_texts[-3] or "r8" in kept_texts[-3] or "r9" in kept_texts[-3]


# ---------------------------------------------------------------------------
# Pass 3 — summarise (fallback)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_summarise_uses_fallback_when_no_client():
    big = "x" * 5000
    messages = [_text_msg(AuthorRole.ASSISTANT, big)]
    cfg = CondensationConfig(
        enabled=True, recent_message_window=0, max_tool_chars=100
    )
    condenser = ContextCondenser(config=cfg, summariser=_FallbackSummariser())
    out, m = await condenser._pass_summarise(messages, cfg)
    assert m.messages_in == 1
    assert m.messages_out == 1
    # The fallback summariser must shorten the message.
    new_text = _message_text(out[0])
    assert len(new_text) < len(big)


@pytest.mark.asyncio
async def test_summarise_condenses_oversized_call_arguments_keep_pairs():
    """The nb_coder shape: the per-round CALL arguments are the bulk (#4816).

    Pre-fix, the pass collapsed TextContent and *appended* a summary to a
    call-only message, leaving its ~10 KB of arguments verbatim: it grew
    the history instead of shrinking it (measured +69 691 estimated
    tokens over a 70-round turn on the deployed condenser). Oversized
    arguments must now be condensed — the issue asks for call parameters
    to be condensed more aggressively — and the call must keep the id its
    result answers.
    """
    call = ChatMessageContent(
        role=AuthorRole.ASSISTANT,
        items=[
            FunctionCallContent(
                id="call-1",
                function_name="nb-update_cell",
                arguments={"n": 1, "source": "x" * 10_000},
            )
        ],
    )
    result = ChatMessageContent(
        role=AuthorRole.TOOL,
        items=[
            FunctionResultContent(
                id="call-1", function_name="nb-update_cell", result="ok"
            )
        ],
    )
    cfg = CondensationConfig(
        enabled=True, recent_message_window=0, max_tool_chars=1000
    )
    condenser = ContextCondenser(config=cfg, summariser=_FallbackSummariser())
    out, m = await condenser._pass_summarise([call, result], cfg)

    assert m.tokens_out < m.tokens_in
    kept_call = next(i for i in out[0].items if isinstance(i, FunctionCallContent))
    assert kept_call.id == "call-1"
    assert kept_call.function_name == "nb-update_cell"
    assert len(str(kept_call.arguments)) < 10_000
    kept_result = next(i for i in out[1].items if isinstance(i, FunctionResultContent))
    assert kept_result.id == "call-1"


@pytest.mark.asyncio
async def test_summarise_never_grows_a_message():
    """A summary larger than the payload leaves the message untouched."""
    msg = ChatMessageContent(
        role=AuthorRole.ASSISTANT,
        items=[FunctionCallContent(id="c", function_name="f", arguments={"q": "x"})],
    )
    cfg = CondensationConfig(
        enabled=True, recent_message_window=0, max_tool_chars=1
    )

    class _Verbose:
        async def summarise(self, text: str, *, max_tokens: int) -> str:
            return "y" * 500

    condenser = ContextCondenser(config=cfg, summariser=_Verbose())
    out, m = await condenser._pass_summarise([msg], cfg)
    assert m.tokens_out <= m.tokens_in
    assert out[0] is msg


@pytest.mark.asyncio
async def test_nbcoder_shape_summarise_shrinks_and_no_orphan():
    """Twelve nb_coder rounds: the summarise pass must shrink, not grow.

    BALANCED preset (the nb_coder seat contract): 10 KB of call arguments
    per round against an 8 000-char cap. Pre-fix the pass added ~4 KB per
    call message; the four passes must now come out smaller, and every
    result must still name the call it answers.
    """
    msgs = [
        _text_msg(AuthorRole.SYSTEM, "sys"),
        _text_msg(AuthorRole.USER, "mission"),
    ]
    for r in range(1, 13):
        msgs.append(
            ChatMessageContent(
                role=AuthorRole.ASSISTANT,
                items=[
                    FunctionCallContent(
                        id=f"call-{r}",
                        function_name="nb-update_cell",
                        arguments={"n": r, "source": "s" * 10_000},
                    )
                ],
            )
        )
        msgs.append(
            ChatMessageContent(
                role=AuthorRole.TOOL,
                items=[
                    FunctionResultContent(
                        id=f"call-{r}",
                        function_name="nb-update_cell",
                        result="o" * 6_000,
                    )
                ],
            )
        )
    condenser = ContextCondenser(
        config=CondensationConfig(enabled=True, preset="balanced")
    )
    working, passes = await condenser._run_passes(msgs, 262_144)
    by_name = {p.name: p for p in passes}
    assert by_name["summarise"].tokens_out < by_name["summarise"].tokens_in

    call_ids = {
        i.id
        for msg in working
        for i in msg.items
        if isinstance(i, FunctionCallContent)
    }
    result_ids = {
        i.id
        for msg in working
        for i in msg.items
        if isinstance(i, FunctionResultContent)
    }
    assert result_ids <= call_ids, "a tool result lost the call it answers"
    assert sum(_message_tokens(m) for m in working) < 262_144


# ---------------------------------------------------------------------------
# Pass 4 — threshold
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_threshold_keeps_recent_window():
    # All-USER thread: the first user message is protected (mission
    # preservation, review #1266), so it holds the oldest slot and the
    # recent window fills with the latest messages.
    messages = [_text_msg(AuthorRole.USER, f"msg-{i}") for i in range(20)]
    cfg = CondensationConfig(enabled=True, recent_message_window=4)
    condenser = ContextCondenser(config=cfg)
    out, m = await condenser._pass_threshold(messages, 1024, cfg)
    assert m.messages_in == 20
    assert m.messages_out == 4
    texts = [_message_text(m) for m in out]
    assert texts[-1] == "msg-19"
    assert texts[0] == "msg-0"


@pytest.mark.asyncio
async def test_threshold_never_trims_the_system_prompt():
    # Review #3944 pt 1: pop(0) trimmed the system prompt first — the spec
    # says "oldest non-system". A tight budget must eat user messages and
    # leave the system message in place.
    messages = [_text_msg(AuthorRole.SYSTEM, "system prompt")]
    messages += [_text_msg(AuthorRole.USER, "x" * 300) for _ in range(10)]
    cfg = CondensationConfig(enabled=True, recent_message_window=2)
    condenser = ContextCondenser(config=cfg)
    out, m = await condenser._pass_threshold(messages, 1000, cfg)
    assert m.messages_out < len(messages)  # the pass actually trimmed
    assert out[0].role == AuthorRole.SYSTEM
    assert _message_text(out[0]) == "system prompt"


@pytest.mark.asyncio
async def test_threshold_never_trims_the_first_user_message():
    # Review #1266: the first USER message is the mission — a tight budget
    # must eat the assistant turns that follow, never the original ask.
    messages = [_text_msg(AuthorRole.SYSTEM, "system prompt")]
    messages.append(_text_msg(AuthorRole.USER, "mission: summarize the repo"))
    messages += [_text_msg(AuthorRole.ASSISTANT, "x" * 300) for _ in range(10)]
    cfg = CondensationConfig(enabled=True, recent_message_window=2)
    condenser = ContextCondenser(config=cfg)
    out, m = await condenser._pass_threshold(messages, 1000, cfg)
    assert m.messages_out < len(messages)  # the pass actually trimmed
    assert out[0].role == AuthorRole.SYSTEM
    assert out[1].role == AuthorRole.USER
    assert _message_text(out[1]) == "mission: summarize the repo"


def test_message_tokens_counts_full_tool_results():
    # Review #3944 minor / acceptance #4: metrics must not understate tool
    # results — _message_text caps them at 200 chars, _message_tokens
    # counts everything.
    big_result = "y" * 4000
    msg = _tool_result_msg(AuthorRole.TOOL, "f", big_result)
    assert _message_tokens(msg) >= 1000  # 4000 chars / 4
    assert len(_message_text(msg)) < 300  # the capped rendering stays short


# ---------------------------------------------------------------------------
# Trigger logic
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_maybe_condense_below_threshold_no_op():
    messages = [_text_msg(AuthorRole.USER, "hi")]
    thread = FakeThread(messages)
    cfg = CondensationConfig(enabled=True, trigger_tokens=10000)
    condenser = ContextCondenser(config=cfg)
    metrics = await condenser.maybe_condense(thread, model_context_window=100000)
    assert metrics.triggered is False
    assert metrics.reason == "below_threshold"
    assert len(thread.chat_history) == 1


@pytest.mark.asyncio
async def test_maybe_condense_triggers_on_fraction():
    big = "x" * 40000  # ~10K tokens at 4 chars/token
    messages = [_text_msg(AuthorRole.ASSISTANT, big)]
    thread = FakeThread(messages)
    cfg = CondensationConfig(enabled=True, trigger_fraction=0.5, dry_run=True)
    condenser = ContextCondenser(config=cfg)
    metrics = await condenser.maybe_condense(
        thread, model_context_window=10000, force=True
    )
    assert metrics.triggered is True
    assert len(metrics.passes) == 4
    # In dry_run mode, the history must NOT be mutated.
    assert len(thread.chat_history) == 1


@pytest.mark.asyncio
async def test_maybe_condense_disabled_returns_noop():
    messages = [_text_msg(AuthorRole.USER, "hi")]
    thread = FakeThread(messages)
    cfg = CondensationConfig(enabled=False)
    condenser = ContextCondenser(config=cfg)
    metrics = await condenser.maybe_condense(thread, model_context_window=1000, force=True)
    assert metrics.triggered is False
    assert metrics.reason == "disabled"


# ---------------------------------------------------------------------------
# Thread write-back
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_write_back_replaces_history():
    # Use long messages so the threshold pass actually trims.
    long_text = "x" * 4000
    messages = [_text_msg(AuthorRole.USER, f"{long_text}-{i}") for i in range(20)]
    thread = FakeThread(messages)
    cfg = CondensationConfig(enabled=True, recent_message_window=2, trigger_fraction=0.1)
    condenser = ContextCondenser(config=cfg)
    await condenser.maybe_condense(thread, model_context_window=1000)
    # Threshold pass trims until thread fits, retaining recent_window=2.
    assert len(thread.chat_history) <= 5  # <= recent window + small buffer


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def test_message_text_renders_tool_calls_and_results():
    msg = ChatMessageContent(
        role=AuthorRole.ASSISTANT,
        items=[
            TextContent(text="hello"),
            FunctionCallContent(function_name="foo", arguments={"a": 1}),
        ],
    )
    txt = _message_text(msg)
    assert "hello" in txt
    assert "tool_call" in txt
    assert "foo" in txt


def test_message_chars_counts_text_only():
    msg = _text_msg(AuthorRole.USER, "abcde")
    assert _message_chars(msg) == 5


def test_tool_call_signature_distinguishes_args():
    a = _tool_call_signature(_tool_call_msg(AuthorRole.ASSISTANT, "f", {"x": 1}))
    b = _tool_call_signature(_tool_call_msg(AuthorRole.ASSISTANT, "f", {"x": 2}))
    assert a is not None
    assert b is not None
    assert a != b


def test_tool_call_signature_none_for_text_only():
    m = _text_msg(AuthorRole.USER, "hi")
    assert _tool_call_signature(m) is None


# ---------------------------------------------------------------------------
# Fallback summariser
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fallback_summariser_shortens_long_text():
    text = "lorem ipsum " * 1000
    s = _FallbackSummariser()
    out = await s.summarise(text, max_tokens=50)
    assert len(out) < len(text)


@pytest.mark.asyncio
async def test_fallback_summariser_returns_input_when_short():
    s = _FallbackSummariser()
    out = await s.summarise("short", max_tokens=50)
    assert out == "short"


@pytest.mark.asyncio
async def test_fallback_summariser_handles_empty():
    s = _FallbackSummariser()
    assert await s.summarise("", max_tokens=10) == ""


# ---------------------------------------------------------------------------
# Follow-up ms#1832 (review ai-01 21/11): pairing invariant of pass 4
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_threshold_never_orphans_a_tool_result():
    """#3944 residual, fixed with #4816: pass 4 trims atomic call+result units.

    The legacy pass popped call and result messages independently. With
    balanced payloads the budget crossing landed on a RESULT (the big
    message), so pairs dropped whole and the invariant held; with a LARGE
    call followed by a SMALL result (long arguments, one-word result) the
    crossing landed on the CALL and an orphan FunctionResultContent
    survived — the pairing broken on the wire.
    This was the strict xfail pinning the residual; since #4816 a call and
    its results are trimmed together, so the pin flips green.
    """
    # Two pairs of (large call ~500 tok, small result ~10 tok): the soft
    # target (window 1000 x 0.5 x 0.6 = 300 tok) used to be crossed by
    # POPPING A CALL, leaving both results orphaned — the reachable
    # boundary. Both pairs must now go together.
    messages = [
        _text_msg(AuthorRole.SYSTEM, "system prompt"),
        _text_msg(AuthorRole.USER, "mission"),
    ]
    for i in range(2):
        messages.append(
            ChatMessageContent(
                role=AuthorRole.ASSISTANT,
                items=[
                    FunctionCallContent(
                        id=f"call-{i}",
                        function_name=f"tool-{i}",
                        arguments="x" * 2_000,  # ~500 tokens
                    )
                ],
            )
        )
        messages.append(
            ChatMessageContent(
                role=AuthorRole.TOOL,
                items=[
                    FunctionResultContent(
                        id=f"call-{i}", function_name=f"tool-{i}", result="ok"
                    )
                ],
            )
        )
    messages.append(_text_msg(AuthorRole.USER, "latest question"))
    cfg = CondensationConfig(
        enabled=True, recent_message_window=2, trigger_fraction=0.5
    )
    condenser = ContextCondenser(config=cfg)
    out, m = await condenser._pass_threshold(messages, 1000, cfg)
    assert m.messages_out < len(messages)  # the pass actually trimmed
    call_ids = {
        item.id
        for msg in out
        for item in msg.items
        if isinstance(item, FunctionCallContent)
    }
    for msg in out:
        for item in msg.items:
            if isinstance(item, FunctionResultContent):
                assert item.id in call_ids, (
                    f"orphan tool result {item.id!r} survived the threshold pass"
                )
    assert [_message_text(msg) for msg in out] == [
        "system prompt",
        "mission",
        "latest question",
    ]


# ---------------------------------------------------------------------------
# #4816: the threshold pass keeps a tool call and its results atomic
# ---------------------------------------------------------------------------


def _pairing(messages):
    """(orphan_results, dangling_calls) by call id — the pairing baseline.

    The input's own pair is the reference: a pass that breaks one moves it.
    """
    open_ids: list = []
    orphan = 0
    for message in messages:
        for item in message.items:
            if isinstance(item, FunctionCallContent):
                open_ids.append(item.id)
            elif isinstance(item, FunctionResultContent):
                if item.id in open_ids:
                    open_ids.remove(item.id)
                else:
                    orphan += 1
    return orphan, len(open_ids)


def _call_with_id(i, args: str = "{}") -> ChatMessageContent:
    return ChatMessageContent(
        role=AuthorRole.ASSISTANT,
        items=[FunctionCallContent(id=f"call-{i}", function_name="t", arguments=args)],
    )


def _result_with_id(i, payload: str = "ok") -> ChatMessageContent:
    return ChatMessageContent(
        role=AuthorRole.TOOL,
        items=[FunctionResultContent(id=f"call-{i}", function_name="t", result=payload)],
    )


def _item_ids(messages, item_type) -> list:
    return [
        item.id
        for message in messages
        for item in message.items
        if isinstance(item, item_type)
    ]


@pytest.mark.asyncio
async def test_threshold_keeps_a_pair_whole_when_the_floor_straddles_it():
    """The keep floor is a lower bound on messages — never a pair to split.

    recent_message_window=3 over two small pairs: reaching the floor meant
    popping the second pair's CALL and leaving its result behind. The pass
    stops one message above the floor instead — more context retained,
    never a broken pair.
    """
    messages = [
        _text_msg(AuthorRole.SYSTEM, "system prompt"),
        _text_msg(AuthorRole.USER, "mission"),
        _call_with_id(1),
        _result_with_id(1),
        _call_with_id(2),
        _result_with_id(2),
    ]
    cfg = CondensationConfig(enabled=True, recent_message_window=3)
    condenser = ContextCondenser(config=cfg)
    out, m = await condenser._pass_threshold(messages, None, cfg)
    assert m.messages_out == 4  # keep=3, +1: the second pair travels whole
    assert _item_ids(out, FunctionResultContent) == ["call-2"]
    assert _pairing(out) == (0, 0)


@pytest.mark.asyncio
async def test_threshold_never_trims_an_unresolved_call():
    """Mid-turn: the current call has no result yet while this pass runs.

    SK 1.42 builds a tool's result message only after its auto-invocation
    filter stack returns (``Kernel.invoke_function_call``), so the live
    history ends with an unresolved call. Trimming it orphans the result
    that lands a moment later.
    """
    messages = [
        _text_msg(AuthorRole.SYSTEM, "system prompt"),
        _text_msg(AuthorRole.USER, "mission"),
    ]
    for i in range(1, 5):
        messages += [_call_with_id(i), _result_with_id(i)]
    messages.append(_call_with_id("live"))
    cfg = CondensationConfig(enabled=True, recent_message_window=2)
    condenser = ContextCondenser(config=cfg)
    out, _ = await condenser._pass_threshold(messages, None, cfg)
    assert _item_ids(out, FunctionCallContent) == ["call-live"]
    assert _pairing(out) == (0, 1)  # still in flight — nothing orphaned


def _parallel_group(g, results: int = 2) -> list:
    """One assistant message issuing two calls, plus ``results`` of their
    result messages (1 = the sibling is still in flight)."""
    group = [
        ChatMessageContent(
            role=AuthorRole.ASSISTANT,
            items=[
                FunctionCallContent(id=f"call-{g}a", function_name="t", arguments="{}"),
                FunctionCallContent(id=f"call-{g}b", function_name="t", arguments="{}"),
            ],
        ),
        _result_with_id(f"{g}a"),
    ]
    if results == 2:
        group.append(_result_with_id(f"{g}b"))
    return group


@pytest.mark.asyncio
async def test_threshold_trims_parallel_call_groups_whole():
    messages = [
        _text_msg(AuthorRole.SYSTEM, "system prompt"),
        _text_msg(AuthorRole.USER, "mission"),
    ]
    for g in range(1, 4):
        messages += _parallel_group(g)
    cfg = CondensationConfig(enabled=True, recent_message_window=4)
    condenser = ContextCondenser(config=cfg)
    out, m = await condenser._pass_threshold(messages, None, cfg)
    assert m.messages_out == 5  # system + mission + the last group (3 messages)
    assert _item_ids(out, FunctionCallContent) == ["call-3a", "call-3b"]
    assert _item_ids(out, FunctionResultContent) == ["call-3a", "call-3b"]
    assert _pairing(out) == (0, 0)


@pytest.mark.asyncio
async def test_threshold_never_trims_a_partially_resolved_parallel_group():
    """A sibling result still in flight freezes its whole group.

    SK appends each parallel call's result when its own filter chain
    returns, so mid-turn the live history can hold a two-call group with
    one result. Trimming the group would orphan the sibling landing next.
    """
    messages = [
        _text_msg(AuthorRole.SYSTEM, "system prompt"),
        _text_msg(AuthorRole.USER, "mission"),
    ]
    for g in range(1, 3):
        messages += _parallel_group(g)
    messages += _parallel_group(3, results=1)
    # keep=1: the floor alone would let the pass trim the last group.
    cfg = CondensationConfig(enabled=True, recent_message_window=1)
    condenser = ContextCondenser(config=cfg)
    out, _ = await condenser._pass_threshold(messages, None, cfg)
    assert _item_ids(out, FunctionCallContent) == ["call-3a", "call-3b"]
    assert _item_ids(out, FunctionResultContent) == ["call-3a"]
    assert _pairing(out) == (0, 1)


@pytest.mark.asyncio
async def test_threshold_drops_a_parallel_group_whole_when_the_target_crosses_inside_it():
    """The soft target may fall INSIDE a group: one big result, one small.

    Legacy popped the call message, then the big result, reached the
    target and stopped — leaving the small sibling result orphaned.
    """
    messages = [
        _text_msg(AuthorRole.SYSTEM, "system prompt"),
        _text_msg(AuthorRole.USER, "mission"),
        ChatMessageContent(
            role=AuthorRole.ASSISTANT,
            items=[
                FunctionCallContent(id="call-1a", function_name="t", arguments="{}"),
                FunctionCallContent(id="call-1b", function_name="t", arguments="{}"),
            ],
        ),
        _result_with_id("1a", payload="y" * 2_000),  # ~500 tokens
        _result_with_id("1b"),  # ~0 token
        _text_msg(AuthorRole.USER, "latest question"),
    ]
    cfg = CondensationConfig(
        enabled=True, recent_message_window=2, trigger_fraction=0.5
    )
    condenser = ContextCondenser(config=cfg)
    out, _ = await condenser._pass_threshold(messages, 1000, cfg)  # target: 300 tok
    assert _pairing(out) == (0, 0)
    assert [_message_text(msg) for msg in out] == [
        "system prompt",
        "mission",
        "latest question",
    ]


def _legacy_threshold(messages, context_window, cfg):
    """Pass 4 as it ran before #4816, verbatim — the characterization oracle.

    Wherever the old algorithm kept every pair whole, the new one must
    reproduce it message for message.
    """
    keep = max(cfg.recent_message_window, 1)
    if len(messages) <= keep:
        return list(messages)
    target = None
    if context_window and cfg.trigger_fraction is not None:
        target = int(context_window * cfg.trigger_fraction * 0.6)
    out = list(messages)
    while len(out) > keep:
        total = sum(_message_tokens(m) for m in out)
        if target is not None and total <= target:
            break
        first_user_idx = next(
            (i for i, m in enumerate(out) if m.role == AuthorRole.USER), None
        )
        idx = next(
            (
                i
                for i, m in enumerate(out)
                if m.role != AuthorRole.SYSTEM and i != first_user_idx
            ),
            None,
        )
        if idx is None:
            break
        out.pop(idx)
    return out


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "call_size,result_size",
    [(20, 20), (2_000, 20), (20, 6_000), (2_000, 6_000)],
)
@pytest.mark.parametrize("pairs", [0, 1, 2, 3, 5])
@pytest.mark.parametrize("keep", [1, 2, 3, 4, 6])
@pytest.mark.parametrize("target", [None, 300, 30_000])
@pytest.mark.parametrize("calls_per_message", [1, 2])
async def test_threshold_is_legacy_identical_where_legacy_kept_pairs_whole(
    pairs, keep, target, call_size, result_size, calls_per_message
):
    messages = [
        _text_msg(AuthorRole.SYSTEM, "system prompt"),
        _text_msg(AuthorRole.USER, "mission"),
    ]
    for i in range(1, pairs + 1):
        suffixes = "ab"[:calls_per_message]
        messages.append(
            ChatMessageContent(
                role=AuthorRole.ASSISTANT,
                items=[
                    FunctionCallContent(
                        id=f"call-{i}{suffix}",
                        function_name="t",
                        arguments="x" * call_size,
                    )
                    for suffix in suffixes
                ],
            )
        )
        messages += [
            _result_with_id(f"{i}{suffix}", payload="y" * result_size)
            for suffix in suffixes
        ]
    messages.append(_text_msg(AuthorRole.USER, "latest question"))

    cfg = CondensationConfig(enabled=True, recent_message_window=keep)
    window = None
    if target is not None:
        cfg.trigger_fraction = 0.5
        window = int(target / 0.5 / 0.6)  # same derivation as the pass
    condenser = ContextCondenser(config=cfg)

    baseline = _pairing(messages)
    legacy = _legacy_threshold(messages, window, cfg)
    out, _ = await condenser._pass_threshold(messages, window, cfg)

    assert _pairing(out) == baseline, "the new pass broke a pair the input had"
    if _pairing(legacy) == baseline:
        assert [id(msg) for msg in out] == [id(msg) for msg in legacy], (
            "diverged from the legacy output where that output was pairing-safe"
        )


# ---------------------------------------------------------------------------
# Pass 2 (#4816): pruning a tool result must keep the pair identity
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_truncate_old_tools_preserves_the_tool_call_id():
    """Pruning rewrites the payload only — the pair identity must survive.

    SK renders a TOOL message's wire field as ``items[0].id or ""``
    (``ChatMessageContent.to_dict``), so a rebuilt FunctionResultContent
    that dropped ``id`` sent ``tool_call_id: ""`` — a result nothing on
    the wire ties to its call.
    """
    messages = []
    for i in range(1, 5):
        messages.append(
            ChatMessageContent(
                role=AuthorRole.ASSISTANT,
                items=[
                    FunctionCallContent(
                        id=f"call-{i}",
                        plugin_name="nb",
                        function_name="update_cell",
                        arguments="{}",
                    )
                ],
            )
        )
        messages.append(
            ChatMessageContent(
                role=AuthorRole.TOOL,
                items=[
                    FunctionResultContent(
                        id=f"call-{i}",
                        plugin_name="nb",
                        function_name="update_cell",
                        result="r" * 40,
                    )
                ],
            )
        )
    cfg = CondensationConfig(enabled=True, tool_result_window=2)
    condenser = ContextCondenser(config=cfg)
    out, _ = await condenser._pass_truncate_old_tools(messages, cfg)

    wire = [msg.to_dict() for msg in out if msg.role == AuthorRole.TOOL]
    assert [w["tool_call_id"] for w in wire] == [f"call-{i}" for i in range(1, 5)]
    assert wire[0]["content"].startswith("[tool result pruned")
    assert wire[1]["content"].startswith("[tool result pruned")
    assert wire[2]["content"] == "r" * 40
    assert wire[3]["content"] == "r" * 40
    # plugin_name rides along too (SK 1.42 field, read by the connector)
    kept = [
        item
        for msg in out
        for item in msg.items
        if isinstance(item, FunctionResultContent)
    ]
    assert all(item.plugin_name == "nb" for item in kept)