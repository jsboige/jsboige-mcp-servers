"""Tests for github_plugin.py — GitHub PR review plugin for sk-agent."""

import json
import subprocess
from unittest.mock import patch, MagicMock

import pytest

from semantic_kernel.functions.kernel_plugin import KernelPlugin

from github_plugin import GitHubPlugin, GitHubWritePlugin


@pytest.fixture
def plugin():
    return GitHubPlugin(default_repo="test-owner/test-repo")


@pytest.fixture
def write_plugin():
    return GitHubWritePlugin(default_repo="test-owner/test-repo")


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
    def test_posts_comment(self, mock_run, write_plugin):
        mock_run.return_value = MagicMock(returncode=0, stdout="Comment posted")
        result = write_plugin.post_review_comment(100, "Looks good!")
        data = json.loads(result)
        assert data["status"] == "posted"
        assert data["pr"] == 100

    @patch("github_plugin.subprocess.run")
    def test_handles_post_error(self, mock_run, write_plugin):
        mock_run.return_value = MagicMock(returncode=1, stderr="Forbidden")
        result = write_plugin.post_review_comment(100, "comment")
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


class TestWriteGate:
    """``github_write`` gates the write surface (#3408, split by #4725).

    The write function now lives on ``GitHubWritePlugin``: a read-only agent's
    kernel function list must not ADVERTISE what it may not call — the old
    shape registered it and refused at call time, so the model could see and
    burn a turn on a forbidden tool.
    """

    def test_write_plugin_posts_by_default(self):
        p = GitHubWritePlugin(default_repo="a/b")
        with patch("github_plugin.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="")
            result = p.post_review_comment(1, "nit: typo")
        assert json.loads(result)["status"] == "posted"
        mock_run.assert_called_once()

    def test_write_plugin_refuses_without_allow_write(self):
        """Second, in-process guard: constructing the write class without the
        grant must refuse rather than post."""
        p = GitHubWritePlugin(default_repo="a/b", allow_write=False)
        with patch("github_plugin.subprocess.run") as mock_run:
            with pytest.raises(ValueError) as exc_info:
                p.post_review_comment(1, "nit: typo")
            mock_run.assert_not_called()
        assert "github_write" in str(exc_info.value)

    def test_read_only_plugin_does_not_expose_the_write_function(self):
        """#4725 criterion 5: the agent's tool list is the verification
        surface — ``post_review_comment`` must not be registered at all."""
        kernel_plugin = KernelPlugin.from_object(
            "github", GitHubPlugin(default_repo="a/b", allow_write=False)
        )
        assert "post_review_comment" not in kernel_plugin.functions
        assert "get_pr_diff" in kernel_plugin.functions  # read surface intact

    def test_write_granted_plugin_exposes_the_write_function(self):
        kernel_plugin = KernelPlugin.from_object(
            "github", GitHubWritePlugin(default_repo="a/b", allow_write=True)
        )
        assert "post_review_comment" in kernel_plugin.functions

    def test_read_functions_unaffected_by_allow_write(self):
        p = GitHubPlugin(default_repo="a/b", allow_write=False)
        with patch("github_plugin.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="diff")
            p.get_pr_diff(1)
        mock_run.assert_called_once()


# --- Child stdin (#1587; same class as the capacity gate, #4712) -------------
# A child spawned by the stdio MCP server that inherits stdin inherits the
# server's JSON-RPC pipe. Measured on the real server (ai-01, 15/11/2026): the
# plugin's `gh pr diff` timed out at 30 s twice in a row with stdin inherited
# and answered in 0.98 s with stdin=DEVNULL. Standalone runs never show it.

import ast
import os
import stat
import sys
import tempfile
import threading
from pathlib import Path

_SK_DIR = Path(__file__).resolve().parent
_SUBPROCESS_FUNCS = {"run", "Popen", "call", "check_output", "check_call"}
_ASYNCIO_FUNCS = {"create_subprocess_exec", "create_subprocess_shell"}


def _child_calls_without_stdin(source: str):
    """(lineno, call) for every subprocess/asyncio child spawn lacking stdin=."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        owner = node.func.value
        name = owner.id if isinstance(owner, ast.Name) else (
            owner.attr if isinstance(owner, ast.Attribute) else None)
        spawns = (name == "subprocess" and node.func.attr in _SUBPROCESS_FUNCS) or (
            node.func.attr in _ASYNCIO_FUNCS)
        if spawns and not any(k.arg == "stdin" for k in node.keywords):
            found.append((node.lineno, f"{name}.{node.func.attr}"))
    return found


class TestChildStdin:
    def test_every_server_child_spawn_sets_stdin(self):
        offenders = []
        for path in sorted(_SK_DIR.glob("*.py")):
            if path.name.startswith("test_") or path.name == "conftest.py":
                continue
            for lineno, call in _child_calls_without_stdin(path.read_text(encoding="utf-8")):
                offenders.append(f"{path.name}:{lineno} {call}")
        assert offenders == [], (
            "child spawned without stdin= (inherits the stdio server's JSON-RPC "
            "pipe and hangs on Windows): " + ", ".join(offenders))

    def test_guard_detects_a_missing_stdin(self):
        src = "import subprocess\nsubprocess.run(['x'], capture_output=True)\n"
        assert _child_calls_without_stdin(src) == [(2, "subprocess.run")]

    @patch("github_plugin.subprocess.run")
    def test_run_gh_passes_devnull(self, mock_run, plugin):
        mock_run.return_value = MagicMock(returncode=0, stdout="ok")
        plugin.get_pr_files(1)
        assert mock_run.call_args.kwargs["stdin"] is subprocess.DEVNULL

    @pytest.mark.skipif(os.name == "nt", reason="fake gh needs a POSIX shebang script")
    def test_run_gh_returns_while_parent_stdin_pipe_stays_open(self):
        """Discriminant: the driver's stdin pipe stays OPEN (never communicate()),
        and the fake gh reads stdin to EOF. Inherited stdin -> the fake gh blocks
        until _run_gh's timeout; DEVNULL -> immediate EOF."""
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "gh"
            fake.write_text("#!/bin/sh\ncat > /dev/null\necho fake-gh-ok\n")
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            code = (
                "import sys; sys.path.insert(0, %r)\n"
                "from github_plugin import GitHubPlugin\n"
                "print(GitHubPlugin()._run_gh(['probe'], timeout=5), flush=True)\n"
            ) % str(_SK_DIR)
            env = dict(os.environ, PATH=tmp + os.pathsep + os.environ.get("PATH", ""))
            proc = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    env=env, text=True, encoding="utf-8", errors="replace")
            out = []
            reader = threading.Thread(target=lambda: out.append(proc.stdout.read()))
            reader.start()
            reader.join(30)
            proc.stdin.close()
            proc.wait(10)
        text = "".join(out)
        assert "fake-gh-ok" in text, f"_run_gh did not return the child output: {text!r}"
        assert "timed out" not in text
