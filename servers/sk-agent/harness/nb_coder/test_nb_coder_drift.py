# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_drift.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Regression pins for the source-twin drift guard (22/11).

CoursIA#27805 (Sudoku-07-Norvig-Rust) was built on a 36-cell Python twin; #27348
added three cells to that twin while the PR was open, and the squash-merge on stale
checks turned `Scripts Tests (CPU)` red for every open PR (fix #27914). These tests
pin the classification (markdown-only vs structure vs code), its reading of a real
git history, the idempotent PR flag, and the stage-5 behaviour: markdown-only drift
re-bases the worktree on origin/main, structure/code drift refuses the push.
"""
import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_drift", _HERE / "nb_coder_drift.py")
nbdr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nbdr)


def _md(src):
    return {"cell_type": "markdown", "source": [src], "metadata": {}}


def _code(src, out=""):
    outs = [{"output_type": "stream", "name": "stdout", "text": [out]}] if out else []
    return {"cell_type": "code", "source": [src], "outputs": outs, "metadata": {},
            "execution_count": 1}


def _nb(cells):
    return {"cells": cells, "metadata": {}, "nbformat": 4, "nbformat_minor": 5}


BASE = _nb([_md("# Titre"), _code("solve()", "ok\n"), _md("## Fin")])


def test_classify_none_and_markdown_only():
    assert nbdr.classify_drift(BASE, json.loads(json.dumps(BASE))) == "none"
    reworded = _nb([_md("# Titre revu"), _code("solve()", "ok\n"), _md("## Fin")])
    assert nbdr.classify_drift(BASE, reworded) == "markdown-only"


def test_classify_structure_when_cells_are_added():
    # The #27348 shape: a measured block inserted mid-notebook.
    grown = _nb([_md("# Titre"), _code("solve()", "ok\n"), _md("### Banc"),
                 _code("bench()", "Easy51 : 1.2 ms\n"), _md("## Fin")])
    assert nbdr.classify_drift(BASE, grown) == "structure"


def test_classify_code_on_source_or_output_change():
    assert nbdr.classify_drift(
        BASE, _nb([_md("# Titre"), _code("solve(fast=True)", "ok\n"), _md("## Fin")])) == "code"
    assert nbdr.classify_drift(
        BASE, _nb([_md("# Titre"), _code("solve()", "ok, 3 pas\n"), _md("## Fin")])) == "code"


def test_classify_deleted():
    assert nbdr.classify_drift(BASE, None) == "deleted"


def _sh(*a, cwd):
    subprocess.run(a, cwd=cwd, check=True, capture_output=True)


def _repo(td: Path) -> Path:
    r = td / "repo"
    r.mkdir()
    _sh("git", "init", "-q", cwd=r)
    _sh("git", "config", "user.email", "t@t.invalid", cwd=r)
    _sh("git", "config", "user.name", "t", cwd=r)
    return r


def _commit(r: Path, rel: str, nb: dict, msg: str) -> str:
    p = r / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8", newline="")
    _sh("git", "add", rel, cwd=r)
    _sh("git", "commit", "-q", "-m", msg, cwd=r)
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=r, capture_output=True,
                          text=True, check=True).stdout.strip()


SRC = "Sudoku/Sudoku-07-Norvig-Python.ipynb"


def test_source_drift_reads_git_history(tmp_path):
    r = _repo(tmp_path)
    base = _commit(r, SRC, BASE, "base")
    grown = _nb(BASE["cells"][:2] + [_code("bench()", "x\n")] + BASE["cells"][2:])
    main = _commit(r, SRC, grown, "Add(sudoku,#27338): banc mesure")
    _sh("git", "update-ref", "refs/remotes/origin/main", main, cwd=r)
    rec = nbdr.source_drift(r, base, SRC)
    assert rec["drift"] == "structure"
    assert rec["base_blob"] != rec["main_blob"]
    assert any("banc mesure" in c for c in rec["commits"])
    assert nbdr.source_drift(r, main, SRC)["drift"] == "none"


def test_source_absent_at_base_or_unreadable_main_is_unmeasured(tmp_path):
    r = _repo(tmp_path)
    base = _commit(r, "README.md", {"x": 1}, "init")
    # No origin/main ref, no source at the base: never read as "deleted".
    assert nbdr.source_drift(r, base, SRC)["drift"] == "unmeasured"
    _commit(r, SRC, BASE, "twin")
    assert nbdr.source_drift(r, "HEAD", SRC)["drift"] == "unmeasured"  # main unreadable
    gone = _commit(r, SRC + ".moved", BASE, "x")
    _sh("git", "rm", "-q", SRC, cwd=r)
    _sh("git", "commit", "-q", "-m", "drop twin", cwd=r)
    main = subprocess.run(["git", "rev-parse", "HEAD"], cwd=r, capture_output=True,
                          text=True, check=True).stdout.strip()
    _sh("git", "update-ref", "refs/remotes/origin/main", main, cwd=r)
    assert nbdr.source_drift(r, gone, SRC)["drift"] == "deleted"


def test_modified_notebooks_lists_only_modified_ipynb(tmp_path):
    r = _repo(tmp_path)
    base = _commit(r, SRC, BASE, "base")
    _commit(r, SRC, _nb(BASE["cells"] + [_md("nav")]), "nav link")
    head = _commit(r, "Sudoku/Sudoku-07-Norvig-Rust.ipynb", BASE, "port")
    assert nbdr.modified_notebooks(r, base, head) == [SRC]


def test_flag_is_idempotent_per_main_blob():
    body = nbdr.drift_comment([{"source": SRC, "drift": "structure", "base_blob": "aaa",
                                "main_blob": "bbb", "commits": ["abc Add bench"]}])
    assert body.startswith("[SOURCE-DRIFT]")
    assert nbdr.already_flagged(["autre", body], "bbb")
    # A later move of the twin is a new event and gets its own flag.
    assert not nbdr.already_flagged([body], "ccc")


def test_only_our_lane_is_commented():
    body = "MED/notebook — lane x\n\n**Grain** : lane `myia-ai-01:vllm`. Issue #1."
    assert nbdr.delivered_by(body, "myia-ai-01:vllm")
    assert not nbdr.delivered_by(body.replace("myia-ai-01:vllm", "myia-po-2028:CoursIA"),
                                 "myia-ai-01:vllm")
    assert not nbdr.delivered_by(None, "myia-ai-01:vllm")


# ---------------------------------------------------------------- stage 5 wiring

def _driver():
    pytest.importorskip("mcp")
    spec = importlib.util.spec_from_file_location("nbcd_drift", _HERE / "nb_coder_driver.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _worktree_on(tmp_path, main_nb):
    """A repo whose HEAD is the build base and whose origin/main moved the twin."""
    r = _repo(tmp_path)
    base = _commit(r, SRC, BASE, "base")
    main = _commit(r, SRC, main_nb, "twin moved")
    _sh("git", "update-ref", "refs/remotes/origin/main", main, cwd=r)
    _sh("git", "checkout", "-q", "--detach", base, cwd=r)
    return r, base, main


def _head(r):
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=r, capture_output=True,
                          text=True, check=True).stdout.strip()


def test_stage5_markdown_only_drift_rebases_on_origin_main(tmp_path):
    nbcd = _driver()
    r, base, main = _worktree_on(
        tmp_path, _nb([_md("# Titre revu"), _code("solve()", "ok\n"), _md("## Fin")]))
    drift = nbcd.stage5_source_drift(r, SRC)
    assert drift["drift"] == "markdown-only" and drift["rebased"] is True
    assert "fetch_error" in drift  # no remote here: fail-open, said
    assert _head(r) == main


def test_stage5_structure_drift_leaves_the_worktree_and_reports(tmp_path):
    nbcd = _driver()
    r, base, main = _worktree_on(
        tmp_path, _nb(BASE["cells"] + [_code("bench()", "x\n")]))
    drift = nbcd.stage5_source_drift(r, SRC)
    assert drift["drift"] == "structure" and "rebased" not in drift
    assert _head(r) == base


def test_source_drifted_is_a_content_failure_for_the_ramp():
    spec = importlib.util.spec_from_file_location("nbcs_drift", _HERE / "nb_coder_scheduler.py")
    sch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sch)
    assert sch.failure_class("source-drifted:structure") == "content"
