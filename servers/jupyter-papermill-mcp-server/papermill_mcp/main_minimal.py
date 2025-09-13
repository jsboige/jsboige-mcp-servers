#!/usr/bin/env python3
"""
Jupyter Papermill MCP Server - Version minimale
Point d'entrée ultra-simplifié utilisant uniquement le SDK MCP standard.
"""

import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

# Ajoutez les chemins parent au PYTHONPATH pour la découverte de modules
if "D:/dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server" not in sys.path:
    sys.path.insert(0, "D:/dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server")

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Créer l'instance du serveur
app = Server("jupyter-papermill-mcp-server")

@app.list_tools()
async def list_tools() -> List[Tool]:
    """List all available tools."""
    return [
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
            name="create_notebook",
            description="Crée un nouveau notebook Jupyter vide",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Chemin vers le nouveau fichier notebook"}
                },
                "required": ["path"]
            }
        ),
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
            name="test_connection",
            description="Test la connexion du serveur MCP",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        )
    ]

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> List[TextContent]:
    """Handle tool calls."""
    try:
        if name == "test_connection":
            return [TextContent(type="text", text="MCP Server is connected and working!")]
            
        elif name == "list_kernels":
            try:
                import subprocess
                result = subprocess.run(['jupyter', 'kernelspec', 'list', '--json'], 
                                      capture_output=True, text=True, timeout=10)
                if result.returncode == 0:
                    return [TextContent(type="text", text=result.stdout)]
                else:
                    return [TextContent(type="text", text=f"Error listing kernels: {result.stderr}")]
            except Exception as e:
                return [TextContent(type="text", text=f"Error: {str(e)}")]
                
        elif name == "create_notebook":
            path = arguments.get("path")
            if not path:
                return [TextContent(type="text", text="Error: path parameter required")]
            
            # Créer un notebook vide
            empty_notebook = {
                "cells": [],
                "metadata": {
                    "kernelspec": {
                        "display_name": "Python 3",
                        "language": "python",
                        "name": "python3"
                    },
                    "language_info": {
                        "name": "python",
                        "version": "3.10.0"
                    }
                },
                "nbformat": 4,
                "nbformat_minor": 4
            }
            
            try:
                file_path = Path(path)
                file_path.parent.mkdir(parents=True, exist_ok=True)
                
                with open(file_path, 'w', encoding='utf-8') as f:
                    json.dump(empty_notebook, f, indent=2)
                    
                return [TextContent(type="text", text=f"Notebook created successfully at: {path}")]
            except Exception as e:
                return [TextContent(type="text", text=f"Error creating notebook: {str(e)}")]
                
        elif name == "read_notebook":
            path = arguments.get("path")
            if not path:
                return [TextContent(type="text", text="Error: path parameter required")]
            
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    notebook_content = json.load(f)
                return [TextContent(type="text", text=json.dumps(notebook_content, indent=2))]
            except Exception as e:
                return [TextContent(type="text", text=f"Error reading notebook: {str(e)}")]
                
        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]
            
    except Exception as e:
        logger.error(f"Error in tool {name}: {e}")
        return [TextContent(type="text", text=f"Error: {e}")]

async def main():
    """Point d'entrée principal du serveur."""
    logger.info("Initializing Jupyter Papermill MCP Server (version minimale)")
    
    try:
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