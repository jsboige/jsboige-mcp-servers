"""Tests for the usage telemetry (one JSONL line per MCP tool call)."""

import asyncio
import inspect
import json
import time

import pytest

import sk_agent


@pytest.fixture
def usage_log(tmp_path, monkeypatch):
    path = tmp_path / "nested" / "usage.jsonl"
    monkeypatch.setattr(sk_agent, "USAGE_LOG", path)
    return path


def _records(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_log_usage_writes_one_record_without_content(usage_log):
    sk_agent.log_usage("call_agent", True, time.monotonic())
    (rec,) = _records(usage_log)
    assert set(rec) == {"ts", "tool", "ok", "dur_s", "pid"}
    assert rec["tool"] == "call_agent"
    assert rec["ok"] is True


def test_log_usage_truncates_error(usage_log):
    sk_agent.log_usage("call_agent", False, time.monotonic(), "x" * 500)
    (rec,) = _records(usage_log)
    assert rec["ok"] is False
    assert len(rec["error"]) == 200


def test_log_usage_never_raises(tmp_path, monkeypatch):
    # A directory sits where the file should be: the append fails, the call must not.
    target = tmp_path / "usage.jsonl"
    target.mkdir()
    monkeypatch.setattr(sk_agent, "USAGE_LOG", target)
    sk_agent.log_usage("call_agent", True, time.monotonic())


def test_track_usage_logs_success_and_failure(usage_log):
    @sk_agent.track_usage
    async def sample_tool(x: int) -> int:
        if x < 0:
            raise ValueError("negative")
        return x * 2

    assert asyncio.run(sample_tool(3)) == 6
    with pytest.raises(ValueError):
        asyncio.run(sample_tool(-1))

    ok, failed = _records(usage_log)
    assert (ok["tool"], ok["ok"]) == ("sample_tool", True)
    assert (failed["tool"], failed["ok"]) == ("sample_tool", False)
    assert "negative" in failed["error"]


def test_track_usage_logs_agent_and_model_on_success(usage_log):
    # Shape of the real call_agent: agent kwarg in, JSON string out
    # carrying model_used.
    @sk_agent.track_usage
    async def call_agent(prompt: str = "", agent: str = "") -> str:
        return json.dumps({"ok": True, "model_used": "glm-4.6", "steps": 1})

    asyncio.run(call_agent("hi", agent="analyst"))
    (rec,) = _records(usage_log)
    assert rec["agent"] == "analyst"
    assert rec["model"] == "glm-4.6"


def test_track_usage_omits_agent_and_model_when_unknown(usage_log):
    # list_agents takes no agent and its payload carries no model_used:
    # both fields must be ABSENT, never null.
    @sk_agent.track_usage
    async def list_agents() -> str:
        return json.dumps({"agents": []})

    asyncio.run(list_agents())
    (rec,) = _records(usage_log)
    assert "agent" not in rec
    assert "model" not in rec


def test_track_usage_keeps_agent_on_failure(usage_log):
    @sk_agent.track_usage
    async def review_pr(repo: str = "", pr_number: int = 0, agent: str = "") -> str:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        asyncio.run(review_pr("r", 1, agent="reviewer"))
    (rec,) = _records(usage_log)
    assert rec["agent"] == "reviewer"
    # A failed call never produced a model.
    assert "model" not in rec


def test_track_usage_ignores_result_without_model_used(usage_log):
    # Non-JSON or non-dict results (plain ints, error-free paths of
    # non-LLM tools) must not break the record or invent a model.
    @sk_agent.track_usage
    async def sample_tool(x: int) -> int:
        return x * 2

    assert asyncio.run(sample_tool(3)) == 6
    (rec,) = _records(usage_log)
    assert "model" not in rec


EXPECTED_TOOLS = {
    "call_agent",
    "list_agents",
    "list_tools",
    "end_conversation",
    "review_pr",
    "install_libreoffice",
    "run_conversation",
    "list_conversations",
    "diagnostics",
}


def test_every_tool_is_tracked_and_keeps_its_schema():
    tools = sk_agent.mcp_server._tool_manager._tools
    assert set(tools) == EXPECTED_TOOLS
    for name, tool in tools.items():
        assert hasattr(tool.fn, "__wrapped__"), f"{name} is not wrapped by track_usage"
        original = inspect.signature(tool.fn.__wrapped__).parameters
        assert set(tool.parameters.get("properties", {})) == set(original), name
