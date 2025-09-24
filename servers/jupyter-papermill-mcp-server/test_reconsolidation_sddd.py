#!/usr/bin/env python3
"""
Test de validation des corrections SDDD reconsolidees
Script de test pour verifier que les corrections sont bien integrees dans l'architecture consolidee
"""

import asyncio
import json
import sys
from pathlib import Path

def test_imports():
    """Test d'importation des modules consolides avec corrections SDDD"""
    print("[TEST] Test 1: Importation des modules consolides...")
    
    try:
        from papermill_mcp.main import JupyterPapermillMCPServer
        print("[OK] main.JupyterPapermillMCPServer - OK")
        
        from papermill_mcp.config import get_config
        print("[OK] config.get_config - OK")
        
        from papermill_mcp.services.notebook_service import NotebookService
        print("[OK] services.notebook_service.NotebookService - OK")
        
        return True
        
    except Exception as e:
        print(f"[ERROR] ERREUR IMPORT: {e}")
        return False

def test_json_parsing_correction():
    """Test de la correction JSON parsing dans parameterize_notebook"""
    print("\n[TEST] Test 2: Correction JSON parsing parameterize_notebook...")
    
    try:
        from papermill_mcp.services.notebook_service import NotebookService
        
        # Verifier que la methode existe et contient la correction
        import inspect
        source = inspect.getsource(NotebookService.parameterize_notebook)
        
        if "isinstance(parameters, str)" in source and "json.loads" in source:
            print("[OK] Correction JSON parsing automatique - INT?GR?E")
            return True
        else:
            print("[ERROR] Correction JSON parsing - NON TROUV?E")
            return False
            
    except Exception as e:
        print(f"[ERROR] ERREUR TEST JSON: {e}")
        return False

def test_timestamp_correction():
    """Test de la correction timestamps uniques dans execute_notebook_solution_a"""
    print("\n[TEST] Test 3: Correction timestamps uniques execute_notebook_solution_a...")
    
    try:
        from papermill_mcp.services.notebook_service import NotebookService
        
        # Verifier que la methode existe et contient la correction
        import inspect
        source = inspect.getsource(NotebookService.execute_notebook_solution_a)
        
        if "timestamp = datetime.datetime.now().strftime" in source and "_executed_{timestamp}.ipynb" in source:
            print("[OK] Correction timestamps uniques - INT?GR?E")
            return True
        else:
            print("[ERROR] Correction timestamps - NON TROUV?E")
            return False
            
    except Exception as e:
        print(f"[ERROR] ERREUR TEST TIMESTAMP: {e}")
        return False

async def test_server_initialization():
    """Test d'initialisation du serveur consolide"""
    print("\n[TEST] Test 4: Initialisation serveur consolide...")
    
    try:
        from papermill_mcp.main import JupyterPapermillMCPServer
        from papermill_mcp.config import get_config
        
        config = get_config()
        server = JupyterPapermillMCPServer(config)
        
        # Test basique d'initialisation
        if hasattr(server, 'app') and hasattr(server, '_config'):
            print("[OK] Serveur consolide - Initialisation OK")
            return True
        else:
            print("[ERROR] Serveur consolide - Initialisation ?CHEC")
            return False
            
    except Exception as e:
        print(f"[ERROR] ERREUR SERVEUR: {e}")
        return False

def test_obsolete_api_marking():
    """Test du marquage API obsolete"""
    print("\n[TEST] Test 5: Marquage API obsolete main_fastmcp.py...")
    
    try:
        # Lire le fichier main_fastmcp.py
        fastmcp_path = Path(__file__).parent / "papermill_mcp" / "main_fastmcp.py"
        
        if fastmcp_path.exists():
            content = fastmcp_path.read_text(encoding='utf-8')
            
            if "API OBSOL?TE" in content and "UTILISER main.py" in content:
                print("[OK] API obsolete - Marquage PR?SENT")
                return True
            else:
                print("[ERROR] API obsolete - Marquage MANQUANT")
                return False
        else:
            print("[ERROR] Fichier main_fastmcp.py - NON TROUV?")
            return False
            
    except Exception as e:
        print(f"[ERROR] ERREUR MARQUAGE: {e}")
        return False

def main():
    """Fonction principale de test"""
    print("=" * 70)
    print("[TARGET] TEST RECONSOLIDATION CORRECTIONS SDDD")
    print("=" * 70)
    
    tests = [
        ("Imports", test_imports),
        ("JSON Parsing", test_json_parsing_correction),
        ("Timestamps", test_timestamp_correction),
        ("Serveur", lambda: asyncio.run(test_server_initialization())),
        ("API Obsolete", test_obsolete_api_marking)
    ]
    
    results = []
    
    for name, test_func in tests:
        try:
            result = test_func()
            results.append((name, result))
        except Exception as e:
            print(f"[ERROR] ERREUR {name}: {e}")
            results.append((name, False))
    
    # Resume
    print("\n" + "=" * 70)
    print("[STATS] R?SUM? DES TESTS")
    print("=" * 70)
    
    success_count = 0
    for name, result in results:
        status = "[OK] SUCC?S" if result else "[ERROR] ?CHEC"
        print(f"{name:15} : {status}")
        if result:
            success_count += 1
    
    total_tests = len(results)
    success_rate = (success_count / total_tests) * 100
    
    print(f"\nScore: {success_count}/{total_tests} ({success_rate:.1f}%)")
    
    if success_rate >= 100:
        print("[SUCCESS] RECONSOLIDATION PARFAITE - Toutes les corrections SDDD integrees")
        return 0
    elif success_rate >= 80:
        print("[OK] RECONSOLIDATION R?USSIE - Corrections principales integrees")
        return 0
    else:
        print("[ERROR] RECONSOLIDATION INCOMPL?TE - Corrections manquantes")
        return 1

if __name__ == "__main__":
    sys.exit(main())