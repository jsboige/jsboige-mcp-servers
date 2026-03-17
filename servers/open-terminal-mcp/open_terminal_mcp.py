"""
Open Terminal MCP Server — stdio wrapper for the Open Terminal REST API.

Exposes terminal commands (run_command, list_files, read_file, write_file,
grep_search, glob_search) as MCP tools that forward to an Open Terminal
instance (https://github.com/open-webui/open-terminal).

Usage:
    python open_terminal_mcp.py

Environment variables:
    OPEN_TERMINAL_URL       Base URL (default: http://open-terminal-myia:8000)
    OPEN_TERMINAL_API_KEY   Bearer token for authentication (required)
"""

import asyncio
import json
import logging
import os
import sys

import httpx
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

log = logging.getLogger("open-terminal-mcp")

BASE_URL = os.environ.get("OPEN_TERMINAL_URL", "http://open-terminal-myia:8000")
API_KEY = os.environ.get("OPEN_TERMINAL_API_KEY", "")

server = Server("open_terminal")


def _headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if API_KEY:
        h["Authorization"] = f"Bearer {API_KEY}"
    return h


async def _get(path: str, params: dict | None = None) -> dict:
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=30) as client:
        r = await client.get(path, headers=_headers(), params=params)
        r.raise_for_status()
        return r.json()


async def _post(path: str, body: dict, timeout: float = 120) -> dict:
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=timeout) as client:
        r = await client.post(path, headers=_headers(), json=body)
        r.raise_for_status()
        return r.json()


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

TOOLS = [
    Tool(
        name="run_command",
        description="Execute a shell command in the terminal. Returns stdout, stderr, and exit code.",
        inputSchema={
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute",
                },
            },
            "required": ["command"],
        },
    ),
    Tool(
        name="list_files",
        description="List files and directories at a given path.",
        inputSchema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path to list (default: current directory)",
                    "default": ".",
                },
            },
        },
    ),
    Tool(
        name="read_file",
        description="Read the contents of a file.",
        inputSchema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to read",
                },
            },
            "required": ["path"],
        },
    ),
    Tool(
        name="write_file",
        description="Write content to a file (creates or overwrites).",
        inputSchema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to write",
                },
                "content": {
                    "type": "string",
                    "description": "Content to write to the file",
                },
            },
            "required": ["path", "content"],
        },
    ),
    Tool(
        name="grep_search",
        description="Search file contents using a pattern (regex supported).",
        inputSchema={
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Search pattern (regex)",
                },
                "path": {
                    "type": "string",
                    "description": "Directory or file to search in (default: current directory)",
                    "default": ".",
                },
            },
            "required": ["pattern"],
        },
    ),
    Tool(
        name="glob_search",
        description="Search for files by name pattern (glob syntax).",
        inputSchema={
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern (e.g., '*.py', '**/*.json')",
                },
                "path": {
                    "type": "string",
                    "description": "Base directory to search from (default: current directory)",
                    "default": ".",
                },
            },
            "required": ["pattern"],
        },
    ),
]


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


@server.list_tools()
async def list_tools() -> list[Tool]:
    return TOOLS


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "run_command":
            result = await _post("/execute", {"command": arguments["command"]})
            # Poll for completion — status field transitions from "running" to "done"
            if "id" in result and result.get("status") == "running":
                process_id = result["id"]
                for _ in range(60):  # max 60 polls × 2s = 120s
                    await asyncio.sleep(2)
                    result = await _get(f"/execute/{process_id}/status")
                    if result.get("status") != "running":
                        break
            # Flatten output for readability
            output_text = ""
            for chunk in result.get("output", []):
                if isinstance(chunk, dict) and "data" in chunk:
                    output_text += chunk["data"]
                elif isinstance(chunk, str):
                    output_text += chunk
            exit_code = result.get("exit_code")
            summary = {
                "command": result.get("command", ""),
                "exit_code": exit_code,
                "output": output_text.rstrip(),
            }
            if exit_code != 0 and exit_code is not None:
                summary["status"] = result.get("status", "unknown")
            return [TextContent(type="text", text=json.dumps(summary, indent=2))]

        elif name == "list_files":
            result = await _get(
                "/files/list", {"directory": arguments.get("path", ".")}
            )
            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        elif name == "read_file":
            result = await _get("/files/read", {"path": arguments["path"]})
            # read_file may return {"content": "..."} or direct text
            if isinstance(result, dict) and "content" in result:
                return [TextContent(type="text", text=result["content"])]
            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        elif name == "write_file":
            result = await _post(
                "/files/write",
                {
                    "path": arguments["path"],
                    "content": arguments["content"],
                },
            )
            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        elif name == "grep_search":
            result = await _get(
                "/files/grep",
                {
                    "query": arguments["pattern"],
                    "path": arguments.get("path", "."),
                },
            )
            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        elif name == "glob_search":
            result = await _get(
                "/files/glob",
                {
                    "pattern": arguments["pattern"],
                    "path": arguments.get("path", "."),
                },
            )
            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]

    except httpx.HTTPStatusError as e:
        return [
            TextContent(
                type="text",
                text=f"HTTP error {e.response.status_code}: {e.response.text}",
            )
        ]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main():
    log.info("Starting open-terminal MCP server (url=%s)", BASE_URL)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream, write_stream, server.create_initialization_options()
        )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    asyncio.run(main())
