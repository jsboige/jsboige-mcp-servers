"""Portability contract for the mutualised nb_coder / nb_audit harness (roo-extensions #4781).

The guard these tests carry: the copy must run on a checkout that is not the original seat,
with no model reachable and no d:/roo-extensions tree at the paths the original seat keeps.
Every path the harness resolves must come from the environment, from the sibling layout it
lives in, or from a documented legacy fallback.

The harness modules import `mcp` at module level; this server's requirements.txt installs it,
so the suite runs on the same interpreter as the other sk-agent tests.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = HERE / "harness"
SHA = "7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ------------------------------------------------------------------ path resolution
def test_nb_audit_driver_resolves_the_sibling_sk_agent():
    m = _load("harness_nb_audit_driver", HARNESS / "nb_audit" / "nb_audit_driver.py")
    assert m.SK_DIR.resolve() == HERE
    assert m.SK_PY == HERE / "venv/Scripts/python.exe"
    assert m.SK_CONFIG == HERE / "sk_agent_config.json"


def test_nb_audit_runner_resolves_the_sibling_sk_agent():
    m = _load("harness_nb_audit_runner", HARNESS / "nb_audit" / "nb_audit_runner.py")
    assert m.SK_PY == HERE / "venv/Scripts/python.exe"


def test_nb_audit_env_override_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("NB_AUDIT_SK_DIR", str(tmp_path))
    m = _load("harness_nb_audit_driver_env", HARNESS / "nb_audit" / "nb_audit_driver.py")
    assert m.SK_DIR == tmp_path
    assert m.SK_PY == tmp_path / "venv/Scripts/python.exe"


def test_nb_coder_driver_resolves_the_sibling_tree():
    m = _load("harness_nb_coder_driver", HARNESS / "nb_coder" / "nb_coder_driver.py")
    assert m.SK_DIR.resolve() == HERE
    # not inside the jsboige/vllm fork here, so the derived defaults anchor on the harness
    assert Path(m.VLLM_ROOT) == HARNESS / "nb_coder"
    assert Path(m.PM_CWD).resolve() == (HERE.parent / "jupyter-papermill-mcp-server").resolve()


# ------------------------------------------------------------------ writer contract
def test_nb_coder_writer_keeps_list_of_lines(tmp_path):
    """CoursIA convention: a cell source is a list of lines. A str written back reformats the
    whole cell and inflates every harness diff (CR CoursIA 14/11, point 1a)."""
    m = _load("harness_nb_coder_writer", HARNESS / "nb_coder" / "nb_coder_driver.py")
    nb = {
        "cells": [
            {"cell_type": "markdown", "id": "aaa", "metadata": {}, "source": ["old line\n"]},
            {"cell_type": "code", "id": "bbb", "metadata": {}, "source": "print(1)\n",
             "outputs": [], "execution_count": None},
        ],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
    }
    p = tmp_path / "nb.ipynb"
    p.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    rep = m.apply_edits(p, {"edits": [{"cell": 0, "source": "new line\n"}]})
    assert rep["wrote"] is True
    assert rep["errors"] == []
    out = json.loads(p.read_text(encoding="utf-8"))
    assert out["cells"][0]["source"] == ["new line\n"]

    assert m.normalize_sources(p) == 1                    # the str-form code cell gets converted
    out = json.loads(p.read_text(encoding="utf-8"))
    assert out["cells"][1]["source"] == ["print(1)\n"]
    assert m.normalize_sources(p) == 0                    # idempotent


# ------------------------------------------------------------------ no seat identity
def test_nb_coder_has_no_lane_default(monkeypatch):
    """vllm#438/F1: the lane reaches the claim text, the [DELIVERED] marker and the claim
    guard. A default identity would let a seat that forgot the variable claim under another
    seat's name — the exact failure the claim registry exists to prevent."""
    monkeypatch.delenv("NBCODER_LANE", raising=False)
    m = _load("harness_nb_coder_lane", HARNESS / "nb_coder" / "nb_coder_driver.py")
    assert m.LANE == ""


def test_repo_and_lane_have_no_seat_defaults():
    """vllm#438/F2: a per-seat checkout path as an argparse default is a fourth resolution
    path, older than the three documented ones. The checkout is an input of the run."""
    banned = {
        "nb_coder/nb_coder_driver.py": ['default="d:/CoursIA"', '"myia-ai-01:nb-coder"'],
        "nb_audit/nb_audit_runner.py": ['default="d:/dev/CoursIA-skaudit"'],
        "nb_audit/nb_audit_driver.py": ['default="d:/dev/CoursIA-skaudit"'],
    }
    hits = [(rel, needle) for rel, needles in banned.items() for needle in needles
            if needle in (HARNESS / rel).read_text(encoding="utf-8")]
    assert hits == []


# ------------------------------------------------------------------ verdict honesty
def test_auth_codes_are_matched_on_word_boundaries():
    """vllm#442/F5-1 (co-review po-2028): a raw substring test on '401'/'403' turns
    'timeout after 1401 ms' and 'listening on port 8403' into auth failures — the mirror of
    the bug the classification removes."""
    m = _load("harness_nb_coder_auth", HARNESS / "nb_coder" / "nb_coder_driver.py")
    assert m.call_failure({"error": "401 invalid proxy authentication"}).startswith("auth-failed")
    assert m.call_failure({"error": "403 forbidden"}).startswith("auth-failed")
    assert m.call_failure({"error": "timeout after 1401 ms"}).startswith("call-failed")
    assert m.call_failure({"error": "listening on port 8403"}).startswith("call-failed")
    assert m.call_failure({}) == ""


def test_preflight_refuses_and_leaves_a_trace(tmp_path):
    """vllm#442/F3-1: a scheduled loop must be able to tell 'ran and refused' from 'never
    ran'. The refusal writes the out-dir and a ledger line before exiting."""
    m = _load("harness_nb_coder_preflight", HARNESS / "nb_coder" / "nb_coder_driver.py")
    m.PM_CWD = tmp_path / "does-not-exist"

    class _AP:
        def error(self, msg):
            raise SystemExit(msg)

    class _Args:
        out_dir, issue, notebook, lane = str(tmp_path / "out"), 4242, "x.ipynb", "seat:nb-coder"

    try:
        m._preflight(_AP(), _Args())
        raise AssertionError("preflight did not refuse a missing PM_CWD")
    except SystemExit:
        pass
    rec = json.loads((tmp_path / "out" / "issue-4242.json").read_text(encoding="utf-8"))
    assert rec["verdict"] == "refused-wiring-unresolved"
    assert any("NBCODER_PM_CWD" in x for x in rec["wiring_missing"])
    ledger = (tmp_path / "out" / "ledger.jsonl").read_text(encoding="utf-8")
    assert "refused-wiring-unresolved" in ledger


# ------------------------------------------------------------------ stage-3 gate
def test_machine_path_gate_judges_outputs_only_and_on_the_delta(tmp_path):
    """CoursIA acceptance contract, trigger 2: a machine path in an OUTPUT is a change
    request. The same string in the source is prose; an untouched output keeps its path."""
    m = _load("harness_nb_coder_machine_path", HARNESS / "nb_coder" / "nb_coder_driver.py")

    def nb(cells):
        return {"cells": cells, "metadata": {"language_info": {"version": "3.13.16"}},
                "nbformat": 4, "nbformat_minor": 5}

    def code(src, out=None):
        return {"cell_type": "code", "source": src, "metadata": {}, "execution_count": 1,
                "outputs": ([{"output_type": "stream", "name": "stdout", "text": out}]
                            if out is not None else [])}

    def run(src_cells, built_cells):
        a, b = tmp_path / "a.ipynb", tmp_path / "b.ipynb"
        a.write_text(json.dumps(nb(src_cells)), encoding="utf-8")
        b.write_text(json.dumps(nb(built_cells)), encoding="utf-8")
        return {g["gate"]: g for g in m.run_gates(a, b)}["machine-path"]

    clean = run([code("x=1", "1\n")], [code("x=1", "1\n"), code("y=2", "2\n")])
    assert clean["ok"], clean
    leaked = run([code("x=1", "1\n")],
                 [code("x=1", "1\n"), code("print(p)", "C:\\Users\\MYIA\\proj\n")])
    assert not leaked["ok"] and leaked["detail"]["cells"] == [1], leaked
    preexisting = run([code("print(p)", "/home/user/data\n")],
                      [code("print(p)", "/home/user/data\n"), code("y=2", "2\n")])
    assert preexisting["ok"] and preexisting["detail"]["source_hits"] == [0], preexisting
    in_source_only = run([code("x=1", "1\n")],
                         [code("x=1", "1\n"), code('p = r"C:\\Users\\MYIA\\data"', None)])
    assert in_source_only["ok"], in_source_only


# ------------------------------------------------------------------ copy provenance
def test_every_copied_file_carries_the_provenance_header():
    files = [p for ext in ("*.py", "*.ps1", "*.md") for p in HARNESS.rglob(ext)]
    assert files, "harness copy is missing"
    missing = [str(p.relative_to(HERE)) for p in files if SHA not in p.read_text(encoding="utf-8")]
    assert missing == []