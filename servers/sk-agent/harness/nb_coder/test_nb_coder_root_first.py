#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ e94d5f4f3f036aa5f4b42060584f592b3e42e983
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_root_first.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Offline tests for root-cause-first repair — #27302 attempt 2, 2026-11-20.

Cell 10 of the C# twin did not compile (`CpSolverParameters`, a type the OR-Tools C# API
lacks under that name). A failed .NET submission defines none of its names, so the five
functions cell 10 declares never existed and seven cells below failed with CS0103 on
them. Each repair round re-asked all of them (13, 12, then 10 cells) and the root error
survived three rounds. A cell that fails on a name an EARLIER failing cell declares now
waits for that cell's repair; it is re-executed after the round."""

import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
d = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(d)

# Verbatim from live/runs/issue-27302-dffc7835/nb_27302_built.ipynb (cells 10, 18, 34).
ERR_ROOT = ("\r\n(27,18): error CS0246: Le nom de type ou d'espace de noms "
            "'CpSolverParameters' est introuvable (vous manque-t-il une directive using ou une "
            "référence d'assembly\xa0?)\r\n\r\n")
ERR_CASCADE = ("\r\n(23,34): error CS0103: Le nom 'EdgeColoringCpsat' n'existe pas dans le "
               "contexte actuel\r\n\r\n(23,10): error CS8130: Impossible de déduire le type de "
               "la variable de déconstruction implicitement typée 'coloring'.\r\n\r\n(23,20): "
               "error CS8130: Impossible de déduire le type de la variable de déconstruction "
               "implicitement typée 'statusName'.\r\n\r\n")
ERR_TWO_ROOTS = ("(9,17): error CS0103: Le nom 'MobiusLadder' n'existe pas dans le contexte "
                 "actuel\r\n\r\n(11,38): error CS0103: Le nom 'EdgeColoringCpsat' n'existe pas "
                 "dans le contexte actuel\r\n\r\n")


def _code(src: str, err: str | None = None) -> dict:
    c = {"cell_type": "code", "metadata": {}, "source": src, "execution_count": None,
         "outputs": []}
    if err is not None:
        c["outputs"] = [{"output_type": "stream", "name": "stderr", "text": err},
                        {"output_type": "error", "ename": "Error",
                         "evalue": "compilation error", "traceback": []}]
    return c


def _cs0103(name: str) -> str:
    return (f"\r\n(3,9): error CS0103: Le nom '{name}' n'existe pas dans le contexte "
            "actuel\r\n\r\n")


def _notebook() -> list[dict]:
    """The #27302 shape, shrunk: one root (2), three cascades on it (3, 4, 5), a cascade on
    a cascade only (8), and an independent error (7)."""
    return [
        {"cell_type": "markdown", "metadata": {}, "source": "# Coloration d'arêtes"},
        _code("public class Graphe { }"),
        _code("static (int[], string) EdgeColoringCpsat(Graphe g, int k)\n{\n"
              "    var p = new CpSolverParameters();\n    return (new int[0], \"\");\n}\n"
              "static string FormatSolverVerdict(int s) => s.ToString();", ERR_ROOT),
        _code("var (col4, status4) = EdgeColoringCpsat(new Graphe(), 4);\n"
              "Console.WriteLine(FormatSolverVerdict(0));",
              _cs0103("EdgeColoringCpsat") + _cs0103("FormatSolverVerdict")),
        _code("Graphe MobiusLadder(int n) => new Graphe();\n"
              "var (coloring, statusName) = EdgeColoringCpsat(new Graphe(), 3);", ERR_CASCADE),
        _code("var c = EdgeColoringCpsat(MobiusLadder(4), 3);", ERR_TWO_ROOTS),
        _code("var y = 1;"),
        _code("int z = Introuvable(3);", _cs0103("Introuvable")),
        _code("var m = MobiusLadder(5);", _cs0103("MobiusLadder")),
    ]


def _detail(cells: list[dict]) -> list[dict]:
    return [{"idx": i, "_raw_errors": d._outputs_text(c)} for i, c in enumerate(cells)
            if c.get("cell_type") == "code" and c["outputs"]]


# ---- undefined_names -------------------------------------------------------------------
def test_undefined_names_reads_the_dotnet_messages_in_french_and_english():
    assert d.undefined_names(ERR_ROOT) == ["CpSolverParameters"]
    assert d.undefined_names(ERR_CASCADE) == ["EdgeColoringCpsat"]      # CS8130 ignored
    assert d.undefined_names(ERR_TWO_ROOTS) == ["MobiusLadder", "EdgeColoringCpsat"]
    assert d.undefined_names("(1,1): error CS0103: The name 'Foo' does not exist") == ["Foo"]
    assert d.undefined_names("(2,5): error CS0246: The type or namespace name 'Bar' could "
                             "not be found") == ["Bar"]


def test_undefined_names_reads_python_and_rust():
    assert d.undefined_names("NameError: name 'solve' is not defined") == ["solve"]
    assert d.undefined_names("error[E0425]: cannot find function `run_woa` in this scope"
                             ) == ["run_woa"]
    assert d.undefined_names("error[E0412]: cannot find type `Swarm` in this scope") == ["Swarm"]
    assert d.undefined_names("error[E0433]: failed to resolve: use of undeclared type `Grid`"
                             ) == ["Grid"]


def test_undefined_names_is_empty_on_other_errors():
    assert d.undefined_names("") == []
    assert d.undefined_names(None) == []
    assert d.undefined_names("System.Exception: Test echoue : Petersen") == []
    assert d.undefined_names("(4,2): error CS1002: ; attendu") == []


# ---- cascade_roots ---------------------------------------------------------------------
def test_cascade_roots_maps_each_cascade_to_its_earlier_failing_definitions():
    cells = _notebook()
    assert d.cascade_roots(cells, _detail(cells)) == {3: [2], 4: [2], 5: [2, 4], 8: [4]}


def test_the_earliest_failing_cell_is_never_a_cascade():
    cells = _notebook()
    roots = d.cascade_roots(cells, _detail(cells))
    assert min(x["idx"] for x in _detail(cells)) not in roots


def test_a_definition_that_runs_is_not_a_root():
    """CS0103 on a name an upstream cell declares and RAN: that cell is not to blame."""
    cells = _notebook()
    cells[2] = _code(d._text(cells[2]["source"]).replace("new CpSolverParameters()", "0"))
    assert 3 not in d.cascade_roots(cells, _detail(cells))


# ---- a repair round --------------------------------------------------------------------
def _run_round(tmp_path, monkeypatch, cells, answer):
    nb = tmp_path / "nb.ipynb"
    nb.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                              "nbformat_minor": 5}), encoding="utf-8")
    prompts, executed = [], []

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
        executed.append(list(targets))
        return [{"cell": i, "ok": True} for i in targets]

    monkeypatch.setattr(d, "sk_call_retry", fake_retry)
    monkeypatch.setattr(d, "parse_or_repair", fake_parse)
    monkeypatch.setattr(d, "pm_call", fake_pm)
    monkeypatch.setattr(d, "start_kernel", fake_start)
    monkeypatch.setattr(d, "execute_cells", fake_exec)
    targets = [i for i, c in enumerate(cells) if c["cell_type"] == "code"]
    rec = {"execution": [{"cell": i, "ok": not cells[i]["outputs"]} for i in targets]}
    asyncio.run(d.repair_kernel_errors(None, None, SimpleNamespace(repair_rounds=1), rec, nb,
                                       "csharp", tmp_path, "k1", targets, None, ""))
    return (prompts, rec["repairs"][0], executed,
            json.loads(nb.read_text(encoding="utf-8"))["cells"])


def test_a_round_asks_the_root_and_holds_its_cascades(tmp_path, monkeypatch):
    answer = [{"idx": 2, "cell_type": "code",
               "source": "static (int[], string) EdgeColoringCpsat(Graphe g, int k) => "
                         "(new int[0], \"\");\nstatic string FormatSolverVerdict(int s) => \"\";"},
              {"idx": 7, "cell_type": "code", "source": "int z = 3;"},
              {"idx": 3, "cell_type": "code", "source": "var (col4, status4) = (1, 2);"}]
    prompts, r, executed, cells = _run_round(tmp_path, monkeypatch, _notebook(), answer)
    p = prompts[0]
    assert "### Cellule 2 (code)" in p and "CpSolverParameters" in p
    assert "### Cellule 7 (code)" in p                         # independent error: asked
    for held in (3, 4, 5, 8):
        assert f"### Cellule {held} (code)" not in p
    assert "CELLULES EN ATTENTE (3, 4, 5, 8)" in p
    assert ("- cellule 2 : doit continuer à définir EdgeColoringCpsat, FormatSolverVerdict "
            "(utilisés par les cellules 3, 4, 5)") in p
    assert "- cellule 4 :" not in p                             # a waiting cell is no root
    assert r["asked"] == 2 and r["deferred"] == [3, 4, 5, 8]
    assert r["replaced"] == [2, 7] and r["out_of_scope"] == [3]
    assert "".join(cells[3]["source"]).startswith("var (col4, status4) = EdgeColoringCpsat")
    assert executed == [[1, 2, 3, 4, 5, 6, 7, 8]]               # the held cells re-run


def test_without_a_failing_root_every_failing_cell_is_asked(tmp_path, monkeypatch):
    cells = _notebook()
    cells[2] = _code(d._text(cells[2]["source"]).replace("new CpSolverParameters()", "0"))
    cells[4] = _code(d._text(cells[4]["source"]))     # MobiusLadder's cell ran too
    answer = [{"idx": 3, "cell_type": "code", "source": "var (col4, status4) = (1, 2);"}]
    prompts, r, _, _ = _run_round(tmp_path, monkeypatch, cells, answer)
    assert "CELLULES EN ATTENTE" not in prompts[0]
    for asked in (3, 5, 7, 8):
        assert f"### Cellule {asked} (code)" in prompts[0]
    assert r["deferred"] == [] and r["asked"] == 4


def test_repair_prompt_without_deferred_is_unchanged():
    f = [{"idx": 1, "source": "x", "errors": "e", "cited": []}]
    assert d.repair_prompt(f, "", None, None) == d.repair_prompt(f, "", None, [])
    assert "EN ATTENTE" not in d.repair_prompt(f)


# ---- values: #27314 attempt 1 ----------------------------------------------------------
# Verbatim from live/runs/issue-27314.attempt1/nb_27314_built.ipynb (cells 19 and 22).
ERR_VOID = ("\r\n(47,37): error CS0023: Impossible d'appliquer l'opérateur '.' à un "
            "opérande de type 'void'\r\n\r\n")
ERR_VALUES = ("\r\n(40,36): error CS0103: Le nom 'ARCHIVE' n'existe pas dans le contexte "
              "actuel\r\n\r\n(40,45): error CS0103: Le nom 'CERTIFICAT' n'existe pas dans le "
              "contexte actuel\r\n\r\n")


def _values_notebook() -> list[dict]:
    """The #27314 shape, shrunk: cell 2 binds ARCHIVE and CERTIFICAT with `var` and fails
    on another line, cell 3 fails on both names, cell 4 fails on its own."""
    return [
        {"cell_type": "markdown", "metadata": {}, "source": "# Compression"},
        _code("var INDEX = new Dictionary<string, int>();\nvar OPS = new List<string>();"),
        _code("Dictionary<string, byte[]> Archiver(Dictionary<string, int> i, List<string> o)"
              " => new();\nvar ARCHIVE = Archiver(INDEX, OPS);\n"
              "var CERTIFICAT = new Dictionary<string, object>();\n"
              "var n = Console.WriteLine(\"x\").Length;", ERR_VOID),
        _code("var bilan = Banc(ARCHIVE, CERTIFICAT);", ERR_VALUES),
        _code("int z = Introuvable(3);", _cs0103("Introuvable")),
    ]


def test_source_cell_finds_bindings_and_defining_cell_stays_declarations_only():
    cells = _values_notebook()
    assert d.source_cell(cells, "ARCHIVE", before=3) == 2
    assert d.source_cell(cells, "CERTIFICAT", before=3) == 2
    assert d.source_cell(cells, "Archiver", before=3) == 2         # declarations still count
    assert d.defining_cell(cells, "ARCHIVE", before=3) is None     # frames name functions
    assert d.source_cell(cells, "ARCHIVE", before=2) is None       # only cells ABOVE


def test_a_value_bound_by_a_failing_cell_makes_a_cascade():
    cells = _values_notebook()
    assert d.cascade_roots(cells, _detail(cells)) == {3: [2]}


def test_reading_a_value_is_not_binding_it():
    """A failing cell that only READS `ARCHIVE` does not explain a CS0103 on it below."""
    cells = _values_notebook()
    cells[2] = _code("var n = ARCHIVE.Count;\nif (CERTIFICAT == null) { }", ERR_VOID)
    assert d.cascade_roots(cells, _detail(cells)) == {}


def test_a_value_bound_by_a_cell_that_ran_is_not_a_root():
    cells = _values_notebook()
    cells[2] = _code(d._text(cells[2]["source"]))
    assert d.cascade_roots(cells, _detail(cells)) == {}


def test_a_round_holds_a_cell_waiting_on_values(tmp_path, monkeypatch):
    answer = [{"idx": 2, "cell_type": "code",
               "source": "var ARCHIVE = new Dictionary<string, byte[]>();\n"
                         "var CERTIFICAT = new Dictionary<string, object>();"},
              {"idx": 4, "cell_type": "code", "source": "int z = 3;"}]
    prompts, r, executed, _ = _run_round(tmp_path, monkeypatch, _values_notebook(), answer)
    p = prompts[0]
    assert "### Cellule 2 (code)" in p and "### Cellule 4 (code)" in p
    assert "### Cellule 3 (code)" not in p
    assert "CELLULES EN ATTENTE (3)" in p
    assert ("- cellule 2 : doit continuer à définir ARCHIVE, CERTIFICAT "
            "(utilisés par les cellules 3)") in p
    assert r["asked"] == 2 and r["deferred"] == [3] and r["replaced"] == [2, 4]
    assert executed == [[1, 2, 3, 4]]
