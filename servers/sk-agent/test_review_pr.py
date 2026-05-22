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
