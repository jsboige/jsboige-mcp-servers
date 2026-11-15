"""Fine-grained turn control for sk-agent (#4742).

Implements the socle (P-a) and the pull-side round admission (P-b) of the
vllm nb-coder contract:

- **Round budget + gate admission between rounds.** An
  ``AUTO_FUNCTION_INVOCATION`` filter consults the per-turn
  :class:`TurnController` after each tool of a round completes. When the
  capacity gate refuses, or the per-call round budget is spent, the filter
  sets ``terminate`` — Semantic Kernel's loop then finishes every tool of
  the round (``asyncio.gather`` completes before the terminate check) and
  returns normally, committing the round's messages to the thread. The
  current round always completes; nothing in flight is killed.
- **Resumable pause.** A paused turn answers with the envelope
  ``status:"paused"``, ``paused:true``, ``resumable:true``, a non-empty
  ``"[paused: ...]"`` response, the ``conversation_id`` and the ``pause``
  block (reason, round where the loop stopped).
  ``options={"continue": true}`` on the next ``call_agent`` re-enters the
  loop over the committed history — no new user message, no replayed
  tools.
- **Idempotent defer across restarts.** Every executed tool call of the
  current turn epoch is journaled (name + arguments -> result). After a
  server restart, a resumed turn rebuilds its context by replaying model
  calls; the filter answers journaled tool calls from the journal instead
  of re-executing them. Replay stops at the first real execution of the
  resumed invoke — a tool deliberately re-called by the model later in the
  turn runs for real.
- **Durable conversations (opt-in).** ``SK_AGENT_CONVERSATION_DIR`` points
  at a directory where each conversation's user/assistant messages and its
  turn journal are persisted, surviving restarts.

The verdict of the pre-dispatch gate (#4712) stays authoritative for the
first model call; this module extends admission to every subsequent round.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

log = logging.getLogger("sk-agent.turns")

#: Env var enabling the durable conversation store (opt-in, #4742 P-a).
CONVERSATION_DIR_ENV = "SK_AGENT_CONVERSATION_DIR"

#: Gate refusal reasons surfaced in the pause envelope.
PAUSE_REASON_CAPACITY_GATE = "capacity_gate"
PAUSE_REASON_ROUND_BUDGET = "round_budget"

STATUS_COMPLETED = "completed"
STATUS_PAUSED = "paused"
STATUS_ERROR = "error"

#: The per-turn controller. Set around ``agent.invoke(...)`` in the
#: handlers; read by the kernel filter installed via
#: :func:`install_turn_filter`. Filters may run in ``asyncio.gather``
#: subtasks: they inherit (a copy of) the context, so reads work; writes
#: stay local to the subtask — the controller is mutated, never rebound.
_current_turn: contextvars.ContextVar["TurnController | None"] = (
    contextvars.ContextVar("sk_agent_current_turn", default=None)
)


def current_turn() -> TurnController | None:
    return _current_turn.get()


class _TurnContext:
    """Scoped activation of a controller (token-based, exception safe)."""

    def __init__(self, controller: TurnController):
        self._controller = controller
        self._token = None

    async def __aenter__(self) -> TurnController:
        self._token = _current_turn.set(self._controller)
        return self._controller

    async def __aexit__(self, *exc_info) -> None:
        _current_turn.reset(self._token)


#: Public alias — handlers import this to activate a controller.
TurnContext = _TurnContext


@dataclass
class TurnCallOptions:
    """Per-call turn-control options parsed from ``call_agent``'s options.

    ``continue_turn`` resumes the paused epoch of the same conversation:
    no new user message, the loop re-enters where it paused. Without a
    paused epoch there is nothing to resume: ``call_agent`` refuses the
    call as ``no_paused_epoch``.
    """

    continue_turn: bool = False
    round_budget: int | None = None


@dataclass
class EpochState:
    """A conversation's paused turn epoch, kept between calls.

    ``replay_from_disk`` marks epochs reconstructed after a restart: only
    those enable journal replay — an in-memory resume continues from the
    committed thread and must not answer later deliberate re-calls from
    the journal.
    """

    base_rounds: int = 0
    entries: dict[str, Any] = field(default_factory=dict)
    log: list[dict[str, Any]] = field(default_factory=list)
    replay_from_disk: bool = False
    agent_id: str = ""


@dataclass
class PauseInfo:
    """Why and where the loop stopped (pause is not an error)."""

    reason: str  # PAUSE_REASON_*
    round_index: int  # rounds completed in the epoch at pause
    retry_after_s: int | None = None
    gate_verdict: str | None = None
    gate_detail: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "reason": self.reason,
            "round_index": self.round_index,
        }
        if self.retry_after_s is not None:
            out["retry_after_s"] = self.retry_after_s
        if self.gate_verdict:
            out["gate_verdict"] = self.gate_verdict
        if self.gate_detail:
            out["gate_detail"] = self.gate_detail
        return out


@dataclass
class TurnController:
    """State of the turn being executed under one ``agent.invoke``.

    ``base_rounds`` carries the epoch's rounds completed before this
    invoke (0 for a fresh turn; journal's count for a resume).
    ``round_budget`` bounds the tool rounds admitted during THIS call —
    a resumed call gets a fresh budget while reporting cumulative
    ``round_index``.
    """

    conversation_id: str
    agent_id: str = ""
    base_rounds: int = 0
    round_budget: int | None = None
    #: Async callable -> refusal dict (same shape as
    #: check_model_capacity_gate) or None when admission passes.
    gate_check: Callable[[], Awaitable[dict[str, Any] | None]] | None = None
    #: Epoch journal entries (key -> result), loaded for replay on resume.
    journal: dict[str, Any] = field(default_factory=dict)
    #: Ordered record of (key, name, result) for durable persistence.
    journal_log: list[dict[str, Any]] = field(default_factory=list)

    pause: PauseInfo | None = None
    #: Rounds of THIS invoke that ran a tool for real (replay excluded).
    rounds_this_invoke: int = 0
    #: SK request index of the first round that ran a tool for real —
    #: requests before it only rebuilt journaled rounds (restart replay).
    first_real_request: int | None = None
    replay_enabled: bool = False
    #: Round watermark — admission is checked at most once per round: a
    #: round's tools complete concurrently (asyncio.gather) and each runs
    #: the post-execution hook; only the first raises the watermark.
    last_checked_round: int = -1

    # -- round accounting ---------------------------------------------------

    def note_round(self, request_sequence_index: int) -> int:
        """Record that the round of SK request ``request_sequence_index``
        ran a tool for real.

        Returns the epoch-round count (base + local). The loop calls this
        once per tool of the round (gather fan-out); the value only grows.
        SK's index also counts the requests that, after a restart, rebuild
        the paused rounds from the journal — those are answered by the
        filter without reaching here, are already in ``base_rounds``, and
        all precede the first real execution (replay stops there). Local
        rounds are therefore counted from that first real request.
        """
        if self.first_real_request is None:
            self.first_real_request = request_sequence_index
        local = request_sequence_index - self.first_real_request + 1
        if local > self.rounds_this_invoke:
            self.rounds_this_invoke = local
        return self.base_rounds + self.rounds_this_invoke

    def admission_due(self, rounds_done: int) -> bool:
        """True for exactly one post-execution hook per round.

        The watermark is raised BEFORE the caller awaits anything, so two
        tools of one round completing in quick succession cannot both
        claim the check.
        """
        if rounds_done <= self.last_checked_round:
            return False
        self.last_checked_round = rounds_done
        return True

    async def check_admission(self, rounds_done: int) -> dict[str, Any] | None:
        """Admission for the NEXT round (call only when ``admission_due``).

        Order: budget first (free, deterministic), then the capacity gate
        (cached probe). Returns a refusal dict shaping :class:`PauseInfo`,
        or None when the next round is admitted. The budget counts the
        rounds of THIS call (a resume gets a fresh budget); ``rounds_done``
        is the cumulative epoch count reported in the pause.
        """
        if (
            self.round_budget is not None
            and self.rounds_this_invoke >= self.round_budget
        ):
            return {"reason": PAUSE_REASON_ROUND_BUDGET, "round_index": rounds_done}
        if self.gate_check is not None:
            refusal = await self.gate_check()
            if refusal is not None:
                return {
                    "reason": PAUSE_REASON_CAPACITY_GATE,
                    "round_index": rounds_done,
                    "retry_after_s": refusal.get("retry_after_s"),
                    "gate_verdict": refusal.get(
                        "error_type", ""
                    ).removeprefix("capacity_gate_")
                    or None,
                    "gate_detail": refusal.get("gate_detail"),
                }
        return None

    # -- journal ------------------------------------------------------------

    @staticmethod
    def journal_key(name: str, arguments: str | None) -> str:
        raw = f"{name}|{arguments or ''}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def record_tool(self, name: str, arguments: str | None, result: Any) -> None:
        key = self.journal_key(name, arguments)
        value = result if _jsonable(result) else str(result)
        self.journal[key] = value
        self.journal_log.append({"key": key, "name": name, "result": value})

    def replay_lookup(self, name: str, arguments: str | None) -> Any | None:
        """Journaled result for an identical call, while replay is active.

        Returns the sentinel ``_MISSING`` when there is no match so a
        journaled ``None``/falsy result still replays.
        """
        if not self.replay_enabled:
            return _MISSING
        key = self.journal_key(name, arguments)
        if key in self.journal:
            return self.journal[key]
        return _MISSING

    def replay_checkpoint(self) -> None:
        """Disable replay once the resumed invoke runs a tool for real.

        After the first real execution the loop is past reconstruction:
        later identical calls are the model's own second calls and must
        execute.
        """
        self.replay_enabled = False


class _Missing:
    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return "<missing>"


_MISSING = _Missing()


def _jsonable(value: Any) -> bool:
    try:
        json.dumps(value)
        return True
    except (TypeError, ValueError):
        return False


# ---------------------------------------------------------------------------
# Turn filter — the only SK seam this feature needs (#4742 P-a/P-b)
# ---------------------------------------------------------------------------


def install_turn_filter(kernel) -> None:
    """Attach the round-control filter to a kernel.

    No-op per tool call when no :class:`TurnController` is active: every
    other invoke path (group chats, benchmarks, tests) keeps exactly
    today's behaviour.
    """
    from semantic_kernel.filters import FilterTypes

    async def turn_control_filter(context, next):
        controller = current_turn()
        if controller is None:
            await next(context)
            return

        call = context.function_call_content
        name = call.name if call is not None else None
        arguments = call.arguments if call is not None else None

        replayed = controller.replay_lookup(name, arguments)
        if replayed is not _MISSING:
            from semantic_kernel.functions import FunctionResult

            context.function_result = FunctionResult(
                function=context.function.metadata, value=replayed
            )
            log.debug("journaled tool call replayed: %s", name)
            return

        controller.replay_checkpoint()
        await next(context)

        rounds_done = controller.note_round(context.request_sequence_index)
        result_value = (
            context.function_result.value
            if context.function_result is not None
            else None
        )
        controller.record_tool(name, arguments, result_value)

        if not controller.admission_due(rounds_done):
            return
        refusal = await controller.check_admission(rounds_done)
        if refusal is not None:
            context.terminate = True
            controller.pause = PauseInfo(
                reason=refusal["reason"],
                round_index=refusal["round_index"],
                retry_after_s=refusal.get("retry_after_s"),
                gate_verdict=refusal.get("gate_verdict"),
                gate_detail=refusal.get("gate_detail"),
            )
            log.info(
                "turn paused (conversation=%s reason=%s round=%s)",
                controller.conversation_id,
                controller.pause.reason,
                rounds_done,
            )

    kernel.add_filter(FilterTypes.AUTO_FUNCTION_INVOCATION, turn_control_filter)


# ---------------------------------------------------------------------------
# Durable conversation store (opt-in via SK_AGENT_CONVERSATION_DIR)
# ---------------------------------------------------------------------------


class ConversationStore:
    """File-backed persistence for conversations and turn journals.

    Layout under the root directory, ``<h>`` = sha256 hex of the id:
    - ``<h>.json`` — durable messages + turn counter.
    - ``<h>.journal.json`` — the current turn epoch's executed-tool
      journal (deleted when the turn completes).

    Both files carry the readable ``conversation_id``; a file whose stored
    id differs from the requested one is treated as absent. Writes are
    atomic (tmp + ``os.replace``), UTF-8 without BOM.
    """

    def __init__(self, root: str | Path | None):
        self.root = Path(root) if root else None

    @classmethod
    def from_env(cls) -> "ConversationStore":
        return cls(os.environ.get(CONVERSATION_DIR_ENV) or None)

    @property
    def enabled(self) -> bool:
        return self.root is not None

    def _path(self, conversation_id: str, suffix: str = ".json") -> Path:
        # Conversation ids are caller-supplied. EVERY id is named by its
        # sha256 hex: one lowercase path segment, so ".." or separators
        # cannot escape the root, nothing is stripped ("a.b" vs "ab"), case
        # never folds on a case-insensitive FS ("Conv" vs "conv"), and no
        # id can name another id's file (an id equal to sha256("a.b") is
        # hashed again). The readable id lives inside the file.
        name = hashlib.sha256(
            conversation_id.encode("utf-8", "surrogatepass")
        ).hexdigest()
        return self.root / f"{name}{suffix}"

    def _write_atomic(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
        os.replace(tmp, path)

    def _read(self, path: Path) -> dict[str, Any] | None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def _read_owned(self, path: Path, conversation_id: str) -> dict[str, Any] | None:
        """Read ``path`` only if it belongs to ``conversation_id``."""
        data = self._read(path)
        if data is None or data.get("conversation_id") != conversation_id:
            return None
        return data

    # -- conversation state ---------------------------------------------------

    def load(self, conversation_id: str) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        return self._read_owned(self._path(conversation_id), conversation_id)

    def save(
        self, conversation_id: str, messages: list[dict[str, Any]], turn_index: int
    ) -> None:
        if not self.enabled:
            return
        self._write_atomic(
            self._path(conversation_id),
            {
                "conversation_id": conversation_id,
                "turn_index": turn_index,
                "messages": messages,
            },
        )

    def delete(self, conversation_id: str) -> None:
        if not self.enabled:
            return
        for path in (
            self._path(conversation_id),
            self._path(conversation_id, ".journal.json"),
        ):
            try:
                path.unlink()
            except OSError:
                pass

    # -- turn journal ---------------------------------------------------------

    def load_journal(self, conversation_id: str) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        return self._read_owned(
            self._path(conversation_id, ".journal.json"), conversation_id
        )

    def save_journal(self, conversation_id: str, payload: dict[str, Any]) -> None:
        if not self.enabled:
            return
        self._write_atomic(
            self._path(conversation_id, ".journal.json"),
            {**payload, "conversation_id": conversation_id},
        )

    def clear_journal(self, conversation_id: str) -> None:
        if not self.enabled:
            return
        try:
            self._path(conversation_id, ".journal.json").unlink()
        except OSError:
            pass


def journal_payload(
    base_rounds: int, journal_log: list[dict[str, Any]], agent_id: str
) -> dict[str, Any]:
    return {
        "base_rounds": base_rounds,
        "agent_id": agent_id,
        "entries": journal_log,
    }
