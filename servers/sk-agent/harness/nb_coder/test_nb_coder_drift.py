# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_drift.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
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
                          text=True, encoding="utf-8", errors="replace", check=True).stdout.strip()


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
                          text=True, encoding="utf-8", errors="replace", check=True).stdout.strip()
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
                          text=True, encoding="utf-8", errors="replace", check=True).stdout.strip()


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


# ------------------------------------------- markdown cells the source only GAINED
# 23/11, CoursIA#28209: a 44-cell port was APPROVED at the 19th verifier pass, then
# #28239 inserted ONE markdown cell (« ancres Lectures », index 43) in the 44-cell
# Python twin; stage 5 read it `structure` and refused the port. An addition of
# markdown cells changes no cell the verifier judged: it is grafted, not re-ported.

GAINED = _nb([_md("# Titre"), _code("solve()", "ok\n"), _md("### Ancres Lectures"),
             _md("## Fin")])


def _port_of(nb: dict):
    """A port cell-aligned with `nb`: same cell types in the same order, its own text,
    ids equal to the cell index (the harness's own scheme)."""
    return _nb([json.loads(json.dumps(c)) | {"id": f"cell-{k:03d}", "source": [f"port {k}"]}
                for k, c in enumerate(nb["cells"])])


def test_only_markdown_cells_gained_is_markdown_added():
    assert nbdr.markdown_insertions(BASE, GAINED) == [2]
    assert nbdr.classify_drift(BASE, GAINED) == "markdown-added"
    assert nbdr.classify_drift(BASE, _nb([_md("haut")] + BASE["cells"])) == "markdown-added"
    both = _nb([_md("haut")] + BASE["cells"] + [_md("bas")])
    assert nbdr.markdown_insertions(BASE, both) == [0, 4]
    assert nbdr.classify_drift(GAINED, json.loads(json.dumps(GAINED))) == "none"


@pytest.mark.parametrize("new", [
    # a gained CODE cell (the #27348 shape of #27805)
    _nb([_md("# Titre"), _code("bench()", "x\n"), _code("solve()", "ok\n"), _md("## Fin")]),
    # a cell removed -- a markdown one counts
    _nb([_md("# Titre"), _code("solve()", "ok\n")]),
    # a cell changed AND a markdown cell gained
    _nb([_md("# Titre revu"), _code("solve()", "ok\n"), _md("ajout"), _md("## Fin")]),
    # a code cell re-typed as markdown
    _nb([_md("# Titre"), _md("solve()"), _md("## Fin")]),
])
def test_anything_else_is_still_structure(new):
    assert nbdr.markdown_insertions(BASE, new) is None
    assert nbdr.classify_drift(BASE, new) == "structure"


def test_source_drift_reports_the_gained_indices_from_git(tmp_path):
    r = _repo(tmp_path)
    base = _commit(r, SRC, BASE, "base")
    main = _commit(r, SRC, GAINED, "Add(notebooks,#19274): ancres Lectures")
    _sh("git", "update-ref", "refs/remotes/origin/main", main, cwd=r)
    rec = nbdr.source_drift(r, base, SRC)
    assert rec["drift"] == "markdown-added" and rec["inserted"] == [2]
    assert "inserted" not in nbdr.source_drift(r, main, SRC)      # no drift, no plan


def test_an_open_pr_is_still_flagged_when_the_twin_gained_markdown():
    # the graft is a stage-5 gesture: a PR already pushed holds none of the added cells
    assert "markdown-added" in nbdr.REFRESH_NEEDED
    assert "`markdown-added`" in nbdr.drift_comment(
        [{"source": SRC, "drift": "markdown-added", "base_blob": "aaa", "main_blob": "bbb"}])


def test_graft_copies_the_gained_cells_at_their_index_and_nothing_else():
    port, before = _port_of(BASE), _port_of(BASE)
    res = nbdr.graft_markdown(port, BASE, GAINED)
    assert res["count"] == 1 and res["already"] is False
    assert res["inserted"] == [{"index": 2, "preview": "### Ancres Lectures"}]
    cells = res["cells"]
    assert [c["cell_type"] for c in cells] == [c["cell_type"] for c in GAINED["cells"]]
    assert cells[2] == GAINED["cells"][2] | {"id": "cell-002"}    # verbatim, the port's ids
    assert cells[3] == before["cells"][2] | {"id": "cell-003"}    # content kept, id = index
    assert cells[:2] == before["cells"][:2]
    assert port == before                                         # the caller's object is not mutated


def test_graft_at_both_ends_and_twice_is_idempotent():
    new = _nb([_md("haut")] + BASE["cells"] + [_md("bas")])
    port = _port_of(BASE)
    first = nbdr.graft_markdown(port, BASE, new)
    assert [g["index"] for g in first["inserted"]] == [0, 4] and len(first["cells"]) == 5
    again = nbdr.graft_markdown(port | {"cells": first["cells"]}, BASE, new)
    assert again["already"] is True and again["count"] == 0
    assert again["cells"] == first["cells"]


def test_graft_refuses_anything_not_proven_aligned():
    short = _port_of(_nb(BASE["cells"][:2]))
    res = nbdr.graft_markdown(short, BASE, GAINED)
    assert "not cell-aligned" in res["error"] and "cells" not in res
    # the new source's SHAPE without its added cell is never read as "already grafted"
    res = nbdr.graft_markdown(_port_of(GAINED), BASE, GAINED)
    assert "not its added cells" in res["error"] and "cells" not in res


def _ported_repo(td: Path, main_nb: dict | None):
    """A repo whose HEAD is detached on the build base and whose origin/main moved —
    the twin when `main_nb` is given, another file when it is None (the twin did not
    move); a real remote, so stage 5's fetch and re-base are the real gestures."""
    origin = td / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", str(origin)], check=True,
                   capture_output=True, cwd=td)
    r = _repo(td)
    _sh("git", "checkout", "-q", "-b", "main", cwd=r)
    _sh("git", "remote", "add", "origin", str(origin).replace("\\", "/"), cwd=r)
    base = _commit(r, SRC, BASE, "base")
    _sh("git", "push", "-q", "origin", "main", cwd=r)

    _sh("git", "checkout", "-q", "-b", "twin-move", cwd=r)
    if main_nb is None:
        (r / "README.md").write_text("main moved elsewhere\n", encoding="utf-8")
        _sh("git", "add", "README.md", cwd=r)
        _sh("git", "commit", "-q", "-m", "main moved elsewhere", cwd=r)
        main = _head(r)
    else:
        main = _commit(r, SRC, main_nb, "twin moved")
    _sh("git", "push", "-q", "origin", "twin-move:main", cwd=r)
    _sh("git", "checkout", "-q", "--detach", base, cwd=r)
    return r, base, main


PORT = "Sudoku/Sudoku-07-Norvig-Rust.ipynb"

from types import SimpleNamespace  # noqa: E402  (stage-5 stubs below)


def _hered(mo, tmp_path):
    """No global git config, no hooks: the only identity is the driver's own."""
    empty = tmp_path / "empty-gitconfig"
    empty.write_text("", encoding="utf-8")
    mo.setenv("GIT_CONFIG_GLOBAL", str(empty))
    mo.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for var in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME",
                "GIT_COMMITTER_EMAIL"):
        mo.delenv(var, raising=False)


def _port_file(out: Path, nb: dict) -> Path:
    p = out / "nb_7_built.ipynb"
    p.write_text(json.dumps(_port_of(nb), ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                 encoding="utf-8", newline="")
    return p


def _stage5(out: Path):
    from types import SimpleNamespace
    args = SimpleNamespace(issue=7, notebook=PORT, pr_branch=None, agent="producer",
                           verifier_agent="critic", grain_tier="MED", lane="lane:a",
                           pr_base="main", pr_repo="jsboige/CoursIA", out_dir=str(out))
    rec = {"plan": {"plan": []}, "revisions": [], "stages": {},
           "verify": {"verdict": "approve", "model_used": "m", "conversation_id": "v",
                      "findings": []},
           "kernel": {"kernel_name": "python3"}, "execution": [1], "c2": {"sequential": True},
           "calls": [], "conversation_id": "p", "create_mode": {"source": SRC, "target": PORT}}
    return args, rec


def _stub_delivery(mo, nbcd):
    bodies = {}

    def fake_gh(argv, token=None, timeout=60):
        if argv[1].endswith("/pulls"):
            bodies["pr"] = Path(argv[argv.index("-F") + 1][len("body=@"):]).read_text(
                encoding="utf-8")
            return 0, json.dumps({"number": 28209, "html_url": "pr-url"})
        return 0, "{}"

    mo.setattr(nbcd, "gh", fake_gh)
    mo.setattr(nbcd, "lane_predecessor", lambda *a, **k: None)
    # this file pins the graft; the repo integration has its own suite
    mo.setattr(nbcd, "_load_integrate_module", lambda: SimpleNamespace(
        integrate=lambda *a, **k: {"error": "stubbed: integration has its own suite"},
        find_twin_pair=lambda *a: None, replay_guards=lambda *a: [],
        register_pair=lambda *a, **k: {}))
    return bodies


def test_stage5_grafts_what_the_twin_gained_then_rebases_and_delivers(tmp_path):
    import os
    import subprocess
    from types import SimpleNamespace
    mo = pytest.MonkeyPatch()
    try:
        _hered(mo, tmp_path)
        nbcd = _driver()
        r, base, main = _ported_repo(tmp_path, GAINED)
        out = tmp_path / "out"
        out.mkdir()
        built = _port_file(out, BASE)
        args, rec = _stage5(out)
        bodies = _stub_delivery(mo, nbcd)

        nbcd.stage5_pr(args, rec, r, built, {"issue": 7}, None)
    finally:
        mo.undo()

    assert rec["verdict"] == "pr-created", rec.get("pr")
    assert rec["pr"]["graft"]["count"] == 1
    assert rec["pr"]["graft"]["inserted"] == [{"index": 2, "preview": "### Ancres Lectures"}]
    assert rec["pr"]["source_drift"]["drift"] == "markdown-added"
    assert rec["pr"]["source_drift"]["rebased"] is True and _head(r) != base
    pushed = json.loads(subprocess.run(
        ["git", "-C", str(r), "show", f"HEAD:{PORT}"], capture_output=True, text=True,
        encoding="utf-8", check=True).stdout)
    assert [c["source"] for c in pushed["cells"]] == [
        ["port 0"], ["port 1"], ["### Ancres Lectures"], ["port 2"]]
    assert [c["id"] for c in pushed["cells"]] == ["cell-000", "cell-001", "cell-002", "cell-003"]
    # the build was rewritten in its own serialisation: parse + dump gives back the file
    assert (json.dumps(pushed, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
            == built.read_text(encoding="utf-8"))
    (backup,) = list(out.glob("nb_7_built.pre-graft-*.ipynb"))
    assert json.loads(backup.read_text(encoding="utf-8")) == _port_of(BASE)   # kept whole
    # said where a reviewer reads: the PR body and the commit
    assert ("gagné 1 cellule(s) markdown" in bodies["pr"] and "indice(s) 2" in bodies["pr"])
    message = subprocess.run(["git", "-C", str(r), "log", "-1", "--format=%B"],
                             capture_output=True, text=True, encoding="utf-8").stdout
    assert "Cellule(s) markdown 2" in message


def test_stage5_graft_refusal_leaves_the_build_and_the_worktree_untouched(tmp_path):
    """Measured BEFORE any re-base, on purpose: a worktree left on origin/main would
    read "no drift" on the next attempt and push a port without the gained cells."""
    mo = pytest.MonkeyPatch()
    try:
        _hered(mo, tmp_path)
        nbcd = _driver()
        r, base, main = _ported_repo(tmp_path, GAINED)
        out = tmp_path / "out"
        out.mkdir()
        built = _port_file(out, _nb(BASE["cells"][:2]))       # not cell-aligned: no proof
        raw = built.read_bytes()
        mo.setattr(nbcd, "_load_integrate_module",
                   lambda: pytest.fail("nothing runs after a refusal"))
        args, rec = _stage5(out)
        nbcd.stage5_pr(args, rec, r, built, {"issue": 7}, None)
    finally:
        mo.undo()

    assert rec["verdict"] == "source-drifted:graft-failed", rec.get("pr")
    assert "not cell-aligned" in rec["pr"]["error"]
    assert built.read_bytes() == raw and not list(out.glob("*.pre-graft-*"))
    assert _head(r) == base and "rebased" not in rec["pr"]["source_drift"]


def test_the_graft_restores_the_approved_build_on_any_failed_write(tmp_path):
    """#1885 review: the backup was restored on `OSError` only. The write is one
    `fh.write(out)`: it can also die ENCODING (UnicodeEncodeError is a ValueError), and
    the file is already truncated by then -- an approved build left half-written."""
    mo = pytest.MonkeyPatch()
    try:
        _hered(mo, tmp_path)
        nbcd = _driver()
        r, base, main = _ported_repo(tmp_path, GAINED)
        out = tmp_path / "out"
        out.mkdir()
        built = _port_file(out, BASE)
        raw = built.read_bytes()
        real_open = open

        class Dying:
            """The real `open(..., "w")` -- truncation included -- then a write that dies
            encoding, as `fh.write` does on a string the file's codec cannot encode."""

            def __init__(self, fh):
                self._fh = fh

            def __enter__(self):
                self._fh.__enter__()
                return self

            def __exit__(self, *a):
                return self._fh.__exit__(*a)

            def write(self, _text):
                raise UnicodeEncodeError("utf-8", "\ud800", 0, 1, "unexpected end of data")

        def dying_open(path, mode="r", *a, **k):
            fh = real_open(path, mode, *a, **k)
            return Dying(fh) if "w" in mode else fh

        mo.setattr(nbcd, "open", dying_open, raising=False)
        res = nbcd.stage5_graft_markdown(r, SRC, {}, built, base_rev="HEAD")
    finally:
        mo.undo()

    assert res["ok"] is False and res["error"].startswith("UnicodeEncodeError"), res
    assert built.read_bytes() == raw, "the approved build is back, byte for byte"
    (backup,) = list(out.glob("nb_7_built.pre-graft-*.ipynb"))
    assert backup.read_bytes() == raw


def test_stage5_measure_only_leaves_the_worktree_where_it_is(tmp_path):
    nbcd = _driver()
    r, base, main = _ported_repo(tmp_path, GAINED)
    drift = nbcd.stage5_source_drift(r, SRC, rebase=False)
    assert drift["drift"] == "markdown-added" and drift["inserted"] == [2]
    assert "fetch_error" not in drift and _head(r) == base


@pytest.mark.parametrize("resumed, flag", [(True, "-B"), (False, "-b")])
def test_only_a_pr_resume_recreates_the_branch_it_finds(tmp_path, resumed, flag):
    """The scheduler releases a failed grain's worktree, never its branch: a stage-5-only
    resume would die on `checkout -b` ("already exists"). A first run keeps `-b`, so a
    branch that exists is still an error there."""
    nbcd = _driver()
    calls = []

    def fake_git(wt, *a, **k):
        calls.append(a)
        return (1, "fatal: a branch named 'x' already exists") \
            if a == ("checkout", flag, "nbcoder/auto-7") else (0, "")

    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(nbcd, "_git", fake_git)
        mp.setattr(nbcd, "stage5_source_drift", lambda *a, **k: {"drift": "none"})
        rec = {"stages": {"pr_resume": {"from": "pr-push-failed"}} if resumed else {}}
        args = SimpleNamespace(issue=7, notebook=PORT, pr_branch="nbcoder/auto-7", agent="p",
                               verifier_agent="c", grain_tier="MED", lane="lane:a",
                               pr_base="main", pr_repo="jsboige/CoursIA", out_dir=str(tmp_path))
        nbcd.stage5_pr(args, rec, tmp_path, tmp_path / "built.ipynb", {"issue": 7}, None)
    finally:
        mp.undo()
    assert rec["verdict"] == "pr-branch-failed"
    assert calls[-1] == ("checkout", flag, "nbcoder/auto-7")
    # a resume starts its branch from today's origin/main, drift or not
    rebased = ("checkout", "-q", "--detach", "origin/main") in calls
    assert rebased is resumed


def _previous_attempt(r: Path, twin: dict | None, msg: str) -> str:
    """What a run that failed past its branch leaves: the worktree ON that branch, one
    commit on top of where it was (the twin re-written when `twin` is given)."""
    _sh("git", "checkout", "-q", "-B", "nbcoder/auto-7-prev", cwd=r)
    if twin is not None:
        _commit(r, SRC, twin, msg)
    else:
        (r / "leftover.txt").write_text("previous attempt\n", encoding="utf-8")
        _sh("git", "add", "leftover.txt", cwd=r)
        _sh("git", "commit", "-q", "-m", msg, cwd=r)
    return _head(r)


def _resumed(out: Path, r: Path, base: str, main_blob: str | None, frm: str):
    """Stage-5 arguments of a resume: the trace's worktree head, and the main blob the
    previous attempt measured when the build it delivered is aligned with it."""
    args, rec = _stage5(out)
    rec["stages"].update({"worktree": {"path": str(r), "head": base[:9]},
                          "pr_resume": {"from": frm, "main_blob": main_blob}})
    return args, rec


def _pushed_cells(r: Path) -> list:
    nb = json.loads(subprocess.run(["git", "-C", str(r), "show", f"HEAD:{PORT}"],
                                   capture_output=True, text=True, encoding="utf-8",
                                   check=True).stdout)
    return [c["source"] for c in nb["cells"]]


LINKED = _nb([_md("# Titre\n[→ jumeau](Sudoku-07-Rust.ipynb)"), _code("solve()", "ok\n"),
              _md("### Ancres Lectures"), _md("## Fin")])
# the source gains a SECOND markdown cell after a first graft
GAINED_AGAIN = _nb([_md("# Titre"), _md("## Avant-propos"), _code("solve()", "ok\n"),
                    _md("### Ancres Lectures"), _md("## Fin")])


def test_a_first_resume_measures_from_the_build_base_and_grafts(tmp_path):
    """The #28209 shape: the previous attempt refused the port (`source-drifted:structure`,
    read by a driver that had no graft) before any branch -- the worktree is still on the
    build's base and the trace carries no main blob. The resume measures from that base,
    grafts, and delivers the approved build without a model turn."""
    mo = pytest.MonkeyPatch()
    try:
        _hered(mo, tmp_path)
        nbcd = _driver()
        r, base, main = _ported_repo(tmp_path, GAINED)
        out = tmp_path / "out"
        out.mkdir()
        built = _port_file(out, BASE)
        args, rec = _resumed(out, r, base, None, "source-drifted:structure")
        bodies = _stub_delivery(mo, nbcd)
        nbcd.stage5_pr(args, rec, r, built, {"issue": 7}, None)
    finally:
        mo.undo()

    assert rec["verdict"] == "pr-created", rec.get("pr")
    assert rec["pr"]["base_rev"] == base[:9]
    assert rec["pr"]["source_drift"]["drift"] == "markdown-added"
    assert "measured_from" not in rec["pr"]["source_drift"]
    assert rec["pr"]["graft"]["count"] == 1 and "gagné 1 cellule(s)" in bodies["pr"]


def test_a_resume_grafts_what_the_source_gained_since_the_previous_attempt(tmp_path):
    """First attempt: grafted, then failed past its branch (push/create) -- the worktree
    sits on that branch. The source then gains ANOTHER markdown cell. From the old branch
    the twin reads `structure` (its cells carry the integration's nav link); from the
    build's base the build is no longer aligned (it holds the first graft) and the graft
    refuses. From the source as the first attempt measured it -- its main blob, carried
    by the trace -- the new cell is grafted onto the grafted build."""
    mo = pytest.MonkeyPatch()
    try:
        _hered(mo, tmp_path)
        nbcd = _driver()
        r, base, first_main = _ported_repo(tmp_path, GAINED)
        first_blob = nbdr.blob_at(r, first_main, SRC)
        prev = _previous_attempt(r, LINKED, "integration de la premiere tentative")
        _sh("git", "checkout", "-q", "twin-move", cwd=r)
        _commit(r, SRC, GAINED_AGAIN, "Add(notebooks): une seconde cellule gagnee")
        _sh("git", "push", "-q", "origin", "twin-move:main", cwd=r)
        _sh("git", "checkout", "-q", "nbcoder/auto-7-prev", cwd=r)
        out = tmp_path / "out"
        out.mkdir()
        built = _port_file(out, GAINED)                 # grafted by the first attempt
        args, rec = _resumed(out, r, base, first_blob[:12], "pr-create-failed")
        _stub_delivery(mo, nbcd)
        # the two readings that lose the port
        assert nbdr.classify_drift(nbdr.notebook_at(r, prev, SRC),
                                   nbdr.notebook_at(r, "origin/main", SRC)) == "structure"
        from_base = nbdr.graft_markdown(
            json.loads(built.read_text(encoding="utf-8")), nbdr.notebook_at(r, base, SRC),
            nbdr.notebook_at(r, "origin/main", SRC))
        assert "not cell-aligned" in from_base["error"]
        nbcd.stage5_pr(args, rec, r, built, {"issue": 7}, None)
    finally:
        mo.undo()

    assert rec["verdict"] == "pr-created", rec.get("pr")
    pr = rec["pr"]
    assert pr["source_drift"]["drift"] == "markdown-added"
    assert pr["source_drift"]["inserted"] == [1]
    assert pr["source_drift"]["measured_from"] == "previous-attempt-main-blob"
    assert pr["graft"]["count"] == 1 and pr["graft"]["already"] is False
    assert _pushed_cells(r) == [["port 0"], ["## Avant-propos"], ["port 1"],
                                ["port 2"], ["port 3"]]
    (backup,) = list(out.glob("nb_7_built.pre-graft-*.ipynb"))
    assert len(json.loads(backup.read_text(encoding="utf-8"))["cells"]) == 4  # 1st graft


def test_a_resume_with_nothing_new_rewrites_nothing(tmp_path):
    """Same first attempt, the source did not move again: measured from its main blob the
    drift is `none`; the build is delivered as it is, from a branch re-created on
    origin/main (not stacked on the previous attempt's commit)."""
    mo = pytest.MonkeyPatch()
    try:
        _hered(mo, tmp_path)
        nbcd = _driver()
        r, base, main = _ported_repo(tmp_path, GAINED)
        main_blob = nbdr.blob_at(r, main, SRC)
        prev = _previous_attempt(r, LINKED, "integration de la tentative precedente")
        out = tmp_path / "out"
        out.mkdir()
        built = _port_file(out, GAINED)
        raw = built.read_bytes()
        args, rec = _resumed(out, r, base, main_blob[:12], "pr-create-failed")
        bodies = _stub_delivery(mo, nbcd)
        nbcd.stage5_pr(args, rec, r, built, {"issue": 7}, None)
    finally:
        mo.undo()

    assert rec["verdict"] == "pr-created", rec.get("pr")
    assert rec["pr"]["source_drift"]["drift"] == "none"
    assert rec["pr"]["source_drift"]["measured_from"] == "previous-attempt-main-blob"
    assert built.read_bytes() == raw and not list(out.glob("*.pre-graft-*"))
    assert "gagné" not in bodies["pr"] and "markdown seul" not in bodies["pr"]
    parent = subprocess.run(["git", "-C", str(r), "rev-parse", "HEAD^"], capture_output=True,
                            text=True, encoding="utf-8", errors="replace",
                            check=True).stdout.strip()
    assert parent == main and _head(r) != prev


@pytest.mark.parametrize("with_twin", [False, True])
def test_a_resume_starts_its_branch_from_origin_main_even_without_drift(tmp_path, with_twin):
    """A second commit stacked on the previous attempt's would be empty (same build,
    idempotent integration): the branch is re-created from origin/main as a first run --
    with or without a source twin to measure. Nothing moved: the PR body says nothing."""
    td = tmp_path / f"t{int(with_twin)}"
    td.mkdir()
    mo = pytest.MonkeyPatch()
    try:
        _hered(mo, td)
        nbcd = _driver()
        r, base, main = _ported_repo(td, None)          # the twin did not move
        prev = _previous_attempt(r, None, "tentative precedente")
        out = td / "out"
        out.mkdir()
        built = _port_file(out, BASE)
        args, rec = _resumed(out, r, base, None, "pr-push-failed")
        if not with_twin:
            rec["create_mode"] = {"target": PORT}       # edit mode / spec twin
        bodies = _stub_delivery(mo, nbcd)
        nbcd.stage5_pr(args, rec, r, built, {"issue": 7}, None)
    finally:
        mo.undo()

    assert rec["verdict"] == "pr-created", rec.get("pr")
    assert rec["pr"]["rebased"] is True
    assert ("source_drift" in rec["pr"]) is with_twin
    if with_twin:
        assert rec["pr"]["source_drift"]["drift"] == "none"
        assert "rebased" not in rec["pr"]["source_drift"]
    assert "markdown seul" not in bodies["pr"]
    parent = subprocess.run(["git", "-C", str(r), "rev-parse", "HEAD^"], capture_output=True,
                            text=True, encoding="utf-8", errors="replace",
                            check=True).stdout.strip()
    assert parent == main and _head(r) != prev


def test_a_failed_rebase_refuses_before_any_branch(tmp_path):
    """An integration replayed on a stale base is not pushed on a guess: the refusal is
    named in the `pr-` family, so the approved build stays resumable."""
    nbcd = _driver()
    calls = []
    real_git = nbcd._git

    def fake_git(wt, *a, **k):
        calls.append(a)
        if a[:3] == ("checkout", "-q", "--detach"):
            return 1, "fatal: unable to unlink 'x': Permission denied"
        return real_git(wt, *a, **k)

    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(nbcd, "_git", fake_git)
        r, base, main = _ported_repo(tmp_path, None)
        out = tmp_path / "out"
        out.mkdir()
        built = _port_file(out, BASE)
        args, rec = _resumed(out, r, base, None, "pr-push-failed")
        rec["create_mode"] = {"target": PORT}
        nbcd.stage5_pr(args, rec, r, built, {"issue": 7}, None)
    finally:
        mp.undo()
    assert rec["verdict"] == "pr-rebase-failed"
    assert calls[-1] == ("checkout", "-q", "--detach", "origin/main")     # nothing after


def test_stage5_base_rev_is_the_head_the_trace_recorded(tmp_path):
    """Never HEAD as found: a worktree left on a previous attempt's branch would be
    measured from that attempt's commit."""
    nbcd = _driver()
    r, base, main = _ported_repo(tmp_path, GAINED)
    prev = _previous_attempt(r, LINKED, "tentative precedente")
    assert _head(r) == prev
    assert nbcd.stage5_base_rev(r, {"stages": {"worktree": {"head": base[:9]}}}) == base[:9]
    assert nbcd.stage5_base_rev(r, {"stages": {"worktree": {"head": "0" * 9}}}) == "HEAD"
    assert nbcd.stage5_base_rev(r, {"stages": {}}) == "HEAD"


# ------------------------- the same-named branch ON ORIGIN (#1885 review, ai-01)
# A run that dies at `gh pr create` has already PUSHED its branch, and the resume rebuilds
# it on today's origin/main under the same deterministic name. The tests above never
# modelled that branch: the previous attempt's stayed a local `nbcoder/auto-7-prev`.


def _origin_head(r: Path, ref: str) -> str:
    out = subprocess.run(["git", "-C", str(r), "ls-remote", "origin", ref], capture_output=True,
                         text=True, encoding="utf-8", errors="replace",
                         check=True).stdout.split()
    return out[0] if out else ""


def _attempt_pushed_under_the_resume_name(r: Path, nbcd) -> str:
    """The previous attempt's branch, on origin under the name the resume uses again.
    Returns the full sha origin holds."""
    name = nbcd.default_pr_branch(7, PORT)
    _sh("git", "push", "-q", "origin", f"nbcoder/auto-7-prev:refs/heads/{name}", cwd=r)
    sha = _origin_head(r, f"refs/heads/{name}")
    assert sha and sha == _head(r), "origin holds the previous attempt's commit"
    return sha


def _recording_pushes(mo, nbcd) -> list:
    """Every `_push_branch` call with the lease it was given -- then the real push."""
    seen = []
    real = nbcd._push_branch

    def fake(wt, branch, *a, lease=None, **k):
        seen.append((branch, lease))
        return real(wt, branch, *a, lease=lease, **k)

    mo.setattr(nbcd, "_push_branch", fake)
    return seen


def _resumed_after_a_pushed_create_failure(td: Path):
    """Repo, build and stage-5 arguments of a resume from `pr-create-failed` whose
    previous attempt pushed under the resume's own branch name."""
    nbcd = _driver()
    r, base, main = _ported_repo(td, GAINED)
    main_blob = nbdr.blob_at(r, main, SRC)
    _previous_attempt(r, LINKED, "integration de la tentative precedente")
    pushed = _attempt_pushed_under_the_resume_name(r, nbcd)
    out = td / "out"
    out.mkdir()
    built = _port_file(out, GAINED)
    args, rec = _resumed(out, r, base, main_blob[:12], "pr-create-failed")
    rec["stages"]["pr_resume"]["pushed_sha"] = pushed
    return nbcd, r, main, out, built, args, rec, pushed


def test_a_resume_from_pr_create_failed_replaces_only_the_commit_it_pushed(tmp_path):
    """The previous attempt pushed the branch and died at `gh pr create`. The resume finds
    it on origin, not an ancestor of the commit it rebuilds on origin/main: under the lease
    of the recorded sha the push replaces it and the PR is created. The trace then holds
    the new sha, which is what a later resume may replace in turn."""
    mo = pytest.MonkeyPatch()
    try:
        _hered(mo, tmp_path)
        nbcd, r, main, out, built, args, rec, pushed = _resumed_after_a_pushed_create_failure(
            tmp_path)
        _stub_delivery(mo, nbcd)
        pushes = _recording_pushes(mo, nbcd)
        nbcd.stage5_pr(args, rec, r, built, {"issue": 7}, None)
    finally:
        mo.undo()

    name = nbcd.default_pr_branch(7, PORT)
    assert rec["verdict"] == "pr-created", rec.get("pr")
    assert pushes == [(name, pushed)], "one push, under the lease of the recorded commit"
    assert rec["pr"]["head_sha"] == _head(r) and _head(r) != pushed
    # the short sha recorded beside it is a sha too -- it read `0` (the rc) until this pin
    assert rec["pr"]["commit"] != 0 and _head(r).startswith(rec["pr"]["commit"])
    assert _origin_head(r, f"refs/heads/{name}") == _head(r), "origin holds the resume's commit"
    parent = subprocess.run(["git", "-C", str(r), "rev-parse", "HEAD^"], capture_output=True,
                            text=True, encoding="utf-8", errors="replace",
                            check=True).stdout.strip()
    assert parent == main


def test_a_first_run_never_replaces_a_same_named_branch_on_origin(tmp_path):
    """No resume, so no lease: the push is refused as a non-fast-forward and the grain ends
    `pr-push-failed`, origin untouched. A branch nobody recorded is never overwritten."""
    mo = pytest.MonkeyPatch()
    try:
        _hered(mo, tmp_path)
        nbcd = _driver()
        r, base, main = _ported_repo(tmp_path, GAINED)
        _previous_attempt(r, LINKED, "integration de la tentative precedente")
        pushed = _attempt_pushed_under_the_resume_name(r, nbcd)
        out = tmp_path / "out"
        out.mkdir()
        built = _port_file(out, BASE)                 # a first run: built on the base
        args, rec = _stage5(out)                       # a first run: no pr_resume
        rec["stages"]["worktree"] = {"path": str(r), "head": base[:9]}
        _stub_delivery(mo, nbcd)
        pushes = _recording_pushes(mo, nbcd)
        nbcd.stage5_pr(args, rec, r, built, {"issue": 7}, None)
    finally:
        mo.undo()

    name = nbcd.default_pr_branch(7, PORT)
    assert rec["verdict"] == "pr-push-failed", rec.get("pr")
    assert pushes == [(name, None)], "a first run pushes without any lease"
    assert "rejected" in rec["pr"]["error"] or "fetch first" in rec["pr"]["error"]
    assert "head_sha" not in rec["pr"]
    assert _origin_head(r, f"refs/heads/{name}") == pushed, "origin is left as it was"


def test_the_lease_refuses_a_branch_moved_past_the_recorded_commit(tmp_path):
    """Someone moved the branch after the attempt that recorded it: the lease no longer
    matches, origin refuses, and nothing is replaced. The refusal is the recorded one."""
    mo = pytest.MonkeyPatch()
    try:
        _hered(mo, tmp_path)
        nbcd, r, main, out, built, args, rec, pushed = _resumed_after_a_pushed_create_failure(
            tmp_path)
        name = nbcd.default_pr_branch(7, PORT)
        # the tip of origin/main (a commit, never the repo's local `main`, which stayed
        # on the build's base), forced onto the grain's branch by another hand
        _sh("git", "push", "-q", "-f", "origin", f"{main}:refs/heads/{name}", cwd=r)
        assert _origin_head(r, f"refs/heads/{name}") == main != pushed
        _stub_delivery(mo, nbcd)
        pushes = _recording_pushes(mo, nbcd)
        nbcd.stage5_pr(args, rec, r, built, {"issue": 7}, None)
    finally:
        mo.undo()

    assert rec["verdict"] == "pr-push-failed", rec.get("pr")
    assert pushes == [(name, pushed)]
    assert "stale info" in rec["pr"]["error"]
    assert "head_sha" not in rec["pr"]
    assert _origin_head(r, f"refs/heads/{name}") == main, "the moved branch is still there"
