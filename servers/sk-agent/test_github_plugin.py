"""Tests for github_plugin.py — GitHub PR review plugin for sk-agent."""

import json
import subprocess
from unittest.mock import patch, MagicMock

import pytest

from github_plugin import GitHubPlugin


@pytest.fixture
def plugin():
    return GitHubPlugin(default_repo="test-owner/test-repo")


class TestGitHubPluginInit:
    def test_default_repo_set(self):
        p = GitHubPlugin(default_repo="foo/bar")
        assert p._default_repo == "foo/bar"

    def test_default_repo_empty(self):
        p = GitHubPlugin()
        assert p._default_repo == ""


class TestGetPrDiff:
    @patch("github_plugin.subprocess.run")
    def test_returns_diff(self, mock_run, plugin):
        mock_run.return_value = MagicMock(
            returncode=0, stdout="diff --git a/file.ts b/file.ts\n+new line"
        )
        result = plugin.get_pr_diff(123)
        assert "diff --git" in result
        mock_run.assert_called_once()
        args = mock_run.call_args[0][0]
        assert "pr" in args
        assert "diff" in args
        assert "123" in args
        assert "--repo" in args
        assert "test-owner/test-repo" in args

    @patch("github_plugin.subprocess.run")
    def test_uses_custom_repo(self, mock_run):
        plugin = GitHubPlugin()
        mock_run.return_value = MagicMock(returncode=0, stdout="diff content")
        plugin.get_pr_diff(456, repo="other/repo")
        args = mock_run.call_args[0][0]
        assert "other/repo" in args

    @patch("github_plugin.subprocess.run")
    def test_handles_error(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=1, stderr="not found")
        result = plugin.get_pr_diff(999)
        parsed = json.loads(result)
        assert "error" in parsed


class TestGetPrFiles:
    @patch("github_plugin.subprocess.run")
    def test_returns_file_list(self, mock_run, plugin):
        mock_run.return_value = MagicMock(
            returncode=0, stdout="src/file1.ts\nsrc/file2.ts\n"
        )
        result = plugin.get_pr_files(100)
        files = json.loads(result)
        assert files == ["src/file1.ts", "src/file2.ts"]

    @patch("github_plugin.subprocess.run")
    def test_empty_diff(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=0, stdout="")
        result = plugin.get_pr_files(100)
        files = json.loads(result)
        assert files == []


class TestGetPrMetadata:
    @patch("github_plugin.subprocess.run")
    def test_returns_metadata(self, mock_run, plugin):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "title": "Fix bug",
                "body": "description",
                "labels": [{"name": "bug"}],
                "state": "OPEN",
                "additions": 10,
                "deletions": 5,
                "changedFiles": 2,
                "author": {"login": "dev"},
                "headRefName": "fix-branch",
                "baseRefName": "main",
            }),
        )
        result = plugin.get_pr_metadata(200)
        data = json.loads(result)
        assert data["title"] == "Fix bug"
        assert data["labels"] == ["bug"]
        assert data["author"] == "dev"
        assert data["additions"] == 10

    @patch("github_plugin.subprocess.run")
    def test_handles_gh_error(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=1, stderr="PR not found")
        result = plugin.get_pr_metadata(404)
        parsed = json.loads(result)
        assert "error" in parsed


class TestListPrComments:
    @patch("github_plugin.subprocess.run")
    def test_returns_comments(self, mock_run, plugin):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "comments": [
                    {"author": {"login": "user1"}, "body": "LGTM", "createdAt": "2026-01-01"},
                    {"author": {"login": "user2"}, "body": "Fix this", "createdAt": "2026-01-02"},
                ]
            }),
        )
        result = plugin.list_pr_comments(300)
        comments = json.loads(result)
        assert len(comments) == 2
        assert comments[0]["author"] == "user1"

    @patch("github_plugin.subprocess.run")
    def test_limits_20_comments(self, mock_run, plugin):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "comments": [{"author": {"login": "u"}, "body": "x", "createdAt": "d"}] * 30
            }),
        )
        result = plugin.list_pr_comments(300)
        comments = json.loads(result)
        assert len(comments) == 20


class TestPostReviewComment:
    @patch("github_plugin.subprocess.run")
    def test_posts_comment(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=0, stdout="Comment posted")
        result = plugin.post_review_comment(100, "Looks good!")
        data = json.loads(result)
        assert data["status"] == "posted"
        assert data["pr"] == 100

    @patch("github_plugin.subprocess.run")
    def test_handles_post_error(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=1, stderr="Forbidden")
        result = plugin.post_review_comment(100, "comment")
        data = json.loads(result)
        assert "error" in data


class TestGrepCode:
    @patch("github_plugin.subprocess.run")
    def test_returns_matches(self, mock_run, plugin):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=json.dumps([
                {"path": "src/main.ts", "textMatches": [{"fragment": "export function main()"}]}
            ]),
        )
        result = plugin.grep_code("function main")
        data = json.loads(result)
        assert len(data) == 1
        assert data[0]["path"] == "src/main.ts"


class TestRunGhEdgeCases:
    @patch("github_plugin.subprocess.run")
    def test_timeout_expired(self, mock_run, plugin):
        mock_run.side_effect = subprocess.TimeoutExpired(cmd="gh", timeout=30)
        result = plugin.get_pr_diff(1)
        data = json.loads(result)
        assert "timed out" in data["error"]

    @patch("github_plugin.subprocess.run")
    def test_gh_not_found(self, mock_run, plugin):
        mock_run.side_effect = FileNotFoundError()
        result = plugin.get_pr_diff(1)
        data = json.loads(result)
        assert "not found" in data["error"].lower()

    @patch("github_plugin.subprocess.run")
    def test_stderr_used_on_empty_stdout_error(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="fatal: repo not found")
        result = plugin.get_pr_diff(1)
        data = json.loads(result)
        assert "repo not found" in data["error"]
