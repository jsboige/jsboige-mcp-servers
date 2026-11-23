# --- provenance (roo-extensions #4781 harness mutualisation) -----------------
# Copied verbatim from jsboige/vllm @ 7a09e1caec22441d9402ab25a222206c8905bfe1
# original path: myia_vllm/scripts/adoption/nb_coder/conftest.py
# Source of truth is THIS tree since the 22/11 cutover (#4781): fix bugs here. The
# jsboige/vllm copy is frozen at the SHA above: never re-copy it over this tree.
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
