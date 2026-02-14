# sk-agent - Semantic Kernel MCP Server

Multi-model LLM proxy server for Claude Code and Roo Code.

## Features

- **Multi-model support**: Configure multiple models with per-model kernels
- **Tool calling**: Models can use MCP plugins (SearXNG, Playwright, etc.)
- **Vision support**: Analyze images with vision-capable models
- **Dynamic model selection**: Choose the right model for each task
- **Intermediate steps**: Optional visibility into tool calls and reasoning
- **Self-inclusion**: Recursive tool chaining with configurable depth limit
- **Conversation threading**: Persistent chat sessions per model

## Architecture

```text
Claude/Roo  --stdio-->  FastMCP server (sk_agent.py)
                              |
                              v
                         Semantic Kernel (per-model)
                         +-- OpenAI Chat Completion (multiple services)
                         +-- MCPStdioPlugin: SearXNG, Playwright, etc.
```

Each model gets its own kernel, agent, and optional model-specific MCP plugins.

## Configured Models

### z.ai API (enabled by default)

| Model ID      | Endpoint                               | Vision | Default For | Description           |
|---------------|----------------------------------------|--------|-------------|-----------------------|
| `glm-4.6v`    | `https://api.z.ai/api/coding/paas/v4`  | Yes    | Vision      | GLM-4.6V (vision)     |
| `glm-5`       | `https://api.z.ai/api/coding/paas/v4`  | No     | Ask         | GLM-5 (fast text)     |
| `glm-4-plus`  | `https://api.z.ai/api/coding/paas/v4`  | No     | -           | GLM-4-Plus (advanced) |

### Myia Infrastructure (disabled by default)

| Model ID               | Endpoint                                           | Vision | Description                    |
|------------------------|----------------------------------------------------|--------|--------------------------------|
| `qwen3-vl-8b-thinking` | `https://api.mini.text-generation-webui.myia.io/v1`  | Yes    | Qwen3-VL 8B Thinking           |
| `glm-4.7-flash`        | `https://api.medium.text-generation-webui.myia.io/v1`| No     | GLM-4.7-Flash                  |

### Model Enable/Disable

Each model has an `enabled` field in the configuration. Set to `true` to activate, `false` to deactivate.

## Configuration

Copy `sk_agent_config.template.json` to `sk_agent_config.json` and add your API keys.

### Configuration Fields

| Field | Type | Description |
|-------|------|-------------|
| `default_ask_model` | string | Model ID for `ask()` tool (default: first model) |
| `default_vision_model` | string | Model ID for `analyze_image()` tool |
| `max_recursion_depth` | int | Max self-inclusion depth (default: 2) |
| `models` | array | List of model configurations |
| `models[].id` | string | Unique identifier for the model |
| `models[].enabled` | bool | Whether model is active (default: true) |
| `models[].base_url` | string | OpenAI-compatible API endpoint |
| `models[].api_key` | string | API key (or use `api_key_env` for env var) |
| `models[].model_id` | string | Actual model name for API calls |
| `models[].vision` | bool | Whether model supports image input |
| `models[].system_prompt` | string | Model-specific system prompt (optional) |
| `models[].mcps` | array | Model-specific MCP plugins (optional) |
| `mcps` | array | Shared MCP plugins for all models |
| `system_prompt` | string | Global system prompt (fallback) |

### Example Configuration

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
      "api_key_env": "ZAI_API_KEY",
      "api_key": "YOUR_ZAI_API_KEY_HERE",
      "model_id": "glm-4.6v",
      "vision": true,
      "description": "Vision model for image analysis (GLM-4.6V via z.ai)",
      "system_prompt": "You are a vision analysis specialist."
    },
    {
      "id": "glm-5",
      "enabled": true,
      "base_url": "https://api.z.ai/api/coding/paas/v4",
      "api_key_env": "ZAI_API_KEY",
      "api_key": "YOUR_ZAI_API_KEY_HERE",
      "model_id": "glm-5",
      "vision": false,
      "description": "Fast text model for quick responses (GLM-5 via z.ai)"
    },
    {
      "id": "qwen3-vl-8b-thinking",
      "enabled": false,
      "base_url": "https://api.mini.text-generation-webui.myia.io/v1",
      "api_key": "YOUR_MINI_API_KEY_HERE",
      "model_id": "qwen3-vl-8b-thinking",
      "vision": true,
      "description": "Vision model (Qwen3-VL 8B - Myia)"
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
  "system_prompt": "You are a helpful assistant with access to tools."
}
```

**Important**: The `sk_agent_config.json` file is excluded from git (contains API keys).

## MCP Tools

### `ask(prompt, model="", system_prompt="", conversation_id="", include_steps=false)`

Send a text prompt to the configured model.

**Parameters:**

- `prompt`: The user question or instruction
- `model`: Optional model ID to use (e.g., "glm-4.7-flash")
- `system_prompt`: Optional override for the system prompt
- `conversation_id`: Optional conversation ID to continue a session
- `include_steps`: If true, include intermediate tool calls in response

**Returns:**

```json
{
  "response": "Model response text",
  "conversation_id": "conv-abc123",
  "model_used": "glm-4.7-flash",
  "steps": [
    { "type": "function_call", "name": "search", "arguments": {...} },
    { "type": "function_result", "name": "search", "result": {...} }
  ]
}
```

### `analyze_image(image_source, prompt="", model="", conversation_id="", zoom_context="")`

Analyze an image using a vision-capable model with Semantic Kernel.

**Parameters:**

- `image_source`: Local file path or URL to the image
- `prompt`: Question or instruction about the image
- `model`: Optional model ID (must support vision)
- `conversation_id`: Optional conversation ID to continue a session
- `zoom_context`: Optional JSON string with zoom context for recursive calls

**Returns:**

```json
{
  "response": "Image description or analysis",
  "conversation_id": "conv-abc123",
  "model_used": "glm-4v-flash",
  "zoom_context": {"depth": 1, "stack": [...], "original_source": "..."}
}
```

### `zoom_image(image_source, region, prompt="", model="", conversation_id="", zoom_context="")`

Zoom into a specific region of an image and analyze it using Semantic Kernel.
Supports progressive zoom by passing the previous zoom_context.

**Parameters:**

- `image_source`: Local file path or URL to the image
- `region`: JSON string with crop region (see below)
- `prompt`: Question or instruction about the region
- `model`: Optional model ID (must support vision)
- `conversation_id`: Optional conversation ID to continue a session
- `zoom_context`: Optional JSON string with previous zoom context for progressive zoom

**Region format (JSON string):**

```json
// Pixels
{"x": 100, "y": 200, "width": 300, "height": 400}

// Percentages (relative to image size)
{"x": "10%", "y": "20%", "width": "50%", "height": "30%"}
```

**Zoom context format (for progressive zoom):**

```json
{
  "depth": 1,
  "stack": [{"x": 100, "y": 200, "w": 300, "h": 400}],
  "original_source": "path/to/original/image.png"
}
```

**Returns:**

```json
{
  "response": "Region description or analysis",
  "conversation_id": "conv-abc123",
  "model_used": "glm-4v-flash",
  "region_analyzed": {"x": 100, "y": 200, "width": 300, "height": 400},
  "zoom_context": {"depth": 2, "stack": [...], "original_source": "..."}
}
```

**Usage example:**

```text
// First zoom on bottom-right quadrant
result1 = zoom_image("screenshot.png", '{"x": "50%", "y": "50%", "width": "50%", "height": "50%"}', "What is here?")

// Progressive zoom - pass zoom_context from previous call
result2 = zoom_image("screenshot.png", '{"x": "25%", "y": "25%", "width": "50%", "height": "50%"}', "Read this text", "", "", result1.zoom_context)
```

### `list_models()`

List all configured models with their capabilities.

**Returns:**

```text
## Available Models
- glm-4.7-flash [ASK]: Fast text model for quick responses
- qwen3-vl-8b-thinking [VISION]: Vision model for image analysis
```

### `list_tools()`

List all loaded MCP plugins and their tools.

### `end_conversation(conversation_id)`

Clean up a conversation thread.

## Usage Patterns

### Fast text processing

```text
ask("Summarize this text: ...", model="glm-4.7-flash")
```

### Vision analysis

```text
analyze_image("path/to/image.png", "Describe the UI", model="qwen3-vl-8b-thinking")
```

### With intermediate steps (debugging)

```text
ask("Search for recent news about AI", include_steps=true)
```

### Conversation continuity

```text
# First message
response1 = ask("What is Python?")
# response1.conversation_id = "conv-abc123"

# Continue conversation
response2 = ask("Tell me more about decorators", conversation_id="conv-abc123")
```

## Self-Inclusion (Recursive Tool Chaining)

sk-agent can include itself as an MCP plugin for recursive tool chaining. This is protected by:

1. **Depth tracking**: `SK_AGENT_DEPTH` environment variable
2. **Configurable limit**: `max_recursion_depth` in config (default: 2)
3. **Automatic depth increment**: Child instances get `SK_AGENT_DEPTH + 1`

```json
{
  "mcps": [
    {
      "name": "sk_agent",
      "description": "Self-inclusion for recursive tool chaining",
      "command": "python",
      "args": ["path/to/sk_agent.py"]
    }
  ]
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SK_AGENT_CONFIG` | Path to config file | `sk_agent_config.json` |
| `SK_AGENT_DEPTH` | Current recursion depth (internal) | `0` |

## Requirements

- Python 3.11+
- `semantic-kernel[mcp]>=1.39`
- `mcp>=1.7`
- `openai>=1.109`
- `Pillow>=10.0`
- `httpx>=0.27`

## Installation

```bash
cd mcps/internal/servers/sk-agent
pip install -r requirements.txt
```

## Running

```bash
# As an MCP server (stdio)
python sk_agent.py

# Or via npx (for Claude Code / Roo Code integration)
npx -y @modelcontextprotocol/inspector python sk_agent.py
```

## Changelog

### 2026-02-14

- **Per-model kernels**: Each model gets its own kernel and agent
- **Intermediate steps**: `include_steps` parameter shows tool calls
- **Self-inclusion**: Protected recursive tool chaining with depth limit
- **Model-specific plugins**: `models[].mcps` for per-model MCP configuration
- **Default models**: Separate `default_ask_model` and `default_vision_model`
- **Model-specific prompts**: `models[].system_prompt` override

### 2026-02-12

- Initial multi-model support
- Vision support with image resizing
- MCP plugin integration (SearXNG, Playwright)
