# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_driver.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Pins for the call-failure classifier (vllm#457, on top of #442's F5).

#442 shipped `call_failure()` with **no test at all** — one file touched, the driver. That
function carries two properties worth freezing: the verdict must name the right REPAIR
(a credential problem and a model-name problem are repaired in different places, by
different people), and a long error must not lose the sentence that explains it.

Every fixture below is a string measured on po-2028:claudish the 16/11 three-model sweep,
not an invented shape — a pin built on a made-up payload protects nothing.

Skipped when `mcp` is not importable (the driver imports the MCP client at load).
"""
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as d  # noqa: E402


# The real 403 body, verbatim from the luna run's driver.log (em dashes included: they are
# what the proxy emits, and a pin that normalises them stops testing the real string).
_LUNA_403 = (
    'ServiceResponseException: ("<class \'…OpenAIChatCompletion\'> service failed to complete '
    "the prompt\", PermissionDeniedError(\"Error code: 403 - {'error': {'message': 'claudish: "
    "unknown model nb-luna — not found in any provider catalog or routing map (it was "
    "defaulted to the native lane, which this proxy cannot serve: no Anthropic credential) "
    "— use provider@model or a configured alias', 'type': 'permission_error', 'code': "
    'None}}"))'
)


def _verdict(err: str) -> str:
    return d.call_failure({"error": err})


def test_unknown_model_403_is_model_unresolved():
    v = _verdict(_LUNA_403)
    assert v.startswith("model-unresolved: "), v


def test_model_unresolved_wins_over_the_status_code():
    """Both markers are present (403 and 'unknown model'); the body must win.

    This is the whole point of #457: the code is ambiguous (`permission_error` rides 403 on
    the OpenAI wire), the wording is not. A future refactor that checks the code first turns
    this test red without moving the fixture.
    """
    v = _verdict(_LUNA_403)
    assert "auth-failed" not in v


def test_401_invalid_proxy_authentication_is_still_auth_failed():
    """The #441 case must not regress: an unset api_key_env IS a credential problem."""
    v = _verdict("Error code: 401 - invalid proxy authentication")
    assert v.startswith("auth-failed: "), v


def test_timeout_with_a_large_ms_count_is_not_auth():
    """Word boundaries, not substring search: '1401' must never match '401'."""
    v = _verdict("timeout after 1401 ms")
    assert v.startswith("call-failed: "), v


def test_a_port_number_is_not_auth():
    v = _verdict("listening on port 8403")
    assert v.startswith("call-failed: "), v


def test_a_model_unresolved_verdict_names_the_model():
    """The window is centred on the marker: the verdict must carry the word that justifies it.

    Head+tail alone put the model name at char ~185 — past the head slice, before the tail
    slice. The pin found that gap in the fix itself; this assertion is what keeps it closed.
    """
    v = _verdict(_LUNA_403)
    assert "nb-luna" in v, "the verdict lost the model name it is about"
    assert "unknown model" in v


def test_a_long_plain_error_keeps_both_ends():
    """Without a marker: the head names the exception, the tail names the cause."""
    v = _verdict("E" * 300 + " THE ACTUAL CAUSE")
    assert v.startswith("call-failed: EEE"), v
    assert v.endswith("THE ACTUAL CAUSE"), v


def test_the_abbreviated_payload_stays_bounded():
    payload = _verdict(_LUNA_403).removeprefix("model-unresolved: ")
    assert len(payload) <= 160, len(payload)
    assert not payload.startswith(" "), "the window opens mid-token"


def test_the_short_error_is_not_abbreviated():
    v = _verdict("boom")
    assert v == "call-failed: boom"


def test_an_answered_call_returns_no_verdict():
    assert d.call_failure({}) == ""
    assert d.call_failure({"response": "fine"}) == ""


# ---- grain tag (CoursIA's merge gate, 16/11) ----
# The tag is read by TWO guards, and the second one was measured the hard way: the tier guard
# wants `Grain: <TIER>/<GENRE>`, and #10983's guard poses `variation-tag-prev-absent` on a tag
# that declares no predecessor. CoursIA#26943 carried both labels the moment it opened.

def test_grain_tag_is_the_line_the_parser_reads():
    assert d.grain_tag("MED", "myia-po-2028:claudish") == (
        "Grain: MED/notebook-python — lane myia-po-2028:claudish — "
        "prev: none (premier grain)")


def test_auto_is_refused_rather_than_written_silently():
    """The exact string that made every harness PR unmergeable: `auto` is not a tier."""
    with pytest.raises(ValueError):
        d.grain_tag("auto", "myia-po-2028:claudish")


def test_a_predecessor_is_cited_verbatim():
    assert d.grain_tag("LIGHT", "l", prev="MED/tooling #26943") == (
        "Grain: LIGHT/notebook-python — lane l — prev: MED/tooling #26943")


def test_a_prev_that_is_not_a_predecessor_is_refused():
    """`prev:` is read as a CITATION, so a value that is not one must not reach the body."""
    with pytest.raises(ValueError):
        d.grain_tag("MED", "l", prev="auto/notebook-python")
    with pytest.raises(ValueError):
        d.grain_tag("MED", "l", prev="see the previous one")


def test_an_unreadable_history_omits_the_field_rather_than_inventing_one():
    """No predecessor READ is not the same fact as no predecessor EXISTING.

    Writing the exemption here would assert a first grain nobody checked; the guard's label
    is then the true verdict, and the trace records why (see `lane_predecessor`).
    """
    tag = d.grain_tag("MED", "myia-po-2028:claudish", prev=None)
    assert "prev" not in tag
    assert tag == "Grain: MED/notebook-python — lane myia-po-2028:claudish"


def test_nothing_scannable_follows_the_prev_field():
    """The parser takes the first `#N` within 120 chars after `prev: <TIER>/<GENRE>`.

    A trailing `— issue #26804` (this harness's old tag shape) would be READ AS THE PR
    NUMBER: an adjacency verdict against an issue that is not a grain. `prev:` is last.
    """
    tag = d.grain_tag("MED", "l", prev="MED/notebook-python")
    assert tag.endswith("prev: MED/notebook-python")


def test_the_pr_body_is_built_from_the_flag_not_from_a_literal():
    """A pin on the CALL SITE: `grain_tag()` can be perfect and still never be used.

    Reverting the body to its old literal would leave every behavioural pin green — the
    regression lives in a string, so the pin reads the source (house pattern: grep the
    wiring, not the intent).
    """
    src = Path(d.__file__).read_text(encoding="utf-8")
    assert 'f"{grain_tag(args.grain_tier' in src, "the PR body no longer uses the flag"
    assert '"Grain: auto' not in src, "a literal `auto` tier is back in the source"
    # The predecessor reaches the tag from a real read, not from a constant.
    assert "lane_predecessor(repo_slug, args.lane, token)" in src
    assert "prev=prev" in src, "the read predecessor is no longer handed to the tag"


# ---- lane predecessor (vllm#459: `prev:` is lane history, not a value this run knows) ----

def _stub_gh(monkeypatch, prs, rc=0):
    """Replace the `gh` runner: the pins below are about READING, not about GitHub."""
    calls = []

    def fake(args, token=None, timeout=60):
        calls.append(args)
        if rc != 0:
            return rc, "HTTP 502"
        return 0, json.dumps(prs)
    monkeypatch.setattr(d, "gh", fake)
    return calls


def test_a_lane_with_no_earlier_grain_cites_the_documented_exemption(monkeypatch):
    _stub_gh(monkeypatch, [])
    assert d.lane_predecessor("o/r", "myia-po-2028:claudish", None) == d.GRAIN_PREV_FIRST


def test_the_newest_matching_grain_is_the_predecessor(monkeypatch):
    _stub_gh(monkeypatch, [
        {"number": 26950, "body": "Grain: LIGHT/docs — lane myia-po-2028:claudish — prev: none"},
        {"number": 26920, "body": "Grain: DEEP/tooling — lane myia-po-2028:claudish"},
    ])
    assert d.lane_predecessor("o/r", "myia-po-2028:claudish", None) == "LIGHT/docs #26950"


def test_the_predecessor_is_the_highest_number_not_the_first_row(monkeypatch):
    """GitHub's search ordering is not creation order — measured 16/11 on CoursIA, where
    `#26790` came back ABOVE `#26806`. Reading the first row would cite an older grain."""
    _stub_gh(monkeypatch, [
        {"number": 26790, "body": "Grain: MED/notebook-python — lane myia-po-2028:claudish"},
        {"number": 26821, "body": "Grain: MED/notebook-python — lane myia-po-2028:claudish"},
    ])
    assert d.lane_predecessor("o/r", "myia-po-2028:claudish", None) == "MED/notebook-python #26821"


def test_a_sibling_lane_is_not_cited(monkeypatch):
    """The search is a substring match: `lane myia-po-2028:claudish` also returns
    `…:claudish-2`. Citing a sibling's grain would make the adjacency verdict meaningless."""
    _stub_gh(monkeypatch, [
        {"number": 26951, "body": "Grain: DEEP/docs — lane myia-po-2028:claudish-2"},
        {"number": 26949, "body": "Grain: MED/notebook-python — lane myia-po-2028:claudish"},
    ])
    assert d.lane_predecessor("o/r", "myia-po-2028:claudish", None) == "MED/notebook-python #26949"


def test_an_unreadable_history_says_so_instead_of_citing_a_first_grain(monkeypatch):
    _stub_gh(monkeypatch, [], rc=1)
    assert d.lane_predecessor("o/r", "myia-po-2028:claudish", None) is None


def test_a_tag_without_grain_is_not_a_predecessor(monkeypatch):
    _stub_gh(monkeypatch, [
        {"number": 26952, "body": "Fix something. Closes #26804"},
        {"number": 26940, "body": "Grain: MED/notebook-python — lane myia-po-2028:claudish"},
    ])
    assert d.lane_predecessor("o/r", "myia-po-2028:claudish", None) == "MED/notebook-python #26940"


def test_the_cited_pr_number_is_the_pull_request_not_an_issue(monkeypatch):
    """The wrong-pointer pin. The harness's OWN old tag ends `— issue #26804`; reading that
    line must yield the PR it lives in, never the issue it cites."""
    _stub_gh(monkeypatch, [
        {"number": 26943, "body": "Grain: LIGHT/docs — lane myia-po-2028:claudish — issue #26804"},
    ])
    assert d.lane_predecessor("o/r", "myia-po-2028:claudish", None) == "LIGHT/docs #26943"


def test_the_flag_the_pr_body_reads_is_defined_by_the_parser():
    """The OTHER half of the wiring (vllm-c2 review of #481, 18/11): a call-site pin
    cannot see a missing add_argument — a body reading `args.grain_tier` with no
    `--grain-tier` flag raises AttributeError at EVERY stage5, while every unit pin
    stays green. Asserts the definition exists, is unique, keeps its contract, and
    that argparse normalisation (str.upper) accepts a lowercase DEEP."""
    src = Path(d.__file__).read_text(encoding="utf-8")
    assert 'ap.add_argument("--grain-tier"' in src, \
        "the parser no longer defines --grain-tier the PR body reads"
    assert "type=str.upper" in src and "choices=list(GRAIN_TIERS)" in src, \
        "the flag lost its normalisation/choices contract"
    import ast
    tree = ast.parse(src)
    flags = [n.args[0].value for n in ast.walk(tree)
             if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "add_argument"
             and n.args and isinstance(n.args[0], ast.Constant)
             and n.args[0].value == "--grain-tier"]
    assert flags == ["--grain-tier"], \
        f"expected exactly one --grain-tier definition, found {flags}"
    import argparse as _ap
    p = _ap.ArgumentParser()
    p.add_argument("--grain-tier", type=str.upper,
                   choices=list(d.GRAIN_TIERS), default="MED")
    assert p.parse_args(["--grain-tier", "deep"]).grain_tier == "DEEP"


def test_grain_tag_round_trips_through_the_coursia_parser():
    """Read by the CONSUMER, not by a copy of its grammar. Skipped where CoursIA is absent."""
    coursia = Path(r"D:\dev\CoursIA\scripts")
    if not (coursia / "grain_tag.py").is_file():
        pytest.skip("CoursIA checkout absent on this seat")
    sys.path.insert(0, str(coursia))
    import grain_tag as g  # noqa: E402

    parsed = g.parse_grain_tag(d.grain_tag("LIGHT", "myia-po-2028:claudish"))
    assert parsed["tier"] == "LIGHT"
    assert parsed["genre"] == "notebook-python"
    assert parsed["lane"] == "myia-po-2028:claudish"


def test_the_prev_field_round_trips_through_the_coursia_parser():
    """Both shapes reach the guard as what they claim: an exemption, and a citation."""
    coursia = Path(r"D:\dev\CoursIA\scripts")
    if not (coursia / "grain_tag.py").is_file():
        pytest.skip("CoursIA checkout absent on this seat")
    sys.path.insert(0, str(coursia))
    import grain_tag as g  # noqa: E402

    first = g.parse_prev(d.grain_tag("MED", "myia-po-2028:claudish"))
    assert first["exempt"] is True, "the documented exemption must not be labelled"

    cited = g.parse_prev(d.grain_tag("MED", "myia-po-2028:claudish",
                                     prev="LIGHT/docs #26943"))
    assert cited["present"] is True
    assert (cited["tier"], cited["genre"], cited["pr_number"]) == ("LIGHT", "docs", 26943)


# ---- creation plan addressing (vllm#486, measured on CoursIA#27106 rerun) ----

def test_an_unaddressed_creation_plan_names_every_problem_before_building():
    cells = [{"type": "markdown"}, {"idx": "bad"}, {"idx": 99},
             {"idx": 1}, {"idx": 1}]
    errors = d.creation_plan_addressing(cells, 3)
    assert len(errors) == 5, errors
    assert errors[0] == "position 0: missing/non-integer idx"
    assert errors[1] == "position 1: missing/non-integer idx"
    assert "outside 0..2" in errors[2]
    assert errors[3] == "position 4: duplicate idx 1"
    assert errors[4].startswith("coverage: 2 source cell(s) unaddressed")


def test_a_well_formed_but_incomplete_plan_is_refused():
    """CoursIA#27305 (23/11, Terra): 10 in-bounds, duplicate-free idx for a 36-cell
    source passed validation and the grain died stage2-empty-segment on a plan the
    model itself contested as truncated. Addressing is necessary, not sufficient:
    the plan must COVER the source, else the port ships truncated."""
    cells = [{"idx": i, "cell_type": "markdown"} for i in range(10)]
    errors = d.creation_plan_addressing(cells, 36)
    assert len(errors) == 1 and errors[0].startswith("coverage: 26 source cell(s)")
    assert "10, 11, 12" in errors[0]
    assert d.creation_plan_addressing(cells, 10) == []


def test_a_fully_addressed_creation_plan_is_accepted():
    cells = [{"idx": 0, "cell_type": "markdown"},
             {"idx": 1, "cell_type": "code"}, {"idx": 2, "cell_type": "markdown"}]
    assert d.creation_plan_addressing(cells, 3) == []


def test_an_empty_creation_plan_is_not_a_valid_noop():
    assert d.creation_plan_addressing([], 35) == ["cells is empty"]


def test_create_segments_refuses_before_any_model_call():
    """The regression is the CALL COUNT, not merely a nicer final verdict."""
    import asyncio
    from types import SimpleNamespace
    rec = {}
    args = SimpleNamespace(max_tokens=100)
    src = Path(d.__file__).read_text(encoding="utf-8")
    fn = src.split("async def create_segments", 1)[1].split("\ndef ", 1)[0]
    guard = fn.index("addressing_errors = creation_plan_addressing")
    ask = fn.index("async def ask_tranche")
    assert guard < ask, "an unaddressable plan can still pay for a build call"
    # No session needed: reaching a model call would fail on this sentinel.
    built = asyncio.run(d.create_segments(None, args, rec, None,
                                          [{"type": "markdown"}], 35, ""))
    assert built == {}
    assert rec["verdict"] == "stage1-unaddressable-creation-plan"
    assert rec["creation_plan_addressing_errors"]


def test_an_overrunning_plan_gets_one_bounded_repair_then_the_verdict(monkeypatch):
    """CoursIA#27580 (20/11): 24 plan entries for a 22-cell source (idx 22/23 outside).

    The re-ask is bounded to ONE turn, and a repair that still overruns never reaches
    the build path — the pin on the CALL COUNT is what keeps that true. The fake repair
    answers a DIFFERENT invalid plan (idx 1/21/40): a mutant that returns None from
    repair_creation_plan would leave errors_after == ["cells is empty"], so asserting
    the repaired plan's OWN defects is what makes that mutant red."""
    import asyncio
    from types import SimpleNamespace
    rec = {}
    args = SimpleNamespace(max_tokens=100)
    seen = []

    async def fake_call(session, args_, rec_, stage, prompt, conv, max_tokens=None):
        seen.append(stage)
        return {"response": '```json\n{"cells": [{"idx": 1}, {"idx": 21}, {"idx": 40}]}\n```',
                "conversation_id": "conv-1"}

    monkeypatch.setattr(d, "sk_call_retry", fake_call)
    plan_cells = [{"idx": 0}, {"idx": 22}]
    built = asyncio.run(d.create_segments(object(), args, rec, "conv-1",
                                          plan_cells, 22, ""))
    assert built == {}
    assert seen == ["1-plan-repair"], "exactly one repair turn, never a build call"
    assert rec["verdict"] == "stage1-unaddressable-creation-plan"
    assert rec["creation_plan_repair"]["kept"] is False
    after = rec["creation_plan_repair"]["errors_after"]
    assert any("idx 40" in e for e in after), f"the repaired plan's own defects: {after}"
    assert not any("idx 22" in e for e in after), "pre-repair errors must not be recycled"
    assert plan_cells == [{"idx": 0}, {"idx": 22}], "a failed repair changes nothing"


def test_a_repaired_plan_is_the_one_that_gets_built(monkeypatch):
    """A successful repair replaces the plan IN PLACE: the build loop must read the
    repaired cells, and rec['plan'] keeps the model's first answer as the trace."""
    import asyncio
    from types import SimpleNamespace

    class BuildReached(Exception):
        pass

    rec = {}
    args = SimpleNamespace(max_tokens=100)
    stages = []

    async def fake_call(session, args_, rec_, stage, prompt, conv, max_tokens=None):
        stages.append(stage)
        if stage.startswith("2-build"):
            raise BuildReached()
        # The repair must now be COMPLETE (#27305): a partially-repaired plan
        # (2 cells for a 22-cell source) is refused by the coverage rule, never
        # built. The model answers the coverage error with the full plan.
        cells = ", ".join(f'{{"idx": {i}}}' for i in range(22))
        return {"response": f'```json\n{{"cells": [{cells}]}}\n```',
                "conversation_id": "conv-1"}

    monkeypatch.setattr(d, "sk_call_retry", fake_call)
    plan_cells = [{"idx": 0}, {"idx": 22}]
    with pytest.raises(BuildReached):
        asyncio.run(d.create_segments(object(), args, rec, "conv-1", plan_cells, 22, ""))
    assert plan_cells == [{"idx": i} for i in range(22)]
    assert stages[0] == "1-plan-repair"
    assert stages[1].startswith("2-build"), "the build runs on the REPAIRED plan"


def test_the_repair_prompt_names_the_exact_source_range():
    prompt = d.creation_plan_repair_prompt(["position 22: idx 22 outside 0..21"], 22)
    assert "0..21" in prompt and "idx 22 outside" in prompt
    assert "une entrée par cellule source" in prompt


def test_an_empty_cell_assembly_never_reaches_apply_create():
    src = Path(d.__file__).read_text(encoding="utf-8")
    run = src.split("async def run(", 1)[1].split("\nasync def ", 1)[0]
    assert 'if not built or not built.get("cells"):' in run
    guard = run.index('if not built or not built.get("cells"):')
    applied = run.index("rec[\"apply\"] = apply_create", guard)
    assert guard < applied
# ---- creation kernel selection (vllm#484, measured on CoursIA#27106) ----

def test_creation_execution_uses_the_canonical_twin_kernelspec():
    """A C# target is absent, so its GameTheory path defaults to python3. The C# twin's
    metadata is the only source that names the deliverable's actual execution kernel.

    Wiring pin, deliberately: unit-testing series_kernel() alone would miss the real bug,
    which was the driver choosing it BEFORE reading create_metadata. The call-site order
    and assignment are what keep execution, repair, stripping and the PR trace coherent.
    """
    src = Path(d.__file__).read_text(encoding="utf-8")
    run = src.split("async def run(", 1)[1].split("\nasync def ", 1)[0]
    selection = run.split("kernel = series_kernel", 1)[1].split('rec["kernel"]', 1)[0]
    assert "if create_mode:" in selection
    assert "series_canonical_meta(wt_path, args.notebook)" in selection
    assert '(twin_meta.get("kernelspec") or {}).get("name")' in selection
    assert 'kernel["kernel_name"] = twin_kernel' in selection
    assert 'kernel["kernel_source"] = "canonical-twin-kernelspec"' in selection
    assignment = next(line for line in selection.splitlines()
                      if 'kernel["kernel_name"] = twin_kernel' in line)
    guard = next(line for line in selection.splitlines()
                 if "if twin_kernel:" in line)
    assert guard.endswith("if twin_kernel:"), "the twin selection is no longer reachable"
    assert selection.index(guard) < selection.index(assignment)


def test_creation_metadata_and_execution_read_the_same_twin():
    """Do not grow two independent metadata reads that could select different kernels."""
    src = Path(d.__file__).read_text(encoding="utf-8")
    run = src.split("async def run(", 1)[1].split("\nasync def ", 1)[0]
    assert run.count("series_canonical_meta(wt_path, args.notebook)") == 1, (
        "creation reads the twin twice; selection and delivered metadata can diverge")
    assert '\n                meta = series_canonical_meta(wt_path, args.notebook)' not in run
    assert ('rec["create_metadata"] = {"kernelspec": '
            '(twin_meta.get("kernelspec") or {}).get("name")') in run


def test_explicit_kernel_override_still_wins_at_every_execution_site():
    src = Path(d.__file__).read_text(encoding="utf-8")
    assert src.count('args.kernel_override or kernel["kernel_name"]') == 3
# ---- banner strip variant (vllm#482, measured on the #27104 verify) ----

def test_the_banner_strip_covers_the_discovery_bootstrap():
    """#27104: the probe-only strip reported ok while the committed cell-3 output
    still carried the DISCOVERY bootstrap (dotnet-interactive-this-cell) — the
    verify rejected it MAJOR. The deliverable is stripped --variant both; the
    probe-only calibration of #22728 binds the COMMITTED-corpus guard, never a
    fresh deliverable. Source pin: the wiring is a CLI argument list."""
    src = Path(d.__file__).read_text(encoding="utf-8")
    fn = src.split("def strip_dotnet_banner", 1)[1].split("\ndef ", 1)[0]
    assert '"--variant", "both"' in fn, \
        "the strip lost the discovery variant — a creation-mode notebook keeps its banner"


def test_stage5_commit_carries_its_own_identity(tmp_path, monkeypatch):
    """ms#1813 regression, upstreamed here after two re-copies dropped it from the
    sk-agent harness: a CI runner has NO user.name/user.email configured and the
    stage5 commit is the first commit of a fresh worktree — git dies "Author
    identity unknown" and the whole grain fails at the last step, after every
    token was spent.

    Hermetic: GIT_CONFIG_GLOBAL points at an EMPTY file and the system config is
    off, so the driver's own `-c` pairs are the only possible identity source. A
    mutant that drops them fails the commit and never reaches pr-created."""
    import os
    import subprocess
    from types import SimpleNamespace

    def sh(*cmd, cwd=None):
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=cwd)
        assert p.returncode == 0, (cmd, p.stderr)
        return p.stdout

    nb_rel = "Series/N-CSharp.ipynb"
    origin = tmp_path / "origin.git"
    origin.mkdir()
    sh("git", "init", "--bare", str(origin), cwd=origin)
    wt = tmp_path / "wt"
    wt.mkdir()
    sh("git", "init", cwd=wt)
    sh("git", "checkout", "-b", "main", cwd=wt)
    sh("git", "remote", "add", "origin", str(origin), cwd=wt)
    (wt / "README.md").write_text("x", encoding="utf-8")
    sh("git", "add", "README.md", cwd=wt)
    sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", cwd=wt)

    empty_cfg = tmp_path / "empty-gitconfig"
    empty_cfg.write_text("", encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(empty_cfg))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for var in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
                "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"):
        monkeypatch.delenv(var, raising=False)

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    built_nb = out_dir / "built.ipynb"
    built_nb.write_text("{}", encoding="utf-8")
    (wt / "Series").mkdir()

    args = SimpleNamespace(
        issue=27102, notebook=nb_rel, pr_branch="nbcoder/ident-27102", agent="producer",
        verifier_agent="critic", grain_tier="MED", lane="myia-po-2028:claudish",
        pr_base="main", pr_repo="jsboige/CoursIA", out_dir=str(out_dir))
    rec = {"plan": {"plan": []}, "verify": {"verdict": "approve", "model_used": "glm-5.3",
                                            "conversation_id": "v", "findings": []},
           "kernel": {"kernel_name": ".net-csharp"}, "execution": [1], "c2": {"sequential": True},
           "calls": [], "conversation_id": "p"}

    monkeypatch.setattr(d, "lane_predecessor",
                        lambda *a, **k: "MED/notebook-dotnet #27256")

    def fake_gh(argv, token=None, timeout=60):
        if argv[1].endswith("/pulls"):
            return 0, json.dumps({"number": 27998, "html_url": "pr-url"})
        return 0, "{}"
    monkeypatch.setattr(d, "gh", fake_gh)

    d.stage5_pr(args, rec, wt, built_nb, {"issue": 27102}, None)

    assert rec["verdict"] == "pr-created", rec.get("pr")
    author = sh("git", "-C", str(wt), "log", "-1", "--format=%an <%ae>")
    assert author.strip() == "nb-coder <nb-coder@nb-coder.invalid>"
    # <login>@users.noreply.github.com is attributed by GitHub to the REAL account
    # NB-Coder (id 54853046) — .invalid (RFC 2606) can never collide (vllm-a9).
    # All three commit attempts (primary + the pre-commit auto-fix retry + the
    # twin-parity reseal commit of the 21/11 repo integration) carry it: a
    # source pin, because the retry path only runs when a hook rewrites.
    src = Path(d.__file__).read_text(encoding="utf-8")
    fn = src.split("def stage5_pr", 1)[1].split("\ndef ", 1)[0]
    assert fn.count("*_GIT_IDENTITY") == 3, "a commit site lost its identity"


# ---- stage5 commit retry after a pre-commit auto-fixer (CoursIA #27113 + #27102) ----

def test_stage5_retries_add_commit_once_when_a_prefix_hook_rewrites_the_file(tmp_path):
    """Measured 2/2 on fresh .ipynb grains (w1f3 #27113, w1g #27102): a pre-commit
    auto-fixer hook rewrites the staged notebook and FAILS the first commit, leaving
    status `AM`; the single-shot driver recorded pr-git-failed and both grains had
    to be salvaged by hand (re-add + re-commit, hooks all-Pass on the replay).

    Behavioral pin on a REAL git repo with a simulated auto-fixer hook: the retry
    must (a) happen exactly once, (b) re-add the FIXED file — the committed content
    carries the hook's marker, which is what distinguishes a re-add from committing
    the stale index, (c) reach pr-created. A blocking hook (rewrites nothing) keeps
    failing on the replay — covered by the bounded single retry, asserted here by
    the absence of a second commit attempt after a clean non-AM failure path.
    """
    import os
    import subprocess
    from types import SimpleNamespace

    def sh(*cmd, cwd=None):
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=cwd)
        assert p.returncode == 0, (cmd, p.stderr)
        return p.stdout

    nb_rel = "Series/N-CSharp.ipynb"
    origin = tmp_path / "origin.git"
    origin.mkdir()
    sh("git", "init", "--bare", str(origin), cwd=origin)
    wt = tmp_path / "wt"
    wt.mkdir()
    sh("git", "init", cwd=wt)
    sh("git", "checkout", "-b", "main", cwd=wt)
    sh("git", "remote", "add", "origin", str(origin), cwd=wt)
    (wt / "README.md").write_text("x", encoding="utf-8")
    sh("git", "add", "README.md", cwd=wt)
    sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init", cwd=wt)
    # Simulated auto-fixer: rewrites the file on disk WITHOUT re-staging, exits 1
    # the first time only -- like the real CoursIA hooks, it passes on the replay
    # because the defect it fixes is already gone from the fixed file.
    hook = wt / ".git" / "hooks" / "pre-commit"
    nb_in_wt = wt / nb_rel
    hook.write_text(
        "#!/bin/sh\n"
        f'if ! grep -q autofix-marker -- "{nb_in_wt}"; then\n'
        f'  printf "autofix-marker\n" >> "{nb_in_wt}"\n'
        '  echo "auto-fixer rewrote the staged file" >&2\n'
        "  exit 1\n"
        "fi\n"
        "exit 0\n", encoding="utf-8", newline="\n")
    os.chmod(hook, 0o755)

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    built_nb = out_dir / "built.ipynb"
    built_nb.write_text("{}", encoding="utf-8")
    (wt / "Series").mkdir()

    args = SimpleNamespace(
        issue=27102, notebook=nb_rel, pr_branch="nbcoder/auto-27102", agent="producer",
        verifier_agent="critic", grain_tier="MED", lane="myia-po-2028:claudish",
        pr_base="main", pr_repo="jsboige/CoursIA", out_dir=str(out_dir))
    rec = {"plan": {"plan": []}, "verify": {"verdict": "approve", "model_used": "glm-5.3",
                                            "conversation_id": "v", "findings": []},
           "kernel": {"kernel_name": ".net-csharp"}, "execution": [1], "c2": {"sequential": True},
           "calls": [], "conversation_id": "p"}

    monkeypr = pytest.MonkeyPatch()
    monkeypr.setattr(d, "lane_predecessor",
                     lambda *a, **k: "MED/notebook-dotnet #27256")
    def fake_gh(argv, token=None, timeout=60):
        if argv[1].endswith("/pulls"):
            return 0, json.dumps({"number": 27999, "html_url": "pr-url"})
        return 0, "{}"
    monkeypr.setattr(d, "gh", fake_gh)
    try:
        d.stage5_pr(args, rec, wt, built_nb, {"issue": 27102}, None)
    finally:
        monkeypr.undo()

    assert rec["verdict"] == "pr-created", rec.get("pr")
    assert rec["pr"]["number"] == 27999
    assert rec["pr"].get("commit_retry") == "pre-commit-auto-fix-read"
    # The re-add staged the FIXED file: the committed blob carries the marker
    # (committing the stale index would land the pre-fix content).
    blob = sh("git", "-C", str(wt), "show", f"HEAD:{nb_rel}")
    assert "autofix-marker" in blob
    assert nb_in_wt.read_text(encoding="utf-8").endswith("autofix-marker\n")


# ---- stage5 push bounded and judged by the remote (CoursIA #28018, 22/11) ----

def _push_repo(tmp_path):
    import subprocess

    def sh(*cmd):
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        assert p.returncode == 0, (cmd, p.stderr)
        return p.stdout
    origin = tmp_path / "origin.git"
    sh("git", "init", "--bare", "-q", str(origin))
    wt = tmp_path / "wt"
    sh("git", "init", "-q", "-b", "main", str(wt))
    sh("git", "-C", str(wt), "remote", "add", "origin", str(origin))
    (wt / "a.txt").write_text("a", encoding="utf-8")
    sh("git", "-C", str(wt), "add", "a.txt")
    sh("git", "-C", str(wt), "-c", "user.email=t@t", "-c", "user.name=t",
       "commit", "-q", "-m", "a")
    return wt, sh


def test_push_timeout_is_a_recorded_failure_not_a_crash(tmp_path, monkeypatch):
    """#28018: an LFS pre-push hook outlived the 300 s timer and the uncaught
    TimeoutExpired crashed an approved grain. A push killed before it lands is
    now `rc != 0` with a reason stage 5 records as pr-push-failed."""
    import subprocess
    wt, _ = _push_repo(tmp_path)
    real = d._git

    def slow_push(w, *a, timeout=300):
        if a[:1] == ("push",):
            raise subprocess.TimeoutExpired(["git", *a], timeout)
        return real(w, *a, timeout=timeout)
    monkeypatch.setattr(d, "_git", slow_push)
    rc, out = d._push_branch(wt, "main", timeout=5)
    assert rc != 0 and "timed out after 5 s" in out and "not at HEAD" in out


def test_push_timeout_after_the_branch_landed_goes_on(tmp_path, monkeypatch):
    """The hook is the slow part, not the transfer: when origin's branch already
    points at HEAD, a timed-out push landed and stage 5 must create the PR."""
    import subprocess
    wt, sh = _push_repo(tmp_path)
    sh("git", "-C", str(wt), "push", "-q", "origin", "main")   # it did land
    real = d._git

    def slow_push(w, *a, timeout=300):
        if a[:1] == ("push",):
            raise subprocess.TimeoutExpired(["git", *a], timeout)
        return real(w, *a, timeout=timeout)
    monkeypatch.setattr(d, "_git", slow_push)
    rc, out = d._push_branch(wt, "main", timeout=5)
    assert rc == 0 and "is at HEAD" in out


def test_push_runs_for_real_without_a_timeout(tmp_path):
    wt, sh = _push_repo(tmp_path)
    rc, _ = d._push_branch(wt, "main")
    assert rc == 0
    head = sh("git", "-C", str(wt), "rev-parse", "HEAD").strip()
    assert sh("git", "-C", str(wt), "ls-remote", "origin", "refs/heads/main").split()[0] == head


# ---- executed kernel published at delivery (CoursIA #28332, 24/11) ----

def test_the_published_kernel_prefers_the_execution_record_to_carried_metadata():
    """The resume carried the C# donor's kernel but started Rust. The aligned
    metadata is a fallback for an old trace, never a replacement for the measured
    execution request; a value merely read is labeled as such."""
    from types import SimpleNamespace

    rec = {"kernel": {"kernel_name": ".net-csharp"},
           "kernelspec_align": {"from": ".net-csharp", "to": "rust"},
           "executed_kernel": {"name": "rust", "source": "manage_kernel-start"}}
    args = SimpleNamespace(kernel_override=None)
    assert d.published_execution_kernel(args, rec) == ("rust", "")
    del rec["executed_kernel"]
    name, note = d.published_execution_kernel(args, rec)
    assert name == "rust" and "noyau lu" in note and "non enregistré" in note
    rec["executed_kernel"] = {"name": ".net-csharp"}
    assert d.published_execution_kernel(args, rec) == (".net-csharp", "")
    args.kernel_override = "rust"
    del rec["kernelspec_align"]
    del rec["executed_kernel"]
    name, note = d.published_execution_kernel(args, rec)
    assert name == "rust" and "--kernel-override" in note


def _stage5_kernel_delivery(tmp_path, monkeypatch, rec, create_mode=None):
    """Real branch, real commit, real push to a bare origin; gh and the repo
    integration are fakes that return what the caller wants to read back."""
    from types import SimpleNamespace

    wt, sh = _push_repo(tmp_path)
    nb_rel = "Series/Planners-05c-Rust.ipynb"
    (wt / "Series").mkdir()
    built = tmp_path / "built.ipynb"
    built.write_text("{}", encoding="utf-8")
    args = SimpleNamespace(
        issue=27947, notebook=nb_rel, pr_branch="nbcoder/kernel-27947", agent="producer",
        verifier_agent="critic", grain_tier="MED", lane="myia-po-2028:claudish",
        pr_base="main", pr_repo="jsboige/CoursIA", out_dir=str(tmp_path),
        kernel_override=None)
    sent = {"facts": None}
    monkeypatch.setattr(d, "lane_predecessor", lambda *a: None)

    def fake_gh(argv, token=None, timeout=60):
        if argv[1].endswith("/pulls"):
            body_arg = next(a for a in argv if a.startswith("body=@"))
            sent["body"] = Path(body_arg[6:]).read_text(encoding="utf-8")
            return 0, json.dumps({"number": 28332, "html_url": "pr-url"})
        return 0, "{}"

    monkeypatch.setattr(d, "gh", fake_gh)
    if create_mode is not None:
        rec["create_mode"] = {"source": "Series/Planners-05c-Python.ipynb",
                              "target": nb_rel}
        # keyword-tolerant: stage5_pr measures the drift with rebase/base_rev/old_blob (#1885)
        monkeypatch.setattr(d, "stage5_source_drift", lambda *a, **k: {"drift": "none"})

        def register_pair(w, s, n, lane, facts=None):
            sent["facts"] = facts
            return {"registered": False}

        monkeypatch.setattr(d, "_load_integrate_module", lambda: SimpleNamespace(
            integrate=lambda *a, **k: {"touched": [], "nav": {}, "readme": {}, "pair": None},
            register_pair=register_pair,
            find_twin_pair=lambda *a: None, replay_guards=lambda *a: []))
    d.stage5_pr(args, rec, wt, built, {"issue": 27947}, None)
    assert rec["verdict"] == "pr-created", rec.get("pr")
    sent["commit"] = sh("git", "-C", str(wt), "log", "-1", "--format=%B")
    return sent


_STALE_KERNEL_TRACE = {
    "plan": {"plan": []},
    "verify": {"verdict": "approve", "model_used": "terra", "findings": []},
    # the C# twin lent its metadata; that is what stage 5 used to publish
    "kernel": {"kernel_name": ".net-csharp", "kernel_source": "meta-from-kernelspec"},
    "kernelspec_align": {"from": ".net-csharp", "to": "rust"},
    "execution": [{"cell": i, "ok": True} for i in range(11)],
    "c2": {"sequential": True}, "calls": [], "conversation_id": "p"}


@pytest.mark.parametrize("carried, expected, note", [
    # the trace as this fix writes it: the start was recorded, nothing is read
    ({"executed_kernel": {"name": "rust", "source": "manage_kernel-start"}}, "rust", ""),
    # a trace written before the record existed: the alignment is read, and says so
    ({}, "rust", " (noyau lu : alignement kernelspec, exécution non enregistrée)"),
])
def test_stage5_body_and_commit_name_the_kernel_that_executed(
        tmp_path, monkeypatch, carried, expected, note):
    """Measured #28332 shape: inherited .net-csharp, real rust execution. Capture the
    body passed to gh (the driver unlinks its scratch file) and the real commit
    message, so neither public execution claim can regress independently."""
    sent = _stage5_kernel_delivery(tmp_path, monkeypatch,
                                   {**_STALE_KERNEL_TRACE, **carried})
    assert f"execute_on_kernel, kernel `{expected}`{note})" in sent["body"]
    assert ".net-csharp" not in sent["body"]
    assert f"Exécution : kernel {expected}{note}," in sent["commit"]
    assert ".net-csharp" not in sent["commit"]


def test_the_pair_registration_fact_names_the_executed_kernel(tmp_path, monkeypatch):
    """The twin registry states `Execution reelle sur kernel <name>`: the same
    stale field fed it. Only the name goes there (its line is ASCII, unaccented)."""
    sent = _stage5_kernel_delivery(
        tmp_path, monkeypatch,
        {**_STALE_KERNEL_TRACE,
         "executed_kernel": {"name": "rust", "source": "manage_kernel-start"}},
        create_mode=True)
    assert sent["facts"] == {"kernel": "rust", "kernel_read": False,
                             "executed_cells": 11, "verdict": "approve"}


def test_the_pair_registration_fact_marks_a_read_kernel(tmp_path, monkeypatch):
    """An old trace with no execution record: the registry must not print
    `Execution reelle` for a name that was only READ."""
    sent = _stage5_kernel_delivery(tmp_path, monkeypatch, dict(_STALE_KERNEL_TRACE),
                                   create_mode=True)
    assert sent["facts"]["kernel"] == "rust" and sent["facts"]["kernel_read"] is True


def test_a_stale_metadata_name_never_feeds_a_published_execution_fact():
    """The #28332 wiring, pinned against reintroduction: stage 5 never reads
    rec["kernel"] straight (the registry fact, the commit and the PR body are
    covered behaviorally above) and resolves the kernel exactly once."""
    src = Path(d.__file__).read_text(encoding="utf-8")
    fn = src.split("def stage5_pr(", 1)[1].split("\n# ", 1)[0]
    assert 'rec.get("kernel")' not in fn
    assert "rec.get('kernel'" not in fn
    assert fn.count("published_execution_kernel(args, rec)") == 1
    for published in ('facts = {"kernel": executed_as,',
                      "{executed_as}{kernel_note}, ", "`{executed_as}`{kernel_note})"):
        assert published in fn, published


def test_the_first_run_records_the_kernel_it_executed_on():
    """run() opens real MCP sessions and has no offline end-to-end harness: the
    recording site is pinned where it stands -- after the execution verdict, on the
    very name every execution site of run() uses. A start alone must not record."""
    src = Path(d.__file__).read_text(encoding="utf-8")
    run = src.split("async def run(", 1)[1]
    assert "execution_verdict(rec, scratch)\n" in run
    verdict = run.index("execution_verdict(rec, scratch)")
    record = run.index("note_execution_kernel(rec, kname_used)")
    assert verdict < record < run.index("gates_then_verify(args, rec, src_nb, built_path")
    assert run.index('kid = await start_kernel(pm, args.kernel_override') < verdict, \
        "recording at the start would claim an execution before the cells ran"
    # the existing guard on the three override-aware execution sites still holds
    assert src.count('args.kernel_override or kernel["kernel_name"]') == 3


def test_a_kernel_start_alone_is_not_an_execution_measurement():
    """exec mode `none` starts a kernel and runs no cell; a repair restart that
    returns none clears rec["kernel_id"] while cells of the round never ran."""
    for rec in ({"kernel_id": "k1", "execution": []},      # nothing executed
                {"kernel_id": None, "execution": [{"cell": 0, "ok": True}]},  # dead restart
                {"kernel_id": "k1"},                       # crashed before execution
                {}):
        d.note_execution_kernel(rec, "rust")
        assert "executed_kernel" not in rec, rec
    ran = {"kernel_id": "k1", "execution": [{"cell": 0, "ok": False}]}
    d.note_execution_kernel(ran, "rust")
    assert ran["executed_kernel"]["name"] == "rust"     # a failed cell still RAN
    assert ran["executed_kernel"]["kernel_id"] == "k1"
