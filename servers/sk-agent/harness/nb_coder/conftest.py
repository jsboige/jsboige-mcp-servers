# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7f7dd99bd2b5b8fce2b3aba315f24fd7ca5d2b77
# original path: myia_vllm/scripts/adoption/nb_coder/conftest.py
# Source of truth stays jsboige/vllm until the cutover completes: fix bugs there and
# re-copy, do not diverge silently.
# -----------------------------------------------------------------------------
"""Keep the suite hermetic: without a GitHub App the driver pins a gh account through real
`gh auth` calls (pinned_gh_token). No test may reach the machine's gh accounts."""
import pytest


@pytest.fixture(autouse=True)
def _no_real_gh_pin(monkeypatch):
    try:
        import nb_coder_driver as d
    except Exception:
        yield
        return
    d.GH_IDENTITY.clear()
    monkeypatch.setattr(d, "_gh_out", lambda argv, timeout=20, token=None: None)
    yield
    d.GH_IDENTITY.clear()
