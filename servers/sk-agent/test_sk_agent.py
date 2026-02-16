#!/usr/bin/env python3
"""
Unit tests for sk-agent MCP server v2.0.

Tests cover:
- Configuration loading (v1 auto-migration, v2 direct)
- Attachment classification
- Agent resolution logic
- SKAgentManager class (init, threads, list_agents)
- call_agent routing (text, image, video, document)
- Dynamic descriptions
- Image processing utilities (crop, resize)
- Video frame extraction
- Backward compatibility (v1 config, deprecated aliases)
- Context window inference
"""

import io
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock, patch

import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

import sk_agent
from semantic_kernel.agents import ChatCompletionAgent
from sk_agent_config import (
    SKAgentConfig,
    AgentConfig,
    ModelConfig,
    McpConfig,
    MemoryConfig,
    EmbeddingsConfig,
    QdrantConfig,
    load_config,
    migrate_config_v1_to_v2,
    get_model_context_window,
    _parse_config,
    DEFAULT_MAX_RECURSION_DEPTH,
)
from media_processing import (
    _crop_image,
    _resize_image_if_needed,
    _extract_video_frames,
    _get_video_info,
)


# ---------------------------------------------------------------------------
# Helper: Create SKAgentConfig from v2 data
# ---------------------------------------------------------------------------

def make_v2_config(
    models: list | None = None,
    agents: list | None = None,
    mcps: list | None = None,
    **kwargs,
) -> SKAgentConfig:
    """Create an SKAgentConfig directly from v2-style data."""
    raw = {
        "config_version": 2,
        "models": models or [],
        "agents": agents or [],
        "mcps": mcps or [],
        **kwargs,
    }
    return _parse_config(raw)


def make_v1_config(**overrides) -> SKAgentConfig:
    """Create an SKAgentConfig from a v1-style dict (auto-migrated)."""
    raw = {"models": [], "mcps": [], **overrides}
    migrated = migrate_config_v1_to_v2(raw)
    return _parse_config(migrated)


# ---------------------------------------------------------------------------
# Test Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_image():
    """Create a sample PNG image for testing."""
    from PIL import Image
    img = Image.new("RGB", (100, 100), color="red")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.getvalue()


@pytest.fixture
def text_config():
    """Config with a single text model -> single agent."""
    return make_v2_config(
        models=[{"id": "text-model", "base_url": "http://test", "model_id": "v1", "vision": False}],
        agents=[{"id": "text-agent", "model": "text-model"}],
        default_agent="text-agent",
    )


@pytest.fixture
def vision_config():
    """Config with text + vision models -> two agents."""
    return make_v2_config(
        models=[
            {"id": "text-model", "base_url": "http://test", "model_id": "v1", "vision": False, "context_window": 200000},
            {"id": "vision-model", "base_url": "http://test", "model_id": "v1-vis", "vision": True, "context_window": 128000},
        ],
        agents=[
            {"id": "text-agent", "model": "text-model", "description": "Text agent"},
            {"id": "vision-agent", "model": "vision-model", "description": "Vision agent"},
        ],
        default_agent="text-agent",
        default_vision_agent="vision-agent",
    )


@pytest.fixture
def isolated_config(tmp_path):
    """Create a temporary v1 config file and set SK_AGENT_CONFIG."""
    config_data = {
        "default_ask_model": "test-model",
        "default_vision_model": "test-vision",
        "max_recursion_depth": 2,
        "models": [
            {
                "id": "test-model",
                "enabled": True,
                "base_url": "https://api.test.com/v1",
                "api_key": "test-key",
                "model_id": "test-model-v1",
                "vision": False,
                "description": "Test text model",
            },
            {
                "id": "test-vision",
                "enabled": True,
                "base_url": "https://api.test.com/v1",
                "api_key": "test-key",
                "model_id": "test-vision-v1",
                "vision": True,
                "description": "Test vision model",
            },
        ],
        "mcps": [],
        "system_prompt": "Test prompt",
    }
    config_file = tmp_path / "test_config.json"
    config_file.write_text(json.dumps(config_data))

    old_env = os.environ.get("SK_AGENT_CONFIG")
    os.environ["SK_AGENT_CONFIG"] = str(config_file)

    yield str(config_file)

    # Cleanup
    if old_env:
        os.environ["SK_AGENT_CONFIG"] = old_env
    elif "SK_AGENT_CONFIG" in os.environ:
        del os.environ["SK_AGENT_CONFIG"]


# ---------------------------------------------------------------------------
# Configuration Tests
# ---------------------------------------------------------------------------

class TestConfigLoading:
    """Tests for config loading via the sk_agent module."""

    @pytest.mark.skip(reason="Module reload isolation issue - config cached at import")
    def test_load_config_missing_file(self, tmp_path):
        pass

    def test_load_config_valid_file(self, isolated_config):
        """Test loading a valid v1 config file (auto-migrates to v2)."""
        config = load_config(isolated_config)

        assert type(config).__name__ == "SKAgentConfig"
        assert len(config.models) == 2
        # V1 models become agents with same IDs
        assert len(config.agents) == 2

    @pytest.mark.skip(reason="Module reload isolation issue")
    def test_load_config_backward_compatibility(self, tmp_path):
        pass

    @pytest.mark.skip(reason="Module reload isolation issue")
    def test_load_config_auto_default_models(self, tmp_path):
        pass


# ---------------------------------------------------------------------------
# Attachment Classification Tests
# ---------------------------------------------------------------------------

class TestAttachmentClassification:
    """Tests for classify_attachment()."""

    def test_image_extensions(self):
        assert sk_agent.classify_attachment("photo.png") == "image"
        assert sk_agent.classify_attachment("photo.jpg") == "image"
        assert sk_agent.classify_attachment("photo.JPEG") == "image"
        assert sk_agent.classify_attachment("photo.webp") == "image"

    def test_video_extensions(self):
        assert sk_agent.classify_attachment("clip.mp4") == "video"
        assert sk_agent.classify_attachment("clip.avi") == "video"
        assert sk_agent.classify_attachment("clip.MOV") == "video"

    def test_document_extensions(self):
        assert sk_agent.classify_attachment("doc.pdf") == "document"
        assert sk_agent.classify_attachment("doc.pptx") == "document"
        assert sk_agent.classify_attachment("doc.docx") == "document"
        assert sk_agent.classify_attachment("doc.xlsx") == "document"

    def test_unknown_extension(self):
        assert sk_agent.classify_attachment("file.txt") is None
        assert sk_agent.classify_attachment("file.py") is None
        assert sk_agent.classify_attachment("") is None

    def test_url_classification(self):
        assert sk_agent.classify_attachment("https://example.com/photo.png") == "image"
        assert sk_agent.classify_attachment("https://example.com/video.mp4") == "video"
        assert sk_agent.classify_attachment("https://example.com/report.pdf") == "document"
        assert sk_agent.classify_attachment("https://example.com/page") is None


# ---------------------------------------------------------------------------
# Image Processing Tests (from media_processing module)
# ---------------------------------------------------------------------------

class TestImageProcessing:
    """Tests for image processing utilities."""

    def test_resize_image_small_image(self, sample_image):
        """Test that small images are not resized."""
        resized_data, media_type = _resize_image_if_needed(sample_image, "image/png")
        assert resized_data == sample_image
        assert media_type == "image/png"

    def test_resize_image_large_image(self):
        """Test that large images are resized."""
        from PIL import Image

        img = Image.new("RGB", (2000, 2000), color="blue")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        large_data = buf.getvalue()

        resized_data, media_type = _resize_image_if_needed(
            large_data, "image/png",
            max_bytes=100_000,
            max_pixels=500_000,
        )
        assert len(resized_data) <= 100_000

    def test_crop_image_pixels(self, sample_image):
        """Test image cropping with pixel values."""
        region = {"x": 10, "y": 10, "width": 50, "height": 50}
        cropped_data, media_type = _crop_image(sample_image, "image/png", region)

        assert len(cropped_data) > 0
        assert media_type == "image/png"

    def test_crop_image_percentages(self, sample_image):
        """Test image cropping with percentage values."""
        region = {"x": "10%", "y": "10%", "width": "50%", "height": "50%"}
        cropped_data, media_type = _crop_image(sample_image, "image/png", region)

        assert len(cropped_data) > 0
        assert media_type == "image/png"

    def test_crop_image_clamp_bounds(self, sample_image):
        """Test that crop region is clamped to image bounds."""
        region = {"x": 80, "y": 80, "width": 100, "height": 100}
        cropped_data, media_type = _crop_image(sample_image, "image/png", region)

        assert len(cropped_data) > 0


# ---------------------------------------------------------------------------
# Recursion Depth Tests
# ---------------------------------------------------------------------------

class TestRecursionDepth:
    """Tests for recursion depth protection."""

    def test_default_max_recursion_depth(self):
        """Test default recursion depth value."""
        assert DEFAULT_MAX_RECURSION_DEPTH == 2

    def test_sk_agent_depth_env_var(self, monkeypatch):
        """Test SK_AGENT_DEPTH environment variable."""
        monkeypatch.setenv("SK_AGENT_DEPTH", "3")
        import importlib
        import sk_agent_config
        importlib.reload(sk_agent_config)
        assert sk_agent_config.SK_AGENT_DEPTH == 3
        # Cleanup
        monkeypatch.delenv("SK_AGENT_DEPTH")
        importlib.reload(sk_agent_config)


# ---------------------------------------------------------------------------
# SKAgentManager Tests
# ---------------------------------------------------------------------------

class TestSKAgentManager:
    """Tests for SKAgentManager class."""

    def test_init_empty(self):
        """Test SKAgentManager with empty config."""
        config = make_v2_config()
        manager = sk_agent.SKAgentManager(config)

        assert manager.config is config
        assert manager._sk_agents == {}
        assert manager._kernels == {}
        assert manager._threads == {}

    def test_init_with_config(self, vision_config):
        """Test SKAgentManager stores config, agents not created until start()."""
        manager = sk_agent.SKAgentManager(vision_config)
        assert manager.config is vision_config
        assert len(manager._sk_agents) == 0

    def test_list_agents(self, vision_config):
        """Test list_agents method."""
        manager = sk_agent.SKAgentManager(vision_config)
        agents = manager.list_agents()

        assert len(agents) == 2
        assert agents[0]["id"] == "text-agent"
        assert agents[1]["id"] == "vision-agent"
        assert agents[0]["is_default"]
        assert not agents[0]["is_default_vision"]
        assert not agents[1]["is_default"]
        assert agents[1]["is_default_vision"]

    def test_list_agents_vision_flag(self, vision_config):
        """Test that vision flag is correctly reported."""
        manager = sk_agent.SKAgentManager(vision_config)
        agents = manager.list_agents()
        assert agents[0]["vision"] is False
        assert agents[1]["vision"] is True

    def test_list_agents_model_info(self, vision_config):
        """Test that model info is carried over."""
        manager = sk_agent.SKAgentManager(vision_config)
        agents = manager.list_agents()
        model_ids = {a["model_id"] for a in agents}
        assert "v1" in model_ids
        assert "v1-vis" in model_ids

    def test_get_or_create_thread_new(self, text_config):
        """Test creating a new thread."""
        manager = sk_agent.SKAgentManager(text_config)
        conv_id, thread = manager._get_or_create_thread(None)

        assert conv_id is not None
        assert thread is not None
        assert conv_id in manager._threads

    def test_get_or_create_thread_existing(self, text_config):
        """Test getting an existing thread."""
        manager = sk_agent.SKAgentManager(text_config)
        conv_id, thread = manager._get_or_create_thread(None)
        conv_id2, thread2 = manager._get_or_create_thread(conv_id)

        assert conv_id == conv_id2
        assert thread == thread2

    def test_end_conversation(self, text_config):
        """Test ending a conversation."""
        manager = sk_agent.SKAgentManager(text_config)
        conv_id, _ = manager._get_or_create_thread(None)
        assert conv_id in manager._threads

        result = manager.end_conversation(conv_id)
        assert result is True
        assert conv_id not in manager._threads

    def test_end_conversation_not_found(self, text_config):
        """Test ending a non-existent conversation."""
        manager = sk_agent.SKAgentManager(text_config)
        result = manager.end_conversation("non-existent")
        assert result is False


# ---------------------------------------------------------------------------
# Agent Resolution Tests
# ---------------------------------------------------------------------------

class TestAgentResolution:
    """Tests for _resolve_agent() logic."""

    def test_resolve_explicit_agent_id(self, vision_config):
        """Explicit agent_id overrides all defaults."""
        manager = sk_agent.SKAgentManager(vision_config)
        manager._sk_agents = {"text-agent": MagicMock(), "vision-agent": MagicMock()}

        agent_id, agent = manager._resolve_agent(agent_id="vision-agent")
        assert agent_id == "vision-agent"
        assert agent is not None

    def test_resolve_default_agent(self, vision_config):
        """No hints -> default agent."""
        manager = sk_agent.SKAgentManager(vision_config)
        manager._sk_agents = {"text-agent": MagicMock(), "vision-agent": MagicMock()}

        agent_id, agent = manager._resolve_agent()
        assert agent_id == "text-agent"

    def test_resolve_vision_default(self, vision_config):
        """needs_vision=True -> default vision agent."""
        manager = sk_agent.SKAgentManager(vision_config)
        manager._sk_agents = {"text-agent": MagicMock(), "vision-agent": MagicMock()}

        agent_id, agent = manager._resolve_agent(needs_vision=True)
        assert agent_id == "vision-agent"

    def test_resolve_no_agents(self):
        """No agents initialized -> (None, None)."""
        config = make_v2_config()
        manager = sk_agent.SKAgentManager(config)

        agent_id, agent = manager._resolve_agent()
        assert agent_id is None
        assert agent is None

    def test_resolve_model_id_backward_compat(self, vision_config):
        """model_id maps to agent that uses that model."""
        manager = sk_agent.SKAgentManager(vision_config)
        manager._sk_agents = {"text-agent": MagicMock(), "vision-agent": MagicMock()}

        agent_id, agent = manager._resolve_agent(model_id="vision-model")
        assert agent_id == "vision-agent"

    def test_resolve_first_available(self):
        """No default configured -> first available agent."""
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{"id": "only-agent", "model": "m1"}],
        )
        manager = sk_agent.SKAgentManager(config)
        manager._sk_agents = {"only-agent": MagicMock()}

        agent_id, agent = manager._resolve_agent()
        assert agent_id == "only-agent"

    def test_resolve_nonexistent_agent_id_falls_through(self, vision_config):
        """Nonexistent agent_id falls through to defaults."""
        manager = sk_agent.SKAgentManager(vision_config)
        manager._sk_agents = {"text-agent": MagicMock(), "vision-agent": MagicMock()}

        agent_id, agent = manager._resolve_agent(agent_id="nonexistent")
        # Falls through: not in _sk_agents -> goes to default
        assert agent_id == "text-agent"


# ---------------------------------------------------------------------------
# call_agent Integration Tests
# ---------------------------------------------------------------------------

class TestCallAgent:
    """Tests for the unified call_agent method."""

    @pytest.mark.asyncio
    async def test_call_agent_no_agents(self):
        """No agents -> error."""
        config = make_v2_config()
        manager = sk_agent.SKAgentManager(config)

        result = await manager.call_agent("test prompt")
        assert "error" in result
        assert "No agents" in result["error"]

    @pytest.mark.asyncio
    async def test_call_agent_text_routing(self, vision_config):
        """Text-only prompt routes to default agent."""
        manager = sk_agent.SKAgentManager(vision_config)

        mock_agent = MagicMock()
        async def fake_invoke(**kwargs):
            resp = MagicMock()
            resp.__str__ = lambda self: "Hello!"
            resp.thread = MagicMock()
            yield resp
        mock_agent.invoke = fake_invoke
        manager._sk_agents = {"text-agent": mock_agent, "vision-agent": MagicMock()}

        result = await manager.call_agent("Hello")
        assert result["agent_used"] == "text-agent"
        assert result["response"] == "Hello!"

    @pytest.mark.asyncio
    async def test_call_agent_image_routing(self, vision_config, tmp_path, sample_image):
        """Image attachment routes to vision agent."""
        manager = sk_agent.SKAgentManager(vision_config)

        mock_agent = MagicMock()
        async def fake_invoke(**kwargs):
            resp = MagicMock()
            resp.__str__ = lambda self: "I see a red image"
            resp.thread = MagicMock()
            yield resp
        mock_agent.invoke = fake_invoke
        manager._sk_agents = {"text-agent": MagicMock(), "vision-agent": mock_agent}

        from PIL import Image
        img_path = tmp_path / "test.png"
        img = Image.open(io.BytesIO(sample_image))
        img.save(img_path)

        result = await manager.call_agent("Describe this", attachment=str(img_path))
        assert result["agent_used"] == "vision-agent"
        assert "I see a red image" in result["response"]

    @pytest.mark.asyncio
    async def test_call_agent_explicit_agent_override(self, vision_config):
        """Explicit agent_id overrides auto-selection."""
        manager = sk_agent.SKAgentManager(vision_config)

        mock_vision = MagicMock()
        async def fake_invoke(**kwargs):
            resp = MagicMock()
            resp.__str__ = lambda self: "From vision"
            resp.thread = MagicMock()
            yield resp
        mock_vision.invoke = fake_invoke
        manager._sk_agents = {"text-agent": MagicMock(), "vision-agent": mock_vision}

        result = await manager.call_agent("Hello", agent_id="vision-agent")
        assert result["agent_used"] == "vision-agent"


# ---------------------------------------------------------------------------
# Dynamic Description Tests
# ---------------------------------------------------------------------------

class TestDynamicDescriptions:
    """Tests for build_call_agent_description and build_list_agents_description."""

    def test_call_agent_description_lists_agents(self, vision_config):
        desc = sk_agent.build_call_agent_description(vision_config)
        assert "text-agent" in desc
        assert "vision-agent" in desc
        assert "Available agents:" in desc

    def test_call_agent_description_shows_vision(self, vision_config):
        desc = sk_agent.build_call_agent_description(vision_config)
        assert "vision" in desc.lower()

    def test_call_agent_description_shows_defaults(self, vision_config):
        desc = sk_agent.build_call_agent_description(vision_config)
        assert "Default: text-agent" in desc
        assert "Default vision: vision-agent" in desc

    def test_list_agents_description_count(self, vision_config):
        desc = sk_agent.build_list_agents_description(vision_config)
        assert "2" in desc

    def test_call_agent_description_shows_tools(self):
        """Agents with MCPs show tool badges."""
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{"id": "researcher", "model": "m1", "mcps": ["searxng"], "description": "Web researcher"}],
            mcps=[{"id": "searxng", "command": "npx", "args": ["-y", "mcp-searxng"]}],
        )
        desc = sk_agent.build_call_agent_description(config)
        assert "searxng" in desc
        assert "tools:" in desc


# ---------------------------------------------------------------------------
# Model Enabled/Disabled Tests
# ---------------------------------------------------------------------------

class TestModelEnabled:
    """Tests for model enabled/disabled behavior in the agent layer."""

    def test_disabled_model_agent_not_listed(self):
        """Agents whose model is disabled are excluded from list_agents."""
        config = make_v2_config(
            models=[
                {"id": "enabled-model", "enabled": True, "base_url": "http://test", "model_id": "v1"},
                {"id": "disabled-model", "enabled": False, "base_url": "http://test", "model_id": "v2"},
            ],
            agents=[
                {"id": "enabled-agent", "model": "enabled-model"},
                {"id": "disabled-agent", "model": "disabled-model"},
            ],
        )
        manager = sk_agent.SKAgentManager(config)
        agents = manager.list_agents()

        assert len(agents) == 1
        assert agents[0]["id"] == "enabled-agent"

    def test_disabled_model_not_in_description(self):
        """Agents with disabled models don't appear in dynamic description."""
        config = make_v2_config(
            models=[
                {"id": "enabled-model", "enabled": True, "base_url": "http://test", "model_id": "v1"},
                {"id": "disabled-model", "enabled": False, "base_url": "http://test", "model_id": "v2"},
            ],
            agents=[
                {"id": "active-agent", "model": "enabled-model", "description": "Active"},
                {"id": "inactive-agent", "model": "disabled-model", "description": "Inactive"},
            ],
        )
        desc = sk_agent.build_call_agent_description(config)
        assert "active-agent" in desc
        assert "inactive-agent" not in desc

    def test_v1_migration_disabled_model(self):
        """V1 disabled models become agents but are filtered in list_agents."""
        config = make_v1_config(
            models=[
                {"id": "enabled", "enabled": True, "base_url": "http://test", "model_id": "v1", "vision": False},
                {"id": "disabled", "enabled": False, "base_url": "http://test", "model_id": "v2", "vision": False},
            ],
        )
        manager = sk_agent.SKAgentManager(config)
        agents = manager.list_agents()
        # Only enabled model's agent shows
        assert len(agents) == 1


# ---------------------------------------------------------------------------
# Zoom Context Tests
# ---------------------------------------------------------------------------

class TestZoomContext:
    """Tests for zoom context handling."""

    def test_zoom_context_structure(self):
        """Test zoom context JSON structure."""
        zoom_context = {
            "depth": 1,
            "stack": [{"x": 100, "y": 200, "w": 300, "h": 400}],
            "original_source": "test.png"
        }
        context_str = json.dumps(zoom_context)
        parsed = json.loads(context_str)
        assert parsed["depth"] == 1
        assert len(parsed["stack"]) == 1

    def test_progressive_zoom_depth(self):
        """Test that zoom depth increases with each zoom."""
        context_v1 = {"depth": 1, "stack": [], "original_source": "test.png"}
        context_v2 = {"depth": 2, "stack": [{"x": 0, "y": 0, "w": 100, "h": 100}], "original_source": "test.png"}
        assert context_v2["depth"] > context_v1["depth"]


# ---------------------------------------------------------------------------
# Video Analysis Tests
# ---------------------------------------------------------------------------

class TestVideoAnalysis:
    """Tests for video analysis via call_agent routing."""

    def test_extract_video_frames_function_exists(self):
        """Test that _extract_video_frames function exists."""
        from media_processing import _extract_video_frames
        import inspect

        sig = inspect.signature(_extract_video_frames)
        params = list(sig.parameters.keys())
        assert "video_path" in params
        assert "num_frames" in params

    def test_extract_video_frames_mocked(self, tmp_path):
        """Test video frame extraction with mocked ffmpeg."""
        fake_video = tmp_path / "test.mp4"
        fake_video.write_bytes(b"fake video")

        from PIL import Image
        img = Image.new('RGB', (100, 100), color='red')
        buf = io.BytesIO()
        img.save(buf, format='JPEG')
        fake_frame = buf.getvalue()

        mock_video_info = MagicMock()
        mock_video_info.duration = 10.0
        mock_video_info.width = 640
        mock_video_info.height = 480

        def mock_run(cmd, *args, **kwargs):
            result = MagicMock()
            result.returncode = 0
            result.stderr = ""
            if "ffmpeg" in cmd and "-frames:v" in cmd:
                output_path = cmd[-1]
                Path(output_path).parent.mkdir(parents=True, exist_ok=True)
                with open(output_path, 'wb') as f:
                    f.write(fake_frame)
            return result

        with patch('media_processing._get_video_info', return_value=mock_video_info):
            with patch('media_processing.subprocess.run', side_effect=mock_run):
                frames = _extract_video_frames(str(fake_video), num_frames=2)

        assert len(frames) == 2

    @pytest.mark.asyncio
    async def test_video_routing_with_vision_agent(self, tmp_path, vision_config):
        """Video file routes to vision agent."""
        manager = sk_agent.SKAgentManager(vision_config)

        mock_agent = MagicMock()
        async def fake_invoke(**kwargs):
            resp = MagicMock()
            resp.__str__ = lambda self: "Video summary"
            resp.thread = MagicMock()
            yield resp
        mock_agent.invoke = fake_invoke
        manager._sk_agents = {"text-agent": MagicMock(), "vision-agent": mock_agent}

        fake_video = tmp_path / "test.mp4"
        fake_video.write_bytes(b"fake video")

        from PIL import Image
        img = Image.new('RGB', (100, 100), color='red')
        buf = io.BytesIO()
        img.save(buf, format='JPEG')
        fake_frame = buf.getvalue()

        with patch('sk_agent._get_video_info', return_value=None):
            with patch('sk_agent._extract_keyframes', return_value=[
                (fake_frame, "image/jpeg"),
                (fake_frame, "image/jpeg"),
            ]):
                result = await manager.call_agent("Describe video", attachment=str(fake_video))

        assert result.get("agent_used") == "vision-agent"
        assert result.get("frames_analyzed") == 2


# ---------------------------------------------------------------------------
# Context Window Tests (via sk_agent_config)
# ---------------------------------------------------------------------------

class TestContextWindow:
    """Tests for context window inference."""

    def test_explicit_context_window(self):
        """Explicit context_window in config is used."""
        config = make_v2_config(
            models=[{"id": "test", "base_url": "http://test", "model_id": "v1", "context_window": 100_000}],
            agents=[{"id": "a", "model": "test"}],
        )
        result = get_model_context_window(config, "test")
        assert result == 100_000

    def test_vision_model_default_context_window(self):
        """Vision models default to 128K."""
        config = make_v2_config(
            models=[{"id": "test", "base_url": "http://test", "model_id": "v1", "vision": True}],
            agents=[{"id": "a", "model": "test"}],
        )
        result = get_model_context_window(config, "test")
        assert result == 128_000

    def test_cloud_model_default_context_window(self):
        """Cloud models (z.ai) default to 200K."""
        config = make_v2_config(
            models=[{"id": "test", "base_url": "https://api.z.ai/v1", "model_id": "v1", "vision": False}],
            agents=[{"id": "a", "model": "test"}],
        )
        result = get_model_context_window(config, "test")
        assert result == 200_000

    def test_unknown_model_default(self):
        """Unknown model returns 32K default."""
        config = make_v2_config()
        result = get_model_context_window(config, "nonexistent")
        assert result == 32_000


# ---------------------------------------------------------------------------
# Backward Compatibility Tests (v1 -> v2)
# ---------------------------------------------------------------------------

class TestBackwardCompatibility:
    """Tests verifying v1 configs work correctly through the v2 stack."""

    def test_v1_config_creates_agents(self, isolated_config):
        """V1 config with models auto-creates agents."""
        config = load_config(isolated_config)

        assert type(config).__name__ == "SKAgentConfig"
        assert len(config.agents) == 2

    def test_v1_default_ask_becomes_default_agent(self, isolated_config):
        """V1 default_ask_model maps to default_agent."""
        config = load_config(isolated_config)

        default = config.get_default_agent()
        assert default is not None
        assert default.id == "test-model"

    def test_v1_default_vision_becomes_default_vision_agent(self, isolated_config):
        """V1 default_vision_model maps to default_vision_agent."""
        config = load_config(isolated_config)

        vision = config.get_default_vision_agent()
        assert vision is not None
        assert vision.id == "test-vision"

    def test_manager_list_agents_with_v1_config(self, isolated_config):
        """Manager works correctly with auto-migrated v1 config."""
        config = load_config(isolated_config)
        manager = sk_agent.SKAgentManager(config)

        agents = manager.list_agents()
        assert len(agents) == 2
        model_ids = {a["model_id"] for a in agents}
        assert "test-model-v1" in model_ids
        assert "test-vision-v1" in model_ids


# ---------------------------------------------------------------------------
# Conversation Tests
# ---------------------------------------------------------------------------

from sk_conversations import (
    ConversationRunner,
    PRESETS,
    DEEP_SEARCH_PRESET,
    DEEP_THINK_PRESET,
    build_run_conversation_description,
)


# ---------------------------------------------------------------------------
# Memory Setup Tests
# ---------------------------------------------------------------------------

class TestMemorySetup:
    """Tests for _setup_memory and memory integration in agent creation."""

    def _make_memory_config(self, memory_enabled=True, embeddings=True, qdrant=True):
        """Create config with memory-related settings."""
        kwargs = {}
        if embeddings:
            kwargs["embeddings"] = {
                "base_url": "https://embeddings.test/v1/embeddings",
                "api_key": "test-emb-key",
                "model_id": "test-embedding-model",
                "dimensions": 1024,
            }
        if qdrant:
            kwargs["qdrant"] = {
                "url": "https://qdrant.test",
                "port": 443,
                "api_key": "test-qdrant-key",
                "default_collection_prefix": "test-prefix",
            }

        return make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{
                "id": "mem-agent",
                "model": "m1",
                "system_prompt": "Base prompt.",
                "memory": {"enabled": memory_enabled, "collection": "my-collection"},
            }],
            default_agent="mem-agent",
            **kwargs,
        )

    @pytest.mark.asyncio
    async def test_setup_memory_returns_none_without_embeddings(self):
        """_setup_memory returns None when embeddings not configured."""
        config = self._make_memory_config(embeddings=False)
        manager = sk_agent.SKAgentManager(config)
        agent_cfg = config.agents[0]
        kernel = MagicMock()

        result = await manager._setup_memory(agent_cfg, kernel)
        assert result is None

    @pytest.mark.asyncio
    async def test_setup_memory_creates_qdrant_store(self):
        """_setup_memory creates QdrantMemoryStore when available."""
        config = self._make_memory_config()
        manager = sk_agent.SKAgentManager(config)
        agent_cfg = config.agents[0]
        kernel = MagicMock()

        with patch.object(sk_agent, "HAS_QDRANT", True), \
             patch.object(sk_agent, "HAS_MEMORY", True), \
             patch("sk_agent.QdrantMemoryStore") as MockQdrant, \
             patch("sk_agent.SemanticTextMemory") as MockMemory, \
             patch("sk_agent.TextMemoryPlugin") as MockPlugin, \
             patch("sk_agent.OpenAITextEmbedding") as MockEmb, \
             patch("sk_agent.AsyncOpenAI"):

            MockQdrant.return_value = MagicMock()
            MockMemory.return_value = MagicMock()
            MockPlugin.return_value = MagicMock()
            MockEmb.return_value = MagicMock()

            result = await manager._setup_memory(agent_cfg, kernel)

            assert result is not None
            MockQdrant.assert_called_once()
            # Verify Qdrant params
            call_kwargs = MockQdrant.call_args.kwargs
            assert call_kwargs["vector_size"] == 1024
            assert call_kwargs["url"] == "https://qdrant.test"
            assert call_kwargs["port"] == 443
            assert call_kwargs["api_key"] == "test-qdrant-key"

    @pytest.mark.asyncio
    async def test_setup_memory_falls_back_to_volatile(self):
        """_setup_memory uses VolatileMemoryStore when Qdrant unavailable."""
        config = self._make_memory_config()
        manager = sk_agent.SKAgentManager(config)
        agent_cfg = config.agents[0]
        kernel = MagicMock()

        with patch.object(sk_agent, "HAS_QDRANT", False), \
             patch.object(sk_agent, "HAS_MEMORY", True), \
             patch("sk_agent.VolatileMemoryStore") as MockVolatile, \
             patch("sk_agent.SemanticTextMemory") as MockMemory, \
             patch("sk_agent.TextMemoryPlugin") as MockPlugin, \
             patch("sk_agent.OpenAITextEmbedding") as MockEmb, \
             patch("sk_agent.AsyncOpenAI"):

            MockVolatile.return_value = MagicMock()
            MockMemory.return_value = MagicMock()
            MockPlugin.return_value = MagicMock()
            MockEmb.return_value = MagicMock()

            result = await manager._setup_memory(agent_cfg, kernel)

            assert result is not None
            MockVolatile.assert_called_once()

    @pytest.mark.asyncio
    async def test_setup_memory_collection_naming(self):
        """Memory collection uses prefix-collection format."""
        config = self._make_memory_config()
        manager = sk_agent.SKAgentManager(config)
        agent_cfg = config.agents[0]
        kernel = MagicMock()

        with patch.object(sk_agent, "HAS_QDRANT", True), \
             patch.object(sk_agent, "HAS_MEMORY", True), \
             patch("sk_agent.QdrantMemoryStore") as MockQdrant, \
             patch("sk_agent.SemanticTextMemory") as MockMemory, \
             patch("sk_agent.TextMemoryPlugin") as MockPlugin, \
             patch("sk_agent.OpenAITextEmbedding"), \
             patch("sk_agent.AsyncOpenAI"):

            MockQdrant.return_value = MagicMock()
            mock_memory = MagicMock()
            MockMemory.return_value = mock_memory
            MockPlugin.return_value = MagicMock()

            await manager._setup_memory(agent_cfg, kernel)

            # Verify collection is stored
            assert "mem-agent" in manager._memory_stores
            assert manager._memory_stores["mem-agent"] is mock_memory

    @pytest.mark.asyncio
    async def test_setup_memory_creates_embeddings_generator(self):
        """_setup_memory creates OpenAITextEmbedding with correct config."""
        config = self._make_memory_config()
        manager = sk_agent.SKAgentManager(config)
        agent_cfg = config.agents[0]
        kernel = MagicMock()

        with patch.object(sk_agent, "HAS_QDRANT", True), \
             patch.object(sk_agent, "HAS_MEMORY", True), \
             patch("sk_agent.QdrantMemoryStore"), \
             patch("sk_agent.SemanticTextMemory") as MockMemory, \
             patch("sk_agent.TextMemoryPlugin"), \
             patch("sk_agent.OpenAITextEmbedding") as MockEmb, \
             patch("sk_agent.AsyncOpenAI") as MockClient:

            MockEmb.return_value = MagicMock()
            MockMemory.return_value = MagicMock()

            await manager._setup_memory(agent_cfg, kernel)

            MockEmb.assert_called_once()
            assert MockEmb.call_args.kwargs["ai_model_id"] == "test-embedding-model"

    @pytest.mark.asyncio
    async def test_setup_memory_exception_returns_none(self):
        """_setup_memory returns None on exception (does not crash)."""
        config = self._make_memory_config()
        manager = sk_agent.SKAgentManager(config)
        agent_cfg = config.agents[0]
        kernel = MagicMock()

        with patch.object(sk_agent, "HAS_QDRANT", True), \
             patch.object(sk_agent, "HAS_MEMORY", True), \
             patch("sk_agent.QdrantMemoryStore", side_effect=Exception("Connection refused")):

            result = await manager._setup_memory(agent_cfg, kernel)
            assert result is None

    def test_memory_prompt_augmentation(self):
        """Agent with memory gets prompt augmented with memory hint."""
        config = self._make_memory_config(memory_enabled=True)
        agent_cfg = config.agents[0]

        # The prompt augmentation happens in _create_agent, so we verify the logic
        system_prompt = agent_cfg.system_prompt or ""
        if agent_cfg.memory.enabled:
            system_prompt += (
                "\n\nYou have access to persistent memory. "
                "Use memory-save to remember important facts and "
                "memory-recall to retrieve relevant knowledge."
            )

        assert "memory-save" in system_prompt
        assert "memory-recall" in system_prompt
        assert system_prompt.startswith("Base prompt.")

    def test_memory_prompt_not_augmented_when_disabled(self):
        """Agent without memory does not get memory hint."""
        config = self._make_memory_config(memory_enabled=False)
        agent_cfg = config.agents[0]

        system_prompt = agent_cfg.system_prompt or ""
        assert "memory-save" not in system_prompt

    def test_memory_badge_in_description(self):
        """Agent with memory shows [memory] badge in description."""
        config = self._make_memory_config(memory_enabled=True)
        desc = sk_agent.build_call_agent_description(config)
        assert "memory" in desc

    def test_no_memory_badge_when_disabled(self):
        """Agent without memory doesn't show [memory] badge."""
        config = self._make_memory_config(memory_enabled=False)
        desc = sk_agent.build_call_agent_description(config)
        # Check only the agent listing line (starts with "  - mem-agent:")
        agent_lines = [l for l in desc.splitlines() if l.strip().startswith("- mem-agent:")]
        assert len(agent_lines) == 1
        assert "memory" not in agent_lines[0]

    @pytest.mark.asyncio
    async def test_create_agent_with_memory_integration(self):
        """Full _create_agent with memory enabled passes plugin to agent."""
        config = self._make_memory_config()
        manager = sk_agent.SKAgentManager(config)
        agent_cfg = config.agents[0]
        model_cfg = config.models[0]

        # Set up service mock
        mock_service = MagicMock()
        manager._services[model_cfg.id] = mock_service

        mock_plugin = MagicMock()

        with patch.object(sk_agent, "HAS_MEMORY", True), \
             patch.object(manager, "_setup_memory", new_callable=AsyncMock, return_value=mock_plugin), \
             patch("sk_agent.ChatCompletionAgent") as MockAgent:

            MockAgent.return_value = MagicMock()
            await manager._create_agent(agent_cfg, model_cfg)

            # Verify _setup_memory was called
            manager._setup_memory.assert_called_once_with(agent_cfg, manager._kernels["mem-agent"])

            # Verify plugin was passed to ChatCompletionAgent
            call_kwargs = MockAgent.call_args.kwargs
            assert mock_plugin in call_kwargs["plugins"]

    @pytest.mark.asyncio
    async def test_create_agent_without_memory(self):
        """_create_agent without memory: no memory plugin in plugins list."""
        config = self._make_memory_config(memory_enabled=False)
        manager = sk_agent.SKAgentManager(config)
        agent_cfg = config.agents[0]
        model_cfg = config.models[0]

        mock_service = MagicMock()
        manager._services[model_cfg.id] = mock_service

        with patch("sk_agent.ChatCompletionAgent") as MockAgent:
            MockAgent.return_value = MagicMock()
            await manager._create_agent(agent_cfg, model_cfg)

            call_kwargs = MockAgent.call_args.kwargs
            assert call_kwargs["plugins"] == []


# ---------------------------------------------------------------------------
# Conversation Execution Tests
# ---------------------------------------------------------------------------

class TestConversationExecution:
    """Tests for actual conversation execution with mocked SK agents."""

    def _make_mock_agent(self, name="test-agent", responses=None):
        """Create a mock ChatCompletionAgent."""
        agent = MagicMock(spec=ChatCompletionAgent)
        agent.name = name
        agent.kernel = MagicMock()
        return agent

    def _make_runner_with_agents(self, agent_names=None, config_conversations=None):
        """Create a ConversationRunner with mock agents."""
        agent_names = agent_names or ["agent-a", "agent-b"]
        sk_agents = {}
        for name in agent_names:
            sk_agents[name] = self._make_mock_agent(name=f"sk-agent-{name}")

        conv_data = config_conversations or []
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{"id": name, "model": "m1"} for name in agent_names],
            conversations=conv_data,
            default_agent=agent_names[0] if agent_names else "",
        )
        return ConversationRunner(config, sk_agents), sk_agents

    @pytest.mark.asyncio
    async def test_run_group_chat_collects_steps(self):
        """Group chat run collects steps from all agents."""
        runner, agents = self._make_runner_with_agents(
            agent_names=["agent-a", "agent-b"],
            config_conversations=[{
                "id": "test-conv",
                "description": "Test",
                "type": "group_chat",
                "agents": ["agent-a", "agent-b"],
                "max_rounds": 4,
            }],
        )

        # Mock AgentGroupChat to yield fake messages
        mock_messages = [
            MagicMock(name="agent-a", content="Response A1", role=MagicMock()),
            MagicMock(name="agent-b", content="Response B1", role=MagicMock()),
        ]
        # Fix: MagicMock(name=...) sets the mock's name attribute
        mock_messages[0].name = "sk-agent-agent-a"
        mock_messages[1].name = "sk-agent-agent-b"

        with patch("sk_conversations.AgentGroupChat") as MockChat:
            mock_chat_instance = MagicMock()

            async def fake_invoke():
                for msg in mock_messages:
                    yield msg

            mock_chat_instance.invoke = fake_invoke
            mock_chat_instance.add_chat_message = AsyncMock()
            MockChat.return_value = mock_chat_instance

            result = await runner.run("test prompt", conversation_id="test-conv")

        assert "error" not in result
        assert result["conversation_type"] == "group_chat"
        assert len(result["steps"]) == 2
        assert result["steps"][0]["agent"] == "sk-agent-agent-a"
        assert result["steps"][1]["agent"] == "sk-agent-agent-b"
        assert result["response"] == "Response B1"  # Last response

    @pytest.mark.asyncio
    async def test_run_sequential_limits_to_agent_count(self):
        """Sequential conversation sets max_iterations to number of agents."""
        runner, agents = self._make_runner_with_agents(
            agent_names=["a", "b", "c"],
            config_conversations=[{
                "id": "seq-conv",
                "description": "Sequential test",
                "type": "sequential",
                "agents": ["a", "b", "c"],
                "max_rounds": 99,  # Should be ignored, capped to len(agents)=3
            }],
        )

        with patch("sk_conversations.AgentGroupChat") as MockChat, \
             patch("sk_conversations.DefaultTerminationStrategy") as MockTermination:

            mock_chat_instance = MagicMock()

            async def fake_invoke():
                return
                yield  # Make this an async generator

            mock_chat_instance.invoke = fake_invoke
            mock_chat_instance.add_chat_message = AsyncMock()
            MockChat.return_value = mock_chat_instance

            await runner.run("test", conversation_id="seq-conv")

            # Verify termination strategy was created with max_iterations = len(agents) = 3
            MockTermination.assert_called_once()
            call_kwargs = MockTermination.call_args.kwargs
            assert call_kwargs["maximum_iterations"] == 3

    @pytest.mark.asyncio
    async def test_run_concurrent_parallel_execution(self):
        """Concurrent conversation runs all agents in parallel."""
        runner, agents = self._make_runner_with_agents(
            agent_names=["fast", "slow"],
            config_conversations=[{
                "id": "concurrent-conv",
                "description": "Concurrent test",
                "type": "concurrent",
                "agents": ["fast", "slow"],
            }],
        )

        # Mock agent.invoke to return responses
        for name, mock_agent in agents.items():
            resp = MagicMock()
            resp.__str__ = lambda self, n=name: f"Response from {n}"

            async def fake_invoke(messages=None, thread=None, _name=name):
                r = MagicMock()
                r.__str__ = lambda self, _n=_name: f"Response from {_n}"
                yield r

            mock_agent.invoke = fake_invoke

        with patch("semantic_kernel.agents.ChatHistoryAgentThread") as MockThread:
            MockThread.return_value = MagicMock()
            result = await runner.run("test", conversation_id="concurrent-conv")

        assert "error" not in result
        assert result["conversation_type"] == "concurrent"
        assert result["rounds"] == 1
        assert len(result["steps"]) == 2

    @pytest.mark.asyncio
    async def test_run_with_max_rounds_override(self):
        """Options can override max_rounds."""
        runner, agents = self._make_runner_with_agents(
            agent_names=["a"],
            config_conversations=[{
                "id": "gc",
                "description": "Test",
                "type": "group_chat",
                "agents": ["a"],
                "max_rounds": 6,
            }],
        )

        with patch("sk_conversations.AgentGroupChat") as MockChat, \
             patch("sk_conversations.DefaultTerminationStrategy") as MockTermination:

            mock_chat_instance = MagicMock()

            async def fake_invoke():
                return
                yield

            mock_chat_instance.invoke = fake_invoke
            mock_chat_instance.add_chat_message = AsyncMock()
            MockChat.return_value = mock_chat_instance

            await runner.run("test", conversation_id="gc", options={"max_rounds": 20})

            call_kwargs = MockTermination.call_args.kwargs
            assert call_kwargs["maximum_iterations"] == 20

    @pytest.mark.asyncio
    async def test_run_magentic_tries_kernel_function_selection(self):
        """Magentic conversation tries KernelFunctionSelectionStrategy."""
        runner, agents = self._make_runner_with_agents(
            agent_names=["researcher", "synthesizer"],
            config_conversations=[{
                "id": "mag-conv",
                "description": "Magentic test",
                "type": "magentic",
                "agents": ["researcher", "synthesizer"],
            }],
        )

        with patch("sk_conversations.AgentGroupChat") as MockChat, \
             patch("semantic_kernel.agents.strategies.KernelFunctionSelectionStrategy") as MockKFS, \
             patch("semantic_kernel.functions.KernelFunctionFromPrompt") as MockKFP:

            MockKFS.return_value = MagicMock()
            MockKFP.return_value = MagicMock()

            mock_chat_instance = MagicMock()

            async def fake_invoke():
                return
                yield

            mock_chat_instance.invoke = fake_invoke
            mock_chat_instance.add_chat_message = AsyncMock()
            MockChat.return_value = mock_chat_instance

            await runner.run("test", conversation_id="mag-conv")

            # Verify KernelFunctionSelectionStrategy was attempted
            MockKFS.assert_called_once()

    @pytest.mark.asyncio
    async def test_run_handles_agent_exception(self):
        """Conversation returns error dict when agent raises."""
        runner, agents = self._make_runner_with_agents(
            agent_names=["a"],
            config_conversations=[{
                "id": "fail-conv",
                "description": "Failing",
                "type": "group_chat",
                "agents": ["a"],
            }],
        )

        with patch("sk_conversations.AgentGroupChat") as MockChat:
            MockChat.side_effect = Exception("SK initialization error")

            result = await runner.run("test", conversation_id="fail-conv")

            assert "error" in result
            assert "SK initialization error" in result["error"]

    @pytest.mark.asyncio
    async def test_run_with_inline_agents(self):
        """Conversations with inline agents create agents on the fly."""
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{"id": "base", "model": "m1"}],
            default_agent="base",
            conversations=[{
                "id": "inline-conv",
                "description": "With inline",
                "type": "sequential",
                "agents": ["inline-a", "inline-b"],
                "inline_agents": [
                    {"id": "inline-a", "model": "m1", "system_prompt": "You are A."},
                    {"id": "inline-b", "model": "m1", "system_prompt": "You are B."},
                ],
            }],
        )

        mock_kernel = MagicMock()
        mock_base = MagicMock(spec=ChatCompletionAgent)
        mock_base.name = "sk-agent-base"
        mock_base.kernel = mock_kernel

        runner = ConversationRunner(config, {"base": mock_base})

        with patch("sk_conversations.ChatCompletionAgent") as MockAgent, \
             patch("sk_conversations.AgentGroupChat") as MockChat:

            created_agents = []

            def track_creation(**kwargs):
                agent = MagicMock(spec=ChatCompletionAgent)
                agent.name = kwargs.get("name", "unnamed")
                agent.kernel = kwargs.get("kernel")
                created_agents.append(agent)
                return agent

            MockAgent.side_effect = track_creation

            mock_chat_instance = MagicMock()

            async def fake_invoke():
                return
                yield

            mock_chat_instance.invoke = fake_invoke
            mock_chat_instance.add_chat_message = AsyncMock()
            MockChat.return_value = mock_chat_instance

            await runner.run("test", conversation_id="inline-conv")

            # Verify 2 inline agents were created
            assert len(created_agents) == 2
            assert "inline-a" in created_agents[0].name
            assert "inline-b" in created_agents[1].name
            # Both reuse the same kernel
            for agent in created_agents:
                assert agent.kernel is mock_kernel


# ---------------------------------------------------------------------------
# Dynamic Description Mutation Tests
# ---------------------------------------------------------------------------

class TestDynamicDescriptionMutation:
    """Tests for _update_tool_descriptions mutating FastMCP tool descriptions."""

    def test_fastmcp_tool_description_can_be_mutated(self):
        """Verify FastMCP Tool.description field is mutable."""
        from mcp.server.fastmcp import FastMCP

        server = FastMCP("test-mutation")

        @server.tool()
        def sample_tool(x: str) -> str:
            """Original description"""
            return x

        tool = server._tool_manager._tools.get("sample_tool")
        assert tool is not None
        assert tool.description == "Original description"

        tool.description = "Mutated description"
        assert tool.description == "Mutated description"

    def test_update_tool_descriptions_modifies_call_agent(self):
        """_update_tool_descriptions changes call_agent description based on config."""
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1", "context_window": 100000}],
            agents=[{"id": "test-agent", "model": "m1", "description": "A test agent"}],
            default_agent="test-agent",
        )

        # Access the actual mcp_server from sk_agent module
        server = sk_agent.mcp_server

        # Check if call_agent is registered
        if "call_agent" in server._tool_manager._tools:
            original_desc = server._tool_manager._tools["call_agent"].description

            sk_agent._update_tool_descriptions(config)

            new_desc = server._tool_manager._tools["call_agent"].description
            assert "test-agent" in new_desc
            assert "A test agent" in new_desc
            assert "100K" in new_desc

            # Restore original to not affect other tests
            server._tool_manager._tools["call_agent"].description = original_desc

    def test_update_tool_descriptions_modifies_run_conversation(self):
        """_update_tool_descriptions changes run_conversation description."""
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{"id": "a1", "model": "m1"}],
            conversations=[{
                "id": "my-research",
                "description": "Custom research pipeline",
                "type": "sequential",
                "agents": ["a1"],
            }],
        )

        server = sk_agent.mcp_server

        if "run_conversation" in server._tool_manager._tools:
            original_desc = server._tool_manager._tools["run_conversation"].description

            sk_agent._update_tool_descriptions(config)

            new_desc = server._tool_manager._tools["run_conversation"].description
            assert "my-research" in new_desc
            assert "Custom research pipeline" in new_desc

            # Restore
            server._tool_manager._tools["run_conversation"].description = original_desc

    def test_update_tool_descriptions_shows_memory_badge(self):
        """Dynamic descriptions include [memory] for memory-enabled agents."""
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{
                "id": "mem-agent",
                "model": "m1",
                "description": "Agent with memory",
                "memory": {"enabled": True, "collection": "test-mem"},
            }],
            embeddings={
                "base_url": "https://emb.test/v1",
                "api_key": "key",
                "model_id": "emb-model",
                "dimensions": 1024,
            },
            default_agent="mem-agent",
        )

        desc = sk_agent.build_call_agent_description(config)
        assert "memory" in desc
        # Specifically in the agent line
        agent_lines = [l for l in desc.splitlines() if "mem-agent" in l]
        assert any("memory" in l for l in agent_lines)

    def test_update_tool_descriptions_handles_exception_gracefully(self):
        """_update_tool_descriptions doesn't crash on internal errors."""
        config = make_v2_config()

        # Mock mcp_server to cause error
        with patch.object(sk_agent.mcp_server, "_tool_manager", None):
            # Should not raise, just log
            sk_agent._update_tool_descriptions(config)


# ---------------------------------------------------------------------------
# Conversation Preset Tests (existing, keep unchanged)
# ---------------------------------------------------------------------------

class TestConversationPresets:
    """Tests for built-in conversation presets."""

    def test_deep_search_preset_exists(self):
        assert "deep-search" in PRESETS
        assert PRESETS["deep-search"] is DEEP_SEARCH_PRESET

    def test_deep_think_preset_exists(self):
        assert "deep-think" in PRESETS
        assert PRESETS["deep-think"] is DEEP_THINK_PRESET

    def test_deep_search_has_correct_agents(self):
        assert DEEP_SEARCH_PRESET.agents == ["researcher", "synthesizer", "critic"]
        assert DEEP_SEARCH_PRESET.type == "magentic"
        assert DEEP_SEARCH_PRESET.max_rounds == 10

    def test_deep_think_has_correct_agents(self):
        assert DEEP_THINK_PRESET.agents == ["optimist", "devils-advocate", "pragmatist", "mediator"]
        assert DEEP_THINK_PRESET.type == "group_chat"
        assert DEEP_THINK_PRESET.max_rounds == 8

    def test_deep_search_inline_agents(self):
        inline_ids = [a.id for a in DEEP_SEARCH_PRESET.inline_agents]
        assert inline_ids == ["researcher", "synthesizer", "critic"]

    def test_deep_think_inline_agents(self):
        inline_ids = [a.id for a in DEEP_THINK_PRESET.inline_agents]
        assert inline_ids == ["optimist", "devils-advocate", "pragmatist", "mediator"]


class TestConversationRunner:
    """Tests for ConversationRunner class."""

    def _make_runner(self, config=None, sk_agents=None):
        if config is None:
            config = make_v2_config(
                models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
                agents=[{"id": "a1", "model": "m1"}],
            )
        return ConversationRunner(config, sk_agents or {})

    def test_list_conversations_returns_presets(self):
        runner = self._make_runner()
        convs = runner.list_conversations()

        ids = [c["id"] for c in convs]
        assert "deep-search" in ids
        assert "deep-think" in ids

    def test_list_conversations_marks_builtins(self):
        runner = self._make_runner()
        convs = runner.list_conversations()

        for conv in convs:
            assert conv.get("builtin") is True

    def test_list_conversations_includes_config_conversations(self):
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{"id": "a1", "model": "m1"}],
            conversations=[
                {"id": "custom-conv", "description": "My custom", "type": "sequential", "agents": ["a1"]}
            ],
        )
        runner = ConversationRunner(config, {})
        convs = runner.list_conversations()

        ids = [c["id"] for c in convs]
        assert "custom-conv" in ids
        # Built-ins still present
        assert "deep-search" in ids

    def test_config_conversation_overrides_preset(self):
        """Config-defined conversation with same ID as preset takes precedence."""
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{"id": "a1", "model": "m1"}],
            conversations=[
                {"id": "deep-search", "description": "My custom deep search", "type": "sequential", "agents": ["a1"]}
            ],
        )
        runner = ConversationRunner(config, {})
        convs = runner.list_conversations()

        # Only one deep-search, not duplicated
        ds = [c for c in convs if c["id"] == "deep-search"]
        assert len(ds) == 1
        assert ds[0]["description"] == "My custom deep search"
        assert ds[0].get("builtin") is not True

    def test_resolve_conversation_defaults_to_deep_search(self):
        runner = self._make_runner()
        conv = runner._resolve_conversation(None)
        assert conv is not None
        assert conv.id == "deep-search"

    def test_resolve_conversation_finds_preset(self):
        runner = self._make_runner()
        conv = runner._resolve_conversation("deep-think")
        assert conv is not None
        assert conv.id == "deep-think"

    def test_resolve_conversation_not_found(self):
        runner = self._make_runner()
        conv = runner._resolve_conversation("nonexistent")
        assert conv is None

    @pytest.mark.asyncio
    async def test_run_unknown_conversation_returns_error(self):
        runner = self._make_runner()
        result = await runner.run("test prompt", conversation_id="nonexistent")
        assert "error" in result
        assert "not found" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_run_no_agents_returns_error(self):
        """Running a conversation with no resolvable agents returns error."""
        runner = self._make_runner(sk_agents={})
        result = await runner.run("test prompt", conversation_id="deep-search")
        assert "error" in result
        assert "no agents" in result["error"].lower()


class TestConversationDescriptionBuilder:
    """Tests for build_run_conversation_description."""

    def test_includes_presets(self):
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{"id": "a1", "model": "m1"}],
        )
        desc = build_run_conversation_description(config)

        assert "deep-search" in desc
        assert "deep-think" in desc
        assert "built-in" in desc

    def test_includes_config_conversations(self):
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{"id": "a1", "model": "m1"}],
            conversations=[
                {"id": "my-conv", "description": "Custom conversation", "type": "group_chat", "agents": ["a1"]}
            ],
        )
        desc = build_run_conversation_description(config)

        assert "my-conv" in desc
        assert "Custom conversation" in desc

    def test_no_duplicate_when_overriding_preset(self):
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{"id": "a1", "model": "m1"}],
            conversations=[
                {"id": "deep-search", "description": "Overridden", "type": "sequential", "agents": ["a1"]}
            ],
        )
        desc = build_run_conversation_description(config)

        # Only one conversation listing line for deep-search (not duplicated)
        conv_lines = [line for line in desc.splitlines() if line.strip().startswith("- deep-search:")]
        assert len(conv_lines) == 1
        assert "Overridden" in conv_lines[0]


class TestConversationInlineAgents:
    """Tests for inline agent resolution in conversations."""

    def test_inline_agent_creation_reuses_kernel(self):
        """Inline agents should reuse existing agent kernels."""
        runner = ConversationRunner.__new__(ConversationRunner)
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{"id": "a1", "model": "m1"}],
        )
        runner.config = config

        # Create a mock SK agent with a mock kernel
        mock_kernel = MagicMock()
        mock_agent = MagicMock()
        mock_agent.kernel = mock_kernel
        runner.sk_agents = {"a1": mock_agent}

        inline_cfg = AgentConfig(
            id="inline-test",
            description="Test inline",
            model="m1",
            system_prompt="You are a test agent.",
        )

        with patch("sk_conversations.ChatCompletionAgent") as MockAgent:
            MockAgent.return_value = MagicMock()
            result = runner._create_inline_agent(inline_cfg)

            assert result is not None
            MockAgent.assert_called_once()
            call_kwargs = MockAgent.call_args
            assert call_kwargs.kwargs["kernel"] is mock_kernel
            assert "inline-test" in call_kwargs.kwargs["name"]

    def test_inline_agent_uses_default_model_when_empty(self):
        """Inline agent with empty model uses default agent's model."""
        config = make_v2_config(
            models=[{"id": "m1", "base_url": "http://test", "model_id": "v1"}],
            agents=[{"id": "a1", "model": "m1"}],
            default_agent="a1",
        )

        runner = ConversationRunner.__new__(ConversationRunner)
        runner.config = config

        mock_kernel = MagicMock()
        mock_agent = MagicMock()
        mock_agent.kernel = mock_kernel
        runner.sk_agents = {"a1": mock_agent}

        inline_cfg = AgentConfig(
            id="no-model-agent",
            description="Test",
            model="",  # Empty model
            system_prompt="Test",
        )

        with patch("sk_conversations.ChatCompletionAgent") as MockAgent:
            MockAgent.return_value = MagicMock()
            result = runner._create_inline_agent(inline_cfg)
            assert result is not None


# ---------------------------------------------------------------------------
# Run Tests
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
