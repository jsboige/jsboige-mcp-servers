"""
CONSOLIDATED Jupyter Papermill MCP Server - Main Entry Point

Unified implementation combining:
- Architecture modulaire (services ? tools)
- Fonctionnalites du monolithique optimisees
- Gestion d'erreurs avancee
- Configuration consolidee

Version finale avec 32 outils unifies
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
    # Silent success - stdout reserved for MCP protocol
except ImportError:
    # Silent failure - stdout reserved for MCP protocol
    pass

from mcp.server.fastmcp import FastMCP

from .config import get_config, MCPConfig
from .tools.notebook_tools import register_notebook_tools, initialize_notebook_tools
from .tools.kernel_tools import register_kernel_tools, initialize_kernel_tools
from .tools.execution_tools import register_execution_tools, initialize_execution_tools

# Configure logging with enhanced format
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)


class JupyterPapermillMCPServer:
    """
    Consolidated MCP Server for Jupyter Papermill operations.
    
    Combines modular architecture with monolithic optimizations:
    - 32 unified tools across 3 modules
    - Enhanced error handling and diagnostics
    - Nest asyncio compatibility
    - Working directory fixes for .NET
    """
    
    def __init__(self, config: Optional[MCPConfig] = None):
        """
        Initialize the consolidated MCP server.
        
        Args:
            config: Optional configuration object. If None, loads from default sources.
        """
        self.config = config or get_config()
        self.app = FastMCP("Jupyter-Papermill MCP Server Consolidated")
        self._initialized = False
        
        logger.info("Initializing Consolidated Jupyter Papermill MCP Server")
        logger.info(f"Server name: {self.app.name}")
    
    def initialize(self) -> None:
        """Initialize all services and register consolidated tools."""
        if self._initialized:
            logger.warning("Server already initialized")
            return
        
        try:
            logger.info("Starting Consolidated Server Initialization...")
            logger.info(f"Configuration: {self.config}")
            
            # Phase 1: Initialize all tool services
            logger.info("Initializing notebook tools...")
            initialize_notebook_tools(self.config)
            
            logger.info("Initializing kernel tools...")
            initialize_kernel_tools(self.config)
            
            logger.info("Initializing execution tools...")
            initialize_execution_tools(self.config)
            
            # Phase 2: Register all tools with the FastMCP app
            logger.info("[NOTE] Registering notebook tools (13 tools)...")
            register_notebook_tools(self.app)
            
            logger.info("[PLUGIN] Registering kernel tools (6 tools)...")
            register_kernel_tools(self.app)
            
            logger.info("Registering execution tools (13 tools)...")
            register_execution_tools(self.app)
            
            self._initialized = True
            logger.info("[OK] Server initialization completed successfully")
            
            # Log consolidated tool summary
            self._log_consolidated_tools()
            
        except Exception as e:
            logger.error(f"[ERROR] Failed to initialize server: {e}")
            raise
    
    def _log_consolidated_tools(self) -> None:
        """Log all consolidated tools with enhanced organization."""
        try:
            notebook_tools = [
                "read_notebook", "write_notebook", "create_notebook",
                "add_cell", "remove_cell", "update_cell", "read_cell", "read_cells_range",
                "list_notebook_cells", "get_notebook_metadata", "inspect_notebook_outputs",
                "validate_notebook", "system_info"
            ]
            
            kernel_tools = [
                "list_kernels", "start_kernel", "stop_kernel",
                "interrupt_kernel", "restart_kernel", "execute_cell"
            ]
            
            execution_tools = [
                "execute_notebook_papermill", "list_notebook_files", "get_notebook_info",
                "get_kernel_status", "cleanup_all_kernels", "start_jupyter_server",
                "stop_jupyter_server", "debug_list_runtime_dir", "execute_notebook_solution_a",
                "parameterize_notebook", "execute_notebook_cell", "get_execution_status"
            ]
            
            total_tools = len(notebook_tools) + len(kernel_tools) + len(execution_tools)
            
            logger.info("=" * 60)
            logger.info("CONSOLIDATED TOOLS SUMMARY")
            logger.info("=" * 60)
            logger.info(f"Notebook Tools ({len(notebook_tools)}): {', '.join(notebook_tools)}")
            logger.info(f"Kernel Tools ({len(kernel_tools)}): {', '.join(kernel_tools)}")
            logger.info(f"Execution Tools ({len(execution_tools)}): {', '.join(execution_tools)}")
            logger.info("=" * 60)
            logger.info(f"TOTAL CONSOLIDATED TOOLS: {total_tools}")
            logger.info("=" * 60)
            
        except Exception as e:
            logger.warning(f"Could not log consolidated tools: {e}")
    
    async def run(self) -> None:
        """Run the consolidated MCP server with enhanced error handling."""
        if not self._initialized:
            self.initialize()
        
        try:
            logger.info("Starting Consolidated Jupyter Papermill MCP Server...")
            logger.info("Server ready on stdin/stdout")
            logger.info("Waiting for MCP client connection...")
            
            # Use FastMCP's async STDIO method directly
            await self.app.run_stdio_async()
            
        except KeyboardInterrupt:
            logger.info("Server interrupted by user")
        except Exception as e:
            logger.error(f"Server error: {e}")
            logger.error(f"Error type: {type(e).__name__}")
            raise
        finally:
            await self.cleanup()
    
    async def cleanup(self) -> None:
        """Clean up server resources with enhanced logging."""
        try:
            logger.info("Cleaning up server resources...")
            
            # Import here to avoid circular imports
            try:
                from .tools.kernel_tools import get_kernel_service
                kernel_service = get_kernel_service()
                await kernel_service.cleanup_kernels()
                logger.info("Cleaned up all kernels")
            except Exception as cleanup_error:
                logger.warning(f"WARNING: Kernel cleanup error (non-critical): {cleanup_error}")
            except Exception as e:
                logger.warning(f"Error during kernel cleanup: {e}")
            
            logger.info("[OK] Server cleanup completed")
            
        except Exception as e:
            logger.error(f"[ERROR] Error during cleanup: {e}")


def create_app(config: Optional[MCPConfig] = None) -> JupyterPapermillMCPServer:
    """
    Create and initialize the consolidated MCP server application.
    
    Args:
        config: Optional configuration object
        
    Returns:
        Initialized consolidated MCP server instance
    """
    server = JupyterPapermillMCPServer(config)
    server.initialize()
    return server


async def main() -> None:
    """Main entry point for the consolidated server."""
    try:
        logger.info("Loading configuration...")
        config = get_config()
        
        logger.info("Creating consolidated server...")
        server = JupyterPapermillMCPServer(config)
        
        logger.info("Starting server execution...")
        await server.run()
        
    except Exception as e:
        logger.error(f"ERROR: Failed to start server: {e}")
        logger.error(f"Error type: {type(e).__name__}")
        sys.exit(1)


def cli_main() -> None:
    """
    CLI entry point for the consolidated server.
    Enhanced with better error reporting and nest_asyncio support.
    """
    try:
        logger.info("=" * 60)
        logger.info("CONSOLIDATED JUPYTER PAPERMILL MCP SERVER")
        logger.info("Architecture: Modular + Monolithic Optimizations")
        logger.info("Tools: 32 Unified Tools")
        logger.info("Framework: FastMCP")
        logger.info("=" * 60)
        
        # Initialize and run server synchronously via FastMCP
        server = JupyterPapermillMCPServer()
        server.app.run("stdio")
        
    except KeyboardInterrupt:
        logger.info("[STOP] Server stopped by user")
        sys.exit(0)
    except Exception as e:
        logger.error(f"Server failed: {e}")
        logger.error(f"Error type: {type(e).__name__}")
        import traceback
        logger.error(f"Traceback:\n{traceback.format_exc()}")
        sys.exit(1)


if __name__ == "__main__":
    cli_main()