# Open Terminal MCP Server

MCP server that exposes terminal and file operations as MCP tools by forwarding
them to an [Open Terminal](https://github.com/open-webui/open-terminal) REST API
instance.

## Description

This server is a **stdio wrapper** around the Open Terminal REST API. It exposes
6 tools that proxy shell and file operations to a remote Open Terminal instance:

- `run_command` — execute a shell command; returns stdout, stderr, and exit code
- `list_files` — list files and directories at a given path
- `read_file` — read the contents of a file
- `write_file` — write content to a file (creates or overwrites)
- `grep_search` — search file contents using a regex pattern
- `glob_search` — find files by name pattern (glob syntax)

## Status — not in canonical fleet deployment

This server is **not wired** into the fleet's canonical MCP configs
(`roo-config/settings/servers.json`, Claude `~/.claude.json`, Roo/Zoo
`mcp_settings.json`). It is an **opt-in / experimental** server: to use it, wire
it manually into your client config with the environment variables below.

> Tracked as a documentation gap in
> [roo-extensions#2918](https://github.com/jsboige/roo-extensions/issues/2918):
> previously this directory contained only `open_terminal_mcp.py`, with no README
> and no canonical wiring.

## Installation

The server is a single-file Python script. Its dependencies (from imports) are
`httpx` and the [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk):

```bash
pip install httpx "mcp[cli]"
```

## Usage

```bash
python open_terminal_mcp.py
```

The server runs over stdio — it is started by your MCP client, not run directly
in a terminal.

## Configuration

| Environment variable | Required | Default | Description |
|----------------------|----------|---------|-------------|
| `OPEN_TERMINAL_URL` | no | `http://open-terminal-myia:8000` | Base URL of the Open Terminal REST API |
| `OPEN_TERMINAL_API_KEY` | **yes** | — | Bearer token for authentication |

## License

MIT
