#!/usr/bin/env python3
"""
Tests for à la carte agent/conversation composition specs (#3407).

Acceptance coverage:
1. Light agent (no tools) and heavy tooled agent created from specs.
2. Conversation with IDs and inline agents works for existing types.
3. Invalid or privileged overrides are refused.
4. Existing signatures and presets stay compatible (legacy paths unchanged).
5. Pydantic errors are actionable client-side (field paths + valid values).

All tests are offline: model services are constructed against unreachable
localhost endpoints (never invoked), MCP loading is faked, and handler /
group-chat execution is captured instead of run.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from sk_agent_config import (  # noqa: E402
    AgentConfig,
    McpConfig,
    ModelConfig,
    SKAgentConfig,
)
from sk_agent_specs import (  # noqa: E402
    AgentSpec,
    ConversationSpec,
    SpecError,
    apply_mcp_delta,
    effective_agent_config,
    effective_conversation_config,
    format_validation_error,
    parse_agent_spec,
    parse_conversation_spec,
    resolve_agent_spec,
    resolve_conversation_spec,
)
from sk_conversations import PRESETS, ConversationRunner  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def make_config() -> SKAgentConfig:
    """Two models, two MCPs, two agents — enough surface for spec tests."""
    return SKAgentConfig(
        default_agent="analyst",
        default_vision_agent="vision-analyst",
        system_prompt="Global fallback prompt.",
        models=[
            ModelConfig(
                id="text-model",
                model_id="glm-5",
                base_url="http://127.0.0.1:9/v1",
                api_key="secret-text-key",
            ),
            ModelConfig(
                id="vision-model",
                model_id="glm-5v",
                base_url="http://127.0.0.1:9/v1",
                api_key="secret-vision-key",
                vision=True,
            ),
            ModelConfig(
                id="disabled-model",
                model_id="old",
                base_url="http://127.0.0.1:9/v1",
                enabled=False,
            ),
        ],
        mcps=[
            McpConfig(id="searxng", command="echo"),
            McpConfig(id="wincli", command="echo"),
        ],
        agents=[
            AgentConfig(
                id="analyst",
                description="Text analyst",
                model="text-model",
                system_prompt="You are an analyst.",
                mcps=["searxng"],
                parameters={"github_tools": False},
            ),
            AgentConfig(
                id="vision-analyst",
                model="vision-model",
                system_prompt="You see things.",
                mcps=["searxng", "wincli"],
            ),
        ],
    )


class FakePlugin:
    def __init__(self, name: str):
        self.name = name


class FakeAgent:
    def __init__(self, name: str):
        self.name = name


def make_manager(monkeypatch):
    """Offline SKAgentManager with faked MCP loading and load tracking."""
    import sk_agent  # heavy import, after sys.path setup

    config = make_config()
    manager = sk_agent.SKAgentManager(config)
    asyncio.run(manager._init_model_pool())

    manager._mcp_plugins = {
        "searxng": FakePlugin("searxng"),
        "wincli": FakePlugin("wincli"),
    }
    loads: list[str] = []

    async def fake_ensure(mcp_id: str) -> bool:
        loads.append(mcp_id)
        return mcp_id in manager._mcp_plugins

    monkeypatch.setattr(manager, "_ensure_mcp_loaded", fake_ensure)
    manager._test_loads = loads
    return manager


def capture_text_handler(manager, captured: dict):
    async def fake_handle_text(
        agent_id, agent, prompt, conversation_id, include_steps,
        model_override=None, sampling_override=None,
    ):
        captured.update(
            agent_id=agent_id,
            agent=agent,
            prompt=prompt,
            model_override=model_override,
            sampling_override=sampling_override,
        )
        return {
            "response": "ok",
            "conversation_id": "c1",
            "agent_used": agent_id,
            "model_used": "stub",
        }

    manager._handle_text = fake_handle_text


# ---------------------------------------------------------------------------
# Pydantic validation — actionable errors + policy surface (acceptance 3, 5)
# ---------------------------------------------------------------------------


class TestSpecValidation:
    def test_minimal_spec_parses(self):
        spec = parse_agent_spec({})
        assert spec.extends == ""
        assert spec.model == ""
        assert spec.system_prompt is None

    def test_unknown_field_refused_with_path(self):
        with pytest.raises(Exception) as exc_info:
            parse_agent_spec({"temperatur": 0.5})
        err = format_validation_error(exc_info.value, "agent_spec")
        assert "agent_spec.temperatur" in err["details"][0]
        assert "validation failed" in err["error"]

    def test_privileged_fields_not_expressible(self):
        """Policy: specs cannot define endpoints, credentials or commands."""
        for privileged in (
            {"api_key": "sk-leak"},
            {"base_url": "http://evil"},
            {"command": "rm -rf"},
            {"env": {"X": "1"}},
            # List-form mcps fails as a TYPE error (McpDeltaSpec expects a
            # dict), NOT extra_forbidden — the container echo must be
            # suppressed too (found by execution on ai-01's surgical fix).
            {"mcps": [{"id": "evil", "command": "nc"}]},
            {"enabled": True},
        ):
            with pytest.raises(Exception) as exc_info:
                parse_agent_spec(privileged)
            # Refusing the field must not ECHO its value (credentials path):
            # extra_forbidden names the field; container (dict/list) inputs
            # on type errors dump the raw payload. Scalars stay echoed.
            err = format_validation_error(exc_info.value, "agent_spec")
            assert "(input=" not in json.dumps(err), privileged
            assert "sk-leak" not in json.dumps(err), privileged

    def test_mcp_replace_exclusive_with_add(self):
        with pytest.raises(Exception):
            parse_agent_spec({"mcps": {"replace": ["searxng"], "add": ["wincli"]}})

    def test_sampling_bounds_actionable(self):
        with pytest.raises(Exception) as exc_info:
            parse_agent_spec({"sampling": {"temperature": 5.0}})
        err = format_validation_error(exc_info.value, "agent_spec")
        assert "sampling.temperature" in err["details"][0]

    def test_sampling_partial_ok(self):
        spec = parse_agent_spec({"sampling": {"max_tokens": 512}})
        assert spec.sampling.overrides() == {"max_tokens": 512}

    def test_conversation_spec_validation(self):
        with pytest.raises(Exception):
            parse_conversation_spec({"type": "bogus"})
        with pytest.raises(Exception):
            parse_conversation_spec({"agents": ["a"], "add_agents": ["b"]})
        with pytest.raises(Exception):
            parse_conversation_spec({"max_rounds": 500})
        with pytest.raises(Exception):
            parse_conversation_spec(
                {"inline_agents": [{"system_prompt": "no id"}]}
            )

    def test_conversation_valid_shape(self):
        spec = parse_conversation_spec(
            {
                "extends": "deep-think",
                "type": "sequential",
                "add_agents": ["analyst"],
                "inline_agents": [
                    {"id": "socratic", "system_prompt": "Ask questions."}
                ],
                "max_rounds": 4,
            }
        )
        assert spec.extends == "deep-think"
        assert spec.inline_agents[0].id == "socratic"


# ---------------------------------------------------------------------------
# Pure agent spec resolution — deterministic precedence (acceptance 1, 3)
# ---------------------------------------------------------------------------


class TestResolveAgentSpec:
    def setup_method(self):
        self.config = make_config()

    def test_no_base_no_fields_defaults_to_default_agent_model(self):
        merged, sampling = resolve_agent_spec(self.config, AgentSpec(), None)
        assert merged.model == "text-model"  # default agent's model
        assert sampling is None
        assert merged.id == "spec-agent"

    def test_extends_inherits_preset_fields(self):
        base = self.config.get_agent("analyst")
        merged, _ = resolve_agent_spec(self.config, AgentSpec(extends="analyst"), base)
        assert merged.system_prompt == "You are an analyst."
        assert merged.mcps == ["searxng"]
        assert merged.model == "text-model"

    def test_spec_overrides_preset(self):
        base = self.config.get_agent("analyst")
        spec = AgentSpec(
            model="vision-model",
            system_prompt="Custom role.",
            mcps={"add": ["wincli"]},
        )
        merged, _ = resolve_agent_spec(self.config, spec, base)
        assert merged.model == "vision-model"
        assert merged.system_prompt == "Custom role."
        assert merged.mcps == ["searxng", "wincli"]

    def test_call_override_beats_spec_beats_preset(self):
        base = self.config.get_agent("analyst")
        spec = AgentSpec(model="vision-model", system_prompt="spec prompt")
        merged, _ = resolve_agent_spec(
            self.config,
            spec,
            base,
            call_model_override=None,
            call_system_prompt="call prompt",
        )
        assert merged.system_prompt == "call prompt"

        merged, _ = resolve_agent_spec(
            self.config, spec, base, call_model_override="text-model"
        )
        assert merged.model == "text-model"

    def test_mcps_replace_empty_disables_tools(self):
        base = self.config.get_agent("vision-analyst")
        spec = AgentSpec(mcps={"replace": []})
        merged, _ = resolve_agent_spec(self.config, spec, base)
        assert merged.mcps == []

    def test_call_mcp_delta_applies_after_spec_delta(self):
        base = self.config.get_agent("vision-analyst")  # [searxng, wincli]
        spec = AgentSpec(mcps={"remove": ["wincli"]})
        merged, _ = resolve_agent_spec(
            self.config, spec, base, call_mcp_overrides={"add": ["wincli"]}
        )
        assert merged.mcps == ["searxng", "wincli"]

    def test_memory_spec_overrides_preset(self):
        base = self.config.get_agent("analyst")
        merged, _ = resolve_agent_spec(self.config, AgentSpec(memory={"enabled": True}), base)
        assert merged.memory.enabled is True

    def test_parameters_merge_spec_wins(self):
        base = AgentConfig(
            id="analyst", model="text-model", parameters={"a": 1, "b": 2}
        )
        merged, _ = resolve_agent_spec(
            self.config, AgentSpec(parameters={"b": 99, "c": 3}), base
        )
        assert merged.parameters == {"a": 1, "b": 99, "c": 3}

    def test_unknown_model_refused_with_valid_values(self):
        with pytest.raises(SpecError) as exc_info:
            resolve_agent_spec(
                self.config, AgentSpec(model="ghost"), None
            )
        assert "ghost" in str(exc_info.value)
        assert any("text-model" in d for d in exc_info.value.details)

    def test_disabled_model_refused(self):
        with pytest.raises(SpecError):
            resolve_agent_spec(self.config, AgentSpec(model="disabled-model"), None)

    def test_unknown_mcp_refused_with_valid_values(self):
        base = self.config.get_agent("analyst")
        with pytest.raises(SpecError) as exc_info:
            resolve_agent_spec(
                self.config, AgentSpec(mcps={"add": ["ghost-mcp"]}), base
            )
        assert any("searxng" in d for d in exc_info.value.details)


class TestApplyMcpDelta:
    """The shared primitive must keep the legacy override semantics."""

    def test_none_returns_copy_of_base(self):
        assert apply_mcp_delta(["a"], None) == ["a"]

    def test_replace_wins(self):
        assert apply_mcp_delta(["a"], {"replace": ["b"], "add": ["c"]}) == ["b"]

    def test_add_remove_ordered(self):
        assert apply_mcp_delta(
            ["a", "b"], {"add": ["c"], "remove": ["b"]}
        ) == ["a", "c"]


# ---------------------------------------------------------------------------
# call_agent spec path — light/heavy agents, effective config (acceptance 1, 4)
# ---------------------------------------------------------------------------


class TestCallAgentSpecPath:
    def test_light_agent_no_tools(self, monkeypatch):
        manager = make_manager(monkeypatch)
        captured: dict = {}
        capture_text_handler(manager, captured)

        result = asyncio.run(
            manager.call_agent(
                prompt="hi",
                agent_spec={
                    "extends": "analyst",
                    "mcps": {"replace": []},
                    "memory": {"enabled": False},
                    "sampling": {"temperature": 0.2, "max_tokens": 512},
                },
            )
        )

        assert "error" not in result, result
        assert manager._test_loads == []  # no MCP loaded for a light agent
        assert result["agent_spec_applied"] is True
        eff = result["effective_config"]
        assert eff["mcps"] == []
        assert eff["model"] == "text-model"
        assert eff["extends"] == "analyst"
        assert eff["sampling"] == {"temperature": 0.2, "max_tokens": 512}
        assert result["model_used"] == "text-model"
        # sampling threaded to the handler
        assert captured["sampling_override"] == {
            "temperature": 0.2,
            "max_tokens": 512,
        }
        # light agent was built with zero plugins
        assert captured["agent"].name == "sk-agent-spec-analyst-spec"

    def test_heavy_agent_tooled(self, monkeypatch):
        manager = make_manager(monkeypatch)
        captured: dict = {}
        capture_text_handler(manager, captured)

        result = asyncio.run(
            manager.call_agent(
                prompt="hi",
                agent_spec={
                    "extends": "analyst",
                    "model": "vision-model",
                    "mcps": {"add": ["wincli"]},
                },
            )
        )

        assert "error" not in result, result
        assert sorted(manager._test_loads) == ["searxng", "wincli"]
        eff = result["effective_config"]
        assert eff["mcps"] == ["searxng", "wincli"]
        assert eff["model"] == "vision-model"
        # model change threads through to the handler (thinking config)
        assert captured["model_override"] == "vision-model"
        assert captured["agent_id"] == "analyst[vision-model]"
        assert result["model_used"] == "vision-model"

    def test_sampling_reaches_invoke_settings(self, monkeypatch):
        manager = make_manager(monkeypatch)
        kwargs = manager._get_invoke_kwargs(
            "analyst", None, {"temperature": 0.2, "max_tokens": 512}
        )
        settings = kwargs["arguments"].execution_settings["default"]
        assert settings.temperature == 0.2
        assert settings.max_tokens == 512
        # unspecified fields keep server defaults
        assert settings.top_p == 1.0

    def test_effective_config_has_no_secrets(self, monkeypatch):
        manager = make_manager(monkeypatch)
        capture_text_handler(manager, {})

        result = asyncio.run(
            manager.call_agent(prompt="hi", agent_spec={"extends": "analyst"})
        )
        blob = json.dumps(result)
        assert "api_key" not in blob
        assert "base_url" not in blob
        assert "secret" not in blob

    def test_invalid_json_shape_refused(self, monkeypatch):
        manager = make_manager(monkeypatch)
        result = asyncio.run(
            manager.call_agent(prompt="hi", agent_spec={"unknown": 1})
        )
        assert "error" in result
        assert any("unknown" in d for d in result["details"])

    def test_unknown_extends_refused_with_valid_values(self, monkeypatch):
        manager = make_manager(monkeypatch)
        result = asyncio.run(
            manager.call_agent(prompt="hi", agent_spec={"extends": "ghost"})
        )
        assert "ghost" in result["error"]
        assert any("analyst" in d for d in result["details"])

    def test_unknown_model_refused(self, monkeypatch):
        manager = make_manager(monkeypatch)
        result = asyncio.run(
            manager.call_agent(prompt="hi", agent_spec={"model": "ghost"})
        )
        assert "refused" in result["error"]
        assert any("text-model" in d for d in result["details"])

    def test_unknown_mcp_refused(self, monkeypatch):
        manager = make_manager(monkeypatch)
        result = asyncio.run(
            manager.call_agent(
                prompt="hi", agent_spec={"mcps": {"replace": ["ghost-mcp"]}}
            )
        )
        assert "refused" in result["error"]
        assert any("searxng" in d for d in result["details"])


class TestCallAgentLegacyCompat:
    """Acceptance 4: signatures and presets stay compatible."""

    def test_no_spec_no_new_keys(self, monkeypatch):
        manager = make_manager(monkeypatch)
        captured: dict = {}
        capture_text_handler(manager, captured)

        result = asyncio.run(manager.call_agent(prompt="hi"))

        assert "error" not in result
        assert "agent_spec_applied" not in result
        assert "effective_config" not in result
        assert captured["sampling_override"] is None
        assert captured["model_override"] is None

    def test_legacy_overrides_unchanged(self, monkeypatch):
        manager = make_manager(monkeypatch)
        captured: dict = {}
        capture_text_handler(manager, captured)

        result = asyncio.run(
            manager.call_agent(
                prompt="hi",
                model_override="vision-model",
                system_prompt="Call-level role.",
                mcp_overrides={"add": ["wincli"]},
            )
        )

        assert "error" not in result, result
        # base agent creation + temp-agent override both hit the loader
        assert set(manager._test_loads) == {"searxng", "wincli"}
        assert result["model_override"] == "vision-model"
        assert result["model_used"] == "vision-model"
        assert captured["model_override"] == "vision-model"
        # with a temp agent, system_prompt is baked into instructions — no prefix
        assert captured["prompt"] == "hi"
        assert captured["agent"].instructions == "Call-level role."

    def test_legacy_system_prompt_alone_injected_as_prefix(self, monkeypatch):
        manager = make_manager(monkeypatch)
        captured: dict = {}
        capture_text_handler(manager, captured)

        asyncio.run(
            manager.call_agent(prompt="hi", system_prompt="Call-level role.")
        )
        # without overrides the prompt is prefixed, legacy behavior intact
        assert captured["prompt"].startswith("<system-override>")
        assert "Call-level role." in captured["prompt"]

    def test_legacy_call_without_spec_still_works_with_agent_id(self, monkeypatch):
        manager = make_manager(monkeypatch)
        captured: dict = {}
        capture_text_handler(manager, captured)

        asyncio.run(manager.call_agent(prompt="hi", agent_id="vision-analyst"))
        assert captured["agent_id"] == "vision-analyst"


# ---------------------------------------------------------------------------
# Conversation spec resolution + runner (acceptance 2)
# ---------------------------------------------------------------------------


class TestResolveConversationSpec:
    def setup_method(self):
        self.config = make_config()

    def test_extends_preset_inherits_and_adds(self):
        base = PRESETS["deep-think"]
        spec = parse_conversation_spec(
            {"extends": "deep-think", "add_agents": ["analyst"]}
        )
        conv = resolve_conversation_spec(self.config, spec, base)
        assert conv.type == "group_chat"
        assert conv.agents == [
            "optimist", "devils-advocate", "pragmatist", "mediator", "analyst",
        ]
        assert conv.max_rounds == base.max_rounds
        # preset inline agents preserved
        assert {a.id for a in conv.inline_agents} >= {"optimist", "mediator"}

    def test_replace_agents_and_type(self):
        spec = parse_conversation_spec(
            {"agents": ["analyst", "vision-analyst"], "type": "concurrent"}
        )
        conv = resolve_conversation_spec(self.config, spec, None)
        assert conv.agents == ["analyst", "vision-analyst"]
        assert conv.type == "concurrent"

    def test_inline_agent_with_tools(self):
        spec = parse_conversation_spec(
            {
                "agents": ["analyst", "scribe"],
                "inline_agents": [
                    {
                        "id": "scribe",
                        "system_prompt": "You take notes.",
                        "mcps": {"replace": ["wincli"]},
                    }
                ],
            }
        )
        conv = resolve_conversation_spec(self.config, spec, None)
        scribe = next(a for a in conv.inline_agents if a.id == "scribe")
        assert scribe.mcps == ["wincli"]
        assert scribe.system_prompt == "You take notes."
        assert scribe.model == "text-model"  # default agent model

    def test_inline_spec_replaces_preset_inline_same_id(self):
        base = PRESETS["deep-search"]
        spec = parse_conversation_spec(
            {
                "extends": "deep-search",
                "inline_agents": [
                    {"id": "critic", "system_prompt": "Harsher critic."}
                ],
            }
        )
        conv = resolve_conversation_spec(self.config, spec, base)
        critic = next(a for a in conv.inline_agents if a.id == "critic")
        assert critic.system_prompt == "Harsher critic."

    def test_unknown_agent_refused(self):
        spec = parse_conversation_spec({"agents": ["analyst", "ghost"]})
        with pytest.raises(SpecError) as exc_info:
            resolve_conversation_spec(self.config, spec, None)
        assert any("configured agents" in d for d in exc_info.value.details)

    def test_effective_conversation_no_prompts_no_secrets(self):
        spec = parse_conversation_spec(
            {"agents": ["analyst"], "inline_agents": [
                {"id": "scribe", "system_prompt": "x", "mcps": {"replace": ["searxng"]}}
            ]}
        )
        conv = resolve_conversation_spec(self.config, spec, None)
        eff = effective_conversation_config(conv)
        blob = json.dumps(eff)
        assert "system_prompt" not in blob
        assert "api_key" not in blob
        assert eff["inline_agents"][0]["mcps"] == ["searxng"]


class TestConversationRunnerSpec:
    def _runner(self, monkeypatch, captured: dict):
        config = make_config()

        inline_legacy: list[str] = []
        inline_built: list[str] = []

        async def fake_factory(agent_id: str):
            # Config agents resolve via the factory, like the real manager
            if config.get_agent(agent_id):
                return FakeAgent(f"factory-{agent_id}")
            return None

        def fake_create_inline(agent_cfg):
            inline_legacy.append(agent_cfg.id)
            return FakeAgent(f"inline-{agent_cfg.id}")

        async def fake_builder(agent_cfg):
            inline_built.append(agent_cfg.id)
            return FakeAgent(f"built-{agent_cfg.id}")

        async def fake_group_chat(prompt, agents, conv_config, max_rounds):
            captured.update(
                kind="group_chat",
                agents=[a.name for a in agents],
                conv=conv_config,
                max_rounds=max_rounds,
                prompt=prompt,
            )
            return {"response": "done", "steps": []}

        async def fake_concurrent(prompt, agents, conv_config):
            captured.update(
                kind="concurrent", agents=[a.name for a in agents], conv=conv_config
            )
            return {"response": "done", "steps": []}

        runner = ConversationRunner(
            config, {}, fake_factory, spec_agent_builder=fake_builder
        )
        monkeypatch.setattr(runner, "_create_inline_agent", fake_create_inline)
        monkeypatch.setattr(runner, "_run_group_chat", fake_group_chat)
        monkeypatch.setattr(runner, "_run_concurrent", fake_concurrent)
        runner._test_inline_legacy = inline_legacy
        runner._test_inline_built = inline_built
        return runner

    def test_ids_and_inline_for_sequential(self, monkeypatch):
        captured: dict = {}
        runner = self._runner(monkeypatch, captured)

        result = asyncio.run(
            runner.run(
                prompt="question",
                conversation_spec={
                    "extends": "deep-think",
                    "type": "sequential",
                    "add_agents": ["analyst", "scribe"],
                    "inline_agents": [
                        {"id": "scribe", "system_prompt": "notes"}
                    ],
                },
            )
        )

        assert "error" not in result, result
        assert captured["kind"] == "group_chat"  # sequential runs the group path
        names = captured["agents"]
        assert "factory-analyst" in names
        assert "inline-scribe" in names
        assert "inline-optimist" in names  # preset inline agents still resolve
        assert result["conversation_spec_applied"] is True
        eff = result["effective_conversation"]
        assert eff["type"] == "sequential"
        assert any(a["id"] == "scribe" for a in eff["inline_agents"])

    def test_concurrent_type_dispatch(self, monkeypatch):
        captured: dict = {}
        runner = self._runner(monkeypatch, captured)

        result = asyncio.run(
            runner.run(
                prompt="question",
                conversation_spec={
                    "agents": ["analyst", "vision-analyst"],
                    "type": "concurrent",
                },
            )
        )
        assert captured["kind"] == "concurrent"
        assert sorted(captured["agents"]) == [
            "factory-analyst",
            "factory-vision-analyst",
        ]
        assert result["effective_conversation"]["type"] == "concurrent"

    def test_group_chat_type_dispatch_with_max_rounds(self, monkeypatch):
        captured: dict = {}
        runner = self._runner(monkeypatch, captured)

        asyncio.run(
            runner.run(
                prompt="q",
                conversation_spec={"extends": "deep-think", "max_rounds": 3},
            )
        )
        assert captured["kind"] == "group_chat"
        assert captured["max_rounds"] == 3
        assert captured["conv"].type == "group_chat"

    def test_options_max_rounds_beats_spec(self, monkeypatch):
        captured: dict = {}
        runner = self._runner(monkeypatch, captured)

        asyncio.run(
            runner.run(
                prompt="q",
                options={"max_rounds": 2},
                conversation_spec={"extends": "deep-think", "max_rounds": 6},
            )
        )
        assert captured["max_rounds"] == 2

    def test_tooled_inline_agent_uses_builder(self, monkeypatch):
        captured: dict = {}
        runner = self._runner(monkeypatch, captured)

        asyncio.run(
            runner.run(
                prompt="q",
                conversation_spec={
                    "agents": ["scribe", "analyst"],
                    "inline_agents": [
                        {
                            "id": "scribe",
                            "system_prompt": "notes",
                            "mcps": {"replace": ["wincli"]},
                        }
                    ],
                },
            )
        )
        assert runner._test_inline_built == ["scribe"]
        assert "scribe" not in runner._test_inline_legacy
        assert "built-scribe" in captured["agents"]

    def test_unknown_agent_refused(self, monkeypatch):
        captured: dict = {}
        runner = self._runner(monkeypatch, captured)
        result = asyncio.run(
            runner.run(prompt="q", conversation_spec={"agents": ["ghost"]})
        )
        assert "refused" in result["error"]
        assert any("configured agents" in d for d in result["details"])

    def test_unknown_extends_refused(self, monkeypatch):
        captured: dict = {}
        runner = self._runner(monkeypatch, captured)
        result = asyncio.run(
            runner.run(prompt="q", conversation_spec={"extends": "ghost"})
        )
        assert "ghost" in result["error"]
        assert any("deep-think" in d for d in result["details"])

    def test_invalid_spec_shape_actionable(self, monkeypatch):
        captured: dict = {}
        runner = self._runner(monkeypatch, captured)
        result = asyncio.run(
            runner.run(prompt="q", conversation_spec={"type": "bogus"})
        )
        assert "validation failed" in result["error"]
        assert result["details"]

    def test_legacy_run_without_spec_unchanged(self, monkeypatch):
        captured: dict = {}
        runner = self._runner(monkeypatch, captured)

        result = asyncio.run(runner.run(prompt="q", conversation_id="ghost-conv"))
        assert "not found" in result["error"]
        assert "deep-search" in result["error"]  # available list intact

        result = asyncio.run(runner.run(prompt="q", conversation_id="deep-think"))
        assert "error" not in result
        assert "conversation_spec_applied" not in result
        assert captured["kind"] == "group_chat"


# ---------------------------------------------------------------------------
# Tool-layer compat (acceptance 4)
# ---------------------------------------------------------------------------


class TestToolLayerCompat:
    def test_tool_signatures_extended_optionally(self):
        import inspect

        import sk_agent

        call_params = inspect.signature(sk_agent.call_agent).parameters
        assert "agent_spec" in call_params
        assert call_params["agent_spec"].default == ""

        run_params = inspect.signature(sk_agent.run_conversation).parameters
        assert "conversation_spec" in run_params
        assert run_params["conversation_spec"].default == ""

        # every pre-existing parameter still present, same order prefix
        legacy_call = [
            "prompt", "agent", "attachment", "options", "conversation_id",
            "include_steps", "timeout", "model_override", "system_prompt",
            "mcp_overrides",
        ]
        assert list(call_params)[: len(legacy_call)] == legacy_call

        legacy_run = ["prompt", "conversation", "options", "conversation_id"]
        assert list(run_params)[: len(legacy_run)] == legacy_run

    def test_manager_call_agent_signature_back_compat(self):
        import inspect

        import sk_agent

        params = inspect.signature(
            sk_agent.SKAgentManager.call_agent
        ).parameters
        legacy = [
            "self", "prompt", "agent_id", "attachment", "options",
            "conversation_id", "include_steps", "model_id", "timeout",
            "model_override", "system_prompt", "mcp_overrides",
        ]
        assert list(params)[: len(legacy)] == legacy
        assert params["agent_spec"].default is None
