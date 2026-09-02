#!/bin/bash
# ============================================================
# Shared main-process patch passes (single source of truth)
# ============================================================
#
# This file is SOURCED, never executed. It is the one definition of the sed
# passes applied to Claude Desktop's minified main-process bundle, plus the
# chunk-discovery and syntax-check machinery around them.
#
# Consumers:
#   - launch.sh          sources this and calls patch_index_apply_all before repacking
#   - PKGBUILD build()   sources this and calls patch_index_apply_all at build time
#   - install.sh         gets these passes by invoking launch.sh at run time, and
#                        copies this file into $INSTALL_DIR alongside launch.sh
#   - tests/test-cowork-patch.sh sources this directly to exercise the passes
#
# WHY THIS FILE EXISTS (issue #170)
# --------------------------------
# launch.sh and PKGBUILD used to carry two hand-maintained copies of the pass
# list. They drifted: launch.sh grew to 9 passes while PKGBUILD's build() stayed
# at 3. Because /usr/bin/claude-cowork execs electron directly against the
# packaged asar and never calls launch.sh, AUR users silently lost the other six.
#
# Two of those six actually regressed the AUR build:
#   - the unguarded `process.resourcesPath,"app.asar"` join, which left
#     shellPathWorker.js resolving to a nonexistent file and broke login-shell
#     PATH priming;
#   - the mainView.js preload-origin patch, which left CoworkSpaces unexposed to
#     the renderer (empty Projects page, spaces not persisting).
#
# The other four did not, and it is worth saying so here so nobody re-adds them
# expecting a fix. The resourcesPath and MCP node-host passes are both gated on
# app.isPackaged, and both launchers start electron with a *path argument*, so
# process.defaultApp is true, isPackaged is false, and those seds rewrite a
# branch that is never taken (see the same note at the resourcesPath pass
# below). The Handoff pair and the --effort remap are independently covered by
# frame-fix-wrapper.js and session_orchestrator.js, which PKGBUILD does install.
#
# In particular this is NOT the cause of "MCP Filesystem: Node host not found".
# #170 said it was; that was reasoning from "the pass is missing" to "the symptom
# must occur" without checking the branch was reachable, and the issue title
# still carries it.
#
# The drift was invisible because both builds "worked". Keeping one list makes
# it unrepresentable rather than merely tested for.
#
# CONTRACT
# --------
#   patch_index_collect_targets <build_dir>
#       Populates the global INDEX_TARGETS array with the main-process code
#       files to patch. Returns 0 even when nothing is found.
#
#   patch_index "<log message>" "<grep -E guard>" "<sed -E script>"
#       Applies the sed to every file in INDEX_TARGETS matching the guard.
#       Logs once if any file matched; warns once if none did. Always returns 0.
#
#   patch_index_verify_syntax
#       node --check every file in INDEX_TARGETS. Warns and returns 0 by
#       default; returns 1 on a parse error when PATCH_INDEX_STRICT_SYNTAX=1.
#
#   patch_index_apply_all <build_dir>
#       collect targets -> every pass, in order -> mainView.js -> verify syntax.
#       Returns 0, except that it propagates a strict-mode syntax failure.
#
# RETURN CONTRACT
# ---------------
# The syntax check is the ONLY thing that can make any of these return non-zero,
# and only when the caller opts in with PATCH_INDEX_STRICT_SYNTAX=1. Everything
# else returns 0 unconditionally -- in particular a pass that matches nothing is
# not an error. PKGBUILD's build() runs under makepkg's `set -e`, so a function
# whose last command is a failing test (the `[ -n "$matched" ] && echo` shape
# launch.sh used) would abort the package build the first time a pass
# legitimately found nothing.
#
# ADDING A PASS
# -------------
# Add it to patch_index_apply_all below and nowhere else. Both consumers pick
# it up automatically. Mind the ordering note on the last two passes.

# Warn when a pass matches nothing. Silent no-ops are this project's worst
# failure mode -- #166 shipped a build where every pattern missed and the
# install still reported success -- so the noisier of the two historical
# behaviours is the one worth keeping. Set to 0 to silence.
: "${PATCH_INDEX_WARN_ON_MISS:=1}"

# ── Locate the main-process code file(s) ────────────────────────────────────
# Vite compiles the main process into .vite/build/. Newer Claude Desktop builds
# emit index.js as a thin entry shim that require()s the real code from an
# index.chunk-<hash>.js file (the <hash> changes every build, and 1.26832.0 adds a
# parallel index2.chunk-<hash>.js series that holds the Cowork gate); older builds keep
# everything in index.js. The patches below must run against whichever file
# actually holds the code, so collect index.js plus every chunk it require()s.
# Applying each grep-guarded patch across all of them is safe: a file that lacks
# the pattern is skipped. This also survives minifier identifier rotation because
# the patterns below match on stable API/string tokens, not minified var names.
# Collect index.js plus *every* index*.chunk-*.js in the build dir, not just the
# ones index.js names: chunks are also require()d transitively by other chunks
# (on 1.26832.0 the --effort builder lives in index2.chunk-Cqfh0Vpp.js, which the
# shim never references), so following only the shim's direct requires misses
# them. Every patch below is grep-guarded, so listing a chunk that lacks the
# pattern costs nothing.
patch_index_collect_targets() {
  local build_dir="$1" chunk
  INDEX_TARGETS=()
  if [ -f "$build_dir/index.js" ]; then
    INDEX_TARGETS+=("$build_dir/index.js")
    while IFS= read -r chunk; do
      [ -n "$chunk" ] && INDEX_TARGETS+=("$chunk")
    done < <(find "$build_dir" -maxdepth 1 -name 'index*.chunk-*.js' -type f | sort)
  fi
  return 0
}

# patch_index "<log message>" "<grep -E guard>" "<sed -E script>"
# Runs the sed against every main-process code file matching the guard; logs once
# if any file matched. Minified identifiers are matched with [A-Za-z0-9_$]+ so the
# patches keep working when a new build reshuffles variable names.
patch_index() {
  local msg="$1" pat="$2" script="$3" f matched=""
  for f in "${INDEX_TARGETS[@]+"${INDEX_TARGETS[@]}"}"; do
    if grep -qE "$pat" "$f" 2>/dev/null; then
      sed -i -E "$script" "$f"
      matched=1
    fi
  done
  if [ -n "$matched" ]; then
    echo "$msg"
  elif [ "$PATCH_INDEX_WARN_ON_MISS" != "0" ]; then
    echo "WARN: patch skipped (target not found): $msg" >&2
  fi
  return 0
}

# Syntax-check every patched chunk before repacking. We rewrite ~300 files
# instead of 2, and the last pass in particular is markerless and substitutes
# globally on a bare `process.resourcesPath,"app.asar"` token, so a malformed
# rewrite would otherwise surface as a blank window at launch with no clue which
# pass produced it. node --check is cheap next to the repack and names the
# offending file. Warn rather than abort: a syntax error in a chunk we never
# patched shouldn't block a launch that would otherwise work.
#
# This covers the passes above only. A caller that mutates the same files
# afterwards (PKGBUILD runs enable-cowork.py after this) should call this again
# once it is done.
#
# PATCH_INDEX_STRICT_SYNTAX=1 turns the warning into a failure. A build step
# should stop rather than ship a package that opens a blank window; a launcher
# should not refuse to start an app that would otherwise work.
patch_index_verify_syntax() {
  command -v node >/dev/null 2>&1 || return 0
  local f bad=0
  for f in "${INDEX_TARGETS[@]+"${INDEX_TARGETS[@]}"}"; do
    [ -f "$f" ] || continue
    if ! node --check "$f" 2>/dev/null; then
      echo "WARNING: $f fails node --check after patching" >&2
      bad=$((bad + 1))
    fi
  done
  if [ "$bad" -gt 0 ]; then
    echo "WARNING: $bad patched chunk(s) failed syntax check" >&2
    [ "${PATCH_INDEX_STRICT_SYNTAX:-0}" = "1" ] && return 1
  fi
  return 0
}

# patch_index_apply_all <build_dir>
# The full pass list, in order. This is the single source of truth: launch.sh
# and PKGBUILD both call exactly this.
patch_index_apply_all() {
  local build_dir="$1"

  patch_index_collect_targets "$build_dir"

  # Fix window decorations: remove macOS-specific titlebar options from the windows.
  # The Vite bundle bypasses the frame-fix-wrapper's require interception, so we patch directly.
  patch_index "Patching macOS titlebar options for Linux (main window)..." \
    'titleBarStyle:["`]hidden["`],titleBarOverlay:[A-Za-z0-9_$!.]+,trafficLightPosition:[A-Za-z0-9_$!.]+,' \
    's/titleBarStyle:["`]hidden["`],titleBarOverlay:[A-Za-z0-9_$!.]+,trafficLightPosition:[A-Za-z0-9_$!.]+,//g'
  patch_index "Patching macOS titlebar options for Linux (about window)..." \
    'titleBarStyle:["`]hiddenInset["`],autoHideMenuBar:!0,skipTaskbar:!0' \
    's/titleBarStyle:["`]hiddenInset["`],autoHideMenuBar:!0,skipTaskbar:!0/autoHideMenuBar:!0/g'

  # Fix origin validation: the asar's nue() function rejects file:// preloads
  # when app.isPackaged is false (which it always is when running via `electron .asar`).
  # This causes the mainWindow/findInPage preloads to crash before exposing `process`
  # via contextBridge, breaking the renderer shell. Drop the isPackaged requirement
  # for file:// origins — the content is inside our asar, so there's no security risk.
  patch_index "Patching origin validation for file:// preloads..." \
    '[A-Za-z0-9_$]+\.protocol===["`]file:["`]&&[A-Za-z0-9_$.]+\.app\.isPackaged===!0' \
    's/([A-Za-z0-9_$]+)\.protocol===["`]file:["`]&&[A-Za-z0-9_$.]+\.app\.isPackaged===!0/\1.protocol==="file:"/g'

  # Fix --effort xhigh: Claude Desktop may pass --effort xhigh but the SDK binary
  # only supports low/medium/high/max. Remap xhigh -> max in the CLI arg builder.
  patch_index "Patching --effort xhigh -> max..." \
    '[A-Za-z0-9_$]+\.push\(["`]--effort["`],this\.options\.effort\)' \
    's/([A-Za-z0-9_$]+)\.push\(["`]--effort["`],this\.options\.effort\)/\1.push("--effort",this.options.effort==="xhigh"?"max":this.options.effort)/g'

  # NOTE: do not "simplify" the disclaimer wrapper away by patching the bundle's
  #   f(t){return process.platform!=="darwin"?t:{cmd:disclaimerBin(),args:[t.cmd,...t.args]}}
  # to its non-darwin (identity) branch. It looks like dead weight we only incur
  # because we spoof platform, but on Linux that wrap is load-bearing: it is the
  # only chokepoint where our spawn interception sees the bundle's own spawn
  # decisions, and the unwrap substitutes OUR resolved Claude binary for whatever
  # path the asar chose (claude-code-vm/<ver>/claude, a macOS .app path). Taking
  # the identity branch hands the SDK the asar's path unchanged and regresses
  # #132. See resolveDisclaimerCommand in stubs/cowork/exec_capability_registry.js.

  # Fix macOS Handoff API: invalidateCurrentActivity() and setUserActivity() are
  # macOS-only Electron APIs that crash on Linux. Replace with safe no-op fallbacks.
  patch_index "Patching macOS Handoff API invalidateCurrentActivity for Linux..." \
    '[A-Za-z0-9_$]+\.app\.invalidateCurrentActivity\(\)' \
    's/([A-Za-z0-9_$]+)\.app\.invalidateCurrentActivity\(\)/(\1.app.invalidateCurrentActivity||function(){})()/g'
  patch_index "Patching macOS Handoff API setUserActivity for Linux..." \
    '[A-Za-z0-9_$]+\.app\.setUserActivity\([A-Za-z0-9_$]+,' \
    's/([A-Za-z0-9_$]+)\.app\.setUserActivity\(([A-Za-z0-9_$]+),/((\1.app.setUserActivity||function(){}))(\2,/g'

  # Fix resource path lookup for i18n, shim-lib, icon, etc.
  # The asar uses `app.isPackaged ? process.resourcesPath : <asar-relative path>`.
  # On Arch Linux, `process.resourcesPath` is the system electron's dir
  # (e.g., /usr/lib/electron39/resources/), which only has default_app.asar —
  # locales live at /usr/lib/electron39/locales/*.pak (wrong format, wrong path).
  # The fallback branch resolves to resources/ inside our asar, where launch.sh
  # populates resources/i18n/*.json. Always use the fallback so locale JSONs load.
  patch_index "Patching resourcesPath lookups to use asar-internal resources/..." \
    '[A-Za-z0-9_$]+\.app\.isPackaged\?process\.resourcesPath:' \
    's/[A-Za-z0-9_$]+\.app\.isPackaged\?process\.resourcesPath://g'

  # Fix MCP node-host path resolution ("MCP Filesystem: Node host not found").
  # The MCP runtime computes its host paths as
  #   app.isPackaged ? join(process.resourcesPath,"app.asar",...) : join(getAppPath(),...)
  # but frame-fix-wrapper.js overrides process.resourcesPath to
  # ~/.config/Claude/cowork-resources (so the disclaimer/Helpers dir is writable),
  # and that location has no app.asar — so the packaged branch resolves to a
  # nonexistent nodeHost.js/directMcpHost.js and the MCP server fails to start.
  # getAppPath() already points inside the running asar (and equals
  # resources/app.asar on a stock build), so rewrite the packaged branch to use
  # it. Covers nodeHost.js, directMcpHost.js, and the asar-root helper — every
  # isPackaged-guarded asar-internal lookup. The resourcesPath patch above only
  # matches the bare `isPackaged?process.resourcesPath:` shape, not these join()
  # forms, so this is a separate pass.
  patch_index "Patching MCP node-host asar paths to use getAppPath()..." \
    '[A-Za-z0-9_$]+\.app\.isPackaged\?[A-Za-z0-9_$.]+\.join\(process\.resourcesPath,["`]app\.asar["`]' \
    's/([A-Za-z0-9_$]+)\.app\.isPackaged\?([A-Za-z0-9_$.]+)\.join\(process\.resourcesPath,["`]app\.asar["`]/\1.app.isPackaged?\2.join(\1.app.getAppPath()/g'

  # Catch-all for the same join with NO isPackaged guard (reported by @shawnyeager
  # on #167). shellPathWorker.js is resolved unconditionally:
  #   function v(){return o.default.join(process.resourcesPath,`app.asar`,`.vite`,`build`,`shell-path-worker`,`shellPathWorker.js`)}
  # The guarded pass above can't reach it, so it keeps resolving through the
  # overridden process.resourcesPath (~/.config/Claude/cowork-resources), which has
  # no app.asar — breaking login-shell PATH priming.
  #
  # This must run AFTER the guarded pass: that pass has already rewritten its own
  # sites away from `process.resourcesPath,app.asar`, so this only touches what it
  # missed. The main-process chunks are CJS with require in scope, so require the
  # app lazily rather than assuming a minified electron binding is in scope here.
  patch_index "Patching unguarded resourcesPath+app.asar joins to use getAppPath()..." \
    'process\.resourcesPath,["`]app\.asar["`]' \
    's/process\.resourcesPath,["`]app\.asar["`]/require("electron").app.getAppPath()/g'

  # Fix the Claude-in-Chrome / remote-control bridge transport on Electron builds
  # that have no net.WebSocket.
  #
  # The bridge picks between Electron's net.WebSocket and the bundled `ws`
  # package, behind a remote feature flag. With the flag on it takes the
  # net.WebSocket path -- but electron.net.WebSocket does not exist in every
  # Electron (Electron 42.1.0 exposes no WebSocket on the net module at all), and
  # the constructor call then throws synchronously:
  #
  #   [bridge-ws] using net.WebSocket transport for wss://bridge.claudeusercontent.com/chrome/<uuid>
  #   [claude-in-chrome] Failed to create WebSocket after 21ms: o.net.WebSocket is not a constructor
  #   [claude-in-chrome] Giving up bridge reconnection after 100 attempts
  #
  # The visible symptom is a Chrome extension that never pairs with the desktop
  # app, which reads as an extension or sign-in problem. It is neither: the
  # failure is 21ms in, before any network I/O.
  #
  # This is a CAPABILITY TEST, not an override. Where net.WebSocket exists the
  # condition is unchanged and the flag still decides, so builds on a newer or
  # patched Electron behave exactly as upstream intends; only builds that would
  # have thrown fall through to the `ws` transport the same code already uses
  # whenever the flag is off or forceWs is set. That path is also the more
  # capable one -- it is the only transport implementing protocol ping, and the
  # bundle already falls back to it at runtime when the peer requires ping.
  #
  # Two sites, and both are needed: the factory decides which socket is built,
  # while wantedTransport() reports which one is wanted and is re-consulted by
  # the flag-change subscription. Patching only the factory leaves the two
  # disagreeing, and the subscription re-applies the flag on top.
  #
  # Anchored on the forceWs / forceWsTransport property names, never on the flag
  # id or the minified gate identifier: property names survive minification, and
  # the flag id is Anthropic's to rotate. require() lazily, per the note on the
  # unguarded resourcesPath pass -- these are CJS chunks and no minified electron
  # binding is guaranteed to be in scope here.
  #
  # Both guards match the unpatched shape only, so re-runs are no-ops: the
  # factory guard requires the condition to be immediately followed by `){`,
  # and the wantedTransport guard requires `<ident>()` directly before the
  # `&&!this.forceWsTransport`. After patching neither holds.
  patch_index "Patching bridge transport to fall back to ws when net.WebSocket is absent..." \
    '\?\.forceWs\|\|![A-Za-z0-9_$]+\(\)\)\{' \
    's/(\?\.forceWs\|\|![A-Za-z0-9_$]+\(\))\)\{/\1||typeof require("electron").net.WebSocket!="function"){/g'
  patch_index "Patching bridge wantedTransport() to match the net.WebSocket capability..." \
    '[A-Za-z0-9_$]+\(\)&&!this\.forceWsTransport' \
    's/([A-Za-z0-9_$]+\(\))&&!this\.forceWsTransport/\1\&\&typeof require("electron").net.WebSocket=="function"\&\&!this.forceWsTransport/g'

  # Fix preload origin validation: the mainView.js preload's h() guard checks
  # if window.location.href origin matches claude.ai/preview.claude.ai etc.
  # On Linux with file:// protocol, origin is "null" and h() returns false,
  # preventing CoworkSpaces (and other IPC bridges) from being exposed to the
  # renderer. This causes the Projects page to be empty and spaces to not persist.
  # Patch: add file:// protocol as an allowed origin.
  #
  # Separate from patch_index because it targets a preload bundle, not the
  # main-process chunks in INDEX_TARGETS.
  # Guard on the SUBSTITUTION target, not just on the marker. sed -i rewrites the
  # file whether or not the pattern matched, so a miss still bumps mtime -- and
  # since a miss also leaves the marker absent, the old shape re-ran on every
  # launch, bumped mtime every launch, and made launch.sh's "is anything newer
  # than the cached asar" check true forever. That repacked the whole ~300-file
  # asar on every start while printing "Patching..." as though it had worked.
  local mainview_js="$build_dir/mainView.js"
  if [ -f "$mainview_js" ] && ! grep -qE 'e\.protocol===["`]file:["`]' "$mainview_js"; then
    if grep -qE 'e\.hostname===["`]localhost["`]' "$mainview_js"; then
      sed -i -E 's/e\.hostname===["`]localhost["`]/&||e.protocol==="file:"/g' "$mainview_js"
      echo "Patching preload origin validation for file:// protocol..."
    elif [ "$PATCH_INDEX_WARN_ON_MISS" != "0" ]; then
      echo "WARN: patch skipped (target not found): preload origin validation for file:// protocol" >&2
    fi
  fi

  patch_index_verify_syntax || return 1
  return 0
}
