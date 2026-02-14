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
import io
import json
import logging
import mimetypes
import os
import subprocess
import sys
import tempfile
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
from semantic_kernel.contents import (
    AuthorRole,
    ChatMessageContent,
    FunctionCallContent,
    FunctionResultContent,
    ImageContent,
    TextContent,
)

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


def _extract_video_frames(video_path: str, num_frames: int = 8, fps: float | None = None) -> list[tuple[bytes, str]]:
    """Extract frames from a video file using ffmpeg.

    Args:
        video_path: Path to the video file
        num_frames: Number of frames to extract (evenly distributed)
        fps: Optional frame rate to use (if None, extracts evenly distributed frames)

    Returns:
        List of (frame_bytes, media_type) tuples
    """
    try:
        # Get video duration
        probe_cmd = [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", video_path
        ]
        result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30)
        duration = float(result.stdout.strip())
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError) as e:
        log.warning("Could not get video duration: %s, using default method", e)
        duration = None

    frames = []

    if duration:
        # Extract evenly distributed frames
        timestamps = [duration * (i + 0.5) / num_frames for i in range(num_frames)]
    else:
        # Fallback: extract at fixed intervals
        timestamps = [i * 2.0 for i in range(num_frames)]

    with tempfile.TemporaryDirectory() as tmpdir:
        for i, ts in enumerate(timestamps):
            output_path = os.path.join(tmpdir, f"frame_{i:03d}.jpg")
            try:
                cmd = [
                    "ffmpeg", "-y", "-ss", str(ts), "-i", video_path,
                    "-frames:v", "1", "-q:v", "2", output_path
                ]
                subprocess.run(cmd, capture_output=True, timeout=30, check=True)

                if os.path.exists(output_path):
                    with open(output_path, "rb") as f:
                        frame_data = f.read()
                    frames.append((frame_data, "image/jpeg"))
                    log.info("Extracted frame %d at %.2fs from video", i, ts)
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError) as e:
                log.warning("Failed to extract frame %d: %s", i, e)
                continue

    log.info("Extracted %d frames from video: %s", len(frames), video_path)
    return frames


def _pdf_to_images(pdf_path: str, max_pages: int = 10) -> list[tuple[bytes, str]]:
    """Convert PDF pages to images using pdf2image or PyMuPDF.

    Args:
        pdf_path: Path to the PDF file
        max_pages: Maximum number of pages to convert

    Returns:
        List of (image_bytes, media_type) tuples
    """
    images = []

    # Try pdf2image first (better quality)
    try:
        from pdf2image import convert_from_path

        pages = convert_from_path(pdf_path, first_page=1, last_page=max_pages, dpi=150)
        for i, page in enumerate(pages):
            buf = io.BytesIO()
            page.save(buf, format="JPEG", quality=85)
            images.append((buf.getvalue(), "image/jpeg"))
            log.info("Converted PDF page %d to image (pdf2image)", i + 1)

        log.info("Converted %d pages from PDF: %s", len(images), pdf_path)
        return images
    except ImportError:
        log.debug("pdf2image not available, trying PyMuPDF")
    except Exception as e:
        log.warning("pdf2image failed: %s, trying PyMuPDF", e)

    # Fallback to PyMuPDF (fitz)
    try:
        import fitz  # PyMuPDF

        doc = fitz.open(pdf_path)
        for i, page in enumerate(doc):
            if i >= max_pages:
                break
            # Render page to image
            mat = fitz.Matrix(2.0, 2.0)  # 2x zoom for better quality
            pix = page.get_pixmap(matrix=mat)
            img_data = pix.tobytes("jpeg")
            images.append((img_data, "image/jpeg"))
            log.info("Converted PDF page %d to image (PyMuPDF)", i + 1)

        doc.close()
        log.info("Converted %d pages from PDF: %s", len(images), pdf_path)
        return images
    except ImportError:
        log.error("Neither pdf2image nor PyMuPDF available for PDF conversion")
        raise RuntimeError("PDF conversion requires pdf2image or PyMuPDF. Install with: pip install pdf2image or pip install PyMuPDF")
    except Exception as e:
        log.error("PDF conversion failed: %s", e)
        raise


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
            # Skip disabled models
            if not model_cfg.get("enabled", True):
                log.info("Skipping disabled model: %s", model_cfg.get("id", "unknown"))
                continue

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

    async def _ask_with_media(
        self,
        prompt: str,
        image_data: str | None = None,
        media_type: str | None = None,
        model_id: str | None = None,
        conversation_id: str | None = None,
        system_prompt: str | None = None,
        include_steps: bool = False,
        zoom_context: dict | None = None,
    ) -> dict[str, Any]:
        """Send a prompt with optional image using Semantic Kernel.

        This is the core method that handles both text-only and vision requests
        using Semantic Kernel's ChatCompletionAgent with proper content types.

        Args:
            prompt: The user question or instruction.
            image_data: Optional base64-encoded image data.
            media_type: MIME type of the image (e.g., "image/png").
            model_id: Optional model ID to use.
            conversation_id: Optional conversation ID to continue.
            system_prompt: Optional override for the system prompt.
            include_steps: If True, include intermediate steps (tool calls) in response.
            zoom_context: Optional dict with zoom level info for recursive calls:
                - depth: current zoom depth (0 = no zoom)
                - stack: list of previous regions [{"x": 10, "y": 20, "w": 100, "h": 100}]
                - original_source: original image source before any cropping

        Returns dict with: response, conversation_id, model_used, and optionally steps, zoom_context
        """
        # Determine which model to use
        target_model = model_id or (self.config.get("default_vision_model") if image_data else self.config.get("default_ask_model"))
        if target_model not in self._agents:
            target_model = next(iter(self._agents), "")
            if not target_model:
                return {"error": "No models available"}
            log.warning("Requested model not found, using: %s", target_model)

        # Verify vision capability if image provided
        if image_data:
            model_cfg = self._get_model_config(target_model)
            if not model_cfg or not model_cfg.get("vision", False):
                # Try to find a vision model among enabled models
                for m in self.config.get("models", []):
                    if m.get("enabled", True) and m.get("vision", False):
                        target_model = m.get("id", "")
                        log.info("Auto-selected vision model: %s", target_model)
                        break
                else:
                    return {"error": "No vision-capable model available"}

        # Get or create thread
        conv_id, thread = self._get_or_create_thread(conversation_id)

        # Get pre-created agent for this model
        agent = self._agents[target_model]

        # Override system prompt if provided
        if system_prompt:
            agent.instructions = system_prompt

        # Build message content items
        content_items = [TextContent(text=prompt)]

        if image_data and media_type:
            # Create data URI for the image
            data_url = f"data:{media_type};base64,{image_data}"
            content_items.append(ImageContent(data_uri=data_url))

        # Create ChatMessageContent with items
        message = ChatMessageContent(
            role=AuthorRole.USER,
            items=content_items,
        )

        # Collect intermediate steps if requested
        collected_steps: list[dict] = []

        async def handle_intermediate_message(msg) -> None:
            """Callback to capture intermediate messages (tool calls/results)."""
            step = {
                "role": str(msg.role) if hasattr(msg, 'role') else "unknown",
            }
            if hasattr(msg, 'items') and msg.items:
                for item in msg.items:
                    if isinstance(item, FunctionCallContent):
                        args = item.arguments if hasattr(item, 'arguments') else {}
                        if isinstance(args, str):
                            try:
                                args = json.loads(args)
                            except (json.JSONDecodeError, TypeError):
                                pass
                        collected_steps.append({
                            "type": "function_call",
                            "name": item.name if hasattr(item, 'name') else str(item),
                            "arguments": args,
                        })
                    elif isinstance(item, FunctionResultContent):
                        raw_result = item.result if hasattr(item, 'result') else item
                        parsed_result = None

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
                        elif isinstance(raw_result, str):
                            try:
                                parsed_result = json.loads(raw_result)
                            except (json.JSONDecodeError, TypeError):
                                parsed_result = raw_result
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
            elif hasattr(msg, 'content') and msg.content:
                step["content"] = str(msg.content)
                collected_steps.append(step)

        # Use invoke() with callback for intermediate steps
        final_response = None
        async for response in agent.invoke(
            messages=message,
            thread=thread,
            on_intermediate_message=handle_intermediate_message if include_steps else None,
        ):
            final_response = response
            thread = response.thread  # Update thread reference

        # Update thread storage
        self._threads[conv_id] = thread

        result = {
            "response": str(final_response) if final_response else "",
            "conversation_id": conv_id,
            "model_used": target_model,
        }

        if include_steps:
            result["steps"] = collected_steps

        if zoom_context:
            result["zoom_context"] = zoom_context

        return result

    async def ask_with_image(
        self,
        image_source: str,
        prompt: str = "Describe this image in detail",
        model_id: str | None = None,
        conversation_id: str | None = None,
        zoom_context: dict | None = None,
    ) -> dict[str, Any]:
        """Send an image + prompt for vision analysis using Semantic Kernel.

        Args:
            image_source: Local file path or URL to the image
            prompt: Question or instruction about the image
            model_id: Optional model ID (must support vision)
            conversation_id: Optional conversation ID to continue
            zoom_context: Optional zoom context for recursive calls

        Returns dict with: response, conversation_id, model_used, zoom_context (if provided)
        """
        if not self._agents:
            return {"error": "No agents initialized"}

        # Check vision model availability BEFORE loading image
        target_model = model_id or self.config.get("default_vision_model", "")
        model_cfg = self._get_model_config(target_model)

        if not model_cfg or not model_cfg.get("vision", False):
            # Try to find a vision model among enabled models
            for m in self.config.get("models", []):
                if m.get("enabled", True) and m.get("vision", False):
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

        # Delegate to unified method
        return await self._ask_with_media(
            prompt=prompt,
            image_data=b64_data,
            media_type=media_type,
            model_id=model_id,
            conversation_id=conversation_id,
            zoom_context=zoom_context,
        )

    async def analyze_image_region(
        self,
        image_source: str,
        region: dict,
        prompt: str = "Describe this region in detail",
        model_id: str | None = None,
        conversation_id: str | None = None,
        zoom_context: dict | None = None,
    ) -> dict[str, Any]:
        """Zoom/crop to a region and analyze it using Semantic Kernel.

        This method crops the image to the specified region and analyzes it.
        It can be called recursively for progressive zoom, passing the zoom_context
        to maintain the zoom stack and enable the model to understand the context.

        Args:
            image_source: Local file path or URL to the image
            region: Dict with x, y, width, height (pixels or "10%" percentages)
            prompt: Question or instruction about the region
            model_id: Optional model ID (must support vision)
            conversation_id: Optional conversation ID to continue
            zoom_context: Optional previous zoom context for recursive calls:
                - depth: current zoom depth (incremented automatically)
                - stack: list of previous regions
                - original_source: original image source

        Returns:
            Dict with: response, conversation_id, model_used, region_analyzed, zoom_context
        """
        if not self._agents:
            return {"error": "No agents initialized"}

        # Check vision model availability BEFORE loading image
        target_model = model_id or self.config.get("default_vision_model", "")
        model_cfg = self._get_model_config(target_model)

        if not model_cfg or not model_cfg.get("vision", False):
            # Try to find a vision model among enabled models
            for m in self.config.get("models", []):
                if m.get("enabled", True) and m.get("vision", False):
                    target_model = m.get("id", "")
                    model_cfg = m
                    log.info("Auto-selected vision model: %s", target_model)
                    break
            else:
                return {"error": "No vision-capable model available"}

        # Build new zoom context
        new_depth = (zoom_context.get("depth", 0) + 1) if zoom_context else 1
        new_stack = list(zoom_context.get("stack", [])) if zoom_context else []
        new_stack.append(region)
        original_source = zoom_context.get("original_source", image_source) if zoom_context else image_source

        new_zoom_context = {
            "depth": new_depth,
            "stack": new_stack,
            "original_source": original_source,
        }

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

        # Delegate to unified method with cropped image
        result = await self._ask_with_media(
            prompt=prompt,
            image_data=cropped_b64,
            media_type=cropped_type,
            model_id=model_id,
            conversation_id=conversation_id,
            zoom_context=new_zoom_context,
        )

        # Add region info to result
        result["region_analyzed"] = region
        return result

    async def analyze_video(
        self,
        video_source: str,
        prompt: str = "Describe what happens in this video",
        model_id: str | None = None,
        conversation_id: str | None = None,
        num_frames: int = 8,
    ) -> dict[str, Any]:
        """Analyze a video by extracting frames and using vision model.

        This method extracts key frames from a video and sends them
        to the vision model for analysis. GLM-4.6V supports up to 128K
        tokens context, allowing comprehensive video understanding.

        Args:
            video_source: Local file path to the video
            prompt: Question or instruction about the video
            model_id: Optional model ID (must support vision)
            conversation_id: Optional conversation ID to continue
            num_frames: Number of frames to extract (default: 8)

        Returns:
            Dict with: response, conversation_id, model_used, frames_analyzed
        """
        if not self._agents:
            return {"error": "No agents initialized"}

        # Check vision model availability
        target_model = model_id or self.config.get("default_vision_model", "")
        model_cfg = self._get_model_config(target_model)

        if not model_cfg or not model_cfg.get("vision", False):
            for m in self.config.get("models", []):
                if m.get("enabled", True) and m.get("vision", False):
                    target_model = m.get("id", "")
                    model_cfg = m
                    log.info("Auto-selected vision model: %s", target_model)
                    break
            else:
                return {"error": "No vision-capable model available"}

        # Extract frames from video
        try:
            frames = _extract_video_frames(video_source, num_frames=num_frames)
        except Exception as e:
            return {"error": f"Failed to extract video frames: {e}"}

        if not frames:
            return {"error": "No frames could be extracted from video"}

        # Build multi-image content
        # For multi-image, we send all frames as a single message with multiple images
        content_items = [TextContent(text=f"{prompt}\n\nThe video has been sampled into {len(frames)} frames below:")]

        for i, (frame_data, media_type) in enumerate(frames):
            b64_data = base64.b64encode(frame_data).decode("ascii")
            data_url = f"data:{media_type};base64,{b64_data}"
            content_items.append(TextContent(text=f"\n--- Frame {i + 1} ---"))
            content_items.append(ImageContent(data_uri=data_url))

        # Get or create thread
        conv_id, thread = self._get_or_create_thread(conversation_id)

        # Get agent
        agent = self._agents[target_model]

        # Create message with all frames
        message = ChatMessageContent(
            role=AuthorRole.USER,
            items=content_items,
        )

        # Invoke agent
        final_response = None
        async for response in agent.invoke(
            messages=message,
            thread=thread,
        ):
            final_response = response
            thread = response.thread

        self._threads[conv_id] = thread

        return {
            "response": str(final_response) if final_response else "",
            "conversation_id": conv_id,
            "model_used": target_model,
            "frames_analyzed": len(frames),
        }

    async def analyze_document(
        self,
        document_source: str,
        prompt: str = "Summarize this document and extract key information",
        model_id: str | None = None,
        conversation_id: str | None = None,
        max_pages: int = 10,
    ) -> dict[str, Any]:
        """Analyze a PDF document by converting pages to images.

        This method converts PDF pages to images and sends them
        to the vision model for analysis. Supports multi-page documents
        with GLM-4.6V's 128K token context.

        Args:
            document_source: Local file path to the PDF document
            prompt: Question or instruction about the document
            model_id: Optional model ID (must support vision)
            conversation_id: Optional conversation ID to continue
            max_pages: Maximum number of pages to analyze (default: 10)

        Returns:
            Dict with: response, conversation_id, model_used, pages_analyzed
        """
        if not self._agents:
            return {"error": "No agents initialized"}

        # Check vision model availability
        target_model = model_id or self.config.get("default_vision_model", "")
        model_cfg = self._get_model_config(target_model)

        if not model_cfg or not model_cfg.get("vision", False):
            for m in self.config.get("models", []):
                if m.get("enabled", True) and m.get("vision", False):
                    target_model = m.get("id", "")
                    model_cfg = m
                    log.info("Auto-selected vision model: %s", target_model)
                    break
            else:
                return {"error": "No vision-capable model available"}

        # Convert PDF to images
        try:
            pages = _pdf_to_images(document_source, max_pages=max_pages)
        except Exception as e:
            return {"error": f"Failed to convert document: {e}"}

        if not pages:
            return {"error": "No pages could be extracted from document"}

        # Build multi-page content
        content_items = [TextContent(text=f"{prompt}\n\nThe document has {len(pages)} pages below:")]

        for i, (page_data, media_type) in enumerate(pages):
            b64_data = base64.b64encode(page_data).decode("ascii")
            data_url = f"data:{media_type};base64,{b64_data}"
            content_items.append(TextContent(text=f"\n--- Page {i + 1} ---"))
            content_items.append(ImageContent(data_uri=data_url))

        # Get or create thread
        conv_id, thread = self._get_or_create_thread(conversation_id)

        # Get agent
        agent = self._agents[target_model]

        # Create message with all pages
        message = ChatMessageContent(
            role=AuthorRole.USER,
            items=content_items,
        )

        # Invoke agent
        final_response = None
        async for response in agent.invoke(
            messages=message,
            thread=thread,
        ):
            final_response = response
            thread = response.thread

        self._threads[conv_id] = thread

        return {
            "response": str(final_response) if final_response else "",
            "conversation_id": conv_id,
            "model_used": target_model,
            "pages_analyzed": len(pages),
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
                "enabled": m.get("enabled", True),
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
    zoom_context: str = "",
) -> str:
    """Analyze an image using the local vision model with Semantic Kernel.

    Accepts a local file path (e.g. D:/screenshots/img.png) or a URL.
    The image is automatically converted to base64 for the model API.
    Supports conversation continuity and recursive zoom context.

    Args:
        image_source: Path to a local image file or an HTTP(S) URL.
        prompt: Question or instruction about the image.
        model: Optional model ID (must support vision). Uses default vision model if not specified.
        conversation_id: Optional conversation ID to continue a previous conversation.
        zoom_context: Optional JSON string with zoom context for recursive calls.
                      Format: '{"depth": 1, "stack": [{"x": 10, "y": 20, "w": 100, "h": 100}], "original_source": "path"}'

    Returns:
        JSON string with: response, conversation_id, model_used, zoom_context (if provided)
    """
    # Parse zoom_context if provided
    zoom_ctx = None
    if zoom_context:
        try:
            zoom_ctx = json.loads(zoom_context)
        except json.JSONDecodeError:
            log.warning("Invalid zoom_context JSON, ignoring: %s", zoom_context)

    manager = await _get_manager()
    result = await manager.ask_with_image(
        image_source=image_source,
        prompt=prompt,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
        zoom_context=zoom_ctx,
    )
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp_server.tool()
async def zoom_image(
    image_source: str,
    region: str,
    prompt: str = "Describe this region in detail",
    model: str = "",
    conversation_id: str = "",
    zoom_context: str = "",
) -> str:
    """Zoom into a specific region of an image and analyze it using Semantic Kernel.

    Crops the image to the specified region and analyzes it with the vision model.
    Useful for examining details in specific areas of an image.
    Supports progressive zoom by passing the previous zoom_context.

    Args:
        image_source: Path to a local image file or an HTTP(S) URL.
        region: JSON string with crop region. Example: '{"x": 100, "y": 200, "width": 300, "height": 400}'
                Values can be pixels or percentages like '{"x": "10%", "y": "20%", "width": "50%", "height": "30%"}'
        prompt: Question or instruction about the region.
        model: Optional model ID (must support vision). Uses default vision model if not specified.
        conversation_id: Optional conversation ID to continue a previous conversation.
        zoom_context: Optional JSON string with previous zoom context for progressive zoom.
                      Pass the zoom_context from a previous zoom_image call to chain zooms.

    Returns:
        JSON string with: response, conversation_id, model_used, region_analyzed, zoom_context
    """
    # Parse region JSON
    try:
        region_dict = json.loads(region)
    except json.JSONDecodeError:
        return json.dumps({"error": f"Invalid region JSON: {region}"}, ensure_ascii=False, indent=2)

    # Parse zoom_context if provided
    zoom_ctx = None
    if zoom_context:
        try:
            zoom_ctx = json.loads(zoom_context)
        except json.JSONDecodeError:
            log.warning("Invalid zoom_context JSON, ignoring: %s", zoom_context)

    manager = await _get_manager()
    result = await manager.analyze_image_region(
        image_source=image_source,
        region=region_dict,
        prompt=prompt,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
        zoom_context=zoom_ctx,
    )
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp_server.tool()
async def analyze_video(
    video_source: str,
    prompt: str = "Describe what happens in this video",
    model: str = "",
    conversation_id: str = "",
    num_frames: int = 8,
) -> str:
    """Analyze a video by extracting frames and using the vision model.

    Extracts key frames from a video file and sends them to the vision model
    for comprehensive video understanding. Supports GLM-4.6V's 128K token context.

    Args:
        video_source: Path to a local video file (MP4, AVI, MOV, etc.).
        prompt: Question or instruction about the video content.
        model: Optional model ID (must support vision). Uses default vision model if not specified.
        conversation_id: Optional conversation ID to continue a previous conversation.
        num_frames: Number of frames to extract from the video (default: 8, max: 20).

    Returns:
        JSON string with: response, conversation_id, model_used, frames_analyzed
    """
    # Clamp num_frames to reasonable range
    num_frames = max(1, min(num_frames, 20))

    manager = await _get_manager()
    result = await manager.analyze_video(
        video_source=video_source,
        prompt=prompt,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
        num_frames=num_frames,
    )
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp_server.tool()
async def analyze_document(
    document_source: str,
    prompt: str = "Summarize this document and extract key information",
    model: str = "",
    conversation_id: str = "",
    max_pages: int = 10,
) -> str:
    """Analyze a PDF document by converting pages to images.

    Converts PDF pages to images and sends them to the vision model
    for document understanding. Supports multi-page documents with GLM-4.6V's
    128K token context. Can extract text, tables, diagrams, and other content.

    Args:
        document_source: Path to a local PDF file.
        prompt: Question or instruction about the document content.
        model: Optional model ID (must support vision). Uses default vision model if not specified.
        conversation_id: Optional conversation ID to continue a previous conversation.
        max_pages: Maximum number of pages to analyze (default: 10, max: 50).

    Returns:
        JSON string with: response, conversation_id, model_used, pages_analyzed
    """
    # Clamp max_pages to reasonable range
    max_pages = max(1, min(max_pages, 50))

    manager = await _get_manager()
    result = await manager.analyze_document(
        document_source=document_source,
        prompt=prompt,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
        max_pages=max_pages,
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
