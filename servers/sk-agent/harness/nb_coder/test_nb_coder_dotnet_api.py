#!/usr/bin/env python3
"""Offline tests for .NET API grounding of repair and revision rounds — 2026-11-22.

ICT-15 C# salvage (CoursIA#27735/27736/27740/27741): every grain died built-execution-failed
on ScottPlot 5 members the model remembered from another version, and four repair rounds
per grain re-invented a new name each time — the compiler names the member that is
missing, never the ones that exist. A .NET repair round now quotes the real API, read by
reflection on the kernel that compiled the cells (`dotnet_api_block`).

The diagnostic texts are verbatim from the built notebooks of runs issue-27735-6fed009b,
issue-27736-6d9bb4d2, issue-27740-f0a23f87 and issue-27741-70c1602f (stderr streams); the
probe output below is verbatim from a live run of the driver's own probe on a fresh
`.net-csharp` kernel against ScottPlot 5.0.55 (22/11)."""

import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
d = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(d)

# Verbatim (runs above, stderr stream of the failing cell).
CS1061_HEATMAP = ("(26,9): error CS1061: 'Heatmap' ne contient pas de définition pour "
                  "'ColorScale' et aucune méthode d'extension accessible 'ColorScale' acceptant "
                  "un premier argument de type 'Heatmap' n'a été trouvée (une directive using "
                  "ou une référence d'assembly est-elle manquante ?)")
CS0117_LINESTYLE = "(12,5): error CS0117: 'LineStyle' ne contient pas de définition pour 'Dash'"
CS0234_CUSTOM = ("(8,1): error CS0234: Le nom de type ou d'espace de noms 'Custom' n'existe pas "
                 "dans l'espace de noms 'ScottPlot.TickGenerators' (vous manque-t-il une "
                 "référence d'assembly ?)")
CS7036_GETIMAGE = ("(30,1): error CS7036: Parmi les arguments spécifiés, aucun ne correspond au "
                   "paramètre obligatoire 'width' de 'Plot.GetImage(int, int)'")
CS1061_GRID_EN = ("(4,10): error CS1061: 'DefaultGrid' does not contain a definition for "
                  "'AddSubplot' and no accessible extension method 'AddSubplot' accepting a "
                  "first argument of type 'DefaultGrid' could be found")
CS0246_TICK = ("(5,1): error CS0246: Le nom de type ou d'espace de noms 'NumericTick' est "
               "introuvable (vous manque-t-il une directive using ou une référence d'assembly ?)")
CS1729_BAR = "(6,1): error CS1729: 'Bar' ne contient pas de constructeur qui accepte des arguments 3"
CS0200_TICKS = ("(7,1): error CS0200: Impossible d'assigner la propriété ou l'indexeur "
                "'ITickGenerator.Ticks' -- il est en lecture seule")

# Verbatim excerpt of the live probe output (driver probe, fresh kernel, ScottPlot 5.0.55).
PROBE_OUT = """@@ Heatmap.ColorScale
type ScottPlot.Plottables.Heatmap — membres publics (l'erreur cite `ColorScale`) :
  IColormap Colormap { get; set; }
  voisin : type ScottPlot.Color
autres membres de Heatmap :
  void Update()
@@ LineStyle.Dash
type ScottPlot.LineStyle — membres publics (l'erreur cite `Dash`) :
  voisin : LinePattern.Dashed — static LinePattern Dashed { get; }
  voisin : LinePattern.DenselyDashed — static LinePattern DenselyDashed { get; }
@@ Plot.GetImage(…)
type ScottPlot.Plot — surcharges de GetImage :
  Image GetImage(int width, int height)
"""


def _code(src: str, stderr: list[str] | None = None) -> dict:
    c = {"cell_type": "code", "metadata": {}, "source": src, "execution_count": None,
         "outputs": []}
    if stderr:
        c["outputs"] = [{"name": "stderr", "output_type": "stream",
                         "text": "\r\n" + "\r\n\r\n".join(stderr) + "\r\n"},
                        {"ename": "Error", "evalue": "compilation error",
                         "output_type": "error", "traceback": []}]
    return c


def _cache(tmp_path: Path, versions: dict[str, list[str]]) -> Path:
    root = tmp_path / "nuget"
    for pid, vers in versions.items():
        for v in vers:
            (root / pid / v / "lib" / "net8.0").mkdir(parents=True)
    return root


# ---- diagnostics -> queries --------------------------------------------------------------

def test_every_measured_diagnostic_class_becomes_a_query():
    errs = [CS1061_HEATMAP, CS0117_LINESTYLE, CS0234_CUSTOM, CS7036_GETIMAGE, CS1729_BAR,
            CS0200_TICKS]
    assert d.dotnet_api_queries(errs, []) == [
        ("member", "Heatmap", "ColorScale"), ("member", "LineStyle", "Dash"),
        ("ns", "ScottPlot.TickGenerators", "Custom"), ("call", "Plot", "GetImage"),
        ("call", "Bar", "Bar"), ("member", "ITickGenerator", "Ticks")]


def test_english_diagnostics_and_missing_types_are_read_too():
    assert d.dotnet_api_queries([CS1061_GRID_EN, CS0246_TICK], []) == [
        ("member", "DefaultGrid", "AddSubplot"), ("type", "", "NumericTick")]
    overload = "(2,1): error CS1501: No overload for method 'GetImage' takes 0 arguments"
    assert d.dotnet_api_queries([overload], []) == [("call", "", "GetImage")]


def test_duplicates_collapse_and_the_count_is_capped():
    # the same cell reports the same error twice (run issue-27735, cell 16)
    assert d.dotnet_api_queries([CS1061_HEATMAP + "\n" + CS1061_HEATMAP], []) == [
        ("member", "Heatmap", "ColorScale")]
    many = [f"(1,1): error CS0117: 'LineStyle' ne contient pas de définition pour 'M{i}'"
            for i in range(10)]
    assert len(d.dotnet_api_queries(many, [])) == d.DOTNET_API_MAX_QUERIES


def test_names_the_notebook_declares_and_keyword_types_are_never_probed():
    cells = [_code("public class Simplex { public int Dim; }")]
    own = "(3,1): error CS1061: 'Simplex' does not contain a definition for 'Faces' and no"
    kw = "(3,1): error CS1061: 'double' ne contient pas de définition pour 'Clamp' et aucune"
    generic = "(3,1): error CS1061: 'List<double>' does not contain a definition for 'Mean'"
    assert d.dotnet_api_queries([own, kw], cells) == []
    assert d.dotnet_api_queries([generic], cells) == [("member", "List", "Mean")]


def test_runtime_errors_and_ansi_never_yield_queries():
    assert d.dotnet_api_queries(["System.InvalidOperationException: Sequence contains no "
                                 "elements"], []) == []
    assert d.dotnet_api_queries(["\x1b[31m" + CS0117_LINESTYLE + "\x1b[0m"], []) == [
        ("member", "LineStyle", "Dash")]


# ---- what the probe loads --------------------------------------------------------------

def test_load_paths_pick_the_declared_version_in_the_nuget_cache(tmp_path):
    root = _cache(tmp_path, {"scottplot": ["5.0.47", "5.0.55", "5.1.0-beta"],
                             "mathnet.numerics": ["5.0.0"]})
    cells = [_code('#r "nuget: ScottPlot, 5.0.55"\n#r "nuget: MathNet.Numerics"\n'
                   '#r "nuget: Absent.Package, 1.0.0"\n#r "Local.dll"')]
    assert d.nuget_load_paths(cells, root) == [str(root / "scottplot" / "5.0.55"),
                                               str(root / "mathnet.numerics" / "5.0.0"),
                                               "Local.dll"]


def test_a_wildcard_or_missing_version_takes_the_highest_stable(tmp_path):
    root = _cache(tmp_path, {"scottplot": ["5.0.47", "5.0.55", "5.1.0-beta", "4.1.9"]})
    for ref in ('#r "nuget: ScottPlot, 5.*"', '#r "nuget: ScottPlot"'):
        assert d.nuget_load_paths([_code(ref)], root) == [str(root / "scottplot" / "5.0.55")]
    assert d.nuget_load_paths([_code('#r "nuget: ScottPlot, 4.*"')], root) == [
        str(root / "scottplot" / "4.1.9")]
    assert d.nuget_load_paths([_code('#r "nuget: ScottPlot, 9.9.9"')], root) == []


# ---- the probe code ------------------------------------------------------------------------

def test_values_are_spliced_as_verbatim_literals_that_cannot_close_early():
    code = d.dotnet_probe_code([("member", 'Evil"Type', "X")], [r"C:\p\a"])
    assert '@"Evil""Type"' in code and r'@"C:\p\a"' in code
    assert "/*QUERIES*/" not in code and "/*LOADS*/" not in code
    assert code.startswith("{") and code.rstrip().endswith("}")


def test_a_fresh_kernel_replays_the_notebooks_package_lines_first():
    cells = [_code('#r "nuget: ScottPlot, 5.0.55"\nusing ScottPlot;'),
             _code('#r "nuget: ScottPlot, 5.0.55"\nvar p = new Plot();')]
    refs = d.nuget_ref_lines(cells)
    assert refs == ['#r "nuget: ScottPlot, 5.0.55"']
    code = d.dotnet_probe_code([("member", "Plot", "X")], ["x"], refs)
    assert code.startswith('#r "nuget: ScottPlot, 5.0.55"\n{')
    assert not d.dotnet_probe_code([("member", "Plot", "X")], ["x"]).startswith("#r")


def test_each_diagnostic_keeps_its_share_of_the_cap():
    big = "@@ A.B\n" + "\n".join(f"  member line {i:03d} padding padding" for i in range(200))
    text = big + "\n@@ C.D\n  real answer for C\n@@ E.F\n  real answer for E\n"
    out = d.cap_probe_sections(text, cap=1500)
    assert "@@ A.B" in out and "@@ C.D" in out and "@@ E.F" in out
    assert "real answer for C" in out and "real answer for E" in out
    assert "[… section tronquée …]" in out and len(out) < 1500 + 200
    assert d.cap_probe_sections("@@ X\n  short\n") == "@@ X\n  short\n"


# ---- the async probe ----------------------------------------------------------------------

def _fake_pm(stdout: str, calls: list):
    async def fake_pm_call(pm, tool, payload):
        calls.append((tool, payload))
        if tool == "execute_on_kernel" and payload.get("mode") == "code":
            return {"status": "ok", "outputs": [
                {"output_type": "stream", "content": {"name": "stdout", "text": stdout}}]}
        return {}
    return fake_pm_call


def test_the_block_quotes_the_kernel_reflection_under_its_own_heading(tmp_path, monkeypatch):
    root = _cache(tmp_path, {"scottplot": ["5.0.55"]})
    calls: list = []
    monkeypatch.setattr(d, "pm_call", _fake_pm(PROBE_OUT, calls))
    cells = [_code('#r "nuget: ScottPlot, 5.0.55"\nvar hm = plt.Add.Heatmap(m);',
                   [CS1061_HEATMAP])]
    block, info = asyncio.run(d.dotnet_api_block(None, "k1", cells, [CS1061_HEATMAP], root))
    assert block.startswith(d.DOTNET_API_HEAD) and "IColormap Colormap { get; set; }" in block
    assert "scottplot 5.0.55" in block
    assert info == {"kind": "dotnet", "queries": 1, "packages": ["scottplot 5.0.55"],
                    "chars": len(PROBE_OUT.strip())}
    (tool, payload), = calls
    assert tool == "execute_on_kernel" and payload["mode"] == "code"
    assert payload["kernel_id"] == "k1" and payload["timeout"] == d.DOTNET_PROBE_TIMEOUT_S
    assert '(@"member", @"Heatmap", @"ColorScale")' in payload["code"]
    assert not payload["code"].startswith("#r")          # live kernel: no replay


def test_nothing_to_ask_or_nothing_printed_gives_no_block(tmp_path, monkeypatch):
    root = _cache(tmp_path, {"scottplot": ["5.0.55"]})
    calls: list = []
    monkeypatch.setattr(d, "pm_call", _fake_pm("", calls))
    cells = [_code('#r "nuget: ScottPlot, 5.0.55"')]
    assert asyncio.run(d.dotnet_api_block(None, "k1", cells, ["Sequence contains no elements"],
                                          root)) == ("", {})
    assert calls == []
    block, info = asyncio.run(d.dotnet_api_block(None, "k1", cells, [CS0117_LINESTYLE], root))
    assert block == "" and "empty" in info and len(calls) == 1
    no_pkg = asyncio.run(d.dotnet_api_block(None, "k1", [_code("var x = 1;")],
                                            [CS0117_LINESTYLE], root))
    assert no_pkg == ("", {"kind": "dotnet", "queries": 1, "skipped": "no-package"})
    assert asyncio.run(d.dotnet_api_block(None, None, cells, [CS0117_LINESTYLE], root)) == ("", {})


def test_a_timed_out_cell_is_never_probed_and_a_crash_never_escapes(tmp_path, monkeypatch):
    nb = tmp_path / "nb.ipynb"
    nb.write_text(json.dumps({"cells": [_code("x", [CS0117_LINESTYLE])], "metadata": {},
                              "nbformat": 4, "nbformat_minor": 5}), encoding="utf-8")
    calls: list = []
    monkeypatch.setattr(d, "pm_call", _fake_pm(PROBE_OUT, calls))
    timed = [{"cell": 0, "ok": False, "status": "timeout"}]
    assert asyncio.run(d.dotnet_ground_execution(None, "k1", nb, timed)) is None
    assert asyncio.run(d.dotnet_ground_execution(None, "k1", nb, [{"cell": 0, "ok": True}])) is None
    assert calls == []

    async def boom(*a, **k):
        raise RuntimeError("kernel gone")

    monkeypatch.setattr(d, "dotnet_api_block", boom)
    g = asyncio.run(d.dotnet_ground_execution(None, "k1", nb,
                                              [{"cell": 0, "ok": False, "status": "error"}]))
    assert g == {"cells": [0], "block": "",
                 "info": {"kind": "dotnet", "error": "RuntimeError: kernel gone"}}


# ---- the prompts ---------------------------------------------------------------------------

def test_the_repair_prompt_takes_the_dotnet_block_without_the_crate_heading():
    failing = [{"idx": 1, "source": "x", "errors": CS0117_LINESTYLE}]
    block = d.DOTNET_API_HEAD + " — réflexion…\n" + PROBE_OUT
    p = d.repair_prompt(failing, "", None, None, block)
    assert "LinePattern.Dashed" in p and d.DOTNET_API_HEAD in p
    assert "API RÉELLE DES CRATES" not in p
    assert "API RÉELLE DES CRATES" in d.repair_prompt(failing, "", None, None, "pub fn x()")


def test_the_revision_prompt_carries_the_block_before_the_findings():
    issue = {"title": "T", "body": "B"}
    f = [{"cell": 1, "severity": "major", "detail": "échec d'EXÉCUTION"}]
    block = d.DOTNET_API_HEAD + " — réflexion…\n" + PROBE_OUT
    p = d.revision_prompt(issue, "view", f, api_block=block)
    assert p.index(d.DOTNET_API_HEAD) < p.index("## Constats du vérificateur")
    assert d.DOTNET_API_HEAD not in d.revision_prompt(issue, "view", f)


# ---- the repair round ----------------------------------------------------------------------

def _round(tmp_path, monkeypatch, kname, after_ok, status="error"):
    tmp_path.mkdir(parents=True, exist_ok=True)
    pkg = str(tmp_path / "nuget" / "scottplot" / "5.0.55")
    monkeypatch.setattr(d, "nuget_load_paths", lambda cells, r=None: [pkg])
    cells = [{"cell_type": "markdown", "metadata": {}, "source": "# ICT-15c"},
             _code('#r "nuget: ScottPlot, 5.0.55"\nusing ScottPlot;'),
             _code("var ls = LineStyle.Dash;", [CS0117_LINESTYLE])]
    nb = tmp_path / "nb.ipynb"
    nb.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                              "nbformat_minor": 5}), encoding="utf-8")
    prompts, calls = [], []

    async def fake_retry(sk, args, rec, stage, prompt, conv, max_tokens=None):
        prompts.append(prompt)
        return {"conversation_id": "c1"}

    async def fake_parse(sk, args, rec, stage, env, conv, max_tokens=None):
        return {"cells": [{"idx": 2, "cell_type": "code",
                           "source": "var ls = LinePattern.Dashed;"}]}, env

    async def fake_start(pm, kname, exec_dir):
        return "k2"

    async def fake_exec(pm, path, kid, targets):
        # the real execution persists the failing cell's diagnostics into the notebook
        if not after_ok:
            nbj = json.loads(path.read_text(encoding="utf-8"))
            nbj["cells"][2]["outputs"] = _code("", [CS0117_LINESTYLE])["outputs"]
            path.write_text(json.dumps(nbj), encoding="utf-8")
        return [{"cell": i, "ok": after_ok or i != 2, "status": "ok" if after_ok or i != 2
                 else "error"} for i in targets]

    monkeypatch.setattr(d, "sk_call_retry", fake_retry)
    monkeypatch.setattr(d, "parse_or_repair", fake_parse)
    monkeypatch.setattr(d, "pm_call", _fake_pm(PROBE_OUT, calls))
    monkeypatch.setattr(d, "start_kernel", fake_start)
    monkeypatch.setattr(d, "execute_cells", fake_exec)
    rec = {"execution": [{"cell": 1, "ok": True, "status": "ok"},
                         {"cell": 2, "ok": False, "status": status}]}
    asyncio.run(d.repair_kernel_errors(None, None, SimpleNamespace(repair_rounds=1), rec, nb,
                                       kname, tmp_path, "k1", [1, 2], None, ""))
    probes = [p for t, p in calls if t == "execute_on_kernel" and p.get("mode") == "code"]
    return prompts, rec, probes


def test_a_dotnet_round_is_grounded_on_the_live_kernel(tmp_path, monkeypatch):
    prompts, rec, probes = _round(tmp_path, monkeypatch, ".net-csharp", after_ok=True)
    assert d.DOTNET_API_HEAD in prompts[0] and "LinePattern.Dashed" in prompts[0]
    assert "API RÉELLE DES CRATES" not in prompts[0]
    assert probes[0]["kernel_id"] == "k1"                 # the kernel that compiled the cell
    assert rec["repairs"][0]["crate_api"]["kind"] == "dotnet"
    assert len(probes) == 1 and "dotnet_api_last" not in rec   # repaired: nothing left


def test_cells_still_failing_after_the_rounds_are_probed_for_the_revision(tmp_path, monkeypatch):
    prompts, rec, probes = _round(tmp_path, monkeypatch, ".net-csharp", after_ok=False)
    assert [p["kernel_id"] for p in probes] == ["k1", "k2"]     # round, then the final state
    assert rec["dotnet_api_last"]["cells"] == [2]
    assert rec["dotnet_api_last"]["block"].startswith(d.DOTNET_API_HEAD)


def test_other_kernels_and_timeouts_are_never_probed(tmp_path, monkeypatch):
    prompts, rec, probes = _round(tmp_path, monkeypatch, "python3", after_ok=False)
    assert probes == [] and d.DOTNET_API_HEAD not in prompts[0]
    prompts, rec, probes = _round(tmp_path / "t", monkeypatch, ".net-csharp", after_ok=True,
                                  status="timeout")
    assert probes == [] and rec["repairs"][0]["crate_api"] is None


# ---- the revision round ---------------------------------------------------------------------

def test_the_revision_reuses_a_matching_probe_and_starts_a_kernel_otherwise(tmp_path, monkeypatch):
    nb = tmp_path / "nb.ipynb"
    nb.write_text(json.dumps({"cells": [_code('#r "nuget: ScottPlot, 5.0.55"'),
                                        _code("x", [CS0117_LINESTYLE])], "metadata": {},
                              "nbformat": 4, "nbformat_minor": 5}), encoding="utf-8")
    monkeypatch.setattr(d, "nuget_load_paths", lambda cells, r=None: ["C:/nuget/scottplot/5.0.55"])
    calls: list = []
    monkeypatch.setattr(d, "pm_call", _fake_pm(PROBE_OUT, calls))
    started = []

    async def fake_start(pm, kname, exec_dir):
        started.append(kname)
        return "kp"

    monkeypatch.setattr(d, "start_kernel", fake_start)
    execution = [{"cell": 0, "ok": True, "status": "ok"},
                 {"cell": 1, "ok": False, "status": "error"}]
    # same failing cells as the last repair probe: reused, no kernel
    rec = {"execution": execution, "dotnet_api_last": {"cells": [1], "block": "B", "info": {}}}
    entry: dict = {}
    assert asyncio.run(d.revision_dotnet_api(None, rec, ".net-csharp", tmp_path, nb, entry)) == "B"
    assert started == [] and calls == []
    # a --revise-from resume (nothing probed in this process): a kernel for the probe alone
    rec = {"execution": execution}
    entry = {}
    block = asyncio.run(d.revision_dotnet_api(None, rec, ".net-csharp", tmp_path, nb, entry))
    assert block.startswith(d.DOTNET_API_HEAD) and started == [".net-csharp"]
    code = [p for t, p in calls if t == "execute_on_kernel"][0]["code"]
    assert code.startswith('#r "nuget: ScottPlot, 5.0.55"')     # fresh kernel: replay
    assert ("manage_kernel", {"action": "stop", "kernel_id": "kp"}) in calls
    assert entry["dotnet_api"]["fresh"] is True and rec["dotnet_api_last"]["cells"] == [1]
