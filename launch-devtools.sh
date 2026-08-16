#!/bin/bash
# Launcher with DevTools enabled for debugging

set -o pipefail

# Change to script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure ~/.local/bin is in PATH (common for user-local electron installs)
export PATH="$HOME/.local/bin:$PATH"

# Resolve electron binary: prefer system electron + local .asar-cache, fall back to AppImage
if command -v electron >/dev/null 2>&1; then
  ELECTRON_BIN="$(command -v electron)"
  ASAR_FILE=".asar-cache/app.asar"
elif [[ -x "$HOME/.local/bin/electron" ]]; then
  ELECTRON_BIN="$HOME/.local/bin/electron"
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

# Apply the main-process patches and repack, the other half of "mirrors
# launch.sh". Without this every cp above was thrown away: electron is handed
# .asar-cache/app.asar, which is whatever launch.sh last packed, so editing a
# stub and running this script debugged the PREVIOUS build. For a debugging
# tool that is the worst possible failure — it looks like your change had no
# effect.
if [ -d "linux-app-extracted" ]; then
  if [ -f "$SCRIPT_DIR/patch-index.sh" ]; then
    # shellcheck source=patch-index.sh
    source "$SCRIPT_DIR/patch-index.sh"
    patch_index_apply_all "linux-app-extracted/.vite/build"
  else
    echo "WARNING: patch-index.sh not found; launching without the main-process patches" >&2
  fi

  if command -v asar >/dev/null 2>&1; then
    mkdir -p "$(dirname "$ASAR_FILE")"
    echo "Repacking app.asar..."
    if ! asar pack linux-app-extracted "$ASAR_FILE"; then
      echo "ERROR: asar pack failed; refusing to launch against a stale $ASAR_FILE" >&2
      exit 1
    fi
  else
    echo "WARNING: asar not installed; launching against the existing $ASAR_FILE" >&2
  fi
fi

if [ ! -f "$ASAR_FILE" ]; then
  echo "ERROR: $ASAR_FILE not found. Run ./launch.sh once to build it." >&2
  exit 1
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
