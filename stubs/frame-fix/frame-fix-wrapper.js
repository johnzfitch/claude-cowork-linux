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
const { createOverrideRegistry, matchOverride, extractEipcUuid, proactivelyRegisterOverrides, isProactiveChannel } = require('./cowork/ipc_overrides.js');

console.log('[Frame Fix] Wrapper v2.5 loaded');
if (process.env.CLAUDE_DEVTOOLS === '1') console.log('[Frame Fix] DevTools mode enabled');

// ── Asset Dumper (--devtools only) ──────────────────────────────────────
// Saves JS/CSS/JSON from claude.ai and *.anthropic.com to:
//   ~/.local/state/claude-cowork/logs/webapp-assets/
// Previous dump is rotated to webapp-assets.bak/ on each launch.
function setupAssetDumper(win) {
  const logDir = process.env.CLAUDE_LOG_DIR || path.join(os.homedir(), '.local', 'state', 'claude-cowork', 'logs');
  const dumpDir = path.join(logDir, 'webapp-assets');
  const bakDir = dumpDir + '.bak';

  // Rotate: remove old .bak, rename current to .bak
  try { fs.rmSync(bakDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.renameSync(dumpDir, bakDir); } catch (_) {}
  try { fs.mkdirSync(dumpDir, { recursive: true }); } catch (_) {}

  const dumped = new Set();
  let dumpCount = 0;
  win.webContents.session.webRequest.onCompleted(
    { urls: ['*://*.anthropic.com/*', '*://claude.ai/*'] },
    (details) => {
      if (details.statusCode !== 200) return;
      const url = details.url;
      if (dumped.has(url)) return;
      const ext = path.extname(new URL(url).pathname).toLowerCase();
      if (!['.js', '.css', '.json', '.html'].includes(ext)) return;
      dumped.add(url);
      win.webContents.session.fetch(url).then(r => r.text()).then(body => {
        const safeName = new URL(url).pathname.replace(/\//g, '_').replace(/^_/, '');
        fs.writeFile(path.join(dumpDir, safeName), body, () => {
          dumpCount++;
          if (dumpCount <= 5 || dumpCount % 10 === 0) {
            console.log('[Asset Dump] ' + dumpCount + ' files -> ' + dumpDir);
          }
        });
      }).catch(() => {});
    }
  );

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  DEVTOOLS MODE  —  Asset dumper active                      ║');
  console.log('║  Current: ' + dumpDir.padEnd(49) + '║');
  console.log('║  Backup:  ' + bakDir.padEnd(49) + '║');
  console.log('║  Diff with: diff <dir> <dir.bak> to spot protocol changes   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
}

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
      hideLinuxMenuBars(electronModule);
      return undefined;
    };
  }

  menuApi.setApplicationMenu = function(menu) {
    hideLinuxMenuBars(electronModule);
    return undefined;
  };

  if (originalSetDefaultAppMenu) {
    menuApi.setDefaultApplicationMenu = function(...args) {
      if (REAL_PLATFORM === 'linux') {
        hideLinuxMenuBars(electronModule);
        return undefined;
      }
      return originalSetDefaultAppMenu(...args);
    };
  }
}

// ============================================================
// IPC TAP — must be created before the early ipcMain patch so
// it can instrument _invokeHandlers before any asar code runs.
// ============================================================
const ipcTap = createIpcTap();

// ============================================================
// CRITICAL: Patch ipcMain IMMEDIATELY before any asar code runs
// ============================================================
// NOTE: _invokeHandlers.get() is dead code — Electron dispatches via C++
// and never calls Map.get() from JavaScript. Synthetic handlers MUST be
// registered via ipcMain.handle() to land in Electron's C++ dispatch map.
// The .set() override here only wraps filesystem handlers with alias
// rewriting. Linux IPC overrides are applied at registration time via
// matchOverride() in both ipcMain.handle() and webContents.ipc.handle().
try {
  const electron = require('electron');
  const { ipcMain } = electron;
  if (ipcMain && ipcMain._invokeHandlers && !global.__coworkIpcMainAliasPatched) {
    global.__coworkIpcMainAliasPatched = true;
    const invokeHandlers = ipcMain._invokeHandlers;
    // Tap _invokeHandlers BEFORE our overrides so the tap sees raw handler behavior
    if (ipcTap.enabled) ipcTap.wrapInvokeHandlers(invokeHandlers);
    const originalSet = invokeHandlers.set.bind(invokeHandlers);
    invokeHandlers.set = function(channel, handler) {
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
global.__coworkSessionStore = localSessionStore;
global.__coworkSessionOrchestrator = ipcSessionOrchestrator;
global.__coworkDirs = DIRS;
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

  // The asar wraps all git commands with a "disclaimer" binary on macOS
  // (Helpers/disclaimer git <args>). Since we spoof process.platform to
  // "darwin", this codepath activates on Linux too. The binary doesn't
  // exist in the Linux Electron distribution, causing ENOENT on every
  // git operation (diff, status, etc). Create a transparent passthrough
  // so the wrapper is a no-op — identical to what the asar's own
  // non-darwin branch does (returns the command unchanged).
  const disclaimerDir = path.join(path.dirname(process.resourcesPath), 'Helpers');
  const disclaimerBin = path.join(disclaimerDir, 'disclaimer');
  if (!fs.existsSync(disclaimerBin)) {
    try {
      fs.mkdirSync(disclaimerDir, { recursive: true, mode: 0o755 });
      fs.writeFileSync(disclaimerBin, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
      console.log('[disclaimer] Created passthrough: ' + disclaimerBin);
    } catch (de) {
      console.warn('[disclaimer] Could not create passthrough: ' + de.message);
    }
  }
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
      // Cross-filesystem rename — fall back to copy+delete
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
      // Cross-filesystem rename — fall back to copy+delete
      fs.copyFileSync(oldPath, newPath);
      fs.unlinkSync(oldPath);
      return;
    }
    throw err;
  }
};

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

const SESSIONS_BASE = DIRS.claudeSessionsBase;

// Items 9, 10: dead support-status overrides removed (handled by IPC stubs).

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

// ============================================================
// IPC OVERRIDE REGISTRY — single source of truth for all Linux overrides.
// Applied at registration time on both ipcMain.handle() and
// webContents.ipc.handle() via matchOverride(channel, overrides).
// ============================================================
const ipcOverrides = createOverrideRegistry(function getProcessState(args) {
  const processId = parseRequestedProcessId(args);
  return getCoworkProcessRunningState(processId);
});

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
    // Hoisted to outer scope so webContents.ipc.handle() patch can reference them
    let originalHandle;
    let originalRemoveHandler;
    if (ipcMain && !global.__coworkIpcHandlePatched) {
      global.__coworkIpcHandlePatched = true;


      // Wire IPC tap before capturing originalHandle so the tap sees raw handler
      // behavior (before our overrides). Only active when CLAUDE_COWORK_IPC_TAP=1.
      if (ipcTap.enabled) {
        ipcTap.wrapHandle(ipcMain);
      }
      originalHandle = ipcMain.handle.bind(ipcMain);
      originalRemoveHandler = ipcMain.removeHandler ? ipcMain.removeHandler.bind(ipcMain) : (() => {});

      // Protect proactively registered channels from being removed by the asar
      if (ipcMain.removeHandler) {
        ipcMain.removeHandler = function(channel) {
          if (isProactiveChannel(channel)) return;
          return originalRemoveHandler(channel);
        };
      }

      ipcMain.handle = function(channel, handler) {
        // Extract UUID from first EIPC channel and proactively register all overrides.
        // Handlers like ComputerUseTcc are never registered by the asar on Linux
        // (macOS-only native dependency), so registration-time interception can't
        // catch them. Proactive registration on ipcMain provides a fallback.
        const uuid = extractEipcUuid(channel);
        if (uuid) {
          proactivelyRegisterOverrides(originalHandle, originalRemoveHandler, ipcOverrides, uuid);
        }

        const overrideHandler = matchOverride(channel, ipcOverrides);
        if (overrideHandler) {
          if (isProactiveChannel(channel)) return; // Already registered proactively
          return originalHandle(channel, overrideHandler);
        }
        return originalHandle(channel, asarAdapter.wrapHandler(channel, handler));
      };

      console.log('[Cowork] IPC handler interception enabled');
    }

    // Patch shell.openExternal to keep OAuth in the Electron session.
    // The asar tries ASWebAuth (macOS), fails on Linux, then falls back
    // to shell.openExternal, sending auth to the system browser where
    // cookies never reach Electron. Fix: open auth in a BrowserWindow
    // with an isolated session partition (bypasses asar's will-navigate
    // and webRequest handlers), then copy cookies back after completion.
    if (module.shell && !global.__coworkShellPatched) {
      global.__coworkShellPatched = true;
      const originalOpenExternal = module.shell.openExternal.bind(module.shell);
      let authInProgress = false; global.__coworkAuthInProgress = false;

      module.shell.openExternal = async function(url, options) {
        let parsed;
        try { parsed = new URL(url); } catch (_) {
          return originalOpenExternal(url, options);
        }
        // While auth popup is open, redirect openExternal calls back
        // into the auth window. The asar's will-navigate handler calls
        // preventDefault() + openExternal(), so we must re-navigate.
        if (authInProgress) {
          console.log('[Frame Fix] Auth redirect in-window:', parsed.hostname + parsed.pathname);
          const { BrowserWindow } = module;
          const wins = BrowserWindow.getAllWindows();
          for (const w of wins) {
            if (!w.isDestroyed() && w.webContents
                && (global.__coworkAuthWebContentsIds || new Set()).has(w.webContents.id)) {
              w.loadURL(url);
              return;
            }
          }
          return;
        }
        const isAuthUrl = parsed.hostname === 'claude.ai'
          && parsed.pathname.startsWith('/login/');
        if (!isAuthUrl) {
          return originalOpenExternal(url, options);
        }

        authInProgress = true;
        global.__coworkAuthInProgress = true;
        console.log('[Frame Fix] Auth intercepted, opening isolated popup');
        const { BrowserWindow, session } = module;
        const wins = BrowserWindow.getAllWindows();
        const mainWin = wins.find(w => !w.isDestroyed());
        if (!mainWin) {
          authInProgress = false; global.__coworkAuthInProgress = false;
          return originalOpenExternal(url, options);
        }

        const authSession = session.fromPartition('persist:oauth');
        parsed.searchParams.delete('open_in_browser');
        const cleanUrl = parsed.toString();

        const authWin = new BrowserWindow({
          width: 500,
          height: 700,
          parent: mainWin,
          show: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            session: authSession,
          },
        });

        global.__coworkAuthWebContentsIds = global.__coworkAuthWebContentsIds || new Set();
        global.__coworkAuthWebContentsIds.add(authWin.webContents.id);

        authWin.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
          console.log('[Frame Fix] Auth popup loading in-window:', popupUrl);
          authWin.loadURL(popupUrl);
          return { action: 'deny' };
        });
        authWin.webContents.setWindowOpenHandler = () => {};

        process.nextTick(() => {
          authWin.webContents.removeAllListeners('will-navigate');
          console.log('[Frame Fix] Stripped will-navigate from auth popup');
        });

        let authCodeCaptured = false;
        authWin.webContents.on('did-finish-load', () => {
          const currentUrl = authWin.webContents.getURL();
          if (!currentUrl.includes('accounts.google.com')) return;
          authWin.webContents.executeJavaScript(`
            (function() {
              if (window.__openerInjected) return;
              window.__openerInjected = true;
              window.opener = {
                postMessage: function(data, origin) {
                  document.title = '__AUTH_CODE__:' + JSON.stringify(data);
                },
                closed: false,
                location: { href: 'https://claude.ai' }
              };
            })();
          `).catch(() => {});
        });

        authWin.on('page-title-updated', async (_event, title) => {
          if (!title.startsWith('__AUTH_CODE__:') || authCodeCaptured) return;
          authCodeCaptured = true;
          const dataStr = title.slice('__AUTH_CODE__:'.length);
          console.log('[Frame Fix] Auth code captured, replaying to claude.ai');

          const replayOnLoad = () => {
            const url = authWin.webContents.getURL();
            if (!url.includes('claude.ai')) return;
            authWin.webContents.removeListener('did-finish-load', replayOnLoad);
            setTimeout(() => {
              console.log('[Frame Fix] Replaying auth postMessage to claude.ai');
              authWin.webContents.executeJavaScript(
                `window.postMessage(${dataStr}, 'https://accounts.google.com');`
              ).catch(e => console.error('[Frame Fix] Replay failed:', e.message));
            }, 2000);
          };
          authWin.webContents.on('did-finish-load', replayOnLoad);
          authWin.loadURL('https://claude.ai/login/app-google-auth');
        });

        if (!authSession.protocol.isProtocolHandled('storagerelay')) {
          authSession.protocol.handle('storagerelay', async (request) => {
            console.log('[Frame Fix] storagerelay intercepted:', request.url);
            return new Response('', { status: 200 });
          });
        }

        authWin.loadURL(cleanUrl);

        const finishAuth = async () => {
          console.log('[Frame Fix] Auth complete, copying cookies');
          try {
            const cookies = await authSession.cookies.get({});
            const mainSes = mainWin.webContents.session;
            let copied = 0;
            for (const c of cookies) {
              if (!c.domain.includes('claude.ai')
                  && !c.domain.includes('anthropic.com')) continue;
              try {
                await mainSes.cookies.set({
                  url: `https://${c.domain.replace(/^\./, '')}${c.path}`,
                  name: c.name,
                  value: c.value,
                  domain: c.domain,
                  path: c.path,
                  secure: c.secure,
                  httpOnly: c.httpOnly,
                  sameSite: c.sameSite,
                  expirationDate: c.expirationDate,
                });
                copied++;
              } catch (_) {}
            }
            console.log(`[Frame Fix] Copied ${copied} cookies`);
          } catch (e) {
            console.error('[Frame Fix] Cookie copy failed:', e.message);
          }
          authInProgress = false; global.__coworkAuthInProgress = false;
          if (!authWin.isDestroyed()) authWin.close();
          mainWin.webContents.loadURL('https://claude.ai/');
        };

        authWin.webContents.on('did-navigate', async (_event, navUrl) => {
          let dest;
          try { dest = new URL(navUrl); } catch (_) { return; }
          console.log('[Frame Fix] Auth did-navigate:', dest.hostname + dest.pathname);
          if (dest.hostname === 'claude.ai'
              && !dest.pathname.startsWith('/login')) {
            await finishAuth();
          }
        });
        authWin.on('closed', () => { authInProgress = false; global.__coworkAuthInProgress = false; });
      };
      console.log('[Frame Fix] shell.openExternal patched for OAuth');
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
          // Don't quit while OAuth is in progress (child windows closing)
          if (global.__coworkAuthInProgress) {
            console.log('[Shutdown] Window close during auth — ignoring');
            return;
          }
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
      // Don't install close-kills-app handler on auth windows
      const authIds = global.__coworkAuthWebContentsIds || new Set();
      const isAuthRelated = authIds.has(contents.id)
        || (owner && owner.webContents && authIds.has(owner.webContents.id));
      if (owner && !isAuthRelated) patchWindowClose(owner);
      patchEventDispatch(contents);

      // For auth-related child windows (Google OAuth popup), set a
      // permissive handler and then lock it by replacing the setter
      // with a no-op so the asar can't override it.
      if (isAuthRelated || (owner && owner.webContents && authIds.has(owner.webContents.id))) {
        authIds.add(contents.id);
        contents.setWindowOpenHandler(({ url: popupUrl }) => {
          console.log('[Frame Fix] Auth child navigation:', popupUrl);
          return { action: 'allow' };
        });
        contents.setWindowOpenHandler = () => {};
      }

      if (ipcTap.enabled) ipcTap.wrapWebContents(contents);


      // Patch webContents.ipc.handle() to intercept handler registration.
      // When the asar calls contents.ipc.handle(channel, handler), we
      // check the channel suffix against our override registry and
      // substitute our handler if matched. No UUID discovery needed.
      if (contents.ipc && typeof contents.ipc.handle === 'function' && !contents.ipc.__coworkHandlePatched) {
        contents.ipc.__coworkHandlePatched = true;
        const origIpcHandle = contents.ipc.handle.bind(contents.ipc);
        contents.ipc.handle = function(channel, handler) {
          // Extract UUID and proactively register overrides on ipcMain for
          // handlers the asar never registers (ComputerUseTcc, CoworkSpaces).
          const uuid = extractEipcUuid(channel);
          if (uuid) {
            proactivelyRegisterOverrides(originalHandle, originalRemoveHandler, ipcOverrides, uuid);
          }

          const overrideHandler = matchOverride(channel, ipcOverrides);
          if (overrideHandler) {
            return origIpcHandle(channel, overrideHandler);
          }
          return origIpcHandle(channel, asarAdapter.wrapHandler(channel, handler));
        };
        console.log('[Cowork] webContents.ipc.handle() patched for override interception');
      }
    }, 'web-contents-created');

    // Also patch on browser-window-created for certainty
    registerElectronAppListener(module, 'browser-window-created', (_event, win) => {
      const authIds = global.__coworkAuthWebContentsIds || new Set();
      const isAuth = win && win.webContents && authIds.has(win.webContents.id);
      if (!isAuth) patchWindowClose(win);
      if (win && win.webContents) {
        patchEventDispatch(win.webContents);
        if (process.env.CLAUDE_DEVTOOLS === '1' && !global.__coworkDevToolsOpened) {
          global.__coworkDevToolsOpened = true;
          win.webContents.once('dom-ready', () => {
            try { win.webContents.openDevTools({ mode: 'detach' }); } catch (_) {}
          });
          setupAssetDumper(win);
        }
      }
    }, 'browser-window-created');

    if (module.webContents && typeof module.webContents.getAllWebContents === 'function') {
      for (const contents of module.webContents.getAllWebContents()) {
        patchEventDispatch(contents);
      }
    }
    installLinuxMenuInterceptors(module);

  }

  return module;
};
