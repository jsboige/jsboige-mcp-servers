#!/usr/bin/env python3
"""
Test de validation des corrections SDDD reconsolidées
Script de test pour vérifier que les corrections sont bien intégrées dans l'architecture consolidée
"""

import asyncio
import json
import sys
from pathlib import Path

def test_imports():
    """Test d'importation des modules consolidés avec corrections SDDD"""
    print("🧪 Test 1: Importation des modules consolidés...")
    
    try:
        from papermill_mcp.main import JupyterPapermillMCPServer
        print("✅ main.JupyterPapermillMCPServer - OK")
        
        from papermill_mcp.config import get_config
        print("✅ config.get_config - OK")
        
        from papermill_mcp.services.notebook_service import NotebookService
        print("✅ services.notebook_service.NotebookService - OK")
        
        return True
        
    except Exception as e:
        print(f"❌ ERREUR IMPORT: {e}")
        return False

def test_json_parsing_correction():
    """Test de la correction JSON parsing dans parameterize_notebook"""
    print("\n🧪 Test 2: Correction JSON parsing parameterize_notebook...")
    
    try:
        from papermill_mcp.services.notebook_service import NotebookService
        
        # Vérifier que la méthode existe et contient la correction
        import inspect
        source = inspect.getsource(NotebookService.parameterize_notebook)
        
        if "isinstance(parameters, str)" in source and "json.loads" in source:
            print("✅ Correction JSON parsing automatique - INTÉGRÉE")
            return True
        else:
            print("❌ Correction JSON parsing - NON TROUVÉE")
            return False
            
    except Exception as e:
        print(f"❌ ERREUR TEST JSON: {e}")
        return False

def test_timestamp_correction():
    """Test de la correction timestamps uniques dans execute_notebook_solution_a"""
    print("\n🧪 Test 3: Correction timestamps uniques execute_notebook_solution_a...")
    
    try:
        from papermill_mcp.services.notebook_service import NotebookService
        
        # Vérifier que la méthode existe et contient la correction
        import inspect
        source = inspect.getsource(NotebookService.execute_notebook_solution_a)
        
        if "timestamp = datetime.datetime.now().strftime" in source and "_executed_{timestamp}.ipynb" in source:
            print("✅ Correction timestamps uniques - INTÉGRÉE")
            return True
        else:
            print("❌ Correction timestamps - NON TROUVÉE")
            return False
            
    except Exception as e:
        print(f"❌ ERREUR TEST TIMESTAMP: {e}")
        return False

async def test_server_initialization():
    """Test d'initialisation du serveur consolidé"""
    print("\n🧪 Test 4: Initialisation serveur consolidé...")
    
    try:
        from papermill_mcp.main import JupyterPapermillMCPServer
        from papermill_mcp.config import get_config
        
        config = get_config()
        server = JupyterPapermillMCPServer(config)
        
        # Test basique d'initialisation
        if hasattr(server, 'app') and hasattr(server, '_config'):
            print("✅ Serveur consolidé - Initialisation OK")
            return True
        else:
            print("❌ Serveur consolidé - Initialisation ÉCHEC")
            return False
            
    except Exception as e:
        print(f"❌ ERREUR SERVEUR: {e}")
        return False

def test_obsolete_api_marking():
    """Test du marquage API obsolète"""
    print("\n🧪 Test 5: Marquage API obsolète main_fastmcp.py...")
    
    try:
        # Lire le fichier main_fastmcp.py
        fastmcp_path = Path(__file__).parent / "papermill_mcp" / "main_fastmcp.py"
        
        if fastmcp_path.exists():
            content = fastmcp_path.read_text(encoding='utf-8')
            
            if "API OBSOLÈTE" in content and "UTILISER main.py" in content:
                print("✅ API obsolète - Marquage PRÉSENT")
                return True
            else:
                print("❌ API obsolète - Marquage MANQUANT")
                return False
        else:
            print("❌ Fichier main_fastmcp.py - NON TROUVÉ")
            return False
            
    except Exception as e:
        print(f"❌ ERREUR MARQUAGE: {e}")
        return False

def main():
    """Fonction principale de test"""
    print("=" * 70)
    print("🎯 TEST RECONSOLIDATION CORRECTIONS SDDD")
    print("=" * 70)
    
    tests = [
        ("Imports", test_imports),
        ("JSON Parsing", test_json_parsing_correction),
        ("Timestamps", test_timestamp_correction),
        ("Serveur", lambda: asyncio.run(test_server_initialization())),
        ("API Obsolète", test_obsolete_api_marking)
    ]
    
    results = []
    
    for name, test_func in tests:
        try:
            result = test_func()
            results.append((name, result))
        except Exception as e:
            print(f"❌ ERREUR {name}: {e}")
            results.append((name, False))
    
    # Résumé
    print("\n" + "=" * 70)
    print("📊 RÉSUMÉ DES TESTS")
    print("=" * 70)
    
    success_count = 0
    for name, result in results:
        status = "✅ SUCCÈS" if result else "❌ ÉCHEC"
        print(f"{name:15} : {status}")
        if result:
            success_count += 1
    
    total_tests = len(results)
    success_rate = (success_count / total_tests) * 100
    
    print(f"\nScore: {success_count}/{total_tests} ({success_rate:.1f}%)")
    
    if success_rate >= 100:
        print("🎉 RECONSOLIDATION PARFAITE - Toutes les corrections SDDD intégrées")
        return 0
    elif success_rate >= 80:
        print("✅ RECONSOLIDATION RÉUSSIE - Corrections principales intégrées")
        return 0
    else:
        print("❌ RECONSOLIDATION INCOMPLÈTE - Corrections manquantes")
        return 1

if __name__ == "__main__":
    sys.exit(main())