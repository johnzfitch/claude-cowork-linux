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
import shutil
import subprocess

# Minifiers emit string literals as either double quotes or template literals;
# 1.26832.0 switched the main bundle wholesale from "darwin" to `darwin`. Match
# either so a quote-style flip alone can't silently disable every patch below.
Q = r'["`]'

# Known exact patterns per version (tried first for speed)
KNOWN_PATTERNS = [
    # v1.26832.0 — function ke(), backtick literals and `let`
    ('function ke(){let t=process.platform;if(t!==`darwin`&&t!==`win32`)return{status:`unsupported`',
     'ke'),
    # v1.1.3963 — function xPt()
    ('function xPt(){const t=process.platform;if(t!=="darwin"&&t!=="win32")return{status:"unsupported"',
     'xPt'),
    # Older builds — function wj()
    ('function wj(){return process.platform!=="darwin"?{status:"unsupported",reason:"Darwin only"}',
     'wj'),
]

# Regex fallback: matches any function whose body starts with a platform check
# and returns {status:"unsupported"} for non-darwin platforms. The declaration
# keyword (const/let/var), the quote style, and minified names that contain `$`
# all rotate between builds, so none of them are pinned here.
PLATFORM_GATE_RE = re.compile(
    r'function ([\w$]+)\(\)\{'
    r'(?:(?:const|let|var) [\w$]+=process\.platform;)?'
    r'(?:return )?'
    r'(?:if\([\w$]+!==' + Q + r'darwin' + Q + r'|[\w$]+!==' + Q + r'darwin' + Q + r'\?)'
    r'[^}]*status:' + Q + r'unsupported' + Q
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
        known = ", ".join(name for _, name in KNOWN_PATTERNS)
        print(f"  Searched for known patterns ({known}) and regex fallback.")
        print(f"  The minified function name may have changed — inspect {filepath} for")
        print('  a function checking process.platform and returning {status:"unsupported"}.')
        return False

    new_code = f'function {func_name}(){{return{{status:"supported"}}}}{PATCH_MARKER}'
    content = content.replace(func_full, new_code, 1)

    with open(filepath, 'w') as f:
        f.write(content)

    print(f"SUCCESS: Patched {filepath}")
    print(f"  {func_name}() now returns {{status:\"supported\"}} unconditionally")
    return True

# `new` is optional: 1.26832.0 emits a bare `throw Error(...)` here.
#
# The argument is matched with a paren-aware sub-pattern, not [^)]*. A bare
# [^)]* stops at the FIRST ')', so a message built with a call in it --
#   throw new Error("Unsupported platform: "+getPlatformName())
# -- matched only up to `getPlatformName(`, and substituting the replacement
# left the call's closing paren behind as `return"darwin-x64")`. That is a
# syntax error, and patch_host_platform still returned True, so the whole script
# printed SUCCESS and exited 0 on a bundle it had just corrupted. Template
# literals interpolating a call, e.g. `${a.it()}`, hit the same shape.
#
# (?:[^()]|\([^()]*\))* allows one level of nesting, which covers a call in the
# message. Deeper nesting still won't match -- that fails closed (no
# substitution) rather than producing invalid JS.
_ERR_ARG = r'(?:[^()]|\([^()]*\))*'
HOST_PLATFORM_THROW_RE = re.compile(
    r'throw (?:new )?Error\(' + _ERR_ARG + r'Unsupported platform' + _ERR_ARG + r'\)'
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


# Stop the darwin platform spoof from leaking into a general Linux path-safety
# check (issue #172).
#
# The bundle's automount-root check treats a path as an untrusted "automount
# root" using one of two regexes, chosen by process.platform:
#   darwin:        /^\/(net|home)(\/|$)/
#   everything else: /^\/net(\/|$)/
# Because this project spoofs process.platform to "darwin" so the Cowork gate
# returns "supported", this check also sees darwin and applies the macOS
# rule, which additionally treats anything under /home as an automount root.
# That's correct on real macOS, where network homes are commonly automounted
# under /home; on Linux, /home is the normal, non-automounted home hierarchy,
# so every path under it gets refused as "a protected location" instead.
#
# Confirmed on 1.26832.0 to be reachable from Cowork's attach-folder
# enumeration (every subfolder of $HOME is checked against this and, today,
# refused) via a { refuseSubstitutedPath: <this function> } option passed to
# the shared path resolver, and is the most likely mechanism behind #172's
# report that MCP tool-result files under ~/.claude and local-agent-mode
# session outputs get rejected the same way.
#
# The fix forces the non-darwin regex unconditionally: this compat layer only
# ever runs on real Linux, so there is no case where the darwin branch should
# apply here regardless of the spoof. /net stays refused either way -- this
# doesn't weaken the check or bypass any resolver, it corrects which
# platform's rule the existing check evaluates.
AUTOMOUNT_DARWIN_BRANCH = re.escape('?/^\\/(net|home)(\\/|$)/:')
AUTOMOUNT_LINUX_BRANCH = re.escape('/^\\/net(\\/|$)/')
AUTOMOUNT_DARWIN_LEAK_RE = re.compile(
    r'process\.platform===' + Q + r'darwin' + Q +
    AUTOMOUNT_DARWIN_BRANCH + r'(' + AUTOMOUNT_LINUX_BRANCH + r')'
)
AUTOMOUNT_DARWIN_LEAK_MARKER = '/*cowork-automount-patched*/'


def patch_automount_darwin_leak(filepath):
    """Stop the darwin platform spoof from making the automount-root check
    treat every path under /home as untrusted (issue #172)."""
    with open(filepath, 'r') as f:
        content = f.read()

    if AUTOMOUNT_DARWIN_LEAK_MARKER in content:
        print(f"  Automount-root check: already patched")
        return True

    match = AUTOMOUNT_DARWIN_LEAK_RE.search(content)
    if not match:
        print(f"  Automount-root check: no matching site found")
        return True

    content = content[:match.start()] + match.group(1) + content[match.end():]
    content += AUTOMOUNT_DARWIN_LEAK_MARKER

    with open(filepath, 'w') as f:
        f.write(content)

    print(f"  Automount-root check patched: darwin branch no longer treats /home as an automount root")
    return True


def _warn_if_unparseable(filepath):
    """Warn loudly if the patched file is no longer valid JavaScript.

    Best-effort: silently skipped when node isn't on PATH, since node is a
    hard dependency of the packaging path but not of this script.
    """
    node = shutil.which('node')
    if not node:
        return
    try:
        result = subprocess.run(
            [node, '--check', filepath],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return
    if result.returncode != 0:
        detail = (result.stderr or '').strip().splitlines()
        print(
            f"ERROR: {filepath} is not valid JavaScript after patching.\n"
            "       A patch pattern matched more or less than intended. This file\n"
            "       would load as a blank window; do not ship it.",
            file=sys.stderr,
        )
        for line in detail[:5]:
            print(f"       {line}", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    target = sys.argv[1]

    # The platform gate lives in exactly one file, but the IPC origin guards,
    # getHostPlatform() throw, and return-style gates are spread across many
    # chunks of a split-entry build. Gating those on the platform gate being
    # present in the *same* file meant they were silently skipped in every
    # chunk that didn't happen to also hold the gate. Run them unconditionally;
    # each is independently marker-guarded and no-ops when it finds no match.
    gate_patched = patch_file(target)
    patch_host_platform(target)
    patch_ipc_origin_guards(target)
    patch_platform_return_gates(target)
    patch_automount_darwin_leak(target)

    # Every pass above is a regex substitution into minified JS, so a pattern
    # that matches slightly more or less than intended produces a file that is
    # no longer valid JavaScript. That used to be invisible: the passes report
    # success from having substituted something, not from the result parsing,
    # so a corrupted bundle still printed SUCCESS and exited 0, and surfaced
    # much later as a blank window with no clue which pass did it.
    #
    # Deliberately does NOT change the exit code. Both callers treat non-zero as
    # "no platform gate in this file", which is an expected, silent condition for
    # most chunks -- failing that way would hide the corruption rather than
    # surface it. Warn on stderr instead: install.sh lets it through, and
    # PKGBUILD captures 2>&1 and prints it for any file it patched.
    _warn_if_unparseable(target)

    # Exit code still reports only the platform gate: install.sh uses it to
    # decide whether Cowork was actually enabled across the whole bundle.
    sys.exit(0 if gate_patched else 1)
