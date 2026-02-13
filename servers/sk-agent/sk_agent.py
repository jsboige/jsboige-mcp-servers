#!/usr/bin/env python3
"""
Semantic Kernel MCP Agent -- model-agnostic MCP proxy.

Exposes any OpenAI-compatible model (vLLM, Open-WebUI, etc.) as MCP tools
for Claude Code / Roo Code.  Uses Semantic Kernel for orchestration so that
the target model can autonomously call MCP-provided tools (SearXNG, Playwright,
etc.) configured via a simple JSON file.

Architecture:
    Claude/Roo  --stdio-->  FastMCP server (this file)
                                  |
                                  v
                             Semantic Kernel
                             +-- OpenAI Chat Completion --> vLLM / Open-WebUI
                             +-- MCPStdioPlugin: SearXNG
                             +-- MCPStdioPlugin: Playwright
                             +-- MCPStdioPlugin: ... (from config)

Tools exposed to Claude/Roo:
    ask(prompt, system_prompt?)     -- text query with auto tool use
    analyze_image(image_source, prompt?) -- vision query, converts paths to base64
    list_tools()                    -- introspection: list loaded MCP plugins/tools

Configuration:
    SK_AGENT_CONFIG env var or default sk_agent_config.json next to this file.

Usage:
    python sk_agent.py                   # stdio MCP server
    claude mcp add sk-agent -- python d:/vllm/myia_vllm/mcp/sk_agent.py
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import os
import sys
from contextlib import AsyncExitStack
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP
from openai import AsyncOpenAI
from PIL import Image

from semantic_kernel.agents import ChatCompletionAgent, ChatHistoryAgentThread
from semantic_kernel.connectors.ai.open_ai import OpenAIChatCompletion
from semantic_kernel.connectors.mcp import MCPStdioPlugin

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("sk-agent")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
CONFIG_PATH = os.environ.get(
    "SK_AGENT_CONFIG",
    str(Path(__file__).parent / "sk_agent_config.json"),
)

MAX_IMAGE_BYTES = 4 * 1024 * 1024  # 4 MB -- resize above this
MAX_IMAGE_PIXELS = 774_144          # Qwen3-VL mini default


def load_config() -> dict:
    path = Path(CONFIG_PATH)
    if not path.exists():
        log.warning("Config not found at %s, using defaults", path)
        return {"models": [], "mcps": [], "system_prompt": ""}
    with open(path, encoding="utf-8") as f:
        config = json.load(f)

    # Backward compatibility: convert old "model" format to new "models" format
    if "model" in config and "models" not in config:
        old_model = config["model"]
        model_id = old_model.get("model_id", "default")
        config["models"] = [{
            "id": model_id,
            **old_model
        }]
        config["default_model"] = model_id
        del config["model"]
        log.info("Migrated old config format to new multi-model format")

    # Set default_model if not specified
    if "models" in config and "default_model" not in config:
        if config["models"]:
            config["default_model"] = config["models"][0]["id"]

    return config


# ---------------------------------------------------------------------------
# Image / attachment helpers
# ---------------------------------------------------------------------------

def _resize_image(data: bytes, media_type: str) -> tuple[bytes, str]:
    """Resize image if it exceeds MAX_IMAGE_BYTES or MAX_IMAGE_PIXELS."""
    img = Image.open(__import__("io").BytesIO(data))
    w, h = img.size
    pixels = w * h

    needs_resize = len(data) > MAX_IMAGE_BYTES or pixels > MAX_IMAGE_PIXELS
    if not needs_resize:
        return data, media_type

    scale = min(1.0, (MAX_IMAGE_PIXELS / pixels) ** 0.5)
    new_w, new_h = int(w * scale), int(h * scale)
    img = img.resize((new_w, new_h), Image.LANCZOS)

    buf = __import__("io").BytesIO()
    fmt = "JPEG" if media_type in ("image/jpeg", "image/jpg") else "PNG"
    img.save(buf, format=fmt)
    out_type = f"image/{fmt.lower()}"
    log.info("Resized image %dx%d -> %dx%d (%s)", w, h, new_w, new_h, out_type)
    return buf.getvalue(), out_type


async def resolve_attachment(source: str) -> tuple[str, str]:
    """Convert a local file path or URL to (base64_data, media_type).

    Supports: PNG, JPG/JPEG, GIF, WebP, BMP.
    Large images are resized to fit MAX_IMAGE_PIXELS.
    """
    source = source.strip()

    if source.startswith(("http://", "https://")):
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(source, follow_redirects=True)
            resp.raise_for_status()
            data = resp.content
            media_type = resp.headers.get("content-type", "").split(";")[0].strip()
            if not media_type.startswith("image/"):
                media_type = mimetypes.guess_type(source)[0] or "image/png"
    else:
        # Local file path -- handle both / and \ separators
        p = Path(source)
        if not p.exists():
            raise FileNotFoundError(f"Image not found: {source}")
        data = p.read_bytes()
        media_type = mimetypes.guess_type(str(p))[0] or "image/png"

    data, media_type = _resize_image(data, media_type)
    b64 = base64.b64encode(data).decode("ascii")
    return b64, media_type


# ---------------------------------------------------------------------------
# Semantic Kernel agent factory
# ---------------------------------------------------------------------------

class SKAgent:
    """Manages SK kernel, MCP plugins, and the ChatCompletionAgent."""

    def __init__(self, config: dict):
        self.config = config
        self._exit_stack = AsyncExitStack()
        self._agent: ChatCompletionAgent | None = None
        self._thread: ChatHistoryAgentThread | None = None
        self._plugins: list = []
        self._models: list[dict] = config.get("models", [])
        self._default_model_id: str = config.get("default_model", "")
        self._current_model_cfg: dict = {}

    async def start(self):
        """Initialize the SK agent: connect to model and MCP plugins."""
        # Find the default model configuration
        model_cfg = self._get_model_config(self._default_model_id)
        self._current_model_cfg = model_cfg

        # Build OpenAI client pointing to configured endpoint
        api_key = os.environ.get(
            model_cfg.get("api_key_env", "VLLM_API_KEY_MINI"),
            model_cfg.get("api_key", "no-key"),
        )
        base_url = model_cfg.get("base_url", "http://localhost:5001/v1")
        model_id = model_cfg.get("model_id", "default")

        async_client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        service = OpenAIChatCompletion(
            ai_model_id=model_id,
            async_client=async_client,
        )
        log.info("Model: %s at %s (default: %s)", model_id, base_url, self._default_model_id)

        # Connect MCP plugins
        for mcp_cfg in self.config.get("mcps", []):
            try:
                env = {**os.environ, **(mcp_cfg.get("env") or {})}
                plugin = MCPStdioPlugin(
                    name=mcp_cfg["name"],
                    description=mcp_cfg.get("description"),
                    command=mcp_cfg["command"],
                    args=mcp_cfg.get("args"),
                    env=env,
                )
                connected = await self._exit_stack.enter_async_context(plugin)
                self._plugins.append(connected)
                log.info("MCP plugin loaded: %s (%s %s)",
                         mcp_cfg["name"], mcp_cfg["command"],
                         " ".join(mcp_cfg.get("args", [])))
            except Exception:
                log.exception("Failed to load MCP plugin: %s", mcp_cfg.get("name"))

        # Create agent
        system_prompt = self.config.get("system_prompt", "")
        self._agent = ChatCompletionAgent(
            service=service,
            name="sk-agent",
            instructions=system_prompt,
            plugins=self._plugins,
        )
        log.info("SK Agent ready with %d MCP plugins", len(self._plugins))

    async def ask(self, prompt: str, system_prompt: str = "") -> str:
        """Send a text prompt to the model with auto tool calling."""
        if not self._agent:
            return "Agent not initialized"

        # Optionally override system prompt per request
        if system_prompt:
            self._agent.instructions = system_prompt

        response = await self._agent.get_response(messages=prompt)
        return str(response)

    async def ask_with_image(
        self, image_source: str, prompt: str = "Describe this image in detail"
    ) -> str:
        """Send an image + prompt to the model (vision).

        image_source can be a local file path or URL.
        The image is converted to base64 and sent as an image_url content part.
        """
        if not self._agent:
            return "Agent not initialized"

        model_cfg = self.config.get("model", {})
        if not model_cfg.get("vision", False):
            return "Vision is not enabled for the configured model."

        b64_data, media_type = await resolve_attachment(image_source)
        data_url = f"data:{media_type};base64,{b64_data}"

        # Build multimodal message directly via the underlying service
        # ChatCompletionAgent doesn't natively support image content parts,
        # so we use the OpenAI client directly for vision requests.
        api_key = os.environ.get(
            model_cfg.get("api_key_env", "VLLM_API_KEY_MINI"),
            model_cfg.get("api_key", "no-key"),
        )
        base_url = model_cfg.get("base_url", "http://localhost:5001/v1")
        model_id = model_cfg.get("model_id", "default")

        async with AsyncOpenAI(api_key=api_key, base_url=base_url) as client:
            resp = await client.chat.completions.create(
                model=model_id,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url",
                         "image_url": {"url": data_url}},
                    ],
                }],
                max_tokens=1024,
            )
        return resp.choices[0].message.content or ""

    def list_loaded_tools(self) -> str:
        """Return a description of all loaded MCP plugins and their tools."""
        if not self._agent or not self._agent.kernel:
            return "No MCP plugins loaded."

        lines = []
        for plugin_name, plugin in self._agent.kernel.plugins.items():
            lines.append(f"## {plugin_name}")
            if hasattr(plugin, "description") and plugin.description:
                lines.append(f"  {plugin.description}")
            for fn_name, fn in plugin.functions.items():
                desc = fn.description or ""
                lines.append(f"  - {fn_name}: {desc}")
        return "\n".join(lines) if lines else "No tools found."

    async def stop(self):
        """Clean up MCP plugin connections."""
        await self._exit_stack.aclose()
        self._plugins.clear()
        self._agent = None
        log.info("SK Agent stopped")

    def _get_model_config(self, model_id: str | None = None) -> dict:
        """Get configuration for a specific model, or the default."""
        if model_id is None:
            model_id = self._default_model_id

        # Find the model by id
        for model in self._models:
            if model.get("id") == model_id:
                return model

        # Fallback to first model if default not found
        if self._models and model_id == self._default_model_id:
            log.warning("Default model '%s' not found, using first model", model_id)
            return self._models[0]

        # Backward compatibility: if no models array, return empty dict
        return {}

    def list_models(self) -> list[dict]:
        """Return a list of all configured models."""
        return [
            {
                "id": m.get("id", "unknown"),
                "model_id": m.get("model_id", ""),
                "vision": m.get("vision", False),
                "description": m.get("description", ""),
                "is_default": m.get("id") == self._default_model_id
            }
            for m in self._models
        ]


# ---------------------------------------------------------------------------
# FastMCP server -- tools exposed to Claude/Roo
# ---------------------------------------------------------------------------

mcp_server = FastMCP(
    "sk-agent",
    instructions=(
        "A proxy to a local LLM with optional tools (web search, browser, etc.). "
        "Use 'ask' for text queries, 'analyze_image' for vision tasks."
    ),
)

_sk_agent: SKAgent | None = None


async def _get_agent() -> SKAgent:
    global _sk_agent
    if _sk_agent is None:
        config = load_config()
        _sk_agent = SKAgent(config)
        await _sk_agent.start()
    return _sk_agent


@mcp_server.tool()
async def ask(prompt: str, system_prompt: str = "") -> str:
    """Send a text prompt to the local LLM.

    The model may autonomously use its configured tools (web search, browser,
    etc.) to answer the query. Returns the model's final response.

    Args:
        prompt: The user question or instruction.
        system_prompt: Optional override for the system prompt.
    """
    agent = await _get_agent()
    return await agent.ask(prompt, system_prompt)


@mcp_server.tool()
async def analyze_image(image_source: str, prompt: str = "Describe this image in detail") -> str:
    """Analyze an image using the local vision model.

    Accepts a local file path (e.g. D:/screenshots/img.png) or a URL.
    The image is automatically converted to base64 for the model API.

    Args:
        image_source: Path to a local image file or an HTTP(S) URL.
        prompt: Question or instruction about the image.
    """
    agent = await _get_agent()
    return await agent.ask_with_image(image_source, prompt)


@mcp_server.tool()
async def list_tools() -> str:
    """List all MCP plugins and tools available to the local LLM.

    Useful for debugging and understanding what tools the model can use.
    """
    agent = await _get_agent()
    return agent.list_loaded_tools()


@mcp_server.tool()
async def list_models() -> str:
    """List all configured models available in the sk-agent.

    Returns information about each model including:
    - id: Unique identifier for the model
    - model_id: The actual model name used in API calls
    - vision: Whether the model supports vision/image input
    - description: Human-readable description
    - is_default: Whether this is the default model

    Useful for selecting the right model for your task.
    """
    config = load_config()
    models = config.get("models", [])
    default_model = config.get("default_model", "")

    if not models:
        return "No models configured."

    lines = ["## Available Models"]
    for m in models:
        model_id = m.get("id", "unknown")
        is_default = " (DEFAULT)" if model_id == default_model else ""
        desc = m.get("description", "")
        vision_badge = " 👁️" if m.get("vision", False) else ""
        lines.append(f"- {model_id}{is_default}{vision_badge}: {desc}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    log.info("Starting sk-agent MCP server (config: %s)", CONFIG_PATH)
    mcp_server.run(transport="stdio")


if __name__ == "__main__":
    main()
