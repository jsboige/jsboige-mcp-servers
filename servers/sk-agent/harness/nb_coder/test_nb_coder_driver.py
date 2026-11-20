# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 8c0e0230e37e1543dcdaf3f0a00f5de8857273e7
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_driver.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
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
    assert len(errors) == 4, errors
    assert errors[0] == "position 0: missing/non-integer idx"
    assert errors[1] == "position 1: missing/non-integer idx"
    assert "outside 0..2" in errors[2]
    assert errors[3] == "position 4: duplicate idx 1"


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
    ms#1816 review: the kernel selection now lives in the PURE resolve_creation_meta seam
    (pinned behaviourally in test_nb_coder_create.py); run() must call it BEFORE the
    capacity gate and adopt BOTH the kernel and the twin metadata it resolved.
    """
    src = Path(d.__file__).read_text(encoding="utf-8")
    run = src.split("async def run(", 1)[1].split("\nasync def ", 1)[0]
    selection = run.split("kernel = series_kernel", 1)[1].split("gate = gate_call(", 1)[0]
    assert "if create_mode:" in selection
    assert "resolve_creation_meta(wt_path, args.notebook" in selection
    assert 'if "verdict" in resolved:' in selection, \
        "the refusal must return BEFORE the capacity gate and any token"
    assert 'kernel = resolved["kernel"]' in selection
    assert 'twin_meta = resolved["twin_meta"]' in selection, \
        "the skeleton must inherit the SAME metadata the resolver selected"
    resolver = src.split("def resolve_creation_meta(", 1)[1].split("\nasync def ", 1)[0]
    assert "series_canonical_meta(wt_path, notebook_rel)" in resolver
    assert 'kernel["kernel_name"] = twin_kernel' in resolver
    guard = next(line for line in resolver.splitlines()
                 if "if twin_kernel:" in line)
    assignment = next(line for line in resolver.splitlines()
                      if 'kernel["kernel_name"] = twin_kernel' in line)
    assert guard.strip().endswith("if twin_kernel:"), "the twin selection is no longer reachable"
    assert resolver.index(guard) < resolver.index(assignment)
    # refuse-before-gate: the resolver call sits before gate_call in run()'s flow
    assert run.index("resolve_creation_meta(") < run.index("gate_call(")


def test_creation_metadata_and_execution_read_the_same_twin():
    """Do not grow two independent metadata reads that could select different kernels.
    The single read lives inside the resolver; run() adopts its twin_meta and the
    skeleton build consumes exactly that dict."""
    src = Path(d.__file__).read_text(encoding="utf-8")
    run = src.split("async def run(", 1)[1].split("\nasync def ", 1)[0]
    resolver = src.split("def resolve_creation_meta(", 1)[1].split("\nasync def ", 1)[0]
    assert resolver.count("series_canonical_meta(wt_path, notebook_rel)") == 1, (
        "creation reads the twin twice; selection and delivered metadata can diverge")
    assert "series_canonical_meta(" not in run, (
        "run() must not re-read the twin outside the resolver")
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
