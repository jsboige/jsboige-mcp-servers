# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 932e556f93b26e8eadb1dd91094351985f910f69
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_repair_scope.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for the repair round's SCOPE (#27314, 20/11).

Two defects of the stage-2.5 repair round, both measured on the first conveyor grain:
  1. the cell was shown as `source[-1600:]`: the compiler cited `(47,37): error CS0023` in a
     2 876-char cell whose line 47 sat in the cut-off head — two rounds never saw it;
  2. only the cell DISPLAYING the error could be rewritten: the exception raised in
     `Decouper` (cell 8) surfaced in cell 16, so the round could never reach its cause.

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

# The real #27314 trace (cell 16), as the .NET Interactive kernel printed it.
DOTNET_TRACE = """System.InvalidOperationException: lignes de largeurs inegales
   at Submission#5.Decouper(Segment seg, String strategie)
   at Submission#8.Appliquer(Segment seg, String nom, Dictionary`2 args)
   at Submission#8.Trier(List`1 racines, Int32 maxAppels, Boolean verbeux)
   at Submission#9.<<Initialize>>d__0.MoveNext()
--- End of stack trace from previous location ---
   at Microsoft.CodeAnalysis.Scripting.ScriptExecutionState.RunSubmissionsAsync[TResult](...)"""

IPY_TRACE = ("\x1b[0;31mValueError\x1b[0m Traceback (most recent call last)\n"
             "Cell In[9], line 2\n----> 2 trier(racines)\n"
             "Cell In[5], line 14, in \x1b[0;36mdecouper\x1b[0;34m(seg, strategie)\x1b[0m\n"
             "File /usr/lib/python3.12/json/__init__.py:346, in loads(s)\n"
             '  File "<stdin>", line 3, in <module>\n')


def test_frame_names_from_a_dotnet_trace_skip_the_runtime_frames():
    assert d.error_frame_names(DOTNET_TRACE) == ["Decouper", "Appliquer", "Trier"]


def test_frame_names_from_an_ipython_trace_strip_ansi():
    assert d.error_frame_names(IPY_TRACE) == ["decouper"]


@pytest.mark.parametrize("src, name", [
    ("List<Segment> Decouper(Segment seg, string strategie)\n{", "Decouper"),
    ("(Dictionary<string, object>, List<Segment>) Appliquer(Segment seg, string nom)", "Appliquer"),
    ("static async Task<int> Run<T>(T x) {", "Run"),
    ("public sealed record Segment(string Id, byte[] Data);", "Segment"),
    ("def decouper(seg, strategie):\n    pass", "decouper"),
    ("async def trier(r):", "trier"),
    ("pub fn decouper(seg: &Segment) -> Vec<Segment> {", "decouper"),
    ("let rec trier racines =", "trier"),
])
def test_declares_recognises_definitions(src, name):
    assert d.declares(src, name)


@pytest.mark.parametrize("src", [
    "        return Decouper(seg, s);",
    "foreach (var e in Decouper(seg, s))",
    "var enfants = Decouper(seg, s);",
    "Console.WriteLine(Decouper(seg, s).Count);",
    "if (Decouper(seg, s).Count > 0) { }",
    "    else Decouper(seg, s);",
    "enfants = decouper(seg, s)",
])
def test_declares_rejects_calls(src):
    assert not d.declares(src, "Decouper") and not d.declares(src, "decouper")


def _code(src):
    return {"cell_type": "code", "source": src, "outputs": [], "execution_count": None}


def test_defining_cell_is_the_last_definition_above():
    cells = [_code("int F(int x) => x;"), {"cell_type": "markdown", "source": "int F(int x)"},
             _code("int F(int x) => x + 1;"), _code("var y = F(2);"), _code("int F(int x) => 0;")]
    assert d.defining_cell(cells, "F", before=3) == 2       # redefinition shadows; below ignored
    assert d.defining_cell(cells, "G", before=3) is None


def test_cap_source_shows_a_cell_whole_and_never_cuts_silently():
    src = "\n".join(f"ligne {k}" for k in range(1, 400))     # ~3 300 chars, like #27314 cell 19
    assert d.cap_source(src) == src                          # line 1 visible: the old cut hid it
    long = "a" * 30000
    capped = d.cap_source(long, cap=1000)
    assert capped.startswith("a" * 500) and capped.endswith("a" * 500)
    assert "29000 caractères omis" in capped


def test_cited_lines_quote_the_compiler_line_from_the_current_source():
    src = "\n".join([f"// {k}" for k in range(1, 47)] + ["    foreach (var op in ops.Reverse().ToList())"])
    errs = "(47,37): error CS0023: Impossible d'appliquer l'opérateur '.' à un opérande de type 'void'"
    assert d.cited_lines(src, errs) == [(47, "    foreach (var op in ops.Reverse().ToList())")]
    assert d.cited_lines(src, "(999,1): error CS0103") == []            # out of range: dropped
    # IPython: only the OUTERMOST frame numbers the failing cell; `Cell In[5], line 14`
    # numbers another cell and must not be quoted against this source
    src20 = "\n".join(f"l{k}" for k in range(1, 21))
    assert d.cited_lines(src20, IPY_TRACE) == [(2, "l2")]


def test_repair_prompt_offers_upstream_cells_and_quotes_cited_lines():
    p = d.repair_prompt(
        [{"idx": 16, "source": "Trier(racines);", "errors": DOTNET_TRACE,
          "cited": [(47, "foreach (var op in ops.Reverse().ToList())")]}],
        "conv",
        upstream=[{"idx": 8, "names": ["Decouper"], "for": 16, "source": "List<Segment> Decouper(...)"}])
    assert "CELLULES AMONT" in p and "Cellule 8" in p and "définit Decouper" in p
    assert "47 | foreach (var op in ops.Reverse().ToList())" in p
    assert "plus les cellules amont que tu corriges" in p and "index inchangés" in p


def test_repair_prompt_without_upstream_keeps_the_strict_scope():
    p = d.repair_prompt([{"idx": 3, "source": "x", "errors": "(1,1): error CS1061"}])
    assert "CELLULES AMONT" not in p and "cellules amont" not in p
    assert "aucune autre cellule" in p


def test_a_repair_round_offers_the_defining_cell_and_refuses_any_other(tmp_path, monkeypatch):
    nb = tmp_path / "nb.ipynb"
    failing = _code("var r = Trier(racines);")
    failing["outputs"] = [{"output_type": "error", "ename": "Error",
                           "evalue": "InvalidOperationException", "traceback": DOTNET_TRACE.split("\n")}]
    nb.write_text(json.dumps({"cells": [
        _code("List<Segment> Decouper(Segment seg, string s)\n{\n  throw new InvalidOperationException();\n}"),
        _code("List<Segment> Trier(List<Segment> r) => r.SelectMany(s => Decouper(s, \"csv\")).ToList();"),
        _code("var x = 1;"),
        failing,
    ], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}), encoding="utf-8")
    prompts = []

    async def fake_retry(sk, args, rec, stage, prompt, conv, max_tokens=None):
        prompts.append(prompt)
        return {"conversation_id": "c1"}

    async def fake_parse(sk, args, rec, stage, env, conv, max_tokens=None):
        return {"cells": [{"idx": 0, "cell_type": "code", "source": "List<Segment> Decouper(Segment seg, string s) => new();"},
                          {"idx": 3, "cell_type": "code", "source": "var r = Trier(racines);"},
                          {"idx": 2, "cell_type": "code", "source": "var x = 2;"}]}, env

    async def fake_pm(pm, name, payload):
        return {}

    async def fake_start(pm, kname, exec_dir):
        return "k2"

    async def fake_exec(pm, path, kid, targets):
        return [{"cell": i, "ok": True} for i in targets]

    monkeypatch.setattr(d, "sk_call_retry", fake_retry)
    monkeypatch.setattr(d, "parse_or_repair", fake_parse)
    monkeypatch.setattr(d, "pm_call", fake_pm)
    monkeypatch.setattr(d, "start_kernel", fake_start)
    monkeypatch.setattr(d, "execute_cells", fake_exec)
    rec = {"execution": [{"cell": 0, "ok": True}, {"cell": 1, "ok": True},
                         {"cell": 2, "ok": True}, {"cell": 3, "ok": False}]}
    asyncio.run(d.repair_kernel_errors(None, None, SimpleNamespace(repair_rounds=1), rec, nb,
                                       "csharp", tmp_path, "k1", [0, 1, 2, 3], None, ""))
    assert "Cellule 0 (code, AMONT — définit Decouper" in prompts[0]
    assert "Cellule 1 (code, AMONT — définit Trier" in prompts[0]
    r = rec["repairs"][0]
    assert r["upstream"] == [0, 1]
    assert r["replaced"] == [0, 3] and r["out_of_scope"] == [2]   # cell 2 was never offered
    cells = json.loads(nb.read_text(encoding="utf-8"))["cells"]
    assert "".join(cells[2]["source"]) == "var x = 1;"
