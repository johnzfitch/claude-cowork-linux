/**
 * Linux stub for @ant/claude-swift
 *
 * This module replaces the native Swift addon that uses Apple's Virtualization
 * Framework on macOS. On Linux, we don't need a VM - we run the Claude Code
 * binary directly on the host system.
 *
 * Architecture:
 *   Claude Desktop (Electron) -> This Stub -> child_process.spawn() -> Claude Binary
 *
 * Key insight from reverse engineering:
 *   - The app imports this module and calls Si() which returns `module.default.vm`
 *   - Therefore, all VM methods must be on `this.vm`, not on the class itself
 *   - The app calls vm.setEventCallbacks() to register stdout/stderr/exit handlers
 *   - Then vm.spawn() to launch the Claude Code binary
 *
 * Path translations performed:
 *   - /usr/local/bin/claude -> ~/.config/Claude/claude-code-vm/2.1.5/claude
 *   - /sessions/... -> ~/.local/share/claude-cowork/sessions/...
 *
 * Security hardening applied:
 *   - Command injection prevention (execFile instead of exec)
 *   - Path traversal protection
 *   - Environment variable filtering
 *   - Secure file permissions
 *
 * Based on reverse engineering of swift_addon.node via pyghidra-lite
 */
console.log('[claude-swift-stub] LOADING MODULE - this confirms our stub is being used');
console.log('[claude-swift-stub] process.platform at load time:', process.platform);
console.log('[claude-swift-stub] Stack at load:', new Error().stack.split('\n').slice(1, 5).join('\n'));
console.log('[claude-swift-stub] Module filename:', __filename);
const EventEmitter = require("events");
const { spawn: nodeSpawn, spawnSync: nodeSpawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// SECURITY: Log to user-writable location with restricted permissions
const LOG_DIR = path.join(os.homedir(), '.local/share/claude-cowork/logs');
const TRACE_FILE = path.join(LOG_DIR, 'claude-swift-trace.log');

// Ensure log directory exists with secure permissions
try {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
} catch (e) {}

const TRACE_IO = process.env.CLAUDE_COWORK_TRACE_IO === '1';

function redactForLogs(input) {
  let text = String(input);

  // Common header / token formats
  text = text.replace(/(Authorization:\s*Bearer)\s+[^\s]+/gi, '$1 [REDACTED]');
  text = text.replace(/(Bearer)\s+[A-Za-z0-9._-]+/g, '$1 [REDACTED]');

  // JSON-style secrets
  text = text.replace(/("authorization"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
  text = text.replace(/("api[_-]?key"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
  text = text.replace(/("access[_-]?token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
  text = text.replace(/("refresh[_-]?token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');

  // Env var leakage
  text = text.replace(/(ANTHROPIC_API_KEY=)[^\s]+/g, '$1[REDACTED]');

  // Cookies
  text = text.replace(/(cookie:\s*)[^\n\r]+/gi, '$1[REDACTED]');

  return text;
}

function trace(msg) {
  const ts = new Date().toISOString();
  const safeMsg = redactForLogs(msg);
  const line = `[${ts}] ${safeMsg}\n`;
  console.log('[TRACE] ' + safeMsg);
  try {
    // SECURITY: Append with restrictive permissions
    fs.appendFileSync(TRACE_FILE, line, { mode: 0o600 });
  } catch(e) {}
}
trace("=== MODULE LOADING ===");
trace("Trace IO logging: " + (TRACE_IO ? "enabled (CLAUDE_COWORK_TRACE_IO=1)" : "disabled"));

// SECURITY: Allowlist of environment variables to pass to spawned process
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  'NODE_ENV', 'ELECTRON_RUN_AS_NODE',
  // Claude-specific
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'
];

function filterEnv(baseEnv, additionalEnv) {
  const filtered = {};
  for (const key of ENV_ALLOWLIST) {
    if (baseEnv[key] !== undefined) {
      filtered[key] = baseEnv[key];
    }
  }
  // Additional env vars from the app are trusted (come from Claude Desktop)
  if (additionalEnv) {
    Object.assign(filtered, additionalEnv);
  }
  return filtered;
}

// SECURITY: Validate path doesn't escape intended directory
function isPathSafe(basePath, targetPath) {
  const resolved = path.resolve(basePath, targetPath);
  return resolved.startsWith(path.resolve(basePath) + path.sep) || resolved === path.resolve(basePath);
}

// Sessions directory in user space (not /sessions)
const SESSIONS_BASE = path.join(os.homedir(), '.local/share/claude-cowork/sessions');

/**
 * Create mount symlinks for a session
 *
 * The additionalMounts object contains mount mappings:
 * {
 *   "mountName": { path: "relative/path/from/homedir", mode: "rw"|"ro" }
 * }
 *
 * We create symlinks at:
 *   ~/.local/share/claude-cowork/sessions/<session>/mnt/<mountName>
 * Pointing to:
 *   ~/<additionalMounts[mountName].path>
 *
 * Special cases:
 *   - Empty path ("") means homedir itself
 *   - "uploads" is a directory, not a symlink
 *   - "outputs" is typically handled separately
 */
function createMountSymlinks(sessionName, additionalMounts) {
  trace('=== CREATE MOUNT SYMLINKS ===');
  trace('Session name: ' + sessionName);
  trace('additionalMounts: ' + JSON.stringify(additionalMounts, null, 2));

  if (!sessionName) {
    trace('ERROR: No session name provided, cannot create mounts');
    return false;
  }

  if (!additionalMounts || typeof additionalMounts !== 'object') {
    trace('WARNING: No additionalMounts provided or invalid format');
    return false;
  }

  const sessionDir = path.join(SESSIONS_BASE, sessionName);
  const mntDir = path.join(sessionDir, 'mnt');

  trace('Session directory: ' + sessionDir);
  trace('Mount directory: ' + mntDir);

  // Create session and mnt directories
  try {
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      trace('Created session directory: ' + sessionDir);
    }
    if (!fs.existsSync(mntDir)) {
      fs.mkdirSync(mntDir, { recursive: true, mode: 0o700 });
      trace('Created mnt directory: ' + mntDir);
    }
  } catch (e) {
    trace('ERROR creating directories: ' + e.message);
    return false;
  }

  // Create symlinks for each mount
  const mountEntries = Object.entries(additionalMounts);
  trace('Processing ' + mountEntries.length + ' mount entries');

  for (const [mountName, mountInfo] of mountEntries) {
    trace('--- Processing mount: ' + mountName + ' ---');
    trace('  Mount info: ' + JSON.stringify(mountInfo));

    const mountPoint = path.join(mntDir, mountName);

    // Handle special cases
    if (mountName === 'uploads') {
      // uploads is a directory, not a symlink
      try {
        if (!fs.existsSync(mountPoint)) {
          fs.mkdirSync(mountPoint, { recursive: true, mode: 0o700 });
          trace('  Created uploads directory: ' + mountPoint);
        } else {
          trace('  Uploads directory already exists: ' + mountPoint);
        }
      } catch (e) {
        trace('  ERROR creating uploads directory: ' + e.message);
      }
      continue;
    }

    // Get the host path from the mount info
    let relativePath = '';
    if (typeof mountInfo === 'object' && mountInfo !== null) {
      relativePath = mountInfo.path || '';
    } else if (typeof mountInfo === 'string') {
      relativePath = mountInfo;
    }

    // Construct the full host path
    // Empty path means homedir itself
    const hostPath = relativePath === ''
      ? os.homedir()
      : path.join(os.homedir(), relativePath);

    trace('  Relative path: "' + relativePath + '"');
    trace('  Host path: ' + hostPath);
    trace('  Mount point: ' + mountPoint);

    // Verify host path exists
    if (!fs.existsSync(hostPath)) {
      trace('  WARNING: Host path does not exist: ' + hostPath);
      // Try to create it for output directories
      if (mountName === 'outputs' || mountInfo.mode === 'rw') {
        try {
          fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 });
          trace('  Created host directory: ' + hostPath);
        } catch (e) {
          trace('  ERROR creating host directory: ' + e.message);
          continue;
        }
      } else {
        continue;
      }
    }

    // Create symlink (remove existing if present)
    try {
      if (fs.existsSync(mountPoint)) {
        const stats = fs.lstatSync(mountPoint);
        if (stats.isSymbolicLink()) {
          const existingTarget = fs.readlinkSync(mountPoint);
          if (existingTarget === hostPath) {
            trace('  Symlink already exists and points to correct target');
            continue;
          }
          trace('  Removing existing symlink (pointed to: ' + existingTarget + ')');
          fs.unlinkSync(mountPoint);
        } else if (stats.isDirectory()) {
          trace('  Mount point is a directory, skipping symlink creation');
          continue;
        } else {
          trace('  Removing existing file at mount point');
          fs.unlinkSync(mountPoint);
        }
      }

      fs.symlinkSync(hostPath, mountPoint);
      trace('  SUCCESS: Created symlink ' + mountPoint + ' -> ' + hostPath);
    } catch (e) {
      trace('  ERROR creating symlink: ' + e.message);
    }
  }

  // Log final directory structure
  trace('=== FINAL MOUNT STRUCTURE ===');
  try {
    const entries = fs.readdirSync(mntDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(mntDir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(entryPath);
        trace('  ' + entry.name + ' -> ' + target);
      } else if (entry.isDirectory()) {
        trace('  ' + entry.name + '/ (directory)');
      } else {
        trace('  ' + entry.name + ' (file)');
      }
    }
  } catch (e) {
    trace('  ERROR listing mnt directory: ' + e.message);
  }
  trace('=== END MOUNT SYMLINKS ===');

  return true;
}

/**
 * Extract session name from spawn arguments or process name
 * The session name is used in paths like /sessions/<sessionName>/mnt/...
 */
function extractSessionName(processName, args) {
  // First try to extract from args (look for /sessions/<name>/ pattern)
  if (args && Array.isArray(args)) {
    for (const arg of args) {
      if (typeof arg === 'string') {
        const match = arg.match(/\/sessions\/([^\/]+)\//);
        if (match) {
          trace('Extracted session name from args: ' + match[1]);
          return match[1];
        }
      }
    }
  }

  // Fall back to process name
  if (processName) {
    trace('Using process name as session name: ' + processName);
    return processName;
  }

  trace('WARNING: Could not determine session name');
  return null;
}

class SwiftAddonStub extends EventEmitter {
  constructor() {
    super();
    trace('Constructor START');
    console.log('[claude-swift-stub] Constructor called');
    this._eventListener = null;
    this._guestConnected = true;  // Linux: always "connected" since we run directly on host
    this._processes = new Map();
    this._processIdCounter = 0;

    // Event callbacks for VM processes
    this._onStdout = null;
    this._onStderr = null;
    this._onExit = null;
    this._onError = null;
    this._onNetworkStatus = null;

    // Events system - native.events.setListener()
    this.events = {
      setListener: (callback) => {
        this._eventListener = callback;
        console.log('[claude-swift] Event listener registered');
      }
    };

    // Quick Access / Quick Entry UI
    this.quickAccess = {
      show: () => {
        console.log('[claude-swift] quickAccess.show()');
        this._emit('quickAccessShown');
      },
      hide: () => {
        console.log('[claude-swift] quickAccess.hide()');
        this._emit('quickAccessHidden');
      },
      isVisible: () => false,
      submit: (data) => {
        console.log('[claude-swift] quickAccess.submit()', data);
      }
    };

    // Notifications
    this.notifications = {
      requestAuth: () => {
        console.log('[claude-swift] notifications.requestAuth()');
        return Promise.resolve(true);
      },
      getAuthStatus: () => {
        return 'authorized';
      },
      show: (options) => {
        console.log('[claude-swift] notifications.show()', options && options.title);
        try {
          const title = String((options && options.title) || 'Claude').substring(0, 200);
          const body = String((options && options.body) || '').substring(0, 1000);
          // SECURITY: Use execFileSync with argument array to prevent command injection
          execFileSync('notify-send', [title, body], { timeout: 5000, stdio: 'ignore' });
        } catch (e) {
          // Notification failed - not critical
        }
        return Promise.resolve({ id: Date.now().toString() });
      },
      close: (id) => {
        console.log('[claude-swift] notifications.close()', id);
      }
    };

    // Desktop integration
    this.desktop = {
      captureScreenshot: (args) => {
        console.log('[claude-swift] desktop.captureScreenshot()', args);
        return Promise.resolve(null);
      },
      captureWindowScreenshot: (windowId) => {
        console.log('[claude-swift] desktop.captureWindowScreenshot()', windowId);
        return Promise.resolve(null);
      },
      getSessionId: () => {
        return 'linux-session-' + Date.now();
      },
      // Get list of open documents (Linux implementation)
      getOpenDocuments: () => {
        console.log('[claude-swift] desktop.getOpenDocuments()');
        // On Linux, we can check recent files or return empty
        // Could integrate with GTK recent files or track opened files
        return Promise.resolve([]);
      },
      // Get list of open windows
      getOpenWindows: () => {
        console.log('[claude-swift] desktop.getOpenWindows()');
        try {
          // Try wmctrl first, fall back to empty
          const { execFileSync } = require('child_process');
          const output = execFileSync('wmctrl', ['-l'], { encoding: 'utf-8', timeout: 2000 });
          const windows = output.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split(/\s+/);
            return {
              id: parts[0],
              desktop: parts[1],
              title: parts.slice(3).join(' ')
            };
          });
          return Promise.resolve(windows);
        } catch (e) {
          return Promise.resolve([]);
        }
      },
      // Open file with default application
      openFile: (filePath) => {
        console.log('[claude-swift] desktop.openFile()', filePath);
        // Translate /sessions/... paths to host paths
        let hostPath = filePath;
        if (typeof filePath === 'string' && filePath.startsWith('/sessions/')) {
          hostPath = path.join(SESSIONS_BASE, filePath.substring('/sessions/'.length));
          console.log('[claude-swift] desktop.openFile() translated to:', hostPath);
        }
        try {
          const { execFile } = require('child_process');
          execFile('xdg-open', [hostPath], (err) => {
            if (err) console.error('[claude-swift] openFile error:', err.message);
          });
          return Promise.resolve(true);
        } catch (e) {
          return Promise.resolve(false);
        }
      },
      // Reveal file in file manager
      revealFile: (filePath) => {
        console.log('[claude-swift] desktop.revealFile()', filePath);
        // Translate /sessions/... paths to host paths
        let hostPath = filePath;
        if (typeof filePath === 'string' && filePath.startsWith('/sessions/')) {
          hostPath = path.join(SESSIONS_BASE, filePath.substring('/sessions/'.length));
          console.log('[claude-swift] desktop.revealFile() translated to:', hostPath);
        }
        try {
          const { execFile } = require('child_process');
          const dir = path.dirname(hostPath);
          // Try nautilus first (GNOME), fall back to xdg-open
          execFile('nautilus', ['--select', hostPath], (err) => {
            if (err) {
              // Fall back to opening the directory
              execFile('xdg-open', [dir], () => {});
            }
          });
          return Promise.resolve(true);
        } catch (e) {
          return Promise.resolve(false);
        }
      },
      // Preview file (Quick Look equivalent)
      previewFile: (filePath) => {
        console.log('[claude-swift] desktop.previewFile()', filePath);
        // Translate /sessions/... paths to host paths
        let hostPath = filePath;
        if (typeof filePath === 'string' && filePath.startsWith('/sessions/')) {
          hostPath = path.join(SESSIONS_BASE, filePath.substring('/sessions/'.length));
          console.log('[claude-swift] desktop.previewFile() translated to:', hostPath);
        }
        try {
          const { execFile } = require('child_process');
          // Try gnome-sushi (GNOME Quick Look), fall back to xdg-open
          execFile('gnome-sushi', [hostPath], (err) => {
            if (err) {
              execFile('xdg-open', [hostPath], () => {});
            }
          });
          return Promise.resolve(true);
        } catch (e) {
          return Promise.resolve(false);
        }
      }
    };

    // Window management (macOS-specific, no-op on Linux)
    this.window = {
      setWindowButtonPosition: (browserWindow, x, y) => {
        console.log('[claude-swift] window.setWindowButtonPosition() - no-op on Linux');
        // macOS-only: positions traffic light buttons
        // Linux window managers handle this automatically
      },
      setThemeMode: (mode) => {
        console.log('[claude-swift] window.setThemeMode(' + mode + ')');
        // Would set system theme preference
      },
      setTrafficLightPosition: (x, y) => {
        console.log('[claude-swift] window.setTrafficLightPosition() - no-op on Linux');
      }
    };

    // Also add as top-level methods for direct calls
    this.setWindowButtonPosition = (browserWindow, x, y) => {
      console.log('[claude-swift] setWindowButtonPosition() - no-op on Linux');
    };

    this.setThemeMode = (mode) => {
      console.log('[claude-swift] setThemeMode(' + mode + ')');
    };

    // File system operations
    this.files = {
      // Read file contents
      read: (filePath) => {
        console.log('[claude-swift] files.read()', filePath);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          return Promise.resolve(content);
        } catch (e) {
          return Promise.reject(e);
        }
      },
      // Write file contents
      write: (filePath, content) => {
        console.log('[claude-swift] files.write()', filePath);
        try {
          fs.writeFileSync(filePath, content, 'utf-8');
          return Promise.resolve(true);
        } catch (e) {
          return Promise.reject(e);
        }
      },
      // Check if file exists
      exists: (filePath) => {
        return Promise.resolve(fs.existsSync(filePath));
      },
      // Get file stats
      stat: (filePath) => {
        console.log('[claude-swift] files.stat()', filePath);
        try {
          const stats = fs.statSync(filePath);
          return Promise.resolve({
            size: stats.size,
            isFile: stats.isFile(),
            isDirectory: stats.isDirectory(),
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime
          });
        } catch (e) {
          return Promise.reject(e);
        }
      },
      // List directory contents
      list: (dirPath) => {
        console.log('[claude-swift] files.list()', dirPath);
        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          return Promise.resolve(entries.map(e => ({
            name: e.name,
            isFile: e.isFile(),
            isDirectory: e.isDirectory(),
            path: path.join(dirPath, e.name)
          })));
        } catch (e) {
          return Promise.reject(e);
        }
      },
      // Watch file for changes
      watch: (filePath, callback) => {
        console.log('[claude-swift] files.watch()', filePath);
        try {
          const watcher = fs.watch(filePath, (eventType, filename) => {
            callback({ type: eventType, filename });
          });
          return { close: () => watcher.close() };
        } catch (e) {
          return { close: () => {} };
        }
      }
    };

    // API object (general purpose)
    this.api = {};

    // Midnight Owl (scheduling/time-based features)
    this.midnightOwl = {
      isEnabled: () => false,
      enable: () => {},
      disable: () => {},
      setEnabled: (enabled) => {
        console.log('[claude-swift] midnightOwl.setEnabled(' + enabled + ')');
      },
      getEnabled: () => false,
    };

    // VM Management (nested object)
    // CRITICAL: The app accesses methods via module.default.vm, so all methods must be here
    const self = this;

    /**
     * VM object - This is the main interface the app uses
     * The app calls Si() which returns module.default.vm
     */
    this.vm = {
      isSupported: () => {
        console.log('[claude-swift] vm.isSupported() called - returning true');
        trace('vm.isSupported() called');
        return true;
      },
      isGuestConnected: () => {
        console.log('[claude-swift] vm.isGuestConnected() called - returning', self._guestConnected);
        return self._guestConnected;
      },
      getRunningStatus: () => {
        const status = {
          running: true,
          connected: true,
          ready: true,
          status: 'running'
        };
        console.log('[claude-swift] vm.getRunningStatus() called - returning:', JSON.stringify(status));
        return status;
      },

      setEventCallbacks: (onStdout, onStderr, onExit, onError, onNetworkStatus) => {
        trace('vm.setEventCallbacks() CALLED with callbacks: stdout=' + !!onStdout + ' stderr=' + !!onStderr + ' exit=' + !!onExit);
        console.log('[claude-swift] vm.setEventCallbacks() called - REGISTERING CALLBACKS');
        console.log('[claude-swift] Callbacks: stdout=' + typeof onStdout + ' stderr=' + typeof onStderr + ' exit=' + typeof onExit);
        self._onStdout = onStdout;
        self._onStderr = onStderr;
        self._onExit = onExit;
        self._onError = onError;
        self._onNetworkStatus = onNetworkStatus;
        if (self._onNetworkStatus) {
          self._onNetworkStatus('connected');
        }
      },

      startVM: async (bundlePath, memoryGB) => {
        trace('vm.startVM() bundlePath=' + bundlePath + ' memoryGB=' + memoryGB);
        console.log('[claude-swift] vm.startVM() bundlePath=' + bundlePath + ' memoryGB=' + memoryGB);
        self._guestConnected = true;
        self._emit('guestConnectionChanged', { connected: true });
        self._emit('guestReady');
        return { success: true };
      },

      installSdk: async (subpath, version) => {
        console.log('[claude-swift] vm.installSdk() subpath=' + subpath + ' version=' + version);
        trace('vm.installSdk() subpath=' + subpath + ' version=' + version);
        return { success: true };
      },

      // Check VM download/install status
      getDownloadStatus: () => {
        console.log('[claude-swift] vm.getDownloadStatus() called');
        trace('vm.getDownloadStatus() called');
        return {
          status: 'ready',
          downloaded: true,
          installed: true,
          progress: 100
        };
      },

      // Check if SDK needs update
      needsUpdate: () => {
        console.log('[claude-swift] vm.needsUpdate() called');
        return false;
      },

      /**
       * Spawn a process - This is called to launch the Claude Code binary
       *
       * Parameters (reverse-engineered from Claude Desktop):
       *   id: string - unique process identifier
       *   processName: string - human-readable name (e.g., "stoic-busy-hawking")
       *   command: string - command to run (e.g., "/usr/local/bin/claude")
       *   args: string[] - command arguments
       *   options: object - spawn options (cwd, etc.)
       *   envVars: object - environment variables
       *   additionalMounts: object - mount mappings { mountName: { path, mode } }
       *   isResume: boolean - whether resuming an existing session
       *   allowedDomains: string[] - allowed network domains
       *   sharedCwdPath: string - shared working directory path
       */
      spawn: (id, processName, command, args, options, envVars, additionalMounts, isResume, allowedDomains, sharedCwdPath) => {
        trace('=== VM.SPAWN CALLED ===');
        trace('vm.spawn() id=' + id);
        trace('vm.spawn() processName=' + processName);
        trace('vm.spawn() command=' + command);
        trace('vm.spawn() args=' + JSON.stringify(args));
        trace('vm.spawn() additionalMounts=' + JSON.stringify(additionalMounts));
        trace('vm.spawn() isResume=' + isResume);
        trace('vm.spawn() sharedCwdPath=' + sharedCwdPath);

        // Extract session name and create mount symlinks BEFORE translating paths
        const sessionName = extractSessionName(processName, args);
        if (sessionName && additionalMounts) {
          trace('Creating mount symlinks for session: ' + sessionName);
          createMountSymlinks(sessionName, additionalMounts);
        } else {
          trace('Skipping mount symlink creation: sessionName=' + sessionName + ', hasAdditionalMounts=' + !!additionalMounts);
        }

        // SECURITY: Validate command is the expected Claude binary
        let hostCommand = command;
        if (command === '/usr/local/bin/claude') {
          hostCommand = path.join(os.homedir(), '.config/Claude/claude-code-vm/2.1.5/claude');
          trace('Translated command: ' + command + ' -> ' + hostCommand);
        } else {
          // SECURITY: Only allow the expected command
          trace('SECURITY: Unexpected command blocked: ' + command);
          if (self._onError) self._onError(id, 'Unexpected command: ' + command, '');
          return { success: false, error: 'Unexpected command' };
        }

        // SECURITY: Verify binary exists and is in expected location
        const expectedDir = path.join(os.homedir(), '.config/Claude/claude-code-vm');
        if (!hostCommand.startsWith(expectedDir)) {
          trace('SECURITY: Command outside expected directory: ' + hostCommand);
          if (self._onError) self._onError(id, 'Invalid binary path', '');
          return { success: false, error: 'Invalid binary path' };
        }

        // Translate VM paths in args with path traversal protection
        let hostArgs = (args || []).map(arg => {
          if (typeof arg === 'string' && arg.startsWith('/sessions/')) {
            // Extract session path component
            const sessionPath = arg.substring('/sessions/'.length);

            // SECURITY: Validate no path traversal
            if (sessionPath.includes('..') || !isPathSafe(SESSIONS_BASE, sessionPath)) {
              trace('SECURITY: Path traversal blocked: ' + arg);
              return arg; // Return original (will fail gracefully)
            }

            const translated = path.join(SESSIONS_BASE, sessionPath);
            trace('Translated arg: ' + arg + ' -> ' + translated);
            return translated;
          }
          return arg;
        });

        // Ensure sessions directory exists with secure permissions
        try {
          if (!fs.existsSync(SESSIONS_BASE)) {
            fs.mkdirSync(SESSIONS_BASE, { recursive: true, mode: 0o700 });
            trace('Created sessions dir: ' + SESSIONS_BASE);
          }
        } catch (e) {
          trace('Failed to create sessions dir: ' + e.message);
        }

        // Translate sharedCwdPath if it's a VM path
        let hostCwdPath = sharedCwdPath;
        if (typeof sharedCwdPath === 'string' && sharedCwdPath.startsWith('/sessions/')) {
          const sessionPath = sharedCwdPath.substring('/sessions/'.length);
          if (!sessionPath.includes('..') && isPathSafe(SESSIONS_BASE, sessionPath)) {
            hostCwdPath = path.join(SESSIONS_BASE, sessionPath);
            trace('Translated sharedCwdPath: ' + sharedCwdPath + ' -> ' + hostCwdPath);
          }
        }
        trace('vm.spawn() sharedCwdPath=' + sharedCwdPath + ' hostCwdPath=' + hostCwdPath);

        console.log('[claude-swift] vm.spawn() id=' + id + ' cmd=' + hostCommand);
        return self.spawn(id, processName, hostCommand, hostArgs, options, envVars, additionalMounts, isResume, allowedDomains, hostCwdPath);
      },

      kill: (id, signal) => {
        console.log('[claude-swift] vm.kill(' + id + ', ' + signal + ')');
        return Promise.resolve(self.killProcess(id));
      },

      writeStdin: (id, data) => {
        console.log('[claude-swift] vm.writeStdin(' + id + ')');
        return Promise.resolve(self.writeToProcess(id, data));
      },

      start: () => {
        console.log('[claude-swift] vm.start()');
        self._guestConnected = true;
        self._emit('guestConnectionChanged', { connected: true });
        self._emit('guestReady');
        return Promise.resolve({ success: true });
      },

      stop: () => {
        console.log('[claude-swift] vm.stop()');
        self._guestConnected = false;
        self._emit('guestConnectionChanged', { connected: false });
        return Promise.resolve({ success: true });
      },

      sendCommand: (cmd) => {
        console.log('[claude-swift] vm.sendCommand()', cmd);
        return Promise.resolve({});
      },

      /**
       * Read file from VM filesystem
       * The app calls this as readFile(sessionName, fullVmPath)
       * Returns base64-encoded content
       */
      readFile: async (sessionName, vmPath) => {
        trace('vm.readFile() sessionName=' + sessionName + ' vmPath=' + vmPath);

        // Translate VM path to host path
        let hostPath = vmPath;
        if (typeof vmPath === 'string' && vmPath.startsWith('/sessions/')) {
          const sessionPath = vmPath.substring('/sessions/'.length);
          if (sessionPath.includes('..') || !isPathSafe(SESSIONS_BASE, sessionPath)) {
            trace('SECURITY: Path traversal blocked in readFile: ' + vmPath);
            throw new Error('Invalid path');
          }
          hostPath = path.join(SESSIONS_BASE, sessionPath);
        }

        trace('vm.readFile() translated to: ' + hostPath);

        try {
          const content = fs.readFileSync(hostPath);
          // Return base64-encoded content as the app expects
          return content.toString('base64');
        } catch (e) {
          trace('vm.readFile() error: ' + e.message);
          throw e;
        }
      },

      /**
       * Write file to VM filesystem
       * The app calls this as writeFile(sessionName, fullVmPath, base64Content)
       * Content is base64-encoded
       */
      writeFile: async (sessionName, vmPath, base64Content) => {
        trace('vm.writeFile() sessionName=' + sessionName + ' vmPath=' + vmPath);

        // Translate VM path to host path
        let hostPath = vmPath;
        if (typeof vmPath === 'string' && vmPath.startsWith('/sessions/')) {
          const sessionPath = vmPath.substring('/sessions/'.length);
          if (sessionPath.includes('..') || !isPathSafe(SESSIONS_BASE, sessionPath)) {
            trace('SECURITY: Path traversal blocked in writeFile: ' + vmPath);
            throw new Error('Invalid path');
          }
          hostPath = path.join(SESSIONS_BASE, sessionPath);
        }

        trace('vm.writeFile() translated to: ' + hostPath);

        try {
          // Ensure parent directory exists
          const dir = path.dirname(hostPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          }

          // Decode base64 and write
          const content = Buffer.from(base64Content, 'base64');
          fs.writeFileSync(hostPath, content, { mode: 0o600 });
          return true;
        } catch (e) {
          trace('vm.writeFile() error: ' + e.message);
          throw e;
        }
      },

      /**
       * Check if debug logging is enabled
       */
      isDebugLoggingEnabled: () => {
        return process.env.CLAUDE_COWORK_DEBUG === '1';
      },

      /**
       * Enable/disable debug logging
       */
      setDebugLogging: (enabled) => {
        console.log('[claude-swift] vm.setDebugLogging(' + enabled + ')');
        // In our stub, this is controlled by env var, so we just log
      },

      /**
       * Stop the VM
       */
      stopVM: async () => {
        console.log('[claude-swift] vm.stopVM()');
        for (const entry of self._processes) {
          try { entry[1].kill('SIGTERM'); } catch (e) {}
        }
        self._processes.clear();
        self._guestConnected = false;
        self._emit('guestConnectionChanged', { connected: false });
        return { success: true };
      },

      /**
       * Add approved OAuth token (new in 1.1.381)
       * This is used to approve OAuth tokens for VM operations
       */
      addApprovedOauthToken: async (token) => {
        trace('vm.addApprovedOauthToken() token=<redacted>');
        console.log('[claude-swift] vm.addApprovedOauthToken() called');
        // Store the token for future use
        // On Linux, we don't have a VM, so we just acknowledge the token
        return { success: true };
      },

      /**
       * Mount a path at runtime (updated in 1.1.381 to include mode parameter)
       * Creates a symlink from the VM path to the host path
       *
       * @param {string} processId - The process ID
       * @param {string} subpath - Subpath within the session (e.g., "mnt/workspace")
       * @param {string} pathName - The VM path to mount (e.g., "/sessions/foo/mnt/workspace")
       * @param {string} mode - Mount mode: "ro" (read-only) or "rw" (read-write)
       */
      mountPath: async (processId, subpath, pathName, mode) => {
        trace('vm.mountPath() processId=' + processId + ' subpath=' + subpath + ' pathName=' + pathName + ' mode=' + mode);
        console.log('[claude-swift] vm.mountPath() processId=' + processId + ' subpath=' + subpath + ' mode=' + mode);

        // Translate VM path to host path
        if (typeof pathName === 'string' && pathName.startsWith('/sessions/')) {
          const sessionPath = pathName.substring('/sessions/'.length);

          // SECURITY: Validate no path traversal
          if (sessionPath.includes('..') || !isPathSafe(SESSIONS_BASE, sessionPath)) {
            trace('SECURITY: Path traversal blocked in mountPath: ' + pathName);
            throw new Error('Invalid path');
          }

          const hostPath = path.join(SESSIONS_BASE, sessionPath);
          trace('vm.mountPath() translated to: ' + hostPath);

          // Ensure parent directory exists
          try {
            const dir = path.dirname(hostPath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
              trace('vm.mountPath() created parent directory: ' + dir);
            }
          } catch (e) {
            trace('vm.mountPath() error creating parent directory: ' + e.message);
            throw e;
          }

          // Create the mount point (directory or symlink as needed)
          try {
            if (!fs.existsSync(hostPath)) {
              // Create directory with appropriate permissions based on mode
              const dirMode = mode === 'ro' ? 0o500 : 0o700;
              fs.mkdirSync(hostPath, { recursive: true, mode: dirMode });
              trace('vm.mountPath() created mount point: ' + hostPath + ' (mode: ' + mode + ')');
            }
            return { success: true };
          } catch (e) {
            trace('vm.mountPath() error: ' + e.message);
            throw e;
          }
        } else {
          trace('vm.mountPath() error: pathName does not start with /sessions/');
          throw new Error('Invalid pathName: must start with /sessions/');
        }
      }
    };

    trace('Constructor COMPLETE. vm.setEventCallbacks=' + typeof this.vm.setEventCallbacks);
    console.log('[claude-swift-stub] Constructor complete. vm.setEventCallbacks type:', typeof this.vm.setEventCallbacks);
  }

  // TOP-LEVEL METHODS (for API compatibility)
  setEventCallbacks(onStdout, onStderr, onExit, onError, onNetworkStatus) {
    console.log('[claude-swift] setEventCallbacks() called - REGISTERING CALLBACKS');
    this._onStdout = onStdout;
    this._onStderr = onStderr;
    this._onExit = onExit;
    this._onError = onError;
    this._onNetworkStatus = onNetworkStatus;
    if (this._onNetworkStatus) {
      this._onNetworkStatus('connected');
    }
  }

  async startVM(bundlePath, memoryGB) {
    console.log('[claude-swift] startVM() bundlePath=' + bundlePath + ' memoryGB=' + memoryGB);
    this._guestConnected = true;
    this._emit('guestConnectionChanged', { connected: true });
    return { success: true };
  }

  async installSdk(subpath, version) {
    console.log('[claude-swift] installSdk() subpath=' + subpath + ' version=' + version);
    return { success: true };
  }

  kill(id, signal) {
    console.log('[claude-swift] kill(' + id + ', ' + signal + ')');
    return this.killProcess(id);
  }

  writeStdin(id, data) {
    return this.writeToProcess(id, data);
  }

  spawn(id, processName, command, args, options, envVars, additionalMounts, isResume, allowedDomains, sharedCwdPath) {
    console.log('[claude-swift] spawn() id=' + id + ' cmd=' + command + ' args=' + JSON.stringify(args));
    try {
      // SECURITY: Filter environment variables
      const env = filterEnv(process.env, envVars);
      const cwd = sharedCwdPath || (options && options.cwd) || process.cwd();
      const proc = nodeSpawn(command, args || [], Object.assign({ cwd: cwd, env: env, stdio: ['pipe', 'pipe', 'pipe'] }, options || {}));
      this._processes.set(id, proc);

      const self = this;
      let stdoutBuffer = '';
      let stderrBuffer = '';

      if (proc.stdout) {
        proc.stdout.on('data', function(data) {
          stdoutBuffer += data.toString();
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop();
          for (const line of lines) {
            if (line.trim() && self._onStdout) {
              if (TRACE_IO) {
                trace('stdout line: ' + line.substring(0, 200) + (line.length > 200 ? '...' : ''));
              }
              self._onStdout(id, line + '\n');
            }
          }
        });
      }
      if (proc.stderr) {
        proc.stderr.on('data', function(data) {
          stderrBuffer += data.toString();
          const lines = stderrBuffer.split('\n');
          stderrBuffer = lines.pop();
          for (const line of lines) {
            if (line.trim() && self._onStderr) {
              if (TRACE_IO) {
                trace('stderr line: ' + line.substring(0, 200) + (line.length > 200 ? '...' : ''));
              }
              self._onStderr(id, line + '\n');
            }
          }
        });
      }
      proc.on('exit', function(code, signal) {
        if (stdoutBuffer.trim() && self._onStdout) {
          self._onStdout(id, stdoutBuffer);
        }
        if (stderrBuffer.trim() && self._onStderr) {
          self._onStderr(id, stderrBuffer);
        }
        console.log('[claude-swift] Process ' + id + ' exited: code=' + code + ' signal=' + signal);
        trace('Process ' + id + ' exited: code=' + code);
        if (self._onExit) self._onExit(id, code || 0, signal || '');
        self._processes.delete(id);
      });
      proc.on('error', function(err) {
        console.error('[claude-swift] Process ' + id + ' error:', err);
        if (self._onError) self._onError(id, err.message, err.stack);
      });

      return { success: true, pid: proc.pid };
    } catch (err) {
      console.error('[claude-swift] spawn error:', err);
      if (this._onError) this._onError(id, err.message, err.stack);
      throw err;
    }
  }

  spawnSync(command, args, options) {
    console.log('[claude-swift] spawnSync() cmd=' + command);
    try {
      const result = nodeSpawnSync(command, args || [], Object.assign({ encoding: 'utf-8' }, options || {}));
      return { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal, error: result.error };
    } catch (err) {
      console.error('[claude-swift] spawnSync error:', err);
      return { error: err, status: 1 };
    }
  }

  stopVM() {
    console.log('[claude-swift] stopVM()');
    for (const entry of this._processes) {
      try { entry[1].kill('SIGTERM'); } catch (e) {}
    }
    this._processes.clear();
    this._guestConnected = false;
    this._emit('guestConnectionChanged', { connected: false });
  }

  killProcess(id) {
    console.log('[claude-swift] killProcess(' + id + ')');
    const proc = this._processes.get(id);
    if (proc) {
      try { proc.kill('SIGTERM'); } catch (e) {}
      this._processes.delete(id);
    }
  }

  cancelProcess(id) {
    return this.killProcess(id);
  }

  writeToProcess(id, data) {
    console.log('[claude-swift] writeToProcess(' + id + ')');
    const proc = this._processes.get(id);
    if (proc && proc.stdin) {
      // Translate /sessions/... paths to host paths in stdin data
      let translatedData = data;
      if (typeof data === 'string' && data.includes('/sessions/')) {
        translatedData = data.replace(/\/sessions\//g, SESSIONS_BASE + '/');
        if (TRACE_IO) {
          trace('writeToProcess: translated /sessions/ paths in stdin');
        }
      }
      proc.stdin.write(translatedData);
    }
  }

  _emit(eventName, payload) {
    if (this._eventListener) this._eventListener(eventName, payload);
    this.emit(eventName, payload);
  }

  isGuestConnected() {
    return this._guestConnected;
  }

  getRunningStatus() {
    return { running: this._guestConnected, connected: this._guestConnected };
  }
}

const instance = new SwiftAddonStub();
trace('Instance created. vm=' + typeof instance.vm + ' vm.setEventCallbacks=' + typeof instance.vm.setEventCallbacks);
console.log('[claude-swift-stub] Exporting instance. Instance type:', typeof instance, 'setEventCallbacks:', typeof instance.setEventCallbacks);
console.log('[claude-swift-stub] instance.on:', typeof instance.on);
console.log('[claude-swift-stub] instance instanceof EventEmitter:', instance instanceof EventEmitter);

// Emit ready events after a short delay to simulate VM startup
setTimeout(() => {
  console.log('[claude-swift-stub] Emitting guestConnectionChanged and guestReady events');
  instance._emit('guestConnectionChanged', { connected: true });
  instance._emit('guestReady');
}, 100);

// ESM import() of CommonJS returns a module namespace object where:
// - .default is set to module.exports
// - Named exports are set to module.exports properties
//
// When app does: const mod = (await import("@ant/claude-swift")).default
// It gets module.exports, which is our instance.
//
// The issue is that our instance IS an EventEmitter, so .on() should work.
// Let's log this for debugging:

module.exports = instance;
module.exports.default = instance;

// For ESM compatibility - mark as ES module
Object.defineProperty(module.exports, '__esModule', { value: true });

// Explicitly bind EventEmitter methods to ensure they work
// This may help if 'this' binding is getting lost somewhere
const origOn = instance.on.bind(instance);
const origEmit = instance.emit.bind(instance);
instance.on = function(...args) {
  console.log('[claude-swift-stub] .on() called with event:', args[0]);
  return origOn(...args);
};
instance.emit = function(...args) {
  console.log('[claude-swift-stub] .emit() called with event:', args[0]);
  return origEmit(...args);
};

trace('Module exports set. default.vm.setEventCallbacks=' + typeof module.exports.default.vm.setEventCallbacks);
console.log('[claude-swift-stub] module.exports.on:', typeof module.exports.on);
console.log('[claude-swift-stub] module.exports.default.on:', typeof module.exports.default.on);
console.log('[claude-swift-stub] Verifying .on is callable:', typeof instance.on === 'function' ? 'YES' : 'NO');
