"""#4725: the nb-coder seat-local entries — validated as the seat will load them.

``nb_coder_seat_entries.example.json`` is the reviewable source of the
seat-local addition (the live ``sk_agent_config.json`` is gitignored and
carries keys). These tests pin the contract stated by roo-extensions#4725
(volet of CoursIA#26534):

- the fragment VALIDATES through the same ``validate_config`` the seat
  runs at load — criterion 1, mechanically;
- the four variants differ ONLY by the effective model;
- the Swift variant carries the DECLARED capacity gate, on a dedicated
  model id (the shared ``qwen3.6-35b-a3b`` entry stays ungated), and a red
  probe yields a typed ``capacity_gate_red`` refusal with NO LLM call —
  criterion 3;
- the GitHub surface is read-only: ``github_read`` in capabilities, and
  the plugin's kernel function list carries no write function — criterion 5;
- the system prompt encodes the #4716 workaround (``execute_on_kernel``
  only; ``execute_notebook_cell`` named as the known defect).

All probes are fake ``python -c`` snippets: no network, no vLLM, no sonde.
"""

import asyncio
import json
import os
import sys
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sk_agent  # noqa: F401 — same import order as test_capacity_gate
from sk_agent import SKAgentManager
from sk_agent_capacity_gate import clear_capacity_gate_cache
from sk_agent_config import AgentConfig, ModelConfig, SKAgentConfig, validate_config
from github_plugin import GitHubPlugin

from semantic_kernel.functions.kernel_plugin import KernelPlugin


EXAMPLE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "nb_coder_seat_entries.example.json"
)

VARIANTS = (
    "notebook-coder",
    "notebook-coder-luna",
    "notebook-coder-minimax",
    "notebook-coder-haiku",
)

SWIFT_MODEL_ID = "qwen3.6-35b-a3b-nbcoder"


@pytest.fixture(scope="module")
def fragment():
    with open(EXAMPLE, encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture(autouse=True)
def _fresh_gate_cache():
    """The verdict cache is module-level: isolate every test."""
    clear_capacity_gate_cache()
    yield
    clear_capacity_gate_cache()


def _config_payload(fragment):
    """Wrap the fragment as the minimal config the seat validation sees.

    Deep-copied: ``validate_config`` normalises a tree in place
    (``mcps`` -> ``tools``), and the module-scoped fixture is shared.
    """
    return {
        "config_version": 2,
        "default_agent": "notebook-coder",
        "models": json.loads(json.dumps(fragment["models"])),
        "mcps": json.loads(json.dumps(fragment["mcps"])),
        "agents": json.loads(json.dumps(fragment["agents"])),
    }


def _model_by_id(fragment, model_id):
    return next(m for m in fragment["models"] if m["id"] == model_id)


def _agent_by_id(fragment, agent_id):
    return next(a for a in fragment["agents"] if a["id"] == agent_id)


class TestFragmentValidates:
    """Criterion 1, mechanically: the seat's own validator accepts it."""

    def test_no_validation_errors(self, fragment):
        assert validate_config(_config_payload(fragment)) == []

    def test_four_variants_present_and_ordered(self, fragment):
        assert tuple(a["id"] for a in fragment["agents"]) == VARIANTS

    def test_variants_differ_only_by_the_effective_model(self, fragment):
        """The issue's core constraint: the variants are the SAME entry,
        and only the model reference moves. ``id``, ``description`` and
        ``model`` carry the difference; ``_comment`` is editorial."""
        def comparable(agent):
            return {
                k: v
                for k, v in agent.items()
                if k not in ("id", "description", "model", "_comment")
            }

        reference = comparable(fragment["agents"][0])
        for agent in fragment["agents"][1:]:
            assert comparable(agent) == reference, agent["id"]

    def test_each_variant_points_at_a_declared_model(self, fragment):
        model_ids = {m["id"] for m in fragment["models"]}
        for agent in fragment["agents"]:
            assert agent["model"] in model_ids

    def test_model_ids_are_distinct(self, fragment):
        ids = [m["id"] for m in fragment["models"]]
        assert len(ids) == len(set(ids))


class TestSwiftCapacityGateDeclared:
    """Criterion 3, config side: the gate is DECLARED on the Swift model."""

    def test_swift_model_declares_the_gate(self, fragment):
        swift = _model_by_id(fragment, SWIFT_MODEL_ID)
        gate = swift["capacity_gate"]
        assert gate["command"], "the probe command must be declared"
        assert "SWIFT_GATE_URL" in gate["env"]
        assert gate["allow_yellow"] is False  # spec: exit 0 only
        assert gate["retry_after_s"] == 3600  # harness retries hourly

    def test_gate_sits_on_a_dedicated_id_not_the_shared_engine_entry(self, fragment):
        """The probe keys on the model id: gating the shared
        ``qwen3.6-35b-a3b`` entry would collaterally gate the auditor and
        every other Swift consumer. The fragment must not do that."""
        gated = [m["id"] for m in fragment["models"] if m.get("capacity_gate")]
        assert gated == [SWIFT_MODEL_ID]
        swift = _model_by_id(fragment, SWIFT_MODEL_ID)
        assert swift["model_id"] == "qwen3.6-35b-a3b"  # same engine as the auditor


class TestSwiftGateRefusesWithoutCallingTheLLM:
    """Criterion 3, runtime side: red probe -> typed refusal, zero LLM calls.

    The model entry is the fragment's, with only the probe replaced by a
    fake ``python -c`` that exits 2 — the rest of the shape is what the
    seat will load.
    """

    def _manager_with_swift(self, fragment, probe):
        swift = json.loads(json.dumps(_model_by_id(fragment, SWIFT_MODEL_ID)))
        swift["capacity_gate"]["command"] = probe
        model = ModelConfig.from_dict(swift)
        agent = AgentConfig(id="notebook-coder", model=model.id)
        manager = SKAgentManager.__new__(SKAgentManager)
        manager.config = SKAgentConfig(models=[model], agents=[agent])
        manager._threads = {}
        manager._thread_counter = 0
        manager._execution_settings = None
        manager._resolve_agent = AsyncMock(return_value=(agent.id, object()))
        manager._handle_text = AsyncMock(
            return_value={
                "response": "ok",
                "conversation_id": "c1",
                "agent_used": agent.id,
                "model_used": agent.model,
            }
        )
        return manager

    def test_red_probe_refuses_typed_without_an_llm_call(self, fragment):
        probe = [
            sys.executable,
            "-c",
            'import sys; sys.stdout.write(\'{"verdict": "red"}\\n\'); sys.exit(2)',
        ]
        manager = self._manager_with_swift(fragment, probe)

        result = asyncio.run(manager.call_agent(prompt="build the notebook"))

        assert result["error_type"] == "capacity_gate_red"
        assert result["model_used"] == SWIFT_MODEL_ID
        assert result["agent_used"] == "notebook-coder"
        assert result["retry_after_s"] == 3600
        assert manager._handle_text.call_count == 0

    def test_green_probe_lets_the_dispatch_through(self, fragment):
        probe = [sys.executable, "-c", "import sys; sys.exit(0)"]
        manager = self._manager_with_swift(fragment, probe)

        result = asyncio.run(manager.call_agent(prompt="build the notebook"))

        assert result.get("response") == "ok"
        assert manager._handle_text.call_count == 1

    def test_yellow_probe_refuses_because_allow_yellow_is_false(self, fragment):
        probe = [sys.executable, "-c", "import sys; sys.exit(1)"]
        manager = self._manager_with_swift(fragment, probe)

        result = asyncio.run(manager.call_agent(prompt="build the notebook"))

        assert result["error_type"] == "capacity_gate_yellow"
        assert manager._handle_text.call_count == 0


class TestGitHubSurfaceIsReadOnly:
    """Criterion 5: no write capability exposed to the model."""

    def test_capabilities_declare_read_only(self, fragment):
        for agent_id in VARIANTS:
            caps = _agent_by_id(fragment, agent_id)["capabilities"]
            assert "github_read" in caps, agent_id
            assert "github_write" not in caps, agent_id

    def test_kernel_function_list_has_no_write_function(self, fragment):
        agent = _agent_by_id(fragment, "notebook-coder")
        repo = agent["parameters"]["github_default_repo"]
        kernel_plugin = KernelPlugin.from_object(
            "github", GitHubPlugin(default_repo=repo, allow_write=False)
        )
        assert "post_review_comment" not in kernel_plugin.functions
        assert "get_pr_diff" in kernel_plugin.functions  # read surface present


class TestPromptCarriesTheKnownGotcha:
    """#4716 prerequisite: the prompt names the only correct execution path."""

    def test_execute_on_kernel_only(self, fragment):
        for agent_id in VARIANTS:
            prompt = _agent_by_id(fragment, agent_id)["system_prompt"]
            assert "execute_on_kernel" in prompt, agent_id
            assert "execute_notebook_cell" in prompt, agent_id
            assert "#4716" in prompt, agent_id

    def test_prompt_states_read_only_github_and_no_git_mutations(self, fragment):
        for agent_id in VARIANTS:
            prompt = _agent_by_id(fragment, agent_id)["system_prompt"]
            assert "LECTURE SEULE" in prompt, agent_id
            assert "git mutante" in prompt, agent_id

    def test_memory_is_disabled(self, fragment):
        for agent_id in VARIANTS:
            assert _agent_by_id(fragment, agent_id)["memory"]["enabled"] is False