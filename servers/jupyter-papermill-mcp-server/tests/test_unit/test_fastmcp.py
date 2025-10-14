#!/usr/bin/env python3

try:
    from mcp.server.fastmcp import FastMCP
    print("[OK] FastMCP disponible")
    
    # Test creation d'une instance
    mcp = FastMCP("test")
    print("[OK] Creation d'instance FastMCP OK")
    
except ImportError as e:
    print(f"[ERROR] FastMCP non disponible: {e}")
    
    # Essayer avec le SDK de bas niveau 
    try:
        from mcp.server import Server
        print("[OK] SDK de bas niveau disponible")
    except ImportError as e2:
        print(f"[ERROR] SDK MCP completement absent: {e2}")