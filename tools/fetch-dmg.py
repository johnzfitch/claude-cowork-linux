#!/usr/bin/env python3
"""Fetch latest Claude Desktop DMG URL (bypasses Cloudflare via rnet)."""
import rnet, asyncio, json, sys

API = "https://claude.ai/api/desktop/darwin/universal/dmg/latest"

async def main():
    client = rnet.Client(emulation=rnet.Emulation.Chrome131)
    resp = await client.get(API)
    data = json.loads(await resp.text())
    if "--url" in sys.argv:
        print(data["url"])
    elif "--json" in sys.argv:
        print(json.dumps(data))
    else:
        print(f'{data["version"]} {data["url"]}')

asyncio.run(main())
