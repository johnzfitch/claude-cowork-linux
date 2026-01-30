#!/usr/bin/env python3
"""
Patch Claude Desktop to enable Cowork (yukonSilver) on Linux.

The bundled app checks process.platform === 'darwin' in the wj() function.
This patch makes wj() unconditionally return {status:"supported"}.

Usage:
    python3 patches/enable-cowork.py <path-to-index.js>

Example:
    python3 patches/enable-cowork.py squashfs-root/usr/lib/node_modules/electron/dist/resources/app/.vite/build/index.js
"""

import sys
import re

OLD_PATTERN = 'function wj(){return process.platform!=="darwin"?{status:"unsupported",reason:"Darwin only"}:process.arch!=="arm64"?{status:"unsupported",reason:"arm64 only"}:gj().major<14?{status:"unsupported",reason:"minimum macOS version not met"}:{status:"supported"}}'

NEW_CODE = 'function wj(){return{status:"supported"}}'

def patch_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    if NEW_CODE in content:
        print(f"Already patched: {filepath}")
        return True

    if OLD_PATTERN not in content:
        # Try to find wj function with regex for diagnostics
        match = re.search(r'function wj\(\)\{[^}]+\}', content)
        if match:
            print(f"ERROR: wj() found but pattern differs:")
            print(f"  Found: {match.group()[:100]}...")
        else:
            print(f"ERROR: wj() function not found in {filepath}")
        return False

    content = content.replace(OLD_PATTERN, NEW_CODE)

    with open(filepath, 'w') as f:
        f.write(content)

    print(f"SUCCESS: Patched {filepath}")
    print(f"  wj() now returns {{status:\"supported\"}} unconditionally")
    return True

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    success = patch_file(sys.argv[1])
    sys.exit(0 if success else 1)
