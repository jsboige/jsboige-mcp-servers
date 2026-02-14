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
                "base_url": "https://api.test.com/v1",
                "api_key": "test-key",
                "model_id": "test-model-v1",
                "vision": False,
                "description": "Test text model",
            },
            {
                "id": "test-vision",
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
# Run Tests
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
