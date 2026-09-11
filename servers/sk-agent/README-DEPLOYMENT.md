# sk-agent Deployment Guide

## Overview

**sk-agent** is a Python-based MCP server that routes LLM work through a pool of named agents backed by 17 models (z.ai cloud, local vLLM, OWUI proxies — `sk_agent_config.template.json` is the canonical list):

- **Vision routing** — default vision agent `vision-analyst` runs **glm-5.3-flash** (native multimodal, 131K ctx); **glm-4.6v** is kept as vision fallback only (#3389)
- **Text routing** — default agent `analyst` runs glm-5.1 (200K ctx)
- **Local/cheap lanes** — qwen3.6-35b, glm-4.7-flash and OWUI wrappers for coding and fast tasks

### Document routing (PDF)

Documents are handled **text-first** (#3389): analysis mode `auto` (the default, recommended) probes the PDF for a text layer (PyMuPDF, majority quorum of sampled pages). Textual PDFs go through native text extraction; only scanned/image PDFs fall back to page-by-page vision. Other modes: `visual` (always images), `text` (extracted text only), `hybrid` (both).

## Prerequisites

1. **Python 3.11+** required
2. **Node.js 18+** (for Claude Code MCP integration)
3. **API keys** from z.ai and myia.io

## Transport modes

- **`stdio`** is the local transport for Claude Code, Roo and Zoo. It does not require `SK_AGENT_API_KEY` because the client starts the process directly.
- **`streamable-http`** is the containerized network transport for OpenWebUI, bots and remote clients. It refuses to start unless `SK_AGENT_API_KEY` is provided. Every MCP request must send `Authorization: Bearer <key>`. A direct process listens on `127.0.0.1` by default; the container explicitly listens on `0.0.0.0`, while the standalone Compose file publishes it on host loopback by default. Expose it remotely only through the TLS reverse proxy; when that proxy runs on another host, set `SK_AGENT_BIND` to the specific LAN address that the proxy reaches.
- **`GET /healthz`** is intentionally unauthenticated for Docker and reverse-proxy probes. It reports whether the configuration exists and parses, how many models are enabled, and whether the manager has been initialized. It never returns credentials or endpoint details.

Store `SK_AGENT_API_KEY` only in a gitignored environment file or secret manager. Never put a fallback value in Compose, source code or documentation. Configuration changes use a controlled container restart; partial hot reload is not supported.

### Compose host binding

The standalone Compose file binds host port 8100 to `127.0.0.1` by default. Keep this default when the TLS reverse proxy runs on the same host.

If the reverse proxy runs on another machine, set `SK_AGENT_BIND` in the same gitignored environment file to the container host's specific LAN address, then recreate the container:

```dotenv
SK_AGENT_BIND=192.0.2.10
```

```bash
docker compose -f docker-compose.sk-agent.yml up -d --force-recreate
```

Do not use `0.0.0.0` unless binding every host interface is explicitly required. The Bearer authentication remains mandatory regardless of the host binding.

## Deployment Steps

### 1. Clone/Update Submodule

```bash
# From roo-extensions root
cd mcps/internal
git submodule update --init --remote
```

### 2. Create Python Virtual Environment

```powershell
cd mcps/internal/servers/sk-agent
python -m venv venv
```

### 3. Install Dependencies

```powershell
# Windows
.\venv\Scripts\pip install -r requirements.txt

# Or manually:
pip install "semantic-kernel[mcp]>=1.39" "mcp>=1.10" "uvicorn>=0.30" "openai>=1.109" "Pillow>=10.0" "httpx>=0.27" "qdrant-client"
```

### 4. Create Configuration File

Create `sk_agent_config.json` from the template — the canonical, up-to-date structure (config v2: agent-based routing, MCP risk classes):

```powershell
Copy-Item sk_agent_config.template.json sk_agent_config.json
# then fill in API keys per model block and adjust agents/mcps for the machine
```

v2 shape (excerpt — top-level defaults plus one entry of each kind; see the template for the full pool):

```json
{
  "config_version": 2,
  "max_recursion_depth": 2,
  "default_agent": "analyst",
  "default_vision_agent": "vision-analyst",
  "models": [
    {
      "id": "glm-5.3-flash",
      "enabled": true,
      "base_url": "https://api.z.ai/api/coding/paas/v4",
      "api_key": "YOUR_ZAI_API_KEY",
      "model_id": "glm-5.3-flash",
      "vision": true,
      "thinking": true,
      "description": "GLM-5.3-Flash via z.ai cloud — native multimodal (text+vision)",
      "context_window": 131072
    }
  ],
  "agents": [
    {
      "id": "vision-analyst",
      "model": "glm-5.3-flash",
      "mcps": ["searxng", "playwright", "markitdown"],
      "capabilities": ["web", "browser", "document_text", "document_visual"]
    }
  ],
  "mcps": [
    {
      "id": "searxng",
      "description": "Web search via SearXNG",
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "risk_class": "read",
      "allowed_capabilities": ["web"]
    }
  ]
}
```

> Legacy v1 keys (`default_ask_model`, `default_vision_model`) no longer exist — defaults are agent IDs now (`default_agent`, `default_vision_agent`).

### 5. Add to Claude Code MCP Settings

Edit `~/.claude.json`:

```json
{
  "mcpServers": {
    "sk-agent": {
      "command": "C:/dev/roo-extensions/mcps/internal/servers/sk-agent/venv/Scripts/python.exe",
      "args": ["C:/dev/roo-extensions/mcps/internal/servers/sk-agent/sk_agent.py"],
      "cwd": "C:/dev/roo-extensions/mcps/internal/servers/sk-agent/",
      "env": {
        "SK_AGENT_CONFIG": "C:/dev/roo-extensions/mcps/internal/servers/sk-agent/sk_agent_config.json"
      }
    }
  }
}
```

**Adjust paths for each machine:**
- Replace `C:/dev/roo-extensions` with actual workspace path

### 6. Restart VS Code

**CRITICAL:** MCP servers load at VS Code startup only.

```powershell
# Close VS Code and reopen
code .
```

## Verification

After restart, test the tools:

```
# List available models
mcp__sk-agent__list_models

# Simple text prompt
mcp__sk-agent__ask("What is 2+2?")

# Image analysis (vision model)
mcp__sk-agent__analyze_image("https://example.com/image.png", "Describe this")
```

## Troubleshooting

### Server not starting
- Check Python version: `python --version` (must be 3.11+)
- Verify venv exists: `ls venv/Scripts/python.exe`
- Test manually: `venv/Scripts/python.exe sk_agent.py`

### Tools not available after restart
- Verify `~/.claude.json` syntax (no trailing commas)
- Check VS Code logs: `Help > Toggle Developer Tools > Console`
- Verify sk_agent_config.json path

### API key errors
- Verify keys in sk_agent_config.json
- Test API endpoints directly

## Deployment Status

| Machine | Status | Notes |
|---------|--------|-------|
| myia-po-2026 | ✅ DONE | Lead deployment, tested — #3389 config sync (glm-5.3-flash) pending |
| myia-ai-01 | ✅ DONE | Config synced to template 2026-09-09 (#3389) |
| myia-po-2023 | ✅ DONE | Config synced 2026-09-09 (#3389) |
| myia-po-2024 | ✅ DONE | Config synced 2026-09-09 (#3389) |
| myia-po-2025 | ✅ DONE | Config synced 2026-09-06 (#3389) |
| myia-web1 | ✅ DONE | Deployed (2GB RAM); stdio re-validated 2026-09-11 (#3411) |
| myia-po-2027 | ➖ N/A | sk-agent not deployed (Claude-only machine) |

*Config-sync state as of 2026-09-11. Local `sk_agent_config.json` files are gitignored — rows reflect issue-thread reports, verify per machine before relying on one.*

## API Keys Reference

**Contact coordinator or check RooSync message `msg-20260215T235930-gk4k9w` for actual keys.**

---

**Issue:** #475
**Created:** 2026-02-16
**Co-Authored-By:** Claude Opus 4.6 <noreply@anthropic.com>
