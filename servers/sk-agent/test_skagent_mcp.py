import asyncio
import sys
import subprocess
import json
import re

# Test via sk-agent MCP tools using stdio
async def test_via_mcp():
    # Call list_agents MCP tool
    result = subprocess.run(
        ["D:/dev/roo-extensions/mcps/internal/servers/sk-agent/venv/Scripts/python.exe", 
         "-c", 
         "import asyncio; from sk_agent import list_agents; print(asyncio.run(list_agents()))"],
        capture_output=True,
        text=True,
        timeout=60,
        cwd="D:/dev/roo-extensions/mcps/internal/servers/sk-agent"
    )
    
    output = result.stdout
    print("=== LIST_AGENTS OUTPUT ===")
    print(output[:2000])
    
    # Count agents by looking for "## " headers
    agents = re.findall(r'^## ([^\n]+)', output, re.MULTILINE)
    print(f"\nFOUND {len(agents)} AGENTS:")
    for agent in agents[:10]:
        print(f"  - {agent}")

asyncio.run(test_via_mcp())
