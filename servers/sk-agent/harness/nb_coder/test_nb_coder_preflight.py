#!/usr/bin/env python3
"""Offline pins for the two preflight refusals added 24/11 (o34, o34b).

Both were measured on CoursIA#28079 within one evening, on po-2028:claudish. A creation
grain queued without its twin (`--source-nb`) built a worktree, ran the claim pre-check
and read the issue before answering `notebook-not-found` at stage 0 -- 95 s and nothing on
the issue naming what was missing. A launch whose model credential variable (`ZAI_API_KEY`,
named by the seat config's `api_key_env`) was unset at every scope paid stage 0, opened the
two MCP sessions, and its first model call answered `401 invalid proxy authentication` --
125 s, one call, verdict `stage1-auth-failed`. Each question was answerable before any of
it was paid: the target against the `origin/main` the worktree is cut from, the credential
against the environment sk-agent will inherit.

Pinned here: what each refusal names (and never a value), the exact case it refuses, the
fail-open cases it must leave alone (unreadable config, unknown preset, literal key,
resume, --from-spec, a git tree it cannot read, a path spelled with another case), the
shared trace/ledger contract (24/11, o33: a refusal never destroys the record it resumes),
and the kill switch. Only a local bare repo is contacted; no engine, no MCP session.
"""
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as D  # noqa: E402


# ---------------------------------------------------------------- fixtures
def _seat(monkeypatch, tmp_path, agents=(), models=()):
    """A seat whose five wired paths resolve, and whose config carries the given entries."""
    seat = tmp_path / "seat"
    (seat / "venv/Scripts").mkdir(parents=True)
    (seat / "sk_agent.py").write_text("# stub\n", encoding="utf-8")
    (seat / "venv/Scripts/python.exe").write_text("", encoding="utf-8")
    (seat / "no-python.exe").write_text("", encoding="utf-8")
    (seat / "no-papermill").mkdir()
    (seat / "sk_agent_config.json").write_text(
        json.dumps({"agents": list(agents), "models": list(models)}), encoding="utf-8")
    monkeypatch.setattr(D, "SK_DIR", seat)
    monkeypatch.setattr(D, "SK_PY", seat / "venv/Scripts/python.exe")
    monkeypatch.setattr(D, "SK_CONFIG", seat / "sk_agent_config.json")
    monkeypatch.setattr(D, "PM_PY", seat / "no-python.exe")
    monkeypatch.setattr(D, "PM_CWD", seat / "no-papermill")
    return seat


def _args(tmp_path, **kw):
    base = dict(issue=28079, notebook="S/N.ipynb", source_nb=None, from_spec=False,
                meta_from=None, repo=str(tmp_path / "repo"), out_dir=str(tmp_path / "out"),
                lane="myia-po-2028:claudish", verify_from=None, revise_from=None,
                max_stage=5, agent="notebook-coder-sol", verifier_agent="critic-terra",
                coder_model=None, verifier_model=None, spec_mode="skip", spec_model=None)
    base.update(kw)
    return SimpleNamespace(**base)


def _argv(tmp_path, *extra):
    return ["nb_coder_driver.py", "--issue", "28079", "--notebook", "S/N.ipynb",
            "--repo", str(tmp_path / "repo"), "--max-stage", "5",
            "--out-dir", str(tmp_path / "out"), "--worktree", str(tmp_path / "wt"),
            "--lane", "myia-po-2028:claudish",
            "--agent", "notebook-coder-sol", "--verifier-agent", "critic-terra", *extra]


def _git(*argv):
    p = subprocess.run(["git", *argv], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    assert p.returncode == 0, p.stderr
    return p.stdout


def _repo_with(tmp_path, files=("S/Present.ipynb",)):
    """A work repo whose origin/main holds exactly `files`."""
    origin = tmp_path / "origin.git"
    _git("init", "--bare", "-q", str(origin))
    seed = tmp_path / "seed"
    _git("init", "-q", str(seed))
    _git("-C", str(seed), "config", "user.email", "preflight@test")
    _git("-C", str(seed), "config", "user.name", "preflight")
    for rel in files:
        p = seed / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{}\n", encoding="utf-8")
    _git("-C", str(seed), "add", "-A")
    _git("-C", str(seed), "commit", "-q", "-m", "seed")
    _git("-C", str(seed), "branch", "-M", "main")
    _git("-C", str(seed), "remote", "add", "origin", str(origin))
    _git("-C", str(seed), "push", "-q", "origin", "main")
    repo = tmp_path / "repo"
    _git("init", "-q", str(repo))
    _git("-C", str(repo), "remote", "add", "origin", str(origin))
    return repo


_GAPPED_MODELS = [{"id": "nb-sol", "model_id": "gpt-6.1-sol",
                   "base_url": "http://127.0.0.1:3000/v1",
                   "api_key_env": "NBC_PF_CODER_KEY", "api_key": "no-key"},
                  {"id": "nb-terra", "model_id": "gpt-6.1-terra",
                   "base_url": "http://127.0.0.1:3000/v1",
                   "api_key_env": "NBC_PF_VERIFIER_KEY", "api_key": "no-key"}]
_GAPPED_AGENTS = [{"id": "notebook-coder-sol", "model": "nb-sol"},
                  {"id": "critic-terra", "model": "nb-terra"}]


# ---------------------------------------------------------------- credential (o34b)
def test_an_unset_api_key_env_is_refused_by_name_and_before_any_worktree(monkeypatch, tmp_path):
    """Measured o34b: the variable sk-agent resolves was unset; the 401 arrived at stage 1."""
    monkeypatch.delenv("NBC_PF_CODER_KEY", raising=False)
    monkeypatch.delenv("NBC_PF_VERIFIER_KEY", raising=False)
    _seat(monkeypatch, tmp_path, agents=_GAPPED_AGENTS, models=_GAPPED_MODELS)
    monkeypatch.setattr(sys, "argv", _argv(tmp_path))
    with pytest.raises(SystemExit) as e:
        D.main()
    assert e.value.code == 2
    rec = json.loads((tmp_path / "out" / "issue-28079.json").read_text(encoding="utf-8"))
    assert rec["verdict"] == "refused-credential-unresolved"
    assert rec["credential_missing"], "the refusal must name what it found"
    joined = "\n".join(rec["credential_missing"])
    assert "coder" in joined and "notebook-coder-sol" in joined and "nb-sol" in joined
    assert "$NBC_PF_CODER_KEY" in joined and "not set" in joined
    assert not (tmp_path / "wt").exists(), "no worktree may be built before this refusal"
    led = json.loads((tmp_path / "out" / "ledger.jsonl").read_text(encoding="utf-8").splitlines()[-1])
    assert led["verdict"] == "refused-credential-unresolved"
    assert "$NBC_PF_CODER_KEY" in led["refusal"], "the journal line carries the remedy"


def test_the_credential_refusal_never_carries_a_value(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("NBC_PF_VERIFIER_KEY", "sk-value-that-must-never-be-printed")
    monkeypatch.delenv("NBC_PF_CODER_KEY", raising=False)
    _seat(monkeypatch, tmp_path, agents=_GAPPED_AGENTS, models=_GAPPED_MODELS)
    monkeypatch.setattr(sys, "argv", _argv(tmp_path))
    with pytest.raises(SystemExit):
        D.main()
    printed = capsys.readouterr().err
    trace = (tmp_path / "out" / "issue-28079.json").read_text(encoding="utf-8")
    ledger = (tmp_path / "out" / "ledger.jsonl").read_text(encoding="utf-8")
    for blob in (printed, trace, ledger):
        assert "sk-value-that-must-never-be-printed" not in blob
        assert "$NBC_PF_CODER_KEY" in blob


def test_a_literal_key_is_a_fallback_and_refuses_nothing(monkeypatch, tmp_path):
    """sk-agent's resolve_api_key() falls back to the literal: the launch would authenticate."""
    monkeypatch.delenv("NBC_PF_CODER_KEY", raising=False)
    models = [{"id": "nb-sol", "api_key_env": "NBC_PF_CODER_KEY", "api_key": "a-real-literal"}]
    _seat(monkeypatch, tmp_path, agents=[{"id": "notebook-coder-sol", "model": "nb-sol"}],
          models=models)
    assert D._seat_credential_gaps(_args(tmp_path, max_stage=1)) == []


def test_the_verifier_is_asked_only_from_stage_4(monkeypatch, tmp_path):
    """Stage 3 never calls the verifier: its credential is nobody's question before stage 4."""
    monkeypatch.setenv("NBC_PF_CODER_KEY", "set")
    monkeypatch.delenv("NBC_PF_VERIFIER_KEY", raising=False)
    _seat(monkeypatch, tmp_path, agents=_GAPPED_AGENTS, models=_GAPPED_MODELS)
    assert D._seat_credential_gaps(_args(tmp_path, max_stage=3)) == []
    gaps = D._seat_credential_gaps(_args(tmp_path, max_stage=4))
    assert len(gaps) == 1 and gaps[0].startswith("verifier:")


def test_the_spec_turn_is_asked_when_spec_mode_runs(monkeypatch, tmp_path):
    monkeypatch.setenv("NBC_PF_CODER_KEY", "set")
    monkeypatch.delenv("NBC_PF_VERIFIER_KEY", raising=False)
    models = _GAPPED_MODELS + [{"id": "gpt-spec", "api_key_env": "NBC_PF_SPEC_KEY"}]
    _seat(monkeypatch, tmp_path, agents=_GAPPED_AGENTS, models=models)
    monkeypatch.delenv("NBC_PF_SPEC_KEY", raising=False)
    args = _args(tmp_path, max_stage=1, spec_mode="run", spec_model="gpt-spec")
    gaps = D._seat_credential_gaps(args)
    assert len(gaps) == 1 and gaps[0].startswith("spec:") and "$NBC_PF_SPEC_KEY" in gaps[0]


def test_what_the_check_cannot_read_is_left_to_sk_agent(monkeypatch, tmp_path):
    seat = _seat(monkeypatch, tmp_path)
    (seat / "sk_agent_config.json").write_text("{not json", encoding="utf-8")
    assert D._seat_credential_gaps(_args(tmp_path)) == []
    (seat / "sk_agent_config.json").write_text(json.dumps(
        {"agents": [{"id": "unknown-preset"}], "models": []}), encoding="utf-8")
    assert D._seat_credential_gaps(_args(tmp_path)) == []


def test_the_kill_switch_disables_the_credential_check(monkeypatch, tmp_path):
    monkeypatch.delenv("NBC_PF_CODER_KEY", raising=False)
    monkeypatch.setenv("NBCODER_PREFLIGHT_CREDENTIALS", "0")
    _seat(monkeypatch, tmp_path, agents=_GAPPED_AGENTS, models=_GAPPED_MODELS)
    assert D._seat_credential_gaps(_args(tmp_path)) == []


# ---------------------------------------------------------------- target (o34)
def test_a_creation_grain_without_a_twin_is_refused_before_the_worktree(monkeypatch, tmp_path):
    """Measured o34: the target was absent from origin/main and the queue line named no twin."""
    monkeypatch.delenv("NBC_PF_CODER_KEY", raising=False)
    _repo_with(tmp_path)                       # origin/main holds S/Present.ipynb, not S/N.ipynb
    _seat(monkeypatch, tmp_path)
    monkeypatch.setattr(sys, "argv", _argv(tmp_path))
    with pytest.raises(SystemExit) as e:
        D.main()
    assert e.value.code == 2
    rec = json.loads((tmp_path / "out" / "issue-28079.json").read_text(encoding="utf-8"))
    assert rec["verdict"] == "refused-target-unresolved"
    assert rec["target_gap"]["reason"] == "creation-grain-without-twin"
    assert rec["target_gap"]["target"] == "S/N.ipynb"
    assert len(rec["target_gap"]["origin_main"]) == 10
    assert "--source-nb" in rec["refusal"] and "--from-spec" in rec["refusal"]
    assert not (tmp_path / "wt").exists(), "no worktree may be built before this refusal"
    led = json.loads((tmp_path / "out" / "ledger.jsonl").read_text(encoding="utf-8").splitlines()[-1])
    assert led["verdict"] == "refused-target-unresolved"


def test_a_named_twin_absent_from_origin_main_is_refused_too(monkeypatch, tmp_path):
    _repo_with(tmp_path)
    _seat(monkeypatch, tmp_path)
    monkeypatch.setattr(sys, "argv", _argv(tmp_path, "--source-nb", "S/Missing.ipynb"))
    with pytest.raises(SystemExit):
        D.main()
    rec = json.loads((tmp_path / "out" / "issue-28079.json").read_text(encoding="utf-8"))
    assert rec["verdict"] == "refused-target-unresolved"
    assert rec["target_gap"]["reason"] == "source-nb-absent"
    assert rec["target_gap"]["source_nb"] == "S/Missing.ipynb"


def test_a_resolvable_launch_refuses_nothing(monkeypatch, tmp_path):
    """origin/main holds S/Present.ipynb; S/N.ipynb is a creation target."""
    _repo_with(tmp_path)
    _seat(monkeypatch, tmp_path)
    assert D._launch_target_gap(_args(tmp_path, notebook="S/Present.ipynb")) is None, \
        "a target on origin/main is a correction"
    assert D._launch_target_gap(_args(tmp_path, source_nb="S/Present.ipynb")) is None, \
        "an absent target with a present twin is a creation"


def test_a_resume_and_from_spec_carry_their_creation_mode_elsewhere(monkeypatch, tmp_path):
    _repo_with(tmp_path)
    _seat(monkeypatch, tmp_path)
    assert D._launch_target_gap(_args(tmp_path, revise_from=str(tmp_path / "t.json"))) is None
    assert D._launch_target_gap(_args(tmp_path, verify_from=str(tmp_path / "t.json"))) is None
    assert D._launch_target_gap(_args(tmp_path, from_spec=True,
                                       meta_from="S/Present.ipynb")) is None


def test_the_other_three_answers_of_run_s_target_resolution_are_asked_too(monkeypatch, tmp_path):
    """`run()` draws four verdicts from the same ref alone; one spend per answer is one too many."""
    _repo_with(tmp_path)
    _seat(monkeypatch, tmp_path)
    already = D._launch_target_gap(_args(tmp_path, notebook="S/Present.ipynb",
                                         source_nb="S/Present.ipynb"))
    assert already["reason"] == "target-already-exists", \
        "a creation flag on a target that exists is refused by run() after the worktree"
    spec = D._launch_target_gap(_args(tmp_path, notebook="S/Present.ipynb", from_spec=True,
                                      meta_from="S/Present.ipynb"))
    assert spec["reason"] == "target-already-exists"
    meta = D._launch_target_gap(_args(tmp_path, source_nb="S/Present.ipynb",
                                      meta_from="S/Missing.ipynb"))
    assert meta["reason"] == "meta-from-not-found" and meta["meta_from"] == "S/Missing.ipynb"
    first = D._launch_target_gap(_args(tmp_path, notebook="S/Present.ipynb",
                                       source_nb="S/Present.ipynb", meta_from="S/Missing.ipynb"))
    assert first["reason"] == "target-already-exists", "run()'s own order: target before meta"


def test_a_repo_git_cannot_read_is_never_an_absence(tmp_path):
    """The existing suite's `--repo D:/repo`: fetch fails, nothing is answered, nothing refused."""
    assert D._launch_target_gap(_args(tmp_path, repo=str(tmp_path / "no-such-repo"))) is None


def test_a_path_git_says_exists_on_disk_is_never_an_absence(monkeypatch, tmp_path):
    """A case-mismatched or untracked spelling is found by the Windows worktree: stay out."""
    repo = _repo_with(tmp_path)
    (repo / "S").mkdir()
    (repo / "S/N.ipynb").write_text("{}\n", encoding="utf-8")
    _seat(monkeypatch, tmp_path)
    assert D._launch_target_gap(_args(tmp_path)) is None