# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_repair_scope.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
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


# ---- fallback by USE (#27302, 20/11) ---------------------------------------------------
# The Petersen test (cell 24) threw from inside its own cell: the trace crosses no upstream
# frame, yet the faulty witness graph lives in cell 5. Round 1 rewrote cell 5 anyway and
# was refused as out of scope, which ended the repair.
PETERSEN_TRACE = """System.Exception: Test echoue : Petersen
   at Submission#11.<<Initialize>>d__0.MoveNext()
--- End of stack trace from previous location ---
   at Microsoft.CodeAnalysis.Scripting.ScriptExecutionState.RunSubmissionsAsync[TResult](...)"""


def test_used_names_and_binds():
    src = ('var g = TEMOINS["Petersen"];\nint k = EdgeColoringCpsat<int>(g, 3);\n'
           'var h = new Graphe();\n// Ignored(1) in a comment\n')
    assert d.used_names(src) == ["TEMOINS", "EdgeColoringCpsat", "Graphe"]
    # a plain argument is a use too; keywords and string contents are not
    assert d.used_names('else if (Trier(racines) == "https://x") return;') == ["Trier", "racines"]
    assert d.binds('var TEMOINS = new Dictionary<string, Graphe>();', "TEMOINS")
    assert d.binds('public static readonly Dictionary<string, Graphe> TEMOINS = new();', "TEMOINS")
    assert d.binds("TEMOINS: dict[str, Graphe] = {}", "TEMOINS")
    assert d.binds("let mut temoins = Vec::new();", "temoins")
    assert not d.binds('if (TEMOINS == null) return;', "TEMOINS")
    assert not d.binds('var t = TEMOINS["P"];', "TEMOINS")
    assert not d.binds('Func<int,int> f = x => x;', "x")


def _petersen_cells():
    return [
        _code("public class Graphe { public void AddEdge(string a, string b) {} }\n"
              "var TEMOINS = new Dictionary<string, Graphe>();"),
        _code("int EdgeColoringCpsat(Graphe g, int k) => k;"),
        _code("var x = 1;"),
        _code("int Unused() => 0;"),
        _code('var g = TEMOINS["Petersen"];\nif (EdgeColoringCpsat(g, 3) != 4)\n'
              '    throw new Exception("Test echoue : Petersen");'),
    ]


def test_using_cells_ranks_by_names_and_honours_bound_and_exclusion():
    cells = _petersen_cells()
    # equal rank -> nearest first
    assert d.using_cells(cells, 4, 3) == [(1, ["EdgeColoringCpsat"]), (0, ["TEMOINS"])]
    assert d.using_cells(cells, 4, 1) == [(1, ["EdgeColoringCpsat"])]       # bounded
    cells[0] = _code(d._text(cells[0]["source"]) + "\nint EdgeColoringCpsat(Graphe g, int k) => 0;")
    cells[1] = _code("int Other() => 1;")
    assert d.using_cells(cells, 4, 3) == [(0, ["TEMOINS", "EdgeColoringCpsat"])]  # more names first
    cells = _petersen_cells()
    assert d.using_cells(cells, 4, 3, exclude={0}) == [(1, ["EdgeColoringCpsat"])]
    # a name the failing cell defines itself is its own business
    cells[4] = _code("int EdgeColoringCpsat(Graphe g, int k) => 4;\n" + d._text(cells[4]["source"]))
    assert d.using_cells(cells, 4, 3) == [(0, ["Graphe", "TEMOINS"])]   # Graphe: param type


def _run_round(tmp_path, monkeypatch, cells, failing_idx, trace, answer):
    nb = tmp_path / "nb.ipynb"
    cells[failing_idx]["outputs"] = [{"output_type": "error", "ename": "Error",
                                      "evalue": "x", "traceback": trace.split("\n")}]
    nb.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                              "nbformat_minor": 5}), encoding="utf-8")
    prompts = []

    async def fake_retry(sk, args, rec, stage, prompt, conv, max_tokens=None):
        prompts.append(prompt)
        return {"conversation_id": "c1"}

    async def fake_parse(sk, args, rec, stage, env, conv, max_tokens=None):
        return {"cells": answer}, env

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
    rec = {"execution": [{"cell": i, "ok": i != failing_idx} for i in range(len(cells))]}
    asyncio.run(d.repair_kernel_errors(None, None, SimpleNamespace(repair_rounds=1), rec, nb,
                                       "csharp", tmp_path, "k1", list(range(len(cells))),
                                       None, ""))
    return prompts, rec["repairs"][0], json.loads(nb.read_text(encoding="utf-8"))["cells"]


def test_an_in_cell_assertion_offers_the_cells_defining_what_it_uses(tmp_path, monkeypatch):
    answer = [{"idx": 0, "cell_type": "code", "source": "var TEMOINS = Fixed();"},
              {"idx": 4, "cell_type": "code", "source": "var g = TEMOINS[\"Petersen\"];"},
              {"idx": 2, "cell_type": "code", "source": "var x = 2;"}]
    prompts, r, cells = _run_round(tmp_path, monkeypatch, _petersen_cells(), 4,
                                   PETERSEN_TRACE, answer)
    assert "Cellule 0 (code, AMONT — définit TEMOINS, utilisé par la cellule 4)" in prompts[0]
    assert "Cellule 1 (code, AMONT — définit EdgeColoringCpsat, utilisé par la cellule 4)" in prompts[0]
    assert "une assertion qui échoue" in prompts[0]
    assert "Cellule 3" not in prompts[0]                       # defines nothing the cell uses
    assert r["upstream"] == [1, 0]
    assert r["replaced"] == [0, 4] and r["out_of_scope"] == [2]
    assert "".join(cells[0]["source"]) == "var TEMOINS = Fixed();"


def test_a_compile_error_never_widens_the_scope_by_use(tmp_path, monkeypatch):
    cs_err = "(1,9): error CS0103: Le nom 'TEMOINZ' n'existe pas dans le contexte actuel"
    answer = [{"idx": 0, "cell_type": "code", "source": "var TEMOINS = Fixed();"},
              {"idx": 4, "cell_type": "code", "source": "var g = TEMOINS[\"Petersen\"];"}]
    prompts, r, cells = _run_round(tmp_path, monkeypatch, _petersen_cells(), 4, cs_err, answer)
    assert "CELLULES AMONT" not in prompts[0]
    assert r["upstream"] == [] and r["replaced"] == [4] and r["out_of_scope"] == [0]


def test_a_traced_failure_keeps_the_trace_offer_only(tmp_path, monkeypatch):
    cells = _petersen_cells()
    cells[4] = _code("var r = Trier(racines);")
    cells[1] = _code("List<Segment> Decouper(Segment seg, string s) => throw new X();")
    cells[2] = _code("var racines = new List<Segment>();")     # used, but the trace is precise
    prompts, r, _ = _run_round(tmp_path, monkeypatch, cells, 4, DOTNET_TRACE,
                               [{"idx": 4, "cell_type": "code", "source": "var r = 1;"}])
    assert r["upstream"] == [1]                                # Decouper via the trace
    assert "traversé par la trace de la cellule 4" in prompts[0]
    assert "utilisé par" not in prompts[0]
