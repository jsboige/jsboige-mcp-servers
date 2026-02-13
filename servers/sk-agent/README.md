# sk-agent - Semantic Kernel MCP Server

Multi-model LLM proxy server for Claude Code and Roo Code.

## Features

- **Multi-model support**: Configure multiple models and switch between them
- **Tool calling**: Models can use MCP plugins (SearXNG, Playwright, etc.)
- **Vision support**: Analyze images with vision-capable models
- **Dynamic model selection**: Choose the right model for each task

## Configured Models (Myia Infrastructure)

| Model ID | Endpoint | Vision | Description |
|----------|----------|--------|-------------|
| `qwen3-vl-8b-thinking` | `https://api.mini.text-generation-webui.myia.io/v1` | ✅ | Default, vision model |
| `glm-4.7-flash` | `https://api.medium.text-generation-webui.myia.io/v1` | ❌ | Fast text model |

## Configuration

Copy `sk_agent_config.template.json` to `sk_agent_config.json` and add your API keys:

```json
{
  "default_model": "qwen3-vl-8b-thinking",
  "models": [
    {
      "id": "qwen3-vl-8b-thinking",
      "base_url": "https://api.mini.text-generation-webui.myia.io/v1",
      "api_key": "YOUR_MINI_API_KEY_HERE",
      "model_id": "qwen3-vl-8b-thinking",
      "vision": true,
      "description": "Vision model for image analysis (Qwen3-VL 8B Thinking)"
    },
    {
      "id": "glm-4.7-flash",
      "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
      "api_key": "YOUR_MEDIUM_API_KEY_HERE",
      "model_id": "glm-4.7-flash",
      "vision": false,
      "description": "Fast text model for quick responses (GLM-4.7-Flash)"
    }
  ],
  "mcps": [
    {
      "name": "searxng",
      "description": "Web search via SearXNG",
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": {
        "SEARXNG_URL": "https://search.myia.io"
      }
    },
    {
      "name": "playwright",
      "description": "Browser automation",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  ],
  "system_prompt": "You are a helpful assistant with access to web search and browser tools."
}
```

**Important**: The `sk_agent_config.json` file is excluded from git (contains API keys).

## MCP Tools

### `ask(prompt, system_prompt="", model="")`
Send a text prompt to the configured model.

- `prompt`: The user question or instruction
- `system_prompt`: Optional override for the system prompt
- `model`: Optional model ID to use (e.g., "glm-4.7-flash")

**Example with specific model:**
```
ask("What is the capital of France?", model="glm-4.7-flash")
```

### `analyze_image(image_source, prompt="Describe this image", model="")`
Analyze an image using a vision-capable model.

- `image_source`: Local file path or URL to the image
- `prompt`: Question or instruction about the image
- `model`: Optional model ID (must support vision)

**Example:**
```
analyze_image("D:/screenshots/screenshot.png", "What is shown in this image?", model="qwen3-vl-8b-thinking")
```

### `switch_model(model)`
Switch the default model for all subsequent requests.

- `model`: The model ID to switch to

**Example:**
```
switch_model("glm-4.7-flash")  # Use fast model for text-only tasks
```

### `list_models()`
List all configured models with their capabilities.

**Returns:**
```
## Available Models
- qwen3-vl-8b-thinking (DEFAULT) 👁️: Vision model for image analysis
- glm-4.7-flash: Fast text model for quick responses
```

### `list_tools()`
List all loaded MCP plugins and their tools.

## Usage Patterns

### Fast text processing
```python
# Switch to fast model for quick queries
switch_model("glm-4.7-flash")
ask("Summarize this text: ...")
```

### Vision analysis
```python
# Switch to vision model for image tasks
switch_model("qwen3-vl-8b-thinking")
analyze_image("path/to/image.png", "Describe the UI")
```

### One-shot model selection
```python
# Use a specific model without changing default
ask("Explain quantum computing", model="glm-4.7-flash")
```

## Environment Variables

Set these in your shell or `.env` file:

- `VLLM_API_KEY_MINI`: API key for vLLM models (default: empty)
- `ANTHROPIC_AUTH_TOKEN`: API key for z.ai GLM models
- `SK_AGENT_CONFIG`: Path to config file (default: `sk_agent_config.json`)

## Requirements

- Python 3.11+
- `semantic-kernel[mcp]>=1.39`
- `mcp>=1.7`
- `openai>=1.109`
- `Pillow>=10.0`

## Running

```bash
# As an MCP server (stdio)
python sk_agent.py

# Or via npx (for Claude Code / Roo Code integration)
npx -y @modelcontextprotocol/inspector python sk_agent.py
```
