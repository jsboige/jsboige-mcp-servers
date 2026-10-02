#!/usr/bin/env python3
"""
MCP plugin adaptation (vllm#63 SAV, ai-01 live probes 03/10).

Defect E -- roo-state-manager deliberately emits JSON-schema unions
(``type: [X, "null"]``, #3174/#1141). Semantic Kernel copies a property's
``type`` verbatim into ``KernelParameterMetadata.type_`` (a ``str``), so any
preset carrying ``roo_state_manager`` failed ChatCompletionAgent construction:
``1 validation error for ChatCompletionAgent / type / Input should be a valid
string``. sk-agent now normalizes the schemas on its side.

Defect A -- one ``sk_agent_config.json`` is read by the sk-agent container
and by the stdio sk-agent on the host; ``OPEN_TERMINAL_URL`` names a
Docker-network host the host cannot resolve. MCP ``env`` values now expand
``${VAR}`` / ``${VAR:-default}`` against the sk-agent process environment.
"""

import asyncio
import copy
import json
import logging
import sys
import textwrap
from pathlib import Path

import mcp.types as types
from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.functions import KernelArguments

sys.path.insert(0, str(Path(__file__).parent))

from sk_agent import (
    SKAgentManager,
    SchemaNormalizingMCPStdioPlugin,
    normalize_tool_schema,
)
from sk_agent_config import McpConfig, SKAgentConfig, expand_env_placeholders


# Shapes taken from roo-state-manager tool-definitions.ts:
# nullableConversationProperties (number / string+enum incl. '' and null)
# and roosync_harmonization's additionalProperties multi-type union.
UNION_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["list", "view"]},
        "limit": {"type": ["number", "null"], "minimum": 1},
        "sortBy": {"type": ["string", "null"], "enum": ["a", "b", "", None]},
        "ids": {"type": ["array", "null"], "items": {"type": ["string", "null"]}},
        "canon": {
            "type": "object",
            "properties": {
                "keys": {
                    "type": "object",
                    "additionalProperties": {"type": ["string", "number", "boolean"]},
                },
                "note": {"type": ["string", "null"]},
            },
            "required": ["keys", "note"],
        },
    },
    "required": ["action", "limit"],
}


def _iter_types(schema):
    """Yield every ``type`` value found anywhere in a schema."""
    if isinstance(schema, dict):
        if "type" in schema:
            yield schema["type"]
        for value in schema.values():
            yield from _iter_types(value)
    elif isinstance(schema, list):
        for value in schema:
            yield from _iter_types(value)


# ---------------------------------------------------------------------------
# Defect E -- pure normalization
# ---------------------------------------------------------------------------


def test_nullable_scalar_becomes_its_type():
    assert normalize_tool_schema({"type": ["number", "null"]}) == {"type": "number"}


def test_nullable_enum_drops_null_keeps_empty_string():
    out = normalize_tool_schema({"type": ["string", "null"], "enum": ["a", "", None]})
    assert out == {"type": "string", "enum": ["a", ""]}


def test_nested_and_array_unions_are_normalized():
    out = normalize_tool_schema(UNION_INPUT_SCHEMA)
    props = out["properties"]
    assert props["limit"] == {"type": "number", "minimum": 1}
    assert props["ids"] == {"type": "array", "items": {"type": "string"}}
    assert props["canon"]["properties"]["note"] == {"type": "string"}
    # Multi-type union: kept as anyOf branches, no list ``type`` left.
    assert props["canon"]["properties"]["keys"]["additionalProperties"] == {
        "anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}]
    }
    assert all(isinstance(t, str) for t in _iter_types(out))


def test_nullable_properties_leave_required_at_every_level():
    out = normalize_tool_schema(UNION_INPUT_SCHEMA)
    assert out["required"] == ["action"]
    assert out["properties"]["canon"]["required"] == ["keys"]


def test_anyof_and_oneof_branches_are_normalized():
    out = normalize_tool_schema(
        {"anyOf": [{"type": ["integer", "null"]}], "oneOf": [{"type": ["boolean", "null"]}]}
    )
    assert out == {"anyOf": [{"type": "integer"}], "oneOf": [{"type": "boolean"}]}


def test_input_schema_is_not_mutated():
    original = copy.deepcopy(UNION_INPUT_SCHEMA)
    normalize_tool_schema(UNION_INPUT_SCHEMA)
    assert UNION_INPUT_SCHEMA == original


# ---------------------------------------------------------------------------
# Defect E -- SK builds the kernel function / ChatCompletionAgent
# ---------------------------------------------------------------------------


class _FakeSession:
    """Stands in for ClientSession: only list_tools is reached by load_tools."""

    def __init__(self, tool: types.Tool):
        self._tool = tool

    async def list_tools(self):
        return types.ListToolsResult(tools=[self._tool])


def test_union_schema_plugin_builds_chat_completion_agent():
    tool = types.Tool(name="probe", description="union-typed", inputSchema=UNION_INPUT_SCHEMA)
    plugin = SchemaNormalizingMCPStdioPlugin(
        name="rsm", command="unused", session=_FakeSession(tool)
    )
    asyncio.run(plugin.load_tools())

    agent = ChatCompletionAgent(
        kernel=Kernel(), name="sk-agent-schema-test", instructions="x", plugins=[plugin]
    )
    params = {p.name: p for p in agent.kernel.get_function("rsm", "probe").metadata.parameters}
    assert set(params) == {"action", "limit", "sortBy", "ids", "canon"}
    assert params["action"].type_ == "string" and params["action"].is_required is True
    assert params["limit"].type_ == "number" and params["limit"].is_required is False
    assert params["sortBy"].schema_data == {"type": "string", "enum": ["a", "b", ""]}
    assert params["ids"].schema_data == {"type": "array", "items": {"type": "string"}}
    assert all(isinstance(t, str) for p in params.values() for t in _iter_types(p.schema_data))


_UNION_SERVER = textwrap.dedent(
    """
    import json, os
    import anyio
    import mcp.types as types
    from mcp.server.lowlevel import Server
    from mcp.server.stdio import stdio_server

    SCHEMA = json.loads(os.environ["SKA_TEST_SCHEMA"])
    server = Server("union_server")

    @server.list_tools()
    async def list_tools():
        return [
            types.Tool(name="probe", description="union-typed", inputSchema=SCHEMA),
            types.Tool(
                name="get_env",
                description="read one variable of this process",
                inputSchema={"type": "object", "properties": {"name": {"type": "string"}},
                             "required": ["name"]},
            ),
        ]

    @server.call_tool()
    async def call_tool(name, arguments):
        if name == "get_env":
            text = os.environ.get(arguments["name"], "<unset>")
        else:
            text = json.dumps(arguments, sort_keys=True)
        return [types.TextContent(type="text", text=text)]

    async def main():
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())

    anyio.run(main)
    """
)


def _union_server_mcp(tmp_path: Path, env: dict[str, str]) -> McpConfig:
    script = tmp_path / "union_server.py"
    script.write_text(_UNION_SERVER, encoding="utf-8")
    return McpConfig(
        id="union_server",
        command=sys.executable,
        args=[str(script)],
        env={"SKA_TEST_SCHEMA": json.dumps(UNION_INPUT_SCHEMA), **env},
        connect_timeout_s=15.0,
    )


def _text(result) -> str:
    return "".join(str(item) for item in result.value)


def test_union_schema_tool_loads_and_is_callable_end_to_end(tmp_path):
    """Real stdio server through the real plugin path (_ensure_mcp_loaded)."""
    mgr = SKAgentManager(SKAgentConfig(mcps=[_union_server_mcp(tmp_path, {})]))

    async def scenario():
        try:
            assert await mgr._ensure_mcp_loaded("union_server") is True
            agent = ChatCompletionAgent(
                kernel=Kernel(),
                name="sk-agent-union",
                instructions="x",
                plugins=[mgr._mcp_plugins["union_server"]],
            )
            return await agent.kernel.invoke(
                plugin_name="union_server",
                function_name="probe",
                arguments=KernelArguments(action="list", limit=5),
            )
        finally:
            await mgr.stop()

    result = asyncio.run(scenario())
    assert json.loads(_text(result)) == {"action": "list", "limit": 5}


# ---------------------------------------------------------------------------
# Defect A -- ${VAR} / ${VAR:-default} in MCP env values
# ---------------------------------------------------------------------------

TEMPLATE_URL = "${OPEN_TERMINAL_URL:-http://open-terminal-myia:8000}"


def test_expand_uses_set_variable():
    env = {"OPEN_TERMINAL_URL": TEMPLATE_URL, "X": "${HOST_X}"}
    out = expand_env_placeholders(
        env, {"OPEN_TERMINAL_URL": "http://localhost:8000", "HOST_X": "x-value"}
    )
    assert out == {"OPEN_TERMINAL_URL": "http://localhost:8000", "X": "x-value"}


def test_expand_unset_variable_uses_default():
    out = expand_env_placeholders({"OPEN_TERMINAL_URL": TEMPLATE_URL}, {})
    assert out == {"OPEN_TERMINAL_URL": "http://open-terminal-myia:8000"}


def test_expand_empty_variable_uses_default():
    out = expand_env_placeholders({"OPEN_TERMINAL_URL": TEMPLATE_URL}, {"OPEN_TERMINAL_URL": ""})
    assert out == {"OPEN_TERMINAL_URL": "http://open-terminal-myia:8000"}


def test_expand_unset_variable_without_default_is_kept_and_warned(caplog):
    with caplog.at_level(logging.WARNING, logger="sk-agent.config"):
        out = expand_env_placeholders({"URL": "http://${MISSING_HOST}:8000"}, {})
    assert out == {"URL": "http://${MISSING_HOST}:8000"}
    assert "MISSING_HOST" in caplog.text and "URL" in caplog.text


def test_values_without_placeholder_are_untouched():
    env = {"API_KEY": "abc$def${", "PORT": 8000, "PLAIN": "http://h:1"}
    out = expand_env_placeholders(env, {"def": "nope"})
    assert out == env
    assert out is not env


def test_plugin_process_receives_expanded_env(tmp_path, monkeypatch):
    """The spawn path (_ensure_mcp_loaded) applies the expansion."""
    monkeypatch.setenv("SKA_TEST_HOST_URL", "http://localhost:8000")
    mcp_cfg = _union_server_mcp(
        tmp_path,
        {
            "PROBE_URL": "${SKA_TEST_HOST_URL:-http://open-terminal-myia:8000}",
            "PROBE_DEFAULT": "${SKA_TEST_UNSET_VAR:-http://open-terminal-myia:8000}",
        },
    )
    monkeypatch.delenv("SKA_TEST_UNSET_VAR", raising=False)
    mgr = SKAgentManager(SKAgentConfig(mcps=[mcp_cfg]))

    async def scenario():
        try:
            assert await mgr._ensure_mcp_loaded("union_server") is True
            plugin = mgr._mcp_plugins["union_server"]
            url = await plugin.call_tool("get_env", name="PROBE_URL")
            default = await plugin.call_tool("get_env", name="PROBE_DEFAULT")
            return str(url[0]), str(default[0])
        finally:
            await mgr.stop()

    url, default = asyncio.run(scenario())
    assert url == "http://localhost:8000"
    assert default == "http://open-terminal-myia:8000"
