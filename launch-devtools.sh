#!/bin/bash
# Launcher with DevTools enabled for debugging

set -o pipefail

# Change to script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Resolve electron binary: prefer system electron + local .asar-cache, fall back to AppImage
if command -v electron >/dev/null 2>&1; then
  ELECTRON_BIN="$(command -v electron)"
  ASAR_FILE=".asar-cache/app.asar"
elif [[ -x "./squashfs-root/usr/lib/node_modules/electron/dist/electron" ]]; then
  ELECTRON_BIN="./squashfs-root/usr/lib/node_modules/electron/dist/electron"
  ASAR_FILE="squashfs-root/usr/lib/node_modules/electron/dist/resources/app.asar"
else
  echo "ERROR: No electron binary found. Install electron or place an AppImage in squashfs-root/"
  exit 1
fi

# Sync stubs into the extracted app tree before launching (mirrors launch.sh)
if [ -f "stubs/@ant/claude-swift/js/index.js" ]; then
  mkdir -p "linux-app-extracted/node_modules/@ant/claude-swift/js"
  cp -f "stubs/@ant/claude-swift/js/index.js" "linux-app-extracted/node_modules/@ant/claude-swift/js/index.js"
fi
if [ -f "stubs/@ant/claude-native/index.js" ]; then
  mkdir -p "linux-app-extracted/node_modules/@ant/claude-native"
  cp -f "stubs/@ant/claude-native/index.js" "linux-app-extracted/node_modules/@ant/claude-native/index.js"
fi
for _ff_file in frame-fix-entry.js frame-fix-wrapper.js; do
  if [ -f "stubs/frame-fix/$_ff_file" ]; then
    cp -f "stubs/frame-fix/$_ff_file" "linux-app-extracted/$_ff_file"
  fi
done
if [ -d "stubs/cowork" ]; then
  mkdir -p "linux-app-extracted/cowork"
  cp -f stubs/cowork/*.js "linux-app-extracted/cowork/"
fi

# Enable logging and DevTools
export ELECTRON_ENABLE_LOGGING=1
export CLAUDE_ENABLE_LOGGING=1
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
LOG_DIR="${CLAUDE_LOG_DIR:-$STATE_HOME/claude-cowork/logs}"
export CLAUDE_LOG_DIR="$LOG_DIR"

# Wayland support
if [[ -n "$WAYLAND_DISPLAY" ]] || [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
  export ELECTRON_OZONE_PLATFORM_HINT=wayland
  echo "Wayland detected, using Ozone platform"
fi

# Create log directory
mkdir -p "$LOG_DIR"

# Launch with DevTools (--inspect enables Node.js inspector)
"$ELECTRON_BIN" \
  "./${ASAR_FILE}" \
  --no-sandbox \
  --disable-gpu \
  --inspect "$@" 2>&1 | tee -a "$LOG_DIR/startup.log"
exit "${PIPESTATUS[0]}"
