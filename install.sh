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

    # Check if app.asar exists (newer versions) or app/ directory (older versions)
    if [ -f "$APP_BUNDLE/Contents/Resources/app.asar" ]; then
        info "Detected app.asar format, extracting..."

        # Install asar if not available
        if ! command -v npx &> /dev/null; then
            error "npx not found. Please install Node.js first."
            rm -rf "$TEMP_DIR"
            exit 1
        fi

        # Extract asar file using npx
        npx --yes asar extract "$APP_BUNDLE/Contents/Resources/app.asar" "$APP_DIR" || {
            error "Failed to extract app.asar"
            rm -rf "$TEMP_DIR"
            exit 1
        }

        # Copy unpacked files if they exist
        if [ -d "$APP_BUNDLE/Contents/Resources/app.asar.unpacked" ]; then
            cp -r "$APP_BUNDLE/Contents/Resources/app.asar.unpacked/"* "$APP_DIR/" 2>/dev/null || true
        fi

        # Copy i18n resources (they're not in the asar)
        info "Copying i18n resources..."
        mkdir -p "$APP_DIR/resources/i18n"
        cp "$APP_BUNDLE/Contents/Resources/"*.json "$APP_DIR/resources/i18n/" 2>/dev/null || true

        success "app.asar extracted"
    elif [ -d "$APP_BUNDLE/Contents/Resources/app" ]; then
        info "Detected unpacked app/ directory format..."
        cp -r "$APP_BUNDLE/Contents/Resources/app/"* "$APP_DIR/"
        success "App directory copied"
    else
        error "Could not find app.asar or app/ directory in Claude.app"
        rm -rf "$TEMP_DIR"
        exit 1
    fi

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

        # Patch Ege() function to support Linux using Node.js for reliable string replacement
        node -e "
        const fs = require('fs');
        const file = '$INDEX_FILE';
        let content = fs.readFileSync(file, 'utf8');

        // Patch 1: Ege function for platform support
        const egeOriginal = 'function Ege(){return process.platform!==\"darwin\"?{status:\"unsupported\",reason:\"Darwin only\"}:process.arch!==\"arm64\"?{status:\"unsupported\",reason:\"arm64 only\"}:z8().major<14?{status:\"unsupported\",reason:\"minimum macOS version not met\"}:{status:\"supported\"}}';

        const egePatched = 'function Ege(){if(process.platform===\"linux\")return{status:\"supported\"};return process.platform!==\"darwin\"?{status:\"unsupported\",reason:\"Darwin only\"}:process.arch!==\"arm64\"?{status:\"unsupported\",reason:\"arm64 only\"}:z8().major<14?{status:\"unsupported\",reason:\"minimum macOS version not met\"}:{status:\"supported\"}}';

        if (content.includes(egeOriginal)) {
          content = content.replace(egeOriginal, egePatched);
          console.log('Patched: Ege function for platform support');
        } else {
          console.error('WARNING: Could not find Ege function to patch');
        }

        // Patch 2: Q7 function for IPC origin validation
        const q7Original = 'function Q7(t){var r;if(!t.senderFrame)return!1;const e=new URL(t.senderFrame.url);return!!(((r=t.senderFrame)==null?void 0:r.parent)===null&&(e.origin===\"https://claude.ai\"||e.origin===\"https://preview.claude.ai\"||e.origin===\"https://claude.com\"||e.origin===\"https://preview.claude.com\"||globalThis.isDeveloperApprovedLocalOverrideEnabled&&e.hostname===\"localhost\"||e.hostname===\"localhost\"&&ce.app.isPackaged===!1||e.protocol===\"file:\"&&ce.app.isPackaged===!0))}';

        const q7Patched = 'function Q7(t){var r;if(!t.senderFrame)return!1;const e=new URL(t.senderFrame.url);return!!(((r=t.senderFrame)==null?void 0:r.parent)===null&&(e.origin===\"https://claude.ai\"||e.origin===\"https://preview.claude.ai\"||e.origin===\"https://claude.com\"||e.origin===\"https://preview.claude.com\"||globalThis.isDeveloperApprovedLocalOverrideEnabled&&e.hostname===\"localhost\"||e.hostname===\"localhost\"&&ce.app.isPackaged===!1||e.protocol===\"file:\"&&(ce.app.isPackaged===!0||process.platform===\"linux\")))}';

        if (content.includes(q7Original)) {
          content = content.replace(q7Original, q7Patched);
          console.log('Patched: Q7 function for IPC origin validation on Linux');
        } else {
          console.error('WARNING: Could not find Q7 function to patch (may already be patched)');
        }

        // Patch 3: \$n variable for feature availability (connectors/extensions)
        const platformOriginal = '\$n=process.platform===\"darwin\"';
        const platformPatched = '\$n=process.platform===\"darwin\"||process.platform===\"linux\"';

        if (content.includes(platformOriginal)) {
          content = content.replace(platformOriginal, platformPatched);
          console.log('Patched: \$n variable to enable extensions/connectors on Linux');
        } else {
          console.error('WARNING: Could not find \$n platform check to patch (may already be patched)');
        }

        fs.writeFileSync(file, content, 'utf8');
        process.exit(0);
        " || {
            warn "Auto-patch failed - manual patching may be required"
            echo "  See README.md for manual patching instructions"
        }

        success "Main bundle patched"
    fi
else
    error "Main bundle not found at $INDEX_FILE"
    exit 1
fi

# Step 4: Create /sessions symlink (secure alternative to 777 directory)
echo ""
echo "Step 4: Setting up session storage..."

USER_SESSIONS="$HOME/.local/share/claude-cowork/sessions"
mkdir -p "$USER_SESSIONS"
chmod 700 "$USER_SESSIONS"
success "User session directory: $USER_SESSIONS"

# The Claude binary has hardcoded /sessions path - we symlink it to user space
if [ -L "/sessions" ]; then
    # Already a symlink
    LINK_TARGET=$(readlink /sessions)
    if [ "$LINK_TARGET" = "$USER_SESSIONS" ]; then
        success "/sessions symlink already points to user space"
    else
        warn "/sessions symlink exists but points to: $LINK_TARGET"
        echo "  Expected: $USER_SESSIONS"
    fi
elif [ -d "/sessions" ]; then
    warn "/sessions exists as a directory (not symlink)"
    echo "  For better security, consider removing it and using a symlink:"
    echo "  sudo rm -rf /sessions && sudo ln -s $USER_SESSIONS /sessions"
else
    info "/sessions needs to be created as a symlink (requires sudo once)"
    echo "  This is more secure than a world-writable directory."
    echo "  The symlink will point to: $USER_SESSIONS"
    echo ""
    read -p "Create /sessions symlink with sudo? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        sudo ln -s "$USER_SESSIONS" /sessions
        success "/sessions -> $USER_SESSIONS (symlink created)"
    else
        warn "Skipping /sessions symlink"
        echo "  The app may fail. Run manually:"
        echo "  sudo ln -s $USER_SESSIONS /sessions"
    fi
fi

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
echo "  tail -f ~/.local/share/claude-cowork/logs/claude-swift-trace.log"
echo ""
