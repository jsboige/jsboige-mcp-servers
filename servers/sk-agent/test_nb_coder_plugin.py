"""#4832 — server-side workflow surface: runner, typed refusals, plugin wiring.

Offline: the harness home is monkeypatched to tmp fixtures (a stub
nb_coder_invoke.py echoing a parametrised envelope), so no network, no
engine, no papermill, no GitHub.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from nb_coder_plugin import STEPS, NbCoderPlugin, harness_home, run_nb_coder_workflow


STUB_INVOKE = r"""
import argparse, json, sys
ap = argparse.ArgumentParser()
ap.add_argument("--step", required=True)
ap.add_argument("--params", required=True)
ap.add_argument("--timeout", type=int, default=0)
a, _ = ap.parse_known_args()
json.loads(a.params)  # surface malformed params loudly
print(json.dumps({"step": a.step, "ok": VERDOK, "verdict": "VERDICT",
                  "issue": 26997, "pr": 4242 if "PR" else None}))
"""


def _fake_home(tmp_path, monkeypatch, verdict="stub-verdict", ok=True, with_pr=False):
    home = tmp_path / "nb_coder"
    home.mkdir()
    body = STUB_INVOKE.replace("VERDICT", verdict).replace(
        "VERDOK", "True" if ok else "False")
    if with_pr:
        body = body.replace('4242 if "PR" else None', "4242")
    (home / "nb_coder_invoke.py").write_text(body, encoding="utf-8")
    monkeypatch.setenv("SK_AGENT_NB_CODER_HOME", str(home))
    return home


class TestHarnessResolution:
    def test_default_home_is_module_relative_sibling(self):
        import nb_coder_plugin
        module_dir = Path(nb_coder_plugin.__file__).resolve().parent
        assert harness_home() == module_dir / "harness" / "nb_coder"
        assert (module_dir / "sk_agent.py").is_file()

    def test_env_override(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SK_AGENT_NB_CODER_HOME", str(tmp_path))
        assert harness_home() == tmp_path


class TestTypedRefusals:
    def test_bad_step(self, tmp_path, monkeypatch):
        _fake_home(tmp_path, monkeypatch)
        out = asyncio.run(run_nb_coder_workflow("nonsense", {}))
        assert out["error"] == "nb_coder_bad_step"
        assert out["valid_steps"] == list(STEPS)

    def test_harness_unresolved_names_what_was_probed(self, tmp_path, monkeypatch):
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("SK_AGENT_NB_CODER_HOME", str(empty))
        out = asyncio.run(run_nb_coder_workflow("code", {"issue": 1, "notebook": "n"}))
        assert out["error"] == "nb_coder_harness_unresolved"
        assert "nb_coder_invoke.py" in out["detail"]
        assert out["harness_home"].endswith("empty")
        assert "INVOCATION.md" in out["hint"]

    def test_bad_params_json_string(self, tmp_path, monkeypatch):
        _fake_home(tmp_path, monkeypatch)
        out = asyncio.run(run_nb_coder_workflow("code", "{not json"))
        assert out["error"] == "nb_coder_bad_params"

    def test_params_not_an_object(self, tmp_path, monkeypatch):
        _fake_home(tmp_path, monkeypatch)
        out = asyncio.run(run_nb_coder_workflow("code", ["issue"]))
        assert out["error"] == "nb_coder_bad_params"


class TestRunnerEnvelope:
    def test_envelope_returned_verbatim(self, tmp_path, monkeypatch):
        _fake_home(tmp_path, monkeypatch, verdict="pr-created", with_pr=True)
        out = asyncio.run(run_nb_coder_workflow(
            "code", {"issue": 26997, "notebook": "X.ipynb"}, timeout=60))
        assert out["step"] == "code"
        assert out["ok"] is True
        assert out["verdict"] == "pr-created"
        assert out["pr"] == 4242

    def test_params_pass_through_to_the_wrapper(self, tmp_path, monkeypatch):
        home = _fake_home(tmp_path, monkeypatch)
        out = asyncio.run(run_nb_coder_workflow("code", {"issue": 7}, timeout=60))
        assert out["ok"] is True
        # the stub echoes only if --params parsed as JSON: reaching ok proves it

    def test_timeout_is_typed(self, tmp_path, monkeypatch):
        slow = tmp_path / "nb_coder"
        slow.mkdir()
        (slow / "nb_coder_invoke.py").write_text(
            "import time; time.sleep(30)\n", encoding="utf-8")
        monkeypatch.setenv("SK_AGENT_NB_CODER_HOME", str(slow))
        out = asyncio.run(run_nb_coder_workflow("spec", {"record": "r"}, timeout=1))
        assert out["error"] == "nb_coder_timeout"
        assert out["timeout_s"] == 1

    def test_no_envelope_is_typed(self, tmp_path, monkeypatch):
        mute = tmp_path / "nb_coder"
        mute.mkdir()
        (mute / "nb_coder_invoke.py").write_text(
            "print('not json at all')\n", encoding="utf-8")
        monkeypatch.setenv("SK_AGENT_NB_CODER_HOME", str(mute))
        out = asyncio.run(run_nb_coder_workflow("spec", {}, timeout=30))
        assert out["error"] == "nb_coder_no_envelope"
        assert "not json" in out["tail"]


class TestPluginSurface:
    """Three kernel functions, one per step — the model cannot pick the wrong step."""

    def _function_names(self):
        from semantic_kernel.functions.kernel_plugin import KernelPlugin
        names = set(KernelPlugin.from_object("nb_coder", NbCoderPlugin()).functions)
        return names

    def test_exactly_three_step_functions(self):
        assert self._function_names() == {"nb_coder_spec", "nb_coder_code",
                                          "nb_coder_audit"}

    def test_functions_return_the_envelope_json(self, tmp_path, monkeypatch):
        _fake_home(tmp_path, monkeypatch, verdict="built-executed-ok")
        plugin = NbCoderPlugin()
        raw = asyncio.run(plugin.nb_coder_code('{"issue": 1, "notebook": "n"}', timeout=60))
        out = json.loads(raw)
        assert out["step"] == "code" and out["ok"] is True


class TestSpecNarrowOnly:
    """A call-level agent_spec must not switch the harness plugin ON (#4832)."""

    def test_nb_coder_tools_is_narrow_only(self):
        from sk_agent_specs import SPEC_NARROW_ONLY_PARAMETERS
        assert "nb_coder_tools" in SPEC_NARROW_ONLY_PARAMETERS

    def test_spec_cannot_widen_nb_coder_tools(self):
        from sk_agent_config import SKAgentConfig, AgentConfig, ModelConfig
        from sk_agent_specs import AgentSpec, resolve_agent_spec
        config = SKAgentConfig(
            default_agent="plain",
            models=[ModelConfig(id="m", model_id="m", base_url="http://x",
                                api_key="k")],
            agents=[AgentConfig(id="plain", model="m",
                                parameters={"nb_coder_tools": False})],
        )
        base = config.get_agent("plain")
        spec = AgentSpec(extends="plain", parameters={"nb_coder_tools": True})
        merged, _ = resolve_agent_spec(config, spec, base)
        assert merged.parameters["nb_coder_tools"] is False
