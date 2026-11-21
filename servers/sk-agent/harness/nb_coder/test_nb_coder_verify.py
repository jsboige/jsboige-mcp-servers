# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7416ac16c91e150aae5a75dd251d0c1a4c2f5c2c
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_verify.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
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
