#!/bin/bash
# Test launcher for claude-cowork-linux
# Uses the AppImage's electron with a repacked app.asar (bakes in stubs/patches)

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

# Ensure the extracted app tree has the latest stub baked in before packing.
# This avoids relying on runtime module interception (ESM import() bypasses Module._load).
if [ -f "$STUB_SRC_FILE" ]; then
  mkdir -p "$(dirname "$STUB_FILE")"
  cp -f "$STUB_SRC_FILE" "$STUB_FILE"
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

# Only repack if stub is newer than asar (or asar doesn't exist)
if [ ! -f "$ASAR_FILE" ] || [ "$STUB_FILE" -nt "$ASAR_FILE" ] || [ "linux-app-extracted/frame-fix-wrapper.js" -nt "$ASAR_FILE" ]; then
  echo "Repacking app.asar (stub changed)..."
  asar pack linux-app-extracted "$ASAR_FILE"
else
  echo "Using cached app.asar (no changes)"
fi

# Enable logging
export ELECTRON_ENABLE_LOGGING=1

# Wayland support for Hyprland, Sway, and other Wayland compositors
if [[ -n "$WAYLAND_DISPLAY" ]] || [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
  export ELECTRON_OZONE_PLATFORM_HINT=wayland
  echo "Wayland detected, using Ozone platform"
  if [[ "$XDG_CURRENT_DESKTOP" == *"GNOME"* ]]; then
    echo "NOTE: GNOME Wayland does not support the GlobalShortcuts portal — configure shortcuts via GNOME Settings instead"
  fi
fi

# Create log directory
mkdir -p ~/.local/share/claude-cowork/logs

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

# Run electron with the repacked app.asar
echo "Launching Claude Desktop (electron: $ELECTRON_BIN, password-store: $PASSWORD_STORE)..."
exec "$ELECTRON_BIN" \
  "./${ASAR_FILE}" \
  --no-sandbox \
  --password-store="$PASSWORD_STORE" \
  --enable-features=GlobalShortcutsPortal \
  "$@" \
  2>&1 | tee -a ~/.local/share/claude-cowork/logs/startup.log
