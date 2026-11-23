# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_verify.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Regression pins for the per-cell outputs fingerprint (vllm#440, merged in #445).

The gate that rejected a correct deliverable was the INSTRUMENT, not the notebook: the
old `outputs_digest` hashed the raw outputs list, so a stream payload re-chunked by the
kernel (['a','b'] vs ['ab']) read as a content change. A verifier told "same sha =
untouched" then rejected an unedited cell. Measured on the 26789 pair (po-2028, 16/11):
the old digest flagged cells 14, 20 and 22 — 20 was purely a buffer split.

These pins also FIX the deliberate design choice of #445: the signed zero is NOT
normalised in the instrument. `+0.000000` and `-0.000000` stay different on purpose —
both texts are handed to the verifier so it can arbitrate, rather than being masked by
a normaliser. `test_signed_zero_is_deliberately_not_normalised` exists so nobody
"fixes" that silently.

Skipped when `mcp` is not importable (the module imports the MCP client at load).
"""
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_verify as v  # noqa: E402


def _nb(tmp_path: Path, cells: list, name: str) -> Path:
    p = tmp_path / name
    p.write_text(json.dumps({"cells": cells, "nbformat": 4, "nbformat_minor": 5}), encoding="utf-8")
    return p


def _code(outputs: list, source: str = "x") -> dict:
    return {"cell_type": "code", "source": source, "outputs": outputs, "metadata": {},
            "execution_count": 1}


def _stream(text, name: str = "stdout") -> dict:
    return {"output_type": "stream", "name": name, "text": text}


# --------------------------------------------------------------- digest


def test_stream_chunking_is_not_a_change(tmp_path):
    """A stdout payload split differently by the kernel is the same text (cell 20 of 26789)."""
    a = _nb(tmp_path, [_code([_stream("abc\ndef\n")])], "a.ipynb")
    b = _nb(tmp_path, [_code([_stream("abc\ndef\n")])], "b.ipynb")
    b_cells = json.loads(b.read_text(encoding="utf-8"))
    b_cells["cells"][0]["outputs"] = [_stream("ab"), _stream("c\nde"), _stream("f\n")]
    b.write_text(json.dumps(b_cells), encoding="utf-8")
    da, db = v.outputs_digest(a)[0], v.outputs_digest(b)[0]
    assert da["sha"] == db["sha"], "the fingerprint must not move on a buffer boundary"
    assert da["bytes"] == db["bytes"]
    # `n` is the RAW block count, kept for information only — it legitimately differs, and
    # nothing may key a verdict on it (the sha is the fingerprint).
    assert (da["n"], db["n"]) == (1, 3)


def test_a_real_change_is_still_seen(tmp_path):
    """The fingerprint must never be constant."""
    a = _nb(tmp_path, [_code([_stream("value 0.100000\n")])], "a.ipynb")
    b = _nb(tmp_path, [_code([_stream("value 0.200000\n")])], "b.ipynb")
    assert v.outputs_digest(a) != v.outputs_digest(b)


def test_signed_zero_is_deliberately_not_normalised(tmp_path):
    """DECISION PIN (#445 comment: "ca se decide, ca ne se glisse pas").

    numpy prints +0.0 or -0.0 depending on the rounding path. The instrument keeps them
    DIFFERENT on purpose: the verifier receives both texts and arbitrates. If someone
    later normalises it, this test must fail so the choice is re-argued, not slipped in.
    """
    a = _nb(tmp_path, [_code([_stream("x  +0.000000\n")])], "a.ipynb")
    b = _nb(tmp_path, [_code([_stream("x  -0.000000\n")])], "b.ipynb")
    assert v.outputs_digest(a) != v.outputs_digest(b)


def test_digest_row_shape_is_stable(tmp_path):
    """The prompt annex and any consumer key on these four fields."""
    nb = _nb(tmp_path, [_code([_stream("a\n")])], "a.ipynb")
    row = v.outputs_digest(nb)[0]
    assert set(row) == {"cell", "n", "types", "bytes", "sha"}
    assert row["types"] == ["stream"]


# --------------------------------------------------------------- cell_diffs


def test_edited_cell_is_labelled_edited(tmp_path):
    """Cell 22 of 26789: the issue asked for the edit, so its output MUST change."""
    a = _nb(tmp_path, [_code([_stream("old\n")], source="print(1)")], "a.ipynb")
    b = _nb(tmp_path, [_code([_stream("new\n")], source="print(2)")], "b.ipynb")
    d = v.cell_diffs(a, b)
    assert [x["kind"] for x in d] == ["edited"]


def test_unchanged_code_with_changed_output_is_labelled_outputs_changed(tmp_path):
    """Cell 2 of 26820: same code, only `python 3.13.15` -> `3.13.16`. The verifier must
    see the text to judge it as an interpreter drift, not as an alteration."""
    a = _nb(tmp_path, [_code([_stream("python     : 3.13.15\n")], source="import sys")], "a.ipynb")
    b = _nb(tmp_path, [_code([_stream("python     : 3.13.16\n")], source="import sys")], "b.ipynb")
    d = v.cell_diffs(a, b)
    assert [x["kind"] for x in d] == ["outputs-changed"]
    assert "3.13.15" in d[0]["src_text"] and "3.13.16" in d[0]["built_text"]


def test_identical_cells_produce_no_diff(tmp_path):
    a = _nb(tmp_path, [_code([_stream("same\n")])], "a.ipynb")
    b = _nb(tmp_path, [_code([_stream("sa"), _stream("me\n")])], "b.ipynb")
    assert v.cell_diffs(a, b) == []


def test_added_and_removed_cells_are_labelled(tmp_path):
    keep = _code([_stream("k\n")])
    extra = _code([_stream("e\n")])
    a = _nb(tmp_path, [keep], "a.ipynb")
    b = _nb(tmp_path, [keep, extra], "b.ipynb")
    assert [x["kind"] for x in v.cell_diffs(a, b)] == ["added"]
    assert [x["kind"] for x in v.cell_diffs(b, a)] == ["removed"]


def test_diff_text_is_bounded(tmp_path):
    """A divergent cell must not inflate the verifier prompt without limit."""
    big = "x" * 5000
    a = _nb(tmp_path, [_code([_stream(big)])], "a.ipynb")
    b = _nb(tmp_path, [_code([_stream(big[:-1] + "y")])], "b.ipynb")
    d = v.cell_diffs(a, b)
    assert all(len(x["src_text"]) <= v.CELL_TEXT_CAP + 1 for x in d)
    assert all(len(x["built_text"]) <= v.CELL_TEXT_CAP + 1 for x in d)


def test_verify_output_budget_default_is_32768():
    """The default verifier (critic = GLM-5.3, thinking on) burns a small output
    budget entirely on reasoning and returns HTTP 200 with ZERO content — measured
    16/11 (vllm#446): 4 096 and 16 000 both die as error:unparsable, 32 000 renders
    the verdict. Re-confirmed 17/11 on the #27104 blank creation pass: the driver
    passes NO --max-tokens, so the CLI default IS the verify budget. This pin keeps
    it from sliding back to an unusable value in silence. (Pinned on the source line:
    argparse 3.13 prints no int defaults in --help, so the CLI surface can't show it.)"""
    src = (Path(__file__).parent / "nb_coder_verify.py").read_text(encoding="utf-8")
    line = [l for l in src.splitlines() if '"--max-tokens"' in l]
    assert len(line) == 1 and "default=32768" in line[0]


def test_empty_response_gets_one_retry():
    """18/11 wave-1c: critic (GLM-5.3) returned 200-empty TWICE (308 s and 609 s) at
    the 32 768 budget — cloud-side empties, not the token-budget case. The verifier
    must retry ONCE with the shorter-reasoning note before settling on
    error:unparsable; a retry that answers replaces the empty envelope."""
    src = (Path(__file__).parent / "nb_coder_verify.py").read_text(encoding="utf-8")
    assert "verify_retry" in src, "the retry marker must be recorded for the trace"
    assert src.count("asyncio.run(call_verifier(") == 2, \
        "exactly two call sites: first attempt + one empty-response retry"
    assert "RETRY_NOTE" in src, "the retry re-asks with the shorter-reasoning note"


# ------------------------------------------------- scope + binary payloads (pilot 16/11)


def test_image_swap_changes_the_digest(tmp_path):
    """Finding 26858 c.17: a display_data image is part of the output's content. Two
    notebooks whose text output is identical but whose PNG differs must NOT share a
    fingerprint — before the fix the image was invisible to every digest."""
    def png(data):
        return [{"output_type": "display_data",
                 "data": {"image/png": data, "text/plain": "<Figure>"}}]
    a = _nb(tmp_path, [_code(png("AAAA"))], "a.ipynb")
    b = _nb(tmp_path, [_code(png("BBBB"))], "b.ipynb")
    da, db = v.outputs_digest(a)[0], v.outputs_digest(b)[0]
    assert da["sha"] != db["sha"], "a swapped image must move the fingerprint"
    c = _nb(tmp_path, [_code(png("AAAA"))], "c.ipynb")
    assert v.outputs_digest(c)[0]["sha"] == da["sha"]


def test_prompt_scopes_the_verdict_to_the_deliverable():
    """4/4 rejects measured on the pilot grains (16/11) were rejecting on facts the
    verifier cannot observe: chain procedure (claims, MCP, coordinator approval) and
    convention defects PRE-EXISTING in the source. The prompt must fence those out, or
    no honest deliverable can ever pass and the verifier measures nothing."""
    issue = {"title": "t", "body": "b"}
    p = v.verify_prompt(issue, "SRC", "BUILT", {}, "", [], [], [])
    assert "Périmètre" in p
    assert "ne rejette jamais pour ce motif" in p
    assert "déjà présent à l'identique dans la SOURCE" in p
    assert "PAR LE LIVRABLE" in p


def test_prompt_fences_out_pr_stage_repo_artifacts():
    """CoursIA#27440 (23/11): eight verify-rejects round after round on criteria the
    ISSUE body lists but the HARNESS only satisfies at PR stage -- twin_pairs.d
    registration with its first attestation, the twin's CATALOG-STATUS block. The
    reseal runs after the integration commit, i.e. after the verifier's own verdict,
    so no revision can ever clear those findings ("nothing-applied" rounds). The
    prompt must fence those artifacts out like chain procedure, or every port on an
    issue carrying them oscillates to death."""
    issue = {"title": "t", "body": "b"}
    p = v.verify_prompt(issue, "SRC", "BUILT", {}, "", [], [], [])
    assert "artefacts d'intégration du dépôt" in p
    assert "twin_pairs.d/" in p
    assert "CATALOG-STATUS" in p
    assert "APRÈS ton verdict" in p
    # 23/11: the fence named the pair registration but not the two edits
    # nb_coder_integrate also writes at stage PR — the inbound nav edge on the
    # source twin and the folder's README row. Three port grains (28206, 28211,
    # 28213) rejected round after round on "Le lien entrant [Version C#] est
    # absent du carnet Python de référence", i.e. on a criterion the harness
    # satisfies after the verdict; #28225 proves the integration writes it.
    assert "arête de navigation entrante" in p
    assert "Version C#" in p
    assert "README" in p
    assert "satisfait par le harnais" in p


def test_prompt_does_not_demand_a_solved_exercise_and_judges_parity_against_the_twin():
    """CoursIA#28208 (23/11): the verifier rejected EIGHT revision rounds on a single
    major -- « la bisection sur les verdicts mesurés ne localise pas le mur w=l à
    ±0,01 ». Measured on the source: no executed bisection exists. Cell 18 is a
    five-row table of measured regimes, and cell 25 is « Exercice 3 -- bisection sur
    w » with `mur_exo3 = None  # TODO etudiant` printing « Exercice a completer ».
    The verifier was therefore demanding the resolution of a student exercise, and it
    compared a MEASURED finite-horizon detector threshold to the ANALYTIC wall. Both
    shapes are unsatisfiable by construction, so the prompt must fence them out."""
    issue = {"title": "t", "body": "b"}
    p = v.verify_prompt(issue, "SRC", "BUILT", {}, "", [], [], [])
    assert "exercice que la SOURCE laisse en TODO" in p
    assert "TODO etudiant" in p
    assert "stub compilable est le port" in p
    assert "ne demande pas " in p and "de résoudre l'exercice" in p
    assert "MESURÉE" in p and "seuil théorique" in p
    assert "Juge la parité contre le jumeau" in p


def test_prompt_does_not_invent_a_no_hints_exercise_criterion():
    """CoursIA#28208 (23/11), third rejection round: with the two fences above in place,
    the verifier rejected again on a phrase it fabricated itself -- the acceptance
    criteria demanded the port of a notebook « sans solution ni indice », a formula
    absent from the issue, from the conventions and from the source. The source's
    exercise cells carry step-by-step guidance comments and `indice :` lines, which
    the conventions explicitly allow (only the SOLVED result is banned), so demanding
    their removal makes a faithful port impossible and the grain oscillates. The prompt
    must name the fabricated criterion and what a faithful stub keeps."""
    issue = {"title": "t", "body": "b"}
    p = v.verify_prompt(issue, "SRC", "BUILT", {}, "", [], [], [])
    assert "commentaires de guidage" in p
    assert "reste le port FIDÈLE" in p
    assert "solution ou le " in p and "résultat révélé" in p
    assert "sans solution ni indice" in p
    assert "N'invente pas un critère plus strict" in p


# ------------------------------------------------- call errors reach the trace (21/11)


def _run_main(monkeypatch, tmp_path, envs):
    """Run v.main() with the GitHub fetch and the sk-agent call faked; `envs` are the
    successive envelopes call_verifier returns. Returns (rc, trace dict)."""
    src = _nb(tmp_path, [_code([_stream("a\n")])], "src.ipynb")
    built = _nb(tmp_path, [_code([_stream("b\n")])], "built.ipynb")
    monkeypatch.setattr(v.nbcd, "app_token", lambda _p: None)
    monkeypatch.setattr(v.nbcd, "fetch_issue",
                        lambda *a, **k: {"title": "t", "body": "b", "comments": ""})
    calls = iter(envs)

    async def fake_call(args, prompt):
        return next(calls), 1.0

    monkeypatch.setattr(v, "call_verifier", fake_call)
    out = tmp_path / "out"
    monkeypatch.setattr(sys, "argv", ["nb_coder_verify.py", "--issue", "7", "--source-nb",
                                      str(src), "--built-nb", str(built), "--out-dir",
                                      str(out)])
    rc = v.main()
    return rc, json.loads((out / "verify-7.json").read_text(encoding="utf-8"))


def test_call_error_names_the_verdict_and_is_kept(monkeypatch, tmp_path):
    """21/11 MGS-25: the critic call died at 610 s with no response and the trace said
    only `error:unparsable` -- sk-agent's error text was dropped. A failed call must
    name itself in the verdict and keep its error, never pass for an unreadable answer."""
    err = "call_agent: APITimeoutError('Request timed out.')"
    rc, t = _run_main(monkeypatch, tmp_path, [{"error": err}])
    assert rc == 2
    assert t["verdict"].startswith("error:call-failed: ") and "APITimeoutError" in t["verdict"]
    assert t["call_error"] == err
    assert "verify_retry" not in t, "an error envelope is not the cloud-empty case"


def test_cloud_empty_keeps_unparsable_after_its_retry(monkeypatch, tmp_path):
    """A 200 with zero content and no error is still the 18/11 cloud-empty case: one
    retry, then error:unparsable, with no invented call_error."""
    rc, t = _run_main(monkeypatch, tmp_path, [{"response": ""}, {"response": ""}])
    assert rc == 2 and t["verdict"] == "error:unparsable"
    assert t["verify_retry"] == "empty-response" and "call_error" not in t


def test_answer_without_verdict_stays_unparsable(monkeypatch, tmp_path):
    """Text came back but carries no verdict: that is unparsable, not a call failure."""
    rc, t = _run_main(monkeypatch, tmp_path, [{"response": "no json here"}])
    assert rc == 2 and t["verdict"] == "error:unparsable" and "call_error" not in t


# ------------------------------------------------- budget-cut answer gets one retry (21/11)

def _run_main_prompts(monkeypatch, tmp_path, envs):
    """Like _run_main, but also returns the prompts each call received."""
    prompts = []
    calls = iter(envs)

    async def fake_call(args, prompt):
        prompts.append(prompt)
        return next(calls), 1.0

    src = _nb(tmp_path, [_code([_stream("a\n")])], "src.ipynb")
    built = _nb(tmp_path, [_code([_stream("b\n")])], "built.ipynb")
    monkeypatch.setattr(v.nbcd, "app_token", lambda _p: None)
    monkeypatch.setattr(v.nbcd, "fetch_issue",
                        lambda *a, **k: {"title": "t", "body": "b", "comments": ""})
    monkeypatch.setattr(v, "call_verifier", fake_call)
    out = tmp_path / "out"
    monkeypatch.setattr(sys, "argv", ["nb_coder_verify.py", "--issue", "7", "--source-nb",
                                      str(src), "--built-nb", str(built), "--out-dir",
                                      str(out)])
    rc = v.main()
    return rc, json.loads((out / "verify-7.json").read_text(encoding="utf-8")), prompts


_CUT = {"response": '```json\n{"verdict": "reject", "findings": [{"cell": 9, "detail": "Sor',
        "usage": {"prompt_tokens": 28795, "completion_tokens": 32768}}


def test_budget_cut_answer_is_retried_with_the_short_note(monkeypatch, tmp_path):
    """21/11 CoursIA#27848: completion_tokens == 32 768 and the JSON stops mid-findings.
    One retry with the truncation note; a retry that answers is the verdict."""
    ok = {"response": '```json\n{"verdict": "approve", "findings": []}\n```',
          "usage": {"prompt_tokens": 28795, "completion_tokens": 9000}}
    rc, t, prompts = _run_main_prompts(monkeypatch, tmp_path, [_CUT, ok])
    assert rc == 0 and t["verdict"] == "approve"
    assert t["verify_retry"] == "truncated"
    assert len(prompts) == 2 and prompts[1].endswith(v.TRUNCATED_NOTE)
    assert v.TRUNCATED_NOTE not in prompts[0]


def test_budget_cut_twice_names_the_verdict(monkeypatch, tmp_path):
    rc, t, prompts = _run_main_prompts(monkeypatch, tmp_path, [_CUT, _CUT])
    assert rc == 2 and t["verdict"] == "error:truncated" and len(prompts) == 2


def test_full_budget_with_a_readable_verdict_is_not_retried(monkeypatch, tmp_path):
    """Reaching the budget is not a defect when the verdict came through whole."""
    full = {"response": '```json\n{"verdict": "reject", "findings": []}\n```',
            "usage": {"prompt_tokens": 1, "completion_tokens": 32768}}
    rc, t, prompts = _run_main_prompts(monkeypatch, tmp_path, [full])
    assert rc == 1 and t["verdict"] == "reject" and "verify_retry" not in t
    assert len(prompts) == 1


def test_unparsable_under_budget_is_not_a_truncation(monkeypatch, tmp_path):
    """No usage, or usage below the budget: unreadable text stays error:unparsable."""
    short = {"response": "no json here", "usage": {"completion_tokens": 120}}
    rc, t, prompts = _run_main_prompts(monkeypatch, tmp_path, [short])
    assert rc == 2 and t["verdict"] == "error:unparsable" and len(prompts) == 1


# ------------------------------------- sk-agent's "empty model response" error (22/11)

_EMPTY_ERR = "empty model response — agent.invoke produced no output"


def test_empty_model_response_error_at_budget_is_retried_short(monkeypatch, tmp_path):
    """22/11 CoursIA#27893: sk-agent returns the empty answer as an ERROR envelope with
    completion_tokens at the budget (the critic thought until the cap). One retry with
    the truncation note; an answer on the retry is the verdict."""
    cut = {"error": _EMPTY_ERR, "usage": {"prompt_tokens": 48097, "completion_tokens": 32768}}
    ok = {"response": '```json\n{"verdict": "approve", "findings": []}\n```',
          "usage": {"prompt_tokens": 48097, "completion_tokens": 7000}}
    rc, t, prompts = _run_main_prompts(monkeypatch, tmp_path, [cut, ok])
    assert rc == 0 and t["verdict"] == "approve"
    assert t["verify_retry"] == "truncated"
    assert len(prompts) == 2 and prompts[1].endswith(v.TRUNCATED_NOTE)


def test_empty_model_response_error_without_usage_gets_the_empty_note(monkeypatch, tmp_path):
    """#27780/#27781: same error, zero usage -- the cloud-empty case, RETRY_NOTE."""
    empty = {"error": _EMPTY_ERR, "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
    ok = {"response": '```json\n{"verdict": "reject", "findings": []}\n```'}
    rc, t, prompts = _run_main_prompts(monkeypatch, tmp_path, [empty, ok])
    assert rc == 1 and t["verdict"] == "reject"
    assert t["verify_retry"] == "empty-response"
    assert prompts[1].endswith(v.nbcd.RETRY_NOTE)


def test_empty_model_response_twice_still_names_the_call_failure(monkeypatch, tmp_path):
    empty = {"error": _EMPTY_ERR}
    rc, t, prompts = _run_main_prompts(monkeypatch, tmp_path, [empty, empty])
    assert rc == 2 and len(prompts) == 2
    assert t["verdict"].startswith("error:call-failed: empty model response")
