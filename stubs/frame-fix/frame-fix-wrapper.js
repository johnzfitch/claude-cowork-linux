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

// ── Bridge forwardEvent patch ──────────────────────────────────────────
// The asar's sessions-bridge class has a forwardEvent method that drops
// "result" and "stream_event" types. On macOS the VM's MITM proxy
// forwards those to CCR instead. On Linux there's no proxy, so we patch
// forwardEvent to stop dropping them — the bridge transport (already
// connected) will POST them to CCR directly.
//
// Detection: the bridge class extends EventEmitter and subscribes to
// "remote_session_start" immediately after creation. We intercept that
// subscription to find the instance and patch its forwardEvent.
(function patchBridgeForwardEvent() {
  const EventEmitter = require('events').EventEmitter;
  const origOn = EventEmitter.prototype.on;
  let patched = false;

  EventEmitter.prototype.on = function patchedOn(event) {
    if (!patched && event === 'remote_session_start' && typeof this.forwardEvent === 'function') {
      patched = true;
      const originalForwardEvent = this.forwardEvent.bind(this);
      const bridge = this;

      this.forwardEvent = async function patchedForwardEvent(e) {
        // The original filter drops result/stream_event. We need those
        // forwarded on Linux since there's no VM proxy to handle it.
        const session = bridge.activeSessions && bridge.activeSessions.get(e.sessionId);
        const msg = e.message;
        const msgType = msg && msg.type;
        console.log('[bridge-patch] forwardEvent called: type=' + e.type
          + ' msgType=' + msgType
          + ' sessionId=' + e.sessionId
          + ' hasSession=' + !!session
          + ' hasTransport=' + !!(session && session.transport));
        if (!session || e.type !== 'message' || !e.message) {
          return originalForwardEvent(e);
        }

        // For types the original would NOT drop, call the original
        if (msgType !== 'result' && msgType !== 'stream_event') {
          return originalForwardEvent(e);
        }

        // For result/stream_event: POST via the bridge transport directly
        if (!session.transport) {
          console.warn('[bridge-patch] No transport for session ' + e.sessionId + ', dropping ' + msgType);
          return;
        }

        // Build event with userMessageUuid if present (matches original logic)
        let eventPayload = msg;
        if (e.userMessageUuid && msgType !== 'user') {
          eventPayload = { ...msg, user_message_uuid: e.userMessageUuid };
        }

        // Serialize writes through the session's writeQueue (same pattern
        // as the original forwardEvent) to prevent interleaving.
        session.writeQueue = (session.writeQueue || Promise.resolve()).then(async () => {
          try {
            if (!session.transport) return;
            if (session.transport.closed) {
              console.warn('[bridge-patch] transport closed for ' + e.sessionId);
              return;
            }
            await session.transport.write(eventPayload);
            console.log('[bridge-patch] write OK: ' + msgType + ' session=' + e.sessionId);
          } catch (err) {
            console.warn('[bridge-patch] Failed to write ' + msgType + ' for session '
              + e.sessionId + ': ' + (err && err.message));
          }
        });
        await session.writeQueue;
      };

      console.log('[bridge-patch] forwardEvent patched on sessions-bridge instance');
      // Restore original .on to avoid overhead on all future subscriptions
      EventEmitter.prototype.on = origOn;
    }
    return origOn.apply(this, arguments);
  };
})();

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
      global.__coworkApplicationMenu = menu;
      hideLinuxMenuBars(electronModule);
      return undefined;
    };
  }

  menuApi.setApplicationMenu = function(menu) {
    global.__coworkApplicationMenu = menu;
    // Call the original so Electron's native binding stays intact
    if (originalSetAppMenu) {
      try { originalSetAppMenu(menu); } catch (_) {}
    }
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

// ── Global shortcut default ───────────────────────────────────────────
// The asar defaults to Alt+Space on darwin, Ctrl+Alt+Space on Linux.
// Since we spoof darwin, it picks Alt+Space which conflicts with most
// Linux WM launchers. Set the Linux default if the user hasn't chosen one.
try {
  const configPath = path.join(DIRS.claudeConfigRoot, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!cfg.globalShortcut) {
    cfg.globalShortcut = 'Ctrl+Alt+Space';
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log('[Frame Fix] Set default global shortcut to Ctrl+Alt+Space');
  }
} catch (_) {}

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
  {
    try {
      fs.mkdirSync(disclaimerDir, { recursive: true, mode: 0o755 });
      // The disclaimer wrapper must resolve macOS binary paths to Linux equivalents.
      // The asar constructs paths like claude.app/Contents/MacOS/claude because
      // we spoof darwin. Without this redirect, exec hits "Exec format error"
      // on the arm64 Mach-O binary and marketplace/plugin operations fail (exit 126).
      fs.writeFileSync(disclaimerBin, [
        '#!/bin/sh',
        'CMD="$1"',
        'shift',
        'case "$CMD" in',
        '  *claude.app/Contents/MacOS/claude|*claude.app/Contents/MacOS/Claude)',
        '    for c in \\',
        '      "$HOME/.local/bin/claude" \\',
        '      "$HOME/.local/share/mise/shims/claude" \\',
        '      "$HOME/.asdf/shims/claude" \\',
        '      "/usr/local/bin/claude" \\',
        '      "/usr/bin/claude"; do',
        '      [ -x "$c" ] && exec "$c" "$@"',
        '    done',
        '    echo "disclaimer: no Linux claude binary found" >&2',
        '    exit 1',
        '    ;;',
        'esac',
        'exec "$CMD" "$@"',
        '',
      ].join('\n'), { mode: 0o755 });
      console.log('[disclaimer] Installed platform-aware wrapper: ' + disclaimerBin);
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

// ── Platform spoofing (performance-critical) ──────────────────────────
// App code must see darwin/arm64; Electron/Node internals need the real
// platform. The old approach used new Error().stack on every access —
// stack trace generation is extremely expensive in V8 and process.platform
// is read thousands of times per second (CSS, feature detection, Node APIs).
//
// New approach: default to 'darwin' (the common case — app code dominates
// runtime reads) and only use the real platform during the brief module-
// loading phase when Electron internals call it. A reentrant guard flips
// to real values when OUR code is executing (frame-fix-wrapper, stubs).
let _inOurCode = false;

function withRealPlatform(fn) {
  _inOurCode = true;
  try { return fn(); }
  finally { _inOurCode = false; }
}

Object.defineProperty(process, 'platform', {
  get() { return _inOurCode ? REAL_PLATFORM : 'darwin'; },
  configurable: true
});

Object.defineProperty(process, 'arch', {
  get() { return _inOurCode ? REAL_ARCH : 'arm64'; },
  configurable: true
});

const originalOsPlatform = os.platform;
const originalOsArch = os.arch;

os.platform = function() { return _inOurCode ? originalOsPlatform.call(os) : 'darwin'; };
os.arch = function() { return _inOurCode ? originalOsArch.call(os) : 'arm64'; };

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

const { isIgnoredLiveEventType } = require('./cowork/session_normalization.js');

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

// Delegates to consolidated isIgnoredLiveEventType in session_normalization.js
function getIgnoredLiveMessageType(channel, payload) {
  return isIgnoredLiveEventType(channel, payload);
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

// ============================================================
// SINGLE-INSTANCE LOCK + PROTOCOL URL FORWARDING
// ============================================================
// The asar takes the macOS codepath (open-url event) because we
// spoof darwin. But Linux doesn't have macOS's Apple Event URL
// routing — launching claude:// URLs spawns a NEW Electron process.
// Fix: acquire a single-instance lock ourselves. When a second
// instance launches (e.g. from a claude:// protocol redirect after
// Google auth), extract the URL from argv, emit 'open-url' on the
// app (which the asar IS listening for), and quit the duplicate.
try {
  const { app } = require('electron');
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // We're the second instance — the first will get 'second-instance'
    console.log('[SingleInstance] Another instance is running, quitting');
    app.quit();
  } else {
    app.on('second-instance', (_event, argv, _workingDirectory) => {
      // Find the claude:// URL in the argv of the second instance
      const url = argv.find(a => a.startsWith('claude://'));
      if (url) {
        console.log('[SingleInstance] Forwarding protocol URL to open-url handler');
        // Emit open-url so the asar's existing handler processes it
        app.emit('open-url', { preventDefault() {} }, url);
      }
      // Focus the existing window
      const { BrowserWindow } = require('electron');
      const wins = BrowserWindow.getAllWindows();
      if (wins.length > 0) {
        const win = wins[0];
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
    console.log('[SingleInstance] Lock acquired, protocol URL forwarding enabled');
  }
} catch (e) {
  console.error('[SingleInstance] Failed to set up single-instance lock:', e.message);
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

  if (id === 'electron' && !global.__coworkElectronPatched) {
    global.__coworkElectronPatched = true;
    console.log('[Frame Fix] Intercepting electron module');

    // Spoof user agent to macOS so the webapp shows the correct branding
    // and auth flows (Google OAuth checks UA for platform compatibility).
    // Without this, the webapp sees "Linux" in the UA and falls through
    // to "Claude for Windows" or breaks Google auth.
    const app = resolveElectronApp(module);
    if (app) {
      const electronVersion = process.versions.electron || '33.0.0';
      const chromeVersion = process.versions.chrome || '130.0.0.0';
      app.userAgentFallback = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/' + (app.getVersion ? app.getVersion() : '1.0.0') + ' Chrome/' + chromeVersion + ' Electron/' + electronVersion + ' Safari/537.36';
      console.log('[Frame Fix] User agent spoofed to macOS');
    }

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

        // Debounce connect-to-mcp-server: the renderer fires duplicate connect
        // requests because mcp-server-auto-reconnect and mcpConfigChange both
        // arrive within ~1ms, each triggering a connect call. The asar's handler
        // already deduplicates (won't double-launch), but the IPC round-trips
        // add noise and latency. Coalesce calls for the same server within 2s.
        if (channel === 'connect-to-mcp-server') {
          const _mcpConnectTimes = new Map();
          const wrappedHandler = async function(event, serverName) {
            const now = Date.now();
            const lastConnect = _mcpConnectTimes.get(serverName);
            if (lastConnect && (now - lastConnect) < 2000) {
              return; // Already connecting this server
            }
            _mcpConnectTimes.set(serverName, now);
            return handler(event, serverName);
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

    // MCP reconnect dedup: suppress auto-reconnect sends that overlap with
    // mcpConfigChange (both fire within ~1ms, causing the renderer to send
    // duplicate connect-to-mcp-server calls for each server).
    let _lastMcpConfigChangeTs = 0;

    function patchEventDispatch(contents) {
      if (!contents || _sendPatched.has(contents) || typeof contents.send !== 'function') {
        return;
      }
      _sendPatched.add(contents);
      const originalSend = contents.send.bind(contents);
      contents.send = function(channel, ...args) {
        // Fallback filter — always available, even before orchestrator
        const ignoredType = getIgnoredLiveMessageType(channel, args[0]);
        if (ignoredType) {
          logIgnoredLiveMessage(channel, args[0], ignoredType);
          return false;
        }

        // MCP dedup: track mcpConfigChange timing and suppress overlapping
        // auto-reconnect sends. Both arrive within ~1ms; the config change
        // already tells the renderer which servers need reconnection.
        if (typeof channel === 'string') {
          if (channel.includes('mcpConfigChange')) {
            _lastMcpConfigChangeTs = Date.now();
          } else if (channel === 'mcp-server-auto-reconnect') {
            if (Date.now() - _lastMcpConfigChangeTs < 500) {
              return false;
            }
          }
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
      patchWindowClose(win);
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

    // ── Portal GlobalShortcuts (Wayland) ────────────────────────────────
    // Electron's globalShortcut.register() uses X11 XGrabKey which silently
    // fails on Wayland. Wrap it to route through xdg-desktop-portal instead.
    // On X11, leave the original alone — it works natively.
    if (REAL_PLATFORM === 'linux'
        && (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')
        && module.globalShortcut) {
      try {
        const { createPortalShortcuts } = require('./cowork/portal_shortcuts.js');
        const portal = createPortalShortcuts();
        if (portal.isAvailable()) {
          const origRegister = module.globalShortcut.register.bind(module.globalShortcut);
          const origUnregister = module.globalShortcut.unregister.bind(module.globalShortcut);
          const origUnregisterAll = module.globalShortcut.unregisterAll.bind(module.globalShortcut);
          const origIsRegistered = module.globalShortcut.isRegistered.bind(module.globalShortcut);

          module.globalShortcut.register = function(accelerator, callback) {
            portal.register(accelerator, callback);
            return true; // Match Electron's sync return
          };
          module.globalShortcut.unregister = function(accelerator) {
            portal.unregister(accelerator);
          };
          module.globalShortcut.unregisterAll = function() {
            portal.unregisterAll();
          };
          module.globalShortcut.isRegistered = function(accelerator) {
            return portal.isRegistered(accelerator);
          };

          // Clean up on quit
          const quitApp = resolveElectronApp(module);
          if (quitApp) {
            quitApp.on('will-quit', () => portal.destroy());
          }

          console.log('[Frame Fix] Global shortcuts routed through xdg-desktop-portal');
        } else {
          console.log('[Frame Fix] GlobalShortcuts portal not available, using Electron default');
        }
      } catch (e) {
        console.warn('[Frame Fix] Portal shortcuts setup failed:', e.message);
      }
    }

  }

  return module;
};
