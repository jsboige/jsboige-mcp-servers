#!/usr/bin/env python3
"""
Semantic Kernel MCP Agent v2.0 -- agent-centric MCP proxy.

Exposes AI agents (model + prompt + tools + optional memory) as MCP tools
for Claude Code / Roo Code.  Uses Semantic Kernel for orchestration so that
agents can autonomously call MCP-provided tools (SearXNG, Playwright, etc.)
and optionally persist knowledge via vector memory (Qdrant).

Architecture:
    Claude/Roo  --stdio-->  FastMCP server (this file)
                                  |
                                  v
                             SK Agent Manager
                             +-- Shared model pool (OpenAI clients)
                             +-- Shared MCP plugin pool
                             +-- Per-agent kernels with memory
                             +-- Conversation threads

Core tools:
    call_agent(prompt, agent?, attachment?, options?, ...)  -- unified agent call
    run_conversation(prompt, conversation?, options?)       -- multi-agent conversations
    list_agents()           -- list configured agents
    list_conversations()    -- list conversation presets
    list_tools()            -- list loaded MCP tools
    end_conversation(id)    -- cleanup thread
    install_libreoffice()   -- utility

Deprecated aliases (backward compat):
    ask, analyze_image, zoom_image, analyze_video, analyze_document, list_models

Configuration:
    SK_AGENT_CONFIG env var or default sk_agent_config.json next to this file.
    Supports v1 (model-centric) and v2 (agent-centric) config formats.
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

# Import config module
from sk_agent_config import (
    SKAgentConfig,
    AgentConfig,
    ModelConfig,
    McpConfig,
    load_config,
    CONFIG_PATH,
    SK_AGENT_DEPTH,
    DEFAULT_MAX_RECURSION_DEPTH,
)
from sk_conversations import ConversationRunner, build_run_conversation_description

# Optional: vector memory support
try:
    from semantic_kernel.memory import SemanticTextMemory, VolatileMemoryStore
    from semantic_kernel.connectors.ai.open_ai import OpenAITextEmbedding
    from semantic_kernel.core_plugins import TextMemoryPlugin
    HAS_MEMORY = True
except ImportError:
    HAS_MEMORY = False

try:
    from semantic_kernel.connectors.memory_stores.qdrant.qdrant_memory_store import QdrantMemoryStore
    HAS_QDRANT = True
except ImportError:
    try:
        from semantic_kernel.connectors.memory.qdrant import QdrantMemoryStore
        HAS_QDRANT = True
    except ImportError:
        HAS_QDRANT = False

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
# Attachment Classification
# ---------------------------------------------------------------------------

# File extension -> content type mapping
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".svg"}
_VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".flv", ".wmv"}
_DOCUMENT_EXTENSIONS = {".pdf", ".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx"}


def classify_attachment(path: str) -> str | None:
    """Classify an attachment by file extension or URL pattern.

    Returns: "image", "video", "document", or None (unknown/text-only).
    """
    if not path:
        return None

    # URL: check extension from URL path
    if path.startswith(("http://", "https://")):
        from urllib.parse import urlparse
        url_path = urlparse(path).path
        ext = Path(url_path).suffix.lower()
    else:
        ext = Path(path).suffix.lower()

    if ext in _IMAGE_EXTENSIONS:
        return "image"
    elif ext in _VIDEO_EXTENSIONS:
        return "video"
    elif ext in _DOCUMENT_EXTENSIONS:
        return "document"
    return None


# ---------------------------------------------------------------------------
# Image/Media Processing Helpers
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
# Dynamic Description Builders
# ---------------------------------------------------------------------------

def build_call_agent_description(config: SKAgentConfig) -> str:
    """Build dynamic description for call_agent tool from config."""
    lines = [
        "Send a prompt to an AI agent.",
        "",
        "Available agents:",
    ]

    for agent_cfg in config.agents:
        model = config.get_model(agent_cfg.model)
        if not model or not model.enabled:
            continue

        parts = [f"{model.model_id}, {model.context_window // 1000}K"]
        if model.vision:
            parts.append("vision")

        tools = agent_cfg.mcps
        badges = []
        if tools:
            badges.append(f"tools: {', '.join(tools)}")
        if agent_cfg.memory.enabled:
            badges.append("memory")

        badge_str = f" [{'; '.join(badges)}]" if badges else ""
        desc = agent_cfg.description or "No description"
        lines.append(f"  - {agent_cfg.id}: {desc} ({', '.join(parts)}){badge_str}")

    default_agent = config.get_default_agent()
    default_vision = config.get_default_vision_agent()
    if default_agent:
        default_info = f"Default: {default_agent.id}"
        if default_vision and default_vision.id != default_agent.id:
            default_info += f" | Default vision: {default_vision.id}"
        lines.append("")
        lines.append(default_info)

    lines.extend([
        "",
        "Parameters:",
        "  prompt: The question or instruction",
        "  agent: Agent ID (default: auto-select based on attachment type)",
        "  attachment: File path or URL (image, video, PDF, PPTX, DOCX, XLSX)",
        "  options: JSON string with type-specific params: region, mode, max_pages, page_range, num_frames",
        "  conversation_id: Continue previous conversation",
        "  include_steps: Show intermediate tool/reasoning steps",
    ])

    return "\n".join(lines)


def build_list_agents_description(config: SKAgentConfig) -> str:
    """Build dynamic description for list_agents tool."""
    count = len([a for a in config.agents if config.get_model(a.model) and config.get_model(a.model).enabled])
    return f"List all {count} configured agents with their models, capabilities, tools, and memory status."


# ---------------------------------------------------------------------------
# Semantic Kernel Agent Manager (v2: Agent-Centric)
# ---------------------------------------------------------------------------

class SKAgentManager:
    """Manages agent-centric resources: shared model/MCP pools and per-agent kernels."""

    def __init__(self, config: SKAgentConfig):
        self.config = config
        self._exit_stack = AsyncExitStack()

        # Shared resource pools
        self._openai_clients: dict[str, AsyncOpenAI] = {}       # model_id -> client
        self._services: dict[str, OpenAIChatCompletion] = {}     # model_id -> service
        self._mcp_plugins: dict[str, Any] = {}                   # mcp_id -> connected plugin
        self._mcp_plugin_list: list = []                         # Ordered list of all plugins

        # Per-agent resources
        self._kernels: dict[str, Kernel] = {}                    # agent_id -> kernel
        self._sk_agents: dict[str, ChatCompletionAgent] = {}     # agent_id -> SK agent

        # Conversation threads
        self._threads: dict[str, ChatHistoryAgentThread] = {}

        # Memory
        self._memory_stores: dict[str, Any] = {}                 # agent_id -> SemanticTextMemory

    async def start(self):
        """Initialize shared pools and per-agent resources."""
        # 1. Create shared model pool
        await self._init_model_pool()

        # 2. Load shared MCP plugins
        max_depth = self.config.max_recursion_depth
        if SK_AGENT_DEPTH < max_depth:
            await self._init_mcp_pool()
        else:
            log.info("Skipping MCP plugins (depth=%d >= max_depth=%d)", SK_AGENT_DEPTH, max_depth)

        # 3. Create per-agent resources
        for agent_cfg in self.config.agents:
            model = self.config.get_model(agent_cfg.model)
            if not model or not model.enabled:
                log.info("Skipping agent '%s': model '%s' not available", agent_cfg.id, agent_cfg.model)
                continue

            await self._create_agent(agent_cfg, model)

        log.info(
            "SK Agent Manager ready: %d agents, %d models, %d MCP plugins",
            len(self._sk_agents), len(self._openai_clients), len(self._mcp_plugins),
        )

    async def _init_model_pool(self):
        """Create OpenAI clients and services for each enabled model."""
        for model_cfg in self.config.models:
            if not model_cfg.enabled:
                continue

            api_key = model_cfg.resolve_api_key()
            client = AsyncOpenAI(api_key=api_key, base_url=model_cfg.base_url)
            self._openai_clients[model_cfg.id] = client

            service = OpenAIChatCompletion(
                ai_model_id=model_cfg.model_id,
                async_client=client,
                service_id=model_cfg.id,
            )
            self._services[model_cfg.id] = service
            log.info("Model pool: %s -> %s at %s", model_cfg.id, model_cfg.model_id, model_cfg.base_url)

    async def _init_mcp_pool(self):
        """Load all MCP plugins from config (shared pool)."""
        for mcp_cfg in self.config.mcps:
            try:
                env = {**os.environ, **mcp_cfg.env}

                # Detect self-inclusion
                mcp_args = " ".join(mcp_cfg.args)
                is_self = "sk_agent.py" in mcp_args or "sk_agent" in mcp_cfg.id.lower()

                if is_self:
                    env["SK_AGENT_DEPTH"] = str(SK_AGENT_DEPTH + 1)
                    log.info("Self-inclusion: spawning child sk-agent with depth=%d", SK_AGENT_DEPTH + 1)

                plugin = MCPStdioPlugin(
                    name=mcp_cfg.id,
                    description=mcp_cfg.description,
                    command=mcp_cfg.command,
                    args=mcp_cfg.args,
                    env=env,
                )
                connected = await self._exit_stack.enter_async_context(plugin)
                self._mcp_plugins[mcp_cfg.id] = connected
                self._mcp_plugin_list.append(connected)
                log.info("MCP pool: %s loaded", mcp_cfg.id)
            except Exception:
                log.exception("Failed to load MCP plugin: %s", mcp_cfg.id)

    async def _create_agent(self, agent_cfg: AgentConfig, model_cfg: ModelConfig):
        """Create a SK agent with its own kernel, model service, and plugins."""
        agent_id = agent_cfg.id

        # Create kernel with the agent's model service
        kernel = Kernel()
        service = self._services.get(model_cfg.id)
        if service:
            kernel.add_service(service)

        # Collect agent-specific MCP plugins
        agent_plugins = []
        for mcp_id in agent_cfg.mcps:
            if mcp_id in self._mcp_plugins:
                agent_plugins.append(self._mcp_plugins[mcp_id])

        # Set up memory if enabled
        if agent_cfg.memory.enabled and HAS_MEMORY:
            memory_plugin = await self._setup_memory(agent_cfg, kernel)
            if memory_plugin:
                agent_plugins.append(memory_plugin)

        # Create SK agent
        safe_name = agent_id.replace(".", "-").replace(" ", "-")
        system_prompt = agent_cfg.system_prompt or self.config.system_prompt

        # Augment prompt with memory hint if memory is active
        if agent_cfg.memory.enabled and HAS_MEMORY:
            system_prompt += (
                "\n\nYou have access to persistent memory. "
                "Use memory-save to remember important facts and "
                "memory-recall to retrieve relevant knowledge."
            )

        agent = ChatCompletionAgent(
            kernel=kernel,
            name=f"sk-agent-{safe_name}",
            instructions=system_prompt,
            plugins=agent_plugins,
        )
        self._kernels[agent_id] = kernel
        self._sk_agents[agent_id] = agent
        log.info("Agent created: %s (model=%s, mcps=%s, memory=%s)",
                 agent_id, model_cfg.id, agent_cfg.mcps, agent_cfg.memory.enabled)

    async def _setup_memory(self, agent_cfg: AgentConfig, kernel: Kernel) -> Any | None:
        """Set up vector memory for an agent. Returns TextMemoryPlugin or None."""
        emb = self.config.embeddings
        if not emb.is_configured:
            log.warning("Agent '%s' has memory enabled but embeddings not configured", agent_cfg.id)
            return None

        collection = agent_cfg.memory.collection or f"{agent_cfg.id}-memory"
        full_collection = f"{self.config.qdrant.default_collection_prefix}-{collection}"

        try:
            # Try Qdrant first
            if HAS_QDRANT:
                qdrant_kwargs: dict[str, Any] = {
                    "vector_size": emb.dimensions,
                    "url": self.config.qdrant.url,
                    "port": self.config.qdrant.port,
                }
                qdrant_api_key = self.config.qdrant.resolve_api_key()
                if qdrant_api_key:
                    qdrant_kwargs["api_key"] = qdrant_api_key
                store = QdrantMemoryStore(**qdrant_kwargs)
                log.info("Memory: using Qdrant for agent '%s' (collection=%s)", agent_cfg.id, full_collection)
            else:
                store = VolatileMemoryStore()
                log.warning("Memory: qdrant-client not installed, using volatile store for '%s'", agent_cfg.id)

            # Create embeddings generator
            emb_client = AsyncOpenAI(
                api_key=emb.resolve_api_key(),
                base_url=emb.base_url,
            )
            embeddings_gen = OpenAITextEmbedding(
                ai_model_id=emb.model_id,
                async_client=emb_client,
            )

            memory = SemanticTextMemory(
                storage=store,
                embeddings_generator=embeddings_gen,
            )
            self._memory_stores[agent_cfg.id] = memory

            plugin = TextMemoryPlugin(memory)
            return plugin

        except Exception:
            log.exception("Failed to set up memory for agent '%s'", agent_cfg.id)
            return None

    # -----------------------------------------------------------------------
    # Agent Resolution
    # -----------------------------------------------------------------------

    def _resolve_agent(
        self,
        agent_id: str | None = None,
        needs_vision: bool = False,
        model_id: str | None = None,
    ) -> tuple[str, ChatCompletionAgent] | tuple[None, None]:
        """Resolve which agent to use.

        Priority:
        1. Explicit agent_id
        2. Backward compat: model_id -> find agent using that model
        3. needs_vision -> default_vision_agent
        4. default_agent
        5. First available agent
        """
        if not self._sk_agents:
            return None, None

        # 1. Explicit agent_id
        if agent_id and agent_id in self._sk_agents:
            return agent_id, self._sk_agents[agent_id]

        # 2. Backward compat: model_id
        if model_id:
            agent_cfg = self.config.find_agent_for_model(model_id)
            if agent_cfg and agent_cfg.id in self._sk_agents:
                return agent_cfg.id, self._sk_agents[agent_cfg.id]

        # 3. Vision default
        if needs_vision:
            vision_cfg = self.config.get_default_vision_agent()
            if vision_cfg and vision_cfg.id in self._sk_agents:
                return vision_cfg.id, self._sk_agents[vision_cfg.id]

        # 4. Default agent
        default_cfg = self.config.get_default_agent()
        if default_cfg and default_cfg.id in self._sk_agents:
            return default_cfg.id, self._sk_agents[default_cfg.id]

        # 5. First available
        first_id = next(iter(self._sk_agents))
        return first_id, self._sk_agents[first_id]

    def _get_or_create_thread(self, conversation_id: str | None) -> tuple[str, ChatHistoryAgentThread]:
        """Get existing thread or create new one."""
        if conversation_id and conversation_id in self._threads:
            return conversation_id, self._threads[conversation_id]

        new_id = conversation_id or str(uuid.uuid4())
        thread = ChatHistoryAgentThread()
        self._threads[new_id] = thread
        return new_id, thread

    # -----------------------------------------------------------------------
    # Unified call_agent
    # -----------------------------------------------------------------------

    async def call_agent(
        self,
        prompt: str,
        agent_id: str | None = None,
        attachment: str | None = None,
        options: dict | None = None,
        conversation_id: str | None = None,
        include_steps: bool = False,
        # Backward compat params
        model_id: str | None = None,
    ) -> dict[str, Any]:
        """Unified agent invocation with optional attachment routing."""
        if not self._sk_agents:
            return {"error": "No agents initialized"}

        options = options or {}
        attachment_type = classify_attachment(attachment) if attachment else None
        needs_vision = attachment_type in ("image", "video", "document")

        # If mode=text for document, we don't necessarily need vision
        if attachment_type == "document" and options.get("mode") == "text":
            needs_vision = False

        # Resolve agent
        resolved_id, agent = self._resolve_agent(
            agent_id=agent_id,
            needs_vision=needs_vision,
            model_id=model_id,
        )

        if not resolved_id or not agent:
            return {"error": "No suitable agent available"}

        # Route based on attachment type
        if attachment_type == "image":
            region = options.get("region")
            if region:
                return await self._handle_image_region(
                    resolved_id, agent, attachment, region, prompt,
                    conversation_id, include_steps, options.get("zoom_context"),
                )
            else:
                return await self._handle_image(
                    resolved_id, agent, attachment, prompt,
                    conversation_id, include_steps,
                )
        elif attachment_type == "video":
            return await self._handle_video(
                resolved_id, agent, attachment, prompt,
                conversation_id, include_steps, options.get("num_frames", 8),
            )
        elif attachment_type == "document":
            return await self._handle_document(
                resolved_id, agent, attachment, prompt,
                conversation_id, include_steps, options,
            )
        else:
            return await self._handle_text(
                resolved_id, agent, prompt,
                conversation_id, include_steps,
            )

    # -----------------------------------------------------------------------
    # Handler Methods
    # -----------------------------------------------------------------------

    async def _handle_text(
        self,
        agent_id: str,
        agent: ChatCompletionAgent,
        prompt: str,
        conversation_id: str | None,
        include_steps: bool,
    ) -> dict[str, Any]:
        """Handle text-only prompt."""
        conv_id, thread = self._get_or_create_thread(conversation_id)
        items = [TextContent(text=prompt)]
        message = ChatMessageContent(role=AuthorRole.USER, items=items)

        steps = []
        final_response = None
        async for response in agent.invoke(
            messages=message,
            thread=thread,
            on_intermediate_message=self._make_step_handler(steps) if include_steps else None,
        ):
            final_response = response
            thread = response.thread

        self._threads[conv_id] = thread
        result = {
            "response": str(final_response) if final_response else "",
            "conversation_id": conv_id,
            "agent_used": agent_id,
            "model_used": self._get_agent_model_id(agent_id),
        }
        if include_steps:
            result["steps"] = steps
        return result

    async def _handle_image(
        self,
        agent_id: str,
        agent: ChatCompletionAgent,
        image_source: str,
        prompt: str,
        conversation_id: str | None,
        include_steps: bool,
    ) -> dict[str, Any]:
        """Handle image analysis."""
        try:
            b64_data, media_type = await resolve_attachment(image_source)
            data_url = f"data:{media_type};base64,{b64_data}"
            image_item = ImageContent(data_uri=data_url)

            conv_id, thread = self._get_or_create_thread(conversation_id)
            items = [image_item, TextContent(text=prompt)]
            message = ChatMessageContent(role=AuthorRole.USER, items=items)

            steps = []
            final_response = None
            async for response in agent.invoke(
                messages=message,
                thread=thread,
                on_intermediate_message=self._make_step_handler(steps) if include_steps else None,
            ):
                final_response = response
                thread = response.thread

            self._threads[conv_id] = thread
            result = {
                "response": str(final_response) if final_response else "",
                "conversation_id": conv_id,
                "agent_used": agent_id,
                "model_used": self._get_agent_model_id(agent_id),
            }
            if include_steps:
                result["steps"] = steps
            return result
        except Exception as e:
            return {"error": str(e)}

    async def _handle_image_region(
        self,
        agent_id: str,
        agent: ChatCompletionAgent,
        image_source: str,
        region: dict,
        prompt: str,
        conversation_id: str | None,
        include_steps: bool,
        zoom_context: str | None = None,
    ) -> dict[str, Any]:
        """Handle image region analysis (zoom)."""
        try:
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

            cropped_data, cropped_type = _crop_image(data, media_type, region)
            cropped_data, cropped_type = _resize_image_if_needed(cropped_data, cropped_type)

            context_msg = prompt
            if zoom_context:
                context_msg = f"[Zoom context: {zoom_context}]\n\n{prompt}"

            b64_data = base64.b64encode(cropped_data).decode("ascii")
            data_url = f"data:{cropped_type};base64,{b64_data}"
            image_item = ImageContent(data_uri=data_url)

            conv_id, thread = self._get_or_create_thread(conversation_id)
            items = [image_item, TextContent(text=context_msg)]
            message = ChatMessageContent(role=AuthorRole.USER, items=items)

            steps = []
            final_response = None
            async for response in agent.invoke(
                messages=message,
                thread=thread,
                on_intermediate_message=self._make_step_handler(steps) if include_steps else None,
            ):
                final_response = response
                thread = response.thread

            self._threads[conv_id] = thread
            result = {
                "response": str(final_response) if final_response else "",
                "conversation_id": conv_id,
                "agent_used": agent_id,
                "model_used": self._get_agent_model_id(agent_id),
                "region_analyzed": region,
            }
            if zoom_context:
                result["zoom_context"] = zoom_context
            if include_steps:
                result["steps"] = steps
            return result
        except Exception as e:
            return {"error": str(e)}

    async def _handle_video(
        self,
        agent_id: str,
        agent: ChatCompletionAgent,
        video_source: str,
        prompt: str,
        conversation_id: str | None,
        include_steps: bool,
        num_frames: int = 8,
    ) -> dict[str, Any]:
        """Handle video analysis."""
        video_path = Path(video_source)
        if not video_path.exists():
            return {"error": f"Video file not found: {video_source}"}

        video_info = _get_video_info(str(video_path))
        num_frames = max(1, min(num_frames, 20))

        try:
            frames = _extract_keyframes(str(video_path), num_frames=num_frames)
            if not frames:
                frames = _extract_video_frames(str(video_path), num_frames=num_frames)
        except Exception as e:
            return {"error": f"Failed to extract video frames: {e}"}

        if not frames:
            return {"error": "No frames could be extracted from video"}

        conv_id, thread = self._get_or_create_thread(conversation_id)

        content_items = [TextContent(text=f"{prompt}\n\nThe video has {len(frames)} frames:")]
        for i, (frame_data, media_type) in enumerate(frames):
            b64_data = base64.b64encode(frame_data).decode("ascii")
            data_url = f"data:{media_type};base64,{b64_data}"
            content_items.append(TextContent(text=f"\n[Frame {i + 1}]"))
            content_items.append(ImageContent(data_uri=data_url))

        message = ChatMessageContent(role=AuthorRole.USER, items=content_items)

        steps = []
        final_response = None
        async for response in agent.invoke(
            messages=message,
            thread=thread,
            on_intermediate_message=self._make_step_handler(steps) if include_steps else None,
        ):
            final_response = response
            thread = response.thread

        self._threads[conv_id] = thread
        result = {
            "response": str(final_response) if final_response else "",
            "conversation_id": conv_id,
            "agent_used": agent_id,
            "model_used": self._get_agent_model_id(agent_id),
            "frames_analyzed": len(frames),
        }
        if video_info:
            result["video_info"] = {
                "duration": video_info.duration,
                "resolution": f"{video_info.width}x{video_info.height}",
            }
        if include_steps:
            result["steps"] = steps
        return result

    async def _handle_document(
        self,
        agent_id: str,
        agent: ChatCompletionAgent,
        document_source: str,
        prompt: str,
        conversation_id: str | None,
        include_steps: bool,
        options: dict,
    ) -> dict[str, Any]:
        """Handle document analysis."""
        mode = options.get("mode", "visual")
        max_pages = max(1, min(options.get("max_pages", DEFAULT_MAX_PAGES), MAX_PAGES_HARD_LIMIT))
        auto_limit_tokens = options.get("auto_limit_tokens", True)

        if mode not in ("visual", "text", "hybrid"):
            return {"error": f"Invalid mode '{mode}'. Must be: visual, text, or hybrid"}

        # Get context window for auto-limiting
        model_id = self._get_agent_model_id(agent_id)
        model_cfg = self.config.get_model(model_id) if model_id else None
        context_window = model_cfg.context_window if (auto_limit_tokens and model_cfg) else None

        # Parse page range
        range_obj = None
        page_range = options.get("page_range")
        if page_range:
            if isinstance(page_range, str):
                page_range = json.loads(page_range)
            range_obj = PageRange(start=page_range.get("start", 1), end=page_range.get("end"))

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

        has_images = any(p.has_image for p in pages)
        needs_vision = has_images or mode == "visual"

        if needs_vision and model_cfg and not model_cfg.vision:
            return {"error": "Agent's model does not support vision for visual/hybrid mode"}

        content_items = [TextContent(text=f"{prompt}\n\nThe document has {len(pages)} page(s):")]
        for page in pages:
            page_label = f"Page {page.page_number}"
            if page.metadata and page.metadata.get("sheet_name"):
                page_label = f"Sheet '{page.metadata['sheet_name']}'"
            elif page.metadata and page.metadata.get("source") == "all_slides":
                page_label = "All slides"
            content_items.append(TextContent(text=f"\n--- {page_label} ---"))

            if page.has_text:
                content_items.append(TextContent(text=page.text_content))
            if page.has_image:
                b64_data = base64.b64encode(page.image_data).decode("ascii")
                data_url = f"data:{page.media_type};base64,{b64_data}"
                content_items.append(ImageContent(data_uri=data_url))

        conv_id, thread = self._get_or_create_thread(conversation_id)
        message = ChatMessageContent(role=AuthorRole.USER, items=content_items)

        steps = []
        final_response = None
        async for response in agent.invoke(
            messages=message,
            thread=thread,
            on_intermediate_message=self._make_step_handler(steps) if include_steps else None,
        ):
            final_response = response
            thread = response.thread

        self._threads[conv_id] = thread
        result = {
            "response": str(final_response) if final_response else "",
            "conversation_id": conv_id,
            "agent_used": agent_id,
            "model_used": self._get_agent_model_id(agent_id),
            "pages_analyzed": len(pages),
            "mode": mode,
        }
        if include_steps:
            result["steps"] = steps
        return result

    # -----------------------------------------------------------------------
    # Utility Methods
    # -----------------------------------------------------------------------

    def _make_step_handler(self, steps: list):
        """Create a step handler callback for agent invocation."""
        async def handler(message) -> None:
            step_info = {"role": str(message.role)}
            for item in message.items:
                if isinstance(item, FunctionCallContent):
                    step_info["type"] = "tool_call"
                    step_info["name"] = item.function_name
                    step_info["arguments"] = item.arguments
                elif isinstance(item, FunctionResultContent):
                    step_info["type"] = "tool_result"
                    step_info["result"] = str(item.result)[:500]
                elif isinstance(item, TextContent):
                    step_info["type"] = "text"
                    step_info["content"] = item.text[:200]
            if "type" in step_info:
                steps.append(step_info)
        return handler

    def _get_agent_model_id(self, agent_id: str) -> str:
        """Get the model ID for an agent."""
        agent_cfg = self.config.get_agent(agent_id)
        return agent_cfg.model if agent_cfg else ""

    def list_agents(self) -> list[dict]:
        """Return list of configured agents with capabilities."""
        result = []
        default_agent = self.config.get_default_agent()
        default_vision = self.config.get_default_vision_agent()

        for agent_cfg in self.config.agents:
            model = self.config.get_model(agent_cfg.model)
            if not model or not model.enabled:
                continue

            info = {
                "id": agent_cfg.id,
                "description": agent_cfg.description,
                "model": agent_cfg.model,
                "model_id": model.model_id,
                "vision": model.vision,
                "context_window": model.context_window,
                "mcps": agent_cfg.mcps,
                "memory": agent_cfg.memory.enabled,
                "is_default": default_agent and agent_cfg.id == default_agent.id,
                "is_default_vision": default_vision and agent_cfg.id == default_vision.id,
            }
            result.append(info)
        return result

    def list_loaded_tools(self) -> str:
        """Return description of all loaded MCP plugins and their tools."""
        if not self._kernels:
            return "No kernels initialized."

        first_kernel = next(iter(self._kernels.values()))
        lines = []
        for plugin_name, plugin in first_kernel.plugins.items():
            lines.append(f"## {plugin_name}")
            if hasattr(plugin, "description") and plugin.description:
                lines.append(f"  {plugin.description}")
            for fn_name, fn in plugin.functions.items():
                desc = fn.description or ""
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
        self._mcp_plugins.clear()
        self._mcp_plugin_list.clear()
        self._threads.clear()
        self._kernels.clear()
        self._sk_agents.clear()
        self._openai_clients.clear()
        self._services.clear()
        self._memory_stores.clear()
        log.info("SK Agent Manager stopped")


# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------

mcp_server = FastMCP(
    "sk-agent",
    instructions=(
        "An agent-centric proxy to local LLMs with tools, memory, and multi-agent conversations. "
        "Use 'call_agent' for all queries. Pass 'attachment' for images/videos/documents. "
        "Use 'list_agents' to see available agents. "
        "Pass conversation_id to continue a previous conversation."
    ),
)

# Global manager instance
_manager: SKAgentManager | None = None
_config: SKAgentConfig | None = None
_conversation_runner: ConversationRunner | None = None


async def _get_manager() -> SKAgentManager:
    """Get or create the global manager instance."""
    global _manager, _config, _conversation_runner
    if _manager is None:
        _config = load_config()
        _manager = SKAgentManager(_config)
        await _manager.start()
        # Create conversation runner with the manager's agents
        _conversation_runner = ConversationRunner(_config, _manager._sk_agents)
        # Update tool descriptions dynamically
        _update_tool_descriptions(_config)
    return _manager


async def _get_conversation_runner() -> ConversationRunner:
    """Get the conversation runner (initializes manager if needed)."""
    global _conversation_runner
    await _get_manager()
    assert _conversation_runner is not None
    return _conversation_runner


def _update_tool_descriptions(config: SKAgentConfig):
    """Mutate tool descriptions after manager init to reflect live config."""
    try:
        tool_manager = mcp_server._tool_manager
        tools = tool_manager._tools

        if "call_agent" in tools:
            tools["call_agent"].description = build_call_agent_description(config)
            log.info("Updated call_agent description dynamically")

        if "list_agents" in tools:
            tools["list_agents"].description = build_list_agents_description(config)

        if "run_conversation" in tools:
            tools["run_conversation"].description = build_run_conversation_description(config)
            log.info("Updated run_conversation description dynamically")
    except Exception:
        log.exception("Failed to update tool descriptions dynamically")


# ---------------------------------------------------------------------------
# Core Tools
# ---------------------------------------------------------------------------

@mcp_server.tool()
async def call_agent(
    prompt: str,
    agent: str = "",
    attachment: str = "",
    options: str = "",
    conversation_id: str = "",
    include_steps: bool = False,
) -> str:
    """Send a prompt to an AI agent.

    Available agents and capabilities are listed dynamically.
    Use list_agents() for details.

    Args:
        prompt: The question or instruction.
        agent: Agent ID (default: auto-select based on attachment type).
        attachment: File path or URL (image, video, PDF, PPTX, DOCX, XLSX).
        options: JSON string with type-specific params (region, mode, max_pages, page_range, num_frames).
        conversation_id: Continue previous conversation.
        include_steps: Show intermediate tool/reasoning steps.

    Returns:
        JSON string with: response, conversation_id, agent_used, model_used, and type-specific fields.
    """
    manager = await _get_manager()

    opts = {}
    if options:
        try:
            opts = json.loads(options)
        except json.JSONDecodeError:
            return json.dumps({"error": "Invalid options JSON"}, ensure_ascii=False)

    result = await manager.call_agent(
        prompt=prompt,
        agent_id=agent if agent else None,
        attachment=attachment if attachment else None,
        options=opts,
        conversation_id=conversation_id if conversation_id else None,
        include_steps=include_steps,
    )
    return json.dumps(result, ensure_ascii=False)


@mcp_server.tool()
async def list_agents() -> str:
    """List all configured agents.

    Returns information about each agent including model, vision capability,
    tools, memory status, and whether it's the default.
    """
    manager = await _get_manager()
    agents = manager.list_agents()

    lines = ["# Available Agents", ""]
    for a in agents:
        badges = []
        if a.get("is_default"):
            badges.append("default")
        if a.get("is_default_vision"):
            badges.append("default-vision")
        if a.get("vision"):
            badges.append("vision")
        if a.get("memory"):
            badges.append("memory")

        badge_str = f" [{', '.join(badges)}]" if badges else ""
        lines.append(f"## {a['id']}{badge_str}")
        lines.append(f"- Model: {a.get('model_id', 'unknown')} ({a.get('model', '')})")
        ctx = a.get("context_window", 0)
        lines.append(f"- Context: {ctx:,} tokens" if isinstance(ctx, int) else f"- Context: {ctx}")
        lines.append(f"- Vision: {'Yes' if a.get('vision') else 'No'}")
        if a.get("mcps"):
            lines.append(f"- Tools: {', '.join(a['mcps'])}")
        if a.get("description"):
            lines.append(f"- Description: {a['description']}")
        lines.append("")

    return "\n".join(lines)


@mcp_server.tool()
async def list_tools() -> str:
    """List all MCP plugins and tools available to the local LLM.

    Useful for debugging and understanding what tools the model can use.
    """
    manager = await _get_manager()
    return manager.list_loaded_tools()


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


@mcp_server.tool()
async def install_libreoffice(force: bool = False, custom_path: str = "") -> str:
    """Check if LibreOffice is installed and install if needed.

    LibreOffice is required for converting PowerPoint (PPT/PPTX), Word (DOC/DOCX),
    and Excel (XLS/XLSX) files to images for vision model analysis.

    Args:
        force: Reinstall even if already present (default: False).
        custom_path: Path to an existing LibreOffice portable installation.

    Returns:
        Installation status and instructions.
    """
    import platform

    if custom_path:
        custom_path_obj = Path(custom_path)
        if not custom_path_obj.exists():
            return f"Path not found: {custom_path}"

        if custom_path_obj.is_dir():
            for exe_name in ["soffice.exe", "program/soffice.exe", "LibreOfficePortable.exe"]:
                candidate = custom_path_obj / exe_name
                if candidate.exists():
                    custom_path = str(candidate)
                    custom_path_obj = candidate
                    break
            else:
                return f"No LibreOffice executable found in: {custom_path}"

        if custom_path_obj.suffix.lower() != ".exe":
            return f"Path must point to an executable (.exe): {custom_path}"

        if set_libreoffice_path(str(custom_path_obj)):
            try:
                result = subprocess.run(
                    [custom_path, "--version"], capture_output=True, text=True, timeout=10
                )
                version = result.stdout.strip() or result.stderr.strip() or "(unknown version)"
                return f"LibreOffice configured: {version}\nPath: {custom_path}"
            except Exception as e:
                return f"LibreOffice configured: {custom_path}\nCould not verify version: {e}"
        else:
            return f"Failed to configure path: {custom_path}"

    libreoffice_cmd = _find_libreoffice()
    if libreoffice_cmd and not force:
        try:
            result = subprocess.run(
                [libreoffice_cmd, "--version"], capture_output=True, text=True, timeout=10
            )
            version = result.stdout.strip() or result.stderr.strip()
            return f"LibreOffice already installed: {version}\nPath: {libreoffice_cmd}"
        except Exception as e:
            log.warning("Failed to get LibreOffice version: %s", e)

    if platform.system() != "Windows":
        return (
            "Auto-install only on Windows.\n"
            "Linux: sudo apt install libreoffice\n"
            "macOS: brew install --cask libreoffice"
        )

    winget_path = shutil.which("winget")
    if winget_path:
        try:
            result = subprocess.run(
                [winget_path, "install", "TheDocumentFoundation.LibreOffice",
                 "--accept-source-agreements", "--accept-package-agreements"],
                capture_output=True, text=True, timeout=300,
            )
            if result.returncode == 0:
                return "LibreOffice installed via winget! Restart your terminal/VS Code."
        except subprocess.TimeoutExpired:
            return "Installation via winget timed out (>5min)."
        except Exception:
            pass

    choco_path = shutil.which("choco")
    if choco_path:
        try:
            result = subprocess.run(
                [choco_path, "install", "libreoffice", "-y"],
                capture_output=True, text=True, timeout=300,
            )
            if result.returncode == 0:
                return "LibreOffice installed via Chocolatey! Restart your terminal/VS Code."
        except subprocess.TimeoutExpired:
            return "Installation via Chocolatey timed out (>5min)."
        except Exception:
            pass

    return (
        "Could not install LibreOffice automatically.\n\n"
        "Manual install:\n"
        "1. Download: https://www.libreoffice.org/download/\n"
        "2. Or via PowerShell (admin): winget install TheDocumentFoundation.LibreOffice\n"
        "3. Restart VS Code after installation\n\n"
        "For portable version, use custom_path parameter."
    )


# ---------------------------------------------------------------------------
# Conversation Tools
# ---------------------------------------------------------------------------

@mcp_server.tool()
async def run_conversation(
    prompt: str,
    conversation: str = "",
    options: str = "",
    conversation_id: str = "",
) -> str:
    """Run a multi-agent conversation.

    Available conversations are listed dynamically.
    Use list_conversations() for details.

    Args:
        prompt: The research question or topic to deliberate.
        conversation: Conversation preset ID (default: deep-search).
        options: JSON string with overrides (max_rounds).
        conversation_id: Reserved for future thread continuity.

    Returns:
        JSON string with: response, conversation_type, agents_used, rounds, steps.
    """
    runner = await _get_conversation_runner()

    opts = {}
    if options:
        try:
            opts = json.loads(options)
        except json.JSONDecodeError:
            return json.dumps({"error": "Invalid options JSON"}, ensure_ascii=False)

    result = await runner.run(
        prompt=prompt,
        conversation_id=conversation if conversation else None,
        options=opts,
    )
    return json.dumps(result, ensure_ascii=False)


@mcp_server.tool()
async def list_conversations() -> str:
    """List available multi-agent conversation presets.

    Shows conversation ID, type, participating agents, and max rounds.
    """
    runner = await _get_conversation_runner()
    conversations = runner.list_conversations()

    lines = ["# Available Conversations", ""]
    for conv in conversations:
        badges = []
        if conv.get("builtin"):
            badges.append("built-in")
        badges.append(conv.get("type", "unknown"))

        badge_str = f" [{', '.join(badges)}]"
        agents_str = ", ".join(conv.get("agents", []))
        lines.append(f"## {conv['id']}{badge_str}")
        lines.append(f"- Description: {conv.get('description', '')}")
        lines.append(f"- Agents: {agents_str}")
        lines.append(f"- Max rounds: {conv.get('max_rounds', 'N/A')}")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Deprecated Aliases (backward compatibility)
# ---------------------------------------------------------------------------

@mcp_server.tool()
async def ask(
    prompt: str,
    model: str = "",
    conversation_id: str = "",
    system_prompt: str = "",
    include_steps: bool = False,
) -> str:
    """[DEPRECATED - Use call_agent instead] Send a text prompt to the local LLM.

    Args:
        prompt: The user question or instruction.
        model: Optional model ID. Uses default if not specified.
        conversation_id: Optional conversation ID to continue.
        system_prompt: Optional override for the system prompt.
        include_steps: If True, include intermediate steps.

    Returns:
        JSON string with: response, conversation_id, model_used
    """
    manager = await _get_manager()
    result = await manager.call_agent(
        prompt=prompt,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
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
    """[DEPRECATED - Use call_agent with attachment instead] Analyze an image.

    Args:
        image_source: Path to image file or URL.
        prompt: Question about the image.
        model: Optional vision model ID.
        conversation_id: Continue previous conversation.
        zoom_context: Optional zoom context JSON.

    Returns:
        JSON string with: response, conversation_id, model_used
    """
    manager = await _get_manager()
    opts = {}
    if zoom_context:
        opts["zoom_context"] = zoom_context
    result = await manager.call_agent(
        prompt=prompt,
        attachment=image_source,
        options=opts if opts else None,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
    )
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
    """[DEPRECATED - Use call_agent with attachment+options.region instead] Zoom into image region.

    Args:
        image_source: Path to image file or URL.
        region: JSON string with crop region.
        prompt: Question about the region.
        model: Optional vision model ID.
        conversation_id: Continue previous conversation.
        zoom_context: Previous zoom context.

    Returns:
        JSON string with: response, conversation_id, model_used, region_analyzed
    """
    try:
        region_dict = json.loads(region)
    except json.JSONDecodeError:
        return json.dumps({"error": "Invalid region JSON"}, ensure_ascii=False)

    manager = await _get_manager()
    opts = {"region": region_dict}
    if zoom_context:
        opts["zoom_context"] = zoom_context
    result = await manager.call_agent(
        prompt=prompt,
        attachment=image_source,
        options=opts,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
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
    """[DEPRECATED - Use call_agent with attachment instead] Analyze a video.

    Args:
        video_source: Path to video file.
        prompt: Question about the video.
        model: Optional vision model ID.
        conversation_id: Continue previous conversation.
        num_frames: Number of frames to extract (default: 8, max: 20).

    Returns:
        JSON string with: response, conversation_id, model_used, frames_analyzed
    """
    manager = await _get_manager()
    result = await manager.call_agent(
        prompt=prompt,
        attachment=video_source,
        options={"num_frames": max(1, min(num_frames, 20))},
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
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
    """[DEPRECATED - Use call_agent with attachment+options instead] Analyze a document.

    Args:
        document_source: Path to document file.
        prompt: Question about the document.
        model: Optional model ID.
        conversation_id: Continue previous conversation.
        max_pages: Max pages to analyze (default: 10, max: 50).
        mode: Analysis mode - visual, text, or hybrid.
        page_range: JSON with page range.
        auto_limit_tokens: Auto-limit pages by context window.

    Returns:
        JSON string with: response, conversation_id, model_used, pages_analyzed, mode
    """
    opts: dict[str, Any] = {
        "mode": mode,
        "max_pages": max_pages,
        "auto_limit_tokens": auto_limit_tokens,
    }
    if page_range:
        try:
            opts["page_range"] = json.loads(page_range)
        except json.JSONDecodeError:
            return json.dumps({"error": "Invalid page_range JSON"}, ensure_ascii=False)

    manager = await _get_manager()
    result = await manager.call_agent(
        prompt=prompt,
        attachment=document_source,
        options=opts,
        model_id=model if model else None,
        conversation_id=conversation_id if conversation_id else None,
    )
    return json.dumps(result, ensure_ascii=False)


@mcp_server.tool()
async def list_models() -> str:
    """[DEPRECATED - Use list_agents instead] List configured models.

    Returns model information. For agent-centric view, use list_agents().
    """
    manager = await _get_manager()
    agents = manager.list_agents()

    lines = ["# Available Models (via agents)", ""]
    for a in agents:
        badges = []
        if a.get("is_default"):
            badges.append("default-ask")
        if a.get("is_default_vision"):
            badges.append("default-vision")
        if a.get("vision"):
            badges.append("vision")

        badge_str = f" [{', '.join(badges)}]" if badges else ""
        lines.append(f"## {a.get('model', 'unknown')}{badge_str}")
        lines.append(f"- Model: {a.get('model_id', 'unknown')}")
        ctx = a.get("context_window", 0)
        lines.append(f"- Context: {ctx:,} tokens" if isinstance(ctx, int) else f"- Context: {ctx}")
        lines.append(f"- Vision: {'Yes' if a.get('vision') else 'No'}")
        if a.get("description"):
            lines.append(f"- Description: {a['description']}")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    log.info("Starting sk-agent MCP server v2.0 (config: %s, depth=%d)", CONFIG_PATH, SK_AGENT_DEPTH)
    mcp_server.run(transport="stdio")


if __name__ == "__main__":
    main()
