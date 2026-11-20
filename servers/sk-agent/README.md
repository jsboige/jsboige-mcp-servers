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

#### `call_agent(prompt, agent?, attachment?, options?, conversation_id?, include_steps?, model_override?, system_prompt?, mcp_overrides?, agent_spec?, source_file?)`

Unified agent invocation. Routes to the right agent based on content type.

- `prompt`: Question or instruction
- `agent`: Agent ID (default: auto-select based on attachment)
- `attachment`: File path or URL (image, video, PDF, PPTX, DOCX, XLSX)
- `source_file`: Local **text** file (`.log`, `.md`, `.py`, `.ps1`, `.json`, …) whose content is injected **verbatim** into the prompt between `<source_file>` delimiters — the large-corpus channel (vllm#205): pass the file instead of re-typing kilobytes inline. Local files only, no URL. **`stdio` transport only** — refused over `streamable-http`, where the caller is remote and shares one Bearer with every other client, so it has no host filesystem to read. Also refused: the mounted sk-agent configuration file (it holds the per-model `api_key` values) and any file above the byte ceiling of the largest admissible cap (checked with `stat()` **before** the read, so an oversized log is never pulled into RAM). Default cap 100K chars (~25K tokens — sized for the mini tier), raised per call via `options.source_max_chars` (hard ceiling 2M chars). The response echoes `{path, chars, truncated}`; a truncated block carries an in-prompt marker so the agent knows it saw a prefix, and the delimiters carry a per-call nonce so a corpus containing `</source_file>` cannot close the block early.
- `options`: JSON string with type-specific params (`region`, `mode`, `max_pages`, `page_range`, `num_frames`, `source_max_chars`)
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
      "base_url": "${HUB_BASE_URL}",
      "api_key_env": "ZAI_API_KEY",
      "model_id": "glm-5.3",
      "vision": false,
      "context_window": 200000
    },
    {
      "id": "swift-1.5-27b",
      "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
      "model_id": "swift-1.5-27b",
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
      "model": "swift-1.5-27b",
      "system_prompt": "You are a helpful analyst.",
      "capabilities": ["memory"],
      "mcps": ["searxng"],
      "memory": { "enabled": true, "collection": "analyst-memory" }
    },
    {
      "id": "vision-analyst",
      "model": "swift-1.5-27b",
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

A model entry may declare five OPTIONAL fields — absent fields keep the
current behaviour exactly (no ceiling change, global budget, sampling-only
`extra_body`):

| Field | Default | Effect |
|-------|---------|--------|
| `request_timeout_s` | `null` (= 300 s) | OpenAI client timeout for this model. Declaring it **also couples** the `call_agent` wait_for ceiling (see Timeout chain). |
| `connect_timeout_s` | `null` (= 5 s) | #4085 — separate bound for the TCP/TLS **connect phase only** (`read`/`write`/`pool` keep the request budget above). An unreachable endpoint (e.g. a LAN-only hub from an off-LAN seat) fails within this bound instead of holding the whole window with no error. |
| `max_tokens` | `null` (= global `sampling.max_tokens`, 4096) | Default output budget for the model. Precedence: per-call / `agent_spec` sampling override > model default > global. |
| `extra_body` | `{}` | Generic vLLM passthrough merged into the request `extra_body`. Model keys override sampling-derived keys (`top_k`/`min_p`/`repetition_penalty` — per-model is more specific than server-wide); `chat_template_kwargs` is deep-merged, so the code-injected `enable_thinking` keeps winning on its key without clobbering other keys. |
| `default_headers` | `null` (= none) | #4740 — extra HTTP headers sent with every request to this model, passed to `AsyncOpenAI(default_headers=…)`. Used by the `nb-*` entries for the claudish lane/seat attribution (`{"x-claudish-lane": "nb-coder", "X-Claudish-Machine": "<seat>"}`, claudish#1055 g4 §2), without which the lane budget, stop and per-lane table stay inert. Names must be HTTP tokens and values strings without CR/LF; a malformed value leaves **that model** out of the pool (fail closed: no traffic without its declared attribution), the other models stay up. |

Example — the notebook-auditor case: a local model under parallel load that
bumps into the 300 s client budget, with a raised thinking budget:

```json
{
  "id": "swift-1.5-27b-slow",
  "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
  "model_id": "swift-1.5-27b",
  "thinking": true,
  "request_timeout_s": 600,
  "max_tokens": 8000,
  "extra_body": { "chat_template_kwargs": { "thinking_budget": 2048 } }
}
```

Deploying real values is a per-model operations decision, made one model at
a time (nothing is activated in the shipped template).

### Seat-local additions — nb-coder, and the per-model capacity gate (#4712, #4725)

The nb-coder harness (CoursIA#26534) adds four agent entries plus their
model and MCP dependencies to the seat that runs it — **myia-ai-01 first**;
other seats are not concerned until the pilot concludes. The entries live in
the LIVE `sk_agent_config.json` (gitignored, carries keys), NOT in this
template: a template entry would invalidate every other seat's config, since
`validate_config` rejects an agent whose MCPs are undeclared (so
`jupyter_papermill` must ride along) and that MCP is an ai-01-only
interpreter path. This is the `notebook-auditor` pattern — local agents and
their model/MCP dependencies survive `sync_from_template.py`
(`--prune-local` removes them).

The reviewable, sanitized source is
[`nb_coder_seat_entries.example.json`](nb_coder_seat_entries.example.json)
and [`test_nb_coder_entries.py`](test_nb_coder_entries.py) validates it with
the same `validate_config` the seat runs at load. The four agents —
`notebook-coder`, `notebook-coder-luna`, `notebook-coder-minimax`,
`notebook-coder-haiku` — are the SAME entry; the model reference is the only
difference. All four declare `github_read` only: the write function lives on
`GitHubWritePlugin` (#4725), so a read-only agent's kernel function list
does not even advertise it.

| Variant | Model entry | Backend |
|---------|-------------|---------|
| `notebook-coder` | `swift-1.5-27b-nbcoder` | Swift engine (`model_id: swift-1.5-27b`, medium vLLM) **with the declared capacity gate** |
| `notebook-coder-luna` | `nb-luna` | claudish stable alias via the **seat sidecar** (g4) |
| `notebook-coder-minimax` | `nb-minimax` | claudish stable alias via the **seat sidecar** (g4) |
| `notebook-coder-haiku` | `nb-haiku` | claudish stable alias via the **seat sidecar** (g4) — NOT PUBLISHED yet (native Anthropic path requires the client's own account) |

**The gate sits on a dedicated model id on purpose.** `capacity_gate` is
evaluated per MODEL ID (`sk_agent_capacity_gate.check_model_capacity_gate`),
before any LLM call: exit 0 green, 1 yellow (refused unless
`allow_yellow`), 2 red, anything else unknown — refused, fail-closed.
Declaring it on the shared Swift / `-audit` entry would
collaterally gate the auditor and every other Swift consumer; the
`-nbcoder` id reuses the same engine and endpoint, so a red probe refuses
only nb-coder dispatches.

**Apply on ai-01** (the seat owner merges; a seat's live config is that
seat's to change):

1. Copy the `models`, `mcps` and `agents` entries into the live
   `sk_agent_config.json`. Merge rule: **add what is absent** — a live
   declaration wins over the copy here (the fragment is self-contained only
   so `validate_config` can run on it standalone). For
   `swift-1.5-27b-nbcoder`, derive from the live auditor model entry
   (keys, endpoint, sampling) and add `capacity_gate`; fill the real
   `jupyter_papermill` `PYTHONPATH` and API keys. On each `nb-*` entry,
   replace `<sidecar-port>` with the seat's claudish sidecar port and
   `<seat machine name>` with the seat's machine id (e.g. `myia-ai-01`).
2. Validate (from this directory — `load_config` only LOGS warnings, so
   call the validator directly):
   `python -c "import json,sys; from sk_agent_config import validate_config; e=validate_config(json.load(open('sk_agent_config.json',encoding='utf-8'))); print('\n'.join(e) or 'OK'); sys.exit(1 if e else 0)"`
   — expect `OK`: no `[schema]` error, no unknown model/MCP reference.
3. Restart the sk-agent process so the MCP host serves the new entries.
4. Verify: `call_agent` on each variant reports the expected `model_used`;
   with a red probe the Swift variant returns
   `error_type: capacity_gate_red` and makes no LLM call; on a sandbox
   notebook a variant writes a cell (`add_cell`) and the harness runs it
   with `execute_on_kernel` on the requested kernel; the agent's tool list
   has no GitHub write function.

**#4716 prerequisite** — jupyter-papermill has two `KernelService`
registries: `execute_notebook_cell` returns "Kernel not found" on a kernel
started by `manage_kernel`. The only correct execution path is
**`execute_on_kernel`**; the system prompt names the defect so a coder
model does not rediscover it.

**claudish alias contract** (volet jsboige/claudish#1055, g3 pending): the
`nb-<model>` ids follow the existing routing-key convention (`nb-minimax`).
Until g3 publishes them the hub 404s on these three ids — expected, the
variants arm themselves once the aliases land. If g3 ships different names,
the edit is the three `model` references in the agents (one line each).

**Why the sidecar, not the hub in direct (g4, CoursIA#26534
c.6885222101):** routing the `nb-*` entries at the seat sidecar
(`http://127.0.0.1:<port>/v1`) instead of the fleet hub gives two things the
direct hop cannot — the sidecar injects the **cluster key** (the entry's own
key placeholder never leaves the seat) and keeps the **AUTONOMOUS fallback**
when the hub is down. The lane/seat attribution headers themselves are
`default_headers` (#4740): the relay copies incoming headers but never adds
the machine, so the entry carries its own attribution.

### Complementary local profiles (#2002)

The same local vLLM model (Swift-1.5-27B, fleet vLLM on ai-01) is exposed
as a thinking / non-thinking pair under the canonical ids (`swift-1.5-27b`,
`swift-1.5-27b-no-thinking` since 11/10, #3411 option A — the pre-rename
alias entries were retired from the template on 2026-11-15, #3401):

| Profile | Model entry | Use |
|---------|-------------|-----|
| Thinking | `swift-1.5-27b` | analysis and review — chain-of-thought (`analyst`, `qwen-local`, `fast-local-thinking`) |
| Non-thinking | `swift-1.5-27b-no-thinking` | short, cheap tasks: classification, formatting (`classifier-local`, `formatter-local`, `fast`, `fast-local`, `coder`) |

Since the #1748 casting (11/10), `summarizer-local` runs on `frognano-4b`
(fastest measured on concise_summary: 2.5 s median vs 29.8 s on the
non-thinking pair, no oracle gap on the task); `classifier-local` and
`formatter-local` stay on the non-thinking entry.

The non-thinking entry declares `extra_body.chat_template_kwargs.enable_thinking = false`
via the #3797 passthrough. `call_agent` already injects that flag from
`thinking: false`, but `run_conversation` agents only receive what the model
entry declares — without this key, a non-thinking profile used in a
conversation preset would think anyway.

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
   unchanged from #1587. Since #4085 the client timeout is an
   `httpx.Timeout` with `connect` bounded separately (default 5 s,
   `connect_timeout_s` override) while `read`/`write`/`pool` carry the
   request budget — a black-holed connect (unreachable hub) fails fast
   instead of holding the whole scalar window.
2. **`call_agent` wait_for (tiers)** — the `timeout` parameter (default
   120 s, `0` = no limit); `review_pr` raises it per tier (60/180/300 s).
   **Coupling (#3797):** when the resolved model DECLARES
   `request_timeout_s`, the ceiling becomes
   `max(caller timeout, request_timeout_s + 30 s)` — the 30 s margin covers
   the pre-LLM work sharing the same window. Undeclared models keep the
   legacy ceilings untouched (non-regression).
   **Freeze watchdog (#4085):** `wait_for` cannot fire while the event loop
   itself is frozen — measured: a sync handler block outruns its ceiling and
   the call still "succeeds"; a permanent connect freeze returns nothing at
   all (the silent-deaf-spawn signature). Each call arms
   `faulthandler.dump_traceback_later(ceiling + 5 s, exit=False)`; a normal
   completion cancels it, so a stack dump on stderr means the result had not
   come back by ceiling + grace — the watchdog thread auto-documents WHERE
   the process is frozen for the next occurrence.
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

**#4742 amendment:** `run_conversation` now runs under its own ceiling —
`options {"timeout": N}` (default 900 s, `0` = no limit) — and passes the
same pre-dispatch gates as `call_agent` (per-agent rate limit, per-model
capacity gate) before any model call.

## Turn control (#4742)

Fine-grained, resumable control of `call_agent` turns, built for the vllm
nb-coder contract (live round admission, defer/resume, no in-flight kill):

- **Envelope.** Every `call_agent` response carries `conversation_id`,
  `turn_index`, `round_index`, `status` (`completed` | `paused` | `error`);
  a mid-turn pause adds `paused: true`, `resumable: true`, a non-empty
  `response` (`"[paused: <reason>] resume with options.continue ..."`, so a
  pause never reads as an empty success, #1587) and a `pause` block
  (`reason` `capacity_gate` | `round_budget`, `round_index`, gate verdict).
  A capacity-gate refusal BEFORE a fresh turn starts is `status: "paused"`
  with `retry_only: true`, `resumable: false`: nothing was committed, so
  repeat the same call (same prompt) — `options.continue` without a paused
  turn is refused as `no_paused_epoch`.
- **Round admission (pull).** The capacity gate (#4712) is evaluated
  before the first model call (as before) and after every round's tools
  complete — a red/yellow verdict mid-conversation PAUSES the turn
  instead of erroring. `options {"max_rounds": N}` bounds the tool rounds
  admitted during this call (pause when reached).
- **Pause is clean.** The pause is implemented with SK's
  `terminate`: the round's tools all complete (`asyncio.gather` finishes
  before the terminate check), the loop stops before the next model
  call, and everything is committed to the thread — nothing in flight is
  killed.
- **Resume.** `call_agent(prompt="", conversation_id=X, options={"continue":
  true})` re-enters the loop over the committed history: no new user
  message, tools already executed never re-run, and a fresh round budget
  (`max_rounds` counts the rounds of that call only).
- **Durable conversations (opt-in).** `SK_AGENT_CONVERSATION_DIR` points
  at a directory where each conversation's user/assistant messages and
  the current turn's tool journal are persisted. After a restart, a
  resumed turn rebuilds by replaying model calls; journaled tool calls
  are answered from the journal (idempotent defer — no double
  execution), and the replayed rounds are not counted again in
  `round_index` or against `max_rounds`. Files are named by the sha256 of
  the conversation id (`<h>.json`, `<h>.journal.json`); the readable id is
  stored inside and checked on load — a mismatch reads as absent.
  `end_conversation` removes the persisted state.
- **Concurrency lock.** Two concurrent turns on one conversation: the
  second is refused as `conversation_busy` — never interleaved history.
- **Timeout rollback.** A timed-out or cancelled turn is truncated back,
  under the lock, to the exact thread length it started from, and the
  error names the `conversation_id` so the caller retries clean. A
  timed-out resume (`options.continue`) keeps its paused turn — prompt,
  `turn_index` and durable journal — so it can be continued again.
- **Probe-absent is `unknown`, not `red`.** A gate probe whose script is
  missing fails inside its interpreter (python exits 2); the stderr
  launcher-failure signature reclassifies it `unknown` (still refused —
  fail-closed) instead of lying "saturated".

Implementation: `sk_agent_turns.py` (controller, filter, durable store,
journal), the `AUTO_FUNCTION_INVOCATION` filter installed on every agent
kernel, and `_begin_turn`/`_finish_turn`/`_rollback_turn` in the manager.
Tests: `test_turn_control.py` (real SK loop, scripted model — pause,
resume, restart replay, rollback, lock, gates), run by the CI job
`test-sk-agent`.

### Known limits

- **A tool run inside an interrupted turn runs again.** Executions are
  journaled durably only when a turn pauses. A resumed turn that times
  out (or is cancelled) is rolled back to its paused epoch, so a tool it
  had already executed runs again on the next `continue` (measured: 3
  executions for 2 committed rounds). A timed-out fresh turn is rolled
  back whole, and its retry re-runs every tool. Prefer idempotent tools,
  and set `timeout` above the longest expected round.
- **No eviction.** Finished conversations stay in memory, and with the
  durable store on disk (`<h>.json`), until `end_conversation` removes
  them.
- **Raw tool results on disk.** While a turn is paused, its journal
  (`<h>.journal.json`) stores raw tool results — a secret printed by a
  shell tool lands on disk. The store is opt-in: point
  `SK_AGENT_CONVERSATION_DIR` at a protected directory.
- **Replay needs identical arguments; the journal is written on pause
  only.** A journaled call is matched by tool name plus byte-identical
  arguments: a model that serializes the same arguments differently on
  replay runs the tool again. A crash before the turn pauses leaves no
  journal, so the tools of that turn re-run.
- **`run_conversation` ceiling.** It is capped at 900 s by default (see
  the #4742 amendment above).

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
| `SK_AGENT_CONVERSATION_DIR` | Opt-in durable conversation store (#4742): directory where conversations and turn journals survive restarts | disabled |
| `HUB_BASE_URL` | OpenAI-compatible **fleet hub endpoint, including `/v1`** — resolves the `${HUB_BASE_URL}` model `base_url` placeholder (`glm-*`, `frognano-4b`) | none (#4814) |
| `ZAI_API_KEY` | z.ai API key (if using `api_key_env`) — also the **cluster hub client key** the mini lane rides on (`frognano-4b`), like the `glm-*` entries | - |
| `EMBEDDINGS_API_KEY` | Embeddings endpoint key | - |
| `OPEN_TERMINAL_URL` | Open Terminal API URL handed to the `open_terminal` MCP (stdio seats only — the plugin is `runtimes: ["stdio"]` and its launcher is absent from the container image, #4758). Set it in the **seat environment** (e.g. `http://localhost:8000`, the open-terminal container's published port) | none (#4758/#4814) |

`models[].base_url` and `mcps[].env` values may reference the sk-agent process environment as `${VAR}` (and, for MCP env only, `${VAR:-default}` — default used when `VAR` is unset or empty). The config entry still wins over the inherited environment for its key; only the placeholder is resolved. An unset `VAR` without default is passed through literally and logged as a warning. This is how one config file serves both the container and the host without publishing seat-specific endpoints (vllm#63, #4814).

## Requirements

- Python 3.11+
- `semantic-kernel[mcp]>=1.39`
- `mcp>=1.26,<2`
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

## Available Models (9)

### GLM via fleet hub (2) — claudish `${HUB_BASE_URL}` (incl. `/v1`, set per seat — #4814), key = hub client key (#3574)

| ID | Model | Vision | Thinking | Context |
|----|-------|--------|----------|---------|
| `glm-5.3` | GLM-5.3 | ❌ | ✅ | 200K |
| `glm-5.3-flash` | GLM-5.3-Flash | ❌ | ❌ | 131K |

Vision is **not** served through the hub: it strips `image_url` parts before they reach z.ai (VERIFIED, roo-extensions#794) — vision routes local (`swift-1.5-27b`) until the claudish passthrough fix.

### Mini tier — FrogNano-4B (1) — economy routing (#4107, volet C of #4085)

The mini tier is the cheapest budget in the fleet: it takes the reading and the mechanical recomputation with objective criteria, while judgement and decisions stay on the medium (doctrine #63). Served from po-2025 (direct `:5003`, hub route `frognano@frognano-4b`), alias `mini`, Apache 2.0, 32K context, tool-calling validated in a real multi-turn loop.

| ID | Model | Vision | Thinking | Context |
|----|-------|--------|----------|---------|
| `frognano-4b` | FrogNano-4B (alias `mini`) | ❌ | ❌ | 32K |

`thinking` is **off by correctness, not tuning**: measured, at `thinking: true` this 4B spends the whole output budget on reasoning and returns an empty answer. Re-enable it per call through `sampling_override` with a budget ≥ 4096 only. On the hub route the flag has no **measurable** effect (2026-10-07) — the budget is the lever that decides whether an answer exists; the flag stays declared because it is harmless and is what the `thinking: false` path sends. The `max_tokens: 4096` on the model entry is the output-budget **floor measured through the hub** on 2026-10-07 — not 1024 (0/3 runs yield content) and not 2048 (stochastic in both arms, 4 of 7 runs empty): the model reasons regardless of the flag, ~1200-2500 reasoning tokens per answer. It lives on the model because the runtime resolves budgets per-call/`agent_spec` > model > global sampling and does not read a preset's `execution.max_tokens`.

Key: `ZAI_API_KEY` (`api_key_env`) — the **cluster hub client key**, the same env var as the `glm-*` entries; **never** the MINI key, which is the hub→vLLM transport credential and must not leave the hub. The template ships a placeholder only.

### vLLM Local Direct (2)

Since 25/09 the fleet medium model is **Swift-1.5-27B** (`ukisai/Swift-1.5-Qwen3.8-27b-W4A16-AWQ`), served on ai-01 as `swift-1.5-27b`. Qwen3.6 35B MoE is retired. Since 11/10 (#3411 option A) the template's canonical ids are the served engine names; the pre-rename alias entries were **retired from the template on 2026-11-15 (#3401)** — a live config that still cites an old id renames the reference to the canonical id (same engine, same endpoint). The canonical entries declare `"succeeds": "<pre-rename id>"` — on a seat that has not synced since the rename and whose local medium `base_url` diverges from the template, the sync inherits the old entry's local key AND endpoint, so a renamed id never deploys keyless (ms#1421 review).

| ID | Model | Vision | Thinking | Context |
|----|-------|--------|----------|---------|
| `swift-1.5-27b` | Swift-1.5-27B (canonical id) | ✅ | ✅ | 262K |
| `swift-1.5-27b-no-thinking` | Swift-1.5-27B, no-thinking | ❌ | ❌ | 262K |

### OWUI Proxy (1)

| ID | Model | Vision | Thinking | Context |
|----|-------|--------|----------|---------|
| `owui-swift-1.5-27b` | Swift-1.5-27B via OWUI (model_id `Local.swift-1.5-27b`, chat-level 200 by ai-01 15/11 with unknown-name 404 control; both `Local.*` ids resolve to the same vLLM backend) | ✅ | ✅ | 262K |

### OWUI Custom Models (3)

| ID | Model | Vision | Thinking | Context |
|----|-------|--------|----------|---------|
| `owui-expert-analyste` | Expert Analyste | ❌ | ✅ | 131K |
| `owui-redacteur-technique` | Rédacteur Technique | ❌ | ✅ | 131K |
| `owui-vision-expert` | Vision Expert | ✅ | ✅ | 131K |

Purged (dead): `omnicoder-9b` + `owui-omnicoder-9b` (GPU 2 freed 30/04), `owui-glm-4.7-flash-*` (local GLM archived), `glm-5.1`/`glm-5`/`glm-4.6v`/`glm-4.7-flash` direct z.ai entries (superseded by glm-5.3/glm-5.3-flash via hub, user mandate 22/09).

## Available Agents (42)

### Core Agents (13)

| ID | Model | Vision | Thinking | Tools | Memory | Description |
|----|-------|--------|----------|-------|--------|-------------|
| `analyst` | swift-1.5-27b | ✅ | ✅ | searxng, playwright, markitdown | ✅ | General analyst — **fleet default, local** (user mandate 22/09) |
| `analyst-glm5` | glm-5.3 | ❌ | ✅ | searxng, playwright, markitdown | ✅ | Cloud twin of analyst (heavy tasks, local-down fallback) |
| `analyst-fast` | glm-5.3-flash | ❌ | ❌ | searxng | ❌ | Fast analyst (hub) |
| `fast-responder` | glm-5.3-flash | ❌ | ❌ | — | ❌ | Quick answers / triage (hub) |
| `vision-analyst` | swift-1.5-27b | ✅ | ✅ | searxng, playwright, markitdown | ❌ | Vision specialist — **local** (hub strips images, #794) |
| `vision-local` | swift-1.5-27b | ✅ | ✅ | searxng, playwright, markitdown | ❌ | Local vision+thinking |
| `vision-local-owui` | owui-swift-1.5-27b | ✅ | ✅ | — | ❌ | OWUI Swift-1.5-27B vision |
| `coder` | swift-1.5-27b-no-thinking | ❌ | ❌ | open_terminal, searxng | ❌ | Local coding (vLLM direct) |
| `coder-local` | owui-swift-1.5-27b | ✅ | ✅ | — | ❌ | Local coding (OWUI proxy) |
| `fast` | swift-1.5-27b-no-thinking | ❌ | ❌ | — | ❌ | Fastest reliable (local no-thinking) |
| `fast-local` | swift-1.5-27b-no-thinking | ❌ | ❌ | — | ❌ | Fast local (direct vLLM) |
| `fast-local-thinking` | swift-1.5-27b | ✅ | ✅ | — | ❌ | Local with thinking |
| `qwen-local` | swift-1.5-27b | ✅ | ✅ | — | ❌ | Direct vLLM Swift-1.5-27B |

### Operational Agents (4)

| ID | Model | Role |
|----|-------|------|
| `config-auditor` | glm-5.3 | Configuration audit |
| `log-analyzer` | glm-5.3 | Log analysis |
| `commit-reviewer` | glm-5.3-flash | Code review (#1748 casting: oracle top score, 4.60) |
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
| `owui-vision` | owui-swift-1.5-27b | Vision analysis |

### Mini tier presets (4) — delegate the mechanical work

Each preset states in its own `description` what the calling agent may hand over, and that **source code goes in the prompt** (sk-agent *attachments* accept office/media only — `.py`/`.ps1` are refused; hand code over as a `source_file`, which injects the content verbatim, instead). All four run `frognano-4b` (no-thinking) and carry the economy rule (#63).

| ID | Tools | What to delegate | Budget floor |
|----|-------|------------------|--------------|
| `mini-coder-fix` | open_terminal | Single-file corrective diagnosis; code pasted in the prompt | 4096 |
| `mini-repo-scan` | open_terminal (read-only by instruction) | Repository inventory: structure, dependencies, risks | 4096 |
| `mini-summarizer` | markitdown | Faithful condensation to a fixed shape — the flagship token-economy delegation | 4096 |
| `mini-web-research` | searxng | Source collection against a precise question, no synthesis | 4096 |

### Delegating preset (1) — the medium works by delegation

| ID | Model | Tools | Description |
|----|-------|-------|-------------|
| `swift-delegator` | swift-1.5-27b | sk_agent | Fleet medium (Swift-1.5-27B) that keeps the judgement and delegates short, tooled, verifiable sub-tasks to the mini presets through the self-inclusion plugin. A child failure is reported and finished by the medium — never a silent gap. |

## Usage Guide — which agent for what (#4085 volet D)

Short guide for callers. Defaults are right most of the time: `call_agent` without
`agent` runs `analyst` (local, full tool belt). Deviate only when a row says so.

| You need | Call | Why |
| -------- | ---- | --- |
| General analysis | `analyst` (default) | Local Swift-1.5-27B, searxng + playwright + markitdown |
| Heavy analysis while local is down | `analyst-glm5` | Cloud twin, same tool belt |
| Quick triage, cheap | `fast-responder`, `analyst-fast` | Hub flash models, minimal tools |
| Images / screenshots | `vision-analyst` (vision default) or `vision-local` | Hub strips images (#794) — vision runs local |
| Code edit or verify on this machine | `coder` | Carries `open_terminal` |
| PR review | `review_pr` | Picks its review tier itself — three tiers (#1587) |
| Structured French deliverable | `owui-analyst`, `owui-writer` | OWUI expert presets |
| Multi-perspective deliberation | `run_conversation` + `deep-think` | 4-agent group chat |
| Sourced research | `run_conversation` + `deep-search` | researcher → synthesizer → critic |
| Cheap mechanical sub-tasks | via `swift-delegator` | Delegates to `frognano-4b` mini presets (#4107) |

**stdio vs mcp-tools.** Every entry in `mcps` is spawned by sk-agent itself as a
**local stdio subprocess** — plugin isolation is free (`venv-markitdown` runs mcp 2.x
while the main venv stays on 1.x). An agent's `mcps` list is the **default** set for its
turns: a single call can narrow or swap it with `mcp_overrides` (`{"add": …}`,
`{"remove": …}`, `{"replace": …}`) or `agent_spec.mcps`, and can never widen beyond the
agent's capabilities. `list_agents` reports each agent's configured `mcps`;
`list_tools` shows the tools loaded in the **first initialised kernel** — useful for
debugging plugin wiring, not for a per-agent inventory.

**Known limits.**

- **Vision is local-only** — the hub strips images (#794).
- **Attachments accept office/media only** — `.py`/`.ps1` are refused as attachments; text corpora go through the `source_file` channel (verbatim prompt injection, capped) or inline in the prompt (the mini presets enforce this).
- **Thinking doubles latency** on Swift models — prefer the `-no-thinking` variants (`coder`, `fast`, `fast-local`) unless reasoning is needed.
- **Timeouts and budgets** follow the timeout chain (#3797) and per-model budget overrides; the mini-tier budget floor is 4096 tokens (#4107).
- **Usage telemetry** (`usage.jsonl`) records tool, duration, agent, model and token usage (prompt/completion, summed over every completion of a call — `call_agent` only; `run_conversation`/group chat are not instrumented) — never content (ms#1387, ms#1612, ms#1790).

## Changelog

### v2.5 (2026-11-15) — alias retirement + OWUI rename (#3401 item 3)

- **Aliases retired**: the template no longer ships the deprecated `qwen3.6-35b-a3b` / `qwen3.6-35b-no-thinking` entries (30-day window from v2.4 closed). A live config still citing an old id renames the reference to the canonical id — the `succeeds` fields stay so a not-yet-synced seat inherits its local pre-rename key AND endpoint (ms#1421)
- **OWUI entry renamed**: `owui-qwen3.6-35b` → `owui-swift-1.5-27b` with `"succeeds": "owui-qwen3.6-35b"` for key inheritance; the three `owui-*` agents citing it follow. `model_id` audited to `Local.swift-1.5-27b` — verified chat-level 200 by ai-01 15/11 12:10Z with an unknown-name 404 control (no fallback; `Local.*` ids are served by the OWUI→vLLM connection, which is why earlier preset-table reads missed them)
- **nb-coder example**: the gated Swift entry is `swift-1.5-27b-nbcoder` (`model_id: swift-1.5-27b`); a seat already carrying the old id renames its live entry in place
- `deploy-sk-agent.ps1` inline fallback and `benchmark_models.py` roster aligned; 9 models / 42 agents

### v2.4 (2026-10-11) — canonical swift-1.5-27b ids (#3411, fleet audit option A)

- **New canonical ids**: `swift-1.5-27b` (+ `swift-1.5-27b-no-thinking` preset) — the served engine name, so `list_agents` states what actually runs
- **Deprecated aliases**: `qwen3.6-35b-a3b` and `qwen3.6-35b-no-thinking` kept ~30 days (removal ~2026-11-10) — ad hoc agent_specs (extends + model) citing them keep resolving; the server keeps serving both names
- **Successor key inheritance** (sync, ms#1421 review): the canonical ids carry `"succeeds": "<alias id>"` — on a seat whose local medium `base_url` diverges from the template (ai-01 `host.docker.internal`), `sync_from_template.py` step 4 inherits the alias's local key AND endpoint, so a renamed id never deploys keyless against an unreachable URL
- **Presets re-pointed**: the 8 thinking and 7 no-thinking medium presets (incl. the pr-review-tier1 inline synthesizer) now cite the canonical ids; OWUI entries unchanged (OWUI-side naming, changes when OWUI renames)
- 9 models / 42 agents

### v2.3 (2026-10-07) — mini tier + delegation (#4107, volet C of #4085)

- **New model**: `frognano-4b` (FrogNano-4B, alias `mini`, served from po-2025) — `thinking: false` by correctness (at `thinking: true` the 4B returns an empty answer), 32K context, `max_tokens: 4096` output-budget floor **measured through the hub** (2026-10-07), key through the cluster hub client key `ZAI_API_KEY` (never the MINI transport key)
- **4 mini presets**: `mini-coder-fix`, `mini-repo-scan`, `mini-summarizer`, `mini-web-research` — each description states what the caller may delegate, that code goes in the prompt, and the economy rule (#63)
- **Delegating preset**: `swift-delegator` (fleet medium + the `sk_agent` self-inclusion plugin) — delegates short, tooled, verifiable sub-tasks; a child failure is reported and finished by the medium
- **Guards**: tests drive the template's own self-inclusion entry through the recursion ceiling (refusal before plugin construction, no orphan bookkeeping) and assert a failing child degrades without wedging the parent
- 9 models / 42 agents

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
