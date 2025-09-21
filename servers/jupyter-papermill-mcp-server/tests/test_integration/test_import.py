#!/usr/bin/env python3
"""Test d'importation du module papermill_mcp"""

try:
    import papermill_mcp.main_working as main
    print("✅ Module papermill_mcp.main_working importé avec succès")
    
    # Test de création du serveur
    print(f"✅ Serveur créé: {main.app.name}")
    
    # Test des outils (sans les exécuter)
    import asyncio
    async def test_list_tools():
        tools = await main.list_tools()
        print(f"✅ {len(tools)} outils disponibles:")
        for tool in tools:
            print(f"  - {tool.name}: {tool.description}")
    
    asyncio.run(test_list_tools())
    print("✅ Tests de base réussis")
    
except Exception as e:
    print(f"❌ Erreur: {e}")
    import traceback
    traceback.print_exc()