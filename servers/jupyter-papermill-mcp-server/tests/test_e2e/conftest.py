"""
Fixtures pytest pour les tests End-to-End du serveur MCP
Configuration et gestion du cycle de vie du serveur pour les tests E2E
"""

import asyncio
import json
import subprocess
import tempfile
import time
import pytest
import pytest_asyncio
from pathlib import Path
from typing import AsyncGenerator, Dict, Any
import os
import signal


class MCPTestClient:
    """Client de test pour communiquer avec le serveur MCP via stdio"""
    
    def __init__(self, server_process: subprocess.Popen):
        self.process = server_process
        self.request_id = 0
    
    def _next_request_id(self) -> int:
        """Genere un ID de requete unique"""
        self.request_id += 1
        return self.request_id
    
    async def send_request(self, method: str, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Envoie une requete JSON-RPC au serveur"""
        request = {
            "jsonrpc": "2.0",
            "id": self._next_request_id(),
            "method": method
        }
        
        if params:
            request["params"] = params
        
        # Envoyer la requete
        request_json = json.dumps(request) + '\n'
        self.process.stdin.write(request_json.encode())
        self.process.stdin.flush()
        
        # Lire la reponse
        response_line = self.process.stdout.readline()
        if not response_line:
            raise Exception("Pas de reponse du serveur")
        
        try:
            response = json.loads(response_line.decode().strip())
            return response
        except json.JSONDecodeError as e:
            raise Exception(f"Reponse JSON invalide: {e}, ligne: {response_line}")
    
    def close(self):
        """Ferme la connexion avec le serveur"""
        if self.process:
            try:
                # Envoie un signal SIGTERM proprement
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    # Force kill si necessaire
                    self.process.kill()
                    self.process.wait()
            except:
                pass


@pytest_asyncio.fixture
async def mcp_server_process() -> AsyncGenerator[subprocess.Popen, None]:
    """Fixture pour demarrer/arreter le serveur MCP"""
    server_dir = Path(__file__).parent.parent.parent
    server_script = server_dir / "papermill_mcp" / "main_fastmcp.py"
    
    if not server_script.exists():
        pytest.skip(f"Script serveur non trouve: {server_script}")
    
    # Demarrer le serveur en mode stdio
    env = os.environ.copy()
    env['PYTHONPATH'] = str(server_dir)
    
    process = subprocess.Popen(
        [
            "python", "-u", str(server_script)
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        cwd=str(server_dir),
        text=False  # Mode binaire pour controler l'encodage
    )
    
    # Attendre que le serveur soit pret
    await asyncio.sleep(1)
    
    if process.poll() is not None:
        stderr_output = process.stderr.read().decode()
        pytest.skip(f"Le serveur a echoue au demarrage: {stderr_output}")
    
    try:
        yield process
    finally:
        # Nettoyage
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


@pytest_asyncio.fixture
async def mcp_client(mcp_server_process) -> AsyncGenerator[MCPTestClient, None]:
    """Fixture pour un client de test MCP"""
    client = MCPTestClient(mcp_server_process)
    try:
        yield client
    finally:
        client.close()


@pytest.fixture
def test_notebooks_dir() -> Path:
    """Chemin vers les notebooks de test"""
    return Path(__file__).parent.parent / "notebooks"


@pytest.fixture
def temp_output_dir():
    """Repertoire temporaire pour les sorties de test"""
    with tempfile.TemporaryDirectory() as temp_dir:
        yield temp_dir


@pytest.fixture
def sample_notebook_content() -> Dict[str, Any]:
    """Contenu de notebook de test minimal"""
    return {
        "cells": [
            {
                "cell_type": "code",
                "execution_count": None,
                "metadata": {},
                "outputs": [],
                "source": ["print('Test notebook from fixture')"]
            }
        ],
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3"
            },
            "language_info": {
                "name": "python"
            }
        },
        "nbformat": 4,
        "nbformat_minor": 4
    }


@pytest_asyncio.fixture
async def create_temp_notebook(temp_output_dir, sample_notebook_content):
    """Cree un notebook temporaire pour les tests"""
    def _create_notebook(filename: str, content: Dict[str, Any] = None) -> Path:
        notebook_content = content or sample_notebook_content
        notebook_path = Path(temp_output_dir) / filename
        
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook_content, f, indent=2)
        
        return notebook_path
    
    return _create_notebook


# Marqueurs pytest pour les tests E2E
def pytest_configure(config):
    """Configuration des marqueurs pytest"""
    config.addinivalue_line(
        "markers", 
        "e2e: marque les tests end-to-end (necessitent le serveur complet)"
    )
    config.addinivalue_line(
        "markers",
        "slow: marque les tests lents qui peuvent prendre du temps"
    )