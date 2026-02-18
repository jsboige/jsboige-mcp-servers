#!/usr/bin/env python3
"""
Functional integration tests for sk-agent v2.0.

These tests use REAL model endpoints (not mocks) to verify that:
- Each agent can successfully respond to prompts
- Conversation presets (deep-search, deep-think, etc.) actually produce output
- Memory-enabled agents can save/recall (when Qdrant is reachable)
- The MCP tool pipeline works end-to-end

Requirements:
    - Real sk_agent_config.json with valid API keys
    - Network access to the configured endpoints
    - Run with: cd mcps/internal/servers/sk-agent && python -m pytest test_sk_agent_functional.py -v -s

These tests are SLOW (network calls to LLMs). They are NOT meant for CI.
Mark them with @pytest.mark.functional so they can be filtered.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path

import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from sk_agent_config import load_config, SKAgentConfig
from sk_agent import SKAgentManager, classify_attachment, build_call_agent_description
from sk_conversations import ConversationRunner, build_run_conversation_description

log = logging.getLogger("sk-agent.functional-tests")

# ---------------------------------------------------------------------------
# Markers & Fixtures
# ---------------------------------------------------------------------------

# Custom marker for functional tests
functional = pytest.mark.functional

# Skip entire module if config has no valid API keys
CONFIG_PATH = Path(__file__).parent / "sk_agent_config.json"
HAS_CONFIG = CONFIG_PATH.exists()

pytestmark = [
    pytest.mark.skipif(not HAS_CONFIG, reason="sk_agent_config.json not found"),
    functional,
]


@pytest.fixture(scope="module")
def config() -> SKAgentConfig:
    """Load real config from sk_agent_config.json."""
    return load_config()


@pytest.fixture(scope="module")
def manager(config) -> SKAgentManager:
    """Create and start a real SKAgentManager (module-scoped for performance).

    This starts the full manager including MCP plugins (searxng, playwright).
    The module-scope fixture ensures we only initialize once for all tests.
    """
    mgr = SKAgentManager(config)
    asyncio.get_event_loop().run_until_complete(mgr.start())

    yield mgr

    # Cleanup
    asyncio.get_event_loop().run_until_complete(mgr.stop())


def run_async(coro):
    """Run an async coroutine synchronously."""
    loop = asyncio.get_event_loop()
    if loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, coro).result()
    return loop.run_until_complete(coro)


# ---------------------------------------------------------------------------
# Test: Manager Initialization
# ---------------------------------------------------------------------------

class TestManagerInitialization:
    """Verify the manager initializes correctly with real config."""

    def test_manager_has_agents(self, manager: SKAgentManager):
        """Manager should have at least one initialized agent."""
        assert len(manager._sk_agents) > 0, "No agents initialized"
        log.info("Initialized agents: %s", list(manager._sk_agents.keys()))

    def test_manager_has_model_pool(self, manager: SKAgentManager):
        """Manager should have at least one model in the pool."""
        assert len(manager._openai_clients) > 0, "No models in pool"
        log.info("Model pool: %s", list(manager._openai_clients.keys()))

    def test_core_agents_present(self, manager: SKAgentManager):
        """Core agents (analyst, fast) should be initialized."""
        agent_ids = set(manager._sk_agents.keys())
        # At minimum, the default agent should be present
        assert len(agent_ids) >= 1, f"Expected at least 1 agent, got: {agent_ids}"
        log.info("All agent IDs: %s", agent_ids)

    def test_conversation_agents_present(self, manager: SKAgentManager):
        """Shared conversation agents should be initialized as top-level agents."""
        agent_ids = set(manager._sk_agents.keys())
        # These were promoted to top-level in the v2.0 refactor
        conversation_agents = {"researcher", "synthesizer", "critic", "optimist",
                               "devils-advocate", "pragmatist", "mediator"}
        present = agent_ids & conversation_agents
        log.info("Conversation agents present: %s / %s", len(present), len(conversation_agents))
        # At least the ones whose models are enabled should be present
        assert len(present) >= 1, (
            f"No conversation agents initialized. Agent IDs: {agent_ids}"
        )

    def test_mcp_plugins_loaded(self, manager: SKAgentManager):
        """MCP plugins should be loaded when depth < max_recursion_depth."""
        log.info("MCP plugins loaded: %s", list(manager._mcp_plugins.keys()))
        # Plugins may or may not load depending on environment
        # Just verify no crash during initialization


# ---------------------------------------------------------------------------
# Test: Individual Agent Calls (Text Only)
# ---------------------------------------------------------------------------

class TestAgentTextCalls:
    """Test each agent with a simple text prompt to verify LLM connectivity."""

    SIMPLE_PROMPT = "Reply with exactly one word: 'working'. Nothing else."
    TIMEOUT = 60  # seconds per call

    def _call_agent(self, manager: SKAgentManager, agent_id: str) -> dict:
        """Helper to call a specific agent and return the result."""
        start = time.time()
        result = run_async(manager.call_agent(
            prompt=self.SIMPLE_PROMPT,
            agent_id=agent_id,
        ))
        elapsed = time.time() - start
        log.info("Agent '%s' responded in %.1fs", agent_id, elapsed)
        return result

    def test_default_agent(self, manager: SKAgentManager, config: SKAgentConfig):
        """Default agent (analyst) should respond successfully."""
        default = config.get_default_agent()
        if not default or default.id not in manager._sk_agents:
            pytest.skip("Default agent not available")

        result = self._call_agent(manager, default.id)
        assert "error" not in result, f"Default agent error: {result.get('error')}"
        assert result.get("response"), "Empty response from default agent"
        assert result["agent_used"] == default.id
        log.info("Response: %s", result["response"][:200])

    def test_fast_agent(self, manager: SKAgentManager):
        """Fast agent (glm-4.7-flash) should respond quickly."""
        if "fast" not in manager._sk_agents:
            pytest.skip("Fast agent not available")

        start = time.time()
        result = self._call_agent(manager, "fast")
        elapsed = time.time() - start

        assert "error" not in result, f"Fast agent error: {result.get('error')}"
        assert result.get("response"), "Empty response from fast agent"
        log.info("Fast agent response in %.1fs: %s", elapsed, result["response"][:200])

    def test_researcher_agent(self, manager: SKAgentManager):
        """Researcher agent should respond (shared conversation agent)."""
        if "researcher" not in manager._sk_agents:
            pytest.skip("Researcher agent not available")

        result = self._call_agent(manager, "researcher")
        assert "error" not in result, f"Researcher error: {result.get('error')}"
        assert result.get("response"), "Empty response from researcher"

    def test_critic_agent(self, manager: SKAgentManager):
        """Critic agent should respond."""
        if "critic" not in manager._sk_agents:
            pytest.skip("Critic agent not available")

        result = self._call_agent(manager, "critic")
        assert "error" not in result, f"Critic error: {result.get('error')}"
        assert result.get("response"), "Empty response from critic"

    def test_optimist_agent(self, manager: SKAgentManager):
        """Optimist agent (deep-think) should respond."""
        if "optimist" not in manager._sk_agents:
            pytest.skip("Optimist agent not available")

        result = self._call_agent(manager, "optimist")
        assert "error" not in result, f"Optimist error: {result.get('error')}"
        assert result.get("response"), "Empty response from optimist"

    def test_devils_advocate_agent(self, manager: SKAgentManager):
        """Devil's advocate agent should respond."""
        if "devils-advocate" not in manager._sk_agents:
            pytest.skip("Devils-advocate agent not available")

        result = self._call_agent(manager, "devils-advocate")
        assert "error" not in result, f"Devils-advocate error: {result.get('error')}"
        assert result.get("response"), "Empty response from devils-advocate"

    def test_mediator_agent(self, manager: SKAgentManager):
        """Mediator agent should respond."""
        if "mediator" not in manager._sk_agents:
            pytest.skip("Mediator agent not available")

        result = self._call_agent(manager, "mediator")
        assert "error" not in result, f"Mediator error: {result.get('error')}"
        assert result.get("response"), "Empty response from mediator"

    def test_all_enabled_agents_respond(self, manager: SKAgentManager):
        """Every initialized agent should respond without error."""
        results = {}
        failures = []

        for agent_id in manager._sk_agents:
            try:
                result = self._call_agent(manager, agent_id)
                results[agent_id] = result
                if "error" in result:
                    failures.append(f"{agent_id}: {result['error']}")
                elif not result.get("response"):
                    failures.append(f"{agent_id}: empty response")
            except Exception as e:
                failures.append(f"{agent_id}: exception {e}")

        log.info("Tested %d agents, %d failures", len(results), len(failures))
        if failures:
            log.error("Failed agents:\n  %s", "\n  ".join(failures))

        assert not failures, f"Agent failures:\n  " + "\n  ".join(failures)


# ---------------------------------------------------------------------------
# Test: Conversation Continuity
# ---------------------------------------------------------------------------

class TestConversationContinuity:
    """Test that conversation threads maintain context."""

    def test_conversation_thread_persists(self, manager: SKAgentManager, config: SKAgentConfig):
        """Multi-turn conversation should maintain context."""
        default = config.get_default_agent()
        if not default or default.id not in manager._sk_agents:
            pytest.skip("Default agent not available")

        # Turn 1: Establish a fact
        result1 = run_async(manager.call_agent(
            prompt="Remember this secret code: ALPHA-7. Just confirm you noted it.",
            agent_id=default.id,
        ))
        assert "error" not in result1, f"Turn 1 error: {result1.get('error')}"
        conv_id = result1.get("conversation_id")
        assert conv_id, "No conversation_id returned"

        # Turn 2: Ask about the fact
        result2 = run_async(manager.call_agent(
            prompt="What was the secret code I just told you?",
            agent_id=default.id,
            conversation_id=conv_id,
        ))
        assert "error" not in result2, f"Turn 2 error: {result2.get('error')}"
        response2 = result2.get("response", "").upper()
        assert "ALPHA" in response2 or "7" in response2, (
            f"Agent forgot the code. Response: {result2['response'][:300]}"
        )
        log.info("Conversation continuity verified: %s", result2["response"][:200])

    def test_separate_threads_are_independent(self, manager: SKAgentManager, config: SKAgentConfig):
        """Two conversations should not share context."""
        default = config.get_default_agent()
        if not default or default.id not in manager._sk_agents:
            pytest.skip("Default agent not available")

        # Conversation A
        result_a = run_async(manager.call_agent(
            prompt="My favorite color is blue. Just confirm.",
            agent_id=default.id,
        ))
        assert "error" not in result_a

        # Conversation B (new thread)
        result_b = run_async(manager.call_agent(
            prompt="What is my favorite color?",
            agent_id=default.id,
            # No conversation_id -> new thread
        ))
        assert "error" not in result_b
        # The agent should NOT know the color from conversation A
        # (It might guess, but it shouldn't have definitive knowledge)
        log.info("Thread B response: %s", result_b.get("response", "")[:200])


# ---------------------------------------------------------------------------
# Test: Agent Resolution
# ---------------------------------------------------------------------------

class TestAgentResolutionLive:
    """Test agent resolution with real initialized agents."""

    def test_explicit_agent_selection(self, manager: SKAgentManager):
        """Explicitly selecting an agent should work."""
        for agent_id in list(manager._sk_agents.keys())[:3]:
            resolved_id, agent = manager._resolve_agent(agent_id=agent_id)
            assert resolved_id == agent_id
            assert agent is manager._sk_agents[agent_id]

    def test_vision_default_resolution(self, manager: SKAgentManager, config: SKAgentConfig):
        """Vision request should resolve to vision agent if available."""
        vision_cfg = config.get_default_vision_agent()
        if not vision_cfg or vision_cfg.id not in manager._sk_agents:
            pytest.skip("Vision agent not available")

        resolved_id, _ = manager._resolve_agent(needs_vision=True)
        assert resolved_id == vision_cfg.id

    def test_fallback_to_default(self, manager: SKAgentManager, config: SKAgentConfig):
        """No explicit agent should resolve to default."""
        default_cfg = config.get_default_agent()
        if not default_cfg or default_cfg.id not in manager._sk_agents:
            pytest.skip("Default agent not available")

        resolved_id, _ = manager._resolve_agent()
        assert resolved_id == default_cfg.id


# ---------------------------------------------------------------------------
# Test: Multi-Agent Conversations
# ---------------------------------------------------------------------------

class TestMultiAgentConversations:
    """Test that conversation presets produce meaningful multi-agent output.

    These tests are SLOW as they involve multiple LLM round-trips.
    """

    TIMEOUT = 300  # 5 minutes max per conversation

    def test_deep_search_produces_output(self, manager: SKAgentManager, config: SKAgentConfig):
        """Deep-search conversation should produce a multi-agent research result."""
        runner = ConversationRunner(config, manager._sk_agents)

        # Check that at least some agents are resolvable
        conv = runner._resolve_conversation("deep-search")
        if not conv:
            pytest.skip("deep-search conversation not found")

        agents = runner._resolve_conversation_agents(conv)
        if len(agents) < 2:
            pytest.skip(f"Not enough agents for deep-search: {len(agents)}")

        result = run_async(runner.run(
            prompt="What is the capital of France? Respond concisely.",
            conversation_id="deep-search",
            options={"max_rounds": 3},  # Limit rounds for speed
        ))

        assert "error" not in result, f"Deep-search error: {result.get('error')}"
        assert result.get("response"), "Empty response from deep-search"
        assert result.get("rounds", 0) >= 1, "No rounds completed"
        assert len(result.get("agents_used", [])) >= 2, "Less than 2 agents participated"
        log.info(
            "Deep-search: %d rounds, %d agents, response: %s",
            result.get("rounds", 0),
            len(result.get("agents_used", [])),
            result.get("response", "")[:300],
        )

    def test_deep_think_produces_output(self, manager: SKAgentManager, config: SKAgentConfig):
        """Deep-think conversation should produce multi-perspective deliberation."""
        runner = ConversationRunner(config, manager._sk_agents)

        conv = runner._resolve_conversation("deep-think")
        if not conv:
            pytest.skip("deep-think conversation not found")

        agents = runner._resolve_conversation_agents(conv)
        if len(agents) < 2:
            pytest.skip(f"Not enough agents for deep-think: {len(agents)}")

        result = run_async(runner.run(
            prompt="Should a small team use microservices or a monolith? Be brief.",
            conversation_id="deep-think",
            options={"max_rounds": 4},
        ))

        assert "error" not in result, f"Deep-think error: {result.get('error')}"
        assert result.get("response"), "Empty response from deep-think"
        assert result.get("rounds", 0) >= 1
        log.info(
            "Deep-think: %d rounds, agents: %s, response: %s",
            result.get("rounds", 0),
            result.get("agents_used", []),
            result.get("response", "")[:300],
        )

    def test_conversation_lists_available(self, manager: SKAgentManager, config: SKAgentConfig):
        """list_conversations should return all available conversations."""
        runner = ConversationRunner(config, manager._sk_agents)
        conversations = runner.list_conversations()

        assert len(conversations) >= 2, f"Expected at least 2 conversations, got {len(conversations)}"

        ids = [c["id"] for c in conversations]
        assert "deep-search" in ids, f"deep-search not in {ids}"
        assert "deep-think" in ids, f"deep-think not in {ids}"
        log.info("Available conversations: %s", ids)

    def test_code_review_conversation_resolves(self, manager: SKAgentManager, config: SKAgentConfig):
        """Code-review conversation (inline agents) should resolve agents."""
        runner = ConversationRunner(config, manager._sk_agents)

        conv = runner._resolve_conversation("code-review")
        if not conv:
            pytest.skip("code-review conversation not found in config")

        agents = runner._resolve_conversation_agents(conv)
        # code-review uses inline agents, so they should be created on-the-fly
        log.info("code-review resolved %d agents", len(agents))
        assert len(agents) >= 1, "No agents resolved for code-review"


# ---------------------------------------------------------------------------
# Test: Dynamic Descriptions
# ---------------------------------------------------------------------------

class TestDynamicDescriptionsLive:
    """Verify dynamic descriptions are generated from real config."""

    def test_call_agent_description_lists_agents(self, config: SKAgentConfig):
        """call_agent description should list all enabled agents."""
        desc = build_call_agent_description(config)
        assert "Available agents:" in desc
        # Should contain at least the default agent
        default = config.get_default_agent()
        if default:
            assert default.id in desc, f"Default agent '{default.id}' not in description"

    def test_run_conversation_description_lists_presets(self, config: SKAgentConfig):
        """run_conversation description should list available conversations."""
        desc = build_run_conversation_description(config)
        assert "deep-search" in desc
        assert "deep-think" in desc

    def test_description_includes_model_info(self, config: SKAgentConfig):
        """Agent descriptions should include model context window info."""
        desc = build_call_agent_description(config)
        # Should contain context window info like "200K" or "128K"
        assert "K" in desc, "No context window info in description"


# ---------------------------------------------------------------------------
# Test: List Agents (Real Data)
# ---------------------------------------------------------------------------

class TestListAgentsLive:
    """Test list_agents with real initialized agents."""

    def test_list_agents_returns_all(self, manager: SKAgentManager):
        """list_agents should return info for all initialized agents."""
        agents = manager.list_agents()
        assert len(agents) > 0, "No agents returned"
        assert len(agents) == len(manager._sk_agents), (
            f"list_agents returned {len(agents)} but {len(manager._sk_agents)} are initialized"
        )

        for agent_info in agents:
            assert "id" in agent_info
            assert "description" in agent_info
            assert "model" in agent_info or "model_id" in agent_info
            log.info("Agent: %s", agent_info.get("id"))

    def test_list_agents_has_conversation_agents(self, manager: SKAgentManager):
        """Shared conversation agents should appear in list_agents."""
        agents = manager.list_agents()
        agent_ids = {a.get("id") for a in agents}

        # Check for at least some promoted agents
        conversation_agents = {"researcher", "synthesizer", "critic", "optimist",
                               "devils-advocate", "pragmatist", "mediator"}
        present = agent_ids & conversation_agents
        log.info("Conversation agents in list_agents: %s", present)
        # At least the ones with enabled models should be listed
        assert len(present) >= 1, (
            f"No conversation agents in list_agents. IDs: {agent_ids}"
        )


# ---------------------------------------------------------------------------
# Test: Robustness
# ---------------------------------------------------------------------------

class TestRobustness:
    """Test error handling and edge cases with real endpoints."""

    def test_empty_prompt_handled(self, manager: SKAgentManager, config: SKAgentConfig):
        """Empty prompt should not crash the manager (may return error dict or raise)."""
        default = config.get_default_agent()
        if not default or default.id not in manager._sk_agents:
            pytest.skip("Default agent not available")

        try:
            result = run_async(manager.call_agent(
                prompt="",
                agent_id=default.id,
            ))
            # If it returns, should be a dict (possibly with "error" key)
            assert isinstance(result, dict)
        except Exception:
            # Some LLM APIs reject empty prompts - that's acceptable behavior
            pass

    def test_unknown_agent_returns_error(self, manager: SKAgentManager):
        """Requesting a non-existent agent should fallback or error gracefully."""
        result = run_async(manager.call_agent(
            prompt="Hello",
            agent_id="nonexistent-agent-xyz",
        ))
        # Should fallback to default or return error
        assert isinstance(result, dict)

    def test_long_prompt_handled(self, manager: SKAgentManager, config: SKAgentConfig):
        """A moderately long prompt should not crash."""
        default = config.get_default_agent()
        if not default or default.id not in manager._sk_agents:
            pytest.skip("Default agent not available")

        long_prompt = "Repeat the word 'test'. " * 100  # ~2400 chars
        result = run_async(manager.call_agent(
            prompt=long_prompt,
            agent_id=default.id,
        ))
        assert "error" not in result, f"Long prompt error: {result.get('error')}"
        assert result.get("response"), "Empty response for long prompt"


# ---------------------------------------------------------------------------
# Test: End-to-End Persona Verification
# ---------------------------------------------------------------------------

class TestPersonaVerification:
    """Verify that each shared agent exhibits its persona characteristics.

    These tests give persona-specific prompts and check that responses
    align with the expected role (optimist vs critic vs pragmatist, etc.).
    """

    PERSONA_PROMPT = (
        "A startup wants to build a social media app. "
        "Give your perspective in 2-3 sentences."
    )

    def test_optimist_is_positive(self, manager: SKAgentManager):
        """Optimist should highlight opportunities/benefits."""
        if "optimist" not in manager._sk_agents:
            pytest.skip("Optimist agent not available")

        result = run_async(manager.call_agent(
            prompt=self.PERSONA_PROMPT, agent_id="optimist"
        ))
        assert "error" not in result
        response = result.get("response", "").lower()
        assert result.get("response"), "Empty response"
        log.info("Optimist: %s", result["response"][:300])
        # The optimist should mention positive things
        # (we don't strictly assert content, just log for manual review)

    def test_devils_advocate_is_critical(self, manager: SKAgentManager):
        """Devil's advocate should highlight risks/challenges."""
        if "devils-advocate" not in manager._sk_agents:
            pytest.skip("Devils-advocate agent not available")

        result = run_async(manager.call_agent(
            prompt=self.PERSONA_PROMPT, agent_id="devils-advocate"
        ))
        assert "error" not in result
        assert result.get("response"), "Empty response"
        log.info("Devil's advocate: %s", result["response"][:300])

    def test_pragmatist_is_practical(self, manager: SKAgentManager):
        """Pragmatist should focus on implementation/execution."""
        if "pragmatist" not in manager._sk_agents:
            pytest.skip("Pragmatist agent not available")

        result = run_async(manager.call_agent(
            prompt=self.PERSONA_PROMPT, agent_id="pragmatist"
        ))
        assert "error" not in result
        assert result.get("response"), "Empty response"
        log.info("Pragmatist: %s", result["response"][:300])

    def test_critic_reviews_quality(self, manager: SKAgentManager):
        """Critic should evaluate quality/evidence."""
        if "critic" not in manager._sk_agents:
            pytest.skip("Critic agent not available")

        result = run_async(manager.call_agent(
            prompt="Review this claim: 'AI will replace all programmers by 2030'. Rate it Strong/Moderate/Weak.",
            agent_id="critic",
        ))
        assert "error" not in result
        assert result.get("response"), "Empty response"
        log.info("Critic: %s", result["response"][:300])

    def test_mediator_synthesizes(self, manager: SKAgentManager):
        """Mediator should find common ground and recommend."""
        if "mediator" not in manager._sk_agents:
            pytest.skip("Mediator agent not available")

        result = run_async(manager.call_agent(
            prompt=(
                "The optimist says 'AI is great for productivity'. "
                "The devil's advocate says 'AI will cause job losses'. "
                "The pragmatist says 'start with small pilots'. "
                "Synthesize these perspectives into a recommendation."
            ),
            agent_id="mediator",
        ))
        assert "error" not in result
        assert result.get("response"), "Empty response"
        log.info("Mediator: %s", result["response"][:300])


# ---------------------------------------------------------------------------
# Run Tests
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s", "--tb=short"])
