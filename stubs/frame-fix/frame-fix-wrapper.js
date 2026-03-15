// Inject frame fix and Cowork support before main app loads
const Module = require('module');
const originalRequire = Module.prototype.require;
const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  createAsarAdapter,
  DEFAULT_FILESYSTEM_PATH_ALIASES,
  isFileSystemPathRewriteChannel,
  rewriteAliasedFilePath,
} = require('./cowork/asar_adapter.js');
const { createDirs } = require('./cowork/dirs.js');
const { createSessionOrchestrator } = require('./cowork/session_orchestrator.js');
const { createSessionStore } = require('./cowork/session_store.js');
const { createIpcTap } = require('./cowork/ipc_tap.js');

console.log('[Frame Fix] Wrapper v2.5 loaded');

function wrapAliasedFileSystemHandler(channel, handler, getAdapter) {
  if (typeof handler !== 'function' || !isFileSystemPathRewriteChannel(channel)) {
    return handler;
  }
  if (handler.__coworkAliasedFileSystemWrapped) {
    return handler;
  }

  const normalizedChannel = typeof channel === 'string' ? channel.toLowerCase() : '';
  function isPotentialIpcEvent(value) {
    if (!value || typeof value !== 'object') {
      return false;
    }
    return !!(
      value.sender ||
      value.senderFrame ||
      value.frameId ||
      value.processId
    );
  }

  function splitHandlerArgs(args) {
    if (!Array.isArray(args) || args.length === 0) {
      return {
        eventArg: null,
        payloadArgs: [],
      };
    }
    if (isPotentialIpcEvent(args[0])) {
      return {
        eventArg: args[0],
        payloadArgs: args.slice(1),
      };
    }
    return {
      eventArg: null,
      payloadArgs: args.slice(),
    };
  }

  function joinHandlerArgs(eventArg, payloadArgs) {
    return eventArg ? [eventArg, ...(payloadArgs || [])] : (payloadArgs || []);
  }

  function isSessionScopedFileSystemChannelName(value) {
    return value.endsWith('filesystem_$_readlocalfile') ||
      value.endsWith('filesystem_$_openlocalfile');
  }

  let delegatedHandler = null;
  const wrappedHandler = async function(...args) {
    if (!delegatedHandler && typeof getAdapter === 'function') {
      const adapter = getAdapter();
      if (adapter && typeof adapter.wrapHandler === 'function') {
        delegatedHandler = adapter.wrapHandler(channel, handler);
      }
    }

    if (delegatedHandler) {
      return delegatedHandler(...args);
    }

    if (!Array.isArray(args) || args.length === 0) {
      return handler(...args);
    }

    const { eventArg, payloadArgs } = splitHandlerArgs(args);
    const hasExplicitSessionId = isSessionScopedFileSystemChannelName(normalizedChannel) &&
      typeof payloadArgs[0] === 'string' &&
      payloadArgs[0].startsWith('local_');
    const targetPath = hasExplicitSessionId ? payloadArgs[1] : payloadArgs[0];
    const rest = hasExplicitSessionId ? payloadArgs.slice(2) : payloadArgs.slice(1);
    if (typeof targetPath !== 'string') {
      return handler(...args);
    }

    const rewrittenPath = rewriteAliasedFilePath(targetPath, DEFAULT_FILESYSTEM_PATH_ALIASES);
    if (rewrittenPath !== targetPath) {
      console.log('[Cowork] Rewrote stale FileSystem path:', targetPath, '->', rewrittenPath);
    }
    const nextPayloadArgs = hasExplicitSessionId
      ? [payloadArgs[0], rewrittenPath, ...rest]
      : [rewrittenPath, ...rest];
    return handler(...joinHandlerArgs(eventArg, nextPayloadArgs));
  };
  wrappedHandler.__coworkAliasedFileSystemWrapped = true;
  return wrappedHandler;
}

function resolveElectronApp(electronModule) {
  const candidate = electronModule && typeof electronModule === 'object'
    ? electronModule.app
    : null;
  if (candidate && typeof candidate.on === 'function') {
    return candidate;
  }

  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.on === 'function') {
      return electron.app;
    }
  } catch (_) {}

  return null;
}

function registerElectronAppListener(electronModule, eventName, listener, description) {
  const label = description || eventName;
  try {
    const app = resolveElectronApp(electronModule);
    if (!app) {
      console.log('[Frame Fix] Skipping app listener registration for ' + label + ': app unavailable');
      return false;
    }
    app.on(eventName, listener);
    return true;
  } catch (error) {
    console.log('[Frame Fix] Failed to register app listener for ' + label + ': ' + error.message);
    return false;
  }
}

function hideLinuxMenuBars(electronModule) {
  if (REAL_PLATFORM !== 'linux') {
    return;
  }

  const BrowserWindow = electronModule && electronModule.BrowserWindow;
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
    console.log('[Frame Fix] Skipping menu bar hide: BrowserWindow.getAllWindows unavailable');
    return;
  }

  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && typeof win.setMenuBarVisibility === 'function') {
        win.setMenuBarVisibility(false);
      }
    }
    console.log('[Frame Fix] Menu bar hidden on all windows');
  } catch (error) {
    console.log('[Frame Fix] setMenuBarVisibility error:', error.message);
  }
}

function describeLinuxMenuApiShape(electronModule) {
  const menuApi = electronModule && electronModule.Menu;
  const app = resolveElectronApp(electronModule);
  const shape = {
    hasMenuObject: !!(menuApi && (typeof menuApi === 'object' || typeof menuApi === 'function')),
    hasMenuSetApplicationMenu: !!(menuApi && typeof menuApi.setApplicationMenu === 'function'),
    hasMenuSetDefaultApplicationMenu: !!(menuApi && typeof menuApi.setDefaultApplicationMenu === 'function'),
    hasAppObject: !!app,
    hasAppSetApplicationMenu: !!(app && typeof app.setApplicationMenu === 'function'),
    missing: [],
  };

  if (!shape.hasMenuObject) {
    shape.missing.push('Menu');
  }
  if (shape.hasMenuObject && !shape.hasMenuSetApplicationMenu) {
    shape.missing.push('Menu.setApplicationMenu');
  }
  if (shape.hasMenuObject && !shape.hasMenuSetDefaultApplicationMenu) {
    shape.missing.push('Menu.setDefaultApplicationMenu');
  }
  if (shape.hasAppObject && !shape.hasAppSetApplicationMenu) {
    shape.missing.push('app.setApplicationMenu');
  }

  return shape;
}

function installLinuxMenuInterceptors(electronModule) {
  if (!electronModule || typeof electronModule !== 'object') {
    return;
  }
  if (global.__coworkLinuxMenuInterceptorsInstalled) {
    return;
  }

  const menuApi = electronModule.Menu;
  const app = resolveElectronApp(electronModule);
  const menuApiShape = describeLinuxMenuApiShape(electronModule);
  if (!menuApi || (!menuApiShape.hasMenuObject && !menuApiShape.hasMenuSetApplicationMenu && !menuApiShape.hasMenuSetDefaultApplicationMenu)) {
    console.log('[Frame Fix] Skipping menu interception: Menu API unavailable');
    console.log('[Frame Fix] Menu API shape:', JSON.stringify(menuApiShape));
    return;
  }
  global.__coworkLinuxMenuInterceptorsInstalled = true;

  const originalSetAppMenu = typeof menuApi.setApplicationMenu === 'function'
    ? menuApi.setApplicationMenu.bind(menuApi)
    : null;
  const originalSetDefaultAppMenu = typeof menuApi.setDefaultApplicationMenu === 'function'
    ? menuApi.setDefaultApplicationMenu.bind(menuApi)
    : null;

  if (menuApiShape.missing.length > 0) {
    console.log('[Frame Fix] Menu API coverage gaps:', menuApiShape.missing.join(', '));
  }

  if (app && typeof app.setApplicationMenu !== 'function') {
    app.setApplicationMenu = function(menu) {
      try {
        if (originalSetAppMenu) {
          return originalSetAppMenu(menu);
        }
      } catch (error) {
        console.log('[Frame Fix] app.setApplicationMenu fallback error (ignored):', error.message);
      } finally {
        hideLinuxMenuBars(electronModule);
      }
      return undefined;
    };
    console.log('[Frame Fix] Added app.setApplicationMenu fallback');
  }

  menuApi.setApplicationMenu = function(menu) {
    console.log('[Frame Fix] Intercepting setApplicationMenu');
    try {
      if (originalSetAppMenu) {
        return originalSetAppMenu(menu);
      }
    } catch (error) {
      console.log('[Frame Fix] setApplicationMenu error (ignored):', error.message);
    } finally {
      hideLinuxMenuBars(electronModule);
    }
    return undefined;
  };

  if (originalSetDefaultAppMenu) {
    menuApi.setDefaultApplicationMenu = function(...args) {
      console.log('[Frame Fix] Intercepting setDefaultApplicationMenu');
      if (REAL_PLATFORM === 'linux') {
        try {
          menuApi.setApplicationMenu(null);
        } catch (error) {
          console.log('[Frame Fix] setDefaultApplicationMenu fallback error (ignored):', error.message);
        }
        return undefined;
      }

      try {
        return originalSetDefaultAppMenu(...args);
      } catch (error) {
        console.log('[Frame Fix] setDefaultApplicationMenu error (ignored):', error.message);
        return undefined;
      }
    };
  }
}

// ============================================================
// IPC TAP — must be created before the early ipcMain patch so
// it can instrument _invokeHandlers before any asar code runs.
// Uses a provisional log dir since DIRS isn't available yet.
// ============================================================
const ipcTap = createIpcTap({
  enabled: process.env.CLAUDE_COWORK_IPC_TAP === '1',
  logDir: process.env.CLAUDE_LOG_DIR ||
    (process.env.XDG_STATE_HOME || require('path').join(require('os').homedir(), '.local', 'state'))
    + '/claude-cowork/logs',
});

// ============================================================
// CRITICAL: Patch ipcMain IMMEDIATELY before any asar code runs
// ============================================================
// NOTE: _invokeHandlers.get() is dead code — Electron dispatches via C++
// and never calls Map.get() from JavaScript. Synthetic handlers MUST be
// registered via ipcMain.handle() to land in Electron's C++ dispatch map.
// The .set() override here only wraps filesystem handlers with alias
// rewriting. Linux-specific EIPC overrides (ClaudeCode, ClaudeVM, etc.) are
// installed on webContents.ipc by installWebContentsIpcOverrides().
try {
  const electron = require('electron');
  const { ipcMain } = electron;
  if (ipcMain && ipcMain._invokeHandlers && !global.__coworkIpcMainPatched) {
    global.__coworkIpcMainPatched = true;
    const invokeHandlers = ipcMain._invokeHandlers;
    // Tap _invokeHandlers BEFORE our overrides so the tap sees raw handler behavior
    if (ipcTap.enabled) ipcTap.wrapInvokeHandlers(invokeHandlers);
    const originalSet = invokeHandlers.set.bind(invokeHandlers);
    invokeHandlers.set = function(channel, handler) {
      // Extract EIPC prefix from the first channel that matches the pattern.
      // This is more reliable than reading files from inside the asar.
      if (!global.__coworkEipcPrefix && typeof channel === 'string') {
        const eipcMatch = channel.match(/^(\$eipc_message\$_[a-f0-9-]+_\$_)claude\.(web|hybrid|settings)_\$_/);
        if (eipcMatch) {
          global.__coworkEipcPrefix = eipcMatch[1] + 'claude.web_$_';
          console.log('[Cowork] Discovered EIPC prefix from handler registration: ' + global.__coworkEipcPrefix);
        }
      }
      return originalSet(channel, wrapAliasedFileSystemHandler(channel, handler, () => global.__coworkAsarAdapter || null));
    };
    console.log('[Cowork] ipcMain._invokeHandlers patched (filesystem aliasing)');
  }
} catch (e) {
  console.error('[Cowork] Failed to patch ipcMain:', e.message);
}

// ============================================================
// 0. TMPDIR FIX - MUST BE ABSOLUTELY FIRST
// ============================================================
// Fix EXDEV error: App downloads VM to /tmp (tmpfs) then tries to
// rename() to ~/.config/Claude/ (disk). rename() can't cross filesystems.

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;
const DIRS = createDirs();

const vmBundleDir = DIRS.claudeVmBundlesDir;
const vmTmpDir = path.join(vmBundleDir, 'tmp');
const claudeVmBundle = path.join(vmBundleDir, 'claudevm.bundle');
const LOCAL_AGENT_ROOT = DIRS.claudeLocalAgentRoot;
const localSessionStore = createSessionStore({ localAgentRoot: LOCAL_AGENT_ROOT });
const ipcSessionOrchestrator = createSessionOrchestrator({
  dirs: DIRS,
  sessionStore: localSessionStore,
});
const asarAdapter = createAsarAdapter({
  sessionOrchestrator: ipcSessionOrchestrator,
  sessionStore: localSessionStore,
});
global.__coworkAsarAdapter = asarAdapter;
localSessionStore.installMetadataPersistenceGuard();
global.__coworkIpcTap = ipcTap;

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
function isAppCodeCall(stack) {
  return stack.includes('/.vite/build/index.js') ||
         stack.includes('/app.asar/.vite/build/index.js') ||
         stack.includes('/app.asar/') ||
         stack.includes('/linux-app-extracted/');
}

function isSystemCall(stack) {
  if (isAppCodeCall(stack)) {
    return false;
  }
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
  // ClaudeCode handlers - stub out for Linux to enable the Code tab
  if (channel.includes('ClaudeCode_$_getStatus')) {
    return async () => ({
      status: 'ready',
      ready: true,
      installed: true,
      downloading: false,
      progress: 100,
      version: '2.1.72',
    });
  }
  if (channel.includes('ClaudeCode_$_prepare')) {
    return async () => ({ ready: true, success: true });
  }
  return null;
}

// ============================================================
// EIPC HANDLER OVERRIDES — webContents.ipc (Electron 23+)
// ============================================================
// The asar registers EIPC handlers on webContents.ipc (per-window IPC), NOT
// on ipcMain. This means ipcMain.handle() patches never intercept them.
//
// Strategy: after the asar's synchronous initialization completes for each
// BrowserWindow, remove its broken Linux-incompatible handlers and register
// our working replacements. No monkey-patching of internal APIs needed —
// just standard removeHandler + handle on the webContents.ipc object.
//
// The EIPC UUID is extracted from the asar's build artifacts at startup.

function discoverEipcPrefix() {
  // Primary: already extracted from _invokeHandlers.set() at startup
  if (global.__coworkEipcPrefix) return global.__coworkEipcPrefix;

  // Fallback: read from the asar's build files (may fail inside packed asar)
  try {
    const buildDir = path.join(
      path.dirname(require.main ? require.main.filename : __filename),
      '.vite', 'build'
    );
    const candidates = ['mainView.js', 'aboutWindow.js', 'index.js'];
    for (const candidate of candidates) {
      try {
        const filePath = path.join(buildDir, candidate);
        const text = fs.readFileSync(filePath, 'utf8');
        const match = text.match(/\$eipc_message\$_([a-f0-9-]+)_\$_/);
        if (match) {
          global.__coworkEipcPrefix = '$eipc_message$_' + match[1] + '_$_claude.web_$_';
          console.log('[Cowork] Discovered EIPC prefix from build file: ' + candidate);
          return global.__coworkEipcPrefix;
        }
      } catch (e) {
        console.warn('[Cowork] EIPC fallback: failed to read ' + candidate + ': ' + e.code);
      }
    }
  } catch (e) {
    console.warn('[Cowork] EIPC fallback: buildDir error: ' + e.message);
  }
  console.error('[Cowork] EIPC prefix not yet available (will retry on next webContents)');
  return null;
}

// Handlers to override on each webContents.ipc. Defined once, applied per-window.
function getLinuxIpcOverrides() {
  return {
    'ClaudeCode_$_getStatus': async () => ({
      status: 'ready',
      ready: true,
      installed: true,
      downloading: false,
      progress: 100,
      version: '2.1.72',
    }),
    'ClaudeCode_$_prepare': async () => ({ ready: true, success: true }),
    'ClaudeCode_$_checkGitAvailable': async () => ({ available: true }),
    'ComputerUseTcc_$_getState': async () => ({ granted: true, status: 'granted' }),
    'ComputerUseTcc_$_requestAccess': async () => ({ granted: true }),
    'ClaudeVM_$_getRunningStatus': async () => ({
      running: true, connected: true, ready: true, status: 'running',
    }),
    'ClaudeVM_$_getDownloadStatus': async () => ({
      status: 'ready', downloaded: true, installed: true, progress: 100,
    }),
    'ClaudeVM_$_isSupported': async () => 'supported',
    'ClaudeVM_$_getSupportStatus': async () => 'supported',
    'ClaudeVM_$_isProcessRunning': async (...args) => {
      const processId = parseRequestedProcessId(args);
      return getCoworkProcessRunningState(processId);
    },
  };
}

function installWebContentsIpcOverrides(contents) {
  if (!contents.ipc || contents.ipc.__coworkOverridesDone) return;
  contents.ipc.__coworkOverridesDone = true;

  const prefix = discoverEipcPrefix();
  if (!prefix) return;

  const overrides = getLinuxIpcOverrides();

  // Schedule after the current tick so the asar's synchronous handler
  // registration (c3t(webContents)) completes first. Then we replace.
  process.nextTick(() => {
    let count = 0;
    for (const [suffix, handler] of Object.entries(overrides)) {
      const channel = prefix + suffix;
      try {
        contents.ipc.removeHandler(channel);
      } catch (_) {}
      try {
        contents.ipc.handle(channel, handler);
        count++;
      } catch (e) {
        console.error('[Cowork] Failed to register ' + suffix + ': ' + e.message);
      }
    }
    console.log('[Cowork] Installed ' + count + ' EIPC overrides on webContents.ipc');
  });
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
registerElectronAppListener(null, 'window-all-closed', () => {
  gracefulQuit('All windows closed');
}, 'window-all-closed');

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
        const originalSet = invokeHandlers.set.bind(invokeHandlers);
        invokeHandlers.has = function(channel) {
          return originalHas(channel) || !!getSyntheticIPCResponse(channel);
        };
        invokeHandlers.set = function(channel, handler) {
          return originalSet(channel, asarAdapter.wrapHandler(channel, handler));
        };
        console.log('[Cowork] _invokeHandlers patched (filesystem wrapping)');
      }

      // Wire IPC tap before capturing originalHandle so the tap sees raw handler
      // behavior (before our overrides). Only active when CLAUDE_COWORK_IPC_TAP=1.
      if (ipcTap.enabled) {
        ipcTap.wrapHandle(ipcMain);
      }
      const originalHandle = ipcMain.handle.bind(ipcMain);
      ipcMain.handle = function(channel, handler) {
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

        // Intercept ClaudeCode handlers for the Code tab feature
        if (channel.includes('ClaudeCode')) {
          console.log(`[Cowork] Intercepting ClaudeCode handler: ${channel}`);

          const wrappedHandler = async (...args) => {
            const method = channel.split('_$_').pop();
            console.log(`[Cowork] ClaudeCode.${method} called`);

            // Override specific methods for Linux - return "ready" status
            if (method === 'getStatus') {
              return {
                status: 'ready',
                ready: true,
                installed: true,
                downloading: false,
                progress: 100,
                version: '2.1.72',
              };
            }
            if (method === 'prepare') {
              return { ready: true, success: true };
            }

            // Call original handler for other methods
            try {
              return await handler(...args);
            } catch(e) {
              console.log(`[Cowork] ClaudeCode.${method} handler error:`, e.message);
              // Return a safe default instead of throwing
              return { ready: true, status: 'ready' };
            }
          };
          return originalHandle(channel, wrappedHandler);
        }

        return originalHandle(channel, asarAdapter.wrapHandler(channel, handler));
      };

      console.log('[Cowork] IPC handler interception enabled');
    }

    // Stub out macOS-only systemPreferences methods that cause crashes on Linux
    if (module.systemPreferences && !global.__coworkSystemPreferencesPatched) {
      global.__coworkSystemPreferencesPatched = true;
      module.systemPreferences.getMediaAccessStatus = function() {
        console.log('[Frame Fix] Stubbed systemPreferences.getMediaAccessStatus');
        return 'granted';
      };
      module.systemPreferences.askForMediaAccess = async function() {
        console.log('[Frame Fix] Stubbed systemPreferences.askForMediaAccess');
        return true;
      };
      console.log('[Frame Fix] systemPreferences patched for Linux');
    }

    // Patch BrowserWindow to stub macOS-only methods and handle close events
    // The asar's close handler does `if (isMac()) return;` which swallows
    // close events since we spoof darwin. We prepend a listener that forces
    // app.quit() so killactive/WM close works on all Linux DEs.
    let _closePatched = new WeakSet();
    let _sendPatched = new WeakSet();

    function patchWindowClose(win) {
      if (_closePatched.has(win)) return;
      _closePatched.add(win);

      // Stub macOS-only BrowserWindow methods
      if (!win.setWindowButtonPosition) {
        win.setWindowButtonPosition = function() {
          // no-op on Linux
        };
      }
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
    registerElectronAppListener(module, 'web-contents-created', (_event, contents) => {
      const owner = contents.getOwnerBrowserWindow && contents.getOwnerBrowserWindow();
      if (owner) patchWindowClose(owner);
      patchEventDispatch(contents);
      if (ipcTap.enabled) ipcTap.wrapWebContents(contents);

      // EIPC override: The asar registers handlers on webContents.ipc (Electron 23+
      // per-window IPC), NOT ipcMain. After the asar's sync initialization completes,
      // replace its broken Linux-incompatible handlers with our working versions.
      if (contents.ipc && typeof contents.ipc.handle === 'function') {
        installWebContentsIpcOverrides(contents);
      }
    }, 'web-contents-created');

    // Also patch on browser-window-created for certainty
    registerElectronAppListener(module, 'browser-window-created', (_event, win) => {
      patchWindowClose(win);
      if (win && win.webContents) {
        patchEventDispatch(win.webContents);
      }
    }, 'browser-window-created');

    if (module.webContents && typeof module.webContents.getAllWebContents === 'function') {
      for (const contents of module.webContents.getAllWebContents()) {
        patchEventDispatch(contents);
      }
    }
    installLinuxMenuInterceptors(module);

    // Intercept shell.showItemInFolder to translate VM paths for scratchpad/file links
    if (module.shell && !global.__coworkShellPatched) {
      global.__coworkShellPatched = true;
      const originalShowItemInFolder = module.shell.showItemInFolder.bind(module.shell);
      const originalOpenPath = typeof module.shell.openPath === 'function'
        ? module.shell.openPath.bind(module.shell)
        : null;
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
        try {
          const stats = typeof resolvedPath === 'string' ? fs.statSync(resolvedPath) : null;
          if (stats && stats.isDirectory()) {
            console.log('[Frame Fix] shell.showItemInFolder opening directory directly:', resolvedPath);
            if (originalOpenPath) {
              originalOpenPath(resolvedPath).catch((err) => {
                console.error('[Frame Fix] shell.openPath failed for directory:', resolvedPath, err && err.message ? err.message : err);
              });
              return true;
            }
          }
        } catch (_) {}
        return originalShowItemInFolder(resolvedPath);
      };
      console.log('[Frame Fix] shell.showItemInFolder patched for VM path translation');
    }
  }

  return module;
};
