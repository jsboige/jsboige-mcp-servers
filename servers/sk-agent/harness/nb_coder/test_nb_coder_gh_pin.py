# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_gh_pin.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
# -----------------------------------------------------------------------------
"""Pinned gh identity (21/11, CoursIA#27781: PR create 422 "must be a collaborator" after the
active gh account drifted mid-run)."""
import json

import pytest

import nb_coder_driver as d

STATUS = {"hosts": {"github.com": [
    {"login": "drifted", "active": True, "state": "success"},
    {"login": "lane", "active": False, "state": "success"},
    {"login": "broken", "active": False, "state": "error"},
]}}


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    d.GH_IDENTITY.clear()
    for k in ("NBCODER_GH_USER", "GH_TOKEN", "GITHUB_TOKEN", "NBCODER_GH_APP_ID", "NBCODER_GH_KEY"):
        monkeypatch.delenv(k, raising=False)
    yield
    d.GH_IDENTITY.clear()


def fake_gh_out(calls, push_ok=("tok-lane",)):
    def run(argv, timeout=20, token=None):
        calls.append((tuple(argv), token))
        if argv[:2] == ["auth", "status"]:
            return json.dumps(STATUS)
        if argv[:3] == ["auth", "token", "-u"]:
            return f"tok-{argv[3]}"
        if argv[0] == "api" and argv[1].startswith("repos/"):
            return "true" if token in push_ok else "false"
        return None
    return run


def test_skips_active_account_without_push(monkeypatch):
    calls = []
    monkeypatch.setattr(d, "_gh_out", fake_gh_out(calls))
    assert d.app_token(d.Path(".")) == "tok-lane"
    rec = d.gh_identity_record()
    assert rec["login"] == "lane" and rec["source"] == "push-probe"
    assert rec["tried"] == ["drifted", "lane"]          # active first, errored account never tried
    assert "_token" not in rec                          # the token never reaches the record


def test_pin_is_taken_once_per_process(monkeypatch):
    calls = []
    monkeypatch.setattr(d, "_gh_out", fake_gh_out(calls))
    d.pinned_gh_token()
    n = len(calls)
    assert d.pinned_gh_token() == "tok-lane"
    assert len(calls) == n                              # a later switch cannot move the pin


def test_explicit_user_is_never_second_guessed(monkeypatch):
    calls = []
    monkeypatch.setenv("NBCODER_GH_USER", "drifted")
    monkeypatch.setattr(d, "_gh_out", fake_gh_out(calls))
    assert d.pinned_gh_token() == "tok-drifted"
    assert d.gh_identity_record()["source"] == "NBCODER_GH_USER"
    assert not any(a[0] == "api" for a, _ in calls)     # no push probe for an explicit pin


def test_no_account_can_push_falls_back_to_active(monkeypatch):
    monkeypatch.setattr(d, "_gh_out", fake_gh_out([], push_ok=()))
    assert d.pinned_gh_token() is None
    assert d.gh_identity_record()["source"] == "no-account-can-push"


def test_operator_token_is_respected(monkeypatch):
    calls = []
    monkeypatch.setenv("GH_TOKEN", "operator")
    monkeypatch.setattr(d, "_gh_out", fake_gh_out(calls))
    assert d.pinned_gh_token() is None
    assert calls == [] and d.gh_identity_record()["source"] == "env-token"


def test_gh_logins_tolerates_garbage(monkeypatch):
    monkeypatch.setattr(d, "_gh_out", lambda argv, timeout=20, token=None: "not json")
    assert d.gh_logins() == []
