#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_step_models.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Offline tests of the per-step model parameters (roo-extensions #4831): --coder-model,
--verifier-model, --spec-model + --spec-mode. Ported from the ms#1810 slice 81ec3536 into
the canonical vllm harness, with the review fix of Hermes (the guard test asserts the
message, not a bare flag name) and the vllm-specific guards (--from-spec, --revise-from).

The contract under test:
  * agent_spec_for composes the call_agent spec; the `model` key is present ONLY when a
    per-step model is declared — absent, the --agent preset's own model serves the turn.
  * every coder turn (sk_call) carries --coder-model; the spec turn carries --spec-model.
  * the driver refuses --spec-mode run without --spec-model BEFORE any spend.
  * the spec skip is DECLARED (a parameter, never a heuristic) and traced on the record;
    a dead spec turn fails loud instead of falling back to the rough issue.
  * the run record and the ledger carry the declared models / the spec mode.
  * the verifier subprocess receives --model; the scheduler forwards the four flags,
    per grain over its own defaults, and always declares --spec-mode.
No engine, no MCP spawn, no GitHub."""

import asyncio
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

HERE = Path(__file__).resolve().parent


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


D = _load("nb_coder_driver_stepmodels", HERE / "nb_coder_driver.py")
S = _load("nb_coder_scheduler_stepmodels", HERE / "nb_coder_scheduler.py")

KERNEL = {"kernel_name": "python3", "canonical_version": "3.13", "neighbour_versions": {}}
BASE = ["--issue", "1", "--notebook", "A.ipynb", "--repo", "D:/CoursIA"]


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


# --------------------------------------------------------------- sk_call payload
class _Session:
    """Captures the call_agent payload; answers an empty-but-valid envelope."""

    def __init__(self):
        self.payloads = []

    async def call_tool(self, name, payload, read_timeout_seconds=None):
        self.payloads.append(payload)
        return SimpleNamespace(content=[SimpleNamespace(text=json.dumps({"response": "ok"}))])


def _args(**kw):
    base = dict(agent="notebook-coder", timeout=60, max_tokens=1000, coder_model=None)
    return SimpleNamespace(**(base | kw))


def _spec_of(session) -> dict:
    return json.loads(session.payloads[-1]["agent_spec"])


def test_sk_call_coder_turn_carries_coder_model():
    s = _Session()
    asyncio.run(D.sk_call(s, _args(coder_model="nb-minimax"), "p", None))
    assert _spec_of(s)["model"] == "nb-minimax"


def test_sk_call_explicit_model_wins_over_coder_model():
    """The spec turn passes --spec-model explicitly: it must not be served by the coder's."""
    s = _Session()
    asyncio.run(D.sk_call(s, _args(coder_model="nb-minimax"), "p", None, model="glm-5.3"))
    assert _spec_of(s)["model"] == "glm-5.3"


def test_sk_call_without_models_keeps_preset():
    s = _Session()
    asyncio.run(D.sk_call(s, SimpleNamespace(agent="notebook-coder", timeout=60,
                                             max_tokens=1000), "p", None))
    assert "model" not in _spec_of(s)


def test_sk_call_retry_forwards_model_on_both_attempts(monkeypatch):
    seen = []

    async def fake_sk(session, args, prompt, conv, max_tokens=None, model=None, **kw):
        seen.append(model)
        return {"error": "empty model response"}, 0.1

    monkeypatch.setattr(D, "sk_call", fake_sk)
    monkeypatch.setattr(D, "engine_tokens", lambda: {})
    rec = {"calls": []}
    asyncio.run(D.sk_call_retry(None, _args(), rec, "spec", "p", None, model="glm-5.3"))
    assert seen == ["glm-5.3", "glm-5.3"]          # the retry keeps the step's model
    assert [c["stage"] for c in rec["calls"]] == ["spec", "spec-retry"]


# --------------------------------------------------------------- driver parser + guards
def test_parser_defaults_preserve_seat_behavior():
    """Unset params = the pre-#4831 behavior: preset models, spec skipped."""
    a = D.build_parser().parse_args(BASE)
    assert a.spec_mode == "skip"
    assert a.coder_model is None and a.verifier_model is None and a.spec_model is None


def test_parser_env_defaults(monkeypatch):
    """Seat wiring follows the NBCODER_* pattern of --verifier-agent/NBCODER_VERIFIER."""
    monkeypatch.setenv("NBCODER_CODER_MODEL", "nb-minimax")
    monkeypatch.setenv("NBCODER_VERIFIER_MODEL", "glm-5.3")
    monkeypatch.setenv("NBCODER_SPEC_MODE", "run")
    monkeypatch.setenv("NBCODER_SPEC_MODEL", "glm-5.3")
    a = D.build_parser().parse_args(BASE)
    assert (a.coder_model, a.verifier_model, a.spec_mode, a.spec_model) == \
        ("nb-minimax", "glm-5.3", "run", "glm-5.3")


def test_parser_accepts_step_models():
    a = D.build_parser().parse_args([
        "--issue", "27106", "--notebook", "Ser/Z3-10-CSharp.ipynb", "--repo", "D:/CoursIA",
        "--coder-model", "nb-minimax", "--verifier-model", "glm-5.3",
        "--spec-mode", "run", "--spec-model", "glm-5.3"])
    assert (a.coder_model, a.verifier_model, a.spec_mode, a.spec_model) == \
        ("nb-minimax", "glm-5.3", "run", "glm-5.3")


def test_parser_rejects_unknown_spec_mode():
    with pytest.raises(SystemExit):
        D.build_parser().parse_args(BASE + ["--spec-mode", "auto"])


@pytest.mark.parametrize("extra, needle", [
    # Hermes's review on ms#1810: assert the GUARD's message, not a bare flag name that
    # argparse's own usage line would also print
    (["--spec-mode", "run"], "--spec-mode run requires --spec-model"),
    (["--spec-mode", "run", "--spec-model", "glm-5.3", "--from-spec", "--meta-from",
      "S/M.ipynb"], "--spec-mode run and --from-spec are exclusive"),
    (["--spec-mode", "run", "--spec-model", "glm-5.3", "--revise-from", "x.json",
      "--max-stage", "4"], "--spec-mode run has no effect with --revise-from"),
])
def test_cli_guards_refuse_before_any_spend(monkeypatch, capsys, extra, needle):
    """Fail-loud guards (same family as --claim without --lane): argparse exits 2 with the
    reason on stderr BEFORE the wiring preflight and before any model turn."""
    called = []
    monkeypatch.setattr(D, "_preflight", lambda ap, args: called.append("preflight"))
    monkeypatch.setattr(sys, "argv", ["nb_coder_driver.py", *BASE, *extra])
    with pytest.raises(SystemExit) as e:
        D.main()
    assert e.value.code == 2
    assert needle in capsys.readouterr().err
    assert called == []


def test_spec_guard_end_to_end_subprocess(tmp_path):
    """Same guard through the real entry point (no monkeypatch on main)."""
    p = subprocess.run(
        [sys.executable, str(HERE / "nb_coder_driver.py"),
         "--issue", "1", "--notebook", "A.ipynb", "--repo", str(tmp_path),
         "--spec-mode", "run"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert p.returncode == 2
    assert "--spec-mode run requires --spec-model" in p.stderr


# --------------------------------------------------------------- spec step
def test_spec_prompt_carries_issue_and_demands_the_five_sections():
    issue = {"title": "Parity Z3-10", "body": "do the C# twin", "comments": ""}
    pr = D.spec_prompt(27106, issue, "Ser/Z3-10-CSharp.ipynb", KERNEL, "ctx", "view", "")
    assert "Parity Z3-10" in pr and "do the C# twin" in pr
    for section in ("Objectif", "Critères d'acceptation", "Plan cellule par cellule",
                    "Sorties attendues", "Pièges"):
        assert section in pr
    # the spec REPLACES the issue for the coder: nothing usable may be dropped
    assert "REMPLACE" in pr
    assert "\n\n## Issue brute\n" in pr               # real line breaks, not literal escapes


def test_spec_skip_trace_is_declared_not_heuristic():
    assert D.spec_skip_trace(4213) == {"mode": "skip", "skipped": True,
                                       "declared": "--spec-mode skip",
                                       "issue_body_chars": 4213}


def test_spec_body_cap_declares_truncation():
    """A spec over the cap feeds stage 1 a DECLARED cut, never a silent one."""
    body = D._cut("x" * (D.SPEC_BODY_CAP + 10), D.SPEC_BODY_CAP, "spec")
    assert len(body) < D.SPEC_BODY_CAP + 200 and "TRONQUÉ" in body


ISSUE = {"title": "Rough", "body": "port it", "comments": ""}


def _spec_args(**kw):
    base = dict(issue=7, notebook="Ser/N.ipynb", spec_mode="run", spec_model="glm-5.3",
                agent="notebook-coder", timeout=60, max_tokens=1000, coder_model="nb-minimax")
    return SimpleNamespace(**(base | kw))


def _fake_retry(monkeypatch, response):
    seen = {}

    async def fake(sk, args, rec, stage, prompt, conv, max_tokens=None, model=None):
        seen.update(stage=stage, prompt=prompt, conv=conv, model=model)
        rec["calls"].append({"stage": stage, "model_used": model})
        return {"response": response, "conversation_id": "c-spec"}

    monkeypatch.setattr(D, "sk_call_retry", fake)
    return seen


def test_spec_stage_skip_returns_raw_issue_and_traces(monkeypatch):
    seen = _fake_retry(monkeypatch, "never")
    rec = {"calls": []}
    out = asyncio.run(D.spec_stage(None, _spec_args(spec_mode="skip"), rec, ISSUE, KERNEL,
                                   "ctx", "view", "", Path(".")))
    assert out is ISSUE
    assert rec["spec"] == D.spec_skip_trace(len("port it"))
    assert seen == {} and rec["calls"] == []         # a declared skip spends nothing


def test_spec_stage_run_rewrites_body_with_spec_model(monkeypatch, tmp_path):
    seen = _fake_retry(monkeypatch, "  ## Objectif\nDETAILED SPEC  ")
    rec = {"calls": []}
    out = asyncio.run(D.spec_stage(None, _spec_args(), rec, ISSUE, KERNEL, "ctx", "view",
                                   "", tmp_path))
    assert seen["stage"] == "spec" and seen["model"] == "glm-5.3" and seen["conv"] is None
    assert "port it" in seen["prompt"]               # the spec reads the RAW issue
    assert out["body"] == "## Objectif\nDETAILED SPEC"
    assert out["title"] == "Rough" and ISSUE["body"] == "port it"   # raw issue untouched
    assert rec["spec"]["mode"] == "run" and rec["spec"]["model"] == "glm-5.3"
    assert rec["spec"]["conversation_id"] == "c-spec" and "failed" not in rec["spec"]
    assert (tmp_path / "spec-7.md").read_text(encoding="utf-8") == out["body"]
    assert rec["spec"]["path"] == str(tmp_path / "spec-7.md")
    assert "verdict" not in rec


def test_spec_stage_dead_turn_fails_loud(monkeypatch, tmp_path):
    _fake_retry(monkeypatch, "   ")
    rec = {"calls": []}
    out = asyncio.run(D.spec_stage(None, _spec_args(), rec, ISSUE, KERNEL, "ctx", "view",
                                   "", tmp_path))
    assert out is None                                # never the rough issue as fallback
    assert rec["spec"]["failed"] is True
    assert rec["verdict"] == "spec-no-answer"
    assert not (tmp_path / "spec-7.md").exists()


def test_spec_stage_names_the_wiring_failure(monkeypatch, tmp_path):
    async def fake(sk, args, rec, stage, prompt, conv, max_tokens=None, model=None):
        return {"error": "Error code: 401 - invalid proxy authentication"}

    monkeypatch.setattr(D, "sk_call_retry", fake)
    rec = {"calls": []}
    assert asyncio.run(D.spec_stage(None, _spec_args(), rec, ISSUE, KERNEL, "c", "v", "",
                                    tmp_path)) is None
    assert rec["verdict"] == f"spec-{D.call_failure({'error': 'Error code: 401 - invalid proxy authentication'})}"
    assert rec["verdict"] != "spec-no-answer"


def test_spec_stage_caps_an_oversized_spec(monkeypatch, tmp_path):
    _fake_retry(monkeypatch, "y" * (D.SPEC_BODY_CAP + 50))
    rec = {"calls": []}
    out = asyncio.run(D.spec_stage(None, _spec_args(), rec, ISSUE, KERNEL, "c", "v", "",
                                   tmp_path))
    assert "TRONQUÉ" in out["body"]
    assert rec["spec"]["chars"] == D.SPEC_BODY_CAP + 50   # the trace keeps the true size


# --------------------------------------------------------------- run record + ledger
def test_main_records_declared_models_and_ledger_spec(monkeypatch, tmp_path):
    async def fake_run(args, rec):
        rec["spec"] = D.spec_skip_trace(12)
        rec["verdict"] = "stage0-only"
        return rec

    monkeypatch.setattr(D, "run", fake_run)
    monkeypatch.setattr(D, "engine_tokens", lambda: {})
    monkeypatch.setattr(sys, "argv", ["nb_coder_driver.py", *BASE, "--max-stage", "0",
                                      "--out-dir", str(tmp_path),
                                      "--coder-model", "nb-minimax",
                                      "--verifier-model", "glm-5.3"])
    assert D.main() == 0
    rec = json.loads((tmp_path / "issue-1.json").read_text(encoding="utf-8"))
    assert rec["models"] == {"spec": None, "coder": "nb-minimax", "verifier": "glm-5.3"}
    led = json.loads((tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()[-1])
    assert led["spec"] == "skip"


# --------------------------------------------------------------- verifier model
class _FakeProc:
    returncode = 2
    stdout = ""
    stderr = "instrument error (fake)"


def _stage4(monkeypatch, tmp_path, verifier_model):
    captured: dict = {}

    def fake_run(cmd, **kw):
        captured["cmd"] = cmd
        return _FakeProc()

    monkeypatch.setattr(D.subprocess, "run", fake_run)
    args = SimpleNamespace(issue=1, verifier_agent="critic", verifier_model=verifier_model,
                           verify_timeout=60)
    (tmp_path / "src.ipynb").write_text("{}", encoding="utf-8")
    (tmp_path / "built.ipynb").write_text("{}", encoding="utf-8")
    rec: dict = {}
    D.stage4_verify(args, rec, tmp_path / "src.ipynb", tmp_path / "built.ipynb", tmp_path)
    return captured["cmd"], rec


def test_stage4_forwards_verifier_model(monkeypatch, tmp_path):
    """--verifier-model must reach nb_coder_verify.py as --model."""
    cmd, rec = _stage4(monkeypatch, tmp_path, "glm-5.3")
    assert cmd[cmd.index("--model") + 1] == "glm-5.3"
    assert rec["verdict"] == "verify-error"     # rc 2 is an instrument error, never a reject


def test_stage4_omits_model_flag_when_unset(monkeypatch, tmp_path):
    """No declared verifier model -> no --model flag: the verifier preset's own model
    serves the audit (seat default, unchanged behavior)."""
    cmd, _ = _stage4(monkeypatch, tmp_path, None)
    assert "--model" not in cmd


def test_verify_cli_traces_declared_model(tmp_path):
    """End-to-end wiring without a live model: missing inputs exit 2 AFTER the trace is
    written — the trace must carry the declared --model."""
    p = subprocess.run(
        [sys.executable, str(HERE / "nb_coder_verify.py"),
         "--issue", "1", "--source-nb", str(tmp_path / "no.ipynb"),
         "--built-nb", str(tmp_path / "nb.ipynb"), "--model", "glm-5.3",
         "--out-dir", str(tmp_path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert p.returncode == 2
    trace = json.loads((tmp_path / "verify-1.json").read_text(encoding="utf-8"))
    assert trace["model"] == "glm-5.3"
    assert trace["verdict"].startswith("error:input-missing")


def _verifier_payload(monkeypatch, tmp_path, model):
    """Drive call_verifier with the MCP transport faked: returns the call_agent payload."""
    import contextlib
    V = _load("nb_coder_verify_stepmodels", HERE / "nb_coder_verify.py")
    session = _Session()

    @contextlib.asynccontextmanager
    async def fake_stdio(params):
        yield None, None

    class FakeClientSession:
        def __init__(self, r, w):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def initialize(self):
            return None

        call_tool = session.call_tool

    monkeypatch.setattr(V, "stdio_client", fake_stdio)
    monkeypatch.setattr(V, "ClientSession", FakeClientSession)
    args = SimpleNamespace(agent="critic", model=model, max_tokens=32768, timeout=60,
                           out_dir=str(tmp_path))
    asyncio.run(V.call_verifier(args, "p"))
    return session.payloads[-1]


def test_verify_call_spec_carries_model(monkeypatch, tmp_path):
    """The verifier's own call_agent spec carries --model (same contract as the coder)."""
    spec = json.loads(_verifier_payload(monkeypatch, tmp_path, "glm-5.3")["agent_spec"])
    assert spec == {"extends": "critic", "model": "glm-5.3",
                    "sampling": {"max_tokens": 32768, "temperature": 0.2}}


def test_verify_call_spec_without_model_keeps_preset(monkeypatch, tmp_path):
    spec = json.loads(_verifier_payload(monkeypatch, tmp_path, None)["agent_spec"])
    assert "model" not in spec and spec["extends"] == "critic"


# --------------------------------------------------------------- scheduler forwarding
def _q(tmp_path: Path, items: list[dict]) -> Path:
    q = tmp_path / "q.jsonl"
    q.write_text("".join(json.dumps(i) + "\n" for i in items), encoding="utf-8")
    return q


def _sched(tmp_path: Path, items: list[dict], extra=(), **arg_overrides):
    q = _q(tmp_path, items)
    args = S.parse_args(["--queue", str(q), "--state-dir", str(tmp_path / "state"),
                         "--repo", "D:/CoursIA", "--max-active", "1", *extra])
    for k, v in arg_overrides.items():
        setattr(args, k, v)
    sched = S.Scheduler(args, spawn=lambda cmd: None, gate=lambda: {"verdict": "green"},
                        sleep=lambda s=0: None, clock=lambda: 1000.0)
    loaded, digest = S.load_queue(q)
    sched.merge_queue(loaded, digest)
    return sched


def _cmd(sched, key) -> list[str]:
    return sched.driver_command(sched.items_by_key[key])


def _flag(cmd: list[str], flag: str):
    return cmd[cmd.index(flag) + 1] if flag in cmd else None


def test_queue_accepts_step_model_fields(tmp_path):
    """The queue schema is a closed set: the four new keys must be known."""
    loaded, _ = S.load_queue(_q(tmp_path, [{
        "issue": 7, "notebook": "Dir/N7.ipynb", "coder_model": "nb-minimax",
        "verifier_model": "glm-5.3", "spec_model": "glm-5.3", "spec_mode": "run"}]))
    assert loaded[0]["coder_model"] == "nb-minimax"


def test_scheduler_parser_defaults():
    a = S.parse_args(["--queue", "q", "--state-dir", "s", "--repo", "R", "--max-active", "1"])
    assert a.spec_mode == "skip"
    assert a.coder_model is None and a.verifier_model is None and a.spec_model is None


def test_driver_command_forwards_step_models(tmp_path):
    sched = _sched(tmp_path, [
        {"issue": 1, "notebook": "Dir/N1.ipynb"},                        # scheduler defaults
        {"issue": 2, "notebook": "Dir/N2.ipynb", "coder_model": "swift-1.5-27b",
         "spec_mode": "skip"},                                           # per-grain overrides
    ], extra=["--coder-model", "nb-minimax", "--verifier-model", "glm-5.3",
              "--spec-model", "glm-5.3", "--spec-mode", "run"])
    c1 = _cmd(sched, "#1:Dir/N1.ipynb")
    assert (_flag(c1, "--coder-model"), _flag(c1, "--verifier-model"),
            _flag(c1, "--spec-model"), _flag(c1, "--spec-mode")) == \
        ("nb-minimax", "glm-5.3", "glm-5.3", "run")
    c2 = _cmd(sched, "#2:Dir/N2.ipynb")
    assert _flag(c2, "--coder-model") == "swift-1.5-27b"     # grain wins over default
    assert _flag(c2, "--spec-mode") == "skip"
    assert _flag(c2, "--verifier-model") == "glm-5.3"        # not overridden: default applies


def test_driver_command_always_declares_spec_mode(tmp_path):
    """Even with every model unset, the spec skip is DECLARED on the driver command line
    (never left to a distant default) — the scheduler default itself is 'skip'."""
    sched = _sched(tmp_path, [{"issue": 3, "notebook": "Dir/N3.ipynb"}])
    cmd = _cmd(sched, "#3:Dir/N3.ipynb")
    assert _flag(cmd, "--spec-mode") == "skip"
    for f in ("--coder-model", "--verifier-model", "--spec-model"):
        assert f not in cmd                                  # unset models stay unset


def test_forwarded_command_parses_in_the_driver(tmp_path):
    """The scheduler's command line must be accepted by the driver's own parser: a flag
    the driver does not know would crash every grain at launch."""
    sched = _sched(tmp_path, [{"issue": 4, "notebook": "Dir/N4.ipynb",
                               "coder_model": "nb-minimax", "verifier_model": "glm-5.3",
                               "spec_model": "glm-5.3", "spec_mode": "run"}])
    cmd = _cmd(sched, "#4:Dir/N4.ipynb")
    a = D.build_parser().parse_args(cmd[2:])
    assert (a.coder_model, a.verifier_model, a.spec_model, a.spec_mode) == \
        ("nb-minimax", "glm-5.3", "glm-5.3", "run")


# --------------------------------------------------------------- run() wiring up to stage 1
class _Stop(Exception):
    """Raised by the fake model at stage 1: the test only needs what stage 1 was shown."""


def _drive_run_to_stage1(monkeypatch, tmp_path, spec_mode, spec_response, source_nb=None):
    import contextlib
    wt = tmp_path / "wt"
    (wt / "Ser").mkdir(parents=True)
    (wt / (source_nb or "Ser/N.ipynb")).write_text(json.dumps({"cells": [], "metadata": {},
                                                    "nbformat": 4, "nbformat_minor": 5}),
                                        encoding="utf-8")
    monkeypatch.setattr(D.subprocess, "run", lambda *a, **kw:
                        SimpleNamespace(stdout="https://github.com/jsboige/CoursIA.git\n"))
    monkeypatch.setattr(D, "app_token", lambda repo: "")
    monkeypatch.setattr(D, "read_conventions", lambda p: "")
    monkeypatch.setattr(D, "check_claim", lambda *a: {"rc": 0, "ok": True})
    monkeypatch.setattr(D, "fetch_issue", lambda *a: {
        "title": "Rough", "state": "open", "labels": [], "body": "RAW-BODY", "comments": ""})
    monkeypatch.setattr(D, "reserve_claim", lambda *a: {"verdict": None})
    monkeypatch.setattr(D, "prepare_worktree", lambda *a: {"ok": True, "path": str(wt)})
    monkeypatch.setattr(D, "series_kernel", lambda *a: dict(KERNEL))
    monkeypatch.setattr(D, "series_context", lambda *a: "CTX")
    monkeypatch.setattr(D, "series_canonical_meta",
                        lambda *a: {"kernelspec": {"name": "python3"}})
    monkeypatch.setattr(D, "build_view", lambda p: "VIEW")
    monkeypatch.setattr(D, "gate_call", lambda *a: {"blocking_refusal": False,
                                                    "verdict": "green"})

    @contextlib.asynccontextmanager
    async def fake_stdio(params):
        yield None, None

    class FakeSession:
        def __init__(self, r, w):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def initialize(self):
            return None

    monkeypatch.setattr(D, "stdio_client", fake_stdio)
    monkeypatch.setattr(D, "ClientSession", FakeSession)
    seen = []

    async def fake_retry(sk, args, rec, stage, prompt, conv, max_tokens=None, model=None):
        seen.append({"stage": stage, "prompt": prompt, "model": model})
        if stage == "spec":
            return {"response": spec_response, "conversation_id": "c-spec"}
        raise _Stop

    monkeypatch.setattr(D, "sk_call_retry", fake_retry)
    args = SimpleNamespace(out_dir=str(tmp_path / "out"), repo="D:/repo", issue=7,
                           notebook="Ser/N.ipynb", source_nb=source_nb, from_spec=False,
                           meta_from=None, allow_foreign_origin=False, lane="lane:a",
                           claim=True, intention="w", conventions="", max_stage=2,
                           worktree=str(wt), fresh_worktree=False, gate_mode="off",
                           gate=None, agent="notebook-coder", timeout=60, max_tokens=1000,
                           coder_model="nb-minimax", spec_mode=spec_mode,
                           spec_model="glm-5.3")
    rec = {"stages": {}, "calls": []}
    try:
        out = asyncio.run(D.run(args, rec))
    except _Stop:
        out = None
    return out, rec, seen


def test_run_stage1_reads_the_prechewed_spec(monkeypatch, tmp_path):
    out, rec, seen = _drive_run_to_stage1(monkeypatch, tmp_path, "run", "PRECHEWED-SPEC")
    assert out is None                                  # stopped at stage 1 by the fake
    assert [s["stage"] for s in seen] == ["spec", "1-plan"]
    assert seen[0]["model"] == "glm-5.3" and "RAW-BODY" in seen[0]["prompt"]
    plan_prompt = seen[1]["prompt"]
    assert "PRECHEWED-SPEC" in plan_prompt and "RAW-BODY" not in plan_prompt
    assert seen[1]["model"] is None                     # stage 1 = coder turn (sk_call default)
    assert rec["spec"]["mode"] == "run"


def test_run_stage1_reads_the_raw_issue_on_declared_skip(monkeypatch, tmp_path):
    out, rec, seen = _drive_run_to_stage1(monkeypatch, tmp_path, "skip", "never")
    assert [s["stage"] for s in seen] == ["1-plan"]
    assert "RAW-BODY" in seen[0]["prompt"]
    assert rec["spec"] == D.spec_skip_trace(len("RAW-BODY"))


def test_run_stops_before_stage1_on_a_dead_spec(monkeypatch, tmp_path):
    out, rec, seen = _drive_run_to_stage1(monkeypatch, tmp_path, "run", "")
    assert [s["stage"] for s in seen] == ["spec"]        # the coder is never called
    assert out is rec and rec["verdict"] == "spec-no-answer"


def test_run_creation_stage1_reads_the_prechewed_spec(monkeypatch, tmp_path):
    # --source-nb (a port) accepts --spec-mode run: its creation plan must see the spec too
    out, rec, seen = _drive_run_to_stage1(monkeypatch, tmp_path, "run", "PRECHEWED-SPEC",
                                          source_nb="Ser/Twin.ipynb")
    assert rec.get("create_mode", {}).get("source") == "Ser/Twin.ipynb", rec.get("verdict")
    assert [s["stage"] for s in seen] == ["spec", "1-plan"]
    assert "PRECHEWED-SPEC" in seen[1]["prompt"] and "RAW-BODY" not in seen[1]["prompt"]
