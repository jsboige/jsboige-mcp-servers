# sk-agent Deployment Guide

## Overview

**sk-agent** is a Python-based MCP server that provides LLM capabilities with 4 models:
- **glm-4.6v** - Vision model (z.ai cloud)
- **glm-5** - Text model (z.ai cloud)
- **zwz-8b** - Fast local text (myia.io self-hosted)
- **glm-4.7-flash** - Fast local text (myia.io self-hosted)

## Prerequisites

1. **Python 3.11+** required
2. **Node.js 18+** (for Claude Code MCP integration)
3. **API keys** from z.ai and myia.io

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
pip install "semantic-kernel[mcp]>=1.39" "mcp>=1.7" "openai>=1.109" "Pillow>=10.0" "httpx>=0.27" "qdrant-client"
```

### 4. Create Configuration File

Create `sk_agent_config.json`:

```json
{
  "default_ask_model": "glm-5",
  "default_vision_model": "glm-4.6v",
  "max_recursion_depth": 2,
  "models": [
    {
      "id": "glm-4.6v",
      "enabled": true,
      "base_url": "https://api.z.ai/api/coding/paas/v4",
      "api_key": "YOUR_ZAI_API_KEY",
      "model_id": "glm-4.6v",
      "vision": true,
      "description": "Vision model (GLM-4.6V via z.ai)",
      "context_window": 128000
    },
    {
      "id": "glm-5",
      "enabled": true,
      "base_url": "https://api.z.ai/api/coding/paas/v4",
      "api_key": "YOUR_ZAI_API_KEY",
      "model_id": "glm-5",
      "vision": false,
      "description": "Text model (GLM-5 via z.ai)",
      "context_window": 200000
    },
    {
      "id": "zwz-8b",
      "enabled": true,
      "base_url": "https://api.mini.text-generation-webui.myia.io/v1",
      "api_key": "YOUR_MYIA_KEY",
      "model_id": "zwz-8b",
      "vision": false,
      "description": "Fast local text (ZwZ 8B AWQ)",
      "context_window": 131072
    },
    {
      "id": "glm-4.7-flash",
      "enabled": true,
      "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
      "api_key": "YOUR_MYIA_KEY",
      "model_id": "glm-4.7-flash",
      "vision": false,
      "description": "Fast local text (GLM-4.7-Flash AWQ)",
      "context_window": 131072
    }
  ],
  "mcps": [
    {
      "name": "searxng",
      "description": "Web search via SearXNG",
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": { "SEARXNG_URL": "https://search.myia.io" }
    },
    {
      "name": "playwright",
      "description": "Browser automation",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  ],
  "system_prompt": "You are a helpful assistant with access to web search and browser tools. Always respond in the same language as the user."
}
```

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
| myia-po-2026 | ✅ DONE | Lead deployment, tested |
| myia-ai-01 | ⏳ TODO | Coordinator machine |
| myia-po-2023 | ⏳ TODO | |
| myia-po-2024 | ⏳ TODO | |
| myia-po-2025 | ⏳ TODO | |
| myia-web1 | ⏳ TODO | (2GB RAM - may need adjustments) |

## API Keys Reference

**Contact coordinator or check RooSync message `msg-20260215T235930-gk4k9w` for actual keys.**

---

**Issue:** #475
**Created:** 2026-02-16
**Co-Authored-By:** Claude Opus 4.6 <noreply@anthropic.com>
