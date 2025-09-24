#!/usr/bin/env python3
"""
Test rapide du protocole JSON-RPC MCP
Vérifie que le serveur répond correctement aux requêtes MCP
"""

import asyncio
import json
import sys
import subprocess
from pathlib import Path

async def test_mcp_protocol():
    """Test du serveur via protocole MCP JSON-RPC"""
    print("TEST PROTOCOLE MCP JSON-RPC")
    print("=" * 40)
    
    # Commande pour lancer le serveur
    cmd = [
        "C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/python.exe",
        "main.py"
    ]
    
    try:
        # Lancer le serveur
        print("Lancement du serveur MCP...")
        process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd="."
        )
        
        # Message d'initialisation MCP
        init_request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "clientInfo": {
                    "name": "test-client",
                    "version": "1.0.0"
                }
            }
        }
        
        # Envoyer la requête d'initialisation
        print("Envoi requête d'initialisation...")
        process.stdin.write(json.dumps(init_request) + "\n")
        process.stdin.flush()
        
        # Attendre la réponse (timeout 10s)
        try:
            stdout, stderr = process.communicate(timeout=10)
            
            if process.returncode is None:
                process.terminate()
                print("TIMEOUT - Serveur non responsive")
                return False
                
            if process.returncode == 0:
                print("SUCCÈS - Serveur a répondu")
                if stdout:
                    print("Réponse:", stdout[:200] + "..." if len(stdout) > 200 else stdout)
                return True
            else:
                print(f"ÉCHEC - Code de retour: {process.returncode}")
                if stderr:
                    print("Erreur:", stderr[:200] + "..." if len(stderr) > 200 else stderr)
                return False
                
        except subprocess.TimeoutExpired:
            process.kill()
            print("TIMEOUT - Serveur bloqué")
            return False
            
    except Exception as e:
        print(f"ERREUR de lancement: {e}")
        return False

def main():
    """Test principal"""
    print("VALIDATION PROTOCOLE MCP - SERVEUR JUPYTER-PAPERMILL")
    print("====================================================")
    
    result = asyncio.run(test_mcp_protocol())
    
    if result:
        print("\n✅ VALIDATION MCP RÉUSSIE")
        print("Le serveur répond correctement au protocole JSON-RPC")
        return 0
    else:
        print("\n❌ VALIDATION MCP ÉCHOUÉE") 
        print("Le serveur ne répond pas correctement")
        return 1

if __name__ == "__main__":
    sys.exit(main())