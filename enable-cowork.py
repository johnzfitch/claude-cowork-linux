#!/usr/bin/env python3
"""
Patch Claude Desktop to enable Cowork (yukonSilver) on Linux.

The bundled app checks process.platform in a platform-gate function (minified
name changes per build — previously wj(), currently xPt()). This patch finds
the function by its characteristic return shape and replaces it to
unconditionally return {status:"supported"}.

Usage:
    python3 enable-cowork.py <path-to-index.js> [--sweep]

Example:
    python3 enable-cowork.py linux-app-extracted/.vite/build/index.js

--sweep tells this script that the caller is iterating over index.js AND every
sibling index*.chunk-*.js itself, so a file without the platform gate is an
expected miss rather than a symptom. Both in-repo callers sweep: install.sh's
apply_patches and PKGBUILD's build(). (launch.sh applies patch-index.sh's sed
passes and never invokes this script, so it has nothing to declare.) Without
the flag, a miss on a split-entry build is reported as the stale-recipe error
it almost always is -- see _report_stale_recipe below.
"""

import sys
import os
import re
import glob
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

    # subn, like every other pass in this file, not search + splice. The marker
    # is written once per FILE, so a first-match-only rewrite leaves any second
    # occurrence in the same chunk unpatched AND marked as done -- the pass can
    # never come back for it. Nothing guarantees the bundler emits this check
    # once: it is a small helper, and minifiers inline small helpers per call
    # site. Rewriting all of them costs nothing when there is only one.
    new_content, count = AUTOMOUNT_DARWIN_LEAK_RE.subn(r'\1', content)
    if count == 0:
        print(f"  Automount-root check: no matching site found")
        return True

    new_content += AUTOMOUNT_DARWIN_LEAK_MARKER

    with open(filepath, 'w') as f:
        f.write(new_content)

    print(f"  Automount-root check patched: {count} site(s) -- darwin branch no longer treats /home as an automount root")
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


def _sibling_chunks(filepath):
    """Every index*.chunk-*.js next to `filepath`, excluding `filepath` itself.

    Same discovery rule as patch_index_collect_targets in patch-index.sh, kept
    to a glob rather than reading the shim's require() list: chunks require each
    other transitively, so following only the shim's own requires misses most of
    them (#166).
    """
    build_dir = os.path.dirname(os.path.abspath(filepath)) or '.'
    target = os.path.abspath(filepath)
    return sorted(
        c for c in glob.glob(os.path.join(build_dir, 'index*.chunk-*.js'))
        if os.path.abspath(c) != target and os.path.isfile(c)
    )


# A minified chunk runs to megabytes and a split bundle has hundreds of them, so
# the sibling scan below is bounded rather than trusting the file count.
_MARKER_SCAN_BUDGET = 256 * 1024 * 1024
# An entry shim is a few require() calls. A real chunk is orders of magnitude
# bigger, and this is the cheap test that keeps the scan off the 300-odd chunks
# a sweep legitimately misses.
_SHIM_MAX_BYTES = 256 * 1024


def _contains_marker(filepath, budget):
    """Is PATCH_MARKER in `filepath`? Returns (found, bytes_read).

    Streams in blocks rather than reading the file whole: these are minified
    bundles, and _sibling_chunks can hand back hundreds of them.
    """
    read = 0
    try:
        with open(filepath, 'r', errors='replace') as f:
            tail = ''
            while read < budget:
                block = f.read(1 << 20)
                if not block:
                    break
                read += len(block)
                # Keep an overlap so a marker straddling a block boundary is
                # still found.
                window = tail + block
                if PATCH_MARKER in window:
                    return True, read
                tail = window[-len(PATCH_MARKER):]
    except OSError:
        return False, read
    return False, read


def _looks_like_entry_shim(filepath, chunks):
    """Is `filepath` a thin entry shim whose real code is in a sibling chunk?

    This is the shape that makes a lone-file run diagnosable: a tiny file that
    require()s a chunk. Checking it first is also what keeps the marker scan
    affordable. A caller too old to pass --sweep still sweeps every target, so
    without this test the scan below would run once per gate-less file --
    hundreds of times on a split bundle, each pass re-reading its siblings.
    """
    try:
        if os.path.getsize(filepath) > _SHIM_MAX_BYTES:
            return False
        with open(filepath, 'r', errors='replace') as f:
            head = f.read(_SHIM_MAX_BYTES)
    except OSError:
        return False
    names = [os.path.basename(c) for c in chunks]
    return any(n in head for n in names)


def _report_stale_recipe(filepath):
    """Name the stale packaging recipe when a lone-file run misses the gate.

    WHY THIS EXISTS (issue #189)
    ---------------------------
    A reporter on the AUR package hit "Platform-gate function not found in
    .../.vite/build/index.js" and reasonably read it as another per-version
    pattern mismatch (#166, #185). It was not. The AUR recipe is pinned at
    pkgrel 10 -- the last release the publish workflow managed to push, on
    2026-03-26 -- and that build() runs this script against index.js alone.
    Split-entry chunk sweeping landed in pkgrel 12. Every publish run since
    2026-04-23 has failed on a malformed AUR_SSH_KEY, so the recipe froze
    two pkgrels before the fix it needed.

    The recipe is stale but this script is not: the PKGBUILD's source= is
    `git+https://github.com/johnzfitch/claude-cowork-linux.git` with no tag or
    commit fragment, so makepkg clones master and the AUR build executes an
    old build() against current scripts. That asymmetry is why this message
    can reach an affected user at all: it ships the moment it lands on master,
    with no AUR publish in between.

    So say what is actually wrong. The old text sent people hunting for a
    renamed minified function in a file that never held it.
    """
    chunks = _sibling_chunks(filepath)
    if not chunks:
        # Genuinely a single-file bundle: a miss here really is a pattern
        # problem, and the message patch_file already printed is the right one.
        return
    if not _looks_like_entry_shim(filepath, chunks):
        # A real chunk that happens to lack the gate. On a split bundle that is
        # every chunk but one, so saying anything here would be noise.
        return

    budget = _MARKER_SCAN_BUDGET
    for c in chunks:
        found, read = _contains_marker(c, budget)
        if found:
            # A sibling already carries the gate patch. This run is one
            # iteration of a sweep whose caller predates --sweep: expected.
            return
        budget -= read
        if budget <= 0:
            # Out of budget with no marker seen. Unproven either way, so stay
            # quiet rather than blame a recipe that may be fine.
            return

    build_dir = os.path.dirname(os.path.abspath(filepath)) or '.'
    name = os.path.basename(filepath)
    print()
    print("  This looks like a STALE PACKAGING RECIPE, not a new bundle layout.")
    print(f"  {build_dir} holds {len(chunks)} index*.chunk-*.js file(s), and this run")
    print(f"  was given only {name}, which is a thin require() shim. On split-entry")
    print("  builds the platform gate lives in one of those chunks, so a caller that")
    print(f"  patches {name} alone can never find it.")
    print()
    print("  If you are building from the AUR: that recipe is older than this script.")
    print("  The package's source= clones this repo at master, so the scripts are")
    print("  current while the recipe that drives them is not. Build from the repo:")
    print()
    print("    git clone https://github.com/johnzfitch/claude-cowork-linux")
    print("    cd claude-cowork-linux")
    print("    makepkg -si          # or: ./install.sh")
    print()
    print("  Tracking issue: https://github.com/johnzfitch/claude-cowork-linux/issues/189")
    print("  A caller that sweeps every chunk itself should pass --sweep after the")
    print("  path; this note is then suppressed for its expected misses.")


if __name__ == "__main__":
    # --sweep is accepted in any position but documented as trailing the path,
    # and that ordering matters for more than style: install.sh resolves the
    # patcher from $INSTALL_DIR when the source tree has none, so a new caller
    # can pair with an older copy of this script. An older copy reads
    # sys.argv[1] as the target and ignores the rest, so `<path> --sweep`
    # degrades to the old behaviour while `--sweep <path>` would make it try to
    # open "--sweep".
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    unknown = flags - {'--sweep'}
    if unknown:
        print(f"ERROR: unknown option(s): {' '.join(sorted(unknown))}")
        print(__doc__)
        sys.exit(2)
    if not args:
        print(__doc__)
        sys.exit(1)

    target = args[0]
    # Callers that iterate every discovered target declare it, either with the
    # flag or with COWORK_PATCH_SWEEP=1 for a caller that cannot easily add an
    # argument. Either way it means "a miss in this file is expected".
    sweeping = '--sweep' in flags or os.environ.get('COWORK_PATCH_SWEEP') == '1'

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

    # A miss is only worth explaining when nobody else is going to patch the
    # gate. Printed last so it is the final thing in the build log, after the
    # per-pass notes that otherwise read as five separate failures.
    #
    # Deliberately does NOT change the exit code, for the same reason as
    # _warn_if_unparseable: both callers treat non-zero as "no platform gate in
    # this file", and install.sh's apply_patches counts on that to decide
    # whether ANY target was patched.
    if not gate_patched and not sweeping:
        _report_stale_recipe(target)

    # Exit code still reports only the platform gate: install.sh uses it to
    # decide whether Cowork was actually enabled across the whole bundle.
    sys.exit(0 if gate_patched else 1)
