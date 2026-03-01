// Inject frame fix and Cowork support before main app loads
const Module = require('module');
const originalRequire = Module.prototype.require;
const path = require('path');
const os = require('os');
const fs = require('fs');

console.log('[Frame Fix] Wrapper v3.0 loaded');

// ============================================================
// 0. TMPDIR FIX - MUST BE ABSOLUTELY FIRST
// ============================================================
// Fix EXDEV error: App downloads VM to /tmp (tmpfs) then tries to
// rename() to ~/.config/Claude/ (disk). rename() can't cross filesystems.

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;

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

  // Pre-create VM bundle to skip download entirely
  fs.mkdirSync(claudeVmBundle, { recursive: true, mode: 0o755 });

  // Create marker files the app checks
  const markers = ['bundle_complete', 'rootfs.img', 'rootfs.img.zst', 'vmlinux', 'config.json'];
  for (const m of markers) {
    const p = path.join(claudeVmBundle, m);
    if (!fs.existsSync(p)) {
      if (m === 'config.json') {
        fs.writeFileSync(p, '{"version":"linux-native","skip_vm":true}', { mode: 0o644 });
      } else {
        fs.writeFileSync(p, 'linux-native-placeholder', { mode: 0o644 });
      }
    }
  }
  fs.writeFileSync(path.join(claudeVmBundle, 'version'), '999.0.0-linux-native', { mode: 0o644 });

  console.log('[TMPDIR] Fixed: ' + vmTmpDir);
  console.log('[TMPDIR] os.tmpdir() patched');
  console.log('[VM_BUNDLE] Ready: ' + claudeVmBundle);
} catch (e) {
  console.error('[TMPDIR] Setup failed:', e.message);
}

// ============================================================
// 0b. PATCH fs.rename TO HANDLE EXDEV ERRORS
// ============================================================
const originalRename = fs.rename;
const originalRenameSync = fs.renameSync;

fs.rename = function(oldPath, newPath, callback) {
  originalRename(oldPath, newPath, (err) => {
    if (err && err.code === 'EXDEV') {
      console.log('[fs.rename] EXDEV detected, using copy+delete for:', oldPath);
      const readStream = fs.createReadStream(oldPath);
      const writeStream = fs.createWriteStream(newPath);
      readStream.on('error', callback);
      writeStream.on('error', callback);
      writeStream.on('close', () => {
        fs.unlink(oldPath, () => callback(null));
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

// ============================================================
// 1. PLATFORM SPOOFING - Immediate, before any app code
// ============================================================

// Helper to check if the IMMEDIATE caller is from system/electron internals.
// We only check the first non-getter frame in the stack, NOT the entire stack.
// This is critical because IPC handlers are dispatched through electron/js2c
// (deep in the stack), but the handler code itself runs from app.asar and
// must see the spoofed platform.
function isSystemCall(stack) {
  const lines = stack.split('\n');
  // Find the first frame that isn't our getter or the Error line itself
  for (let i = 1; i < lines.length && i < 6; i++) {
    const line = lines[i];
    if (line.includes('frame-fix-wrapper')) continue;
    // This is the actual caller - check if it's system code
    return line.includes('node:internal') ||
           line.includes('internal/modules') ||
           line.includes('node:electron') ||
           line.includes('electron/js2c') ||
           line.includes('electron.asar');
  }
  return false;
}

Object.defineProperty(process, 'platform', {
  get() {
    const stack = new Error().stack || '';
    // System/Electron internals need real platform
    if (isSystemCall(stack)) {
      return REAL_PLATFORM;
    }
    // App code sees darwin (for event logging, feature detection, etc)
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

// Spoof macOS version
const originalGetSystemVersion = process.getSystemVersion;
process.getSystemVersion = function() {
  return '14.0.0';
};

console.log('[Platform] Spoofing: darwin/arm64 macOS 14.0 (immediate)');
console.log('[Platform] Real platform was:', REAL_PLATFORM);

// ============================================================
// Cowork/YukonSilver Support for Linux
// On Linux we run Claude Code directly without a VM
// ============================================================

// Global state for Cowork
global.__cowork = {
  supported: true,
  status: 'supported', // This is what the app checks
  processes: new Map(),
};

// Create sessions directory
const SESSIONS_BASE = path.join(os.homedir(), '.local/share/claude-cowork/sessions');
try { fs.mkdirSync(SESSIONS_BASE, { recursive: true, mode: 0o700 }); } catch(e) {}

// Override getYukonSilverSupportStatus globally
// The bundled code might look for this function
global.getYukonSilverSupportStatus = function() {
  console.log('[Cowork] getYukonSilverSupportStatus intercepted - returning supported');
  return 'supported';
};

// Try to intercept via prototype pollution on common patterns
// The app might use an object like: vmStatus.getStatus() or vmSupport.getSupportStatus()
const originalDefineProperty = Object.defineProperty;
Object.defineProperty = function(target, key, descriptor) {
  // Intercept any property that looks like it returns support status
  if (typeof key === 'string' && (key.includes('SupportStatus') || key === 'status' || key === 'supported')) {
    if (descriptor && typeof descriptor.value === 'function') {
      const original = descriptor.value;
      descriptor.value = function(...args) {
        const result = original.apply(this, args);
        if (result === 'unsupported') {
          console.log(`[Cowork] Intercepted ${key} returning unsupported -> supported`);
          return 'supported';
        }
        return result;
      };
    }
  }
  return originalDefineProperty.call(this, target, key, descriptor);
};

console.log('[Cowork] Linux support enabled - VM will be emulated');

Module.prototype.require = function(id) {
  // Intercept claude-swift to inject our Linux implementation
  if (id && id.includes('@ant/claude-swift')) {
    console.log('[Cowork] Intercepting @ant/claude-swift');
    const swiftStub = originalRequire.apply(this, arguments);
    // Ensure the VM reports as supported
    if (swiftStub && swiftStub.vm) {
      const originalGetStatus = swiftStub.vm.getStatus;
      swiftStub.vm.getStatus = function() {
        console.log('[Cowork] vm.getStatus called - returning supported');
        return { supported: true, status: 'supported', running: true, connected: true };
      };
      swiftStub.vm.getSupportStatus = function() {
        console.log('[Cowork] vm.getSupportStatus called - returning supported');
        return 'supported';
      };
      swiftStub.vm.isSupported = function() {
        return true;
      };
    }
    return swiftStub;
  }

  const module = originalRequire.apply(this, arguments);

  if (id === 'electron') {
    console.log('[Frame Fix] Intercepting electron module');

    // Intercept IPC handler registration at the Map level.
    // The asar registers handlers via ipcMain.handle() which stores them
    // in ipcMain._invokeHandlers (an internal Map). By patching .set()
    // on this Map, we catch ALL registrations regardless of timing or
    // whether the asar captured ipcMain.handle before our patch.
    const { ipcMain } = module;
    if (ipcMain && !global.__coworkIPCPatched) {
      global.__coworkIPCPatched = true;

      // Handlers we override with Linux-compatible stubs
      const IPC_OVERRIDES = {
        'ClaudeVM_$_getDownloadStatus': { status: 'ready', downloaded: true, installed: true, progress: 100, version: 'linux-native-1.0.0' },
        'ClaudeVM_$_download': { status: 'ready', downloaded: true, progress: 100 },
        'ClaudeVM_$_getRunningStatus': { running: true, connected: true, status: 'connected' },
        'ClaudeVM_$_start': { started: true, status: 'running' },
        'ClaudeVM_$_stop': { stopped: true },
        'ClaudeVM_$_getSupportStatus': { status: 'supported' },
        'ClaudeVM_$_setYukonSilverConfig': { success: true },
        'ClaudeVM_$_deleteAndReinstall': { success: true },
      };

      const overrideEntries = Object.entries(IPC_OVERRIDES);

      // Check if a channel matches one of our overrides
      function getOverrideResponse(channel) {
        for (const [suffix, response] of overrideEntries) {
          if (channel.endsWith('_$_' + suffix)) {
            return response;
          }
        }
        return null;
      }

      // Patch _invokeHandlers.set() to intercept handler registration
      const invokeHandlers = ipcMain._invokeHandlers;
      if (invokeHandlers && invokeHandlers instanceof Map) {
        const origSet = invokeHandlers.set.bind(invokeHandlers);
        invokeHandlers.set = function(channel, handler) {
          const override = getOverrideResponse(channel);
          if (override) {
            console.log('[IPC-Intercept] Replacing handler: ' + channel.split('_$_').pop());
            return origSet(channel, async () => override);
          }
          return origSet(channel, handler);
        };
        console.log('[IPC-Intercept] _invokeHandlers.set() patched');
      } else {
        console.warn('[IPC-Intercept] _invokeHandlers not available, falling back to ipcMain.handle patch');
        // Fallback: patch ipcMain.handle directly
        const originalHandle = ipcMain.handle.bind(ipcMain);
        ipcMain.handle = function(channel, handler) {
          const override = getOverrideResponse(channel);
          if (override) {
            console.log('[IPC-Intercept] Replacing handler (fallback): ' + channel.split('_$_').pop());
            return originalHandle(channel, async () => override);
          }
          return originalHandle(channel, handler);
        };
      }

      console.log('[Cowork] IPC handler interception enabled');
    }

    // Stub macOS-only systemPreferences methods that don't exist on Linux.
    // Since we spoof platform as darwin, the app tries to call these.
    if (REAL_PLATFORM === 'linux' && module.systemPreferences) {
      const sp = module.systemPreferences;
      if (typeof sp.getMediaAccessStatus !== 'function') {
        sp.getMediaAccessStatus = function(mediaType) { return 'granted'; };
      }
      if (typeof sp.askForMediaAccess !== 'function') {
        sp.askForMediaAccess = async function(mediaType) { return true; };
      }
      if (typeof sp.promptTouchID !== 'function') {
        sp.promptTouchID = async function(reason) { /* no-op on Linux */ };
      }
      console.log('[Platform] Stubbed macOS systemPreferences methods');
    }

    const OriginalBrowserWindow = module.BrowserWindow;
    const OriginalMenu = module.Menu;

    // Stub macOS-only BrowserWindow methods that don't exist on Linux
    if (REAL_PLATFORM === 'linux') {
      if (!OriginalBrowserWindow.prototype.setWindowButtonPosition) {
        OriginalBrowserWindow.prototype.setWindowButtonPosition = function() {};
      }
    }

    module.BrowserWindow = class BrowserWindowWithFrame extends OriginalBrowserWindow {
      constructor(options) {
        console.log('[Frame Fix] BrowserWindow constructor called');
        if (REAL_PLATFORM === 'linux') {
          options = options || {};
          const originalFrame = options.frame;
          // Force native frame
          options.frame = true;
          // Hide the menu bar by default (Alt key will toggle it)
          options.autoHideMenuBar = true;
          // Remove custom titlebar options
          delete options.titleBarStyle;
          delete options.titleBarOverlay;
          console.log(`[Frame Fix] Modified frame from ${originalFrame} to true`);
        }
        super(options);
        // Hide menu bar after window creation on Linux
        if (REAL_PLATFORM === 'linux') {
          this.setMenuBarVisibility(false);
          console.log('[Frame Fix] Menu bar visibility set to false');
        }
      }
    };

    // Copy static methods and properties (but NOT prototype, that's already set by extends)
    for (const key of Object.getOwnPropertyNames(OriginalBrowserWindow)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(OriginalBrowserWindow, key);
          if (descriptor) {
            Object.defineProperty(module.BrowserWindow, key, descriptor);
          }
        } catch (e) {
          // Ignore errors for non-configurable properties
        }
      }
    }

    // Intercept Menu.setApplicationMenu to hide menu bar on Linux
    // This catches the app's later calls to setApplicationMenu that would show the menu
    const originalSetAppMenu = OriginalMenu.setApplicationMenu;
    module.Menu.setApplicationMenu = function(menu) {
      console.log('[Frame Fix] Intercepting setApplicationMenu');
      try {
        // Call original - use call() to preserve correct context
        if (typeof originalSetAppMenu === 'function') {
          originalSetAppMenu.call(OriginalMenu, menu);
        }
      } catch (e) {
        console.log('[Frame Fix] setApplicationMenu error (ignored):', e.message);
      }
      if (REAL_PLATFORM === 'linux') {
        // Hide menu bar on all existing windows after menu is set
        try {
          for (const win of module.BrowserWindow.getAllWindows()) {
            win.setMenuBarVisibility(false);
          }
          console.log('[Frame Fix] Menu bar hidden on all windows');
        } catch (e) {
          console.log('[Frame Fix] setMenuBarVisibility error:', e.message);
        }
      }
    };

    // ============================================================
    // Linux: prevent duplicate Tray D-Bus errors
    // ============================================================
    // The app creates two Tray instances. The second one's D-Bus handlers
    // fail to register ("already exported"). Fix by destroying the previous
    // Tray before creating a new one.
    if (REAL_PLATFORM === 'linux' && !global.__coworkTrayPatched) {
      global.__coworkTrayPatched = true;
      const OrigTray = module.Tray;
      let _previousTray = null;
      module.Tray = class TrayDedup extends OrigTray {
        constructor(...args) {
          if (_previousTray && typeof _previousTray.isDestroyed === 'function' && !_previousTray.isDestroyed()) {
            _previousTray.destroy();
          }
          super(...args);
          _previousTray = this;
        }
      };
    }

    // ============================================================
    // Linux: confirm-before-quit on window close
    // ============================================================
    // On macOS, closing the window hides it to the dock/tray. On Linux
    // (especially KDE Plasma Wayland) the tray restore doesn't work, so
    // we intercept the close event and ask the user whether they really
    // want to quit. This runs for the main window only (not small helper
    // windows like "About" or "Find in Page").
    if (REAL_PLATFORM === 'linux' && !global.__coworkCloseDialogPatched) {
      global.__coworkCloseDialogPatched = true;
      const { dialog: _dialog, app: _app } = require('electron');

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
          const locale = _app.getLocale() || process.env.LANG || 'en-US';
          const lang = locale.split(/[-_]/)[0].toLowerCase();

          // Load button labels from i18n JSON
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
              const i18nPath = path.join(__dirname, 'resources', 'i18n', tag + '.json');
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

      // Track whether the user already confirmed quit (or app.quit() was called)
      let _quitting = false;
      _app.on('before-quit', () => { _quitting = true; });

      const _origEmit = OriginalBrowserWindow.prototype.emit;
      OriginalBrowserWindow.prototype.emit = function(event, ev, ...args) {
        if (event === 'close' && !_quitting && !this.isDestroyed()) {
          // Only intercept "main-like" windows (have a reasonable size)
          const [w, h] = this.getSize();
          if (w >= 400 && h >= 300) {
            ev.preventDefault();
            const s = _getCloseStrings();
            _dialog.showMessageBox(this, {
              type: 'question',
              buttons: [s.quit, s.cancel],
              defaultId: 1,
              cancelId: 1,
              title: s.title,
              message: s.message,
            }).then(({ response }) => {
              if (response === 0) {
                _quitting = true;
                _app.quit();
              }
            });
            return false;
          }
        }
        return _origEmit.call(this, event, ev, ...args);
      };

      console.log('[Linux] Close confirmation dialog enabled');
    }
  }

  return module;
};
