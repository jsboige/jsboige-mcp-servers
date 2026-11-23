#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Authored here (#4816 criterion 3), not a copy. Sibling files are tracked
# against jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1 ; this
# module is native to this tree since the 22/11 cutover (#4781).
# -----------------------------------------------------------------------------
"""#4816 criterion 3 — the nb_coder window witness (deterministic sandbox replay).

Measured defect (jsboige/vllm#466, run CoursIA#27027, 17/11 00:24Z): an
nb_coder pass overflowed Swift's 262 144-token window MID-TURN — the outgoing
request grew round over round inside one ``agent.invoke`` until the engine
rejected it with HTTP 400 (262 145 > 262 144, body 1 016 816 chars).

The mid-turn condensation (ms#1832/ms#1839) is proven by unit tests at a
small synthetic window; this module is the missing WITNESS at the REAL
window: it replays the CoursIA#27027 morphology (one turn, one
``update_cell``-shaped tool round after another, multi-KB call arguments and
kernel outputs) through the REAL turn machinery — real ``SKAgentManager``
turn path, real ``install_turn_filter`` hook, real ``ContextCondenser``, real
Semantic Kernel ``OpenAIChatCompletion`` connector over a real
``AsyncOpenAI`` HTTP client — against a local OpenAI-compatible engine that
enforces the engine contract exactly as the incident measured it.

Engine model (documented, honest about what is modeled):
  tokens = ceil(chars / 3.88)   — derived from the incident pair
  1 016 816 chars -> 262 145 tokens => 3.8792 chars/token
  vLLM's two-branch length check, message shapes pinned VERBATIM against
  the live Swift engine (probe 23/11): prompt-only when prompt_tokens >
  262 144 ("exceeds this limit even without any output tokens"), else
  prompt + max_tokens; both 400 ``context_length_exceeded``.

The condenser itself estimates at 4.0 chars/token, so the engine counts
~3% MORE tokens than the estimate on the same text — the replay therefore
exercises the estimator-vs-tokenizer asymmetry, not a tautology.

Two cases, one CLI:

  red   — condensation NOT enabled: the turn dies mid-turn with the real
          HTTP 400 (``openai.BadRequestError``), at a measured round, with
          the measured body size. The incident, replayed.
  green — condensation enabled (the nb_coder seat-entry contract):
          the turn COMPLETES, every request stays under the window, the
          instruction rides every request, the K newest kernel outputs
          stay verbatim, older ones are pruned, and the response envelope
          reports ``condensation.mid_turn``.

Usage:
    python nb_coder_window_replay.py --mode both [--json OUT.json]
    python nb_coder_window_replay.py --live-probe --base-url URL \
        --api-key-env VAR --model ID

The live probe (optional, never in tests) sends ONE deliberately
over-window request to a real OpenAI-compatible engine and records the
rejection, pinning the modeled contract against the real one. It never
prints the key.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
_SK_ROOT = _HERE.parent.parent
if str(_SK_ROOT) not in sys.path:
    sys.path.insert(0, str(_SK_ROOT))

# ---------------------------------------------------------------------------
# Contract constants — derived from the measured incident
# ---------------------------------------------------------------------------

#: The incident rejection: 262 145 > 262 144 (jsboige/vllm#466).
MAX_MODEL_LEN = 262_144
#: 1 016 816 chars -> 262 145 tokens = 3.8792 chars/token.
INCIDENT_CHARS = 1_016_816
INCIDENT_TOKENS = 262_145
CHARS_PER_TOKEN = INCIDENT_CHARS / INCIDENT_TOKENS  # 3.8792...
#: Output budget the engine reserves (vLLM checks prompt + max_tokens).
MAX_GEN_TOKENS = 4_096

#: The condensation contract the nb_coder seat entries declare, verbatim
#: (nb_coder_seat_entries.example.json, ms#1832): enabled + BALANCED preset,
#: no overrides — BALANCED resolves to hot window 8 / 8 000-char cap
#: (sk_context_condensation._PRESETS), so the replay rides the seat
#: contract itself, never a bespoke variant.
NBCODER_CONDENSATION = {
    "enabled": True,
    "preset": "balanced",
}

#: Morphology defaults: one turn of ``ROUNDS`` update_cell rounds, each
#: adding ~16 KB (call arguments + kernel output) to the request history —
#: the growth that killed CoursIA#27027 at round ~62. Kernel outputs are
#: modeled at 6 000 chars, under the BALANCED 8 000-char cap, so the
#: hot-window verbatim property holds under the real seat contract; the
#: arguments carry the rest of the per-round growth.
ROUNDS = 70
ARGS_CHARS = 10_000
RESULT_CHARS = 6_000

INSTRUCTION = (
    "Construis le carnet demande cellule par cellule "
    "(replay nb_coder #4816 — temoin fenetre 262144)."
)
TOOL_QUALNAME = "nb-update_cell"
FINAL_ANSWER = "carnet finalise — replay witness done"
_RESULT_MARK = "NB-W-RESULT r="


def _fill(round_no: int, kind: str, chars: int) -> str:
    """Deterministic, round-distinct payload body of exactly ``chars``."""
    body = f"{_RESULT_MARK}{round_no} {kind} "
    unit = (
        f"r{round_no:03d}:{kind}: kernel stdout line, cell execution "
        "output, deterministic replay fill; "
    )
    out = body + unit * (chars // len(unit) + 2)
    return out[:chars]


def call_arguments(round_no: int, chars: int = ARGS_CHARS) -> str:
    """The model's tool call: valid JSON, binds to (n, source)."""
    return json.dumps(
        {"n": round_no, "source": _fill(round_no, "src", chars - 64)},
        ensure_ascii=False,
    )


def tool_result(round_no: int, chars: int = RESULT_CHARS) -> str:
    return _fill(round_no, "out", chars)


def count_tokens(blob: str, per_message: int = 0, per_tool_call: int = 0) -> int:
    """The modeled engine count: ceil(chars / 3.8792) + template overhead."""
    return math.ceil(len(blob) / CHARS_PER_TOKEN) + per_message * 3 + per_tool_call * 4


# ---------------------------------------------------------------------------
# The engine — a real HTTP server speaking the OpenAI contract
# ---------------------------------------------------------------------------


@dataclass
class EngineRecord:
    """What the engine saw: one entry per /chat/completions request."""

    index: int
    chars: int
    tokens: int
    instruction_seen: bool
    full_rounds: list[int]
    rejected: bool = False


@dataclass
class EngineState:
    max_model_len: int = MAX_MODEL_LEN
    max_gen_tokens: int = MAX_GEN_TOKENS
    chars_per_token: float = CHARS_PER_TOKEN
    final_after: int = ROUNDS
    rounds_planned: int = ROUNDS
    requests: list[EngineRecord] = field(default_factory=list)
    rejections: list[EngineRecord] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def reset(self, final_after: int, rounds_planned: int) -> None:
        self.final_after = final_after
        self.rounds_planned = rounds_planned
        self.requests.clear()
        self.rejections.clear()


def _blob_of(messages: list[dict]) -> tuple[str, int, int]:
    """Concatenate what the engine tokenizes: contents + tool-call names/args."""
    parts: list[str] = []
    n_msgs = 0
    n_calls = 0
    for m in messages:
        n_msgs += 1
        c = m.get("content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            for piece in c:
                if isinstance(piece, dict) and isinstance(piece.get("text"), str):
                    parts.append(piece["text"])
        for call in m.get("tool_calls") or []:
            n_calls += 1
            fn = (call or {}).get("function") or {}
            parts.append(str(fn.get("name") or ""))
            parts.append(str(fn.get("arguments") or ""))
    return "\n".join(parts), n_msgs, n_calls


def _last_round_seen(messages: list[dict]) -> int:
    last = 0
    for m in messages:
        c = m.get("content")
        if not isinstance(c, str) or _RESULT_MARK not in c:
            continue
        try:
            last = max(last, int(c.split(_RESULT_MARK, 1)[1].split()[0]))
        except (IndexError, ValueError):
            continue
    return last


class _EngineHandler(BaseHTTPRequestHandler):
    server_version = "nb-window-replay/1.0"
    protocol_version = "HTTP/1.1"

    @property
    def state(self) -> EngineState:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, *args: Any) -> None:  # silence per-request stderr
        return

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # /v1/models — the client never asks, but be polite
        if self.path.rstrip("/").endswith("/models"):
            self._send(
                200,
                {"object": "list", "data": [{"id": "nb-window-replay", "object": "model"}]},
            )
        else:
            self._send(404, {"error": {"message": "not found", "type": "invalid_request_error"}})

    def do_POST(self) -> None:
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._send(404, {"error": {"message": "not found", "type": "invalid_request_error"}})
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            self._send(400, {"error": {"message": "bad json", "type": "invalid_request_error"}})
            return
        messages = req.get("messages") or []
        blob, n_msgs, n_calls = _blob_of(messages)
        tokens = count_tokens(blob, per_message=n_msgs, per_tool_call=n_calls)
        full_rounds = [
            r
            for r in range(1, self.state.rounds_planned + 1)
            if any(m.get("content") == tool_result(r) for m in messages)
        ]
        with self.state.lock:
            rec = EngineRecord(
                index=len(self.state.requests),
                chars=len(blob),
                tokens=tokens,
                instruction_seen=INSTRUCTION in blob,
                full_rounds=full_rounds,
            )
            self.state.requests.append(rec)
        limit = self.state.max_model_len - self.state.max_gen_tokens
        if tokens > self.state.max_model_len:
            message = (
                f"This model's maximum context length is "
                f"{self.state.max_model_len} tokens. However, your prompt "
                f"contains at least {tokens} input tokens, which exceeds this "
                f"limit even without any output tokens. Please reduce the "
                f"length of the prompt."
            )
        elif tokens > limit:
            message = (
                f"This model's maximum context length is "
                f"{self.state.max_model_len} tokens. However, your request "
                f"has {tokens} input tokens and {self.state.max_gen_tokens} "
                f"generated tokens. The input tokens exceeded the limit."
            )
        else:
            message = None
        if message is not None:
            with self.state.lock:
                rec.rejected = True
                self.state.rejections.append(rec)
            self._send(
                400,
                {
                    "error": {
                        "message": message,
                        "type": "invalid_request_error",
                        "param": None,
                        "code": "context_length_exceeded",
                    }
                },
            )
            return
        last = _last_round_seen(messages)
        if last >= self.state.final_after:
            self._send(
                200,
                {
                    "id": f"chatcmpl-replay-{rec.index}",
                    "object": "chat.completion",
                    "created": 0,
                    "model": req.get("model") or "nb-window-replay",
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {"role": "assistant", "content": FINAL_ANSWER},
                        }
                    ],
                    "usage": {
                        "prompt_tokens": tokens,
                        "completion_tokens": 9,
                        "total_tokens": tokens + 9,
                    },
                },
            )
            return
        nxt = last + 1
        self._send(
            200,
            {
                "id": f"chatcmpl-replay-{rec.index}",
                "object": "chat.completion",
                "created": 0,
                "model": req.get("model") or "nb-window-replay",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": f"call_{rec.index}",
                                    "type": "function",
                                    "function": {
                                        "name": TOOL_QUALNAME,
                                        "arguments": call_arguments(nxt),
                                    },
                                }
                            ],
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": tokens,
                    "completion_tokens": 120,
                    "total_tokens": tokens + 120,
                },
            },
        )


def start_engine(state: EngineState) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _EngineHandler)
    server.state = state  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


# ---------------------------------------------------------------------------
# The real turn machinery over the engine
# ---------------------------------------------------------------------------


def build_replay(tmp_path: Path, engine_url: str, *, condensation: dict | None, rounds: int = ROUNDS):
    """Manager double over the REAL SK agent + real OpenAI HTTP connector.

    Same construction as test_mid_turn_condensation._overflow_manager —
    the real ``_handle_text``/``_begin_turn`` path — but the model service
    is Semantic Kernel's real ``OpenAIChatCompletion`` over an
    ``AsyncOpenAI`` client pointed at the replay engine, so every round is
    a real HTTP request the engine can reject.
    """
    from openai import AsyncOpenAI
    from semantic_kernel import Kernel
    from semantic_kernel.agents import ChatCompletionAgent
    from semantic_kernel.connectors.ai.function_choice_behavior import (
        FunctionChoiceBehavior,
    )
    from semantic_kernel.connectors.ai.open_ai import OpenAIChatCompletion
    from semantic_kernel.functions import kernel_function

    import sk_agent_turns
    from sk_agent import SKAgentManager
    from sk_agent_config import AgentConfig, ModelConfig, SKAgentConfig
    from sk_agent_turns import ConversationStore

    model = ModelConfig(id="swift-1.5-27b-nbcoder", context_window=MAX_MODEL_LEN)
    agent_cfg = AgentConfig(
        id="notebook-coder",
        model="swift-1.5-27b-nbcoder",
        condensation=condensation,
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

    client = AsyncOpenAI(
        base_url=engine_url, api_key="replay-no-key", max_retries=0, timeout=180.0
    )
    service = OpenAIChatCompletion(
        ai_model_id="swift-1.5-27b-nbcoder", async_client=client
    )
    counter: dict = {"calls": 0}

    kernel = Kernel()
    sk_agent_turns.install_turn_filter(kernel)
    kernel.add_service(service)

    class NBPlugin:
        @kernel_function(description="write one notebook cell")
        async def update_cell(self, n: int, source: str) -> str:
            counter["calls"] += 1
            return tool_result(n)

    kernel.add_plugin(NBPlugin(), plugin_name="nb")
    agent = ChatCompletionAgent(
        kernel=kernel,
        name="notebook-coder-replay",
        instructions="Replay witness agent.",
        function_choice_behavior=FunctionChoiceBehavior.Auto(
            maximum_auto_invoke_attempts=rounds + 10
        ),
    )

    async def fake_resolve(**kwargs):
        return ("notebook-coder", agent)

    manager._resolve_agent = fake_resolve
    return manager, agent, counter


async def run_case(
    tmp_path: Path, state: EngineState, engine_url: str, *, mode: str, rounds: int = ROUNDS
) -> dict:
    """Run one replay case; returns the measured report dict."""
    from sk_agent import STATUS_COMPLETED

    condensation = NBCODER_CONDENSATION if mode == "green" else None
    state.reset(final_after=rounds, rounds_planned=rounds)
    first_request_index = len(state.requests)
    manager, agent, counter = build_replay(
        tmp_path, engine_url, condensation=condensation, rounds=rounds
    )

    outcome: dict[str, Any] = {"mode": mode}
    try:
        result = await manager._handle_text(
            "notebook-coder", agent, INSTRUCTION, None, False
        )
        outcome["status"] = result.get("status")
        outcome["response"] = result.get("response")
        outcome["completed"] = result.get("status") == STATUS_COMPLETED
        outcome["tool_calls"] = counter["calls"]
        mid = (result.get("condensation") or {}).get("mid_turn") or []
        outcome["condensations"] = {
            "count": len(mid),
            "triggered": sum(1 for e in mid if e.get("triggered")),
        }
    except Exception as ex:  # the red control dies on the engine's 400
        outcome["completed"] = False
        outcome["exception"] = f"{type(ex).__name__}: {ex}"[:300]
        outcome["exception_type"] = type(ex).__name__
        outcome["tool_calls"] = counter["calls"]
        # SK wraps the engine's HTTP error (ServiceResponseException in
        # 1.39); the CONTRACT lives on the root openai error in the cause
        # chain — walk it, never guess from the wrapper.
        root = ex
        seen = set()
        while root is not None and id(root) not in seen:
            seen.add(id(root))
            if type(root).__name__ == "BadRequestError":
                break
            root = root.__cause__ or root.__context__
        outcome["root_exception_type"] = type(root).__name__
        outcome["root_status_code"] = getattr(root, "status_code", None)
        outcome["root_code"] = getattr(root, "code", None)

    reqs = [r for r in state.requests if r.index >= first_request_index]
    rejs = [r for r in state.rejections if r.index >= first_request_index]
    outcome["engine"] = {
        "requests": len(reqs),
        "rejections": len(rejs),
        "peak_chars": max((r.chars for r in reqs), default=0),
        "peak_tokens": max((r.tokens for r in reqs), default=0),
        "window_tokens": state.max_model_len,
        "instruction_every_request": all(r.instruction_seen for r in reqs),
        "rejected_at_request": rejs[0].index + 1 if rejs else None,
        "rejected_tokens": rejs[0].tokens if rejs else None,
        "rejected_chars": rejs[0].chars if rejs else None,
        "last_request": {
            "chars": reqs[-1].chars,
            "tokens": reqs[-1].tokens,
            "instruction_seen": reqs[-1].instruction_seen,
            "full_rounds": reqs[-1].full_rounds,
        }
        if reqs
        else None,
    }
    return outcome


def replay_report(tmp_path: Path, *, rounds: int = ROUNDS) -> dict:
    """Both cases against one engine instance: red first, then green."""
    state = EngineState()
    server = start_engine(state)
    engine_url = f"http://127.0.0.1:{server.server_address[1]}/v1"
    try:
        red = asyncio.run(run_case(tmp_path, state, engine_url, mode="red", rounds=rounds))
        green = asyncio.run(
            run_case(tmp_path, state, engine_url, mode="green", rounds=rounds)
        )
    finally:
        server.shutdown()
        server.server_close()
    verdict = {
        "red_reproduces_400": bool(red["engine"]["rejections"])
        and red.get("root_exception_type") == "BadRequestError"
        and red.get("root_status_code") == 400
        and red.get("root_code") == "context_length_exceeded",
        "green_completes": bool(green.get("completed")),
        "green_no_rejection": green["engine"]["rejections"] == 0,
        "green_under_window": green["engine"]["peak_tokens"]
        + MAX_GEN_TOKENS
        <= MAX_MODEL_LEN,
        "green_instruction_every_request": bool(
            green["engine"]["instruction_every_request"]
        ),
        "green_condensed_mid_turn": green["condensations"]["triggered"] > 0,
    }
    return {"red": red, "green": green, "verdict": verdict}


# ---------------------------------------------------------------------------
# Optional: pin the modeled contract against a REAL engine (one request)
# ---------------------------------------------------------------------------


def live_engine_probe(base_url: str, api_key: str, model: str, *, chars: int = 1_400_000) -> dict:
    """Send ONE deliberately over-window request; record the rejection.

    Never runs in tests. The body is ~1.4M chars: at any ratio <= 4.0
    chars/token that is >= 350K tokens > 262 144, so the engine rejects
    BEFORE any inference. max_tokens=16 keeps the would-be output trivial
    even if an engine accepted the prompt.
    """
    import openai

    client = openai.OpenAI(base_url=base_url, api_key=api_key, max_retries=0, timeout=120)
    body = ("live probe #4816 — over-window single request. " * (chars // 46 + 1))[:chars]
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": body}],
            max_tokens=16,
        )
        return {
            "rejected": False,
            "note": "engine ACCEPTED the over-window body — probe inconclusive",
            "usage": getattr(resp, "usage", None) and resp.usage.model_dump(),
        }
    except openai.BadRequestError as ex:
        return {
            "rejected": True,
            "status": ex.status_code,
            "code": ex.code,
            "message_head": str(ex)[:240],
            "modeled_tokens": count_tokens(body),
        }
    except Exception as ex:  # network/auth — report, never guess
        return {"rejected": None, "error": f"{type(ex).__name__}: {ex}"[:240]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--mode", choices=["red", "green", "both"], default="both")
    ap.add_argument("--rounds", type=int, default=ROUNDS)
    ap.add_argument("--json", type=Path, default=None, help="also write the report here")
    ap.add_argument("--live-probe", action="store_true", help="one over-window request to a REAL engine")
    ap.add_argument("--base-url", default=None, help="real engine base_url (with /v1)")
    ap.add_argument("--api-key-env", default=None, help="env var holding the real engine key")
    ap.add_argument("--model", default=None, help="real engine model id")
    args = ap.parse_args(argv)

    if args.live_probe:
        if not (args.base_url and args.api_key_env and args.model):
            print("--live-probe needs --base-url, --api-key-env and --model", file=sys.stderr)
            return 2
        import os

        key = os.environ.get(args.api_key_env, "")
        if not key:
            print(f"env {args.api_key_env} is empty", file=sys.stderr)
            return 2
        report = {"live_probe": live_engine_probe(args.base_url, key, args.model)}
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0

    import tempfile

    with tempfile.TemporaryDirectory(prefix="nb-window-replay-") as td:
        report = replay_report(Path(td), rounds=args.rounds)
    if args.json:
        args.json.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    ok = report["verdict"]
    return 0 if all(ok.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
