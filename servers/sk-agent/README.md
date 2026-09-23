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

#### `call_agent(prompt, agent?, attachment?, options?, conversation_id?, include_steps?, model_override?, system_prompt?, mcp_overrides?, agent_spec?)`

Unified agent invocation. Routes to the right agent based on content type.

- `prompt`: Question or instruction
- `agent`: Agent ID (default: auto-select based on attachment)
- `attachment`: File path or URL (image, video, PDF, PPTX, DOCX, XLSX)
- `options`: JSON string with type-specific params (`region`, `mode`, `max_pages`, `page_range`, `num_frames`)
- `conversation_id`: Continue previous conversation
- `include_steps`: Show intermediate tool/reasoning steps
- `agent_spec`: JSON string composing an agent à la carte (#3407) — model + prompt + capabilities + tools + execution, optionally specializing a preset via `extends`. Precedence per dimension: call-level override > spec > preset > server default. Only server-configured models/MCPs may be referenced; anything else is refused, as are vision-requirement violations and attempts to widen tool-enabling parameters (`github_tools`). The response carries `effective_config` (no secrets).

```json
{
  "extends": "analyst",
  "model": "glm-5.3",
  "system_prompt": "You are a terse summarizer.",
  "mcps": { "replace": [] },
  "memory": { "enabled": false },
  "sampling": { "temperature": 0.2, "max_tokens": 512 }
}
```

#### `run_conversation(prompt, conversation?, options?, conversation_id?, conversation_spec?)`

Run a multi-agent conversation (DeepSearch, DeepThink, or custom).

- `prompt`: Research question or topic
- `conversation`: Conversation preset ID (default: `deep-search`)
- `options`: JSON string with overrides (`max_rounds`)
- `conversation_spec`: JSON string composing a conversation à la carte (#3407) — agents + coordination + prompts, optionally specializing a preset via `extends`. Agent references must resolve to configured agents or `inline_agents`; `max_rounds` is capped at 50 and the cap holds even through `options`. `handoff` executes through the same round-robin group-chat path as preset-defined handoff conversations. The response carries `effective_conversation` (no secrets).

```json
{
  "extends": "deep-think",
  "type": "sequential",
  "add_agents": ["analyst"],
  "inline_agents": [
    { "id": "scribe", "system_prompt": "You take verbatim notes.", "mcps": { "replace": ["searxng"] } }
  ],
  "max_rounds": 4
}
```

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

> The block below is validated by `python -m pytest test_inventory_validation.py`.
> Any change must keep it parseable by `sk_agent_config.validate_config()`.

```json
{
  "config_version": 2,
  "default_agent": "analyst",
  "default_vision_agent": "vision-analyst",

  "models": [
    {
      "id": "glm-5.3",
      "base_url": "http://192.168.0.50:3000/v1",
      "api_key_env": "ZAI_API_KEY",
      "model_id": "glm-5.3",
      "vision": false,
      "context_window": 200000
    },
    {
      "id": "qwen3.6-35b-a3b",
      "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
      "model_id": "qwen3.6-35b-a3b",
      "vision": true,
      "context_window": 262144
    }
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
      "model": "qwen3.6-35b-a3b",
      "system_prompt": "You are a helpful analyst.",
      "capabilities": ["memory"],
      "mcps": ["searxng"],
      "memory": { "enabled": true, "collection": "analyst-memory" }
    },
    {
      "id": "vision-analyst",
      "model": "qwen3.6-35b-a3b",
      "system_prompt": "You are a vision specialist.",
      "mcps": [],
      "memory": { "enabled": false }
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

### Per-model budget overrides (#3797)

A model entry may declare three OPTIONAL fields — absent fields keep the
current behaviour exactly (no ceiling change, global budget, sampling-only
`extra_body`):

| Field | Default | Effect |
|-------|---------|--------|
| `request_timeout_s` | `null` (= 300 s) | OpenAI client timeout for this model. Declaring it **also couples** the `call_agent` wait_for ceiling (see Timeout chain). |
| `max_tokens` | `null` (= global `sampling.max_tokens`, 4096) | Default output budget for the model. Precedence: per-call / `agent_spec` sampling override > model default > global. |
| `extra_body` | `{}` | Generic vLLM passthrough merged into the request `extra_body`. Model keys override sampling-derived keys (`top_k`/`min_p`/`repetition_penalty` — per-model is more specific than server-wide); `chat_template_kwargs` is deep-merged, so the code-injected `enable_thinking` keeps winning on its key without clobbering other keys. |

Example — the notebook-auditor case: a local model under parallel load that
bumps into the 300 s client budget, with a raised thinking budget:

```json
{
  "id": "qwen3.6-35b-a3b-slow",
  "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
  "model_id": "qwen3.6-35b-a3b",
  "thinking": true,
  "request_timeout_s": 600,
  "max_tokens": 8000,
  "extra_body": { "chat_template_kwargs": { "thinking_budget": 2048 } }
}
```

Deploying real values is a per-model operations decision, made one model at
a time (nothing is activated in the shipped template).

## Timeout chain (#3797)

Every `call_agent` invocation is bounded by a chain of delays — **the
effective timeout is the minimum of the chain**, so a budget raised at one
level is dead config if a lower ceiling cuts the call first:

```
MCP caller (client-side tool timeout)          ← governs the WHOLE tool call
  └─ call_agent wait_for ceiling               ← asyncio.wait_for, sk_agent.py
       ├─ pre-LLM work (attachment conversion, memory recall, MCP plugin calls)
       └─ LLM client budget                    ← AsyncOpenAI timeout, per model
```

1. **LLM client (per model)** — `request_timeout_s` on the model entry
   (default 300 s, `#1587`: openai-python's own default of 600 s + 2 retries
   would outlive every tool ceiling). `max_retries=1`: a single attempt must
   fit under the wait_for ceiling; a pathological retry may be cut by it —
   unchanged from #1587.
2. **`call_agent` wait_for (tiers)** — the `timeout` parameter (default
   120 s, `0` = no limit); `review_pr` raises it per tier (60/180/300 s).
   **Coupling (#3797):** when the resolved model DECLARES
   `request_timeout_s`, the ceiling becomes
   `max(caller timeout, request_timeout_s + 30 s)` — the 30 s margin covers
   the pre-LLM work sharing the same window. Undeclared models keep the
   legacy ceilings untouched (non-regression).
3. **MCP transport** — no server-side ceiling in this repo: stdio is bounded
   only by the caller's client-side MCP timeout; streamable-http (uvicorn)
   sets no request timeout either. **The caller must allow the full chain**:
   its tool timeout must exceed the call_agent ceiling it expects, plus
   margin for post-processing.

`run_conversation` has no internal `wait_for`: each LLM turn is bounded only
by the per-model client budget, and the whole conversation is bounded by the
MCP caller's tool timeout (level 3). Model `max_tokens` / `extra_body`
overrides reach conversation agents too: each agent whose model declares
one of them runs as a conversation-scoped copy carrying only those two
fields (no global sampling, no `enable_thinking` injection — conversation
agents never had either). The shared agents that `call_agent` reuses are
never modified, and a model declaring neither field runs exactly as before.

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

## Available Models (8)

### GLM via fleet hub (2) — claudish `http://192.168.0.50:3000/v1`, key = hub client key (#3574)

| ID | Model | Vision | Thinking | Context |
|----|-------|--------|----------|---------|
| `glm-5.3` | GLM-5.3 | ❌ | ✅ | 200K |
| `glm-5.3-flash` | GLM-5.3-Flash | ❌ | ❌ | 131K |

Vision is **not** served through the hub: it strips `image_url` parts before they reach z.ai (VERIFIED, roo-extensions#794) — vision routes local (qwen3.6-35b-a3b) until the claudish passthrough fix.

### vLLM Local Direct (2)

| ID | Model | Vision | Thinking | Context |
|----|-------|--------|----------|---------|
| `qwen3.6-35b-a3b` | Qwen3.6 35B MoE | ✅ | ✅ | 262K |
| `qwen3.6-35b-no-thinking` | Qwen3.6 35B MoE | ❌ | ❌ | 262K |

### OWUI Proxy (1)

| ID | Model | Vision | Thinking | Context |
|----|-------|--------|----------|---------|
| `owui-qwen3.6-35b` | Qwen3.6 35B via OWUI | ✅ | ✅ | 262K |

### OWUI Custom Models (3)

| ID | Model | Vision | Thinking | Context |
|----|-------|--------|----------|---------|
| `owui-expert-analyste` | Expert Analyste | ❌ | ✅ | 131K |
| `owui-redacteur-technique` | Rédacteur Technique | ❌ | ✅ | 131K |
| `owui-vision-expert` | Vision Expert | ✅ | ✅ | 131K |

Purged (dead): `omnicoder-9b` + `owui-omnicoder-9b` (GPU 2 freed 30/04), `owui-glm-4.7-flash-*` (local GLM archived), `glm-5.1`/`glm-5`/`glm-4.6v`/`glm-4.7-flash` direct z.ai entries (superseded by glm-5.3/glm-5.3-flash via hub, user mandate 22/09).

## Available Agents (32)

### Core Agents (13)

| ID | Model | Vision | Thinking | Tools | Memory | Description |
|----|-------|--------|----------|-------|--------|-------------|
| `analyst` | qwen3.6-35b-a3b | ✅ | ✅ | searxng, playwright, markitdown | ✅ | General analyst — **fleet default, local** (user mandate 22/09) |
| `analyst-glm5` | glm-5.3 | ❌ | ✅ | searxng, playwright, markitdown | ✅ | Cloud twin of analyst (heavy tasks, local-down fallback) |
| `analyst-fast` | glm-5.3-flash | ❌ | ❌ | searxng | ❌ | Fast analyst (hub) |
| `fast-responder` | glm-5.3-flash | ❌ | ❌ | — | ❌ | Quick answers / triage (hub) |
| `vision-analyst` | qwen3.6-35b-a3b | ✅ | ✅ | searxng, playwright, markitdown | ❌ | Vision specialist — **local** (hub strips images, #794) |
| `vision-local` | qwen3.6-35b-a3b | ✅ | ✅ | searxng, playwright, markitdown | ❌ | Local vision+thinking |
| `vision-local-owui` | owui-qwen3.6-35b | ✅ | ✅ | — | ❌ | OWUI Qwen3.6 vision |
| `coder` | qwen3.6-35b-no-thinking | ❌ | ❌ | open_terminal, searxng | ❌ | Local coding (vLLM direct) |
| `coder-local` | owui-qwen3.6-35b | ✅ | ✅ | — | ❌ | Local coding (OWUI proxy) |
| `fast` | qwen3.6-35b-no-thinking | ❌ | ❌ | — | ❌ | Fastest reliable (local no-thinking) |
| `fast-local` | qwen3.6-35b-no-thinking | ❌ | ❌ | — | ❌ | Fast local (direct vLLM) |
| `fast-local-thinking` | qwen3.6-35b-a3b | ✅ | ✅ | — | ❌ | Local with thinking |
| `qwen-local` | qwen3.6-35b-a3b | ✅ | ✅ | — | ❌ | Direct vLLM Qwen3.6 |

### Operational Agents (4)

| ID | Model | Role |
|----|-------|------|
| `config-auditor` | glm-5.3 | Configuration audit |
| `log-analyzer` | glm-5.3 | Log analysis |
| `commit-reviewer` | glm-5.3 | Code review |
| `guardian-sentinel` | glm-5.3 | System health surveillance |

### Deep Search Agents (3)

| ID | Model | Tools | Memory |
|----|-------|-------|--------|
| `researcher` | glm-5.3 | searxng, playwright, open_terminal, markitdown | ✅ |
| `synthesizer` | glm-5.3-flash | — | ❌ |
| `critic` | glm-5.3 | — | ❌ |

### Deep Think Agents (4)

| ID | Model | Role |
|----|-------|------|
| `optimist` | glm-5.3 | Opportunity finder |
| `devils-advocate` | glm-5.3 | Risk identifier |
| `pragmatist` | glm-5.3 | Implementation planner |
| `mediator` | glm-5.3-flash | Consensus builder |

### PR Review Agents (5, #1587)

| ID | Model | Role |
|----|-------|------|
| `fast-reviewer` | glm-5.3-flash | Tier 1 diff-only reviewer |
| `integration-reviewer` | glm-5.3 | Tier 2 context-aware reviewer |
| `context-explorer` | glm-5.3 | Code context around PR changes |
| `regression-hunter` | glm-5.3 | Git-history regression risks |
| `security-executor` | glm-5.3 | Deep security analysis |

### OWUI Custom Agents (3)

| ID | Model | Role |
|----|-------|------|
| `owui-analyst` | owui-expert-analyste | Structured French analysis |
| `owui-writer` | owui-redacteur-technique | Technical documentation |
| `owui-vision` | owui-vision-expert | Vision analysis |

## Changelog

### v2.2 (2026-09-23) — user mandate 22/09 (glm-5.3 era)

- **Local by default**: `analyst` (default_agent) and `vision-analyst` (default_vision_agent) now run `qwen3.6-35b-a3b` locally; `analyst-glm5` is the explicit cloud twin (fallback when :5002 is down)
- **GLM lineup**: glm-5.1/glm-5/glm-5-fast/glm-4.7-flash (direct z.ai) superseded by `glm-5.3` + `glm-5.3-flash` via the fleet hub (#3574)
- **Vision stays local**: the hub strips `image_url` parts (roo-extensions#794) — cloud GLM vision deferred until the claudish passthrough fix
- **Purged dead models**: `omnicoder-9b`, `owui-omnicoder-9b`, `owui-glm-4.7-flash-*`
- 8 models / 32 agents

### v2.1 (2026-04-09) — Issue #894

- **13 models**: z.ai cloud (4) + vLLM direct (2) + OWUI proxy (4) + OWUI custom (3)
- **25 agents**: Full coverage of thinking/vision combinations across all model sources
- **New model field**: `thinking` flag on ModelConfig for reasoning capability tracking
- **New agents**: `fast-local`, `fast-local-thinking`, `analyst-glm5`, `coder-local`, `vision-local-owui`, `qwen-local`
- **OWUI proxy models**: Separate entries for thinking vs non-thinking variants
- **151 tests**: Config (51) + agent/integration (100), all passing

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
