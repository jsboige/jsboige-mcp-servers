#!/usr/bin/env python3
# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 9683ab2f5165f374bbb387132288c2cbf7cc6084
# original path: myia_vllm/scripts/adoption/nb_audit/sk_call.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""One-shot sk-agent call_agent from the command line (smoke tests of agents/tools).

Usage: <sk-agent venv python> sk_call.py AGENT "prompt" [timeout_s]
"""
import asyncio
import json
import os
import sys
from datetime import timedelta
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HERE = Path(__file__).resolve().parent


def _sk_dir() -> Path:
    """Where the sk-agent checkout lives (roo-extensions #4781: no seat binding in the tree).
    Same cascade as the drivers: NB_AUDIT_SK_DIR env, then the sibling layout the harness has
    once it lives at servers/sk-agent/harness/nb_audit/ (root ../.., recognised by
    sk_agent.py), then the legacy absolute path kept until the cutover."""
    env = os.environ.get("NB_AUDIT_SK_DIR")
    if env:
        return Path(env)
    sibling = (HERE / "../..").resolve()
    if (sibling / "sk_agent.py").is_file():
        return sibling
    return Path("d:/roo-extensions/mcps/internal/servers/sk-agent")


SK_DIR = _sk_dir()
SK_PY = Path(os.environ.get("NB_AUDIT_SK_PY", str(SK_DIR / "venv/Scripts/python.exe")))
SK_CONFIG = Path(os.environ.get("NB_AUDIT_SK_CONFIG", str(SK_DIR / "sk_agent_config.json")))


async def main() -> None:
    agent, prompt = sys.argv[1], sys.argv[2]
    timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 600
    params = StdioServerParameters(command=str(SK_PY),
                                   args=[str(SK_DIR / "sk_agent.py")],
                                   env={**os.environ, "SK_AGENT_CONFIG": str(SK_CONFIG)})
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            res = await s.call_tool("call_agent", {"prompt": prompt, "agent": agent, "timeout": timeout,
                                                   "include_steps": True},
                                    read_timeout_seconds=timedelta(seconds=timeout + 60))
            print("\n".join(getattr(c, "text", "") for c in res.content))


asyncio.run(main())
