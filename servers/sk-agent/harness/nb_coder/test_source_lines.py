# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 932e556f93b26e8eadb1dd91094351985f910f69
# original path: myia_vllm/scripts/adoption/nb_coder/test_source_lines.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Offline regression tests for the deterministic writer (no MCP/network needed).

`apply_edits` and `normalize_sources` are the two functions that decide what every
deliverable notebook looks like: a str source written back reformats the whole cell
JSON and inflates each harness PR's diff (CR CoursIA 14/11, point 1a). Neither had a
test on main — this file is the coverage that PR #432 asked for, re-pointed at the
`_lines` helper main ended up with.

The driver is exercised through AST extraction so the test does not need the MCP
runtime dependencies (mcp, sk-agent, papermill).
"""
import ast
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

TREE = ast.parse(Path(__file__).with_name("nb_coder_driver.py").read_text(encoding="utf-8"))
NODES = [n for n in TREE.body if isinstance(n, ast.FunctionDef)
         and n.name in {"_text", "_lines", "apply_edits", "normalize_sources"}]
NS = {"Path": Path, "json": json, "hashlib": hashlib}
exec(compile(ast.Module(body=NODES, type_ignores=[]), "nb_coder_driver.py", "exec"), NS)


def _write_nb(path: Path, cells: list) -> None:
    nb = {"cells": cells, "metadata": {}, "nbformat": 4, "nbformat_minor": 5}
    path.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def _untouched_code_cell() -> dict:
    return {"cell_type": "code", "source": ["print(1)"],
            "metadata": {}, "execution_count": 1,
            "outputs": [{"output_type": "stream", "name": "stdout", "text": ["1\n"]}]}


class WriterTests(unittest.TestCase):
    def test_edits_and_inserts_preserve_text_and_unrelated_outputs(self):
        """The writer path (`--write-mode json`): edits, inserts, and what must not move."""
        for text in ("first\nsecond\n", "first\nsecond", "", "école\n\nfin"):
            with self.subTest(text=text), tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp) / "sample.ipynb"
                untouched = _untouched_code_cell()
                _write_nb(p, [{"cell_type": "markdown", "source": ["old\n"],
                               "metadata": {}, "id": "original"}, untouched])
                result = NS["apply_edits"](p, {"edits": [{"cell": 0, "source": text}],
                     "inserts": [{"after": 0, "source": text, "cell_type": "markdown"}]})
                self.assertEqual(result["errors"], [])
                cells = json.loads(p.read_text(encoding="utf-8"))["cells"]
                for cell in cells[:2]:
                    self.assertIsInstance(cell["source"], list)
                    self.assertEqual("".join(cell["source"]), text)
                self.assertEqual(cells[2], untouched)

    def test_normalize_sources_converts_mcp_string_writes(self):
        """The MCP path: `update_cell`/`add_cell` write plain strings, not lists."""
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "sample.ipynb"
            untouched = _untouched_code_cell()
            _write_nb(p, [{"cell_type": "markdown", "source": "déjà\nune liste\n",
                           "metadata": {}, "id": "a"}, untouched])
            self.assertEqual(NS["normalize_sources"](p), 1)
            cells = json.loads(p.read_text(encoding="utf-8"))["cells"]
            self.assertEqual(cells[0]["source"], ["déjà\n", "une liste\n"])
            self.assertEqual(cells[1], untouched)

    def test_normalize_sources_is_a_noop_when_already_lists(self):
        """Idempotence: a second pass must not rewrite the file (that would be diff noise)."""
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "sample.ipynb"
            _write_nb(p, [{"cell_type": "code", "source": ["x = 1\n"],
                           "metadata": {}, "id": "a", "execution_count": None, "outputs": []}])
            before = p.read_bytes()
            self.assertEqual(NS["normalize_sources"](p), 0)
            self.assertEqual(p.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()