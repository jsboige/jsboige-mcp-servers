#!/usr/bin/env python3
"""Test d'importation du module papermill_mcp"""

try:
    import papermill_mcp.main_working as main
    print("[OK] Module papermill_mcp.main_working importe avec succes")
    
    # Test de creation du serveur
    print(f"[OK] Serveur cree: {main.app.name}")
    
    # Test des outils (sans les executer)
    import asyncio
    async def test_list_tools():
        tools = await main.list_tools()
        print(f"[OK] {len(tools)} outils disponibles:")
        for tool in tools:
            print(f"  - {tool.name}: {tool.description}")
    
    asyncio.run(test_list_tools())
    print("[OK] Tests de base reussis")
    
except Exception as e:
    print(f"[ERROR] Erreur: {e}")
    import traceback
    traceback.print_exc()