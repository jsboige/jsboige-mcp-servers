#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_revise.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Offline pins for the constructive-review loop (20/11, IT08 CoursIA#27460).

A verify-reject used to END the grain: the first draft could never be improved by the
review it had just received. `--revise-rounds` feeds the verifier's findings back to the
builder (fresh, self-contained conversation), re-executes the whole notebook, re-gates and
re-verifies with the previous round attached; `--revise-from` resumes an already-rejected
grain without re-paying plan and build.

Pinned here: what the reviser sees (real outputs, declared cuts), what it may change (no
insert/delete/retype), the stale-verify-trace hazard, the loop's stop conditions, the
fail-closed resume, the CLI guards and the scheduler forwarding. No engine, no MCP
session, no GitHub.
"""
import asyncio
import contextlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as D  # noqa: E402
import nb_coder_verify as V  # noqa: E402


def _write(p: Path, nb: dict) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(nb, ensure_ascii=False), encoding="utf-8")
    return p


def _nb(tmp_path: Path, name: str = "built.ipynb", out_text: str = "0.5\n") -> Path:
    return _write(tmp_path / name, {"nbformat": 4, "nbformat_minor": 5, "metadata": {
        "kernelspec": {"name": "python3"}}, "cells": [
        {"cell_type": "markdown", "metadata": {}, "source": ["# Titre"]},
        {"cell_type": "code", "metadata": {}, "execution_count": 1,
         "source": ["print(1 - 0.5)"],
         "outputs": [{"output_type": "stream", "name": "stdout", "text": [out_text]}]},
        {"cell_type": "markdown", "metadata": {}, "source": ["Synthèse."]},
        {"cell_type": "code", "metadata": {}, "execution_count": 2,
         "source": ["x = 2"], "outputs": []},
    ]})


def _cells(p: Path) -> list:
    return json.loads(p.read_text(encoding="utf-8"))["cells"]


# ---------------------------------------------------------------- what the reviser sees
def test_revision_view_shows_real_outputs_and_counts(tmp_path):
    v = D.revision_view(_nb(tmp_path))
    assert "=== cellule 1 | code ===" in v and "print(1 - 0.5)" in v
    assert "--- sortie réelle (execution_count=1) ---\n0.5" in v
    assert "=== cellule 3 | code ===" in v and "(aucune sortie)" in v
    assert "=== cellule 0 | markdown ===" in v and "sortie réelle" not in v.split(
        "=== cellule 1")[0]


def test_revision_view_declares_both_cuts(tmp_path):
    v = D.revision_view(_nb(tmp_path, out_text="y" * 50), out_cap=10)
    assert "…[sortie tronquée : 40 caractères non affichés]" in v
    whole = D.revision_view(_nb(tmp_path), max_chars=40)
    assert "vue du carnet TRONQUÉ" in whole


def test_revision_prompt_contract():
    p = D.revision_prompt({"title": "IT08", "body": "## Plan des cellules\n…"}, "VIEW",
                          [{"cell": 8, "severity": "major", "detail": "grille sans α=1"},
                           "not-a-dict"], conventions="CONV", spec=True)
    assert "## Issue — spec" in p and "CONV" in p and "VIEW" in p
    assert "grille sans α=1" in p and "not-a-dict" not in p
    assert "Ne crée ni ne supprime aucune cellule" in p
    assert "réexécute TOUT le carnet" in p
    assert "contested" in p and "addressed" in p
    assert "critères d'acceptation" in D.revision_prompt(
        {"title": "T", "body": "B"}, "V", [], spec=False)


# ---------------------------------------------------------------- what it may change
def test_apply_revision_rewrites_code_and_markdown_and_resets_outputs(tmp_path):
    p = _nb(tmp_path)
    rep = D.apply_revision(p, {"cells": [
        {"idx": 1, "cell_type": "code", "source": "print(round(1 - 0.5, 3))"},
        {"idx": 2, "cell_type": "markdown", "source": "Synthèse qualifiée."}]})
    assert rep == {"replaced": [1, 2], "unknown_idx": [], "bad": [], "type_changed": []}
    c = _cells(p)
    assert "".join(c[1]["source"]) == "print(round(1 - 0.5, 3))"
    assert c[1]["outputs"] == [] and c[1]["execution_count"] is None
    assert "".join(c[2]["source"]) == "Synthèse qualifiée."
    assert c[3]["execution_count"] == 2                 # untouched cell keeps its state
    assert len(c) == 4 and [x["cell_type"] for x in c] == ["markdown", "code",
                                                           "markdown", "code"]


@pytest.mark.parametrize("cell, field", [
    ({"idx": 1, "cell_type": "markdown", "source": "x"}, "type_changed"),
    ({"idx": 9, "cell_type": "code", "source": "x"}, "unknown_idx"),
    ({"idx": -1, "cell_type": "code", "source": "x"}, "unknown_idx"),
    ({"idx": 1, "cell_type": "code", "source": "   "}, "bad"),
    ({"idx": "un", "cell_type": "code", "source": "x"}, "bad"),
])
def test_apply_revision_refusals_write_nothing(tmp_path, cell, field):
    p = _nb(tmp_path)
    before = p.read_bytes()
    rep = D.apply_revision(p, {"cells": [cell]})
    assert rep["replaced"] == [] and rep[field]
    assert p.read_bytes() == before


def test_apply_revision_keeps_the_first_of_a_duplicate_idx(tmp_path):
    p = _nb(tmp_path)
    rep = D.apply_revision(p, {"cells": [
        {"idx": 3, "cell_type": "code", "source": "x = 3"},
        {"idx": 3, "cell_type": "code", "source": "x = 4"}]})
    assert rep["replaced"] == [3] and rep["bad"] == [3]
    assert "".join(_cells(p)[3]["source"]) == "x = 3"


# ---------------------------------------------------------------- stale verify trace
def test_archive_verify_trace_renames_and_never_overwrites(tmp_path):
    assert D._archive_verify_trace(tmp_path, 7, "t") is None
    (tmp_path / "verify-7.json").write_text('{"n": 1}', encoding="utf-8")
    a = D._archive_verify_trace(tmp_path, 7, "t")
    (tmp_path / "verify-7.json").write_text('{"n": 2}', encoding="utf-8")
    b = D._archive_verify_trace(tmp_path, 7, "t")
    assert Path(a).name == "verify-7.t.json" and Path(b).name == "verify-7.t-1.json"
    assert json.loads(Path(a).read_text())["n"] == 1
    assert json.loads(Path(b).read_text())["n"] == 2
    assert not (tmp_path / "verify-7.json").exists()


def test_a_dead_verifier_never_returns_the_previous_verdict(monkeypatch, tmp_path):
    """The hazard the archive exists for: an old `approve` trace on disk + a child that
    dies before writing must read as verify-error, never as the old approval."""
    (tmp_path / "verify-5.json").write_text(json.dumps(
        {"verdict": "approve", "answer": {"findings": []}}), encoding="utf-8")
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        return SimpleNamespace(returncode=0, stdout="", stderr="died")

    monkeypatch.setattr(D.subprocess, "run", fake_run)
    args = SimpleNamespace(issue=5, verifier_agent="critic", verify_timeout=10,
                           from_spec=True)
    rec: dict = {}
    D.stage4_verify(args, rec, tmp_path / "s.ipynb", tmp_path / "b.ipynb", tmp_path,
                    prior={"round": 0, "findings": [{"cell": 1}]})
    assert rec["verdict"] == "verify-error"
    assert Path(rec["verify"]["previous_trace"]).is_file()
    assert "--mode" in seen["cmd"] and "--prior" in seen["cmd"]
    prior_p = Path(seen["cmd"][seen["cmd"].index("--prior") + 1])
    assert json.loads(prior_p.read_text(encoding="utf-8"))["findings"] == [{"cell": 1}]


def test_verify_prompt_carries_the_previous_round_only_when_given():
    prior = {"round": 0, "findings": [{"cell": 8, "detail": "α=1 manquant"}],
             "addressed": [{"cell": 8, "how": "grille étendue"}],
             "contested": [{"cell": 12, "why": "149,99 n'est pas atteignable"}]}
    p = V.verify_prompt({"title": "T", "body": "B"}, "S", "B", {}, "", mode="spec",
                        prior=prior)
    assert "## Tour précédent" in p and "AFFIRMATIONS" in p
    assert "149,99 n'est pas atteignable" in p and "grille étendue" in p
    assert "## Tour précédent" not in V.verify_prompt(
        {"title": "T", "body": "B"}, "S", "B", {}, "", mode="spec")


# ---------------------------------------------------------------- the loop
FINDINGS = [{"cell": 1, "severity": "major", "detail": "précision"},
            {"cell": 2, "severity": "minor", "detail": "synthèse"}]
REVISION = ('```json\n{"cells":[{"idx":1,"cell_type":"code",'
            '"source":"print(round(1 - 0.5, 3))"}],'
            '"addressed":[{"cell":1,"how":"arrondi"}],'
            '"contested":[{"cell":2,"why":"déjà qualifiée"}]}\n```')


def _loop_args(**kw):
    base = dict(revise_rounds=2, max_stage=4, from_spec=True, repair_rounds=0)
    base.update(kw)
    return SimpleNamespace(**base)


def _fake_engine(monkeypatch, responses: list[str], verdicts: list[tuple]):
    """responses: one model answer per revision call. verdicts: one (verdict, findings)
    per verifier call. Execution writes sequential counts like a real kernel."""
    calls = {"sk": [], "kernels": 0, "verify": [], "stops": 0}

    @contextlib.asynccontextmanager
    async def fake_sessions(out_dir):
        yield "SK", "PM"

    async def fake_sk(sk, args, rec, stage, prompt, conv, max_tokens=None, model=None):
        calls["sk"].append({"stage": stage, "conv": conv, "prompt": prompt})
        rec["calls"].append({"stage": stage})
        return {"response": responses[len(calls["sk"]) - 1], "conversation_id": "c-rev"}

    async def fake_start(pm, kname, cwd):
        calls["kernels"] += 1
        return f"k{calls['kernels']}"

    async def fake_exec(pm, nb_path, kid, idx):
        nb = json.loads(nb_path.read_text(encoding="utf-8"))
        n = 0
        for i in idx:
            n += 1
            nb["cells"][i]["execution_count"] = n
            nb["cells"][i]["outputs"] = [{"output_type": "stream", "name": "stdout",
                                          "text": ["0.5\n"]}]
        nb_path.write_text(json.dumps(nb), encoding="utf-8")
        return [{"cell": i, "ok": True} for i in idx]

    async def fake_pm(pm, tool, payload):
        calls["stops"] += payload.get("action") == "stop"
        return {}

    def fake_verify(args, rec, src_nb, built_nb, out_dir, prior=None):
        verdict, findings = verdicts[len(calls["verify"])]
        calls["verify"].append(prior)
        rec["verify"] = {"verdict": verdict, "findings": findings}
        rec["verdict"] = {"approve": "verify-approved", "reject": "verify-reject"}[verdict]

    monkeypatch.setattr(D, "mcp_sessions", fake_sessions)
    monkeypatch.setattr(D, "sk_call_retry", fake_sk)
    monkeypatch.setattr(D, "start_kernel", fake_start)
    monkeypatch.setattr(D, "execute_cells", fake_exec)
    monkeypatch.setattr(D, "pm_call", fake_pm)
    monkeypatch.setattr(D, "run_gates", lambda *a, **kw: [{"gate": "g", "ok": True}])
    monkeypatch.setattr(D, "stage4_verify", fake_verify)
    return calls


def _rejected_rec():
    return {"verdict": "verify-reject", "calls": [], "stages": {}, "conversation_id": "c-build",
            "verify": {"verdict": "reject", "findings": list(FINDINGS)}}


def _loop(args, rec, built, tmp_path):
    return asyncio.run(D.revise_loop(
        args, rec, issue={"title": "T", "body": "B"}, src_nb=tmp_path / "twin.ipynb",
        built_path=built, kname="python3", exec_dir=tmp_path, conventions="",
        create_mode=True, wt_path=tmp_path, out_dir=tmp_path))


def test_one_round_that_approves(monkeypatch, tmp_path):
    built = _nb(tmp_path)
    original = built.read_bytes()
    calls = _fake_engine(monkeypatch, [REVISION], [("approve", [])])
    rec = _rejected_rec()
    _loop(_loop_args(), rec, built, tmp_path)
    assert rec["verdict"] == "verify-approved"
    (r,) = rec["revisions"]
    assert r["result"] == "verify-approved" and r["majors_in"] == 1 and r["findings_in"] == 2
    assert r["apply"]["replaced"] == [1] and r["exec_verdict"] == "built-executed-ok"
    assert r["contested"] == [{"cell": 2, "why": "déjà qualifiée"}]
    assert Path(r["draft_backup"]).read_bytes() == original        # rejected draft kept
    assert "".join(_cells(built)[1]["source"]) == "print(round(1 - 0.5, 3))"
    assert rec["c2"]["sequential"] is True
    # a FRESH conversation, the real outputs and the findings reach the reviser
    assert calls["sk"][0]["conv"] is None and calls["sk"][0]["stage"] == "6-revise+0"
    assert "sortie réelle (execution_count=1)" in calls["sk"][0]["prompt"]
    assert '"précision"' in calls["sk"][0]["prompt"]
    # the verifier gets its own previous findings + the builder's answer
    assert calls["verify"][0]["findings"] == FINDINGS
    assert calls["verify"][0]["addressed"] == [{"cell": 1, "how": "arrondi"}]
    assert calls["kernels"] == 1 and calls["stops"] == 1


def test_two_rounds_chain_their_findings(monkeypatch, tmp_path):
    built = _nb(tmp_path)
    second = [{"cell": 1, "severity": "major", "detail": "toujours 0.5"}]
    calls = _fake_engine(monkeypatch, [REVISION, REVISION],
                         [("reject", second), ("approve", [])])
    rec = _rejected_rec()
    _loop(_loop_args(), rec, built, tmp_path)
    assert [r["result"] for r in rec["revisions"]] == ["verify-reject", "verify-approved"]
    assert rec["revisions"][0]["findings_out"] == 1
    assert calls["verify"][1]["round"] == 1 and calls["verify"][1]["findings"] == second
    assert (tmp_path / "built.r0.ipynb").is_file() and (tmp_path / "built.r1.ipynb").is_file()


def test_rounds_are_bounded(monkeypatch, tmp_path):
    built = _nb(tmp_path)
    calls = _fake_engine(monkeypatch, [REVISION] * 3, [("reject", FINDINGS)] * 3)
    rec = _rejected_rec()
    _loop(_loop_args(revise_rounds=2), rec, built, tmp_path)
    assert len(rec["revisions"]) == 2 and len(calls["sk"]) == 2
    assert rec["verdict"] == "verify-reject"


def _majors(n: int, minors: int = 1) -> list[dict]:
    return ([{"cell": 1, "severity": "major", "detail": f"majeur {i}"} for i in range(n)]
            + [{"cell": 2, "severity": "minor", "detail": "mineur"}] * minors)


def _reject_with(n_majors: int) -> dict:
    rec = _rejected_rec()
    rec["verify"]["findings"] = _majors(n_majors)
    return rec


def test_a_converging_loop_earns_a_round_past_its_budget(monkeypatch, tmp_path):
    # CoursIA#27747 (21/11): majors 6 -> 4 -> 1, the budget ran out with one major left
    built = _nb(tmp_path)
    calls = _fake_engine(monkeypatch, [REVISION] * 3,
                         [("reject", _majors(2)), ("reject", _majors(1)), ("approve", [])])
    rec = _reject_with(3)
    _loop(_loop_args(revise_rounds=2), rec, built, tmp_path)
    assert rec["verdict"] == "verify-approved" and len(calls["sk"]) == 3
    r = rec["revisions"]
    assert [x["majors_in"] for x in r] == [3, 2, 1]
    assert [x.get("majors_out") for x in r] == [2, 1, 0]
    assert "extended" not in r[0]                 # inside the budget: nothing to extend
    assert r[1]["extended"] == {"budget": 3, "cap": 4}


def test_the_extension_is_capped(monkeypatch, tmp_path):
    built = _nb(tmp_path)
    calls = _fake_engine(monkeypatch, [REVISION] * 6,
                         [("reject", _majors(n)) for n in (4, 3, 2, 1, 0)])
    rec = _reject_with(5)
    _loop(_loop_args(revise_rounds=2, revise_extend=2), rec, built, tmp_path)
    assert len(rec["revisions"]) == 4 and len(calls["sk"]) == 4       # 2 + 2, never more
    assert rec["verdict"] == "verify-reject"
    assert "extended" not in rec["revisions"][-1]


def test_a_stalled_loop_is_not_extended(monkeypatch, tmp_path):
    # same day: [2, 1, 1] — the last round fixed no major
    built = _nb(tmp_path)
    calls = _fake_engine(monkeypatch, [REVISION] * 3,
                         [("reject", _majors(1)), ("reject", _majors(1)), ("approve", [])])
    rec = _reject_with(2)
    _loop(_loop_args(revise_rounds=2), rec, built, tmp_path)
    assert len(calls["sk"]) == 2 and rec["verdict"] == "verify-reject"


def test_a_gate_broken_by_the_last_round_earns_one_round(monkeypatch, tmp_path):
    # 22/11 CoursIA#27930: the budgeted round fixed the verifier major but its rewrite
    # dropped the comments of a long cell; the gate ended the grain with no round on it.
    built = _nb(tmp_path)
    calls = _fake_engine(monkeypatch, [REVISION] * 2, [("approve", [])])
    broken = {"gate": "uncommented-code", "ok": False,
              "detail": {"measured": True, "cells": [1], "flagged": 1,
                         "findings": [{"cell": 1, "text": "cellule 1 : 89 lignes, 0 commentaire"}]}}
    gate_runs = iter([[broken], [{"gate": "uncommented-code", "ok": True}]])
    monkeypatch.setattr(D, "run_gates", lambda *a, **kw: next(gate_runs))
    rec = _rejected_rec()
    _loop(_loop_args(revise_rounds=1), rec, built, tmp_path)
    assert rec["verdict"] == "verify-approved" and len(calls["sk"]) == 2
    r = rec["revisions"]
    assert r[0]["result"] == "verify-reject" and r[0]["extended"]["budget"] == 2
    assert "uncommented-code" in calls["sk"][1]["prompt"] or "commentaire" in calls["sk"][1]["prompt"]
    assert len(calls["verify"]) == 1          # the verifier ran once, on the repaired draft


def test_revise_extend_zero_keeps_the_fixed_budget(monkeypatch, tmp_path):
    built = _nb(tmp_path)
    calls = _fake_engine(monkeypatch, [REVISION] * 3,
                         [("reject", _majors(2)), ("reject", _majors(1)), ("approve", [])])
    rec = _reject_with(3)
    _loop(_loop_args(revise_rounds=2, revise_extend=0), rec, built, tmp_path)
    assert len(calls["sk"]) == 2 and rec["verdict"] == "verify-reject"


def test_majors_of_another_source_do_not_extend(monkeypatch, tmp_path):
    # a synthesized execution major then a verifier reject with none: not one scale
    built = _failing_nb(tmp_path)
    calls = _fake_engine(monkeypatch, [REVISION] * 2, [("reject", _majors(0)), ("approve", [])])
    rec = _exec_seeded_rec()
    _loop(_loop_args(revise_rounds=1), rec, built, tmp_path)
    assert len(calls["sk"]) == 1 and rec["verdict"] == "verify-reject"
    assert "extended" not in rec["revisions"][0]


@pytest.mark.parametrize("done, budget, cap, s_in, s_out, m_in, m_out, want", [
    (2, 2, 4, None, None, 4, 1, True),
    (1, 2, 4, None, None, 4, 1, False),          # budget not spent yet
    (4, 4, 4, None, None, 2, 1, False),          # cap reached
    (2, 2, 4, None, None, 1, 1, False),          # no strict progress
    (2, 2, 4, "execution", None, 3, 1, False),   # different sources
    (2, 2, 4, "execution", "execution", 3, 1, True),
    (2, 2, 4, None, None, 3, None, False),       # no verifier count after the round
    # 22/11 CoursIA#27930: a verifier round whose rewrite broke a gate -> one round for it
    (2, 2, 4, None, "gates", 1, 1, True),
    (2, 2, 4, "gates", "execution", 1, 1, True),  # a gate fix that broke execution
    (4, 4, 4, None, "gates", 1, 1, False),        # still bounded by the cap
    (2, 2, 4, "gates", None, 1, 1, False),        # the verifier coming back: no extension
])
def test_revise_round_extends(done, budget, cap, s_in, s_out, m_in, m_out, want):
    assert D.revise_round_extends(done, budget, cap, s_in, s_out, m_in, m_out) is want


def test_an_unparsed_revision_keeps_the_reject_and_the_draft(monkeypatch, tmp_path):
    built = _nb(tmp_path)
    before = built.read_bytes()
    calls = _fake_engine(monkeypatch, ["je ne sais pas"], [])
    rec = _rejected_rec()
    _loop(_loop_args(), rec, built, tmp_path)
    assert rec["verdict"] == "verify-reject"
    (r,) = rec["revisions"]                         # no second round on a dead answer
    assert r["result"] == "unparsed" and built.read_bytes() == before
    assert calls["kernels"] == 0 and calls["verify"] == []


def test_a_revision_that_applies_nothing_stops(monkeypatch, tmp_path):
    built = _nb(tmp_path)
    bad = '```json\n{"cells":[{"idx":1,"cell_type":"markdown","source":"x"}]}\n```'
    calls = _fake_engine(monkeypatch, [bad], [])
    rec = _rejected_rec()
    _loop(_loop_args(), rec, built, tmp_path)
    (r,) = rec["revisions"]
    assert r["result"] == "nothing-applied" and r["apply"]["type_changed"] == [1]
    assert rec["verdict"] == "verify-reject" and calls["kernels"] == 0


def test_no_findings_means_no_revision_call(monkeypatch, tmp_path):
    built = _nb(tmp_path)
    calls = _fake_engine(monkeypatch, [], [])
    rec = _rejected_rec()
    rec["verify"]["findings"] = []
    _loop(_loop_args(), rec, built, tmp_path)
    assert rec["revisions"][0]["result"] == "no-findings" and calls["sk"] == []


@pytest.mark.parametrize("kw", [{"revise_rounds": 0}, {"max_stage": 3}])
def test_the_loop_is_inert_when_disabled(monkeypatch, tmp_path, kw):
    built = _nb(tmp_path)
    calls = _fake_engine(monkeypatch, [], [])
    rec = _rejected_rec()
    _loop(_loop_args(**kw), rec, built, tmp_path)
    assert "revisions" not in rec and calls["sk"] == []


def test_a_dead_kernel_after_revision_is_not_verified(monkeypatch, tmp_path):
    built = _nb(tmp_path)
    calls = _fake_engine(monkeypatch, [REVISION], [])

    async def no_kernel(pm, kname, cwd):
        return None

    monkeypatch.setattr(D, "start_kernel", no_kernel)
    rec = _rejected_rec()
    _loop(_loop_args(), rec, built, tmp_path)
    assert rec["verdict"] == "kernel-start-failed" and calls["verify"] == []
    assert rec["revisions"][0]["result"] == "kernel-start-failed"


# ---------------------------------------------------------------- --revise-from
NB_REL = "Series/New-08.ipynb"


def _trace(tmp_path: Path, **over) -> Path:
    wt = tmp_path / "wt"
    (wt / "Series").mkdir(parents=True, exist_ok=True)
    twin = _nb(tmp_path, "twin.ipynb")
    built = _nb(tmp_path, "nb_8_built.ipynb")
    t = {"issue": 8, "notebook": NB_REL, "verdict": "verify-reject",
         "started": "2026-11-20T05:36:00Z",
         "stages": {"worktree": {"path": str(wt), "ok": True},
                    "claim_reservation": {"verdict": None}},
         "create_mode": {"spec_twin": str(twin)},
         "kernel": {"kernel_name": "python3"}, "kernel_cwd": str(wt / "Series"),
         "built_notebook": {"path": str(built)},
         "verify": {"verdict": "reject", "findings": FINDINGS}}
    t.update(over)
    p = tmp_path / "issue-8.json"
    p.write_text(json.dumps(t), encoding="utf-8")
    return p


def _rev_args(tmp_path, trace, **kw):
    base = dict(revise_from=str(trace), out_dir=str(tmp_path), issue=8, notebook=NB_REL,
                repo=str(tmp_path / "repo"), allow_foreign_origin=False, lane="lane:a",
                conventions="", gate_mode="advisory", gate=None, kernel_override=None,
                max_stage=5, revise_rounds=2, from_spec=False)
    base.update(kw)
    return SimpleNamespace(**base)


def _stub_resume(monkeypatch, claim_rc=0, blocking=False):
    seen = {"loop": 0, "pr": 0}
    monkeypatch.setattr(D.subprocess, "run", lambda *a, **kw: SimpleNamespace(
        stdout="https://github.com/jsboige/CoursIA.git\n"))
    monkeypatch.setattr(D, "check_claim", lambda *a: {"rc": claim_rc})
    monkeypatch.setattr(D, "app_token", lambda repo: "")
    monkeypatch.setattr(D, "read_conventions", lambda p: "")
    monkeypatch.setattr(D, "fetch_issue", lambda *a: {"title": "T", "body": "B",
                                                      "state": "open", "labels": []})
    monkeypatch.setattr(D, "gate_call", lambda *a: {"blocking_refusal": blocking})

    async def fake_loop(args, rec, **kw):
        seen["loop"] += 1
        seen["kw"] = kw
        seen["from_spec"] = args.from_spec
        rec["verdict"] = "verify-approved"

    def fake_pr(args, rec, wt, built, issue, token):
        seen["pr"] += 1
        rec["verdict"] = "pr-created"

    monkeypatch.setattr(D, "revise_loop", fake_loop)
    monkeypatch.setattr(D, "stage5_pr", fake_pr)
    return seen


def _resume(args):
    return asyncio.run(D.run_revision(args, {"stages": {}, "calls": []}))


def test_resume_happy_path_reuses_the_trace(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    got = _resume(_rev_args(tmp_path, _trace(tmp_path)))
    assert got["verdict"] == "pr-created" and seen["loop"] == 1 and seen["pr"] == 1
    assert seen["from_spec"] is True                    # derived from the trace's twin
    assert seen["kw"]["src_nb"] == tmp_path / "twin.ipynb"
    assert seen["kw"]["create_mode"] is True and seen["kw"]["kname"] == "python3"
    assert got["verify"]["findings"] == FINDINGS        # carried, so it can chain again
    assert got["stages"]["claim_reservation"] == {"verdict": None}
    assert got["revised_from"]["verdict"] == "verify-reject"


def test_resume_stops_before_the_pr_below_stage_5(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    got = _resume(_rev_args(tmp_path, _trace(tmp_path), max_stage=4))
    assert got["verdict"] == "verify-approved" and seen["pr"] == 0


@pytest.mark.parametrize("over, args_kw, verdict", [
    ({}, {"issue": 9}, "refused-revise-trace-mismatch"),
    ({}, {"notebook": "Other/X.ipynb"}, "refused-revise-trace-mismatch"),
    ({"verdict": "gates-ok"}, {}, "refused-revise-not-rejected:gates-ok"),
    ({"verdict": "verify-error"}, {}, "refused-revise-not-rejected:verify-error"),
    ({"stages": {"worktree": {"path": "x"}, "claim_reservation":
                 {"verdict": "refused-claim-post-failed"}}}, {},
     "refused-revise-no-reservation"),
    ({"built_notebook": {"path": "Z:/absent.ipynb"}}, {}, "refused-revise-built-missing"),
    ({"kernel_cwd": "Z:/absent"}, {}, "refused-revise-kernel-cwd-missing"),
])
def test_resume_refusals_spend_nothing(monkeypatch, tmp_path, over, args_kw, verdict):
    seen = _stub_resume(monkeypatch)
    got = _resume(_rev_args(tmp_path, _trace(tmp_path, **over), **args_kw))
    assert got["verdict"].startswith(verdict) and seen["loop"] == 0


def test_resume_refuses_a_missing_trace(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    got = _resume(_rev_args(tmp_path, tmp_path / "nope.json"))
    assert got["verdict"].startswith("refused-revise-trace-missing") and seen["loop"] == 0


def test_resume_old_trace_livereads_the_reservation(monkeypatch, tmp_path):
    # w1*-era traces (18-19/11) carry no claim_reservation stage: the resume re-reads
    # the LIVE scoped claim instead of refusing on a missing attestation (20/11: 3
    # grains were refused as no-reservation while our lane still held the claim).
    seen = _stub_resume(monkeypatch)
    trace = _trace(tmp_path, stages={"worktree": {"path": str(tmp_path / "wt"),
                                                  "ok": True}})
    got = _resume(_rev_args(tmp_path, trace))
    assert got["verdict"] == "pr-created" and seen["loop"] == 1
    assert got["stages"]["claim_reservation"] == {"verdict": None, "live_recheck": True}


def test_resume_old_trace_live_conflict_refuses(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch, claim_rc=1)
    trace = _trace(tmp_path, stages={"worktree": {"path": str(tmp_path / "wt"),
                                                  "ok": True}})
    got = _resume(_rev_args(tmp_path, trace))
    assert got["verdict"].startswith(
        "refused-revise-no-reservation:refused-claim-held-by-another-lane")
    assert seen["loop"] == 0


def test_resume_rereads_the_claim_and_the_capacity_gate(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch, claim_rc=1)
    got = _resume(_rev_args(tmp_path, _trace(tmp_path)))
    assert got["verdict"] == "refused-claim-held-by-another-lane" and seen["loop"] == 0
    seen = _stub_resume(monkeypatch, blocking=True)
    got = _resume(_rev_args(tmp_path, _trace(tmp_path)))
    assert got["verdict"] == "deferred-by-capacity-gate" and seen["loop"] == 0


# ---------------------------------------------------------------- --verify-from
def _verify_args(tmp_path, trace, **kw):
    return _rev_args(tmp_path, trace, verify_from=str(trace), revise_from=None, **kw)


def test_verify_from_recovers_a_crashed_verifier_without_a_model_turn(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    calls = {}

    def fake_gates(args, rec, src_nb, built, create_mode, kname, wt, out_dir, prior=None):
        calls["verdict_in"] = rec.get("verdict")
        calls["built"] = built
        rec["verdict"] = "gates-ok"
        rec["verify"] = {"verdict": "approve"}

    monkeypatch.setattr(D, "gates_then_verify", fake_gates)
    trace = _trace(tmp_path, verdict="verify-error")
    got = _resume(_verify_args(tmp_path, trace))
    assert got["verdict"] == "pr-created"
    # gates+verify are re-run on the SAME on-disk build the crash left behind
    assert calls["verdict_in"] == "built-executed-ok"
    assert calls["built"] == tmp_path / "nb_8_built.ipynb"
    assert got["calls"] == []                     # zero model turn: nothing was re-paid
    assert seen["loop"] == 1 and seen["pr"] == 1
    assert got["revised_from"]["mode"] == "verify"
    assert got["revised_from"]["verdict"] == "verify-error"


def test_verify_from_refuses_a_delivered_reject(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    trace = _trace(tmp_path)                      # verdict verify-reject: a revise job
    got = _resume(_verify_args(tmp_path, trace))
    assert got["verdict"] == "refused-verify-not-crashed:verify-reject" and seen["loop"] == 0


def test_verify_from_refuses_a_missing_trace(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    got = _resume(_verify_args(tmp_path, tmp_path / "nope.json"))
    assert got["verdict"].startswith("refused-revise-trace-missing") and seen["loop"] == 0


LATE_REFUSED = "late-claim-refused:refused-claim-held-by-another-lane"


def _late_trace(tmp_path, **over):
    """A claim-late grain approved and built, refused at late_reservation; the
    scheduler then released its worktree (21/11: CoursIA#27851)."""
    import shutil
    base = dict(verdict=LATE_REFUSED, verify={"verdict": "approve"},
                stages={"worktree": {"path": str(tmp_path / "wt"), "ok": True,
                                     "head": "0df1b6ad8c7c"},
                        "claim_reservation": dict(D.LATE_CLAIM_DEFERRED)})
    base.update(over)
    trace = _trace(tmp_path, **base)
    shutil.rmtree(tmp_path / "wt")
    return trace


def _stub_restore(monkeypatch, ok=True):
    seen = {"restore": [], "late": 0}

    def fake_restore(repo, dest, head):
        seen["restore"].append((dest, head))
        if ok:
            (dest / "Series").mkdir(parents=True, exist_ok=True)
        return {"ok": ok, "head": head, "path": str(dest)}

    def fake_late(args, rec):
        seen["late"] += 1
        return True

    monkeypatch.setattr(D, "restore_worktree", fake_restore)
    monkeypatch.setattr(D, "late_reservation", fake_late)
    return seen


def test_verify_from_publishes_an_approved_late_claim_refusal(monkeypatch, tmp_path):
    """#27851: approved + built, refused by the late-claim guard, then [RELEASED]
    by the holder. --verify-from re-creates the released worktree at the trace's
    head, re-reads the live claim, re-gates the SAME build and opens the PR, with
    the reservation still taken by late_reservation() right before stage 5."""
    seen = _stub_resume(monkeypatch)
    rs = _stub_restore(monkeypatch)
    gates = {}

    def fake_gates(args, rec, src_nb, built, create_mode, kname, wt, out_dir, prior=None):
        gates["built"] = built
        rec["verdict"] = "gates-ok"
        rec["verify"] = {"verdict": "approve"}

    monkeypatch.setattr(D, "gates_then_verify", fake_gates)
    got = _resume(_verify_args(tmp_path, _late_trace(tmp_path)))
    assert got["verdict"] == "pr-created" and seen["pr"] == 1
    assert rs["restore"] == [(tmp_path / "wt", "0df1b6ad8c7c")]
    assert got["stages"]["worktree_restored"]["ok"] is True
    assert gates["built"] == tmp_path / "nb_8_built.ipynb"
    assert got["calls"] == []                     # no coder turn re-paid
    assert rs["late"] == 1                        # the deferred claim is still taken
    assert got["stages"]["claim_reservation"]["deferred"] == "late"
    assert got["revised_from"]["verdict"] == LATE_REFUSED


def test_verify_from_late_refusal_still_held_refuses_before_any_spend(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch, claim_rc=1)
    rs = _stub_restore(monkeypatch)
    got = _resume(_verify_args(tmp_path, _late_trace(tmp_path)))
    assert got["verdict"] == ("refused-revise-no-reservation:"
                              "refused-claim-held-by-another-lane")
    assert rs["restore"] == [] and seen["loop"] == 0 and seen["pr"] == 0


def test_verify_from_refuses_an_unapproved_late_claim_refusal(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    _stub_restore(monkeypatch)
    trace = _late_trace(tmp_path, verify={"verdict": "reject", "findings": FINDINGS})
    got = _resume(_verify_args(tmp_path, trace))
    assert got["verdict"] == f"refused-verify-not-crashed:{LATE_REFUSED}"
    assert seen["loop"] == 0


def test_resume_refuses_when_the_worktree_cannot_be_restored(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    rs = _stub_restore(monkeypatch, ok=False)
    got = _resume(_verify_args(tmp_path, _late_trace(tmp_path)))
    assert got["verdict"].startswith("refused-revise-worktree-missing")
    assert len(rs["restore"]) == 1 and seen["loop"] == 0


def test_restore_worktree_adds_a_detached_tree_at_the_trace_head(monkeypatch, tmp_path):
    cmds = []
    dest = tmp_path / "wt"

    def fake_run(cmd, **kw):
        cmds.append(cmd)
        if "add" in cmd:
            dest.mkdir()
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(D.subprocess, "run", fake_run)
    got = D.restore_worktree(tmp_path / "repo", dest, "0df1b6ad8c7c")
    assert got["ok"] is True and got["head"] == "0df1b6ad8c7c"
    assert cmds[0][-2:] == ["worktree", "prune"]
    assert cmds[1][-4:] == ["add", "--detach", str(dest), "0df1b6ad8c7c"]
    assert "--force" not in cmds[1]
    assert D.restore_worktree(tmp_path / "repo", tmp_path / "x", None)["ok"] is False


def test_revise_from_repairs_a_gates_failed_trace(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    trace = _trace(tmp_path, verdict="gates-failed:machine-path",
                   gates=[{"gate": "machine-path", "ok": False,
                           "detail": {"cells": [15], "build_hits": [15]}}])
    got = _resume(_rev_args(tmp_path, trace))
    assert got["verdict"] == "pr-created" and seen["loop"] == 1 and seen["pr"] == 1
    assert got["gate_repair"]["resumed"] is True
    assert got["gate_repair"]["from"] == "gates-failed:machine-path"
    assert got["verify"]["source"] == "gates" and got["verify"]["findings"][0]["cell"] == 15


def test_revise_from_refuses_an_unrepairable_gates_failure(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    trace = _trace(tmp_path, verdict="gates-failed:language-info",
                   gates=[{"gate": "language-info", "ok": False,
                           "detail": {"canon": None, "built": None}}])
    got = _resume(_rev_args(tmp_path, trace))
    assert got["verdict"].startswith("refused-gate-repair-unrepairable:gates-failed")
    assert seen["loop"] == 0


# ---------------------------------------------------------------- gate repair
def _gates_call(monkeypatch, tmp_path, gates, **args_kw):
    built = _nb(tmp_path)
    monkeypatch.setattr(D, "run_gates", lambda *a, **kw: gates)
    rec = {"stages": {}, "calls": [], "verdict": "built-executed-ok"}
    args = SimpleNamespace(max_stage=5, revise_rounds=2)
    for k, v in args_kw.items():
        setattr(args, k, v)
    D.gates_then_verify(args, rec, tmp_path / "twin.ipynb", built, True, "python3",
                        tmp_path, tmp_path)
    return rec


def test_a_gate_failure_seeds_the_constructive_loop(monkeypatch, tmp_path):
    rec = _gates_call(monkeypatch, tmp_path, [
        {"gate": "machine-path", "ok": False,
         "detail": {"cells": [15], "source_hits": [], "build_hits": [15]}},
        {"gate": "language-info", "ok": False, "detail": {"canon": None, "built": None}}])
    assert rec["verdict"] == "verify-reject"              # routed into the review loop
    assert rec["verify"]["source"] == "gates" and rec["verify"]["verdict"] == "gate-reject"
    f = rec["verify"]["findings"]
    assert len(f) == 1                                    # language-info is NOT builder-fixable
    assert f[0]["cell"] == 15 and f[0]["severity"] == "major"
    assert "machine-path" in f[0]["detail"]
    assert rec["gate_repair"]["from"].startswith("gates-failed:")


def test_a_metadata_only_gate_failure_stays_terminal(monkeypatch, tmp_path):
    rec = _gates_call(monkeypatch, tmp_path, [
        {"gate": "language-info", "ok": False, "detail": {"canon": None, "built": None}}])
    assert rec["verdict"] == "gates-failed:language-info" and "verify" not in rec


def test_gate_repair_respects_a_disabled_loop(monkeypatch, tmp_path):
    rec = _gates_call(monkeypatch, tmp_path,
                      [{"gate": "machine-path", "ok": False, "detail": {"cells": [3]}}],
                      revise_rounds=0)
    assert rec["verdict"] == "gates-failed:machine-path" and "verify" not in rec


def _gate_seeded_rec():
    return {"verdict": "verify-reject", "calls": [], "stages": {},
            "gate_repair": {"from": "gates-failed:machine-path", "findings": 1},
            "verify": {"verdict": "gate-reject", "source": "gates",
                       "findings": [{"cell": 15, "severity": "major",
                                     "detail": "porte machine-path en échec"}]}}


def test_gate_repair_exhaustion_restores_the_honest_verdict(monkeypatch, tmp_path):
    built = _nb(tmp_path)
    _fake_engine(monkeypatch, ["pas du tout du json"], [("approve", [])])
    rec = _gate_seeded_rec()
    _loop(_loop_args(), rec, built, tmp_path)
    assert rec["verdict"] == "gates-failed:machine-path"   # never masked as verify-reject


def test_gate_repair_success_keeps_the_real_verdict(monkeypatch, tmp_path):
    built = _nb(tmp_path)
    _fake_engine(monkeypatch, [REVISION], [("approve", [])])
    rec = _gate_seeded_rec()
    _loop(_loop_args(), rec, built, tmp_path)
    assert rec["verdict"] == "verify-approved"
    assert "source" not in rec["verify"]                   # the REAL verify overwrote it


# ---------------------------------------------------------------- execution repair
# 21/11 (po-2028 report, Swift conveyor 18/46 launches): a build whose cells still failed
# after the kernel-repair rounds ended `built-execution-failed` with `revisions: []`.

def _err(ename: str, evalue: str) -> dict:
    return {"output_type": "error", "ename": ename, "evalue": evalue,
            "traceback": [f"{ename}: {evalue}"]}


def _failing_nb(tmp_path: Path, name: str = "built.ipynb") -> Path:
    """Cell 1 fails on its own; cell 3 fails only because cell 1 never bound `y`."""
    return _write(tmp_path / name, {"nbformat": 4, "nbformat_minor": 5, "metadata": {
        "kernelspec": {"name": "python3"}}, "cells": [
        {"cell_type": "markdown", "metadata": {}, "source": ["# Titre"]},
        {"cell_type": "code", "metadata": {}, "execution_count": 1,
         "source": ["y = 1 / 0"], "outputs": [_err("ZeroDivisionError", "division by zero")]},
        {"cell_type": "markdown", "metadata": {}, "source": ["Synthèse."]},
        {"cell_type": "code", "metadata": {}, "execution_count": 2,
         "source": ["print(y)"], "outputs": [_err("NameError", "name 'y' is not defined")]},
    ]})


FAILED_EXEC = [{"cell": 1, "status": "ok", "ok": False, "error": "ZeroDivisionError"},
               {"cell": 3, "status": "ok", "ok": False, "error": "NameError"}]


def _exec_call(tmp_path, **args_kw):
    built = _failing_nb(tmp_path)
    rec = {"stages": {}, "calls": [], "verdict": "built-execution-failed",
           "execution": [dict(e) for e in FAILED_EXEC]}
    args = SimpleNamespace(max_stage=5, revise_rounds=2)
    for k, v in args_kw.items():
        setattr(args, k, v)
    D.gates_then_verify(args, rec, tmp_path / "twin.ipynb", built, True, "python3",
                        tmp_path, tmp_path)
    return rec


def test_an_execution_failure_seeds_the_constructive_loop(tmp_path):
    rec = _exec_call(tmp_path)
    assert rec["verdict"] == "verify-reject"
    assert rec["verify"]["source"] == "execution" and rec["verify"]["verdict"] == "exec-reject"
    root, cascade = rec["verify"]["findings"]
    assert root["cell"] == 1 and root["severity"] == "major"
    assert "EXÉCUTION" in root["detail"] and "division by zero" in root["detail"]
    # the dependent cell points at its root instead of asking a workaround
    assert cascade["cell"] == 3 and "CASCADE de la cellule 1" in cascade["detail"]
    assert rec["exec_repair"] == {"from": "built-execution-failed", "seeded": 1, "findings": 2}


@pytest.mark.parametrize("kw", [{"revise_rounds": 0}, {"max_stage": 3}])
def test_execution_repair_respects_a_disabled_loop(tmp_path, kw):
    rec = _exec_call(tmp_path, **kw)
    assert rec["verdict"] == "built-execution-failed" and "verify" not in rec


def test_execution_findings_cap_is_declared(tmp_path):
    cells = [{"cell_type": "code", "metadata": {}, "execution_count": i + 1,
              "source": [f"v{i} = 1 / 0"], "outputs": [_err("ZeroDivisionError", f"cell {i}")]}
             for i in range(D.EXEC_FINDINGS_MAX + 2)]
    built = _write(tmp_path / "many.ipynb", {"nbformat": 4, "nbformat_minor": 5,
                                             "metadata": {}, "cells": cells})
    rec = {"execution": [{"cell": i, "ok": False} for i in range(len(cells))]}
    f = D.exec_repair_findings(rec, built)
    assert len(f) == D.EXEC_FINDINGS_MAX + 1
    assert f[-1]["cell"] is None and "2 autres cellules" in f[-1]["detail"]
    assert f[-1]["detail"].endswith(f"{[D.EXEC_FINDINGS_MAX, D.EXEC_FINDINGS_MAX + 1]}")


def test_execution_findings_fall_back_on_the_recorded_error(tmp_path):
    built = _nb(tmp_path)                       # no error output persisted on disk
    f = D.exec_repair_findings({"execution": [{"cell": 3, "ok": False, "status": "timeout",
                                               "error": "délai dépassé"}]}, built)
    assert f[0]["cell"] == 3 and "(statut timeout)" in f[0]["detail"]
    assert "délai dépassé" in f[0]["detail"]
    assert D.exec_repair_findings({"execution": [{"cell": 1, "ok": True}]}, built) == []


def _exec_seeded_rec():
    return {"verdict": "verify-reject", "calls": [], "stages": {},
            "execution": [dict(e) for e in FAILED_EXEC],
            "exec_repair": {"from": "built-execution-failed", "seeded": 1, "findings": 1},
            "verify": {"verdict": "exec-reject", "source": "execution",
                       "findings": [{"cell": 1, "severity": "major",
                                     "detail": "échec d'EXÉCUTION réel du noyau"}]}}


def test_execution_repair_exhaustion_restores_the_honest_verdict(monkeypatch, tmp_path):
    built = _failing_nb(tmp_path)
    _fake_engine(monkeypatch, ["pas du tout du json"], [])
    rec = _exec_seeded_rec()
    _loop(_loop_args(), rec, built, tmp_path)
    assert rec["verdict"] == "built-execution-failed"      # never masked as verify-reject


def test_execution_repair_success_reaches_the_real_verifier(monkeypatch, tmp_path):
    built = _failing_nb(tmp_path)
    calls = _fake_engine(monkeypatch, [REVISION], [("approve", [])])
    rec = _exec_seeded_rec()
    _loop(_loop_args(), rec, built, tmp_path)
    assert rec["verdict"] == "verify-approved" and len(calls["verify"]) == 1
    assert "source" not in rec["verify"]                   # the REAL verify overwrote it
    assert rec["revisions"][0]["exec_verdict"] == "built-executed-ok"
    # the reviser saw the real kernel error, not only the finding
    assert "ZeroDivisionError" in calls["sk"][0]["prompt"]


def test_a_draft_that_fails_again_is_reseeded_from_its_own_errors(monkeypatch, tmp_path):
    built = _failing_nb(tmp_path)
    calls = _fake_engine(monkeypatch, [REVISION, REVISION], [("approve", [])])
    real_exec = D.execute_cells
    runs = {"n": 0}

    async def flaky_exec(pm, nb_path, kid, idx):
        runs["n"] += 1
        if runs["n"] > 1:
            return await real_exec(pm, nb_path, kid, idx)
        nb = json.loads(nb_path.read_text(encoding="utf-8"))
        for n, i in enumerate(idx, 1):
            nb["cells"][i]["execution_count"] = n
            nb["cells"][i]["outputs"] = ([_err("TypeError", "second failure")] if i == 1
                                         else [])
        nb_path.write_text(json.dumps(nb), encoding="utf-8")
        return [{"cell": i, "ok": i != 1} for i in idx]

    monkeypatch.setattr(D, "execute_cells", flaky_exec)
    rec = _exec_seeded_rec()
    _loop(_loop_args(), rec, built, tmp_path)
    assert [r["result"] for r in rec["revisions"]] == ["verify-reject", "verify-approved"]
    assert rec["exec_repair"]["seeded"] == 2
    # round 1 answers the CURRENT failure, not the first one
    assert "second failure" in calls["sk"][1]["prompt"]
    assert rec["verdict"] == "verify-approved"


def test_a_dead_kernel_during_execution_repair_keeps_its_verdict(monkeypatch, tmp_path):
    built = _failing_nb(tmp_path)
    _fake_engine(monkeypatch, [REVISION], [])

    async def no_kernel(pm, kname, cwd):
        return None

    monkeypatch.setattr(D, "start_kernel", no_kernel)
    rec = _exec_seeded_rec()
    _loop(_loop_args(), rec, built, tmp_path)
    assert rec["verdict"] == "kernel-start-failed"


def test_revise_from_repairs_a_built_execution_failed_trace(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    trace = _trace(tmp_path, verdict="built-execution-failed",
                   execution=[dict(e) for e in FAILED_EXEC])
    _failing_nb(tmp_path, "nb_8_built.ipynb")              # the build the trace points at
    got = _resume(_rev_args(tmp_path, trace))
    assert got["verdict"] == "pr-created" and seen["loop"] == 1
    assert got["exec_repair"]["resumed"] is True
    assert got["verify"]["source"] == "execution"
    assert [f["cell"] for f in got["verify"]["findings"]] == [1, 3]


def test_revise_from_refuses_an_execution_trace_with_nothing_failing(monkeypatch, tmp_path):
    seen = _stub_resume(monkeypatch)
    trace = _trace(tmp_path, verdict="built-execution-failed",
                   execution=[{"cell": 1, "ok": True}])
    got = _resume(_rev_args(tmp_path, trace))
    assert got["verdict"] == "refused-exec-repair-unrepairable:built-execution-failed"
    assert seen["loop"] == 0


# ---------------------------------------------------------------- CLI + scheduler
@pytest.mark.parametrize("extra, needle", [
    (["--revise-from", "t.json", "--from-spec", "--meta-from", "S/M.ipynb"], "do not pass"),
    (["--revise-from", "t.json", "--revise-rounds", "0"], "--revise-rounds >= 1"),
    (["--revise-from", "t.json", "--max-stage", "3"], "--max-stage >= 4"),
    (["--revise-from", "t.json", "--verify-from", "t.json"], "exclusive"),
    (["--verify-from", "t.json", "--max-stage", "3"], "--max-stage >= 4 (that is the stage"),
    (["--verify-from", "t.json", "--source-nb", "S/P.ipynb"], "do not pass"),
])
def test_cli_guards(monkeypatch, capsys, extra, needle):
    monkeypatch.setattr(sys, "argv", ["nb_coder_driver.py", "--issue", "1", "--notebook",
                                      "S/N.ipynb", "--repo", "D:/repo", "--max-stage", "4",
                                      *extra])
    with pytest.raises(SystemExit) as e:
        D.main()
    assert e.value.code == 2
    assert needle in capsys.readouterr().err


def test_main_keeps_the_revised_trace(monkeypatch, tmp_path):
    out = tmp_path / "issue-1.json"
    out.write_text('{"verdict": "verify-reject"}', encoding="utf-8")

    async def fake_rev(args, rec):
        rec["verdict"] = "verify-approved"
        return rec

    monkeypatch.setattr(D, "run_revision", fake_rev)
    monkeypatch.setattr(D, "_preflight", lambda ap, args: None)
    monkeypatch.setattr(D, "engine_tokens", lambda: {})
    monkeypatch.setattr(sys, "argv", ["nb_coder_driver.py", "--issue", "1", "--notebook",
                                      "S/N.ipynb", "--repo", "D:/repo", "--max-stage", "4",
                                      "--out-dir", str(tmp_path), "--revise-from", str(out)])
    D.main()
    kept = list(tmp_path.glob("issue-1.pre-revise-*.json"))
    assert len(kept) == 1 and json.loads(kept[0].read_text())["verdict"] == "verify-reject"
    new = json.loads(out.read_text(encoding="utf-8"))
    assert new["verdict"] == "verify-approved"
    assert new["revised_from"]["kept_as"] == str(kept[0])
    led = json.loads((tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()[-1])
    assert led["revised_from"] is True


def test_main_keeps_the_verify_trace(monkeypatch, tmp_path):
    out = tmp_path / "issue-1.json"
    out.write_text('{"verdict": "verify-error"}', encoding="utf-8")

    async def fake_rev(args, rec):
        rec["verdict"] = "verify-approved"
        return rec

    monkeypatch.setattr(D, "run_revision", fake_rev)
    monkeypatch.setattr(D, "_preflight", lambda ap, args: None)
    monkeypatch.setattr(D, "engine_tokens", lambda: {})
    monkeypatch.setattr(sys, "argv", ["nb_coder_driver.py", "--issue", "1", "--notebook",
                                      "S/N.ipynb", "--repo", "D:/repo", "--max-stage", "4",
                                      "--out-dir", str(tmp_path), "--verify-from", str(out)])
    D.main()
    kept = list(tmp_path.glob("issue-1.pre-verify-*.json"))
    assert len(kept) == 1 and json.loads(kept[0].read_text())["verdict"] == "verify-error"
    led = json.loads((tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()[-1])
    assert led["revised_from"] is True


def test_scheduler_forwards_revise_rounds(tmp_path):
    import test_nb_coder_scheduler as TS
    sched = TS.make_sched(tmp_path, [{"issue": 44, "notebook": "A/D.ipynb", "max_stage": 4,
                                      "revise_rounds": 3}])
    joined = " ".join(sched.driver_command(sched.items_by_key["#44:A/D.ipynb"]))
    assert "--revise-rounds 3" in joined
    sched2 = TS.make_sched(tmp_path, [{"issue": 45, "notebook": "A/E.ipynb", "max_stage": 4}])
    joined2 = " ".join(sched2.driver_command(sched2.items_by_key["#45:A/E.ipynb"]))
    assert "--revise-rounds 2" in joined2                 # the scheduler default applies


# ---------------------------------------------------------------- twin reference (22/11)
# 25 of 105 verify-reject findings (w3a-w3x) were values the builder reinvented: the
# reviser saw the findings and the draft, never what the twin actually printed.
def _twin(tmp_path):
    nb = {"cells": [
        {"cell_type": "markdown", "source": "# T", "metadata": {}},
        {"cell_type": "code", "source": "print(3.97)", "metadata": {}, "execution_count": 1,
         "outputs": [{"output_type": "stream", "name": "stdout", "text": "3.97\n"}]},
        {"cell_type": "code", "source": "x = 1", "metadata": {}, "execution_count": 2,
         "outputs": []}],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5}
    p = tmp_path / "twin.ipynb"
    p.write_text(json.dumps(nb), encoding="utf-8")
    return p


def test_twin_reference_view_shows_code_and_real_outputs(tmp_path):
    v = D.twin_reference_view(_twin(tmp_path))
    assert "print(3.97)" in v and "3.97" in v.split("SORTIE RÉELLE")[1]
    assert "(aucune sortie enregistrée)" in v          # declared, never filled in
    assert "# T" not in v                               # markdown is not a reference
    assert D.twin_reference_view(tmp_path / "absent.ipynb") == ""


def test_revision_prompt_carries_twin_reference_and_values_rule():
    p = D.revision_prompt({"title": "T", "body": "B"}, "V", [], twin_view="REF-3.97")
    assert "Jumeau source — code ET sorties de RÉFÉRENCE" in p and "REF-3.97" in p
    assert "VALEURS :" in p
    bare = D.revision_prompt({"title": "T", "body": "B"}, "V", [])
    assert "RÉFÉRENCE" not in bare and "VALEURS :" not in bare


def test_creation_segment_carries_twin_reference_outputs(tmp_path):
    cells = D._cells(_twin(tmp_path))
    p = D.creation_json_prompt([{"idx": 1, "cell_type": "code"}], 3, "", src_cells=cells)
    assert "CODE ET SORTIES DE RÉFÉRENCE DU JUMEAU" in p and "3.97" in p
    md_only = D.creation_json_prompt([{"idx": 0, "cell_type": "markdown"}], 3, "",
                                     src_cells=cells)
    assert "SORTIES DE RÉFÉRENCE" not in md_only


def test_revise_loop_hands_the_twin_reference_to_the_reviser(monkeypatch, tmp_path):
    """Wiring pin: the reviser of a CREATION sees the twin's real outputs (the values to
    reproduce), not only the findings — unit-testing revision_prompt alone would miss a
    call site that stops passing them."""
    _twin(tmp_path)                                    # src_nb of _loop = tmp_path/twin.ipynb
    built = _nb(tmp_path)
    calls = _fake_engine(monkeypatch, [REVISION], [("approve", [])])
    _loop(_loop_args(), _rejected_rec(), built, tmp_path)
    p = calls["sk"][0]["prompt"]
    assert "Jumeau source — code ET sorties de RÉFÉRENCE" in p and "print(3.97)" in p
    assert "VALEURS :" in p
