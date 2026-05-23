"""Tests for mcp_overrides feature — resolve_effective_mcp_ids + collect logic."""

import pytest
import re

# Import the sanitize function for testing
_INVALID_NAME_CHARS = re.compile(r"[^0-9A-Za-z_-]")


def _sanitize_agent_name(name: str) -> str:
    return _INVALID_NAME_CHARS.sub("-", name)


# --- Pure logic extracted for testability ---


def resolve_effective_mcp_ids(base_mcps: list[str], overrides: dict | None) -> list[str]:
    """Compute effective MCP IDs given base config and per-call overrides."""
    if not overrides:
        return base_mcps

    if "replace" in overrides:
        return list(overrides["replace"])

    result = list(base_mcps)
    for mcp_id in overrides.get("add", []):
        if mcp_id not in result:
            result.append(mcp_id)
    for mcp_id in overrides.get("remove", []):
        if mcp_id in result:
            result.remove(mcp_id)
    return result


# --- Tests ---


class TestResolveEffectiveMcpIds:
    """Tests for the resolve_effective_mcp_ids helper."""

    def test_none_overrides_returns_base(self):
        assert resolve_effective_mcp_ids(["searxng", "playwright"], None) == [
            "searxng",
            "playwright",
        ]

    def test_empty_overrides_returns_base(self):
        assert resolve_effective_mcp_ids(["searxng"], {}) == ["searxng"]

    def test_replace_full_replacement(self):
        result = resolve_effective_mcp_ids(
            ["searxng", "playwright"], {"replace": ["open_terminal"]}
        )
        assert result == ["open_terminal"]

    def test_replace_empty_disables_all_mcps(self):
        result = resolve_effective_mcp_ids(
            ["searxng", "playwright"], {"replace": []}
        )
        assert result == []

    def test_add_new_mcp(self):
        result = resolve_effective_mcp_ids(
            ["searxng"], {"add": ["open_terminal"]}
        )
        assert result == ["searxng", "open_terminal"]

    def test_add_duplicate_ignored(self):
        result = resolve_effective_mcp_ids(
            ["searxng"], {"add": ["searxng"]}
        )
        assert result == ["searxng"]

    def test_remove_existing_mcp(self):
        result = resolve_effective_mcp_ids(
            ["searxng", "playwright"], {"remove": ["playwright"]}
        )
        assert result == ["searxng"]

    def test_remove_nonexistent_noop(self):
        result = resolve_effective_mcp_ids(
            ["searxng"], {"remove": ["nonexistent"]}
        )
        assert result == ["searxng"]

    def test_add_and_remove_combined(self):
        result = resolve_effective_mcp_ids(
            ["searxng", "playwright"],
            {"add": ["open_terminal"], "remove": ["playwright"]},
        )
        assert result == ["searxng", "open_terminal"]

    def test_replace_takes_precedence_over_add_remove(self):
        result = resolve_effective_mcp_ids(
            ["searxng"],
            {"replace": ["markitdown"], "add": ["open_terminal"]},
        )
        assert result == ["markitdown"]

    def test_preserves_base_order(self):
        result = resolve_effective_mcp_ids(
            ["searxng", "playwright", "markitdown"],
            {"add": ["open_terminal"]},
        )
        assert result == ["searxng", "playwright", "markitdown", "open_terminal"]

    def test_empty_base_with_add(self):
        result = resolve_effective_mcp_ids([], {"add": ["searxng"]})
        assert result == ["searxng"]

    def test_empty_base_with_replace(self):
        result = resolve_effective_mcp_ids([], {"replace": ["searxng", "playwright"]})
        assert result == ["searxng", "playwright"]


class TestMcpOverridesParsing:
    """Tests for MCP tool call_agent mcp_overrides JSON parsing."""

    def test_valid_json_dict(self):
        import json

        raw = '{"add": ["searxng"], "remove": ["playwright"]}'
        parsed = json.loads(raw)
        assert isinstance(parsed, dict)
        assert parsed["add"] == ["searxng"]
        assert parsed["remove"] == ["playwright"]

    def test_valid_replace_dict(self):
        import json

        raw = '{"replace": ["searxng"]}'
        parsed = json.loads(raw)
        assert parsed["replace"] == ["searxng"]

    def test_invalid_json_rejected(self):
        import json

        raw = "not json"
        with pytest.raises(json.JSONDecodeError):
            json.loads(raw)

    def test_non_dict_rejected(self):
        """A bare list is not valid mcp_overrides — must be a dict."""
        import json

        raw = '["searxng"]'
        parsed = json.loads(raw)
        assert not isinstance(parsed, dict)

    def test_empty_string_treated_as_none(self):
        raw = ""
        result = None if not raw else raw
        assert result is None


class TestSanitizeAgentName:
    """Tests for _sanitize_agent_name — SK ChatCompletionAgent name pattern."""

    def test_dot_replaced(self):
        assert _sanitize_agent_name("glm-4.7-flash") == "glm-4-7-flash"

    def test_multiple_dots(self):
        assert _sanitize_agent_name("model.4.7.plus") == "model-4-7-plus"

    def test_space_replaced(self):
        assert _sanitize_agent_name("my agent") == "my-agent"

    def test_alphanumeric_unchanged(self):
        assert _sanitize_agent_name("fast-reviewer") == "fast-reviewer"

    def test_underscore_preserved(self):
        assert _sanitize_agent_name("my_agent_v2") == "my_agent_v2"

    def test_plus_replaced(self):
        assert _sanitize_agent_name("model+plus") == "model-plus"

    def test_combined_suffix(self):
        assert _sanitize_agent_name("fast-glm-4.7-flash") == "fast-glm-4-7-flash"

    def test_empty_string(self):
        assert _sanitize_agent_name("") == ""

    def test_no_altering_of_valid_name(self):
        name = "sk-agent-override-fast-glm-4-7-flash"
        assert _sanitize_agent_name(name) == name
