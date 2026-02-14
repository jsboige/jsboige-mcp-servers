#!/usr/bin/env python3
"""
Semantic Kernel MCP Agent -- model-agnostic MCP proxy.

Exposes any OpenAI-compatible model (vLLM, Open-WebUI, etc.) as MCP tools
for Claude Code / Roo Code.  Uses Semantic Kernel for orchestration so that
the target model can autonomously call MCP-provided tools (SearXNG, Playwright,
etc.) configured via a simple JSON file.

Models configured (Myia infrastructure):
    - qwen3-vl-8b-thinking (vision): https://api.mini.text-generation-webui.myia.io/v1
    - glm-4.7-flash (text): https://api.medium.text-generation-webui.myia.io/v1

Architecture:
    Claude/Roo  --stdio-->  FastMCP server (this file)
                                  |
                                  v
                             Semantic Kernel
                             +-- OpenAI Chat Completion (multiple services)
                             +-- MCPStdioPlugin: SearXNG, Playwright, etc.

Tools exposed to Claude/Roo:
    ask(prompt, model?, conversation_id?)     -- text query with auto tool use
    analyze_image(image, prompt?, model?, conversation_id?)  -- vision query
    list_tools()                              -- introspection: loaded tools
    list_models()                             -- list available models
    end_conversation(conversation_id)         -- clean up a conversation

Configuration:
    SK_AGENT_CONFIG env var or default sk_agent_config.json next to this file.
    Template: sk_agent_config.template.json (without API keys)
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import os
import sys
import uuid
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP
from openai import AsyncOpenAI
from PIL import Image

from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent, ChatHistoryAgentThread
from semantic_kernel.connectors.ai.open_ai import OpenAIChatCompletion
from semantic_kernel.connectors.mcp import MCPStdioPlugin
from semantic_kernel.functions.kernel_arguments import KernelArguments

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

# Recursion protection: SK_AGENT_DEPTH tracks nesting level
SK_AGENT_DEPTH = int(os.environ.get("SK_AGENT_DEPTH", "0"))
DEFAULT_MAX_RECURSION_DEPTH = 2

MAX_IMAGE_BYTES = 4 * 1024 * 1024  # 4 MB
MAX_IMAGE_PIXELS = 774_144  # Qwen3-VL mini default


def load_config() -> dict:
    """Load configuration from JSON file."""
    path = Path(CONFIG_PATH)
    if not path.exists():
        log.warning("Config not found at %s, using defaults", path)
        return {"models": [], "mcps": [], "system_prompt": ""}
    with open(path, encoding="utf-8") as f:
        config = json.load(f)

    # Backward compatibility: convert old formats
    if "model" in config and "models" not in config:
        old_model = config["model"]
        model_id = old_model.get("model_id", "default")
        config["models"] = [{"id": model_id, **old_model}]
        config["default_ask_model"] = model_id
        del config["model"]

    # Set default models if not specified
    if config.get("models"):
        first_model = config["models"][0].get("id", "")
        if "default_ask_model" not in config:
            config["default_ask_model"] = config.get("default_model", first_model)
        if "default_vision_model" not in config:
            # Find first vision-capable model
            for m in config["models"]:
                if m.get("vision", False):
                    config["default_vision_model"] = m.get("id", first_model)
                    break
            else:
                config["default_vision_model"] = first_model

    # Remove old default_model if present (use default_ask_model instead)
    if "default_model" in config and "default_ask_model" in config:
        del config["default_model"]

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
    """Convert a local file path or URL to (base64_data, media_type)."""
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
        p = Path(source)
        if not p.exists():
            raise FileNotFoundError(f"Image not found: {source}")
        data = p.read_bytes()
        media_type = mimetypes.guess_type(str(p))[0] or "image/png"

    data, media_type = _resize_image(data, media_type)
    b64 = base64.b64encode(data).decode("ascii")
    return b64, media_type


# ---------------------------------------------------------------------------
# Semantic Kernel Agent Manager
# ---------------------------------------------------------------------------

class SKAgentManager:
    """Manages SK kernel, MCP plugins, and per-conversation threads."""

    def __init__(self, config: dict):
        self.config = config
        self._exit_stack = AsyncExitStack()
        self._kernel: Kernel | None = None
        self._plugins: list = []
        self._threads: dict[str, ChatHistoryAgentThread] = {}
        self._services: dict[str, OpenAIChatCompletion] = {}
        self._openai_clients: dict[str, AsyncOpenAI] = {}

    async def start(self):
        """Initialize the kernel, register all model services, load plugins."""
        self._kernel = Kernel()

        # Register all model services
        for model_cfg in self.config.get("models", []):
            model_id = model_cfg.get("id", "default")
            api_key = os.environ.get(
                model_cfg.get("api_key_env", ""),
                model_cfg.get("api_key", "no-key"),
            )
            base_url = model_cfg.get("base_url", "http://localhost:5001/v1")
            target_model = model_cfg.get("model_id", "default")

            client = AsyncOpenAI(api_key=api_key, base_url=base_url)
            self._openai_clients[model_id] = client

            service = OpenAIChatCompletion(
                ai_model_id=target_model,
                async_client=client,
                service_id=model_id,  # Use model_id as service_id
            )
            self._kernel.add_service(service)
            self._services[model_id] = service
            log.info("Registered model service: %s -> %s at %s", model_id, target_model, base_url)

        # Load MCP plugins (if not at max recursion depth)
        max_depth = self.config.get("max_recursion_depth", DEFAULT_MAX_RECURSION_DEPTH)
        if SK_AGENT_DEPTH >= max_depth:
            log.info("Skipping MCP plugins (depth=%d >= max_depth=%d)", SK_AGENT_DEPTH, max_depth)
        else:
            await self._load_plugins()

        log.info("SK Agent Manager ready with %d services, %d plugins",
                 len(self._services), len(self._plugins))

    async def _load_plugins(self):
        """Load all MCP plugins from config."""
        for mcp_cfg in self.config.get("mcps", []):
            try:
                env = {**os.environ, **(mcp_cfg.get("env") or {})}

                # Detect self-inclusion
                mcp_args = " ".join(mcp_cfg.get("args", []))
                is_self = "sk_agent.py" in mcp_args or "sk_agent" in mcp_cfg.get("name", "").lower()

                if is_self:
                    env["SK_AGENT_DEPTH"] = str(SK_AGENT_DEPTH + 1)
                    log.info("Self-inclusion: spawning child sk-agent with depth=%d", SK_AGENT_DEPTH + 1)

                plugin = MCPStdioPlugin(
                    name=mcp_cfg["name"],
                    description=mcp_cfg.get("description"),
                    command=mcp_cfg.get("command", ""),
                    args=mcp_cfg.get("args"),
                    env=env,
                )
                connected = await self._exit_stack.enter_async_context(plugin)
                self._plugins.append(connected)
                log.info("MCP plugin loaded: %s", mcp_cfg["name"])
            except Exception:
                log.exception("Failed to load MCP plugin: %s", mcp_cfg.get("name"))

    def _get_model_config(self, model_id: str) -> dict | None:
        """Get configuration for a specific model."""
        for m in self.config.get("models", []):
            if m.get("id") == model_id:
                return m
        return None

    def _get_or_create_thread(self, conversation_id: str | None) -> tuple[str, ChatHistoryAgentThread]:
        """Get existing thread or create new one. Returns (conversation_id, thread)."""
        if conversation_id and conversation_id in self._threads:
            return conversation_id, self._threads[conversation_id]

        new_id = conversation_id or f"conv-{uuid.uuid4().hex[:8]}"
        thread = ChatHistoryAgentThread()
        self._threads[new_id] = thread
        return new_id, thread

    async def ask(
        self,
        prompt: str,
        model_id: str | None = None,
        conversation_id: str | None = None,
        system_prompt: str | None = None,
    ) -> dict[str, Any]:
        """Send a text prompt with auto tool calling.

        Returns dict with: response, conversation_id, model_used
        """
        if not self._kernel:
            return {"error": "Kernel not initialized"}

        # Determine which model to use
        target_model = model_id or self.config.get("default_ask_model", "")
        if target_model not in self._services:
            # Fallback to first available
            target_model = next(iter(self._services), "")
            if not target_model:
                return {"error": "No models available"}
            log.warning("Requested model not found, using: %s", target_model)

        # Get or create thread
        conv_id, thread = self._get_or_create_thread(conversation_id)

        # Create agent with specific service
        effective_system_prompt = system_prompt or self.config.get("system_prompt", "")
        agent = ChatCompletionAgent(
            kernel=self._kernel,
            name="sk-agent",
            instructions=effective_system_prompt,
            plugins=self._plugins,
        )

        # Invoke with service selection via kernel arguments
        arguments = KernelArguments(service_id=target_model)

        response = await agent.get_response(messages=prompt, thread=thread, arguments=arguments)

        return {
            "response": str(response),
            "conversation_id": conv_id,
            "model_used": target_model,
        }

    async def ask_with_image(
        self,
        image_source: str,
        prompt: str = "Describe this image in detail",
        model_id: str | None = None,
        conversation_id: str | None = None,
    ) -> dict[str, Any]:
        """Send an image + prompt for vision analysis.

        Returns dict with: response, conversation_id, model_used
        """
        if not self._kernel:
            return {"error": "Kernel not initialized"}

        # Determine which model to use (prefer vision-capable)
        target_model = model_id or self.config.get("default_vision_model", "")
        model_cfg = self._get_model_config(target_model)

        if not model_cfg or not model_cfg.get("vision", False):
            # Try to find a vision model
            for m in self.config.get("models", []):
                if m.get("vision", False):
                    target_model = m.get("id", "")
                    model_cfg = m
                    log.info("Auto-selected vision model: %s", target_model)
                    break
            else:
                return {"error": "No vision-capable model available"}

        # Load and encode image
        try:
            b64_data, media_type = await resolve_attachment(image_source)
        except FileNotFoundError as e:
            return {"error": str(e)}

        data_url = f"data:{media_type};base64,{b64_data}"

        # Get OpenAI client for this model
        client = self._openai_clients.get(target_model)
        if not client:
            return {"error": f"No client for model: {target_model}"}

        # For vision, we use direct OpenAI API (SK doesn't handle image content well)
        # But we could extend this to use SK in the future
        target_model_name = model_cfg.get("model_id", target_model)
        resp = await client.chat.completions.create(
            model=target_model_name,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }],
            max_tokens=1024,
        )

        return {
            "response": resp.choices[0].message.content or "",
            "conversation_id": None,  # Vision requests don't continue threads for now
            "model_used": target_model,
        }

    def list_models(self) -> list[dict]:
        """Return list of all configured models."""
        default_ask = self.config.get("default_ask_model", "")
        default_vision = self.config.get("default_vision_model", "")

        return [
            {
                "id": m.get("id", "unknown"),
                "model_id": m.get("model_id", ""),
                "vision": m.get("vision", False),
                "description": m.get("description", ""),
                "is_default_ask": m.get("id") == default_ask,
                "is_default_vision": m.get("id") == default_vision,
            }
            for m in self.config.get("models", [])
        ]

    def list_loaded_tools(self) -> str:
        """Return description of all loaded MCP plugins and their tools."""
        if not self._kernel:
            return "Kernel not initialized."

        lines = []
        for plugin_name, plugin in self._kernel.plugins.items():
            lines.append(f"## {plugin_name}")
            if hasattr(plugin, "description") and plugin.description:
                lines.append(f"  {plugin.description}")
            for fn_name, fn in plugin.functions.items():
                desc = fn.description or ""
                # Truncate long descriptions
                if len(desc) > 100:
                    desc = desc[:97] + "..."
                lines.append(f"  - {fn_name}: {desc}")
        return "\n".join(lines) if lines else "No tools loaded."

    def end_conversation(self, conversation_id: str) -> bool:
        """End and clean up a conversation thread."""
        if conversation_id in self._threads:
            del self._threads[conversation_id]
            log.info("Ended conversation: %s", conversation_id)
            return True
        return False

    async def stop(self):
        """Clean up all resources."""
        await self._exit_stack.aclose()
        self._plugins.clear()
        self._threads.clear()
        self._kernel = None
        log.info("SK Agent Manager stopped")


# ---------------------------------------------------------------------------
# FastMCP server -- tools exposed to Claude/Roo
# ---------------------------------------------------------------------------

mcp_server = FastMCP(
    "sk-agent",
    instructions=(
        "A proxy to a local LLM with optional tools (web search, browser, etc.). "
        "Use 'ask' for text queries, 'analyze_image' for vision tasks. "
        "Pass conversation_id to continue a previous conversation."
    ),
)

_agent_manager: SKAgentManager | None = None


async def _get_manager() -> SKAgentManager:
    global _agent_manager
    if _agent_manager is None:
        config = load_config()
        _agent_manager = SKAgentManager(config)
        await _agent_manager.start()
    return _agent_manager


@mcp_server.tool()
async def ask(
    prompt: str,
    model: str = "",
    conversation_id: str = "",
    system_prompt: str = "",
) -> str:
    """Send a text prompt to the local LLM.

    The model may autonomously use its configured tools (web search, browser,
    etc.) to answer the query. Returns the model's response.

    Args:
        prompt: The user question or instruction.
        model: Optional model ID (e.g., "glm-4.7-flash"). Uses default if not specified.
        conversation_id: Optional conversation ID to continue a previous conversation.
        system_prompt: Optional override for the system prompt.

    Returns:
        JSON string with: response, conversation_id, model_used
    """
    manager = await _get_manager()
    result = await manager.ask(
        prompt=prompt,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
        system_prompt=system_prompt if system_prompt else None,
    )
    return json.dumps(result, ensure_ascii=False)


@mcp_server.tool()
async def analyze_image(
    image_source: str,
    prompt: str = "Describe this image in detail",
    model: str = "",
    conversation_id: str = "",
) -> str:
    """Analyze an image using the local vision model.

    Accepts a local file path (e.g. D:/screenshots/img.png) or a URL.
    The image is automatically converted to base64 for the model API.

    Args:
        image_source: Path to a local image file or an HTTP(S) URL.
        prompt: Question or instruction about the image.
        model: Optional model ID (must support vision). Uses default vision model if not specified.
        conversation_id: Optional conversation ID (currently not used for vision).

    Returns:
        JSON string with: response, conversation_id, model_used
    """
    manager = await _get_manager()
    result = await manager.ask_with_image(
        image_source=image_source,
        prompt=prompt,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
    )
    return json.dumps(result, ensure_ascii=False)


@mcp_server.tool()
async def list_tools() -> str:
    """List all MCP plugins and tools available to the local LLM.

    Useful for debugging and understanding what tools the model can use.
    """
    manager = await _get_manager()
    return manager.list_loaded_tools()


@mcp_server.tool()
async def list_models() -> str:
    """List all configured models available in the sk-agent.

    Returns information about each model including:
    - id: Unique identifier for the model
    - model_id: The actual model name used in API calls
    - vision: Whether the model supports vision/image input
    - description: Human-readable description
    - is_default_ask: Whether this is the default for ask()
    - is_default_vision: Whether this is the default for analyze_image()

    Useful for selecting the right model for your task.
    """
    config = load_config()
    models = config.get("models", [])
    default_ask = config.get("default_ask_model", "")
    default_vision = config.get("default_vision_model", "")

    if not models:
        return "No models configured."

    lines = ["## Available Models"]
    for m in models:
        model_id = m.get("id", "unknown")
        badges = []
        if model_id == default_ask:
            badges.append("ASK")
        if model_id == default_vision:
            badges.append("VISION👁️")
        badge_str = f" [{'+'.join(badges)}]" if badges else ""
        desc = m.get("description", "")
        lines.append(f"- {model_id}{badge_str}: {desc}")

    return "\n".join(lines)


@mcp_server.tool()
async def end_conversation(conversation_id: str) -> str:
    """End and clean up a conversation thread.

    Args:
        conversation_id: The conversation ID to end.

    Returns:
        Success or error message.
    """
    manager = await _get_manager()
    success = manager.end_conversation(conversation_id)
    if success:
        return f"Conversation '{conversation_id}' ended."
    return f"Conversation '{conversation_id}' not found."


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    log.info("Starting sk-agent MCP server (config: %s, depth=%d)", CONFIG_PATH, SK_AGENT_DEPTH)
    mcp_server.run(transport="stdio")


if __name__ == "__main__":
    main()
