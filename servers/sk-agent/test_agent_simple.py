import asyncio
import sys
sys.path.insert(0, '.')

async def main():
    from sk_agent import call_agent

    print("Testing call_agent(analyst, 'What is 2+2?')...")
    try:
        result = await call_agent("analyst", "What is 2+2? Answer in one sentence.")
        print("\n=== RESULT ===")
        print(result)
        return "SUCCESS"
    except Exception as e:
        print(f"\n=== ERROR ===")
        print(f"{type(e).__name__}: {e}")
        return "ERROR"

if __name__ == "__main__":
    status = asyncio.run(main())
    print(f"\nSTATUS: {status}")
