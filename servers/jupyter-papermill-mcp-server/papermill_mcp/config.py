"""
Configuration management for Papermill MCP Server.

Handles configuration from command line, environment variables, and config files.
"""

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Dict, Any
from pydantic import BaseModel, Field, validator


class JupyterServerConfig(BaseModel):
    """Configuration for Jupyter server connection."""
    base_url: str = Field(default="http://localhost:8888", description="Jupyter server base URL")
    token: str = Field(default="", description="Jupyter server authentication token")
    
    class Config:
        validate_assignment = True


class PapermillConfig(BaseModel):
    """Configuration for Papermill execution."""
    output_dir: str = Field(default="./outputs", description="Directory for output notebooks")
    timeout: int = Field(default=300, description="Execution timeout in seconds")
    kernel_name: Optional[str] = Field(default=None, description="Default kernel name")
    
    class Config:
        validate_assignment = True


class LoggingConfig(BaseModel):
    """Configuration for logging."""
    level: str = Field(default="INFO", description="Logging level")
    format: str = Field(
        default="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        description="Log format string"
    )
    
    @validator('level')
    def validate_level(cls, v):
        valid_levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']
        if v.upper() not in valid_levels:
            raise ValueError(f'Invalid log level: {v}. Must be one of {valid_levels}')
        return v.upper()
    
    class Config:
        validate_assignment = True


class MCPConfig(BaseModel):
    """Main configuration class for the MCP server."""
    jupyter_server: JupyterServerConfig = Field(default_factory=JupyterServerConfig)
    papermill: PapermillConfig = Field(default_factory=PapermillConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    offline_mode: bool = Field(default=False, description="Run in offline mode")
    skip_connection_check: bool = Field(default=False, description="Skip Jupyter server connection check")
    
    class Config:
        validate_assignment = True


@dataclass
class CommandLineOptions:
    """Command line options parsing result."""
    url: Optional[str] = None
    token: Optional[str] = None
    offline: bool = False
    skip_connection_check: bool = False
    config: Optional[str] = None
    help: bool = False
    log_level: Optional[str] = None
    output_dir: Optional[str] = None
    timeout: Optional[int] = None


class ConfigManager:
    """Configuration manager with layered configuration loading."""
    
    def __init__(self):
        self.config: Optional[MCPConfig] = None
        self._config_file_path: Optional[str] = None
    
    def load_config(self, options: Optional[CommandLineOptions] = None) -> MCPConfig:
        """
        Load configuration with priority order:
        1. Command line arguments
        2. Environment variables  
        3. Configuration file
        4. Default values
        """
        options = options or CommandLineOptions()
        
        # Start with default configuration
        config_dict = {}
        
        # Load from configuration file if specified
        config_file_path = self._determine_config_file_path(options)
        if config_file_path and Path(config_file_path).exists():
            try:
                config_dict = self._load_config_file(config_file_path)
                print(f"Configuration chargee depuis {config_file_path}")
                self._config_file_path = config_file_path
            except Exception as e:
                print(f"Erreur lors du chargement du fichier de configuration {config_file_path}: {e}")
                print("Utilisation des valeurs par defaut")
        else:
            if config_file_path:
                print(f"Fichier de configuration {config_file_path} non trouve, utilisation des valeurs par defaut")
        
        # Apply environment variables
        self._apply_environment_variables(config_dict)
        
        # Apply command line options
        self._apply_command_line_options(config_dict, options)
        
        # Create and validate the configuration
        self.config = MCPConfig.parse_obj(config_dict)
        
        return self.config
    
    def _determine_config_file_path(self, options: CommandLineOptions) -> Optional[str]:
        """Determine the configuration file path."""
        return (
            options.config or
            os.getenv('JUPYTER_MCP_CONFIG') or
            './config.json'
        )
    
    def _load_config_file(self, config_path: str) -> Dict[str, Any]:
        """Load configuration from JSON file."""
        with open(config_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def _apply_environment_variables(self, config_dict: Dict[str, Any]):
        """Apply environment variables to configuration."""
        # Jupyter server configuration
        if 'jupyter_server' not in config_dict:
            config_dict['jupyter_server'] = {}
        
        if os.getenv('JUPYTER_SERVER_URL'):
            config_dict['jupyter_server']['base_url'] = os.getenv('JUPYTER_SERVER_URL')
        
        if os.getenv('JUPYTER_SERVER_TOKEN'):
            config_dict['jupyter_server']['token'] = os.getenv('JUPYTER_SERVER_TOKEN')
        
        # Operational modes
        if os.getenv('JUPYTER_MCP_OFFLINE', '').lower() == 'true':
            config_dict['offline_mode'] = True
        
        if os.getenv('JUPYTER_SKIP_CONNECTION_CHECK', '').lower() == 'true':
            config_dict['skip_connection_check'] = True
        
        # Logging configuration
        if os.getenv('JUPYTER_MCP_LOG_LEVEL'):
            if 'logging' not in config_dict:
                config_dict['logging'] = {}
            config_dict['logging']['level'] = os.getenv('JUPYTER_MCP_LOG_LEVEL')
        
        # Papermill configuration
        if os.getenv('JUPYTER_MCP_OUTPUT_DIR'):
            if 'papermill' not in config_dict:
                config_dict['papermill'] = {}
            config_dict['papermill']['output_dir'] = os.getenv('JUPYTER_MCP_OUTPUT_DIR')
        
        if os.getenv('JUPYTER_MCP_TIMEOUT'):
            if 'papermill' not in config_dict:
                config_dict['papermill'] = {}
            try:
                config_dict['papermill']['timeout'] = int(os.getenv('JUPYTER_MCP_TIMEOUT'))
            except ValueError:
                print(f"Valeur invalide pour JUPYTER_MCP_TIMEOUT: {os.getenv('JUPYTER_MCP_TIMEOUT')}")
    
    def _apply_command_line_options(self, config_dict: Dict[str, Any], options: CommandLineOptions):
        """Apply command line options to configuration."""
        # Jupyter server configuration
        if options.url:
            if 'jupyter_server' not in config_dict:
                config_dict['jupyter_server'] = {}
            config_dict['jupyter_server']['base_url'] = options.url
        
        if options.token:
            if 'jupyter_server' not in config_dict:
                config_dict['jupyter_server'] = {}
            config_dict['jupyter_server']['token'] = options.token
        
        # Operational modes
        if options.offline:
            config_dict['offline_mode'] = True
        
        if options.skip_connection_check:
            config_dict['skip_connection_check'] = True
        
        # Logging configuration
        if options.log_level:
            if 'logging' not in config_dict:
                config_dict['logging'] = {}
            config_dict['logging']['level'] = options.log_level
        
        # Papermill configuration
        if options.output_dir:
            if 'papermill' not in config_dict:
                config_dict['papermill'] = {}
            config_dict['papermill']['output_dir'] = options.output_dir
        
        if options.timeout:
            if 'papermill' not in config_dict:
                config_dict['papermill'] = {}
            config_dict['papermill']['timeout'] = options.timeout
    
    def save_config(self, config_path: Optional[str] = None) -> str:
        """Save current configuration to file."""
        if not self.config:
            raise ValueError("No configuration loaded to save")
        
        path = config_path or self._config_file_path or './config.json'
        
        # Create directory if it doesn't exist
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(self.config.dict(), f, indent=2, ensure_ascii=False)
        
        return path
    
    @staticmethod
    def show_help():
        """Display help message for command line options."""
        help_message = """
Usage: python -m papermill_mcp.main [options]

Options:
  --url <url>               URL du serveur Jupyter (ex: http://localhost:8888)
  --token <token>           Token d'authentification du serveur Jupyter  
  --offline                 Demarrer en mode hors ligne (sans tentatives de connexion)
  --skip-connection-check   Ne pas verifier la connexion au serveur Jupyter
  --config <path>           Chemin vers un fichier de configuration personnalise
  --log-level <level>       Niveau de logging (DEBUG, INFO, WARNING, ERROR, CRITICAL)
  --output-dir <path>       Repertoire pour les notebooks de sortie Papermill
  --timeout <seconds>       Timeout d'execution pour Papermill (en secondes)
  --help                    Afficher cette aide

Exemples:
  python -m papermill_mcp.main --url http://localhost:8888 --token abc123
  python -m papermill_mcp.main --offline
  python -m papermill_mcp.main --config ./my-config.json

Variables d'environnement:
  JUPYTER_SERVER_URL          URL du serveur Jupyter
  JUPYTER_SERVER_TOKEN        Token d'authentification du serveur Jupyter
  JUPYTER_MCP_OFFLINE         Definir a 'true' pour le mode hors ligne
  JUPYTER_SKIP_CONNECTION_CHECK  Definir a 'true' pour eviter les verifications de connexion
  JUPYTER_MCP_CONFIG          Chemin vers un fichier de configuration personnalise
  JUPYTER_MCP_LOG_LEVEL       Niveau de logging
  JUPYTER_MCP_OUTPUT_DIR      Repertoire de sortie pour Papermill
  JUPYTER_MCP_TIMEOUT         Timeout d'execution pour Papermill (en secondes)
"""
        print(help_message)
        sys.exit(0)


# Instance globale du gestionnaire de configuration
config_manager = ConfigManager()


def get_config() -> MCPConfig:
    """Get the current configuration instance."""
    if config_manager.config is None:
        return config_manager.load_config()
    return config_manager.config


def reload_config(options: Optional[CommandLineOptions] = None) -> MCPConfig:
    """Reload configuration with new options."""
    return config_manager.load_config(options)