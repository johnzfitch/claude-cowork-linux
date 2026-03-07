// Inject frame fix and Cowork support before main app loads
const Module = require('module');
const originalRequire = Module.prototype.require;
const path = require('path');
const os = require('os');
const fs = require('fs');

console.log('[Frame Fix] Wrapper v2.5 loaded');

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

// Helper to check if call is from system/electron internals
function isSystemCall(stack) {
  return stack.includes('node:internal') ||
         stack.includes('internal/modules') ||
         stack.includes('node:electron') ||
         stack.includes('electron/js2c') ||
         stack.includes('electron.asar') ||
         stack.includes('frame-fix-wrapper');
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

    // Intercept ipcMain.handle to inject our VM handlers
    const { ipcMain } = module;
    if (ipcMain && !global.__coworkIPCPatched) {
      global.__coworkIPCPatched = true;

      const originalHandle = ipcMain.handle.bind(ipcMain);
      ipcMain.handle = function(channel, handler) {
        // Filter queue-operation messages from transcripts — unknown type in current webapp
        if (channel.includes('getTranscript')) {
          return originalHandle(channel, async (...args) => {
            const result = await handler(...args);
            if (Array.isArray(result)) {
              return result.filter(msg => msg && msg.type !== 'queue-operation');
            }
            return result;
          });
        }

        // Intercept ClaudeVM handlers to inject our Linux implementation
        if (channel.includes('ClaudeVM')) {
          console.log(`[Cowork] Intercepting ClaudeVM handler: ${channel}`);

          // Wrap the handler to override certain methods
          const wrappedHandler = async (...args) => {
            const method = channel.split('_$_').pop();
            console.log(`[Cowork] ClaudeVM.${method} called`);

            // Override specific methods for Linux
            if (method === 'getRunningStatus') {
              return { running: true, connected: true, ready: true, status: 'running' };
            }
            if (method === 'getDownloadStatus') {
              return { status: 'ready', downloaded: true, installed: true, progress: 100 };
            }
            if (method === 'isSupported' || method === 'getSupportStatus') {
              return 'supported';
            }

            // Call original handler for other methods
            try {
              return await handler(...args);
            } catch(e) {
              console.log(`[Cowork] ClaudeVM.${method} handler error:`, e.message);
              return null;
            }
          };
          return originalHandle(channel, wrappedHandler);
        }
        return originalHandle(channel, handler);
      };

      console.log('[Cowork] IPC handler interception enabled');
    }

    const OriginalMenu = module.Menu;

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
  }

  return module;
};
