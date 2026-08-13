# Maintainer: Zack Fitch <zack@internetuniverse.org>
pkgname=claude-cowork-linux
pkgver=1.1.4010
pkgrel=12
pkgdesc="Anthropic Claude Desktop with Cowork (local agent) support for Linux"
arch=('x86_64')
url="https://github.com/johnzfitch/claude-cowork-linux"
license=('custom:proprietary')
depends=(
    'electron'
    'nodejs'
    'curl'
    'zstd'
)
# gnome-keyring is recommended but not required; launcher detects SecretService
# at runtime and falls back to --password-store=basic if unavailable
makedepends=(
    'p7zip'
    'asar'
    'curl'
)
optdepends=(
    'xdg-utils: for opening URLs'
    'bubblewrap: for sandbox isolation'
    'gnome-keyring: SecretService provider for secure credential storage'
    'kwallet: SecretService provider for KDE users'
    'python: for enable-cowork.py patch script'
)
provides=('claude-cowork' 'claude-desktop')
conflicts=(
    'claude-cowork'
    'claude-desktop'
    'claude-desktop-bin'
    'claude-desktop-native'
    'claude-desktop-appimage'
)
options=('!strip')

source=(
    "git+https://github.com/johnzfitch/claude-cowork-linux.git"
)
sha256sums=(
    'SKIP'
)

pkgver() {
    cd "${srcdir}"

    # Use Node.js to query the DMG API
    local version
    version=$(node "${srcdir}/claude-cowork-linux/fetch-dmg.js" 2>/dev/null \
        | awk '{print $1}')

    echo "${version:-1.1.4010}"
}

prepare() {
    cd "${srcdir}"

    # Fetch latest DMG URL via Node.js, download with curl
    echo "Fetching latest Claude Desktop DMG URL..."
    local dmg_url
    dmg_url=$(node "${srcdir}/claude-cowork-linux/fetch-dmg.js" --url)
    echo "Downloading DMG from CDN..."
    curl -fSL --progress-bar -o "${srcdir}/Claude.dmg" "$dmg_url"
}

build() {
    cd "${srcdir}"

    local _repo="${srcdir}/claude-cowork-linux"

    # Extract DMG with 7z
    echo "Extracting DMG..."
    local seven_z_exit=0
    7z x -y "${srcdir}/Claude.dmg" -o"${srcdir}/dmg-extracted" >/dev/null 2>&1 || seven_z_exit=$?
    # 7z exit 1 = warning (e.g. "Dangerous link path" for /Applications symlink)
    if [[ $seven_z_exit -gt 2 ]]; then
        echo "Error: Failed to extract DMG (7z exit code: $seven_z_exit)"
        return 1
    fi

    # Find Claude.app and app.asar
    local _claude_app
    _claude_app=$(find "${srcdir}/dmg-extracted" -name "Claude.app" -type d | head -1)
    if [[ -z "$_claude_app" ]]; then
        echo "Error: Claude.app not found in DMG"
        return 1
    fi

    local _app_asar="${_claude_app}/Contents/Resources/app.asar"
    if [[ ! -f "$_app_asar" ]]; then
        echo "Error: app.asar not found at: $_app_asar"
        return 1
    fi

    # Extract app.asar
    asar extract "$_app_asar" "${srcdir}/linux-app-extracted"

    # Copy unpacked native modules if present
    local _unpacked="${_claude_app}/Contents/Resources/app.asar.unpacked"
    if [[ -d "$_unpacked" ]]; then
        cp -r "$_unpacked"/* "${srcdir}/linux-app-extracted/" 2>/dev/null || true
    fi

    # Copy resources/ from DMG (i18n, icons, etc.) excluding the asar itself
    local _resources_dir="${_claude_app}/Contents/Resources"
    mkdir -p "${srcdir}/linux-app-extracted/resources"
    for item in "$_resources_dir"/*; do
        local name
        name=$(basename "$item")
        case "$name" in
            app.asar|app.asar.unpacked) continue ;;
        esac
        cp -r "$item" "${srcdir}/linux-app-extracted/resources/$name" 2>/dev/null || true
    done

    # Bake stubs into node_modules
    mkdir -p "${srcdir}/linux-app-extracted/node_modules/@ant/claude-swift/js"
    mkdir -p "${srcdir}/linux-app-extracted/node_modules/@ant/claude-native"
    cp -f "${_repo}/stubs/@ant/claude-swift/js/index.js" \
          "${srcdir}/linux-app-extracted/node_modules/@ant/claude-swift/js/index.js"
    cp -f "${_repo}/stubs/@ant/claude-native/index.js" \
          "${srcdir}/linux-app-extracted/node_modules/@ant/claude-native/index.js"

    # Copy frame-fix files
    cp -f "${_repo}/stubs/frame-fix/frame-fix-entry.js" \
          "${srcdir}/linux-app-extracted/frame-fix-entry.js"
    cp -f "${_repo}/stubs/frame-fix/frame-fix-wrapper.js" \
          "${srcdir}/linux-app-extracted/frame-fix-wrapper.js"

    # Copy cowork orchestration modules
    mkdir -p "${srcdir}/linux-app-extracted/cowork"
    cp -f "${_repo}"/stubs/cowork/*.js \
          "${srcdir}/linux-app-extracted/cowork/"
    cp -f "${_repo}"/stubs/cowork/*.sh \
          "${srcdir}/linux-app-extracted/cowork/" 2>/dev/null || true

    # Linux port wiring (mirrors launch.sh; without these the renderer UI never appears).
    echo "Applying Linux port patches..."
    local _ext="${srcdir}/linux-app-extracted"
    local _pkgjson="${_ext}/package.json"
    local _indexjs="${_ext}/.vite/build/index.js"

    # Trampoline: override resourcesPath, then load frame-fix-entry.js.
    cat > "${_ext}/trampoline.js" <<'JSEOF'
Object.defineProperty(process, 'resourcesPath', {
    value: '/usr/lib/claude-cowork/resources',
    writable: true,
    configurable: true,
    enumerable: true,
});
require('./frame-fix-entry.js');
JSEOF

    # Repoint asar main → trampoline.js.
    if grep -q '"main":.*"\.vite/build/index\.pre\.js"' "$_pkgjson"; then
        sed -i 's|"main":.*"\.vite/build/index\.pre\.js"|"main": "trampoline.js"|' "$_pkgjson"
    else
        echo "WARN: asar entry-point patch skipped (target not found)"
    fi

    # Locate the main-process code file(s). Newer Claude Desktop builds (asar
    # 1.19367.0+) emit index.js as a thin entry shim that require()s the real
    # code from index.chunk-<hash>.js and index2.chunk-<hash>.js files (the
    # hash rotates every build);
    # older builds keep everything in index.js. Patches must hit whichever file
    # actually holds the code, so collect index.js plus every chunk it require()s
    # and apply each grep-guarded patch across all of them (a file lacking the
    # pattern is simply skipped).
    local _build_dir="${_ext}/.vite/build"
    local -a _index_targets=()
    if [ ! -f "$_indexjs" ]; then
        echo "ERROR: main-process entry not found at $_indexjs" >&2
        echo "       The extracted Claude Desktop bundle layout may have changed;" >&2
        echo "       cannot locate the code to patch, so Cowork could not be enabled." >&2
        return 1
    fi
    _index_targets+=("$_indexjs")
    local _chunk
    while IFS= read -r _chunk; do
        [ -n "$_chunk" ] && [ -f "$_build_dir/$_chunk" ] \
            && _index_targets+=("$_build_dir/$_chunk")
    done < <(grep -oE 'index2?\.chunk-[A-Za-z0-9_-]+\.js' "$_indexjs" | sort -u)

    # patch_index <log msg> <grep -E guard> <sed -E script>
    # Runs the sed against every main-process code file matching the guard; logs
    # once if any matched, warns once if none did. Minified identifiers are
    # matched with [A-Za-z0-9_$]+ so the patches survive per-build var renaming.
    patch_index() {
        local msg="$1" pat="$2" script="$3" f matched=""
        for f in "${_index_targets[@]}"; do
            if grep -qE "$pat" "$f" 2>/dev/null; then
                sed -i -E "$script" "$f"
                matched=1
            fi
        done
        if [ -n "$matched" ]; then
            echo "$msg"
        else
            echo "WARN: patch skipped (target not found): $msg"
        fi
    }

    # Strip macOS titlebar opts (Vite ESM bypasses wrapper's require-Proxy).
    patch_index "Stripping macOS titlebar options (main window)..." \
        'titleBarStyle:"hidden",titleBarOverlay:[A-Za-z0-9_$]+,trafficLightPosition:[A-Za-z0-9_$]+,' \
        's/titleBarStyle:"hidden",titleBarOverlay:[A-Za-z0-9_$]+,trafficLightPosition:[A-Za-z0-9_$]+,//g'
    patch_index "Stripping macOS titlebar options (about window)..." \
        'titleBarStyle:"hiddenInset",autoHideMenuBar:!0,skipTaskbar:!0' \
        's/titleBarStyle:"hiddenInset",autoHideMenuBar:!0,skipTaskbar:!0/autoHideMenuBar:!0/g'

    # Drop isPackaged check on file:// preloads (else renderer shell never loads).
    # The protocol/app identifiers are minified and rotate per build, so match
    # with [A-Za-z0-9_$]+ rather than the old hardcoded e./Ee. names.
    patch_index "Patching origin validation for file:// preloads..." \
        '[A-Za-z0-9_$]+\.protocol==="file:"&&[A-Za-z0-9_$]+\.app\.isPackaged===!0' \
        's/([A-Za-z0-9_$]+)\.protocol==="file:"&&[A-Za-z0-9_$]+\.app\.isPackaged===!0/\1.protocol==="file:"/g'

    # Add linux branch to getHostPlatform() (without this, the minified
    # platform switch throws "Unsupported platform: linux-x64" and the
    # ClaudeCode.prepare IPC fails -- Cowork tasks fail in the UI with a
    # generic "Something went wrong" banner).
    # This inline pass targets index.js only: its insert hardcodes the arch
    # variable name (A), which is minifier-assigned and unsafe to splice into a
    # chunk where it may differ. On split-entry builds this switch lives in the
    # chunk, where enable-cowork.py's host-platform patch (run across all targets
    # below) handles it instead — so finding nothing here is expected, not a bug.
    if grep -q 'win32-arm64":"win32-x64";throw new Error' "$_indexjs"; then
        sed -i 's|win32-arm64":"win32-x64";throw new Error|win32-arm64":"win32-x64";if(process.platform==="linux")return A==="arm64"?"linux-arm64":"linux-x64";throw new Error|' "$_indexjs"
        echo "Patched getHostPlatform() linux branch in index.js"
    else
        echo "Note: inline getHostPlatform patch not applied to index.js (handled by enable-cowork.py on split-entry builds)"
    fi

    # Duplicate i18n JSONs into resources/i18n/ (bundle reads from both paths).
    if ls "${_ext}/resources/"*.json >/dev/null 2>&1; then
        mkdir -p "${_ext}/resources/i18n"
        cp "${_ext}/resources/"*.json "${_ext}/resources/i18n/"
    fi

    # Allow bash/sh in cowork orchestrator allowlist (upstream gap -- the SDK
    # calls vm.spawn("bash", ...) which the allowlist currently rejects).
    # Guard matches either quote style so this no-ops once stubs/cowork/
    # session_orchestrator.js is patched upstream. Remove this whole block
    # after that fix lands.
    local _orch="${_ext}/cowork/session_orchestrator.js"
    if grep -q '} else if (allowedPrefixes\.some' "$_orch" \
       && ! grep -qE "commandBasename === [\"']bash[\"']" "$_orch"; then
        sed -i 's#^    } else if (allowedPrefixes\.some#    } else if (commandBasename === "bash" || commandBasename === "sh") {\n      hostCommand = "/usr/bin/" + commandBasename;\n      trace("Translated shell command: " + normalizedCommand + " -> " + hostCommand);\n    } else if (allowedPrefixes.some#' "$_orch"
    else
        echo "WARN: bash/sh allowlist patch skipped (target not found or already patched)"
    fi

    # Apply cowork patch. On split-entry builds the platform gate, IPC origin
    # guards, and host-platform code live in the chunk (not index.js), so run
    # enable-cowork.py across index.js plus every discovered chunk. The script is
    # idempotent (marker-guarded) and exits non-zero when a file lacks the
    # platform gate (expected for the shim and chunks without it). Capture each
    # run's output: print it when the file was patched, but suppress the script's
    # "Platform-gate function not found" noise for the expected misses so a
    # successful build log stays clean. Require at least one target to patch;
    # otherwise fail the build loudly — surfacing the stashed output to diagnose
    # a bundle-layout change — rather than ship a package with Cowork disabled.
    echo "Applying cowork patch to ${#_index_targets[@]} file(s)..."
    local _t _out _any_patched="" _miss_log=""
    for _t in "${_index_targets[@]}"; do
        if _out="$(python "${_repo}/enable-cowork.py" "$_t" 2>&1)"; then
            _any_patched=1
            [ -n "$_out" ] && printf '%s\n' "$_out"
        else
            echo "  Skipped ${_t##*/} (no platform gate; patched in another target)"
            _miss_log+="--- ${_t##*/} ---"$'\n'"$_out"$'\n'
        fi
    done
    if [ -z "$_any_patched" ]; then
        echo "ERROR: cowork platform gate not found in index.js or any index[2].chunk-*.js" >&2
        echo "       Claude Desktop's bundle layout may have changed; Cowork would not be enabled." >&2
        echo "       enable-cowork.py output follows:" >&2
        printf '%s' "$_miss_log" >&2
        return 1
    fi
    echo "Cowork patches applied"

    # Repack into app.asar
    echo "Repacking app.asar..."
    asar pack "${srcdir}/linux-app-extracted" "${srcdir}/app.asar"
}

package() {
    cd "${srcdir}"

    # Install repacked app.asar
    install -Dm644 "${srcdir}/app.asar" \
                   "${pkgdir}/usr/lib/claude-cowork/app.asar"

    # Resources in our namespace (avoid /usr/lib/electronNN/, foreign-owned).
    # i18n in BOTH root and i18n/ -- bundle reads from both paths.
    install -d "${pkgdir}/usr/lib/claude-cowork/resources/i18n"
    install -m644 "${srcdir}/linux-app-extracted/resources/"*.json \
        "${pkgdir}/usr/lib/claude-cowork/resources/"
    install -m644 "${srcdir}/linux-app-extracted/resources/i18n/"*.json \
        "${pkgdir}/usr/lib/claude-cowork/resources/i18n/"
    install -m755 "${srcdir}/linux-app-extracted/cowork/cowork-plugin-shim.sh" \
        "${pkgdir}/usr/lib/claude-cowork/resources/cowork-plugin-shim.sh"

    # Disclaimer stub: exists so the asar's path check passes.
    # Exec calls are intercepted in-process by frame-fix-wrapper.
    install -Dm755 /dev/stdin "${pkgdir}/usr/lib/claude-cowork/Helpers/disclaimer" <<'EOF'
#!/bin/sh
CMD="$1"
shift
case "$CMD" in
  *claude.app/Contents/MacOS/claude|*claude.app/Contents/MacOS/Claude)
    for c in \
      "$HOME/.local/bin/claude" \
      "$HOME/.local/share/mise/shims/claude" \
      "$HOME/.asdf/shims/claude" \
      "/usr/local/bin/claude" \
      "/usr/bin/claude"; do
      [ -x "$c" ] && exec "$c" "$@"
    done
    exit 127
    ;;
esac
exec "$CMD" "$@"
EOF

    # Install launcher script
    install -Dm755 /dev/stdin "${pkgdir}/usr/bin/claude-cowork" <<'EOF'
#!/bin/bash
# Claude Cowork Linux launcher

if [[ -n "$WAYLAND_DISPLAY" ]] || [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
    export ELECTRON_OZONE_PLATFORM_HINT=wayland
fi

# Detect password store backend
PW_STORE="gnome-libsecret"
if ! dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
     org.freedesktop.DBus.NameHasOwner string:"org.freedesktop.secrets" 2>/dev/null \
     | grep -q "boolean true"; then
    PW_STORE="basic"
fi

# Register claude:// protocol handler if not already set
if command -v xdg-mime >/dev/null 2>&1; then
    _current_handler="$(xdg-mime query default x-scheme-handler/claude 2>/dev/null || true)"
    if [[ -z "$_current_handler" ]]; then
        xdg-mime default claude-cowork.desktop x-scheme-handler/claude 2>/dev/null || true
    fi
fi

# Sandbox: prefer Chromium sandbox when user namespaces are available
_sandbox_flag="--no-sandbox"
if [[ -f /proc/sys/kernel/unprivileged_userns_clone ]]; then
    [[ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" == "1" ]] && _sandbox_flag=""
elif [[ -f /proc/sys/user/max_user_namespaces ]]; then
    _max_ns="$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)"
    [[ "$_max_ns" -gt 0 ]] 2>/dev/null && _sandbox_flag=""
fi

exec electron /usr/lib/claude-cowork/app.asar \
    ${_sandbox_flag} \
    --disable-gpu \
    --class=Claude \
    --password-store="$PW_STORE" \
    --enable-features=GlobalShortcutsPortal,WaylandWindowDecorations "$@"
EOF

    # Install desktop entry
    install -Dm644 /dev/stdin "${pkgdir}/usr/share/applications/claude-cowork.desktop" <<EOF
[Desktop Entry]
Name=Claude Cowork
Comment=Anthropic Claude Desktop with local agent support
Exec=claude-cowork %U
Icon=claude-cowork
Type=Application
Categories=Development;Utility;
MimeType=x-scheme-handler/claude;
StartupWMClass=Claude
EOF

    # Extract icon from DMG's Claude.app if available
    local _claude_app
    _claude_app=$(find "${srcdir}/dmg-extracted" -name "Claude.app" -type d 2>/dev/null | head -1)
    if [[ -n "$_claude_app" ]]; then
        local _icns="${_claude_app}/Contents/Resources/AppIcon.icns"
        # Try to convert .icns to png (icns2png from libicns)
        if [[ -f "$_icns" ]] && command -v icns2png &>/dev/null; then
            icns2png -x -s 256 "$_icns" -o "${srcdir}/" 2>/dev/null || true
            local _icon
            _icon=$(ls -S "${srcdir}/"*.png 2>/dev/null | head -1)
            if [[ -n "$_icon" ]]; then
                install -Dm644 "$_icon" \
                    "${pkgdir}/usr/share/icons/hicolor/256x256/apps/claude-cowork.png"
            fi
        fi
    fi

    # Install license notice
    install -Dm644 /dev/stdin "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE" <<EOF
Claude Desktop is proprietary software by Anthropic PBC.
This package provides a Linux compatibility layer for the macOS app.
See https://www.anthropic.com/legal/consumer-terms for terms of service.
EOF
}
