# sk-agent - Semantic Kernel MCP Server v2.0

Agent-centric LLM proxy server for Claude Code and Roo Code.

## Features

- **Agent-centric architecture**: Agents combine model + system prompt + tools + optional memory
- **Shared resource pools**: Models and MCP plugins are shared; agents compose them
- **Multi-agent conversations**: DeepSearch (research pipeline) and DeepThink (deliberation)
- **Vector memory**: Per-agent persistent memory via Qdrant + embeddings
- **Tool calling**: Agents can use MCP plugins (SearXNG, Playwright, etc.)
- **Vision support**: Image, video, and document analysis
- **Dynamic descriptions**: Tool descriptions reflect live config at startup
- **Self-inclusion**: Recursive tool chaining with configurable depth limit
- **Backward compatible**: v1 configs auto-migrate; deprecated aliases still work

## Architecture

```text
Claude/Roo  --stdio-->  FastMCP server (sk_agent.py)
                              |
                              v
                         SK Agent Manager
                         +-- Shared model pool (OpenAI clients)
                         +-- Shared MCP plugin pool
                         +-- Per-agent kernels with memory
                         +-- Conversation runner (multi-agent)
                         +-- Conversation threads
```

Agents are the central abstraction. Each agent has:
- A **model** from the shared pool
- A **system prompt** defining its personality/role
- A subset of **MCP plugins** (tools)
- Optional **vector memory** (Qdrant + embeddings)

## MCP Tools

### Core Tools

#### `call_agent(prompt, agent?, attachment?, options?, conversation_id?, include_steps?)`

Unified agent invocation. Routes to the right agent based on content type.

- `prompt`: Question or instruction
- `agent`: Agent ID (default: auto-select based on attachment)
- `attachment`: File path or URL (image, video, PDF, PPTX, DOCX, XLSX)
- `options`: JSON string with type-specific params (`region`, `mode`, `max_pages`, `page_range`, `num_frames`)
- `conversation_id`: Continue previous conversation
- `include_steps`: Show intermediate tool/reasoning steps

#### `run_conversation(prompt, conversation?, options?, conversation_id?)`

Run a multi-agent conversation (DeepSearch, DeepThink, or custom).

- `prompt`: Research question or topic
- `conversation`: Conversation preset ID (default: `deep-search`)
- `options`: JSON string with overrides (`max_rounds`)

#### `list_agents()`

List all configured agents with models, capabilities, tools, and memory status.

#### `list_conversations()`

List available multi-agent conversation presets.

#### `list_tools()`

List all loaded MCP plugins and their tools.

#### `end_conversation(conversation_id)`

Clean up a conversation thread.

#### `install_libreoffice(force?, custom_path?)`

Check/install LibreOffice for document conversion.

### Deprecated Aliases (backward compat)

These still work but delegate to `call_agent`:
`ask`, `analyze_image`, `zoom_image`, `analyze_video`, `analyze_document`, `list_models`

## Built-in Conversations

### DeepSearch (magentic)

Multi-agent research with smart manager coordination:

```
User prompt -> MagenticManager -> Researcher (search) -> Synthesizer (report) -> Critic (review)
                                       ^                                              |
                                       +---------- (if not APPROVED) -----------------+
```

Agents: `researcher` (with search tools), `synthesizer`, `critic`
Max rounds: 10

### DeepThink (group_chat)

Multi-perspective deliberation with round-robin:

```
Round 1: Optimist -> Devil's Advocate -> Pragmatist -> Synthesizer
Round 2: (deeper analysis building on Round 1)
```

Agents: `optimist`, `devils-advocate`, `pragmatist`, `synthesizer-dt`
Max rounds: 8

## Configuration

Copy `sk_agent_config.template.json` to `sk_agent_config.json` and add your API keys.

### v2 Config (agent-centric)

```json
{
  "config_version": 2,
  "default_agent": "analyst",
  "default_vision_agent": "vision-analyst",

  "models": [
    { "id": "glm-5", "base_url": "...", "api_key_env": "ZAI_API_KEY", "model_id": "glm-5", "vision": false }
  ],

  "embeddings": {
    "base_url": "https://embeddings.myia.io/v1",
    "model_id": "Qwen3-4B-AWQ-embedding",
    "dimensions": 2560
  },

  "qdrant": { "url": "http://localhost", "port": 6333 },

  "mcps": [
    { "id": "searxng", "command": "npx", "args": ["-y", "mcp-searxng"] }
  ],

  "agents": [
    {
      "id": "analyst",
      "model": "glm-5",
      "system_prompt": "You are a helpful analyst.",
      "mcps": ["searxng"],
      "memory": { "enabled": true, "collection": "analyst-memory" }
    }
  ],

  "conversations": []
}
```

### v1 Config (backward compatible)

v1 configs (without `config_version`) are auto-migrated: each model becomes an agent with the same ID, all MCPs are shared across agents.

### Key Config Sections

| Section | Description |
|---------|-------------|
| `models` | Shared model pool (OpenAI-compatible endpoints) |
| `mcps` | Shared MCP plugin pool |
| `agents` | Agent definitions (model + prompt + tools + memory) |
| `conversations` | Custom multi-agent conversation presets |
| `embeddings` | Embeddings endpoint for vector memory |
| `qdrant` | Qdrant vector store connection |

## Vector Memory

When `memory.enabled: true` on an agent, it gets a `TextMemoryPlugin` with:
- **`memory-save(text, key, collection)`**: Store information
- **`memory-recall(ask, collection, relevance, limit)`**: Semantic search

Storage priority: Qdrant (persistent) -> VolatileMemoryStore (in-memory fallback).

Each agent has its own collection: `{prefix}-{collection}` (e.g., `sk-agent-analyst-memory`).

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SK_AGENT_CONFIG` | Path to config file | `sk_agent_config.json` |
| `SK_AGENT_DEPTH` | Current recursion depth (internal) | `0` |
| `ZAI_API_KEY` | z.ai API key (if using `api_key_env`) | - |
| `EMBEDDINGS_API_KEY` | Embeddings endpoint key | - |

## Requirements

- Python 3.11+
- `semantic-kernel[mcp]>=1.39`
- `mcp>=1.7`
- `openai>=1.109`
- `Pillow>=10.0`
- `httpx>=0.27`
- `qdrant-client>=1.9` (for persistent vector memory)

**Optional:**
- `PyMuPDF` - PDF to images/text
- `python-docx` - DOCX text extraction
- `pandas` + `openpyxl` - Excel to CSV
- `ffmpeg` - Video frame extraction

## Installation

```bash
cd mcps/internal/servers/sk-agent
pip install -r requirements.txt

# Optional: document/video support
pip install PyMuPDF python-docx pandas openpyxl
```

## Running

```bash
# As an MCP server (stdio)
python sk_agent.py

# Or via npx inspector (debugging)
npx -y @modelcontextprotocol/inspector python sk_agent.py
```

## Testing

```bash
cd mcps/internal/servers/sk-agent
python -m pytest test_sk_agent.py test_config.py -v
```

## Changelog

### v2.0 (2026-02-16)

- **Agent-centric architecture**: Models/MCPs are shared pools, agents compose them
- **Multi-agent conversations**: `run_conversation` tool with DeepSearch and DeepThink presets
- **Vector memory**: Per-agent Qdrant memory with TextMemoryPlugin
- **Unified API**: `call_agent` replaces ask/analyze_image/zoom_image/analyze_video/analyze_document
- **Dynamic descriptions**: Tool descriptions generated from live config
- **Config v2**: New schema with agents, embeddings, qdrant, conversations sections
- **Backward compatible**: v1 configs auto-migrate, deprecated aliases still work
- **125 tests**: Config (51) + agent/integration (74), all passing

### v1.x (2026-02-12 to 2026-02-16)

- Multi-model support with per-model kernels
- Vision, video, and document analysis
- Self-inclusion with depth-limited recursion
- MCP plugin integration (SearXNG, Playwright)
- Intermediate step visibility
