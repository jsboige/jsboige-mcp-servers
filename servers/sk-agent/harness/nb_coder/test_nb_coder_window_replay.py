# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Authored here (#4816 criterion 3), not a copy. Sibling files are tracked
# against jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1 ; this
# module is native to this tree since the 22/11 cutover (#4781).
# -----------------------------------------------------------------------------
"""#4816 criterion 3 — the nb_coder window witness, asserted.

The replay module (nb_coder_window_replay.py) drives the REAL turn
machinery — real ``_handle_text``/``_begin_turn``, real turn filter, real
``ContextCondenser``, real Semantic Kernel ``OpenAIChatCompletion``
connector over a real ``AsyncOpenAI`` HTTP client — against a local
OpenAI-compatible engine that enforces the engine contract as the incident
measured it (262 144-token window, 400 ``context_length_exceeded``).

What these tests pin:

- the incident arithmetic the engine model derives from (1 016 816 chars
  -> 262 145 tokens -> rejected);
- RED: without condensation the turn DIES mid-turn on the engine's real
  HTTP 400 — the defect, replayed at the real window;
- GREEN: with the nb_coder seat-entry condensation contract the turn
  COMPLETES — every request under the window, instruction verbatim on
  every request, hot-window kernel outputs intact, older ones pruned,
  mid-turn condensations reported on the envelope.

Run:
    python -m pytest harness/nb_coder/test_nb_coder_window_replay.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_SK_ROOT = _HERE.parent.parent
for _p in (str(_SK_ROOT), str(_HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import nb_coder_window_replay as w  # noqa: E402


@pytest.fixture(scope="module")
def report(tmp_path_factory):
    """One engine, both cases: red first, then green."""
    return w.replay_report(tmp_path_factory.mktemp("nb-window-replay"))


def test_incident_arithmetic_is_pinned():
    """The engine model derives from the measured pair, and rejects it.

    1 016 816 chars at 3.8792 chars/token = 262 145 tokens > 262 144 —
    the incident's own numbers must reproduce the incident's own verdict.
    """
    body = "x" * w.INCIDENT_CHARS
    tokens = w.count_tokens(body)
    assert tokens == w.INCIDENT_TOKENS == 262_145
    limit = w.MAX_MODEL_LEN - w.MAX_GEN_TOKENS
    assert tokens > limit, "the incident body must exceed the modeled window"


def test_red_control_dies_on_the_engine_400_mid_turn(report):
    red = report["red"]
    eng = red["engine"]

    # The turn did NOT complete: the real HTTP 400 reached the caller (SK
    # wraps it — the root cause in the chain is the engine's contract).
    assert red.get("root_exception_type") == "BadRequestError", red.get("exception")
    assert red.get("root_status_code") == 400
    assert red.get("root_code") == "context_length_exceeded"
    assert eng["rejections"] == 1
    assert eng["rejected_tokens"] > w.MAX_MODEL_LEN - w.MAX_GEN_TOKENS
    assert eng["rejected_chars"] > 1_000_000  # the incident scale (~1 016 816)

    # Mid-turn: the turn died AFTER many rounds completed, not at once.
    assert red["tool_calls"] > 40, "died too early — not the #4816 morphology"
    # Monotone growth of the outgoing requests (nothing condensed).
    assert red["engine"]["peak_tokens"] == eng["rejected_tokens"]


def test_green_condensation_completes_under_the_window(report):
    green = report["green"]
    eng = green["engine"]

    assert green["completed"], green
    assert green["response"] == w.FINAL_ANSWER
    assert green["tool_calls"] == w.ROUNDS  # every round ran exactly once

    # No 400 ever reached the turn, and every request fit the window.
    assert eng["rejections"] == 0
    assert eng["peak_tokens"] + w.MAX_GEN_TOKENS <= w.MAX_MODEL_LEN

    # The instruction rode EVERY request verbatim.
    assert eng["instruction_every_request"]

    # Hot window: the last TOOL_RESULT_WINDOW kernel outputs ride the final
    # request in full; earlier ones were pruned (differential condensation).
    last = eng["last_request"]
    hot = set(range(w.ROUNDS - w.NBCODER_CONDENSATION["tool_result_window"] + 1, w.ROUNDS + 1))
    assert hot.issubset(set(last["full_rounds"])), last["full_rounds"]
    early = [r for r in last["full_rounds"] if r not in hot]
    assert len(early) < (w.ROUNDS - len(hot)), "no differential reduction"

    # The envelope reports the mid-turn condensations that kept it alive.
    assert green["condensations"]["triggered"] > 0

    # The differential did its job at the real scale: the peak request of
    # the GREEN turn is far below the RED death point.
    assert eng["peak_tokens"] < report["red"]["engine"]["rejected_tokens"] * 0.9


def test_verdict_block_is_all_true(report):
    assert report["verdict"] and all(report["verdict"].values()), report["verdict"]
