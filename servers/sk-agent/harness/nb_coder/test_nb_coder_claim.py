# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 8c0e0230e37e1543dcdaf3f0a00f5de8857273e7
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_claim.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Regression pins for the #466 fixes: scoped claim check + kernel working_dir.

Two measured defects (jsboige/vllm#466, cycle 17/11 00:4xZ):
- `check_claim()` called check_lane_claim.py WITHOUT `--paths`, so the guard answered
  NOT_SCOPED (rc=2) whenever any PR touched the issue but none named this notebook —
  and the driver let rc=2 pass where a scoped check says BLOCKED. Measured on
  CoursIA#27018 vs PR #27025 (po-2023, 21:29Z): scoped = rc=1, unscoped = rc=2.
- The execution kernel started with no `working_dir`, inheriting the MCP server's cwd
  (the out-dir); CoursIA#27021 lost 5 cells on `import ict` — the ICT package sits
  next to the SOURCE notebook in the worktree.

Skipped when `mcp` is not importable (the driver imports the MCP client at load).
"""
import asyncio
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as nbcd  # noqa: E402


def test_check_claim_scopes_to_the_notebook(monkeypatch, tmp_path):
    """The guard must receive --paths <notebook>: unscoped, rc=2 masquerades as clear."""
    seen = {}

    def fake_run(argv, **kw):
        seen["argv"] = argv
        class P:
            returncode = 0
            stdout = "CLEAR"
            stderr = ""
        return P()

    monkeypatch.setattr(nbcd.subprocess, "run", fake_run)
    guard = tmp_path / "scripts" / "check_lane_claim.py"
    guard.parent.mkdir(exist_ok=True)
    guard.write_text("# stub", encoding="utf-8")
    out = nbcd.check_claim(tmp_path, 27018, "myia-ai-01:vllm", "19451-ICT/ICT-18b/nb.ipynb")
    assert seen["argv"][seen["argv"].index("--paths") + 1] == "19451-ICT/ICT-18b/nb.ipynb"
    assert out["rc"] == 0 and out["ok"] is True


def test_claim_verdict_is_fail_closed():
    v = nbcd.claim_verdict
    assert v({"rc": 1}) == "refused-claim-held-by-another-lane"
    # rc=2 passed through before #466 — now it refuses
    assert v({"rc": 2}) == "refused-claim-check-not-scoped"
    # absent guard used to KeyError mid-run; now a crash-free refusal
    assert v({"ok": None, "error": "check_lane_claim.py absent"}) == "refused-claim-check-broken"
    assert v({"rc": 0}) is None


def test_start_kernel_sends_working_dir(monkeypatch, tmp_path):
    """#27021: the kernel cwd must be the source notebook's directory, not the out-dir."""
    captured = {}

    async def fake_pm_call(pm, tool, payload):
        captured["tool"] = tool
        captured["payload"] = payload
        return {"kernel_id": "k-466"}

    monkeypatch.setattr(nbcd, "pm_call", fake_pm_call)
    kid = asyncio.run(nbcd.start_kernel(None, "python3", tmp_path))
    assert kid == "k-466"
    assert captured["tool"] == "manage_kernel"
    assert captured["payload"]["working_dir"] == str(tmp_path)
