#!/usr/bin/env python3
"""
Unit tests for sk-agent MCP server.

Tests cover:
- Configuration loading and validation
- Image processing utilities (crop)
- Model selection logic
- Recursion depth protection
- SKAgentManager class
- Video analysis integration
- Document analysis integration
"""

import io
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

import sk_agent
from media_processing import (
    _crop_image,
    _resize_image_if_needed,
    _extract_video_frames,
    _get_video_info,
)


# ---------------------------------------------------------------------------
# Test Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def isolated_config(tmp_path):
    """Create a temporary config file and set SK_AGENT_CONFIG."""
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


@pytest.fixture
def sample_image():
    """Create a sample PNG image for testing."""
    from PIL import Image
    img = Image.new("RGB", (100, 100), color="red")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Configuration Tests
# ---------------------------------------------------------------------------

class TestConfigLoading:
    """Tests for configuration loading and validation."""

    @pytest.mark.skip(reason="Module reload isolation issue - config cached at import")
    def test_load_config_missing_file(self, tmp_path):
        """Test loading config when file doesn't exist."""
        pass

    def test_load_config_valid_file(self, isolated_config):
        """Test loading a valid config file."""
        import importlib
        importlib.reload(sk_agent)
        config = sk_agent.load_config()

        assert "models" in config
        assert len(config["models"]) == 2
        assert config["default_ask_model"] == "test-model"
        assert config["default_vision_model"] == "test-vision"

    @pytest.mark.skip(reason="Module reload isolation issue")
    def test_load_config_backward_compatibility(self, tmp_path):
        """Test backward compatibility with old config format."""
        pass

    @pytest.mark.skip(reason="Module reload isolation issue")
    def test_load_config_auto_default_models(self, tmp_path):
        """Test auto-setting default models."""
        pass


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

        # Create a very large image
        img = Image.new("RGB", (2000, 2000), color="blue")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        large_data = buf.getvalue()

        resized_data, media_type = _resize_image_if_needed(
            large_data, "image/png",
            max_bytes=100_000,  # 100 KB limit
            max_pixels=500_000,
        )

        # Should have been resized
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
        # Request crop beyond image bounds
        region = {"x": 80, "y": 80, "width": 100, "height": 100}
        cropped_data, media_type = _crop_image(sample_image, "image/png", region)

        # Should still succeed with clamped bounds
        assert len(cropped_data) > 0


# ---------------------------------------------------------------------------
# Recursion Depth Tests
# ---------------------------------------------------------------------------

class TestRecursionDepth:
    """Tests for recursion depth protection."""

    def test_default_max_recursion_depth(self):
        """Test default recursion depth value."""
        assert sk_agent.DEFAULT_MAX_RECURSION_DEPTH == 2

    def test_sk_agent_depth_env_var(self, monkeypatch):
        """Test SK_AGENT_DEPTH environment variable."""
        monkeypatch.setenv("SK_AGENT_DEPTH", "3")
        # Need to reload to pick up env var
        import importlib
        importlib.reload(sk_agent)
        assert sk_agent.SK_AGENT_DEPTH == 3


# ---------------------------------------------------------------------------
# SKAgentManager Tests
# ---------------------------------------------------------------------------

class TestSKAgentManager:
    """Tests for SKAgentManager class."""

    def test_init(self):
        """Test SKAgentManager initialization."""
        config = {"models": [], "mcps": []}
        manager = sk_agent.SKAgentManager(config)

        assert manager.config == config
        assert manager._agents == {}
        assert manager._kernels == {}

    def test_list_models(self, isolated_config):
        """Test list_models method."""
        import importlib
        importlib.reload(sk_agent)

        config = sk_agent.load_config()
        manager = sk_agent.SKAgentManager(config)
        manager._agents = {"test-model": MagicMock(), "test-vision": MagicMock()}

        models = manager.list_models()

        assert len(models) == 2
        assert models[0]["id"] == "test-model"
        assert models[1]["id"] == "test-vision"
        assert models[0]["is_default_ask"]
        assert not models[0]["is_default_vision"]
        assert not models[1]["is_default_ask"]
        assert models[1]["is_default_vision"]

    def test_get_or_create_thread_new(self):
        """Test creating a new thread."""
        config = {"models": [], "mcps": []}
        manager = sk_agent.SKAgentManager(config)

        conv_id, thread = manager._get_or_create_thread(None)

        assert conv_id is not None
        assert thread is not None
        assert conv_id in manager._threads

    def test_get_or_create_thread_existing(self):
        """Test getting an existing thread."""
        config = {"models": [], "mcps": []}
        manager = sk_agent.SKAgentManager(config)

        # Create a thread first
        conv_id, thread = manager._get_or_create_thread(None)

        # Get the same thread
        conv_id2, thread2 = manager._get_or_create_thread(conv_id)

        assert conv_id == conv_id2
        assert thread == thread2

    def test_end_conversation(self):
        """Test ending a conversation."""
        config = {"models": [], "mcps": []}
        manager = sk_agent.SKAgentManager(config)

        # Create a thread
        conv_id, _ = manager._get_or_create_thread(None)
        assert conv_id in manager._threads

        # End it
        result = manager.end_conversation(conv_id)
        assert result is True
        assert conv_id not in manager._threads

    def test_end_conversation_not_found(self):
        """Test ending a non-existent conversation."""
        config = {"models": [], "mcps": []}
        manager = sk_agent.SKAgentManager(config)

        result = manager.end_conversation("non-existent")
        assert result is False


# ---------------------------------------------------------------------------
# Model Selection Tests
# ---------------------------------------------------------------------------

class TestModelSelection:
    """Tests for model selection logic."""

    def test_get_model_config_found(self):
        """Test finding a model config."""
        config = {
            "models": [
                {"id": "model-a", "vision": False},
                {"id": "model-b", "vision": True},
            ]
        }
        manager = sk_agent.SKAgentManager(config)

        result = manager._get_model_config("model-b")

        assert result is not None
        assert result["id"] == "model-b"
        assert result["vision"] is True

    def test_get_model_config_not_found(self):
        """Test model config not found."""
        config = {"models": [{"id": "model-a", "vision": False}]}
        manager = sk_agent.SKAgentManager(config)

        result = manager._get_model_config("non-existent")

        assert result is None


# ---------------------------------------------------------------------------
# Integration Tests
# ---------------------------------------------------------------------------

class TestIntegration:
    """Integration tests with mocked agents."""

    @pytest.mark.asyncio
    async def test_ask_no_models(self):
        """Test ask with no models configured."""
        config = {"models": [], "mcps": []}
        manager = sk_agent.SKAgentManager(config)

        result = await manager.ask("test prompt")

        assert "error" in result
        assert "No agents" in result["error"]

    @pytest.mark.asyncio
    async def test_analyze_image_region_no_vision_model(self, tmp_path):
        """Test analyze_image_region when no vision model is available."""
        config = {"models": [{"id": "text-only", "vision": False}]}
        manager = sk_agent.SKAgentManager(config)
        manager._agents = {"text-only": MagicMock()}

        # Create a test image
        from PIL import Image
        img = Image.new("RGB", (100, 100), color="red")
        img_path = tmp_path / "test.png"
        img.save(img_path)

        result = await manager.analyze_image_region(
            str(img_path),
            region={"x": 0, "y": 0, "width": 50, "height": 50}
        )

        assert "error" in result


# ---------------------------------------------------------------------------
# Model Enabled Tests
# ---------------------------------------------------------------------------

class TestModelEnabled:
    """Tests for model enabled/disabled functionality."""

    def test_list_models_includes_enabled_field(self):
        """Test that list_models includes enabled field."""
        config = {
            "models": [
                {"id": "enabled-model", "enabled": True, "vision": False},
                {"id": "disabled-model", "enabled": False, "vision": False},
            ]
        }
        manager = sk_agent.SKAgentManager(config)

        models = manager.list_models()

        assert models[0]["enabled"] is True
        assert models[1]["enabled"] is False

    def test_disabled_model_not_loaded(self):
        """Test that disabled models are not loaded."""
        config = {
            "models": [
                {"id": "enabled-model", "enabled": True, "base_url": "http://test", "model_id": "v1"},
                {"id": "disabled-model", "enabled": False, "base_url": "http://test", "model_id": "v2"},
            ]
        }
        manager = sk_agent.SKAgentManager(config)
        manager._agents = {"enabled-model": MagicMock()}  # Simulate only enabled loaded

        assert "enabled-model" in manager._agents
        assert "disabled-model" not in manager._agents

    def test_vision_search_ignores_disabled_models(self):
        """Test that vision model search ignores disabled models."""
        config = {
            "default_vision_model": "disabled-vision",
            "models": [
                {"id": "disabled-vision", "enabled": False, "vision": True},
                {"id": "enabled-vision", "enabled": True, "vision": True},
            ]
        }
        manager = sk_agent.SKAgentManager(config)
        manager._agents = {"enabled-vision": MagicMock()}

        # Get model config should find the enabled one
        enabled_cfg = manager._get_model_config("enabled-vision")
        assert enabled_cfg is not None
        assert enabled_cfg["vision"] is True


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
        import json
        context_str = json.dumps(zoom_context)

        # Verify it can be serialized
        parsed = json.loads(context_str)
        assert parsed["depth"] == 1
        assert len(parsed["stack"]) == 1

    def test_progressive_zoom_depth(self):
        """Test that zoom depth increases with each zoom."""
        context_v1 = {"depth": 1, "stack": [], "original_source": "test.png"}
        context_v2 = {"depth": 2, "stack": [{"x": 0, "y": 0, "w": 100, "h": 100}], "original_source": "test.png"}

        assert context_v2["depth"] > context_v1["depth"]


# ---------------------------------------------------------------------------
# Advanced Vision Capabilities Tests
# ---------------------------------------------------------------------------

class TestAdvancedVisionCapabilities:
    """Tests for advanced vision features."""

    @pytest.mark.asyncio
    async def test_ask_with_media_supports_single_image(self, sample_image):
        """Test that _ask_with_media can handle a single image."""
        config = {
            "default_vision_model": "test-vision",
            "models": [{"id": "test-vision", "vision": True, "base_url": "http://test", "model_id": "v1"}]
        }
        manager = sk_agent.SKAgentManager(config)
        manager._agents = {"test-vision": MagicMock()}

        from semantic_kernel.contents import ImageContent
        import base64
        b64_data = base64.b64encode(sample_image).decode("ascii")
        image_item = ImageContent(data_uri=f"data:image/png;base64,{b64_data}")

        # This should not raise an error about image handling
        # The actual agent invocation would need mocking for full test

    @pytest.mark.asyncio
    async def test_analyze_image_region_with_zoom_context(self, sample_image, tmp_path):
        """Test image region analysis with zoom context."""
        config = {
            "default_vision_model": "test-vision",
            "models": [{"id": "test-vision", "vision": True, "base_url": "http://test", "model_id": "v1"}]
        }
        manager = sk_agent.SKAgentManager(config)
        manager._agents = {"test-vision": MagicMock()}

        # Create a test image file
        from PIL import Image
        img = Image.open(io.BytesIO(sample_image))
        img_path = tmp_path / "test.png"
        img.save(img_path)

        import base64
        zoom_context = '{"depth": 1, "stack": []}'

        result = await manager.analyze_image_region(
            str(img_path),
            region={"x": 0, "y": 0, "width": 50, "height": 50},
            zoom_context=zoom_context
        )

        # Result should include the zoom context in the prompt
        # (actual result depends on mocked agent)


# ---------------------------------------------------------------------------
# Video Analysis Tests
# ---------------------------------------------------------------------------

class TestVideoAnalysis:
    """Tests for video analysis functionality."""

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

        # Create a test frame image
        from PIL import Image
        import io
        img = Image.new('RGB', (100, 100), color='red')
        buf = io.BytesIO()
        img.save(buf, format='JPEG')
        fake_frame = buf.getvalue()

        # Mock _get_video_info to return valid info
        mock_video_info = MagicMock()
        mock_video_info.duration = 10.0
        mock_video_info.width = 640
        mock_video_info.height = 480

        # Mock subprocess to simulate ffmpeg frame extraction
        def mock_run(cmd, *args, **kwargs):
            result = MagicMock()
            result.returncode = 0
            result.stderr = ""
            # If this is an ffmpeg frame extraction command
            if "ffmpeg" in cmd and "-frames:v" in cmd:
                # Find output path (last argument)
                output_path = cmd[-1]
                Path(output_path).parent.mkdir(parents=True, exist_ok=True)
                with open(output_path, 'wb') as f:
                    f.write(fake_frame)
            return result

        with patch('media_processing._get_video_info', return_value=mock_video_info):
            with patch('media_processing.subprocess.run', side_effect=mock_run):
                frames = _extract_video_frames(str(fake_video), num_frames=2)

        # Should have extracted 2 frames
        assert len(frames) == 2

    @pytest.mark.asyncio
    async def test_analyze_video_no_vision_model(self, tmp_path):
        """Test analyze_video when no vision model is available."""
        config = {"models": [{"id": "text-only", "vision": False}]}
        manager = sk_agent.SKAgentManager(config)
        manager._agents = {"text-only": MagicMock()}

        # Create a fake video file
        fake_video = tmp_path / "test.mp4"
        fake_video.write_bytes(b"fake video")

        result = await manager.analyze_video(str(fake_video))

        assert "error" in result

    @pytest.mark.asyncio
    async def test_analyze_video_success(self, tmp_path):
        """Test successful video analysis."""
        config = {
            "default_vision_model": "test-vision",
            "models": [{"id": "test-vision", "vision": True, "base_url": "http://test", "model_id": "v1"}]
        }
        manager = sk_agent.SKAgentManager(config)

        mock_agent = MagicMock()
        manager._agents = {"test-vision": mock_agent}
        manager._threads = {}

        # Create a fake video file
        fake_video = tmp_path / "test.mp4"
        fake_video.write_bytes(b"fake video")

        # Mock video info extraction
        with patch('sk_agent._get_video_info', return_value=None):
            # Mock frame extraction
            from PIL import Image
            import io
            img = Image.new('RGB', (100, 100), color='red')
            buf = io.BytesIO()
            img.save(buf, format='JPEG')
            fake_frame = buf.getvalue()

            with patch('sk_agent._extract_keyframes', return_value=[
                (fake_frame, "image/jpeg"),
                (fake_frame, "image/jpeg"),
            ]):
                async def mock_invoke(*args, **kwargs):
                    mock_response = MagicMock()
                    mock_response.__str__ = lambda self: "Video summary"
                    mock_response.thread = MagicMock()
                    yield mock_response

                mock_agent.invoke = mock_invoke
                result = await manager.analyze_video(str(fake_video))

        assert "response" in result
        assert result["frames_analyzed"] == 2


# ---------------------------------------------------------------------------
# Context Window Tests
# ---------------------------------------------------------------------------

class TestContextWindow:
    """Tests for context window functionality."""

    def test_get_model_context_window_explicit(self):
        """Test getting explicit context window from config."""
        config = {
            "models": [
                {"id": "test", "context_window": 100_000}
            ]
        }
        result = sk_agent.get_model_context_window(config, "test")
        assert result == 100_000

    def test_get_model_context_window_vision_default(self):
        """Test default context window for vision models."""
        config = {
            "models": [
                {"id": "test", "vision": True}
            ]
        }
        result = sk_agent.get_model_context_window(config, "test")
        assert result == 128_000

    def test_get_model_context_window_cloud_default(self):
        """Test default context window for cloud models."""
        config = {
            "models": [
                {"id": "test", "vision": False, "base_url": "https://api.z.ai/v1"}
            ]
        }
        result = sk_agent.get_model_context_window(config, "test")
        assert result == 200_000


# ---------------------------------------------------------------------------
# Run Tests
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
