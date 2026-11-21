# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 9683ab2f5165f374bbb387132288c2cbf7cc6084
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_kernel_start.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for the kernel start retry (20/11).

The MCP server gives a kernel 30 s to answer. The evcxr `rust` kernel's first start of a
session overshoots it while the next one passes, so CoursIA#27133 died at stage 3 with
`kernel-start-failed` after 1,273 s of paid model work. A start without a kernel id is
now retried; the server cleans up the spawned process of a failed start.
"""
import asyncio
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as nbcd  # noqa: E402

TIMEOUT = {"error": "Failed to start kernel 'rust': Kernel didn't respond in 30 seconds"}


def _fake(monkeypatch, answers):
    calls, sleeps = [], []

    async def fake_pm_call(pm, tool, payload):
        calls.append((tool, dict(payload)))
        return answers[len(calls) - 1]

    async def fake_sleep(s):
        sleeps.append(s)

    monkeypatch.setattr(nbcd, "pm_call", fake_pm_call)
    monkeypatch.setattr(nbcd, "_kernel_retry_sleep", fake_sleep)
    return calls, sleeps


def test_a_cold_start_timeout_is_retried(monkeypatch, tmp_path, capsys):
    calls, sleeps = _fake(monkeypatch, [TIMEOUT, {"kernel_id": "k-2"}])
    kid = asyncio.run(nbcd.start_kernel(None, "rust", tmp_path))
    assert kid == "k-2"
    assert len(calls) == 2 and sleeps == [nbcd.KERNEL_START_BACKOFF_S]
    # the retry sends the very same request, working dir included
    assert calls[0] == calls[1]
    assert calls[1][1]["working_dir"] == str(tmp_path)
    err = capsys.readouterr().err
    assert "didn't respond in 30 seconds" in err and "started on attempt 2" in err


def test_attempts_are_bounded_and_the_failure_stays_a_failure(monkeypatch, tmp_path):
    calls, sleeps = _fake(monkeypatch, [TIMEOUT] * 10)
    kid = asyncio.run(nbcd.start_kernel(None, "rust", tmp_path))
    assert kid is None
    assert len(calls) == nbcd.KERNEL_START_ATTEMPTS
    assert len(sleeps) == nbcd.KERNEL_START_ATTEMPTS - 1      # no sleep after the last


def test_a_first_start_that_answers_is_not_retried(monkeypatch, tmp_path, capsys):
    calls, sleeps = _fake(monkeypatch, [{"kernel_id": "k-1"}])
    assert asyncio.run(nbcd.start_kernel(None, "python3", tmp_path)) == "k-1"
    assert len(calls) == 1 and sleeps == []
    assert "[kernel]" not in capsys.readouterr().err


def test_an_unparsed_answer_counts_as_a_failed_start(monkeypatch, tmp_path):
    calls, _ = _fake(monkeypatch, [{"raw": "<html>oops</html>"}, {"kernel_id": ""},
                                   {"kernel_id": "k-3"}])
    assert asyncio.run(nbcd.start_kernel(None, "rust", tmp_path)) == "k-3"
    assert len(calls) == 3
