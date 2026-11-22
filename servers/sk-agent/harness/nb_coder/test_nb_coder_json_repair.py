# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_json_repair.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for the tolerant JSON reader and its one format-repair turn.

po-2028:claudish, 20/11: stage-2 answers came back unreadable on two malformations, raw
newlines inside a cell's source string and unescaped quotes, and on 32-unit builds the whole
answer was then lost as `unparsed`. A raw newline has one meaning, so the reader accepts it
(`strict=False`). An unescaped quote does not: where the string ends is a guess, so the
decoder's error goes back to the model ONCE, on the same conversation, and the harness never
rewrites a cell itself.

Skipped when `mcp` is not importable (the driver imports the MCP client at load).
"""
import asyncio
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as d  # noqa: E402

FENCE = "```"
GOOD = FENCE + 'json\n{"cells": [{"idx": 0, "source": "print(1)"}]}\n' + FENCE
# A raw newline inside the source string: json.loads (strict) refuses it.
RAW_NEWLINE = FENCE + 'json\n{"cells": [{"idx": 0, "source": "a = 1\nb = 2"}]}\n' + FENCE
# An unescaped quote: no reader can know where the string was meant to end.
BAD_QUOTE = FENCE + 'json\n{"cells": [{"idx": 0, "source": "print("hi")"}]}\n' + FENCE


# ---------------------------------------------------------------- reader
def test_a_raw_newline_in_a_string_is_read():
    assert d.parse_json_block(RAW_NEWLINE)["cells"][0]["source"] == "a = 1\nb = 2"


def test_a_raw_tab_in_a_string_is_read():
    text = FENCE + 'json\n{"cells": [{"idx": 0, "source": "if x:\n\tpass"}]}\n' + FENCE
    assert d.parse_json_block(text)["cells"][0]["source"] == "if x:\n\tpass"


def test_a_fence_inside_a_cell_source_does_not_cut_the_answer():
    # The markdown cell carries its own ``` block after a brace: the non-greedy fence regex
    # stops there, and the outermost-brace candidate recovers the whole object.
    text = (FENCE + 'json\n{"cells": [{"idx": 0, "source": "Exemple :\n' + FENCE
            + 'python\nd = {}\n' + FENCE + '\nfin"}]}\n' + FENCE)
    src = d.parse_json_block(text)["cells"][0]["source"]
    assert src.endswith("fin") and "d = {}" in src


def test_an_unfenced_answer_after_a_preamble_is_read():
    text = 'Voici le plan.\n{"execute_cells": [1, 2], "edits": []}\nFin.'
    assert d.parse_json_block(text) == {"execute_cells": [1, 2], "edits": []}


def test_the_last_fenced_block_is_the_answer():
    text = (FENCE + 'json\n{"draft": true}\n' + FENCE + "\nCorrigé :\n"
            + FENCE + 'json\n{"draft": false}\n' + FENCE)
    assert d.parse_json_block(text) == {"draft": False}


def test_an_unescaped_quote_is_not_guessed_and_the_error_says_where():
    obj, err = d.parse_json_report(BAD_QUOTE)
    assert obj is None
    assert "ligne" in err and "colonne" in err and "hi" in err


def test_a_json_list_is_not_an_answer():
    obj, err = d.parse_json_report('[{"idx": 0}]')
    assert obj is None and "list" in err


def test_no_json_at_all_says_so():
    assert d.parse_json_report("Je n'ai pas pu.") == (None, "aucun objet JSON dans la réponse")


# ---------------------------------------------------------------- format repair
def _fake(monkeypatch, responses):
    calls = []

    async def fake_sk(session, args, rec, stage, prompt, conv, max_tokens=None, model=None):
        calls.append({"stage": stage, "prompt": prompt, "conv": conv, "max_tokens": max_tokens})
        return responses[len(calls) - 1]

    monkeypatch.setattr(d, "sk_call_retry", fake_sk)
    return calls


def _repair(env, conv="c-1", max_tokens=None):
    rec = {"calls": []}
    obj, env_out = asyncio.run(d.parse_or_repair(None, None, rec, "2-build", env, conv,
                                                 max_tokens=max_tokens))
    return obj, env_out, rec


def test_an_unreadable_answer_gets_one_repair_on_the_same_conversation(monkeypatch):
    fixed = {"response": GOOD, "conversation_id": "c-1"}
    calls = _fake(monkeypatch, [fixed])
    obj, env, rec = _repair({"response": BAD_QUOTE, "conversation_id": "c-1"},
                            max_tokens=32768)
    assert obj == {"cells": [{"idx": 0, "source": "print(1)"}]}
    assert env is fixed
    (c,) = calls
    assert c["stage"] == "2-build-format" and c["conv"] == "c-1" and c["max_tokens"] == 32768
    assert "colonne" in c["prompt"] and "Réponse à reprendre" not in c["prompt"]
    assert rec["format_repairs"][0]["ok"] is True


def test_a_failed_repair_gives_up_after_one_turn_and_keeps_the_original(monkeypatch):
    original = {"response": BAD_QUOTE, "conversation_id": "c-1"}
    calls = _fake(monkeypatch, [{"response": BAD_QUOTE, "conversation_id": "c-1"}])
    obj, env, rec = _repair(original)
    assert obj is None and env is original and len(calls) == 1
    fr = rec["format_repairs"][0]
    assert fr["ok"] is False and "colonne" in fr["error_after"]


def test_without_a_conversation_the_answer_travels_in_the_prompt(monkeypatch):
    calls = _fake(monkeypatch, [{"response": GOOD}])
    obj, _, _ = _repair({"response": BAD_QUOTE}, conv=None)
    assert obj is not None
    assert calls[0]["conv"] is None and BAD_QUOTE in calls[0]["prompt"]


def test_a_gate_refusal_on_the_repair_is_returned_so_the_caller_defers(monkeypatch):
    refused = {"error": "capacity gate refused dispatch (verdict yellow); retry after 3600s"}
    _fake(monkeypatch, [refused])
    obj, env, _ = _repair({"response": BAD_QUOTE, "conversation_id": "c-1"})
    assert obj is None and d.gate_refusal(env).startswith("deferred-by-capacity-gate")


@pytest.mark.parametrize("env", [
    {"response": GOOD},                                           # parsed: nothing to do
    {"response": RAW_NEWLINE},                                    # read by strict=False
    {"error": "ServiceResponseException: 500", "response": ""},   # no answer to repair
    {"response": "   "},                                          # empty answer
    # cut by max_tokens inside a string: re-emitting under the same budget cuts it again
    {"response": FENCE + 'json\n{"cells": [{"idx": 0, "source": "a = '},
])
def test_no_repair_turn_when_there_is_nothing_to_repair(monkeypatch, env):
    calls = _fake(monkeypatch, [])
    _, out, rec = _repair(env)
    assert calls == [] and out is env and "format_repairs" not in rec
