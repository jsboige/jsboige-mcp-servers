#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_fresh_conv.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Offline tests for repair turns that outgrow the conversation — #27134 (2.3d), 2026-11-21.

Every repair round and bisect half continued the build conversation. On 2.3d the prompt
reached 238 335 tokens at 2.5-repair+2+h0; the next half was refused in 1.1 s by a 400
("maximum context length is 262144 tokens … at least 262145 input tokens") and the grain
ended with half its cells repaired. A repair prompt is self-contained, so the turn now
starts a fresh conversation: before the call when the estimate says it cannot fit, after
it when the engine refuses the window."""

import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
d = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(d)

# verbatim, 2.3d run issue-27134-843d9e74, call 2.5-repair+2+h1
OVERFLOW = (
    "(\"<class 'semantic_kernel.connectors.ai.open_ai.services.open_ai_chat_completion."
    "OpenAIChatCompletion'> service failed to complete the prompt\", BadRequestError('Error "
    "code: 400 - {\\'error\\': {\\'message\\': \"This model\\'s maximum context length is "
    "262144 tokens. However, your prompt contains at least 262145 input tokens, which "
    "exceeds this limit even without any output tokens. Please reduce the length of the "
    "input prompt. (parameter=input_tokens, value=262145)\", \\'type\\': "
    "\\'BadRequestError\\', \\'param\\': \\'input_tokens\\', \\'code\\': 400}}'))")
GATE = ("capacity gate refused dispatch to model 'qwen3.6-35b-a3b-nbcoder' (verdict red); "
        "retry after 3600s")
ERR = "\x1b[31m[E0308] Error:\x1b[0m mismatched types\n"
CUT = '```json\n{"cells": [{"idx": 1, "cell_type": "code", "source": "let k: u16 = 3'


def _call(conv, prompt_tokens, completion_tokens, tools=False, stage="2.5-repair+2"):
    return {"stage": stage, "tools": tools, "conversation_id": conv,
            "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens}}


# ---- reading the refusal ------------------------------------------------------------------
def test_the_verbatim_400_reads_as_a_window_overflow():
    assert d.context_overflow({"error": OVERFLOW})
    assert not d.context_overflow({"error": GATE})
    assert not d.context_overflow({"error": "APITimeoutError: Request timed out."})
    assert not d.context_overflow({"error": None, "response": "maximum context length is 1 "
                                   "tokens"})      # an answer quoting it is not a refusal


# ---- sizing the conversation --------------------------------------------------------------
def test_the_last_answered_call_on_the_conversation_sizes_it():
    rec = {"calls": [_call("c1", 208828, 15557), _call("c1", 238335, 10967),
                     {"stage": "x", "tools": False, "conversation_id": "c1", "error": GATE},
                     _call("other", 5000, 100)]}
    assert d.conv_tokens(rec, "c1") == 238335 + 10967
    assert d.conv_tokens(rec, "nope") is None and d.conv_tokens(rec, None) is None


def test_a_tool_turn_never_sizes_the_conversation():
    """sk-agent sums usage over every tool round: 5 rounds of 40K read as 200K."""
    rec = {"calls": [_call("c1", 200000, 3000, tools=True)]}
    assert d.conv_tokens(rec, "c1") is None
    assert d.ctx_overrun(rec, "c1", "x" * 90000, 32768, 262144) is None


def test_the_2_3d_history_is_flagged_before_the_half_that_overflowed():
    """After +2+h0 (238 335 + 10 967), a ~13K-token half plus a 32K answer cannot fit."""
    rec = {"calls": [_call("c1", 238335, 10967, stage="2.5-repair+2+h0")]}
    est = d.ctx_overrun(rec, "c1", "x" * 40000, d.BUILD_MAX_TOKENS, d.CTX_WINDOW)
    assert est == {"resident": 249302, "need": 249302 + 13333 + 32768, "budget": 262144}


def test_a_conversation_with_room_is_not_flagged():
    rec = {"calls": [_call("c1", 77112, 389, stage="2.5-repair+0")]}
    assert d.ctx_overrun(rec, "c1", "x" * 90000, d.BUILD_MAX_TOKENS, d.CTX_WINDOW) is None


# ---- one repair turn ----------------------------------------------------------------------
def _fake(monkeypatch, refuse_on=()):
    seen = []

    async def fake_retry(sk, args, rec, stage, prompt, conv, max_tokens=None):
        seen.append({"stage": stage, "conv": conv, "prompt": prompt})
        if conv in refuse_on:
            return {"conversation_id": conv, "response": "", "error": OVERFLOW}
        return {"conversation_id": conv or f"fresh{len(seen)}", "response": "ok",
                "error": None}

    monkeypatch.setattr(d, "sk_call_retry", fake_retry)
    return seen


def test_a_refused_turn_is_asked_again_fresh_with_the_same_prompt(monkeypatch):
    seen = _fake(monkeypatch, refuse_on={"c1"})
    rec = {"calls": []}
    env = asyncio.run(d.repair_call(None, None, rec, "2.5-repair+2+h1", "PROMPT", "c1",
                                    head="HEAD\n"))
    assert [(s["stage"], s["conv"]) for s in seen] == [("2.5-repair+2+h1", "c1"),
                                                      ("2.5-repair+2+h1-fresh", None)]
    assert seen[1]["prompt"] == "HEAD\nPROMPT"
    assert env["conversation_id"] == "fresh2" and env["error"] is None
    assert rec["fresh_conversations"] == [{"stage": "2.5-repair+2+h1", "from": "c1",
                                           "to": "fresh2", "refused": True,
                                           "budget": 262144}]


def test_a_full_conversation_goes_fresh_without_paying_the_refusal(monkeypatch):
    seen = _fake(monkeypatch)
    rec = {"calls": [_call("c1", 238335, 10967)]}
    asyncio.run(d.repair_call(None, None, rec, "2.5-repair+2+h1", "x" * 40000, "c1",
                              head="HEAD\n"))
    assert [s["conv"] for s in seen] == [None]
    assert seen[0]["stage"].endswith("-fresh") and seen[0]["prompt"].startswith("HEAD\n")
    assert rec["fresh_conversations"][0]["resident"] == 249302


def test_a_turn_with_room_stays_on_its_conversation(monkeypatch):
    seen = _fake(monkeypatch)
    rec = {"calls": [_call("c1", 77112, 389)]}
    env = asyncio.run(d.repair_call(None, None, rec, "2.5-repair+0", "PROMPT", "c1",
                                    head="HEAD\n"))
    assert [(s["conv"], s["prompt"]) for s in seen] == [("c1", "PROMPT")]
    assert env["conversation_id"] == "c1" and "fresh_conversations" not in rec


def test_a_fresh_turn_is_never_refused_twice(monkeypatch):
    """No conversation, nothing to drop: a refusal there is the prompt's own size."""
    seen = _fake(monkeypatch, refuse_on={None})
    rec = {"calls": []}
    env = asyncio.run(d.repair_call(None, None, rec, "s", "PROMPT", None))
    assert len(seen) == 1 and env["error"] == OVERFLOW and "fresh_conversations" not in rec


def test_the_window_follows_the_cli():
    args = d.build_parser().parse_args(["--issue", "1", "--notebook", "a.ipynb",
                                        "--ctx-window", "131072"])
    assert args.ctx_window == 131072
    assert d.build_parser().parse_args(["--issue", "1", "--notebook", "a.ipynb"]
                                       ).ctx_window == d.CTX_WINDOW


def test_the_fresh_head_names_the_notebook_and_its_twin():
    head = d.fresh_repair_head(SimpleNamespace(notebook="X-Rust.ipynb",
                                               source_nb="X-Python.ipynb"), "rust")
    assert "`X-Rust.ipynb`" in head and "rust" in head and "`X-Python.ipynb`" in head
    assert "portage" not in d.fresh_repair_head(SimpleNamespace(notebook="Y.ipynb"), "rust")


def test_calls_record_the_conversation_they_grew(monkeypatch):
    async def fake_sk(session, args, prompt, conv, max_tokens=None, model=None, **kw):
        return {"conversation_id": "c9", "response": "r", "usage": {"prompt_tokens": 10,
                                                                    "completion_tokens": 2}}, 0.1

    monkeypatch.setattr(d, "sk_call", fake_sk)
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    rec = {"calls": []}
    asyncio.run(d.sk_call_retry(None, None, rec, "2.5-repair+0", "p", None))
    assert rec["calls"][-1]["conversation_id"] == "c9"
    assert d.conv_tokens(rec, "c9") == 12


# ---- through the repair loop (the 2.3d shape) --------------------------------------------
def _code(src: str, err: str | None = None) -> dict:
    c = {"cell_type": "code", "metadata": {}, "source": src, "execution_count": None,
         "outputs": []}
    if err is not None:
        c["outputs"] = [{"output_type": "stream", "name": "stderr", "text": err},
                        {"output_type": "error", "ename": "Error",
                         "evalue": "compilation error", "traceback": []}]
    return c


def test_the_second_half_refused_by_the_window_is_repaired_fresh(tmp_path, monkeypatch):
    """2.3d, round 2: the round is cut, h0 parses, h1 is refused 400 on the window."""
    cells = [{"cell_type": "markdown", "metadata": {}, "source": "# T"}]
    cells += [_code(f"let k{i}: u8 = 300u16;", ERR) for i in range(4)] + [_code("let ok = 1;")]
    nb = tmp_path / "nb.ipynb"
    nb.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                              "nbformat_minor": 5}), encoding="utf-8")
    seen, executed = [], []

    async def fake_retry(sk, args, rec, stage, prompt, conv, max_tokens=None):
        seen.append((stage, conv))
        if stage.endswith("+h1") and conv == "c1":
            return {"conversation_id": "c1", "response": "", "error": OVERFLOW}
        if stage.endswith("+0"):
            return {"conversation_id": "c1", "response": CUT, "error": None}
        return {"conversation_id": conv or "f1", "response": "ok}", "error": None}

    async def fake_parse(sk, args, rec, stage, env, conv, max_tokens=None):
        if env.get("error") or env["response"] == CUT:
            return None, env
        idx = [1, 2] if stage.endswith("+h0") else [3, 4]
        return {"cells": [{"idx": i, "cell_type": "code", "source": f"let k{i}: u16 = 1;"}
                          for i in idx]}, env

    async def fake_noop(*a, **k):
        return {}

    async def fake_start(pm, kname, exec_dir):
        return "k2"

    async def fake_exec(pm, path, kid, targets):
        executed.append(list(targets))
        return [{"cell": i, "ok": True} for i in targets]

    monkeypatch.setattr(d, "sk_call_retry", fake_retry)
    monkeypatch.setattr(d, "parse_or_repair", fake_parse)
    monkeypatch.setattr(d, "pm_call", fake_noop)
    monkeypatch.setattr(d, "start_kernel", fake_start)
    monkeypatch.setattr(d, "execute_cells", fake_exec)
    targets = [i for i, c in enumerate(cells) if c["cell_type"] == "code"]
    rec = {"calls": [], "execution": [{"cell": i, "ok": not cells[i]["outputs"]}
                                      for i in targets]}
    args = SimpleNamespace(repair_rounds=1, notebook="nb.ipynb", source_nb=None)
    _, conv = asyncio.run(d.repair_kernel_errors(None, None, args, rec, nb, "csharp",
                                                 tmp_path, "k1", targets, "c1", ""))
    assert seen == [("2.5-repair+0", "c1"), ("2.5-repair+0+h0", "c1"),
                    ("2.5-repair+0+h1", "c1"), ("2.5-repair+0+h1-fresh", None)]
    r = rec["repairs"][0]
    assert r["replaced"] == [1, 2, 3, 4]
    assert all("verdict" not in h for h in r["bisect"]["halves"])
    assert rec["fresh_conversations"][0]["from"] == "c1"
    assert conv == "f1"         # later turns continue on the small conversation
    assert executed == [[1, 2, 3, 4, 5]]
