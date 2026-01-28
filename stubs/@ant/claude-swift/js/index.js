/**
 * @ant/claude-swift stub for Linux
 *
 * This replaces the macOS Swift native module with JS stubs.
 * The app accesses this module in various ways - we need to handle them all.
 *
 * Key insight from debug: setupSwiftNotificationHandlers calls e.on()
 * where 'e' is likely the result of accessing a property on this module.
 *
 * CRITICAL: Every sub-object must be an EventEmitter with .on(), .emit(), etc.
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn: nodeSpawn, execFileSync } = require('child_process');

const LOG_PREFIX = '[claude-swift-stub]';
const TRACE_ENABLED = !!process.env.CLAUDE_TRACE; // Controlled by env var

// Sessions directory in user space
const SESSIONS_BASE = path.join(os.homedir(), '.local/share/claude-cowork/sessions');
const LOG_DIR = path.join(os.homedir(), '.local/share/claude-cowork/logs');

// Log rotation settings
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const LOG_FILE = path.join(LOG_DIR, 'claude-swift-trace.log');

// Cache for created directories
const CREATED_DIRS = new Set();

// Resolve Claude binary path once at startup
const CLAUDE_BINARY = path.join(os.homedir(), '.config/Claude/claude-code-vm/2.1.5/claude');

// Ensure directories exist
try {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SESSIONS_BASE, { recursive: true, mode: 0o700 });
  CREATED_DIRS.add(LOG_DIR);
  CREATED_DIRS.add(SESSIONS_BASE);
} catch (e) {}

// Trace logging with rotation
function trace(category, msg, data = null) {
  if (!TRACE_ENABLED) return;

  const entry = `[TRACE:${category}] ${msg}`;
  console.log(entry);

  try {
    // Check log size and rotate if needed
    try {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > MAX_LOG_SIZE) {
        fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
      }
    } catch (e) {
      // File doesn't exist yet, OK
    }

    fs.appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] ${entry}${data ? ' ' + JSON.stringify(data) : ''}\n`,
      { mode: 0o600 }
    );
  } catch (e) {
    // Don't fail if logging fails
  }
}

console.log(`${LOG_PREFIX} LOADING MODULE`);
console.log(`${LOG_PREFIX} process.platform at load time: ${process.platform}`);

/**
 * Create an EventEmitter-based object that also has all the stub methods.
 * This is the key - every sub-object must have .on(), .emit(), etc.
 */
function createEmitterObject(name, extraMethods = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  // Add name for debugging
  emitter._stubName = name;

  // Add common stub methods
  Object.assign(emitter, {
    // Async stubs that return resolved promises
    initialize: async () => { trace(name, 'initialize()'); return true; },
    shutdown: async () => { trace(name, 'shutdown()'); return true; },
    getState: async () => { trace(name, 'getState()'); return {}; },
    setState: async (state) => { trace(name, 'setState()', state); return true; },

    // Sync stubs
    isAvailable: () => true,
    isEnabled: () => true,
    isSupported: () => true,
    enable: () => { trace(name, 'enable()'); },
    disable: () => { trace(name, 'disable()'); },

    ...extraMethods,
  });

  // Override emit to log
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = function(event, ...args) {
    trace(name, `emit('${event}')`, args.length > 0 ? args : null);
    return originalEmit(event, ...args);
  };

  return emitter;
}

// ============================================================
// Sub-modules - each is an EventEmitter with stub methods
// ============================================================

const notifications = createEmitterObject('notifications', {
  show: async (options) => {
    trace('notifications', 'show()', options?.title);
    try {
      const title = String(options?.title || 'Claude').substring(0, 200);
      const body = String(options?.body || '').substring(0, 1000);
      execFileSync('notify-send', [title, body], { timeout: 5000, stdio: 'ignore' });
    } catch (e) {}
    return { id: Date.now().toString() };
  },
  hide: async (id) => { trace('notifications', 'hide()', { id }); },
  hideAll: async () => { trace('notifications', 'hideAll()'); },
  close: (id) => { trace('notifications', 'close()', { id }); },
  requestAuth: () => Promise.resolve(true),
  getAuthStatus: () => 'authorized',
});

const vm = createEmitterObject('vm', {
  start: async () => { trace('vm', 'start()'); return { success: true }; },
  stop: async () => { trace('vm', 'stop()'); return { success: true }; },
  startVM: async (bundlePath, memoryGB) => {
    trace('vm', 'startVM()', { bundlePath, memoryGB });
    return { success: true };
  },
  stopVM: async () => { trace('vm', 'stopVM()'); return { success: true }; },
  getStatus: async () => ({ running: true, connected: true, supported: true, status: 'supported' }),
  getRunningStatus: () => ({ running: true, connected: true, ready: true, status: 'running' }),
  getDownloadStatus: () => ({ status: 'ready', downloaded: true, installed: true, progress: 100 }),
  getSupportStatus: () => {
    trace('vm', 'getSupportStatus() returning supported');
    return 'supported';
  },
  isGuestConnected: () => true,
  isSupported: () => true,
  needsUpdate: () => false,
  installSdk: async () => ({ success: true }),
  sendMessage: async (msg) => { trace('vm', 'sendMessage()', msg); return null; },

  setEventCallbacks: (onStdout, onStderr, onExit, onError, onNetworkStatus) => {
    trace('vm', 'setEventCallbacks()', { hasStdout: !!onStdout, hasStderr: !!onStderr });
    // Store callbacks for spawn()
    vm._onStdout = onStdout;
    vm._onStderr = onStderr;
    vm._onExit = onExit;
    vm._onError = onError;
    vm._onNetworkStatus = onNetworkStatus;
    if (onNetworkStatus) onNetworkStatus('connected');
  },

  spawn: (id, processName, command, args, options, envVars, additionalMounts, isResume, allowedDomains, sharedCwdPath) => {
    trace('vm', 'spawn()', { id, processName, command, additionalMounts });

    // Create session directory (cached)
    const sessionDir = path.join(SESSIONS_BASE, processName);
    if (!CREATED_DIRS.has(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      CREATED_DIRS.add(sessionDir);
    }

    // Translate command path (use cached constant)
    let hostCommand = command;
    if (command === '/usr/local/bin/claude') {
      hostCommand = CLAUDE_BINARY;
    }

    // Build mount mappings from additionalMounts
    const username = os.userInfo().username;
    const mountMap = {};

    // Process additionalMounts to build the mapping
    if (additionalMounts && typeof additionalMounts === 'object') {
      for (const [mountName, mountInfo] of Object.entries(additionalMounts)) {
        if (mountInfo && typeof mountInfo === 'object') {
          // mountInfo.path is relative to home, empty string means home itself
          const relPath = mountInfo.path || '';
          mountMap[mountName] = relPath ? path.join(os.homedir(), relPath) : os.homedir();
        }
      }
    }

    // Fallback defaults if not in additionalMounts
    if (!mountMap[username]) mountMap[username] = os.homedir();
    if (!mountMap['.claude']) mountMap['.claude'] = path.join(os.homedir(), '.claude');
    if (!mountMap['.skills']) mountMap['.skills'] = path.join(os.homedir(), '.config/Claude/local-agent-mode-sessions/skills-plugin');
    if (!mountMap['uploads']) mountMap['uploads'] = path.join(sessionDir, 'uploads');

    // Ensure mount targets exist (with caching)
    for (const hostPath of Object.values(mountMap)) {
      if (!CREATED_DIRS.has(hostPath)) {
        try {
          fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 });
          CREATED_DIRS.add(hostPath);
        } catch(e) {}
      }
    }

    // Build bwrap arguments with security hardening
    // This creates an isolated namespace where /sessions/{processName}/mnt/{mountName} is available
    const vmSessionPath = `/sessions/${processName}`;

    // Network enabled by default, can be isolated for testing
    const isolateNetwork = process.env.CLAUDE_ISOLATE_NETWORK === 'true';

    const bwrapArgs = [
      // User namespace isolation
      '--unshare-user',
      '--uid', String(process.getuid()),
      '--gid', String(process.getgid()),
      '--die-with-parent',

      // Network isolation (opt-in for testing/security)
      ...(isolateNetwork ? ['--unshare-net'] : []),

      // Start with empty tmpfs root for maximum isolation
      '--tmpfs', '/',

      // Bind only necessary system directories (READ-ONLY where possible)
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/etc', '/etc',

      // Only bind user's home directory (not all of /home)
      '--bind', os.homedir(), os.homedir(),

      // Isolated temp directory (NOT host /tmp)
      '--tmpfs', '/tmp',

      // Minimal /dev and /proc
      '--dev', '/dev',
      '--proc', '/proc',

      // DO NOT MOUNT: /run (IPC sockets), /var (system state)
    ];

    // Optional system dirs that may exist (READ-ONLY)
    for (const optDir of ['/lib64', '/lib32', '/opt', '/snap', '/nix']) {
      try {
        if (fs.existsSync(optDir)) {
          bwrapArgs.push('--ro-bind', optDir, optDir);
        }
      } catch(e) {}
    }

    // Create /sessions directory structure in the namespace
    bwrapArgs.push('--dir', '/sessions');
    bwrapArgs.push('--dir', `${vmSessionPath}`);
    bwrapArgs.push('--dir', `${vmSessionPath}/mnt`);

    // Add bind mounts for each mount point
    for (const [mountName, hostPath] of Object.entries(mountMap)) {
      const vmMountPath = `${vmSessionPath}/mnt/${mountName}`;
      bwrapArgs.push('--dir', vmMountPath);
      bwrapArgs.push('--bind', hostPath, vmMountPath);
    }

    // Set working directory inside the sandbox
    let vmCwd = sharedCwdPath || `${vmSessionPath}/mnt/${username}`;
    bwrapArgs.push('--chdir', vmCwd);

    // Add the actual command to run
    bwrapArgs.push('--', hostCommand, ...(args || []));

    trace('vm', 'spawn bwrap', { bwrapArgs: bwrapArgs.slice(0, 20) });

    // Build secure environment with whitelist
    const userInfo = os.userInfo();
    const vmEnv = {
      // Essential system vars
      HOME: os.homedir(),
      USER: userInfo.username,
      LOGNAME: userInfo.username,
      SHELL: userInfo.shell || '/bin/bash',
      TERM: process.env.TERM || 'xterm-256color',
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      TMPDIR: '/tmp',

      // Claude-specific environment
      CLAUDE_COWORK_SESSION: processName,
      CLAUDE_VM_VERSION: '2.1.5',
      CLAUDE_SANDBOX: 'true',
      CLAUDE_SESSION_DIR: vmSessionPath,

      // Explicitly passed env vars
      ...envVars,

      // Selectively pass display/graphics vars if present
      ...(process.env.DISPLAY && { DISPLAY: process.env.DISPLAY }),
      ...(process.env.WAYLAND_DISPLAY && { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }),
      ...(process.env.XDG_RUNTIME_DIR && !isolateNetwork && { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }),

      // Development vars (if explicitly enabled)
      ...(process.env.CLAUDE_DEBUG && { CLAUDE_DEBUG: process.env.CLAUDE_DEBUG }),
      ...(process.env.NODE_OPTIONS && { NODE_OPTIONS: process.env.NODE_OPTIONS }),
    };

    // DO NOT PASS: SSH_AUTH_SOCK, GPG_AGENT_INFO, DBUS_SESSION_BUS_ADDRESS,
    // AWS_*, AZURE_*, GCP_*, *_API_KEY, *_SECRET, *_TOKEN (unless in envVars)

    try {
      const proc = nodeSpawn('bwrap', bwrapArgs, {
        env: vmEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Store process for writeStdin/kill
      vm._processes = vm._processes || new Map();
      vm._processes.set(id, proc);

      // Create cleanup function to remove all listeners
      const cleanup = () => {
        vm._processes?.delete(id);
        if (proc.stdout) proc.stdout.removeAllListeners();
        if (proc.stderr) proc.stderr.removeAllListeners();
        proc.removeAllListeners();
      };

      // Buffer stdout to reduce callback frequency (helps prevent renderer overload)
      let stdoutBuffer = '';
      let stdoutTimer = null;
      const STDOUT_FLUSH_DELAY = 16; // ~1 frame

      if (proc.stdout) {
        proc.stdout.on('data', (data) => {
          stdoutBuffer += data.toString('utf-8');
          if (!stdoutTimer) {
            stdoutTimer = setTimeout(() => {
              if (stdoutBuffer && vm._onStdout) {
                trace('vm', 'stdout', { id, len: stdoutBuffer.length });
                vm._onStdout(id, stdoutBuffer);
              }
              stdoutBuffer = '';
              stdoutTimer = null;
            }, STDOUT_FLUSH_DELAY);
          }
        });
      }
      if (proc.stderr) {
        proc.stderr.on('data', (data) => {
          trace('vm', 'stderr', { id, len: data.length });
          if (vm._onStderr) vm._onStderr(id, data.toString('utf-8'));
        });
      }
      proc.on('exit', (code, signal) => {
        cleanup();
        if (vm._onExit) vm._onExit(id, code || 0, signal || '');
      });
      proc.on('error', (err) => {
        cleanup();
        if (vm._onError) vm._onError(id, err.message, err.stack);
      });

      return { success: true, pid: proc.pid };
    } catch (err) {
      trace('vm', 'spawn error', { error: err.message });
      if (vm._onError) vm._onError(id, err.message, err.stack);
      return { success: false, error: err.message };
    }
  },

  kill: async (id, signal) => {
    trace('vm', 'kill()', { id, signal });
    const proc = vm._processes?.get(id);
    if (proc) {
      try {
        proc.kill(signal || 'SIGTERM');
      } catch (err) {
        trace('vm', 'kill error', { id, error: err.message });
      }
      // Cleanup will happen in exit handler, but delete from map immediately
      vm._processes.delete(id);
    }
  },

  writeStdin: async (id, data) => {
    trace('vm', 'writeStdin()', { id, dataLen: data?.length });
    const proc = vm._processes?.get(id);
    if (proc && proc.stdin && !proc.stdin.destroyed) {
      return new Promise((resolve) => {
        // Check if write buffer has space (backpressure handling)
        const canWrite = proc.stdin.write(data);
        if (!canWrite) {
          trace('vm', 'writeStdin backpressure detected', { id });
          // Wait for drain event before resolving
          proc.stdin.once('drain', () => {
            trace('vm', 'writeStdin buffer drained', { id });
            resolve(true);
          });
        } else {
          resolve(true);
        }
      });
    }
    trace('vm', 'writeStdin failed - no process or stdin', { id });
    return Promise.resolve(false);
  },

  readFile: async (sessionName, vmPath) => {
    let hostPath = vmPath;
    if (vmPath?.startsWith('/sessions/')) {
      hostPath = path.join(SESSIONS_BASE, vmPath.substring('/sessions/'.length));
    }
    return fs.readFileSync(hostPath).toString('base64');
  },

  writeFile: async (sessionName, vmPath, base64Content) => {
    let hostPath = vmPath;
    if (vmPath?.startsWith('/sessions/')) {
      hostPath = path.join(SESSIONS_BASE, vmPath.substring('/sessions/'.length));
    }
    const dir = path.dirname(hostPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(hostPath, Buffer.from(base64Content, 'base64'), { mode: 0o600 });
    return true;
  },

  mountPath: async (processId, subpath, pathName, mode) => {
    trace('vm', 'mountPath()', { processId, subpath, pathName, mode });

    // On Linux we need to create the mount point directory/symlink
    // subpath is like "/sessions/laughing-zen-darwin/mnt/zack"
    // pathName is like "/home/zack" (the actual host path to mount)
    try {
      if (subpath && pathName) {
        let hostMountPoint = subpath;
        if (subpath.startsWith('/sessions/')) {
          hostMountPoint = path.join(SESSIONS_BASE, subpath.substring('/sessions/'.length));
        }

        // Create parent directory
        const parentDir = path.dirname(hostMountPoint);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
        }

        // Create symlink to host path (if it doesn't exist)
        if (!fs.existsSync(hostMountPoint)) {
          fs.symlinkSync(pathName, hostMountPoint);
          trace('vm', 'mountPath created symlink', { hostMountPoint, pathName });
        }
      }
    } catch (e) {
      trace('vm', 'mountPath error (non-fatal)', { error: e.message });
    }

    return { success: true };
  },

  addApprovedOauthToken: async (token) => {
    trace('vm', 'addApprovedOauthToken()');
    return { success: true };
  },

  isDebugLoggingEnabled: () => TRACE_ENABLED,
  setDebugLogging: (enabled) => { trace('vm', 'setDebugLogging()', { enabled }); },
  showDebugWindow: () => { trace('vm', 'showDebugWindow()'); },
  hideDebugWindow: () => { trace('vm', 'hideDebugWindow()'); },
  isConsoleEnabled: () => !!process.env.CLAUDE_ENABLE_LOGGING,
});

const clipboard = createEmitterObject('clipboard', {
  read: () => {
    trace('clipboard', 'read()');
    try {
      return execFileSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf-8', timeout: 2000 });
    } catch (e) {
      try {
        return execFileSync('xsel', ['--clipboard', '--output'], { encoding: 'utf-8', timeout: 2000 });
      } catch (e2) { return ''; }
    }
  },
  write: (text) => {
    trace('clipboard', 'write()');
    try {
      execFileSync('xclip', ['-selection', 'clipboard'], { input: text, timeout: 2000 });
    } catch (e) {
      try {
        execFileSync('xsel', ['--clipboard', '--input'], { input: text, timeout: 2000 });
      } catch (e2) {}
    }
  },
  readImage: async () => null,
  writeImage: async () => {},
  clear: () => {},
});

const dictation = createEmitterObject('dictation', {
  start: async () => { trace('dictation', 'start()'); return false; },
  stop: async () => { trace('dictation', 'stop()'); },
  isListening: () => false,
  isRecording: () => false,
});

const quickAccess = createEmitterObject('quickAccess', {
  show: () => { trace('quickAccess', 'show()'); },
  hide: () => { trace('quickAccess', 'hide()'); },
  toggle: () => { trace('quickAccess', 'toggle()'); },
  isVisible: () => false,
  submit: (data) => { trace('quickAccess', 'submit()', data); },
});

// Helper to translate VM paths to host paths for file operations
function translateVmPathToHost(vmPath) {
  if (!vmPath || typeof vmPath !== 'string') return vmPath;

  // Handle /sessions/{session}/mnt/{mountName}/... paths
  if (vmPath.startsWith('/sessions/')) {
    const parts = vmPath.split('/');
    // /sessions/session-name/mnt/mountName/rest/of/path
    const mntIdx = parts.indexOf('mnt');
    if (mntIdx !== -1 && parts[mntIdx + 1]) {
      const mountName = parts[mntIdx + 1];
      const rest = parts.slice(mntIdx + 2).join('/');

      // Common mount mappings
      const username = os.userInfo().username;
      if (mountName === username || mountName === 'zack') {
        return rest ? path.join(os.homedir(), rest) : os.homedir();
      }
      if (mountName === '.claude') {
        return rest ? path.join(os.homedir(), '.claude', rest) : path.join(os.homedir(), '.claude');
      }
    }
    // Fallback: try mapping to sessions base
    return path.join(SESSIONS_BASE, vmPath.substring('/sessions/'.length));
  }

  return vmPath;
}

const desktop = createEmitterObject('desktop', {
  getDisplays: async () => [],
  getActiveWindow: async () => null,
  getOpenWindows: async () => [],
  getOpenDocuments: async () => [],
  captureScreen: async () => null,
  captureScreenshot: async () => null,
  captureWindow: async () => null,
  captureWindowScreenshot: async () => null,
  getSessionId: () => 'linux-session-' + Date.now(),
  openFile: (filePath) => {
    const hostPath = translateVmPathToHost(filePath);
    trace('desktop', 'openFile()', { filePath, hostPath });
    const { execFile } = require('child_process');
    execFile('xdg-open', [hostPath], (err) => {
      if (err) trace('desktop', 'openFile error', { error: err.message });
    });
    return Promise.resolve(true);
  },
  revealFile: (filePath) => {
    const hostPath = translateVmPathToHost(filePath);
    trace('desktop', 'revealFile()', { filePath, hostPath });
    const { execFile } = require('child_process');
    execFile('xdg-open', [path.dirname(hostPath)], (err) => {
      if (err) trace('desktop', 'revealFile error', { error: err.message });
    });
    return Promise.resolve(true);
  },
  previewFile: (filePath) => {
    const hostPath = translateVmPathToHost(filePath);
    trace('desktop', 'previewFile()', { filePath, hostPath });
    const { execFile } = require('child_process');
    execFile('xdg-open', [hostPath], (err) => {
      if (err) trace('desktop', 'previewFile error', { error: err.message });
    });
    return Promise.resolve(true);
  },
});

const events = createEmitterObject('events', {
  setListener: (callback) => {
    trace('events', 'setListener()');
    events._listener = callback;
  },
});

const windowModule = createEmitterObject('window', {
  focus: async () => { trace('window', 'focus()'); },
  blur: async () => { trace('window', 'blur()'); },
  minimize: async () => { trace('window', 'minimize()'); },
  maximize: async () => { trace('window', 'maximize()'); },
  restore: async () => { trace('window', 'restore()'); },
  close: async () => { trace('window', 'close()'); },
  setTitle: async (title) => { trace('window', 'setTitle()', { title }); },
  setBounds: async (bounds) => { trace('window', 'setBounds()', bounds); },
  getBounds: async () => ({ x: 0, y: 0, width: 800, height: 600 }),
  setWindowButtonPosition: () => {},
  setTrafficLightPosition: () => {},
  setThemeMode: (mode) => { trace('window', 'setThemeMode()', { mode }); },
});

// File picker using Electron's built-in dialog (no external dependencies!)
async function openFileDialog(options = {}) {
  try {
    const { dialog } = require('electron');

    const isDirectory = options.directory || options.properties?.includes('openDirectory');
    const isMultiple = options.multiple || options.properties?.includes('multiSelections');
    const isSave = options.save;
    const title = options.title || (isDirectory ? 'Select Folder' : 'Select File');
    const defaultPath = options.defaultPath || os.homedir();

    trace('files', 'openFileDialog()', { isDirectory, isMultiple, isSave, title, defaultPath });

    if (isSave) {
      // Save dialog
      const result = await dialog.showSaveDialog({
        title: title,
        defaultPath: defaultPath,
        properties: ['createDirectory', 'showOverwriteConfirmation']
      });

      if (result.canceled || !result.filePath) {
        trace('files', 'save dialog cancelled');
        return [];
      }
      trace('files', 'save dialog result', { filePath: result.filePath });
      return [result.filePath];
    } else {
      // Open dialog (file or directory)
      const properties = [];
      if (isDirectory) {
        properties.push('openDirectory', 'createDirectory');
      } else {
        properties.push('openFile');
      }
      if (isMultiple) {
        properties.push('multiSelections');
      }

      const result = await dialog.showOpenDialog({
        title: title,
        defaultPath: defaultPath,
        properties: properties
      });

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        trace('files', 'open dialog cancelled');
        return [];
      }
      trace('files', 'open dialog result', { filePaths: result.filePaths });
      return result.filePaths;
    }
  } catch (err) {
    trace('files', 'openFileDialog error', { error: err.message });
    // Fallback: return home directory so app doesn't freeze
    console.warn('[claude-swift-stub] Dialog error, using home as fallback:', err.message);
    return [os.homedir()];
  }
}

const files = createEmitterObject('files', {
  select: async (options) => {
    trace('files', 'select()', options);
    try {
      const result = await openFileDialog(options);
      return result;
    } catch (err) {
      trace('files', 'select error', { error: err.message });
      return [];
    }
  },
  save: async (options) => {
    trace('files', 'save()', options);
    try {
      const result = await openFileDialog({ ...options, save: true });
      return result.length > 0 ? result[0] : null;
    } catch (err) {
      trace('files', 'save error', { error: err.message });
      return null;
    }
  },
  reveal: (filePath) => {
    const hostPath = translateVmPathToHost(filePath);
    trace('files', 'reveal()', { filePath, hostPath });
    const { spawn } = require('child_process');
    spawn('xdg-open', [path.dirname(hostPath)], { detached: true, stdio: 'ignore' });
  },
  openLocalFile: (filePath) => {
    const hostPath = translateVmPathToHost(filePath);
    trace('files', 'openLocalFile()', { filePath, hostPath });
    const { spawn } = require('child_process');
    spawn('xdg-open', [hostPath], { detached: true, stdio: 'ignore' });
    return Promise.resolve(true);
  },
  read: (filePath) => Promise.resolve(fs.readFileSync(filePath, 'utf-8')),
  write: (filePath, content) => { fs.writeFileSync(filePath, content, 'utf-8'); return Promise.resolve(true); },
  exists: (filePath) => Promise.resolve(fs.existsSync(filePath)),
  stat: (filePath) => {
    const stats = fs.statSync(filePath);
    return Promise.resolve({
      size: stats.size,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      created: stats.birthtime,
      modified: stats.mtime,
    });
  },
  list: (dirPath) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return Promise.resolve(entries.map(e => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
      path: path.join(dirPath, e.name)
    })));
  },
});

const midnightOwl = createEmitterObject('midnightOwl', {
  getState: async () => ({ enabled: false }),
  setEnabled: (enabled) => { trace('midnightOwl', 'setEnabled()', { enabled }); },
  getEnabled: () => false,
});

const api = createEmitterObject('api', {});

// ============================================================
// Main instance - also an EventEmitter
// ============================================================

class ClaudeSwiftInstance extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);

    trace('constructor', 'Constructor START');

    // Attach all sub-modules
    this.notifications = notifications;
    this.vm = vm;
    this.clipboard = clipboard;
    this.dictation = dictation;
    this.quickAccess = quickAccess;
    this.desktop = desktop;
    this.events = events;
    this.window = windowModule;
    this.files = files;
    this.midnightOwl = midnightOwl;
    this.api = api;

    // Top-level methods
    this.initialize = async () => { trace('instance', 'initialize()'); return true; };
    this.shutdown = async () => { trace('instance', 'shutdown()'); };
    this.setWindowButtonPosition = () => {};
    this.setThemeMode = (mode) => { trace('instance', 'setThemeMode()', { mode }); };
    this.setApplicationMenu = () => {};

    trace('constructor', 'Constructor COMPLETE');
  }
}

const instance = new ClaudeSwiftInstance();

// Emit ready events after a short delay
setTimeout(() => {
  trace('init', 'Emitting guestConnectionChanged and guestReady events');
  instance.emit('guestConnectionChanged', { connected: true });
  instance.emit('guestReady');
  vm.emit('guestConnectionChanged', { connected: true });
  vm.emit('guestReady');
}, 100);

// ============================================================
// Export structure - handle all access patterns
// ============================================================

// The main export object IS the instance (so module.exports.on works)
module.exports = instance;
module.exports.default = instance;

// Re-export all sub-modules at top level
module.exports.notifications = notifications;
module.exports.vm = vm;
module.exports.clipboard = clipboard;
module.exports.dictation = dictation;
module.exports.quickAccess = quickAccess;
module.exports.desktop = desktop;
module.exports.events = events;
module.exports.window = windowModule;
module.exports.files = files;
module.exports.midnightOwl = midnightOwl;
module.exports.api = api;

// Make sure .default also has all sub-modules
module.exports.default.notifications = notifications;
module.exports.default.vm = vm;
module.exports.default.clipboard = clipboard;
module.exports.default.dictation = dictation;
module.exports.default.quickAccess = quickAccess;
module.exports.default.desktop = desktop;
module.exports.default.events = events;
module.exports.default.window = windowModule;
module.exports.default.files = files;
module.exports.default.midnightOwl = midnightOwl;
module.exports.default.api = api;

// Verification logging
console.log(`${LOG_PREFIX} === EXPORT VERIFICATION ===`);
console.log(`${LOG_PREFIX} module.exports.on: ${typeof module.exports.on}`);
console.log(`${LOG_PREFIX} module.exports.notifications.on: ${typeof module.exports.notifications.on}`);
console.log(`${LOG_PREFIX} module.exports.vm.on: ${typeof module.exports.vm.on}`);
console.log(`${LOG_PREFIX} module.exports.vm.setEventCallbacks: ${typeof module.exports.vm.setEventCallbacks}`);
console.log(`${LOG_PREFIX} module.exports.default.on: ${typeof module.exports.default.on}`);

trace('exports', 'Module exports set up complete');
