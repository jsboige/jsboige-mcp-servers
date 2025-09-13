"""
Main entry point for the Jupyter Papermill MCP Server.

This module initializes and runs the FastMCP server with all tools registered.
"""

import asyncio
import logging
import sys
from pathlib import Path
from typing import Optional

# Import nest_asyncio at the top to handle nested event loops
try:
    import nest_asyncio
    nest_asyncio.apply()
except ImportError:
    pass  # Will be handled in cli_main if needed

from mcp.server.fastmcp import FastMCP

from .config import get_config, MCPConfig
from .tools.notebook_tools import register_notebook_tools, initialize_notebook_tools
from .tools.kernel_tools import register_kernel_tools, initialize_kernel_tools  
from .tools.execution_tools import register_execution_tools, initialize_execution_tools

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)


class JupyterPapermillMCPServer:
    """Main MCP Server class for Jupyter Papermill operations."""
    
    def __init__(self, config: Optional[MCPConfig] = None):
        """
        Initialize the MCP server.
        
        Args:
            config: Optional configuration object. If None, will load from default sources.
        """
        self.config = config or get_config()
        self.app = FastMCP("jupyter-papermill-mcp")
        self._initialized = False
    
    def initialize(self) -> None:
        """Initialize all services and register tools."""
        if self._initialized:
            logger.warning("Server already initialized")
            return
        
        try:
            logger.info("Initializing Jupyter Papermill MCP Server")
            logger.info(f"Configuration: {self.config}")
            
            # Initialize all tool services
            logger.info("Initializing notebook tools...")
            initialize_notebook_tools(self.config)
            
            logger.info("Initializing kernel tools...")
            initialize_kernel_tools(self.config)
            
            logger.info("Initializing execution tools...")
            initialize_execution_tools(self.config)
            
            # Register all tools with the FastMCP app
            logger.info("Registering notebook tools...")
            register_notebook_tools(self.app)
            
            logger.info("Registering kernel tools...")
            register_kernel_tools(self.app)
            
            logger.info("Registering execution tools...")
            register_execution_tools(self.app)
            
            self._initialized = True
            logger.info("Server initialization completed successfully")
            
            # Log available tools
            self._log_available_tools()
            
        except Exception as e:
            logger.error(f"Failed to initialize server: {e}")
            raise
    
    def _log_available_tools(self) -> None:
        """Log all available tools for debugging."""
        try:
            # This is a simplified version - in practice you'd access the FastMCP registry
            tools = [
                # Notebook tools
                "read_notebook", "write_notebook", "create_notebook", 
                "add_cell", "remove_cell", "update_cell",
                
                # Kernel tools  
                "list_kernels", "start_kernel", "stop_kernel", 
                "interrupt_kernel", "restart_kernel", "execute_cell",
                "execute_notebook", "execute_notebook_cell",
                
                # Execution tools
                "execute_notebook_papermill", "list_notebook_files", 
                "get_notebook_info", "get_kernel_status", "cleanup_all_kernels",
                "start_jupyter_server", "stop_jupyter_server", "debug_list_runtime_dir"
            ]
            
            logger.info(f"Available tools ({len(tools)}): {', '.join(tools)}")
            
        except Exception as e:
            logger.warning(f"Could not log available tools: {e}")
    
    async def run(self) -> None:
        """Run the MCP server."""
        if not self._initialized:
            self.initialize()
        
        try:
            logger.info("Starting Jupyter Papermill MCP Server...")
            logger.info(f"Server ready on stdin/stdout")
            
            # Use STDIO transport directly to avoid asyncio.run() conflicts
            from mcp.server.stdio import stdio_server
            
            async with stdio_server() as (read_stream, write_stream):
                await self.app.run(read_stream, write_stream, self.app.create_initialization_options())
            
        except KeyboardInterrupt:
            logger.info("Server interrupted by user")
        except Exception as e:
            logger.error(f"Server error: {e}")
            raise
        finally:
            await self.cleanup()
    
    async def cleanup(self) -> None:
        """Clean up server resources."""
        try:
            logger.info("Cleaning up server resources...")
            
            # Import here to avoid circular imports
            from .tools.kernel_tools import get_kernel_service
            
            try:
                kernel_service = get_kernel_service()
                await kernel_service.cleanup_kernels()
                logger.info("Cleaned up all kernels")
            except Exception as e:
                logger.warning(f"Error during kernel cleanup: {e}")
            
            logger.info("Server cleanup completed")
            
        except Exception as e:
            logger.error(f"Error during cleanup: {e}")


def create_app(config: Optional[MCPConfig] = None) -> JupyterPapermillMCPServer:
    """
    Create and initialize the MCP server application.
    
    Args:
        config: Optional configuration object
        
    Returns:
        Initialized MCP server instance
    """
    server = JupyterPapermillMCPServer(config)
    server.initialize()
    return server


async def main() -> None:
    """Main entry point for the server."""
    try:
        # Load configuration
        config = get_config()
        
        # Create and run server
        server = JupyterPapermillMCPServer(config)
        await server.run()
        
    except Exception as e:
        logger.error(f"Failed to start server: {e}")
        sys.exit(1)


def cli_main() -> None:
    """CLI entry point for the server."""
    try:
        # With nest_asyncio applied, we can use asyncio.run() even in nested contexts
        logger.info("Starting Jupyter Papermill MCP Server")
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
        sys.exit(0)
    except Exception as e:
        logger.error(f"Server failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    cli_main()