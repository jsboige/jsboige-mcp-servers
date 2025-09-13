#!/usr/bin/env python3
"""
Jupyter Papermill MCP Server - Version SDK MCP Standard

Migration from FastMCP to standard MCP SDK for compatibility with external MCP hosts.
"""

import asyncio
import logging
import sys
from typing import Any, Dict, List, Optional, Sequence, Union

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    Resource,
    Tool,
    TextContent,
    ImageContent,
    EmbeddedResource,
    LoggingLevel
)

from .config import get_config, MCPConfig
from .tools.notebook_tools import initialize_notebook_tools
from .tools.kernel_tools import initialize_kernel_tools  
from .tools.execution_tools import initialize_execution_tools

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class JupyterPapermillMCPServer:
    """Main MCP Server using standard MCP SDK."""
    
    def __init__(self, config: Optional[MCPConfig] = None):
        self.config = config or get_config()
        self.server = Server("jupyter-papermill-mcp-server")
        self._initialized = False
        
    def initialize(self) -> None:
        """Initialize the server and register all tools."""
        if self._initialized:
            return
            
        try:
            logger.info("Initializing Jupyter Papermill MCP Server")
            logger.info(f"Configuration: {self.config}")
            
            # Initialize services
            logger.info("Initializing notebook tools...")
            self.notebook_service = initialize_notebook_tools(self.config)
            
            logger.info("Initializing kernel tools...")
            self.kernel_service = initialize_kernel_tools(self.config)
            
            logger.info("Initializing execution tools...")
            self.execution_service = initialize_execution_tools(self.config)
            
            # Register tools
            self._register_notebook_tools()
            self._register_kernel_tools()
            self._register_execution_tools()
            
            logger.info("Server initialization completed successfully")
            self._log_available_tools()
            
            self._initialized = True
            
        except Exception as e:
            logger.error(f"Failed to initialize server: {e}")
            raise
            
    def _register_notebook_tools(self) -> None:
        """Register notebook management tools."""
        
        @self.server.call_tool
        async def read_notebook(arguments: dict) -> List[TextContent]:
            """Lit un notebook Jupyter à partir d'un fichier."""
            path = arguments.get("path")
            if not path:
                return [TextContent(type="text", text="Error: path parameter required")]
                
            try:
                result = await self.notebook_service.read_notebook(path)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def write_notebook(arguments: dict) -> List[TextContent]:
            """Écrit un notebook Jupyter dans un fichier."""
            path = arguments.get("path")
            content = arguments.get("content")
            if not path or not content:
                return [TextContent(type="text", text="Error: path and content parameters required")]
                
            try:
                result = await self.notebook_service.write_notebook(path, content)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def create_notebook(arguments: dict) -> List[TextContent]:
            """Crée un nouveau notebook vide."""
            path = arguments.get("path")
            kernel_name = arguments.get("kernel_name", "python3")
            if not path:
                return [TextContent(type="text", text="Error: path parameter required")]
                
            try:
                result = await self.notebook_service.create_notebook(path, kernel_name)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def add_cell(arguments: dict) -> List[TextContent]:
            """Ajoute une cellule à un notebook."""
            path = arguments.get("path")
            source = arguments.get("source", "")
            cell_type = arguments.get("cell_type", "code")
            index = arguments.get("index")
            
            if not path:
                return [TextContent(type="text", text="Error: path parameter required")]
                
            try:
                result = await self.notebook_service.add_cell(path, source, cell_type, index)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def remove_cell(arguments: dict) -> List[TextContent]:
            """Supprime une cellule d'un notebook."""
            path = arguments.get("path")
            index = arguments.get("index")
            
            if not path or index is None:
                return [TextContent(type="text", text="Error: path and index parameters required")]
                
            try:
                result = await self.notebook_service.remove_cell(path, index)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def update_cell(arguments: dict) -> List[TextContent]:
            """Modifie une cellule d'un notebook."""
            path = arguments.get("path")
            index = arguments.get("index")
            source = arguments.get("source")
            
            if not path or index is None or source is None:
                return [TextContent(type="text", text="Error: path, index and source parameters required")]
                
            try:
                result = await self.notebook_service.update_cell(path, index, source)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        logger.info("Registered notebook tools")
        
    def _register_kernel_tools(self) -> None:
        """Register kernel management tools."""
        
        @self.server.call_tool
        async def list_kernels(arguments: dict) -> List[TextContent]:
            """Liste tous les kernels Jupyter disponibles."""
            try:
                result = await self.kernel_service.list_kernels()
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def start_kernel(arguments: dict) -> List[TextContent]:
            """Démarre un nouveau kernel Jupyter."""
            kernel_name = arguments.get("kernel_name", "python3")
            try:
                result = await self.kernel_service.start_kernel(kernel_name)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def stop_kernel(arguments: dict) -> List[TextContent]:
            """Arrête un kernel spécifique."""
            kernel_id = arguments.get("kernel_id")
            if not kernel_id:
                return [TextContent(type="text", text="Error: kernel_id parameter required")]
                
            try:
                result = await self.kernel_service.stop_kernel(kernel_id)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def interrupt_kernel(arguments: dict) -> List[TextContent]:
            """Interrompt l'exécution d'un kernel."""
            kernel_id = arguments.get("kernel_id")
            if not kernel_id:
                return [TextContent(type="text", text="Error: kernel_id parameter required")]
                
            try:
                result = await self.kernel_service.interrupt_kernel(kernel_id)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def restart_kernel(arguments: dict) -> List[TextContent]:
            """Redémarre un kernel spécifique."""
            kernel_id = arguments.get("kernel_id")
            if not kernel_id:
                return [TextContent(type="text", text="Error: kernel_id parameter required")]
                
            try:
                result = await self.kernel_service.restart_kernel(kernel_id)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def execute_cell(arguments: dict) -> List[TextContent]:
            """Exécute une cellule de code dans un kernel."""
            kernel_id = arguments.get("kernel_id")
            source = arguments.get("source")
            
            if not kernel_id or not source:
                return [TextContent(type="text", text="Error: kernel_id and source parameters required")]
                
            try:
                result = await self.kernel_service.execute_cell(kernel_id, source)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def get_kernel_status(arguments: dict) -> List[TextContent]:
            """Obtient le statut d'un kernel."""
            kernel_id = arguments.get("kernel_id")
            if not kernel_id:
                return [TextContent(type="text", text="Error: kernel_id parameter required")]
                
            try:
                result = await self.kernel_service.get_kernel_status(kernel_id)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def cleanup_all_kernels(arguments: dict) -> List[TextContent]:
            """Nettoie tous les kernels actifs."""
            try:
                result = await self.kernel_service.cleanup_kernels()
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        logger.info("Registered kernel tools")
        
    def _register_execution_tools(self) -> None:
        """Register execution and Papermill tools."""
        
        @self.server.call_tool
        async def execute_notebook(arguments: dict) -> List[TextContent]:
            """Exécute un notebook complet avec un kernel."""
            path = arguments.get("path")
            kernel_name = arguments.get("kernel_name", "python3")
            
            if not path:
                return [TextContent(type="text", text="Error: path parameter required")]
                
            try:
                result = await self.execution_service.execute_notebook(path, kernel_name)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def execute_notebook_cell(arguments: dict) -> List[TextContent]:
            """Exécute une cellule spécifique d'un notebook."""
            path = arguments.get("path")
            cell_index = arguments.get("cell_index")
            kernel_name = arguments.get("kernel_name", "python3")
            
            if not path or cell_index is None:
                return [TextContent(type="text", text="Error: path and cell_index parameters required")]
                
            try:
                result = await self.execution_service.execute_notebook_cell(path, cell_index, kernel_name)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def execute_notebook_papermill(arguments: dict) -> List[TextContent]:
            """Exécute un notebook avec Papermill et paramètres."""
            input_path = arguments.get("input_path")
            output_path = arguments.get("output_path")
            parameters = arguments.get("parameters", {})
            kernel_name = arguments.get("kernel_name")
            
            if not input_path or not output_path:
                return [TextContent(type="text", text="Error: input_path and output_path parameters required")]
                
            try:
                result = await self.execution_service.execute_notebook_papermill(
                    input_path, output_path, parameters, kernel_name
                )
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def list_notebook_files(arguments: dict) -> List[TextContent]:
            """Liste les fichiers notebook dans un répertoire."""
            directory = arguments.get("directory", ".")
            pattern = arguments.get("pattern", "*.ipynb")
            
            try:
                result = await self.execution_service.list_notebook_files(directory, pattern)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def get_notebook_info(arguments: dict) -> List[TextContent]:
            """Obtient les informations sur un notebook."""
            path = arguments.get("path")
            if not path:
                return [TextContent(type="text", text="Error: path parameter required")]
                
            try:
                result = await self.execution_service.get_notebook_info(path)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def start_jupyter_server(arguments: dict) -> List[TextContent]:
            """Démarre un serveur Jupyter local."""
            port = arguments.get("port", 8888)
            try:
                result = await self.execution_service.start_jupyter_server(port)
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def stop_jupyter_server(arguments: dict) -> List[TextContent]:
            """Arrête le serveur Jupyter local."""
            try:
                result = await self.execution_service.stop_jupyter_server()
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        @self.server.call_tool
        async def debug_list_runtime_dir(arguments: dict) -> List[TextContent]:
            """Debug: liste le contenu du répertoire runtime Jupyter."""
            try:
                result = await self.execution_service.debug_list_runtime_dir()
                return [TextContent(type="text", text=str(result))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]
                
        logger.info("Registered execution tools")
        
    def _log_available_tools(self) -> None:
        """Log all available tools for debugging."""
        tools = [
            # Notebook tools
            "read_notebook", "write_notebook", "create_notebook", 
            "add_cell", "remove_cell", "update_cell",
            
            # Kernel tools  
            "list_kernels", "start_kernel", "stop_kernel", 
            "interrupt_kernel", "restart_kernel", "execute_cell",
            "get_kernel_status", "cleanup_all_kernels",
            
            # Execution tools
            "execute_notebook", "execute_notebook_cell", "execute_notebook_papermill", 
            "list_notebook_files", "get_notebook_info", 
            "start_jupyter_server", "stop_jupyter_server", "debug_list_runtime_dir"
        ]
        
        logger.info(f"Available tools ({len(tools)}): {', '.join(tools)}")
        
    async def run(self) -> None:
        """Run the MCP server using STDIO."""
        if not self._initialized:
            self.initialize()
            
        try:
            logger.info("Starting Jupyter Papermill MCP Server...")
            logger.info("Server ready on stdin/stdout")
            
            # Use stdio_server for MCP communication
            await stdio_server(self.server)
                
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
            
            # Cleanup kernels
            try:
                if hasattr(self, 'kernel_service'):
                    await self.kernel_service.cleanup_kernels()
                logger.info("Cleaned up all kernels")
            except Exception as e:
                logger.warning(f"Error during kernel cleanup: {e}")
                
            logger.info("Server cleanup completed")
            
        except Exception as e:
            logger.error(f"Error during cleanup: {e}")


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
        logger.info("Starting MCP server with standard SDK")
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
        sys.exit(0)
    except Exception as e:
        logger.error(f"Server failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    cli_main()