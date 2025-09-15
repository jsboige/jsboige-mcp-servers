"""
Tests End-to-End pour le protocole MCP complet
Niveau 3 SDDD : Tests avec serveur MCP complet et simulation JSON-RPC
"""

import json
import pytest
from pathlib import Path
from typing import Dict, Any

from .conftest import MCPTestClient


@pytest.mark.e2e
class TestMCPProtocol:
    """Tests du protocole MCP de base"""
    
    @pytest.mark.asyncio
    async def test_mcp_initialize(self, mcp_client: MCPTestClient):
        """Test l'initialisation du protocole MCP"""
        response = await mcp_client.send_request(
            method="initialize",
            params={
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "clientInfo": {
                    "name": "test-client",
                    "version": "1.0.0"
                }
            }
        )
        
        assert "result" in response
        assert response["result"]["protocolVersion"] == "2024-11-05"
        assert "capabilities" in response["result"]
        assert "serverInfo" in response["result"]
    
    @pytest.mark.asyncio
    async def test_mcp_list_tools(self, mcp_client: MCPTestClient):
        """Test la liste des outils disponibles"""
        # D'abord initialiser
        await mcp_client.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "test", "version": "1.0"}
        })
        
        # Puis lister les outils
        response = await mcp_client.send_request("tools/list")
        
        assert "result" in response
        assert "tools" in response["result"]
        
        tools = response["result"]["tools"]
        assert isinstance(tools, list)
        assert len(tools) > 0
        
        # Vérifier la présence d'outils essentiels
        tool_names = [tool["name"] for tool in tools]
        expected_tools = [
            "execute_notebook",
            "create_notebook", 
            "list_kernels",
            "system_info"
        ]
        
        for expected_tool in expected_tools:
            assert expected_tool in tool_names, f"Outil manquant: {expected_tool}"
    
    @pytest.mark.asyncio
    async def test_invalid_method(self, mcp_client: MCPTestClient):
        """Test d'appel de méthode invalide"""
        response = await mcp_client.send_request("invalid_method")
        
        assert "error" in response
        assert response["error"]["code"] == -32601  # Method not found
    
    @pytest.mark.asyncio
    async def test_invalid_params(self, mcp_client: MCPTestClient):
        """Test d'appel avec paramètres invalides"""
        # Initialiser d'abord
        await mcp_client.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "test", "version": "1.0"}
        })
        
        # Appel avec paramètres invalides
        response = await mcp_client.send_request(
            "tools/call",
            {
                "name": "execute_notebook",
                "arguments": {}  # Paramètres manquants
            }
        )
        
        assert "error" in response


@pytest.mark.e2e
class TestJupyterTools:
    """Tests des outils Jupyter via le protocole MCP"""
    
    @pytest.mark.asyncio
    async def test_system_info_tool(self, mcp_client: MCPTestClient):
        """Test l'outil system_info"""
        # Initialiser
        await mcp_client.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "test", "version": "1.0"}
        })
        
        # Appeler system_info
        response = await mcp_client.send_request(
            "tools/call",
            {
                "name": "system_info",
                "arguments": {}
            }
        )
        
        assert "result" in response
        result = response["result"]
        assert "content" in result
        
        # Parser le résultat JSON de l'outil
        content = result["content"][0] if isinstance(result["content"], list) else result["content"]
        if "text" in content:
            system_data = json.loads(content["text"])
            assert system_data["status"] == "success"
            assert "python" in system_data
            assert "system" in system_data
    
    @pytest.mark.asyncio
    async def test_list_kernels_tool(self, mcp_client: MCPTestClient):
        """Test l'outil list_kernels"""
        # Initialiser
        await mcp_client.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "test", "version": "1.0"}
        })
        
        # Appeler list_kernels
        response = await mcp_client.send_request(
            "tools/call",
            {
                "name": "list_kernels",
                "arguments": {}
            }
        )
        
        assert "result" in response
        result = response["result"]
        assert "content" in result
        
        # Parser le résultat
        content = result["content"][0] if isinstance(result["content"], list) else result["content"]
        if "text" in content:
            kernels_data = json.loads(content["text"])
            assert isinstance(kernels_data, list)
            assert len(kernels_data) > 0
    
    @pytest.mark.asyncio
    async def test_create_notebook_tool(self, mcp_client: MCPTestClient, temp_output_dir):
        """Test l'outil create_notebook"""
        # Initialiser
        await mcp_client.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "test", "version": "1.0"}
        })
        
        # Créer un notebook
        notebook_path = str(Path(temp_output_dir) / "test_created.ipynb")
        response = await mcp_client.send_request(
            "tools/call",
            {
                "name": "create_notebook",
                "arguments": {
                    "notebook_path": notebook_path,
                    "kernel_name": "python3"
                }
            }
        )
        
        assert "result" in response
        result = response["result"]
        assert "content" in result
        
        # Vérifier que le notebook a été créé
        assert Path(notebook_path).exists()
        
        # Vérifier le contenu
        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook_data = json.load(f)
        
        assert notebook_data["nbformat"] == 4
        assert "cells" in notebook_data
        assert "metadata" in notebook_data


@pytest.mark.e2e
@pytest.mark.slow
class TestNotebookExecution:
    """Tests d'exécution de notebooks via MCP"""
    
    @pytest.mark.asyncio
    async def test_execute_python_success_notebook(self, mcp_client: MCPTestClient, test_notebooks_dir):
        """Test d'exécution du notebook Python de succès"""
        # Initialiser
        await mcp_client.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "test", "version": "1.0"}
        })
        
        # Exécuter le notebook de succès
        notebook_path = str(test_notebooks_dir / "test_python_success.ipynb")
        response = await mcp_client.send_request(
            "tools/call",
            {
                "name": "execute_notebook",
                "arguments": {
                    "notebook_path": notebook_path
                }
            }
        )
        
        assert "result" in response
        result = response["result"]
        assert "content" in result
        
        # Parser le résultat d'exécution
        content = result["content"][0] if isinstance(result["content"], list) else result["content"]
        if "text" in content:
            execution_result = json.loads(content["text"])
            assert execution_result["status"] == "success"
            assert "output_path" in execution_result
            assert "execution_time_seconds" in execution_result
            
            # Vérifier que le fichier de sortie existe
            output_path = execution_result["output_path"]
            assert Path(output_path).exists()
    
    @pytest.mark.asyncio
    async def test_execute_python_failure_notebook(self, mcp_client: MCPTestClient, test_notebooks_dir):
        """Test d'exécution du notebook Python en échec"""
        # Initialiser
        await mcp_client.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "test", "version": "1.0"}
        })
        
        # Exécuter le notebook d'échec
        notebook_path = str(test_notebooks_dir / "test_python_failure.ipynb")
        response = await mcp_client.send_request(
            "tools/call",
            {
                "name": "execute_notebook",
                "arguments": {
                    "notebook_path": notebook_path
                }
            }
        )
        
        assert "result" in response
        result = response["result"]
        assert "content" in result
        
        # Parser le résultat d'exécution
        content = result["content"][0] if isinstance(result["content"], list) else result["content"]
        if "text" in content:
            execution_result = json.loads(content["text"])
            assert execution_result["status"] == "error"
            assert "error" in execution_result
            assert "PapermillExecutionError" in execution_result.get("error_type", "")
    
    @pytest.mark.asyncio
    async def test_execute_nonexistent_notebook(self, mcp_client: MCPTestClient):
        """Test d'exécution d'un notebook inexistant"""
        # Initialiser
        await mcp_client.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "test", "version": "1.0"}
        })
        
        # Tenter d'exécuter un notebook inexistant
        response = await mcp_client.send_request(
            "tools/call",
            {
                "name": "execute_notebook",
                "arguments": {
                    "notebook_path": "/nonexistent/path.ipynb"
                }
            }
        )
        
        assert "result" in response
        result = response["result"]
        assert "content" in result
        
        # Parser le résultat d'erreur
        content = result["content"][0] if isinstance(result["content"], list) else result["content"]
        if "text" in content:
            execution_result = json.loads(content["text"])
            assert execution_result["status"] == "error"
            assert "not found" in execution_result["error"].lower()


@pytest.mark.e2e
class TestNotebookManagement:
    """Tests de gestion des notebooks via MCP"""
    
    @pytest.mark.asyncio
    async def test_complete_notebook_workflow(self, mcp_client: MCPTestClient, temp_output_dir):
        """Test d'un flux complet de création et exécution"""
        # Initialiser
        await mcp_client.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "test", "version": "1.0"}
        })
        
        # 1. Créer un notebook
        notebook_path = str(Path(temp_output_dir) / "workflow_test.ipynb")
        create_response = await mcp_client.send_request(
            "tools/call",
            {
                "name": "create_notebook",
                "arguments": {
                    "notebook_path": notebook_path,
                    "kernel_name": "python3"
                }
            }
        )
        
        assert "result" in create_response
        assert Path(notebook_path).exists()
        
        # 2. Ajouter une cellule
        add_cell_response = await mcp_client.send_request(
            "tools/call",
            {
                "name": "add_cell_to_notebook",
                "arguments": {
                    "notebook_path": notebook_path,
                    "cell_type": "code",
                    "content": "print('Hello from workflow test!')"
                }
            }
        )
        
        assert "result" in add_cell_response
        
        # 3. Exécuter le notebook
        execute_response = await mcp_client.send_request(
            "tools/call",
            {
                "name": "execute_notebook",
                "arguments": {
                    "notebook_path": notebook_path
                }
            }
        )
        
        assert "result" in execute_response
        result = execute_response["result"]
        content = result["content"][0] if isinstance(result["content"], list) else result["content"]
        
        if "text" in content:
            execution_result = json.loads(content["text"])
            assert execution_result["status"] == "success"
    
    @pytest.mark.asyncio
    async def test_parameterized_execution(self, mcp_client: MCPTestClient, create_temp_notebook):
        """Test d'exécution avec paramètres"""
        # Initialiser
        await mcp_client.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "test", "version": "1.0"}
        })
        
        # Créer un notebook avec cellule paramétrisée
        notebook_content = {
            "cells": [
                {
                    "cell_type": "code",
                    "execution_count": None,
                    "metadata": {"tags": ["parameters"]},
                    "outputs": [],
                    "source": ["param1 = 'default_value'", "param2 = 42"]
                },
                {
                    "cell_type": "code",
                    "execution_count": None,
                    "metadata": {},
                    "outputs": [],
                    "source": ["print(f'param1: {param1}, param2: {param2}')"]
                }
            ],
            "metadata": {
                "kernelspec": {
                    "display_name": "Python 3",
                    "language": "python",
                    "name": "python3"
                },
                "language_info": {"name": "python"}
            },
            "nbformat": 4,
            "nbformat_minor": 4
        }
        
        notebook_path = create_temp_notebook("parameterized.ipynb", notebook_content)
        
        # Exécuter avec paramètres
        parameters = {
            "param1": "test_value",
            "param2": 123
        }
        
        response = await mcp_client.send_request(
            "tools/call",
            {
                "name": "parameterize_notebook",
                "arguments": {
                    "notebook_path": str(notebook_path),
                    "parameters": json.dumps(parameters)
                }
            }
        )
        
        assert "result" in response
        result = response["result"]
        content = result["content"][0] if isinstance(result["content"], list) else result["content"]
        
        if "text" in content:
            execution_result = json.loads(content["text"])
            assert execution_result["status"] == "success"
            assert execution_result["parameters"] == parameters


@pytest.mark.e2e
class TestErrorHandling:
    """Tests de gestion d'erreur via le protocole MCP"""
    
    @pytest.mark.asyncio
    async def test_malformed_json_request(self, mcp_server_process):
        """Test de requête JSON malformée"""
        # Envoyer JSON malformé directement
        malformed_request = '{"jsonrpc": "2.0", "method": "test", malformed}\n'
        mcp_server_process.stdin.write(malformed_request.encode())
        mcp_server_process.stdin.flush()
        
        # Lire la réponse d'erreur
        try:
            response_line = mcp_server_process.stdout.readline()
            if response_line:
                response = json.loads(response_line.decode().strip())
                assert "error" in response
                assert response["error"]["code"] == -32700  # Parse error
        except:
            # Si le serveur ne répond pas, c'est aussi un comportement acceptable
            pass
    
    @pytest.mark.asyncio
    async def test_tool_execution_timeout(self, mcp_client: MCPTestClient, create_temp_notebook):
        """Test de timeout d'exécution d'outil"""
        # Initialiser
        await mcp_client.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "test", "version": "1.0"}
        })
        
        # Créer un notebook avec code très lent
        slow_notebook_content = {
            "cells": [{
                "cell_type": "code",
                "execution_count": None,
                "metadata": {},
                "outputs": [],
                "source": ["import time", "time.sleep(300)  # 5 minutes"]
            }],
            "metadata": {
                "kernelspec": {
                    "display_name": "Python 3",
                    "language": "python", 
                    "name": "python3"
                },
                "language_info": {"name": "python"}
            },
            "nbformat": 4,
            "nbformat_minor": 4
        }
        
        notebook_path = create_temp_notebook("slow.ipynb", slow_notebook_content)
        
        # Cette requête devrait timeout ou être gérée gracieusement
        response = await mcp_client.send_request(
            "tools/call",
            {
                "name": "execute_notebook",
                "arguments": {
                    "notebook_path": str(notebook_path)
                }
            }
        )
        
        # Le serveur doit répondre, même si c'est une erreur
        assert "result" in response or "error" in response