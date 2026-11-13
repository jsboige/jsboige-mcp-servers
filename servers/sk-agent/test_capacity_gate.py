"""#4712: per-model capacity gate consulted before agent dispatch.

Acceptance mapping (issue roo-extensions#4712):

- config: an absent ``capacity_gate`` keeps the exact legacy behaviour;
  invalid values are REFUSED at parse and by the Pydantic schema (the
  schema layer must not be looser than the parser); the field
  round-trips through ``to_dict`` only when declared;
- verdicts: exit 0 green / 1 yellow / 2 red, anything else — timeout,
  missing executable, spawn failure — unknown; the exit code is
  authoritative, the stdout JSON payload is informational detail;
- enforcement: red / unknown / yellow-without-allow_yellow refusals are
  typed errors naming the verdict, carry ``retry_after_s`` /
  ``model_used`` / ``agent_used`` / ``gate_detail``, and are produced
  WITHOUT any LLM call;
- scope: the gate keys on the EFFECTIVE model (agent default,
  ``model_override``, or ``agent_spec`` resolution), evaluated between
  two turns, never during a generation;
- cache: verdicts are cached per model id for ``cache_s`` seconds so a
  burst of dispatches does not become a burst of probes.

All probe commands are fake ``python -c`` snippets — no network, no real
vLLM, no real sonde.
"""

import asyncio
import ctypes
import json
import os
import sys
import time
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sk_agent
from sk_agent import SKAgentManager
from sk_agent_capacity_gate import (
    check_model_capacity_gate,
    clear_capacity_gate_cache,
    evaluate_capacity_gate,
    parse_capacity_gate,
)
from sk_agent_config import (
    AgentConfig,
    McpConfig,
    ModelConfig,
    SKAgentConfig,
    validate_config,
)


_UNSET = object()


@pytest.fixture(autouse=True)
def _fresh_gate_cache():
    """The verdict cache is module-level: isolate every test."""
    clear_capacity_gate_cache()
    yield
    clear_capacity_gate_cache()


# ---------------------------------------------------------------------------
# Fake probe commands — exit codes are the contract, stdout is detail
# ---------------------------------------------------------------------------


def _probe(exit_code: int, payload: dict | None = None) -> list[str]:
    """A fake sonde: optional one-line JSON payload, then a chosen exit."""
    if payload is None:
        return [sys.executable, "-c", f"import sys; sys.exit({exit_code})"]
    line = json.dumps(payload).replace('"', '\\"')
    return [
        sys.executable,
        "-c",
        f'import sys; print("{line}"); sys.exit({exit_code})',
    ]


def _counter_probe(counter_path: str, exit_code: int = 0) -> list[str]:
    """Appends one line per spawn — lets tests COUNT executions."""
    return [
        sys.executable,
        "-c",
        f"import sys; open(sys.argv[1], 'a').write('x\\n'); sys.exit({int(exit_code)})",
        counter_path,
    ]


def _gate(command: list[str], **overrides) -> dict:
    gate = {"command": command, "cache_s": 0}
    gate.update(overrides)
    return gate


# ---------------------------------------------------------------------------
# (a) Config parsing — absent = legacy, invalid = refused at parse
# ---------------------------------------------------------------------------


class TestGateParsing:
    def test_absent_means_no_gate(self):
        m = ModelConfig.from_dict({"id": "m"})
        assert m.capacity_gate is None
        assert "capacity_gate" not in m.to_dict()

    def test_explicit_none_means_no_gate(self):
        m = ModelConfig.from_dict({"id": "m", "capacity_gate": None})
        assert m.capacity_gate is None

    def test_valid_gate_parses_with_defaults(self):
        m = ModelConfig.from_dict(
            {"id": "m", "capacity_gate": {"command": ["probe", "--url", "x"]}}
        )
        assert m.capacity_gate == {
            "command": ["probe", "--url", "x"],
            "env": {},
            "allow_yellow": False,
            "cache_s": 10.0,
            "timeout_s": 10.0,
            "retry_after_s": 60,
        }

    def test_full_gate_parses_and_roundtrips(self):
        raw = {
            "command": ["probe"],
            "env": {"SWIFT_GATE_URL": "http://localhost:5002/metrics"},
            "allow_yellow": True,
            "cache_s": 30,
            "timeout_s": 2.5,
            "retry_after_s": 120,
        }
        m = ModelConfig.from_dict({"id": "m", "capacity_gate": raw})
        assert m.capacity_gate == {
            "command": ["probe"],
            "env": {"SWIFT_GATE_URL": "http://localhost:5002/metrics"},
            "allow_yellow": True,
            "cache_s": 30.0,
            "timeout_s": 2.5,
            "retry_after_s": 120,
        }
        assert m.to_dict()["capacity_gate"] == m.capacity_gate

    @pytest.mark.parametrize(
        "bad",
        [
            {"command": []},                       # empty list
            {"command": ["probe", ""]},            # empty string element
            {"command": ["probe", 1]},             # non-string element
            {"command": "probe"},                  # not a list
            {"command": ["probe"], "env": {"A": 1}},
            {"command": ["probe"], "env": {"A": None}},
            {"command": ["probe"], "env": "x=1"},  # not an object
            {"command": ["probe"], "allow_yellow": 1},
            {"command": ["probe"], "allow_yellow": "true"},
            {"command": ["probe"], "cache_s": -1},
            {"command": ["probe"], "cache_s": "10"},
            {"command": ["probe"], "cache_s": True},
            {"command": ["probe"], "timeout_s": 0},
            {"command": ["probe"], "timeout_s": -0.5},
            {"command": ["probe"], "timeout_s": "10"},
            {"command": ["probe"], "retry_after_s": -60},
            {"command": ["probe"], "retry_after_s": 60.0},
            {"command": ["probe"], "retry_after_s": "60"},
            {"command": ["probe"], "retry_after_s": True},
            "probe",                               # gate itself not an object
            ["probe"],                             # ditto, list shape
        ],
    )
    def test_invalid_refused_at_parse(self, bad):
        with pytest.raises(ValueError, match="capacity_gate"):
            parse_capacity_gate(bad)
        # The model entry is isolated, not fatal: it loads, carries the
        # error, and keeps the operator's raw entry for save_config.
        m = ModelConfig.from_dict({"id": "m", "capacity_gate": bad})
        assert m.capacity_gate_error and "capacity_gate" in m.capacity_gate_error
        assert m.to_dict()["capacity_gate"] == bad

    def test_missing_command_refused(self):
        with pytest.raises(ValueError, match="command"):
            parse_capacity_gate({"cache_s": 5})


class TestMalformedGateIsolation:
    """One typo'd gate must neither take the seat down (the agents' #1748
    isolation contract) nor fail open on the model it was meant to bound."""

    def test_config_load_survives_and_other_models_stay_free(self):
        from sk_agent_config import _parse_config

        cfg = _parse_config(
            {
                "models": [
                    {"id": "m-typo", "capacity_gate": {"command": "probe"}},
                    {"id": "m-free"},
                ]
            }
        )
        typo, free = cfg.get_model("m-typo"), cfg.get_model("m-free")
        assert typo is not None and typo.capacity_gate_error
        assert free is not None and free.capacity_gate_error is None
        assert asyncio.run(check_model_capacity_gate(free)) is None

    def test_rejected_gate_refuses_unknown_without_spawning(self, tmp_path):
        counter = tmp_path / "spawns.txt"
        m = ModelConfig.from_dict(
            {
                "id": "m-typo",
                # a runnable probe, but cache_s is invalid: must never run
                "capacity_gate": {
                    "command": _counter_probe(str(counter)),
                    "cache_s": -1,
                },
            }
        )
        refusal = asyncio.run(check_model_capacity_gate(m, agent_id="a-x"))
        assert refusal["error_type"] == "capacity_gate_unknown"
        assert refusal["model_used"] == "m-typo"
        assert refusal["agent_used"] == "a-x"
        assert "cache_s" in refusal["gate_detail"]["config_error"]
        assert "malformed" in refusal["error"]
        assert not counter.exists()

    @pytest.mark.parametrize("gate", [{"command": []}, {"cache_s": 0}])
    def test_unvalidated_gate_dict_is_unknown_not_an_exception(self, gate):
        """A gate built in code, bypassing parse_capacity_gate, must still
        fail closed as unknown — never raise into the dispatch path."""
        result = asyncio.run(evaluate_capacity_gate("m-raw", gate))
        assert result.verdict == "unknown" and result.allowed is False

    def test_call_agent_refuses_the_rejected_model_only(self):
        typo = ModelConfig.from_dict(
            {"id": "m-x", "capacity_gate": {"command": []}}
        )
        manager = _call_manager([typo], _agent())

        result = asyncio.run(manager.call_agent(prompt="hi"))

        assert result["error_type"] == "capacity_gate_unknown"
        assert "config_error" in result["gate_detail"]
        assert manager._handle_text.call_count == 0


# ---------------------------------------------------------------------------
# (b) Pydantic schema — valid accepted, malformed refused with a clear error
# ---------------------------------------------------------------------------


def _schema_payload(gate: object = _UNSET) -> dict:
    model: dict = {
        "id": "m-x",
        "enabled": True,
        "base_url": "http://localhost/v1",
        "api_key": "test-key",
        "model_id": "m",
    }
    if gate is not _UNSET:
        model["capacity_gate"] = gate
    return {
        "config_version": 2,
        "models": [model],
        "agents": [{"id": "a-x", "model": "m-x"}],
    }


class TestSchemaKnowsTheField:
    """``ModelSpec`` is ``extra="forbid"``: the field must be declared
    there or every config carrying a gate logs a warning per load."""

    def test_valid_gate_accepted(self):
        errors = validate_config(
            _schema_payload(
                {
                    "command": ["probe", "--url", "http://localhost:5002/metrics"],
                    "env": {"SWIFT_GATE_URL": "http://localhost:5002/metrics"},
                    "allow_yellow": True,
                    "cache_s": 30,
                    "timeout_s": 2.5,
                    "retry_after_s": 120,
                }
            )
        )
        assert errors == [], errors

    def test_minimal_gate_accepted(self):
        assert validate_config(_schema_payload({"command": ["probe"]})) == []

    def test_legacy_model_without_the_field_still_validates(self):
        assert validate_config(_schema_payload()) == []

    @pytest.mark.parametrize(
        "bad",
        [
            {"command": []},
            {"command": "probe"},
            {"command": ["probe", ""]},
            {"command": ["probe", 1]},
            {"cache_s": 5},                            # command missing
            {"command": ["probe"], "cache_s": -1},
            {"command": ["probe"], "cache_s": "10"},
            {"command": ["probe"], "cache_s": True},
            {"command": ["probe"], "timeout_s": 0},
            {"command": ["probe"], "retry_after_s": "60"},
            {"command": ["probe"], "retry_after_s": True},
            {"command": ["probe"], "allow_yellow": 1},
            {"command": ["probe"], "env": {"A": 1}},
            "probe",
        ],
    )
    def test_schema_refuses_malformed_gate(self, bad):
        # The schema must not be looser than the parser: a gate the schema
        # accepts but the parser refuses is a warning-free crash at load.
        errors = validate_config(_schema_payload(bad))
        assert any("capacity_gate" in e for e in errors), errors


# ---------------------------------------------------------------------------
# (c) Verdict semantics — exit code authoritative, stdout informational
# ---------------------------------------------------------------------------


class TestVerdicts:
    def test_green_allows(self):
        result = asyncio.run(
            evaluate_capacity_gate("m", _gate(_probe(0)))
        )
        assert result.verdict == "green"
        assert result.allowed is True
        assert result.from_cache is False

    def test_red_refuses_with_detail(self):
        result = asyncio.run(
            evaluate_capacity_gate("m", _gate(_probe(2, {"verdict": "red"})))
        )
        assert result.verdict == "red"
        assert result.allowed is False
        assert result.detail == {"verdict": "red"}
        assert result.retry_after_s == 60

    def test_yellow_refused_by_default(self):
        result = asyncio.run(
            evaluate_capacity_gate("m", _gate(_probe(1, {"verdict": "yellow"})))
        )
        assert result.verdict == "yellow"
        assert result.allowed is False

    def test_yellow_allowed_with_allow_yellow(self):
        result = asyncio.run(
            evaluate_capacity_gate(
                "m", _gate(_probe(1, {"verdict": "yellow"}), allow_yellow=True)
            )
        )
        assert result.verdict == "yellow"
        assert result.allowed is True

    def test_exit_3_is_unknown_refused(self):
        result = asyncio.run(
            evaluate_capacity_gate("m", _gate(_probe(3, {"verdict": "red"})))
        )
        assert result.verdict == "unknown"
        assert result.allowed is False

    def test_exit_code_is_authoritative_over_stdout(self):
        """The sonde says red on stdout but exits 0: green wins. A lying or
        half-written payload must not flip a verdict (#4712 contract)."""
        result = asyncio.run(
            evaluate_capacity_gate("m", _gate(_probe(0, {"verdict": "red"})))
        )
        assert result.verdict == "green"
        assert result.allowed is True
        assert result.detail == {"verdict": "red"}

    def test_detail_is_last_non_empty_line(self):
        command = [
            sys.executable,
            "-c",
            'import sys; print("noise"); print(""); '
            'print(\'{"verdict":"green","queue":3}\'); sys.exit(0)',
        ]
        result = asyncio.run(evaluate_capacity_gate("m", _gate(command)))
        assert result.detail == {"verdict": "green", "queue": 3}

    def test_non_json_stdout_gives_no_detail(self):
        command = [
            sys.executable,
            "-c",
            'import sys; print("not json at all"); sys.exit(0)',
        ]
        result = asyncio.run(evaluate_capacity_gate("m", _gate(command)))
        assert result.verdict == "green"
        assert result.detail is None

    def test_missing_executable_is_unknown_refused(self):
        result = asyncio.run(
            evaluate_capacity_gate(
                "m", _gate(["definitely-not-a-real-binary-4712", "--probe"])
            )
        )
        assert result.verdict == "unknown"
        assert result.allowed is False

    def test_retry_after_s_flows_from_gate(self):
        result = asyncio.run(
            evaluate_capacity_gate(
                "m", _gate(_probe(2), retry_after_s=120)
            )
        )
        assert result.retry_after_s == 120


# ---------------------------------------------------------------------------
# (d) Timeout — the child is killed, the verdict is unknown
# ---------------------------------------------------------------------------


def _windows_process_alive(pid: int) -> bool | None:
    """True/False on Windows, None when the check is unavailable."""
    if os.name != "nt":
        return None
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFO
    if not handle:
        return False  # already gone
    try:
        exit_code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
        if not ok:
            return None
        return exit_code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


class TestTimeout:
    def test_timeout_refuses_unknown_and_kills_child(self, tmp_path):
        pid_file = tmp_path / "child.txt"
        sleeper = [
            sys.executable,
            "-c",
            "import os, sys, time\n"
            f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n"
            "time.sleep(30)\n"
            f"open({str(pid_file)!r}, 'a').write('done')\n",
        ]

        started = time.monotonic()
        result = asyncio.run(
            evaluate_capacity_gate("m", _gate(sleeper, timeout_s=1.0))
        )
        elapsed = time.monotonic() - started

        assert result.verdict == "unknown"
        assert result.allowed is False
        # The gate must NOT wait for the 30 s child: it returns around its
        # own bound (allow generous slack for interpreter startup).
        assert elapsed < 15, elapsed

        # The child writes its pid at startup; wait for the file so the
        # kill check below never races the interpreter boot.
        deadline = time.monotonic() + 10
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        pid = int(pid_file.read_text().strip().splitlines()[0])
        alive = _windows_process_alive(pid)
        if alive is not None:
            deadline = time.monotonic() + 5
            while alive and time.monotonic() < deadline:
                time.sleep(0.2)
                alive = _windows_process_alive(pid)
            assert alive is False, "sleeper child must be killed on timeout"


# ---------------------------------------------------------------------------
# (e) Cache — one probe per cache window, per model id
# ---------------------------------------------------------------------------


class TestCache:
    def test_two_calls_within_cache_s_spawn_once(self, tmp_path):
        counter = tmp_path / "spawns.txt"
        command = _counter_probe(str(counter))

        first = asyncio.run(
            evaluate_capacity_gate("m", _gate(command, cache_s=30))
        )
        second = asyncio.run(
            evaluate_capacity_gate("m", _gate(command, cache_s=30))
        )

        assert counter.read_text().count("x") == 1
        assert first.from_cache is False
        assert second.from_cache is True
        assert second.verdict == first.verdict == "green"
        assert second.allowed is True

    def test_cache_s_zero_spawns_each_time(self, tmp_path):
        counter = tmp_path / "spawns.txt"
        command = _counter_probe(str(counter))

        for _ in range(2):
            asyncio.run(evaluate_capacity_gate("m", _gate(command, cache_s=0)))

        assert counter.read_text().count("x") == 2

    def test_cache_entry_expires(self, tmp_path):
        counter = tmp_path / "spawns.txt"
        command = _counter_probe(str(counter))

        asyncio.run(evaluate_capacity_gate("m", _gate(command, cache_s=0.3)))
        time.sleep(0.4)
        second = asyncio.run(
            evaluate_capacity_gate("m", _gate(command, cache_s=0.3))
        )

        assert counter.read_text().count("x") == 2
        assert second.from_cache is False

    def test_allow_yellow_is_evaluated_per_call_not_cached(self, tmp_path):
        """The verdict is cached, the POLICY is not: flipping allow_yellow
        between two calls within one cache window must flip the decision
        without re-probing."""
        counter = tmp_path / "spawns.txt"
        command = _counter_probe(str(counter), exit_code=1)  # yellow

        refused = asyncio.run(
            evaluate_capacity_gate("m", _gate(command, cache_s=30))
        )
        allowed = asyncio.run(
            evaluate_capacity_gate(
                "m", _gate(command, cache_s=30, allow_yellow=True)
            )
        )

        assert counter.read_text().count("x") == 1  # probed once
        assert refused.allowed is False
        assert allowed.allowed is True
        assert allowed.from_cache is True

    def test_cache_is_keyed_per_model(self, tmp_path):
        counter = tmp_path / "spawns.txt"
        command = _counter_probe(str(counter))

        asyncio.run(evaluate_capacity_gate("m-a", _gate(command, cache_s=30)))
        asyncio.run(evaluate_capacity_gate("m-b", _gate(command, cache_s=30)))

        assert counter.read_text().count("x") == 2

    def test_env_merged_over_os_environ(self, monkeypatch):
        monkeypatch.setenv("GATE_TEST_AMBIENT_4712", "ambient")
        monkeypatch.setenv("GATE_TEST_MARKER_4712", "shadowed")
        probe = [
            sys.executable,
            "-c",
            "import json, os, sys\n"
            "print(json.dumps({\n"
            "    'ambient': os.environ.get('GATE_TEST_AMBIENT_4712'),\n"
            "    'marker': os.environ.get('GATE_TEST_MARKER_4712'),\n"
            "}))\n"
            "sys.exit(0)\n",
        ]
        result = asyncio.run(
            evaluate_capacity_gate(
                "m", _gate(probe, env={"GATE_TEST_MARKER_4712": "set"})
            )
        )
        assert result.detail == {"ambient": "ambient", "marker": "set"}


# ---------------------------------------------------------------------------
# (f) check_model_capacity_gate — the dispatch seam
# ---------------------------------------------------------------------------


class TestDispatchSeam:
    def test_model_without_gate_returns_none(self):
        model = ModelConfig(id="m-free")
        assert asyncio.run(check_model_capacity_gate(model)) is None

    def test_untyped_gate_field_returns_none(self):
        """Test doubles expose auto-created attributes (see the #1748
        regression): anything untyped must not gate, and must not crash."""

        class Double:
            capacity_gate = "not-a-dict"

        assert asyncio.run(check_model_capacity_gate(Double())) is None

    def test_green_returns_none(self):
        model = ModelConfig(id="m", capacity_gate=_gate(_probe(0)))
        assert asyncio.run(check_model_capacity_gate(model)) is None

    def test_red_returns_typed_refusal(self):
        model = ModelConfig(
            id="m", capacity_gate=_gate(_probe(2, {"queue": 7}))
        )
        refusal = asyncio.run(
            check_model_capacity_gate(model, agent_id="a-x")
        )
        assert refusal is not None
        assert refusal["error_type"] == "capacity_gate_red"
        assert refusal["model_used"] == "m"
        assert refusal["agent_used"] == "a-x"
        assert refusal["retry_after_s"] == 60
        assert refusal["gate_detail"] == {"queue": 7}
        assert "red" in refusal["error"]

    def test_unknown_returns_typed_refusal(self):
        model = ModelConfig(
            id="m", capacity_gate=_gate(["no-such-binary-4712"])
        )
        refusal = asyncio.run(check_model_capacity_gate(model))
        assert refusal["error_type"] == "capacity_gate_unknown"
        assert refusal["gate_detail"] is None


# ---------------------------------------------------------------------------
# (g) Full call_agent path — refusal before any model invocation
# ---------------------------------------------------------------------------


def _agent(agent_id="a-x", model="m-x"):
    return AgentConfig(id=agent_id, model=model)


def _call_manager(models, agent):
    """call_agent-path manager: minimal attrs (see test_rate_limit.py) with
    the mocked resolution/handler seams — _handle_text IS the LLM call."""
    manager = SKAgentManager.__new__(SKAgentManager)
    manager.config = SKAgentConfig(models=models, agents=[agent])
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


class TestCallAgentEnforcement:
    def test_red_gate_refuses_without_calling_the_llm(self):
        model = ModelConfig(
            id="m-x", capacity_gate=_gate(_probe(2, {"verdict": "red"}))
        )
        manager = _call_manager([model], _agent())

        result = asyncio.run(manager.call_agent(prompt="hi"))

        assert result["error_type"] == "capacity_gate_red"
        assert result["model_used"] == "m-x"
        assert result["agent_used"] == "a-x"
        assert result["retry_after_s"] == 60
        assert result["gate_detail"] == {"verdict": "red"}
        assert "red" in result["error"]
        # The handler seam never ran — the refusal preceded any LLM call.
        assert manager._handle_text.call_count == 0

    def test_green_gate_lets_the_call_through(self):
        model = ModelConfig(id="m-x", capacity_gate=_gate(_probe(0)))
        manager = _call_manager([model], _agent())

        result = asyncio.run(manager.call_agent(prompt="hi"))

        assert result.get("response") == "ok"
        assert manager._handle_text.call_count == 1

    def test_absent_field_keeps_today_behaviour(self):
        manager = _call_manager([ModelConfig(id="m-x")], _agent())

        result = asyncio.run(manager.call_agent(prompt="hi"))

        assert result.get("response") == "ok"
        assert manager._handle_text.call_count == 1

    def test_gate_keys_on_the_effective_model_not_the_agent_default(self):
        """model_override to a gated model must hit the gate even when the
        agent's own model is free — the gate protects the ENGINE, not the
        agent entry."""
        free = ModelConfig(id="m-free")
        gated = ModelConfig(
            id="m-busy", capacity_gate=_gate(_probe(2, {"verdict": "red"}))
        )
        manager = _call_manager([free, gated], _agent(model="m-free"))

        result = asyncio.run(
            manager.call_agent(prompt="hi", model_override="m-busy")
        )

        assert result["error_type"] == "capacity_gate_red"
        assert result["model_used"] == "m-busy"
        assert manager._handle_text.call_count == 0

    def test_override_to_a_free_model_skips_the_gate(self):
        """Symmetric control: the agent's default model is gated, the
        override target is not — the EFFECTIVE model decides. The call
        proceeds past the gate and stops at the (unmocked) service lookup,
        NOT at a gate refusal."""
        gated_default = ModelConfig(
            id="m-busy", capacity_gate=_gate(_probe(2))
        )
        free = ModelConfig(id="m-free")
        manager = _call_manager([gated_default, free], _agent(model="m-busy"))
        manager._services = {}  # override path looks the service up after the gate

        result = asyncio.run(
            manager.call_agent(prompt="hi", model_override="m-free")
        )

        assert "capacity_gate" not in json.dumps(result)
        assert "service not available" in result.get("error", "")
        assert manager._handle_text.call_count == 0  # stopped at services, not at the gate


# ---------------------------------------------------------------------------
# (h) agent_spec path — the gate sees the spec's effective model
# ---------------------------------------------------------------------------


class _FakePlugin:
    def __init__(self, name):
        self.name = name


class TestAgentSpecPath:
    def _manager(self, capacity_gate):
        config = SKAgentConfig(
            default_agent="analyst",
            models=[
                ModelConfig(
                    id="text-model",
                    model_id="glm-5",
                    base_url="http://localhost:9/v1",
                    capacity_gate=capacity_gate,
                ),
                ModelConfig(
                    id="alt-model",
                    model_id="alt",
                    base_url="http://localhost:9/v1",
                ),
            ],
            agents=[
                AgentConfig(
                    id="analyst",
                    model="text-model",
                    system_prompt="You are an analyst.",
                    mcps=["searxng"],
                )
            ],
            mcps=[McpConfig(id="searxng", command="echo")],
        )
        manager = SKAgentManager(config)
        asyncio.run(manager._init_model_pool())
        manager._mcp_plugins = {"searxng": _FakePlugin("searxng")}

        async def fake_ensure(mcp_id):
            return mcp_id in manager._mcp_plugins

        manager._ensure_mcp_loaded = fake_ensure
        manager._handle_text = AsyncMock(
            return_value={
                "response": "ok",
                "conversation_id": "c1",
                "agent_used": "analyst",
                "model_used": "text-model",
            }
        )
        return manager

    def test_spec_on_a_gated_model_refuses(self):
        manager = self._manager(_gate(_probe(2, {"verdict": "red"})))

        result = asyncio.run(
            manager.call_agent(prompt="hi", agent_spec={"extends": "analyst"})
        )

        assert result["error_type"] == "capacity_gate_red"
        assert result["model_used"] == "text-model"
        assert manager._handle_text.call_count == 0

    def test_spec_to_an_ungated_model_proceeds(self):
        manager = self._manager(_gate(_probe(2)))

        result = asyncio.run(
            manager.call_agent(
                prompt="hi",
                agent_spec={"extends": "analyst", "model": "alt-model"},
            )
        )

        assert result.get("response") == "ok"
        assert manager._handle_text.call_count == 1


# ---------------------------------------------------------------------------
# (i) Test-of-the-test — the enforcement tests assert THE gate
# ---------------------------------------------------------------------------


class TestMutantDiscriminance:
    def test_neutralized_seam_never_refuses(self):
        """With the dispatch seam neutralized (the mutant), the very same
        red scenario answers normally: this proves the (g) tests carry
        the signal, not an artefact. Run the REAL mutation on the source
        and (g) goes red — this class documents the failure shape."""
        model = ModelConfig(id="m-x", capacity_gate=_gate(_probe(2)))
        manager = _call_manager([model], _agent())

        async def _always_none(model_cfg, agent_id=None):
            return None

        sk_agent.check_model_capacity_gate = _always_none  # the mutant
        try:
            result = asyncio.run(manager.call_agent(prompt="hi"))
            assert result.get("response") == "ok"
            assert manager._handle_text.call_count == 1
        finally:
            sk_agent.check_model_capacity_gate = check_model_capacity_gate
