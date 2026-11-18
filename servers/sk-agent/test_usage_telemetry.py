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


# ---------------------------------------------------------------------------
# Token usage (calibration of the nb_coder harness — vllm#431)
# ---------------------------------------------------------------------------
def test_log_usage_writes_usage_when_given(usage_log):
    sk_agent.log_usage("call_agent", True, time.monotonic(),
                       usage={"prompt_tokens": 1200, "completion_tokens": 340})
    (rec,) = _records(usage_log)
    assert rec["usage"] == {"prompt_tokens": 1200, "completion_tokens": 340}


def test_log_usage_omits_usage_when_absent(usage_log):
    # Absent, never null and never zero-filled: a zero would be read as
    # "measured free call" rather than "the backend said nothing".
    sk_agent.log_usage("call_agent", True, time.monotonic())
    (rec,) = _records(usage_log)
    assert "usage" not in rec


def test_track_usage_logs_usage_from_payload(usage_log):
    @sk_agent.track_usage
    async def call_agent(prompt: str = "", agent: str = "") -> str:
        return json.dumps({"ok": True, "model_used": "nb-minimax",
                           "usage": {"prompt_tokens": 10, "completion_tokens": 4}})

    asyncio.run(call_agent("hi", agent="analyst"))
    (rec,) = _records(usage_log)
    assert rec["usage"] == {"prompt_tokens": 10, "completion_tokens": 4}
    assert rec["model"] == "nb-minimax"


def test_track_usage_ignores_null_or_foreign_usage(usage_log):
    # A backend that reports nothing must leave the field out, and a
    # non-dict value must not be copied into the record as-is.
    @sk_agent.track_usage
    async def call_agent(prompt: str = "", agent: str = "") -> str:
        return json.dumps({"ok": True, "usage": None})

    @sk_agent.track_usage
    async def other(prompt: str = "", agent: str = "") -> str:
        return json.dumps({"ok": True, "usage": "n/a"})

    asyncio.run(call_agent("hi"))
    asyncio.run(other("hi"))
    first, second = _records(usage_log)
    assert "usage" not in first
    assert "usage" not in second


def _completion(prompt: int, completion: int, attempt=None):
    """One message content as SK hands it back: usage in metadata, and on the
    streaming class only, the loop's own function_invoke_attempt counter."""
    import types
    content = types.SimpleNamespace(
        metadata={"usage": types.SimpleNamespace(prompt_tokens=prompt,
                                                 completion_tokens=completion)})
    if attempt is not None:
        content.function_invoke_attempt = attempt
    return content


def test_usage_meter_sums_every_completion_of_a_call():
    # A tool-calling loop completes once per function-invoke attempt: the CALL
    # cost is the sum, and reporting the last one alone would under-count
    # exactly the calls that cost the most.
    meter = sk_agent.UsageMeter()
    meter.add(_completion(1000, 50))
    meter.add(_completion(1200, 30))
    assert meter.totals() == {"prompt_tokens": 2200, "completion_tokens": 80}


def test_usage_meter_keeps_last_value_per_streamed_completion():
    # SK puts usage on the FINAL chunk of a streamed completion, and several
    # chunks share one function_invoke_attempt: the last value per attempt is
    # the completion's total, not something to add once per chunk.
    meter = sk_agent.UsageMeter()
    meter.add(_completion(100, 10, attempt=0))   # earlier chunk, partial
    meter.add(_completion(900, 40, attempt=0))   # final chunk of completion 0
    meter.add(_completion(300, 20, attempt=1))   # completion 1
    assert meter.totals() == {"prompt_tokens": 1200, "completion_tokens": 60}


def test_usage_meter_reads_dict_shaped_usage():
    # Not every connector hands a CompletionUsage object.
    import types
    meter = sk_agent.UsageMeter()
    meter.add(types.SimpleNamespace(metadata={"usage": {"prompt_tokens": 7,
                                                        "completion_tokens": 3}}))
    assert meter.totals() == {"prompt_tokens": 7, "completion_tokens": 3}


def test_usage_meter_attaches_nothing_when_backend_reported_none():
    import types
    meter = sk_agent.UsageMeter()
    meter.add(types.SimpleNamespace(metadata={"usage": None}))
    meter.add(types.SimpleNamespace(metadata={}))
    result = {"agent_used": "analyst"}
    assert meter.attach(result) == {"agent_used": "analyst"}
    assert "usage" not in result


def test_usage_meter_attach_reports_totals_on_the_payload():
    meter = sk_agent.UsageMeter()
    meter.add(_completion(5, 2))
    result = meter.attach({"agent_used": "analyst"})
    assert result["usage"] == {"prompt_tokens": 5, "completion_tokens": 2}


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
    "nb_coder_workflow",
}


def test_every_tool_is_tracked_and_keeps_its_schema():
    tools = sk_agent.mcp_server._tool_manager._tools
    assert set(tools) == EXPECTED_TOOLS
    for name, tool in tools.items():
        assert hasattr(tool.fn, "__wrapped__"), f"{name} is not wrapped by track_usage"
        original = inspect.signature(tool.fn.__wrapped__).parameters
        assert set(tool.parameters.get("properties", {})) == set(original), name


# ---------------------------------------------------------------------------
# Real Semantic Kernel loop (ms#1790 review): intermediate completions reach
# the manager ONLY through on_intermediate_message — agent.invoke yields the
# final response alone. The step handler must therefore ALWAYS be installed
# and feed the meter; a handler wired only when include_steps is set counts
# just the last completion. On the pre-fix head (signature (steps) only) this
# test failed with totals 1000/5 instead of 2200/12 — the measured undercount.
# ---------------------------------------------------------------------------

from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.chat_completion_client_base import (
    ChatCompletionClientBase,
)
from semantic_kernel.connectors.ai.function_choice_behavior import (
    FunctionChoiceBehavior,
)
from semantic_kernel.contents import (
    AuthorRole,
    ChatMessageContent,
    FinishReason,
    FunctionCallContent,
    TextContent,
)
from semantic_kernel.functions import kernel_function

_TOOL_USAGE = {"prompt_tokens": 1200, "completion_tokens": 7}
_FINAL_USAGE = {"prompt_tokens": 1000, "completion_tokens": 5}


class _ScriptedToolLoopService(ChatCompletionClientBase):
    """Completion 1 returns a tool call (usage A), completion 2 final text (usage B)."""

    ai_model_id: str = "scripted"
    calls: int = 0
    SUPPORTS_FUNCTION_CALLING = True

    async def _inner_get_chat_message_contents(self, chat_history, settings, **kwargs):
        self.calls += 1
        if self.calls == 1:
            message = ChatMessageContent(
                role=AuthorRole.ASSISTANT,
                items=[
                    FunctionCallContent(
                        id="call_1",
                        name="tests-echo",
                        arguments='{"text": "hi"}',
                    )
                ],
                metadata={"usage": _TOOL_USAGE},
            )
            message.finish_reason = FinishReason.TOOL_CALLS
            return [message]
        return [
            ChatMessageContent(
                role=AuthorRole.ASSISTANT,
                items=[TextContent(text="done: hi")],
                metadata={"usage": _FINAL_USAGE},
            )
        ]

    async def _inner_get_streaming_chat_message_contents(self, chat_history, settings, **kwargs):
        raise NotImplementedError("streaming is not exercised by this scripted service")


@kernel_function(description="Echo the text back.")
def _echo(text: str) -> str:
    """Echo the text back."""
    return f"echo:{text}"


def _wire_handler(manager, steps, meter):
    """Adapt to the _make_step_handler signature (1 arg = pre-fix, 2 = fixed)."""
    params = [
        p for p in inspect.signature(
            sk_agent.SKAgentManager._make_step_handler
        ).parameters.values()
        if p.name != "self"
    ]
    if len(params) == 1:
        return manager._make_step_handler(steps)
    return manager._make_step_handler(steps, meter)


def test_real_sk_loop_sums_usage_across_every_completion():
    kernel = Kernel()
    kernel.add_function(plugin_name="tests", function=_echo, function_name="echo")
    service = _ScriptedToolLoopService()
    kernel.add_service(service)
    agent = ChatCompletionAgent(
        kernel=kernel,
        name="scripted-agent",
        instructions="Use the echo tool once, then answer.",
        function_choice_behavior=FunctionChoiceBehavior.Auto(),
    )

    meter = sk_agent.UsageMeter()
    steps = []
    manager = object.__new__(sk_agent.SKAgentManager)
    handler = _wire_handler(manager, steps, meter)

    async def run():
        yields = 0
        async for response in agent.invoke(on_intermediate_message=handler):
            meter.add(response)
            yields += 1
        return yields

    yields = asyncio.run(run())

    assert service.calls == 2, "the scripted loop must complete twice (tool call + final)"
    assert yields == 1, "agent.invoke yields only the final response"
    assert meter.totals() == {
        "prompt_tokens": 2200,
        "completion_tokens": 12,
    }, "usage must be summed over BOTH completions, not the last one"


def test_real_sk_loop_meter_fed_even_without_steps():
    params = [
        p for p in inspect.signature(
            sk_agent.SKAgentManager._make_step_handler
        ).parameters.values()
        if p.name != "self"
    ]
    if len(params) == 1:
        pytest.skip("pre-fix head: handler takes no meter — see the undercount test above")

    kernel = Kernel()
    kernel.add_function(plugin_name="tests", function=_echo, function_name="echo")
    service = _ScriptedToolLoopService()
    kernel.add_service(service)
    agent = ChatCompletionAgent(
        kernel=kernel,
        name="scripted-agent",
        instructions="Use the echo tool once, then answer.",
        function_choice_behavior=FunctionChoiceBehavior.Auto(),
    )

    meter = sk_agent.UsageMeter()
    steps = []
    manager = object.__new__(sk_agent.SKAgentManager)
    handler = manager._make_step_handler(None, meter)  # include_steps=False

    async def run():
        async for response in agent.invoke(on_intermediate_message=handler):
            meter.add(response)

    asyncio.run(run())

    assert meter.totals() == {
        "prompt_tokens": 2200,
        "completion_tokens": 12,
    }, "include_steps=False must not blind the meter"
    assert steps == [], "steps stay empty when the caller did not ask for them"


def test_log_usage_drops_junk_token_field_not_the_record(usage_log):
    # A non-numeric value must drop its own field, never the whole record.
    sk_agent.log_usage(
        "call_agent",
        True,
        time.monotonic(),
        agent="analyst",
        usage={"prompt_tokens": "abc", "completion_tokens": "12"},
    )
    (rec,) = _records(usage_log)
    assert rec["ok"] is True
    assert rec["agent"] == "analyst"
    assert rec["usage"] == {"completion_tokens": 12}, "only the numeric field survives"


def test_log_usage_omits_usage_when_both_fields_are_junk(usage_log):
    sk_agent.log_usage(
        "call_agent",
        True,
        time.monotonic(),
        usage={"prompt_tokens": None, "completion_tokens": object()},
    )
    (rec,) = _records(usage_log)
    assert "usage" not in rec
