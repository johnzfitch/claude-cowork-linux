#!/bin/bash
# Test launcher for claude-cowork-linux
# Uses the AppImage's electron with a repacked app.asar (bakes in stubs/patches)

set -o pipefail

# Change to script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Resolve electron binary: prefer system electron + local .asar-cache, fall back to AppImage
if command -v electron >/dev/null 2>&1; then
  ELECTRON_BIN="$(command -v electron)"
  ASAR_FILE=".asar-cache/app.asar"
  mkdir -p ".asar-cache"
elif [[ -x "./squashfs-root/usr/lib/node_modules/electron/dist/electron" ]]; then
  ELECTRON_BIN="./squashfs-root/usr/lib/node_modules/electron/dist/electron"
  ASAR_FILE="squashfs-root/usr/lib/node_modules/electron/dist/resources/app.asar"
else
  echo "ERROR: No electron binary found. Install electron or place an AppImage in squashfs-root/"
  exit 1
fi

STUB_FILE="linux-app-extracted/node_modules/@ant/claude-swift/js/index.js"
STUB_SRC_FILE="stubs/@ant/claude-swift/js/index.js"

NATIVE_STUB_FILE="linux-app-extracted/node_modules/@ant/claude-native/index.js"
NATIVE_STUB_SRC_FILE="stubs/@ant/claude-native/index.js"

# Ensure the extracted app tree has the latest stubs baked in before packing.
# This avoids relying on runtime module interception (ESM import() bypasses Module._load).
if [ -f "$STUB_SRC_FILE" ]; then
  mkdir -p "$(dirname "$STUB_FILE")"
  cp -f "$STUB_SRC_FILE" "$STUB_FILE"
fi

if [ -f "$NATIVE_STUB_SRC_FILE" ]; then
  mkdir -p "$(dirname "$NATIVE_STUB_FILE")"
  cp -f "$NATIVE_STUB_SRC_FILE" "$NATIVE_STUB_FILE"
fi

# Sync frame-fix files so wrapper changes take effect without a full reinstall
for _ff_file in frame-fix-entry.js frame-fix-wrapper.js; do
  if [ -f "stubs/frame-fix/$_ff_file" ]; then
    cp -f "stubs/frame-fix/$_ff_file" "linux-app-extracted/$_ff_file"
  fi
done

# Sync cowork orchestration modules into the extracted app tree.
if [ -d "stubs/cowork" ]; then
  mkdir -p "linux-app-extracted/cowork"
  cp -f stubs/cowork/*.js "linux-app-extracted/cowork/"
fi

# Install plugin permission shim so the asar can find it.
# The asar resolves the shim from its own resources/ directory (inside the asar),
# so we copy it into the extracted tree before repacking. Also copy to Electron's
# resources dir as a fallback for process.resourcesPath lookups.
if [ -f "stubs/cowork/cowork-plugin-shim.sh" ]; then
  mkdir -p "linux-app-extracted/resources"
  cp -f stubs/cowork/cowork-plugin-shim.sh "linux-app-extracted/resources/cowork-plugin-shim.sh"
  chmod +x "linux-app-extracted/resources/cowork-plugin-shim.sh"
  _RESOURCES_DIR="$(dirname "$ELECTRON_BIN")/resources"
  if [ -d "$_RESOURCES_DIR" ]; then
    cp -f stubs/cowork/cowork-plugin-shim.sh "$_RESOURCES_DIR/cowork-plugin-shim.sh"
    chmod +x "$_RESOURCES_DIR/cowork-plugin-shim.sh"
  fi
fi

# ============================================================
# Linux UI Fixes (applied before every repack)
# ============================================================

# Fix i18n: the app expects resources/i18n/*.json but DMG extracts to resources/*.json
if [ -d "linux-app-extracted/resources" ] && [ ! -d "linux-app-extracted/resources/i18n" ]; then
  echo "Fixing i18n paths..."
  mkdir -p "linux-app-extracted/resources/i18n"
  for f in linux-app-extracted/resources/*.json; do
    [ -f "$f" ] && cp "$f" "linux-app-extracted/resources/i18n/"
  done
fi

# Fix entry point: use frame-fix-entry.js so BrowserWindow gets native Linux frames
PKG_JSON="linux-app-extracted/package.json"
if [ -f "$PKG_JSON" ] && grep -q '"main":.*index\.pre\.js"' "$PKG_JSON"; then
  echo "Fixing entry point to use frame-fix-entry.js..."
  sed -i 's|"main":.*"\.vite/build/index\.pre\.js"|"main": "frame-fix-entry.js"|' "$PKG_JSON"
fi

# Fix window decorations: remove macOS-specific titlebar options from main window
# The Vite bundle bypasses the frame-fix-wrapper's require interception, so we patch directly.
INDEX_JS="linux-app-extracted/.vite/build/index.js"
if [ -f "$INDEX_JS" ] && grep -q 'titleBarOverlay' "$INDEX_JS"; then
  echo "Patching macOS titlebar options for Linux..."
  # Main window: remove titleBarStyle:"hidden",titleBarOverlay:VAR,trafficLightPosition:VAR,
  sed -i 's/titleBarStyle:"hidden",titleBarOverlay:[A-Za-z0-9_]\+,trafficLightPosition:[A-Za-z0-9_]\+,//g' "$INDEX_JS"
  # About window: remove titleBarStyle:"hiddenInset" (keep other options)
  sed -i 's/titleBarStyle:"hiddenInset",autoHideMenuBar:!0,skipTaskbar:!0/autoHideMenuBar:!0/g' "$INDEX_JS"
fi

# Fix origin validation: the asar's nue() function rejects file:// preloads
# when app.isPackaged is false (which it always is when running via `electron .asar`).
# This causes the mainWindow/findInPage preloads to crash before exposing `process`
# via contextBridge, breaking the renderer shell. Drop the isPackaged requirement
# for file:// origins — the content is inside our asar, so there's no security risk.
if [ -f "$INDEX_JS" ] && grep -q 'e\.protocol==="file:"&&Ee\.app\.isPackaged===!0' "$INDEX_JS"; then
  echo "Patching origin validation for file:// preloads..."
  sed -i 's/e\.protocol==="file:"&&Ee\.app\.isPackaged===!0/e.protocol==="file:"/g' "$INDEX_JS"
fi

# Only repack if stub is newer than asar (or asar doesn't exist)
# Repack if any file in the extracted tree is newer than the cached asar.
_needs_repack=false
if [ ! -f "$ASAR_FILE" ]; then
  _needs_repack=true
else
  while IFS= read -r -d '' _f; do
    if [ "$_f" -nt "$ASAR_FILE" ]; then
      _needs_repack=true
      break
    fi
  done < <(find linux-app-extracted -type f -print0)
fi
if [ "$_needs_repack" = true ]; then
  echo "Repacking app.asar..."
  asar pack linux-app-extracted "$ASAR_FILE"
else
  echo "Using cached app.asar (no changes)"
fi

# ============================================================
# Fix Code tab binary: the asar downloads a macOS Mach-O binary to
# claude-code/<version>/claude. Replace with the Linux binary so
# HostCLIRunner (Code tab) works on Linux.
# ============================================================
CLAUDE_CODE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude-code"
if [[ -d "$CLAUDE_CODE_DIR" ]]; then
  LINUX_CLAUDE=""
  for _candidate in "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude" "/usr/local/bin/claude" "/usr/bin/claude"; do
    if [[ -x "$_candidate" ]]; then
      LINUX_CLAUDE="$_candidate"
      break
    fi
  done
  if [[ -n "$LINUX_CLAUDE" ]]; then
    LINUX_CLAUDE_REAL="$(readlink -f "$LINUX_CLAUDE")"
    for _version_dir in "$CLAUDE_CODE_DIR"/*/; do
      _ccd_bin="${_version_dir}claude"
      if [[ -f "$_ccd_bin" && ! -L "$_ccd_bin" ]]; then
        # Check if it's a Mach-O binary (not a Linux ELF)
        if file "$_ccd_bin" 2>/dev/null | grep -q "Mach-O"; then
          echo "Fixing Code tab binary: replacing macOS binary with Linux symlink"
          echo "  $_ccd_bin -> $LINUX_CLAUDE_REAL"
          mv "$_ccd_bin" "${_ccd_bin}.macho-backup"
          ln -s "$LINUX_CLAUDE_REAL" "$_ccd_bin"
        fi
      fi
    done
  fi
fi

# --devtools flag opens DevTools + asset dumper on launch
# --perf flag enables Chromium tracing + Node inspector for profiling
_args=()
_perf=false
_dev=false
for arg in "$@"; do
  if [[ "$arg" == "--devtools" ]]; then
    export CLAUDE_DEVTOOLS=1
    _dev=true
  elif [[ "$arg" == "--perf" ]]; then
    _perf=true
    _dev=true
  elif [[ "$arg" == "--dev" ]]; then
    _dev=true
  else
    _args+=("$arg")
  fi
done
set -- "${_args[@]}"

# Enable logging
export ELECTRON_ENABLE_LOGGING=1
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
LOG_DIR="${CLAUDE_LOG_DIR:-$STATE_HOME/claude-cowork/logs}"
export CLAUDE_LOG_DIR="$LOG_DIR"

if [[ -n "$CLAUDE_DEVTOOLS" ]]; then
  echo ""
  echo "  DEVTOOLS MODE"
  echo "  Assets will be saved to: $LOG_DIR/webapp-assets/"
  echo "  Previous assets backed up to: $LOG_DIR/webapp-assets.bak/"
  echo "  Compare: diff $LOG_DIR/webapp-assets/ $LOG_DIR/webapp-assets.bak/"
  echo ""
fi

# Wayland support for Hyprland, Sway, and other Wayland compositors
if [[ -n "$WAYLAND_DISPLAY" ]] || [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
  export ELECTRON_OZONE_PLATFORM_HINT=wayland
  echo "Wayland detected, using Ozone platform"
  if [[ "$XDG_CURRENT_DESKTOP" == *"GNOME"* ]]; then
    echo "NOTE: GNOME Wayland does not support the GlobalShortcuts portal — configure shortcuts via GNOME Settings instead"
  fi
fi

# Create log directory
mkdir -p "$LOG_DIR"

# Detect password store backend.
# gnome-libsecret is preferred (works with gnome-keyring, KeePassXC, KDE Wallet
# via the freedesktop SecretService D-Bus interface).  Fall back to basic if
# the SecretService bus name isn't claimed -- avoids hard failures on minimal
# desktops or headless setups.
PASSWORD_STORE="gnome-libsecret"
if ! dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
     org.freedesktop.DBus.NameHasOwner string:"org.freedesktop.secrets" 2>/dev/null \
     | grep -q "boolean true"; then
  echo "WARN: org.freedesktop.secrets not available, falling back to --password-store=basic"
  PASSWORD_STORE="basic"
fi

# Build electron args
_electron_args=(
  "./${ASAR_FILE}"
  --no-sandbox
  --password-store="$PASSWORD_STORE"
  --enable-features=GlobalShortcutsPortal
)

if [[ "$_perf" == true ]]; then
  export CLAUDE_DEVTOOLS=1
  export CLAUDE_COWORK_IPC_TAP=1
  export CLAUDE_COWORK_TRACE_IO=1
  export CLAUDE_COWORK_VERBOSE=1
  _electron_args+=(
    --inspect=9229
    --remote-debugging-port=9222
  )
  echo ""
  echo "  PERF MODE"
  echo "  Main process:  chrome://inspect (port 9229) -> Profiler tab"
  echo "  Renderer:      DevTools will open -> Performance tab -> Record"
  echo "  IPC tap:       $LOG_DIR/ipc-tap.log"
  echo "  Trace IO:      Enabled (stdin/stdout logging)"
  echo ""
fi

# Run electron with the repacked app.asar
if [[ "$_dev" == true ]]; then
  # Foreground: terminal stays attached (--dev, --devtools, --perf)
  echo "Launching Claude Desktop (foreground, electron: $ELECTRON_BIN)..."
  "$ELECTRON_BIN" \
    "${_electron_args[@]}" \
    "$@" \
    2>&1 | tee -a "$LOG_DIR/startup.log"
  exit "${PIPESTATUS[0]}"
else
  # Default: launch headless, detach from terminal
  echo "Launching Claude Desktop..."
  nohup "$ELECTRON_BIN" \
    "${_electron_args[@]}" \
    "$@" \
    >> "$LOG_DIR/startup.log" 2>&1 &
  disown
  echo "PID $! — logs: $LOG_DIR/startup.log"
fi
