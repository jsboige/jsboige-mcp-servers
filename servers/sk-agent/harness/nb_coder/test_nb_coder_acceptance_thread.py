#!/usr/bin/env python3
"""Offline pins: an acceptance amendment posted in the issue THREAD reaches the verifier.

Measured 24/11 on CoursIA#28079 (seat po-2028:claudish). The 23/11 11:52:35Z comment
(`jsboige`, on behalf of myia-ai-01:vllm) amended acceptance: a "non-parité arithmétique"
reject cannot rest on a machine-precision quadrature that meets four declared points. The
verifier re-rejected on that very ground at 12:29:00Z (nb-luna-oai, 4 findings) and at
00:33:16Z (nb-terra, 4 findings): `verify_prompt` carried the issue TITLE and BODY only,
while the build prompts carried the thread tail (`## Fil (extrait récent)`). The reviser
(`revision_prompt`) had the same blind spot, so a revision round could only bend the
notebook to a finding the thread had struck. The grain was delivered (CoursIA#28431) only
after the amendment had been copied into the issue body by hand.

Pinned here: the verifier's prompt renders the thread's NON-BOT voices and nothing a lane
bot wrote (a producing agent's words never reach an independent verifier); spec selection
still reads every comment, bot-posted or not; the recent tail is what survives a long
thread; the reviser sees the same thread tail as the build prompts; the driver forwards
its `--conventions` to the verifier. No GitHub, no engine: `gh` is faked, `subprocess.run`
is captured.
"""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as d  # noqa: E402
import nb_coder_verify as v  # noqa: E402

TARGET = "MyIA.AI.Notebooks/Physique/Integrales/Integrales-03-Bulle-Premiere-Divergence-CSharp.ipynb"
AMENDMENT = ("**Amendement d'acceptation — myia-ai-01:vllm, 23/11 11:5xZ**\n\nUn rejet "
             "« non-parité arithmétique » **ne peut pas porter** sur une quadrature en "
             "précision machine qui remplit ces 4 points.")
CONSIGNE = "**Consigne de reprise — Integrales-03-Bulle (myia-po-2028:claudish) — harnais 100 % OpenAI**"


def cm(i, body, login, at):
    return {"id": i, "login": login, "created_at": at, "body": body}


def thread_28079():
    """The measured #28079 thread, shortened to what the selection has to tell apart."""
    return [cm(7082498892, "[CLAIMED] lane myia-po-2028:claudish -- Fournee w3w : C# vague 4",
               "coursia-lane-po-2028[bot]", "2026-11-22T16:59:52Z"),
            cm(7089456945, "[OVERRIDE] lane myia-po-2028:claudish -- paths: " + TARGET,
               "myia-ai-01", "2026-11-23T01:50:22Z"),
            cm(7093112561, "[RELEASED] lane myia-po-2028:claudish — Integrales-03 : verify-reject",
               "coursia-lane-po-2028[bot]", "2026-11-23T06:12:49Z"),
            cm(7100200718, AMENDMENT, "jsboige", "2026-11-23T11:52:35Z"),
            cm(7141705843, CONSIGNE, "coursia-lane-po-2028[bot]", "2026-11-24T19:10:24Z")]


# ---------------------------------------------------------------- who is rendered
def test_non_bot_voices_keep_the_amendment_and_drop_the_lane_bot_lines():
    issue = {"title": "T", "body": "B"}
    d.select_target_spec(issue, thread_28079(), None, voices="non-bot")
    assert AMENDMENT in issue["comments"], "the verifier must read the acceptance amendment"
    assert "[OVERRIDE]" in issue["comments"], "a coordinator's word is acceptance too"
    for bot_line in ("[CLAIMED]", "[RELEASED]", CONSIGNE):
        assert bot_line not in issue["comments"], "a producing agent's words stay out"


def test_the_default_selection_is_unchanged_for_the_producer_side():
    issue = {"title": "T", "body": "B"}
    info = d.select_target_spec(issue, thread_28079(), None)
    assert info["status"] == "no-target"
    for line in ("[CLAIMED]", "[OVERRIDE]", "[RELEASED]", AMENDMENT, CONSIGNE):
        assert line in issue["comments"], "the build prompts keep the whole thread"


def test_a_bot_login_is_judged_by_its_suffix_only():
    thread = [cm(1, "HUMAN-WORD", "jsboige", "2026-11-23T11:52:35Z"),
              cm(2, "not-a-bot-account", "lane-bot", "2026-11-23T11:53:35Z"),
              cm(3, "APP-WORD", "coursia-lane-po-2028[bot]", "2026-11-23T11:54:35Z")]
    issue = {"title": "T", "body": "B"}
    d.select_target_spec(issue, thread, None, voices="non-bot")
    assert "HUMAN-WORD" in issue["comments"] and "not-a-bot-account" in issue["comments"]
    assert "APP-WORD" not in issue["comments"]


# ---------------------------------------------------------------- the spec is not lost
def _spec(target, marker):
    return (f"[SPEC-DRAFT] lane x -- brouillon\n\n---\n\n## Objet\n\n"
            f"- Source : `s.ipynb` (23 cellules)\n- Cible : `{target}` (à créer)\n\n"
            f"## Plan des cellules\n\n| Index | Première ligne |\n|---|---|\n| 2 | {marker} |\n")


def test_spec_selection_still_reads_a_bot_posted_spec():
    """Specs are bot-posted by design: the voice filter applies to the rendered thread only."""
    thread = [cm(1, "[CLAIMED] lane a", "lane-a[bot]", "2026-11-23T01:00:00Z"),
              cm(2, _spec(TARGET, "MARK-SPEC"), "spec-lane[bot]", "2026-11-23T02:00:00Z"),
              cm(3, AMENDMENT, "jsboige", "2026-11-23T11:52:35Z")]
    issue = {"body": "Lot body"}
    info = d.select_target_spec(issue, thread, TARGET, voices="non-bot")
    assert info["status"] == "selected" and info["comment_id"] == 2
    assert "MARK-SPEC" in issue["body"], "the spec still reaches the verifier, through the body"
    assert "[CLAIMED]" not in issue["comments"] and AMENDMENT in issue["comments"]


def test_a_lot_without_a_spec_for_this_target_is_still_refused_for_the_verifier():
    other = TARGET.replace("CSharp", "Rust")
    thread = [cm(2, _spec(other, "MARK-OTHER"), "spec-lane[bot]", "2026-11-23T02:00:00Z")]
    info = d.select_target_spec({"body": "B"}, thread, TARGET, voices="non-bot")
    assert info["status"] == "none-for-target"


# ---------------------------------------------------------------- what survives a long thread
def test_the_recent_tail_is_what_survives_a_long_thread():
    """The selection renders every voice; the 8 000-char TAIL cut is the verifier prompt's."""
    old = cm(1, "[OVERRIDE] " + "x" * 9000, "myia-ai-01", "2026-11-23T01:00:00Z")
    thread = [old] + thread_28079()[2:]
    issue = {"title": "T", "body": "B"}
    d.select_target_spec(issue, thread, None, voices="non-bot")
    assert "[OVERRIDE] xxxx" in issue["comments"], "nothing is cut at the selection"
    p = v.verify_prompt(issue, "SRC", "BUILT", {}, "")
    assert AMENDMENT in p, "an amendment is recent: it must be in the tail"
    assert "[OVERRIDE] xxxx" not in p, "the head of a long thread is what the cut removes"


# ---------------------------------------------------------------- the verifier's prompt
def test_the_verifier_prompt_carries_the_amendment_thread_between_body_and_source():
    issue = {"title": "T", "body": "B", "comments": f"--- jsboige 2026-11-23T11:52:35Z\n{AMENDMENT}"}
    p = v.verify_prompt(issue, "SRC", "BUILT", {}, "")
    assert AMENDMENT in p
    assert p.index("CORPS") < p.index("## Fil de l'issue") < p.index("## SOURCE")
    assert "ne peut pas porter" in p


def test_the_verifier_prompt_has_no_thread_block_without_a_thread():
    p = v.verify_prompt({"title": "T", "body": "B"}, "SRC", "BUILT", {}, "")
    assert "## Fil de l'issue" not in p
    p = v.verify_prompt({"title": "T", "body": "B", "comments": ""}, "SRC", "BUILT", {}, "")
    assert "## Fil de l'issue" not in p


def test_fetch_issue_hands_the_verifier_the_filtered_thread(monkeypatch):
    stream = "\n".join(json.dumps(c, ensure_ascii=False) for c in thread_28079())

    def fake_gh(args, token=None, timeout=60):
        if args[1].endswith("/comments"):
            return 0, stream
        return 0, json.dumps({"title": "T", "state": "open", "body": "B", "labels": []})

    monkeypatch.setattr(d, "gh", fake_gh)
    issue = d.fetch_issue("o/r", 28079, None, None, voices="non-bot")
    assert AMENDMENT in issue["comments"] and "[CLAIMED]" not in issue["comments"]
    issue = d.fetch_issue("o/r", 28079, None, None)
    assert "[CLAIMED]" in issue["comments"], "no voices argument: the producer's whole thread"


# ---------------------------------------------------------------- the reviser's prompt
def test_the_reviser_prompt_carries_the_thread_tail_like_the_build_prompts():
    issue = {"title": "T", "body": "B", "comments": f"--- jsboige 2026-11-23T11:52:35Z\n{AMENDMENT}"}
    p = d.revision_prompt(issue, "VIEW", [{"cell": 8, "severity": "major", "detail": "non-parité"}])
    assert "## Fil (extrait récent)" in p and AMENDMENT in p
    assert "## Fil (extrait récent)" not in d.revision_prompt({"title": "T", "body": "B"}, "VIEW", [])


# ---------------------------------------------------------------- one conventions text for both
def _stage4_cmd(monkeypatch, tmp_path, **kw):
    cmds = []

    def fake_run(cmd, **k):
        cmds.append(cmd)
        (tmp_path / "verify-7.json").write_text(json.dumps({"verdict": "approve"}), encoding="utf-8")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(d.subprocess, "run", fake_run)
    args = SimpleNamespace(issue=7, verifier_agent="v", verify_timeout=60, from_spec=False, **kw)
    d.stage4_verify(args, {"calls": []}, tmp_path / "s.ipynb", tmp_path / "b.ipynb", tmp_path)
    return cmds[0]


def test_the_driver_forwards_its_conventions_to_the_verifier(monkeypatch, tmp_path):
    cmd = _stage4_cmd(monkeypatch, tmp_path, conventions="D:/elsewhere/conventions.md")
    assert cmd[cmd.index("--conventions") + 1] == "D:/elsewhere/conventions.md"


def test_an_empty_conventions_argument_adds_nothing_to_the_verifier_command(monkeypatch, tmp_path):
    cmd = _stage4_cmd(monkeypatch, tmp_path, conventions="")
    assert "--conventions" not in cmd
