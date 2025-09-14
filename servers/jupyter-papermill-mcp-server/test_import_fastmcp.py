#!/usr/bin/env python3

try:
    import papermill_mcp.main_fastmcp
    print("✅ Import du module FastMCP OK")
    
    # Test accès au serveur MCP
    from papermill_mcp.main_fastmcp import mcp
    print(f"✅ Serveur MCP créé: {mcp.name}")
    
    # Lister les outils enregistrés
    tools = [func.__name__ for func in mcp._tools]
    print(f"✅ Nombre d'outils enregistrés: {len(tools)}")
    print("Outils disponibles:")
    for tool in tools:
        print(f"  - {tool}")
        
except ImportError as e:
    print(f"❌ Erreur d'import: {e}")
except Exception as e:
    print(f"❌ Erreur: {e}")