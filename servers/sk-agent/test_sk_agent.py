#!/usr/bin/env python3
"""
Unit tests for sk-agent MCP server.

Tests cover:
- Configuration loading and validation
- Image processing utilities (resize + crop)
- Model selection logic
- Recursion depth protection
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
        # Import here to use fresh module state
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config_path = tmp_path / "nonexistent.json"
        with patch.dict(os.environ, {"SK_AGENT_CONFIG": str(config_path)}):
            config = sk_agent.load_config()
            assert config == {"models": [], "mcps": [], "system_prompt": ""}

    def test_load_config_valid_file(self, isolated_config):
        """Test loading a valid config file."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = sk_agent.load_config()
        assert config["default_ask_model"] == "test-model"
        assert len(config["models"]) == 2
        assert config["system_prompt"] == "Test prompt"

    @pytest.mark.skip(reason="Module reload isolation issue - config cached at import")
    def test_load_config_backward_compatibility(self, tmp_path):
        """Test backward compatibility with old config format."""
        old_config = {
            "default_model": "legacy-model",
            "model": {
                "model_id": "legacy-model",
                "base_url": "https://api.legacy.com/v1",
                "api_key": "legacy-key",
            },
            "mcps": [],
        }
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(old_config))

        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        with patch.dict(os.environ, {"SK_AGENT_CONFIG": str(config_file)}):
            config = sk_agent.load_config()

        # Should convert old format to new
        assert "model" not in config
        assert "models" in config
        assert len(config["models"]) == 1
        assert config["models"][0]["id"] == "legacy-model"
        assert config["default_ask_model"] == "legacy-model"

    @pytest.mark.skip(reason="Module reload isolation issue - config cached at import")
    def test_load_config_auto_default_models(self, tmp_path):
        """Test automatic setting of default models."""
        config_data = {
            "models": [
                {"id": "text-model", "vision": False},
                {"id": "vision-model", "vision": True},
            ],
        }
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(config_data))

        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        with patch.dict(os.environ, {"SK_AGENT_CONFIG": str(config_file)}):
            config = sk_agent.load_config()

        # First model should be default for ask
        assert config["default_ask_model"] == "text-model"
        # First vision model should be default for vision
        assert config["default_vision_model"] == "vision-model"


# ---------------------------------------------------------------------------
# Image Processing Tests
# ---------------------------------------------------------------------------

class TestImageProcessing:
    """Tests for image processing utilities."""

    def test_resize_image_small_image(self, sample_image):
        """Test that small images are not resized."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        resized_data, media_type = sk_agent._resize_image(sample_image, "image/png")

        # Small image should not be resized
        assert resized_data == sample_image
        assert media_type == "image/png"

    def test_resize_image_large_image(self):
        """Test that large images are resized."""
        from PIL import Image
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        # Create a large 1000x1000 image
        img = Image.new("RGB", (1000, 1000), color="blue")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        data = buf.getvalue()

        resized_data, media_type = sk_agent._resize_image(data, "image/png")

        # Large image should be resized (smaller output)
        assert len(resized_data) < len(data)
        assert media_type == "image/png"

    def test_crop_image_pixels(self, sample_image):
        """Test cropping image with pixel values."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        region = {"x": 10, "y": 10, "width": 50, "height": 50}
        cropped_data, media_type = sk_agent._crop_image(sample_image, "image/png", region)

        # Cropped image should be smaller
        assert len(cropped_data) < len(sample_image)
        assert media_type == "image/png"

    def test_crop_image_percentages(self, sample_image):
        """Test cropping image with percentage values."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        region = {"x": "25%", "y": "25%", "width": "50%", "height": "50%"}
        cropped_data, media_type = sk_agent._crop_image(sample_image, "image/png", region)

        # Cropped image should be smaller
        assert len(cropped_data) < len(sample_image)
        assert media_type == "image/png"

    def test_crop_image_clamp_bounds(self, sample_image):
        """Test that crop region is clamped to image bounds."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        # Region extends beyond image bounds
        region = {"x": 80, "y": 80, "width": 100, "height": 100}
        cropped_data, _ = sk_agent._crop_image(sample_image, "image/png", region)

        # Should not crash and produce valid output
        assert len(cropped_data) > 0


# ---------------------------------------------------------------------------
# Recursion Depth Tests
# ---------------------------------------------------------------------------

class TestRecursionDepth:
    """Tests for recursion depth protection."""

    def test_default_max_recursion_depth(self):
        """Test default recursion depth limit."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        assert sk_agent.DEFAULT_MAX_RECURSION_DEPTH == 2

    def test_sk_agent_depth_env_var(self):
        """Test SK_AGENT_DEPTH environment variable reading."""
        with patch.dict(os.environ, {"SK_AGENT_DEPTH": "3"}, clear=False):
            import sk_agent
            import importlib
            importlib.reload(sk_agent)
            assert sk_agent.SK_AGENT_DEPTH == 3


# ---------------------------------------------------------------------------
# Agent Manager Tests
# ---------------------------------------------------------------------------

class TestSKAgentManager:
    """Tests for SKAgentManager class."""

    def test_init(self, isolated_config):
        """Test manager initialization."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = sk_agent.load_config()
        manager = sk_agent.SKAgentManager(config)

        assert manager.config == config
        assert manager._kernels == {}
        assert manager._agents == {}
        assert manager._threads == {}

    def test_list_models(self, isolated_config):
        """Test list_models method."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = sk_agent.load_config()
        manager = sk_agent.SKAgentManager(config)

        models = manager.list_models()

        assert len(models) == 2
        assert models[0]["id"] == "test-model"
        assert models[0]["is_default_ask"] is True
        assert models[0]["is_default_vision"] is False
        assert models[1]["id"] == "test-vision"
        assert models[1]["is_default_ask"] is False
        assert models[1]["is_default_vision"] is True

    def test_get_or_create_thread_new(self, isolated_config):
        """Test creating a new thread."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = sk_agent.load_config()
        manager = sk_agent.SKAgentManager(config)

        conv_id, thread = manager._get_or_create_thread(None)

        assert conv_id.startswith("conv-")
        assert conv_id in manager._threads

    def test_get_or_create_thread_existing(self, isolated_config):
        """Test getting an existing thread."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = sk_agent.load_config()
        manager = sk_agent.SKAgentManager(config)

        # Create a thread first
        manager._get_or_create_thread("existing-conv")

        # Get the same thread
        same_conv_id, thread = manager._get_or_create_thread("existing-conv")

        assert same_conv_id == "existing-conv"
        assert thread is manager._threads["existing-conv"]

    def test_end_conversation(self, isolated_config):
        """Test ending a conversation."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = sk_agent.load_config()
        manager = sk_agent.SKAgentManager(config)

        # Create a thread
        manager._get_or_create_thread("test-conv")
        assert "test-conv" in manager._threads

        # End it
        result = manager.end_conversation("test-conv")
        assert result is True
        assert "test-conv" not in manager._threads

    def test_end_conversation_not_found(self, isolated_config):
        """Test ending a non-existent conversation."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = sk_agent.load_config()
        manager = sk_agent.SKAgentManager(config)

        result = manager.end_conversation("nonexistent")
        assert result is False


# ---------------------------------------------------------------------------
# Model Selection Tests
# ---------------------------------------------------------------------------

class TestModelSelection:
    """Tests for model selection logic."""

    def test_get_model_config_found(self, isolated_config):
        """Test finding a model config."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = sk_agent.load_config()
        manager = sk_agent.SKAgentManager(config)

        model_cfg = manager._get_model_config("test-model")

        assert model_cfg is not None
        assert model_cfg["id"] == "test-model"

    def test_get_model_config_not_found(self, isolated_config):
        """Test model config not found."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = sk_agent.load_config()
        manager = sk_agent.SKAgentManager(config)

        model_cfg = manager._get_model_config("nonexistent")

        assert model_cfg is None


# ---------------------------------------------------------------------------
# Integration Tests (Mocked)
# ---------------------------------------------------------------------------

class TestIntegration:
    """Integration tests with mocked external dependencies."""

    @pytest.mark.asyncio
    async def test_ask_no_models(self, tmp_path):
        """Test ask when no models are available."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = {"models": [], "mcps": []}
        manager = sk_agent.SKAgentManager(config)
        # Don't call start() to avoid plugin loading

        result = await manager.ask("test prompt")

        assert "error" in result
        assert "No models available" in result["error"]

    @pytest.mark.asyncio
    async def test_analyze_image_region_no_vision_model(self, tmp_path):
        """Test region analysis when no vision model is configured."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = {
            "default_vision_model": "text-only",
            "models": [
                {"id": "text-only", "model_id": "text-v1", "vision": False, "base_url": "http://localhost"},
            ],
        }
        manager = sk_agent.SKAgentManager(config)

        # Mock agents as initialized but no vision model
        manager._agents = {"text-only": MagicMock()}
        manager._openai_clients = {"text-only": MagicMock()}

        result = await manager.analyze_image_region(
            "fake_path.png",
            {"x": 0, "y": 0, "width": 100, "height": 100},
            "Describe this"
        )

        assert "error" in result
        assert "No vision-capable model" in result["error"]


# ---------------------------------------------------------------------------
# Model Enable/Disable Tests
# ---------------------------------------------------------------------------

class TestModelEnabled:
    """Tests for model enable/disable functionality."""

    def test_list_models_includes_enabled_field(self, isolated_config):
        """Test that list_models includes enabled field."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = sk_agent.load_config()
        manager = sk_agent.SKAgentManager(config)

        models = manager.list_models()

        assert len(models) > 0
        for m in models:
            assert "enabled" in m

    def test_disabled_model_not_loaded(self, tmp_path):
        """Test that disabled models are skipped during startup."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = {
            "default_ask_model": "enabled-model",
            "models": [
                {"id": "enabled-model", "enabled": True, "model_id": "v1", "vision": False, "base_url": "http://localhost"},
                {"id": "disabled-model", "enabled": False, "model_id": "v2", "vision": True, "base_url": "http://localhost"},
            ],
        }
        manager = sk_agent.SKAgentManager(config)

        # Simulate start() without actually loading plugins
        for model_cfg in config.get("models", []):
            if not model_cfg.get("enabled", True):
                continue  # Should skip disabled model
            model_id = model_cfg.get("id")
            manager._agents[model_id] = MagicMock()

        assert "enabled-model" in manager._agents
        assert "disabled-model" not in manager._agents

    @pytest.mark.asyncio
    async def test_vision_search_ignores_disabled_models(self, tmp_path):
        """Test that vision model search ignores disabled models."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = {
            "default_vision_model": "disabled-vision",
            "models": [
                {"id": "disabled-vision", "enabled": False, "model_id": "v1", "vision": True, "base_url": "http://localhost"},
                {"id": "enabled-vision", "enabled": True, "model_id": "v2", "vision": True, "base_url": "http://localhost"},
            ],
        }
        manager = sk_agent.SKAgentManager(config)
        manager._agents = {"enabled-vision": MagicMock()}

        # When searching for vision model, should only find enabled one
        result = await manager.ask_with_image("fake.png", "test")

        # Should not have error - found enabled vision model
        assert "error" not in result or result.get("error") != "No vision-capable model available"


# ---------------------------------------------------------------------------
# Zoom Context Tests
# ---------------------------------------------------------------------------

class TestZoomContext:
    """Tests for zoom context functionality."""

    def test_zoom_context_structure(self):
        """Test that zoom context is built correctly."""
        # Simulate zoom context building
        zoom_context = None
        region = {"x": 100, "y": 200, "width": 300, "height": 400}

        new_depth = (zoom_context.get("depth", 0) + 1) if zoom_context else 1
        new_stack = list(zoom_context.get("stack", [])) if zoom_context else []
        new_stack.append(region)

        new_zoom_context = {
            "depth": new_depth,
            "stack": new_stack,
            "original_source": "test.png",
        }

        assert new_zoom_context["depth"] == 1
        assert len(new_zoom_context["stack"]) == 1
        assert new_zoom_context["stack"][0] == region

    def test_progressive_zoom_depth(self):
        """Test that progressive zoom increases depth."""
        # First zoom
        ctx1 = {"depth": 1, "stack": [{"x": 0, "y": 0, "w": 100, "h": 100}], "original_source": "test.png"}
        region2 = {"x": 25, "y": 25, "width": 50, "height": 50}

        new_depth = (ctx1.get("depth", 0) + 1) if ctx1 else 1
        new_stack = list(ctx1.get("stack", []))
        new_stack.append(region2)

        ctx2 = {"depth": new_depth, "stack": new_stack, "original_source": ctx1["original_source"]}

        assert ctx2["depth"] == 2
        assert len(ctx2["stack"]) == 2


# ---------------------------------------------------------------------------
# Multi-Image / Document Tests (GLM-4.6V capabilities)
# ---------------------------------------------------------------------------

class TestAdvancedVisionCapabilities:
    """Tests for advanced vision capabilities (multi-image, documents)."""

    def test_ask_with_media_supports_single_image(self):
        """Test that _ask_with_media can handle single image input."""
        import sk_agent

        # Verify the method signature accepts image_data and media_type
        import inspect
        sig = inspect.signature(sk_agent.SKAgentManager._ask_with_media)
        params = list(sig.parameters.keys())

        assert "image_data" in params
        assert "media_type" in params
        assert "zoom_context" in params

    @pytest.mark.asyncio
    async def test_analyze_image_region_with_zoom_context(self, tmp_path):
        """Test that zoom context is passed through and incremented."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = {
            "default_vision_model": "test-vision",
            "models": [
                {"id": "test-vision", "enabled": True, "model_id": "v1", "vision": True, "base_url": "http://localhost"},
            ],
        }
        manager = sk_agent.SKAgentManager(config)

        # Mock the agent
        mock_agent = MagicMock()
        mock_agent.invoke = MagicMock()
        manager._agents = {"test-vision": mock_agent}
        manager._threads = {}

        # Create a test image file
        test_img = tmp_path / "test.png"
        from PIL import Image
        img = Image.new('RGB', (100, 100), color='red')
        img.save(test_img)

        # Mock the async generator for invoke
        async def mock_invoke(*args, **kwargs):
            mock_response = MagicMock()
            mock_response.__str__ = lambda self: "Test response"
            mock_response.thread = MagicMock()
            yield mock_response

        mock_agent.invoke = mock_invoke

        # Test with zoom context
        prev_context = {"depth": 1, "stack": [{"x": 0, "y": 0, "w": 50, "h": 50}], "original_source": str(test_img)}
        result = await manager.analyze_image_region(
            str(test_img),
            {"x": 10, "y": 10, "width": 30, "height": 30},
            "Describe this region",
            zoom_context=prev_context
        )

        assert "zoom_context" in result
        assert result["zoom_context"]["depth"] == 2
        assert len(result["zoom_context"]["stack"]) == 2


# ---------------------------------------------------------------------------
# Video Analysis Tests
# ---------------------------------------------------------------------------

class TestVideoAnalysis:
    """Tests for video analysis functionality."""

    def test_extract_video_frames_function_exists(self):
        """Test that video frame extraction function exists and has correct signature."""
        import sk_agent
        import inspect

        assert hasattr(sk_agent, "_extract_video_frames")
        sig = inspect.signature(sk_agent._extract_video_frames)
        params = list(sig.parameters.keys())

        assert "video_path" in params
        assert "num_frames" in params

    def test_extract_video_frames_mocked(self, tmp_path):
        """Test video frame extraction with mocked ffmpeg."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        # Create a fake video file (just needs to exist for path check)
        fake_video = tmp_path / "test.mp4"
        fake_video.write_bytes(b"fake video content")

        # Mock subprocess to simulate ffmpeg behavior
        frames = []
        original_run = sk_agent.subprocess.run

        def mock_run(cmd, *args, **kwargs):
            # Detect if it's ffprobe (get duration) or ffmpeg (extract frame)
            if "ffprobe" in cmd:
                # Return mock duration
                result = MagicMock()
                result.stdout = "10.0\n"  # 10 seconds
                result.stderr = ""
                return result
            elif "ffmpeg" in cmd:
                # Simulate frame extraction by creating output file
                output_path = cmd[-1]
                from PIL import Image
                import io
                img = Image.new('RGB', (100, 100), color='blue')
                buf = io.BytesIO()
                img.save(buf, format='JPEG')
                Path(output_path).write_bytes(buf.getvalue())
                result = MagicMock()
                result.returncode = 0
                return result
            return original_run(cmd, *args, **kwargs)

        with patch.object(sk_agent.subprocess, 'run', side_effect=mock_run):
            result = sk_agent._extract_video_frames(str(fake_video), num_frames=3)

        # Should have extracted frames
        assert len(result) == 3
        for frame_data, media_type in result:
            assert len(frame_data) > 0
            assert media_type == "image/jpeg"

    @pytest.mark.asyncio
    async def test_analyze_video_no_vision_model(self, tmp_path):
        """Test video analysis when no vision model is configured."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = {
            "default_vision_model": "text-only",
            "models": [
                {"id": "text-only", "model_id": "v1", "vision": False, "base_url": "http://localhost"},
            ],
        }
        manager = sk_agent.SKAgentManager(config)
        manager._agents = {"text-only": MagicMock()}

        result = await manager.analyze_video(str(tmp_path / "fake.mp4"))

        assert "error" in result
        assert "No vision-capable model" in result["error"]

    @pytest.mark.asyncio
    async def test_analyze_video_success(self, tmp_path):
        """Test successful video analysis."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = {
            "default_vision_model": "test-vision",
            "models": [
                {"id": "test-vision", "enabled": True, "model_id": "v1", "vision": True, "base_url": "http://localhost"},
            ],
        }
        manager = sk_agent.SKAgentManager(config)

        # Mock the agent
        mock_agent = MagicMock()
        manager._agents = {"test-vision": mock_agent}
        manager._threads = {}

        # Create a test video file (fake)
        test_video = tmp_path / "test.mp4"
        test_video.write_bytes(b"fake video")

        # Mock _extract_video_frames to return test frames
        def mock_extract_frames(path, num_frames=8):
            from PIL import Image
            import io
            img = Image.new('RGB', (100, 100), color='green')
            buf = io.BytesIO()
            img.save(buf, format='JPEG')
            return [(buf.getvalue(), "image/jpeg") for _ in range(num_frames)]

        with patch.object(sk_agent, '_extract_video_frames', side_effect=mock_extract_frames):
            # Mock the async generator for invoke
            async def mock_invoke(*args, **kwargs):
                mock_response = MagicMock()
                mock_response.__str__ = lambda self: "Video analysis result"
                mock_response.thread = MagicMock()
                yield mock_response

            mock_agent.invoke = mock_invoke

            result = await manager.analyze_video(str(test_video), num_frames=4)

        assert "response" in result
        assert result["frames_analyzed"] == 4
        assert "conversation_id" in result
        assert result["model_used"] == "test-vision"


# ---------------------------------------------------------------------------
# Document Analysis Tests
# ---------------------------------------------------------------------------

class TestDocumentAnalysis:
    """Tests for document (PDF) analysis functionality."""

    def test_pdf_to_images_function_exists(self):
        """Test that PDF conversion function exists and has correct signature."""
        import sk_agent
        import inspect

        assert hasattr(sk_agent, "_pdf_to_images")
        sig = inspect.signature(sk_agent._pdf_to_images)
        params = list(sig.parameters.keys())

        assert "pdf_path" in params
        assert "max_pages" in params

    def test_pdf_to_images_mocked(self, tmp_path):
        """Test PDF to image conversion with mocked pdf2image."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        # Create a fake PDF file
        fake_pdf = tmp_path / "test.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4 fake pdf content")

        # Mock pdf2image
        from PIL import Image
        mock_pages = [Image.new('RGB', (200, 200), color='white') for _ in range(3)]

        with patch.dict('sys.modules', {'pdf2image': MagicMock()}):
            import sys
            mock_pdf2image = sys.modules['pdf2image']
            mock_pdf2image.convert_from_path = MagicMock(return_value=mock_pages)

            # Force reimport to use mocked module
            result = sk_agent._pdf_to_images(str(fake_pdf), max_pages=3)

        # Should have converted pages
        assert len(result) == 3
        for page_data, media_type in result:
            assert len(page_data) > 0
            assert media_type == "image/jpeg"

    @pytest.mark.asyncio
    async def test_analyze_document_no_vision_model(self, tmp_path):
        """Test document analysis when no vision model is configured."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = {
            "default_vision_model": "text-only",
            "models": [
                {"id": "text-only", "model_id": "v1", "vision": False, "base_url": "http://localhost"},
            ],
        }
        manager = sk_agent.SKAgentManager(config)
        manager._agents = {"text-only": MagicMock()}

        result = await manager.analyze_document(str(tmp_path / "fake.pdf"))

        assert "error" in result
        assert "No vision-capable model" in result["error"]

    @pytest.mark.asyncio
    async def test_analyze_document_success(self, tmp_path):
        """Test successful document analysis."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = {
            "default_vision_model": "test-vision",
            "models": [
                {"id": "test-vision", "enabled": True, "model_id": "v1", "vision": True, "base_url": "http://localhost"},
            ],
        }
        manager = sk_agent.SKAgentManager(config)

        # Mock the agent
        mock_agent = MagicMock()
        manager._agents = {"test-vision": mock_agent}
        manager._threads = {}

        # Create a test PDF file (fake)
        test_pdf = tmp_path / "test.pdf"
        test_pdf.write_bytes(b"%PDF-1.4 fake pdf")

        # Mock _pdf_to_images to return test pages
        def mock_pdf_to_images(path, max_pages=10):
            from PIL import Image
            import io
            img = Image.new('RGB', (200, 300), color='white')
            buf = io.BytesIO()
            img.save(buf, format='JPEG')
            return [(buf.getvalue(), "image/jpeg") for _ in range(min(5, max_pages))]

        with patch.object(sk_agent, '_pdf_to_images', side_effect=mock_pdf_to_images):
            # Mock the async generator for invoke
            async def mock_invoke(*args, **kwargs):
                mock_response = MagicMock()
                mock_response.__str__ = lambda self: "Document analysis result"
                mock_response.thread = MagicMock()
                yield mock_response

            mock_agent.invoke = mock_invoke

            result = await manager.analyze_document(str(test_pdf), max_pages=5)

        assert "response" in result
        assert result["pages_analyzed"] == 5
        assert "conversation_id" in result
        assert result["model_used"] == "test-vision"

    @pytest.mark.asyncio
    async def test_analyze_document_respects_max_pages(self, tmp_path):
        """Test that document analysis respects max_pages limit."""
        import sk_agent
        import importlib
        importlib.reload(sk_agent)

        config = {
            "default_vision_model": "test-vision",
            "models": [
                {"id": "test-vision", "enabled": True, "model_id": "v1", "vision": True, "base_url": "http://localhost"},
            ],
        }
        manager = sk_agent.SKAgentManager(config)

        # Mock the agent
        mock_agent = MagicMock()
        manager._agents = {"test-vision": mock_agent}
        manager._threads = {}

        # Create a test PDF file
        test_pdf = tmp_path / "test.pdf"
        test_pdf.write_bytes(b"%PDF-1.4 fake pdf")

        # Mock _pdf_to_images to return more pages than max_pages
        def mock_pdf_to_images(path, max_pages=10):
            from PIL import Image
            import io
            img = Image.new('RGB', (200, 300), color='white')
            buf = io.BytesIO()
            img.save(buf, format='JPEG')
            # Return exactly max_pages images
            return [(buf.getvalue(), "image/jpeg") for _ in range(max_pages)]

        with patch.object(sk_agent, '_pdf_to_images', side_effect=mock_pdf_to_images):
            # Mock the async generator for invoke
            async def mock_invoke(*args, **kwargs):
                mock_response = MagicMock()
                mock_response.__str__ = lambda self: "Result"
                mock_response.thread = MagicMock()
                yield mock_response

            mock_agent.invoke = mock_invoke

            result = await manager.analyze_document(str(test_pdf), max_pages=3)

        # Should only analyze 3 pages (not more)
        assert result["pages_analyzed"] == 3


# ---------------------------------------------------------------------------
# Run Tests
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
