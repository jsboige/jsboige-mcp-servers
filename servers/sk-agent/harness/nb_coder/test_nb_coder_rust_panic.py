#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ e94d5f4f3f036aa5f4b42060584f592b3e42e983
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_rust_panic.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Offline tests for the evcxr (Rust kernel) execution facts — MGS-25 #27133, 2026-11-20.

Two defects one run exposed: a Rust panic reaches the notebook ONLY as stderr text with
status "ok" (the harness recorded the cell as passed and the repair rounds never saw it),
and evcxr numbers its cells from 2 (the C.2 check demanded 1..N and failed a notebook
whose numbering matches CoursIA's accepted Sudoku-02-DancingLinks-Rust.ipynb)."""

import asyncio
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("nb_coder_driver", HERE / "nb_coder_driver.py")
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)

# Verbatim from live/runs/issue-27133-00084896/nb_27133_built.ipynb, cell 4 (ec=3).
MGS25_PANIC = (
    "\nthread '<unnamed>' (64040) panicked at src\\lib.rs:92:45:\n"
    "index out of bounds: the len is 36 but the index is 36\n"
    "stack backtrace:\n"
    "   0: __rustc::rust_begin_unwind\n"
    "             at /rustc/0ef1bc386059596dada8fb65b50425aab2ea637a/library/std\\src/panicking.rs:676:5\n"
    "   1: core::panicking::panic_fmt\n"
    "             at /rustc/0ef1bc386059596dada8fb65b50425aab2ea637a/library/core\\src/panicking.rs:80:14\n"
    "   2: core::panicking::panic_bounds_check\n"
    "             at /rustc/0ef1bc386059596dada8fb65b50425aab2ea637a/library/core\\src/panicking.rs:271:5\n"
    "   3: ctx::run_woa\n"
    "   4: run_user_code_2\n"
    "   5: <evcxr::runtime::Runtime>::run_loop\n"
    "   6: evcxr::runtime::runtime_hook\n"
    "   7: evcxr_jupyter::main\n"
    "note: Some details are omitted, run with `RUST_BACKTRACE=full` for a verbose backtrace.\n")


def _run_cells(monkeypatch, outputs: list, status: str = "ok") -> list[dict]:
    async def fake_pm_call(session, tool, payload):
        return {"status": status, "outputs": outputs, "error_outputs_persisted": True}

    monkeypatch.setattr(D, "pm_call", fake_pm_call)
    return asyncio.run(D.execute_cells(object(), Path("scratch.ipynb"), "k1", [4]))


def test_stderr_panic_fails_the_cell_with_status_ok(monkeypatch):
    res = _run_cells(monkeypatch, [{"output_type": "stream", "name": "stderr",
                                    "text": MGS25_PANIC}])
    assert res[0]["status"] == "ok"
    assert res[0]["ok"] is False, "a Rust panic is a failed cell whatever the status says"
    assert res[0]["error"].startswith("thread '<unnamed>' (64040) panicked at")
    assert "index out of bounds" in res[0]["error"]


def test_panic_split_across_stderr_chunks_is_still_seen(monkeypatch):
    """evcxr flushes stderr in pieces (16 stream outputs on MGS-25's cell)."""
    chunks = [{"output_type": "stream", "name": "stderr", "text": line}
              for line in MGS25_PANIC.splitlines(keepends=True)]
    res = _run_cells(monkeypatch, chunks)
    assert res[0]["ok"] is False
    assert res[0]["error"].startswith("thread '<unnamed>'")


def test_stderr_warning_without_panic_keeps_the_cell_ok(monkeypatch):
    res = _run_cells(monkeypatch, [
        {"output_type": "stream", "name": "stderr",
         "text": "warning: unused variable: `x`\n --> src/lib.rs:3:9\n"},
        {"output_type": "stream", "name": "stdout", "text": "36 itérations\n"}])
    assert res[0]["ok"] is True and res[0]["error"] is None


def test_panic_text_printed_on_stdout_is_not_a_failure(monkeypatch):
    """A cell that PRINTS about panics (a course on error handling) is not one."""
    res = _run_cells(monkeypatch, [{"output_type": "stream", "name": "stdout",
                                    "text": MGS25_PANIC}])
    assert res[0]["ok"] is True and res[0]["error"] is None


def test_error_output_still_wins_over_stderr(monkeypatch):
    res = _run_cells(monkeypatch, [
        {"output_type": "error", "ename": "Error", "evalue": "E0425", "text": "E0425 x"},
        {"output_type": "stream", "name": "stderr", "text": MGS25_PANIC}], status="error")
    assert res[0]["ok"] is False and res[0]["error"] == "E0425 x"


def test_rust_panic_text_is_empty_without_a_panic():
    assert D.rust_panic_text([]) == ""
    assert D.rust_panic_text(None) == ""
    assert D.rust_panic_text([{"output_type": "stream", "name": "stderr",
                               "text": "panicked at nothing"}]) == ""


def test_frame_names_from_an_evcxr_backtrace_keep_user_code_only():
    assert D.error_frame_names(MGS25_PANIC) == ["run_woa"]


def test_frame_names_from_evcxr_methods_and_closures():
    trace = ("   3: <ctx::Swarm>::step\n"
             "   4: ctx::run_woa::{{closure}}\n"
             "   5: ctx::Grid::cell_at\n")
    assert D.error_frame_names(trace) == ["step", "run_woa", "cell_at"]


def test_counts_contiguous_accepts_the_kernel_start():
    assert D.counts_contiguous([1, 2, 3]) is True
    assert D.counts_contiguous([2, 3, 4, 5]) is True   # evcxr
    assert D.counts_contiguous([]) is True


def test_counts_contiguous_refuses_gaps_nulls_and_bad_starts():
    assert D.counts_contiguous([2, 4, 5]) is False
    assert D.counts_contiguous([1, 2, 2]) is False
    assert D.counts_contiguous([3, 2]) is False
    assert D.counts_contiguous([None, 2]) is False
    assert D.counts_contiguous([2, None]) is False
    assert D.counts_contiguous([0, 1]) is False
    assert D.counts_contiguous([True, 2]) is False


def _scratch(tmp_path: Path, counts: list) -> Path:
    cells = [{"cell_type": "markdown", "metadata": {}, "source": "# T"}]
    cells += [{"cell_type": "code", "metadata": {}, "source": f"let x{i} = {i};",
               "execution_count": c, "outputs": []} for i, c in enumerate(counts)]
    p = tmp_path / "s.ipynb"
    p.write_text(json.dumps({"cells": cells, "metadata": {}, "nbformat": 4,
                             "nbformat_minor": 5}), encoding="utf-8")
    return p


def test_verdict_accepts_evcxr_numbering(tmp_path):
    """MGS-25 #27133: counts [2..10] were failed as counts-broken."""
    rec = {"execution": [{"cell": 1, "ok": True}]}
    D.execution_verdict(rec, _scratch(tmp_path, list(range(2, 11))))
    assert rec["c2"]["sequential"] is True
    assert rec["verdict"] == "built-executed-ok"


def test_verdict_still_breaks_on_a_gap(tmp_path):
    rec = {"execution": [{"cell": 1, "ok": True}]}
    D.execution_verdict(rec, _scratch(tmp_path, [2, 3, 5]))
    assert rec["verdict"] == "built-executed-counts-broken"


def test_verdict_fails_on_a_stderr_panic_end_to_end(monkeypatch, tmp_path):
    res = _run_cells(monkeypatch, [{"output_type": "stream", "name": "stderr",
                                    "text": MGS25_PANIC}])
    rec = {"execution": res}
    D.execution_verdict(rec, _scratch(tmp_path, [2, 3, 4]))
    assert rec["verdict"] == "built-execution-failed"


# ---- the shape execute_on_kernel really answers (kernel_service.py:249-251) ----------
# Verbatim from live/runs/issue-27302-dffc7835/issue-27302.json, cell 10 outputs_tail.
WIRE_CS0246 = [
    {"output_type": "stream", "content": {"name": "stderr", "text": (
        "\r\n(27,18): error CS0246: Le nom de type ou d'espace de noms "
        "'CpSolverParameters' est introuvable (vous manque-t-il une directive using ou une "
        "référence d'assembly\xa0?)\r\n\r\n")}, "metadata": None, "execution_count": None},
    {"output_type": "error", "content": {"ename": "Error", "evalue": "compilation error",
                                         "traceback": []},
     "metadata": None, "execution_count": None}]


def _wire(name: str, text: str) -> dict:
    return {"output_type": "stream", "content": {"name": name, "text": text},
            "metadata": None, "execution_count": None}


def test_wire_stderr_panic_fails_the_cell(monkeypatch):
    """#518 read `name`/`text` at the top level: deaf to every live stream."""
    res = _run_cells(monkeypatch, [_wire("stderr", MGS25_PANIC)])
    assert res[0]["ok"] is False
    assert res[0]["error"].startswith("thread '<unnamed>' (64040) panicked at")


def test_wire_panic_split_across_chunks(monkeypatch):
    res = _run_cells(monkeypatch, [_wire("stderr", line)
                                   for line in MGS25_PANIC.splitlines(keepends=True)])
    assert res[0]["ok"] is False


def test_wire_stdout_panic_text_and_stderr_warning_stay_ok(monkeypatch):
    res = _run_cells(monkeypatch, [_wire("stdout", MGS25_PANIC),
                                   _wire("stderr", "warning: unused variable: `x`\n")])
    assert res[0]["ok"] is True and res[0]["error"] is None


def test_wire_dotnet_compile_error_is_recorded(monkeypatch):
    """#27302: every failed cell recorded `error: null`."""
    res = _run_cells(monkeypatch, WIRE_CS0246, status="error")
    assert res[0]["ok"] is False
    assert res[0]["error"] == "Error: compilation error"


def test_wire_output_flattens_only_streams_and_errors():
    assert D.wire_output(WIRE_CS0246[0])["name"] == "stderr"
    assert D.wire_output(WIRE_CS0246[1])["evalue"] == "compilation error"
    rich = {"output_type": "execute_result", "content": {"text/plain": "3"}}
    assert D.wire_output(rich) is rich
    nbf = {"output_type": "stream", "name": "stdout", "text": "x"}
    assert D.wire_output(nbf) is nbf
    assert D.wire_output("raw") == "raw"
