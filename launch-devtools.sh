#!/bin/bash
# Test launcher with DevTools enabled

# Change to script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Enable logging and DevTools
export ELECTRON_ENABLE_LOGGING=1
export CLAUDE_ENABLE_LOGGING=1

# Wayland support
if [[ -n "$WAYLAND_DISPLAY" ]] || [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
  export ELECTRON_OZONE_PLATFORM_HINT=wayland
  echo "Wayland detected, using Ozone platform"
fi

# Create log directory (Linux path)
LOG_DIR="$HOME/.local/share/claude-cowork/logs"
mkdir -p "$LOG_DIR"

# Clear log
echo "=== TEST RUN WITH DEVTOOLS ===" > "$LOG_DIR/startup.log"

# Launch with DevTools (--inspect enables Node.js inspector)
exec ./squashfs-root/usr/lib/node_modules/electron/dist/electron \
  ./squashfs-root/usr/lib/node_modules/electron/dist/resources/app.asar \
  --no-sandbox --inspect "$@" 2>&1 | tee -a "$LOG_DIR/startup.log"
