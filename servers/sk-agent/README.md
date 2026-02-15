# sk-agent - Semantic Kernel MCP Server

Multi-model LLM proxy server for Claude Code and Roo Code.

## Features

- **Multi-model support**: Configure multiple models with per-model kernels
- **Tool calling**: Models can use MCP plugins (SearXNG, Playwright, etc.)
- **Vision support**: Analyze images with vision-capable models
- **Document analysis**: PDF, PPTX, DOCX, XLSX with visual/text/hybrid modes
- **Video analysis**: Extract frames and analyze video content
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

### z.ai Cloud API (enabled by default)

| Model ID   | Endpoint                              | Vision | Default For | Context | Description        |
|------------|---------------------------------------|--------|-------------|---------|--------------------|
| `glm-4.6v` | `https://api.z.ai/api/coding/paas/v4` | Yes    | Vision      | 128K    | GLM-4.6V (vision)  |
| `glm-5`    | `https://api.z.ai/api/coding/paas/v4` | No     | Ask         | 200K    | GLM-5 (reasoning)  |

### Myia Self-Hosted (disabled by default in template, enable if available)

| Model ID        | Endpoint                                              | Vision | Context | Description                    |
|-----------------|-------------------------------------------------------|--------|---------|--------------------------------|
| `zwz-8b`        | `https://api.mini.text-generation-webui.myia.io/v1`   | No     | 131K    | ZwZ 8B AWQ (Qwen-based)        |
| `glm-4.7-flash` | `https://api.medium.text-generation-webui.myia.io/v1` | No     | 131K    | GLM-4.7-Flash AWQ              |

### Model Enable/Disable

Each model has an `enabled` field in the configuration. Set to `true` to activate, `false` to deactivate.
Only enabled models are loaded at startup.

## Configuration

Copy `sk_agent_config.template.json` to `sk_agent_config.json` and add your API keys.

### Configuration Fields

| Field | Type | Description |
|-------|------|-------------|
| `default_ask_model` | string | Model ID for `ask()` tool (default: first enabled model) |
| `default_vision_model` | string | Model ID for `analyze_image()` / `analyze_document(mode=visual)` |
| `max_recursion_depth` | int | Max self-inclusion depth (default: 2) |
| `models` | array | List of model configurations |
| `models[].id` | string | Unique identifier for the model |
| `models[].enabled` | bool | Whether model is active (default: true) |
| `models[].base_url` | string | OpenAI-compatible API endpoint |
| `models[].api_key` | string | API key (or use `api_key_env` for env var) |
| `models[].api_key_env` | string | Environment variable name containing the API key |
| `models[].model_id` | string | Actual model name for API calls |
| `models[].vision` | bool | Whether model supports image input |
| `models[].context_window` | int | Token context limit (auto-inferred if omitted) |
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
      "description": "Vision model for image/document analysis (GLM-4.6V via z.ai)",
      "context_window": 128000
    },
    {
      "id": "glm-5",
      "enabled": true,
      "base_url": "https://api.z.ai/api/coding/paas/v4",
      "api_key_env": "ZAI_API_KEY",
      "api_key": "YOUR_ZAI_API_KEY_HERE",
      "model_id": "glm-5",
      "vision": false,
      "description": "Text model for complex reasoning (GLM-5 via z.ai)",
      "context_window": 200000
    },
    {
      "id": "zwz-8b",
      "enabled": false,
      "base_url": "https://api.mini.text-generation-webui.myia.io/v1",
      "api_key": "YOUR_MINI_API_KEY_HERE",
      "model_id": "zwz-8b",
      "vision": false,
      "description": "Fast local text model (ZwZ 8B AWQ - Myia self-hosted)",
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
  "system_prompt": "You are a helpful assistant with access to tools."
}
```

**Important**: The `sk_agent_config.json` file is excluded from git (contains API keys).

## MCP Tools

### `ask(prompt, model?, system_prompt?, conversation_id?, include_steps?)`

Send a text prompt to the configured model.

**Parameters:**

- `prompt`: The user question or instruction
- `model`: Optional model ID to use (e.g., "glm-5", "zwz-8b")
- `system_prompt`: Optional override for the system prompt
- `conversation_id`: Optional conversation ID to continue a session
- `include_steps`: If true, include intermediate tool calls in response

**Returns:**

```json
{
  "response": "Model response text",
  "conversation_id": "conv-abc123",
  "model_used": "glm-5",
  "steps": [...]
}
```

### `analyze_image(image_source, prompt?, model?, conversation_id?, zoom_context?)`

Analyze an image using a vision-capable model.

**Parameters:**

- `image_source`: Local file path or URL to the image
- `prompt`: Question or instruction about the image
- `model`: Optional model ID (must support vision)
- `conversation_id`: Optional conversation ID
- `zoom_context`: Optional JSON string with zoom context for recursive calls

### `zoom_image(image_source, region, prompt?, model?, conversation_id?, zoom_context?)`

Zoom into a specific region of an image and analyze it.

**Region format (JSON string):**

```json
{"x": 100, "y": 200, "width": 300, "height": 400}
{"x": "10%", "y": "20%", "width": "50%", "height": "30%"}
```

### `analyze_video(video_source, prompt?, model?, conversation_id?, num_frames?)`

Analyze a video by extracting frames and using the vision model.

**Parameters:**

- `video_source`: Local file path to the video (MP4, AVI, MOV, etc.)
- `prompt`: Question or instruction about the video content
- `num_frames`: Number of frames to extract (default: 8, max: 20)

**Requirements:** `ffmpeg` and `ffprobe` must be in PATH.

### `analyze_document(document_source, prompt?, model?, max_pages?, mode?, page_range?, auto_limit_tokens?)`

Analyze a document with unified pipeline supporting multiple formats and modes.

**Supported formats:**

| Format     | Visual mode         | Text mode           | Hybrid mode        |
|------------|---------------------|---------------------|--------------------|
| PDF        | PyMuPDF (DPI 180)   | PyMuPDF text extract| Both               |
| PPT/PPTX   | LibreOffice -> PDF  | LibreOffice -> text | Both               |
| DOC/DOCX   | LibreOffice -> PDF  | python-docx / LO    | Both               |
| XLS/XLSX   | LibreOffice -> PDF  | pandas CSV          | Both               |

**Parameters:**

- `document_source`: Path to document file
- `prompt`: Question or instruction about the document
- `model`: Optional model ID (auto-selected based on mode)
- `max_pages`: Maximum pages to analyze (default: 10, max: 50)
- `mode`: `"visual"` (images), `"text"` (extracted text), `"hybrid"` (both)
- `page_range`: Optional JSON `{"start": 1, "end": 10}` (1-indexed, inclusive)
- `auto_limit_tokens`: Auto-limit pages based on model context window (default: true)

**Returns:**

```json
{
  "response": "Document analysis",
  "conversation_id": "conv-abc123",
  "model_used": "glm-4.6v",
  "pages_analyzed": 5,
  "mode": "visual"
}
```

**Usage examples:**

```text
analyze_document("report.pdf", "Summarize key findings", max_pages=15)
analyze_document("slides.pptx", "What topics are covered?", mode="visual")
analyze_document("data.xlsx", "Analyze trends in this data", mode="text")
analyze_document("contract.docx", "Extract key terms", mode="hybrid", page_range='{"start":1,"end":5}')
```

### `install_libreoffice(force?, custom_path?)`

Check/install LibreOffice (required for PPT/DOC/XLS visual conversion).

**Methods (order of preference):**
1. Custom path (portable) via `custom_path` parameter
2. winget (Windows 11)
3. Chocolatey
4. Manual download instructions

### `list_models()`

List all configured models with their capabilities, context windows, and default status.

### `list_tools()`

List all loaded MCP plugins and their tools.

### `end_conversation(conversation_id)`

Clean up a conversation thread.

## Self-Inclusion (Recursive Tool Chaining)

sk-agent can include itself as an MCP plugin. Protected by:

1. **Depth tracking**: `SK_AGENT_DEPTH` environment variable
2. **Configurable limit**: `max_recursion_depth` in config (default: 2)
3. **Automatic depth increment**: Child instances get `SK_AGENT_DEPTH + 1`

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SK_AGENT_CONFIG` | Path to config file | `sk_agent_config.json` |
| `SK_AGENT_DEPTH` | Current recursion depth (internal) | `0` |
| `ZAI_API_KEY` | z.ai API key (if using `api_key_env`) | - |

## Requirements

- Python 3.11+
- `semantic-kernel[mcp]>=1.39`
- `mcp>=1.7`
- `openai>=1.109`
- `Pillow>=10.0`
- `httpx>=0.27`

**Optional (for document analysis):**
- `PyMuPDF` - PDF to images/text
- `pdf2image` - PDF to images (alternative)
- `python-docx` - DOCX text extraction (alternative to LibreOffice)
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

## Changelog

### 2026-02-16

- **Model updates**: Removed deprecated `glm-4-plus`, updated self-hosted model `qwen3-vl-8b-thinking` -> `zwz-8b`
- **Self-hosted re-enabled**: Both mini (zwz-8b) and medium (glm-4.7-flash) endpoints back online
- **Config improvements**: Added explicit `context_window` to all model configs
- **Template updated**: Dual cloud+self-hosted config with placeholders for API keys

### 2026-02-15

- **Document analysis**: Unified pipeline for PDF, PPT/PPTX, DOC/DOCX, XLS/XLSX
- **Three analysis modes**: visual (images), text (extracted), hybrid (both)
- **Token auto-limiting**: Pages auto-limited based on model context window
- **Video analysis**: New `analyze_video` tool with keyframe extraction
- **Zoom context**: Progressive zoom tracking with depth and region stack

### 2026-02-14

- **Per-model kernels**: Each model gets its own kernel and agent
- **Intermediate steps**: `include_steps` parameter shows tool calls
- **Self-inclusion**: Protected recursive tool chaining with depth limit
- **Model-specific plugins**: `models[].mcps` for per-model MCP configuration

### 2026-02-12

- Initial multi-model support
- Vision support with image resizing
- MCP plugin integration (SearXNG, Playwright)
