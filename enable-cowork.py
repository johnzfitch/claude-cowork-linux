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
# and returns {status:"unsupported"} for non-darwin platforms. Vite changed
# minification style in Desktop 1.28929.0: the main-process gate moved to an
# index2.chunk-* file and uses template-literal quotes (`darwin`) rather than
# string quotes ("darwin"). Accept all three JavaScript quote styles.
PLATFORM_GATE_RE = re.compile(
    r'function (\w+)\(\)\{'
    r'(?:(?:const|let|var) \w+=process\.platform;)?'
    r'(?:return )?'
    r'(?:if\(\w+!==(["\'`])darwin\2|\w+!==(["\'`])darwin\3\?)'
    r'[^}]*status:(["\'`])unsupported\4'
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
        print("  Searched for known patterns (xPt, wj) and quote-agnostic regex fallback.")
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


# Extend IPC origin-validation guards to accept file:// origins.
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
# 38+ distinct minified validator names. Rather than disabling all checks, we
# add a file:// origin exemption at each call site: the original FUNC(i) still
# validates non-file:// origins (e.g. would reject http://evil.com), so the
# defense-in-depth layer is preserved for everything except our local renderer.
#
# The validator name and the sender-arg name are both minified and rotate per
# build (e.g. the arg was `i` in older builds and is `n` in 1.19367.0; validator
# names like `$m` even contain `$`), so match both with [\w$]+ and reuse the
# captured arg in the exemption rather than hardcoding it.
IPC_ORIGIN_GUARD_RE = re.compile(
    r'if\(!([\w$]+)\(([\w$]+)\)\)(throw (?:new )?Error\(`[^`]*did not pass origin validation`\))'
)
IPC_PATCH_MARKER = '/*cowork-ipc-patched*/'


def patch_ipc_origin_guards(filepath):
    """Add file:// as an accepted origin at each IPC validation call site,
    preserving the original validator for all other origins."""
    with open(filepath, 'r') as f:
        content = f.read()

    if IPC_PATCH_MARKER in content:
        print(f"  IPC origin guards: already patched")
        return True

    # Replace if(!FUNC(ARG)) with
    #   if(!FUNC(ARG)&&!(ARG.senderFrame&&ARG.senderFrame.url&&ARG.senderFrame.url.startsWith("file://")))
    # This lets file:// through while keeping the validator for everything else.
    new_content, count = IPC_ORIGIN_GUARD_RE.subn(
        r'if(!\1(\2)&&!(\2.senderFrame&&\2.senderFrame.url&&\2.senderFrame.url.startsWith("file://")))\3',
        content
    )
    if count == 0:
        print(f"  IPC origin guards: no matching sites found")
        return True

    new_content += IPC_PATCH_MARKER

    with open(filepath, 'w') as f:
        f.write(new_content)

    print(f"  IPC origin guards patched: {count} call sites — file:// origin exempted, other origins still validated")
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


# Claude Code spools large MCP results beneath
#   <config>/projects/<session>/tool-results/<tool-id>.json
# and then asks the host Read tool to open that file. On Linux the desktop's
# safe-path resolver rejects the session storage prefix as an "automount root"
# before the normal allowed-root check runs. Only bypass that first resolver
# for SDK-owned tool-result files; the existing containment check immediately
# after this block still enforces the configured projects root.
TOOL_RESULT_RESOLVE_RE = re.compile(
    r'let ([\w$]+);try\{\1=await ([\w$]+)\.resolveFilePath\(([\w$]+),!0\)\}'
)
TOOL_RESULT_RESOLVE_MARKER = '/*cowork-tool-result-resolve-patched*/'


def patch_tool_result_resolution(filepath):
    """Allow host Read to consume SDK-spooled MCP tool-result files on Linux."""
    with open(filepath, 'r') as f:
        content = f.read()

    if TOOL_RESULT_RESOLVE_MARKER in content:
        print("  Tool-result path resolution: already patched")
        return True

    def replacement(match):
        resolved, helpers, candidate = match.groups()
        owned_result = (
            f'/(?:^|\\/)\\.claude\\/projects\\/.+\\/tool-results\\/[^\\/]+$/.test({candidate})'
        )
        return (
            f'let {resolved};if({owned_result}){resolved}={candidate};'
            f'else try{{{resolved}=await {helpers}.resolveFilePath({candidate},!0)}}'
        )

    new_content, count = TOOL_RESULT_RESOLVE_RE.subn(replacement, content)
    if count == 0:
        print("  Tool-result path resolution: no matching sites found")
        return True

    new_content += TOOL_RESULT_RESOLVE_MARKER
    with open(filepath, 'w') as f:
        f.write(new_content)

    print(f"  Tool-result path resolution patched: {count} host-loop sites")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    # The split bundle can place the Cowork platform gate and auxiliary patch
    # sites in different chunks (Desktop 1.28929.0 does this for IPC origin
    # guards). Always inspect every file passed by install.sh/launch.sh. Keep
    # the exit-code contract tied to the platform gate so apply_patches still
    # reports success only when the actual Cowork gate was found.
    success = patch_file(sys.argv[1])
    patch_host_platform(sys.argv[1])
    patch_ipc_origin_guards(sys.argv[1])
    patch_platform_return_gates(sys.argv[1])
    patch_tool_result_resolution(sys.argv[1])
    sys.exit(0 if success else 1)
