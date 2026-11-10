"""Guard for #1748 H(i): the benchmark runner derives its model list from the config.

A hardcoded list goes stale silently — the previous literal kept naming `glm-5`,
`glm-5-not` and `glm-4.7-flash` after they had left the config, and never named the
variants that replaced them. These tests fail if the runner names an id the loaded
config does not declare, or silently skips one it does.
"""

import sys
from pathlib import Path

SK_AGENT_DIR = Path(__file__).parent
sys.path.insert(0, str(SK_AGENT_DIR))

import run_benchmark  # noqa: E402  (needs the path insert above)


def _cfg(*models: dict) -> dict:
    return {"models": list(models)}


def test_only_enabled_models_are_benchmarked():
    cfg = _cfg(
        {"id": "alpha", "enabled": True},
        {"id": "beta", "enabled": False},
        {"id": "gamma", "enabled": True},
    )
    assert run_benchmark.derive_benchmark_model_ids(cfg) == ["alpha", "gamma"]


def test_model_without_enabled_flag_is_not_benchmarked():
    assert run_benchmark.derive_benchmark_model_ids(_cfg({"id": "alpha"})) == []


def test_empty_config_yields_no_model():
    assert run_benchmark.derive_benchmark_model_ids({"models": []}) == []


def test_runner_names_no_id_absent_from_the_loaded_config():
    """The regression guard: a stale hardcoded id fails here."""
    declared = {m["id"] for m in run_benchmark.config.get("models", [])}
    undeclared = [mid for mid in run_benchmark.BENCHMARK_MODEL_IDS if mid not in declared]
    assert undeclared == [], (
        f"{run_benchmark.ACTIVE_CONFIG_PATH.name} declares no model "
        f"with these ids: {undeclared}"
    )


def test_runner_skips_no_model_the_loaded_config_enables():
    """Nothing enabled is silently left out: the list is exactly the enabled set."""
    enabled = [
        m["id"] for m in run_benchmark.config.get("models", []) if m.get("enabled", False)
    ]
    assert run_benchmark.BENCHMARK_MODEL_IDS == enabled


# --- #3401: key resolution reads env FIRST when api_key_env is set ---


def test_api_key_env_wins_over_a_decoy_literal():
    """The regression: a decoy literal must NOT be used when env is set.

    The old form read the literal first and only fell back to env when the
    literal was empty — so a present-but-decoy literal was used as-is and the
    benchmark measured 401s, not the models.
    """
    cfg = {"api_key": "decoy-literal-24c", "api_key_env": "REAL_KEY"}
    assert run_benchmark.resolve_benchmark_api_key(cfg, environ={"REAL_KEY": "real-env-32c"}) == "real-env-32c"


def test_api_key_env_absent_falls_back_to_literal():
    """No env var set -> the literal is the fallback (resolve_api_key parity)."""
    cfg = {"api_key": "literal-fallback", "api_key_env": "MISSING_KEY"}
    assert run_benchmark.resolve_benchmark_api_key(cfg, environ={}) == "literal-fallback"


def test_api_key_env_set_but_empty_resolves_empty():
    """Exact resolve_api_key parity: env SET but empty resolves to "".

    This pins the real behaviour (no literal fallback on empty), so the decoy
    fix stays scoped to a present env var and never silently changes the
    empty-env case.
    """
    cfg = {"api_key": "literal-fallback", "api_key_env": "EMPTY_KEY"}
    assert run_benchmark.resolve_benchmark_api_key(cfg, environ={"EMPTY_KEY": ""}) == ""


def test_no_api_key_env_uses_literal():
    """Without api_key_env, the literal is used as-is (unchanged behaviour)."""
    cfg = {"api_key": "plain-literal"}
    assert run_benchmark.resolve_benchmark_api_key(cfg, environ={"IGNORED": "x"}) == "plain-literal"


def test_no_key_at_all_returns_empty():
    assert run_benchmark.resolve_benchmark_api_key({}, environ={}) == ""


# --- #1748 H(ii): direct calls preserve model modes; errors are unmeasured ---


def test_direct_call_passes_model_extra_body(monkeypatch):
    """Model-specific vLLM arguments reach the direct HTTP request."""
    captured = {}

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return {"choices": [{"message": {"content": "ok"}}]}

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def post(self, url, json, headers):
            captured.update(json)
            return FakeResponse()

    monkeypatch.setattr(run_benchmark.httpx, "Client", FakeClient)
    model = {
        "model_id": "swift",
        "base_url": "http://localhost/v1",
        "thinking": True,
        "extra_body": {"chat_template_kwargs": {"enable_thinking": True}},
    }
    result = run_benchmark.call_model(model, "probe")
    assert result["response"] == "ok"
    assert captured["extra_body"]["chat_template_kwargs"]["enable_thinking"] is True


def test_direct_call_disables_thinking_without_clobbering_model_kwargs(monkeypatch):
    """Parity with sk_agent.py: thinking=false wins, other kwargs survive."""
    captured = {}

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return {"choices": [{"message": {"content": "ok"}}]}

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def post(self, url, json, headers):
            captured.update(json)
            return FakeResponse()

    monkeypatch.setattr(run_benchmark.httpx, "Client", FakeClient)
    model = {
        "model_id": "swift",
        "base_url": "http://localhost/v1",
        "thinking": False,
        "extra_body": {"chat_template_kwargs": {"enable_thinking": True, "other": 1}},
    }
    run_benchmark.call_model(model, "probe")
    assert captured["extra_body"]["chat_template_kwargs"] == {
        "enable_thinking": False,
        "other": 1,
    }


def test_scorer_is_not_mistaken_for_a_semantic_judge():
    """Pin the limitation that the report must disclose, not hide.

    A surface heuristic can award 5/5 to a valid JSON carrying a wrong O(n^3)
    complexity; this is why G needs a real judge rather than this raw score.
    """
    wrong_complexity = '{"complexity":"O(n^3)","bug_risk":"low","suggestion":"use set"}'
    assert run_benchmark.score_response("json_output", TASK_FOR_SCORE, wrong_complexity) == 5.0


TASK_FOR_SCORE = {"prompt": "not used by the heuristic"}
