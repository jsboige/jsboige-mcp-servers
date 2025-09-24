#!/usr/bin/env python3
"""
Test script pour valider l'initialisation du serveur MCP Python
"""

import sys
import traceback
from pathlib import Path

# Ajout du repertoire du package au PYTHONPATH
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

try:
    print("=== Test d'initialisation du serveur MCP Python ===")
    print(f"Chemin du projet: {project_root}")
    print(f"Version Python: {sys.version}")
    print()

    # Test d'importation des modules principaux
    print("1. Test d'importation des modules...")
    from papermill_mcp.main import create_app, JupyterPapermillMCPServer
    from papermill_mcp.config import get_config, MCPConfig
    print("   ? Importation reussie")

    # Test de chargement de la configuration
    print("2. Test de chargement de la configuration...")
    try:
        config = get_config()
        print(f"   ? Configuration chargee: {config}")
    except Exception as e:
        print(f"   ? Erreur de configuration (non critique): {e}")
        config = None

    # Test de creation du serveur
    print("3. Test de creation du serveur...")
    server = JupyterPapermillMCPServer(config)
    print("   ? Serveur cree")

    # Test d'initialisation
    print("4. Test d'initialisation du serveur...")
    server.initialize()
    print("   ? Serveur initialise avec succes")

    # Liste des outils theoriquement disponibles
    expected_tools = [
        # Notebook tools
        "read_notebook", "write_notebook", "create_notebook", 
        "add_cell", "remove_cell", "update_cell",
        
        # Kernel tools  
        "list_kernels", "start_kernel", "stop_kernel", 
        "interrupt_kernel", "restart_kernel", "execute_cell",
        "execute_notebook", "execute_notebook_cell",
        
        # Execution tools
        "execute_notebook_papermill", "list_notebook_files", 
        "get_notebook_info", "get_kernel_status", "cleanup_all_kernels",
        "start_jupyter_server", "stop_jupyter_server", "debug_list_runtime_dir"
    ]
    
    print(f"\n5. Outils theoriquement disponibles ({len(expected_tools)}):")
    for i, tool in enumerate(expected_tools, 1):
        print(f"   {i:2}. {tool}")

    print("\n=== R?SULTAT: SUCCESS ===")
    print("Le serveur MCP Python s'initialise correctement !")
    
except Exception as e:
    print(f"\n=== R?SULTAT: ERROR ===")
    print(f"Erreur lors de l'initialisation: {e}")
    print("\nStack trace complete:")
    traceback.print_exc()
    sys.exit(1)