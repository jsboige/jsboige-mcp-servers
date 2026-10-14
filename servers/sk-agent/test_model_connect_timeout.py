"""Unit tests for model connect-timeout + freeze-dump watchdog (#4085)."""
import asyncio
import os
import sys
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

# Add parent dir to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sk_agent_config import (
    SKAgentConfig,
    AgentConfig,
    ModelConfig,
    DEFAULT_REQUEST_TIMEOUT_S,
    DEFAULT_MODEL_CONNECT_TIMEOUT_S,
)


class FakeAgent:
    """Minimal ChatCompletionAgent mock."""
    pass


class FakeConfig:
    """Minimal SKAgentConfig mock."""
    agents = [MagicMock(id="test-agent")]


def _make_manager():
    """Create a SKAgentManager with mocked internals."""
    from sk_agent import SKAgentManager
    manager = SKAgentManager.__new__(SKAgentManager)
    manager.config = FakeConfig()
    manager._agents = {"test-agent": FakeAgent()}
    manager._threads = {}
    manager._thread_counter = 0
    manager._execution_settings = None
    return manager


class TestConnectTimeoutConfig(unittest.TestCase):
    """Config surface: constant sanity + ModelConfig round-trip."""

    def test_default_model_connect_timeout_sane(self):
        self.assertGreater(DEFAULT_MODEL_CONNECT_TIMEOUT_S, 0)
        self.assertLessEqual(DEFAULT_MODEL_CONNECT_TIMEOUT_S, 60.0)

    def test_model_config_connect_timeout_round_trip(self):
        declared = ModelConfig.from_dict({"id": "m1", "connect_timeout_s": 3.5})
        self.assertEqual(declared.connect_timeout_s, 3.5)
        self.assertEqual(declared.to_dict().get("connect_timeout_s"), 3.5)
        # absent → None → omitted from to_dict (legacy shape preserved)
        absent = ModelConfig.from_dict({"id": "m2"})
        self.assertIsNone(absent.connect_timeout_s)
        self.assertNotIn("connect_timeout_s", absent.to_dict())


class TestClientTimeoutShape(unittest.TestCase):
    """_init_model_pool must hand each client an httpx.Timeout with a bounded
    connect phase while read/write/pool keep the request budget."""

    def test_clients_get_bounded_connect_and_legacy_budget(self):
        import httpx
        from sk_agent import SKAgentManager

        cfg = SKAgentConfig(
            models=[
                ModelConfig(
                    id="declared",
                    base_url="http://127.0.0.1:9/v1",
                    model_id="x",
                    connect_timeout_s=2.0,
                ),
                ModelConfig(
                    id="undeclared",
                    base_url="http://127.0.0.1:9/v1",
                    model_id="x",
                ),
                ModelConfig(
                    id="budgeted",
                    base_url="http://127.0.0.1:9/v1",
                    model_id="x",
                    request_timeout_s=42.0,
                ),
            ],
        )
        manager = SKAgentManager(cfg)
        asyncio.run(manager._init_model_pool())

        t_declared = manager._openai_clients["declared"].timeout
        t_undeclared = manager._openai_clients["undeclared"].timeout
        t_budgeted = manager._openai_clients["budgeted"].timeout

        self.assertIsInstance(t_declared, httpx.Timeout)
        self.assertEqual(t_declared.connect, 2.0)
        self.assertEqual(t_undeclared.connect, DEFAULT_MODEL_CONNECT_TIMEOUT_S)
        # read/write/pool keep the request budget (scalar-timeout legacy)
        self.assertEqual(t_undeclared.read, DEFAULT_REQUEST_TIMEOUT_S)
        self.assertEqual(t_budgeted.read, 42.0)
        self.assertEqual(t_budgeted.connect, DEFAULT_MODEL_CONNECT_TIMEOUT_S)


class TestFreezeDumpWatchdog(unittest.TestCase):
    """#4085: faulthandler watchdog around the call_agent wait_for ceiling."""

    def test_arm_disarm_depth_semantics(self):
        import sk_agent
        with patch.object(sk_agent, "faulthandler") as fh:
            sk_agent._FAULT_DUMP_DEPTH = 0
            try:
                sk_agent._arm_freeze_dump(10.0)
                sk_agent._arm_freeze_dump(20.0)
                # One process-wide timer: re-arm replaces the pending deadline
                fh.dump_traceback_later.assert_called_with(
                    20.0 + sk_agent._FAULT_DUMP_GRACE_S, exit=False
                )
                fh.cancel_dump_traceback_later.assert_not_called()
                sk_agent._disarm_freeze_dump()
                # Still one call in flight → timer stays armed
                fh.cancel_dump_traceback_later.assert_not_called()
                sk_agent._disarm_freeze_dump()
                fh.cancel_dump_traceback_later.assert_called_once()
            finally:
                sk_agent._FAULT_DUMP_DEPTH = 0

    def test_call_agent_arms_watchdog_only_with_ceiling(self):
        manager = _make_manager()
        manager._resolve_agent = AsyncMock(return_value=("test-agent", FakeAgent()))
        manager._handle_text = AsyncMock(return_value={"response": "ok"})

        with patch("sk_agent._arm_freeze_dump") as arm, \
                patch("sk_agent._disarm_freeze_dump") as disarm:
            async def _run():
                return await manager.call_agent(prompt="hello", timeout=120)
            asyncio.run(_run())
        arm.assert_called_once_with(120)
        disarm.assert_called_once()

        # timeout=0 (no ceiling) → no watchdog to arm
        with patch("sk_agent._arm_freeze_dump") as arm, \
                patch("sk_agent._disarm_freeze_dump") as disarm:
            async def _run0():
                return await manager.call_agent(prompt="hello", timeout=0)
            asyncio.run(_run0())
        arm.assert_not_called()
        disarm.assert_not_called()

    def test_wait_for_cannot_fire_while_loop_frozen(self):
        """The #4085 signature, as actually measured: a sync freeze outruns
        the wait_for ceiling and the call still 'succeeds' — the loop was
        frozen, the timeout callback could not run, and when the loop resumes
        the handler completes before wait_for can cancel it. This ceiling-
        under-freeze powerlessness is exactly what the faulthandler watchdog
        compensates for (a freeze outlasting ceiling + grace dumps the stack)."""
        import sk_agent
        manager = _make_manager()

        async def _slow_resolve(**kwargs):
            return ("test-agent", FakeAgent())

        manager._resolve_agent = _slow_resolve

        def _freeze_handler(*args, **kwargs):
            time.sleep(1.0)  # SYNC block: freezes the event loop
            return {"response": "ok"}

        manager._handle_text = AsyncMock(side_effect=_freeze_handler)

        with patch.object(sk_agent, "faulthandler") as fh:
            async def _run():
                return await manager.call_agent(prompt="hello", timeout=0.1)
            t0 = time.monotonic()
            result = asyncio.run(_run())
            elapsed = time.monotonic() - t0

        # The freeze outruns the 0.1 s ceiling…
        self.assertGreaterEqual(elapsed, 1.0)
        # …and wait_for is powerless DURING it: the call completes with the
        # handler's own result, ceiling blown. In production the freeze is
        # usually permanent (unreachable hub), so neither this result nor a
        # timeout ever arrives — which is why the dump matters.
        self.assertEqual(result, {"response": "ok"})
        # Watchdog: armed at ceiling + grace, cancelled on completion.
        fh.dump_traceback_later.assert_called_once_with(
            0.1 + sk_agent._FAULT_DUMP_GRACE_S, exit=False
        )
        fh.cancel_dump_traceback_later.assert_called_once()


class TestUnreachableModelEndToEnd(unittest.TestCase):
    """GO acceptance (#4085): non-routable model endpoint → bounded error, and
    a second call on the SAME process answers too (no silent deaf spawn)."""

    def test_unreachable_host_bounded_and_recovers(self):
        from sk_agent import SKAgentManager

        cfg = SKAgentConfig(
            models=[
                ModelConfig(
                    id="dead-hub",
                    base_url="http://10.255.255.1:9/v1",
                    model_id="dead",
                    connect_timeout_s=1.5,
                )
            ],
            agents=[AgentConfig(id="probe-agent", model="dead-hub")],
        )
        manager = SKAgentManager(cfg)

        async def _two_calls():
            await manager.start()
            r1 = await manager.call_agent(prompt="ping", agent_id="probe-agent", timeout=20)
            r2 = await manager.call_agent(prompt="ping", agent_id="probe-agent", timeout=20)
            return r1, r2

        t0 = time.monotonic()
        r1, r2 = asyncio.run(_two_calls())
        elapsed = time.monotonic() - t0

        self.assertIn("error", r1)  # unreachable endpoint → error, not silence
        self.assertIn("error", r2)  # second call on the same process responds
        # Bounded: ~2 connect attempts at 1.5 s + backoff per call, far below
        # the 20 s ceiling — a regression to the scalar shared budget pushes
        # this towards the 2×20 s wait_for ceilings.
        self.assertLess(elapsed, 30.0)


if __name__ == "__main__":
    unittest.main()
