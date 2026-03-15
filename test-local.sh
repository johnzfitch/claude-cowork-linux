#!/bin/bash
# Deploy local stubs to installed claude-desktop for testing
# Usage: ./test-local.sh [--launch]

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.local/share/claude-desktop"
EXTRACTED_DIR="$INSTALL_DIR/linux-app-extracted"

echo "Deploying local stubs from $REPO_DIR"

# Copy frame-fix wrapper
cp -v "$REPO_DIR/stubs/frame-fix/frame-fix-wrapper.js" "$INSTALL_DIR/frame-fix-wrapper.js"
cp -v "$REPO_DIR/stubs/frame-fix/frame-fix-wrapper.js" "$EXTRACTED_DIR/frame-fix-wrapper.js" 2>/dev/null || true

# Keep the installed stubs tree and extracted app in sync. Dynamic imports can
# resolve from either location depending on launch path and packaging state.
mkdir -p "$INSTALL_DIR/stubs/@ant/claude-swift/js" "$INSTALL_DIR/stubs/@ant/claude-native"
mkdir -p "$EXTRACTED_DIR/node_modules/@ant/claude-swift/js" "$EXTRACTED_DIR/node_modules/@ant/claude-native"

# Copy swift stub
cp -v "$REPO_DIR/stubs/@ant/claude-swift/js/index.js" "$INSTALL_DIR/stubs/@ant/claude-swift/js/index.js"
cp -v "$REPO_DIR/stubs/@ant/claude-swift/js/index.js" "$EXTRACTED_DIR/node_modules/@ant/claude-swift/js/index.js"

# Copy native stub
cp -v "$REPO_DIR/stubs/@ant/claude-native/index.js" "$INSTALL_DIR/stubs/@ant/claude-native/index.js"
cp -v "$REPO_DIR/stubs/@ant/claude-native/index.js" "$EXTRACTED_DIR/node_modules/@ant/claude-native/index.js"

# Clear asar cache to force rebuild
if [ -d "$INSTALL_DIR/.asar-cache" ]; then
    rm -rf "$INSTALL_DIR/.asar-cache"/*
    echo "Cleared .asar-cache"
fi

echo ""
echo "Local stubs deployed. Run claude-desktop to test."

if [ "$1" = "--launch" ]; then
    echo "Launching claude-desktop..."
    exec "$INSTALL_DIR/claude-desktop"
fi
