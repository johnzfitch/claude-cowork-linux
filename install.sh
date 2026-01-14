#!/bin/bash
# Claude Cowork for Linux - Installation Script
# This script extracts Claude Desktop and applies our Linux patches

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

success() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; }
info() { echo -e "${CYAN}→${NC} $1"; }

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║           Claude Cowork for Linux - Installer              ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Check dependencies
echo "Step 1: Checking dependencies..."

if ! command -v node &> /dev/null; then
    error "Node.js is not installed"
    echo "  Install: sudo pacman -S nodejs npm (Arch) or apt install nodejs npm (Debian)"
    exit 1
fi
success "Node.js $(node --version)"

if ! command -v npm &> /dev/null; then
    error "npm is not installed"
    exit 1
fi
success "npm $(npm --version)"

if ! command -v 7z &> /dev/null; then
    error "7z (p7zip) is not installed - needed to extract DMG"
    echo "  Install: sudo pacman -S p7zip (Arch) or apt install p7zip-full (Debian)"
    exit 1
fi
success "7z available"

# Step 2: Get Claude Desktop DMG
echo ""
echo "Step 2: Claude Desktop app..."

if [ -d "$APP_DIR" ] && [ -f "$APP_DIR/.vite/build/index.js" ]; then
    success "Claude Desktop already extracted at $APP_DIR"
else
    echo ""
    info "You need to provide a Claude Desktop .dmg file"
    echo "  Download from: https://claude.ai/download"
    echo ""

    if [ -n "$1" ] && [ -f "$1" ]; then
        DMG_PATH="$1"
    else
        read -p "Enter path to Claude Desktop .dmg file: " DMG_PATH
    fi

    if [ ! -f "$DMG_PATH" ]; then
        error "DMG file not found: $DMG_PATH"
        exit 1
    fi

    info "Extracting DMG..."
    TEMP_DIR=$(mktemp -d)
    7z x -o"$TEMP_DIR" "$DMG_PATH" > /dev/null 2>&1 || {
        error "Failed to extract DMG"
        rm -rf "$TEMP_DIR"
        exit 1
    }

    # Find the app bundle
    APP_BUNDLE=$(find "$TEMP_DIR" -name "Claude.app" -type d 2>/dev/null | head -1)
    if [ -z "$APP_BUNDLE" ]; then
        error "Could not find Claude.app in DMG"
        rm -rf "$TEMP_DIR"
        exit 1
    fi

    info "Copying app resources..."
    mkdir -p "$APP_DIR"
    cp -r "$APP_BUNDLE/Contents/Resources/app/"* "$APP_DIR/"

    rm -rf "$TEMP_DIR"
    success "Claude Desktop extracted"
fi

# Step 3: Apply patches
echo ""
echo "Step 3: Applying Linux patches..."

# Copy our stub files
info "Installing swift addon stub..."
mkdir -p "$APP_DIR/node_modules/@ant/claude-swift/js"
cp "$SCRIPT_DIR/stubs/@ant/claude-swift/js/index.js" "$APP_DIR/node_modules/@ant/claude-swift/js/"
success "Swift addon stub installed"

info "Installing native addon stub..."
mkdir -p "$APP_DIR/node_modules/@ant/claude-native"
cp "$SCRIPT_DIR/stubs/@ant/claude-native/index.js" "$APP_DIR/node_modules/@ant/claude-native/"
success "Native addon stub installed"

# Patch index.js for Linux support
INDEX_FILE="$APP_DIR/.vite/build/index.js"
if [ -f "$INDEX_FILE" ]; then
    # Check if already patched
    if grep -q "process.platform === 'linux'" "$INDEX_FILE"; then
        success "Main bundle already patched"
    else
        info "Patching main bundle for Linux support..."

        # Backup original
        cp "$INDEX_FILE" "$INDEX_FILE.bak"

        # Patch Ege() function to support Linux
        # Find: status:"unsupported",reason:"local_agent_mode_not_supported_on_platform"
        # Add before it: if(process.platform==='linux')return{status:"supported"};
        sed -i 's/status:"unsupported",reason:"local_agent_mode_not_supported_on_platform"/status:"supported"}/; s/status:"supported"}/if(process.platform==="linux")return{status:"supported"};return{status:"unsupported",reason:"local_agent_mode_not_supported_on_platform"}/' "$INDEX_FILE" 2>/dev/null || {
            warn "Auto-patch failed - manual patching may be required"
            echo "  See README.md for manual patching instructions"
        }

        success "Main bundle patched"
    fi
else
    error "Main bundle not found at $INDEX_FILE"
    exit 1
fi

# Step 4: Create /sessions directory
echo ""
echo "Step 4: Creating required directories..."

if [ -d "/sessions" ] && [ -w "/sessions" ]; then
    success "/sessions directory exists"
else
    warn "/sessions directory needs to be created (requires sudo)"
    echo "  The Claude binary has hardcoded internal paths that require this."
    echo ""
    read -p "Create /sessions with sudo? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        sudo mkdir -p /sessions
        sudo chmod 777 /sessions
        success "/sessions created"
    else
        error "Cannot continue without /sessions"
        echo "  Run manually: sudo mkdir -p /sessions && sudo chmod 777 /sessions"
        exit 1
    fi
fi

mkdir -p "$HOME/.config/Claude/cowork-sessions"
success "Session directories ready"

# Step 5: Install npm dependencies
echo ""
echo "Step 5: Installing Electron..."

cd "$SCRIPT_DIR"
if [ ! -f "package.json" ]; then
    cat > package.json << 'EOF'
{
  "name": "claude-cowork-linux",
  "version": "1.0.0",
  "description": "Claude Cowork for Linux",
  "main": "app/.vite/build/index.js",
  "scripts": {
    "start": "./run.sh"
  },
  "devDependencies": {
    "electron": "^33.0.0"
  }
}
EOF
fi

npm install
success "Electron installed"

# Done!
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                   Installation Complete!                    ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "To run Claude Desktop with Cowork:"
echo "  ./run.sh"
echo ""
echo "For debugging:"
echo "  tail -f /tmp/claude-swift-trace.log"
echo ""
