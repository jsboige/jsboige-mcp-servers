"""Guard: .gitignore must keep ignoring sk_agent_config.json and its .bak-* backups (roo-extensions#3551)."""

import subprocess
from pathlib import Path

SK_AGENT_DIR = Path(__file__).resolve().parent
FICTIVE_BACKUP = "sk_agent_config.json.bak-20991231-FICTIVE-PROOF"


def _check_ignore(relpath):
    return subprocess.run(
        ["git", "check-ignore", relpath],
        cwd=SK_AGENT_DIR,
        capture_output=True,
        text=True,
    )


def test_backup_pattern_is_ignored():
    result = _check_ignore(FICTIVE_BACKUP)
    assert result.returncode == 0, (
        f"{FICTIVE_BACKUP} is NOT ignored — servers/sk-agent/.gitignore must cover "
        f"sk_agent_config.json.bak-* (stdout={result.stdout!r}, stderr={result.stderr!r})"
    )


def test_canonical_config_still_ignored():
    result = _check_ignore("sk_agent_config.json")
    assert result.returncode == 0, (
        "sk_agent_config.json is no longer ignored — regression on the canonical secret pattern"
    )
