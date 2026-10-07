"""#4107 (volet C of #4085): the three guards of the Swift->mini delegation lane.

Guard 1 — recursion ceiling refusal — is already covered by
test_recursion_guard.py (mutation-measured); this file locks the other two:

Guard 2 — no orphan process: an MCP child (here: a recursive sk-agent child
or any plugin server) whose handshake fails must be *terminated*, not just
dropped from the plugin map. The connect-timeout tests assert the bounded
failure; this asserts the process itself is gone.

Guard 3 — a mini error surfaces without breaking the medium's task: a model
call that raises (mini endpoint 500/timeout) must come back as an ``error``
dict — never propagate out of call_agent — and the manager must keep serving
subsequent calls (the medium's session survives the failed delegation).

Plus the template contract for the mini lane: thinking off, max_tokens floor,
no recursion grant on the minis, and the delegation preset holding the
sk_agent grant.
"""

import asyncio
import ctypes
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from sk_agent import SKAgentManager
from sk_agent_config import SKAgentConfig, McpConfig

TEMPLATE_PATH = Path(__file__).resolve().parent / "sk_agent_config.template.json"
TEMPLATE = json.loads(TEMPLATE_PATH.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Guard 2 — no orphan process after a failed MCP handshake
# ---------------------------------------------------------------------------


def _pid_alive(pid: int) -> bool:
    """Cross-platform liveness probe (no psutil dependency).

    On Windows a NULL OpenProcess is read as "gone". That is sound *here*
    because the probe only ever runs against our own children (same user,
    same session), where access-denied cannot occur — the ambiguous case the
    sk-agent pre-review flagged (MINOR 3b) is out of reach (and
    test_pid_liveness_probe_detects_both_states pins the non-ambiguous half).
    """
    if pid <= 0:
        return False
    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False  # gone (see docstring: own children only)
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists but owned by another user
    except OSError:
        return False


def test_pid_liveness_probe_detects_both_states():
    """The orphan test's control: prove the probe reads a live child live.

    Without this, a probe that always says "dead" would make
    test_hanging_mcp_child_leaves_no_orphan_process pass for the wrong
    reason (sk-agent pre-review MINOR 3a/3b).
    """
    import subprocess

    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert _pid_alive(child.pid), "probe must see a freshly spawned live child"
    finally:
        child.terminate()
        child.wait(timeout=10)
    deadline = time.monotonic() + 10.0
    while _pid_alive(child.pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _pid_alive(child.pid), "probe must see the terminated child as dead"


def test_hanging_mcp_child_leaves_no_orphan_process(tmp_path):
    """Guard 2: the timed-out child server process must be terminated.

    The spawned server records its own PID then hangs. After the bounded
    handshake failure (timeout path calls plugin.close()), the process must
    be gone — a dropped-but-alive child is exactly the orphan the fleet
    measured accumulating on delegation storms (#4107).
    """
    pidfile = tmp_path / "hanging-child.pid"
    # Forward slashes only: the path is embedded in Python source (-c), where
    # a backslash would start an escape sequence.
    pid_arg = str(pidfile).replace("\\", "/")
    hanging = McpConfig(
        id="orphan-check-server",
        command=sys.executable,
        args=[
            "-c",
            f"import os,time;open({pid_arg!r},'w').write(str(os.getpid()));time.sleep(120)",
        ],
        connect_timeout_s=1.5,
    )
    mgr = SKAgentManager(SKAgentConfig(mcps=[hanging]))

    loaded = asyncio.run(mgr._ensure_mcp_loaded("orphan-check-server"))
    assert loaded is False, "hanging server must fail its handshake"

    # The child writes its pid right after spawn; poll briefly for it.
    deadline = time.monotonic() + 10.0
    while not pidfile.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert pidfile.exists(), "child never recorded its pid (spawn itself failed)"
    pid = int(pidfile.read_text().strip())

    # plugin.close() after the timeout must terminate it; allow a short reap.
    deadline = time.monotonic() + 10.0
    while _pid_alive(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not _pid_alive(pid), (
        f"orphan process {pid} still alive {time.monotonic():.0f}s after the "
        "failed MCP handshake — the timeout path must terminate the child, "
        "not just drop it from the plugin map"
    )


# ---------------------------------------------------------------------------
# Guard 3 — a mini error surfaces without breaking the medium's task
# ---------------------------------------------------------------------------


class _RaisingAgent:
    """ChatCompletionAgent stand-in whose invoke raises — the mini endpoint
    returning 500 / timing out mid-delegation."""

    def invoke(self, messages=None, thread=None, on_intermediate_message=None, **kw):
        async def _gen():
            raise RuntimeError("mini endpoint 500 (simulated)")
            yield  # pragma: no cover — makes this an async generator

        return _gen()


class _HealthyAgent:
    """ChatCompletionAgent stand-in that answers normally."""

    class _Resp:
        def __init__(self, text):
            self._t = text
            self.thread = object()

        def __str__(self):
            return self._t

    def invoke(self, messages=None, thread=None, on_intermediate_message=None, **kw):
        async def _gen():
            yield self._Resp("medium answer after the mini failure")

        return _gen()


def _delegation_manager() -> SKAgentManager:
    """Manager wired like the delegation lane: a mini preset + the medium.

    The model endpoints are dead ports on purpose — no call ever reaches
    them because the fake agents below are seeded into the lazy-creation
    cache (_get_or_create_agent returns the cache first).
    """
    from sk_agent_config import AgentConfig, ModelConfig

    cfg = SKAgentConfig(
        models=[
            ModelConfig.from_dict({
                "id": "frognano-4b", "enabled": True,
                "base_url": "http://127.0.0.1:9/v1", "api_key": "dummy",
                "model_id": "frognano-4b", "vision": False, "thinking": False,
                "description": "mini", "context_window": 32768,
            }),
            ModelConfig.from_dict({
                "id": "qwen3.6-35b-a3b", "enabled": True,
                "base_url": "http://127.0.0.1:9/v1", "api_key": "dummy",
                "model_id": "qwen3.6-35b-a3b", "vision": False, "thinking": False,
                "description": "medium", "context_window": 262144,
            }),
        ],
        agents=[
            AgentConfig.from_dict({
                "id": "mini-coder-fix", "description": "mini",
                "model": "frognano-4b", "system_prompt": "x",
                "mcps": [], "memory": {"enabled": False},
            }),
            AgentConfig.from_dict({
                "id": "swift-delegator", "description": "medium",
                "model": "qwen3.6-35b-a3b", "system_prompt": "x",
                "mcps": [], "memory": {"enabled": False},
            }),
        ],
    )
    return SKAgentManager(cfg)


def test_mini_error_returns_error_dict_not_raise():
    """Guard 3a: the failing model call comes back as an error dict.

    Goes through the unified call_agent — the boundary the recursive child
    sk-agent exposes to the medium — not the handler layer.
    """
    mgr = _delegation_manager()
    mgr._sk_agents["mini-coder-fix"] = _RaisingAgent()
    result = asyncio.run(mgr.call_agent(prompt="fix this", agent_id="mini-coder-fix"))
    assert "error" in result, "a raising model call must surface as error data"
    assert "response" not in result, "must not be a silent success"
    assert "500" in result["error"]


def test_manager_survives_mini_error_and_serves_next_call():
    """Guard 3b: the medium's session is not poisoned by the mini failure.

    The delegation lane reuses one manager for the medium's whole task: after
    a failed mini call, the next (healthy) call on the same manager must
    still produce an answer — the medium continues its task with the error
    as data, which is precisely what the swift-delegator prompt asks it to do.
    """
    mgr = _delegation_manager()
    mgr._sk_agents["mini-coder-fix"] = _RaisingAgent()
    mgr._sk_agents["swift-delegator"] = _HealthyAgent()

    failed = asyncio.run(mgr.call_agent(prompt="fix this", agent_id="mini-coder-fix"))
    assert "error" in failed

    healthy = asyncio.run(
        mgr.call_agent(prompt="continue the task", agent_id="swift-delegator")
    )
    assert "response" in healthy, "manager must keep serving after a mini failure"
    assert "after the mini failure" in healthy["response"]


# ---------------------------------------------------------------------------
# Template contract — the mini lane as specified (#4085 c.6019492370/c.6022769664)
# ---------------------------------------------------------------------------


def _model(mid):
    return next(m for m in TEMPLATE["models"] if m["id"] == mid)


def _agent(aid):
    return next(a for a in TEMPLATE["agents"] if a["id"] == aid)


def test_frognano_model_thinking_off_and_budget_floor():
    m = _model("frognano-4b")
    assert m["thinking"] is False, "thinking must be off (4096/4096 reasoning -> empty answer)"
    assert m["max_tokens"] >= 1024, "max_tokens floor 1024 (thinking eats small budgets)"
    assert m["extra_body"]["chat_template_kwargs"]["enable_thinking"] is False, (
        "no-thinking must also hold on the conversation path (#2002)"
    )
    assert m["api_key"].startswith("YOUR_"), "no real key in the repo — placeholder only"
    assert m["api_key_env"], "the live key stays an environment reference"


def test_mini_presets_exist_and_never_recurse():
    expected = {"mini-coder-fix", "mini-repo-scan", "mini-summarizer", "mini-web-research"}
    ids = {a["id"] for a in TEMPLATE["agents"]}
    assert expected <= ids, f"missing mini presets: {expected - ids}"
    for aid in sorted(expected):
        a = _agent(aid)
        assert a["model"] == "frognano-4b", f"{aid} must run the fleet mini"
        assert "sk_agent" not in a.get("mcps", []), (
            f"{aid} must not hold the recursion grant (minis cannot delegate further)"
        )
        assert "recursive_agents" not in a.get("capabilities", []), (
            f"{aid} must not declare recursive_agents"
        )


def test_mini_coder_fix_and_repo_scan_document_code_in_prompt():
    for aid in ("mini-coder-fix", "mini-repo-scan"):
        a = _agent(aid)
        blob = (a["description"] + " " + a["system_prompt"]).lower()
        assert "prompt" in blob, (
            f"{aid} must tell calling agents that code goes IN THE PROMPT "
            "(attachments refuse code files, #4085 c.6022769664)"
        )


def test_swift_delegator_holds_the_recursion_grant():
    a = _agent("swift-delegator")
    assert a["model"] == "qwen3.6-35b-a3b", "the delegation medium is the fleet medium"
    assert "sk_agent" in a["mcps"], "delegation happens via recursive sk-agent calls"
    assert "recursive_agents" in a["capabilities"], (
        "the sk_agent MCP requires the recursive_agents grant (#3408)"
    )
    blob = a["system_prompt"].lower()
    assert "delegate" in blob, "the consigne must say WHAT to delegate"
