# Canonical home is sk-agent: new harness fixes belong here, not in vllm.
# Harness base is the vllm re-copy @ 443b38c0fae70f64aa46198d51bdb74357df1853.
"""#4832 — the canonical invocation wrapper: contract tests, fully offline.

``nb_coder_invoke.py`` is the ONE documented entry (INVOCATION.md): closed
param sets, CLI mapping, envelope contract. These tests pin:

- the closed set refuses unknown keys and missing required keys (a typo'd
  ``notebok`` must refuse, never silently default);
- the snake_case -> --kebab-case mapping, booleans as bare flags;
- the envelope verdict/ok extraction per step, including the audit rule
  (instrument error is NEVER a reject) and the code-step record enrichment;
- the dry-run mode spawns nothing.

The step scripts are replaced by a stub that echoes a fixed payload, so no
network, no engine, no GitHub, no papermill.
"""

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import nb_coder_invoke as nci


STUB = r"""
import argparse, json, sys
ap = argparse.ArgumentParser()
ap.add_argument("--issue", type=int)
ap.add_argument("--notebook")
ap.add_argument("--out-dir")
known, _ = ap.parse_known_args(sys.argv[1:])
print("some progress noise")
print(json.dumps({"issue": known.issue, "verdict": STUB_VERDICT, "pr": STUB_PR}))
"""


@pytest.fixture
def stub_script(tmp_path, monkeypatch, request):
    """A fake step script echoing a parametrised final JSON line."""
    verdict = getattr(request, "param", "built-executed-ok")
    pr = 4242 if verdict == "pr-created" else None
    script = tmp_path / "stub_step.py"
    script.write_text(STUB.replace("STUB_VERDICT", repr(verdict)).replace("STUB_PR", repr(pr)),
                      encoding="utf-8")
    monkeypatch.setitem(nci.STEP_SPECS, "code",
                        (str(script), nci.CODE_FIELDS, ("issue", "notebook")))
    return script


class TestClosedSets:
    def test_unknown_key_refuses(self):
        with pytest.raises(ValueError, match="unknown code param"):
            nci.build_command("code", {"issue": 1, "notebook": "n.ipynb", "notebok": "typo"})

    def test_missing_required_refuses(self):
        with pytest.raises(ValueError, match="missing required code param"):
            nci.build_command("code", {"issue": 1})

    def test_spec_requires_record_notebook_ref(self):
        with pytest.raises(ValueError, match="missing required spec param"):
            nci.build_command("spec", {"record": "r.json", "notebook": "n.ipynb"})

    def test_audit_requires_source_and_built(self):
        with pytest.raises(ValueError, match="missing required audit param"):
            nci.build_command("audit", {"issue": 5, "source_nb": "s.ipynb"})


class TestCommandMapping:
    def test_snake_case_maps_to_kebab_flags(self):
        argv = nci.build_command("code", {
            "issue": 26997, "notebook": "X.ipynb", "repo": "D:/CoursIA",
            "max_stage": 2, "write_mode": "json"})
        assert "--max-stage" in argv and "2" == argv[argv.index("--max-stage") + 1]
        assert "--write-mode" in argv
        assert "--issue" in argv and "26997" == argv[argv.index("--issue") + 1]
        assert "--notebook" in argv and "X.ipynb" == argv[argv.index("--notebook") + 1]

    def test_booleans_are_bare_flags(self):
        argv = nci.build_command("code", {"issue": 1, "notebook": "n", "claim": True,
                                          "fresh_worktree": False})
        assert "--claim" in argv
        assert "--fresh-worktree" not in argv

    def test_int_string_coerced_bool_refused(self):
        argv = nci.build_command("code", {"issue": "26997", "notebook": "n"})
        assert "26997" == argv[argv.index("--issue") + 1]
        with pytest.raises(ValueError, match="issue: integer expected"):
            nci.build_command("code", {"issue": 1.5, "notebook": "n"})
        with pytest.raises(ValueError, match="claim: boolean expected"):
            nci.build_command("code", {"issue": 1, "notebook": "n", "claim": "yes"})

    def test_spec_positional_record(self):
        argv = nci.build_command("spec", {"record": "rec.json", "notebook": "n",
                                          "ref": "abc123"})
        assert "rec.json" in argv
        assert "--record" not in argv          # record is positional, not a flag


class TestEnvelope:
    @pytest.mark.parametrize("stub_script", ["built-executed-ok"], indirect=True)
    def test_code_envelope_ok_and_verdict(self, stub_script, tmp_path, monkeypatch):
        rec = tmp_path / "issue-1.json"
        rec.write_text(json.dumps({"pr": {"number": 4242, "url": "http://x/4242"}}),
                       encoding="utf-8")
        import types
        fake_driver = types.ModuleType("nb_coder_driver")
        fake_driver.VLLM_ROOT = str(tmp_path)
        monkeypatch.setitem(sys.modules, "nb_coder_driver", fake_driver)
        env = nci.run_step("code", {"issue": 1, "notebook": "n.ipynb",
                                    "out_dir": str(tmp_path)}, timeout=60)
        assert env["ok"] is True
        assert env["verdict"] == "built-executed-ok"
        assert env["pr"] == 4242
        assert env["pr_url"] == "http://x/4242"
        assert env["trace"].endswith("issue-1.json")
        assert env["step"] == "code" and env["exit"] == 0

    @pytest.mark.parametrize("stub_script", ["refused-claim-held-by-another-lane"],
                             indirect=True)
    def test_code_refusal_is_not_ok(self, stub_script):
        env = nci.run_step("code", {"issue": 1, "notebook": "n"}, timeout=60)
        assert env["ok"] is False
        assert env["verdict"] == "refused-claim-held-by-another-lane"

    def test_dry_run_spawns_nothing(self, monkeypatch):
        def boom(*a, **k):
            raise AssertionError("dry-run must not spawn")

        monkeypatch.setattr(nci.subprocess, "Popen", boom)
        env = nci.run_step("code", {"issue": 1, "notebook": "n"}, timeout=5, dry_run=True)
        assert env["verdict"] == "dry-run" and env["ok"] is None
        assert env["command"]

    def test_last_json_extractor_compact_and_indented(self):
        compact = 'noise {"a":1}\nprogress\n{"issue":1,"verdict":"v"}\ntrailing'
        assert nci._last_json_object(compact)["verdict"] == "v"
        # the verifier's final print is INDENTED json — multi-line, must parse
        indented = 'log line\n{\n  "verdict": "approve",\n  "trace": "t.json"\n}\n'
        got = nci._last_json_object(indented)
        assert got["verdict"] == "approve" and got["trace"] == "t.json"

    def test_audit_envelope_verdict_and_instrument_error(self, tmp_path, monkeypatch):
        """exit 2 = instrument error, NEVER a reject; envelope carries the flag."""
        stub = tmp_path / "stub_verify.py"
        stub.write_text(
            "import json, sys\n"
            "print(json.dumps({'verdict': 'error:unparsable', 'trace': 'x.json'}, indent=1))\n"
            "sys.exit(2)\n", encoding="utf-8")
        monkeypatch.setitem(nci.STEP_SPECS, "audit",
                            (str(stub), nci.AUDIT_FIELDS, ("issue", "source_nb", "built_nb")))
        env = nci.run_step("audit", {"issue": 5, "source_nb": "s.ipynb",
                                     "built_nb": "b.ipynb"}, timeout=60)
        assert env["verdict"] == "error:unparsable"
        assert env["instrument_error"] is True
        assert env["ok"] is False
