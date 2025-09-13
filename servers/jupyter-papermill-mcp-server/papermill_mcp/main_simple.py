#!/usr/bin/env python3
"""
Jupyter Papermill MCP Server - Version simple et directe
Point d'entrée utilisant le SDK MCP standard sans conflits asyncio.
"""

import asyncio
import logging
import sys
from typing import Any, Dict, List, Optional, Sequence

# Ajoutez les chemins parent au PYTHONPATH pour la découverte de modules
if "D:/dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server" not in sys.path:
    sys.path.insert(0, "D:/dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server")
if "D:/dev/roo-extensions/mcps/internal/servers" not in sys.path:
    sys.path.insert(0, "D:/dev/roo-extensions/mcps/internal/servers")

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool, CallToolRequest

from .config import get_config
from .tools.notebook_tools import initialize_notebook_tools
from .tools.kernel_tools import initialize_kernel_tools
from .tools.execution_tools import initialize_execution_tools

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Créer l'instance du serveur
app = Server("jupyter-papermill-mcp-server")

# Configuration globale
config = get_config()

# Services globaux (initialisés dans main)
notebook_service = None
kernel_service = None
execution_service = None


# === DÉFINITION DES OUTILS ===

@app.list_tools()
async def list_tools() -> List[Tool]:
    """List all available tools."""
    return [
        Tool(
            name="read_notebook",
            description="Lit un notebook Jupyter à partir d'un fichier",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin vers le fichier notebook"}
                },
                "required": ["path"]
            }
        ),
        Tool(
            name="write_notebook",
            description="Écrit un notebook Jupyter dans un fichier",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin vers le fichier notebook"},
                    "content": {"type": "object", "description": "Contenu du notebook"}
                },
                "required": ["path", "content"]
            }
        ),
        Tool(
            name="create_notebook",
            description="Crée un nouveau notebook Jupyter",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin vers le nouveau fichier notebook"}
                },
                "required": ["path"]
            }
        ),
        Tool(
            name="list_kernels",
            description="Liste tous les kernels Jupyter disponibles",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="start_kernel",
            description="Démarre un nouveau kernel Jupyter",
            inputSchema={
                "type": "object",
                "properties": {
                    "kernel_name": {"type": "string", "description": "Nom du kernel à démarrer"}
                },
                "required": []
            }
        ),
        Tool(
            name="execute_notebook_papermill",
            description="Exécute un notebook avec Papermill",
            inputSchema={
                "type": "object",
                "properties": {
                    "input_path": {"type": "string", "description": "Chemin du notebook d'entrée"},
                    "output_path": {"type": "string", "description": "Chemin du notebook de sortie"},
                    "parameters": {"type": "object", "description": "Paramètres pour le notebook"},
                    "kernel_name": {"type": "string", "description": "Nom du kernel"}
                },
                "required": ["input_path", "output_path"]
            }
        )
    ]


# === GESTION DES OUTILS ===

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> List[TextContent]:
    """Handle tool calls."""
    try:
        if name == "read_notebook":
            path = arguments.get("path")
            if not path:
                return [TextContent(type="text", text="Error: path parameter required")]
            result = await notebook_service.read_notebook(path)
            return [TextContent(type="text", text=str(result))]
            
        elif name == "write_notebook":
            path = arguments.get("path")
            content = arguments.get("content")
            if not path or not content:
                return [TextContent(type="text", text="Error: path and content parameters required")]
            result = await notebook_service.write_notebook(path, content)
            return [TextContent(type="text", text=str(result))]
            
        elif name == "create_notebook":
            path = arguments.get("path")
            if not path:
                return [TextContent(type="text", text="Error: path parameter required")]
            result = await notebook_service.create_notebook(path)
            return [TextContent(type="text", text=str(result))]
            
        elif name == "list_kernels":
            result = await kernel_service.list_kernels()
            return [TextContent(type="text", text=str(result))]
            
        elif name == "start_kernel":
            kernel_name = arguments.get("kernel_name")
            result = await kernel_service.start_kernel(kernel_name)
            return [TextContent(type="text", text=str(result))]
            
        elif name == "execute_notebook_papermill":
            input_path = arguments.get("input_path")
            output_path = arguments.get("output_path")
            parameters = arguments.get("parameters", {})
            kernel_name = arguments.get("kernel_name")
            if not input_path or not output_path:
                return [TextContent(type="text", text="Error: input_path and output_path parameters required")]
            result = await execution_service.execute_notebook_papermill(input_path, output_path, parameters, kernel_name)
            return [TextContent(type="text", text=str(result))]
            
        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]
            
    except Exception as e:
        logger.error(f"Error in tool {name}: {e}")
        return [TextContent(type="text", text=f"Error: {e}")]


# === MAIN FUNCTION ===

async def main():
    """Point d'entrée principal du serveur."""
    global notebook_service, kernel_service, execution_service
    
    logger.info("Initializing Jupyter Papermill MCP Server (version simple)")
    logger.info(f"Configuration: {config}")
    
    # Initialiser les services
    try:
        logger.info("Initializing services...")
        notebook_service = initialize_notebook_tools(config)
        kernel_service = initialize_kernel_tools(config)
        execution_service = initialize_execution_tools(config)
        logger.info("Services initialized successfully")
        
        # Démarrer le serveur STDIO
        logger.info("Starting MCP server...")
        async with stdio_server() as (read_stream, write_stream):
            await app.run(read_stream, write_stream)
            
    except Exception as e:
        logger.error(f"Server failed: {e}")
        raise


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
        sys.exit(0)
    except Exception as e:
        logger.error(f"Server error: {e}")
        sys.exit(1)