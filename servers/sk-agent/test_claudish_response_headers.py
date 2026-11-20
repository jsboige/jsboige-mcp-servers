"""#4844: claudish response headers in the call_agent envelope.

`failover_notice` (x-claudish-failover-notice, base64 UTF-8 — claudish#229)
and `served_model` (x-claudish-served-model — claudish#1128) must surface at
the TOP LEVEL of a successful envelope, captured PER CALL: the AsyncOpenAI
clients are pooled per model and shared by concurrent calls, so capture rides
a ContextVar-scoped httpx hook, never a shared attribute.

Contract pinned here (consumer: vllm#504, merged):
- a header the endpoint did not send stays an ABSENT field — the nb_coder
  driver maps absence to "unknown"; a value inferred from the requested id or
  from model_used would defeat the producer != verifier guard;
- an undecodable base64 notice is dropped silently, the call succeeds;
- `model_used` keeps its id-of-entry semantics in every case.

All values are fake fixtures (no real host, key, model or notice).
"""

import asyncio
import base64
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from sk_agent import (
    CLAUDISH_FAILOVER_NOTICE_HEADER,
    CLAUDISH_SERVED_MODEL_HEADER,
    ClaudishHeaderCapture,
    SKAgentManager,
)
from sk_agent_config import AgentConfig, ModelConfig, SKAgentConfig

MODEL_ID = "fake-model"
AGENT_ID = "fake-agent"
FAILOVER_TEXT = (
    "claudish failover notice: nominal model restored (fake fixture value)"
)
FAILOVER_B64 = base64.b64encode(FAILOVER_TEXT.encode("utf-8")).decode("ascii")
INVALID_B64 = "not-base64!!!"  # `!` is outside the base64 alphabet

# marker -> claudish headers the fake endpoint sends back for that call.
# The marker travels in the user prompt, so each call ATTRIBUTES its own
# response even when two calls share the pooled client concurrently.
ROUTES = {
    "route-alpha": {"failover": FAILOVER_B64,
                    "served": "fake-provider@gpt-alpha"},
    "route-beta": {"failover": None, "served": "fake-provider@gpt-beta"},
    "bad-b64": {"failover": INVALID_B64, "served": "fake-provider@gpt-beta"},
    "no-headers": {"failover": None, "served": None},
}


def _completion_body():
    return {
        "id": "chatcmpl-fake",
        "object": "chat.completion",
        "created": 0,
        "model": MODEL_ID,
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "ok"},
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


class _FakeClaudishHandler(BaseHTTPRequestHandler):
    """OpenAI-compatible endpoint whose claudish headers follow the marker."""

    def do_POST(self):  # noqa: N802 (http.server API)
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) or b"{}"
        try:
            body = json.loads(raw)
        except ValueError:
            body = {}
        route = ROUTES[_marker_of(body)]
        payload = json.dumps(_completion_body()).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        if route["failover"] is not None:
            self.send_header(CLAUDISH_FAILOVER_NOTICE_HEADER, route["failover"])
        if route["served"] is not None:
            self.send_header(CLAUDISH_SERVED_MODEL_HEADER, route["served"])
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


def _marker_of(body):
    messages = body.get("messages") or []
    for msg in reversed(messages):
        content = msg.get("content")
        text = content if isinstance(content, str) else json.dumps(content)
        for marker in ROUTES:
            if marker in text:
                return marker
    return "no-headers"


def _manager(base_url):
    cfg = SKAgentConfig(
        models=[
            ModelConfig.from_dict(
                {
                    "id": MODEL_ID,
                    "enabled": True,
                    "base_url": base_url,
                    "api_key": "dummy-key-fake",
                    "model_id": MODEL_ID,
                    "vision": False,
                    "thinking": False,
                    "description": "fake",
                    "context_window": 32768,
                }
            ),
        ],
        agents=[
            AgentConfig.from_dict(
                {
                    "id": AGENT_ID,
                    "description": "fake",
                    "model": MODEL_ID,
                    "system_prompt": "x",
                    "mcps": [],
                    "memory": {"enabled": False},
                }
            ),
        ],
    )
    manager = SKAgentManager(cfg)
    asyncio.run(manager._init_model_pool())
    return manager


class TestEnvelopeFields(unittest.TestCase):
    """End-to-end: real pooled client, real agent, fake claudish endpoint."""

    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeClaudishHandler)
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def _call(self, manager, marker, conversation_id):
        return asyncio.run(
            manager.call_agent(
                prompt=f"answer plainly, marker {marker}",
                agent_id=AGENT_ID,
                conversation_id=conversation_id,
            )
        )

    def test_header_present_field_present_and_decoded(self):
        """Test 1: present header -> present, DECODED field."""
        mgr = _manager(self.base)
        result = self._call(mgr, "route-alpha", "conv-alpha")

        self.assertIn("response", result, f"call must succeed: {result!r}")
        self.assertEqual(result["failover_notice"], FAILOVER_TEXT)
        self.assertEqual(result["served_model"], "fake-provider@gpt-alpha")

    def test_header_absent_field_absent(self):
        """Test 2: absent header -> ABSENT field, never a substitute."""
        mgr = _manager(self.base)
        result = self._call(mgr, "no-headers", "conv-none")

        self.assertIn("response", result, f"call must succeed: {result!r}")
        self.assertNotIn("failover_notice", result)
        self.assertNotIn("served_model", result)
        # the substitute the issue forbids: inventing the field from the
        # requested id / model_used instead of the endpoint's silence
        self.assertNotIn("served_model_variants", result)
        self.assertNotIn("failover_notice_variants", result)

    def test_invalid_base64_field_dropped_call_survives(self):
        """Test 3: undecodable notice -> absent field, no exception."""
        mgr = _manager(self.base)
        result = self._call(mgr, "bad-b64", "conv-bad")

        self.assertIn("response", result, f"call must succeed: {result!r}")
        self.assertNotIn("failover_notice", result)
        # a sibling readable field on the same response still surfaces
        self.assertEqual(result["served_model"], "fake-provider@gpt-beta")

    def test_concurrent_calls_each_envelope_carries_its_own(self):
        """Test 4: shared client, concurrent calls, distinct headers."""
        mgr = _manager(self.base)
        # warm the lazy agent creation up front: the race under test is the
        # header capture, not _get_or_create_agent
        warm = self._call(mgr, "no-headers", "conv-warm")
        self.assertIn("response", warm)

        async def two_at_once():
            return await asyncio.gather(
                mgr.call_agent(
                    prompt="answer plainly, marker route-alpha",
                    agent_id=AGENT_ID,
                    conversation_id="conv-a",
                ),
                mgr.call_agent(
                    prompt="answer plainly, marker route-beta",
                    agent_id=AGENT_ID,
                    conversation_id="conv-b",
                ),
            )

        alpha, beta = asyncio.run(two_at_once())
        self.assertIn("response", alpha, f"alpha call must succeed: {alpha!r}")
        self.assertIn("response", beta, f"beta call must succeed: {beta!r}")
        self.assertEqual(alpha["served_model"], "fake-provider@gpt-alpha")
        self.assertEqual(beta["served_model"], "fake-provider@gpt-beta")
        self.assertEqual(alpha["failover_notice"], FAILOVER_TEXT)
        self.assertNotIn("failover_notice", beta)
        # neither envelope silently carries the other call's value
        self.assertNotEqual(alpha["served_model"], beta["served_model"])

    def test_model_used_unchanged_in_all_cases(self):
        """Test 5: model_used keeps its id-of-entry semantics everywhere."""
        mgr = _manager(self.base)
        for marker, conv in (
            ("route-alpha", "conv-mu-1"),
            ("no-headers", "conv-mu-2"),
            ("bad-b64", "conv-mu-3"),
        ):
            result = self._call(mgr, marker, conv)
            self.assertEqual(
                result["model_used"],
                MODEL_ID,
                f"model_used must stay the entry id ({marker}): {result!r}",
            )


class TestFoldSemantics(unittest.TestCase):
    """Unit level: multi-response divergence is never silent."""

    @staticmethod
    def _b64(text):
        return base64.b64encode(text.encode("utf-8")).decode("ascii")

    def test_divergent_served_models_last_plus_variants(self):
        capture = ClaudishHeaderCapture()
        capture.record({CLAUDISH_SERVED_MODEL_HEADER: "fake@one"})
        capture.record({CLAUDISH_SERVED_MODEL_HEADER: "fake@two"})
        capture.record({CLAUDISH_SERVED_MODEL_HEADER: "fake@one"})
        out = {}
        capture.fold_into_envelope(out)
        self.assertEqual(out["served_model"], "fake@one")  # last value
        self.assertEqual(
            out["served_model_variants"], ["fake@one", "fake@two"]
        )  # distinct, first-appearance order

    def test_single_value_no_variants_field(self):
        capture = ClaudishHeaderCapture()
        capture.record({CLAUDISH_SERVED_MODEL_HEADER: "fake@one"})
        capture.record({CLAUDISH_SERVED_MODEL_HEADER: "fake@one"})
        out = {}
        capture.fold_into_envelope(out)
        self.assertEqual(out["served_model"], "fake@one")
        self.assertNotIn("served_model_variants", out)

    def test_divergent_failover_notices_last_plus_variants(self):
        capture = ClaudishHeaderCapture()
        capture.record(
            {CLAUDISH_FAILOVER_NOTICE_HEADER: self._b64("notice one")}
        )
        capture.record(
            {CLAUDISH_FAILOVER_NOTICE_HEADER: self._b64("notice two")}
        )
        out = {}
        capture.fold_into_envelope(out)
        self.assertEqual(out["failover_notice"], "notice two")
        self.assertEqual(
            out["failover_notice_variants"], ["notice one", "notice two"]
        )

    def test_all_undecodable_failovers_field_absent(self):
        capture = ClaudishHeaderCapture()
        capture.record({CLAUDISH_FAILOVER_NOTICE_HEADER: INVALID_B64})
        capture.record({CLAUDISH_FAILOVER_NOTICE_HEADER: "��"})
        out = {}
        capture.fold_into_envelope(out)  # must not raise
        self.assertNotIn("failover_notice", out)
        self.assertNotIn("failover_notice_variants", out)

    def test_empty_capture_folds_nothing(self):
        out = {"model_used": MODEL_ID}
        ClaudishHeaderCapture().fold_into_envelope(out)
        self.assertEqual(out, {"model_used": MODEL_ID})


if __name__ == "__main__":
    unittest.main()
