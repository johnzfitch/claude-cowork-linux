#!/bin/bash
# Test launcher for claude-cowork-linux
# Uses the AppImage's electron with a repacked app.asar (bakes in stubs/patches)

# Change to script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Resolve electron binary: prefer AppImage, fall back to system
if [[ -x "./squashfs-root/usr/lib/node_modules/electron/dist/electron" ]]; then
  ELECTRON_BIN="./squashfs-root/usr/lib/node_modules/electron/dist/electron"
  ASAR_FILE="squashfs-root/usr/lib/node_modules/electron/dist/resources/app.asar"
elif command -v electron >/dev/null 2>&1; then
  ELECTRON_BIN="$(command -v electron)"
  ASAR_FILE="$SCRIPT_DIR/.asar-cache/app.asar"
  mkdir -p "$SCRIPT_DIR/.asar-cache"
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

# Only repack if stub is newer than asar (or asar doesn't exist)
if [ ! -f "$ASAR_FILE" ] || [ "$STUB_FILE" -nt "$ASAR_FILE" ] || [ "linux-app-extracted/frame-fix-wrapper.js" -nt "$ASAR_FILE" ] || [ "linux-app-extracted/ipc-handler-setup.js" -nt "$ASAR_FILE" ]; then
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
fi

# Create log directory
mkdir -p ~/.local/share/claude-cowork/logs

# Run electron with the repacked app.asar
echo "Launching Claude Desktop (electron: $ELECTRON_BIN)..."
exec "$ELECTRON_BIN" \
  "./${ASAR_FILE}" \
  --no-sandbox \
  --password-store=gnome-libsecret \
  "$@" \
  2>&1 | tee -a ~/.local/share/claude-cowork/logs/startup.log
