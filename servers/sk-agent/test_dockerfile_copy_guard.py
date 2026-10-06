"""Guard: the Dockerfile COPY list must cover every local module sk_agent.py imports (roo-extensions#4085).

The in-image guard (`RUN python -c "import sk_agent"`) only fires when someone
builds the image, and nobody does in CI. sk_context_condensation.py (#1266,
2026-10-01) was imported at module level but missing from COPY: the public
container could not be rebuilt from main for five days, and nothing said so.
"""

import ast
import re
from pathlib import Path

SK_AGENT_DIR = Path(__file__).resolve().parent


def _copied_modules():
    text = (SK_AGENT_DIR / "Dockerfile").read_text(encoding="utf-8")
    joined = text.replace("\\\n", " ")
    copied = set()
    for line in joined.splitlines():
        if line.strip().startswith("COPY "):
            copied.update(re.findall(r"([A-Za-z_][A-Za-z0-9_]*)\.py\b", line))
    return copied


def _local_imports(module):
    tree = ast.parse((SK_AGENT_DIR / f"{module}.py").read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module.split(".")[0])
        elif isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
    return {n for n in names if (SK_AGENT_DIR / f"{n}.py").is_file()}


def _import_closure(root):
    seen, todo = set(), [root]
    while todo:
        module = todo.pop()
        if module in seen:
            continue
        seen.add(module)
        todo.extend(_local_imports(module) - seen)
    return seen


def test_copy_list_covers_the_import_closure_of_sk_agent():
    missing = _import_closure("sk_agent") - _copied_modules()
    assert not missing, (
        f"Dockerfile COPY is missing {sorted(missing)}: the image build fails at "
        f"`RUN python -c \"import sk_agent\"`, or a lazy import fails at runtime."
    )
