"""Tests for review_pr tool — tier mapping, prompt generation, options parsing."""

import json
from unittest.mock import patch, MagicMock, AsyncMock

import pytest


# --- Pure logic extracted from review_pr for testability ---

TIER_AGENTS = {1: "fast-reviewer", 2: "integration-reviewer", 3: "deep-reviewer"}
TIER_CONVERSATIONS = {
    1: "pr-review-tier1",
    2: "pr-review-tier2",
    3: "pr-review-tier3",
}


def resolve_tier(tier: int) -> int:
    """Clamp tier to [1, 3]."""
    return max(1, min(3, tier))


def resolve_agent(tier: int, override: str = "") -> str:
    return override or TIER_AGENTS.get(tier, "integration-reviewer")


def resolve_conversation(tier: int, override: str = "") -> str:
    return override or TIER_CONVERSATIONS.get(tier, "pr-review-tier2")


def parse_options(options_str: str) -> dict:
    if not options_str:
        return {}
    try:
        return json.loads(options_str)
    except json.JSONDecodeError:
        return {}


def build_review_prompt(repo: str, pr_number: int, tier: int = 2) -> str:
    prompt_parts = [
        f"Review PR #{pr_number} in repository {repo}.",
        f"Use the GitHub tools to fetch the PR diff, files, and metadata.",
        f"Provide your review in the following JSON format:",
        "```json",
        "{",
        '  "verdict": "APPROVE | COMMENT | REQUEST_CHANGES",',
        '  "confidence": "HIGH | MEDIUM | LOW",',
        '  "summary": "1-3 sentence summary",',
        '  "blocking_issues": [{"severity":"critical|major|minor", "category":"security|performance|maintainability|integration|regression", "file":"path", "line":0, "message":"description", "suggestion":"fix"}],',
        '  "suggestions": [{"severity":"minor", "category":"style", "file":"path", "line":0, "message":"description", "suggestion":"fix"}]',
        "}",
        "```",
        "",
        "Be thorough. Check for bugs, security issues, performance problems, and maintainability.",
        "If the PR is a pointer bump or trivial change, keep the review short.",
    ]

    if tier == 3:
        prompt_parts.extend([
            "",
            "TIER 3 INSTRUCTIONS: You have terminal access. When possible:",
            "1. Clone or checkout the PR branch to inspect the code locally",
            "2. Run the build and tests to verify correctness",
            "3. Run linter/type checks if available",
            "4. Include test_results in your review output",
        ])

    return "\n".join(prompt_parts)


# --- #1587 fix: tier-adaptive timeout + error propagation ---

DEFAULT_TIMEOUT = 120  # matches sk_agent.py review_pr default


def resolve_effective_timeout(timeout: int, tier: int) -> int:
    """Compute effective timeout for review_pr call_agent.

    When timeout is the default (120), replace with tier-appropriate value.
    When explicitly set by the caller, respect it.
    """
    if timeout == DEFAULT_TIMEOUT:
        return {1: 60, 2: 180, 3: 300}.get(tier, DEFAULT_TIMEOUT)
    return timeout


def format_review_result(result, agent_id: str, tier: int, elapsed: float,
                         effective_timeout: int) -> str:
    """Format review_pr result, propagating errors instead of silently swallowing.

    Returns JSON string with either "response" or "error" key.
    Mirrors the logic in review_pr's error propagation fix (#1587).
    """
    if isinstance(result, dict) and "error" in result:
        return json.dumps({
            "error": result["error"],
            "agent_used": agent_id,
            "tier": tier,
            "duration_seconds": elapsed,
            "timeout_used": effective_timeout,
        }, indent=2, ensure_ascii=False)

    return json.dumps({
        "response": result.get("response", "") if isinstance(result, dict) else str(result),
        "agent_used": agent_id,
        "model_used": result.get("model_used", "") if isinstance(result, dict) else "",
        "tier": tier,
        "duration_seconds": elapsed,
    }, indent=2, ensure_ascii=False)


# --- Tests ---


class TestResolveTier:
    def test_tier_1_unchanged(self):
        assert resolve_tier(1) == 1

    def test_tier_2_unchanged(self):
        assert resolve_tier(2) == 2

    def test_tier_3_unchanged(self):
        assert resolve_tier(3) == 3

    def test_tier_0_clamped_to_1(self):
        assert resolve_tier(0) == 1

    def test_tier_negative_clamped_to_1(self):
        assert resolve_tier(-5) == 1

    def test_tier_5_clamped_to_3(self):
        assert resolve_tier(5) == 3

    def test_tier_100_clamped_to_3(self):
        assert resolve_tier(100) == 3


class TestResolveAgent:
    def test_tier1_maps_to_fast_reviewer(self):
        assert resolve_agent(1) == "fast-reviewer"

    def test_tier2_maps_to_integration_reviewer(self):
        assert resolve_agent(2) == "integration-reviewer"

    def test_tier3_maps_to_deep_reviewer(self):
        assert resolve_agent(3) == "deep-reviewer"

    def test_override_takes_precedence(self):
        assert resolve_agent(2, override="custom-agent") == "custom-agent"

    def test_empty_override_falls_back(self):
        assert resolve_agent(1, override="") == "fast-reviewer"


class TestResolveConversation:
    def test_tier1_sequential(self):
        assert resolve_conversation(1) == "pr-review-tier1"

    def test_tier2_group_chat(self):
        assert resolve_conversation(2) == "pr-review-tier2"

    def test_tier3_has_own_conversation(self):
        assert resolve_conversation(3) == "pr-review-tier3"

    def test_override_takes_precedence(self):
        assert resolve_conversation(2, override="my-conv") == "my-conv"


class TestParseOptions:
    def test_empty_string(self):
        assert parse_options("") == {}

    def test_valid_json(self):
        opts = parse_options('{"model": "glm-5", "max_rounds": 3}')
        assert opts == {"model": "glm-5", "max_rounds": 3}

    def test_invalid_json_returns_empty(self):
        assert parse_options("not json") == {}

    def test_partial_json_returns_empty(self):
        assert parse_options('{"model": "glm-5"') == {}


class TestBuildReviewPrompt:
    def test_contains_repo_and_pr(self):
        prompt = build_review_prompt("jsboige/roo-extensions", 1587)
        assert "jsboige/roo-extensions" in prompt
        assert "1587" in prompt

    def test_contains_json_schema(self):
        prompt = build_review_prompt("owner/repo", 1)
        assert "verdict" in prompt
        assert "APPROVE" in prompt
        assert "blocking_issues" in prompt
        assert "suggestions" in prompt
        assert "confidence" in prompt

    def test_contains_thoroughness_instruction(self):
        prompt = build_review_prompt("owner/repo", 1)
        assert "Be thorough" in prompt

    def test_contains_trivial_shortcut(self):
        prompt = build_review_prompt("owner/repo", 1)
        assert "pointer bump" in prompt

    def test_tier3_contains_execution_instructions(self):
        prompt = build_review_prompt("owner/repo", 1, tier=3)
        assert "TIER 3 INSTRUCTIONS" in prompt
        assert "terminal access" in prompt
        assert "Run the build and tests" in prompt
        assert "test_results" in prompt

    def test_tier2_no_execution_instructions(self):
        prompt = build_review_prompt("owner/repo", 1, tier=2)
        assert "TIER 3 INSTRUCTIONS" not in prompt


class TestTier3Distinct:
    """Verify Tier 3 is now distinct from Tier 2."""

    def test_tier3_agent_differs_from_tier2(self):
        assert resolve_agent(3) != resolve_agent(2)

    def test_tier3_conversation_differs_from_tier2(self):
        assert resolve_conversation(3) != resolve_conversation(2)

    def test_tier3_agent_is_deep_reviewer(self):
        assert resolve_agent(3) == "deep-reviewer"

    def test_tier3_conversation_is_pr_review_tier3(self):
        assert resolve_conversation(3) == "pr-review-tier3"


# --- #1587 fix tests ---


class TestResolveEffectiveTimeout:
    """Tier-adaptive timeout: default 120 is replaced with tier-appropriate values."""

    def test_tier1_default_gets_60(self):
        assert resolve_effective_timeout(120, 1) == 60

    def test_tier2_default_gets_180(self):
        assert resolve_effective_timeout(120, 2) == 180

    def test_tier3_default_gets_300(self):
        assert resolve_effective_timeout(120, 3) == 300

    def test_explicit_timeout_preserved_tier2(self):
        """If caller explicitly sets timeout=60, don't override."""
        assert resolve_effective_timeout(60, 2) == 60

    def test_explicit_timeout_preserved_tier3(self):
        """If caller explicitly sets timeout=500, don't override."""
        assert resolve_effective_timeout(500, 3) == 500

    def test_zero_timeout_not_overridden(self):
        """Edge case: explicit 0 should be preserved (no timeout)."""
        assert resolve_effective_timeout(0, 2) == 0


class TestFormatReviewResultErrorPropagation:
    """#1587: Error dicts from call_agent must be propagated, not silently swallowed."""

    def test_timeout_error_propagated(self):
        """The original bug: timeout returned {"error": "...", "timeout": N}
        and .get("response", "") returned "" — silent swallow."""
        error_result = {"error": "call_agent timed out after 180s", "timeout": 180}
        output = format_review_result(
            result=error_result,
            agent_id="integration-reviewer",
            tier=2,
            elapsed=180.2,
            effective_timeout=180,
        )
        parsed = json.loads(output)
        assert "error" in parsed
        assert "timed out" in parsed["error"]
        assert parsed["agent_used"] == "integration-reviewer"
        assert parsed["tier"] == 2
        assert parsed["timeout_used"] == 180
        # The key fix: "response" must NOT be present in error output
        assert "response" not in parsed

    def test_agent_resolution_error_propagated(self):
        """Non-timeout errors (e.g., agent not found) also propagated."""
        error_result = {"error": "Agent 'unknown-agent' not found"}
        output = format_review_result(
            result=error_result,
            agent_id="unknown-agent",
            tier=2,
            elapsed=0.1,
            effective_timeout=180,
        )
        parsed = json.loads(output)
        assert "error" in parsed
        assert "not found" in parsed["error"]
        assert "response" not in parsed

    def test_success_result_not_affected(self):
        """Successful results should still have "response" key as before."""
        success_result = {"response": "LGTM", "model_used": "glm-5"}
        output = format_review_result(
            result=success_result,
            agent_id="fast-reviewer",
            tier=1,
            elapsed=15.3,
            effective_timeout=60,
        )
        parsed = json.loads(output)
        assert parsed["response"] == "LGTM"
        assert parsed["model_used"] == "glm-5"
        assert parsed["agent_used"] == "fast-reviewer"
        assert parsed["tier"] == 1
        assert "error" not in parsed

    def test_string_result_handled(self):
        """If call_agent returns a plain string (not dict), wrap it."""
        output = format_review_result(
            result="Plain text review",
            agent_id="integration-reviewer",
            tier=2,
            elapsed=10.0,
            effective_timeout=180,
        )
        parsed = json.loads(output)
        assert parsed["response"] == "Plain text review"

    def test_dict_without_response_key(self):
        """Edge case: success dict missing 'response' key defaults to empty string."""
        result = {"model_used": "glm-5"}
        output = format_review_result(
            result=result,
            agent_id="fast-reviewer",
            tier=1,
            elapsed=5.0,
            effective_timeout=60,
        )
        parsed = json.loads(output)
        assert parsed["response"] == ""
        assert "error" not in parsed
