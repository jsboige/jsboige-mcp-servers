"""Regression: system_info() must not shadow the datetime CLASS with the MODULE (#3593).

`notebook_service` imports `from datetime import datetime, ...` at module level, so the
name `datetime` is the CLASS. A local `import datetime` inside system_info() rebound it to
the MODULE for the whole function scope, making `datetime.now()` raise AttributeError --
swallowed by the function's own `except Exception`, so the tool returned
{"error": "module 'datetime' has no attribute 'now'"} and no system info at all.

This asserts the observable contract (a usable timestamp), not the absence of an import
line: a future refactor may legitimately move the import, but must never bring the
AttributeError back.
"""
import asyncio

from papermill_mcp.services.notebook_service import NotebookService


class _Probe(NotebookService):
    # system_info() only reads self.workspace_dir; skip the real __init__ and its deps.
    def __init__(self):
        self.workspace_dir = "."


def test_system_info_returns_a_timestamp_not_an_attributeerror():
    info = asyncio.run(_Probe().system_info())

    assert "error" not in info, f"system_info() failed: {info.get('error')}"
    assert info.get("timestamp"), "system_info() returned no timestamp"
    # An ISO-8601 timestamp parses back; the module-vs-class bug produced none at all.
    from datetime import datetime as _dt

    _dt.fromisoformat(info["timestamp"])
