"""
Native Semantic Kernel plugin for GitHub PR operations via `gh` CLI.

Provides structured access to PR diffs, metadata, and review posting
for multi-tier automated code reviews (Issue #1587).

Usage in sk-agent:
    from github_plugin import GitHubPlugin
    plugin = GitHubPlugin()
    agent_plugins.append(plugin)
    # SK auto-discovers @kernel_function decorated methods.
"""

from __future__ import annotations

import json
import logging
import subprocess
from typing import Any

from semantic_kernel.functions import kernel_function

log = logging.getLogger("sk-agent.github")


class GitHubPlugin:
    """GitHub PR operations via `gh` CLI for automated code reviews."""

    def __init__(self, default_repo: str = ""):
        self._default_repo = default_repo

    def _run_gh(self, args: list[str], timeout: int = 30) -> str:
        """Run a gh CLI command and return stdout."""
        cmd = ["gh"] + args
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                encoding="utf-8",
            )
            if result.returncode != 0:
                error = result.stderr.strip() or result.stdout.strip()
                log.warning("gh %s failed (rc=%d): %s", args[0], result.returncode, error[:200])
                return json.dumps({"error": error[:500]})
            return result.stdout
        except subprocess.TimeoutExpired:
            log.warning("gh %s timed out after %ds", args[0], timeout)
            return json.dumps({"error": f"Command timed out after {timeout}s"})
        except FileNotFoundError:
            return json.dumps({"error": "gh CLI not found. Install GitHub CLI."})

    @kernel_function(
        description="Get the diff of a GitHub pull request. Returns unified diff text.",
        name="get_pr_diff",
    )
    def get_pr_diff(
        self,
        pr_number: int,
        repo: str = "",
    ) -> str:
        """Get the diff of a pull request.

        Args:
            pr_number: PR number (e.g. 1234)
            repo: Repository in owner/repo format. Uses default if empty.
        """
        repo = repo or self._default_repo
        args = ["pr", "diff", str(pr_number)]
        if repo:
            args.extend(["--repo", repo])
        return self._run_gh(args, timeout=60)

    @kernel_function(
        description="Get the list of files changed in a pull request. Returns JSON array.",
        name="get_pr_files",
    )
    def get_pr_files(
        self,
        pr_number: int,
        repo: str = "",
    ) -> str:
        """Get the list of files changed in a pull request.

        Args:
            pr_number: PR number
            repo: Repository in owner/repo format
        """
        repo = repo or self._default_repo
        args = ["pr", "diff", str(pr_number), "--name-only"]
        if repo:
            args.extend(["--repo", repo])
        output = self._run_gh(args, timeout=30)
        if output.startswith('{"error"'):
            return output
        files = [f.strip() for f in output.strip().split("\n") if f.strip()]
        return json.dumps(files)

    @kernel_function(
        description="Get pull request metadata as JSON (title, body, labels, state, additions, deletions, files count).",
        name="get_pr_metadata",
    )
    def get_pr_metadata(
        self,
        pr_number: int,
        repo: str = "",
    ) -> str:
        """Get PR metadata as JSON.

        Args:
            pr_number: PR number
            repo: Repository in owner/repo format
        """
        repo = repo or self._default_repo
        fields = "title,body,labels,state,additions,deletions,changedFiles,author,createdAt,updatedAt,headRefName,baseRefName"
        args = ["pr", "view", str(pr_number), "--json", fields]
        if repo:
            args.extend(["--repo", repo])
        output = self._run_gh(args, timeout=15)
        if output.startswith('{"error"'):
            return output
        try:
            data = json.loads(output)
            if "labels" in data:
                data["labels"] = [l.get("name", str(l)) for l in data["labels"]]
            if "author" in data and isinstance(data["author"], dict):
                data["author"] = data["author"].get("login", str(data["author"]))
            return json.dumps(data, indent=2)
        except json.JSONDecodeError:
            return output

    @kernel_function(
        description="List existing review comments on a pull request. Returns JSON array.",
        name="list_pr_comments",
    )
    def list_pr_comments(
        self,
        pr_number: int,
        repo: str = "",
    ) -> str:
        """List review comments on a PR.

        Args:
            pr_number: PR number
            repo: Repository in owner/repo format
        """
        repo = repo or self._default_repo
        args = ["pr", "view", str(pr_number), "--comments", "--json", "comments"]
        if repo:
            args.extend(["--repo", repo])
        output = self._run_gh(args, timeout=15)
        if output.startswith('{"error"'):
            return output
        try:
            data = json.loads(output)
            comments = data.get("comments", [])
            simplified = []
            for c in comments[:20]:
                simplified.append({
                    "author": c.get("author", {}).get("login", "unknown") if isinstance(c.get("author"), dict) else str(c.get("author", "")),
                    "body": c.get("body", "")[:500],
                    "createdAt": c.get("createdAt", ""),
                })
            return json.dumps(simplified, indent=2)
        except json.JSONDecodeError:
            return output

    @kernel_function(
        description="Post a review comment on a pull request. Returns confirmation or error.",
        name="post_review_comment",
    )
    def post_review_comment(
        self,
        pr_number: int,
        body: str,
        repo: str = "",
    ) -> str:
        """Post a review comment on a PR.

        Args:
            pr_number: PR number
            body: Comment body (markdown)
            repo: Repository in owner/repo format
        """
        repo = repo or self._default_repo
        args = ["pr", "comment", str(pr_number), "--body", body]
        if repo:
            args.extend(["--repo", repo])
        output = self._run_gh(args, timeout=15)
        if output.startswith('{"error"'):
            return output
        return json.dumps({"status": "posted", "pr": pr_number})

    @kernel_function(
        description="Get the content of a file at a specific branch/tag/commit. Returns file content or error.",
        name="read_file",
    )
    def read_file(
        self,
        path: str,
        ref: str = "HEAD",
        repo: str = "",
    ) -> str:
        """Read a file from the repository at a specific ref.

        Args:
            path: File path in the repository
            ref: Git ref (branch, tag, commit SHA). Default: HEAD
            repo: Repository in owner/repo format
        """
        repo = repo or self._default_repo
        args = ["api", f"repos/{repo}/contents/{path}?ref={ref}", "--jq", ".content"]
        if repo:
            pass  # repo already in URL
        else:
            return json.dumps({"error": "repo is required for read_file"})
        output = self._run_gh(args, timeout=15)
        if output.startswith('{"error"'):
            return output
        import base64
        try:
            content = base64.b64decode(output.strip()).decode("utf-8", errors="replace")
            if len(content) > 50000:
                return content[:50000] + "\n... [truncated at 50KB]"
            return content
        except Exception as e:
            return json.dumps({"error": f"Failed to decode file: {e}"})

    @kernel_function(
        description="Search code in a repository using grep pattern. Returns matching file paths and line numbers.",
        name="grep_code",
    )
    def grep_code(
        self,
        pattern: str,
        repo: str = "",
        path: str = "",
    ) -> str:
        """Search code in a repository.

        Args:
            pattern: Search pattern (literal or regex)
            repo: Repository in owner/repo format
            path: Optional path prefix to limit search
        """
        repo = repo or self._default_repo
        args = ["search", "code", pattern, "--repo", repo, "--json", "path,textMatches"]
        if path:
            args.extend(["--", path])
        output = self._run_gh(args, timeout=30)
        if output.startswith('{"error"'):
            return output
        try:
            results = json.loads(output)
            simplified = []
            for r in results[:20]:
                simplified.append({
                    "path": r.get("path", ""),
                    "matches": [m.get("fragment", "")[:200] for m in r.get("textMatches", [])[:3]],
                })
            return json.dumps(simplified, indent=2)
        except json.JSONDecodeError:
            return output
