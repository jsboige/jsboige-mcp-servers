"""
Native Semantic Kernel plugin + shared runner for the nb_coder workflows
(roo-extensions #4832).

Exposes the harness steps (spec / code / audit — ``harness/nb_coder/``) as:

  * kernel functions on agents that declare ``parameters.nb_coder_tools: true``
    AND the ``shell`` capability (``GitHubPlugin`` gating pattern, #3408/#4725:
    a function an agent may not call never appears in its function list; ``shell``
    because the steps execute kernels, git and gh under the seat's wiring);
  * the shared runner behind the server-level ``nb_coder_workflow`` MCP tool,
    so ANY MCP client of the seat can invoke a workflow without knowing the
    harness filesystem (the tool resolves its own module-relative home).

The runner never grows policy of its own: it validates the step, locates
``nb_coder_invoke.py`` (the ONE documented entry — same contract for the
scheduled seats and the on-demand callers, single state) and returns the
envelope the wrapper prints. Credentials ride the server process environment
(``NBCODER_*``), never the params.

Refusal philosophy (fail-closed, #4741/#4758 container precedent): a seat whose
filesystem does not carry the harness home gets a typed
``nb_coder_harness_unresolved`` error naming what was probed — never a stripped
run and never a silent fallback.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from semantic_kernel.functions import kernel_function

log = logging.getLogger("sk-agent.nb-coder")

#: The harness home: module-relative sibling layout by default (this module
#: lives at servers/sk-agent/, the harness at servers/sk-agent/harness/nb_coder/),
#: overridable for non-standard installs.
def harness_home() -> Path:
    env = os.environ.get("SK_AGENT_NB_CODER_HOME")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent / "harness" / "nb_coder"


INVOKE = "nb_coder_invoke.py"
STEPS = ("spec", "code", "audit")

_DEFAULT_TIMEOUT_S = 3600


def _harness_refusal(detail: str) -> dict[str, Any]:
    return {
        "error": "nb_coder_harness_unresolved",
        "detail": detail,
        "harness_home": str(harness_home()),
        "hint": "this seat's sk-agent checkout does not carry the nb_coder harness "
                "(or SK_AGENT_NB_CODER_HOME is mispointed) — invoke from a harness seat "
                "(see harness/nb_coder/INVOCATION.md)",
    }


async def run_nb_coder_workflow(
    step: str, params: dict[str, Any] | str, timeout: int = 0
) -> dict[str, Any]:
    """Run one nb_coder step through the canonical wrapper, envelope back.

    ``params`` accepts a dict or a JSON string (callers come from prompts —
    both shapes occur). The wrapper's own closed-set validation is the last
    word on fields; this layer only refuses what it cannot even launch.
    """
    if step not in STEPS:
        return {"error": "nb_coder_bad_step", "step": step, "valid_steps": list(STEPS)}
    home = harness_home()
    invoke = home / INVOKE
    if not invoke.is_file():
        return _harness_refusal(f"{INVOKE} not found under the resolved harness home")
    if isinstance(params, str):
        try:
            params = json.loads(params) if params.strip() else {}
        except json.JSONDecodeError as exc:
            return {"error": "nb_coder_bad_params", "detail": f"params JSON: {exc}"}
    if not isinstance(params, dict):
        return {"error": "nb_coder_bad_params",
                "detail": "params must be a JSON object (or JSON object string)"}

    argv = [sys.executable, str(invoke), "--step", step, "--params",
            json.dumps(params, ensure_ascii=False)]
    if timeout and timeout > 0:
        argv += ["--timeout", str(timeout)]
    log.info("nb_coder workflow %s dispatched (timeout=%ss)", step, timeout or _DEFAULT_TIMEOUT_S)

    # stdin=DEVNULL: an MCP server's stdin is a JSON-RPC pipe — a child that
    # inherits it can hang until timeout (#1587 gh class, measured).
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        stdin=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(),
                                        timeout=timeout or _DEFAULT_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return {"error": "nb_coder_timeout", "step": step,
                "timeout_s": timeout or _DEFAULT_TIMEOUT_S}
    text = (out or b"").decode("utf-8", errors="replace")
    envelope = None
    for ln in reversed(text.splitlines()):
        ln = ln.strip()
        if ln.startswith("{") and ln.endswith("}"):
            try:
                candidate = json.loads(ln)
                if isinstance(candidate, dict) and candidate.get("step") == step:
                    envelope = candidate
                    break
            except Exception:
                continue
    if envelope is None:
        return {"error": "nb_coder_no_envelope", "step": step, "exit": proc.returncode,
                "tail": text.strip()[-600:]}
    envelope["exit"] = proc.returncode if envelope.get("exit") is None else envelope["exit"]
    return envelope


class NbCoderPlugin:
    """Per-step workflow functions for nb_coder operator agents (#4832).

    Three thin functions instead of one generic one: the model cannot pick the
    wrong step — each preset (nb-coder-spec / nb-coder-code / nb-coder-audit)
    documents exactly one. All return the wrapper envelope verbatim.
    """

    @kernel_function(
        description=(
            "Run the nb_coder SPEC workflow: draft a CoursIA issue body from a validated "
            "nb_audit finding record. Params JSON keys: record (path to the record JSON, "
            "required), notebook (repo-relative path, required), ref (commit SHA the audit "
            "read, required), out (optional file for the draft). Returns the workflow "
            "envelope: {step, ok, verdict, draft_chars, draft?, command, tail}."
        ),
        name="nb_coder_spec",
    )
    async def nb_coder_spec(self, params_json: str, timeout: int = 120) -> str:
        return json.dumps(
            await run_nb_coder_workflow("spec", params_json, timeout),
            ensure_ascii=False, indent=1)

    @kernel_function(
        description=(
            "Run the nb_coder CODE workflow: the full issue -> notebook -> PR harness "
            "(stages 0-5). Params JSON keys: issue (int, required), notebook (required), "
            "repo (CoursIA checkout path, required unless NBCODER_REPO is set), lane "
            "(required with claim), plus the closed optional set in harness/nb_coder/"
            "INVOCATION.md (source_nb, max_stage, agent, verifier_agent, write_mode, "
            "exec_mode, gate_mode, out_dir, ...). Default max_stage=2 (dry). Returns the "
            "workflow envelope: {step, ok, verdict, pr?, pr_url?, trace?, command, tail}."
        ),
        name="nb_coder_code",
    )
    async def nb_coder_code(self, params_json: str, timeout: int = 0) -> str:
        return json.dumps(
            await run_nb_coder_workflow("code", params_json, timeout or _DEFAULT_TIMEOUT_S),
            ensure_ascii=False, indent=1)

    @kernel_function(
        description=(
            "Run the nb_coder AUDIT workflow: independent verification of a built notebook "
            "against its pristine source (separate verifier agent, producer != verifier). "
            "Params JSON keys: issue (int, required), source_nb (pristine notebook path, "
            "required), built_nb (deliverable path, required), facts (optional builder "
            "trace JSON), agent (verifier preset, default critic), out_dir, timeout_s. "
            "Returns the workflow envelope: {step, ok, verdict, trace, instrument_error}."
        ),
        name="nb_coder_audit",
    )
    async def nb_coder_audit(self, params_json: str, timeout: int = 1200) -> str:
        return json.dumps(
            await run_nb_coder_workflow("audit", params_json, timeout),
            ensure_ascii=False, indent=1)
