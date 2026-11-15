"""#4742: fine-grained turn control — pause, resume, durability, gates.

Closure criteria mapped (issue roo-extensions#4742):

- **Pause and resume.** A conversation paused by the capacity gate
  between two rounds resumes with the same ``conversation_id`` and no
  tool re-executed (call counter unchanged). Same for a round-budget
  pause.
- **Restart idempotence.** After a server "restart" (new manager, empty
  memory), a resumed turn replays model calls but answers journaled tool
  calls from the durable journal — the tool runs exactly once.
- **Gate of run_conversation.** A red gate on a participating model
  refuses the conversation before any model call.
- **Envelope.** Every response carries conversation_id, turn_index,
  round_index and status (completed | paused | error); a pause carries
  resumable=true; a refusal names the conversation_id.
- **Concurrency lock.** Two concurrent turns on one conversation: the
  second is refused as ``conversation_busy``.
- **Timeout rollback.** A timed-out turn leaves no dangling user
  message and its error names the conversation_id.
- **Probe absent ≠ red.** A missing probe script is ``unknown``, never
  "saturated" (#4742 defect fix).

The engine is a REAL Semantic Kernel loop: a scripted
``ChatCompletionClientBase`` standing in for the model service, the real
``ChatCompletionAgent`` auto-invocation loop, and the real turn filter
installed on the kernel. Only the network is fake.
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.chat_completion_client_base import (
    ChatCompletionClientBase,
)
from semantic_kernel.functions import kernel_function
from semantic_kernel.connectors.ai.function_choice_behavior import (
    FunctionChoiceBehavior,
)
from semantic_kernel.contents import (
    AuthorRole,
    ChatMessageContent,
    FunctionCallContent,
    FunctionResultContent,
)

import sk_agent
from sk_agent import SKAgentManager
from sk_agent_capacity_gate import (
    check_model_capacity_gate,
    clear_capacity_gate_cache,
    evaluate_capacity_gate,
)
from sk_agent_config import AgentConfig, ModelConfig, SKAgentConfig
from sk_agent_turns import ConversationStore, TurnCallOptions
import sk_agent_turns

# Reuse the public parse seam through the manager module (it lives there).
from sk_agent import _parse_turn_options

TOOL_NAME = "probe-tick"


# ---------------------------------------------------------------------------
# Fake engine — scripted model + counting tool, real SK loop
# ---------------------------------------------------------------------------


class ScriptedChatCompletion(ChatCompletionClientBase):
    """One scripted model: tool call first, final answer once a tool
    result is visible in history."""

    sleep_s: float = 0.0
    always_tools: bool = False
    model_calls: int = 0
    # The base class bypasses the whole auto-invocation loop without it.
    SUPPORTS_FUNCTION_CALLING = True

    def __init__(self, sleep_s: float = 0.0, always_tools: bool = False):
        super().__init__(
            ai_model_id="fake-model", sleep_s=sleep_s, always_tools=always_tools
        )

    async def _inner_get_chat_message_contents(self, chat_history, settings):
        self.model_calls += 1
        if self.sleep_s:
            await asyncio.sleep(self.sleep_s)
        has_result = any(
            isinstance(item, FunctionResultContent)
            for msg in chat_history.messages
            for item in msg.items
        )
        if has_result and not self.always_tools:
            return [
                ChatMessageContent(role=AuthorRole.ASSISTANT, content="final-answer")
            ]
        return [
            ChatMessageContent(
                role=AuthorRole.ASSISTANT,
                items=[
                    FunctionCallContent(
                        id=f"call_{self.model_calls}", name=TOOL_NAME, arguments="{}"
                    )
                ],
            )
        ]

    async def _inner_get_streaming_chat_message_contents(self, chat_history, settings):
        raise NotImplementedError("streaming not used in these tests")


def _make_agent(service: ScriptedChatCompletion, tool_counter: dict, on_tool=None):
    """Real ChatCompletionAgent: real kernel, turn filter, one counting tool."""
    kernel = Kernel()
    sk_agent_turns.install_turn_filter(kernel)
    kernel.add_service(service)

    class TickPlugin:
        """One counting tool: the only 'MCP' in these tests."""

        @kernel_function(description="tick")
        async def tick(self) -> str:
            tool_counter["calls"] = tool_counter.get("calls", 0) + 1
            if on_tool is not None:
                on_tool(tool_counter["calls"])
            return f"tool-result-{tool_counter['calls']}"

    kernel.add_plugin(TickPlugin(), plugin_name="probe")
    return ChatCompletionAgent(
        kernel=kernel,
        name="sk-agent-fake",
        instructions="test",
        function_choice_behavior=FunctionChoiceBehavior.Auto(),
    )


def _state_probe(state_file: Path) -> list[str]:
    """Gate probe honouring a state file: 'green' -> 0, else 2 (red)."""
    return [
        sys.executable,
        "-c",
        f"import sys; sys.exit(0 if open(r'{state_file}').read().strip() == 'green' else 2)",
    ]


def _turn_manager(
    gate: dict | None,
    store_root: Path | None = None,
    sleep_s: float = 0.0,
    always_tools: bool = False,
    on_tool=None,
):
    """Manager double with a REAL _handle_text over a real SK agent.

    The model service and resolution are scripted; everything else
    (turn control, gates, locks, envelope, persistence) is the real code.
    """
    model = ModelConfig(id="m-x", capacity_gate=gate)
    agent_cfg = AgentConfig(id="a-x", model="m-x")
    manager = SKAgentManager.__new__(SKAgentManager)
    manager.config = SKAgentConfig(models=[model], agents=[agent_cfg])
    manager._threads = {}
    manager._execution_settings = None
    manager._conv_locks = {}
    manager._turn_counts = {}
    manager._epochs = {}
    manager._store = ConversationStore(store_root)
    manager._turn_counter = 0

    service = ScriptedChatCompletion(sleep_s=sleep_s, always_tools=always_tools)
    counter: dict = {"calls": 0}

    async def fake_resolve(**kwargs):
        return ("a-x", _make_agent(service, counter, on_tool=on_tool))

    manager._resolve_agent = fake_resolve
    return manager, service, counter


def _gate_dict(probe: list[str]) -> dict:
    return {
        "command": probe,
        "env": {},
        "allow_yellow": False,
        "cache_s": 0.0,
        "timeout_s": 10.0,
        "retry_after_s": 30,
    }


@pytest.fixture(autouse=True)
def _fresh_gate_cache():
    clear_capacity_gate_cache()
    yield
    clear_capacity_gate_cache()


# ---------------------------------------------------------------------------
# Closure criterion 1 — pause by gate between rounds, resume, no re-exec
# ---------------------------------------------------------------------------


class TestPauseAndResume:
    def test_gate_pause_between_rounds_then_resume_same_conversation(
        self, tmp_path
    ):
        state = tmp_path / "gate-state.txt"
        state.write_text("green")

        def flip_red_after_first(calls):
            # The gate goes red from INSIDE round 1 — the post-round
            # admission check must pause before round 2's model call.
            if calls == 1:
                state.write_text("red")

        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state)), on_tool=flip_red_after_first
        )

        async def scenario():
            first = await manager.call_agent(prompt="go", agent_id="a-x")
            state.write_text("green")  # re-admit for the resume
            second = await manager.call_agent(
                prompt="",
                agent_id="a-x",
                conversation_id=first["conversation_id"],
                options={"continue": True},
            )
            return first, second

        first, second = asyncio.run(scenario())

        assert first["status"] == "paused", first
        assert first["resumable"] is True
        assert first["paused"]["reason"] == "capacity_gate"
        assert first["round_index"] == 1
        assert first["turn_index"] == 1
        conv = first["conversation_id"]
        assert conv

        assert second["status"] == "completed", second
        assert second["conversation_id"] == conv
        assert second["round_index"] == 1  # final call: no new tool round
        assert second["response"] == "final-answer"
        # THE contract: the tool ran exactly once across pause + resume.
        assert counter["calls"] == 1, "tool must not re-execute on resume"

    def test_gate_pause_requires_red_probe_actually_flipped(self, tmp_path):
        """The pause above must come from the gate, not budget: same setup
        with an always-green probe runs to completion."""
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state))
        )

        result = asyncio.run(manager.call_agent(prompt="go", agent_id="a-x"))

        assert result["status"] == "completed"
        assert counter["calls"] == 1

    def test_round_budget_pauses_and_resumes(self, tmp_path):
        """options.max_rounds bounds the rounds of THIS call; a resume
        with a fresh budget completes the turn."""
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        # always_tools: every model call requests the tool again, so the
        # budget is the only thing that can stop the loop.
        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state)), always_tools=True
        )

        async def scenario():
            first = await manager.call_agent(
                prompt="go", agent_id="a-x", options={"max_rounds": 1}
            )
            second = await manager.call_agent(
                prompt="",
                agent_id="a-x",
                conversation_id=first["conversation_id"],
                options={"continue": True, "max_rounds": 1},
            )
            return first, second

        first, second = asyncio.run(scenario())

        assert first["status"] == "paused", first
        assert first["paused"]["reason"] == "round_budget"
        assert first["round_index"] == 1
        assert first["resumable"] is True
        # Resume: round 2 admitted (fresh budget), tool runs a second
        # time — a NEW round, not a re-execution of round 1.
        assert second["status"] == "paused"
        assert second["round_index"] == 2
        assert counter["calls"] == 2

    def test_journal_replay_after_restart_no_double_execution(self, tmp_path):
        """Restart between pause and resume: the tool result is read from
        the durable journal, never re-executed."""
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        store_root = tmp_path / "store"

        # Process 1: budget-pause after round 1, durable store on.
        m1, s1, c1 = _turn_manager(
            _gate_dict(_state_probe(state)), store_root=store_root
        )
        # Budget 1 + a script that would answer after the tool result:
        # round 1 runs the tool, budget pauses before the final call.
        first = asyncio.run(
            m1.call_agent(
                prompt="go", agent_id="a-x", options={"max_rounds": 1}
            )
        )
        assert first["status"] == "paused"
        assert c1["calls"] == 1
        journals = list(store_root.glob("*.journal.json"))
        assert journals, "pause must persist the journal"

        # Process 2: brand-new manager, empty memory, same store root.
        m2, s2, c2 = _turn_manager(
            _gate_dict(_state_probe(state)), store_root=store_root
        )
        second = asyncio.run(
            m2.call_agent(
                prompt="",
                agent_id="a-x",
                conversation_id=first["conversation_id"],
                options={"continue": True},
            )
        )

        assert second["status"] == "completed", second
        assert second["response"] == "final-answer"
        # THE contract, restart edition: the replayed model call was
        # answered from the journal — the tool counter of the NEW process
        # stays at zero; combined with process 1's single call, the tool
        # ran exactly once overall.
        assert c2["calls"] == 0, "journaled call must replay, not re-execute"
        assert c1["calls"] + c2["calls"] == 1


# ---------------------------------------------------------------------------
# Envelope, refusals, locks, rollback
# ---------------------------------------------------------------------------


class TestEnvelopeAndRefusals:
    def test_pre_dispatch_refusal_is_a_pause_with_conversation_id(self, tmp_path):
        state = tmp_path / "gate-state.txt"
        state.write_text("red")
        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state))
        )
        # Resolution may run (it builds the SK agent, no LLM call); the
        # refusal must land before any model call does.
        resolve_spy = manager._resolve_agent
        manager._resolve_agent = AsyncMock(side_effect=resolve_spy)

        result = asyncio.run(manager.call_agent(prompt="hi", agent_id="a-x"))

        assert result["error_type"] == "capacity_gate_red"
        assert result["status"] == "paused"
        assert result["resumable"] is True
        assert result["conversation_id"]
        assert result["round_index"] == 0
        assert result["turn_index"] == 0  # the turn never started
        # No model call was issued: the scripted service saw nothing.
        assert service.model_calls == 0

    def test_completed_turn_carries_envelope(self, tmp_path):
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state))
        )

        result = asyncio.run(manager.call_agent(prompt="hi", agent_id="a-x"))

        assert result["status"] == "completed"
        assert result["turn_index"] == 1
        assert result["round_index"] == 1
        assert result["conversation_id"]

    def test_continue_without_conversation_id_refused(self, tmp_path):
        manager, _, _ = _turn_manager(None)

        result = asyncio.run(
            manager.call_agent(prompt="x", options={"continue": True})
        )

        assert result["error_type"] == "invalid_options"
        assert result["status"] == "error"

    def test_bad_option_values_refused(self):
        for bad in ({"max_rounds": 0}, {"max_rounds": True}, {"max_rounds": "3"}, {"continue": "yes"}):
            parsed = _parse_turn_options(bad)
            assert isinstance(parsed, dict), bad
            assert parsed["error_type"] == "invalid_options"

    def test_good_option_values(self):
        opts = _parse_turn_options({"continue": True, "max_rounds": 3})
        assert isinstance(opts, TurnCallOptions)
        assert opts.continue_turn is True
        assert opts.round_budget == 3


class TestConversationLock:
    def test_concurrent_second_turn_is_refused_busy(self, tmp_path):
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state)), sleep_s=0.2
        )

        async def scenario():
            conv_id = "lock-conv"
            t1 = asyncio.create_task(
                manager.call_agent(prompt="a", agent_id="a-x", conversation_id=conv_id)
            )
            await asyncio.sleep(0.05)  # let the first acquire + start the model call
            t2 = asyncio.create_task(
                manager.call_agent(prompt="b", agent_id="a-x", conversation_id=conv_id)
            )
            return await asyncio.gather(t1, t2)

        first, second = asyncio.run(scenario())

        assert first["status"] == "completed"
        assert second["error_type"] == "conversation_busy"
        assert second["conversation_id"] == "lock-conv"


class TestTimeoutRollback:
    def test_timeout_rolls_back_user_message_and_names_conversation(self, tmp_path):
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state)), sleep_s=0.5
        )

        async def scenario():
            timed_out = await manager.call_agent(
                prompt="slow", agent_id="a-x", conversation_id="t-1", timeout=1
            )
            # Same conversation, fast service now: must start clean.
            service.sleep_s = 0.0
            retry = await manager.call_agent(
                prompt="again", agent_id="a-x", conversation_id="t-1"
            )
            return timed_out, retry

        timed_out, retry = asyncio.run(scenario())

        assert "timed out" in timed_out["error"]
        assert timed_out["conversation_id"] == "t-1"
        assert timed_out["status"] == "error"
        assert retry["status"] == "completed", retry
        # The rolled-back turn did not consume a turn index.
        assert retry["turn_index"] == 1
        thread_messages = list(manager._threads["t-1"]._chat_history.messages)
        user_texts = [
            str(m) for m in thread_messages
            if getattr(m, "role", None) == AuthorRole.USER
        ]
        assert user_texts == ["again"], "pending user message must be rolled back"


# ---------------------------------------------------------------------------
# Closure criterion 2 — run_conversation passes the gate
# ---------------------------------------------------------------------------


class TestRunConversationGate:
    def _config(self, gate):
        from sk_agent_config import ConversationConfig

        return SKAgentConfig(
            models=[ModelConfig(id="m-x", capacity_gate=gate)],
            agents=[AgentConfig(id="a-x", model="m-x")],
            conversations=[
                ConversationConfig(
                    id="seq",
                    description="seq",
                    type="sequential",
                    agents=["a-x"],
                    max_rounds=2,
                )
            ],
        )

    def _runner(self, gate):
        from sk_conversations import ConversationRunner

        manager = SKAgentManager.__new__(SKAgentManager)
        manager.config = self._config(gate)
        manager._conv_locks = {}
        manager._turn_counts = {}
        manager._epochs = {}
        manager._store = ConversationStore(None)
        return ConversationRunner(
            manager.config, {}, pre_flight=manager.conversation_pre_flight
        )

    def test_red_gate_refuses_run_conversation(self, tmp_path):
        state = tmp_path / "gate-state.txt"
        state.write_text("red")
        runner = self._runner(_gate_dict(_state_probe(state)))
        # Participating agent already built: the refusal must come from
        # the gate, before the runner starts any turn.
        runner.sk_agents = {"a-x": object()}

        result = asyncio.run(runner.run(prompt="q", conversation_id="seq"))

        assert result["error_type"] == "capacity_gate_red"
        assert "refused" in result["error"]

    def test_green_gate_passes_pre_flight(self, tmp_path):
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        runner = self._runner(_gate_dict(_state_probe(state)))

        conv = runner.config.conversations[0]
        refusal = asyncio.run(runner._pre_flight(conv))

        assert refusal is None, "green gate must let the conversation run"

    def test_run_conversation_timeout_bounds_the_run(self):
        from unittest.mock import patch

        class _SlowRunner:
            async def run(self, **kwargs):
                await asyncio.sleep(5)
                return {"response": "never"}

        async def scenario():
            with patch(
                "sk_agent._get_conversation_runner",
                AsyncMock(return_value=_SlowRunner()),
            ):
                raw = await sk_agent.run_conversation(
                    prompt="q",
                    conversation="seq",
                    options='{"timeout": 1}',
                )
            return json.loads(raw)

        result = asyncio.run(scenario())

        assert result["error_type"] == "timeout"
        assert result["timeout"] == 1

    def test_run_conversation_invalid_timeout_refused(self):
        from unittest.mock import patch

        class _NeverRunner:
            async def run(self, **kwargs):
                raise AssertionError("runner must not be called")

        async def scenario():
            with patch(
                "sk_agent._get_conversation_runner",
                AsyncMock(return_value=_NeverRunner()),
            ):
                raw = await sk_agent.run_conversation(
                    prompt="q", conversation="seq", options='{"timeout": -1}'
                )
            return json.loads(raw)

        result = asyncio.run(scenario())
        assert result["error"].startswith("options.timeout")


# ---------------------------------------------------------------------------
# Gate defect fix — missing probe is unknown, not red
# ---------------------------------------------------------------------------


class TestProbeAbsentIsUnknown:
    def test_missing_probe_script_is_unknown_not_red(self):
        missing = tmp_missing = os.path.join(
            os.path.dirname(__file__), "definitely_missing_probe_xyz.py"
        )
        result = asyncio.run(
            evaluate_capacity_gate(
                "m-absent", _gate_dict([sys.executable, missing])
            )
        )
        assert result.verdict == "unknown"
        assert result.allowed is False  # fail-closed stays
        assert "probe_stderr" in (result.detail or {})

    def test_real_red_exit_stays_red(self):
        probe = [
            sys.executable,
            "-c",
            "import sys; sys.stderr.write('saturated\\n'); sys.exit(2)",
        ]
        result = asyncio.run(evaluate_capacity_gate("m-red", _gate_dict(probe)))
        assert result.verdict == "red"
        assert result.allowed is False

    def test_missing_probe_refusal_via_check_model_capacity_gate(self):
        missing = os.path.join(
            os.path.dirname(__file__), "definitely_missing_probe_xyz.py"
        )
        model = ModelConfig(
            id="m-absent2", capacity_gate=_gate_dict([sys.executable, missing])
        )
        refusal = asyncio.run(check_model_capacity_gate(model))
        assert refusal is not None
        assert refusal["error_type"] == "capacity_gate_unknown"


# ---------------------------------------------------------------------------
# Durable store unit tests
# ---------------------------------------------------------------------------


class TestConversationStore:
    def test_save_load_roundtrip(self, tmp_path):
        store = ConversationStore(tmp_path)
        store.save("c1", [{"role": "user", "content": "hi"}], 3)
        data = store.load("c1")
        assert data["turn_index"] == 3
        assert data["messages"] == [{"role": "user", "content": "hi"}]

    def test_journal_roundtrip_and_clear(self, tmp_path):
        store = ConversationStore(tmp_path)
        store.save_journal(
            "c1",
            {
                "base_rounds": 1,
                "agent_id": "a-x",
                "entries": [{"key": "k", "name": "t", "result": "r"}],
            },
        )
        loaded = store.load_journal("c1")
        assert loaded["base_rounds"] == 1
        store.clear_journal("c1")
        assert store.load_journal("c1") is None

    def test_delete_removes_both_files(self, tmp_path):
        store = ConversationStore(tmp_path)
        store.save("c1", [], 0)
        store.save_journal("c1", {"entries": []})
        store.delete("c1")
        assert store.load("c1") is None
        assert store.load_journal("c1") is None

    def test_path_confinement(self, tmp_path):
        store = ConversationStore(tmp_path)
        store.save("../evil", [], 0)
        assert (tmp_path / "evil.json").exists()
        assert not (tmp_path.parent / "evil.json").exists()

    def test_disabled_store_is_noop(self):
        store = ConversationStore(None)
        assert not store.enabled
        store.save("c1", [], 0)  # must not raise
        assert store.load("c1") is None
