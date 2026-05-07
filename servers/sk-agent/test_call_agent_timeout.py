"""Unit tests for call_agent timeout feature (#2046)."""
import asyncio
import json
import sys
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

# Add parent dir to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


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


class TestCallAgentTimeout(unittest.TestCase):
    """Test timeout behavior in SKAgentManager.call_agent()."""

    def test_timeout_param_default(self):
        """call_agent should accept timeout parameter with default 120."""
        manager = _make_manager()
        # Verify the method signature includes timeout
        import inspect
        sig = inspect.signature(manager.call_agent)
        self.assertIn("timeout", sig.parameters)
        self.assertEqual(sig.parameters["timeout"].default, 120)

    @patch.object(
        __import__("sk_agent").SKAgentManager,
        "_handle_text",
        new_callable=AsyncMock,
        return_value={"response": "ok", "conversation_id": "c1", "agent_used": "a", "model_used": "m"},
    )
    def test_timeout_not_triggered(self, mock_handle_text):
        """Normal call completes within timeout."""
        from sk_agent import SKAgentManager

        manager = _make_manager()
        manager._resolve_agent = AsyncMock(return_value=("test-agent", FakeAgent()))

        async def _run():
            result = manager.call_agent(
                prompt="hello",
                timeout=120,
            )
            return await result

        result = asyncio.run(_run())
        self.assertNotIn("error", result)
        self.assertEqual(result["response"], "ok")

    def test_timeout_triggered(self):
        """call_agent returns error dict when execution exceeds timeout."""
        manager = _make_manager()

        async def _slow_resolve(**kwargs):
            await asyncio.sleep(10)
            return ("test-agent", FakeAgent())

        manager._resolve_agent = _slow_resolve

        async def _run():
            return await manager.call_agent(
                prompt="hello",
                timeout=0.1,
            )

        result = asyncio.run(_run())
        self.assertIn("error", result)
        self.assertIn("timed out", result["error"])
        self.assertEqual(result["timeout"], 0.1)

    def test_timeout_zero_means_no_limit(self):
        """timeout=0 should mean no timeout (None passed to asyncio.wait_for)."""
        manager = _make_manager()
        manager._resolve_agent = AsyncMock(return_value=("test-agent", FakeAgent()))
        manager._handle_text = AsyncMock(
            return_value={"response": "ok", "conversation_id": "c1", "agent_used": "a", "model_used": "m"}
        )

        async def _run():
            return await manager.call_agent(
                prompt="hello",
                timeout=0,
            )

        result = asyncio.run(_run())
        self.assertNotIn("error", result)
        self.assertEqual(result["response"], "ok")

    def test_tool_level_timeout_param(self):
        """Tool-level call_agent should accept timeout parameter."""
        from sk_agent import call_agent as tool_call_agent
        import inspect
        sig = inspect.signature(tool_call_agent)
        self.assertIn("timeout", sig.parameters)
        self.assertEqual(sig.parameters["timeout"].default, 120)

    def test_tool_level_timeout_passthrough(self):
        """Tool-level timeout=0 should pass None to manager."""
        from sk_agent import call_agent as tool_call_agent

        with patch("sk_agent._get_manager", new_callable=AsyncMock) as mock_get:
            mock_manager = MagicMock()
            mock_manager.call_agent = AsyncMock(
                return_value={"response": "ok", "conversation_id": "c1"}
            )
            mock_get.return_value = mock_manager

            async def _run():
                return await tool_call_agent(
                    prompt="hello",
                    timeout=0,
                )

            result = json.loads(asyncio.run(_run()))
            mock_manager.call_agent.assert_called_once()
            call_kwargs = mock_manager.call_agent.call_args
            self.assertIsNone(call_kwargs.kwargs.get("timeout") or call_kwargs[1].get("timeout"))


if __name__ == "__main__":
    unittest.main()
