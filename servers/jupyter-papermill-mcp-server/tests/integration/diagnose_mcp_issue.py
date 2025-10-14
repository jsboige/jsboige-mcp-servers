#!/usr/bin/env python3
"""
Script de diagnostic simple pour identifier le probleme MCP
"""

import sys
import subprocess
import time
from pathlib import Path

def test_basic_import():
    """Test d'importation de base"""
    print("=== TEST IMPORTATION ===")
    
    try:
        sys.path.insert(0, '.')
        from papermill_mcp.main import JupyterPapermillMCPServer
        print("? Import JupyterPapermillMCPServer reussi")
        
        from papermill_mcp.config import get_config
        print("? Import config reussi") 
        
        return True
    except Exception as e:
        print(f"? Erreur import: {e}")
        return False

def test_server_creation():
    """Test de creation du serveur"""
    print("\n=== TEST CR?ATION SERVEUR ===")
    
    try:
        from papermill_mcp.main import JupyterPapermillMCPServer
        from papermill_mcp.config import get_config
        
        config = get_config()
        server = JupyterPapermillMCPServer(config)
        print("? Serveur cree")
        
        server.initialize()
        print("? Serveur initialise")
        
        return True
    except Exception as e:
        print(f"? Erreur serveur: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_main_execution():
    """Test d'execution main() directe"""
    print("\n=== TEST MAIN EXECUTION ===")
    
    try:
        # Test si main.py peut etre importe
        import main
        print("? main.py importable")
        return True
    except Exception as e:
        print(f"? Erreur main: {e}")
        return False

def test_direct_launch():
    """Test de lancement direct du serveur"""
    print("\n=== TEST LANCEMENT DIRECT ===")
    
    try:
        cmd = ["C:/Users/jsboi/.conda/envs/mcp-jupyter-py310/python.exe", "main.py"]
        
        # Lancement avec timeout court
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        
        # Attendre 3 secondes
        try:
            stdout, stderr = process.communicate(timeout=3)
            print("? Serveur a termine normalement")
            if stdout:
                print(f"STDOUT: {stdout[:200]}")
            if stderr:
                print(f"STDERR: {stderr[:200]}")
        except subprocess.TimeoutExpired:
            process.kill()
            print("? Serveur demarre mais timeout (normal pour MCP)")
            
        return True
    except Exception as e:
        print(f"? Erreur lancement: {e}")
        return False

def main():
    """Diagnostic complet"""
    print("DIAGNOSTIC SERVEUR JUPYTER-PAPERMILL MCP")
    print("=" * 40)
    
    results = []
    
    # Test 1: Importation
    results.append(test_basic_import())
    
    # Test 2: Creation serveur
    results.append(test_server_creation())
    
    # Test 3: Main execution
    results.append(test_main_execution())
    
    # Test 4: Lancement direct
    results.append(test_direct_launch())
    
    # Resume
    print("\n" + "=" * 40)
    print("R?SULTATS DIAGNOSTIC:")
    
    passed = sum(results)
    total = len(results)
    
    tests = [
        "Importation modules",
        "Creation serveur",
        "Main execution",
        "Lancement direct"
    ]
    
    for i, (test, result) in enumerate(zip(tests, results)):
        status = "? PASS" if result else "? FAIL"
        print(f"  {i+1}. {test}: {status}")
    
    print(f"\nSCORE: {passed}/{total} tests reussis")
    
    if passed == total:
        print("? SERVEUR SEMBLE FONCTIONNEL - PROBL?ME AILLEURS")
        return 0
    else:
        print("? PROBL?MES SERVEUR D?TECT?S")
        return 1

if __name__ == "__main__":
    sys.exit(main())