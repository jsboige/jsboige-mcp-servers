"""Per-model capacity gate consulted before agent dispatch (#4712).

A model entry may declare ``capacity_gate``: an external probe command run
between two turns — never during a generation — whose exit code decides
whether dispatch to that model is allowed:

- exit 0 -> green  (dispatch allowed)
- exit 1 -> yellow (allowed only when ``allow_yellow: true``)
- exit 2 -> red    (refused)
- any other exit code, a timeout, or a spawn failure -> unknown (refused)

The command's stdout last non-empty line, when it parses as a JSON object,
is kept as informational ``detail`` — the exit code alone is authoritative,
so a half-written or lying payload cannot flip a verdict. Results are
cached per model id for ``cache_s`` seconds (``time.monotonic``) so a
burst of dispatches does not become a burst of probes.

Cache scope (same statement as the #1748 rate counters): in-process
memory. stdio transport = one process per MCP client session;
streamable-http = one process shared by its sessions. A server restart
re-probes on the next dispatch.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("sk-agent.capacity-gate")

VERDICT_GREEN = "green"
VERDICT_YELLOW = "yellow"
VERDICT_RED = "red"
VERDICT_UNKNOWN = "unknown"

#: Authoritative verdict map — the exit code, never the stdout payload.
_EXIT_CODE_VERDICTS = {0: VERDICT_GREEN, 1: VERDICT_YELLOW, 2: VERDICT_RED}

#: In-process cache: model id -> (expires_at monotonic, verdict, detail).
_GATE_CACHE: dict[str, tuple[float, str, dict[str, Any] | None]] = {}


@dataclass
class CapacityGateResult:
    """Outcome of one gate evaluation (or cache hit)."""

    verdict: str
    detail: dict[str, Any] | None = None
    allowed: bool = False
    from_cache: bool = False
    retry_after_s: int = 60


def clear_capacity_gate_cache() -> None:
    """Test seam: drop the in-process verdict cache."""
    _GATE_CACHE.clear()


def parse_capacity_gate(data: Any) -> dict[str, Any] | None:
    """Parse + validate a model's ``capacity_gate`` entry.

    ``None`` (absent or explicit null) means "no gate" — exactly today's
    behaviour. Anything else must be an object carrying a non-empty
    ``command`` list of strings; a malformed entry raises ``ValueError``
    naming the field (same contract as ``RateLimitConfig.from_dict``: a
    dead gate is worse than none — the caller would believe the model is
    bounded when it is not, so refuse loudly at parse rather than fail
    open at dispatch).
    """
    if data is None:
        return None
    if not isinstance(data, dict):
        raise ValueError(
            f"capacity_gate must be an object {{command, ...}}, "
            f"got {type(data).__name__}"
        )

    command = data.get("command")
    if (
        not isinstance(command, list)
        or not command
        or not all(
            isinstance(token, str) and token.strip() for token in command
        )
    ):
        raise ValueError(
            "capacity_gate.command must be a non-empty list of non-empty "
            f"strings, got {command!r}"
        )

    env = data.get("env", {})
    if env is None:
        env = {}
    if not isinstance(env, dict) or not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in env.items()
    ):
        raise ValueError(
            f"capacity_gate.env must be an object of string -> string, got {env!r}"
        )

    allow_yellow = data.get("allow_yellow", False)
    if not isinstance(allow_yellow, bool):
        raise ValueError(
            f"capacity_gate.allow_yellow must be a boolean, got {allow_yellow!r}"
        )

    cache_s = _parse_number("cache_s", data.get("cache_s", 10.0), minimum=0.0)
    timeout_s = _parse_number(
        "timeout_s", data.get("timeout_s", 10.0), minimum=0.0, exclusive=True
    )

    retry_after_s = data.get("retry_after_s", 60)
    if (
        not isinstance(retry_after_s, int)
        or isinstance(retry_after_s, bool)
        or retry_after_s < 0
    ):
        raise ValueError(
            "capacity_gate.retry_after_s must be an integer >= 0, "
            f"got {retry_after_s!r}"
        )

    return {
        "command": list(command),
        "env": dict(env),
        "allow_yellow": allow_yellow,
        "cache_s": cache_s,
        "timeout_s": timeout_s,
        "retry_after_s": retry_after_s,
    }


def _parse_number(
    name: str, value: Any, minimum: float, exclusive: bool = False
) -> float:
    """Numeric gate field: JSON number (bool excluded), bounded below."""
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or value < minimum
        or (exclusive and value == minimum)
    ):
        bound = ">" if exclusive else ">="
        raise ValueError(
            f"capacity_gate.{name} must be a number {bound} {minimum}, "
            f"got {value!r}"
        )
    return float(value)


def _parse_detail(stdout: bytes) -> dict[str, Any] | None:
    """Last non-empty stdout line as a JSON object, else ``None``."""
    if not stdout:
        return None
    lines = stdout.decode("utf-8", "replace").splitlines()
    for line in reversed(lines):
        text = line.strip()
        if not text:
            continue
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _allowed(verdict: str, gate: dict) -> bool:
    if verdict == VERDICT_GREEN:
        return True
    return verdict == VERDICT_YELLOW and bool(gate.get("allow_yellow", False))


def _retry_after_s(gate: dict) -> int:
    try:
        return int(gate.get("retry_after_s", 60))
    except (TypeError, ValueError):
        return 60


async def evaluate_capacity_gate(
    model_id: str, gate: dict[str, Any]
) -> CapacityGateResult:
    """Run one model's gate command and map its exit code to a verdict.

    The child is spawned with ``create_subprocess_exec`` (no shell), its
    ``env`` layered over ``os.environ``, and killed if it overruns
    ``timeout_s``. Spawn failures of any shape (missing executable,
    unsupported child-watch on this loop, OS error) map to ``unknown`` —
    fail-closed, typed — never an exception into the dispatch path.
    """
    now = time.monotonic()
    cached = _GATE_CACHE.get(model_id)
    if cached is not None and cached[0] > now:
        _, verdict, detail = cached
        return CapacityGateResult(
            verdict=verdict,
            detail=detail,
            allowed=_allowed(verdict, gate),
            from_cache=True,
            retry_after_s=_retry_after_s(gate),
        )

    verdict = VERDICT_UNKNOWN
    detail: dict[str, Any] | None = None
    try:
        child_env = dict(os.environ)
        child_env.update(gate.get("env") or {})
        proc = await asyncio.create_subprocess_exec(
            *gate["command"],
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=child_env,
        )
        try:
            stdout, _ = await asyncio.wait_for(
                proc.communicate(), timeout=float(gate.get("timeout_s", 10.0))
            )
        except asyncio.TimeoutError:
            # A probe that overruns its bound must not keep accumulating
            # on the seat: kill it, then report unknown (refused).
            try:
                proc.kill()
            except (ProcessLookupError, OSError):
                pass
            await proc.wait()
        else:
            verdict = _EXIT_CODE_VERDICTS.get(proc.returncode, VERDICT_UNKNOWN)
            detail = _parse_detail(stdout or b"")
    except (FileNotFoundError, NotImplementedError, OSError, ValueError) as exc:
        log.warning(
            "capacity gate for model '%s' could not run: %s", model_id, exc
        )

    cache_s = float(gate.get("cache_s", 10.0))
    if cache_s > 0:
        _GATE_CACHE[model_id] = (now + cache_s, verdict, detail)
    return CapacityGateResult(
        verdict=verdict,
        detail=detail,
        allowed=_allowed(verdict, gate),
        retry_after_s=_retry_after_s(gate),
    )


async def check_model_capacity_gate(
    model_cfg: Any, agent_id: str | None = None
) -> dict[str, Any] | None:
    """Dispatch seam for ``call_agent`` (#4712).

    Returns ``None`` when the call may proceed (no gate declared, or an
    allowed verdict); a typed refusal dict otherwise. Anything that is not
    a parsed ``capacity_gate`` dict is ignored — a config that does not
    declare the field keeps exactly today's behaviour.
    """
    gate = getattr(model_cfg, "capacity_gate", None)
    if not isinstance(gate, dict) or not gate:
        return None
    result = await evaluate_capacity_gate(model_cfg.id, gate)
    if result.allowed:
        return None
    return {
        "error": (
            f"capacity gate refused dispatch to model '{model_cfg.id}' "
            f"(verdict {result.verdict}); retry after "
            f"{result.retry_after_s}s"
        ),
        "error_type": f"capacity_gate_{result.verdict}",
        "retry_after_s": result.retry_after_s,
        "model_used": model_cfg.id,
        "agent_used": agent_id,
        "gate_detail": result.detail,
    }
