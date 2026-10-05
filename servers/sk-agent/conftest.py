"""Shared pytest setup for sk-agent tests."""

import os
import tempfile


def pytest_configure(config):
    # Tests that call real tools would otherwise append to the developer's
    # usage log (%LOCALAPPDATA%/sk-agent/usage.jsonl) and inflate the counter
    # the telemetry exists to measure.  Set before sk_agent is imported, since
    # USAGE_LOG is resolved at import time.
    os.environ["SK_AGENT_USAGE_LOG"] = os.path.join(
        tempfile.mkdtemp(prefix="sk-agent-tests-"), "usage.jsonl"
    )
