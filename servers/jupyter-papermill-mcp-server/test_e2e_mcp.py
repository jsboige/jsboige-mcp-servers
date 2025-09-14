#!/usr/bin/env python3
"""
Test End-to-End pour simuler la communication MCP avec le serveur Jupyter-Papermill
Simule exactement ce que fait Roo pour communiquer avec le serveur
"""

import asyncio
import json
import subprocess
import sys
import os
from typing import Dict, Any

# Configuration identique à mcp_settings.json
MCP_CONFIG = {
    "command": "C:/Users/jsboi/.conda/envs/mcp-jupyter/python.exe",
    "args": ["-m", "papermill_mcp"],
    "env": {
        "PYTHONPATH": "D:/dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server"
    },
    "cwd": "D:/dev/roo-extensions/mcps/internal/servers/jupyter-papermill-mcp-server"
}

class MCPTestClient:
    """Client de test pour communiquer avec le serveur MCP via stdio"""
    
    def __init__(self):
        self.process = None
        self.request_id = 0
    
    async def start(self):
        """Démarre le serveur MCP"""
        print("🚀 Démarrage du serveur MCP...")
        
        # Préparer l'environnement
        env = os.environ.copy()
        env.update(MCP_CONFIG["env"])
        
        # Démarrer le processus
        self.process = await asyncio.create_subprocess_exec(
            MCP_CONFIG["command"],
            *MCP_CONFIG["args"],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=MCP_CONFIG["cwd"]
        )
        
        print("✅ Serveur démarré")
        return self
    
    async def send_request(self, method: str, params: Dict[str, Any] = None) -> Dict[str, Any]:
        """Envoie une requête JSON-RPC au serveur"""
        self.request_id += 1
        
        request = {
            "jsonrpc": "2.0",
            "id": self.request_id,
            "method": method
        }
        
        if params:
            request["params"] = params
        
        request_json = json.dumps(request) + "\n"
        print(f"📤 Envoi: {request_json.strip()}")
        
        # Envoyer la requête
        self.process.stdin.write(request_json.encode())
        await self.process.stdin.drain()
        
        # Lire la réponse
        response_line = await self.process.stdout.readline()
        response_text = response_line.decode().strip()
        
        print(f"📥 Réponse: {response_text}")
        
        if not response_text:
            raise Exception("Pas de réponse du serveur")
        
        try:
            return json.loads(response_text)
        except json.JSONDecodeError as e:
            print(f"❌ Erreur JSON: {e}")
            print(f"❌ Texte brut: {response_text}")
            raise
    
    async def close(self):
        """Ferme la connexion avec le serveur"""
        if self.process:
            self.process.stdin.close()
            await self.process.wait()
            print("🔚 Serveur fermé")

async def test_mcp_communication():
    """Test complet de communication MCP"""
    
    print("=== TEST E2E MCP JUPYTER-PAPERMILL ===")
    
    client = MCPTestClient()
    
    try:
        # 1. Démarrer le serveur
        await client.start()
        
        # 2. Handshake initial
        print("\n1️⃣ Test d'initialisation...")
        init_response = await client.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}}
        })
        
        if "error" in init_response:
            print(f"❌ Erreur d'initialisation: {init_response['error']}")
            return False
        
        print("✅ Initialisation OK")
        
        # 3. Lister les outils
        print("\n2️⃣ Test de liste des outils...")
        tools_response = await client.send_request("tools/list")
        
        if "error" in tools_response:
            print(f"❌ Erreur outils: {tools_response['error']}")
            return False
        
        tools = tools_response.get("result", {}).get("tools", [])
        print(f"✅ {len(tools)} outils trouvés:")
        for tool in tools:
            print(f"  - {tool['name']}: {tool['description']}")
        
        # 4. Test d'appel d'outil
        if tools:
            print("\n3️⃣ Test d'appel d'outil...")
            tool_name = tools[0]["name"]
            call_response = await client.send_request("tools/call", {
                "name": tool_name,
                "arguments": {}
            })
            
            if "error" in call_response:
                print(f"❌ Erreur appel outil: {call_response['error']}")
                return False
            
            content = call_response.get("result", {}).get("content", [])
            print(f"✅ Outil '{tool_name}' exécuté: {len(content)} éléments de contenu")
            if content:
                print(f"  Résultat: {content[0].get('text', '')}")
        
        print("\n🎉 TOUS LES TESTS E2E RÉUSSIS!")
        return True
        
    except Exception as e:
        print(f"❌ ÉCHEC DU TEST E2E: {e}")
        import traceback
        traceback.print_exc()
        return False
        
    finally:
        await client.close()

async def main():
    """Point d'entrée principal"""
    success = await test_mcp_communication()
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    asyncio.run(main())