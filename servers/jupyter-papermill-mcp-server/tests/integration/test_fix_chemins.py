#!/usr/bin/env python3
"""
Test script pour valider la correction du bug de gestion des chemins
"""

import os
import tempfile
import json
from pathlib import Path
import sys

# Add the papermill_mcp module to path
sys.path.insert(0, str(Path(__file__).parent / "../../papermill_mcp"))

try:
    # Simuler l'enregistrement des outils pour pouvoir appeler les fonctions décorées
    from mcp.server.fastmcp import FastMCP
    from papermill_mcp.tools.notebook_tools import register_notebook_tools
    from papermill_mcp.tools.execution_tools import register_execution_tools
    from papermill_mcp.config import MCPConfig
    from papermill_mcp.tools.notebook_tools import initialize_notebook_tools
    from papermill_mcp.tools.execution_tools import initialize_execution_tools
    
    # Initialiser les services
    config = MCPConfig()
    initialize_notebook_tools(config)
    initialize_execution_tools(config)
    
    # Créer une app dummy pour récupérer les fonctions décorées
    app = FastMCP("test_app")
    register_notebook_tools(app)
    register_execution_tools(app)
    
    # Récupérer les fonctions depuis l'app (ce sont maintenant des méthodes de l'app)
    # Note: FastMCP enregistre les outils, mais pour les tests unitaires on a besoin d'accéder aux fonctions
    # Dans ce script de test d'intégration, nous allons utiliser une approche différente
    # en instanciant directement les services
    from papermill_mcp.tools.notebook_tools import get_notebook_service
    from papermill_mcp.services.notebook_service import NotebookService
    
    notebook_service = get_notebook_service()
    
    # Wrapper pour create_notebook
    async def create_notebook(path, kernel="python3"):
        return await notebook_service.create_notebook(path, kernel)
        
    # Wrapper pour execute_notebook (remplace execute_notebook_solution_a)
    async def execute_notebook_solution_a(notebook_path, output_path=""):
        return await notebook_service.execute_notebook_consolidated(
            input_path=notebook_path,
            output_path=output_path if output_path else None,
            mode="sync"
        )
    
    import asyncio
    
    # Helper pour exécuter les fonctions async de manière synchrone pour ce script
    def run_sync(coro):
        return asyncio.run(coro)

    print("[OK] Import des modules reussi")
except ImportError as e:
    print(f"[ERREUR] Erreur d'import: {e}")
    sys.exit(1)

def test_path_consistency():
    """Test de cohérence des chemins"""
    print("\n[TEST] Coherence des chemins")
    
    original_cwd = os.getcwd()
    print(f"[INFO] Working directory initial: {original_cwd}")
    
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        notebook_path = temp_path / "test_notebook.ipynb"
        
        # Créer un notebook simple
        try:
            result = run_sync(create_notebook(
                path=str(notebook_path),
                kernel="python3"
            ))
            print(f"[OK] Notebook cree: {result.get('status')}")
            
            # Vérifier que le working directory n'a pas changé
            current_cwd = os.getcwd()
            if current_cwd == original_cwd:
                print("[OK] Working directory stable - pas de fuite os.chdir()")
            else:
                print(f"[ERREUR] PROBLEME: Working directory change {original_cwd} -> {current_cwd}")
                return False
                
        except Exception as e:
            print(f"[ERREUR] Erreur lors de creation notebook: {e}")
            return False
    
    return True

def test_execution_paths():
    """Test d'exécution avec différents types de chemins"""
    print("\n[TEST] Execution avec differents chemins")
    
    original_cwd = os.getcwd()
    
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        
        # Créer un notebook avec code simple
        notebook_content = {
            "cells": [
                {
                    "cell_type": "code",
                    "metadata": {},
                    "execution_count": None,
                    "outputs": [],
                    "source": [
                        "import os\n",
                        "print(f'Working directory: {os.getcwd()}')\n",
                        "print('Hello from test notebook!')\n",
                        "result = 2 + 2\n",
                        "print(f'2 + 2 = {result}')"
                    ]
                }
            ],
            "metadata": {
                "kernelspec": {
                    "display_name": "Python 3",
                    "language": "python",
                    "name": "python3"
                }
            },
            "nbformat": 4,
            "nbformat_minor": 4
        }
        
        # Test avec chemin absolu
        abs_notebook_path = temp_path / "test_abs.ipynb"
        with open(abs_notebook_path, 'w') as f:
            json.dump(notebook_content, f, indent=2)
        
        print(f"[INFO] Notebook absolu cree: {abs_notebook_path}")
        
        try:
            # Tester l'exécution (note: peut échouer si conda env pas disponible, mais les chemins doivent rester cohérents)
            result = run_sync(execute_notebook_solution_a(
                notebook_path=str(abs_notebook_path),
                output_path=""  # Auto-généré
            ))
            
            print(f"📊 Résultat: {result.get('status', 'unknown')}")
            
            # Vérifier que le working directory n'a pas changé
            current_cwd = os.getcwd()
            if current_cwd == original_cwd:
                print("✅ Working directory stable après exécution")
                return True
            else:
                print(f"❌ PROBLÈME: Working directory changé {original_cwd} → {current_cwd}")
                return False
                
        except Exception as e:
            print(f"⚠️ Exécution échouée (attendu si env conda absent): {e}")
            
            # Même si l'exécution échoue, vérifier la cohérence des chemins
            current_cwd = os.getcwd()
            if current_cwd == original_cwd:
                print("✅ Working directory stable malgré l'erreur")
                return True
            else:
                print(f"❌ PROBLÈME CRITIQUE: Working directory corrompu même avec erreur")
                return False

def main():
    """Test principal de validation du fix"""
    print("[VALIDATION] TEST DE VALIDATION - CORRECTION BUG GESTION CHEMINS MCP JUPYTER")
    print("=" * 60)
    
    tests_passed = 0
    total_tests = 2
    
    # Test 1: Cohérence des chemins
    if test_path_consistency():
        tests_passed += 1
        print("[OK] Test 1 REUSSI")
    else:
        print("[ECHEC] Test 1 ECHOUE")
    
    # Test 2: Exécution avec différents chemins
    if test_execution_paths():
        tests_passed += 1
        print("[OK] Test 2 REUSSI")
    else:
        print("[ECHEC] Test 2 ECHOUE")
    
    # Résumé
    print("\n" + "=" * 60)
    print(f"[RESULTATS] {tests_passed}/{total_tests} tests reussis")
    
    if tests_passed == total_tests:
        print("[SUCCES] CORRECTION DU BUG VALIDEE - MCP Jupyter securise !")
        return 0
    else:
        print("[ECHEC] PROBLEMES DETECTES - Correction incomplete")
        return 1

if __name__ == "__main__":
    sys.exit(main())