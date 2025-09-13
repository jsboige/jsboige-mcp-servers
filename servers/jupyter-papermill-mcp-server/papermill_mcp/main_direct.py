#!/usr/bin/env python3
"""
Jupyter Papermill MCP Server - Version protocole direct
Implémentation directe du protocole JSON-RPC pour éviter les problèmes asyncio/TaskGroup.
"""

import json
import sys
import logging
import subprocess
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class MCPServer:
    def __init__(self):
        self.tools = [
            {
                "name": "test_connection",
                "description": "Test la connexion du serveur MCP",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            },
            {
                "name": "list_kernels",
                "description": "Liste tous les kernels Jupyter disponibles",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            },
            {
                "name": "create_notebook",
                "description": "Crée un nouveau notebook Jupyter vide",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Chemin vers le nouveau fichier notebook"}
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "read_notebook",
                "description": "Lit un notebook Jupyter à partir d'un fichier",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Chemin vers le fichier notebook"}
                    },
                    "required": ["path"]
                }
            }
        ]

    def handle_message(self, message):
        """Handle incoming JSON-RPC message."""
        try:
            if message.get("method") == "tools/list":
                return {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "result": {
                        "tools": self.tools
                    }
                }
            elif message.get("method") == "tools/call":
                return self.handle_tool_call(message)
            elif message.get("method") == "initialize":
                return {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {
                            "tools": {}
                        },
                        "serverInfo": {
                            "name": "jupyter-papermill-mcp-server",
                            "version": "1.0.0"
                        }
                    }
                }
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "error": {
                        "code": -32601,
                        "message": "Method not found"
                    }
                }
        except Exception as e:
            logger.error(f"Error handling message: {e}")
            return {
                "jsonrpc": "2.0",
                "id": message.get("id"),
                "error": {
                    "code": -32603,
                    "message": f"Internal error: {e}"
                }
            }

    def handle_tool_call(self, message):
        """Handle tool call requests."""
        params = message.get("params", {})
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        
        try:
            if tool_name == "test_connection":
                result = "MCP Server is connected and working!"
                
            elif tool_name == "list_kernels":
                try:
                    result = subprocess.run(['jupyter', 'kernelspec', 'list', '--json'], 
                                          capture_output=True, text=True, timeout=10)
                    if result.returncode == 0:
                        result = result.stdout
                    else:
                        result = f"Error listing kernels: {result.stderr}"
                except Exception as e:
                    result = f"Error: {str(e)}"
                    
            elif tool_name == "create_notebook":
                path = arguments.get("path")
                if not path:
                    result = "Error: path parameter required"
                else:
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
                            
                        result = f"Notebook created successfully at: {path}"
                    except Exception as e:
                        result = f"Error creating notebook: {str(e)}"
                        
            elif tool_name == "read_notebook":
                path = arguments.get("path")
                if not path:
                    result = "Error: path parameter required"
                else:
                    try:
                        with open(path, 'r', encoding='utf-8') as f:
                            notebook_content = json.load(f)
                        result = json.dumps(notebook_content, indent=2)
                    except Exception as e:
                        result = f"Error reading notebook: {str(e)}"
                        
            else:
                result = f"Unknown tool: {tool_name}"
                
            return {
                "jsonrpc": "2.0",
                "id": message.get("id"),
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": result
                        }
                    ]
                }
            }
            
        except Exception as e:
            logger.error(f"Error in tool {tool_name}: {e}")
            return {
                "jsonrpc": "2.0",
                "id": message.get("id"),
                "error": {
                    "code": -32603,
                    "message": f"Tool execution error: {e}"
                }
            }

    def run(self):
        """Main server loop."""
        logger.info("Starting Jupyter Papermill MCP Server (version direct)")
        
        try:
            while True:
                line = sys.stdin.readline()
                if not line:
                    break
                    
                try:
                    message = json.loads(line.strip())
                    response = self.handle_message(message)
                    if response:
                        print(json.dumps(response), flush=True)
                except json.JSONDecodeError:
                    logger.error(f"Invalid JSON received: {line}")
                except Exception as e:
                    logger.error(f"Error processing message: {e}")
                    
        except KeyboardInterrupt:
            logger.info("Server stopped by user")
        except Exception as e:
            logger.error(f"Server error: {e}")
            sys.exit(1)

if __name__ == "__main__":
    server = MCPServer()
    server.run()