"""
Tests for configuration management.
"""

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from papermill_mcp.config import MCPConfig, ConfigManager


class TestMCPConfig:
    """Test MCPConfig model."""
    
    def test_default_config(self):
        """Test default configuration values."""
        config = MCPConfig()
        
        assert config.jupyter_timeout == 300
        assert config.execution_timeout == 60.0
        assert config.continue_on_error is False
        assert config.output_directory == Path("./outputs")
        assert config.log_level == "INFO"
        assert config.max_kernels == 10
    
    def test_config_validation(self):
        """Test configuration validation."""
        # Valid config
        config = MCPConfig(
            jupyter_timeout=120,
            execution_timeout=30.0,
            log_level="DEBUG"
        )
        assert config.jupyter_timeout == 120
        assert config.execution_timeout == 30.0
        assert config.log_level == "DEBUG"
        
        # Invalid log level should raise validation error
        with pytest.raises(ValueError):
            MCPConfig(log_level="INVALID")
    
    def test_config_from_dict(self):
        """Test creating config from dictionary."""
        data = {
            "jupyter_timeout": 180,
            "execution_timeout": 45.0,
            "continue_on_error": True,
            "output_directory": "/tmp/outputs",
            "log_level": "WARNING",
            "max_kernels": 5
        }
        
        config = MCPConfig(**data)
        assert config.jupyter_timeout == 180
        assert config.execution_timeout == 45.0
        assert config.continue_on_error is True
        assert config.output_directory == Path("/tmp/outputs")
        assert config.log_level == "WARNING"
        assert config.max_kernels == 5


class TestConfigManager:
    """Test ConfigManager functionality."""
    
    def test_load_default_config(self):
        """Test loading default configuration."""
        config = ConfigManager.load_config()
        
        assert isinstance(config, MCPConfig)
        assert config.jupyter_timeout == 300
        assert config.log_level == "INFO"
    
    def test_load_config_from_file(self):
        """Test loading configuration from JSON file."""
        config_data = {
            "jupyter_timeout": 240,
            "execution_timeout": 90.0,
            "log_level": "DEBUG",
            "max_kernels": 8
        }
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(config_data, f)
            config_path = f.name
        
        try:
            config = ConfigManager.load_config(config_path=config_path)
            
            assert config.jupyter_timeout == 240
            assert config.execution_timeout == 90.0
            assert config.log_level == "DEBUG"
            assert config.max_kernels == 8
            
        finally:
            os.unlink(config_path)
    
    def test_load_config_from_env_vars(self):
        """Test loading configuration from environment variables."""
        env_vars = {
            "JUPYTER_MCP_JUPYTER_TIMEOUT": "150",
            "JUPYTER_MCP_EXECUTION_TIMEOUT": "75.5",
            "JUPYTER_MCP_CONTINUE_ON_ERROR": "true",
            "JUPYTER_MCP_LOG_LEVEL": "ERROR",
            "JUPYTER_MCP_MAX_KERNELS": "15"
        }
        
        with patch.dict(os.environ, env_vars):
            config = ConfigManager.load_config()
            
            assert config.jupyter_timeout == 150
            assert config.execution_timeout == 75.5
            assert config.continue_on_error is True
            assert config.log_level == "ERROR"
            assert config.max_kernels == 15
    
    def test_load_config_priority(self):
        """Test configuration loading priority (CLI > env > file > defaults)."""
        # Create a config file
        file_config = {
            "jupyter_timeout": 200,
            "execution_timeout": 50.0,
            "log_level": "WARNING"
        }
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(file_config, f)
            config_path = f.name
        
        # Set environment variables
        env_vars = {
            "JUPYTER_MCP_JUPYTER_TIMEOUT": "300",  # Should override file
            "JUPYTER_MCP_EXECUTION_TIMEOUT": "60.0"  # Should override file
            # log_level not set, should use file value
        }
        
        try:
            with patch.dict(os.environ, env_vars):
                config = ConfigManager.load_config(config_path=config_path)
                
                # Env vars should override file
                assert config.jupyter_timeout == 300
                assert config.execution_timeout == 60.0
                # File value should be used when env var not set
                assert config.log_level == "WARNING"
                
        finally:
            os.unlink(config_path)
    
    def test_load_config_missing_file(self):
        """Test loading configuration when file doesn't exist."""
        # Should not raise error, should use defaults
        config = ConfigManager.load_config(config_path="/nonexistent/path.json")
        
        # Should fall back to defaults
        assert config.jupyter_timeout == 300
        assert config.log_level == "INFO"
    
    def test_load_config_invalid_json(self):
        """Test loading configuration from invalid JSON file."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            f.write("invalid json content")
            config_path = f.name
        
        try:
            # Should not raise error, should use defaults
            config = ConfigManager.load_config(config_path=config_path)
            assert config.jupyter_timeout == 300
            assert config.log_level == "INFO"
            
        finally:
            os.unlink(config_path)
    
    def test_config_path_expansion(self):
        """Test path expansion in configuration."""
        config_data = {
            "output_directory": "~/test_outputs"
        }
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(config_data, f)
            config_path = f.name
        
        try:
            config = ConfigManager.load_config(config_path=config_path)
            
            # Path should be expanded
            assert str(config.output_directory).startswith(str(Path.home()))
            assert str(config.output_directory).endswith("test_outputs")
            
        finally:
            os.unlink(config_path)
    
    def test_boolean_env_vars(self):
        """Test boolean environment variable parsing."""
        test_cases = [
            ("true", True),
            ("True", True),
            ("TRUE", True),
            ("1", True),
            ("yes", True),
            ("false", False),
            ("False", False),
            ("FALSE", False),
            ("0", False),
            ("no", False),
        ]
        
        for env_value, expected in test_cases:
            env_vars = {"JUPYTER_MCP_CONTINUE_ON_ERROR": env_value}
            
            with patch.dict(os.environ, env_vars):
                config = ConfigManager.load_config()
                assert config.continue_on_error == expected, f"Failed for value: {env_value}"


if __name__ == "__main__":
    pytest.main([__file__])