#!/bin/bash
#
# Claude Desktop for Linux - One-Click Installer
#
# Usage: ./install.sh [path/to/Claude.dmg]
#        curl -fsSL https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master/install.sh | bash
#
# This script:
#   1. Checks/installs dependencies (7z, node, electron, asar)
#   2. Downloads Claude macOS DMG from Anthropic's official CDN
#   3. Extracts and patches the app for Linux compatibility
#   4. Installs to /Applications/Claude.app (macOS-style path for compat)
#   5. Creates desktop entry and CLI command
#
# Requirements: Linux with apt/pacman/dnf, Node.js 18+, ~500MB disk space
#
# License: MIT
# Source: https://github.com/johnzfitch/claude-cowork-linux

set -euo pipefail

# ============================================================
# Configuration
# ============================================================

VERSION="2.0.0"
CLAUDE_VERSION="latest"

# Official Anthropic download URLs
DMG_URL_PRIMARY="https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest/Claude.dmg"
DMG_URL_FALLBACK="https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect"

# Stub download URLs (from GitHub repo)
REPO_BASE="https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master"
SWIFT_STUB_URL="${REPO_BASE}/stubs/@ant/claude-swift/js/index.js"
NATIVE_STUB_URL="${REPO_BASE}/stubs/@ant/claude-native/index.js"

# Minimum expected DMG size (100MB) - basic integrity check
MIN_DMG_SIZE=100000000

# Installation paths
INSTALL_DIR="/Applications/Claude.app"
USER_DATA_DIR="$HOME/Library/Application Support/Claude"
USER_LOG_DIR="$HOME/Library/Logs/Claude"
USER_CACHE_DIR="$HOME/Library/Caches/Claude"

# Temp directory for installation (with cleanup on multiple signals)
WORK_DIR=$(mktemp -d)
cleanup() { rm -rf "$WORK_DIR" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================
# Utility Functions
# ============================================================

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

die() {
    log_error "$@"
    exit 1
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Detect package manager
detect_pkg_manager() {
    if command_exists apt-get; then
        echo "apt"
    elif command_exists pacman; then
        echo "pacman"
    elif command_exists dnf; then
        echo "dnf"
    elif command_exists zypper; then
        echo "zypper"
    elif command_exists nix-env; then
        echo "nix"
    else
        echo "unknown"
    fi
}

# ============================================================
# Dependency Installation
# ============================================================

install_dependencies() {

# Portable file size formatter (replacement for numfmt)
format_size() {
    local size=$1
    local units=("B" "KB" "MB" "GB" "TB")
    local unit=0
    local num=$size
    
    while (( num > 1024 && unit < 4 )); do
        num=$((num / 1024))
        unit=$((unit + 1))
    done
    
    echo "${num}${units[$unit]}"
}

# Optional SHA256 verification if checksum is known
verify_checksum() {
    local file_path="$1"
    local expected_sha256="${CLAUDE_DMG_SHA256:-}"
    
    if [[ -z "$expected_sha256" ]]; then
        log_warn "No SHA256 checksum provided (set CLAUDE_DMG_SHA256=<hash> to verify)"
        log_info "Anthropic does not publish official checksums for Claude Desktop DMG"
        log_info "Download source: $DMG_URL_PRIMARY"
        return 0
    fi
    
    log_info "Verifying SHA256 checksum..."
    local actual_sha256
    if command -v sha256sum >/dev/null 2>&1; then
        actual_sha256=$(sha256sum "$file_path" | awk "{print \$1}")
    elif command -v shasum >/dev/null 2>&1; then
        actual_sha256=$(shasum -a 256 "$file_path" | awk "{print \$1}")
    else
        log_warn "No SHA256 tool available (sha256sum or shasum required)"
        return 0
    fi
    
    if [[ "$actual_sha256" != "$expected_sha256" ]]; then
        die "SHA256 checksum mismatch! Expected: $expected_sha256, Got: $actual_sha256"
    fi
    
    log_success "SHA256 checksum verified"
}

    log_info "Checking dependencies..."

    local pkg_manager
    pkg_manager=$(detect_pkg_manager)
    local missing=()

    # Check each required command
    if ! command_exists 7z; then
        missing+=("7z")
    fi
    if ! command_exists node; then
        missing+=("nodejs")
    fi
    if ! command_exists npm; then
        missing+=("npm")
    fi
    if ! command_exists bwrap; then
        missing+=("bubblewrap")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_info "Missing packages: ${missing[*]}"
        log_warn "The following packages will be installed via your package manager."
        echo ""
        read -r -p "Continue with installation? [Y/n] " response
        response=${response:-Y}
        if [[ ! "$response" =~ ^[Yy]$ ]]; then
            die "Installation cancelled by user"
        fi

        case "$pkg_manager" in
            apt)
                sudo apt-get update -qq
                sudo apt-get install -y p7zip-full nodejs npm bubblewrap
                ;;
            pacman)
                # Install only required packages without system upgrade
                sudo pacman -S --noconfirm --needed p7zip nodejs npm bubblewrap
                ;;
            dnf)
                sudo dnf install -y p7zip nodejs npm bubblewrap
                ;;
            zypper)
                sudo zypper install -y p7zip nodejs npm bubblewrap
                ;;
            nix)
                nix-env -iA nixpkgs.p7zip nixpkgs.nodejs nixpkgs.bubblewrap
                ;;
            *)
                die "Unknown package manager. Please install manually: p7zip nodejs npm bubblewrap"
                ;;
        esac
    fi

    # Install npm packages to user prefix (avoid sudo npm)
    local npm_prefix="${HOME}/.local"
    mkdir -p "$npm_prefix"

    if ! command_exists asar; then
        log_info "Installing @electron/asar to $npm_prefix..."
        npm config set prefix "$npm_prefix" 2>/dev/null || true
        npm install --silent -g @electron/asar || die "Failed to install asar. Try: npm install -g @electron/asar"
        export PATH="$npm_prefix/bin:$PATH"
    fi

    if ! command_exists electron; then
        log_info "Installing electron to $npm_prefix..."
        npm config set prefix "$npm_prefix" 2>/dev/null || true
        npm install --silent -g electron || die "Failed to install electron. Try: npm install -g electron"
        export PATH="$npm_prefix/bin:$PATH"
    fi

    # Verify all dependencies
    local all_ok=true
    for cmd in 7z node npm asar electron bwrap; do
        if command_exists "$cmd"; then
            log_success "Found: $cmd"
        else
            log_error "Missing: $cmd"
            all_ok=false
        fi
    done

    if [[ "$all_ok" != "true" ]]; then
        die "Some dependencies could not be installed"
    fi

    # Check Node.js version
    local node_version
    node_version=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ "$node_version" -lt 18 ]]; then
        die "Node.js 18+ required, found v$node_version"
    fi
    log_success "Node.js version OK (v$node_version)"
}

# ============================================================
# Download Claude DMG
# ============================================================

download_dmg() {
    local dmg_path="$1"

    # Validate user-provided DMG path (prevent path traversal)
    if [[ -n "${CLAUDE_DMG:-}" ]]; then
        # Resolve to absolute path and check it exists
        local resolved_path
        resolved_path=$(realpath -e "$CLAUDE_DMG" 2>/dev/null) || die "User-provided DMG not found: $CLAUDE_DMG"

        # Verify it's a regular file
        if [[ ! -f "$resolved_path" ]]; then
            die "CLAUDE_DMG must be a regular file: $CLAUDE_DMG"
        fi

        # Basic sanity check - must end in .dmg
        if [[ ! "$resolved_path" =~ \.dmg$ ]]; then
            log_warn "File does not have .dmg extension: $CLAUDE_DMG"
            read -r -p "Continue anyway? [y/N] " response
            if [[ ! "$response" =~ ^[Yy]$ ]]; then
                die "Installation cancelled"
            fi
        fi

        log_info "Using user-provided DMG: $resolved_path"
        cp "$resolved_path" "$dmg_path"
        return 0
    fi

    # Check current directory for existing DMG (safely)
    local existing_dmg=""
    while IFS= read -r -d $'\0' file; do
        existing_dmg="$file"
        break
    done < <(find . -maxdepth 1 \( -name "Claude*.dmg" -o -name "claude*.dmg" \) -type f -print0 2>/dev/null)

    if [[ -n "$existing_dmg" ]]; then
        log_info "Found existing DMG: $existing_dmg"
        read -r -p "Use this DMG? [Y/n] " response
        response=${response:-Y}
        if [[ "$response" =~ ^[Yy]$ ]]; then
            cp "$existing_dmg" "$dmg_path"
            return 0
        fi
    fi

    log_info "Downloading Claude Desktop from Anthropic's official CDN..."
    log_info "Source: $DMG_URL_PRIMARY"
    echo ""

    # Try primary URL first
    if curl -fSL --progress-bar -o "$dmg_path" "$DMG_URL_PRIMARY" 2>/dev/null; then
        log_success "Downloaded from primary CDN"
    elif curl -fSL --progress-bar -o "$dmg_path" "$DMG_URL_FALLBACK" 2>/dev/null; then
        log_success "Downloaded from fallback URL"
    else
        log_error "Failed to download Claude DMG"
        log_info ""
        log_info "Manual download instructions:"
        log_info "  1. Visit https://claude.ai/download"
        log_info "  2. Download the macOS version"
        log_info "  3. Re-run with: CLAUDE_DMG=/path/to/Claude.dmg $0"
        exit 1
    fi

    # Verify download size (minimum 100MB for valid DMG)
    local dmg_size
    dmg_size=$(stat -c%s "$dmg_path" 2>/dev/null || stat -f%z "$dmg_path" 2>/dev/null || echo 0)
    if [[ ! -f "$dmg_path" ]] || [[ "$dmg_size" -lt "$MIN_DMG_SIZE" ]]; then
        die "Download appears incomplete or corrupted (size: ${dmg_size} bytes, expected >100MB)"
    fi
    log_success "Download verified ($(format_size "$dmg_size"))"
    
    # Optional SHA256 verification
    verify_checksum "$dmg_path"
}

# ============================================================
# Extract and Patch App
# ============================================================

extract_app() {
    local dmg_path="$1"
    local extract_dir="$2"

    log_info "Extracting DMG..."
    7z x -y -o"$extract_dir" "$dmg_path" >/dev/null 2>&1 || die "Failed to extract DMG"

    # Find Claude.app
    local claude_app
    claude_app=$(find "$extract_dir" -name "Claude.app" -type d | head -1)
    if [[ -z "$claude_app" ]]; then
        die "Claude.app not found in DMG"
    fi

    log_success "Extracted Claude.app"
    echo "$claude_app"
}

extract_asar() {
    local claude_app="$1"
    local app_extract_dir="$2"

    local asar_file="$claude_app/Contents/Resources/app.asar"
    if [[ ! -f "$asar_file" ]]; then
        die "app.asar not found"
    fi

    log_info "Extracting app.asar..."
    asar extract "$asar_file" "$app_extract_dir" || die "Failed to extract app.asar"
    log_success "Extracted app code"
}

# ============================================================
# Download Linux Stubs
# ============================================================

download_swift_stub() {
    local stub_dir="$1"
    mkdir -p "$stub_dir"
    curl -fsSL "$SWIFT_STUB_URL" -o "$stub_dir/index.js" || die "Failed to download Swift stub"
    log_success "Downloaded Swift stub"
}

download_native_stub() {
    local stub_dir="$1"
    mkdir -p "$stub_dir"
    curl -fsSL "$NATIVE_STUB_URL" -o "$stub_dir/index.js" || die "Failed to download Native stub"
    log_success "Downloaded Native stub"
}

# ============================================================
# Create Linux Loader
# ============================================================

create_linux_loader() {
    local resources_dir="$1"

    cat > "$resources_dir/linux-loader.js" << 'LOADER'
#!/usr/bin/env node
/**
 * linux-loader.js - Claude Linux compatibility layer
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');

console.log('Claude Linux Loader');

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;
const RESOURCES_DIR = __dirname;
const STUB_PATH = path.join(RESOURCES_DIR, 'stubs', '@ant', 'claude-swift', 'js', 'index.js');

let appStarted = false;

Object.defineProperty(process, 'platform', {
  get() { return appStarted ? 'darwin' : REAL_PLATFORM; },
  configurable: true
});

Object.defineProperty(process, 'arch', {
  get() {
    const stack = new Error().stack || '';
    if (stack.includes('internal/') || stack.includes('node:')) return REAL_ARCH;
    if (stack.includes('/app/') || stack.includes('Claude.app') || stack.includes('.vite/build')) return 'arm64';
    return REAL_ARCH;
  },
  configurable: true
});

const originalGetSystemVersion = process.getSystemVersion;
process.getSystemVersion = function() {
  const stack = new Error().stack || '';
  if (stack.includes('/app/') || stack.includes('Claude.app') || stack.includes('.vite/build')) return '14.0.0';
  return originalGetSystemVersion ? originalGetSystemVersion.call(process) : '0.0.0';
};

const originalLoad = Module._load;
let swiftStubCache = null;
let loadingStub = false;
let patchedElectron = null;

function loadSwiftStub() {
  if (swiftStubCache) return swiftStubCache;
  if (!fs.existsSync(STUB_PATH)) throw new Error(`Swift stub not found: ${STUB_PATH}`);
  loadingStub = true;
  try {
    delete require.cache[STUB_PATH];
    swiftStubCache = originalLoad.call(Module, STUB_PATH, module, false);
  } finally { loadingStub = false; }
  return swiftStubCache;
}

Module._load = function(request, parent, isMain) {
  if (loadingStub) return originalLoad.apply(this, arguments);
  if (request.includes('swift_addon') && request.endsWith('.node')) return loadSwiftStub();
  if (request === 'electron' && patchedElectron) return patchedElectron;
  return originalLoad.apply(this, arguments);
};

const electron = require('electron');
const app = electron.app;
let pendingDeepLinks = [];

function parseClaudeUrlArg(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.startsWith('claude://') ? trimmed : null;
}

function dispatchClaudeUrl(url) {
  try {
    app.emit('open-url', { preventDefault() {} }, url);
    console.log('[Protocol] Forwarded URL:', url);
  } catch (e) {
    console.error('[Protocol] Failed to forward URL:', e.message);
  }
}

app.on('second-instance', (_event, argv) => {
  const args = Array.isArray(argv) ? argv : [];
  for (const arg of args) {
    const url = parseClaudeUrlArg(arg);
    if (!url) continue;
    pendingDeepLinks.push(url);
    if (app.isReady()) dispatchClaudeUrl(url);
  }
});

app.whenReady().then(() => {
  for (const url of pendingDeepLinks) dispatchClaudeUrl(url);
  pendingDeepLinks = [];
});

const origSysPrefs = electron.systemPreferences || {};
const patchedSysPrefs = {
  getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true,
  getEffectiveAppearance: () => 'light', getAppearance: () => 'light', setAppearance: () => {},
  getAccentColor: () => '007AFF', getColor: () => '#007AFF',
  getUserDefault: () => null, setUserDefault: () => {}, removeUserDefault: () => {},
  subscribeNotification: () => 0, unsubscribeNotification: () => {},
  subscribeWorkspaceNotification: () => 0, unsubscribeWorkspaceNotification: () => {},
  postNotification: () => {}, postLocalNotification: () => {},
  isTrustedAccessibilityClient: () => true, isSwipeTrackingFromScrollEventsEnabled: () => false,
  isAeroGlassEnabled: () => false, isHighContrastColorScheme: () => false,
  isReducedMotion: () => false, isInvertedColorScheme: () => false,
};
for (const [key, val] of Object.entries(patchedSysPrefs)) origSysPrefs[key] = val;

const OrigBrowserWindow = electron.BrowserWindow;
const macOSWindowMethods = {
  setWindowButtonPosition: () => {}, getWindowButtonPosition: () => ({ x: 0, y: 0 }),
  setTrafficLightPosition: () => {}, getTrafficLightPosition: () => ({ x: 0, y: 0 }),
  setWindowButtonVisibility: () => {}, setVibrancy: () => {}, setBackgroundMaterial: () => {},
  setRepresentedFilename: () => {}, getRepresentedFilename: () => '',
  setDocumentEdited: () => {}, isDocumentEdited: () => false,
  setTouchBar: () => {}, setSheetOffset: () => {}, setAutoHideCursor: () => {},
};
for (const [method, impl] of Object.entries(macOSWindowMethods)) {
  if (typeof OrigBrowserWindow.prototype[method] !== 'function') OrigBrowserWindow.prototype[method] = impl;
}

const OrigMenu = electron.Menu;
const origSetApplicationMenu = OrigMenu.setApplicationMenu;
OrigMenu.setApplicationMenu = function(menu) {
  try { if (origSetApplicationMenu) return origSetApplicationMenu.call(OrigMenu, menu); } catch (e) {}
};

const origBuildFromTemplate = OrigMenu.buildFromTemplate;
OrigMenu.buildFromTemplate = function(template) {
  const filtered = (template || []).map(item => {
    if (!item) return null;
    const f = { ...item };
    if (f.role === 'services' || f.role === 'recentDocuments') return null;
    if (f.submenu && Array.isArray(f.submenu)) {
      f.submenu = f.submenu.filter(s => s && s.role !== 'services' && s.role !== 'recentDocuments');
    }
    return f;
  }).filter(Boolean);
  return origBuildFromTemplate.call(OrigMenu, filtered);
};

patchedElectron = electron;

process.on('uncaughtException', (error) => {
  if (error.message && (error.message.includes('is not a function') || error.message.includes('No handler registered'))) {
    console.error('[Error]', error.message);
    return;
  }
  throw error;
});

appStarted = true;
require('./app/.vite/build/index.js');
LOADER

    chmod +x "$resources_dir/linux-loader.js"
    log_success "Created Linux loader"
}

# ============================================================
# Create Launch Script
# ============================================================

create_launcher() {
    local macos_dir="$1"

    cat > "$macos_dir/Claude" << 'LAUNCHER'
#!/bin/bash
# Claude launcher script

SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_PATH"
done

SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/../Resources"
cd "$RESOURCES_DIR"

ELECTRON_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --debug) export CLAUDE_TRACE=1 ;;
    --devtools) ELECTRON_ARGS+=("--inspect") ;;
    --isolate-network) export CLAUDE_ISOLATE_NETWORK=1 ;;
    *) ELECTRON_ARGS+=("$arg") ;;
  esac
done

export ELECTRON_ENABLE_LOGGING=1

# Wayland support for Hyprland, Sway, and other Wayland compositors
if [[ -n "$WAYLAND_DISPLAY" ]] || [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
  export ELECTRON_OZONE_PLATFORM_HINT=wayland
fi

# Launch Electron
exec electron linux-loader.js "${ELECTRON_ARGS[@]}" 2>&1 | tee -a ~/Library/Logs/Claude/startup.log
LAUNCHER

    chmod +x "$macos_dir/Claude"
    log_success "Created launcher script"
}

# ============================================================
# Install Application
# ============================================================

confirm_sudo_operations() {
    echo ""
    log_warn "The following operations require sudo (root) privileges:"
    echo "  - Create directory: $INSTALL_DIR"
    echo "  - Copy application files to $INSTALL_DIR"
    echo "  - Create symlinks: /usr/local/bin/claude-desktop and /usr/local/bin/claude-cowork"
    echo ""
    read -r -p "Proceed with installation? [Y/n] " response
    response=${response:-Y}
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        die "Installation cancelled by user"
    fi
}

install_app() {
    local claude_app="$1"
    local app_extract_dir="$2"

    # Show what sudo operations will be performed
    confirm_sudo_operations

    log_info "Installing to $INSTALL_DIR..."

    # Remove old installation (with safety check)
    if [[ -d "$INSTALL_DIR" ]]; then
        log_info "Removing previous installation..."
        sudo rm -rf "$INSTALL_DIR"
    fi

    # Create directory structure
    sudo mkdir -p "$INSTALL_DIR/Contents/"{MacOS,Resources,Frameworks}

    # Copy extracted app code
    sudo cp -r "$app_extract_dir" "$INSTALL_DIR/Contents/Resources/app"

    # Copy resources from original app
    sudo cp -r "$claude_app/Contents/Resources/"* "$INSTALL_DIR/Contents/Resources/" 2>/dev/null || true

    # Create and install stubs
    local stub_swift_dir="$INSTALL_DIR/Contents/Resources/stubs/@ant/claude-swift/js"
    local stub_native_dir="$INSTALL_DIR/Contents/Resources/stubs/@ant/claude-native"

    sudo mkdir -p "$stub_swift_dir" "$stub_native_dir"

    # Download stubs from repo then copy
    download_swift_stub "$WORK_DIR/stubs/swift"
    download_native_stub "$WORK_DIR/stubs/native"

    sudo cp "$WORK_DIR/stubs/swift/index.js" "$stub_swift_dir/index.js"
    sudo cp "$WORK_DIR/stubs/native/index.js" "$stub_native_dir/index.js"

    # Replace original @ant modules with stubs
    sudo cp "$WORK_DIR/stubs/swift/index.js" "$INSTALL_DIR/Contents/Resources/app/node_modules/@ant/claude-swift/js/index.js"
    sudo cp "$WORK_DIR/stubs/native/index.js" "$INSTALL_DIR/Contents/Resources/app/node_modules/@ant/claude-native/index.js"

    # Create Linux loader
    create_linux_loader "$INSTALL_DIR/Contents/Resources"

    # Create launcher
    create_launcher "$INSTALL_DIR/Contents/MacOS"

    # Create canonical launchers in PATH
    sudo ln -sf "$INSTALL_DIR/Contents/MacOS/Claude" /usr/local/bin/claude-desktop
    sudo ln -sf "$INSTALL_DIR/Contents/MacOS/Claude" /usr/local/bin/claude-cowork
    # Back-compat only: do not clobber existing Claude Code CLI if already installed.
    if [[ ! -e /usr/local/bin/claude ]]; then
      sudo ln -sf "$INSTALL_DIR/Contents/MacOS/Claude" /usr/local/bin/claude
    fi

    log_success "Installed to $INSTALL_DIR"
}

# ============================================================
# Setup User Environment
# ============================================================

setup_user_dirs() {
    log_info "Setting up user directories..."

    # Create macOS-style directories
    mkdir -p "$USER_DATA_DIR"/{Projects,Conversations,"Claude Extensions","Claude Extensions Settings",claude-code-vm,vm_bundles,blob_storage}
    mkdir -p "$USER_LOG_DIR"
    mkdir -p "$USER_CACHE_DIR"
    mkdir -p ~/Library/Preferences

    # Create default configs if not exist
    if [[ ! -f "$USER_DATA_DIR/config.json" ]]; then
        cat > "$USER_DATA_DIR/config.json" << 'EOF'
{
  "scale": 0,
  "locale": "en-US",
  "userThemeMode": "system",
  "hasTrackedInitialActivation": false
}
EOF
    fi

    if [[ ! -f "$USER_DATA_DIR/claude_desktop_config.json" ]]; then
        cat > "$USER_DATA_DIR/claude_desktop_config.json" << 'EOF'
{
  "preferences": {
    "chromeExtensionEnabled": true
  }
}
EOF
    fi

    # Set permissions
    chmod 700 "$USER_DATA_DIR" "$USER_LOG_DIR" "$USER_CACHE_DIR"

    log_success "User directories created"
}

# ============================================================
# Create Desktop Entry
# ============================================================

create_desktop_entry() {
    log_info "Creating desktop entry..."

    mkdir -p ~/.local/share/applications

    cat > ~/.local/share/applications/claude.desktop << EOF
[Desktop Entry]
Type=Application
Name=Claude
Comment=AI assistant by Anthropic
Exec=/usr/local/bin/claude-desktop %U
Icon=$INSTALL_DIR/Contents/Resources/icon.icns
Terminal=false
Categories=Utility;Development;Chat;
Keywords=AI;assistant;chat;anthropic;
StartupWMClass=Claude
MimeType=x-scheme-handler/claude;
EOF

    chmod +x ~/.local/share/applications/claude.desktop

    if command_exists update-desktop-database; then
        update-desktop-database ~/.local/share/applications 2>/dev/null || true
    fi
    if command_exists xdg-mime; then
        xdg-mime default claude.desktop x-scheme-handler/claude 2>/dev/null || true
    fi

    log_success "Desktop entry created"
}

# ============================================================
# Main Installation Flow
# ============================================================

main() {
    # Allow positional arg as DMG path (./install.sh ~/Downloads/Claude.dmg)
    if [[ -n "${1:-}" && -z "${CLAUDE_DMG:-}" ]]; then
        export CLAUDE_DMG="$1"
    fi

    echo ""
    echo "=========================================="
    echo " Claude Desktop for Linux - Installer"
    echo " Version: $VERSION"
    echo "=========================================="
    echo ""

    # Check if running as root (bad idea)
    if [[ $EUID -eq 0 ]]; then
        die "Do not run as root. The script will use sudo when needed."
    fi

    # Step 1: Dependencies
    install_dependencies
    echo ""

    # Step 2: Download DMG
    local dmg_path="$WORK_DIR/Claude.dmg"
    download_dmg "$dmg_path"
    echo ""

    # Step 3: Extract
    local extract_dir="$WORK_DIR/extract"
    local claude_app
    claude_app=$(extract_app "$dmg_path" "$extract_dir")
    echo ""

    # Step 4: Extract app.asar
    local app_extract_dir="$WORK_DIR/app-extracted"
    extract_asar "$claude_app" "$app_extract_dir"
    echo ""

    # Step 5: Install
    install_app "$claude_app" "$app_extract_dir"
    echo ""

    # Step 6: User setup
    setup_user_dirs
    echo ""

    # Step 7: Desktop entry
    create_desktop_entry
    echo ""

    # Done!
    echo "=========================================="
    echo -e "${GREEN} Installation Complete!${NC}"
    echo "=========================================="
    echo ""
    echo "Launch Claude:"
    echo "  Command:  claude-cowork"
    echo "  Alt Cmd:  claude-desktop"
    echo "  Desktop:  Search for 'Claude' in app launcher"
    echo ""
    echo "Options:"
    echo "  claude --debug      Enable trace logging"
    echo "  claude --devtools   Enable Chrome DevTools"
    echo ""
    echo "Logs: ~/Library/Logs/Claude/startup.log"
    echo ""
}

# Run main
main "$@"
