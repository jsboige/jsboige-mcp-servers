# Getting Started — jsboige-mcp-servers

This repo is a **submodule** of [roo-extensions](https://github.com/jsboige/roo-extensions).

## Quick Start

### roo-state-manager

```bash
cd servers/roo-state-manager
npm install
npm run build
npx vitest run  # NEVER npm test (watch mode blocks)
```

#### Configuration

Copy `.env.example` to `.env` and fill in:

```env
ROOSYNC_SHARED_PATH=/path/to/gdrive/.shared-state
QDRANT_URL=https://your-qdrant-instance
QDRANT_API_KEY=your-api-key
```

#### Running

The server runs via stdio (stdin/stdout). Configure in your MCP client:

```json
{
  "mcpServers": {
    "roo-state-manager": {
      "command": "node",
      "args": ["servers/roo-state-manager/mcp-wrapper.cjs"],
      "cwd": "/path/to/jsboige-mcp-servers"
    }
  }
}
```

### sk-agent

```bash
cd servers/sk-agent
pip install -r requirements.txt
# See servers/sk-agent/README.md for configuration
```

## Testing

```bash
# Dev (all tests)
npx vitest run

# CI (excludes platform-dependent tests)
npx vitest run --config vitest.config.ci.ts
```

## Architecture Overview

See [architecture.md](architecture.md) for the MCP protocol overview and [../README.md](../README.md) for the repo structure.

## Troubleshooting

See [troubleshooting.md](troubleshooting.md) for common issues.
