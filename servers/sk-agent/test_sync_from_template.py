"""Guard: sync_from_template.py must not degrade silently to template placeholders.

Thread 27/09 (po-2026 medium-key incident): a resync ran with no matching local key,
the written config kept the template `YOUR_*` placeholder in api_key, the warning
drowned in stdout and the script exited 0 — the server then 401'd at runtime. The
contract under test: missing keys still WRITE the file (no refusal — that would break
the resync flow) but emit a loud stderr banner and exit non-zero.

The bench copies the REAL script into a tmp dir with fixture template/local configs
(paths inside the script are Path(__file__).parent-based) and runs it via subprocess.
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SK_AGENT_DIR = Path(__file__).resolve().parent
SCRIPT_NAME = "sync_from_template.py"

TEMPLATE = {
    "models": [
        {
            "id": "glm-5.3",
            "base_url": "http://192.168.0.50:3000/v1",
            "api_key": "YOUR_HUB_CLIENT_KEY_HERE",
            "api_key_env": "ZAI_API_KEY",
        },
        {
            "id": "qwen3.6-35b-a3b",
            "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
            "api_key": "YOUR_MEDIUM_API_KEY_HERE",
        },
    ],
    "agents": [],
    "conversations": [],
    "mcps": [],
}

LOCAL_HEALTHY = {
    "models": [
        {
            "id": "glm-5.3-local",
            "base_url": "http://192.168.0.50:3000/v1",
            "api_key": "sk-hub-real-key",
        },
        {
            "id": "qwen3.6-35b-a3b-local",
            "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
            "api_key": "sk-medium-real-key",
        },
    ],
    "agents": [],
    "conversations": [],
    "mcps": [],
}

LOCAL_NO_MEDIUM = {
    "models": [
        {
            "id": "glm-5.3-local",
            "base_url": "http://192.168.0.50:3000/v1",
            "api_key": "sk-hub-real-key",
        },
    ],
    "agents": [],
    "conversations": [],
    "mcps": [],
}


def _run_sync(tmp_path, local, extra_args=(), template=TEMPLATE):
    """Copy the real script + fixtures into tmp, run it, return (proc, config_path)."""
    shutil.copy2(SK_AGENT_DIR / SCRIPT_NAME, tmp_path / SCRIPT_NAME)
    (tmp_path / "sk_agent_config.template.json").write_text(
        json.dumps(template, indent=2), encoding="utf-8"
    )
    config_path = tmp_path / "sk_agent_config.json"
    config_path.write_text(json.dumps(local, indent=2), encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(tmp_path / SCRIPT_NAME), *extra_args],
        capture_output=True,
        text=True,
        cwd=tmp_path,
    )
    return proc, config_path


def test_missing_key_writes_file_but_exits_nonzero_with_stderr_banner():
    with tempfile.TemporaryDirectory() as td:
        proc, config_path = _run_sync(Path(td), LOCAL_NO_MEDIUM)
        assert proc.returncode == 1, (
            f"degraded sync must exit 1 — got {proc.returncode} "
            f"(stdout={proc.stdout!r}, stderr={proc.stderr!r})"
        )
        assert "MISSING API KEYS" in proc.stderr, f"no banner on stderr: {proc.stderr!r}"
        assert "qwen3.6-35b-a3b" in proc.stderr, (
            f"banner must name the degraded model: {proc.stderr!r}"
        )
        # The file IS written (no refusal) — placeholder left visible for hand-fixing.
        written = json.loads(config_path.read_text(encoding="utf-8"))
        by_id = {m["id"]: m for m in written["models"]}
        assert by_id["qwen3.6-35b-a3b"]["api_key"] == "YOUR_MEDIUM_API_KEY_HERE"
        # The healthy model still got its key injected.
        assert by_id["glm-5.3"]["api_key"] == "sk-hub-real-key"
        # Backup of the previous local config exists.
        assert (config_path.with_suffix(".json.bak")).exists()


def test_missing_key_hint_cites_api_key_env_when_present():
    with tempfile.TemporaryDirectory() as td:
        local = {
            "models": [
                {
                    "id": "medium-only",
                    "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
                    "api_key": "sk-medium-real-key",
                }
            ],
            "agents": [],
            "conversations": [],
            "mcps": [],
        }
        proc, _ = _run_sync(Path(td), local)
        assert proc.returncode == 1
        # glm-5.3 carries api_key_env=ZAI_API_KEY in the template — the banner must
        # cite it so the operator knows which var to provision.
        assert "ZAI_API_KEY" in proc.stderr, f"hint missing: {proc.stderr!r}"
        assert "glm-5.3" in proc.stderr


def test_healthy_sync_exits_zero_without_banner():
    with tempfile.TemporaryDirectory() as td:
        proc, config_path = _run_sync(Path(td), LOCAL_HEALTHY)
        assert proc.returncode == 0, (
            f"healthy sync must exit 0 — stderr={proc.stderr!r}"
        )
        assert "MISSING API KEYS" not in proc.stderr
        written = json.loads(config_path.read_text(encoding="utf-8"))
        by_id = {m["id"]: m for m in written["models"]}
        assert by_id["glm-5.3"]["api_key"] == "sk-hub-real-key"
        assert by_id["qwen3.6-35b-a3b"]["api_key"] == "sk-medium-real-key"


def test_same_id_local_model_keeps_local_endpoint():
    """#3411 web2 cell: off-LAN seat, same model id, different base_url.

    web2 (VPS) serves glm-5.3 from https://models.myia.io/v1 with a real key;
    the template points at the LAN hub (192.168.0.50). The old matcher only
    paired by base_url, so the key stayed a placeholder (exit 1) AND a
    successful sync would have regressed the URL to one unreachable from
    that seat. Same-id + real local key must take key, base_url AND enabled
    from local, exit 0, and say so on stderr — never silently.
    """
    local = {
        "models": [
            {
                "id": "glm-5.3",
                "base_url": "https://models.myia.io/v1",
                "api_key": "sk-glm-real-key",
                "enabled": False,
            },
            {
                "id": "qwen3.6-35b-a3b-local",
                "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
                "api_key": "sk-medium-real-key",
            },
        ],
        "agents": [],
        "conversations": [],
        "mcps": [],
    }
    with tempfile.TemporaryDirectory() as td:
        proc, config_path = _run_sync(Path(td), local)
        assert proc.returncode == 0, (
            f"same-id key must inject — stderr={proc.stderr!r}"
        )
        assert "MISSING API KEYS" not in proc.stderr
        written = json.loads(config_path.read_text(encoding="utf-8"))
        by_id = {m["id"]: m for m in written["models"]}
        glm = by_id["glm-5.3"]
        assert glm["api_key"] == "sk-glm-real-key", "id-direct key injection"
        assert glm["base_url"] == "https://models.myia.io/v1", (
            "off-LAN seat endpoint must NOT regress to the template LAN URL"
        )
        assert glm["enabled"] is False, "local enabled flag is the seat's reality"
        # The divergence is visible next to the report, not silent.
        assert "PRESERVED LOCAL ENDPOINTS" in proc.stderr, (
            f"preserved-endpoint note missing: {proc.stderr!r}"
        )
        assert "glm-5.3" in proc.stderr
        # Sibling models unaffected: URL matching still serves the medium key.
        assert by_id["qwen3.6-35b-a3b"]["api_key"] == "sk-medium-real-key"
        # Review note (ai-01): banner carries ids and field names only —
        # no endpoint values on stderr.
        assert "models.myia.io" not in proc.stderr
        assert "192.168.0.50" not in proc.stderr


# --- Declared successor (renamed id) key/endpoint inheritance (ms#1421) --

TEMPLATE_WITH_SUCCESSOR = {
    "models": [
        {
            "id": "glm-5.3",
            "base_url": "http://192.168.0.50:3000/v1",
            "api_key": "YOUR_HUB_CLIENT_KEY_HERE",
            "api_key_env": "ZAI_API_KEY",
        },
        {
            "id": "swift-1.5-27b",
            "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
            "api_key": "YOUR_MEDIUM_API_KEY_HERE",
            "succeeds": "qwen3.6-35b-a3b",
        },
        {
            "id": "qwen3.6-35b-a3b",
            "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
            "api_key": "YOUR_MEDIUM_API_KEY_HERE",
        },
    ],
    "agents": [],
    "conversations": [],
    "mcps": [],
}

# ai-01-shaped seat (ms#1421 review): the local medium endpoint diverges from
# the template (docker-network URL) and only the OLD id exists locally.
LOCAL_DIVERGENT_ALIAS = {
    "models": [
        {
            "id": "glm-5.3-local",
            "base_url": "http://192.168.0.50:3000/v1",
            "api_key": "sk-hub-real-key",
        },
        {
            "id": "qwen3.6-35b-a3b",
            "base_url": "http://host.docker.internal:5002/v1",
            "api_key": "sk-medium-real-key",
        },
    ],
    "agents": [],
    "conversations": [],
    "mcps": [],
}


def test_new_id_succeeding_alias_inherits_key_and_divergent_base_url():
    """ms#1421 blocker: a renamed id on a seat whose local medium base_url
    diverges from the template. Steps 0-3 all miss (new id, different URL,
    no api_key_env) — without the successor step the renamed id deploys
    keyless AND against a URL the seat may not even reach."""
    with tempfile.TemporaryDirectory() as td:
        proc, config_path = _run_sync(
            Path(td), LOCAL_DIVERGENT_ALIAS, template=TEMPLATE_WITH_SUCCESSOR
        )
        assert proc.returncode == 0, (
            f"successor must inherit a key — stderr={proc.stderr!r}"
        )
        assert "MISSING API KEYS" not in proc.stderr
        written = json.loads(config_path.read_text(encoding="utf-8"))
        by_id = {m["id"]: m for m in written["models"]}
        swift = by_id["swift-1.5-27b"]
        assert swift["api_key"] == "sk-medium-real-key", (
            "renamed id must inherit the local alias key"
        )
        assert swift["base_url"] == "http://host.docker.internal:5002/v1", (
            "renamed id must inherit the alias's local endpoint, not the template URL"
        )
        # The alias itself keeps its own key + endpoint via the same-id path.
        alias = by_id["qwen3.6-35b-a3b"]
        assert alias["api_key"] == "sk-medium-real-key"
        assert alias["base_url"] == "http://host.docker.internal:5002/v1"
        # Sibling model unaffected (exact URL match still serves the hub key).
        assert by_id["glm-5.3"]["api_key"] == "sk-hub-real-key"
        # Visibility: the inheritance is announced — ids and field names
        # only, no endpoint values on stderr.
        assert "PRESERVED LOCAL ENDPOINTS" in proc.stderr
        assert "swift-1.5-27b" in proc.stderr
        assert "qwen3.6-35b-a3b" in proc.stderr
        assert "host.docker.internal" not in proc.stderr


def test_dry_run_divergent_seat_lists_no_missing_keys_for_successor():
    """Review exit criterion (ms#1421): --dry-run against a diverging
    config no longer lists the renamed id under MISSING-KEYS."""
    with tempfile.TemporaryDirectory() as td:
        proc, config_path = _run_sync(
            Path(td),
            LOCAL_DIVERGENT_ALIAS,
            extra_args=("--dry-run",),
            template=TEMPLATE_WITH_SUCCESSOR,
        )
        assert proc.returncode == 0, (
            f"dry-run on divergent seat must exit 0 — stderr={proc.stderr!r}"
        )
        assert "[DRY RUN]" in proc.stdout
        assert "MISSING API KEYS" not in proc.stderr
        # Dry-run leaves the local config untouched.
        assert json.loads(config_path.read_text(encoding="utf-8")) == LOCAL_DIVERGENT_ALIAS


def test_successor_without_local_alias_still_fails_loud():
    """No local alias to inherit from (fresh seat, or alias already removed
    locally): the successor step must not mask the missing-key guard."""
    with tempfile.TemporaryDirectory() as td:
        proc, _ = _run_sync(
            Path(td), LOCAL_NO_MEDIUM, template=TEMPLATE_WITH_SUCCESSOR
        )
        assert proc.returncode == 1
        assert "MISSING API KEYS" in proc.stderr
        assert "swift-1.5-27b" in proc.stderr


# --- Local-only agent preservation (#3411, ai-01 spec c.6105550181) ------

LOCAL_WITH_AUDITOR = {
    "models": [
        {
            "id": "glm-5.3-local",
            "base_url": "http://192.168.0.50:3000/v1",
            "api_key": "sk-hub-real-key",
        },
        {
            "id": "qwen3.6-35b-a3b-local",
            "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
            "api_key": "sk-medium-real-key",
        },
        # Template-absent model referenced ONLY by the local-only agent.
        {
            "id": "qwen3.6-35b-a3b-audit",
            "base_url": "https://api.medium.text-generation-webui.myia.io/v1",
            "api_key": "sk-audit-real-key",
            "request_timeout_s": 600,
        },
    ],
    "agents": [
        {
            "id": "notebook-auditor",
            "description": "seat-local campaign agent",
            "model": "qwen3.6-35b-a3b-audit",
            "system_prompt": "audit notebooks",
            "mcps": ["desktop_commander", "jupyter_papermill"],
            "memory": {"enabled": False},
        },
        {
            "id": "mini-assistant",
            "description": "stopgap",
            "model": "glm-5.3-local",  # resolves via URL-matched template model
            "system_prompt": "x",
            "mcps": [],
            "memory": {"enabled": False},
        },
    ],
    "conversations": [],
    "mcps": [
        {"id": "desktop_commander", "command": "python", "args": ["-m", "dc"]},
        {"id": "jupyter_papermill", "command": "python", "args": ["-m", "jp"]},
    ],
}


def _agents_of(config):
    return {a["id"] for a in config["agents"]}


def test_local_only_agent_preserved_with_dependencies():
    """ai-01's notebook-auditor case: a live-caller seat-local agent must
    survive a sync, together with the model and MCP entries the template
    does not carry. Ids on stderr only, never values."""
    with tempfile.TemporaryDirectory() as td:
        proc, config_path = _run_sync(Path(td), LOCAL_WITH_AUDITOR)
        assert proc.returncode == 0, f"stderr={proc.stderr!r}"
        written = json.loads(config_path.read_text(encoding="utf-8"))
        assert "notebook-auditor" in _agents_of(written), "local-only agent deleted"
        assert "mini-assistant" in _agents_of(written)
        model_ids = {m["id"] for m in written["models"]}
        assert "qwen3.6-35b-a3b-audit" in model_ids, "template-absent model dropped"
        mcp_ids = {m["id"] for m in written["mcps"]}
        assert {"desktop_commander", "jupyter_papermill"} <= mcp_ids
        # The preserved model entry came verbatim (budget field intact).
        audit_model = next(m for m in written["models"] if m["id"] == "qwen3.6-35b-a3b-audit")
        assert audit_model["request_timeout_s"] == 600
        # Visibility: ids only on stderr.
        assert "PRESERVED LOCAL-ONLY AGENTS" in proc.stderr
        assert "notebook-auditor" in proc.stderr
        assert "model:qwen3.6-35b-a3b-audit" in proc.stderr
        assert "mcp:desktop_commander" in proc.stderr
        # No endpoint/command values leak in the banner (ids and field names only).
        assert "api.medium.text-generation-webui" not in proc.stderr


def test_prune_local_drops_agent_and_orphaned_dependencies():
    """Retirement is a written gesture: --prune-local mini-assistant drops
    that agent; deps are collected from SURVIVING agents only."""
    with tempfile.TemporaryDirectory() as td:
        proc, config_path = _run_sync(
            Path(td), LOCAL_WITH_AUDITOR, extra_args=("--prune-local", "mini-assistant")
        )
        assert proc.returncode == 0, f"stderr={proc.stderr!r}"
        written = json.loads(config_path.read_text(encoding="utf-8"))
        agents = _agents_of(written)
        assert "mini-assistant" not in agents, "pruned agent must be gone"
        assert "notebook-auditor" in agents, "survivor must stay"
        # notebook-auditor's deps survive; glm-5.3 (template model) unaffected.
        model_ids = {m["id"] for m in written["models"]}
        assert "qwen3.6-35b-a3b-audit" in model_ids
        assert "glm-5.3" in model_ids
        # The report shows the removal; stderr names the prune.
        assert "mini-assistant" in proc.stdout  # sync report Removed line
        assert "Pruned via --prune-local" in proc.stderr


def test_prune_local_lone_agent_takes_its_unique_deps_down():
    """Pruning the only agent that references a template-absent model/MCP
    removes those deps too — no orphans left behind."""
    with tempfile.TemporaryDirectory() as td:
        proc, config_path = _run_sync(
            Path(td), LOCAL_WITH_AUDITOR, extra_args=("--prune-local", "notebook-auditor")
        )
        assert proc.returncode == 0, f"stderr={proc.stderr!r}"
        written = json.loads(config_path.read_text(encoding="utf-8"))
        assert "notebook-auditor" not in _agents_of(written)
        model_ids = {m["id"] for m in written["models"]}
        assert "qwen3.6-35b-a3b-audit" not in model_ids, "orphan model kept"
        mcp_ids = {m["id"] for m in written["mcps"]}
        assert "desktop_commander" not in mcp_ids, "orphan mcp kept"
        assert "jupyter_papermill" not in mcp_ids
        # mini-assistant (the other local-only agent) still preserved.
        assert "mini-assistant" in _agents_of(written)


def test_dry_run_degraded_exits_nonzero_and_writes_nothing():
    with tempfile.TemporaryDirectory() as td:
        before = json.dumps(LOCAL_NO_MEDIUM, sort_keys=True)
        proc, config_path = _run_sync(Path(td), LOCAL_NO_MEDIUM, extra_args=("--dry-run",))
        assert proc.returncode == 1, (
            f"dry-run degraded must exit 1 (pre-check tool) — got {proc.returncode}"
        )
        assert "[DRY RUN]" in proc.stdout
        # Dry-run leaves the local config untouched.
        after = json.dumps(
            json.loads(config_path.read_text(encoding="utf-8")), sort_keys=True
        )
        assert after == before, "dry-run must not rewrite the local config"
        assert not config_path.with_suffix(".json.bak").exists()


def test_missing_local_config_exits_nonzero_with_error():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        shutil.copy2(SK_AGENT_DIR / SCRIPT_NAME, tmp / SCRIPT_NAME)
        (tmp / "sk_agent_config.template.json").write_text(
            json.dumps(TEMPLATE), encoding="utf-8"
        )
        # No sk_agent_config.json at all.
        proc = subprocess.run(
            [sys.executable, str(tmp / SCRIPT_NAME)],
            capture_output=True,
            text=True,
            cwd=tmp,
        )
        assert proc.returncode == 1
        assert "not found" in proc.stdout


# --- #4085: MCP install-path placeholders -----------------------------------
# The template ships the sk_agent self-inclusion declaration with symbolic
# install paths (VENV_PATH/Scripts/python.exe, INSTALLATION_PATH/sk_agent.py).
# A sync that let them through verbatim left every seat's sk_agent tool dead
# at spawn (c.218 dogfood). The sync must derive the real paths from its own
# location and REFUSE any placeholder that survives the rewrite.


def _template_with_placeholder_mcp():
    template = json.loads(json.dumps(TEMPLATE))
    template["mcps"] = [
        {
            "id": "sk_agent",
            "command": "VENV_PATH/Scripts/python.exe",
            "args": ["INSTALLATION_PATH/sk_agent.py"],
            "env": {"SK_AGENT_HOME": "INSTALLATION_PATH"},
        }
    ]
    return template


def test_mcp_path_placeholders_rewritten_to_script_dir_paths():
    template = _template_with_placeholder_mcp()
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        proc, config_path = _run_sync(tmp, LOCAL_HEALTHY, template=template)
        assert proc.returncode == 0, (
            f"placeholder rewrite must keep the sync healthy — stderr={proc.stderr!r}"
        )
        written = json.loads(config_path.read_text(encoding="utf-8"))
        mcp = next(m for m in written["mcps"] if m["id"] == "sk_agent")
        assert mcp["command"] == f"{tmp / 'venv'}/Scripts/python.exe", mcp["command"]
        assert mcp["args"] == [f"{tmp}/sk_agent.py"], mcp["args"]
        assert mcp["env"] == {"SK_AGENT_HOME": str(tmp)}, mcp["env"]
        # No residual and no refusal banner.
        assert "UNREPLACED MCP PATH PLACEHOLDERS" not in proc.stderr


def test_residual_placeholder_in_untouched_mcp_field_refused():
    # The rewriter covers command/args/env; a placeholder reaching any OTHER
    # field of an MCP declaration must trip the tripwire, not ship silently.
    template = _template_with_placeholder_mcp()
    template["mcps"][0]["cwd"] = "INSTALLATION_PATH/subdir"
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        proc, config_path = _run_sync(tmp, LOCAL_HEALTHY, template=template)
        assert proc.returncode == 1, (
            f"residual placeholder must exit 1 — got {proc.returncode}"
        )
        assert "UNREPLACED MCP PATH PLACEHOLDERS" in proc.stderr, proc.stderr
        assert "sk_agent" in proc.stderr
        # File still written (hand-fixable), and the KNOWN fields were still
        # rewritten — only the untouched field keeps its placeholder.
        written = json.loads(config_path.read_text(encoding="utf-8"))
        mcp = next(m for m in written["mcps"] if m["id"] == "sk_agent")
        assert "VENV_PATH" not in mcp["command"]
        assert "INSTALLATION_PATH" not in mcp["args"][0]
        assert mcp["cwd"] == "INSTALLATION_PATH/subdir"
