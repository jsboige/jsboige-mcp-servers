"""Tests for #4741 — per-runtime MCP declarations and typed refusals.

Covers:
- config parsing/validation of ``runtimes`` and ``container`` (McpConfig),
- runtime identity via SK_AGENT_RUNTIME (default "stdio"),
- the typed refusal (McpRuntimeUnavailableError) raised BEFORE any kernel
  creation or LLM call when an agent requires an MCP its runtime does not
  serve,
- spawn refusal in _ensure_mcp_loaded without negative-cache pollution,
- the _collect_mcp_plugins parity (override/spec path),
- diagnostics reporting runtime + mcp_plugins_out_of_runtime,
- template/example declarations.

The two core behavioural tests (refusal + spawn refusal) are RED on the
pre-#4741 base: the agent used to be served silently stripped of the plugin.
"""

import asyncio
import json
from pathlib import Path

import pytest

import sk_agent
import sk_agent_config
import sk_conversations
from sk_agent_config import (
    AgentConfig,
    ConversationConfig,
    McpConfig,
    ModelConfig,
    SKAgentConfig,
)

HERE = Path(__file__).parent


def _make_manager(mcps, agents, models=None):
    """Build a SKAgentManager without start() — dicts only, no I/O."""
    cfg = SKAgentConfig(
        models=models if models is not None else [ModelConfig(id="test-model")],
        mcps=mcps,
        agents=agents,
    )
    return sk_agent.SKAgentManager(cfg)


# ---------------------------------------------------------------------------
# Runtime identity
# ---------------------------------------------------------------------------


class TestCurrentRuntime:
    def test_default_is_stdio(self, monkeypatch):
        monkeypatch.delenv("SK_AGENT_RUNTIME_ENV_UNUSED", raising=False)
        monkeypatch.delenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, raising=False)
        assert sk_agent_config.current_runtime() == "stdio"

    def test_reads_env_lowercased_trimmed(self, monkeypatch):
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "  Container ")
        assert sk_agent_config.current_runtime() == "container"

    def test_empty_env_falls_back_to_stdio(self, monkeypatch):
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "   ")
        assert sk_agent_config.current_runtime() == "stdio"


# ---------------------------------------------------------------------------
# McpConfig: runtimes + container parsing
# ---------------------------------------------------------------------------


class TestRuntimesParsing:
    def test_absent_means_all_runtimes(self):
        cfg = McpConfig.from_dict({"id": "x", "command": "cmd"})
        assert cfg.runtimes is None

    def test_empty_list_means_all_runtimes(self):
        cfg = McpConfig.from_dict({"id": "x", "command": "cmd", "runtimes": []})
        assert cfg.runtimes is None

    def test_lowercased(self):
        cfg = McpConfig.from_dict(
            {"id": "x", "command": "cmd", "runtimes": ["STDIO", "Container"]}
        )
        assert cfg.runtimes == ["stdio", "container"]

    @pytest.mark.parametrize("bad", ["stdio", [""], [42], {"stdio": True}])
    def test_invalid_rejected(self, bad):
        with pytest.raises(ValueError):
            McpConfig.from_dict({"id": "x", "command": "cmd", "runtimes": bad})

    def test_available_in_semantics(self):
        unrestricted = McpConfig(id="u", command="cmd")  # runtimes None
        assert unrestricted.available_in("stdio")
        assert unrestricted.available_in("container")

        stdio_only = McpConfig(id="s", command="cmd", runtimes=["stdio"])
        assert stdio_only.available_in("stdio")
        assert not stdio_only.available_in("container")


class TestContainerOverrideParsing:
    VALID = {
        "command": "/opt/venv-markitdown/bin/markitdown-mcp",
        "args": ["--port", "1"],
    }

    def test_valid_parses_and_roundtrips(self):
        cfg = McpConfig.from_dict(
            {"id": "x", "command": "cmd", "container": self.VALID}
        )
        assert cfg.container == self.VALID
        d = cfg.to_dict()
        assert d["container"] == self.VALID

    def test_absent_is_none(self):
        cfg = McpConfig.from_dict({"id": "x", "command": "cmd"})
        assert cfg.container is None
        assert "container" not in cfg.to_dict()

    @pytest.mark.parametrize(
        "bad",
        [
            {"command": "  "},  # blank command
            {"command": "c", "args": "not-a-list"},
            {"command": "c", "args": [1]},
            {"command": "c", "unknown": 1},
            {"args": ["a"]},  # no command
            "not-a-dict",
        ],
    )
    def test_invalid_rejected(self, bad):
        with pytest.raises(ValueError):
            McpConfig.from_dict({"id": "x", "command": "cmd", "container": bad})

    def test_empty_dict_is_none(self):
        cfg = McpConfig.from_dict({"id": "x", "command": "cmd", "container": {}})
        assert cfg.container is None


class TestEffectiveCommandArgs:
    def test_stdio_uses_host_fields_even_with_override(self):
        cfg = McpConfig(
            id="x",
            command="python",
            args=["-m", "markitdown_mcp.main"],
            container={"command": "/opt/venv/bin/markitdown-mcp", "args": []},
        )
        assert cfg.effective_command_args("stdio") == (
            "python",
            ["-m", "markitdown_mcp.main"],
        )

    def test_container_with_override_uses_it(self):
        cfg = McpConfig(
            id="x",
            command="python",
            args=["-m", "markitdown_mcp.main"],
            container={"command": "/opt/venv/bin/markitdown-mcp", "args": ["--x"]},
        )
        assert cfg.effective_command_args("container") == (
            "/opt/venv/bin/markitdown-mcp",
            ["--x"],
        )

    def test_container_without_override_uses_host_fields(self):
        """Portable plugins (npx …) keep one declaration for both runtimes."""
        cfg = McpConfig(id="x", command="npx", args=["-y", "mcp-searxng"])
        assert cfg.effective_command_args("container") == (
            "npx",
            ["-y", "mcp-searxng"],
        )


# ---------------------------------------------------------------------------
# Typed refusal — RED on the pre-#4741 base (agent was served stripped)
# ---------------------------------------------------------------------------


class TestAgentRefusal:
    def test_required_mcp_out_of_runtime_refused_typed(self, monkeypatch):
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "container")
        mgr = _make_manager(
            mcps=[
                McpConfig(
                    id="stdio-only", command="no-such-binary-4741", runtimes=["stdio"]
                )
            ],
            agents=[
                AgentConfig(id="needer", model="test-model", mcps=["stdio-only"])
            ],
        )
        with pytest.raises(sk_agent.McpRuntimeUnavailableError) as ei:
            asyncio.run(mgr._get_or_create_agent("needer"))
        payload = ei.value.to_payload()
        assert payload == {
            "error": "mcp_unavailable_in_runtime",
            "agent_id": "needer",
            "mcp_id": "stdio-only",
            "mcp_runtimes": ["stdio"],
            "runtime": "container",
        }
        # Refusal happens BEFORE creation: no agent may exist afterwards.
        assert "needer" not in mgr._sk_agents

    def test_no_false_refusal_for_portable_mcp(self, monkeypatch):
        """A plugin with runtimes=None (legacy/portable) never blocks."""
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "container")
        mgr = _make_manager(
            models=[],  # resolution stops AFTER the runtime gate, at the model
            mcps=[McpConfig(id="portable", command="cmd")],
            agents=[AgentConfig(id="a", model="missing-model", mcps=["portable"])],
        )
        # No McpRuntimeUnavailableError: gate passed, creation stopped later.
        assert asyncio.run(mgr._get_or_create_agent("a")) is None

    def test_stdio_runtime_never_refuses_stdio_scoped(self, monkeypatch):
        monkeypatch.delenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, raising=False)
        mgr = _make_manager(
            models=[],
            mcps=[
                McpConfig(id="stdio-mcp", command="cmd", runtimes=["stdio"])
            ],
            agents=[
                AgentConfig(id="a", model="missing-model", mcps=["stdio-mcp"])
            ],
        )
        assert asyncio.run(mgr._get_or_create_agent("a")) is None


class TestOptionalMcps:
    """#4741 review (b): declared-but-optional MCPs never refuse the agent.

    swift-delegator DECLARES sk_agent and must be SERVED WITHOUT it in the
    container (the plugin stays visible in mcp_plugins_out_of_runtime);
    notebook-* style agents (non-optional) keep the typed refusal.
    """

    def test_optional_mcp_served_without_in_container(self, monkeypatch):
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "container")
        mgr = _make_manager(
            models=[],  # resolution stops AFTER the runtime gate, at the model
            mcps=[
                McpConfig(
                    id="sk_agent", command="no-such-binary-4741", runtimes=["stdio"]
                )
            ],
            agents=[
                AgentConfig(
                    id="swift-delegator",
                    model="missing-model",
                    mcps=["sk_agent"],
                    optional_mcps=["sk_agent"],
                )
            ],
        )
        # No McpRuntimeUnavailableError: the gate skips the optional id.
        assert asyncio.run(mgr._get_or_create_agent("swift-delegator")) is None

    def test_same_agent_without_optional_is_still_refused(self, monkeypatch):
        """The other branch: non-optional references keep the typed refusal."""
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "container")
        mgr = _make_manager(
            models=[],
            mcps=[
                McpConfig(
                    id="sk_agent", command="no-such-binary-4741", runtimes=["stdio"]
                )
            ],
            agents=[
                AgentConfig(
                    id="notebook-coder", model="missing-model", mcps=["sk_agent"]
                )
            ],
        )
        with pytest.raises(sk_agent.McpRuntimeUnavailableError):
            asyncio.run(mgr._get_or_create_agent("notebook-coder"))

    def test_collect_mcp_plugins_skips_optional(self, monkeypatch):
        """The override/spec path honours optionality too (_collect_mcp_plugins)."""
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "container")
        mgr = _make_manager(
            mcps=[
                McpConfig(
                    id="stdio-only", command="no-such-binary-4741", runtimes=["stdio"]
                )
            ],
            agents=[],
        )
        # Optional: no raise, no plugin collected (spawn refused upstream).
        assert (
            asyncio.run(
                mgr._collect_mcp_plugins(
                    ["stdio-only"], "swift-delegator",
                    optional_mcp_ids=["stdio-only"],
                )
            )
            == []
        )
        # Non-optional in the same runtime: typed refusal unchanged.
        with pytest.raises(sk_agent.McpRuntimeUnavailableError):
            asyncio.run(mgr._collect_mcp_plugins(["stdio-only"], "notebook-coder"))

    def test_optional_plugin_still_visible_in_diagnostics(
        self, monkeypatch, tmp_path
    ):
        """Served-without must stay visible: the plugin is listed, not hidden."""
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "container")
        mgr = _make_manager(
            mcps=[
                McpConfig(id="sk_agent", command="cmd", runtimes=["stdio"]),
            ],
            agents=[
                AgentConfig(
                    id="swift-delegator",
                    model="test-model",
                    mcps=["sk_agent"],
                    optional_mcps=["sk_agent"],
                )
            ],
        )
        monkeypatch.setattr(sk_agent, "CONFIG_PATH", str(tmp_path / "absent.json"))
        monkeypatch.setattr(
            sk_agent, "_config_file_fingerprint", lambda: "fp", raising=True
        )
        monkeypatch.setattr(
            sk_agent, "_config_file_mtime_utc", lambda p: "never", raising=True
        )
        monkeypatch.setattr(sk_agent, "_manager", mgr, raising=True)
        monkeypatch.setattr(sk_agent, "_config_loaded_at", None, raising=True)
        monkeypatch.setattr(
            sk_agent, "_config_loaded_fingerprint", None, raising=True
        )

        result = json.loads(asyncio.run(sk_agent.diagnostics()))
        assert result["mcp_plugins_out_of_runtime"] == [
            {"id": "sk_agent", "runtimes": ["stdio"]}
        ]


class TestMalformedMcpIsolation:
    """#4741 review (d): one malformed MCP entry must not take down the seat.

    Mirrors _parse_agent_at (#1748): the seat keeps loading, the bad entry
    keeps its id as an inert, loudly-refused placeholder.
    """

    def test_malformed_entry_isolated_other_entries_parse(self, tmp_path):
        raw = {
            "config_version": 2,
            "models": [{"id": "m"}],
            "mcps": [
                {"id": "good", "command": "cmd"},
                {"id": "broken", "command": "cmd", "runtimes": "stdio"},
            ],
            "agents": [{"id": "a", "model": "m", "mcps": ["good", "broken"]}],
        }
        path = tmp_path / "cfg.json"
        path.write_text(json.dumps(raw), encoding="utf-8")

        loaded = sk_agent_config.load_config(str(path))  # must not raise

        by_id = {m.id: m for m in loaded.mcps}
        assert set(by_id) == {"good", "broken"}
        assert by_id["good"].config_error is None
        assert by_id["good"].command == "cmd"
        assert by_id["broken"].config_error  # named, not fatal
        assert by_id["broken"].command == ""  # inert placeholder
        # The rest of the config still parsed normally.
        assert loaded.get_model("m") is not None
        assert [a.id for a in loaded.agents] == ["a"]

    def test_rejected_mcp_never_spawns(self, monkeypatch):
        """The placeholder is refused loudly, without poisoning the cache."""
        mgr = _make_manager(
            mcps=[
                McpConfig(id="broken", config_error="runtimes must be a list of strings")
            ],
            agents=[],
        )

        async def _no_spawn(*a, **k):  # pragma: no cover - must not be reached
            raise AssertionError("rejected MCP must never spawn")

        monkeypatch.setattr(
            sk_agent, "SchemaNormalizingMCPStdioPlugin", _no_spawn, raising=True
        )
        assert asyncio.run(mgr._ensure_mcp_loaded("broken")) is False
        assert "broken" not in mgr._mcp_failed_until


class TestRunConversationRefusal:
    """#4741 review (c): the typed refusal must surface from run_conversation.

    The real ConversationRunner resolves agents through manager._get_or_create_agent,
    which raises McpRuntimeUnavailableError. run_conversation's catch must sit
    around ``runner.run(...)`` and return its JSON-string contract — not leak the
    exception, and not be placed in an unrelated handler (_handle_image).
    """

    def test_run_conversation_surfaces_typed_refusal_as_json(self, monkeypatch):
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "container")
        mgr = _make_manager(
            mcps=[
                McpConfig(
                    id="stdio-only", command="no-such-binary-4741", runtimes=["stdio"]
                )
            ],
            agents=[
                AgentConfig(id="needer", model="test-model", mcps=["stdio-only"])
            ],
        )
        mgr.config.conversations = [
            ConversationConfig(id="conv4741", type="sequential", agents=["needer"])
        ]
        runner = sk_conversations.ConversationRunner(
            mgr.config, mgr._sk_agents, mgr._get_or_create_agent
        )

        async def _fake_runner():
            return runner

        monkeypatch.setattr(sk_agent, "_get_conversation_runner", _fake_runner)

        raw = asyncio.run(
            sk_agent.run_conversation(prompt="hello", conversation="conv4741")
        )
        assert isinstance(raw, str)  # JSON-string contract preserved
        payload = json.loads(raw)
        assert payload["error"] == "mcp_unavailable_in_runtime"
        assert payload["agent_id"] == "needer"
        assert payload["mcp_id"] == "stdio-only"
        assert payload["runtime"] == "container"
        assert payload["conversation_id"] == "conv4741"
        # No agent may have been created by the refused conversation.
        assert "needer" not in mgr._sk_agents


class TestEnsureMcpLoadedRefusal:
    def test_out_of_runtime_never_spawns_and_does_not_poison_cache(
        self, monkeypatch
    ):
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "container")
        mgr = _make_manager(
            mcps=[
                McpConfig(
                    id="stdio-only", command="no-such-binary-4741", runtimes=["stdio"]
                )
            ],
            agents=[],
        )
        spawns = []

        class _Boom:
            def __init__(self, *a, **k):
                spawns.append((a, k))
                raise AssertionError("plugin must not spawn for out-of-runtime MCP")

        monkeypatch.setattr(
            sk_agent, "SchemaNormalizingMCPStdioPlugin", _Boom, raising=True
        )
        assert asyncio.run(mgr._ensure_mcp_loaded("stdio-only")) is False
        assert spawns == []
        # Runtime refusal is NOT a load failure: no negative-cache TTL, or a
        # later runtime change would stay masked for _MCP_FAILURE_TTL_S.
        assert "stdio-only" not in mgr._mcp_failed_until

    def test_container_override_used_at_spawn_in_container_runtime(
        self, monkeypatch
    ):
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "container")
        mgr = _make_manager(
            mcps=[
                McpConfig(
                    id="containerized",
                    command="python",
                    args=["host-args"],
                    container={
                        "command": "/opt/venv/bin/plugin",
                        "args": ["container-args"],
                    },
                )
            ],
            agents=[],
        )
        captured = {}

        class _FakePlugin:
            def __init__(self, command, args, **kwargs):
                captured["command"] = command
                captured["args"] = args
                # Simulate successful registration on the manager:
                # _ensure_mcp_loaded stores the plugin by id.

        async def _fake_register(self, mcp_id, plugin):  # pragma: no cover
            pass

        monkeypatch.setattr(
            sk_agent, "SchemaNormalizingMCPStdioPlugin", _FakePlugin, raising=True
        )
        # Run the gate; the plugin object is stored by _ensure_mcp_loaded's
        # post-construction code, so reaching the constructor with the
        # OVERRIDE command is the assertion that matters.
        try:
            asyncio.run(mgr._ensure_mcp_loaded("containerized"))
        except Exception:
            # Post-construction registration may need internals we faked;
            # the command capture below is the point of this test.
            pass
        assert captured.get("command") == "/opt/venv/bin/plugin"
        assert captured.get("args") == ["container-args"]


class TestCollectMcpPluginsParity:
    def test_override_path_raises_typed(self, monkeypatch):
        """agent_spec/mcp_overrides must refuse like the configured path."""
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "container")
        mgr = _make_manager(
            mcps=[
                McpConfig(id="ov", command="cmd", runtimes=["stdio"])
            ],
            agents=[],
        )
        with pytest.raises(sk_agent.McpRuntimeUnavailableError) as ei:
            asyncio.run(mgr._collect_mcp_plugins(["ov"], "spec-agent"))
        assert ei.value.mcp_id == "ov"

    def test_override_path_passes_portable(self, monkeypatch):
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "container")
        mgr = _make_manager(
            mcps=[McpConfig(id="portable", command="no-such-binary-4741")],
            agents=[],
        )
        # No raise: load attempt proceeds (and fails to spawn — missing
        # binary — returning an empty list, plugin-less but not refused).
        plugins = asyncio.run(mgr._collect_mcp_plugins(["portable"], "spec"))
        assert plugins == []


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------


class TestDiagnosticsRuntimeView:
    def test_reports_runtime_and_out_of_runtime(self, monkeypatch, tmp_path):
        monkeypatch.setenv(sk_agent_config.SK_AGENT_RUNTIME_ENV, "container")
        mgr = _make_manager(
            mcps=[
                McpConfig(id="stdio-only", command="cmd", runtimes=["stdio"]),
                McpConfig(id="portable", command="cmd"),
            ],
            agents=[],
        )
        # Point diagnostics at a config path that does not exist (skips the
        # disk parse) and stub the fingerprint helpers — the manager block
        # is what this test exercises.
        monkeypatch.setattr(sk_agent, "CONFIG_PATH", str(tmp_path / "absent.json"))
        monkeypatch.setattr(
            sk_agent, "_config_file_fingerprint", lambda: "fp", raising=True
        )
        monkeypatch.setattr(
            sk_agent,
            "_config_file_mtime_utc",
            lambda p: "never",
            raising=True
        )
        monkeypatch.setattr(sk_agent, "_manager", mgr, raising=True)
        monkeypatch.setattr(sk_agent, "_config_loaded_at", None, raising=True)
        monkeypatch.setattr(
            sk_agent, "_config_loaded_fingerprint", None, raising=True
        )

        result = json.loads(asyncio.run(sk_agent.diagnostics()))
        assert result["runtime"] == "container"
        assert result["mcp_plugins_out_of_runtime"] == [
            {"id": "stdio-only", "runtimes": ["stdio"]}
        ]


# ---------------------------------------------------------------------------
# Template + seat example declarations
# ---------------------------------------------------------------------------


class TestTemplateDeclarations:
    def test_template_validates_and_declares(self):
        from sk_agent_config import validate_config

        data = json.loads(
            (HERE / "sk_agent_config.template.json").read_text(encoding="utf-8")
        )
        assert validate_config(data) == []  # no semantic errors
        by_id = {m["id"]: m for m in data.get("mcps", [])}
        # sk_agent self-inclusion is stdio-only (container serves it natively)
        assert by_id["sk_agent"].get("runtimes") == ["stdio"]
        # markitdown spawns from the isolated container venv (#3411)
        assert by_id["markitdown"]["container"] == {
            "command": "/opt/venv-markitdown/bin/markitdown-mcp",
            "args": [],
        }
        # #4741 review (b): swift-delegator declares sk_agent as functional
        # in stdio only — it must be served WITHOUT it in the container.
        agents = {a["id"]: a for a in data.get("agents", [])}
        assert agents["swift-delegator"]["optional_mcps"] == ["sk_agent"]

    def test_nb_coder_example_declares_papermill_stdio(self):
        data = json.loads(
            (HERE / "nb_coder_seat_entries.example.json").read_text(
                encoding="utf-8"
            )
        )
        by_id = {m["id"]: m for m in data.get("mcps", [])}
        assert by_id["jupyter_papermill"].get("runtimes") == ["stdio"]


# ---------------------------------------------------------------------------
# Schema parity (ToolSpec)
# ---------------------------------------------------------------------------


class TestToolSpecSchema:
    def test_tool_spec_accepts_runtimes_and_container(self):
        from sk_agent_schemas import ToolSpec

        spec = ToolSpec(
            id="x", command="cmd", runtimes=["stdio"], container={"command": "c"}
        )
        assert spec.runtimes == ["stdio"]
        # schema-side validator normalizes args to [] like the config side
        assert spec.container == {"command": "c", "args": []}

    def test_tool_spec_rejects_invalid(self):
        from sk_agent_schemas import ToolSpec

        with pytest.raises(ValueError):
            ToolSpec(id="x", command="cmd", runtimes="stdio")
        with pytest.raises(ValueError):
            ToolSpec(
                id="x", command="cmd", container={"command": "c", "extra": 1}
            )
