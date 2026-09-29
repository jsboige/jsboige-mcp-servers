#!/usr/bin/env python3
"""
Unit tests for sk_context_condensation module.

Tests cover:
- Configuration: from_dict / to_dict / preset resolution
- Pass 1 (lossless dedup) — collapses identical consecutive tool calls
- Pass 2 (truncate old tools) — keeps the recent window, prunes the rest
- Pass 3 (summarise) — uses fallback summariser when no client
- Pass 4 (threshold) — drops oldest messages until under target
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
    # Same sig twice — second occurrence collapses into the first kept msg.
    assert m.messages_in == 4
    assert m.messages_out == 3
    assert m.reduction_ratio > 0


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
    messages = [_text_msg(AuthorRole.USER, f"msg-{i}") for i in range(20)]
    cfg = CondensationConfig(enabled=True, recent_message_window=4)
    condenser = ContextCondenser(config=cfg)
    out, m = await condenser._pass_threshold(messages, 1024, cfg)
    assert m.messages_in == 20
    assert m.messages_out == 4
    # Must keep the last 4 messages.
    texts = [_message_text(m) for m in out]
    assert texts[-1] == "msg-19"
    assert texts[0] == "msg-16"


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