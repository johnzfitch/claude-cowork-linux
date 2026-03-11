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
const APP_SUPPORT_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
const LOCAL_AGENT_ROOT = path.join(APP_SUPPORT_ROOT, 'LocalAgentModeSessions');

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

// Keep the bootstrap wrapper aligned with the swift stub's session root.
const SESSIONS_BASE = path.join(LOCAL_AGENT_ROOT, 'sessions');
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

const IGNORED_LIVE_MESSAGE_TYPES = new Set(['queue-operation', 'rate_limit_event']);

function parseRequestedProcessId(args) {
  for (const arg of args) {
    if (typeof arg === 'string') {
      return arg;
    }
    if (arg && typeof arg === 'object' && typeof arg.id === 'string') {
      return arg.id;
    }
  }
  return null;
}

async function getCoworkProcessRunningState(processId) {
  const stub = global.__coworkSwiftStub;
  const specialKeepalive = processId === '__keepalive__' || processId === '__heartbeat__';

  try {
    if (stub && typeof stub.isProcessRunning === 'function' && !stub.isProcessRunning.__coworkSyntheticWrapper) {
      const result = await Promise.resolve(stub.isProcessRunning(processId));
      if (result && typeof result === 'object' && 'running' in result) {
        return {
          running: !!result.running,
          exitCode: result.exitCode ?? null,
        };
      }
      const running = !!result;
      return { running, exitCode: running ? null : 0 };
    }
    if (stub && stub.vm && typeof stub.vm.isProcessRunning === 'function' && !stub.vm.isProcessRunning.__coworkSyntheticWrapper) {
      const result = await Promise.resolve(stub.vm.isProcessRunning(processId));
      if (result && typeof result === 'object' && 'running' in result) {
        return {
          running: !!result.running,
          exitCode: result.exitCode ?? null,
        };
      }
      const running = !!result;
      return { running, exitCode: running ? null : 0 };
    }
  } catch (_) {}

  if (typeof processId === 'string' && global.__cowork.processes.has(processId)) {
    return { running: true, exitCode: null };
  }
  if (specialKeepalive) {
    return { running: true, exitCode: null };
  }
  return { running: false, exitCode: 0 };
}

function getIgnoredLiveMessageType(channel, payload) {
  if (typeof channel !== 'string') {
    return null;
  }
  if (!channel.includes('LocalAgentModeSessions_$_onEvent') && !channel.includes('LocalSessions_$_onEvent')) {
    return null;
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.type === 'message' && payload.message && typeof payload.message === 'object') {
    const messageType = payload.message.type;
    return IGNORED_LIVE_MESSAGE_TYPES.has(messageType) ? messageType : null;
  }

  return IGNORED_LIVE_MESSAGE_TYPES.has(payload.type) ? payload.type : null;
}

function logIgnoredLiveMessage(channel, payload, messageType) {
  if (!global.__coworkIgnoredLiveMessageStats) {
    global.__coworkIgnoredLiveMessageStats = new Map();
  }

  const key = `${channel}:${messageType}`;
  const current = global.__coworkIgnoredLiveMessageStats.get(key) || { count: 0, lastLoggedAt: 0 };
  current.count += 1;

  const now = Date.now();
  const shouldLog = current.count <= 3 || (now - current.lastLoggedAt) >= 60000;
  if (shouldLog) {
    current.lastLoggedAt = now;
    console.log('[Cowork] Ignored live session event ' + JSON.stringify({
      channel: channel.includes('LocalAgentModeSessions') ? 'LocalAgentModeSessions.onEvent' : 'LocalSessions.onEvent',
      messageType,
      count: current.count,
      sessionId: payload && typeof payload === 'object' ? (payload.sessionId || null) : null,
    }));
  }

  global.__coworkIgnoredLiveMessageStats.set(key, current);
}

function getSyntheticIPCResponse(channel) {
  if (typeof channel !== 'string') {
    return null;
  }
  if (channel.includes('ComputerUseTcc_$_getState')) {
    return async () => ({
      accessibility: 'denied',
      screenCapture: 'denied',
      canPrompt: false,
    });
  }
  if (channel.includes('ComputerUseTcc_$_requestAccess')) {
    return async () => ({
      success: false,
      accessibility: 'denied',
      screenCapture: 'denied',
      canPrompt: false,
    });
  }
  if (channel.includes('isProcessRunning')) {
    return async (...args) => {
      const processId = parseRequestedProcessId(args);
      // Return object { running, exitCode } - app expects e?.running
      return getCoworkProcessRunningState(processId);
    };
  }
  return null;
}

// ============================================================
// GRACEFUL SHUTDOWN — on Linux, closing all windows must quit the
// app. The asar's handler checks `process.platform === "darwin"`
// and skips quit on macOS (dock convention). Since we spoof darwin,
// we must register our own handler first to call app.quit().
// Also handle SIGTERM/SIGHUP so WMs, systemd, and kill(1) work.
// ============================================================
let shuttingDown = false;
function gracefulQuit(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] ${reason}, quitting gracefully`);
  try {
    const { app } = require('electron');
    // app.quit() can be cancelled by before-quit handlers (the asar has one).
    // app.exit() is uncancellable — closes all windows and exits immediately.
    app.exit(0);
  } catch (e) {
    process.exit(0);
  }
}

// window-all-closed: registered early so it fires before the asar's
// handler (which short-circuits on "darwin" and never quits)
const { app: _app } = require('electron');
_app.on('window-all-closed', () => {
  gracefulQuit('All windows closed');
});

for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
  process.on(sig, () => gracefulQuit(`Received ${sig}`));
}

Module.prototype.require = function(id) {
  // Intercept claude-swift to inject our Linux implementation
  if (id && id.includes('@ant/claude-swift')) {
    console.log('[Cowork] Intercepting @ant/claude-swift');
    const swiftStub = originalRequire.apply(this, arguments);
    global.__coworkSwiftStub = swiftStub;
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
      if (typeof swiftStub.vm.isProcessRunning !== 'function') {
        const syntheticVmIsProcessRunning = async function(processId) {
          const state = await getCoworkProcessRunningState(processId);
          return state.running;
        };
        syntheticVmIsProcessRunning.__coworkSyntheticWrapper = true;
        swiftStub.vm.isProcessRunning = syntheticVmIsProcessRunning;
      }
    }
    if (swiftStub && typeof swiftStub.isProcessRunning !== 'function') {
      const syntheticIsProcessRunning = async function(processId) {
        const state = await getCoworkProcessRunningState(processId);
        return state.running;
      };
      syntheticIsProcessRunning.__coworkSyntheticWrapper = true;
      swiftStub.isProcessRunning = syntheticIsProcessRunning;
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

      const invokeHandlers = ipcMain._invokeHandlers;
      if (invokeHandlers && !global.__coworkInvokeHandlersPatched) {
        global.__coworkInvokeHandlersPatched = true;
        const originalHas = invokeHandlers.has.bind(invokeHandlers);
        const originalGet = invokeHandlers.get.bind(invokeHandlers);
        invokeHandlers.has = function(channel) {
          return originalHas(channel) || !!getSyntheticIPCResponse(channel);
        };
        invokeHandlers.get = function(channel) {
          const existing = originalGet(channel);
          return existing || getSyntheticIPCResponse(channel);
        };
        console.log('[Cowork] _invokeHandlers fallback enabled');
      }

      const originalHandle = ipcMain.handle.bind(ipcMain);
      ipcMain.handle = function(channel, handler) {
        // Filter ignored message types from transcripts — check both top-level and nested
        if (channel.includes('getTranscript')) {
          return originalHandle(channel, async (...args) => {
            const result = await handler(...args);
            if (Array.isArray(result)) {
              return result.filter(msg => {
                if (!msg) return false;
                // Check top-level type
                if (IGNORED_LIVE_MESSAGE_TYPES.has(msg.type)) return false;
                // Check nested message type (matches live filtering logic)
                if (msg.type === 'message' && msg.message && IGNORED_LIVE_MESSAGE_TYPES.has(msg.message.type)) {
                  return false;
                }
                return true;
              });
            }
            return result;
          });
        }

        const syntheticHandler = getSyntheticIPCResponse(channel);
        if (syntheticHandler) {
          console.log(`[Cowork] Intercepting synthetic IPC handler: ${channel}`);
          return originalHandle(channel, syntheticHandler);
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
            if (method === 'isProcessRunning') {
              const processId = parseRequestedProcessId(args);
              // Return object { running, exitCode } - app expects e?.running
              return getCoworkProcessRunningState(processId);
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

    // Patch BrowserWindow so close events actually quit on Linux.
    // The asar's close handler does `if (isMac()) return;` which swallows
    // close events since we spoof darwin. We prepend a listener that forces
    // app.quit() so killactive/WM close works on all Linux DEs.
    let _closePatched = new WeakSet();
    let _sendPatched = new WeakSet();

    function patchWindowClose(win) {
      if (_closePatched.has(win)) return;
      _closePatched.add(win);
      // Use prependListener so we fire before the asar's handler
      win.prependListener('close', (event) => {
        if (REAL_PLATFORM === 'linux' && !shuttingDown) {
          console.log('[Shutdown] Window close on Linux — scheduling exit');
          // Defer exit so the close event chain finishes without
          // hitting "Object has been destroyed" in downstream handlers
          setImmediate(() => gracefulQuit('Window closed'));
        }
      });
    }

    function patchEventDispatch(contents) {
      if (!contents || _sendPatched.has(contents) || typeof contents.send !== 'function') {
        return;
      }
      _sendPatched.add(contents);
      const originalSend = contents.send.bind(contents);
      contents.send = function(channel, ...args) {
        const ignoredType = getIgnoredLiveMessageType(channel, args[0]);
        if (ignoredType) {
          logIgnoredLiveMessage(channel, args[0], ignoredType);
          return false;
        }
        return originalSend(channel, ...args);
      };
    }

    // Hook webContents creation to catch windows as they appear
    _app.on('web-contents-created', (_event, contents) => {
      const owner = contents.getOwnerBrowserWindow && contents.getOwnerBrowserWindow();
      if (owner) patchWindowClose(owner);
      patchEventDispatch(contents);
    });

    // Also patch on browser-window-created for certainty
    _app.on('browser-window-created', (_event, win) => {
      patchWindowClose(win);
      if (win && win.webContents) {
        patchEventDispatch(win.webContents);
      }
    });

    if (module.webContents && typeof module.webContents.getAllWebContents === 'function') {
      for (const contents of module.webContents.getAllWebContents()) {
        patchEventDispatch(contents);
      }
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

    // Intercept shell.showItemInFolder to translate VM paths for scratchpad/file links
    if (module.shell && !global.__coworkShellPatched) {
      global.__coworkShellPatched = true;
      const originalShowItemInFolder = module.shell.showItemInFolder.bind(module.shell);
      module.shell.showItemInFolder = function(fullPath) {
        let resolvedPath = fullPath;
        let candidatePath = null;
        let sessionRoot = null;
        if (typeof fullPath === 'string') {
          if (fullPath.startsWith('/sessions/')) {
            const sessionPath = fullPath.substring('/sessions/'.length);
            const sessionName = sessionPath.split('/')[0];
            if (!sessionName || sessionName === '.' || sessionName === '..' || sessionName.includes('/')) {
              console.error('[Frame Fix] shell.showItemInFolder: invalid session name:', fullPath);
              return false;
            }
            sessionRoot = path.join(SESSIONS_BASE, sessionName);
            candidatePath = path.resolve(path.join(SESSIONS_BASE, sessionPath));
          } else if (fullPath === SESSIONS_BASE || fullPath.startsWith(SESSIONS_BASE + path.sep)) {
            const sessionRelative = path.relative(SESSIONS_BASE, fullPath);
            const sessionName = sessionRelative.split(path.sep)[0];
            if (!sessionName || sessionName === '.' || sessionName === '..' || sessionName.includes('/')) {
              console.error('[Frame Fix] shell.showItemInFolder: invalid host session path:', fullPath);
              return false;
            }
            sessionRoot = path.join(SESSIONS_BASE, sessionName);
            candidatePath = path.resolve(fullPath);
          }
        }
        if (candidatePath && sessionRoot) {
          // Validate containment lexically within the session tree, then canonicalize
          // through mnt symlinks so the file manager lands on the real host location.
          const relativeToRoot = path.relative(sessionRoot, candidatePath);
          if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
            console.error('[Frame Fix] shell.showItemInFolder: path escapes session root:', fullPath, '->', candidatePath);
            return false;
          }
          try {
            resolvedPath = fs.realpathSync(candidatePath);
          } catch (_) {
            let current = path.dirname(candidatePath);
            let foundAncestor = false;
            while (current !== path.dirname(current)) {
              const relative = path.relative(sessionRoot, current);
              if (relative.startsWith('..') || path.isAbsolute(relative)) {
                console.error('[Frame Fix] shell.showItemInFolder: no valid ancestor inside session root:', fullPath);
                return false;
              }
              try {
                resolvedPath = fs.realpathSync(current);
                foundAncestor = true;
                break;
              } catch (_) {
                current = path.dirname(current);
              }
            }
            if (!foundAncestor) {
              console.error('[Frame Fix] shell.showItemInFolder: no valid ancestor found:', fullPath);
              return false;
            }
          }
          console.log('[Frame Fix] shell.showItemInFolder translated:', fullPath, '->', resolvedPath);
        }
        return originalShowItemInFolder(resolvedPath);
      };
      console.log('[Frame Fix] shell.showItemInFolder patched for VM path translation');
    }
  }

  return module;
};
