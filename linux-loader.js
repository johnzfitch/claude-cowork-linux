#!/usr/bin/env node
/**
 * linux-loader.js - Claude Linux compatibility layer v2.5
 *
 * CRITICAL ORDER OF OPERATIONS:
 * 0. TMPDIR fix + os.tmpdir() patch (fixes EXDEV cross-device rename)
 * 1. Platform spoofing (immediate - no delay, patches process.platform AND os.platform())
 * 2. Module interception (BEFORE electron require!)
 * 3. Electron patching (safe now that interception is active)
 * 4. Load application
 *
 * Fixes in v2.5:
 * - os.tmpdir() patched directly (not just env var)
 * - Platform spoofing is immediate (not waiting for app start)
 * - os.platform() and os.arch() also spoofed
 * - VM bundle marker files created with non-empty content
 */

// ============================================================
// 0. TMPDIR FIX - MUST BE ABSOLUTELY FIRST
// ============================================================
// Fix EXDEV error: App downloads VM to /tmp (tmpfs) then tries to
// rename() to ~/.config/Claude/ (disk). rename() can't cross filesystems.
// We fix this by:
// 1. Setting TMPDIR env vars
// 2. Patching os.tmpdir() directly
// 3. Creating marker files so download is skipped
const os = require('os');
const path = require('path');
const fs = require('fs');

const vmBundleDir = path.join(os.homedir(), '.config/Claude/vm_bundles');
const vmTmpDir = path.join(vmBundleDir, 'tmp');
const claudeVmBundle = path.join(vmBundleDir, 'claudevm.bundle');

try {
  // Create temp dir on same filesystem as target
  fs.mkdirSync(vmTmpDir, { recursive: true, mode: 0o700 });

  // Set env vars for any code that reads them directly
  process.env.TMPDIR = vmTmpDir;
  process.env.TMP = vmTmpDir;
  process.env.TEMP = vmTmpDir;

  // CRITICAL: Patch os.tmpdir() directly - it may have cached /tmp already
  const originalTmpdir = os.tmpdir;
  os.tmpdir = function() {
    return vmTmpDir;
  };

  // Pre-create VM bundle to skip download entirely (we run native, no VM needed)
  // This must look like a complete, valid bundle so the app skips downloading
  fs.mkdirSync(claudeVmBundle, { recursive: true, mode: 0o755 });

  // Create all marker files the app might check
  const markers = [
    'bundle_complete',
    'rootfs.img',          // Main filesystem image
    'rootfs.img.zst',      // Compressed version
    'vmlinux',             // Kernel
    'config.json',         // VM configuration
  ];
  for (const m of markers) {
    const p = path.join(claudeVmBundle, m);
    if (!fs.existsSync(p)) {
      // Create non-empty files (some checks might verify size > 0)
      if (m === 'config.json') {
        fs.writeFileSync(p, '{"version":"linux-native","skip_vm":true}', { mode: 0o644 });
      } else {
        fs.writeFileSync(p, 'linux-native-placeholder', { mode: 0o644 });
      }
    }
  }

  // Version file with a high version to prevent "update needed" checks
  const vp = path.join(claudeVmBundle, 'version');
  fs.writeFileSync(vp, '999.0.0-linux-native', { mode: 0o644 });

  console.log('[TMPDIR] Fixed: ' + vmTmpDir);
  console.log('[TMPDIR] os.tmpdir() patched');
  console.log('[VM_BUNDLE] Ready: ' + claudeVmBundle);
} catch (e) {
  console.error('[TMPDIR] Setup failed:', e.message);
}

// ============================================================
// 0b. PATCH fs.rename TO HANDLE EXDEV (cross-device) ERRORS
// ============================================================
// Native code still uses /tmp, so patch fs.rename to copy+delete on EXDEV

const originalRename = fs.rename;
const originalRenameSync = fs.renameSync;

fs.rename = function(oldPath, newPath, callback) {
  originalRename(oldPath, newPath, (err) => {
    if (err && err.code === 'EXDEV') {
      console.log('[fs.rename] EXDEV detected, using copy+delete for:', oldPath);
      // Copy then delete
      const readStream = fs.createReadStream(oldPath);
      const writeStream = fs.createWriteStream(newPath);
      readStream.on('error', callback);
      writeStream.on('error', callback);
      writeStream.on('close', () => {
        fs.unlink(oldPath, (unlinkErr) => {
          if (unlinkErr) console.warn('[fs.rename] Failed to delete source:', unlinkErr.message);
          callback(null);
        });
      });
      readStream.pipe(writeStream);
    } else {
      callback(err);
    }
  });
};

fs.renameSync = function(oldPath, newPath) {
  try {
    return originalRenameSync(oldPath, newPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      console.log('[fs.renameSync] EXDEV detected, using copy+delete for:', oldPath);
      fs.copyFileSync(oldPath, newPath);
      fs.unlinkSync(oldPath);
      return;
    }
    throw err;
  }
};

console.log('[fs.rename] Patched to handle EXDEV errors');

const Module = require('module');

console.log('='.repeat(60));
console.log('Claude Linux Loader v2.5 (TMPDIR + platform fixes)');
console.log('='.repeat(60));

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;
const RESOURCES_DIR = __dirname;
const STUB_PATH = path.join(RESOURCES_DIR, 'stubs', '@ant', 'claude-swift', 'js', 'index.js');

// ============================================================
// 1. PLATFORM/ARCH/VERSION SPOOFING (must be first!)
// ============================================================
// Spoof for app code only - Electron and Node internals need real platform

function isSystemCall(stack) {
  return stack.includes('node:internal') ||
         stack.includes('internal/modules') ||
         stack.includes('node:electron') ||
         stack.includes('electron/js2c') ||
         stack.includes('electron.asar') ||
         stack.includes('linux-loader.js') ||
         stack.includes('frame-fix-wrapper');
}

Object.defineProperty(process, 'platform', {
  get() {
    const stack = new Error().stack || '';
    if (isSystemCall(stack)) {
      return REAL_PLATFORM;
    }
    return 'darwin';
  },
  configurable: true
});

Object.defineProperty(process, 'arch', {
  get() {
    const stack = new Error().stack || '';
    if (isSystemCall(stack)) {
      return REAL_ARCH;
    }
    return 'arm64';
  },
  configurable: true
});

// Also spoof os.platform() and os.arch()
const originalOsPlatform = os.platform;
const originalOsArch = os.arch;

os.platform = function() {
  const stack = new Error().stack || '';
  if (isSystemCall(stack)) {
    return originalOsPlatform.call(os);
  }
  return 'darwin';
};

os.arch = function() {
  const stack = new Error().stack || '';
  if (isSystemCall(stack)) {
    return originalOsArch.call(os);
  }
  return 'arm64';
};

const originalGetSystemVersion = process.getSystemVersion;
process.getSystemVersion = function() {
  return '14.0.0'; // Always return macOS version
};

console.log('[Platform] Spoofing: darwin/arm64 macOS 14.0 (immediate)');

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
// 5. IPC HANDLERS FOR COWORK/YUKONSILVER
// ============================================================

// The app uses eipc pattern: $eipc_message$_<UUID>_$_<namespace>_$_<handler>
const EIPC_UUID = 'c42e5915-d1f8-48a1-a373-fe793971fdbd';
const EIPC_NAMESPACES = ['claude.web', 'claude.hybrid', 'claude.settings'];

// Track registered handlers to avoid duplicates
const registeredHandlers = new Set();

/**
 * Register an eipc-style handler for all namespaces
 * @param {string} handlerName - e.g., 'AppFeatures_$_getCoworkFeatureState'
 * @param {function} handler - The handler function
 * @param {boolean} isSync - Whether to use ipcMain.on (sync) vs ipcMain.handle (async)
 */
function registerEipcHandler(handlerName, handler, isSync = false) {
  for (const ns of EIPC_NAMESPACES) {
    const channel = `$eipc_message$_${EIPC_UUID}_$_${ns}_$_${handlerName}`;
    if (registeredHandlers.has(channel)) continue;

    try {
      if (isSync) {
        ipcMain.on(channel, (event, ...args) => {
          try {
            event.returnValue = handler(event, ...args);
          } catch (e) {
            console.error(`[IPC] Sync handler error ${handlerName}:`, e.message);
            event.returnValue = { result: null, error: e.message };
          }
        });
      } else {
        ipcMain.handle(channel, handler);
      }
      registeredHandlers.add(channel);
    } catch (e) {
      if (!e.message.includes('already registered')) {
        console.error(`[IPC] Failed to register ${handlerName}:`, e.message);
      }
    }
  }
  console.log(`[IPC] Registered: ${handlerName} (${isSync ? 'sync' : 'async'})`);
}

// ===== AppFeatures - CRITICAL for Cowork UI visibility =====
registerEipcHandler('AppFeatures_$_getSupportedFeatures', async () => ({
  localAgentMode: true,
  cowork: true,
  claudeCode: true,
  extensions: true,
  mcp: true,
  globalShortcuts: true,
  menuBar: true,
  startupOnLogin: true,
  autoUpdate: true,
  filePickers: true,
}));

registerEipcHandler('AppFeatures_$_getCoworkFeatureState', async () => ({
  enabled: true,
  status: 'supported',
  reason: null,
}));

registerEipcHandler('AppFeatures_$_getYukonSilverStatus', async () => ({
  status: 'supported',
}));

registerEipcHandler('AppFeatures_$_getFeatureFlags', async () => ({
  yukonSilver: true,
  cowork: true,
  localAgentMode: true,
}));

// ===== ClaudeVM - VM lifecycle handlers =====
registerEipcHandler('ClaudeVM_$_download', async () => ({
  status: 'ready',
  downloaded: true,
  progress: 100,
}));

registerEipcHandler('ClaudeVM_$_getDownloadStatus', async () => ({
  status: 'ready',
  downloaded: true,
  progress: 100,
  version: 'linux-native-1.0.0',
}));

registerEipcHandler('ClaudeVM_$_getRunningStatus', async () => ({
  running: true,
  connected: true,
  status: 'connected',
}));

registerEipcHandler('ClaudeVM_$_start', async () => ({
  started: true,
  status: 'running',
}));

registerEipcHandler('ClaudeVM_$_stop', async () => ({
  stopped: true,
}));

registerEipcHandler('ClaudeVM_$_getSupportStatus', async () => ({
  status: 'supported',
}));

// ===== LocalAgentMode / Cowork sessions =====
registerEipcHandler('LocalAgentModeSessions_$_getAll', async () => []);

registerEipcHandler('LocalAgentModeSessions_$_create', async (event, sessionData) => ({
  id: `session-${Date.now()}`,
  ...sessionData,
}));

registerEipcHandler('LocalAgentModeSessions_$_get', async (event, sessionId) => ({
  id: sessionId,
  status: 'active',
}));

// ===== AutoUpdater - prevent update checks =====
registerEipcHandler('AutoUpdater_$_updaterState_$store$_getState', async () => ({
  updateAvailable: false,
  updateDownloaded: false,
  checking: false,
  error: null,
  version: null,
  progress: null,
}));

registerEipcHandler('AutoUpdater_$_updaterState_$store$_update', async () => ({
  success: true,
}));

// ===== DesktopIntl - SYNC handler =====
registerEipcHandler('DesktopIntl_$_getInitialLocale', () => {
  const locale = process.env.LANG?.split('.')[0]?.replace('_', '-') || 'en-US';
  return {
    result: {
      locale: locale,
      messages: {},
    },
    error: null,
  };
}, true); // SYNC

registerEipcHandler('DesktopIntl_$_requestLocaleChange', async (event, locale) => ({
  success: true,
}));

// ===== WindowControl =====
registerEipcHandler('WindowControl_$_setThemeMode', async (event, mode) => ({
  success: true,
}));

// ===== LocalPlugins =====
registerEipcHandler('LocalPlugins_$_getPlugins', async () => []);

// ===== Account =====
registerEipcHandler('Account_$_setAccountDetails', async () => ({
  success: true,
}));

// ===== QuickEntry =====
registerEipcHandler('QuickEntry_$_setRecentChats', async () => ({
  success: true,
}));

// ===== Simple channel handlers (no eipc prefix) =====
try {
  ipcMain.handle('list-mcp-servers', async () => {
    const configPath = path.join(os.homedir(), '.config/Claude/claude_desktop_config.json');
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return config.mcpServers || {};
      }
    } catch (e) {
      console.error('[IPC] Error reading MCP config:', e.message);
    }
    return {};
  });
  console.log('[IPC] Registered: list-mcp-servers');
} catch (e) { /* ignore duplicates */ }

try {
  ipcMain.handle('connect-to-mcp-server', async (event, serverName) => {
    console.log('[IPC] connect-to-mcp-server:', serverName);
    return { connected: false, error: 'Not implemented in Linux stub' };
  });
  console.log('[IPC] Registered: connect-to-mcp-server');
} catch (e) { /* ignore duplicates */ }

console.log('[IPC] All Cowork handlers registered');

// ============================================================
// 6. ERROR HANDLING
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
// 7. LOAD APPLICATION
// ============================================================

console.log('='.repeat(60));
console.log('Loading Claude application...');
console.log('='.repeat(60));
console.log('');

// Load via frame-fix-entry.js to get frame-fix-wrapper.js Cowork support
require('./linux-app-extracted/frame-fix-entry.js');
