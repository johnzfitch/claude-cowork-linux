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

process.getSystemVersion = function() {
  return '14.0.0'; // Always return macOS version for compatibility
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

Module._load = function(request, _parent, _isMain) {
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
// 3.5. USER-AGENT SPOOFING - Fixes "Active Sessions" platform detection
// ============================================================
// Electron builds User-Agent with OS info. We need to override to show macOS.
// This prevents the server from detecting "Linux" in the User-Agent header.

const { app, session } = electron;
let pendingClaudeUrls = [];

function parseClaudeUrlArg(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.startsWith('claude://') ? trimmed : null;
}

function dispatchClaudeUrl(url) {
  try {
    app.emit('open-url', { preventDefault() {} }, url);
    console.log('[Protocol] Forwarded URL to open-url:', url);
  } catch (e) {
    console.error('[Protocol] Failed to forward URL:', e.message);
  }
}

app.on('second-instance', (_event, argv) => {
  const candidates = Array.isArray(argv) ? argv : [];
  for (const arg of candidates) {
    const url = parseClaudeUrlArg(arg);
    if (!url) continue;
    pendingClaudeUrls.push(url);
    if (app.isReady()) dispatchClaudeUrl(url);
  }
});

// Set app-wide User-Agent fallback (used when session UA is not set)
// Format: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/...
const macOSUserAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`;

if (app.userAgentFallback) {
  const origUA = app.userAgentFallback;
  // Replace Linux/X11 with macOS in the User-Agent
  app.userAgentFallback = origUA
    .replace(/\(X11; Linux [^)]+\)/, '(Macintosh; Intel Mac OS X 10_15_7)')
    .replace(/Linux/, 'Mac OS X');
  console.log('[UserAgent] Spoofed app.userAgentFallback');
}

// Also set on the default session once app is ready
app.whenReady().then(() => {
  try {
    const defaultSession = session.defaultSession;
    if (defaultSession) {
      const currentUA = defaultSession.getUserAgent();
      const spoofedUA = currentUA
        .replace(/\(X11; Linux [^)]+\)/, '(Macintosh; Intel Mac OS X 10_15_7)')
        .replace(/Linux/, 'Mac OS X');
      defaultSession.setUserAgent(spoofedUA);
      console.log('[UserAgent] Spoofed session User-Agent');

      // Fix CSP: add a-api.anthropic.com to connect-src so analytics doesn't throw errors
      defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = { ...details.responseHeaders };
        const cspKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-security-policy');
        if (cspKey && Array.isArray(headers[cspKey])) {
          headers[cspKey] = headers[cspKey].map(v =>
            v.replace(
              /connect-src\s+([^;]+)/,
              'connect-src $1 https://a-api.anthropic.com'
            )
          );
        }
        callback({ responseHeaders: headers });
      });
      console.log('[CSP] Patched connect-src to allow a-api.anthropic.com');

      if (process.env.CLAUDE_CLEAR_CACHE_ON_CLOSE === '1') {
        app.on('before-quit', async () => {
          try {
            await defaultSession.clearCache();
            await defaultSession.clearStorageData({
              storages: ['appcache', 'serviceworkers', 'cachestorage'],
            });
            console.log('[Cache] Cleared session cache/storage on quit');
          } catch (e) {
            console.error('[Cache] Failed clearing cache on quit:', e.message);
          }
        });
      }
    }
    for (const url of pendingClaudeUrls) dispatchClaudeUrl(url);
    pendingClaudeUrls = [];
  } catch (e) {
    console.error('[UserAgent] Failed to spoof session UA:', e.message);
  }
});

// ============================================================
// 4. IPC DEBUGGING
// ============================================================

const { ipcMain, dialog, BrowserWindow } = electron;

// ============================================================
// 4b. LINUX: CONFIRM-BEFORE-QUIT ON WINDOW CLOSE
// ============================================================
// On macOS, closing the window hides it to the dock/tray. On Linux
// (especially KDE Plasma Wayland) the tray restore doesn't work, so
// we intercept the close event and ask the user whether they really
// want to quit. Minimize stays as normal minimize.
{
  // Load button labels from the app's own i18n JSON files.
  // Keys: dKX0bpR+a2 = "Quit", 0GT0SIETlE = "Cancel"
  // Title/message have no existing i18n key, so we use a small
  // lookup that mirrors the app's supported locales.
  const _quitMessages = {
    de: { title: 'Claude beenden', message: 'Möchten Sie Claude wirklich beenden?' },
    en: { title: 'Quit Claude', message: 'Do you really want to quit Claude?' },
    fr: { title: 'Quitter Claude', message: 'Voulez-vous vraiment quitter Claude ?' },
    es: { title: 'Salir de Claude', message: '¿Realmente quiere salir de Claude?' },
    it: { title: 'Esci da Claude', message: 'Vuoi davvero uscire da Claude?' },
    pt: { title: 'Sair do Claude', message: 'Deseja realmente sair do Claude?' },
    ja: { title: 'Claude を終了', message: 'Claude を本当に終了しますか？' },
    ko: { title: 'Claude 종료', message: 'Claude를 정말 종료하시겠습니까?' },
    hi: { title: 'Claude बंद करें', message: 'क्या आप वाकई Claude बंद करना चाहते हैं?' },
    id: { title: 'Keluar dari Claude', message: 'Apakah Anda yakin ingin keluar dari Claude?' },
  };
  let _i18nCache = null;
  function _getCloseStrings() {
    if (!_i18nCache) {
      const locale = app.getLocale() || process.env.LANG || 'en-US';
      const lang = locale.split(/[-_]/)[0].toLowerCase();

      const candidates = [locale.replace('_', '-')];
      const variants = {
        de: 'de-DE', en: 'en-US', fr: 'fr-FR', es: 'es-ES', it: 'it-IT',
        pt: 'pt-BR', ja: 'ja-JP', ko: 'ko-KR', hi: 'hi-IN', id: 'id-ID',
      };
      if (variants[lang]) candidates.push(variants[lang]);
      candidates.push('en-US');

      let strings = null;
      for (const tag of candidates) {
        try {
          const i18nPath = path.join(RESOURCES_DIR, 'resources', 'i18n', tag + '.json');
          strings = JSON.parse(fs.readFileSync(i18nPath, 'utf8'));
          break;
        } catch (_) { /* try next */ }
      }

      const msg = _quitMessages[lang] || _quitMessages.en;
      _i18nCache = {
        quit: (strings && strings['dKX0bpR+a2']) || 'Quit',
        cancel: (strings && strings['0GT0SIETlE']) || 'Cancel',
        title: msg.title,
        message: msg.message,
      };
    }
    return _i18nCache;
  }

  let _quitting = false;
  app.on('before-quit', () => { _quitting = true; });

  const _origEmit = BrowserWindow.prototype.emit;
  BrowserWindow.prototype.emit = function(event, ev, ...args) {
    if (event === 'close' && !_quitting && !this.isDestroyed()) {
      const [w, h] = this.getSize();
      if (w >= 400 && h >= 300) {
        ev.preventDefault();
        const s = _getCloseStrings();
        dialog.showMessageBox(this, {
          type: 'question',
          buttons: [s.quit, s.cancel],
          defaultId: 1,
          cancelId: 1,
          title: s.title,
          message: s.message,
        }).then(({ response }) => {
          if (response === 0) {
            _quitting = true;
            app.quit();
          }
        });
        return false;
      }
    }
    return _origEmit.call(this, event, ev, ...args);
  };

  console.log('[Linux] Close confirmation dialog enabled');
}

// Log ALL IPC handle registrations to find cowork-related ones
// ============================================================
// 5. IPC HANDLERS FOR COWORK/YUKONSILVER
// ============================================================

// The app uses eipc pattern: $eipc_message$_<UUID>_$_<namespace>_$_<handler>
// UUIDs change with each asar build. We intercept ipcMain.handle to auto-detect
// any UUID the asar uses and register our handlers for it, while blocking the
// asar from registering its own handlers for names we own.
const EIPC_NAMESPACES = ['claude.web', 'claude.hybrid', 'claude.settings'];
const EIPC_UUID_RE = /^\$eipc_message\$_([0-9a-f-]{36})_\$_[^_$]+_\$_(.+)$/;

// Map of handlerName -> { handler, isSync } for all our owned handlers
const ownedHandlers = new Map();
// Set of fully-qualified channels we've registered
const registeredChannels = new Set();
// UUIDs we've seen from the asar
const knownUUIDs = new Set();

function _registerChannelHandler(channel, handlerName, isSync) {
  if (registeredChannels.has(channel)) return;
  const { handler } = ownedHandlers.get(handlerName);
  try {
    if (isSync) {
      origOn(channel, (event, ...args) => {
        try {
          event.returnValue = handler(event, ...args);
        } catch (e) {
          console.error(`[IPC] Sync handler error ${handlerName}:`, e.message);
          event.returnValue = { result: null, error: e.message };
        }
      });
    } else {
      origHandle(channel, async (event, ...args) => {
        try {
          return await handler(event, ...args);
        } catch (e) {
          console.error(`[IPC] Handler error ${handlerName}:`, e.message);
          throw e;
        }
      });
    }
    registeredChannels.add(channel);
  } catch (e) {
    if (!e.message.includes('already registered')) {
      console.error(`[IPC] Failed to register ${handlerName}:`, e.message);
    }
  }
}

function _registerHandlerForUUID(uuid, handlerName) {
  const { isSync } = ownedHandlers.get(handlerName);
  for (const ns of EIPC_NAMESPACES) {
    _registerChannelHandler(`$eipc_message$_${uuid}_$_${ns}_$_${handlerName}`, handlerName, isSync);
  }
}

/**
 * Register an eipc-style handler for all known UUIDs and namespaces.
 * Also blocks the asar from registering its own handler for this name.
 */
function registerEipcHandler(handlerName, handler, isSync = false) {
  ownedHandlers.set(handlerName, { handler, isSync });
  for (const uuid of knownUUIDs) {
    _registerHandlerForUUID(uuid, handlerName);
  }
  console.log(`[IPC] Registered: ${handlerName} (${isSync ? 'sync' : 'async'})`);
}

const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function(channel, handler) {
  const m = channel.match(EIPC_UUID_RE);
  if (m) {
    const [, uuid, handlerName] = m;
    // Auto-register all our handlers for newly seen UUIDs
    if (!knownUUIDs.has(uuid)) {
      knownUUIDs.add(uuid);
      console.log(`[IPC] Discovered new eipc UUID: ${uuid}`);
      for (const name of ownedHandlers.keys()) {
        _registerHandlerForUUID(uuid, name);
      }
    }
    // Block asar from registering handlers for names we own
    if (ownedHandlers.has(handlerName)) {
      return;
    }
  }
  if (channel.includes('VM') || channel.includes('Cowork')) {
    console.log('[IPC] Handler registered:', channel);
  }
  return origHandle(channel, handler);
};

const origOn = ipcMain.on.bind(ipcMain);
ipcMain.on = function(channel, handler) {
  if (channel.includes('VM') || channel.includes('Cowork')) {
    console.log('[IPC] Listener registered:', channel);
  }
  return origOn(channel, handler);
};

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

registerEipcHandler('ClaudeVM_$_setYukonSilverConfig', async () => {
  console.log('[IPC] ClaudeVM_$_setYukonSilverConfig called (no-op)');
  return { success: true };
});

registerEipcHandler('ClaudeVM_$_deleteAndReinstall', async () => {
  console.log('[IPC] ClaudeVM_$_deleteAndReinstall called (no-op)');
  return { success: true };
});

// ===== FileSystem - File browsing and I/O =====
registerEipcHandler('FileSystem_$_browseFolder', async () => {
  try {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  } catch (e) {
    console.error('[IPC] FileSystem_$_browseFolder error:', e.message);
    return null;
  }
});

registerEipcHandler('FileSystem_$_getSystemPath', async (_event, pathName) => {
  try {
    const pathMap = {
      home: app.getPath('home'),
      desktop: app.getPath('desktop'),
      downloads: app.getPath('downloads'),
      documents: app.getPath('documents'),
      temp: app.getPath('temp'),
      appdata: app.getPath('appData'),
      userdata: app.getPath('userData'),
    };
    return pathMap[pathName] || app.getPath('home');
  } catch (e) {
    console.error('[IPC] FileSystem_$_getSystemPath error:', e.message);
    return app.getPath('home');
  }
});

registerEipcHandler('FileSystem_$_readFile', async (_event, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error('[IPC] FileSystem_$_readFile error:', e.message);
    throw e;
  }
});

registerEipcHandler('FileSystem_$_writeFile', async (_event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content);
    return { success: true };
  } catch (e) {
    console.error('[IPC] FileSystem_$_writeFile error:', e.message);
    throw e;
  }
});

registerEipcHandler('FileSystem_$_exists', async (_event, filePath) => {
  return fs.existsSync(filePath);
});

registerEipcHandler('FileSystem_$_whichApplication', async () => {
  // Stub: return null (not supported on Linux without additional logic)
  return null;
});

/**
 * Read local file for Cowork sessions.
 * Called by webapp to load files from session mount points for preview.
 * Returns: { content: string, mimeType?: string, encoding?: 'base64'|'utf8' }
 *
 * SECURITY: Path is validated against allowed base dirs (session mounts + asar
 * session storage) after symlink resolution to prevent arbitrary file read.
 */
const MAX_PREVIEW_SIZE = 10 * 1024 * 1024; // 10 MB

// Lazy — constants are defined later in module scope
let _allowedReadBases;
function getAllowedReadBases() {
  if (!_allowedReadBases) {
    _allowedReadBases = [
      IPC_HANDLER_STATE_DIR, // ~/Library/Application Support/Claude/LocalAgentModeSessions
      LOCAL_AGENT_STATE_DIR, // ~/.config/Claude/LocalAgentModeSessions
      ASAR_SESSIONS_BASE,    // ~/.config/Claude/local-agent-mode-sessions
      path.join(os.homedir(), '.local', 'share', 'claude-cowork'), // legacy session dir
    ];
  }
  return _allowedReadBases;
}

function isReadPathAllowed(resolvedPath) {
  return getAllowedReadBases().some(base => {
    const normalBase = path.resolve(base) + path.sep;
    return resolvedPath === path.resolve(base) || resolvedPath.startsWith(normalBase);
  });
}

registerEipcHandler('FileSystem_$_readLocalFile', async (_event, filePath) => {
  console.log('[IPC] FileSystem_$_readLocalFile:', filePath);
  try {
    // Resolve symlinks to get the real path
    let resolvedPath;
    try {
      resolvedPath = fs.realpathSync(filePath);
    } catch (_) {
      resolvedPath = path.resolve(filePath);
    }

    // SECURITY: Reject paths outside allowed session directories
    if (!isReadPathAllowed(resolvedPath)) {
      console.error('[IPC] FileSystem_$_readLocalFile: path outside allowed dirs:', resolvedPath);
      throw new Error('Access denied: path outside session directories');
    }

    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      console.error('[IPC] FileSystem_$_readLocalFile: file not found:', resolvedPath);
      throw new Error(`File not found: ${filePath}`);
    }

    const stats = fs.statSync(resolvedPath);

    // Check if it's a directory
    if (stats.isDirectory()) {
      const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
      const listing = entries.map(e => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
      }));
      return {
        content: JSON.stringify(listing, null, 2),
        mimeType: 'application/json',
        encoding: 'utf8',
        isDirectory: true,
      };
    }

    // Reject files over size cap
    if (stats.size > MAX_PREVIEW_SIZE) {
      throw new Error(`File too large for preview (${(stats.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_PREVIEW_SIZE / 1024 / 1024} MB)`);
    }

    // Determine if file is text by extension or basename
    const ext = path.extname(resolvedPath).toLowerCase();
    const basename = path.basename(resolvedPath).toLowerCase();
    const textExtensions = new Set([
      '.txt', '.md', '.json', '.js', '.ts', '.jsx', '.tsx', '.html', '.css',
      '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
      '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf', '.sh', '.bash',
      '.zsh', '.fish', '.sql', '.graphql', '.log', '.csv', '.env',
    ]);
    const textBasenames = new Set([
      'dockerfile', 'makefile', 'cmakelists.txt', 'gemfile', 'rakefile',
      'procfile', '.gitignore', '.gitattributes', '.editorconfig',
      '.dockerignore', '.eslintrc', '.prettierrc', '.babelrc',
    ]);
    const isKnownText = textExtensions.has(ext) || textBasenames.has(basename);

    // Read file content
    const content = fs.readFileSync(resolvedPath);

    // Check for NUL bytes to detect binary (only in first 8KB for perf)
    const sampleLen = Math.min(content.length, 8192);
    let hasNul = false;
    for (let i = 0; i < sampleLen; i++) {
      if (content[i] === 0) { hasNul = true; break; }
    }
    const isBinary = hasNul && !isKnownText;

    // Determine MIME type
    const mimeTypes = {
      '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
      '.js': 'text/javascript', '.ts': 'text/typescript', '.html': 'text/html',
      '.css': 'text/css', '.py': 'text/x-python', '.go': 'text/x-go',
      '.rs': 'text/x-rust', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
    };
    const mimeType = mimeTypes[ext] || (isBinary ? 'application/octet-stream' : 'text/plain');

    if (isBinary) {
      return {
        content: content.toString('base64'),
        mimeType,
        encoding: 'base64',
        size: stats.size,
      };
    } else {
      return {
        content: content.toString('utf8'),
        mimeType,
        encoding: 'utf8',
        size: stats.size,
      };
    }
  } catch (e) {
    console.error('[IPC] FileSystem_$_readLocalFile error:', e.message);
    throw e;
  }
});

// ===== AppConfig - Application configuration =====
registerEipcHandler('AppConfig_$_getAppConfig', async () => ({
  claudeAiUrl: 'https://claude.ai',
  isSwiftEnabled: true,
  secureVmFeaturesEnabled: true,
  coworkEnabled: true,
  localAgentModeEnabled: true,
}));

registerEipcHandler('AppConfig_$_setAppFeature', async (_event, featureName, value) => {
  console.log(`[IPC] AppConfig_$_setAppFeature: ${featureName} = ${value}`);
  return { success: true };
});

registerEipcHandler('AppConfig_$_setIsUsingBuiltInNodeForMcp', async (_event, value) => {
  console.log(`[IPC] AppConfig_$_setIsUsingBuiltInNodeForMcp: ${value}`);
  return { success: true };
});

registerEipcHandler('AppConfig_$_setIsDxtAutoUpdatesEnabled', async (_event, value) => {
  console.log(`[IPC] AppConfig_$_setIsDxtAutoUpdatesEnabled: ${value}`);
  return { success: true };
});

// ===== DesktopInfo - System information =====
registerEipcHandler('DesktopInfo_$_getSystemInfo', async () => ({
  platform: 'darwin',
  arch: 'arm64',
  version: '14.0.0',
  isLinux: false,
  isMac: true,
  isWindows: false,
}));

// ===== ClaudeCode - Claude Code integration =====
registerEipcHandler('ClaudeCode_$_prepare', async () => ({
  ready: true,
}));

registerEipcHandler('ClaudeCode_$_getStatus', async () => ({
  ready: true,
  running: true,
  connected: true,
}));

// CustomPlugins: read plugin data directly from CLI rather than spawning via VM
registerEipcHandler('CustomPlugins_$_listMarketplaces', async () => []);
registerEipcHandler('CustomPlugins_$_listAvailablePlugins', async () => {
  const { execFile } = require('child_process');
  const claudeBin = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local/bin/claude');
  return new Promise((resolve) => {
    execFile(claudeBin, ['plugin', 'list', '--available', '--json'], { timeout: 30000 }, (err, stdout) => {
      if (err || !stdout) {
        console.log('[IPC] CustomPlugins listAvailablePlugins: CLI error, returning empty list');
        return resolve([]);
      }
      try {
        const { available = [], installed = [] } = JSON.parse(stdout);
        const installedIds = new Set(installed.map(p => p.id));
        const plugins = available.map(p => ({
          id: p.pluginId,
          name: p.name,
          description: p.description,
          marketplaceName: p.marketplaceName,
          isInstalled: installedIds.has(p.pluginId),
        }));
        resolve(plugins);
      } catch (e) {
        console.log('[IPC] CustomPlugins listAvailablePlugins: parse error:', e.message);
        resolve([]);
      }
    });
  });
});

// ===== BrowserNavigation - Navigation state =====
registerEipcHandler('BrowserNavigation_$_navigationState_$store$_getState', async () => ({
  canGoBack: false,
  canGoForward: false,
}));

registerEipcHandler('BrowserNavigation_$_navigationState_$store$_getStateSync', (_event) => ({
  result: { canGoBack: false, canGoForward: false },
  error: null,
}), true); // sync handler

registerEipcHandler('BrowserNavigation_$_reportNavigationState', async () => {
  return { success: true };
});

registerEipcHandler('BrowserNavigation_$_goBack', async () => {
  console.log('[IPC] BrowserNavigation_$_goBack called (no-op)');
});

registerEipcHandler('BrowserNavigation_$_goForward', async () => {
  console.log('[IPC] BrowserNavigation_$_goForward called (no-op)');
});

registerEipcHandler('BrowserNavigation_$_requestMainMenuPopup', async () => {
  console.log('[IPC] BrowserNavigation_$_requestMainMenuPopup called (no-op)');
});

// ===== AppPreferences - User preferences =====
registerEipcHandler('AppPreferences_$_getPreferences', async () => ({
  secureVmFeaturesEnabled: true,
  autoUpdate: true,
  theme: 'system',
}));

registerEipcHandler('AppPreferences_$_setPreference', async (_event, key, value) => {
  console.log(`[IPC] AppPreferences_$_setPreference: ${key} = ${value}`);
  return { success: true };
});

// ===== Startup - Login and menu bar settings =====
registerEipcHandler('Startup_$_isStartupOnLoginEnabled', async () => false);

registerEipcHandler('Startup_$_setStartupOnLoginEnabled', async (_event, enabled) => {
  console.log(`[IPC] Startup_$_setStartupOnLoginEnabled: ${enabled}`);
  return { success: true };
});

registerEipcHandler('Startup_$_isMenuBarEnabled', async () => false);

registerEipcHandler('Startup_$_setMenuBarEnabled', async (_event, enabled) => {
  console.log(`[IPC] Startup_$_setMenuBarEnabled: ${enabled}`);
  return { success: true };
});

// ===== WindowState - Window state queries =====
registerEipcHandler('WindowState_$_getFullscreen', async () => false);

// ===== WindowControl - Window manipulation =====
registerEipcHandler('WindowControl_$_resize', async (_event, width, height) => {
  try {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
      focusedWindow.setSize(width, height);
    }
  } catch (e) {
    console.error('[IPC] WindowControl_$_resize error:', e.message);
  }
});

registerEipcHandler('WindowControl_$_focus', async () => {
  try {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
      focusedWindow.focus();
    }
  } catch (e) {
    console.error('[IPC] WindowControl_$_focus error:', e.message);
  }
});

// ===== LocalSessions - Local session management =====
registerEipcHandler('LocalSessions_$_getAll', async () => []);

registerEipcHandler('LocalSessions_$_getGitInfo', async () => ({
  branches: [],
  currentBranch: null,
  remotes: [],
}));

// ===== LocalKBs - Local knowledge bases =====
registerEipcHandler('LocalKBs_$_list', async () => []);

// ===== LocalSessionEnvironment - Environment variables =====
const localEnvVars = { ...process.env };

registerEipcHandler('LocalSessionEnvironment_$_get', async () => ({ ...localEnvVars }));

registerEipcHandler('LocalSessionEnvironment_$_save', async (_event, envVars) => {
  Object.keys(localEnvVars).forEach(k => delete localEnvVars[k]);
  Object.assign(localEnvVars, envVars);
  console.log('[IPC] LocalSessionEnvironment_$_save: updated env vars');
  return { success: true };
});

// ===== AutoUpdater - Auto-update handlers =====
registerEipcHandler('AutoUpdater_$_restartToUpdate', async () => false);

registerEipcHandler('AutoUpdater_$_updaterState_$store$_getStateSync', (_event) => ({
  result: {
    status: 'idle',
    version: null,
    downloaded: false,
  },
  error: null,
}), true); // sync handler

// ===== LocalAgentMode / Cowork sessions =====
// Full session management with Claude Agent SDK bridge

const { CoworkSDKBridge } = require('./cowork/sdk_bridge');
const { emitLocalAgentEvent, addDiscoveredUUID, extractUUID } = require('./cowork/event_dispatch');

const sdkBridge = new CoworkSDKBridge();

// In-memory session state
const localAgentSessions = new Map();
const trustedFolders = new Set();
let focusedSessionId = null;

// State persistence
const LOCAL_AGENT_STATE_DIR = path.join(os.homedir(), '.config', 'Claude', 'LocalAgentModeSessions');
const LOCAL_AGENT_STATE_FILE = path.join(LOCAL_AGENT_STATE_DIR, 'sessions.json');
// ipc-handler-setup.js reads from the macOS-style path (~/Library/Application Support/Claude/...)
// We must also save there so sessions survive app restarts via the asar's hydration code.
const IPC_HANDLER_STATE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'LocalAgentModeSessions');
const IPC_HANDLER_STATE_FILE = path.join(IPC_HANDLER_STATE_DIR, 'sessions.json');
let stateSaveTimer = null;

// The asar's LocalSessionManager stores per-session data (including .claude/projects/)
// under ~/.config/Claude/local-agent-mode-sessions/<userId>/<orgId>/.
// We discover this path at startup so we can create .claude/projects/ where the asar expects it.
const ASAR_SESSIONS_BASE = path.join(os.homedir(), '.config', 'Claude', 'local-agent-mode-sessions');

/**
 * Discover the asar's session storage directory by scanning for UUID-named subdirectories.
 * Returns the <userId>/<orgId> dir, or null if not found.
 */
function discoverAsarSessionStorageDir() {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  try {
    if (!fs.existsSync(ASAR_SESSIONS_BASE)) return null;
    for (const userId of fs.readdirSync(ASAR_SESSIONS_BASE)) {
      if (!uuidRe.test(userId)) continue;
      const userDir = path.join(ASAR_SESSIONS_BASE, userId);
      if (!fs.statSync(userDir).isDirectory()) continue;
      for (const orgId of fs.readdirSync(userDir)) {
        if (!uuidRe.test(orgId)) continue;
        const orgDir = path.join(userDir, orgId);
        if (fs.statSync(orgDir).isDirectory()) return orgDir;
      }
    }
  } catch (_) { /* best effort */ }
  return null;
}

const asarSessionStorageDir = discoverAsarSessionStorageDir();
if (asarSessionStorageDir) {
  console.log('[Cowork] Discovered asar session storage dir:', asarSessionStorageDir);
}

/**
 * Get or create the .claude/projects directory for a session inside the asar's storage.
 * Returns the host path to the .claude dir, or null if the asar storage dir is unknown.
 */
function ensureAsarClaudeConfigDir(sessionId) {
  if (!asarSessionStorageDir) return null;
  const sessionDir = path.join(asarSessionStorageDir, sessionId);
  const claudeDir = path.join(sessionDir, '.claude');
  const projectsDir = path.join(claudeDir, 'projects');
  try {
    fs.mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
  } catch (_) { /* best effort */ }
  return claudeDir;
}

function generateUUID() {
  const crypto = require('crypto');
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.substring(0,8), hex.substring(8,12), hex.substring(12,16),
          hex.substring(16,20), hex.substring(20,32)].join('-');
}

function normalizeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return `local_${generateUUID()}`;
  }
  return sessionId.startsWith('local_') ? sessionId : `local_${sessionId}`;
}

/**
 * Derive conversationUuid from sessionId by stripping the `local_` prefix.
 * The webapp uses this as a path parameter in API calls, so it must be a valid UUID.
 */
function deriveConversationUuid(sessionId, fallback) {
  // If an explicit conversationUuid was provided and is a valid UUID, use it
  if (typeof fallback === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fallback)) {
    return fallback;
  }
  // Derive from sessionId by stripping the local_ prefix
  if (typeof sessionId === 'string' && sessionId.startsWith('local_')) {
    return sessionId.replace(/^local_/, '');
  }
  // Last resort: generate a new one
  return generateUUID();
}

function buildSession(info = {}) {
  const sessionId = normalizeSessionId(info.sessionId);
  const cwd = typeof info.sharedCwdPath === 'string' && info.sharedCwdPath.length > 0
    ? (path.isAbsolute(info.sharedCwdPath) ? info.sharedCwdPath : path.join(os.homedir(), info.sharedCwdPath))
    : process.cwd();
  const now = Date.now();

  return {
    sessionId,
    uuid: sessionId,
    conversationUuid: deriveConversationUuid(sessionId, info.conversationUuid),
    cwd,
    originCwd: cwd,
    userSelectedFolders: Array.isArray(info.userSelectedFolders) ? info.userSelectedFolders : [],
    userSelectedProjectUuids: Array.isArray(info.userSelectedProjectUuids) ? info.userSelectedProjectUuids : [],
    isRunning: true,
    model: typeof info.model === 'string' ? info.model : undefined,
    title: typeof info.title === 'string' ? info.title : undefined,
    createdAt: now,
    lastActivityAt: now,
    isArchived: false,
    homePath: os.homedir(),
    folderExists: true,
    initialMessage: typeof info.message === 'string' ? info.message : undefined,
    transcript: [],
    name: typeof info.title === 'string' ? info.title : 'New Task',
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
}

function getSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const direct = localAgentSessions.get(sessionId);
  if (direct) {
    // Ensure conversationUuid is always present and valid
    if (!direct.conversationUuid || direct.conversationUuid.startsWith('local_')) {
      direct.conversationUuid = deriveConversationUuid(direct.sessionId);
      direct.uuid = direct.sessionId;
    }
    return direct;
  }
  const normalized = sessionId.startsWith('local_') ? sessionId : `local_${sessionId}`;
  const session = localAgentSessions.get(normalized) || null;
  if (session && (!session.conversationUuid || session.conversationUuid.startsWith('local_'))) {
    session.conversationUuid = deriveConversationUuid(session.sessionId);
    session.uuid = session.sessionId;
  }
  return session;
}

function updateSession(sessionId, updates) {
  const session = getSession(sessionId);
  if (!session || !updates || typeof updates !== 'object') return session;
  Object.assign(session, updates);
  session.lastActivityAt = Date.now();
  session.updated_at = new Date().toISOString();
  return session;
}

function saveState(reason) {
  try {
    const sessions = Array.from(localAgentSessions.values()).map(s => {
      // Strip transcript from persisted state (too large)
      const { transcript, ...rest } = s;
      // Ensure conversationUuid is always derived correctly
      rest.uuid = rest.sessionId;
      rest.conversationUuid = deriveConversationUuid(rest.sessionId, rest.conversationUuid);
      return rest;
    });
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      sessions,
      trustedFolders: Array.from(trustedFolders),
      focusedSessionId,
    };
    const json = JSON.stringify(payload, null, 2);

    // Write to our primary state directory
    fs.mkdirSync(LOCAL_AGENT_STATE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(LOCAL_AGENT_STATE_FILE, json, { mode: 0o600 });

    // Also write to the path ipc-handler-setup.js reads from (~/Library/Application Support/...)
    // so sessions persist across app restarts via the asar's hydration code.
    try {
      fs.mkdirSync(IPC_HANDLER_STATE_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(IPC_HANDLER_STATE_FILE, json, { mode: 0o600 });
    } catch (_) { /* non-critical */ }

    console.log(`[Cowork] State saved (${reason})`);
  } catch (e) {
    console.error('[Cowork] Failed to save state:', e.message);
  }
}

function scheduleSave(reason) {
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => { stateSaveTimer = null; saveState(reason); }, 250);
}

function hydrateSessionPayload(payload) {
  const sessionList = Array.isArray(payload.sessions) ? payload.sessions
    : Array.isArray(payload) ? payload : [];
  for (const rawSession of sessionList) {
    if (!rawSession || typeof rawSession !== 'object') continue;
    const sessionId = normalizeSessionId(rawSession.sessionId || rawSession.uuid || rawSession.conversationUuid);
    if (localAgentSessions.has(sessionId)) continue; // don't overwrite existing

    // Ensure .claude/projects dir exists for the asar's transcript recovery
    const claudeConfigDir = ensureAsarClaudeConfigDir(sessionId);

    const session = {
      ...rawSession,
      sessionId,
      uuid: sessionId,
      conversationUuid: deriveConversationUuid(sessionId, rawSession.conversationUuid),
      isRunning: false, // Not running after restart
      transcript: [],
      ...(claudeConfigDir ? { claudeConfigDir } : {}),
    };
    localAgentSessions.set(sessionId, session);
  }
  if (Array.isArray(payload.trustedFolders)) {
    payload.trustedFolders.forEach(f => { if (typeof f === 'string' && f.length > 0) trustedFolders.add(f); });
  }
  if (typeof payload.focusedSessionId === 'string' && !focusedSessionId) {
    focusedSessionId = payload.focusedSessionId;
  }
}

function loadState() {
  // Check multiple candidate paths (our primary + ipc-handler-setup.js path + legacy)
  const candidates = [
    LOCAL_AGENT_STATE_FILE,
    IPC_HANDLER_STATE_FILE,
    path.join(os.homedir(), '.local', 'share', 'claude-cowork', 'LocalAgentModeSessions', 'sessions.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, 'utf8');
      const payload = JSON.parse(raw);
      hydrateSessionPayload(payload);
      console.log(`[Cowork] Loaded sessions from ${candidate}`);
    } catch (e) {
      // Skip this candidate, try next
    }
  }
  console.log(`[Cowork] Total sessions after load: ${localAgentSessions.size}`);
}

// Load persisted sessions on startup, then immediately flush corrected UUIDs
// back to disk so the asar's ipc-handler-setup.js reads clean data when it
// hydrates moments later (it reads the same sessions.json file independently).
loadState();
if (localAgentSessions.size > 0) {
  saveState('startup-uuid-fixup');
}

// Migrate existing transcripts to session-specific dirs where the asar expects them.
//
// Before this fix, CLAUDE_CONFIG_DIR contained a VM-internal path (/sessions/...)
// that the stub's symlink mapped to ~/.local/share/claude-cowork/sessions/<name>/mnt/.claude/
// instead of the asar-expected path at ~/.config/Claude/local-agent-mode-sessions/.../<sessionId>/.claude/.
// The asar's getTranscript() looks in the latter, so we scan both legacy locations:
//   1. ~/.claude/projects/ (global CLI config, pre-patch)
//   2. ~/.local/share/claude-cowork/sessions/<name>/mnt/.claude/projects/ (post-patch but pre-env-fix)
function migrateTranscriptsForExistingSessions() {
  if (!asarSessionStorageDir) return;

  // Build list of source directories to scan for transcripts
  const sourceProjectDirs = [];

  // Source 1: Global ~/.claude/projects/
  const globalClaudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (fs.existsSync(globalClaudeDir)) {
    sourceProjectDirs.push(globalClaudeDir);
  }

  // Source 2: Per-session dirs under ~/.local/share/claude-cowork/sessions/*/mnt/.claude/projects/
  const coworkSessionsBase = path.join(os.homedir(), '.local', 'share', 'claude-cowork', 'sessions');
  try {
    if (fs.existsSync(coworkSessionsBase)) {
      for (const sessionName of fs.readdirSync(coworkSessionsBase)) {
        const projectsDir = path.join(coworkSessionsBase, sessionName, 'mnt', '.claude', 'projects');
        if (fs.existsSync(projectsDir)) {
          sourceProjectDirs.push(projectsDir);
        }
      }
    }
  } catch (_) { /* best effort */ }

  if (sourceProjectDirs.length === 0) return;

  let migrated = 0;
  for (const session of localAgentSessions.values()) {
    const ccId = session.ccConversationId;
    if (!ccId) continue;

    const sessionProjectsDir = path.join(asarSessionStorageDir, session.sessionId, '.claude', 'projects');

    for (const srcProjectsDir of sourceProjectDirs) {
      try {
        for (const projectHash of fs.readdirSync(srcProjectsDir)) {
          const srcFile = path.join(srcProjectsDir, projectHash, `${ccId}.jsonl`);
          if (!fs.existsSync(srcFile)) continue;

          const destDir = path.join(sessionProjectsDir, projectHash);
          const destFile = path.join(destDir, `${ccId}.jsonl`);
          if (fs.existsSync(destFile)) continue; // already migrated

          try {
            fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
            // Use symlink (saves disk space, stays in sync) with hard link fallback
            try {
              fs.symlinkSync(srcFile, destFile);
            } catch (_) {
              fs.linkSync(srcFile, destFile);
            }
            migrated++;
            console.log(`[Cowork] Migrated transcript for ${session.sessionId}: ${ccId}.jsonl from ${srcProjectsDir}`);
          } catch (e) {
            console.warn(`[Cowork] Failed to migrate transcript ${ccId}.jsonl:`, e.message);
          }
        }
      } catch (_) { /* best effort */ }
    }
  }
  if (migrated > 0) {
    console.log(`[Cowork] Migrated ${migrated} transcript file(s) to session-specific dirs`);
  }
}
migrateTranscriptsForExistingSessions();

// --- Session lifecycle handlers ---

/**
 * Callback for when the SDK bridge captures a CLI conversation ID.
 * Persists it in the session so --resume works after app restart.
 */
function onConversationIdCaptured(sessionId, ccConversationId) {
  const session = getSession(sessionId);
  if (session) {
    session.ccConversationId = ccConversationId;
    scheduleSave('ccConversationId');
  }
}

/**
 * Ensure the SDK bridge has a live session state. For rehydrated sessions
 * (loaded from disk after restart), the bridge is empty and needs re-init.
 */
async function ensureBridgeSession(sessionId) {
  if (sdkBridge.hasSession(sessionId)) return;
  const session = getSession(sessionId);
  if (!session) return;
  console.log('[Cowork] Re-initializing bridge for rehydrated session:', sessionId);
  // Ensure the .claude/projects dir exists and pass the config dir path to the bridge
  if (!session.claudeConfigDir) {
    const claudeConfigDir = ensureAsarClaudeConfigDir(sessionId);
    if (claudeConfigDir) {
      session.claudeConfigDir = claudeConfigDir;
    }
  }
  await sdkBridge.startSession(sessionId, session, emitLocalAgentEvent, {
    onConversationId: onConversationIdCaptured,
  });
}

registerEipcHandler('LocalAgentModeSessions_$_start', async (_event, info) => {
  const session = buildSession(info);
  localAgentSessions.set(session.sessionId, session);
  console.log('[Cowork] Starting session:', session.sessionId);

  // Ensure the asar's .claude/projects dir exists so transcript recovery works after restart
  const claudeConfigDir = ensureAsarClaudeConfigDir(session.sessionId);
  if (claudeConfigDir) {
    session.claudeConfigDir = claudeConfigDir;
  }

  await sdkBridge.startSession(session.sessionId, session, emitLocalAgentEvent, {
    onConversationId: onConversationIdCaptured,
  });
  scheduleSave('start');
  emitLocalAgentEvent({ type: 'sessionsUpdated', sessionId: session.sessionId });
  return { sessionId: session.sessionId, conversationUuid: session.conversationUuid };
});

registerEipcHandler('LocalAgentModeSessions_$_sendMessage', async (_event, sessionId, message, images, files) => {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Re-init bridge for sessions that were loaded from disk (no live bridge state)
  await ensureBridgeSession(session.sessionId);
  session.isRunning = true;

  const entry = {
    type: 'user',
    message,
    images: images || [],
    files: files || [],
    timestamp: Date.now(),
  };
  session.transcript.push(entry);
  session.lastActivityAt = Date.now();
  scheduleSave('sendMessage');
  emitLocalAgentEvent({ type: 'data', sessionId, data: JSON.stringify(entry) });

  try {
    await sdkBridge.sendMessage(session.sessionId, message, images, files);
  } catch (e) {
    console.error('[Cowork] sendMessage bridge error:', e.message);
    emitLocalAgentEvent({
      type: 'data', sessionId: session.sessionId,
      data: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: `[Error processing message: ${e.message}]` }] }),
    });
  }
});

registerEipcHandler('LocalAgentModeSessions_$_stop', async (_event, sessionId) => {
  const session = updateSession(sessionId, { isRunning: false });
  console.log('[Cowork] Stopping session:', sessionId);
  await sdkBridge.stopSession(sessionId);
  scheduleSave('stop');
  emitLocalAgentEvent({ type: 'sessionsUpdated', sessionId });
  return session ? { success: true } : { success: false };
});

registerEipcHandler('LocalAgentModeSessions_$_archive', async (_event, sessionId) => {
  updateSession(sessionId, { isArchived: true, isRunning: false });
  await sdkBridge.stopSession(sessionId);
  scheduleSave('archive');
  emitLocalAgentEvent({ type: 'sessionsUpdated', sessionId });
});

registerEipcHandler('LocalAgentModeSessions_$_updateSession', async (_event, sessionId, updates) => {
  updateSession(sessionId, updates);
  scheduleSave('updateSession');
  emitLocalAgentEvent({ type: 'sessionsUpdated', sessionId });
});

registerEipcHandler('LocalAgentModeSessions_$_getSession', async (_event, sessionId) => {
  return getSession(sessionId);
});

registerEipcHandler('LocalAgentModeSessions_$_getAll', async () => {
  const sessions = Array.from(localAgentSessions.values());
  // Ensure every session has a valid conversationUuid before returning
  for (const session of sessions) {
    if (!session.conversationUuid || session.conversationUuid.startsWith('local_')) {
      session.conversationUuid = deriveConversationUuid(session.sessionId);
      session.uuid = session.sessionId;
    }
  }
  return sessions;
});

registerEipcHandler('LocalAgentModeSessions_$_getTranscript', async (_event, sessionId) => {
  // Combine our local transcript with SDK transcript
  const session = getSession(sessionId);
  const localTranscript = session?.transcript ?? [];
  const sdkTranscript = sdkBridge.getTranscript(sessionId);
  // SDK transcript has the full message history; local has user entries
  // Return SDK transcript if available (richer), else local
  return sdkTranscript.length > 0 ? sdkTranscript : localTranscript;
});

registerEipcHandler('LocalAgentModeSessions_$_respondToToolPermission', async (_event, requestId, decision, updatedInput) => {
  console.log('[Cowork] respondToToolPermission:', requestId, decision, Boolean(updatedInput));
  // Future: broker permission through SDK canUseTool callback
});

registerEipcHandler('LocalAgentModeSessions_$_openOutputsDir', async (_event, sessionId) => {
  console.log('[Cowork] openOutputsDir:', sessionId);
});

registerEipcHandler('LocalAgentModeSessions_$_shareSession', async (_event, sessionId) => {
  console.log('[Cowork] shareSession:', sessionId);
  return { success: false, error: 'Sharing not yet supported on Linux' };
});

registerEipcHandler('LocalAgentModeSessions_$_setDraftSessionFolders', async (_event, folders) => {
  console.log('[Cowork] setDraftSessionFolders:', folders?.length ?? 0);
});

registerEipcHandler('LocalAgentModeSessions_$_getSupportedCommands', async () => []);

registerEipcHandler('LocalAgentModeSessions_$_getTrustedFolders', async () => {
  return Array.from(trustedFolders);
});

registerEipcHandler('LocalAgentModeSessions_$_addTrustedFolder', async (_event, folder) => {
  if (typeof folder === 'string' && folder.length > 0) {
    trustedFolders.add(folder);
    scheduleSave('addTrustedFolder');
  }
});

registerEipcHandler('LocalAgentModeSessions_$_removeTrustedFolder', async (_event, folder) => {
  trustedFolders.delete(folder);
  scheduleSave('removeTrustedFolder');
});

registerEipcHandler('LocalAgentModeSessions_$_isFolderTrusted', async (_event, folder) => {
  return trustedFolders.has(folder);
});

registerEipcHandler('LocalAgentModeSessions_$_setMcpServers', async () => ({ added: [], removed: [] }));

registerEipcHandler('LocalAgentModeSessions_$_setFirstPartyConnectors', async () => {
  console.log('[Cowork] setFirstPartyConnectors');
});

registerEipcHandler('LocalAgentModeSessions_$_setFocusedSession', async (_event, sessionId) => {
  focusedSessionId = sessionId ?? null;
  scheduleSave('setFocusedSession');
});

registerEipcHandler('LocalAgentModeSessions_$_respondDirectoryServers', async (_event, requestId) => {
  console.log('[Cowork] respondDirectoryServers:', requestId);
});

registerEipcHandler('LocalAgentModeSessions_$_mcpCallTool', async () => ({
  content: [{ type: 'text', text: 'MCP tool calls not yet supported via Cowork on Linux' }],
  isError: true,
}));

registerEipcHandler('LocalAgentModeSessions_$_mcpReadResource', async () => ({ contents: [] }));

registerEipcHandler('LocalAgentModeSessions_$_mcpListResources', async () => []);

// Discover UUIDs from incoming eipc channels during handler registration
const origRegisterEipcHandler = registerEipcHandler;
// (UUID discovery happens via the ipcMain.handle patch in ipc-handler-setup.js,
//  but we also capture from our own registration for completeness)

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

registerEipcHandler('DesktopIntl_$_requestLocaleChange', async (_event, _locale) => ({
  success: true,
}));

// ===== WindowControl =====
registerEipcHandler('WindowControl_$_setThemeMode', async (_event, _mode) => ({
  success: true,
}));

// ===== LocalPlugins =====
registerEipcHandler('LocalPlugins_$_getPlugins', async () => []);

// ===== Account =====
registerEipcHandler('Account_$_setAccountDetails', async () => ({
  success: true,
}));

// ===== Auth (OAuth browser flow) =====
// OAUTH COMPLIANCE: This handler only opens the Anthropic OAuth URL in the
// user's browser. It does not intercept, capture, or process any callback.
// URL origin validation ensures only Anthropic domains are opened.
const ALLOWED_AUTH_ORIGINS = [
  'https://claude.ai',
  'https://auth.anthropic.com',
  'https://accounts.anthropic.com',
  'https://console.anthropic.com',
];

registerEipcHandler('Auth_$_doAuthInBrowser', async (_event, url) => {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('Invalid url');
  }

  // SECURITY: Validate URL points to an Anthropic domain
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (_) {
    throw new Error('Malformed URL');
  }
  const origin = parsedUrl.origin;
  if (!ALLOWED_AUTH_ORIGINS.includes(origin)) {
    console.warn(`[Auth] Blocked non-Anthropic auth URL: ${origin}`);
    throw new Error('Auth URL origin not in allowlist: ' + origin);
  }

  // SECURITY: only allow URL opens, never shell-evaluate
  const { execFile } = require('child_process');
  return await new Promise((resolve, reject) => {
    execFile('xdg-open', [url], (err) => {
      if (err) return reject(err);
      resolve({ success: true });
    });
  });
});

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
  ipcMain.handle('connect-to-mcp-server', async (_event, serverName) => {
    console.log('[IPC] connect-to-mcp-server:', serverName);
    return { connected: false, error: 'Not implemented in Linux stub' };
  });
  console.log('[IPC] Registered: connect-to-mcp-server');
} catch (e) { /* ignore duplicates */ }

try {
  ipcMain.handle('request-open-mcp-settings', async () => {
    console.log('[IPC] request-open-mcp-settings called (no-op)');
    return { success: true };
  });
  console.log('[IPC] Registered: request-open-mcp-settings');
} catch (e) { /* ignore duplicates */ }

console.log('[IPC] All Cowork handlers registered');

// ============================================================
// 6. ERROR HANDLING
// ============================================================

process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error.message || error);
  // Don't re-throw -- let the process survive.
  // IPC errors are handled per-handler (see registerEipcHandler), so this is a last-resort log.
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
