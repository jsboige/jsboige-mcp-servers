#!/usr/bin/env python3

try:
    from mcp.server.fastmcp import FastMCP
    print("✅ FastMCP disponible")
    
    # Test création d'une instance
    mcp = FastMCP("test")
    print("✅ Création d'instance FastMCP OK")
    
except ImportError as e:
    print(f"❌ FastMCP non disponible: {e}")
    
    # Essayer avec le SDK de bas niveau 
    try:
        from mcp.server import Server
        print("✅ SDK de bas niveau disponible")
    except ImportError as e2:
        print(f"❌ SDK MCP complètement absent: {e2}")