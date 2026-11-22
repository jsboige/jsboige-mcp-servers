# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_served_identity.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Pins for producer != verifier BY SERVED MODEL, not by sk-agent entry name.

20/11, po-2028:claudish: 11 requests of the `nb-minimax` entry were served by glm-5.3 through
a local sidecar reroute, while the verifier was glm-5.3 too. Every trace still read
`nb-minimax`: `model_used` is the sk-agent entry id, not the model that answered. The driver
now records the envelope's `served_model` / `failover_notice` when present, refuses an
approval signed by the model that served the draft, and says "modèle servi inconnu" in clear
when the envelope is silent. It never infers the served model from the requested id.

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


def call(stage, served=None, notice=None, chars=100, error=None):
    c = {"stage": stage, "model_used": "qwen3.6-35b-a3b-nbcoder", "response_chars": chars,
         "error": error}
    if served:
        c["served_model"] = served
    if notice:
        c["failover_notice"] = notice
    return c


# ---------------------------------------------------------------- identity
def test_the_same_served_model_on_both_sides_is_same():
    idt = d.served_identity([call("1-plan", "swift-1.5-27b"), call("2-build", "glm-5.3")],
                            {"served_model": "glm-5.3"})
    assert idt["status"] == "same" and idt["producer"] == ["glm-5.3", "swift-1.5-27b"]


def test_distinct_needs_every_answered_producer_call_named():
    calls = [call("1-plan", "swift-1.5-27b"), call("2-build", "swift-1.5-27b")]
    assert d.served_identity(calls, {"served_model": "glm-5.3"})["status"] == "distinct"
    calls.append(call("2.5-repair"))            # one silent envelope: no longer provable
    assert d.served_identity(calls, {"served_model": "glm-5.3"})["status"] == "unknown"


def test_a_silent_verifier_envelope_is_unknown_never_distinct():
    calls = [call("1-plan", "swift-1.5-27b")]
    assert d.served_identity(calls, {"model_used": "glm-5.3"})["status"] == "unknown"


def test_the_requested_id_is_never_read_as_the_served_model():
    # model_used names glm-5.3 on both sides, but no envelope says what served: unknown.
    calls = [dict(call("1-plan"), model_used="glm-5.3")]
    idt = d.served_identity(calls, {"model_used": "glm-5.3"})
    assert idt["status"] == "unknown" and idt["producer"] == [] and idt["verifier"] is None


def test_failed_and_empty_calls_do_not_count_as_producer_work():
    calls = [call("1-plan", "swift-1.5-27b"), call("2-build", "glm-5.3", error="500"),
             call("2-build-retry", "glm-5.3", chars=0)]
    idt = d.served_identity(calls, {"served_model": "glm-5.3"})
    assert idt["status"] == "distinct" and idt["producer"] == ["swift-1.5-27b"]


# ms#1824 (#4844 c.7042525323): `served_model` is the LAST round's value only; the distinct
# values of a multi-round call live in `served_model_variants`, present only when > 1.
def test_a_non_last_producer_round_served_by_the_verifier_model_is_same():
    c = dict(call("2-build", "swift-1.5-27b"), served_model_variants=["glm-5.3", "swift-1.5-27b"])
    idt = d.served_identity([c], {"served_model": "glm-5.3"})
    assert idt["status"] == "same" and idt["shared"] == ["glm-5.3"]


def test_a_non_last_verifier_round_served_by_the_producer_model_is_same():
    v = {"served_model": "glm-5.3", "served_model_variants": ["swift-1.5-27b", "glm-5.3"]}
    idt = d.served_identity([call("2-build", "swift-1.5-27b")], v)
    assert idt["status"] == "same" and idt["shared"] == ["swift-1.5-27b"]


def test_disjoint_variants_stay_distinct():
    c = dict(call("2-build", "swift-1.5-27b"), served_model_variants=["kimi", "swift-1.5-27b"])
    v = {"served_model": "glm-5.3", "served_model_variants": ["minimax", "glm-5.3"]}
    idt = d.served_identity([c], v)
    assert idt["status"] == "distinct"
    assert idt["producer"] == ["kimi", "swift-1.5-27b"] and idt["verifier"] == "glm-5.3, minimax"


def test_variants_alone_name_the_served_model():
    c = dict(call("2-build"), served_model_variants=["swift-1.5-27b"])
    assert d.served_identity([c], {"served_model": "glm-5.3"})["status"] == "distinct"


def test_calls_record_the_variant_fields(monkeypatch):
    envs = [{"response": "ok", "served_model": "swift-1.5-27b",
             "served_model_variants": ["glm-5.3", "swift-1.5-27b"],
             "failover_notice": "b", "failover_notice_variants": ["a", "b"]}]

    async def fake_sk(session, args, prompt, conv, max_tokens=None, model=None, **kw):
        return envs.pop(0), 1.0

    monkeypatch.setattr(d, "sk_call", fake_sk)
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    rec = {"calls": []}
    asyncio.run(d.sk_call_retry(None, None, rec, "2-build", "p", None))
    (c,) = rec["calls"]
    assert c["served_model_variants"] == ["glm-5.3", "swift-1.5-27b"]
    assert c["failover_notice_variants"] == ["a", "b"]
    assert d.served_identity(rec["calls"], {})["failovers"] == [
        {"stage": "2-build", "notice": "a | b"}]


def test_failover_notices_are_listed_whatever_the_status():
    calls = [call("1-plan", notice="role=nb, served by glm-5.3")]
    idt = d.served_identity(calls, {"failover_notice": "role=verify, served by kimi"})
    assert idt["status"] == "unknown"
    assert [f["stage"] for f in idt["failovers"]] == ["1-plan", "4-verify"]


@pytest.mark.parametrize("identity, expected", [
    (None, "modèle servi inconnu"),
    ({"status": "unknown", "producer": [], "verifier": None, "failovers": []},
     "modèle servi inconnu"),
    ({"status": "distinct", "producer": ["swift-1.5-27b"], "verifier": "glm-5.3",
      "failovers": []}, "producteur swift-1.5-27b ≠ vérificateur glm-5.3"),
    ({"status": "same", "producer": ["glm-5.3"], "verifier": "glm-5.3", "failovers": []},
     "MÊME modèle servi"),
])
def test_the_pr_line_says_what_served_or_that_it_is_unknown(identity, expected):
    assert expected in d.identity_line(identity)


def test_the_pr_line_names_the_failover_stages():
    idt = {"status": "unknown", "producer": [], "verifier": None,
           "failovers": [{"stage": "2-build", "notice": "x"}]}
    assert d.identity_line(idt).endswith("bascule au hub sur 2-build")


# ---------------------------------------------------------------- envelope recording
def test_calls_record_the_served_fields_only_when_the_envelope_has_them(monkeypatch):
    envs = [{"response": "ok", "model_used": "nb-minimax", "served_model": "glm-5.3",
             "failover_notice": "role=nb"},
            {"response": "ok", "model_used": "nb-minimax"}]

    async def fake_sk(session, args, prompt, conv, max_tokens=None, model=None, **kw):
        return envs.pop(0), 1.0

    monkeypatch.setattr(d, "sk_call", fake_sk)
    monkeypatch.setattr(d, "engine_tokens", lambda: {})
    rec = {"calls": []}
    asyncio.run(d.sk_call_retry(None, None, rec, "1-plan", "p", None))
    asyncio.run(d.sk_call_retry(None, None, rec, "2-build", "p", None))
    first, second = rec["calls"]
    assert first["served_model"] == "glm-5.3" and first["failover_notice"] == "role=nb"
    assert "served_model" not in second and "failover_notice" not in second


# ---------------------------------------------------------------- stage 4 verdict
def _stage4(monkeypatch, tmp_path, calls, trace, rc):
    def fake_run(cmd, **kw):
        (tmp_path / "verify-7.json").write_text(json.dumps(trace), encoding="utf-8")
        return SimpleNamespace(returncode=rc, stdout="", stderr="")

    monkeypatch.setattr(d.subprocess, "run", fake_run)
    args = SimpleNamespace(issue=7, verifier_agent="nb-verifier", verify_timeout=60,
                           from_spec=False)
    rec = {"calls": calls}
    d.stage4_verify(args, rec, tmp_path / "src.ipynb", tmp_path / "built.ipynb", tmp_path)
    return rec


def test_an_approval_by_the_model_that_served_the_draft_is_refused(monkeypatch, tmp_path):
    rec = _stage4(monkeypatch, tmp_path, [call("2-build", "glm-5.3")],
                  {"verdict": "approve", "model_used": "glm-5.3", "served_model": "glm-5.3"}, 0)
    assert rec["verdict"] == "verify-same-served-model"
    assert rec["verify"]["identity"]["status"] == "same"


def test_an_approval_is_refused_when_only_a_non_last_round_matches(monkeypatch, tmp_path):
    c = dict(call("2-build", "swift-1.5-27b"), served_model_variants=["glm-5.3", "swift-1.5-27b"])
    rec = _stage4(monkeypatch, tmp_path, [c],
                  {"verdict": "approve", "served_model": "glm-5.3"}, 0)
    assert rec["verdict"] == "verify-same-served-model"
    assert "MÊME modèle servi des deux côtés (glm-5.3)" in d.identity_line(
        rec["verify"]["identity"])


def test_a_pre_variants_same_record_still_renders():
    idt = {"status": "same", "producer": ["glm-5.3"], "verifier": "glm-5.3", "failovers": []}
    assert "(glm-5.3)" in d.identity_line(idt)


def test_a_distinct_approval_stands(monkeypatch, tmp_path):
    rec = _stage4(monkeypatch, tmp_path, [call("2-build", "swift-1.5-27b")],
                  {"verdict": "approve", "served_model": "glm-5.3"}, 0)
    assert rec["verdict"] == "verify-approved"
    assert rec["verify"]["served_model"] == "glm-5.3"


def test_an_unknown_identity_keeps_the_approval_and_says_so(monkeypatch, tmp_path):
    rec = _stage4(monkeypatch, tmp_path, [call("2-build")],
                  {"verdict": "approve", "model_used": "glm-5.3"}, 0)
    assert rec["verdict"] == "verify-approved"
    assert rec["verify"]["identity"]["status"] == "unknown"
    assert "modèle servi inconnu" in d.identity_line(rec["verify"]["identity"])


def test_a_reject_stays_a_reject_even_by_the_same_model(monkeypatch, tmp_path):
    rec = _stage4(monkeypatch, tmp_path, [call("2-build", "glm-5.3")],
                  {"verdict": "reject", "served_model": "glm-5.3",
                   "answer": {"findings": [{"cell": 1}]}}, 1)
    assert rec["verdict"] == "verify-reject"


def test_the_refusal_is_not_a_scheduler_success():
    import nb_coder_scheduler as s
    assert not "verify-same-served-model".endswith(s.DONE_VERDICT_SUFFIXES)
