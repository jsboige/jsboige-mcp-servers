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


class TestReadFile:
    @patch("github_plugin.subprocess.run")
    def test_returns_decoded_content(self, mock_run, plugin):
        import base64
        content = "hello world"
        encoded = base64.b64encode(content.encode()).decode()
        mock_run.return_value = MagicMock(returncode=0, stdout=encoded + "\n")
        result = plugin.read_file("src/main.ts", repo="owner/repo")
        assert result == content

    @patch("github_plugin.subprocess.run")
    def test_truncates_at_50kb(self, mock_run, plugin):
        import base64
        big = "x" * 60000
        encoded = base64.b64encode(big.encode()).decode()
        mock_run.return_value = MagicMock(returncode=0, stdout=encoded + "\n")
        result = plugin.read_file("big.txt", repo="owner/repo")
        assert result.endswith("[truncated at 50KB]")
        assert len(result) < 60000

    def test_requires_repo(self, plugin):
        plugin._default_repo = ""
        result = plugin.read_file("file.txt")
        data = json.loads(result)
        assert "error" in data

    @patch("github_plugin.subprocess.run")
    def test_handles_gh_error(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=1, stderr="not found")
        result = plugin.read_file("missing.txt", repo="owner/repo")
        data = json.loads(result)
        assert "error" in data

    @patch("github_plugin.subprocess.run")
    def test_handles_decode_error(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=0, stdout="not-valid-base64!!!\n")
        result = plugin.read_file("binary.bin", repo="owner/repo")
        data = json.loads(result)
        assert "error" in data

    @patch("github_plugin.subprocess.run")
    def test_api_url_format(self, mock_run, plugin):
        import base64
        encoded = base64.b64encode(b"ok").decode()
        mock_run.return_value = MagicMock(returncode=0, stdout=encoded + "\n")
        plugin.read_file("src/file.ts", ref="abc123", repo="owner/repo")
        args = mock_run.call_args[0][0]
        assert "api" in args
        assert "repos/owner/repo/contents/src/file.ts?ref=abc123" in args


class TestGetFileHistory:
    @patch("github_plugin.subprocess.run")
    def test_returns_commits(self, mock_run, plugin):
        jq_output = (
            '{"sha":"abc123456789","author":"dev","date":"2026-05-20","message":"fix bug"}\n'
            '{"sha":"def456789abc","author":"dev2","date":"2026-05-19","message":"add feature"}\n'
        )
        mock_run.return_value = MagicMock(returncode=0, stdout=jq_output)
        result = plugin.get_file_history("src/main.ts", repo="owner/repo")
        commits = json.loads(result)
        assert len(commits) == 2
        assert commits[0]["sha"] == "abc123456789"
        assert commits[1]["author"] == "dev2"

    @patch("github_plugin.subprocess.run")
    def test_uses_default_repo(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=0, stdout="")
        plugin.get_file_history("src/file.ts")
        args = mock_run.call_args[0][0]
        assert any("test-owner/test-repo" in a for a in args)

    def test_requires_repo(self):
        p = GitHubPlugin()
        result = p.get_file_history("file.txt")
        data = json.loads(result)
        assert "error" in data

    @patch("github_plugin.subprocess.run")
    def test_handles_error(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=1, stderr="path not found")
        result = plugin.get_file_history("missing.ts", repo="owner/repo")
        data = json.loads(result)
        assert "error" in data

    @patch("github_plugin.subprocess.run")
    def test_limit_clamped_to_20(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=0, stdout="")
        plugin.get_file_history("f.ts", repo="o/r", limit=100)
        args = mock_run.call_args[0][0]
        assert "[:20]" in " ".join(args)

    @patch("github_plugin.subprocess.run")
    def test_limit_minimum_1(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=0, stdout="")
        plugin.get_file_history("f.ts", repo="o/r", limit=-5)
        args = mock_run.call_args[0][0]
        assert "[:1]" in " ".join(args)

    @patch("github_plugin.subprocess.run")
    def test_branch_param_passed(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=0, stdout="")
        plugin.get_file_history("f.ts", repo="o/r", branch="develop")
        args = mock_run.call_args[0][0]
        assert any("develop" in a for a in args)

    @patch("github_plugin.subprocess.run")
    def test_empty_history(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=0, stdout="")
        result = plugin.get_file_history("new.ts", repo="owner/repo")
        commits = json.loads(result)
        assert commits == []


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

    @patch("github_plugin.subprocess.run")
    def test_path_filter_in_query(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=0, stdout="[]")
        plugin.grep_code("TODO", repo="owner/repo", path="src/")
        args = mock_run.call_args[0][0]
        assert any("path:src/" in a for a in args)


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
