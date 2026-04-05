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
const fs = require('fs');
const { createDirs } = require('../../../cowork/dirs.js');
const { redactCredentials } = require('../../../cowork/credential_classifier.js');

const LOG_PREFIX = '[claude-native-stub]';
const DIRS = global.__coworkDirs || createDirs();

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function trace(category, msg, data = null) {
  const safeMsg = typeof msg === 'string' ? redactCredentials(msg) : msg;
  const safeData = data != null ? JSON.parse(redactCredentials(JSON.stringify(data))) : null;
  const entry = {
    ts: new Date().toISOString(),
    cat: category,
    msg: safeMsg,
    data: safeData,
  };
  // Write to trace file if CLAUDE_NATIVE_TRACE is set
  if (process.env.CLAUDE_NATIVE_TRACE) {
    const logDir = process.env.CLAUDE_LOG_DIR ||
      DIRS.coworkLogsDir;
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

log('claude-native stub loaded successfully');

// ============================================================
// Module exports
// ============================================================

module.exports = {
  // Keyboard constants
  KeyboardKeys,

  // Auth
  AuthRequest,

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
};

module.exports.default = module.exports;
