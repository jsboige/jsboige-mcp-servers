"""Text source channel for call_agent (vllm#205 gesture b).

Exercises the `source_file` parameter of the module-level call_agent wrapper:
a local text file is injected VERBATIM into the prompt between <source_file>
delimiters, with a cap, a truncation marker, and a response echo. The media
attachment path (image/video/document) is untouched by this channel.
"""

import json

import pytest

import sk_agent


class _StubManager:
    """Captures what the wrapper hands to the manager, answers "ok"."""

    def __init__(self):
        self.calls: list[dict] = []

    async def call_agent(self, prompt, **kwargs):
        self.calls.append({"prompt": prompt, **kwargs})
        return {
            "response": "ok",
            "conversation_id": "c1",
            "agent_used": "default-agent",
            "model_used": "stub-model",
        }


@pytest.fixture
def stub_manager(monkeypatch):
    mgr = _StubManager()

    async def _fake_get_manager():
        return mgr

    monkeypatch.setattr(sk_agent, "_get_manager", _fake_get_manager)
    return mgr


def _parse(raw: str) -> dict:
    return json.loads(raw)


def _body_of(prompt: str) -> str:
    """The content between the opening tag's newline and the closing tag."""
    return prompt.split(">\n", 1)[1].rsplit("</source_file>", 1)[0]


class TestRefusals:
    """Every refusal fires before the manager is touched."""

    @pytest.mark.asyncio
    async def test_missing_file_refused(self, stub_manager, tmp_path):
        missing = str(tmp_path / "nope.log")
        raw = _parse(await sk_agent.call_agent(prompt="q", source_file=missing))
        assert "error" in raw
        assert "Source file not found" in raw["error"]
        assert stub_manager.calls == []

    @pytest.mark.asyncio
    async def test_media_extension_refused_on_the_text_channel(
        self, stub_manager, tmp_path
    ):
        # .png stays an attachment concern; the text channel must not become a
        # side door for binary media classification.
        png = tmp_path / "corpus.png"
        png.write_bytes(b"\x89PNG\r\n\x1a\n")
        raw = _parse(
            await sk_agent.call_agent(prompt="q", source_file=str(png))
        )
        assert "error" in raw
        assert "Unsupported source file extension '.png'" in raw["error"]
        assert ".log" in raw["error"]  # the message lists the text extensions
        assert stub_manager.calls == []

    @pytest.mark.asyncio
    async def test_cap_bool_rejected(self, stub_manager, tmp_path):
        # JSON true coerces to 1 under isinstance(x, int) — the same laxness
        # that let Pydantic accept "5" for rate_limit (ms#1636) must not pass
        # here: `true` would cap the corpus at one char.
        f = tmp_path / "c.log"
        f.write_text("x" * 50, encoding="utf-8")
        raw = _parse(
            await sk_agent.call_agent(
                prompt="q",
                source_file=str(f),
                options='{"source_max_chars": true}',
            )
        )
        assert "error" in raw
        assert "source_max_chars" in raw["error"]
        assert stub_manager.calls == []

    @pytest.mark.asyncio
    async def test_cap_below_one_rejected(self, stub_manager, tmp_path):
        f = tmp_path / "c.log"
        f.write_text("x" * 50, encoding="utf-8")
        raw = _parse(
            await sk_agent.call_agent(
                prompt="q",
                source_file=str(f),
                options='{"source_max_chars": 0}',
            )
        )
        assert "error" in raw
        assert stub_manager.calls == []

    @pytest.mark.asyncio
    async def test_cap_ceiling_enforced(self, stub_manager, tmp_path):
        f = tmp_path / "c.log"
        f.write_text("x" * 50, encoding="utf-8")
        raw = _parse(
            await sk_agent.call_agent(
                prompt="q",
                source_file=str(f),
                options='{"source_max_chars": 2000001}',
            )
        )
        assert "error" in raw
        assert "ceiling" in raw["error"]
        assert stub_manager.calls == []


class TestInjection:
    @pytest.mark.asyncio
    async def test_content_injected_verbatim_with_echo(self, stub_manager, tmp_path):
        corpus = "temp=31C idle\nWARN disk 82%\nPROMPT_OK run 7\n"
        f = tmp_path / "vigie.log"
        f.write_bytes(corpus.encode("utf-8"))  # bytes: no host newline rewrite
        raw = _parse(
            await sk_agent.call_agent(
                prompt="extract the WARN lines", source_file=str(f)
            )
        )
        assert "error" not in raw
        assert raw["source_file"]["truncated"] is False
        assert raw["source_file"]["chars"] == len(corpus)
        sent = stub_manager.calls[0]["prompt"]
        # Prompt = instruction, then the delimited block, nothing else.
        assert sent.startswith("extract the WARN lines\n\n<source_file ")
        assert sent.endswith("</source_file>")
        # Verbatim: the exact corpus bytes sit inside the delimiters (the
        # framing adds one \n before the closing tag).
        assert _body_of(sent) == corpus + "\n"

    @pytest.mark.asyncio
    async def test_crlf_corpus_stays_byte_identical(self, stub_manager, tmp_path):
        # A CRLF corpus must reach the prompt with its \r intact — the block
        # is diffed against grep oracles, newline normalisation would skew it.
        corpus = "temp=31C idle\r\nWARN disk 82%\r\n"
        f = tmp_path / "crlf.log"
        f.write_bytes(corpus.encode("utf-8"))
        await sk_agent.call_agent(prompt="q", source_file=str(f))
        body = _body_of(stub_manager.calls[0]["prompt"])
        assert "\r\n" in body
        assert body == corpus + "\n"

    @pytest.mark.asyncio
    async def test_bom_stripped(self, stub_manager, tmp_path):
        f = tmp_path / "bom.log"
        f.write_bytes(b"\xef\xbb\xbf" + "line one\n".encode("utf-8"))
        await sk_agent.call_agent(prompt="q", source_file=str(f))
        assert "﻿" not in stub_manager.calls[0]["prompt"]

    @pytest.mark.asyncio
    async def test_invalid_bytes_replaced_not_raised(self, stub_manager, tmp_path):
        f = tmp_path / "dirty.log"
        f.write_bytes(b"good line\n\xff\xfe\nlast\n")
        raw = _parse(
            await sk_agent.call_agent(prompt="q", source_file=str(f))
        )
        assert "error" not in raw
        assert "good line" in stub_manager.calls[0]["prompt"]
        assert "last" in stub_manager.calls[0]["prompt"]

    @pytest.mark.asyncio
    async def test_truncation_cuts_marks_and_echoes(self, stub_manager, tmp_path):
        corpus = "abcdefghij" * 3  # 30 chars
        f = tmp_path / "big.log"
        f.write_text(corpus, encoding="utf-8")
        raw = _parse(
            await sk_agent.call_agent(
                prompt="q",
                source_file=str(f),
                options='{"source_max_chars": 10}',
            )
        )
        assert raw["source_file"]["truncated"] is True
        assert raw["source_file"]["chars"] == 30
        sent = stub_manager.calls[0]["prompt"]
        assert 'truncated="true"' in sent
        assert "[truncated — first 10 of 30 chars]" in sent
        # The cut content is a strict prefix of the corpus.
        assert _body_of(sent).startswith(corpus[:10])

    @pytest.mark.asyncio
    async def test_cap_popped_from_opts_before_manager(self, stub_manager, tmp_path):
        f = tmp_path / "c.log"
        f.write_text("hello", encoding="utf-8")
        await sk_agent.call_agent(
            prompt="q",
            source_file=str(f),
            options='{"source_max_chars": 500}',
        )
        # The manager must not see the wrapper-level knob.
        assert "source_max_chars" not in stub_manager.calls[0]["options"]
        # Other options still flow through untouched.
        await sk_agent.call_agent(
            prompt="q2",
            source_file=str(f),
            options='{"source_max_chars": 500, "mode": "text"}',
        )
        assert stub_manager.calls[1]["options"] == {"mode": "text"}

    @pytest.mark.asyncio
    async def test_no_source_file_parity(self, stub_manager):
        """Without the parameter the wrapper behaves exactly as before."""
        raw = _parse(await sk_agent.call_agent(prompt="plain q"))
        assert "error" not in raw
        assert "source_file" not in raw
        assert stub_manager.calls[0]["prompt"] == "plain q"

    @pytest.mark.asyncio
    async def test_default_cap_applies_without_option(self, stub_manager, tmp_path):
        corpus = "x" * (sk_agent._SOURCE_FILE_DEFAULT_MAX_CHARS + 5)
        f = tmp_path / "huge.log"
        f.write_text(corpus, encoding="utf-8")
        raw = _parse(
            await sk_agent.call_agent(prompt="q", source_file=str(f))
        )
        assert raw["source_file"]["truncated"] is True
        body = _body_of(stub_manager.calls[0]["prompt"])
        assert body.startswith("x" * sk_agent._SOURCE_FILE_DEFAULT_MAX_CHARS)
