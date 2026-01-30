#!/bin/bash
# Test launcher for claude-cowork-linux
# Uses the AppImage's electron with repacked asar (the approach that worked)

# Change to script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ASAR_FILE="squashfs-root/usr/lib/node_modules/electron/dist/resources/app.asar"
STUB_FILE="linux-app-extracted/node_modules/@ant/claude-swift/js/index.js"

# Only repack if stub is newer than asar (or asar doesn't exist)
if [ ! -f "$ASAR_FILE" ] || [ "$STUB_FILE" -nt "$ASAR_FILE" ]; then
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

# Run with AppImage's electron - use app/ directory instead of asar for better stub handling
echo "Launching Claude Desktop..."
exec ./squashfs-root/usr/lib/node_modules/electron/dist/electron \
  ./squashfs-root/usr/lib/node_modules/electron/dist/resources/app \
  --no-sandbox 2>&1 | tee -a ~/.local/share/claude-cowork/logs/startup.log
