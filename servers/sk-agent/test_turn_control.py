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
import hashlib
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


class StepChatCompletion(ChatCompletionClientBase):
    """Scripted model whose round k calls ``step(n=k)`` — distinct
    arguments per round, so a replayed round and a real one never share a
    journal key — and answers once ``final_after`` results are visible."""

    final_after: int = 3
    model_calls: int = 0
    SUPPORTS_FUNCTION_CALLING = True

    def __init__(self, final_after: int = 3):
        super().__init__(ai_model_id="fake-step-model", final_after=final_after)

    async def _inner_get_chat_message_contents(self, chat_history, settings):
        self.model_calls += 1
        done = sum(
            isinstance(item, FunctionResultContent)
            for msg in chat_history.messages
            for item in msg.items
        )
        if done >= self.final_after:
            return [
                ChatMessageContent(role=AuthorRole.ASSISTANT, content="final-answer")
            ]
        return [
            ChatMessageContent(
                role=AuthorRole.ASSISTANT,
                items=[
                    FunctionCallContent(
                        id=f"step_{self.model_calls}",
                        name="probe-step",
                        arguments=json.dumps({"n": done + 1}),
                    )
                ],
            )
        ]

    async def _inner_get_streaming_chat_message_contents(self, chat_history, settings):
        raise NotImplementedError("streaming not used in these tests")


def _step_manager(gate: dict | None, store_root: Path | None, execs: dict):
    """_turn_manager double over StepChatCompletion; ``execs[n]`` counts
    the real executions of ``step(n)`` (shared across restarts)."""
    manager, _, _ = _turn_manager(gate, store_root=store_root)
    service = StepChatCompletion()

    class StepPlugin:
        @kernel_function(description="step")
        async def step(self, n: int) -> str:
            execs[n] = execs.get(n, 0) + 1
            return f"step-{n}"

    async def fake_resolve(**kwargs):
        kernel = Kernel()
        sk_agent_turns.install_turn_filter(kernel)
        kernel.add_service(service)
        kernel.add_plugin(StepPlugin(), plugin_name="probe")
        return (
            "a-x",
            ChatCompletionAgent(
                kernel=kernel,
                name="sk-agent-fake",
                instructions="test",
                function_choice_behavior=FunctionChoiceBehavior.Auto(),
            ),
        )

    manager._resolve_agent = fake_resolve
    return manager


def _user_texts(manager, conv_id: str) -> list[str]:
    """USER messages of a conversation's in-memory thread."""
    thread = manager._threads[conv_id]
    return [
        str(m)
        for m in thread._chat_history.messages
        if getattr(m, "role", None) == AuthorRole.USER
    ]


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
        assert first["paused"] is True
        assert first["pause"]["reason"] == "capacity_gate"
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
        assert first["pause"]["reason"] == "round_budget"
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

    def test_resume_gets_a_fresh_round_budget(self, tmp_path):
        """W-a: max_rounds bounds the rounds of THIS call — a resume after
        a pause at round 2 admits 2 more rounds, not 2 - 2 + 1."""
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state)), always_tools=True
        )

        async def scenario():
            first = await manager.call_agent(
                prompt="go", agent_id="a-x", options={"max_rounds": 2}
            )
            calls_first = counter["calls"]
            second = await manager.call_agent(
                prompt="",
                agent_id="a-x",
                conversation_id=first["conversation_id"],
                options={"continue": True, "max_rounds": 2},
            )
            return first, calls_first, second

        first, calls_first, second = asyncio.run(scenario())

        assert first["status"] == "paused" and first["round_index"] == 2
        assert calls_first == 2
        assert second["status"] == "paused", second
        assert second["round_index"] == 4
        assert counter["calls"] - calls_first == 2, "fresh budget: 2 rounds"

    def test_replayed_rounds_do_not_advance_round_index(self, tmp_path):
        """W-b: after a restart, SK's request index also counts the replayed
        requests; they must not advance round_index nor eat the budget."""
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        gate = _gate_dict(_state_probe(state))
        store_root = tmp_path / "store"
        execs: dict = {}

        m1 = _step_manager(gate, store_root, execs)
        first = asyncio.run(
            m1.call_agent(prompt="go", agent_id="a-x", options={"max_rounds": 1})
        )
        assert first["status"] == "paused" and first["round_index"] == 1
        cid = first["conversation_id"]

        m2 = _step_manager(gate, store_root, execs)  # restart
        second = asyncio.run(
            m2.call_agent(
                prompt="",
                agent_id="a-x",
                conversation_id=cid,
                options={"continue": True, "max_rounds": 1},
            )
        )
        # Round 1 replayed from the journal, round 2 ran for real: the
        # budget of 1 is spent by round 2, which is the TRUE epoch round 2.
        assert second["status"] == "paused", second
        assert second["round_index"] == 2
        assert execs == {1: 1, 2: 1}

        third = asyncio.run(
            m2.call_agent(
                prompt="",
                agent_id="a-x",
                conversation_id=cid,
                options={"continue": True},
            )
        )
        assert third["status"] == "completed", third
        assert third["round_index"] == 3
        assert third["response"] == "final-answer"
        assert execs == {1: 1, 2: 1, 3: 1}, "every step ran exactly once"


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
        # Nothing was committed: retry the call, never continue it (C3).
        assert result["resumable"] is False
        assert result["retry_only"] is True
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


class TestAllocatedConversationId:
    """C1: a call WITHOUT conversation_id keys its thread, lock, rollback
    and envelope by the one id it returns."""

    def test_timeout_without_conversation_id(self, tmp_path):
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state)), sleep_s=0.7
        )

        async def scenario():
            timed_out = await manager.call_agent(
                prompt="slow", agent_id="a-x", timeout=1
            )
            conv = timed_out["conversation_id"]
            # The rollback hit the thread the caller can name.
            assert conv in manager._threads
            assert _user_texts(manager, conv) == []
            assert set(manager._conv_locks) == {conv}
            service.sleep_s = 0.0
            again = await manager.call_agent(
                prompt="again", agent_id="a-x", conversation_id=conv
            )
            more = await manager.call_agent(
                prompt="more", agent_id="a-x", conversation_id=conv
            )
            return timed_out, again, more

        timed_out, again, more = asyncio.run(scenario())

        conv = timed_out["conversation_id"]
        assert "timed out" in timed_out["error"]
        assert again["conversation_id"] == more["conversation_id"] == conv
        assert again["turn_index"] == 1  # the timed-out turn gave it back
        assert _user_texts(manager, conv) == ["again", "more"]
        # One conversation, one lock — no orphan entry per call.
        assert set(manager._conv_locks) == set(manager._threads) == {conv}

    def test_pause_without_conversation_id_resumes_on_returned_id(self, tmp_path):
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state))
        )

        async def scenario():
            paused = await manager.call_agent(
                prompt="go", agent_id="a-x", options={"max_rounds": 1}
            )
            conv = paused["conversation_id"]
            assert conv in manager._threads
            assert set(manager._conv_locks) == {conv}
            done = await manager.call_agent(
                prompt="",
                agent_id="a-x",
                conversation_id=conv,
                options={"continue": True},
            )
            return paused, done

        paused, done = asyncio.run(scenario())

        conv = paused["conversation_id"]
        assert paused["status"] == "paused"
        assert done["status"] == "completed", done
        assert done["response"] == "final-answer"
        assert counter["calls"] == 1
        assert set(manager._conv_locks) == set(manager._threads) == {conv}
        manager.end_conversation(conv)
        assert manager._conv_locks == {} and manager._threads == {}

    def test_refusals_without_conversation_id_leave_no_lock(self, tmp_path):
        """W-c: a refused call without conversation_id, ended before its
        thread exists, must not leave its lock behind."""
        state = tmp_path / "gate-state.txt"
        state.write_text("red")
        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state))
        )

        async def scenario():
            refusals = [
                await manager.call_agent(prompt="x", agent_id="a-x")
                for _ in range(5)
            ]
            assert manager._conv_locks == {} and manager._threads == {}
            # The named id still works: retry it once the gate is green.
            state.write_text("green")
            conv = refusals[-1]["conversation_id"]
            retry = await manager.call_agent(
                prompt="x", agent_id="a-x", conversation_id=conv
            )
            return refusals, retry

        refusals, retry = asyncio.run(scenario())

        ids = {r["conversation_id"] for r in refusals}
        assert len(ids) == 5
        assert all(r["retry_only"] is True for r in refusals)
        assert retry["status"] == "completed", retry
        assert set(manager._conv_locks) == set(manager._threads) == {
            refusals[-1]["conversation_id"]
        }


class TestResumeTimeoutKeepsEpoch:
    """C2: a timed-out RESUME rolls back only what the resume added."""

    def test_restart_continue_timeout_keeps_prompt_and_journal(self, tmp_path):
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        store_root = tmp_path / "store"
        store = ConversationStore(store_root)

        # Process 1: budget-pause after round 1 (tool ran once, journaled).
        m1, s1, c1 = _turn_manager(
            _gate_dict(_state_probe(state)), store_root=store_root
        )
        first = asyncio.run(
            m1.call_agent(prompt="go", agent_id="a-x", options={"max_rounds": 1})
        )
        assert first["status"] == "paused"
        cid = first["conversation_id"]
        assert c1["calls"] == 1
        assert store.load_journal(cid) is not None

        # Process 2 (restart): the resume times out mid replay.
        m2, s2, c2 = _turn_manager(
            _gate_dict(_state_probe(state)), store_root=store_root, sleep_s=1.5
        )
        timed_out = asyncio.run(
            m2.call_agent(
                prompt="",
                agent_id="a-x",
                conversation_id=cid,
                options={"continue": True},
                timeout=1,
            )
        )
        assert "timed out" in timed_out["error"]
        assert store.load_journal(cid) is not None, (
            "a timed-out resume must keep the durable journal"
        )
        assert _user_texts(m2, cid) == ["go"], "the paused turn's prompt is kept"
        assert timed_out["turn_index"] == 1
        assert m2._turn_counts[cid] == 1, "a resume never gives a turn back"

        # Relaunch the resume: journaled tool replayed, never re-executed.
        s2.sleep_s = 0.0
        done = asyncio.run(
            m2.call_agent(
                prompt="",
                agent_id="a-x",
                conversation_id=cid,
                options={"continue": True},
            )
        )
        assert done["status"] == "completed", done
        assert done["response"] == "final-answer"
        assert done["turn_index"] == 1
        assert c1["calls"] + c2["calls"] == 1, "the tool ran exactly once in total"
        assert _user_texts(m2, cid) == ["go"]
        assert store.load_journal(cid) is None  # completed turn clears it


class TestContinueRequiresPausedEpoch:
    """C3: continue resumes a paused epoch only; a refused fresh turn is
    retry-only."""

    def test_refused_fresh_turn_is_retry_only(self, tmp_path):
        state = tmp_path / "gate-state.txt"
        state.write_text("red")
        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state))
        )

        refusal = asyncio.run(
            manager.call_agent(
                prompt="the-real-prompt", agent_id="a-x", conversation_id="r4"
            )
        )
        assert refusal["status"] == "paused"
        assert refusal["resumable"] is False
        assert refusal["retry_only"] is True
        assert refusal["conversation_id"] == "r4"

        state.write_text("green")
        cont = asyncio.run(
            manager.call_agent(
                prompt="",
                agent_id="a-x",
                conversation_id="r4",
                options={"continue": True},
            )
        )
        assert cont["error_type"] == "no_paused_epoch", cont
        assert cont["status"] == "error"
        assert cont["conversation_id"] == "r4"
        assert service.model_calls == 0, "continue must not run the loop"

        retry = asyncio.run(
            manager.call_agent(
                prompt="the-real-prompt", agent_id="a-x", conversation_id="r4"
            )
        )
        assert retry["status"] == "completed", retry
        assert _user_texts(manager, "r4") == ["the-real-prompt"]

    def test_refused_continue_keeps_its_paused_epoch(self, tmp_path):
        state = tmp_path / "gate-state.txt"
        state.write_text("green")
        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state))
        )

        async def scenario():
            paused = await manager.call_agent(
                prompt="go", agent_id="a-x", options={"max_rounds": 1}
            )
            conv = paused["conversation_id"]
            state.write_text("red")
            refused = await manager.call_agent(
                prompt="",
                agent_id="a-x",
                conversation_id=conv,
                options={"continue": True},
            )
            state.write_text("green")
            done = await manager.call_agent(
                prompt="",
                agent_id="a-x",
                conversation_id=conv,
                options={"continue": True},
            )
            return paused, refused, done

        paused, refused, done = asyncio.run(scenario())

        assert paused["status"] == "paused"
        assert refused["status"] == "paused"
        assert refused["resumable"] is True  # the epoch is still paused
        assert "retry_only" not in refused
        assert done["status"] == "completed", done
        assert counter["calls"] == 1


class TestPauseIsExplicit:
    """W1: a mid-turn pause is never an empty success (#1587)."""

    def test_mid_turn_pause_has_paused_flag_and_response(self, tmp_path):
        state = tmp_path / "gate-state.txt"
        state.write_text("green")

        def flip_red_after_first(calls):
            if calls == 1:
                state.write_text("red")

        manager, service, counter = _turn_manager(
            _gate_dict(_state_probe(state)), on_tool=flip_red_after_first
        )

        paused = asyncio.run(manager.call_agent(prompt="go", agent_id="a-x"))

        assert paused["status"] == "paused"
        assert paused["paused"] is True
        assert "error" not in paused
        assert paused["response"].startswith("[paused: capacity_gate]")
        assert paused["pause"]["reason"] == "capacity_gate"

        # A non-paused response is unchanged.
        state.write_text("green")
        done = asyncio.run(manager.call_agent(prompt="hi", agent_id="a-x"))
        assert done["status"] == "completed"
        assert done["response"] == "final-answer"
        assert "paused" not in done and "pause" not in done


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
        hashed = hashlib.sha256(b"../evil").hexdigest()
        # Not stripped to "evil": named by its hash, inside the root.
        assert [p.name for p in tmp_path.iterdir()] == [f"{hashed}.json"]
        assert not (tmp_path / "evil.json").exists()
        assert not (tmp_path.parent / "evil.json").exists()
        assert store.load("../evil")["conversation_id"] == "../evil"

    def test_distinct_ids_never_share_a_file(self, tmp_path):
        """W3/W-e: stripping made "a.b"/"ab" collide; a case-insensitive FS
        folded "Conv"/"conv"; an id equal to sha256("a.b") named a.b's
        file. Every id is now hashed — on every FS, no pair shares a file."""
        store = ConversationStore(tmp_path)
        h_ab = hashlib.sha256(b"a.b").hexdigest()
        pairs = (
            ("a.b", "ab"),
            ("../evil", "evil"),
            ("a/b", "a_b"),
            ("Conv", "conv"),
            ("a.b", h_ab),
        )
        for a, b in pairs:
            assert store._path(a).name.lower() != store._path(b).name.lower(), (a, b)
            store.save(a, [], 1)
            store.save(b, [], 2)
            assert store.load(a)["conversation_id"] == a
            assert store.load(a)["turn_index"] == 1
            assert store.load(b)["conversation_id"] == b
        for weird in ("../evil", "..\\evil", "a/b", "x" * 129, "é"):
            assert store._path(weird).parent == tmp_path, weird
        # Every id — plain ones included — is named by its hash.
        for cid in ("pr-review_tier2", "x" * 129, "Conv"):
            assert store._path(cid).name == (
                hashlib.sha256(cid.encode()).hexdigest() + ".json"
            )

    def test_stored_id_mismatch_is_absent(self, tmp_path):
        """W-e: a file that holds ANOTHER conversation is never returned."""
        store = ConversationStore(tmp_path)
        store.save("conv", [{"role": "user", "content": "secret"}], 3)
        store.save_journal("conv", {"base_rounds": 1, "entries": [{"key": "k"}]})
        # Simulate a collision: Conv's files hold conv's state.
        store._path("Conv").write_bytes(store._path("conv").read_bytes())
        store._path("Conv", ".journal.json").write_bytes(
            store._path("conv", ".journal.json").read_bytes()
        )
        assert store.load("Conv") is None
        assert store.load_journal("Conv") is None
        assert store.load("conv")["turn_index"] == 3
        assert store.load_journal("conv")["conversation_id"] == "conv"

    def test_disabled_store_is_noop(self):
        store = ConversationStore(None)
        assert not store.enabled
        store.save("c1", [], 0)  # must not raise
        assert store.load("c1") is None


# ---------------------------------------------------------------------------
# CI wiring — these tests must actually run in the test-sk-agent job
# ---------------------------------------------------------------------------


class TestCiRunsTurnControl:
    def test_ci_sk_agent_job_runs_this_file(self):
        """The test-sk-agent job runs an explicit file list; this file was
        missing from it, so no turn-control test ran in CI."""
        ci = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml"
        if not ci.exists():
            pytest.skip("server copied without its repository (no ci.yml)")
        lines = ci.read_text(encoding="utf-8").splitlines()
        start = lines.index("  test-sk-agent:")
        job = []
        for line in lines[start + 1 :]:
            if line.startswith("  ") and not line.startswith("   ") and line.rstrip().endswith(":"):
                break  # next job
            job.append(line)
        pytest_lines = [line for line in job if "python -m pytest" in line]
        assert pytest_lines, "test-sk-agent job runs no pytest command"
        assert any(
            os.path.basename(__file__) in line.split() for line in pytest_lines
        ), "test_turn_control.py is missing from the test-sk-agent pytest list"
