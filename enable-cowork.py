#!/usr/bin/env python3
"""
Patch Claude Desktop to enable Cowork (yukonSilver) on Linux.

The bundled app checks process.platform in a platform-gate function (minified
name changes per build — previously wj(), currently xPt()). This patch finds
the function by its characteristic return shape and replaces it to
unconditionally return {status:"supported"}.

Usage:
    python3 enable-cowork.py <path-to-index.js>

Example:
    python3 enable-cowork.py linux-app-extracted/.vite/build/index.js
"""

import sys
import re

# Known exact patterns per version (tried first for speed)
KNOWN_PATTERNS = [
    # v1.1.3963 — function xPt()
    ('function xPt(){const t=process.platform;if(t!=="darwin"&&t!=="win32")return{status:"unsupported"',
     'xPt'),
    # Older builds — function wj()
    ('function wj(){return process.platform!=="darwin"?{status:"unsupported",reason:"Darwin only"}',
     'wj'),
]

# Regex fallback: matches any function whose body starts with a platform check
# and returns {status:"unsupported"} for non-darwin platforms
PLATFORM_GATE_RE = re.compile(
    r'function (\w+)\(\)\{'
    r'(?:const \w+=process\.platform;)?'
    r'(?:return )?'
    r'(?:if\(\w+!=="darwin"|\w+!=="darwin"\?)'
    r'[^}]*status:"unsupported"'
)


def find_function_bounds(content, start):
    """Find the end of a function starting at `start` by counting braces."""
    depth = 0
    i = start
    while i < len(content):
        if content[i] == '{':
            depth += 1
        elif content[i] == '}':
            depth -= 1
            if depth == 0:
                return content[start:i+1]
        i += 1
    return None


PATCH_MARKER = '/*cowork-patched*/'


def patch_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Check if already patched via marker
    if PATCH_MARKER in content:
        print(f"Already patched: {filepath}")
        return True

    # Try known exact patterns first
    func_name = None
    func_full = None
    for prefix, name in KNOWN_PATTERNS:
        if prefix in content:
            idx = content.find(prefix)
            func_full = find_function_bounds(content, idx)
            if func_full:
                func_name = name
                break

    # Regex fallback for unknown minified names
    if not func_name:
        match = PLATFORM_GATE_RE.search(content)
        if match:
            func_name = match.group(1)
            func_full = find_function_bounds(content, match.start())

    if not func_name or not func_full:
        print(f"ERROR: Platform-gate function not found in {filepath}")
        print("  Searched for known patterns (xPt, wj) and regex fallback.")
        print("  The minified function name may have changed — inspect index.js for")
        print("  a function checking process.platform and returning {{status:\"unsupported\"}}.")
        return False

    new_code = f'function {func_name}(){{return{{status:"supported"}}}}{PATCH_MARKER}'
    content = content.replace(func_full, new_code, 1)

    with open(filepath, 'w') as f:
        f.write(content)

    print(f"SUCCESS: Patched {filepath}")
    print(f"  {func_name}() now returns {{status:\"supported\"}} unconditionally")
    return True

HOST_PLATFORM_THROW_RE = re.compile(
    r'throw new Error\([^)]*Unsupported platform[^)]*\)'
)


def patch_host_platform(filepath):
    """Patch getHostPlatform() to return 'darwin-x64' instead of throwing on Linux.

    The minified getHostPlatform() method only handles darwin and win32,
    throwing Error('Unsupported platform: ...') for anything else.
    Replace the throw with return"darwin-x64" so session init succeeds.
    """
    with open(filepath, 'r') as f:
        content = f.read()

    match = HOST_PLATFORM_THROW_RE.search(content)
    if not match:
        print(f"  getHostPlatform(): no throw found (already patched or not present)")
        return True

    content = HOST_PLATFORM_THROW_RE.sub('return"darwin-x64"', content)

    with open(filepath, 'w') as f:
        f.write(content)

    print(f"  getHostPlatform() patched: throw replaced with return\"darwin-x64\"")
    return True


# Bypass IPC origin-validation guards.
#
# In a packaged build, the renderer is served via the app:// protocol and each
# IPC channel's main-process handler checks i.senderFrame.url against an
# interface-specific allowlist. When running unpacked from file:// (which is
# what we do on Linux), every one of those ~560 guard sites throws, and the
# preload script that calls DesktopIntl.getInitialLocale() aborts before it
# can install the contextBridge polyfills the renderer needs ("process is not
# defined"). Each call site looks like:
#
#   if(!FUNC(i))throw new Error(`Incoming "METHOD" call on interface "IFACE"
#                                from '${...}' did not pass origin validation`)
#
# 38+ distinct minified validator names. Replacing `!FUNC(i)` with `false`
# at every site short-circuits the throw without touching validator bodies.
#
# Security: bypassing the origin check on a local desktop app is equivalent
# to standard dev-mode Electron — the renderer is loaded only by Electron
# from disk, not from network. No new attack surface vs. packaged macOS build.
IPC_ORIGIN_GUARD_RE = re.compile(
    r'if\(!\w+\(i\)\)(throw new Error\(`[^`]*did not pass origin validation`\))'
)
IPC_PATCH_MARKER = '/*cowork-ipc-patched*/'


def patch_ipc_origin_guards(filepath):
    """Bypass all IPC origin-validation throws so preload scripts execute under
    file:// origin instead of failing on getInitialLocale and similar calls."""
    with open(filepath, 'r') as f:
        content = f.read()

    if IPC_PATCH_MARKER in content:
        print(f"  IPC origin guards: already patched")
        return True

    new_content, count = IPC_ORIGIN_GUARD_RE.subn(r'if(false)\1', content)
    if count == 0:
        print(f"  IPC origin guards: no matching sites found")
        return True

    # Stamp once at end so re-runs are no-ops
    new_content += IPC_PATCH_MARKER

    with open(filepath, 'w') as f:
        f.write(new_content)

    print(f"  IPC origin guards patched: {count} call sites short-circuited")
    return True


# Patch return-style platform gates (issue #114).
#
# Some functions (e.g. Mrt() for Chrome extension installer) use
# return {status: Error, error: `Unsupported platform: ...`} instead of
# throw. The HOST_PLATFORM_THROW_RE regex doesn't match these.
PLATFORM_RETURN_GATE_RE = re.compile(
    r'return\s*\{[^}]*error:\s*`Unsupported platform:\s*\$\{process\.platform\}[^`]*`[^}]*\}'
)
PLATFORM_RETURN_MARKER = '/*cowork-platform-return-patched*/'


def patch_platform_return_gates(filepath):
    """Neutralize return-style 'Unsupported platform' gates that block features
    like Chrome extension installation on Linux."""
    with open(filepath, 'r') as f:
        content = f.read()

    if PLATFORM_RETURN_MARKER in content:
        print(f"  Platform return gates: already patched")
        return True

    new_content, count = PLATFORM_RETURN_GATE_RE.subn(
        'return{status:"supported"}', content
    )
    if count == 0:
        print(f"  Platform return gates: no matching sites found")
        return True

    new_content += PLATFORM_RETURN_MARKER

    with open(filepath, 'w') as f:
        f.write(new_content)

    print(f"  Platform return gates patched: {count} sites neutralized")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    success = patch_file(sys.argv[1])
    if success:
        patch_host_platform(sys.argv[1])
        patch_ipc_origin_guards(sys.argv[1])
        patch_platform_return_gates(sys.argv[1])
    sys.exit(0 if success else 1)
