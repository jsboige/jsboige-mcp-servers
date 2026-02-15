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
    analyze_document(document, prompt?, mode?, max_pages?, page_range?) -- document analysis
    analyze_video(video, prompt?, num_frames?, conversation_id?) -- video analysis
    zoom_image(image, region, prompt?, ...)   -- image region analysis
    list_tools()                              -- introspection: loaded tools
    list_models()                             -- list available models
    install_libreoffice(force?, custom_path?) -- install/configure LibreOffice
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
import shutil
import subprocess
import sys
import uuid
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP
from openai import AsyncOpenAI

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

# Import document and media processing modules
from document_processing import (
    DocumentAnalysisMode,
    PageRange,
    extract_document_pages,
    set_libreoffice_path,
    _find_libreoffice,
    DEFAULT_MAX_PAGES,
    MAX_PAGES_HARD_LIMIT,
)
from media_processing import (
    _crop_image,
    _resize_image_if_needed,
    _extract_video_frames,
    _extract_keyframes,
    _get_video_info,
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


# ---------------------------------------------------------------------------
# Configuration Loading
# ---------------------------------------------------------------------------

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

    # Validate model entries
    for m in config.get("models", []):
        if "id" not in m:
            log.warning("Model entry missing 'id' field: %s", m)
            m["id"] = "unknown"

    return config


def save_config(config: dict) -> None:
    """Save configuration to JSON file."""
    path = Path(CONFIG_PATH)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)


def get_model_context_window(config: dict, model_id: str) -> int:
    """Get context window for a model from config.

    Default values:
    - Vision models: 128k (GLM-4.6V, Qwen3-VL)
    - Cloud models: 200k (z.ai API)
    - Text models: 32k (conservative default)
    """
    for m in config.get("models", []):
        if m.get("id") == model_id:
            # Check explicit context_window in config
            if "context_window" in m:
                return m["context_window"]
            # Infer from model type
            if m.get("vision", False):
                return 128_000  # 128k for vision models
            # Check if cloud API (larger context)
            base_url = m.get("base_url", "")
            if "z.ai" in base_url or "openai.com" in base_url:
                return 200_000  # 200k for cloud models
            return 32_000  # Conservative default for local models
    return 32_000


# ---------------------------------------------------------------------------
# Image Processing Helpers
# ---------------------------------------------------------------------------

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

    data, media_type = _resize_image_if_needed(data, media_type)
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

        new_id = conversation_id or str(uuid.uuid4())
        thread = ChatHistoryAgentThread()
        self._threads[new_id] = thread
        return new_id, thread

    # -----------------------------------------------------------------------
    # Core Agent Methods
    # -----------------------------------------------------------------------

    async def ask(
        self,
        prompt: str,
        model_id: str | None = None,
        conversation_id: str | None = None,
        system_prompt: str | None = None,
        include_steps: bool = False,
    ) -> dict[str, Any]:
        """Send a text prompt to the model with optional tool use."""
        if not self._agents:
            return {"error": "No agents initialized"}

        # Select model
        target_model = model_id or self.config.get("default_ask_model", "")
        if not target_model or target_model not in self._agents:
            for m in self.config.get("models", []):
                if m.get("enabled", True):
                    target_model = m.get("id", "")
                    break

        if not target_model or target_model not in self._agents:
            return {"error": "No suitable model available"}

        agent = self._agents[target_model]
        conv_id, thread = self._get_or_create_thread(conversation_id)

        # Build message
        items = [TextContent(text=prompt)]
        message = ChatMessageContent(role=AuthorRole.USER, items=items)

        # Track intermediate steps if requested
        steps = []

        async def handle_intermediate_message(message) -> None:
            """Track intermediate messages for step-by-step output."""
            step_info = {"role": str(message.role)}
            for item in message.items:
                if isinstance(item, FunctionCallContent):
                    step_info["type"] = "tool_call"
                    step_info["name"] = item.function_name
                    step_info["arguments"] = item.arguments
                elif isinstance(item, FunctionResultContent):
                    step_info["type"] = "tool_result"
                    step_info["result"] = str(item.result)[:500]  # Truncate
                elif isinstance(item, TextContent):
                    step_info["type"] = "text"
                    step_info["content"] = item.text[:200]
            if "type" in step_info:
                steps.append(step_info)

        # Invoke agent
        final_response = None
        async for response in agent.invoke(
            messages=message,
            thread=thread,
            on_intermediate_message=handle_intermediate_message if include_steps else None,
        ):
            final_response = response
            thread = response.thread

        self._threads[conv_id] = thread

        result = {
            "response": str(final_response) if final_response else "",
            "conversation_id": conv_id,
            "model_used": target_model,
        }
        if include_steps:
            result["steps"] = steps

        return result

    async def _ask_with_media(
        self,
        media_items: list,
        prompt: str,
        model_id: str | None = None,
        conversation_id: str | None = None,
        include_steps: bool = False,
    ) -> dict[str, Any]:
        """Internal method to ask with media content (images)."""
        if not self._agents:
            return {"error": "No agents initialized"}

        # Select vision model
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

        agent = self._agents[target_model]
        conv_id, thread = self._get_or_create_thread(conversation_id)

        # Build message with media and prompt
        items = list(media_items)
        items.append(TextContent(text=prompt))
        message = ChatMessageContent(role=AuthorRole.USER, items=items)

        # Track steps
        steps = []

        async def handle_intermediate_message(msg) -> None:
            step_info = {"role": str(msg.role)}
            for item in msg.items:
                if isinstance(item, FunctionCallContent):
                    step_info["type"] = "tool_call"
                    step_info["name"] = item.function_name
                elif isinstance(item, TextContent):
                    step_info["type"] = "text"
            if "type" in step_info:
                steps.append(step_info)

        final_response = None
        async for response in agent.invoke(
            messages=message,
            thread=thread,
            on_intermediate_message=handle_intermediate_message if include_steps else None,
        ):
            final_response = response
            thread = response.thread

        self._threads[conv_id] = thread

        result = {
            "response": str(final_response) if final_response else "",
            "conversation_id": conv_id,
            "model_used": target_model,
        }
        if include_steps:
            result["steps"] = steps

        return result

    async def ask_with_image(
        self,
        image_source: str,
        prompt: str = "Describe this image in detail",
        model_id: str | None = None,
        conversation_id: str | None = None,
    ) -> dict[str, Any]:
        """Ask a question about an image."""
        try:
            b64_data, media_type = await resolve_attachment(image_source)
            data_url = f"data:{media_type};base64,{b64_data}"
            image_item = ImageContent(data_uri=data_url)
            return await self._ask_with_media(
                [image_item], prompt, model_id, conversation_id
            )
        except Exception as e:
            return {"error": str(e)}

    async def analyze_image_region(
        self,
        image_source: str,
        region: dict,
        prompt: str = "Describe this region in detail",
        model_id: str | None = None,
        conversation_id: str | None = None,
        zoom_context: str | None = None,
    ) -> dict[str, Any]:
        """Analyze a specific region of an image (zoom)."""
        try:
            # Load image
            if image_source.startswith(("http://", "https://")):
                async with httpx.AsyncClient(timeout=30) as client:
                    resp = await client.get(image_source, follow_redirects=True)
                    resp.raise_for_status()
                    data = resp.content
                    media_type = resp.headers.get("content-type", "").split(";")[0].strip()
            else:
                p = Path(image_source)
                if not p.exists():
                    return {"error": f"Image not found: {image_source}"}
                data = p.read_bytes()
                media_type = mimetypes.guess_type(str(p))[0] or "image/png"

            # Crop to region
            cropped_data, cropped_type = _crop_image(data, media_type, region)
            cropped_data, cropped_type = _resize_image_if_needed(cropped_data, cropped_type)

            # Build context message
            context_msg = prompt
            if zoom_context:
                context_msg = f"[Zoom context: {zoom_context}]\n\n{prompt}"

            b64_data = base64.b64encode(cropped_data).decode("ascii")
            data_url = f"data:{cropped_type};base64,{b64_data}"
            image_item = ImageContent(data_uri=data_url)

            return await self._ask_with_media(
                [image_item], context_msg, model_id, conversation_id
            )
        except Exception as e:
            return {"error": str(e)}

    async def analyze_video(
        self,
        video_source: str,
        prompt: str = "Describe what happens in this video",
        model_id: str | None = None,
        conversation_id: str | None = None,
        num_frames: int = 8,
        use_keyframes: bool = True,
    ) -> dict[str, Any]:
        """Analyze a video by extracting frames."""
        if not self._agents:
            return {"error": "No agents initialized"}

        # Check video file exists
        video_path = Path(video_source)
        if not video_path.exists():
            return {"error": f"Video file not found: {video_source}"}

        # Get video info
        video_info = _get_video_info(str(video_path))

        # Extract frames
        try:
            if use_keyframes:
                frames = _extract_keyframes(str(video_path), num_frames=num_frames)
            else:
                frames = _extract_video_frames(str(video_path), num_frames=num_frames)
        except Exception as e:
            return {"error": f"Failed to extract video frames: {e}"}

        if not frames:
            return {"error": "No frames could be extracted from video"}

        # Select vision model
        target_model = model_id or self.config.get("default_vision_model", "")
        model_cfg = self._get_model_config(target_model)

        if not model_cfg or not model_cfg.get("vision", False):
            for m in self.config.get("models", []):
                if m.get("enabled", True) and m.get("vision", False):
                    target_model = m.get("id", "")
                    break
            else:
                return {"error": "No vision-capable model available"}

        agent = self._agents[target_model]
        conv_id, thread = self._get_or_create_thread(conversation_id)

        # Build content with frames
        content_items = [TextContent(text=f"{prompt}\n\nThe video has {len(frames)} frames:")]

        for i, (frame_data, media_type) in enumerate(frames):
            b64_data = base64.b64encode(frame_data).decode("ascii")
            data_url = f"data:{media_type};base64,{b64_data}"
            content_items.append(TextContent(text=f"\n[Frame {i + 1}]"))
            content_items.append(ImageContent(data_uri=data_url))

        message = ChatMessageContent(role=AuthorRole.USER, items=content_items)

        final_response = None
        async for response in agent.invoke(messages=message, thread=thread):
            final_response = response
            thread = response.thread

        self._threads[conv_id] = thread

        return {
            "response": str(final_response) if final_response else "",
            "conversation_id": conv_id,
            "model_used": target_model,
            "frames_analyzed": len(frames),
            "video_info": {
                "duration": video_info.duration if video_info else None,
                "resolution": f"{video_info.width}x{video_info.height}" if video_info else None,
            } if video_info else None,
        }

    async def analyze_document(
        self,
        document_source: str,
        prompt: str = "Summarize this document and extract key information",
        model_id: str | None = None,
        conversation_id: str | None = None,
        max_pages: int = DEFAULT_MAX_PAGES,
        mode: DocumentAnalysisMode = "visual",
        page_range: dict | None = None,
        auto_limit_tokens: bool = True,
    ) -> dict[str, Any]:
        """Analyze a document (PDF, PPT/PPTX, DOC/DOCX, XLS/XLSX) with unified pipeline.

        Supports 3 analysis modes:
        - "visual": Convert pages to images (requires vision model)
        - "text": Extract text content (uses text model)
        - "hybrid": Both images and text (requires vision model)

        Args:
            document_source: Local file path to the document
            prompt: Question or instruction about the document
            model_id: Optional model ID override
            conversation_id: Optional conversation ID to continue
            max_pages: Maximum number of pages/sheets to analyze
            mode: Analysis mode - "visual", "text", or "hybrid"
            page_range: Optional dict with "start" and "end" (1-indexed, inclusive)
            auto_limit_tokens: Auto-limit pages based on model context window

        Returns:
            Dict with: response, conversation_id, model_used, pages_analyzed, mode
        """
        if not self._agents:
            return {"error": "No agents initialized"}

        # Select model early to get context window
        has_images_hint = mode in ("visual", "hybrid")
        if has_images_hint:
            target_model = model_id or self.config.get("default_vision_model", "")
            model_cfg = self._get_model_config(target_model)
            if not model_cfg or not model_cfg.get("vision", False):
                for m in self.config.get("models", []):
                    if m.get("enabled", True) and m.get("vision", False):
                        target_model = m.get("id", "")
                        model_cfg = m
                        break
        else:
            target_model = model_id or self.config.get("default_ask_model", "")
            model_cfg = self._get_model_config(target_model)

        if not target_model or target_model not in self._agents:
            return {"error": "No suitable model available"}

        # Get context window for auto-limiting
        context_window = None
        if auto_limit_tokens and model_cfg:
            context_window = get_model_context_window(self.config, target_model)

        # Parse page range
        range_obj = None
        if page_range:
            range_obj = PageRange(
                start=page_range.get("start", 1),
                end=page_range.get("end"),
            )

        # Extract pages using unified pipeline
        try:
            pages = extract_document_pages(
                document_source,
                mode=mode,
                max_pages=max_pages,
                page_range=range_obj,
                context_window=context_window,
            )
        except Exception as e:
            return {"error": f"Failed to extract document pages: {e}"}

        if not pages:
            return {"error": "No pages could be extracted from document"}

        # Determine if we need vision model (has images)
        has_images = any(p.has_image for p in pages)
        needs_vision = has_images or mode == "visual"

        if needs_vision and not model_cfg.get("vision", False):
            return {"error": "No vision-capable model available for visual/hybrid mode"}

        # Build content items
        content_items = [TextContent(text=f"{prompt}\n\nThe document has {len(pages)} page(s):")]

        for page in pages:
            # Add page separator
            page_label = f"Page {page.page_number}"
            if page.metadata and page.metadata.get("sheet_name"):
                page_label = f"Sheet '{page.metadata['sheet_name']}'"
            elif page.metadata and page.metadata.get("source") == "all_slides":
                page_label = "All slides"
            content_items.append(TextContent(text=f"\n--- {page_label} ---"))

            # Add text content if available
            if page.has_text:
                content_items.append(TextContent(text=page.text_content))

            # Add image content if available
            if page.has_image:
                b64_data = base64.b64encode(page.image_data).decode("ascii")
                data_url = f"data:{page.media_type};base64,{b64_data}"
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
            "mode": mode,
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
                "context_window": m.get("context_window", get_model_context_window(self.config, m.get("id", ""))),
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

# Global manager instance
_manager: SKAgentManager | None = None


async def _get_manager() -> SKAgentManager:
    """Get or create the global manager instance."""
    global _manager
    if _manager is None:
        config = load_config()
        _manager = SKAgentManager(config)
        await _manager.start()
    return _manager


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
    return json.dumps(result, ensure_ascii=False)


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
    manager = await _get_manager()
    result = await manager.ask_with_image(
        image_source=image_source,
        prompt=prompt,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
    )

    # Include zoom context if provided
    if zoom_context:
        result["zoom_context"] = zoom_context

    return json.dumps(result, ensure_ascii=False)


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
    import json as json_mod
    try:
        region_dict = json_mod.loads(region)
    except json_mod.JSONDecodeError:
        return json.dumps({"error": "Invalid region JSON"}, ensure_ascii=False)

    manager = await _get_manager()
    result = await manager.analyze_image_region(
        image_source=image_source,
        region=region_dict,
        prompt=prompt,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
        zoom_context=zoom_context if zoom_context else None,
    )

    result["region_analyzed"] = region_dict
    return json.dumps(result, ensure_ascii=False)


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
    # Clamp num_frames
    num_frames = max(1, min(num_frames, 20))

    manager = await _get_manager()
    result = await manager.analyze_video(
        video_source=video_source,
        prompt=prompt,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
        num_frames=num_frames,
    )
    return json.dumps(result, ensure_ascii=False)


@mcp_server.tool()
async def analyze_document(
    document_source: str,
    prompt: str = "Summarize this document and extract key information",
    model: str = "",
    conversation_id: str = "",
    max_pages: int = 10,
    mode: str = "visual",
    page_range: str = "",
    auto_limit_tokens: bool = True,
) -> str:
    """Analyse un document (PDF, PPT/PPTX, DOC/DOCX, XLS/XLSX) avec pipeline unifié.

    3 modes d'analyse disponibles:
    - "visual": Convertit les pages en images (requiert modèle vision)
    - "text": Extrait le contenu textuel (utilise modèle texte)
    - "hybrid": Combine images ET texte (requiert modèle vision)

    Formats supportés:
    - PDF: PyMuPDF (images DPI 180 PNG + extraction texte)
    - PPT/PPTX: LibreOffice → PDF → images, ou extraction texte
    - DOC/DOCX: LibreOffice → PDF → images, ou extraction texte
    - XLS/XLSX: LibreOffice → PDF → images, ou CSV (pandas/LibreOffice)

    Peut extraire texte, tableaux, diagrammes, formules, etc.
    Supporte les documents multi-pages avec le contexte 128K-200K tokens.

    Args:
        document_source: Chemin vers un fichier local (PDF, PPT, PPTX, DOC, DOCX, XLS, XLSX).
        prompt: Question ou instruction sur le contenu du document.
        model: ID du modèle optionnel. Auto-sélectionné selon le mode si non spécifié.
        conversation_id: ID de conversation optionnel pour continuer une conversation précédente.
        max_pages: Nombre maximum de pages/feuilles à analyser (défaut: 10, max: 50).
        mode: Mode d'analyse - "visual" (images), "text" (texte), "hybrid" (les deux). Défaut: visual.
        page_range: JSON optionnel avec plage de pages: '{"start": 1, "end": 10}' (1-indexé, inclusif).
        auto_limit_tokens: Limite automatique des pages selon le contexte du modèle (défaut: true).

    Returns:
        Chaîne JSON avec: response, conversation_id, model_used, pages_analyzed, mode
    """
    import json as json_mod

    # Clamp max_pages to reasonable range
    max_pages = max(1, min(max_pages, MAX_PAGES_HARD_LIMIT))

    # Validate mode
    if mode not in ("visual", "text", "hybrid"):
        return json.dumps({"error": f"Invalid mode '{mode}'. Must be: visual, text, or hybrid"}, ensure_ascii=False)

    # Parse page_range if provided
    page_range_dict = None
    if page_range:
        try:
            page_range_dict = json_mod.loads(page_range)
        except json_mod.JSONDecodeError:
            return json.dumps({"error": "Invalid page_range JSON"}, ensure_ascii=False)

    manager = await _get_manager()
    result = await manager.analyze_document(
        document_source=document_source,
        prompt=prompt,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
        max_pages=max_pages,
        mode=mode,  # type: ignore
        page_range=page_range_dict,
        auto_limit_tokens=auto_limit_tokens,
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
    - context_window: Token context limit
    - is_default_ask: Whether this is the default for ask()
    - is_default_vision: Whether this is the default for analyze_image()

    Useful for selecting the right model for your task.
    """
    manager = await _get_manager()
    models = manager.list_models()

    lines = ["# Available Models", ""]
    for m in models:
        model_id = m.get("id", "unknown")
        vision = m.get("vision", False)
        context = m.get("context_window", "unknown")
        desc = m.get("description", "")

        badges = []
        if m.get("is_default_ask"):
            badges.append("default-ask")
        if m.get("is_default_vision"):
            badges.append("default-vision")
        if vision:
            badges.append("vision")

        badge_str = f" [{', '.join(badges)}]" if badges else ""
        lines.append(f"## {model_id}{badge_str}")
        lines.append(f"- Model: {m.get('model_id', 'unknown')}")
        lines.append(f"- Context: {context:,} tokens" if isinstance(context, int) else f"- Context: {context}")
        lines.append(f"- Vision: {'Yes' if vision else 'No'}")
        if desc:
            lines.append(f"- Description: {desc}")
        lines.append("")

    return "\n".join(lines)


@mcp_server.tool()
async def install_libreoffice(force: bool = False, custom_path: str = "") -> str:
    """Vérifie si LibreOffice est installé et l'installe si nécessaire.

    LibreOffice est requis pour la conversion de fichiers PowerPoint (PPT/PPTX)
    en images pour l'analyse par le modèle de vision.

    Méthodes d'installation (par ordre de préférence):
    1. Chemin personnalisé (portable) - utiliser custom_path
    2. winget (Windows Package Manager) - recommandé sur Windows 11
    3. choco (Chocolatey) - alternative
    4. Téléchargement manuel - instructions fournies

    Args:
        force: Si True, réinstalle même si déjà présent (défaut: False)
        custom_path: Chemin vers une installation LibreOffice portable existante
                     (ex: "D:\\PortableApps\\PortableApps\\LibreOfficePortable\\LibreOfficePortable.exe")

    Returns:
        Statut de l'installation et instructions
    """
    import platform

    # If custom path provided, validate and configure it
    if custom_path:
        custom_path_obj = Path(custom_path)

        # Check if path exists
        if not custom_path_obj.exists():
            return f"❌ Chemin non trouvé: {custom_path}"

        # If it's a directory, look for the executable inside
        if custom_path_obj.is_dir():
            # Look for soffice.exe or LibreOfficePortable.exe in common locations
            for exe_name in ["soffice.exe", "program/soffice.exe", "LibreOfficePortable.exe"]:
                candidate = custom_path_obj / exe_name
                if candidate.exists():
                    custom_path = str(candidate)
                    custom_path_obj = candidate
                    break
            else:
                return f"❌ Aucun exécutable LibreOffice (soffice.exe/LibreOfficePortable.exe) trouvé dans: {custom_path}"

        # Validate it's a valid executable
        if custom_path_obj.suffix.lower() != ".exe":
            return f"❌ Le chemin doit pointer vers un exécutable (.exe): {custom_path}"

        if set_libreoffice_path(str(custom_path_obj)):
            log.info("Configured custom LibreOffice path: %s", custom_path)

            # Try to get version
            try:
                result = subprocess.run(
                    [custom_path, "--version"],
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                version = result.stdout.strip() or result.stderr.strip() or "(version inconnue)"
                return f"✅ LibreOffice configuré: {version}\nChemin: {custom_path}"
            except Exception as e:
                return f"✅ LibreOffice configuré: {custom_path}\n⚠️ Impossible de vérifier la version: {e}"
        else:
            return f"❌ Échec de la configuration du chemin: {custom_path}"

    # Check if already installed
    libreoffice_cmd = _find_libreoffice()

    if libreoffice_cmd and not force:
        # Verify version
        try:
            result = subprocess.run(
                [libreoffice_cmd, "--version"],
                capture_output=True,
                text=True,
                timeout=10
            )
            version = result.stdout.strip() or result.stderr.strip()
            return f"✅ LibreOffice déjà installé: {version}\nChemin: {libreoffice_cmd}"
        except Exception as e:
            log.warning("Failed to get LibreOffice version: %s", e)

    # Check platform
    if platform.system() != "Windows":
        return (
            "⚠️ Installation automatique uniquement sur Windows.\n"
            "Sur Linux: sudo apt install libreoffice\n"
            "Sur macOS: brew install --cask libreoffice"
        )

    # Try winget first (Windows 11 built-in)
    winget_path = shutil.which("winget")
    if winget_path:
        log.info("Installing LibreOffice via winget...")
        try:
            result = subprocess.run(
                [winget_path, "install", "TheDocumentFoundation.LibreOffice", "--accept-source-agreements", "--accept-package-agreements"],
                capture_output=True,
                text=True,
                timeout=300  # 5 minutes
            )
            if result.returncode == 0:
                return (
                    "✅ LibreOffice installé avec succès via winget!\n"
                    "Redémarrez votre terminal/VS Code pour utiliser la conversion PPT."
                )
            else:
                log.warning("winget install failed: %s", result.stderr)
        except subprocess.TimeoutExpired:
            return "❌ Installation via winget a expiré (>5min). Essayez manuellement."
        except Exception as e:
            log.warning("winget install error: %s", e)

    # Try chocolatey as fallback
    choco_path = shutil.which("choco")
    if choco_path:
        log.info("Installing LibreOffice via chocolatey...")
        try:
            result = subprocess.run(
                [choco_path, "install", "libreoffice", "-y"],
                capture_output=True,
                text=True,
                timeout=300
            )
            if result.returncode == 0:
                return (
                    "✅ LibreOffice installé avec succès via Chocolatey!\n"
                    "Redémarrez votre terminal/VS Code pour utiliser la conversion PPT."
                )
            else:
                log.warning("choco install failed: %s", result.stderr)
        except subprocess.TimeoutExpired:
            return "❌ Installation via Chocolatey a expiré (>5min). Essayez manuellement."
        except Exception as e:
            log.warning("choco install error: %s", e)

    # Manual installation instructions
    return (
        "❌ Impossible d'installer automatiquement LibreOffice.\n\n"
        "📋 Installation manuelle:\n"
        "1. Téléchargez depuis: https://www.libreoffice.org/download/\n"
        "2. Ou installez via PowerShell (admin):\n"
        "   winget install TheDocumentFoundation.LibreOffice\n"
        "3. Redémarrez VS Code après l'installation\n\n"
        "💡 Alternative: Si vous avez Scoop:\n"
        "   scoop bucket add extras && scoop install libreoffice\n\n"
        "💡 Pour une version portable, utilisez le paramètre custom_path:\n"
        "   install_libreoffice(custom_path='D:\\PortableApps\\...\\LibreOfficePortable.exe')"
    )


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
