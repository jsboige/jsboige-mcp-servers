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
