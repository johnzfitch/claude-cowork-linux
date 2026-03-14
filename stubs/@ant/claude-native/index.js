/**
 * Linux stub for @ant/claude-native
 *
 * This module intercepts require('@ant/claude-native') to prevent
 * the Mach-O binary from being loaded on Linux.
 *
 * Critical: Registers IPC handlers that the renderer expects.
 * Without these handlers, the app fails silently because the
 * native module init code never runs.
 *
 * Missing handlers identified from loader-trace.log:
 * - LocalAgentModeSessions_$_getAll
 * - ClaudeCode_$_prepare
 * - ClaudeVM_$_download/getDownloadStatus/getRunningStatus/start
 * - WindowControl_$_setThemeMode
 * - QuickEntry_$_setRecentChats
 * - Account_$_setAccountDetails
 * - DesktopIntl_$_getInitialLocale/requestLocaleChange
 */

const { ipcMain } = require('electron');
const EventEmitter = require('events');
const path = require('path');
const os = require('os');
const fs = require('fs');

const LOG_PREFIX = '[claude-native-stub]';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function trace(category, msg, data = null) {
  const entry = {
    ts: new Date().toISOString(),
    cat: category,
    msg,
    data
  };
  // Write to trace file if CLAUDE_NATIVE_TRACE is set
  if (process.env.CLAUDE_NATIVE_TRACE) {
    const logDir = process.env.CLAUDE_LOG_DIR ||
      path.join(os.homedir(), '.local/share/claude-cowork/logs');
    try {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(
        path.join(logDir, 'claude-native-trace.log'),
        JSON.stringify(entry) + '\n',
        { mode: 0o600 }
      );
    } catch (e) {}
  }
}

function canonicalizeResolvableHostPath(hostPath) {
  if (typeof hostPath !== 'string' || !path.isAbsolute(hostPath)) {
    return hostPath;
  }
  try {
    return fs.realpathSync(hostPath);
  } catch (_) {
    return hostPath;
  }
}

// ============================================================
// IPC Handler Registration
// These handlers are what the app expects to exist
// ============================================================

function safeHandle(channel, handler) {
  try {
    // Check if handler already exists
    // ipcMain doesn't expose a direct check, so we track our own
    ipcMain.handle(channel, handler);
    log(`  Registered: ${channel}`);
    return true;
  } catch (e) {
    if (e.message && e.message.includes('already registered')) {
      log(`  Skipped (exists): ${channel}`);
      return false;
    }
    log(`  Error registering ${channel}:`, e.message);
    return false;
  }
}

function registerCriticalHandlers() {
  log('Registering critical IPC handlers...');

  // Local Agent Mode Sessions
  safeHandle('LocalAgentModeSessions_$_getAll', async () => {
    trace('IPC', 'LocalAgentModeSessions_$_getAll called');
    return []; // Return empty sessions list
  });

  // Claude Code
  safeHandle('ClaudeCode_$_prepare', async () => {
    trace('IPC', 'ClaudeCode_$_prepare called');
    return { ready: false, reason: 'linux-stub' };
  });

  // Claude VM handlers
  const vmHandlers = {
    'ClaudeVM_$_download': async () => ({ status: 'unavailable', reason: 'linux-stub' }),
    'ClaudeVM_$_getDownloadStatus': async () => ({ status: 'unavailable' }),
    'ClaudeVM_$_getRunningStatus': async () => ({ running: false }),
    'ClaudeVM_$_start': async () => ({ started: false, reason: 'linux-stub' }),
  };

  for (const [channel, handler] of Object.entries(vmHandlers)) {
    safeHandle(channel, handler);
  }

  // Window Control
  safeHandle('WindowControl_$_setThemeMode', async (event, mode) => {
    trace('IPC', 'WindowControl_$_setThemeMode called', { mode });
    // Could integrate with system theme here
    return { success: true };
  });

  // Quick Entry
  safeHandle('QuickEntry_$_setRecentChats', async (event, chats) => {
    trace('IPC', 'QuickEntry_$_setRecentChats called', { count: chats?.length });
    return { success: true };
  });

  // Account
  safeHandle('Account_$_setAccountDetails', async (event, details) => {
    trace('IPC', 'Account_$_setAccountDetails called');
    return { success: true };
  });

  // Desktop Internationalization
  safeHandle('DesktopIntl_$_getInitialLocale', async () => {
    const locale = process.env.LANG?.split('.')[0] || 'en_US';
    trace('IPC', 'DesktopIntl_$_getInitialLocale called', { locale });
    return locale;
  });

  safeHandle('DesktopIntl_$_requestLocaleChange', async (event, locale) => {
    trace('IPC', 'DesktopIntl_$_requestLocaleChange called', { locale });
    return { success: true };
  });

  // Computer Use TCC (macOS permissions gate) — unsupported on Linux, return
  // a stable denied state instead of surfacing missing-handler errors.
  safeHandle('ComputerUseTcc_$_getState', async () => {
    trace('IPC', 'ComputerUseTcc_$_getState called');
    return {
      accessibility: 'denied',
      screenCapture: 'denied',
      canPrompt: false,
    };
  });

  safeHandle('ComputerUseTcc_$_requestAccess', async () => {
    trace('IPC', 'ComputerUseTcc_$_requestAccess called');
    return {
      success: false,
      accessibility: 'denied',
      screenCapture: 'denied',
      canPrompt: false,
    };
  });

  log('Critical IPC handlers registered.');
}

// ============================================================
// Keyboard constants (used by the app)
// ============================================================

const KeyboardKeys = {
  ESCAPE: 27,
  ENTER: 13,
  TAB: 9,
  BACKSPACE: 8,
  DELETE: 46,
  ARROW_UP: 38,
  ARROW_DOWN: 40,
  ARROW_LEFT: 37,
  ARROW_RIGHT: 39,
};

// ============================================================
// Auth request stub - falls back to system browser
//
// OAUTH COMPLIANCE:
// This class satisfies the IPC contract for @ant/claude-native's
// AuthRequest. It performs exactly ONE action: open a URL in the
// user's default browser via xdg-open.
//
// What this stub DOES:
//   - Opens the Anthropic OAuth URL in the system browser
//
// What this stub DOES NOT do:
//   - Intercept, capture, or process the OAuth callback
//   - Read, store, or forward any tokens or credentials
//   - Register any deep-link / protocol handler (claude://)
//   - Communicate with any server or external service
//
// The OAuth callback is handled entirely by the unmodified Claude
// Desktop renderer code, which manages its own session with
// Anthropic's servers. isAvailable() returns false to signal that
// no native auth window is available — the renderer falls back to
// its own browser-based OAuth flow.
// ============================================================

class AuthRequest extends EventEmitter {
  constructor() {
    super();
  }

  start(url, _callbackUrl) {
    // SECURITY: Validate URL is an Anthropic OAuth origin before opening
    const ALLOWED_AUTH_ORIGINS = [
      'https://claude.ai', 'https://auth.anthropic.com',
      'https://accounts.anthropic.com', 'https://console.anthropic.com',
    ];
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (_) {
      this.emit('error', new Error('Malformed auth URL'));
      return;
    }
    if (!ALLOWED_AUTH_ORIGINS.includes(parsedUrl.origin)) {
      console.error('[claude-native] Blocked non-Anthropic auth URL:', parsedUrl.origin);
      this.emit('error', new Error('Auth URL origin not in allowlist: ' + parsedUrl.origin));
      return;
    }

    // SECURITY: Use execFile (not exec) to prevent command injection
    const { execFile } = require('child_process');
    execFile('xdg-open', [url], (err) => {
      if (err) console.error('[claude-native] Failed to open browser:', err.message);
    });

    // Signal that native auth is unavailable — the renderer handles
    // the OAuth callback itself. We never see the token.
    setTimeout(() => {
      this.emit('error', new Error('Authentication via system browser - callback handled by renderer'));
    }, 100);
  }

  cancel() {
    this.emit('cancelled');
  }

  static isAvailable() {
    return false; // No native auth window — renderer handles OAuth directly
  }
}

// ============================================================
// Native binding stub
// The real module loads a .node file - we provide JS equivalents
// ============================================================

const nativeStub = {
  // Platform detection
  platform: 'darwin',   // Spoofed for Cowork support
  arch: 'arm64',        // Spoofed for Cowork support

  // System integration stubs
  getSystemTheme: () => 'dark',
  setDockBadge: (text) => { trace('NATIVE', 'setDockBadge', { text }); },
  showNotification: (title, body) => {
    trace('NATIVE', 'showNotification', { title, body });
    // Could use notify-send or node-notifier here
  },

  // File system integration
  revealInFinder: (filePath) => {
    trace('NATIVE', 'revealInFinder', { path: filePath });
    // xdg-open on Linux — open the directory itself when given a directory,
    // otherwise reveal the nearest existing parent for missing files.
    const { spawn } = require('child_process');
    let revealDir = filePath;
    try {
      const stats = fs.statSync(filePath);
      revealDir = stats.isDirectory()
        ? canonicalizeResolvableHostPath(filePath)
        : canonicalizeResolvableHostPath(path.dirname(filePath));
    } catch (_) {
      // Only fall back to immediate parent, not arbitrary ancestors
      const parentDir = path.dirname(filePath);
      try {
        fs.accessSync(parentDir, fs.constants.R_OK);
        revealDir = parentDir;
      } catch (_) {
        console.error('[claude-native] revealInFinder: target and parent missing:', filePath);
        return; // Don't open unrelated directories
      }
    }
    spawn('xdg-open', [revealDir], { detached: true, stdio: 'ignore' });
  },

  // Accessibility
  isAccessibilityEnabled: () => true,
  requestAccessibilityPermission: () => Promise.resolve(true),

  // Screen capture
  hasScreenCapturePermission: () => true,
  requestScreenCapturePermission: () => Promise.resolve(true),
};

// ============================================================
// Window management stubs
// ============================================================

function focus_window(handle) {
  // Could implement with xdotool or wmctrl
  log('focus_window not implemented on Linux');
  return false;
}

function get_active_window_handle() {
  // Could implement with xdotool
  return null;
}

// ============================================================
// Preferences stubs (Linux uses different config systems)
// ============================================================

function read_plist_value(domain, key) {
  return null;
}

function read_cf_pref_value(domain, key) {
  return null;
}

function read_registry_values(request) {
  return null;
}

function write_registry_value(request) {
  return false;
}

function get_app_info_for_file(filePath) {
  const resolvedPath = canonicalizeResolvableHostPath(filePath);
  const fallbackName = path.basename(resolvedPath || filePath || '');
  const info = {
    path: resolvedPath,
    name: fallbackName,
    displayName: fallbackName,
  };
  if (typeof resolvedPath !== 'string' || resolvedPath.length === 0) {
    return info;
  }
  try {
    const { execFileSync } = require('child_process');
    const mimeType = execFileSync('xdg-mime', ['query', 'filetype', resolvedPath], {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    if (mimeType) {
      info.mimeType = mimeType;
      try {
        const desktopFile = execFileSync('xdg-mime', ['query', 'default', mimeType], {
          encoding: 'utf-8',
          timeout: 2000,
        }).trim();
        if (desktopFile) {
          const desktopId = desktopFile.replace(/\.desktop$/i, '');
          info.desktopFile = desktopFile;
          info.id = desktopId;
          info.bundleIdentifier = desktopId;
          info.name = desktopId;
          info.displayName = desktopId;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return info;
}

// ============================================================
// Module initialization
// ============================================================

// NOTE: IPC handlers are registered in ipc-handler-setup.js (baked into app.asar)
// registerCriticalHandlers() is no longer called here

// NOTE: CoworkSpaces IPC handlers are registered in frame-fix-wrapper.js
// via getSyntheticIPCResponse() because ipcMain.handle() is patched and
// doesn't work correctly from this stub.

log('claude-native stub loaded successfully');

// ============================================================
// Quick Access overlay/dictation stubs (macOS-only UI features)
// ============================================================

const quickAccess = {
  overlay: {
    setLoggedIn: () => {},
    setRecentChats: () => {},
    setActiveChatId: () => {},
    toggle: () => {},
  },
  dictation: {
    setLanguage: () => {},
    show: () => {},
    stop: () => {},
    toggle: () => {},
  },
};

// ============================================================
// Midnight Owl stub (macOS power management feature)
// ============================================================

const midnightOwl = {
  setEnabled: () => {},
};

// ============================================================
// API credential stub
// ============================================================

const api = {
  setCredentials: () => {},
};

// ============================================================
// Module exports — must be an EventEmitter (app calls Br.on())
// ============================================================

const moduleExports = new EventEmitter();

Object.assign(moduleExports, {
  // Keyboard constants
  KeyboardKeys,

  // Auth
  AuthRequest,

  // Quick Access, Midnight Owl, API
  quickAccess,
  midnightOwl,
  api,

  // Window management (snake_case and camelCase)
  focus_window,
  focusWindow: focus_window,
  get_active_window_handle,
  getActiveWindowHandle: get_active_window_handle,

  // Preferences (snake_case and camelCase)
  read_plist_value,
  readPlistValue: read_plist_value,
  read_cf_pref_value,
  readCfPrefValue: read_cf_pref_value,
  read_registry_values,
  readRegistryValues: read_registry_values,
  write_registry_value,
  writeRegistryValue: write_registry_value,
  get_app_info_for_file,
  getAppInfoForFile: get_app_info_for_file,

  // Native stub functions
  ...nativeStub,
});

module.exports = moduleExports;
module.exports.default = module.exports;
