"""#4853: per-call presence_penalty / repetition_penalty (SamplingSpec option a).

A caller must be able to lower presence_penalty (or set repetition_penalty)
for ONE call via agent_spec.sampling, with precedence call > model > global:

- presence_penalty is an OpenAI param: the call value rides the typed param,
  and must also own a model-declared extra_body["presence_penalty"] key
  (option (b) stopgap shape) — extra_body overrides the typed param at the
  HTTP body level, so leaving the model's key would let the model beat the
  call;
- repetition_penalty is a vLLM extra: it rides extra_body, merged over the
  model's keys without dropping any (chat_template_kwargs included).

Acceptance (issue roo-extensions#4853): the HTTP body is captured by a fake
OpenAI-compatible endpoint through the REAL path — pooled AsyncOpenAI client,
SK serialization, agent.invoke — so the asserted dict is the exact request
JSON the server would receive. Absent fields must keep today's exact body
(diffed against a baseline call with no sampling override).

All values are fake fixtures (no real host, key or model).
"""

import asyncio
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from pydantic import ValidationError

from sk_agent import SKAgentManager
from sk_agent_config import AgentConfig, ModelConfig, SamplingConfig, SKAgentConfig
from sk_agent_specs import SamplingSpec

MODEL_STD = "fake-pen-std"
MODEL_MODEL_KEYS = "fake-pen-model-keys"
AGENT_STD = "fake-agent-std"
AGENT_MODEL_KEYS = "fake-agent-model-keys"

# Distinct at every precedence level so a leaked value is attributable:
# global pp=1.5, model-declared extra_body pp=0.0, call pp=-0.75.
GLOBAL_PP = 1.5
MODEL_PP = 0.0
CALL_PP = -0.75


def _completion_body():
    return {
        "id": "chatcmpl-fake",
        "object": "chat.completion",
        "created": 0,
        "model": MODEL_STD,
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "ok"},
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


class _CaptureHandler(BaseHTTPRequestHandler):
    """OpenAI-compatible endpoint that records every request body."""

    def do_POST(self):  # noqa: N802 (http.server API)
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) or b"{}"
        self.server.bodies.append(json.loads(raw))
        payload = json.dumps(_completion_body()).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


def _manager(base_url):
    cfg = SKAgentConfig(
        models=[
            ModelConfig(
                id=MODEL_STD,
                model_id=MODEL_STD,
                base_url=base_url,
                api_key="dummy-key-fake",
                thinking=False,
            ),
            # Option (b) stopgap shape (#4853): the model carries its own
            # extra_body, including a presence_penalty key.
            ModelConfig(
                id=MODEL_MODEL_KEYS,
                model_id=MODEL_MODEL_KEYS,
                base_url=base_url,
                api_key="dummy-key-fake",
                thinking=False,
                extra_body={
                    "top_k": 50,
                    "presence_penalty": MODEL_PP,
                    "chat_template_kwargs": {"thinking_budget": 2048},
                },
            ),
        ],
        agents=[
            AgentConfig(
                id=AGENT_STD,
                model=MODEL_STD,
                system_prompt="x",
            ),
            AgentConfig(
                id=AGENT_MODEL_KEYS,
                model=MODEL_MODEL_KEYS,
                system_prompt="x",
            ),
        ],
        sampling=SamplingConfig(
            temperature=0.7,
            top_k=20,
            presence_penalty=GLOBAL_PP,  # rp stays 1.0 -> absent from body
        ),
        default_agent=AGENT_STD,
    )
    manager = SKAgentManager(cfg)
    asyncio.run(manager._init_model_pool())
    return manager


class _EndpointTestCase(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _CaptureHandler)
        self.server.bodies = []
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def _call(self, manager, agent_id, agent_spec=None, conversation_id="conv"):
        result = asyncio.run(
            manager.call_agent(
                prompt="answer plainly",
                agent_id=agent_id,
                agent_spec=agent_spec,
                conversation_id=conversation_id,
            )
        )
        self.assertIn("response", result, f"call must succeed: {result!r}")
        return self.server.bodies[-1]


class TestPerCallPenaltiesReachBody(_EndpointTestCase):
    """End-to-end: the captured HTTP body carries the per-call values."""

    def test_call_presence_penalty_beats_global(self):
        mgr = _manager(self.base)
        body = self._call(
            mgr,
            AGENT_STD,
            agent_spec={"sampling": {"presence_penalty": -0.5}},
            conversation_id="conv-pp",
        )
        self.assertEqual(body["presence_penalty"], -0.5)  # global is 1.5

    def test_call_presence_penalty_beats_model_extra_body_key(self):
        mgr = _manager(self.base)
        body = self._call(
            mgr,
            AGENT_MODEL_KEYS,
            agent_spec={"sampling": {"presence_penalty": CALL_PP}},
            conversation_id="conv-pp-model",
        )
        # model declared 0.0, global is 1.5 — the call value must own the key
        self.assertEqual(body["presence_penalty"], CALL_PP)

    def test_call_repetition_penalty_merges_without_dropping_model_keys(self):
        mgr = _manager(self.base)
        body = self._call(
            mgr,
            AGENT_MODEL_KEYS,
            agent_spec={"sampling": {"repetition_penalty": 1.15}},
            conversation_id="conv-rp",
        )
        self.assertEqual(body["repetition_penalty"], 1.15)
        # every model-declared key survives the merge
        self.assertEqual(body["top_k"], 50)
        self.assertEqual(body["chat_template_kwargs"]["thinking_budget"], 2048)
        # no call pp -> model-declared pp still beats the global (option (b))
        self.assertEqual(body["presence_penalty"], MODEL_PP)

    def test_both_penalties_in_one_call(self):
        mgr = _manager(self.base)
        body = self._call(
            mgr,
            AGENT_MODEL_KEYS,
            agent_spec={
                "sampling": {
                    "presence_penalty": 0.5,
                    "repetition_penalty": 1.2,
                    "max_tokens": 64,
                }
            },
            conversation_id="conv-both",
        )
        self.assertEqual(body["presence_penalty"], 0.5)
        self.assertEqual(body["repetition_penalty"], 1.2)
        self.assertEqual(body["max_tokens"], 64)
        self.assertEqual(body["chat_template_kwargs"]["thinking_budget"], 2048)

    def test_absent_fields_keep_todays_exact_body(self):
        mgr = _manager(self.base)
        # Baseline through the SAME spec path (an empty spec): the ephemeral
        # agent names itself differently from the preset agent, and that
        # #3407 difference must not be blamed on sampling.
        baseline = self._call(
            mgr, AGENT_STD, agent_spec={}, conversation_id="conv-base"
        )
        # today's shape, pinned: global pp rides the typed param, no
        # repetition_penalty key (global rp == 1.0), sampling-derived top_k,
        # enable_thinking injection for a non-thinking model
        self.assertEqual(baseline["presence_penalty"], GLOBAL_PP)
        self.assertNotIn("repetition_penalty", baseline)
        self.assertEqual(baseline["top_k"], 20)
        self.assertEqual(
            baseline["chat_template_kwargs"], {"enable_thinking": False}
        )
        # a sampling override that does NOT touch the penalties must produce
        # today's body unchanged, apart from the field it overrides
        override = self._call(
            mgr,
            AGENT_STD,
            agent_spec={"sampling": {"temperature": 0.3}},
            conversation_id="conv-temp",
        )
        self.assertEqual(override, {**baseline, "temperature": 0.3})


class TestSamplingSpecSchema(unittest.TestCase):
    """Schema layer: the two fields validate, are bounded and stay optional."""

    def test_accepts_new_fields(self):
        spec = SamplingSpec(presence_penalty=-0.5, repetition_penalty=1.1)
        self.assertEqual(
            spec.overrides(),
            {"presence_penalty": -0.5, "repetition_penalty": 1.1},
        )

    def test_absent_fields_stay_out_of_overrides(self):
        self.assertEqual(SamplingSpec(temperature=0.3).overrides(), {"temperature": 0.3})
        self.assertEqual(SamplingSpec().overrides(), {})

    def test_bounds_reject_out_of_range(self):
        for bad in (
            {"presence_penalty": 2.5},
            {"presence_penalty": -2.5},
            {"repetition_penalty": 0.0},
            {"repetition_penalty": -1.0},
        ):
            with self.assertRaises(ValidationError, msg=bad):
                SamplingSpec(**bad)

    def test_extra_still_forbidden(self):
        with self.assertRaises(ValidationError):
            SamplingSpec(frequency_penalty=0.5)


if __name__ == "__main__":
    unittest.main()
