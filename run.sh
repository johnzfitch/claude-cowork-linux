#!/bin/bash
# Claude Desktop for Linux launcher

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
ELECTRON="$SCRIPT_DIR/node_modules/.bin/electron"

# GPU flags for Linux stability
export ELECTRON_ENABLE_LOGGING=1

# Use X11 instead of Wayland for better GPU compatibility
# Or use software rendering if needed
exec "$ELECTRON" "$APP_DIR" \
    --disable-gpu-sandbox \
    --enable-features=UseOzonePlatform \
    --ozone-platform=x11 \
    --disable-gpu-compositing \
    "$@"
