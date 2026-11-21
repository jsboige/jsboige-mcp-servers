"""#4725: the nb-coder seat-local entries — validated as the seat will load them.

``nb_coder_seat_entries.example.json`` is the reviewable source of the
seat-local addition (the live ``sk_agent_config.json`` is gitignored and
carries keys). These tests pin the contract stated by roo-extensions#4725
(volet of CoursIA#26534):

- the fragment VALIDATES through the same ``validate_config`` the seat
  runs at load — criterion 1, mechanically;
- the four variants differ ONLY by the effective model;
- the Swift variant carries the DECLARED capacity gate, on a dedicated
  model id (the shared ``swift-1.5-27b`` entry stays ungated), and a red
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

#: #4832 on-demand operator presets — one per harness step, appended after
#: the builder variants. Same fragment = same state for scheduled and on-demand.
OPERATORS = (
    "nb-coder-spec",
    "nb-coder-code",
    "nb-coder-audit",
)

SWIFT_MODEL_ID = "swift-1.5-27b-nbcoder"


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
        assert tuple(a["id"] for a in fragment["agents"]) == VARIANTS + OPERATORS

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

        builders = fragment["agents"][: len(VARIANTS)]
        reference = comparable(builders[0])
        for agent in builders[1:]:
            assert comparable(agent) == reference, agent["id"]

    def test_each_variant_points_at_a_declared_model(self, fragment):
        model_ids = {m["id"] for m in fragment["models"]}
        for agent in fragment["agents"]:
            assert agent["model"] in model_ids

    def test_model_ids_are_distinct(self, fragment):
        ids = [m["id"] for m in fragment["models"]]
        assert len(ids) == len(set(ids))


class TestMidTurnCondensationDeclared:
    """#4816 volet 1, config side: the builder variants opt into the
    condensation block — without it, a pass that saturates the model
    window mid-turn dies on HTTP 400 before any turn-boundary condenser
    (CoursIA#27027: 262 145 > 262 144) can run."""

    def test_builders_enable_condensation(self, fragment):
        for variant in VARIANTS:
            block = _agent_by_id(fragment, variant)["condensation"]
            assert block["enabled"] is True, variant

    def test_operators_carry_no_condensation(self, fragment):
        """Operators are short-turn harness steps (#4832): the seam is
        inert for them, byte-for-byte legacy behaviour."""
        for operator in OPERATORS:
            assert "condensation" not in _agent_by_id(fragment, operator)

    def test_loader_reads_the_block(self, fragment):
        """Pin the full path, not just validation: the loader (not only
        the schema) must hand the block to ``AgentConfig``, where
        ``_get_or_create_condenser`` picks it up."""
        from sk_agent_config import _parse_config

        config = _parse_config(_config_payload(fragment))
        for variant in VARIANTS:
            loaded = next(a for a in config.agents if a.id == variant)
            assert loaded.condensation.get("enabled") is True, variant


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
        ``swift-1.5-27b`` entry would collaterally gate the auditor and
        every other Swift consumer. The fragment must not do that."""
        gated = [m["id"] for m in fragment["models"] if m.get("capacity_gate")]
        assert gated == [SWIFT_MODEL_ID]
        swift = _model_by_id(fragment, SWIFT_MODEL_ID)
        assert swift["model_id"] == "swift-1.5-27b"  # same engine as the auditor


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


NB_ALIASES = ("nb-luna", "nb-minimax", "nb-haiku")


class TestOperatorPresets:
    """#4832 — the on-demand door: one operator per harness step.

    The contract that makes 'n'importe quel agent MCP' safe: the operator
    carries nb_coder_tools + the harness capability (the plugin gate in
    sk_agent.py), NO MCP of its own (the step function is a kernel function,
    not a spawned server), a template model every seat already declares, and
    a prompt that forbids paraphrasing the envelope.
    """

    def test_operators_present_after_builders(self, fragment):
        ids = [a["id"] for a in fragment["agents"]]
        assert tuple(ids[len(VARIANTS):]) == OPERATORS

    def test_operators_declare_plugin_and_capability(self, fragment):
        for agent_id in OPERATORS:
            agent = _agent_by_id(fragment, agent_id)
            assert agent["parameters"]["nb_coder_tools"] is True, agent_id
            assert "shell" in agent["capabilities"], agent_id

    def test_operators_have_no_mcp(self, fragment):
        """Zero spawned MCPs: the step function is server-side. The operator
        cannot touch anything except through the workflow's own guards."""
        for agent_id in OPERATORS:
            assert _agent_by_id(fragment, agent_id)["mcps"] == [], agent_id

    def test_operators_run_on_a_template_model(self, fragment):
        for agent_id in OPERATORS:
            assert _agent_by_id(fragment, agent_id)["model"] == "glm-5.3", agent_id

    def test_operator_prompts_forbid_paraphrasing(self, fragment):
        for agent_id in OPERATORS:
            prompt = _agent_by_id(fragment, agent_id)["system_prompt"]
            assert "SANS MODIFICATION" in prompt, agent_id
            assert "n'appelle aucun autre outil" in prompt, agent_id

    def test_operators_memory_off(self, fragment):
        for agent_id in OPERATORS:
            assert _agent_by_id(fragment, agent_id)["memory"]["enabled"] is False

    def test_code_operator_prompt_names_the_dry_default(self, fragment):
        """max_stage default 2 = dry: the on-demand door must not deliver a PR
        by accident — delivery is an explicit caller decision."""
        prompt = _agent_by_id(fragment, "nb-coder-code")["system_prompt"]
        assert "max_stage" in prompt


class TestNbAliasesCarryLaneHeaders:
    """g4 (CoursIA#26534 c.6885222101): the claudish aliases must attribute
    themselves — the relay copies incoming headers but never adds the
    machine, so without client-side headers the per-lane ceiling, the
    emergency stop and the capture attribution have no hold — and they must
    ride the SEAT SIDECAR, which injects the cluster key and keeps the
    AUTONOMOUS fallback. Headers field itself: #4740 (ms#1765)."""

    def test_nb_aliases_declare_lane_and_machine_headers(self, fragment):
        for alias in NB_ALIASES:
            headers = _model_by_id(fragment, alias)["default_headers"]
            assert headers["x-claudish-lane"] == "nb-coder", alias
            machine = headers["X-Claudish-Machine"]
            assert machine and not machine.startswith("http"), alias

    def test_nb_aliases_target_the_seat_sidecar_not_the_hub(self, fragment):
        """Direct-to-hub routing bypasses the seat sidecar: no cluster key
        injection, no AUTONOMOUS fallback. The placeholder keeps the port
        per-seat — the apply step fills it."""
        for alias in NB_ALIASES:
            base_url = _model_by_id(fragment, alias)["base_url"]
            assert base_url.startswith("http://127.0.0.1:"), (alias, base_url)
            assert "<sidecar-port>" in base_url, alias
            assert "<fleet-hub-host>" not in base_url, alias

    def test_swift_entry_stays_headerless(self, fragment):
        """The Swift engine entry targets the vLLM endpoint directly —
        no claudish relay on that path, nothing to attribute."""
        swift = _model_by_id(fragment, SWIFT_MODEL_ID)
        assert "default_headers" not in swift

    def test_haiku_entry_is_noted_unpublished(self, fragment):
        """Coordinator 14/11: the native Anthropic path requires the
        client's own account — the entry stays armed-shaped but documented
        NOT PUBLISHED until that question is settled."""
        comment = _model_by_id(fragment, "nb-haiku")["_comment"]
        assert "NOT PUBLISHED" in comment