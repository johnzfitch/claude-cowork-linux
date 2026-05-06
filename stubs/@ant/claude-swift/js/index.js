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
 *   - /usr/local/bin/claude -> resolved via claude-code-vm or ~/.local/bin/claude
 *   - /sessions/... -> ${XDG_CONFIG_HOME}/Claude/local-agent-mode-sessions/sessions/...
 *
 * Security hardening applied:
 *   - Command injection prevention (execFile instead of exec)
 *   - Path traversal protection
 *   - Environment variable filtering
 *   - Secure file permissions
 *
 * Based on reverse engineering of swift_addon.node via pyghidra-lite
 */
console.log('[claude-swift-stub] Module loaded: ' + __filename);
const EventEmitter = require("events");
const { spawn: nodeSpawn, spawnSync: nodeSpawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const {
  createDirs,
  isPathSafe,
  translateVmPathStrict: _translateVmPathStrict,
  translateVmPathsInString: _translateVmPathsInString,
  canonicalizeHostPath,
  canonicalizeVmPathStrict: _canonicalizeVmPathStrict,
  canonicalizePathForHostAccess: _canonicalizePathForHostAccess,
  validateMountName,
  validateRelativePathWithinHome,
} = require('../../../../cowork/dirs.js');
const { createSessionStore } = require('../../../../cowork/session_store.js');
const { createSessionsApi } = require('../../../../cowork/sessions_api.js');
const { createSessionOrchestrator } = require('../../../../cowork/session_orchestrator.js');
const { redactCredentials } = require('../../../../cowork/credential_classifier.js');
const {
  extractCliSessionId,
  getIgnoredSdkMessageType,
  hasAssistantResponse,
  isFlatlineResumeResult,
  isSuccessfulResult,
  parseJsonLine,
} = require('../../../../cowork/stream_protocol.js');

const DIRS = global.__coworkDirs || createDirs();
const CLAUDE_CONFIG_ROOT = DIRS.claudeConfigRoot;
const LOCAL_AGENT_ROOT = DIRS.claudeLocalAgentRoot;


const LOG_DIR = process.env.CLAUDE_LOG_DIR || DIRS.coworkLogsDir;
const TRACE_FILE = path.join(LOG_DIR, 'claude-swift-trace.log');

// Ensure log directory exists with secure permissions
try {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
} catch (e) {}


const MAX_TRACE_FILE_BYTES = 50 * 1024 * 1024;
try {
  const _traceStats = fs.statSync(TRACE_FILE);
  if (_traceStats.size > MAX_TRACE_FILE_BYTES) {
    const _keepBytes = 10 * 1024 * 1024;
    const _fd = fs.openSync(TRACE_FILE, 'r');
    const _buf = Buffer.alloc(_keepBytes);
    const _bytesRead = fs.readSync(_fd, _buf, 0, _keepBytes, _traceStats.size - _keepBytes);
    fs.closeSync(_fd);
    fs.writeFileSync(TRACE_FILE, _buf.slice(0, _bytesRead), { mode: 0o600 });
  }
} catch (_) {}

const TRACE_IO = process.env.CLAUDE_COWORK_TRACE_IO === '1';


const MAX_STDIN_HISTORY_BYTES = 10 * 1024 * 1024; // 10 MB

function redactForLogs(input) {
  return redactCredentials(String(input));
}

function trace(msg) {
  const ts = new Date().toISOString();
  const safeMsg = redactForLogs(msg);
  const line = `[${ts}] ${safeMsg}\n`;
  console.log('[TRACE] ' + safeMsg);
  try {
    
    fs.appendFileSync(TRACE_FILE, line, { mode: 0o600 });
  } catch(e) {}
}
trace("=== MODULE LOADING ===");
trace("Trace IO logging: " + (TRACE_IO ? "enabled (CLAUDE_COWORK_TRACE_IO=1)" : "disabled"));

const { filterEnv: _filterEnv } = require('../../../../cowork/env_filter.js');

function filterEnv(baseEnv, additionalEnv) {
  return _filterEnv(baseEnv, additionalEnv, trace);
}

const SESSIONS_BASE = DIRS.claudeSessionsBase;

// Wrapper over dirs.js translateVmPathStrict that binds SESSIONS_BASE
// and adds security trace logging before propagating the error.
function translateVmPathStrict(vmPath) {
  try {
    return _translateVmPathStrict(SESSIONS_BASE, vmPath);
  } catch (err) {
    if (err.message.includes('Path traversal')) {
      trace(err.message);
    }
    throw err;
  }
}

function translateVmPathsInString(str) {
  return _translateVmPathsInString(SESSIONS_BASE, str);
}

function extractSessionNameFromVmPathStrict(vmPath) {
  const hostPath = translateVmPathStrict(vmPath);
  const relativePath = path.relative(SESSIONS_BASE, hostPath);
  const parts = relativePath.split(path.sep).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('Missing session name in VM path: ' + vmPath);
  }
  return parts[0];
}


function generateUUID() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

function parseSemver(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemverDesc(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

function resolveClaudeBinaryPath() {
  // 1. Prefer Claude Desktop's downloaded claude-code-vm roots, resolved with XDG-aware paths.
  for (const vmRoot of DIRS.claudeVmRoots) {
    try {
      const entries = fs
        .readdirSync(vmRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(compareSemverDesc);

      for (const version of entries) {
        const candidate = path.join(vmRoot, version, 'claude');
        if (fs.existsSync(candidate)) {
          trace('Resolved Claude binary (claude-code-vm): ' + candidate);
          return candidate;
        }
      }
    } catch (e) {
      trace('claude-code-vm root not available: ' + vmRoot + ' (' + e.message + ')');
    }
  }

  // 2. On Linux, find the native Claude Code CLI binary
  if (process.env.CLAUDE_CODE_PATH) {
    const envPath = process.env.CLAUDE_CODE_PATH;
    if (fs.existsSync(envPath)) {
      trace('Resolved Claude binary (CLAUDE_CODE_PATH): ' + envPath);
      return envPath;
    }
  }

  const home = os.homedir();
  const linuxCandidates = [
    path.join(home, '.local/bin/claude'),
    path.join(home, '.npm-global/bin/claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    // Linuxbrew
    '/home/linuxbrew/.linuxbrew/bin/claude',
    path.join(home, '.linuxbrew/bin/claude'),
    // Version managers (mise, asdf)
    path.join(home, '.local/share/mise/shims/claude'),
    path.join(home, '.asdf/shims/claude'),
  ];
  for (const candidate of linuxCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        trace('Resolved Claude binary (Linux): ' + candidate);
        return candidate;
      }
    } catch (_) { /* skip */ }
  }

  // Last resort: let PATH resolve it
  trace('No Claude binary found at known paths, falling back to PATH lookup');
  return 'claude';
}

/**
 * Create mount symlinks for a session
 *
 * The additionalMounts object contains mount mappings:
 * {
 *   "mountName": { path: "relative/path/from/homedir", mode: "rw"|"ro" }
 * }
 *
 * We create symlinks at:
 *   ${XDG_CONFIG_HOME}/Claude/local-agent-mode-sessions/sessions/<session>/mnt/<mountName>
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
  // Track failures for required mounts (.claude is critical for transcripts)
  const REQUIRED_MOUNTS = new Set(['.claude']);
  const failedMounts = [];
  const mountEntries = Object.entries(additionalMounts);
  trace('Processing ' + mountEntries.length + ' mount entries');

  for (const [mountName, mountInfo] of mountEntries) {
    trace('--- Processing mount: ' + mountName + ' ---');
    trace('  Mount info: ' + JSON.stringify(mountInfo));

    if (!validateMountName(mountName)) {
      trace('  Rejected mount: ' + mountName);
      failedMounts.push(mountName);
      continue;
    }

    const mountPoint = path.join(mntDir, mountName);

    // Skip asar mounts: on macOS the app path is a directory inside the .app bundle,
    // but on Linux it's a packed .asar file which Claude Code can't use as a project dir.
    if (mountName.endsWith('.asar')) {
      trace('  SKIP: ' + mountName + ' is an asar archive, not a directory (Linux)');
      continue;
    }

    // Handle special cases
    if (mountName === 'uploads') {
      // On macOS, uploads is a VM shared mount. On Linux (no VM),
      // we symlink to the host uploads dir so Claude Code can see files.
      const uploadsRelPath = (typeof mountInfo === 'object' && mountInfo !== null) ? (mountInfo.path || '') : String(mountInfo || '');
      if (uploadsRelPath !== '' && !validateRelativePathWithinHome(uploadsRelPath)) {
        trace('  Rejected uploads path');
        failedMounts.push(mountName);
        continue;
      }
      const hostUploadsPath = path.join(os.homedir(), uploadsRelPath);
      try {
        fs.mkdirSync(hostUploadsPath, { recursive: true, mode: 0o700 });
        if (fs.existsSync(mountPoint)) {
          const stat = fs.lstatSync(mountPoint);
          if (stat.isSymbolicLink()) {
            const target = fs.readlinkSync(mountPoint);
            if (target === hostUploadsPath) {
              trace('  Uploads symlink already correct: ' + mountPoint + ' -> ' + hostUploadsPath);
              continue;
            }
            fs.unlinkSync(mountPoint);
          } else if (stat.isDirectory()) {
            // Preserve stale uploads contents before replacing with a symlink.
            for (const entry of fs.readdirSync(mountPoint)) {
              const sourcePath = path.join(mountPoint, entry);
              const destPath = path.join(hostUploadsPath, entry);
              if (fs.existsSync(destPath)) {
                trace('  Uploads entry already exists at host path, preserving destination: ' + destPath);
                continue;
              }
              try {
                fs.renameSync(sourcePath, destPath);
              } catch (moveErr) {
                // renameSync fails across filesystems (EXDEV); fall back to copy+delete
                if (moveErr.code === 'EXDEV') {
                  const srcStat = fs.statSync(sourcePath);
                  if (srcStat.isDirectory()) {
                    fs.cpSync(sourcePath, destPath, { recursive: true });
                  } else {
                    fs.copyFileSync(sourcePath, destPath);
                  }
                  fs.rmSync(sourcePath, { recursive: true, force: true });
                } else {
                  trace('  WARNING: Could not move upload entry ' + entry + ': ' + moveErr.message);
                }
              }
            }
            fs.rmSync(mountPoint, { recursive: true, force: true });
          } else {
            fs.unlinkSync(mountPoint);
          }
        }
        fs.symlinkSync(hostUploadsPath, mountPoint);
        trace('  Created uploads symlink: ' + mountPoint + ' -> ' + hostUploadsPath);
      } catch (e) {
        trace('  ERROR creating uploads symlink: ' + e.message);
        failedMounts.push(mountName);
        // Fallback: create directory so process doesn't crash
        try {
          if (!fs.existsSync(mountPoint)) {
            fs.mkdirSync(mountPoint, { recursive: true, mode: 0o700 });
            trace('  Created fallback directory for uploads');
          }
        } catch (_) {}
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

    if (relativePath !== '' && !validateRelativePathWithinHome(relativePath)) {
      trace('  Rejected relativePath');
      failedMounts.push(mountName);
      continue;
    }

    // Construct the full host path
    // Empty path means homedir itself.
    // Since Claude Desktop v1.569.0+, getVMStorageSubpath returns root-relative
    // subpaths (e.g. "home/user/.config/...") instead of homedir-relative paths.
    // Detect this format to avoid doubled paths like /home/user/home/user/...
    const _homedir = os.homedir();
    const _asAbsolute = '/' + relativePath;
    const hostPath = relativePath === ''
      ? _homedir
      : path.isAbsolute(relativePath)
        ? relativePath
        : (_asAbsolute === _homedir || _asAbsolute.startsWith(_homedir + '/'))
          ? _asAbsolute
          : path.join(_homedir, relativePath);

    trace('  Relative path: "' + relativePath + '"');
    trace('  Host path: ' + hostPath);
    trace('  Mount point: ' + mountPoint);

    // Verify host path exists
    if (!fs.existsSync(hostPath)) {
      trace('  WARNING: Host path does not exist: ' + hostPath);
      // Try to create it for output directories or writable mounts (rw, rwd, etc.)
      const isWritable = mountName === 'outputs' ||
        (typeof mountInfo.mode === 'string' && mountInfo.mode.includes('w'));
      if (isWritable) {
        try {
          fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 });
          trace('  Created host directory: ' + hostPath);
        } catch (e) {
          trace('  ERROR creating host directory: ' + e.message);
          failedMounts.push(mountName);
          continue;
        }
      } else {
        trace('  ERROR: Host path missing and mount is read-only');
        failedMounts.push(mountName);
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
          // Mount point is a directory. This happens for nested mounts
          // (e.g. .local-plugins/cache/.../mcpb-cache) that resolve through
          // a parent symlink to a real directory on the host. If the resolved
          // path matches the target host path, the mount is effectively set up.
          try {
            const resolvedMountPoint = fs.realpathSync(mountPoint);
            const resolvedHostPath = fs.realpathSync(hostPath);
            if (resolvedMountPoint === resolvedHostPath) {
              trace('  Mount point resolves to host path via parent symlink — already mounted');
              continue;
            }
          } catch (_) {}
          trace('  ERROR: Mount point is a directory, cannot create symlink');
          failedMounts.push(mountName);
          continue;
        } else {
          trace('  Removing existing file at mount point');
          fs.unlinkSync(mountPoint);
        }
      }

      // Ensure parent dir exists -- nested mount keys like ".claude/skills"
      // need ".claude/" to exist before symlinkSync can place "skills" inside.
      // Idempotent for non-nested keys (parent already equals mntDir).
      fs.mkdirSync(path.dirname(mountPoint), { recursive: true, mode: 0o700 });
      fs.symlinkSync(hostPath, mountPoint);
      trace('  SUCCESS: Created symlink ' + mountPoint + ' -> ' + hostPath);
    } catch (e) {
      trace('  ERROR creating symlink: ' + e.message);
      failedMounts.push(mountName);
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

  // Fail if any required mounts failed
  const failedRequired = failedMounts.filter(m => REQUIRED_MOUNTS.has(m));
  if (failedRequired.length > 0) {
    trace('FATAL: Required mounts failed: ' + failedRequired.join(', '));
    return false;
  }
  if (failedMounts.length > 0) {
    trace('WARNING: Non-required mounts failed: ' + failedMounts.join(', '));
  }
  return true;
}

/**
 * Extract session name only from validated VM paths supplied by the asar.
 * Never falls back to processName, which is human-readable metadata.
 */
function extractSessionName(args, envVars, sharedCwdPath) {
  if (typeof sharedCwdPath === 'string' && sharedCwdPath.startsWith('/sessions/')) {
    const sessionName = extractSessionNameFromVmPathStrict(sharedCwdPath);
    trace('Extracted session name from sharedCwdPath: ' + sessionName);
    return sessionName;
  }

  if (envVars && typeof envVars === 'object') {
    for (const [key, value] of Object.entries(envVars)) {
      if (typeof value === 'string' && value.startsWith('/sessions/')) {
        const sessionName = extractSessionNameFromVmPathStrict(value);
        trace('Extracted session name from envVar ' + key + ': ' + sessionName);
        return sessionName;
      }
    }
  }

  if (args && Array.isArray(args)) {
    for (const arg of args) {
      if (typeof arg === 'string' && arg.startsWith('/sessions/')) {
        const sessionName = extractSessionNameFromVmPathStrict(arg);
        trace('Extracted session name from args: ' + sessionName);
        return sessionName;
      }
    }
  }

  trace('WARNING: No validated VM path available for session name extraction');
  return null;
}

function findSessionName(args, envVars, sharedCwdPath) {
  try {
    return extractSessionName(args, envVars, sharedCwdPath);
  } catch (err) {
    trace('Invalid VM path: ' + err.message);
    throw err;
  }
}

function canonicalizeVmPathStrict(vmPath) {
  try {
    return _canonicalizeVmPathStrict(SESSIONS_BASE, vmPath);
  } catch (err) {
    if (err.message.includes('Path traversal')) {
      trace(err.message);
    }
    throw err;
  }
}

// Route VM paths through strict validation+canonicalization, host paths
// through canonicalizeHostPath. Used by files.* and other surfaces that
// receive paths from the asar without knowing the path type.
function canonicalizePathForHostAccess(inputPath) {
  return _canonicalizePathForHostAccess(SESSIONS_BASE, inputPath);
}

// For arbitrary host paths from desktop integrations, avoid ancestor walking
// if the target is missing or inaccessible. Those paths are not crossing the
// VM boundary, so preserve the original string unless realpath succeeds.
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

function getSessionRootForVmPath(vmPath) {
  return path.join(SESSIONS_BASE, extractSessionNameFromVmPathStrict(vmPath));
}

function findNearestExistingAncestorWithin(hostPath, stopAtPath) {
  if (typeof hostPath !== 'string' || hostPath.length === 0) {
    throw new Error('Missing host path for bounded ancestor lookup');
  }
  if (typeof stopAtPath !== 'string' || stopAtPath.length === 0) {
    throw new Error('Missing stop path for bounded ancestor lookup');
  }

  const boundary = path.resolve(stopAtPath);
  let current = path.resolve(hostPath);

  while (true) {
    const relative = path.relative(boundary, current);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Path escapes session root: ' + hostPath);
    }
    try {
      return fs.realpathSync(current);
    } catch (_) {
      if (current === boundary) {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  throw new Error('No existing ancestor found within session root: ' + hostPath);
}

class SwiftAddonStub extends EventEmitter {
  constructor() {
    super();
    trace('Constructor START');
    console.log('[claude-swift-stub] Constructor called');
    this._eventListener = null;
    this._guestConnected = true;  // Linux: always "connected" since we run directly on host
    this._processes = new Map();
    this._processStates = new Map();
    this._processIdCounter = 0;
    this._quickAccessOverlayState = {
      activeChatId: null,
      isLoggedIn: false,
      recentChats: [],
      visible: false,
    };
    this._quickAccessDictationState = {
      active: false,
      language: 'en-US',
    };
    this._sessionStore = global.__coworkSessionStore || createSessionStore({
      localAgentRoot: LOCAL_AGENT_ROOT,
    });
    this._sessionsApi = createSessionsApi({
      authFileDescriptor: process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR || null,
      authToken: process.env.CLAUDE_COWORK_SESSIONS_API_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
      baseUrl: process.env.CLAUDE_COWORK_SESSIONS_API_BASE_URL || process.env.CLAUDE_COWORK_SESSION_API_BASE_URL,
      organizationUuid: process.env.CLAUDE_CODE_ORGANIZATION_UUID || null,
      requestSync: typeof global.__coworkSessionsApiRequestSync === 'function'
        ? global.__coworkSessionsApiRequestSync
        : null,
      trace,
    });
    this._sessionOrchestrator = createSessionOrchestrator({
      appSupportRoot: CLAUDE_CONFIG_ROOT,
      claudeVmRoots: DIRS.claudeVmRoots,
      canonicalizePathForHostAccess,
      canonicalizeVmPathStrict,
      createMountSymlinks,
      filterEnv,
      findSessionName,
      resolveClaudeBinaryPath,
      sessionStore: this._sessionStore,
      sessionsApi: this._sessionsApi,
      sessionsBase: SESSIONS_BASE,
      trace,
      translateVmPathStrict,
    });

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
      },
      overlay: {
        show: () => {
          this._quickAccessOverlayState.visible = true;
          trace('quickAccess.overlay.show()');
        },
        hide: () => {
          this._quickAccessOverlayState.visible = false;
          trace('quickAccess.overlay.hide()');
        },
        isVisible: () => this._quickAccessOverlayState.visible,
        setActiveChatId: (chatId) => {
          this._quickAccessOverlayState.activeChatId = (
            typeof chatId === 'string' && chatId.trim() ? chatId : null
          );
          trace('quickAccess.overlay.setActiveChatId(' + String(this._quickAccessOverlayState.activeChatId) + ')');
        },
        setLoggedIn: (isLoggedIn) => {
          this._quickAccessOverlayState.isLoggedIn = Boolean(isLoggedIn);
          trace('quickAccess.overlay.setLoggedIn(' + String(this._quickAccessOverlayState.isLoggedIn) + ')');
        },
        setRecentChats: (recentChats, activeChatId = null) => {
          this._quickAccessOverlayState.recentChats = Array.isArray(recentChats)
            ? recentChats.slice()
            : [];
          this._quickAccessOverlayState.activeChatId = (
            typeof activeChatId === 'string' && activeChatId.trim() ? activeChatId : null
          );
          trace(
            'quickAccess.overlay.setRecentChats(count='
              + this._quickAccessOverlayState.recentChats.length
              + ', activeChatId='
              + String(this._quickAccessOverlayState.activeChatId)
              + ')'
          );
        },
      },
      dictation: {
        start: () => {
          this._quickAccessDictationState.active = true;
          trace('quickAccess.dictation.start()');
        },
        stop: () => {
          this._quickAccessDictationState.active = false;
          trace('quickAccess.dictation.stop()');
        },
        isActive: () => this._quickAccessDictationState.active,
        setLanguage: (language) => {
          this._quickAccessDictationState.language = (
            typeof language === 'string' && language.trim()
              ? language.trim()
              : this._quickAccessDictationState.language
          );
          trace('quickAccess.dictation.setLanguage(' + this._quickAccessDictationState.language + ')');
        },
      },
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
        return `local_${generateUUID()}`;
      },
      // Get list of open documents (Linux implementation)
      getOpenDocuments: () => {
        console.log('[claude-swift] desktop.getOpenDocuments()');
        // On Linux, we can check recent files or return empty
        // Could integrate with GTK recent files or track opened files
        return Promise.resolve([]);
      },
      // Get list of open windows — disabled for privacy (do not expose
      // the user's desktop window list to AI sessions)
      getOpenWindows: () => {
        return Promise.resolve([]);
      },
      // Open file with default application
      openFile: (filePath) => {
        console.log('[claude-swift] desktop.openFile()', filePath);
        let hostPath = filePath;
        let translatedVmPath = null;
        let sessionRoot = null;
        if (typeof filePath === 'string' && filePath.startsWith('/sessions/')) {
          try {
            translatedVmPath = translateVmPathStrict(filePath);
            sessionRoot = getSessionRootForVmPath(filePath);
            hostPath = canonicalizeHostPath(translatedVmPath);
          } catch (e) {
            console.error('[claude-swift] openFile path error:', e.message);
            return Promise.resolve(false);
          }
        } else {
          hostPath = canonicalizeResolvableHostPath(filePath);
        }
        console.log('[claude-swift] desktop.openFile() resolved to:', hostPath);
        try {
          const { execFile } = require('child_process');
          let openTarget = hostPath;
          let fallbackTarget = hostPath;
          try {
            const stats = fs.statSync(hostPath);
            openTarget = canonicalizeResolvableHostPath(hostPath);
            fallbackTarget = stats.isDirectory()
              ? openTarget
              : canonicalizeResolvableHostPath(path.dirname(hostPath));
          } catch (err) {
            if (translatedVmPath && sessionRoot) {
              try {
                openTarget = findNearestExistingAncestorWithin(path.dirname(translatedVmPath), sessionRoot);
                fallbackTarget = openTarget;
              } catch (fallbackErr) {
                console.error('[claude-swift] openFile fallback error:', fallbackErr.message);
                return Promise.resolve(false);
              }
            } else {
              // For non-session paths, only fall back to immediate parent (not arbitrary ancestors)
              const parentDir = path.dirname(hostPath);
              try {
                fs.accessSync(parentDir, fs.constants.R_OK);
                openTarget = parentDir;
                fallbackTarget = parentDir;
              } catch (_) {
                console.error('[claude-swift] openFile: target and parent missing:', hostPath);
                return Promise.resolve(false);
              }
            }
          }
          execFile('xdg-open', [openTarget], (err) => {
            if (err) {
              console.error('[claude-swift] openFile error:', err.message);
              if (fallbackTarget !== openTarget) {
                execFile('xdg-open', [fallbackTarget], () => {});
              }
            }
          });
          return Promise.resolve(true);
        } catch (e) {
          return Promise.resolve(false);
        }
      },
      // Reveal file in file manager
      revealFile: (filePath) => {
        console.log('[claude-swift] desktop.revealFile()', filePath);
        let hostPath = filePath;
        let translatedVmPath = null;
        let sessionRoot = null;
        if (typeof filePath === 'string' && filePath.startsWith('/sessions/')) {
          try {
            translatedVmPath = translateVmPathStrict(filePath);
            sessionRoot = getSessionRootForVmPath(filePath);
            hostPath = canonicalizeHostPath(translatedVmPath);
          } catch (e) {
            console.error('[claude-swift] revealFile path error:', e.message);
            return Promise.resolve(false);
          }
        } else {
          hostPath = canonicalizeResolvableHostPath(filePath);
        }
        console.log('[claude-swift] desktop.revealFile() resolved to:', hostPath);
        try {
          const { execFile } = require('child_process');
          let revealDir = hostPath;
          // Try nautilus first (GNOME), fall back to xdg-open
          let targetIsFile = false;
          try {
            const stats = fs.statSync(hostPath);
            targetIsFile = stats.isFile();
            revealDir = stats.isDirectory()
              ? canonicalizeResolvableHostPath(hostPath)
              : canonicalizeResolvableHostPath(path.dirname(hostPath));
          } catch (err) {
            if (translatedVmPath && sessionRoot) {
              try {
                revealDir = findNearestExistingAncestorWithin(path.dirname(translatedVmPath), sessionRoot);
              } catch (fallbackErr) {
                console.error('[claude-swift] revealFile fallback error:', fallbackErr.message);
                return Promise.resolve(false);
              }
            } else {
              // For non-session paths, only fall back to immediate parent (not arbitrary ancestors)
              const parentDir = path.dirname(hostPath);
              try {
                fs.accessSync(parentDir, fs.constants.R_OK);
                revealDir = parentDir;
              } catch (_) {
                console.error('[claude-swift] revealFile: target and parent missing:', hostPath);
                return Promise.resolve(false);
              }
            }
          }
          if (targetIsFile) {
            execFile('nautilus', ['--select', hostPath], (err) => {
              if (err) {
                execFile('xdg-open', [revealDir], () => {});
              }
            });
          } else {
            execFile('xdg-open', [revealDir], () => {});
          }
          return Promise.resolve(true);
        } catch (e) {
          return Promise.resolve(false);
        }
      },
      // Preview file (Quick Look equivalent)
      previewFile: (filePath) => {
        console.log('[claude-swift] desktop.previewFile()', filePath);
        let hostPath = filePath;
        if (typeof filePath === 'string' && filePath.startsWith('/sessions/')) {
          try {
            hostPath = canonicalizeVmPathStrict(filePath);
          } catch (e) {
            console.error('[claude-swift] previewFile path error:', e.message);
            return Promise.resolve(false);
          }
        } else {
          hostPath = canonicalizeResolvableHostPath(filePath);
        }
        console.log('[claude-swift] desktop.previewFile() resolved to:', hostPath);
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

    // File system operations — canonicalize paths to resolve mount symlinks.
    // Uses canonicalizePathForHostAccess so both /sessions/... VM paths and
    // regular host paths are handled correctly.
    this.files = {
      // Read file contents
      read: (filePath) => {
        console.log('[claude-swift] files.read()', filePath);
        try {
          const content = fs.readFileSync(canonicalizePathForHostAccess(filePath), 'utf-8');
          return Promise.resolve(content);
        } catch (e) {
          return Promise.reject(e);
        }
      },
      // Write file contents
      write: (filePath, content) => {
        console.log('[claude-swift] files.write()', filePath);
        try {
          fs.writeFileSync(canonicalizePathForHostAccess(filePath), content, 'utf-8');
          return Promise.resolve(true);
        } catch (e) {
          return Promise.reject(e);
        }
      },
      // Check if file exists
      exists: (filePath) => {
        return Promise.resolve(fs.existsSync(canonicalizePathForHostAccess(filePath)));
      },
      // Get file stats
      stat: (filePath) => {
        console.log('[claude-swift] files.stat()', filePath);
        try {
          const stats = fs.statSync(canonicalizePathForHostAccess(filePath));
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
          const resolved = canonicalizePathForHostAccess(dirPath);
          const returnedBasePath = (typeof dirPath === 'string' && dirPath.length > 0) ? dirPath : resolved;
          const entries = fs.readdirSync(resolved, { withFileTypes: true });
          return Promise.resolve(entries.map(e => ({
            name: e.name,
            isFile: e.isFile(),
            isDirectory: e.isDirectory(),
            path: path.join(returnedBasePath, e.name)
          })));
        } catch (e) {
          return Promise.reject(e);
        }
      },
      // Watch file for changes
      watch: (filePath, callback) => {
        console.log('[claude-swift] files.watch()', filePath);
        try {
          const watcher = fs.watch(canonicalizePathForHostAccess(filePath), (eventType, filename) => {
            callback({ type: eventType, filename });
          });
          return { close: () => watcher.close() };
        } catch (e) {
          console.error('[claude-swift] files.watch() failed:', filePath, e.message);
          throw e;
        }
      }
    };

    // API object (general purpose)
    this.api = {
      setCredentials: (creds) => {
        trace('api.setCredentials() called');
      },
    };

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
        return Promise.resolve(self._guestConnected);
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

      setEventCallbacks: (onStdout, onStderr, onExit, onError, onNetworkStatus, onApiReachability) => {
        trace('vm.setEventCallbacks() CALLED with callbacks: stdout=' + !!onStdout + ' stderr=' + !!onStderr + ' exit=' + !!onExit);
        console.log('[claude-swift] vm.setEventCallbacks() called - REGISTERING CALLBACKS');
        console.log('[claude-swift] Callbacks: stdout=' + typeof onStdout + ' stderr=' + typeof onStderr + ' exit=' + typeof onExit);
        self._onStdout = onStdout;
        self._onStderr = onStderr;
        self._onExit = onExit;
        self._onError = onError;
        self._onNetworkStatus = onNetworkStatus;
        self._onApiReachability = onApiReachability;
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

        const claudeConfigRoot = DIRS.claudeConfigRoot;
        const targetDir = path.join('/', subpath, version);
        const targetBin = path.join(targetDir, 'claude');

        if (!targetDir.startsWith(claudeConfigRoot + '/')) {
          trace('vm.installSdk() REJECTED: subpath resolves outside Claude config: ' + targetDir);
          return { success: false, error: 'Install path outside allowed directory' };
        }

        try {
          fs.accessSync(targetBin, fs.constants.X_OK);
          fs.accessSync(path.join(targetDir, '.verified'));
          trace('vm.installSdk() already installed at ' + targetBin);
          return { success: true };
        } catch {}

        const arch = os.arch() === 'arm64' ? 'linux-arm64' : 'linux-x64';
        const url = 'https://downloads.claude.ai/claude-code-releases/' + encodeURIComponent(version) + '/' + arch + '/claude.zst';
        console.log('[claude-swift] Downloading SDK binary from ' + url);
        trace('vm.installSdk() downloading ' + url + ' -> ' + targetBin);

        try {
          fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
          execFileSync('curl', ['-sfL', '-o', targetBin + '.zst', url], { timeout: 120000 });
          execFileSync('zstd', ['-d', '-f', targetBin + '.zst', '-o', targetBin], { timeout: 30000 });
          fs.unlinkSync(targetBin + '.zst');
          fs.chmodSync(targetBin, 0o755);
          fs.writeFileSync(path.join(targetDir, '.verified'), '');
          console.log('[claude-swift] SDK binary installed at ' + targetBin);
          return { success: true };
        } catch (e) {
          console.error('[claude-swift] vm.installSdk() download failed:', e.message);
          trace('vm.installSdk() FAILED: ' + e.message);
          try { fs.unlinkSync(targetBin + '.zst'); } catch {}
          return { success: false, error: e.message };
        }
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
        const preparedSpawn = self._sessionOrchestrator.prepareVmSpawn({
          processId: id,
          processName,
          command,
          args,
          envVars,
          additionalMounts,
          sharedCwdPath,
          onError: self._onError,
        });
        if (!preparedSpawn.success) {
          return preparedSpawn;
        }

        console.log('[claude-swift] vm.spawn() id=' + id + ' cmd=' + preparedSpawn.command);
        const spawnResult = self.spawn(
          id,
          processName,
          preparedSpawn.command,
          preparedSpawn.args,
          options,
          preparedSpawn.envVars,
          additionalMounts,
          isResume,
          allowedDomains,
          preparedSpawn.sharedCwdPath
        );

        return spawnResult;
      },

      kill: (id, signal) => {
        console.log('[claude-swift] vm.kill(' + id + ', ' + signal + ')');
        return Promise.resolve(self.killProcess(id, signal));
      },

      writeStdin: (id, data) => {
        console.log('[claude-swift] vm.writeStdin(' + id + ')');
        return Promise.resolve(self.writeToProcess(id, data));
      },

      isProcessRunning: (id) => {
        return Promise.resolve(self.isProcessRunning(id));
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

        // Translate VM path to host path and resolve symlinks
        let hostPath = vmPath;
        if (typeof vmPath === 'string' && vmPath.startsWith('/sessions/')) {
          hostPath = canonicalizeVmPathStrict(vmPath);
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

        // Translate VM path to host path and resolve symlinks
        let hostPath = vmPath;
        if (typeof vmPath === 'string' && vmPath.startsWith('/sessions/')) {
          hostPath = canonicalizeVmPathStrict(vmPath);
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
      setGuestRequestCallback: (callback) => {
        trace('vm.setGuestRequestCallback() registered');
        self._guestRequestCallback = callback;
      },

      sendGuestResponse: async (id, resultJson, error) => {
        trace('vm.sendGuestResponse() id=' + id);
      },

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
        self._processStates.clear();
        self._guestConnected = false;
        self._emit('guestConnectionChanged', { connected: false });
        return { success: true };
      },

      /**
       * Add approved OAuth token (new in 1.1.381)
       *
       * OAUTH COMPLIANCE: This handler is intentionally a no-op.
       *
       * On macOS, this method stores an OAuth token inside the sandboxed VM
       * so Claude Code can authenticate with the user's consumer plan. On
       * this Linux compatibility layer we deliberately DO NOT store, forward,
       * persist, or use the token in any way. The token parameter is never
       * read, assigned, or passed to any subprocess.
       *
       * Authentication is handled entirely by the unmodified Anthropic
       * applications:
       *   - Claude Desktop (Electron renderer) manages its own OAuth session
       *   - Claude Code CLI authenticates independently via CLAUDE_CODE_OAUTH_TOKEN
       *     passed in spawn envVars (see filterEnv / CREDENTIAL_EXEMPT_KEYS above)
       *
       * This stub exists solely to satisfy the IPC contract — the renderer
       * expects a response on this channel. Removing it would crash the app.
       *
       * @param {*} _token - Deliberately unused; never read or stored
       * @returns {{ success: true }} Acknowledgement only
       */
      addApprovedOauthToken: async (_token) => {
        trace('vm.addApprovedOauthToken() called — token intentionally discarded (OAuth compliance)');
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

        let hostPath;
        try {
          hostPath = canonicalizePathForHostAccess(pathName);
        } catch (e) {
          trace('vm.mountPath() error canonicalizing pathName: ' + e.message);
          throw e;
        }

        if (typeof hostPath !== 'string' || !path.isAbsolute(hostPath)) {
          trace('vm.mountPath() error: pathName is not an absolute host path');
          throw new Error('Invalid pathName: must be an absolute path');
        }

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
      }
    };

    trace('Constructor COMPLETE. vm.setEventCallbacks=' + typeof this.vm.setEventCallbacks);
    console.log('[claude-swift-stub] Constructor complete. vm.setEventCallbacks type:', typeof this.vm.setEventCallbacks);
  }

  // TOP-LEVEL METHODS (for API compatibility)
  setEventCallbacks(onStdout, onStderr, onExit, onError, onNetworkStatus, onApiReachability) {
    console.log('[claude-swift] setEventCallbacks() called - REGISTERING CALLBACKS');
    this._onStdout = onStdout;
    this._onStderr = onStderr;
    this._onExit = onExit;
    this._onError = onError;
    this._onNetworkStatus = onNetworkStatus;
    this._onApiReachability = onApiReachability;
  }

  async startVM(bundlePath, memoryGB) {
    console.log('[claude-swift] startVM() bundlePath=' + bundlePath + ' memoryGB=' + memoryGB);
    this._guestConnected = true;
    this._emit('guestConnectionChanged', { connected: true });
    return { success: true };
  }

  async installSdk(subpath, version) {
    console.log('[claude-swift] installSdk() subpath=' + subpath + ' version=' + version);
    return this.vm.installSdk(subpath, version);
  }

  kill(id, signal) {
    console.log('[claude-swift] kill(' + id + ', ' + signal + ')');
    return this.killProcess(id, signal);
  }

  writeStdin(id, data) {
    return this.writeToProcess(id, data);
  }

  spawn(id, processName, command, args, options, envVars, additionalMounts, isResume, allowedDomains, sharedCwdPath) {
    console.log('[claude-swift] spawn() id=' + id + ' cmd=' + command + ' args=' + JSON.stringify(args));
    // Log auth-related env vars from the asar (redact values) so we can debug auth issues
    if (envVars && typeof envVars === 'object') {
      const authKeys = Object.keys(envVars).filter(k => /ANTHROPIC|AUTH|TOKEN|API_KEY|OAUTH/i.test(k));
      if (authKeys.length > 0) {
        trace('spawn envVars auth keys from asar: ' + authKeys.join(', '));
        const oauthVal = envVars.CLAUDE_CODE_OAUTH_TOKEN;
        if (typeof oauthVal === 'string') {
          trace('spawn OAUTH_TOKEN: present (len=' + oauthVal.length + ')');
        }
      }
      trace('spawn envVars keys from asar: ' + Object.keys(envVars).join(', '));
    }
    try {
      const translatedArgs = Array.isArray(args)
        ? args.map(a => typeof a === 'string' ? translateVmPathsInString(a) : a)
        : [];
      const translatedEnvVars = envVars && typeof envVars === 'object'
        ? Object.fromEntries(Object.entries(envVars).map(([k, v]) =>
            [k, typeof v === 'string' ? translateVmPathsInString(v) : v]))
        : {};
      const processState = {
        id,
        processName,
        command,
        args: translatedArgs,
        options: options && typeof options === 'object' ? { ...options } : {},
        envVars: translatedEnvVars,
        additionalMounts,
        allowedDomains,
        sharedCwdPath,
        retryCount: 0,
        stdinHistory: [],
        stdinHistoryBytes: 0,
        deferredResultLine: null,
        hadFirstResponse: false,
        attemptedResume: false,
        completedSuccessfully: false,
        continuityPlan: null,
        latestCliSessionId: null,
        stdoutSeq: 0,
      };
      this._processStates.set(id, processState);
      return this._startManagedProcess(processState);
    } catch (err) {
      console.error('[claude-swift] spawn error:', err);
      if (this._onError) this._onError(id, err.message, err.stack);
      throw err;
    }
  }

  spawnSync(command, args, options) {
    console.log('[claude-swift] spawnSync() cmd=' + command);
    try {
      const { cwd: optCwd, env: optEnv, ...safeOptions } = (options || {});
      const cwd = canonicalizePathForHostAccess(optCwd || process.cwd());
      // Intentionally inherit process.env here. The asar does not pass its
      // filtered LocalAgentMode envVars through spawnSync(), so ignoring
      // options.env preserves the existing behavior while still blocking
      // callers from overriding the canonicalized cwd.
      if (optEnv && typeof optEnv === 'object') {
        trace('WARNING: spawnSync() ignoring options.env override');
      }
      const translatedArgs = Array.isArray(args)
        ? args.map(a => typeof a === 'string' ? translateVmPathsInString(a) : a)
        : [];
      const result = nodeSpawnSync(command, translatedArgs, { encoding: 'utf-8', cwd, ...safeOptions });
      return { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal, error: result.error };
    } catch (err) {
      console.error('[claude-swift] spawnSync error:', err);
      return { error: err, status: 1 };
    }
  }

  _startManagedProcess(processState) {
    const spawnContext = this._sessionOrchestrator.buildSpawnOptions({
      processId: processState.id,
      options: processState.options,
      envVars: processState.envVars,
      sharedCwdPath: processState.sharedCwdPath,
      onError: this._onError,
    });
    if (!spawnContext.success) {
      return spawnContext;
    }

    processState.envVars = spawnContext.envVars;
    processState.sharedCwdPath = spawnContext.spawnOptions.cwd || processState.sharedCwdPath;
    processState.attemptedResume = Array.isArray(processState.args) && processState.args.includes('--resume');
    processState.hadFirstResponse = false;
    processState.completedSuccessfully = false;
    processState.latestCliSessionId = null;
    processState.deferredResultLine = null;
    processState.stdoutSeq = 0;

    const proc = nodeSpawn(processState.command, processState.args || [], spawnContext.spawnOptions);
    this._processes.set(processState.id, proc);
    this._attachProcessListeners(processState, proc);

    if (processState.retryCount > 0 && processState.stdinHistory.length > 0 && proc.stdin) {
      const retryInput = this._buildRetryInput(processState);
      if (retryInput !== null && retryInput !== undefined) {
        proc.stdin.write(retryInput);
      }
    }

    return { success: true, pid: proc.pid };
  }

  _buildRetryInput(processState) {
    if (!processState || !Array.isArray(processState.stdinHistory) || processState.stdinHistory.length === 0) {
      return null;
    }

    const args = Array.isArray(processState.args) ? processState.args : [];
    const inputFormatIndex = args.indexOf('--input-format');
    const inputFormat = inputFormatIndex >= 0 ? args[inputFormatIndex + 1] : null;
    const allowsPlaintextContinuity = inputFormat !== 'stream-json';

    if (
      allowsPlaintextContinuity &&
      processState.continuityPlan &&
      processState.continuityPlan.strategy === 'transcript_hydration_prompt'
    ) {
      const stdinText = processState.stdinHistory.map((chunk) => {
        if (typeof chunk === 'string') {
          return chunk;
        }
        if (Buffer.isBuffer(chunk)) {
          return chunk.toString('utf8');
        }
        return null;
      });

      if (stdinText.every((chunk) => typeof chunk === 'string')) {
        trace('Applying orchestrator continuity retry plan for process ' + processState.id);
        return processState.continuityPlan.hydratedPrompt + stdinText.join('');
      }
    }
    if (
      !allowsPlaintextContinuity &&
      processState.continuityPlan &&
      processState.continuityPlan.strategy === 'transcript_hydration_prompt'
    ) {
      trace(
        'Skipping plaintext continuity hydration for process ' + processState.id
          + ' due to incompatible input format: ' + String(inputFormat || 'unknown')
      );
    }

    trace('Replaying ' + processState.stdinHistory.length + ' stdin chunks after fresh retry for process ' + processState.id);
    return Buffer.concat(processState.stdinHistory.map((chunk) => (
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    )));
  }

  _attachProcessListeners(processState, proc) {
    const self = this;
    let stdoutBuffer = '';
    let stderrBuffer = '';

    if (proc.stdin) {
      proc.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE') trace('stdin error for process ' + processState.id + ': ' + err.message);
      });
    }

    if (proc.stdout) {
      proc.stdout.on('data', function(data) {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop();
        for (const line of lines) {
          self._handleProcessStdoutLine(processState, line);
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
            self._onStderr(processState.id, line + '\n');
          }
        }
      });
    }
    proc.on('exit', function(code, signal) {
      if (stdoutBuffer.trim()) {
        self._handleProcessStdoutLine(processState, stdoutBuffer);
      }
      if (stderrBuffer.trim() && self._onStderr) {
        self._onStderr(processState.id, stderrBuffer);
      }
      console.log('[claude-swift] Process ' + processState.id + ' exited: code=' + code + ' signal=' + signal);
      trace('Process ' + processState.id + ' exited: code=' + code + ' signal=' + signal);
      if (self._handleFlatlineRetry(processState, proc, code, signal || '')) {
        return;
      }
      if (processState.deferredResultLine && self._onStdout) {
        self._onStdout(processState.id, processState.deferredResultLine);
        processState.deferredResultLine = null;
      }
      if (
        processState.retryCount > 0 &&
        processState.completedSuccessfully &&
        processState.latestCliSessionId
      ) {
        const persistenceResult = self._sessionOrchestrator.persistRecoveredCliSession({
          cliSessionId: processState.latestCliSessionId,
          envVars: processState.envVars,
        });
        if (!persistenceResult.success) {
          trace('WARNING: Failed to persist recovered cliSessionId for process ' + processState.id + ': ' + persistenceResult.error);
        }
      }
      // Preserve null code for signaled exits - don't coerce to 0
      if (self._onExit) self._onExit(processState.id, code, signal || '');
      if (self._processes.get(processState.id) === proc) {
        self._processes.delete(processState.id);
      }
      self._processStates.delete(processState.id);
    });
    proc.on('error', function(err) {
      console.error('[claude-swift] Process ' + processState.id + ' error:', err);
      if (self._onError) self._onError(processState.id, err.message, err.stack);
    });
  }

  _handleProcessStdoutLine(processState, line) {
    if (!line.trim() || !this._onStdout) {
      return;
    }
    const ignoredSdkType = getIgnoredSdkMessageType(line);
    if (ignoredSdkType) {
      if (TRACE_IO) {
        trace('stdout ignored sdk message type: ' + ignoredSdkType);
      }
      return;
    }

    const parsed = parseJsonLine(line);
    const cliSessionId = extractCliSessionId(parsed);
    if (cliSessionId) {
      processState.latestCliSessionId = cliSessionId;
    }
    if (hasAssistantResponse(parsed)) {
      processState.hadFirstResponse = true;
    }
    if (isSuccessfulResult(parsed)) {
      processState.completedSuccessfully = true;
    }
    if (
      processState.attemptedResume &&
      processState.retryCount === 0 &&
      !processState.hadFirstResponse &&
      isFlatlineResumeResult(parsed)
    ) {
      processState.deferredResultLine = line + '\n';
      trace('Deferred flatline resume result for process ' + processState.id);
      return;
    }

    processState.stdoutSeq += 1;
    const msgType = parsed ? (parsed.type || (parsed.message && parsed.message.role) || 'data') : 'unknown';
    console.log('[stdout-order] seq=' + processState.stdoutSeq + ' type=' + msgType + ' ts=' + Date.now() + ' len=' + line.length);
    if (TRACE_IO) {
      trace('stdout line: ' + line.substring(0, 500) + (line.length > 500 ? '...' : ''));
    }
    this._onStdout(processState.id, line + '\n');
  }

  _handleFlatlineRetry(processState, proc, code, signal) {
    if (
      !processState.attemptedResume ||
      processState.retryCount > 0 ||
      processState.hadFirstResponse ||
      signal
    ) {
      trace('Flatline retry skipped for ' + processState.id + ': ' +
        (!processState.attemptedResume ? 'not a resume' :
         processState.retryCount > 0 ? 'already retried' :
         processState.hadFirstResponse ? 'had response' :
         'killed by signal ' + signal));
      return false;
    }

    const retryContext = this._sessionOrchestrator.prepareFlatlineRetry({
      args: processState.args,
      envVars: processState.envVars,
      sharedCwdPath: processState.sharedCwdPath,
    });
    if (!retryContext.success) {
      trace('Skipping flatline retry for process ' + processState.id + ': ' + retryContext.error);
      return false;
    }

    const deferredResultLine = processState.deferredResultLine;
    processState.retryCount += 1;
    processState.args = Array.isArray(retryContext.args) ? retryContext.args.slice() : [];
    processState.envVars = retryContext.envVars && typeof retryContext.envVars === 'object'
      ? { ...retryContext.envVars }
      : processState.envVars;
    processState.sharedCwdPath = retryContext.sharedCwdPath;
    processState.attemptedResume = false;
    processState.continuityPlan = retryContext.continuityPlan || null;

    trace('Retrying flatlined resume via ' + (retryContext.retryMode || 'fresh') + ' path for process ' + processState.id + ' after exit code=' + code);
    const retryResult = this._startManagedProcess(processState);
    if (retryResult && retryResult.success) {
      processState.deferredResultLine = null;
      if (this._processes.get(processState.id) === proc) {
        this._processes.delete(processState.id);
      }
      return true;
    }

    processState.deferredResultLine = deferredResultLine;
    trace('Fresh retry failed for process ' + processState.id + ': ' + (retryResult && retryResult.error ? retryResult.error : 'unknown error'));
    if (this._onError && retryResult && retryResult.error) {
      this._onError(processState.id, retryResult.error, '');
    }
    return false;
  }

  stopVM() {
    console.log('[claude-swift] stopVM()');
    for (const entry of this._processes) {
      try { entry[1].kill('SIGTERM'); } catch (e) {}
    }
    this._processes.clear();
    this._processStates.clear();
    this._guestConnected = false;
    this._emit('guestConnectionChanged', { connected: false });
  }

  killProcess(id, signal) {
    console.log('[claude-swift] killProcess(' + id + ')');
    const proc = this._processes.get(id);
    if (proc) {
      const sig = (typeof signal === 'string' && signal.length > 0) ? signal : 'SIGTERM';
      if (proc.exitCode !== null) return;

      // In LocalAgentMode, the desktop may call kill() immediately after receiving a result.
      // SIGTERM'ing too early can prevent Claude Code from persisting the conversation, which
      // breaks `--resume <session_id>` on the next turn. Give it a brief grace period.
      if (sig === 'SIGTERM') {
        if (!proc.__coworkKillTimers) proc.__coworkKillTimers = {};
        if (proc.__coworkKillTimers.term) return;

        proc.__coworkKillTimers.term = setTimeout(() => {
          try {
            if (proc.exitCode === null) proc.kill('SIGTERM');
          } catch (_e) { /* ignore */ }
        }, 1000);

        proc.__coworkKillTimers.kill = setTimeout(() => {
          try {
            if (proc.exitCode === null) proc.kill('SIGKILL');
          } catch (_e) { /* ignore */ }
        }, 6000);
        return;
      }

      try { proc.kill(sig); } catch (_e) { /* ignore */ }
    }
  }

  cancelProcess(id) {
    return this.killProcess(id);
  }

  isProcessRunning(id) {
    const proc = this._processes.get(id);
    // Only check exitCode - proc.killed flips on signal send, not process exit
    return !!(proc && proc.exitCode === null);
  }

  writeToProcess(id, data) {
    console.log('[claude-swift] writeToProcess(' + id + ')');
    const processState = this._processStates.get(id);
    if (processState) {
      const chunkSize = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), 'utf8');
      // Single chunk larger than the entire cap: drop history, skip recording.
      // Without this, eviction empties history and the oversized chunk is
      // still pushed, leaving stdinHistoryBytes permanently above the limit.
      if (chunkSize > MAX_STDIN_HISTORY_BYTES) {
        trace('WARNING: stdinHistory chunk exceeds cap for process ' + id + ' (' + chunkSize + ' bytes), clearing history and skipping record');
        processState.stdinHistory = [];
        processState.stdinHistoryBytes = 0;
      } else {
        processState.stdinHistoryBytes += chunkSize;
        if (processState.stdinHistoryBytes > MAX_STDIN_HISTORY_BYTES) {
          trace('WARNING: stdinHistory size cap reached for process ' + id + ', evicting oldest entries');
          while (processState.stdinHistory.length > 0 && processState.stdinHistoryBytes > MAX_STDIN_HISTORY_BYTES / 2) {
            const removed = processState.stdinHistory.shift();
            processState.stdinHistoryBytes -= (Buffer.isBuffer(removed) ? removed.length : Buffer.byteLength(String(removed), 'utf8'));
          }
        }
        processState.stdinHistory.push(data);
      }
    }
    const proc = this._processes.get(id);
    if (proc && proc.stdin && proc.exitCode === null) {
      trace('Sending ' + Buffer.byteLength(data) + ' bytes to stdin of process ' + id);
      proc.stdin.write(data, (err) => {
        if (err) trace('stdin write error for process ' + id + ': ' + err.message);
      });
    } else {
      trace('stdin write dropped for process ' + id + ': ' +
        (!proc ? 'no process' : proc.exitCode !== null ? 'exited with code ' + proc.exitCode : 'no stdin'));
    }
  }

  _emit(eventName, payload) {
    if (this._eventListener) this._eventListener(eventName, payload);
    this.emit(eventName, payload);
  }

  isGuestConnected() {
    return Promise.resolve(this._guestConnected);
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

module.exports.filterEnv = filterEnv;

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
