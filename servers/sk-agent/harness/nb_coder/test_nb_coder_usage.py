# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 9683ab2f5165f374bbb387132288c2cbf7cc6084
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_usage.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for #506 palier 0: every model call records ITS OWN tokens.

The per-call `engine_delta` is the whole-engine counter delta over the call, Claude Code
traffic included (IT08 `1-plan`: +569 630 prompt tokens for one 93.7 s call), so it
cannot size a turn. sk-agent publishes the call's own `usage` (UsageMeter, summed over
every completion of one call_agent); the driver and the verifier now keep it.

Skipped when `mcp` is not importable (the driver imports the MCP client at load).
"""
import asyncio
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as d  # noqa: E402


@pytest.mark.parametrize("env, expected", [
    ({"usage": {"prompt_tokens": 4465, "completion_tokens": 618}},
     {"usage": {"prompt_tokens": 4465, "completion_tokens": 618}}),
    ({"usage": {"prompt_tokens": 12}}, {"usage": {"prompt_tokens": 12}}),
    ({}, {}),                                              # silent envelope: absent
    ({"usage": None}, {}),
    ({"usage": "4465"}, {}),                               # not a dict
    ({"usage": {"prompt_tokens": "abc", "completion_tokens": 3}},
     {"usage": {"completion_tokens": 3}}),                 # junk drops its own field
    ({"usage": {"prompt_tokens": True}}, {}),              # a bool is not a count
])
def test_usage_fields_keeps_only_real_counts(env, expected):
    assert d.usage_fields(env) == expected


def test_a_call_record_carries_its_own_usage_and_never_a_zero(monkeypatch):
    envs = [{"response": "ok", "usage": {"prompt_tokens": 18000, "completion_tokens": 900}},
            {"response": "ok"}]

    async def fake_sk(session, args, prompt, conv, max_tokens=None, model=None):
        return envs.pop(0), 1.0

    monkeypatch.setattr(d, "sk_call", fake_sk)
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    rec = {"calls": []}
    asyncio.run(d.sk_call_retry(None, None, rec, "1-plan", "p", None))
    asyncio.run(d.sk_call_retry(None, None, rec, "2-build", "p", None))
    first, second = rec["calls"]
    assert first["usage"] == {"prompt_tokens": 18000, "completion_tokens": 900}
    assert "usage" not in second           # unknown stays unknown, never a measured 0


def test_an_empty_answer_retry_records_both_calls_usage(monkeypatch):
    envs = [{"response": "", "error": "empty model response",
             "usage": {"prompt_tokens": 9000, "completion_tokens": 32768}},
            {"response": "ok", "usage": {"prompt_tokens": 9100, "completion_tokens": 700}}]

    async def fake_sk(session, args, prompt, conv, max_tokens=None, model=None):
        return envs.pop(0), 1.0

    monkeypatch.setattr(d, "sk_call", fake_sk)
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    rec = {"calls": []}
    asyncio.run(d.sk_call_retry(None, None, rec, "2-build", "p", None))
    assert [c["stage"] for c in rec["calls"]] == ["2-build", "2-build-retry"]
    assert [c["usage"]["completion_tokens"] for c in rec["calls"]] == [32768, 700]


def test_the_verifier_records_its_usage_through_the_same_helper():
    src = (Path(__file__).parent / "nb_coder_verify.py").read_text(encoding="utf-8")
    assert "rec |= nbcd.usage_fields(env)" in src
