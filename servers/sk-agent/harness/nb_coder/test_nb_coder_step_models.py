# --- provenance (roo-extensions #4831 per-step model selection) ---------------
# Authored here (harness canonical home, #4781) — not a vllm copy; lineage anchored on
# the tree it extends: jsboige/vllm @ 231c9ad8e9281ee162fc641a11889fc5600f4827.
# Offline: fake subprocess calls, no engine, no MCP spawn.
"""Tests of the per-step model parameters (#4831): --coder-model, --verifier-model,
--spec-model + --spec-mode.

The contract under test:
  * agent_spec_for composes the call_agent spec; the `model` key is present ONLY when a
    per-step model is declared — absent, the --agent preset's own model serves the turn.
  * the driver refuses --spec-mode run without --spec-model BEFORE any spend (the spec
    turn exists precisely to avoid burning the coder on a rough issue).
  * the spec skip is DECLARED (a parameter, never a heuristic) and traced on the record.
  * the verifier subprocess receives --model; the scheduler forwards the four flags to
    the driver, per grain over its own defaults.

Driver/verifier modules import `mcp` at load — skipped when not importable, like
test_nb_coder_verify.py.
"""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

HERE = Path(__file__).resolve().parent


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


D = _load("nb_coder_driver_stepmodels", HERE / "nb_coder_driver.py")


# --------------------------------------------------------------- agent_spec_for

def test_agent_spec_omits_model_when_unset():
    """No declared model -> no `model` key: the extends preset's model serves the call
    (seat default, unchanged behavior before #4831)."""
    spec = D.agent_spec_for("notebook-coder", None, 16384, 0.4)
    assert spec == {"extends": "notebook-coder",
                    "sampling": {"max_tokens": 16384, "temperature": 0.4}}


def test_agent_spec_carries_model_when_set():
    spec = D.agent_spec_for("notebook-coder", "nb-minimax", 16384, 0.4)
    assert spec["model"] == "nb-minimax"
    assert spec["extends"] == "notebook-coder"      # the preset keeps tools + prompt


# --------------------------------------------------------------- driver parser

def test_parser_defaults_preserve_seat_behavior():
    """Unset params = the pre-#4831 behavior: preset models, spec skipped."""
    a = D.build_parser().parse_args(["--issue", "1", "--notebook", "A.ipynb",
                                     "--repo", "D:/CoursIA"])
    assert a.spec_mode == "skip"
    assert a.coder_model is None and a.verifier_model is None and a.spec_model is None


def test_parser_env_defaults(monkeypatch):
    """Seat wiring follows the NBCODER_* pattern of --verifier-agent/NBCODER_VERIFIER."""
    monkeypatch.setenv("NBCODER_CODER_MODEL", "nb-minimax")
    monkeypatch.setenv("NBCODER_SPEC_MODE", "run")
    monkeypatch.setenv("NBCODER_SPEC_MODEL", "glm-5.3")
    a = D.build_parser().parse_args(["--issue", "1", "--notebook", "A.ipynb",
                                     "--repo", "D:/CoursIA"])
    assert (a.coder_model, a.spec_mode, a.spec_model) == ("nb-minimax", "run", "glm-5.3")


def test_parser_accepts_step_models():
    a = D.build_parser().parse_args([
        "--issue", "27106", "--notebook", "Ser/Z3-10-CSharp.ipynb", "--repo", "D:/CoursIA",
        "--coder-model", "nb-minimax", "--verifier-model", "glm-5.3",
        "--spec-mode", "run", "--spec-model", "glm-5.3"])
    assert (a.coder_model, a.verifier_model, a.spec_mode, a.spec_model) == \
        ("nb-minimax", "glm-5.3", "run", "glm-5.3")


def test_spec_mode_run_without_spec_model_refuses_before_any_spend(tmp_path):
    """Fail-loud guard (same family as --claim without --lane): argparse exits 2 with the
    reason on stderr BEFORE the wiring preflight and before any model turn."""
    p = subprocess.run(
        [sys.executable, str(HERE / "nb_coder_driver.py"),
         "--issue", "1", "--notebook", "A.ipynb", "--repo", str(tmp_path),
         "--spec-mode", "run"],
        capture_output=True, text=True, timeout=120)
    assert p.returncode == 2
    assert "--spec-model" in p.stderr


# --------------------------------------------------------------- spec step

def test_spec_prompt_carries_issue_and_demands_the_five_sections():
    issue = {"title": "Parity Z3-10", "body": "do the C# twin", "comments": ""}
    pr = D.spec_prompt(27106, issue, "Ser/Z3-10-CSharp.ipynb",
                       {"kernel_name": "python3", "canonical_version": "3.13",
                        "neighbour_versions": {}}, "ctx", "view", "")
    assert "Parity Z3-10" in pr and "do the C# twin" in pr
    for section in ("Objectif", "Critères d'acceptation", "Plan cellule par cellule",
                    "Sorties attendues", "Pièges"):
        assert section in pr
    # the spec REPLACES the issue for the coder: nothing usable may be dropped
    assert "REMPLACE" in pr


def test_spec_skip_trace_is_declared_not_heuristic():
    t = D.spec_skip_trace(4213)
    assert t == {"mode": "skip", "skipped": True, "declared": "--spec-mode skip",
                 "issue_body_chars": 4213}
    # the judgment evidence rides along: the lane decided 4 213 chars were detailed enough
    assert t["issue_body_chars"] > 0


def test_spec_body_cap_declares_truncation():
    """A spec over the cap feeds stage 1 a DECLARED cut, never a silent one."""
    body = D._cut("x" * (D.SPEC_BODY_CAP + 10), D.SPEC_BODY_CAP, "spec")
    assert len(body) < D.SPEC_BODY_CAP + 200 and "TRONQUÉ" in body


# --------------------------------------------------------------- verifier model

def test_stage4_forwards_verifier_model(monkeypatch, tmp_path):
    """stage4_verify builds the subprocess command: --verifier-model must reach
    nb_coder_verify.py as --model."""
    captured: dict = {}

    class FakeProc:
        returncode = 2
        stdout = ""
        stderr = "instrument error (fake)"

    def fake_run(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(D.subprocess, "run", fake_run)

    class A:
        issue = 1
        verifier_agent = "critic"
        verifier_model = "glm-5.3"
        verify_timeout = 60

    (tmp_path / "src.ipynb").write_text("{}", encoding="utf-8")
    (tmp_path / "built.ipynb").write_text("{}", encoding="utf-8")
    rec: dict = {}
    D.stage4_verify(A(), rec, tmp_path / "src.ipynb", tmp_path / "built.ipynb", tmp_path)
    cmd = captured["cmd"]
    i = cmd.index("--model")
    assert cmd[i + 1] == "glm-5.3"
    assert rec["verdict"] == "verify-error"     # rc 2 is an instrument error, never a reject


def test_stage4_omits_model_flag_when_unset(monkeypatch, tmp_path):
    """No declared verifier model -> no --model flag: the verifier preset's own model
    serves the audit (seat default, unchanged behavior)."""
    captured: dict = {}

    class FakeProc:
        returncode = 2
        stdout = ""
        stderr = "instrument error (fake)"

    def fake_run(cmd, **kw):
        captured["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(D.subprocess, "run", fake_run)

    class A:
        issue = 1
        verifier_agent = "critic"
        verifier_model = None
        verify_timeout = 60

    (tmp_path / "src.ipynb").write_text("{}", encoding="utf-8")
    (tmp_path / "built.ipynb").write_text("{}", encoding="utf-8")
    D.stage4_verify(A(), rec={}, src_nb=tmp_path / "src.ipynb",
                    built_nb=tmp_path / "built.ipynb", out_dir=tmp_path)
    assert "--model" not in captured["cmd"]


def test_verify_cli_traces_declared_model(tmp_path):
    """End-to-end wiring without a live model: missing inputs exit 2 AFTER the trace is
    written — the trace must carry the declared --model."""
    p = subprocess.run(
        [sys.executable, str(HERE / "nb_coder_verify.py"),
         "--issue", "1", "--source-nb", str(tmp_path / "no.ipynb"),
         "--built-nb", str(tmp_path / "nb.ipynb"), "--model", "glm-5.3",
         "--out-dir", str(tmp_path)],
        capture_output=True, text=True, timeout=120)
    assert p.returncode == 2
    trace = json.loads((tmp_path / "verify-1.json").read_text(encoding="utf-8"))
    assert trace["model"] == "glm-5.3"
    assert trace["verdict"].startswith("error:input-missing")


# --------------------------------------------------------------- scheduler forwarding

S = _load("nb_coder_scheduler_stepmodels", HERE / "nb_coder_scheduler.py")


def _sched(tmp_path: Path, items: list[dict], **arg_overrides):
    q = tmp_path / "q.jsonl"
    q.write_text("".join(json.dumps(i) + "\n" for i in items), encoding="utf-8")
    args = S.parse_args([
        "--queue", str(q), "--state-dir", str(tmp_path / "state"),
        "--repo", "D:/CoursIA", "--max-active", "1",
        "--coder-model", "nb-minimax", "--verifier-model", "glm-5.3",
        "--spec-model", "glm-5.3", "--spec-mode", "run"] + arg_overrides.pop("extra", []))
    for k, v in arg_overrides.items():
        setattr(args, k, v)
    sched = S.Scheduler(args, spawn=lambda cmd: None,
                        gate=lambda: {"verdict": "green"}, sleep=lambda s=0: None,
                        clock=lambda: 1000.0)
    loaded, digest = S.load_queue(q)
    sched.merge_queue(loaded, digest)
    return sched


def test_queue_accepts_step_model_fields(tmp_path):
    """The queue schema is a closed set: the four new keys must be known (a typo'd key
    still refuses loud)."""
    loaded, _ = S.load_queue(_q(tmp_path, [{
        "issue": 7, "notebook": "Dir/N7.ipynb", "coder_model": "nb-minimax",
        "verifier_model": "glm-5.3", "spec_model": "glm-5.3", "spec_mode": "run"}]))
    assert loaded[0]["coder_model"] == "nb-minimax"


def _q(tmp_path: Path, items: list[dict]) -> Path:
    q = tmp_path / "q.jsonl"
    q.write_text("".join(json.dumps(i) + "\n" for i in items), encoding="utf-8")
    return q


def test_driver_command_forwards_step_models(tmp_path):
    sched = _sched(tmp_path, [
        {"issue": 1, "notebook": "Dir/N1.ipynb"},                        # scheduler defaults
        {"issue": 2, "notebook": "Dir/N2.ipynb", "coder_model": "swift-1.5-27b",
         "spec_mode": "skip"},                                           # per-grain overrides
    ])
    cmd1 = " ".join(sched.driver_command(sched.items_by_key["#1:Dir/N1.ipynb"]))
    assert "--coder-model nb-minimax" in cmd1
    assert "--verifier-model glm-5.3" in cmd1
    assert "--spec-model glm-5.3" in cmd1
    assert "--spec-mode run" in cmd1
    cmd2 = " ".join(sched.driver_command(sched.items_by_key["#2:Dir/N2.ipynb"]))
    assert "--coder-model swift-1.5-27b" in cmd2      # grain wins over scheduler default
    assert "--spec-mode skip" in cmd2
    assert "--verifier-model glm-5.3" in cmd2         # not overridden: default applies


def test_driver_command_always_declares_spec_mode(tmp_path):
    """Even with every model unset, the spec skip is DECLARED on the driver command line
    (never left to a distant default) — the scheduler default itself is 'skip'."""
    sched = _sched(tmp_path, [{"issue": 3, "notebook": "Dir/N3.ipynb"}],
                   coder_model=None, verifier_model=None, spec_model=None, spec_mode="skip")
    cmd = " ".join(sched.driver_command(sched.items_by_key["#3:Dir/N3.ipynb"]))
    assert "--spec-mode skip" in cmd
    assert "--coder-model" not in cmd                 # unset models stay unset
