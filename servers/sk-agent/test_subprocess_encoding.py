"""Guard: every subprocess call that decodes its child's output must name the codec.

A `text=True` without `encoding=` decodes in the LOCALE encoding: cp1252 on a Windows
seat, UTF-8 on the Linux runners. The same harness then reads the same child two
different ways, and a byte cp1252 leaves undefined (0x81, 0x8D, 0x8F, 0x90, 0x9D) raises
UnicodeDecodeError where CI was green — measured 25/11 on this seat: the closed CI list
only passed with PYTHONUTF8=1 exported, and a per-line grep could not even see the class
(an `encoding=` sitting on the next line of a multi-line call looks absent).

The scan is an AST walk, never a regex: a multi-line call is one Call node. It fails CLOSED
— a non-literal `text=<expr>` is reported too, because it cannot be proven byte-safe from
the source. Counters are asserted to close (files found = parsed + unparsable, sites
counted = sites reported) so an empty scan can never read as a pass.
"""
from __future__ import annotations

import ast
import os
from pathlib import Path

import pytest

EXCLUDE_PARTS = {"__pycache__", "venv", ".venv", "site-packages", "build", "dist", "node_modules", ".git"}
SUB = ("run", "check_output", "check_call", "call", "Popen", "getoutput", "getstatusoutput")
LOCALE_ONLY = ("getoutput", "getstatusoutput")


def _sites(root: Path):
    found = parsed = 0
    unparsable: list[str] = []
    violations: list[str] = []
    counted = 0
    for path in sorted(root.rglob("*.py")):
        if EXCLUDE_PARTS & set(path.parts):
            continue
        found += 1
        try:
            src = path.read_text(encoding="utf-8")
            tree = ast.parse(src, filename=str(path))
        except Exception as exc:  # a file we cannot read is a hole in the guard, never a pass
            unparsable.append(f"{path}: {type(exc).__name__}")
            continue
        parsed += 1
        rel = path.relative_to(root).as_posix()
        mods, imported = {"subprocess"}, set()
        for node in tree.body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == "subprocess":
                        mods.add(alias.asname or "subprocess")
            elif isinstance(node, ast.ImportFrom) and node.module == "subprocess":
                for alias in node.names:
                    if alias.name in SUB:
                        imported.add(alias.asname or alias.name)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id in mods and func.attr in SUB:
                name = func.attr
            elif isinstance(func, ast.Name) and func.id in imported:
                name = func.id
            else:
                continue
            kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg is not None}
            counted += 1
            if name in LOCALE_ONLY:
                violations.append(f"{rel}:{node.lineno}: subprocess.{name}() decodes in the locale encoding and takes no encoding= — use run(...) with encoding=")
                continue
            if "encoding" in kwargs:
                continue
            mode = kwargs.get("text") or kwargs.get("universal_newlines")
            if mode is None:
                continue
            try:
                literal = ast.literal_eval(mode)
            except Exception:
                violations.append(f"{rel}:{node.lineno}: subprocess.{name}(text=<non-literal>) without encoding= — cannot be proven byte-safe; pass encoding= explicitly")
                continue
            if literal in (True, 1):
                violations.append(f"{rel}:{node.lineno}: subprocess.{name}(text=True) without encoding= — add encoding=\"utf-8\", errors=\"replace\"")
    return found, parsed, unparsable, violations, counted


def test_subprocess_text_mode_names_its_codec():
    root = Path(__file__).resolve().parent
    found, parsed, unparsable, violations, counted = _sites(root)
    assert found == parsed + len(unparsable), f"scan control: found={found} parsed={parsed} unparsable={unparsable}"
    assert not unparsable, f"files the guard could not read: {unparsable}"
    assert counted > 20, f"scan control: only {counted} subprocess calls seen under {root} — the walk is broken, not the tree clean"
    assert not violations, "subprocess decode sites without an explicit encoding:\n" + "\n".join(violations)


class TestCiRunsThisGuard:
    def test_ci_sk_agent_job_runs_this_file(self):
        """The test-sk-agent job runs an explicit file list (same wiring guard as
        test_turn_control.py): a guard nobody runs is not a guard."""
        ci = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml"
        if not ci.exists():
            pytest.skip("server copied without its repository (no ci.yml)")
        lines = ci.read_text(encoding="utf-8").splitlines()
        start = lines.index("  test-sk-agent:")
        job = []
        for line in lines[start + 1 :]:
            if line.startswith("  ") and not line.startswith("   ") and line.rstrip().endswith(":"):
                break  # next job
            job.append(line)
        pytest_lines = [line for line in job if "python -m pytest" in line]
        assert pytest_lines, "test-sk-agent job runs no pytest command"
        assert any(os.path.basename(__file__) in line.split() for line in pytest_lines), (
            "test_subprocess_encoding.py is missing from the test-sk-agent pytest list"
        )
