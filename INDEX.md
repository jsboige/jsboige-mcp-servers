# MCPs Internes — Index

Active servers in this repository. See [README.md](README.md) for full details.

## Active Servers

### roo-state-manager

The core RooSync multi-agent coordination server.

- **15 MCP tools** — conversations, RooSync messaging, dashboards, semantic search, baselines, diagnostics
- **Stack**: TypeScript, Node.js 20.18.0, Vitest (~7900 tests)
- **Storage**: Qdrant (semantic index), GDrive (shared state)
- **Doc**: [servers/roo-state-manager/README.md](servers/roo-state-manager/README.md)
- **Config**: `.env` (ROOSYNC_SHARED_PATH, QDRANT_URL, QDRANT_API_KEY)

### sk-agent

Agent-centric LLM proxy for multi-agent conversations.

- **Stack**: Python, Semantic Kernel, FastMCP
- **Features**: DeepSearch, DeepThink, vector memory, tool calling, vision
- **Doc**: [servers/sk-agent/README.md](servers/sk-agent/README.md)

### jinavigator-server

Web-to-Markdown conversion server (Jina API).

- **Status**: ✅ Active — `enabled: true` in canonical `roo-config/settings/servers.json` (`node ./mcps/internal/servers/jinavigator-server/dist/index.js`)
- **Doc**: [servers/jinavigator-server/README.md](servers/jinavigator-server/README.md)

### jupyter-papermill-mcp-server

Python Jupyter Notebook operations server (via Papermill).

- **Status**: ✅ Active — this is the canonical `jupyter` server in `roo-config/settings/servers.json` (`python -m papermill_mcp.main`)
- **Doc**: [servers/jupyter-papermill-mcp-server/README.md](servers/jupyter-papermill-mcp-server/README.md)

## Retired / Disabled Servers

These exist in `servers/` but are removed from active config:

- `quickfiles-server` — ❌ Retired (replaced by Claude Code native capabilities)
- `github-projects-mcp` — ❌ Retired (replaced by `gh` CLI)
- `jupyter-mcp-server` (legacy Node, 152 tools) — ⚠️ Disabled (caused scheduler crash; replaced by `jupyter-papermill-mcp-server`)

## General Docs

- [Architecture](docs/architecture.md)
- [Getting Started](docs/getting-started.md)
- [Troubleshooting](docs/troubleshooting.md)
