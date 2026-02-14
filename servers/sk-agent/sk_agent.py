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
from semantic_kernel.contents import FunctionCallContent, FunctionResultContent

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


def _crop_image(data: bytes, media_type: str, region: dict) -> tuple[bytes, str]:
    """Crop image to specified region.

    Args:
        data: Raw image bytes
        media_type: MIME type of the image
        region: Dict with x, y, width, height (pixels or percentages)

    Returns:
        Tuple of (cropped_image_bytes, media_type)
    """
    import io

    img = Image.open(io.BytesIO(data))
    img_w, img_h = img.size

    # Parse region - support both pixels and percentages
    def parse_value(val: float | str, total: int) -> int:
        if isinstance(val, str) and val.endswith("%"):
            return int(float(val[:-1]) / 100 * total)
        return int(val)

    x = parse_value(region.get("x", 0), img_w)
    y = parse_value(region.get("y", 0), img_h)
    w = parse_value(region.get("width", region.get("w", img_w)), img_w)
    h = parse_value(region.get("height", region.get("h", img_h)), img_h)

    # Clamp to image bounds
    x = max(0, min(x, img_w - 1))
    y = max(0, min(y, img_h - 1))
    w = min(w, img_w - x)
    h = min(h, img_h - y)

    # Crop
    cropped = img.crop((x, y, x + w, y + h))

    buf = io.BytesIO()
    fmt = "JPEG" if media_type in ("image/jpeg", "image/jpg") else "PNG"
    cropped.save(buf, format=fmt)
    out_type = f"image/{fmt.lower()}"

    log.info("Cropped image %dx%d -> %dx%d", img_w, img_h, w, h)
    return buf.getvalue(), out_type


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
    """Manages per-model kernels, MCP plugins, and per-conversation threads."""

    def __init__(self, config: dict):
        self.config = config
        self._exit_stack = AsyncExitStack()
        # Per-model resources
        self._kernels: dict[str, Kernel] = {}
        self._agents: dict[str, ChatCompletionAgent] = {}
        self._openai_clients: dict[str, AsyncOpenAI] = {}
        self._model_plugins: dict[str, list] = {}  # Per-model plugins
        # Shared resources
        self._shared_plugins: list = []
        self._threads: dict[str, ChatHistoryAgentThread] = {}

    async def start(self):
        """Initialize per-model kernels, agents, and plugins."""
        max_depth = self.config.get("max_recursion_depth", DEFAULT_MAX_RECURSION_DEPTH)
        if SK_AGENT_DEPTH >= max_depth:
            log.info("Skipping MCP plugins (depth=%d >= max_depth=%d)", SK_AGENT_DEPTH, max_depth)
        else:
            # Load shared MCP plugins
            await self._load_shared_plugins()

        # Create a kernel + agent per model
        for model_cfg in self.config.get("models", []):
            model_id = model_cfg.get("id", "default")
            api_key = os.environ.get(
                model_cfg.get("api_key_env", ""),
                model_cfg.get("api_key", "no-key"),
            )
            base_url = model_cfg.get("base_url", "http://localhost:5001/v1")
            target_model = model_cfg.get("model_id", "default")

            # Create OpenAI client for this model
            client = AsyncOpenAI(api_key=api_key, base_url=base_url)
            self._openai_clients[model_id] = client

            # Create dedicated kernel for this model
            kernel = Kernel()
            service = OpenAIChatCompletion(
                ai_model_id=target_model,
                async_client=client,
                service_id=model_id,
            )
            kernel.add_service(service)
            self._kernels[model_id] = kernel

            # Get model-specific system prompt or use global
            system_prompt = model_cfg.get("system_prompt") or self.config.get("system_prompt", "")

            # Combine shared + per-model plugins
            all_plugins = list(self._shared_plugins)

            # Load per-model MCPs if specified
            if SK_AGENT_DEPTH < max_depth and model_cfg.get("mcps"):
                model_plugins = await self._load_model_plugins(model_cfg, model_id)
                all_plugins.extend(model_plugins)
                self._model_plugins[model_id] = model_plugins

            # Create agent for this model with all plugins
            # Sanitize model_id for agent name (only alphanumeric, underscore, hyphen)
            safe_name = model_id.replace(".", "-").replace(" ", "-")
            agent = ChatCompletionAgent(
                kernel=kernel,
                name=f"sk-agent-{safe_name}",
                instructions=system_prompt,
                plugins=all_plugins,
            )
            self._agents[model_id] = agent

            log.info("Created agent for model: %s -> %s at %s", model_id, target_model, base_url)

        log.info("SK Agent Manager ready: %d agents, %d shared plugins, %d model-specific plugins",
                 len(self._agents), len(self._shared_plugins), sum(len(p) for p in self._model_plugins.values()))

    async def _load_shared_plugins(self):
        """Load all MCP plugins from config.mcps (shared by all models)."""
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
                self._shared_plugins.append(connected)
                log.info("Shared MCP plugin loaded: %s", mcp_cfg["name"])
            except Exception:
                log.exception("Failed to load shared MCP plugin: %s", mcp_cfg.get("name"))

    async def _load_model_plugins(self, model_cfg: dict, model_id: str) -> list:
        """Load MCP plugins specific to a model from model_cfg.mcps."""
        plugins = []
        for mcp_cfg in model_cfg.get("mcps", []):
            try:
                env = {**os.environ, **(mcp_cfg.get("env") or {})}

                # Detect self-inclusion
                mcp_args = " ".join(mcp_cfg.get("args", []))
                is_self = "sk_agent.py" in mcp_args or "sk_agent" in mcp_cfg.get("name", "").lower()

                if is_self:
                    env["SK_AGENT_DEPTH"] = str(SK_AGENT_DEPTH + 1)
                    log.info("Self-inclusion: spawning child sk-agent with depth=%d", SK_AGENT_DEPTH + 1)

                # Prefix name with model_id to avoid conflicts
                plugin_name = f"{model_id}_{mcp_cfg['name']}"

                plugin = MCPStdioPlugin(
                    name=plugin_name,
                    description=mcp_cfg.get("description"),
                    command=mcp_cfg.get("command", ""),
                    args=mcp_cfg.get("args"),
                    env=env,
                )
                connected = await self._exit_stack.enter_async_context(plugin)
                plugins.append(connected)
                log.info("Model-specific MCP plugin loaded: %s for model %s", mcp_cfg["name"], model_id)
            except Exception:
                log.exception("Failed to load model MCP plugin: %s for model %s", mcp_cfg.get("name"), model_id)
        return plugins

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
        include_steps: bool = False,
    ) -> dict[str, Any]:
        """Send a text prompt with auto tool calling.

        Args:
            prompt: The user question or instruction.
            model_id: Optional model ID to use.
            conversation_id: Optional conversation ID to continue.
            system_prompt: Optional override for the system prompt.
            include_steps: If True, include intermediate steps (tool calls) in response.

        Returns dict with: response, conversation_id, model_used, and optionally steps
        """
        # Determine which model to use
        target_model = model_id or self.config.get("default_ask_model", "")
        if target_model not in self._agents:
            # Fallback to first available
            target_model = next(iter(self._agents), "")
            if not target_model:
                return {"error": "No models available"}
            log.warning("Requested model not found, using: %s", target_model)

        # Get or create thread
        conv_id, thread = self._get_or_create_thread(conversation_id)

        # Get pre-created agent for this model
        agent = self._agents[target_model]

        # Override system prompt if provided
        if system_prompt:
            agent.instructions = system_prompt

        # Collect intermediate steps if requested
        collected_steps: list[dict] = []

        async def handle_intermediate_message(message) -> None:
            """Callback to capture intermediate messages (tool calls/results)."""
            step = {
                "role": str(message.role) if hasattr(message, 'role') else "unknown",
            }
            # Check message items for function calls/results
            if hasattr(message, 'items') and message.items:
                for item in message.items:
                    if isinstance(item, FunctionCallContent):
                        # Try to parse arguments as JSON
                        args = item.arguments if hasattr(item, 'arguments') else {}
                        if isinstance(args, str):
                            try:
                                args = json.loads(args)
                            except (json.JSONDecodeError, TypeError):
                                pass  # Keep as string if not valid JSON
                        collected_steps.append({
                            "type": "function_call",
                            "name": item.name if hasattr(item, 'name') else str(item),
                            "arguments": args,
                        })
                    elif isinstance(item, FunctionResultContent):
                        # Extract result - handle MCP TextContent objects
                        raw_result = item.result if hasattr(item, 'result') else item
                        parsed_result = None

                        # Case 1: List of TextContent objects (MCP tool response)
                        if isinstance(raw_result, list):
                            texts = []
                            for elem in raw_result:
                                if hasattr(elem, 'text'):
                                    texts.append(elem.text)
                                elif hasattr(elem, 'content') and hasattr(elem.content, 'text'):
                                    texts.append(elem.content.text)
                                else:
                                    texts.append(str(elem))
                            combined = "\n".join(texts)
                            try:
                                parsed_result = json.loads(combined)
                            except (json.JSONDecodeError, TypeError):
                                parsed_result = combined
                        # Case 2: String that might be JSON
                        elif isinstance(raw_result, str):
                            try:
                                parsed_result = json.loads(raw_result)
                            except (json.JSONDecodeError, TypeError):
                                parsed_result = raw_result
                        # Case 3: Single TextContent object
                        elif hasattr(raw_result, 'text'):
                            try:
                                parsed_result = json.loads(raw_result.text)
                            except (json.JSONDecodeError, TypeError):
                                parsed_result = raw_result.text
                        else:
                            parsed_result = str(raw_result)

                        collected_steps.append({
                            "type": "function_result",
                            "name": item.name if hasattr(item, 'name') else str(item),
                            "result": parsed_result,
                        })
            elif hasattr(message, 'content') and message.content:
                # Regular message with content
                step["content"] = str(message.content)
                collected_steps.append(step)

        # Use invoke() with callback for intermediate steps
        final_response = None
        async for response in agent.invoke(
            messages=prompt,
            thread=thread,
            on_intermediate_message=handle_intermediate_message if include_steps else None,
        ):
            final_response = response
            thread = response.thread  # Update thread reference

        result = {
            "response": str(final_response) if final_response else "",
            "conversation_id": conv_id,
            "model_used": target_model,
        }

        if include_steps:
            result["steps"] = collected_steps

        return result

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
        if not self._agents:
            return {"error": "No agents initialized"}

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

    async def analyze_image_region(
        self,
        image_source: str,
        region: dict,
        prompt: str = "Describe this region in detail",
        model_id: str | None = None,
    ) -> dict[str, Any]:
        """Zoom/crop to a region and analyze it.

        Args:
            image_source: Local file path or URL to the image
            region: Dict with x, y, width, height (pixels or "10%" percentages)
            prompt: Question or instruction about the region
            model_id: Optional model ID (must support vision)

        Returns:
            Dict with: response, model_used, region_analyzed
        """
        if not self._agents:
            return {"error": "No agents initialized"}

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

        # Load image
        try:
            data, media_type = await resolve_attachment(image_source)
        except FileNotFoundError as e:
            return {"error": str(e)}

        # Decode base64 back to bytes for cropping
        raw_data = base64.b64decode(data)

        # Crop to region
        try:
            cropped_data, cropped_type = _crop_image(raw_data, media_type, region)
        except Exception as e:
            return {"error": f"Failed to crop image: {e}"}

        # Re-encode cropped image
        cropped_b64 = base64.b64encode(cropped_data).decode("ascii")
        data_url = f"data:{cropped_type};base64,{cropped_b64}"

        # Get OpenAI client for this model
        client = self._openai_clients.get(target_model)
        if not client:
            return {"error": f"No client for model: {target_model}"}

        # Analyze cropped region
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
            "model_used": target_model,
            "region_analyzed": region,
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
        if not self._kernels:
            return "No kernels initialized."

        # Use first kernel's plugins (shared by all models)
        first_kernel = next(iter(self._kernels.values()))
        lines = []
        for plugin_name, plugin in first_kernel.plugins.items():
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
        self._shared_plugins.clear()
        self._threads.clear()
        self._kernels.clear()
        self._agents.clear()
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
    include_steps: bool = False,
) -> str:
    """Send a text prompt to the local LLM.

    The model may autonomously use its configured tools (web search, browser,
    etc.) to answer the query. Returns the model's response.

    Args:
        prompt: The user question or instruction.
        model: Optional model ID (e.g., "glm-4.7-flash"). Uses default if not specified.
        conversation_id: Optional conversation ID to continue a previous conversation.
        system_prompt: Optional override for the system prompt.
        include_steps: If True, include intermediate reasoning/tool call steps.

    Returns:
        JSON string with: response, conversation_id, model_used, and optionally steps
    """
    manager = await _get_manager()
    result = await manager.ask(
        prompt=prompt,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
        system_prompt=system_prompt if system_prompt else None,
        include_steps=include_steps,
    )
    return json.dumps(result, ensure_ascii=False, indent=2)


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
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp_server.tool()
async def zoom_image(
    image_source: str,
    region: str,
    prompt: str = "Describe this region in detail",
    model: str = "",
) -> str:
    """Zoom into a specific region of an image and analyze it.

    Crops the image to the specified region and analyzes it with the vision model.
    Useful for examining details in specific areas of an image.

    Args:
        image_source: Path to a local image file or an HTTP(S) URL.
        region: JSON string with crop region. Example: '{"x": 100, "y": 200, "width": 300, "height": 400}'
                Values can be pixels or percentages like '{"x": "10%", "y": "20%", "width": "50%", "height": "30%"}'
        prompt: Question or instruction about the region.
        model: Optional model ID (must support vision). Uses default vision model if not specified.

    Returns:
        JSON string with: response, model_used, region_analyzed
    """
    # Parse region JSON
    try:
        region_dict = json.loads(region)
    except json.JSONDecodeError:
        return json.dumps({"error": f"Invalid region JSON: {region}"}, ensure_ascii=False, indent=2)

    manager = await _get_manager()
    result = await manager.analyze_image_region(
        image_source=image_source,
        region=region_dict,
        prompt=prompt,
        model_id=model if model else None,
    )
    return json.dumps(result, ensure_ascii=False, indent=2)


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
