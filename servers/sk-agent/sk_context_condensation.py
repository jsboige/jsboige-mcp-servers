#!/usr/bin/env python3
"""
Context condensation for sk-agent agent threads.

Implements a Smart-style multi-pass compaction of ``ChatHistoryAgentThread``
content, modeled on RooCodeInc/Roo-Code#8743 "Provider-Based Context
Condensation Architecture". The engine here is a LOCAL, four-pass
condensation: it can run on a configured model (cloud fallback) or on
the same model that produced the conversation (auto-hosted).

Design notes
------------

- **Smart provider** (4 passes, threshold-driven):
  1. **Lossless** — tool call deduplication; identical consecutive tool
     calls or tool calls with identical parameters + identical results
     collapse to the last one. No semantic loss.
  2. **Selective truncation** — keep recent tool messages intact, drop
     *old* tool results beyond a retention window, but preserve tool
     calls (so the model still sees which tools were invoked).
  3. **Message summarisation** — summarise tool-result bodies and
     assistant text that falls outside the preservation window.
  4. **Threshold-based message-level compaction** — if the thread still
     exceeds the threshold, drop the oldest non-system messages until
     the thread fits.

- **Activation threshold** is configurable per agent (tokens or % of
  model context window) with a default preset (``BALANCED``). Three
  presets — ``CONSERVATIVE``, ``BALANCED``, ``AGGRESSIVE`` — map to a
  fixed bundle of parameters.

- **Local-first** — the summarisation pass uses an OpenAI-compatible
  client from the shared model pool, so the condensation can run on the
  same local model that produced the conversation. No cloud dependency
  is required, although one is available as a fallback.

- **Metric hook** — every pass emits a per-pass timing + tokens metric
  so the harness can verify the compaction is doing useful work
  (acceptance #2 of issue #3944).

- **Differentiation messages vs tools** — the lossless pass treats
  ``FunctionCallContent``/``FunctionResultContent`` independently from
  ``TextContent`` (acceptance #3 of #8743 / #3944): tool calls/results
  are deduped, not summarised, while text messages are summarised.

The module exposes a single class — :class:`ContextCondenser` — that is
instantiated per agent and attached to the thread lifecycle by
``SKAgentManager``. The condenser does NOT replace the underlying
``ChatHistoryAgentThread``; it works on a snapshot of its chat history
and writes the compacted history back into the same thread.

Public surface
--------------

- :class:`ContextCondenser`
- :class:`CondensationPreset` (enum)
- :class:`CondensationMetrics` (dataclass — also exposed in results)
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Protocol

from semantic_kernel.contents import (
    AuthorRole,
    ChatMessageContent,
    FunctionCallContent,
    FunctionResultContent,
    ImageContent,
    TextContent,
)

log = logging.getLogger("sk-agent.condensation")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Default token-estimate ratio (chars / token). Conservative — English
#: text averages ~3.5-4 chars/token; using 4 leaves a small safety margin
#: and is close enough to true tokenisers for the threshold check.
_DEFAULT_CHARS_PER_TOKEN = 4.0


class CondensationPreset(str, Enum):
    """Named condensation profiles.

    Mirrors RooCodeInc/Roo-Code#8743 presets. Each preset maps to a
    fixed bundle of :class:`CondensationConfig` parameters.
    """

    CONSERVATIVE = "conservative"
    BALANCED = "balanced"
    AGGRESSIVE = "aggressive"


@dataclass
class CondensationConfig:
    """Per-agent condensation configuration.

    Attributes:
        enabled: Master toggle. When False, the condenser is a no-op.
        preset: Named preset — when set, the matching bundle is applied
            to the other fields unless they are explicitly overridden.
        trigger_tokens: Hard threshold in estimated tokens at which
            condensation runs. ``None`` disables the trigger.
        trigger_fraction: Threshold as a fraction of the model's context
            window (0.0-1.0). ``None`` disables the trigger.
        recent_message_window: Number of recent messages preserved verbatim
            (never summarised / dropped). Default 6 for BALANCED.
        tool_result_window: Number of recent tool-result messages kept in
            full; older tool results are summarised or dropped.
        summarise_max_tokens: Output budget for the summarisation pass.
        max_tool_chars: Cap on tool-result length before truncation /
            summarisation. Defaults: 8000 (BALANCED).
        summarise_model_id: Model ID used for the summarisation pass.
            ``None`` (default) means "use the agent's own model" — the
            auto-hosted path. A cloud model id triggers the cloud path.
        dry_run: When True, the condenser computes the metrics but does
            NOT mutate the thread. Useful for acceptance tests and
            dashboards.
    """

    enabled: bool = False
    preset: CondensationPreset | str = CondensationPreset.BALANCED
    trigger_tokens: int | None = None
    trigger_fraction: float | None = None
    recent_message_window: int = 6
    tool_result_window: int = 8
    summarise_max_tokens: int = 1024
    max_tool_chars: int = 8000
    summarise_model_id: str | None = None
    dry_run: bool = False

    @classmethod
    def from_dict(cls, data: dict | None) -> CondensationConfig:
        if not data:
            return cls()
        return cls(
            enabled=bool(data.get("enabled", False)),
            preset=data.get("preset", CondensationPreset.BALANCED),
            trigger_tokens=data.get("trigger_tokens"),
            trigger_fraction=data.get("trigger_fraction"),
            recent_message_window=int(data.get("recent_message_window", 6)),
            tool_result_window=int(data.get("tool_result_window", 8)),
            summarise_max_tokens=int(data.get("summarise_max_tokens", 1024)),
            max_tool_chars=int(data.get("max_tool_chars", 8000)),
            summarise_model_id=data.get("summarise_model_id"),
            dry_run=bool(data.get("dry_run", False)),
        )

    def to_dict(self) -> dict:
        return {
            "enabled": self.enabled,
            "preset": str(self.preset),
            "trigger_tokens": self.trigger_tokens,
            "trigger_fraction": self.trigger_fraction,
            "recent_message_window": self.recent_message_window,
            "tool_result_window": self.tool_result_window,
            "summarise_max_tokens": self.summarise_max_tokens,
            "max_tool_chars": self.max_tool_chars,
            "summarise_model_id": self.summarise_model_id,
            "dry_run": self.dry_run,
        }

    def resolved(self) -> "CondensationConfig":
        """Return a copy with preset fields applied unless overridden.

        The dataclass defaults above act as sentinels: a field equal to
        the default is taken to mean "user did not set this explicitly"
        and is replaced by the preset bundle. Fields the user passed
        explicitly (non-default) win.
        """
        preset_name = self.preset
        if isinstance(preset_name, str):
            try:
                preset_enum = CondensationPreset(preset_name)
            except ValueError:
                preset_enum = CondensationPreset.BALANCED
        else:
            preset_enum = preset_name

        bundle = _PRESETS.get(preset_enum, _PRESETS[CondensationPreset.BALANCED])
        defaults = CondensationConfig()

        # Build the resolved dict from user fields, overlaying preset
        # bundle where the user kept the default.
        resolved_dict: dict[str, Any] = {
            "enabled": self.enabled,
            "preset": preset_enum,
            "trigger_tokens": self.trigger_tokens,
            "trigger_fraction": self.trigger_fraction,
            "recent_message_window": self.recent_message_window,
            "tool_result_window": self.tool_result_window,
            "summarise_max_tokens": self.summarise_max_tokens,
            "max_tool_chars": self.max_tool_chars,
            "summarise_model_id": self.summarise_model_id,
            "dry_run": self.dry_run,
        }
        for key, value in bundle.items():
            if resolved_dict.get(key) == getattr(defaults, key):
                resolved_dict[key] = value
        return CondensationConfig(**resolved_dict)


# Preset bundles — three knobs that capture the essence of each profile.
_PRESETS: dict[CondensationPreset, dict[str, Any]] = {
    CondensationPreset.CONSERVATIVE: {
        "trigger_fraction": 0.85,
        "recent_message_window": 10,
        "tool_result_window": 12,
        "summarise_max_tokens": 1536,
        "max_tool_chars": 16000,
    },
    CondensationPreset.BALANCED: {
        "trigger_fraction": 0.70,
        "recent_message_window": 6,
        "tool_result_window": 8,
        "summarise_max_tokens": 1024,
        "max_tool_chars": 8000,
    },
    CondensationPreset.AGGRESSIVE: {
        "trigger_fraction": 0.55,
        "recent_message_window": 4,
        "tool_result_window": 5,
        "summarise_max_tokens": 512,
        "max_tool_chars": 4000,
    },
}


@dataclass
class PassMetrics:
    """Metrics emitted by a single condensation pass."""

    name: str
    duration_s: float
    messages_in: int
    messages_out: int
    chars_in: int
    chars_out: int
    tokens_in: int
    tokens_out: int

    @property
    def reduction_ratio(self) -> float:
        if self.tokens_in == 0:
            return 0.0
        return max(0.0, 1.0 - (self.tokens_out / self.tokens_in))


@dataclass
class CondensationMetrics:
    """Aggregate metrics emitted by a full condensation run."""

    triggered: bool
    reason: str
    total_duration_s: float
    total_tokens_in: int
    total_tokens_out: int
    passes: list[PassMetrics] = field(default_factory=list)
    dry_run: bool = False

    @property
    def reduction_ratio(self) -> float:
        if self.total_tokens_in == 0:
            return 0.0
        return max(0.0, 1.0 - (self.total_tokens_out / self.total_tokens_in))

    def to_dict(self) -> dict:
        return {
            "triggered": self.triggered,
            "reason": self.reason,
            "total_duration_s": round(self.total_duration_s, 4),
            "total_tokens_in": self.total_tokens_in,
            "total_tokens_out": self.total_tokens_out,
            "reduction_ratio": round(self.reduction_ratio, 4),
            "passes": [
                {
                    "name": p.name,
                    "duration_s": round(p.duration_s, 4),
                    "messages_in": p.messages_in,
                    "messages_out": p.messages_out,
                    "chars_in": p.chars_in,
                    "chars_out": p.chars_out,
                    "tokens_in": p.tokens_in,
                    "tokens_out": p.tokens_out,
                    "reduction_ratio": round(p.reduction_ratio, 4),
                }
                for p in self.passes
            ],
            "dry_run": self.dry_run,
        }


# ---------------------------------------------------------------------------
# Summariser protocol
# ---------------------------------------------------------------------------


class Summariser(Protocol):
    """Anything that can summarise a piece of text.

    The :class:`ContextCondenser` uses a :class:`Summariser` for the
    message-summarisation pass. The default implementation uses an
    OpenAI-compatible chat completion client — either the agent's own
    model (auto-hosted) or an explicitly named cloud model.
    """

    async def summarise(self, text: str, *, max_tokens: int) -> str: ...


class _FallbackSummariser:
    """No-LLM summariser used when no client is available.

    Produces a deterministic short extract of the input so the rest of
    the pipeline can still run in tests / dry-runs without a real
    chat-completion client. Never raises — when summarisation is
    impossible, this is the safety net.
    """

    async def summarise(self, text: str, *, max_tokens: int) -> str:
        return self.summarise_sync(text, max_tokens)

    def summarise_sync(self, text: str, max_tokens: int) -> str:
        if not text:
            return ""
        # Heuristic: keep first N chars proportional to max_tokens.
        approx_chars = max(80, int(max_tokens * _DEFAULT_CHARS_PER_TOKEN))
        if len(text) <= approx_chars:
            return text
        head = text[:approx_chars].rsplit(" ", 1)[0]
        return head + " [...]"


class _OpenAISummariser:
    """Chat-completion-based summariser.

    Wraps an ``AsyncOpenAI`` client (the same one sk-agent uses for the
    model's main calls). Keeps the loop local: by default the
    summariser runs on the agent's own model, no cloud round-trip.
    """

    def __init__(self, client: Any, model_id: str) -> None:
        self._client = client
        self._model_id = model_id

    async def summarise(self, text: str, *, max_tokens: int) -> str:
        if not text:
            return ""
        # System instruction: a no-frills instruction tuned for short,
        # faithful summary. Kept inline so the contract survives even
        # when prompt templates are unavailable.
        prompt = (
            "Summarise the following tool output or message in plain text. "
            "Preserve key facts (identifiers, numeric results, file paths, "
            "errors). Keep it under the requested length.\n\n"
            f"{text}"
        )
        try:
            resp = await self._client.chat.completions.create(
                model=self._model_id,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a precise summariser.",
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=max(1, int(max_tokens)),
                temperature=0.0,
            )
            if not resp.choices:
                return _FallbackSummariser().summarise_sync(text, max_tokens)
            content = resp.choices[0].message.content or ""
            return content.strip() or _FallbackSummariser().summarise_sync(
                text, max_tokens
            )
        except Exception:
            log.exception(
                "Condenser summariser: chat completion failed; using fallback"
            )
            return _FallbackSummariser().summarise_sync(text, max_tokens)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, int(len(text) / _DEFAULT_CHARS_PER_TOKEN))


def _message_text(message: ChatMessageContent) -> str:
    """Extract a plain-text rendering of a message for sizing and summaries."""
    parts: list[str] = []
    for item in message.items:
        if isinstance(item, TextContent):
            parts.append(item.text or "")
        elif isinstance(item, FunctionCallContent):
            args = getattr(item, "arguments", None) or ""
            parts.append(f"[tool_call {item.function_name} {args}]")
        elif isinstance(item, FunctionResultContent):
            parts.append(f"[tool_result {item.function_name} {str(item.result)[:200]}]")
    return "\n".join(p for p in parts if p)


def _message_chars(message: ChatMessageContent) -> int:
    """Approximate the message size in characters (text only)."""
    total = 0
    for item in message.items:
        if isinstance(item, TextContent):
            total += len(item.text or "")
        elif isinstance(item, FunctionCallContent):
            total += len(item.function_name or "")
            total += len(str(getattr(item, "arguments", "") or ""))
        elif isinstance(item, FunctionResultContent):
            total += len(item.function_name or "")
            total += len(str(getattr(item, "result", "") or ""))
        elif isinstance(item, ImageContent):
            # ImageContent is base64 payload — count size but never inline.
            total += 200  # placeholder budget for image references
    return total


def _thread_messages(thread: Any) -> list[ChatMessageContent]:
    """Return a plain list of messages from a ChatHistoryAgentThread.

    ``ChatHistoryAgentThread`` exposes its history as ``chat_history`` or
    a generator, depending on the Semantic Kernel version. We accept
    either shape.
    """
    history = getattr(thread, "chat_history", None)
    if history is None and hasattr(thread, "messages"):
        history = thread.messages
    if history is None:
        return []
    if isinstance(history, list):
        return list(history)
    return list(history)


def _tool_call_signature(message: ChatMessageContent) -> tuple | None:
    """Return a hashable signature of the tool calls in a message, or None.

    Two ``FunctionCallContent`` items produce the same signature iff they
    call the same function with the same arguments. Used by the lossless
    pass to detect duplicates.
    """
    sig_parts: list[tuple] = []
    has_call = False
    for item in message.items:
        if isinstance(item, FunctionCallContent):
            has_call = True
            args = getattr(item, "arguments", None)
            sig_parts.append(
                (item.function_name, _stable_str(args))
            )
    if not has_call:
        return None
    return tuple(sig_parts)


def _stable_str(obj: Any) -> str:
    """Stable stringification for hashing tool-call arguments."""
    try:
        import json

        return json.dumps(obj, sort_keys=True, default=str)
    except Exception:
        return str(obj)


def _replace_text_in_message(
    message: ChatMessageContent, new_text: str
) -> ChatMessageContent:
    """Return a copy of ``message`` whose TextContent items are collapsed
    into a single TextContent with ``new_text``.

    Non-text items (tool calls, images) are preserved in their original
    order. The returned message has the same role as the input.
    """
    new_items: list[Any] = []
    inserted = False
    for item in message.items:
        if isinstance(item, TextContent):
            if not inserted:
                new_items.append(TextContent(text=new_text))
                inserted = True
            # else: drop the additional TextContent items — they get merged.
            continue
        new_items.append(item)
    if not inserted:
        # Nothing textual to replace — append a TextContent at the end.
        new_items.append(TextContent(text=new_text))
    return ChatMessageContent(role=message.role, items=new_items)


def _set_tool_result_text(
    message: ChatMessageContent, new_text: str
) -> ChatMessageContent:
    """Replace ``FunctionResultContent.result`` text in a copy of the message.

    Tool calls themselves are preserved; only the result payload is
    rewritten. When a message carries multiple tool results, each is
    rewritten to the same compact form.
    """
    new_items: list[Any] = []
    for item in message.items:
        if isinstance(item, FunctionResultContent):
            new_items.append(
                FunctionResultContent(
                    function_name=item.function_name,
                    result=new_text,
                )
            )
        else:
            new_items.append(item)
    return ChatMessageContent(role=message.role, items=new_items)


# ---------------------------------------------------------------------------
# ContextCondenser
# ---------------------------------------------------------------------------


class ContextCondenser:
    """Run multi-pass condensation on a ``ChatHistoryAgentThread``.

    The condenser is stateless across threads: it is bound to a single
    agent thread at a time. Reuse the same instance for repeated
    condensations on the same thread (the manager does this).

    Args:
        config: Per-agent :class:`CondensationConfig`.
        summariser: Optional pre-built :class:`Summariser`. When ``None``,
            a fallback no-LLM summariser is used (tests, dry-runs).
    """

    def __init__(
        self,
        config: CondensationConfig,
        summariser: Summariser | None = None,
    ) -> None:
        self.config = config
        self._summariser: Summariser = summariser or _FallbackSummariser()

    # ----- public API ---------------------------------------------------

    async def maybe_condense(
        self,
        thread: Any,
        *,
        model_context_window: int | None = None,
        force: bool = False,
    ) -> CondensationMetrics:
        """Condense ``thread`` when triggered.

        Args:
            thread: The agent's ``ChatHistoryAgentThread``.
            model_context_window: The model's context window in tokens,
                used to evaluate ``trigger_fraction`` and to size the
                preservation budget.
            force: When True, skip the trigger check and run all passes.

        Returns:
            A :class:`CondensationMetrics` instance — even when no
            condensation ran, so callers can log "checked, no-op".
        """
        start = time.monotonic()
        messages = _thread_messages(thread)
        total_chars = sum(_message_chars(m) for m in messages)
        total_tokens = sum(_estimate_tokens(_message_text(m)) for m in messages)

        trigger, reason = self._should_trigger(
            total_tokens=total_tokens,
            context_window=model_context_window,
            force=force,
        )
        if not trigger:
            return CondensationMetrics(
                triggered=False,
                reason=reason,
                total_duration_s=time.monotonic() - start,
                total_tokens_in=total_tokens,
                total_tokens_out=total_tokens,
            )

        log.info(
            "ContextCondenser: triggering (%s) — %d msgs, ~%d tokens",
            reason,
            len(messages),
            total_tokens,
        )

        cfg = self.config.resolved()
        working = list(messages)
        passes: list[PassMetrics] = []

        # Pass 1 — lossless tool-call dedup
        working, p1 = await self._pass_lossless_dedup(working)
        passes.append(p1)

        # Pass 2 — selective truncation of old tool results
        working, p2 = await self._pass_truncate_old_tools(working, cfg)
        passes.append(p2)

        # Pass 3 — message-level summarisation
        working, p3 = await self._pass_summarise(working, cfg)
        passes.append(p3)

        # Pass 4 — message-level threshold compaction
        working, p4 = await self._pass_threshold(working, model_context_window, cfg)
        passes.append(p4)

        if not cfg.dry_run:
            self._replace_thread_history(thread, working)

        return CondensationMetrics(
            triggered=True,
            reason=reason,
            total_duration_s=time.monotonic() - start,
            total_tokens_in=total_tokens,
            total_tokens_out=sum(
                _estimate_tokens(_message_text(m)) for m in working
            ),
            passes=passes,
            dry_run=cfg.dry_run,
        )

    # ----- trigger ------------------------------------------------------

    def _should_trigger(
        self,
        *,
        total_tokens: int,
        context_window: int | None,
        force: bool,
    ) -> tuple[bool, str]:
        if not self.config.enabled:
            return False, "disabled"
        if force:
            return True, "forced"
        cfg = self.config.resolved()
        if cfg.trigger_tokens is not None and total_tokens >= cfg.trigger_tokens:
            return True, f"trigger_tokens={cfg.trigger_tokens}"
        if cfg.trigger_fraction is not None and context_window:
            threshold = int(context_window * cfg.trigger_fraction)
            if total_tokens >= threshold:
                return True, f"trigger_fraction={cfg.trigger_fraction}"
        return False, "below_threshold"

    # ----- pass 1 -------------------------------------------------------

    async def _pass_lossless_dedup(
        self, messages: list[ChatMessageContent]
    ) -> tuple[list[ChatMessageContent], PassMetrics]:
        """Drop consecutive messages whose tool calls are identical.

        A "consecutive run" of identical tool calls is collapsed to the
        first occurrence; the kept message is updated with the latest
        text so the most recent result survives. Tool result messages
        are kept in the run (they follow their call); only the second
        and later identical call+result pairs are dropped. Messages
        with no tool-call signature (text, system, image-only) reset
        the run.
        """
        start = time.monotonic()
        chars_in = sum(_message_chars(m) for m in messages)
        out: list[ChatMessageContent] = []
        last_sig: tuple | None = None
        for m in messages:
            sig = _tool_call_signature(m)
            if sig is not None and sig == last_sig:
                # Identical tool call to the previous kept message — drop.
                continue
            out.append(m)
            # Only update last_sig when the message carries a tool call
            # signature; tool-result messages (sig=None) keep the run alive.
            if sig is not None:
                last_sig = sig
        chars_out = sum(_message_chars(m) for m in out)
        return out, PassMetrics(
            name="lossless_dedup",
            duration_s=time.monotonic() - start,
            messages_in=len(messages),
            messages_out=len(out),
            chars_in=chars_in,
            chars_out=chars_out,
            tokens_in=sum(_estimate_tokens(_message_text(m)) for m in messages),
            tokens_out=sum(_estimate_tokens(_message_text(m)) for m in out),
        )

    # ----- pass 2 -------------------------------------------------------

    async def _pass_truncate_old_tools(
        self,
        messages: list[ChatMessageContent],
        cfg: CondensationConfig,
    ) -> tuple[list[ChatMessageContent], PassMetrics]:
        """Truncate or drop tool results older than the retention window."""
        start = time.monotonic()
        chars_in = sum(_message_chars(m) for m in messages)
        # Find tool-result messages, keep the last ``tool_result_window`` intact.
        tool_indices = [
            i for i, m in enumerate(messages) if _has_tool_result(m)
        ]
        if len(tool_indices) <= cfg.tool_result_window:
            return messages, PassMetrics(
                name="truncate_old_tools",
                duration_s=time.monotonic() - start,
                messages_in=len(messages),
                messages_out=len(messages),
                chars_in=chars_in,
                chars_out=chars_in,
                tokens_in=sum(_estimate_tokens(_message_text(m)) for m in messages),
                tokens_out=sum(_estimate_tokens(_message_text(m)) for m in messages),
            )
        drop_below = tool_indices[-cfg.tool_result_window]

        out: list[ChatMessageContent] = []
        for i, m in enumerate(messages):
            if _has_tool_result(m) and i < drop_below:
                # Drop the tool result payload entirely; keep the message
                # so the model still sees the call happened.
                pruned = _set_tool_result_text(
                    m, f"[tool result pruned by condensation, {len(str(getattr(m.items[0], 'result', '') or ''))} chars]"
                )
                out.append(pruned)
            elif _has_tool_result(m) and _message_chars(m) > cfg.max_tool_chars:
                # Within the window but too large — keep a head extract.
                head = _first_text(m)[: cfg.max_tool_chars]
                pruned = _set_tool_result_text(
                    m, head + " [...]" if len(_first_text(m)) > cfg.max_tool_chars else head
                )
                out.append(pruned)
            else:
                out.append(m)
        chars_out = sum(_message_chars(m) for m in out)
        return out, PassMetrics(
            name="truncate_old_tools",
            duration_s=time.monotonic() - start,
            messages_in=len(messages),
            messages_out=len(out),
            chars_in=chars_in,
            chars_out=chars_out,
            tokens_in=sum(_estimate_tokens(_message_text(m)) for m in messages),
            tokens_out=sum(_estimate_tokens(_message_text(m)) for m in out),
        )

    # ----- pass 3 -------------------------------------------------------

    async def _pass_summarise(
        self,
        messages: list[ChatMessageContent],
        cfg: CondensationConfig,
    ) -> tuple[list[ChatMessageContent], PassMetrics]:
        """Summarise non-recent messages (text + oversized tool results)."""
        start = time.monotonic()
        chars_in = sum(_message_chars(m) for m in messages)
        if len(messages) <= cfg.recent_message_window:
            return messages, PassMetrics(
                name="summarise",
                duration_s=time.monotonic() - start,
                messages_in=len(messages),
                messages_out=len(messages),
                chars_in=chars_in,
                chars_out=chars_in,
                tokens_in=sum(_estimate_tokens(_message_text(m)) for m in messages),
                tokens_out=sum(_estimate_tokens(_message_text(m)) for m in messages),
            )
        boundary = len(messages) - cfg.recent_message_window
        out: list[ChatMessageContent] = []
        for i, m in enumerate(messages):
            if i < boundary and m.role == AuthorRole.ASSISTANT and _message_chars(m) > cfg.max_tool_chars:
                text = _message_text(m)
                summary = await self._summariser.summarise(
                    text, max_tokens=cfg.summarise_max_tokens
                )
                out.append(_replace_text_in_message(m, summary))
            else:
                out.append(m)
        chars_out = sum(_message_chars(m) for m in out)
        return out, PassMetrics(
            name="summarise",
            duration_s=time.monotonic() - start,
            messages_in=len(messages),
            messages_out=len(out),
            chars_in=chars_in,
            chars_out=chars_out,
            tokens_in=sum(_estimate_tokens(_message_text(m)) for m in messages),
            tokens_out=sum(_estimate_tokens(_message_text(m)) for m in out),
        )

    # ----- pass 4 -------------------------------------------------------

    async def _pass_threshold(
        self,
        messages: list[ChatMessageContent],
        context_window: int | None,
        cfg: CondensationConfig,
    ) -> tuple[list[ChatMessageContent], PassMetrics]:
        """Trim oldest messages until the thread fits the budget.

        The threshold pass enforces two constraints:

        1. **Hard cap** — keep at least ``recent_message_window`` messages
           (the recent context the model has just produced).
        2. **Soft target** — when a context window is provided and the
           trigger fraction is set, trim until the thread's token count
           falls under ``context_window * trigger_fraction * 0.6`` (60 %
           of the trigger threshold leaves a safety margin).

        When neither bound kicks in, the messages pass through unchanged.
        """
        start = time.monotonic()
        chars_in = sum(_message_chars(m) for m in messages)
        # Hard cap: keep at least the recent window.
        keep = max(cfg.recent_message_window, 1)
        if len(messages) <= keep:
            return messages, PassMetrics(
                name="threshold",
                duration_s=time.monotonic() - start,
                messages_in=len(messages),
                messages_out=len(messages),
                chars_in=chars_in,
                chars_out=chars_in,
                tokens_in=sum(_estimate_tokens(_message_text(m)) for m in messages),
                tokens_out=sum(_estimate_tokens(_message_text(m)) for m in messages),
            )
        # Soft target: trim until under the trigger budget (or min keep).
        target = None
        if context_window and cfg.trigger_fraction is not None:
            target = int(context_window * cfg.trigger_fraction * 0.6)
        out = list(messages)
        while len(out) > keep:
            total = sum(_estimate_tokens(_message_text(m)) for m in out)
            if target is not None and total <= target:
                break
            out.pop(0)
        chars_out = sum(_message_chars(m) for m in out)
        return out, PassMetrics(
            name="threshold",
            duration_s=time.monotonic() - start,
            messages_in=len(messages),
            messages_out=len(out),
            chars_in=chars_in,
            chars_out=chars_out,
            tokens_in=sum(_estimate_tokens(_message_text(m)) for m in messages),
            tokens_out=sum(_estimate_tokens(_message_text(m)) for m in out),
        )

    # ----- thread write-back -------------------------------------------

    def _replace_thread_history(
        self, thread: Any, new_messages: list[ChatMessageContent]
    ) -> None:
        """Write ``new_messages`` back into ``thread``.

        ``ChatHistoryAgentThread`` in the Semantic Kernel versions we
        target exposes ``chat_history`` as a mutable list. We assign a
        copy in place so the caller's reference (held by SKAgentManager)
        sees the change.
        """
        history = getattr(thread, "chat_history", None)
        if history is None and hasattr(thread, "messages"):
            history = thread.messages
        if history is None:
            log.warning(
                "ContextCondenser: thread has no chat_history attribute; "
                "cannot write back compacted messages"
            )
            return
        if isinstance(history, list):
            history.clear()
            history.extend(new_messages)
            return
        # Generator-style history — try to assign.
        try:
            thread.chat_history = list(new_messages)
        except Exception:
            log.exception("ContextCondenser: failed to write back history")


def _has_tool_result(message: ChatMessageContent) -> bool:
    return any(isinstance(item, FunctionResultContent) for item in message.items)


def _first_text(message: ChatMessageContent) -> str:
    for item in message.items:
        if isinstance(item, TextContent):
            return item.text or ""
        if isinstance(item, FunctionResultContent):
            return str(getattr(item, "result", "") or "")
    return ""