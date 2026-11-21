"""Unit tests for per-model max_retries (#4849).

vLLM abandons the decode as soon as the client disconnects, so replaying a
request that already timed out restarts from zero under the same budget and
load — it only doubles the wall time. Covered here: parsing (int >= 0, bool
refused), ModelConfig round-trip, isolation of a malformed entry (fail
closed for that model only), the value actually reaching the pooled
AsyncOpenAI client (0 declared -> 0, absent -> legacy 1), and the shared
embeddings endpoint accepting the same field.
"""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sk_agent_config import (
    EmbeddingsConfig,
    ModelConfig,
    SKAgentConfig,
    parse_max_retries,
)


class TestParseMaxRetries(unittest.TestCase):
    def test_absent_means_none(self):
        self.assertIsNone(parse_max_retries(None))

    def test_zero_is_kept(self):
        self.assertEqual(parse_max_retries(0), 0)

    def test_positive_is_kept(self):
        self.assertEqual(parse_max_retries(3), 3)

    def test_negative_is_refused(self):
        with self.assertRaises(ValueError):
            parse_max_retries(-1)

    def test_string_is_refused(self):
        with self.assertRaises(ValueError):
            parse_max_retries("2")

    def test_float_is_refused(self):
        with self.assertRaises(ValueError):
            parse_max_retries(1.5)

    def test_bool_is_refused(self):
        # bool is an int subclass; max_retries: true is never a retry count.
        with self.assertRaises(ValueError):
            parse_max_retries(True)


class TestModelConfigRoundTrip(unittest.TestCase):
    def _model(self, **kw):
        return ModelConfig.from_dict({"id": "m", "base_url": "http://x/v1", **kw})

    def test_declared_round_trip(self):
        m = self._model(max_retries=0)
        self.assertEqual(m.max_retries, 0)
        self.assertIsNone(m.max_retries_error)
        self.assertEqual(m.to_dict().get("max_retries"), 0)
        again = ModelConfig.from_dict(m.to_dict())
        self.assertEqual(again.max_retries, 0)
        self.assertIsNone(again.max_retries_error)

    def test_absent_keeps_legacy_shape(self):
        m = self._model()
        self.assertIsNone(m.max_retries)
        self.assertIsNone(m.max_retries_error)
        self.assertNotIn("max_retries", m.to_dict())

    def test_rejected_is_kept_verbatim_and_flagged(self):
        m = self._model(max_retries=-1)
        self.assertEqual(m.max_retries, -1)  # verbatim: save_config keeps it
        self.assertIsNotNone(m.max_retries_error)
        self.assertEqual(m.to_dict().get("max_retries"), -1)


class TestPoolClientMaxRetries(unittest.TestCase):
    def _pool(self):
        from sk_agent import SKAgentManager
        cfg = SKAgentConfig(models=[
            ModelConfig(id="declared0", base_url="http://127.0.0.1:9/v1",
                        model_id="x", max_retries=0),
            ModelConfig(id="undeclared", base_url="http://127.0.0.1:9/v1",
                        model_id="x"),
            ModelConfig(id="rejected", base_url="http://127.0.0.1:9/v1",
                        model_id="x", max_retries=-1,
                        max_retries_error="must be >= 0"),
        ])
        manager = SKAgentManager(cfg)
        asyncio.run(manager._init_model_pool())
        return manager

    def test_declared_zero_reaches_the_client(self):
        manager = self._pool()
        self.assertEqual(manager._openai_clients["declared0"].max_retries, 0)

    def test_undeclared_client_keeps_legacy_one(self):
        manager = self._pool()
        self.assertEqual(manager._openai_clients["undeclared"].max_retries, 1)

    def test_rejected_model_is_left_out_of_the_pool_only(self):
        manager = self._pool()
        self.assertNotIn("rejected", manager._openai_clients)
        self.assertIn("declared0", manager._openai_clients)
        self.assertIn("undeclared", manager._openai_clients)


class TestEmbeddingsConfig(unittest.TestCase):
    def test_absent_means_none(self):
        emb = EmbeddingsConfig.from_dict({"base_url": "http://x", "model_id": "e"})
        self.assertIsNone(emb.max_retries)
        self.assertNotIn("max_retries", emb.to_dict())

    def test_declared_round_trip(self):
        emb = EmbeddingsConfig.from_dict(
            {"base_url": "http://x", "model_id": "e", "max_retries": 0})
        self.assertEqual(emb.max_retries, 0)
        self.assertEqual(emb.to_dict().get("max_retries"), 0)

    def test_malformed_fails_the_load_loudly(self):
        # One embeddings endpoint, no pool to isolate into: the load fails.
        with self.assertRaises(ValueError):
            EmbeddingsConfig.from_dict(
                {"base_url": "http://x", "model_id": "e", "max_retries": -1})


if __name__ == "__main__":
    unittest.main()
