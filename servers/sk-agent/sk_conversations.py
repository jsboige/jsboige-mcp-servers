"""
Multi-agent conversation runner for sk-agent v2.0.

Uses Semantic Kernel's AgentGroupChat to orchestrate conversations
between multiple agents with configurable selection and termination
strategies.

Supported conversation types:
  - sequential: Each agent speaks once, in order (pipeline)
  - group_chat: Round-robin for N rounds
  - magentic: LLM-driven selection (smart manager picks next speaker)
  - concurrent: All agents run in parallel on the same prompt

DeepSearch and DeepThink are built-in conversation presets.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from semantic_kernel import Kernel
from semantic_kernel.agents import AgentGroupChat, ChatCompletionAgent
from semantic_kernel.agents.strategies import (
    DefaultTerminationStrategy,
    SequentialSelectionStrategy,
)
from semantic_kernel.contents import ChatMessageContent, AuthorRole

from sk_agent_config import SKAgentConfig, AgentConfig, ConversationConfig

log = logging.getLogger("sk-agent.conversations")


# ---------------------------------------------------------------------------
# Built-in Conversation Presets
# ---------------------------------------------------------------------------

DEEP_SEARCH_PRESET = ConversationConfig(
    id="deep-search",
    description="Multi-agent deep research with search, synthesis, and critical review",
    type="magentic",
    agents=["researcher", "synthesizer", "critic"],
    max_rounds=10,
    inline_agents=[
        AgentConfig(
            id="researcher",
            description="Finds information from multiple web sources",
            model="",  # Uses first available model
            system_prompt=(
                "You are a research specialist. Break queries into sub-questions, "
                "search for each, collect diverse sources. Return structured findings "
                "with citations. Never fabricate sources."
            ),
            mcps=[],  # Will inherit available MCPs at runtime
        ),
        AgentConfig(
            id="synthesizer",
            description="Synthesizes research findings into coherent reports",
            model="",
            system_prompt=(
                "Given raw research findings: identify key themes, resolve contradictions "
                "between sources, organize into a coherent narrative. Maintain citations "
                "throughout. Output a structured report."
            ),
        ),
        AgentConfig(
            id="critic",
            description="Reviews reports for quality, gaps, and accuracy",
            model="",
            system_prompt=(
                "Review critically: identify unsupported claims, find logical gaps or "
                "contradictions, assess source quality. If quality is sufficient, respond "
                "with APPROVED. Otherwise, list specific improvements needed."
            ),
        ),
    ],
)

DEEP_THINK_PRESET = ConversationConfig(
    id="deep-think",
    description="Multi-perspective deliberation with diverse viewpoints and synthesis",
    type="group_chat",
    agents=["optimist", "devils-advocate", "pragmatist", "synthesizer-dt"],
    max_rounds=8,
    inline_agents=[
        AgentConfig(
            id="optimist",
            description="Opportunity-focused analyst",
            model="",
            system_prompt=(
                "You are an optimistic analyst. Identify opportunities, potential benefits, "
                "best-case scenarios. Be constructive but honest - don't ignore real risks, "
                "just emphasize the upside."
            ),
        ),
        AgentConfig(
            id="devils-advocate",
            description="Critical risk analyst",
            model="",
            system_prompt=(
                "You are a devil's advocate. Challenge assumptions, identify risks, "
                "worst-case scenarios, hidden costs, and potential failures. Be rigorous "
                "but fair - acknowledge genuine strengths too."
            ),
        ),
        AgentConfig(
            id="pragmatist",
            description="Implementation-focused realist",
            model="",
            system_prompt=(
                "You are a pragmatic analyst. Focus on what's realistic, implementable, "
                "and cost-effective. Consider timelines, resources, dependencies. Bridge "
                "the gap between optimism and criticism."
            ),
        ),
        AgentConfig(
            id="synthesizer-dt",
            description="Balanced synthesizer of all perspectives",
            model="",
            system_prompt=(
                "Given analyses from multiple perspectives (optimist, critic, pragmatist), "
                "create a balanced synthesis. Weigh each perspective fairly, highlight "
                "consensus points, clearly state unresolved tensions, and recommend a "
                "course of action."
            ),
        ),
    ],
)

PRESETS: dict[str, ConversationConfig] = {
    "deep-search": DEEP_SEARCH_PRESET,
    "deep-think": DEEP_THINK_PRESET,
}


# ---------------------------------------------------------------------------
# Conversation Runner
# ---------------------------------------------------------------------------

class ConversationRunner:
    """Runs multi-agent conversations using SK AgentGroupChat."""

    def __init__(self, config: SKAgentConfig, sk_agents: dict[str, ChatCompletionAgent]):
        """
        Args:
            config: The full agent config (for model/agent lookups).
            sk_agents: Map of agent_id -> initialized ChatCompletionAgent from SKAgentManager.
        """
        self.config = config
        self.sk_agents = sk_agents

    def list_conversations(self) -> list[dict]:
        """List available conversation presets."""
        result = []

        # Config-defined conversations
        for conv in self.config.conversations:
            result.append(self._describe_conversation(conv))

        # Built-in presets (if not overridden by config)
        config_ids = {c.id for c in self.config.conversations}
        for preset_id, preset in PRESETS.items():
            if preset_id not in config_ids:
                info = self._describe_conversation(preset)
                info["builtin"] = True
                result.append(info)

        return result

    def _describe_conversation(self, conv: ConversationConfig) -> dict:
        return {
            "id": conv.id,
            "description": conv.description,
            "type": conv.type,
            "agents": conv.agents,
            "max_rounds": conv.max_rounds,
        }

    async def run(
        self,
        prompt: str,
        conversation_id: str | None = None,
        options: dict | None = None,
    ) -> dict[str, Any]:
        """Run a multi-agent conversation.

        Args:
            prompt: The task/question for the agents.
            conversation_id: ID of the conversation preset to run.
            options: Override options (max_rounds, etc.).

        Returns:
            Dict with response, agents_used, conversation_type, steps.
        """
        options = options or {}

        # Resolve conversation config
        conv_config = self._resolve_conversation(conversation_id)
        if not conv_config:
            available = [c.id for c in self.config.conversations] + list(PRESETS.keys())
            return {"error": f"Conversation '{conversation_id}' not found. Available: {available}"}

        max_rounds = options.get("max_rounds", conv_config.max_rounds)

        # Resolve agents for this conversation
        agents = self._resolve_conversation_agents(conv_config)
        if not agents:
            return {"error": f"No agents available for conversation '{conv_config.id}'"}

        # Build and run the group chat
        try:
            if conv_config.type == "concurrent":
                return await self._run_concurrent(prompt, agents, conv_config)
            else:
                return await self._run_group_chat(prompt, agents, conv_config, max_rounds)
        except Exception as e:
            log.exception("Conversation '%s' failed", conv_config.id)
            return {"error": str(e)}

    def _resolve_conversation(self, conversation_id: str | None) -> ConversationConfig | None:
        """Find conversation config by ID."""
        cid = conversation_id or "deep-search"

        # Check config-defined conversations first
        for conv in self.config.conversations:
            if conv.id == cid:
                return conv

        # Check built-in presets
        return PRESETS.get(cid)

    def _resolve_conversation_agents(
        self, conv_config: ConversationConfig,
    ) -> list[ChatCompletionAgent]:
        """Resolve agent references to actual SK agents.

        Priority:
        1. Inline agent definitions (conversation-scoped)
        2. Top-level agents from config (shared)
        """
        agents = []
        inline_map = {a.id: a for a in conv_config.inline_agents}

        for agent_id in conv_config.agents:
            # 1. Check if agent exists as initialized SK agent
            if agent_id in self.sk_agents:
                agents.append(self.sk_agents[agent_id])
                continue

            # 2. Check inline agent definitions -> create on-the-fly
            if agent_id in inline_map:
                inline_cfg = inline_map[agent_id]
                agent = self._create_inline_agent(inline_cfg)
                if agent:
                    agents.append(agent)
                    continue

            log.warning("Agent '%s' not found for conversation '%s'", agent_id, conv_config.id)

        return agents

    def _create_inline_agent(self, agent_cfg: AgentConfig) -> ChatCompletionAgent | None:
        """Create a temporary agent from inline config."""
        # Find model: use specified model, or first available
        model_id = agent_cfg.model
        if not model_id:
            # Use default model from config
            default = self.config.get_default_agent()
            model_id = default.model if default else ""

        if not model_id:
            log.warning("No model available for inline agent '%s'", agent_cfg.id)
            return None

        # Try to reuse kernel from an existing agent with the same model
        for existing_id, existing_agent in self.sk_agents.items():
            existing_cfg = self.config.get_agent(existing_id)
            if existing_cfg and existing_cfg.model == model_id:
                # Create new agent with same kernel but different instructions
                kernel = existing_agent.kernel
                safe_name = agent_cfg.id.replace(".", "-").replace(" ", "-")
                return ChatCompletionAgent(
                    kernel=kernel,
                    name=f"sk-conv-{safe_name}",
                    instructions=agent_cfg.system_prompt or "You are a helpful assistant.",
                )

        # Fallback: use the first available agent's kernel
        if self.sk_agents:
            first_agent = next(iter(self.sk_agents.values()))
            safe_name = agent_cfg.id.replace(".", "-").replace(" ", "-")
            return ChatCompletionAgent(
                kernel=first_agent.kernel,
                name=f"sk-conv-{safe_name}",
                instructions=agent_cfg.system_prompt or "You are a helpful assistant.",
            )

        return None

    async def _run_group_chat(
        self,
        prompt: str,
        agents: list[ChatCompletionAgent],
        conv_config: ConversationConfig,
        max_rounds: int,
    ) -> dict[str, Any]:
        """Run a group chat conversation (sequential, group_chat, or magentic)."""
        # Build selection strategy
        if conv_config.type == "magentic":
            # For magentic: use KernelFunction-based selection if possible
            # Fall back to sequential if no LLM selection available
            try:
                from semantic_kernel.agents.strategies import KernelFunctionSelectionStrategy
                from semantic_kernel.functions import KernelFunctionFromPrompt

                # Use the first agent's kernel for the manager
                manager_kernel = agents[0].kernel if agents else Kernel()
                agent_names = ", ".join(a.name for a in agents)
                selection_fn = KernelFunctionFromPrompt(
                    function_name="select_next",
                    prompt=f"""You are a conversation manager. Given the conversation so far,
decide which agent should speak next. Available agents: {agent_names}.

Rules:
- If research/facts are needed, pick the researcher.
- If synthesis is needed, pick the synthesizer.
- If quality review is needed, pick the critic.
- Respond with ONLY the agent name, nothing else.

{{{{$history}}}}

Next agent:""",
                )
                selection_strategy = KernelFunctionSelectionStrategy(
                    kernel=manager_kernel,
                    function=selection_fn,
                    agent_variable_name="agents",
                    history_variable_name="history",
                )
            except (ImportError, Exception) as e:
                log.warning("KernelFunctionSelectionStrategy not available, falling back to sequential: %s", e)
                selection_strategy = SequentialSelectionStrategy()
        else:
            # sequential and group_chat both use round-robin
            selection_strategy = SequentialSelectionStrategy()

        # Build termination strategy
        if conv_config.type == "sequential":
            # Each agent speaks exactly once
            max_iter = len(agents)
        else:
            max_iter = max_rounds

        termination_strategy = DefaultTerminationStrategy(
            maximum_iterations=max_iter,
            agents=agents,
        )

        # Create group chat
        chat = AgentGroupChat(
            agents=agents,
            selection_strategy=selection_strategy,
            termination_strategy=termination_strategy,
        )

        # Add initial user message
        await chat.add_chat_message(
            ChatMessageContent(role=AuthorRole.USER, content=prompt)
        )

        # Run and collect messages
        steps = []
        final_response = ""
        async for message in chat.invoke():
            step = {
                "agent": message.name or str(message.role),
                "content": str(message.content) if message.content else "",
            }
            steps.append(step)
            final_response = step["content"]

        return {
            "response": final_response,
            "conversation_type": conv_config.type,
            "conversation_id": conv_config.id,
            "agents_used": [a.name for a in agents],
            "rounds": len(steps),
            "steps": steps,
        }

    async def _run_concurrent(
        self,
        prompt: str,
        agents: list[ChatCompletionAgent],
        conv_config: ConversationConfig,
    ) -> dict[str, Any]:
        """Run all agents concurrently on the same prompt."""
        from semantic_kernel.agents import ChatHistoryAgentThread

        async def run_single(agent: ChatCompletionAgent) -> dict:
            thread = ChatHistoryAgentThread()
            message = ChatMessageContent(role=AuthorRole.USER, content=prompt)
            final = None
            async for response in agent.invoke(messages=message, thread=thread):
                final = response
            return {
                "agent": agent.name,
                "response": str(final) if final else "",
            }

        results = await asyncio.gather(
            *(run_single(agent) for agent in agents),
            return_exceptions=True,
        )

        steps = []
        for r in results:
            if isinstance(r, Exception):
                steps.append({"agent": "error", "response": str(r)})
            else:
                steps.append(r)

        # Combine responses
        combined = "\n\n---\n\n".join(
            f"**{s['agent']}**: {s['response']}" for s in steps if s.get("response")
        )

        return {
            "response": combined,
            "conversation_type": "concurrent",
            "conversation_id": conv_config.id,
            "agents_used": [a.name for a in agents],
            "rounds": 1,
            "steps": steps,
        }


# ---------------------------------------------------------------------------
# Description Builder
# ---------------------------------------------------------------------------

def build_run_conversation_description(config: SKAgentConfig) -> str:
    """Build dynamic description for run_conversation tool."""
    lines = [
        "Run a multi-agent conversation.",
        "",
        "Available conversations:",
    ]

    # Config conversations
    for conv in config.conversations:
        agent_list = ", ".join(conv.agents)
        lines.append(f"  - {conv.id}: {conv.description} ({agent_list}) [{conv.type}]")

    # Built-in presets not overridden
    config_ids = {c.id for c in config.conversations}
    for preset_id, preset in PRESETS.items():
        if preset_id not in config_ids:
            agent_list = ", ".join(preset.agents)
            lines.append(f"  - {preset_id}: {preset.description} ({agent_list}) [{preset.type}, built-in]")

    lines.extend([
        "",
        "Parameters:",
        "  prompt: The research question or topic to deliberate",
        "  conversation: Conversation ID (default: deep-search)",
        "  options: JSON - max_rounds override",
        "  conversation_id: Not used (reserved for future thread continuity)",
    ])

    return "\n".join(lines)
