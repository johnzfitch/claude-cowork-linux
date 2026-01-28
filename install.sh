#!/bin/bash
# install.sh - Complete Claude Linux installation
# Creates exact macOS directory structure on Linux

set -e

VERSION="1.23.26"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================="
echo "Claude Linux Installer v${VERSION}"
echo "=========================================="
echo ""

# ============================================================
# DEPENDENCY CHECK
# ============================================================

echo "[1/9] Checking dependencies..."

check_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "✗ Missing: $1"
    echo "  Install with: $2"
    exit 1
  fi
  echo "✓ Found: $1"
}

check_command "7z" "sudo apt install p7zip-full"
check_command "asar" "npm install -g @electron/asar"
check_command "electron" "npm install -g electron"
check_command "node" "sudo apt install nodejs"

echo ""

# ============================================================
# LOCATE SOURCE FILES
# ============================================================

echo "[2/9] Locating source files..."

# Find the DMG or app directory
if [ -d "claude-app-2-1.23.26/Claude.app" ]; then
  CLAUDE_APP="$SCRIPT_DIR/claude-app-2-1.23.26/Claude.app"
  echo "✓ Found: Extracted Claude.app"
else
  DMG_FILE=$(find "$SCRIPT_DIR" -name "Claude-2-*.dmg" 2>/dev/null | head -1)

  if [ -z "$DMG_FILE" ]; then
    echo "✗ No Claude DMG or extracted app found"
    exit 1
  fi

  echo "✓ Found: $(basename "$DMG_FILE")"

  # Extract DMG
  echo "  Extracting DMG..."
  EXTRACT_DIR="$SCRIPT_DIR/extract-$(date +%s)"
  mkdir -p "$EXTRACT_DIR"
  7z x "$DMG_FILE" -o"$EXTRACT_DIR" >/dev/null 2>&1

  CLAUDE_APP=$(find "$EXTRACT_DIR" -name "Claude.app" -type d | head -1)

  if [ -z "$CLAUDE_APP" ]; then
    echo "✗ Claude.app not found in DMG"
    exit 1
  fi
fi

# Check for stub
STUB_FILE="$SCRIPT_DIR/stubs/@ant/claude-swift/js/index.js"
if [ ! -f "$STUB_FILE" ]; then
  echo "✗ Swift stub not found at: $STUB_FILE"
  exit 1
fi
echo "✓ Found: Swift Linux stub"

echo ""

# ============================================================
# EXTRACT APP.ASAR
# ============================================================

echo "[3/9] Extracting app.asar..."

ASAR_FILE="$CLAUDE_APP/Contents/Resources/app.asar"

if [ ! -f "$ASAR_FILE" ]; then
  echo "✗ app.asar not found"
  exit 1
fi

APP_EXTRACT="$SCRIPT_DIR/app-extracted"
rm -rf "$APP_EXTRACT"
asar extract "$ASAR_FILE" "$APP_EXTRACT"

echo "✓ Extracted $(du -sh "$APP_EXTRACT" | cut -f1) of app code"

# ============================================================
# CREATE APPLICATION STRUCTURE
# ============================================================

echo "[4/9] Creating /Applications/Claude.app..."

# Remove old installation
sudo rm -rf /Applications/Claude.app

# Create macOS structure
sudo mkdir -p /Applications/Claude.app/Contents/{MacOS,Resources,Frameworks}

# Copy extracted app
echo "  Copying app files..."
sudo cp -r "$APP_EXTRACT" /Applications/Claude.app/Contents/Resources/app

# Copy ALL resources from DMG
echo "  Copying resources..."
sudo cp -r "$CLAUDE_APP/Contents/Resources/"* /Applications/Claude.app/Contents/Resources/ 2>/dev/null || true

# Create stubs directory and copy stub
echo "  Installing Swift Linux stub..."
sudo mkdir -p /Applications/Claude.app/Contents/Resources/stubs/@ant/claude-swift/js
sudo cp "$STUB_FILE" /Applications/Claude.app/Contents/Resources/stubs/@ant/claude-swift/js/index.js

# CRITICAL: Replace the original @ant modules with our stubs
# ESM dynamic imports bypass Module._load hooks, so we must replace the actual files
echo "  Replacing original Swift module with stub..."
sudo cp "$STUB_FILE" /Applications/Claude.app/Contents/Resources/app/node_modules/@ant/claude-swift/js/index.js

# Also replace claude-native module
NATIVE_STUB_FILE="$SCRIPT_DIR/stubs/@ant/claude-native/index.js"
if [ -f "$NATIVE_STUB_FILE" ]; then
  echo "  Replacing original Native module with stub..."
  sudo mkdir -p /Applications/Claude.app/Contents/Resources/stubs/@ant/claude-native
  sudo cp "$NATIVE_STUB_FILE" /Applications/Claude.app/Contents/Resources/stubs/@ant/claude-native/index.js
  sudo cp "$NATIVE_STUB_FILE" /Applications/Claude.app/Contents/Resources/app/node_modules/@ant/claude-native/index.js
  echo "✓ Found: Native Linux stub"
else
  echo "⚠ Native stub not found, skipping"
fi

# Copy locale files to ALL Electron resources directories
echo "  Installing locale files to Electron..."
LOCALE_COUNT=0
for ELECTRON_DIR in /usr/lib/electron*/resources; do
  if [ -d "$ELECTRON_DIR" ]; then
    sudo cp "$CLAUDE_APP/Contents/Resources/"*.json "$ELECTRON_DIR/" 2>/dev/null || true
    LOCALE_COUNT=$((LOCALE_COUNT + 1))
  fi
done
if [ $LOCALE_COUNT -gt 0 ]; then
  echo "  ✓ Locale files installed to $LOCALE_COUNT Electron installation(s)"
else
  echo "  ⚠ No Electron resources directories found"
fi

# Copy .vite directory to where the app expects it (Resources/.vite)
sudo cp -r "$APP_EXTRACT/.vite" /Applications/Claude.app/Contents/Resources/.vite

echo "✓ Application structure created"

# ============================================================
# CREATE LINUX LOADER
# ============================================================

echo "[5/9] Creating linux-loader.js..."

cat << 'LOADEREOF' | sudo tee /Applications/Claude.app/Contents/Resources/linux-loader.js >/dev/null
#!/usr/bin/env node
/**
 * linux-loader.js - Claude Linux compatibility layer v2.2
 *
 * CRITICAL ORDER OF OPERATIONS:
 * 1. Platform spoofing (before anything)
 * 2. Module interception (BEFORE electron require!)
 * 3. Electron patching (safe now that interception is active)
 * 4. Load application
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');

console.log('='.repeat(60));
console.log('Claude Linux Loader v2.2');
console.log('='.repeat(60));

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;
const RESOURCES_DIR = __dirname;
const STUB_PATH = path.join(RESOURCES_DIR, 'stubs', '@ant', 'claude-swift', 'js', 'index.js');

// ============================================================
// 1. PLATFORM/ARCH/VERSION SPOOFING (must be first!)
// ============================================================

// Track whether we've started loading the app
let appStarted = false;

Object.defineProperty(process, 'platform', {
  get() {
    // Once app loading starts, always return darwin for app code
    if (appStarted) {
      return 'darwin';
    }
    return REAL_PLATFORM;
  },
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

console.log('[Platform] Spoofing: darwin/arm64 macOS 14.0');

// ============================================================
// 2. MODULE INTERCEPTION - MUST BE BEFORE ELECTRON REQUIRE!
// ============================================================

const originalLoad = Module._load;
let swiftStubCache = null;
let loadingStub = false;  // Prevent recursive interception

function loadSwiftStub() {
  if (swiftStubCache) {
    return swiftStubCache;
  }
  if (!fs.existsSync(STUB_PATH)) throw new Error(`Swift stub not found: ${STUB_PATH}`);

  // Prevent recursive interception when loading the stub itself
  loadingStub = true;
  try {
    // Clear any existing cache first
    delete require.cache[STUB_PATH];
    swiftStubCache = originalLoad.call(Module, STUB_PATH, module, false);

    console.log('[Module] Swift stub loaded');
    console.log('[Module] Stub has .on():', typeof swiftStubCache.on);
    console.log('[Module] Stub.default has .on():', swiftStubCache.default ? typeof swiftStubCache.default.on : 'no default');
  } finally {
    loadingStub = false;
  }
  return swiftStubCache;
}

// Store patched electron for reuse
let patchedElectron = null;

Module._load = function(request, parent, isMain) {
  // Skip interception if we're loading the stub itself
  if (loadingStub) {
    return originalLoad.apply(this, arguments);
  }

  // Intercept swift_addon.node (native binary that won't exist on Linux)
  if (request.includes('swift_addon') && request.endsWith('.node')) {
    console.log('[Module._load] Intercepted native:', request);
    return loadSwiftStub();
  }

  // Intercept electron to ensure patches are applied
  if (request === 'electron' && patchedElectron) {
    return patchedElectron;
  }

  return originalLoad.apply(this, arguments);
};

console.log('[Module] Swift interception enabled');

// ============================================================
// 3. NOW SAFE TO LOAD ELECTRON AND PATCH IT
// ============================================================

const electron = require('electron');

// Patch systemPreferences with macOS-only APIs
const origSysPrefs = electron.systemPreferences || {};
const patchedSysPrefs = {
  getMediaAccessStatus: () => 'granted',
  askForMediaAccess: async () => true,
  getEffectiveAppearance: () => 'light',
  getAppearance: () => 'light',
  setAppearance: () => {},
  getAccentColor: () => '007AFF',
  getColor: () => '#007AFF',
  getUserDefault: () => null,
  setUserDefault: () => {},
  removeUserDefault: () => {},
  subscribeNotification: () => 0,
  unsubscribeNotification: () => {},
  subscribeWorkspaceNotification: () => 0,
  unsubscribeWorkspaceNotification: () => {},
  postNotification: () => {},
  postLocalNotification: () => {},
  isTrustedAccessibilityClient: () => true,
  isSwipeTrackingFromScrollEventsEnabled: () => false,
  isAeroGlassEnabled: () => false,
  isHighContrastColorScheme: () => false,
  isReducedMotion: () => false,
  isInvertedColorScheme: () => false,
};

// Merge with originals, our patches take precedence
for (const [key, val] of Object.entries(patchedSysPrefs)) {
  origSysPrefs[key] = val;
}

// Patch BrowserWindow prototype for all future instances
const OrigBrowserWindow = electron.BrowserWindow;
const macOSWindowMethods = {
  setWindowButtonPosition: () => {},
  getWindowButtonPosition: () => ({ x: 0, y: 0 }),
  setTrafficLightPosition: () => {},
  getTrafficLightPosition: () => ({ x: 0, y: 0 }),
  setWindowButtonVisibility: () => {},
  setVibrancy: () => {},
  setBackgroundMaterial: () => {},
  setRepresentedFilename: () => {},
  getRepresentedFilename: () => '',
  setDocumentEdited: () => {},
  isDocumentEdited: () => false,
  setTouchBar: () => {},
  setSheetOffset: () => {},
  setAutoHideCursor: () => {},
};

for (const [method, impl] of Object.entries(macOSWindowMethods)) {
  if (typeof OrigBrowserWindow.prototype[method] !== 'function') {
    OrigBrowserWindow.prototype[method] = impl;
  }
}

// Wrap Menu.setApplicationMenu to handle edge cases
const OrigMenu = electron.Menu;
const origSetApplicationMenu = OrigMenu.setApplicationMenu;
OrigMenu.setApplicationMenu = function(menu) {
  console.log('[Electron] Patched Menu.setApplicationMenu');
  try {
    if (origSetApplicationMenu) {
      return origSetApplicationMenu.call(OrigMenu, menu);
    }
  } catch (e) {
    console.log('[Electron] Menu.setApplicationMenu error (ignored):', e.message);
  }
};

// Also patch Menu.buildFromTemplate for safety
const origBuildFromTemplate = OrigMenu.buildFromTemplate;
OrigMenu.buildFromTemplate = function(template) {
  // Filter out macOS-specific menu roles that don't exist on Linux
  const filteredTemplate = (template || []).map(item => {
    const filtered = { ...item };
    // Remove macOS-specific accelerators that might cause issues
    if (filtered.role === 'services' || filtered.role === 'recentDocuments') {
      return null;
    }
    if (filtered.submenu && Array.isArray(filtered.submenu)) {
      filtered.submenu = filtered.submenu.filter(sub => {
        if (!sub) return false;
        if (sub.role === 'services' || sub.role === 'recentDocuments') return false;
        return true;
      });
    }
    return filtered;
  }).filter(Boolean);
  return origBuildFromTemplate.call(OrigMenu, filteredTemplate);
};

// Store patched electron for module interception
patchedElectron = electron;

console.log('[Electron] Patched systemPreferences + BrowserWindow.prototype + Menu');

// ============================================================
// 4. IPC DEBUGGING
// ============================================================

const { ipcMain } = electron;

// Log ALL IPC handle registrations to find cowork-related ones
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function(channel, handler) {
  // Log VM and cowork related channels
  if (channel.includes('VM') || channel.includes('vm') || channel.includes('cowork') || channel.includes('spawn') || channel.includes('Cowork')) {
    console.log('[IPC] Handler registered:', channel);
  }
  return origHandle(channel, handler);
};

// Log all IPC on registrations
const origOn = ipcMain.on.bind(ipcMain);
ipcMain.on = function(channel, handler) {
  if (channel.includes('VM') || channel.includes('vm') || channel.includes('cowork') || channel.includes('spawn') || channel.includes('Cowork')) {
    console.log('[IPC] Listener registered:', channel);
  }
  return origOn(channel, handler);
};

// ============================================================
// 5. ERROR HANDLING
// ============================================================

process.on('uncaughtException', (error) => {
  if (error.message && (
    error.message.includes('is not a function') ||
    error.message.includes('No handler registered')
  )) {
    console.error('[Error] Caught:', error.message);
    return;
  }
  throw error;
});

// ============================================================
// 6. LOAD APPLICATION
// ============================================================

console.log('='.repeat(60));
console.log('Loading Claude application...');
console.log('='.repeat(60));
console.log('');

// Enable darwin spoofing for app code
appStarted = true;

require('./app/.vite/build/index.js');
LOADEREOF

sudo chmod +x /Applications/Claude.app/Contents/Resources/linux-loader.js

echo "✓ Linux loader created"

# ============================================================
# CREATE LAUNCH SCRIPT
# ============================================================

echo "[6/9] Creating launch script..."

cat << 'LAUNCHEREOF' | sudo tee /Applications/Claude.app/Contents/MacOS/Claude >/dev/null
#!/bin/bash
# Claude launcher script
# Usage: claude [--debug] [--devtools] [other electron args...]

# Resolve symlinks to find actual script location
SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_PATH"
done

SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/../Resources"
cd "$RESOURCES_DIR"

# Parse arguments
ELECTRON_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --debug)
      export CLAUDE_TRACE=1
      echo "[Claude] Debug trace logging enabled"
      ;;
    --devtools)
      ELECTRON_ARGS+=("--inspect")
      echo "[Claude] DevTools enabled (--inspect)"
      ;;
    --isolate-network)
      export CLAUDE_ISOLATE_NETWORK=1
      echo "[Claude] Network isolation enabled"
      ;;
    *)
      ELECTRON_ARGS+=("$arg")
      ;;
  esac
done

# Enable logging
export ELECTRON_ENABLE_LOGGING=1

# Launch with unbuffered output for real-time streaming
exec stdbuf -oL -eL electron linux-loader.js "${ELECTRON_ARGS[@]}" 2>&1 | stdbuf -oL tee -a ~/Library/Logs/Claude/startup.log
LAUNCHEREOF

sudo chmod +x /Applications/Claude.app/Contents/MacOS/Claude

# Create symlink in PATH
sudo ln -sf /Applications/Claude.app/Contents/MacOS/Claude /usr/local/bin/claude

echo "✓ Launch script created"
echo "✓ Symlink: /usr/local/bin/claude → Claude.app"

# ============================================================
# CREATE USER DIRECTORIES
# ============================================================

echo "[7/9] Setting up user directories..."

# Create macOS-style directories (no symlinks!)
mkdir -p ~/Library/Application\ Support/Claude/{Projects,Conversations,"Claude Extensions","Claude Extensions Settings",claude-code-vm,vm_bundles,blob_storage}
mkdir -p ~/Library/Logs/Claude
mkdir -p ~/Library/Caches/Claude
mkdir -p ~/Library/Preferences

# Create configs
if [ ! -f ~/Library/Application\ Support/Claude/config.json ]; then
  cat > ~/Library/Application\ Support/Claude/config.json <<'CONFIGEOF'
{
  "scale": 0,
  "locale": "en-US",
  "userThemeMode": "system",
  "hasTrackedInitialActivation": false
}
CONFIGEOF
fi

if [ ! -f ~/Library/Application\ Support/Claude/claude_desktop_config.json ]; then
  cat > ~/Library/Application\ Support/Claude/claude_desktop_config.json <<'CONFIGEOF'
{
  "preferences": {
    "chromeExtensionEnabled": true
  }
}
CONFIGEOF
fi

# Set permissions
chmod 700 ~/Library/Application\ Support/Claude
chmod 700 ~/Library/Logs/Claude
chmod 700 ~/Library/Caches/Claude

echo "✓ User directories created"

# ============================================================
# CREATE DESKTOP ENTRY
# ============================================================

echo "[8/9] Creating desktop entry..."

mkdir -p ~/.local/share/applications

cat > ~/.local/share/applications/claude.desktop <<'DESKTOPEOF'
[Desktop Entry]
Type=Application
Name=Claude
Comment=AI assistant by Anthropic
Exec=/usr/local/bin/claude
Icon=/Applications/Claude.app/Contents/Resources/icon.icns
Terminal=false
Categories=Utility;Development;Chat;
Keywords=AI;assistant;chat;anthropic;
StartupWMClass=Claude
DESKTOPEOF

chmod +x ~/.local/share/applications/claude.desktop

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database ~/.local/share/applications 2>/dev/null || true
fi

echo "✓ Desktop entry created"

# ============================================================
# OPTIONAL: HYPRLAND WINDOW RULES
# ============================================================

HYPRLAND_CONFIG_DIR="$HOME/.config/hypr"
HYPRLAND_CONF="$HYPRLAND_CONFIG_DIR/hyprland.conf"
CLAUDE_HYPR_CONF="$SCRIPT_DIR/config/hyprland/claude.conf"

if [ -f "$CLAUDE_HYPR_CONF" ] && [ -d "$HYPRLAND_CONFIG_DIR" ]; then
  echo ""
  echo "[Optional] Hyprland detected"

  # Copy config to hypr directory
  DEST_CONF="$HYPRLAND_CONFIG_DIR/claude.conf"
  cp "$CLAUDE_HYPR_CONF" "$DEST_CONF"
  echo "  ✓ Copied claude.conf to $HYPRLAND_CONFIG_DIR"

  # Check if already sourced
  if grep -q "source.*claude.conf" "$HYPRLAND_CONF" 2>/dev/null; then
    echo "  ✓ claude.conf already sourced in hyprland.conf"
  else
    echo ""
    echo "  To enable Claude window rules, add to $HYPRLAND_CONF:"
    echo "    source = ~/.config/hypr/claude.conf"
    echo ""
  fi
fi

# ============================================================
# CLEANUP
# ============================================================

echo "[9/9] Cleaning up..."

# Only remove extraction if we created it
if [ -n "$EXTRACT_DIR" ] && [ -d "$EXTRACT_DIR" ]; then
  rm -rf "$EXTRACT_DIR"
  echo "✓ Temporary files removed"
fi

# ============================================================
# SUMMARY
# ============================================================

echo ""
echo "=========================================="
echo "✓ Installation Complete!"
echo "=========================================="
echo ""
echo "Structure created:"
echo "  App:      /Applications/Claude.app/"
echo "  Data:     ~/Library/Application Support/Claude/"
echo "  Logs:     ~/Library/Logs/Claude/"
echo "  Cache:    ~/Library/Caches/Claude/"
echo ""
echo "Launch Claude:"
echo "  Command:  claude"
echo "  Desktop:  Search for 'Claude' in app launcher"
echo ""
echo "Startup logs:"
echo "  ~/Library/Logs/Claude/startup.log"
echo ""
echo "Test with:  claude"
echo ""
