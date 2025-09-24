#!/usr/bin/env python3

try:
    import papermill_mcp.main_fastmcp
    print("[OK] Import du module FastMCP OK")
    
    # Test acces au serveur MCP
    from papermill_mcp.main_fastmcp import mcp
    print(f"[OK] Serveur MCP cree: {mcp.name}")
    
    # Lister les outils enregistres
    tools = [func.__name__ for func in mcp._tools]
    print(f"[OK] Nombre d'outils enregistres: {len(tools)}")
    print("Outils disponibles:")
    for tool in tools:
        print(f"  - {tool}")
        
except ImportError as e:
    print(f"[ERROR] Erreur d'import: {e}")
except Exception as e:
    print(f"[ERROR] Erreur: {e}")