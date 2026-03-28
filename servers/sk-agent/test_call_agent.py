import asyncio
import subprocess
import sys

async def test_call_agent():
    # Test call_agent with analyst
    code = """
import asyncio
from sk_agent import call_agent
result = await call_agent("analyst", "What is 2+2? Answer in one sentence.")
print(result)
"""
    
    result = subprocess.run(
        ["D:/dev/roo-extensions/mcps/internal/servers/sk-agent/venv/Scripts/python.exe", "-c", code],
        capture_output=True,
        text=True,
        timeout=120,
        cwd="D:/dev/roo-extensions/mcps/internal/servers/sk-agent"
    )
    
    print("=== CALL_AGENT(analyst, 'What is 2+2?') ===")
    print(result.stdout[:3000])
    if result.stderr:
        print("\n=== STDERR ===")
        print(result.stderr[:1000])

asyncio.run(test_call_agent())
