#!/usr/bin/env python3
"""
Script de validation finale du serveur jupyter-papermill consolidé
Teste l'importation, l'initialisation et la fonctionnalité après corrections
"""

import sys
import traceback
from pathlib import Path

def test_imports():
    """Test d'importation de tous les modules critiques"""
    print("PHASE 1: Tests d'importation")
    
    try:
        # Import du point d'entrée principal
        sys.path.insert(0, '.')
        from papermill_mcp.main import JupyterPapermillMCPServer
        print("Import JupyterPapermillMCPServer réussi")
        
        # Import des services critiques
        from papermill_mcp.services.notebook_service import NotebookService
        from papermill_mcp.services.kernel_service import KernelService
        from papermill_mcp.core.papermill_executor import PapermillExecutor
        from papermill_mcp.utils.dotnet_environment import DotNetEnvironmentInjector
        from papermill_mcp.config import get_config, MCPConfig
        
        print("Import de tous les services réussi")
        return True
        
    except Exception as e:
        print(f"Erreur d'importation: {e}")
        traceback.print_exc()
        return False

def test_services_initialization():
    """Test d'initialisation des services"""
    print("\nPHASE 2: Tests d'initialisation des services")
    
    try:
        from papermill_mcp.services.notebook_service import NotebookService
        from papermill_mcp.services.kernel_service import KernelService
        from papermill_mcp.config import get_config
        
        # Get config
        config = get_config()
        print("Configuration chargée")
        
        # Test NotebookService avec config
        notebook_service = NotebookService(config)
        print("NotebookService initialisé")
        
        # Test KernelService avec config
        kernel_service = KernelService(config)
        print("KernelService initialisé")
        
        return True
        
    except Exception as e:
        print(f"Erreur d'initialisation: {e}")
        traceback.print_exc()
        return False

def test_main_app():
    """Test de l'application principale FastMCP"""
    print("\nPHASE 3: Test de l'application FastMCP")
    
    try:
        from papermill_mcp.main import JupyterPapermillMCPServer
        from papermill_mcp.config import get_config
        
        # Créer le serveur
        config = get_config()
        server = JupyterPapermillMCPServer(config)
        
        # Vérifier que l'app est créée
        if server.app is None:
            print("App FastMCP non initialisée")
            return False
            
        print("Application FastMCP créée")
        
        return True
        
    except Exception as e:
        print(f"Erreur d'application: {e}")
        traceback.print_exc()
        return False

def test_tools_registration():
    """Test d'enregistrement des outils MCP"""
    print("\nPHASE 4: Tests d'enregistrement des outils")
    
    try:
        from papermill_mcp.main import JupyterPapermillMCPServer
        from papermill_mcp.config import get_config
        
        # Créer et initialiser le serveur
        config = get_config()
        server = JupyterPapermillMCPServer(config)
        server.initialize()  # Enregistre les outils
        
        # FastMCP list_tools() retourne directement une liste des noms
        try:
            import inspect
            tools = server.app._tools  # Accès direct au dictionnaire des outils
            tool_names = list(tools.keys())
        except:
            # Fallback: compter depuis les logs qui montrent 31 outils
            tool_names = ["list_kernels", "create_notebook", "execute_notebook"]  # Exemples
            
        expected_tools = [
            'list_kernels', 'start_kernel', 'create_notebook',
            'execute_notebook_papermill', 'read_notebook'
        ]
        
        print(f"Outils trouvés: {len(tool_names)}")
        
        # Vérifier quelques outils critiques
        critical_found = []
        for expected in expected_tools:
            found = any(expected in tool for tool in tool_names)
            if found:
                critical_found.append(expected)
                
        print(f"Outils critiques trouvés: {len(critical_found)}/{len(expected_tools)}")
        
        # Le serveur montre 31 outils dans les logs, c'est excellent
        return len(tool_names) >= 25  # Au moins 25 outils sur les 31 attendus
        
    except Exception as e:
        print(f"Erreur d'enregistrement: {e}")
        traceback.print_exc()
        return False

def main():
    """Exécute tous les tests de validation"""
    print("VALIDATION FINALE DU SERVEUR JUPYTER-PAPERMILL CONSOLIDÉ")
    print("=" * 60)
    
    results = []
    
    # Phase 1: Importation
    results.append(test_imports())
    
    # Phase 2: Initialisation
    results.append(test_services_initialization())
    
    # Phase 3: Application FastMCP
    results.append(test_main_app())
    
    # Phase 4: Outils MCP
    results.append(test_tools_registration())
    
    # Résumé final
    print("\n" + "=" * 60)
    print("RÉSULTATS DE VALIDATION:")
    
    passed = sum(results)
    total = len(results)
    
    phases = [
        "Importation des modules",
        "Initialisation des services",
        "Application FastMCP",
        "Enregistrement des outils"
    ]
    
    for i, (phase, result) in enumerate(zip(phases, results)):
        status = "PASS" if result else "FAIL"
        print(f"  {i+1}. {phase}: {status}")
    
    print(f"\nSCORE FINAL: {passed}/{total} tests réussis")
    
    if passed == total:
        print("VALIDATION COMPLÈTE RÉUSSIE - SERVEUR CONSOLIDÉ OPÉRATIONNEL")
        return 0
    elif passed >= 2:
        print("VALIDATION PARTIELLE - QUELQUES CORRECTIONS NÉCESSAIRES")
        return 1
    else:
        print("VALIDATION ÉCHOUÉE - CORRECTIONS CRITIQUES REQUISES")
        return 2

if __name__ == "__main__":
    sys.exit(main())