#!/usr/bin/env python3
"""Config provenance telemetry (#4289).

The host loads the config ONCE (first _get_manager) and never re-reads it,
while diagnostics() re-reads the disk. Before this change nothing exposed
that divergence from inside a session: hosts born before a config edit kept
serving stale models/keys (401 in session, 200 standalone — measured
2026-11-08 across hosts older than the edit). diagnostics() must now report
WHEN the served config was loaded and WHETHER the disk has since drifted.
"""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import sk_agent  # noqa: E402
from sk_agent import SKAgentManager  # noqa: E402
from sk_agent_config import SKAgentConfig  # noqa: E402

LOADED_AT = "2026-11-08T10:53:33+00:00"


def test_diagnostics_exposes_config_loaded_when_uninitialized(monkeypatch, tmp_path):
    """Pre-change this fails with KeyError: the block did not exist."""
    cfg = tmp_path / "sk_agent_config.json"
    cfg.write_text('{"config_version": 2}', encoding="utf-8")
    monkeypatch.setattr(sk_agent, "CONFIG_PATH", str(cfg))
    monkeypatch.setattr(sk_agent, "_manager", None)
    monkeypatch.setattr(sk_agent, "_config", None)
    monkeypatch.setattr(sk_agent, "_config_loaded_at", None)
    monkeypatch.setattr(sk_agent, "_config_loaded_fingerprint", None)

    data = json.loads(asyncio.run(sk_agent.diagnostics()))
    block = data["config_loaded"]
    assert block["at"] is None
    assert block["served_fingerprint"] is None
    assert block["disk_fingerprint"] is not None
    assert block["stale"] is None  # unknown: nothing was ever served
    assert block["agents_served"] is None


def test_fingerprint_tracks_content_not_mtime(tmp_path):
    cfg = tmp_path / "sk_agent_config.json"
    cfg.write_text('{"config_version": 2}', encoding="utf-8")
    fp1 = sk_agent._config_file_fingerprint(str(cfg))
    assert fp1 is not None and len(fp1) == 16

    # Content change -> different fingerprint.
    cfg.write_text('{"config_version": 2, "agents": []}', encoding="utf-8")
    fp2 = sk_agent._config_file_fingerprint(str(cfg))
    assert fp2 is not None and fp2 != fp1

    # Identical bytes rewritten (fresh mtime) -> same fingerprint.
    cfg.write_text('{"config_version": 2, "agents": []}', encoding="utf-8")
    assert sk_agent._config_file_fingerprint(str(cfg)) == fp2

    # Missing file -> None, not a crash.
    assert sk_agent._config_file_fingerprint(str(tmp_path / "missing.json")) is None


def test_diagnostics_flags_stale_served_config(monkeypatch, tmp_path):
    """Host initialized on file v1, disk now holds v2 -> stale=True with both
    fingerprints exposed; disk back to served bytes -> stale=False."""
    cfg = tmp_path / "sk_agent_config.json"
    cfg.write_text('{"config_version": 2}', encoding="utf-8")
    monkeypatch.setattr(sk_agent, "CONFIG_PATH", str(cfg))
    served_fp = sk_agent._config_file_fingerprint(str(cfg))

    served = SKAgentConfig()
    mgr = SKAgentManager(served)
    monkeypatch.setattr(sk_agent, "_manager", mgr)
    monkeypatch.setattr(sk_agent, "_config", served)
    monkeypatch.setattr(sk_agent, "_config_loaded_at", LOADED_AT)
    monkeypatch.setattr(sk_agent, "_config_loaded_fingerprint", served_fp)

    # Config edited after the host was born (the measured incident).
    cfg.write_text('{"config_version": 2, "agents": []}', encoding="utf-8")
    data = json.loads(asyncio.run(sk_agent.diagnostics()))
    block = data["config_loaded"]
    assert block["stale"] is True
    assert block["at"] == LOADED_AT
    assert block["served_fingerprint"] == served_fp
    assert block["disk_fingerprint"] != served_fp
    assert block["disk_mtime"] is not None
    # Served counts come from the manager, not the disk re-read above.
    assert block["agents_served"] == len(served.agents)
    assert block["models_served"] == len(served.models)

    # Disk restored to the served bytes -> converged.
    cfg.write_text('{"config_version": 2}', encoding="utf-8")
    data = json.loads(asyncio.run(sk_agent.diagnostics()))
    assert data["config_loaded"]["stale"] is False


def test_diagnostics_flags_deleted_disk_config(monkeypatch, tmp_path):
    """File deleted after load: no disk fingerprint to compare, still a
    drift the operator must see, not a silent None."""
    cfg = tmp_path / "sk_agent_config.json"
    cfg.write_text('{"config_version": 2}', encoding="utf-8")
    monkeypatch.setattr(sk_agent, "CONFIG_PATH", str(cfg))
    served_fp = sk_agent._config_file_fingerprint(str(cfg))

    served = SKAgentConfig()
    monkeypatch.setattr(sk_agent, "_manager", SKAgentManager(served))
    monkeypatch.setattr(sk_agent, "_config", served)
    monkeypatch.setattr(sk_agent, "_config_loaded_at", LOADED_AT)
    monkeypatch.setattr(sk_agent, "_config_loaded_fingerprint", served_fp)

    cfg.unlink()
    data = json.loads(asyncio.run(sk_agent.diagnostics()))
    block = data["config_loaded"]
    assert block["disk_fingerprint"] is None
    assert block["disk_mtime"] is None
    assert block["stale"] is True


def test_get_manager_records_provenance(monkeypatch, tmp_path):
    """A successful init stamps the load time and fingerprint; a failed one
    resets both so the retry does not inherit stale provenance."""
    cfg = tmp_path / "sk_agent_config.json"
    cfg.write_text('{"config_version": 2}', encoding="utf-8")
    monkeypatch.setattr(sk_agent, "CONFIG_PATH", str(cfg))
    import sk_agent_config

    monkeypatch.setattr(sk_agent_config, "CONFIG_PATH", str(cfg))
    monkeypatch.setattr(sk_agent, "_manager", None)
    monkeypatch.setattr(sk_agent, "_config", None)
    monkeypatch.setattr(sk_agent, "_config_loaded_at", None)
    monkeypatch.setattr(sk_agent, "_config_loaded_fingerprint", None)

    class FakeManager(SKAgentManager):
        async def start(self):
            pass  # skip kernels/plugins: provenance is set before start()

    monkeypatch.setattr(sk_agent, "SKAgentManager", FakeManager)

    asyncio.run(sk_agent._get_manager())
    assert sk_agent._config_loaded_at is not None
    assert sk_agent._config_loaded_fingerprint is not None

    # Failure path: start() raises -> except branch resets provenance along
    # with the manager, so the next retry cannot inherit stale fields.
    class ExplodingManager(SKAgentManager):
        async def start(self):
            raise RuntimeError("boom")

    monkeypatch.setattr(sk_agent, "SKAgentManager", ExplodingManager)
    monkeypatch.setattr(sk_agent, "_manager", None)
    monkeypatch.setattr(sk_agent, "_config", None)

    import pytest

    with pytest.raises(RuntimeError):
        asyncio.run(sk_agent._get_manager())
    assert sk_agent._manager is None
    assert sk_agent._config_loaded_at is None
    assert sk_agent._config_loaded_fingerprint is None
    assert sk_agent._init_error == "RuntimeError: boom"
