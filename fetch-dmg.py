#!/usr/bin/env python3
"""Fetch latest Claude Desktop DMG URL (bypasses Cloudflare via rnet).

Outputs:
  (default)   VERSION URL [SHA256]
  --url       URL only
  --sha256    SHA256 only (empty if not provided by API)
  --json      Full API response as JSON
"""
import rnet, asyncio, json, sys

API = "https://claude.ai/api/desktop/darwin/universal/dmg/latest"

async def main():
    client = rnet.Client(emulation=rnet.Emulation.Chrome131)
    resp = await client.get(API)
    data = json.loads(await resp.text())

    sha256 = data.get("sha256", data.get("checksum", ""))

    if "--url" in sys.argv:
        print(data["url"])
    elif "--sha256" in sys.argv:
        print(sha256)
    elif "--json" in sys.argv:
        print(json.dumps(data))
    else:
        parts = [data["version"], data["url"]]
        if sha256:
            parts.append(sha256)
        print(" ".join(parts))

asyncio.run(main())
