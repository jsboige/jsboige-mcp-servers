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