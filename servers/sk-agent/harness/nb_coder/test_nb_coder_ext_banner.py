# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_ext_banner.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Regression pins for the kernel extension-banner strip (21/11, po-2028 batch w3e2).

The .NET kernel prints `Loading extensions from <C:\\Users\\<user>\\.nuget\\…>` as a
display output each time ScottPlot/SkiaSharp loads. The machine-path gate refused it in 5
of 6 C# grains and the repair rounds could not remove it (it is a kernel output, not a
cell source). The harness now drops that output before the gates and before delivery;
a line the MODEL writes (a stream, or mixed content) still faces the gate.

Skipped when `mcp` is not importable (the driver imports the MCP client at load).
"""
import importlib.util
import json
from pathlib import Path

import pytest

pytest.importorskip("mcp")

_DRV = Path(__file__).resolve().parent / "nb_coder_driver.py"
_spec = importlib.util.spec_from_file_location("nbcd_ext_banner", _DRV)
nbcd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nbcd)

WIN = ("Loading extensions from `C:\\Users\\someone\\.nuget\\packages\\skiasharp\\2.88.9\\"
       "interactive-extensions\\dotnet\\SkiaSharp.DotNet.Interactive.dll`")
CANON = ("Loading extensions from `/root/.nuget/packages/skiasharp/2.88.9/"
         "interactive-extensions/dotnet/SkiaSharp.DotNet.Interactive.dll`")


def _disp(text, mime="text/plain", otype="display_data"):
    o = {"output_type": otype, "data": {mime: text}, "metadata": {}}
    if otype == "execute_result":
        o["execution_count"] = 1
    return o


def _stream(text):
    return {"output_type": "stream", "name": "stdout", "text": text}


def _nb(path, cells):
    path.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                                "nbformat_minor": 5}), encoding="utf-8")
    return path


def _code(outputs):
    return {"cell_type": "code", "source": "#r \"nuget: ScottPlot\"", "metadata": {},
            "execution_count": 1, "outputs": outputs}


def test_banner_outputs_dropped_other_outputs_kept(tmp_path):
    nb = _nb(tmp_path / "b.ipynb", [
        _code([_disp([WIN]), _disp("Installed ScottPlot, 5.0.0"), _stream("ok\n")]),
        _code([_disp(CANON, otype="execute_result"),
               _disp(f"<div>{WIN.replace('`', '<code>', 1)}</div>", mime="text/html")]),
        {"cell_type": "markdown", "source": WIN, "metadata": {}},
    ])
    rep = nbcd.strip_kernel_extension_banner(nb)
    assert rep == {"ok": True, "removed": [{"cell": 0, "outputs": 1},
                                           {"cell": 1, "outputs": 2}]}
    cells = json.loads(nb.read_text(encoding="utf-8"))["cells"]
    assert [o["data"]["text/plain"] for o in cells[0]["outputs"][:1]] == ["Installed ScottPlot, 5.0.0"]
    assert cells[0]["outputs"][1]["output_type"] == "stream"
    assert cells[1]["outputs"] == []               # execute_result and html-wrapped forms too
    assert cells[2]["source"] == WIN               # markdown never touched


def test_model_written_lines_still_face_the_gate(tmp_path):
    # a stream (Console.WriteLine) or a display mixing the notice with content is NOT the
    # kernel's notice: left in place, so machine-path keeps judging it
    nb = _nb(tmp_path / "b.ipynb", [
        _code([_stream(WIN + "\n")]),
        _code([_disp([WIN + "\n", "and C:\\Users\\someone\\data.csv\n"])]),
        _code([_disp(WIN), ]),
    ])
    nb_obj = json.loads(nb.read_text(encoding="utf-8"))
    nb_obj["cells"][2]["outputs"][0]["data"]["image/png"] = "iVBOR"
    nb.write_text(json.dumps(nb_obj), encoding="utf-8")
    assert nbcd.strip_kernel_extension_banner(nb)["removed"] == []
    gates = nbcd.run_gates(nb, nb, create_mode=True)        # src == built: delta empty
    built = [g for g in gates if g["gate"] == "machine-path"][0]["detail"]["build_hits"]
    assert built == [0, 1, 2]


def test_gate_passes_after_strip(tmp_path):
    src = _nb(tmp_path / "src.ipynb", [{"cell_type": "markdown", "source": "# T", "metadata": {}}])
    built = _nb(tmp_path / "built.ipynb", [{"cell_type": "markdown", "source": "# T",
                                            "metadata": {}}, _code([_disp([WIN])])])
    before = [g for g in nbcd.run_gates(src, built, create_mode=True)
              if g["gate"] == "machine-path"][0]
    assert before["ok"] is False and before["detail"]["cells"] == [1]
    nbcd.strip_kernel_extension_banner(built)
    after = [g for g in nbcd.run_gates(src, built, create_mode=True)
             if g["gate"] == "machine-path"][0]
    assert after["ok"] is True


def test_no_banner_no_rewrite(tmp_path):
    nb = _nb(tmp_path / "b.ipynb", [_code([_stream("x\n")])])
    before = nb.read_bytes()
    assert nbcd.strip_kernel_extension_banner(nb) == {"ok": True, "removed": []}
    assert nb.read_bytes() == before


def test_unreadable_notebook_is_declared(tmp_path):
    nb = tmp_path / "b.ipynb"
    nb.write_text("{not json", encoding="utf-8")
    rep = nbcd.strip_kernel_extension_banner(nb)
    assert rep["ok"] is False and "JSONDecodeError" in rep["error"]
