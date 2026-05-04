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

# Regex for getHostPlatform(): matches `throw new Error(...)` containing
# "Unsupported platform" — the platform block in the session-init path.
# Must not match unrelated "Unsupported platform" in chrome mcp
HOST_PLATFORM_THROW_RE = re.compile(
    r'throw new Error\([^)]*Unsupported platform[^)]*\)'
)


# Regex for VM file-list lookups: .files[platform][arch]??[]
# Eo.files only has darwin/win32 keys. First bracket returned undefined
VM_FILES_LOOKUP_RE = re.compile(
    r'(\.files\[\w+\])\[(\w+)\](\?\?\[\])'
)


def patch_vm_files_lookup(filepath):
    """Add optional chaining to VM file-list lookups for Linux safety.

    The minified asar has functions like:
        function hae(){const e=process.platform,A=Qae();return Eo.files[e][A]??[]}
    Eo.files only has 'darwin' and 'win32' keys. On Linux, Eo.files["linux"]
    is undefined, so [A] on it throws TypeError. Adding ?. makes the access
    return undefined instead, which ?? catches and returns [].
    """
    with open(filepath, 'r') as f:
        content = f.read()

    matches = VM_FILES_LOOKUP_RE.findall(content)
    if not matches:
        print("  vm files lookup: no unsafe patterns found (already patched or not present)")
        return True

    content = VM_FILES_LOOKUP_RE.sub(r'\1?.[\2]\3', content)

    with open(filepath, 'w') as f:
        f.write(content)

    print(f"  vm files lookup patched: {len(matches)} unsafe .files[platform][arch] access(es) fixed")
    return True


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

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    success = patch_file(sys.argv[1])
    if success:
        patch_host_platform(sys.argv[1])
        patch_vm_files_lookup(sys.argv[1])
    sys.exit(0 if success else 1)
