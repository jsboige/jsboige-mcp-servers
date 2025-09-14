#!/usr/bin/env python3
"""
Jupyter Papermill MCP Server - Version ultra-basique pour test
"""

import asyncio
import json
import logging
import sys
from typing import Any, Dict, List

# Ajout du chemin pour les imports (version portable)
import os
current_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

# Configuration logging minimal
logging.basicConfig(level=logging.ERROR)
logger = logging.getLogger(__name__)

# Créer le serveur
app = Server("jupyter-papermill-mcp-server")

@app.list_resources()
async def list_resources():
    """Liste les ressources disponibles (aucune pour l'instant)"""
    return []

@app.list_tools()
async def list_tools() -> List[Tool]:
    """Liste les outils disponibles - version minimale pour test"""
    return [
        Tool(
            name="test_connection",
            description="Test de connexion du serveur MCP",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="list_kernels",
            description="Liste les kernels Jupyter disponibles",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        )
    ]

@app.call_tool()
async def handle_tool_call(name: str, arguments: Dict[str, Any]) -> List[TextContent]:
    """Gestionnaire d'appels d'outils"""
    
    if name == "test_connection":
        return [TextContent(type="text", text="✅ Serveur Jupyter-Papermill MCP connecté avec succès!")]
        
    elif name == "list_kernels":
        # Version simplifiée pour tester la connexion
        return [TextContent(type="text", text="🔧 Fonction list_kernels prête - serveur opérationnel")]
        
    else:
        return [TextContent(type="text", text=f"❌ Outil inconnu: {name}")]

def main():
    """Point d'entrée principal"""
    async def run():
        async with stdio_server() as streams:
            await app.run(streams[0], streams[1], {})
    
    asyncio.run(run())

if __name__ == "__main__":
    main()