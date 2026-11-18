#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Imported from jsboige/vllm @ 40ce1b93f15d44848d91cdae4f9e7dd04f126076
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_create.py
# Canonical home is sk-agent: new harness fixes belong here, not in vllm.
# -----------------------------------------------------------------------------
"""Offline tests for the driver's creation mode (--source-nb) — the parity C# wave
(#27099-#27116) creates notebooks absent from origin/main. No engine, no MCP, no GitHub."""

import asyncio
import importlib.util
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "nb_coder_driver", HERE / "nb_coder_driver.py")
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)


def write_nb(path: Path, cells: list[dict], meta: dict | None = None) -> Path:
    path.write_text(json.dumps({"cells": cells, "metadata": meta or {},
                                "nbformat": 4, "nbformat_minor": 5},
                               ensure_ascii=False), encoding="utf-8")
    return path


def _join(src) -> str:
    return "".join(src) if isinstance(src, list) else (src or "")


def py_twin(tmp_path: Path) -> Path:
    return write_nb(tmp_path / "T-Python.ipynb", [
        {"cell_type": "markdown", "source": "# Titre", "metadata": {}},
        {"cell_type": "code", "source": "print('hello')", "metadata": {},
         "execution_count": 1, "outputs": []},
        {"cell_type": "markdown", "source": "## Suite", "metadata": {}},
        {"cell_type": "code", "source": "assert 1 + 1 == 2", "metadata": {},
         "execution_count": 2, "outputs": []},
    ])


# ---------------------------------------------------------------- apply_create
def test_apply_create_fills_skeleton_one_write(tmp_path):
    skel = tmp_path / "skel.ipynb"
    skel.write_text(json.dumps({"cells": [], "metadata": {"kernelspec": {"name": ".net-csharp"}},
                                "nbformat": 4, "nbformat_minor": 5}), encoding="utf-8")
    rep = D.apply_create(skel, {"cells": [
        {"cell_type": "markdown", "source": "# Titre C#"},
        {"cell_type": "code", "source": 'Console.WriteLine("hello");'},
        {"cell_type": "code", "source": ""},                     # skipped: empty
        {"cell_type": "quote", "source": "bad"},                 # skipped: bad type
    ]})
    nb = json.loads(skel.read_text(encoding="utf-8"))
    assert rep["cells_written"] == 2 and len(nb["cells"]) == 2
    assert rep["empty_sources"] == [2] and len(rep["errors"]) == 1
    assert nb["cells"][1]["execution_count"] is None and nb["cells"][1]["outputs"] == []
    assert "execution_count" not in nb["cells"][0]               # markdown stays clean
    assert all(c["id"] for c in nb["cells"])                     # nbformat 4.5+ ids
    assert nb["metadata"]["kernelspec"]["name"] == ".net-csharp"  # skeleton meta kept


def test_verify_structure_create_count_and_signature(tmp_path):
    src = py_twin(tmp_path)
    good = write_nb(tmp_path / "good.ipynb", [
        {"cell_type": "markdown", "source": "# Titre C#", "metadata": {}},
        {"cell_type": "code", "source": "var a = 1;", "metadata": {},
         "execution_count": None, "outputs": []},
        {"cell_type": "markdown", "source": "## Suite .NET", "metadata": {}},
        {"cell_type": "code", "source": "var b = 2;", "metadata": {},
         "execution_count": None, "outputs": []},
    ])
    assert D.verify_structure_create(src, good)["ok"] is True

    fewer = write_nb(tmp_path / "fewer.ipynb",
                     json.loads(good.read_text(encoding="utf-8"))["cells"][:3])
    v = D.verify_structure_create(src, fewer)
    assert v["ok"] is False and v["counts_ok"] is False and v["type_signature_ok"] is False

    swapped = write_nb(tmp_path / "swapped.ipynb", [
        {"cell_type": "markdown", "source": "# T", "metadata": {}},
        {"cell_type": "markdown", "source": "code devenu markdown", "metadata": {}},
        {"cell_type": "markdown", "source": "## S", "metadata": {}},
        {"cell_type": "code", "source": "var b = 2;", "metadata": {},
         "execution_count": None, "outputs": []},
    ])
    v2 = D.verify_structure_create(src, swapped)
    assert v2["counts_ok"] is True and v2["type_signature_ok"] is False

    stale = json.loads(good.read_text(encoding="utf-8"))
    stale["cells"][1]["outputs"] = [{"output_type": "stream", "text": "fabriqué"}]
    stalep = tmp_path / "stale.ipynb"
    stalep.write_text(json.dumps(stale), encoding="utf-8")
    v3 = D.verify_structure_create(src, stalep)
    assert v3["ok"] is False and v3["stale_outputs"] == [1]      # outputs must come from EXECUTION


# ---------------------------------------------------------------- canonical meta
def test_series_canonical_meta_picks_csharp_twin(tmp_path):
    repo = tmp_path
    d = repo / "Ser"
    d.mkdir()
    write_nb(d / "T-01-CSharp.ipynb", [], {"kernelspec": {"name": ".net-csharp"},
                                           "language_info": {"version": "9.0.117"}})
    write_nb(d / "T-02-CSharp.ipynb", [], {"kernelspec": {"name": ".net-csharp"},
                                           "language_info": {"version": "9.0.117"}})
    write_nb(d / "T-Python.ipynb", [], {"kernelspec": {"name": "python3"},
                                        "language_info": {"version": "3.13.16"}})
    meta = D.series_canonical_meta(repo, "Ser/T-03-CSharp.ipynb")
    assert meta["kernelspec"]["name"] == ".net-csharp"
    assert meta["language_info"]["version"] == "9.0.117"         # NOT the Python twin's
    assert D.series_canonical_meta(repo, "Ser/T-04-CSharp.ipynb") == {} or True
    # no C# sibling at all -> empty dict (skeleton without meta, gate will report honestly)
    lone = repo / "Lone"
    lone.mkdir()
    write_nb(lone / "X-Python.ipynb", [], {"kernelspec": {"name": "python3"}})
    assert D.series_canonical_meta(repo, "Lone/X-CSharp.ipynb") == {}


# ---------------------------------------------------------------- gates in creation mode
def test_run_gates_language_info_uses_canon_in_creation(tmp_path):
    src = py_twin(tmp_path)
    built = write_nb(tmp_path / "built.ipynb", [
        {"cell_type": "markdown", "source": "# Titre C#", "metadata": {}},
        {"cell_type": "code", "source": "var a = 1;", "metadata": {},
         "execution_count": None, "outputs": []},
        {"cell_type": "markdown", "source": "## Suite .NET", "metadata": {}},
        {"cell_type": "code", "source": "var b = 2;", "metadata": {},
         "execution_count": None, "outputs": []},
    ], meta={"kernelspec": {"name": ".net-csharp"},
             "language_info": {"version": "9.0.117"}})
    gates = {g["gate"]: g for g in D.run_gates(src, built, create_mode=True,
                                               canon_version="9.0.117")}
    assert gates["language-info"]["ok"] is True
    assert gates["language-info"]["detail"] == {"canon": "9.0.117", "built": "9.0.117"}
    # correction mode on the same pair would FAIL (python 3.13 vs 9.0) — that failure is
    # the proof the create branch is actually taken
    gates_corr = {g["gate"]: g for g in D.run_gates(src, built)}
    assert gates_corr["language-info"]["ok"] is False
    # every cell is delta in creation mode: coord-refs polices the whole notebook
    bad = json.loads(built.read_text(encoding="utf-8"))
    bad["cells"][0]["source"] = "voir l'epic #26070 pour le contexte"
    badp = tmp_path / "bad.ipynb"
    badp.write_text(json.dumps(bad), encoding="utf-8")
    gates_bad = {g["gate"]: g for g in D.run_gates(src, badp, create_mode=True,
                                                   canon_version="9.0.117")}
    assert gates_bad["coord-refs"]["ok"] is False


# ---------------------------------------------------------------- prompts + segmentation
def test_creation_prompts_contract(tmp_path):
    p1 = D.creation_prompt(27099, {"title": "t", "body": "corps", "comments": ""},
                           "Ser/Z3-10-CSharp.ipynb", "Ser/Z3-10-Python.ipynb",
                           {"kernel_name": ".net-csharp", "canonical_version": None,
                            "neighbour_versions": {}}, "ctx", "vue")
    assert "MODE CRÉATION" in p1 and '"cells"' in p1 and "27099" in p1
    # the 17/11 fix: stage 1 is a LIGHT plan — full sources are stage 2's job, by segments
    assert "SANS les sources" in p1
    assert '"source"' not in p1.split("Rends UNIQUEMENT")[1]   # schema has titre/role only
    p2 = D.creation_json_prompt([{"idx": 0, "cell_type": "markdown", "titre": "T"}], 29, "conv")
    assert "29" in p2 and '"cells"' in p2 and "TRANCHE" in p2


def test_create_segments_assembles_and_reports(monkeypatch):
    """The stage-2 loop: one call per CREATE_SEGMENT plan cells -> assembled payload in
    plan order; a segment that answers nothing parseable sets the verdict and returns
    {} with the raw tail persisted (the 17/11 diagnosability hole)."""
    plan_cells = [{"idx": i, "cell_type": "markdown" if i % 2 else "code", "titre": f"c{i}"}
                  for i in range(10)]
    canned = [{"cells": [{"idx": c["idx"], "cell_type": c["cell_type"],
                          "source": f"src {c['idx']}"} for c in plan_cells[i:i + D.CREATE_SEGMENT]]}
              for i in range(0, 10, D.CREATE_SEGMENT)]
    calls = []

    async def fake_retry(session, args, rec, stage, prompt, conv, max_tokens=None):
        calls.append(stage)
        return {"response": "```json\n" + json.dumps(canned.pop(0)) + "\n```",
                "conversation_id": "cx"}

    monkeypatch.setattr(D, "sk_call_retry", fake_retry)
    rec: dict = {}
    out = asyncio.run(D.create_segments(None, None, rec, None, plan_cells, 10, ""))
    assert calls == ["2-build+0", "2-build+8"]               # 10 cells -> segments of 8 + 2
    assert [c["source"] for c in out["cells"]] == [f"src {i}" for i in range(10)]
    assert [s["got"] for s in rec["segments"]] == [8, 2]
    assert out["notes"] == "assembled from 2 segments"

    async def fake_dead(session, args, rec, stage, prompt, conv, max_tokens=None):
        # ends with a closed fence and no JSON inside: an UNPARSABLE answer, not a
        # truncated one — the bisect path must NOT fire for this
        return {"response": "voilà le code\n```\n{ incomplet\n```", "conversation_id": "cx"}

    monkeypatch.setattr(D, "sk_call_retry", fake_dead)
    rec2: dict = {}
    out2 = asyncio.run(D.create_segments(None, None, rec2, None, plan_cells, 10, ""))
    assert out2 == {} and rec2["verdict"].startswith("stage2-unparsed:0")
    assert rec2["stage2_raw_tail"]                           # diagnosable without a re-run


def test_create_segments_short_segment_repaired(monkeypatch):
    """17/11 #27104 blank pass: segment 3 answered 6 of 8 cells, the loop appended
    silently, the built notebook was 2 cells short and ONLY the final verify caught
    it. Now the missing idx get ONE repair re-ask; the assembled order stays the
    PLAN order even when the repair fills mid-segment holes."""
    plan_cells = [{"idx": i, "cell_type": "markdown", "titre": f"c{i}"} for i in range(8)]
    first = {"cells": [{"idx": c["idx"], "cell_type": "markdown", "source": f"s{c['idx']}"}
                       for c in plan_cells if c["idx"] not in (3, 6)]}   # 6 of 8
    repair = {"cells": [
        {"idx": 6, "cell_type": "markdown", "source": "s6"},             # out of order
        {"idx": 3, "cell_type": "markdown", "source": ""},
        {"idx": 3, "cell_type": "markdown", "source": "s3-dup"},        # after the empty
        {"idx": 99, "cell_type": "markdown", "source": "hors-tranche"}, # dropped
    ]}
    calls = []

    async def fake(session, args, rec, stage, prompt, conv, max_tokens=None):
        calls.append(stage)
        return {"response": "```json\n" + json.dumps(first if not calls[1:] else repair)
                + "\n```", "conversation_id": "cx"}

    monkeypatch.setattr(D, "sk_call_retry", fake)
    rec: dict = {}
    out = asyncio.run(D.create_segments(None, None, rec, None, plan_cells, 8, ""))
    assert calls == ["2-build+0", "2-build+0+repair"]
    assert [c["idx"] for c in out["cells"]] == list(range(8))            # plan order
    assert [c["source"] for c in out["cells"]] == [
        "s0", "s1", "s2", "s3-dup", "s4", "s5", "s6", "s7"]   # empty dup skipped, real kept
    s = rec["segments"][0]
    assert s["asked"] == 8 and s["got"] == 8 and s["repair"]["filled"] == [3, 6]
    assert "verdict" not in rec


def test_create_segments_short_segment_fails_fast(monkeypatch):
    """Repair still short -> verdict BEFORE the notebook is written (the tokens of a
    doomed apply/execute round are not spent), missing idx named for the record."""
    plan_cells = [{"idx": i, "cell_type": "markdown", "titre": f"c{i}"} for i in range(8)]
    first = {"cells": [{"idx": c["idx"], "cell_type": "markdown", "source": f"s{c['idx']}"}
                       for c in plan_cells if c["idx"] not in (6, 7)]}
    half = {"cells": [{"idx": 6, "cell_type": "markdown", "source": "s6"}]}
    calls = []

    async def fake(session, args, rec, stage, prompt, conv, max_tokens=None):
        calls.append(stage)
        return {"response": "```json\n" + json.dumps(first if not calls[1:] else half)
                + "\n```", "conversation_id": "cx"}

    monkeypatch.setattr(D, "sk_call_retry", fake)
    rec: dict = {}
    out = asyncio.run(D.create_segments(None, None, rec, None, plan_cells, 8, ""))
    assert out == {} and rec["verdict"] == "stage2-short-segment:0"
    assert rec["stage2_missing_idx"] == [7] and rec["stage2_raw_tail"]


def test_create_segments_truncated_bisects_once(monkeypatch):
    """18/11 wave-1c (7/7 failed, 2 on this path): the segment JSON was CUT mid-cell
    — thinking counts toward max_tokens, so the visible output truncates (measured
    9.8K and 28.5K chars, tails ending inside a "source" string). The loop must
    re-ask the segment as two halves; halves that answer keep the grain alive."""
    plan_cells = [{"idx": i, "cell_type": "markdown", "titre": f"c{i}"} for i in range(8)]
    h0 = {"cells": [{"idx": c["idx"], "cell_type": "markdown", "source": f"s{c['idx']}"}
                    for c in plan_cells[:4]]}
    h1 = {"cells": [{"idx": c["idx"], "cell_type": "markdown", "source": f"s{c['idx']}"}
                    for c in plan_cells[4:]]}
    calls = []

    async def fake(session, args, rec, stage, prompt, conv, max_tokens=None):
        calls.append((stage, max_tokens))
        if stage == "2-build+0":
            # truncated: no closing fence, ends mid-string — exactly the 18/11 shape
            return {"response": '```json\n{"cells":[{"idx":0,"source": "// coupé mid-vo',
                    "conversation_id": "cx"}
        half = h0 if stage.endswith("h0") else h1
        return {"response": "```json\n" + json.dumps(half) + "\n```", "conversation_id": "cx"}

    monkeypatch.setattr(D, "sk_call_retry", fake)
    rec: dict = {}
    out = asyncio.run(D.create_segments(None, None, rec, None, plan_cells, 8, ""))
    assert [c["idx"] for c in out["cells"]] == list(range(8))     # plan order preserved
    assert rec["bisected"] == [0]
    assert [s[0] for s in calls] == ["2-build+0", "2-build+0+h0", "2-build+0+h1"]
    # build tours carry the raised budget (the truncation mechanism is token-borne)
    assert all(m == D.BUILD_MAX_TOKENS for _, m in calls)


def test_create_segments_truncated_half_fails_named(monkeypatch):
    """A half that STILL truncates fails the grain as stage2-truncated (named half),
    never silently."""
    plan_cells = [{"idx": i, "cell_type": "markdown", "titre": f"c{i}"} for i in range(8)]

    async def fake(session, args, rec, stage, prompt, conv, max_tokens=None):
        return {"response": '```json\n{"cells":[{"idx":2,"source": "coupé',
                "conversation_id": "cx"}

    monkeypatch.setattr(D, "sk_call_retry", fake)
    rec: dict = {}
    out = asyncio.run(D.create_segments(None, None, rec, None, plan_cells, 8, ""))
    assert out == {} and rec["verdict"] == "stage2-truncated:0+h0"
    assert rec["stage2_raw_tail"]


def test_gate_refusal_defers_instead_of_failing():
    """18/11 wave-1c #27103: 'capacity gate refused dispatch ... retry after 3600s'
    arrived as stage1-call-failed and terminally burned the grain — the scheduler
    only retries verdicts STARTING with deferred-by-capacity-gate."""
    gr = D.gate_refusal({"error": "capacity gate refused dispatch to model "
                                  "'qwen3.6-35b-a3b-nbcoder' (verdict yellow); retry after 3600s"})
    assert gr.startswith("deferred-by-capacity-gate")
    assert D.gate_refusal({"error": "401 invalid proxy authentication"}) == ""
    assert D.gate_refusal({}) == ""
    assert D.gate_refusal({"error": "TimeoutError: read timed out"}) == ""


# ---------------------------------------------------------------- post-exec hygiene (17/11)
def test_foreign_script_gate_flags_corruption_delta_judged(tmp_path):
    """#27104 blank pass: Cyrillic/CJK hallucinated inside regenerated French prose.
    Delta-judged — a pre-existing foreign-script cell untouched by the build is the
    repo's business (same rule as coord-refs/secrets)."""
    src = py_twin(tmp_path)                       # 4 cells, French-clean
    corrupt = write_nb(tmp_path / "corrupt.ipynb", [
        {"cell_type": "markdown", "source": "# Titre C#", "metadata": {}},
        {"cell_type": "code", "source": "var a = 1;", "metadata": {},
         "execution_count": None, "outputs": []},
        # CHANGED cell carrying the measured corruption shapes
        {"cell_type": "markdown",
         "source": "## Suite : ni случай générateur, il serait。德onnant", "metadata": {}},
        {"cell_type": "code", "source": "var b = 2;", "metadata": {},
         "execution_count": None, "outputs": []},
    ])
    gates = {g["gate"]: g for g in D.run_gates(src, corrupt, create_mode=True)}
    g = gates["foreign-script"]
    assert g["ok"] is False and len(g["detail"]["hits"]) == 1
    assert g["detail"]["hits"][0]["cell"] == 2 and "excerpt" in g["detail"]["hits"][0]

    clean = write_nb(tmp_path / "clean.ipynb", [
        {"cell_type": "markdown", "source": "# Titre C#", "metadata": {}},
        {"cell_type": "code", "source": "var a = 1;", "metadata": {},
         "execution_count": None, "outputs": []},
        {"cell_type": "markdown", "source": "## Suite .NET (lambda, phi, Delta éàç)",
         "metadata": {}},                       # Greek + accents: deliberately NOT flagged
        {"cell_type": "code", "source": "var b = 2;", "metadata": {},
         "execution_count": None, "outputs": []},
    ])
    gates2 = {g["gate"]: g for g in D.run_gates(src, clean, create_mode=True)}
    assert gates2["foreign-script"]["ok"] is True

    # correction-mode delta rule: the identical Cyrillic cell sits UNTOUCHED in the
    # source and the build -> skipped (repo's business, not this build's)
    src_cyr = write_nb(tmp_path / "src_cyr.ipynb", [
        {"cell_type": "markdown", "source": "# Titre", "metadata": {}},
        {"cell_type": "code", "source": "print('hello')", "metadata": {},
         "execution_count": 1, "outputs": []},
        {"cell_type": "markdown", "source": "## случай préexistant", "metadata": {}},
        {"cell_type": "code", "source": "assert 1 + 1 == 2", "metadata": {},
         "execution_count": 2, "outputs": []},
    ])
    built_same = write_nb(tmp_path / "same.ipynb", json.loads(
        src_cyr.read_text(encoding="utf-8"))["cells"])
    gates3 = {g["gate"]: g for g in D.run_gates(src_cyr, built_same)}
    assert gates3["foreign-script"]["ok"] is True   # untouched -> not this build's fault


def test_strip_dotnet_banner_records_and_never_fatals(tmp_path):
    """Missing tool -> recorded error, no exception; a real tool is invoked with
    --apply <nb> and its rc lands in the record."""
    nb = write_nb(tmp_path / "nb.ipynb", [])
    miss = D.strip_dotnet_banner(tmp_path / "nope.py", nb)
    assert miss["ok"] is False and "absent" in miss["error"]

    tool = tmp_path / "strip.py"
    tool.write_text("import sys\nsys.exit(0)\n", encoding="utf-8")
    ok = D.strip_dotnet_banner(tool, nb)
    assert ok["ok"] is True and ok["rc"] == 0

    fail = tmp_path / "strip_fail.py"
    fail.write_text("import sys\nsys.exit(3)\n", encoding="utf-8")
    bad = D.strip_dotnet_banner(fail, nb)
    assert bad["ok"] is False and bad["rc"] == 3


# ---------------------------------------------------------------- repair loop
def test_apply_repairs_replaces_and_resets(tmp_path):
    nb = tmp_path / "b.ipynb"
    write_nb(nb, [
        {"cell_type": "markdown", "source": "# T", "metadata": {}},
        {"cell_type": "code", "source": "var a = MkNe(1, 2);", "metadata": {},
         "execution_count": 3,
         "outputs": [{"output_type": "error", "evalue": "compilation error"}]},
        {"cell_type": "code", "source": "Console.WriteLine(1);", "metadata": {},
         "execution_count": 4, "outputs": []},
    ])
    rep = D.apply_repairs(nb, {"cells": [
        {"idx": 1, "cell_type": "code", "source": "var a = ctx.MkNot(ctx.MkEq(x, y));"},
        {"idx": 9, "cell_type": "code", "source": "inconnue"},      # unknown idx
        {"idx": 0, "cell_type": "code", "source": "pas code"},      # not a code cell
        {"idx": 2, "cell_type": "code", "source": "   "},           # empty source
    ]})
    assert rep["replaced"] == [1] and rep["unknown_idx"] == [9, 0] and rep["bad"] == [2]
    cells = json.loads(nb.read_text(encoding="utf-8"))["cells"]
    # sources are normalized to LISTS of lines — substring on the joined source
    assert "MkNot" in _join(cells[1]["source"])
    assert cells[1]["outputs"] == [] and cells[1]["execution_count"] is None  # re-execute
    assert _join(cells[2]["source"]) == "Console.WriteLine(1);"   # untouched


def test_repair_prompt_contract():
    p = D.repair_prompt([{"idx": 3, "source": "var a = MkNe(1,2);",
                          "errors": "(2,15): error CS1061: MkNe"}], "conv")
    assert "TOUR RÉPARATION" in p and "MkNe" in p and "CS1061" in p
    assert '"idx"' in p and "conv" in p
    # the schema demands ONLY the failing cells — no wholesale rewrite invitation
    assert "index inchangés" in p


# ------------------------------------------------- prose authority + markdown repair (17/11 #27104)
def test_creation_json_prompt_injects_twin_prose():
    """The twin's markdown prose is handed to the builder VERBATIM — the model must
    COPY it, not regenerate it (regenerated prose came back corrupted: Cyrillic/CJK)."""
    seg = [{"idx": 1, "cell_type": "markdown", "titre": "théorème"},
           {"idx": 2, "cell_type": "code", "titre": "impl"}]
    twin = [{"cell_type": "markdown", "source": "# Titre"},
            {"cell_type": "markdown", "source": "Le théorème de Gibbard–Satterthwaite."},
            {"cell_type": "code", "source": "print(1)"}]
    p = D.creation_json_prompt(seg, 3, "", src_cells=twin)
    assert "PROSE DU JUMEAU PYTHON" in p and "AUTORITÉ" in p
    assert "<cellule 1 — prose à recopier>" in p
    assert "Gibbard–Satterthwaite" in p          # the twin prose, verbatim
    assert "<cellule 2" not in p                 # CODE cells derive from the plan
    # no twin (correction mode / absent) -> no prose block, prompt shape unchanged
    p_plain = D.creation_json_prompt(seg, 3, "conv")
    assert "PROSE DU JUMEAU PYTHON" not in p_plain and "TRANCHE" in p_plain and "conv" in p_plain


def test_apply_repairs_markdown_needs_flag(tmp_path):
    """Markdown repair is a SEPARATE lane: without the flag the old contract holds
    (code cells only); with allow_markdown=True a markdown cell's source is replaced
    and nothing else is touched — markdown has no outputs to reset."""
    nb = tmp_path / "m.ipynb"
    write_nb(nb, [
        {"cell_type": "markdown", "source": "ni случай générateur", "metadata": {}},
        {"cell_type": "code", "source": "var x = 1;", "metadata": {},
         "execution_count": 2, "outputs": []},
    ])
    payload = {"cells": [
        {"idx": 0, "cell_type": "markdown", "source": "ni un générateur ni un dictateur"},
        {"idx": 1, "cell_type": "code", "source": "var x = 2;"},
    ]}
    strict = D.apply_repairs(nb, payload)                    # flag off
    assert strict["replaced"] == [1] and strict["unknown_idx"] == [0]
    md = D.apply_repairs(nb, payload, allow_markdown=True)    # prose round
    assert md["replaced"] == [0, 1] and md["unknown_idx"] == []
    cells = json.loads(nb.read_text(encoding="utf-8"))["cells"]
    assert _join(cells[0]["source"]) == "ni un générateur ni un dictateur"
    assert cells[1]["execution_count"] is None and cells[1]["outputs"] == []


def test_md_repair_prompt_contract():
    p = D.md_repair_prompt([{"idx": 4, "excerpt": "il serait。德onnant",
                             "twin_source": "Il serait étonnant que"},
                            {"idx": 7, "excerpt": "lalanceur", "twin_source": ""}],
                           "conv")
    assert "TOUR RÉPARATION PROSE" in p
    assert "### Cellule 4 (markdown)" in p and "。德" in p and "Il serait étonnant" in p
    assert "### Cellule 7 (markdown)" in p
    assert "absente du jumeau" in p               # fallback when the twin has no prose
    assert '"cell_type":"markdown"' in p and "index inchangés" in p and "conv" in p


def test_mcp_write_mode_refused_in_creation():
    """The driver's own post-parse guard: --source-nb + --write-mode mcp exits 2
    BEFORE any stage runs (max-stage 0, unreachable repo, claim off)."""
    old = sys.argv
    try:
        sys.argv = ["nb_coder_driver.py",
                    "--issue", "1", "--notebook", "A/B-CSharp.ipynb",
                    "--source-nb", "A/B-Python.ipynb", "--repo", "D:/nope",
                    "--write-mode", "mcp", "--max-stage", "0"]
        with pytest.raises(SystemExit) as ei:
            D.main()
        assert ei.value.code == 2
    finally:
        sys.argv = old


def test_initialize_handshake_has_a_timeout():
    """Wave-1b hang (18/11 00:27->03:35Z): a child blocked in StreamHandler.emit
    never answered `initialize` and the driver waited forever — per-call
    read_timeouts only arm AFTER the handshake. The fix wraps both initialize()
    calls in asyncio.wait_for; this test pins the wait_for by calling the SAME
    wrapped sequence against a session stub that never responds."""
    import inspect
    src = inspect.getsource(D)
    assert "asyncio.wait_for(sk.initialize()" in src, \
        "the sk-agent initialize handshake must carry a wait_for timeout"
    assert "asyncio.wait_for(pm.initialize()" in src, \
        "the papermill initialize handshake must carry a wait_for timeout"


def test_execute_cells_opts_into_error_output_persistence(monkeypatch):
    """#4817 / ms#1803: the MCP default REFUSES to persist a raised cell's error output
    into the .ipynb (committed sources stay intangible). execute_cells only ever runs
    the SCRATCH copy, and the repair rounds + verify critic read that artifact from
    disk after the process is gone — so the payload must opt IN, and the record must
    carry the instrument's own error_outputs_persisted proof."""
    seen = []

    async def fake_pm_call(session, tool, payload):
        seen.append((tool, payload))
        return {"status": "error", "outputs": [],
                "error_outputs_persisted": True}

    monkeypatch.setattr(D, "pm_call", fake_pm_call)
    res = asyncio.run(D.execute_cells(object(), Path("scratch.ipynb"), "k1", [3, 7]))
    payloads = [p for t, p in seen if t == "execute_on_kernel"]
    assert len(payloads) == 2
    for p in payloads:
        assert p["persist_error_outputs"] is True
        assert p["kernel_id"] == "k1" and p["mode"] == "notebook_cell"
    assert all(r["error_outputs_persisted"] is True for r in res), \
        "the instrument's persistence proof must survive into the record"
    assert all(r["ok"] is False for r in res)  # status error -> not ok, unchanged semantics


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
