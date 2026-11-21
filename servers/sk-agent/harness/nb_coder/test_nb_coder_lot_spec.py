# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 9683ab2f5165f374bbb387132288c2cbf7cc6084
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_lot_spec.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for lot-issue spec scoping (CoursIA#27133 / #27134, 20/11).

A lot issue carries one `[SPEC-DRAFT]` comment per notebook, each naming its own
« Cible : `…ipynb` ». The prompts see the issue BODY and only the TAIL of the thread
(8 000 chars): on #27133 that tail is the end of the lot's LAST spec (Sudoku-05), so MGS-25
would have been built against another notebook's plan. With a target, fetch_issue moves the
target's own spec into the body and replaces every other spec of the lot by a line naming
the notebook it specifies; a lot whose specs all name other notebooks refuses the run.

Skipped when `mcp` is not importable (the driver imports the MCP client at load).
"""
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as d  # noqa: E402

LOT = "MyIA.AI.Notebooks/Search/Part4-Metaheuristics/MGS-vs-mealpy"
T25 = f"{LOT}/MGS-25-WhaleOptimisation-vs-Mealpy-Rust.ipynb"
T28 = f"{LOT}/MGS-28-BareBonesPSO-vs-Mealpy-Rust.ipynb"


def spec(target, marker, source="x.ipynb"):
    return (f"[SPEC-DRAFT] lane myia-ai-01:CoursIA -- brouillon\n\n---\n\n## Objet\n\n"
            f"- Source : `{source}` (23 cellules)\n- Cible : `{target}` (à créer)\n\n"
            f"## Plan des cellules\n\n| Index | Première ligne |\n|---|---|\n| 2 | {marker} |\n")


def cm(i, body, login="jsboige", at=None):
    return {"id": i, "login": login, "created_at": at or f"2026-11-20T18:22:{i:02d}Z", "body": body}


def lot_thread():
    return [cm(1, "[CLAIMED] lane myia-po-2028:CoursIA-2 -- ancien"),
            cm(2, spec(T25, "MARK-25")),
            cm(3, spec(T28, "MARK-28")),
            cm(4, "[CLAIMED] lane myia-ai-01:vllm -- portage Rust du lot 5")]


def test_the_target_spec_joins_the_body_and_the_other_specs_leave_the_thread():
    issue = {"body": "Lot 5 body"}
    info = d.select_target_spec(issue, lot_thread(), T25)
    assert info["status"] == "selected" and info["comment_id"] == 2
    assert issue["body"].startswith("Lot 5 body") and "MARK-25" in issue["body"]
    assert "MARK-28" not in issue["body"] and "MARK-28" not in issue["comments"]
    assert "MARK-25" not in issue["comments"]          # not twice: the body carries it
    assert f"AUTRE carnet du lot : `{T28}`" in issue["comments"]
    assert "[CLAIMED] lane myia-ai-01:vllm" in issue["comments"]   # non-spec comments stay
    assert info["lot_targets"] == sorted([T25, T28])


def test_a_lot_without_a_spec_for_the_target_says_so():
    issue = {"body": "Lot 5 body"}
    info = d.select_target_spec(issue, lot_thread(), f"{LOT}/MGS-29-GA-vs-Mealpy-Rust.ipynb")
    assert info["status"] == "none-for-target"
    assert "MARK-25" not in issue["comments"] and "MARK-28" not in issue["comments"]
    assert issue["body"] == "Lot 5 body"


def test_a_single_notebook_issue_is_left_unchanged():
    issue = {"body": "spec in the body"}
    comments = [cm(1, "[CLAIMED] lane a"), cm(2, "a review note")]
    info = d.select_target_spec(issue, comments, T25)
    assert info["status"] == "no-spec-comments"
    assert issue["body"] == "spec in the body"
    assert issue["comments"] == "--- jsboige 2026-11-20T18:22:01Z\n[CLAIMED] lane a\n" \
                                "--- jsboige 2026-11-20T18:22:02Z\na review note"


def test_without_a_target_the_thread_stays_verbatim():
    issue = {"body": "B"}
    info = d.select_target_spec(issue, lot_thread(), None)
    assert info["status"] == "no-target"
    assert "MARK-25" in issue["comments"] and "MARK-28" in issue["comments"]
    assert issue["body"] == "B"


def test_the_latest_revision_of_the_target_spec_wins():
    comments = lot_thread() + [cm(5, spec(T25, "MARK-25-REVISED"))]
    issue = {"body": "B"}
    info = d.select_target_spec(issue, comments, T25)
    assert info["comment_id"] == 5 and info["versions"] == 2
    assert "MARK-25-REVISED" in issue["body"] and "MARK-25 |" not in issue["body"]
    assert "version antérieure" in issue["comments"]


def test_a_spec_draft_naming_no_target_stays_in_the_thread():
    comments = [cm(1, "[SPEC-DRAFT] notes sans cible déclarée, MARK-FREE")] + lot_thread()
    issue = {"body": "B"}
    d.select_target_spec(issue, comments, T25)
    assert "MARK-FREE" in issue["comments"]


def test_the_target_is_compared_on_the_posix_plane():
    issue = {"body": "B"}
    info = d.select_target_spec(issue, lot_thread(), T25.replace("/", "\\"))
    assert info["status"] == "selected" and info["comment_id"] == 2


def test_spec_draft_target_reads_only_spec_drafts():
    assert d.spec_draft_target(spec(T25, "m")) == T25
    assert d.spec_draft_target("[CLAIMED]\n- Cible : `a.ipynb`") is None
    assert d.spec_draft_target("[SPEC-DRAFT]\n**Cible** : `a/b.ipynb` (à créer)") == "a/b.ipynb"


def test_fetch_issue_scopes_the_gh_comment_stream(monkeypatch):
    stream = "\n".join(json.dumps(c, ensure_ascii=False) for c in lot_thread())

    def fake_gh(args, token=None, timeout=60):
        if args[1].endswith("/comments"):
            assert "--paginate" in args
            return 0, stream
        return 0, json.dumps({"title": "Lot 5", "state": "open", "body": "Lot 5 body",
                              "labels": []})

    monkeypatch.setattr(d, "gh", fake_gh)
    issue = d.fetch_issue("o/r", 27133, None, T28)
    assert issue["spec_comment"]["status"] == "selected"
    assert "MARK-28" in issue["body"] and "MARK-25" not in issue["body"] + issue["comments"]


def test_fetch_issue_records_an_unreadable_thread_without_failing(monkeypatch):
    def fake_gh(args, token=None, timeout=60):
        if args[1].endswith("/comments"):
            return 1, "HTTP 502"
        return 0, json.dumps({"title": "T", "state": "open", "body": "B", "labels": []})

    monkeypatch.setattr(d, "gh", fake_gh)
    issue = d.fetch_issue("o/r", 1, None, T25)
    assert issue["spec_comment"] == {"status": "comments-unreadable"}
    assert issue["comments"].startswith("(comments fetch failed rc=1")


def test_the_run_refuses_a_lot_grain_without_its_spec_before_the_reservation(monkeypatch,
                                                                              tmp_path):
    rec = {"stages": {}, "calls": []}
    args = SimpleNamespace(out_dir=str(tmp_path), repo="D:/repo", issue=27133, notebook=T25,
                           source_nb=None, allow_foreign_origin=False, lane="lane:a",
                           claim=True, intention="w", conventions="", max_stage=5,
                           worktree=str(tmp_path / "wt"), fresh_worktree=False)
    seen = {}
    monkeypatch.setattr(d, "app_token", lambda repo: "")
    monkeypatch.setattr(d, "read_conventions", lambda p: "")
    monkeypatch.setattr(d, "check_claim", lambda *a: {"rc": 0, "ok": True})

    def fake_fetch(*a):
        seen["target"] = a[3] if len(a) > 3 else None
        return {"title": "Lot", "state": "open", "labels": [], "body": "",
                "spec_comment": {"status": "none-for-target"}}

    monkeypatch.setattr(d, "fetch_issue", fake_fetch)
    monkeypatch.setattr(d, "reserve_claim", lambda *a: (_ for _ in ()).throw(
        AssertionError("no reservation for a grain without its spec")))
    monkeypatch.setattr(d.subprocess, "run", lambda *a, **kw:
                        SimpleNamespace(stdout="https://github.com/jsboige/CoursIA.git\n"))
    got = asyncio.run(d.run(args, rec))
    assert got["verdict"] == "refused-no-spec-for-target"
    assert seen["target"] == T25


def test_the_verifier_receives_the_same_target(monkeypatch, tmp_path):
    cmds = []

    def fake_run(cmd, **kw):
        cmds.append(cmd)
        (tmp_path / "verify-7.json").write_text(json.dumps({"verdict": "approve"}),
                                                encoding="utf-8")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(d.subprocess, "run", fake_run)
    args = SimpleNamespace(issue=7, verifier_agent="v", verify_timeout=60, from_spec=False,
                           notebook=T25.replace("/", "\\"))
    d.stage4_verify(args, {"calls": []}, tmp_path / "s.ipynb", tmp_path / "b.ipynb", tmp_path)
    cmd = cmds[0]
    assert cmd[cmd.index("--target") + 1] == T25


# ---------------------------------------------------------------- stage 5 wording
def test_a_creation_is_titled_add_and_a_correction_fix():
    assert d.pr_title(27314, "X — portage depuis Y", {"source": "Y.ipynb"}) \
        == "Add(notebooks,#27314): X — portage depuis Y"
    assert d.pr_title(27000, "X cell 3 — fix", None) == "Fix(notebooks,#27000): X cell 3 — fix"


def test_a_lot_pr_refs_the_issue_and_a_single_notebook_pr_closes_it():
    issue = {"body": "B"}
    issue["spec_comment"] = d.select_target_spec(issue, lot_thread(), T25)
    line = d.issue_link_line(27133, issue, T25)
    assert line.startswith("Refs #27133") and "Closes" not in line and T25 in line
    assert d.issue_link_line(27314, {"spec_comment": {"status": "no-spec-comments"}},
                             "a.ipynb") == "Closes #27314"
    assert d.issue_link_line(1, None, "a.ipynb") == "Closes #1"
    one = {"spec_comment": {"status": "selected", "lot_targets": [T25]}}
    assert d.issue_link_line(2, one, T25) == "Closes #2"
