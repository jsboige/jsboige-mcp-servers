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

## Retired Servers

These exist in `servers/` but are removed from active config:

- `quickfiles-server` — replaced by Claude Code native capabilities
- `jinavigator-server` — replaced by markitdown MCP
- `github-projects-mcp` — replaced by `gh` CLI
- `jupyter-mcp-server` / `jupyter-papermill-mcp-server` — not in active use

## General Docs

- [Architecture](docs/architecture.md)
- [Getting Started](docs/getting-started.md)
- [Troubleshooting](docs/troubleshooting.md)
