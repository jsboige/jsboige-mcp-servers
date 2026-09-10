"""Guard: .gitignore must keep ignoring sk_agent_config.json and its bare/dated .bak backups (roo-extensions#3551, #3411)."""

import subprocess
from pathlib import Path

SK_AGENT_DIR = Path(__file__).resolve().parent
# The bare filename is what sync_from_template.py rotates to (no timestamp); the
# dated variant is the legacy backup form. Both paths are fictitious: only the
# ignore PATTERN is tested via git check-ignore, never an actual local file.
FICTIVE_BARE_BACKUP = "sk_agent_config.json.bak"
FICTIVE_TIMESTAMPED_BACKUP = "sk_agent_config.json.bak-20991231-FICTIVE-PROOF"


def _check_ignore(relpath):
    return subprocess.run(
        ["git", "check-ignore", relpath],
        cwd=SK_AGENT_DIR,
        capture_output=True,
        text=True,
    )


def test_bare_backup_is_ignored():
    result = _check_ignore(FICTIVE_BARE_BACKUP)
    assert result.returncode == 0, (
        f"{FICTIVE_BARE_BACKUP} is NOT ignored — servers/sk-agent/.gitignore must cover "
        f"the bare sk_agent_config.json.bak rotation target (stdout={result.stdout!r}, stderr={result.stderr!r})"
    )


def test_timestamped_backup_is_ignored():
    result = _check_ignore(FICTIVE_TIMESTAMPED_BACKUP)
    assert result.returncode == 0, (
        f"{FICTIVE_TIMESTAMPED_BACKUP} is NOT ignored — servers/sk-agent/.gitignore must cover "
        f"sk_agent_config.json.bak-* dated backups (stdout={result.stdout!r}, stderr={result.stderr!r})"
    )


def test_canonical_config_still_ignored():
    result = _check_ignore("sk_agent_config.json")
    assert result.returncode == 0, (
        "sk_agent_config.json is no longer ignored — regression on the canonical secret pattern"
    )
