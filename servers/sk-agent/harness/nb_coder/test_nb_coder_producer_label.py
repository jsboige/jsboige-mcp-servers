# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/test_nb_coder_producer_label.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""The PR names its producer by the CONFIGURED target, not by the sk-agent entry id alone.

Entry ids keep historical names: `qwen3.6-35b-a3b-nbcoder` points at Swift on :5002. Citing
the id alone named the retired MoE as producer, and Swift's PRs were counted as nobody's
(claudish #445 tally, 20/11). The label says "cible configurée": what ANSWERED is the
`served_model` line's business (#504), never inferred from config.

Skipped when `mcp` is not importable (the driver imports the MCP client at load).
"""
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("mcp")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_coder_driver as d  # noqa: E402


@pytest.fixture
def cfg(tmp_path):
    p = tmp_path / "sk_agent_config.json"
    p.write_text(json.dumps({"models": [
        {"id": "qwen3.6-35b-a3b-nbcoder", "base_url": "http://host.docker.internal:5002/v1",
         "model_id": "swift-1.5-27b", "api_key_env": "SECRET_ENV_NAME"},
        {"id": "glm-5.3", "base_url": "http://192.168.0.50:3000/v1", "model_id": "glm-5.3"},
        {"id": "no-model", "base_url": "http://x:1/v1"},
        {"id": "no-port", "base_url": "http://hub/v1", "model_id": "m"},
    ]}), encoding="utf-8")
    return p


def test_the_legacy_entry_id_resolves_to_swift(cfg):
    assert d.configured_target("qwen3.6-35b-a3b-nbcoder", cfg) == "swift-1.5-27b sur :5002"
    label = d.producer_label("notebook-coder", "qwen3.6-35b-a3b-nbcoder", cfg)
    assert label == ("`notebook-coder` (entrée sk-agent `qwen3.6-35b-a3b-nbcoder` "
                     "→ cible configurée `swift-1.5-27b sur :5002`)")


def test_the_label_never_leaks_host_or_key(cfg):
    label = d.producer_label("critic", "glm-5.3", cfg)
    assert "192.168" not in label and "SECRET_ENV_NAME" not in label
    assert "host.docker.internal" not in d.producer_label(
        "notebook-coder", "qwen3.6-35b-a3b-nbcoder", cfg)


@pytest.mark.parametrize("entry, expected", [
    (None, "`a` (entrée sk-agent inconnue)"),
    ("absent-entry", "`a` (entrée sk-agent `absent-entry`, cible non lue)"),
    ("no-model", "`a` (entrée sk-agent `no-model`, cible non lue)"),
])
def test_unknown_stays_unknown(cfg, entry, expected):
    assert d.producer_label("a", entry, cfg) == expected


def test_no_port_keeps_the_model_alone(cfg):
    assert d.configured_target("no-port", cfg) == "m"


def test_an_unreadable_config_is_not_a_target(tmp_path):
    assert d.configured_target("x", tmp_path / "missing.json") is None
    (tmp_path / "bad.json").write_text("{", encoding="utf-8")
    assert d.configured_target("x", tmp_path / "bad.json") is None


def test_the_pr_body_uses_the_label_for_both_sides():
    src = (Path(__file__).parent / "nb_coder_driver.py").read_text(encoding="utf-8")
    assert "producer_label(args.agent," in src and "producer_label(args.verifier_agent," in src
