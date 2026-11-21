# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 443b38c0fae70f64aa46198d51bdb74357df1853
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_grain_names.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for per-GRAIN run names (CoursIA#27133 / #27134, 20/11).

A lot issue carries several notebooks. Every per-run name was keyed by the ISSUE
alone: the scheduler's run dir (`issue-<N>`) and worktree (`wt-<N>`), and the
driver's PR branch (`nbcoder/auto-<N>`). Two grains of one lot then shared a run
dir and a worktree, and the second one's `checkout -b` failed on the first one's
branch after its whole model run had been paid. Each name is now per grain.

The driver half is skipped when `mcp` is not importable (the driver imports the
MCP client at load); the scheduler half always runs.
"""
import importlib.util
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_scheduler", HERE / "nb_coder_scheduler.py")
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)

LOT = "MyIA.AI.Notebooks/Search/Part4-Metaheuristics/MGS-vs-mealpy"
T25 = f"{LOT}/MGS-25-WhaleOptimisation-vs-Mealpy-Rust.ipynb"
T28 = f"{LOT}/MGS-28-BareBonesPSO-vs-Mealpy-Rust.ipynb"


def _sched(tmp_path, items):
    import json
    q = tmp_path / "queue.jsonl"
    q.write_text("\n".join(json.dumps(x) for x in items) + "\n", encoding="utf-8")
    args = S.parse_args(["--queue", str(q), "--state-dir", str(tmp_path / "state"),
                         "--repo", "D:/CoursIA", "--max-active", "2"])
    sched = S.Scheduler(args, spawn=lambda *a, **k: None,
                        gate=lambda: {"verdict": "green", "running": 0, "waiting": 0,
                                      "preemptions": 0},
                        sleep=lambda s=0: None, clock=lambda: 1000.0)
    loaded, digest = S.load_queue(q)
    sched.merge_queue(loaded, digest)
    return sched


def _opt(cmd, flag):
    return cmd[cmd.index(flag) + 1]


# ---------------------------------------------------------------- scheduler
def test_two_grains_of_one_lot_get_distinct_run_dir_and_worktree(tmp_path):
    sched = _sched(tmp_path, [{"issue": 27133, "notebook": T25},
                              {"issue": 27133, "notebook": T28}])
    c25 = sched.driver_command(sched.items_by_key[f"#27133:{T25}"])
    c28 = sched.driver_command(sched.items_by_key[f"#27133:{T28}"])
    assert _opt(c25, "--out-dir") != _opt(c28, "--out-dir")
    assert _opt(c25, "--worktree") != _opt(c28, "--worktree")
    # still readable by issue: an operator greps runs/issue-27133-*
    assert Path(_opt(c25, "--out-dir")).name.startswith("issue-27133-")
    assert Path(_opt(c25, "--worktree")).name.startswith("wt-27133-")


def test_grain_slug_is_stable_and_plane_neutral():
    a = S.grain_slug({"issue": 27133, "notebook": T25})
    assert a == S.grain_slug({"issue": 27133, "notebook": T25})          # reload-stable
    assert a == S.grain_slug({"issue": 27133, "notebook": T25.replace("/", "\\")})
    assert a == S.grain_slug({"issue": 27133, "notebook": "./" + T25})
    assert re.fullmatch(r"27133-[0-9a-f]{8}", a)
    # the issue is part of the name: one notebook named by two issues stays apart
    assert a != S.grain_slug({"issue": 27134, "notebook": T25})


def test_slug_keeps_the_worktree_path_short():
    """CoursIA paths are long; the worktree root already eats ~50 chars on Windows."""
    assert len("wt-" + S.grain_slug({"issue": 27133, "notebook": T25})) <= 20


# ---------------------------------------------------------------- driver
def _driver():
    pytest.importorskip("mcp")
    sys.path.insert(0, str(HERE))
    import nb_coder_driver as d  # noqa: E402
    return d


def test_default_branch_is_per_grain_readable_and_a_valid_ref():
    d = _driver()
    b25, b28 = d.default_pr_branch(27133, T25), d.default_pr_branch(27133, T28)
    assert b25 != b28
    assert b25 == d.default_pr_branch(27133, T25.replace("/", "\\"))
    assert re.fullmatch(r"nbcoder/auto-27133-[a-z0-9-]+-[0-9a-f]{6}", b25), b25
    assert "mgs-25-whaleoptimisation" in b25
    for b in (b25, b28, d.default_pr_branch(1, "X/---.ipynb")):
        rc = subprocess.run(["git", "check-ref-format", "--branch", b],
                            capture_output=True).returncode
        assert rc == 0, b


def test_same_stem_in_two_folders_does_not_collide():
    d = _driver()
    assert d.default_pr_branch(1, "A/Intro.ipynb") != d.default_pr_branch(1, "B/Intro.ipynb")


def _stage5_branch(monkeypatch, pr_branch):
    d = _driver()
    seen = []

    def fake_git(wt, *argv, **_k):
        seen.append(argv)
        return 1, "stop here"            # fail the checkout: stage 5 returns early

    monkeypatch.setattr(d, "_git", fake_git)
    monkeypatch.setattr(d, "_short_desc", lambda *a, **k: "desc")
    args = SimpleNamespace(issue=27133, notebook=T25, pr_branch=pr_branch)
    rec: dict = {}
    d.stage5_pr(args, rec, Path("."), Path("built.ipynb"), {}, None)
    assert rec["verdict"] == "pr-branch-failed"
    assert seen[0][:2] == ("checkout", "-b")
    return seen[0][2], rec["pr"]["branch"], d


def test_stage5_uses_the_per_grain_default(monkeypatch):
    used, recorded, d = _stage5_branch(monkeypatch, None)
    assert used == recorded == d.default_pr_branch(27133, T25)


def test_stage5_keeps_an_explicit_branch(monkeypatch):
    used, recorded, _ = _stage5_branch(monkeypatch, "nbcoder/manual-x")
    assert used == recorded == "nbcoder/manual-x"
