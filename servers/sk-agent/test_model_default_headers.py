"""Unit tests for per-model default_headers (#4740).

claudish#1055 g4 §2: the nb-* entries must send the claudish lane/seat
attribution headers. Covered here: parsing, round-trip, isolation of a
malformed entry (fail closed for that model only), and the header actually
reaching the wire through the pooled AsyncOpenAI client.
"""
import asyncio
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sk_agent_config import ModelConfig, SKAgentConfig, parse_default_headers

LANE = {"x-claudish-lane": "nb-coder", "X-Claudish-Machine": "myia-ai-01"}


class TestParseDefaultHeaders(unittest.TestCase):
    def test_absent_or_empty_means_none(self):
        self.assertIsNone(parse_default_headers(None))
        self.assertIsNone(parse_default_headers({}))

    def test_valid_mapping_is_kept(self):
        self.assertEqual(parse_default_headers(dict(LANE)), LANE)

    def test_non_string_value_is_refused(self):
        with self.assertRaises(ValueError):
            parse_default_headers({"x-claudish-lane": 7})

    def test_non_mapping_is_refused(self):
        with self.assertRaises(ValueError):
            parse_default_headers(["x-claudish-lane", "nb-coder"])

    def test_invalid_name_is_refused(self):
        with self.assertRaises(ValueError):
            parse_default_headers({"bad name": "v"})

    def test_trailing_newline_in_name_is_refused(self):
        with self.assertRaises(ValueError):
            parse_default_headers({"x-claudish-lane\n": "nb-coder"})

    def test_crlf_injection_is_refused(self):
        with self.assertRaises(ValueError):
            parse_default_headers({"x-claudish-lane": "nb-coder\r\nX-Evil: 1"})


class TestModelConfigRoundTrip(unittest.TestCase):
    def test_declared_round_trip(self):
        m = ModelConfig.from_dict({"id": "nb-minimax", "default_headers": LANE})
        self.assertEqual(m.default_headers, LANE)
        self.assertIsNone(m.default_headers_error)
        again = ModelConfig.from_dict(m.to_dict())
        self.assertEqual(again.default_headers, LANE)

    def test_absent_keeps_legacy_shape(self):
        m = ModelConfig.from_dict({"id": "m"})
        self.assertIsNone(m.default_headers)
        self.assertNotIn("default_headers", m.to_dict())

    def test_rejected_is_kept_verbatim_and_flagged(self):
        raw = {"x-claudish-lane": 7}
        m = ModelConfig.from_dict({"id": "m", "default_headers": raw})
        self.assertIsNotNone(m.default_headers_error)
        # save_config must never destroy the operator's entry
        self.assertEqual(m.to_dict()["default_headers"], raw)


class _CaptureHandler(BaseHTTPRequestHandler):
    seen: list = []

    def do_POST(self):  # noqa: N802 (http.server API)
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        type(self).seen.append({k.lower(): v for k, v in self.headers.items()})
        body = json.dumps({
            "id": "c1", "object": "chat.completion", "created": 0,
            "model": "x",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": "ok"}}],
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class TestPoolClientHeaders(unittest.TestCase):
    def setUp(self):
        _CaptureHandler.seen = []
        self.server = HTTPServer(("127.0.0.1", 0), _CaptureHandler)
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def _pool(self):
        from sk_agent import SKAgentManager
        cfg = SKAgentConfig(models=[
            ModelConfig(id="declared", base_url=self.base, model_id="x",
                        default_headers=dict(LANE)),
            ModelConfig(id="undeclared", base_url=self.base, model_id="x"),
            ModelConfig(id="rejected", base_url=self.base, model_id="x",
                        default_headers={"x-claudish-lane": 7},
                        default_headers_error="must be a string"),
        ])
        manager = SKAgentManager(cfg)
        asyncio.run(manager._init_model_pool())
        return manager

    def _call(self, client):
        async def go():
            await client.chat.completions.create(
                model="x", messages=[{"role": "user", "content": "hi"}])
        asyncio.run(go())
        return _CaptureHandler.seen[-1]

    def test_declared_headers_reach_the_wire(self):
        manager = self._pool()
        seen = self._call(manager._openai_clients["declared"])
        self.assertEqual(seen.get("x-claudish-lane"), "nb-coder")
        self.assertEqual(seen.get("x-claudish-machine"), "myia-ai-01")

    def test_undeclared_client_sends_no_lane_header(self):
        manager = self._pool()
        seen = self._call(manager._openai_clients["undeclared"])
        self.assertNotIn("x-claudish-lane", seen)
        self.assertNotIn("x-claudish-machine", seen)

    def test_rejected_model_is_left_out_of_the_pool_only(self):
        manager = self._pool()
        self.assertNotIn("rejected", manager._openai_clients)
        self.assertIn("declared", manager._openai_clients)
        self.assertIn("undeclared", manager._openai_clients)


if __name__ == "__main__":
    unittest.main()
