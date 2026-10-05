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
