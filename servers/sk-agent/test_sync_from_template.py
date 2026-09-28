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


def _run_sync(tmp_path, local, extra_args=()):
    """Copy the real script + fixtures into tmp, run it, return (proc, config_path)."""
    shutil.copy2(SK_AGENT_DIR / SCRIPT_NAME, tmp_path / SCRIPT_NAME)
    (tmp_path / "sk_agent_config.template.json").write_text(
        json.dumps(TEMPLATE, indent=2), encoding="utf-8"
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
