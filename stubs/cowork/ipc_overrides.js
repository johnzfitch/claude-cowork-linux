'use strict';

// Linux IPC override registry.
//
// Defines handler overrides keyed by channel SUFFIX (the part after the
// EIPC UUID prefix). The frame-fix-wrapper intercepts webContents.ipc.handle()
// and ipcMain.handle() at REGISTRATION time, matching each channel's suffix
// against this registry. If a match is found the asar's handler is replaced
// with ours — no UUID discovery or post-hoc removal needed.

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const {
  CLAUDE_CODE_STATUS,
  CLAUDE_CODE_PREPARE,
  CLAUDE_VM_RUNNING_STATUS,
  CLAUDE_VM_DOWNLOAD_STATUS,
  COMPUTER_USE_TCC_GRANTED,
  COMPUTER_USE_TCC_REQUEST_GRANTED,
} = require('./linux_ipc_stubs.js');
const { createSpacesStore } = require('./spaces_store.js');

// -- Helpers --

// Verbose logging: only emitted when CLAUDE_COWORK_VERBOSE=1 (set by --perf).
// Keeps production output clean while preserving diagnostics for debugging.
const _verbose = process.env.CLAUDE_COWORK_VERBOSE === '1';
function vlog(msg) { if (_verbose) console.log(msg); }

// Security boundary: homedir resolved to canonical form at load time.
// Uses passwd-based homedir (not $HOME), then realpathSync to defeat
// symlinked home directories.
var _rawHomeDir = global.__coworkPasswdHomedir || require('os').userInfo().homedir;
var _realHomeDir;
try { _realHomeDir = fs.realpathSync(_rawHomeDir); } catch (_) { _realHomeDir = _rawHomeDir; }

// Only the user's home directory is an allowed root. No /tmp, no
// system dirs, no world-writable paths.
var _allowedFsRoots = [_realHomeDir];

// Validate and resolve a path in one pass. No normalization, no
// transformation. The input must be a clean absolute path as-given.
// Returns the canonical real path if valid, null if anything is wrong.
function verifyPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  if (rawPath.charCodeAt(0) !== 47) return null;
  if (rawPath.indexOf('\0') >= 0) return null;
  // Strip trailing slash for normalization (legitimate directory paths
  // often arrive with one). Empty result means input was just "/" — reject.
  var clean = rawPath;
  while (clean.length > 1 && clean.charCodeAt(clean.length - 1) === 47) {
    clean = clean.slice(0, -1);
  }
  if (clean.length <= 1) return null;
  var segments = clean.split('/');
  for (var i = 1; i < segments.length; i++) {
    if (segments[i] === '' || segments[i] === '.' || segments[i] === '..') return null;
  }
  var real;
  try {
    real = fs.realpathSync(clean);
  } catch (_) {
    return null;
  }
  if (!_allowedFsRoots.some(function(root) {
    return real === root || real.startsWith(root + '/');
  })) {
    return null;
  }
  return real;
}

function isPathWithinAllowedRoots(filePath) {
  return verifyPath(filePath) !== null;
}

function getSpacesStore() {
  // Reuse the early-registered store from frame-fix-wrapper if it exists.
  // Two separate instances would have separate rate-limit state and could
  // race on the spaces.json atomic rename — single global instance avoids both.
  if (global.__coworkSpacesStore) return global.__coworkSpacesStore;
  const dirs = global.__coworkDirs;
  const localAgentRoot = dirs ? dirs.claudeLocalAgentRoot : path.join(_realHomeDir, '.config', 'Claude', 'local-agent-mode-sessions');
  global.__coworkSpacesStore = createSpacesStore({ localAgentRoot, isPathAllowed: isPathWithinAllowedRoots, trace: vlog });
  return global.__coworkSpacesStore;
}

function createSpacesOverrides() {
  const store = getSpacesStore();
  return {
    'CoworkSpaces_$_getAllSpaces': async (event) => store.getAllSpaces(),
    'CoworkSpaces_$_getSpace': async (event, spaceId) => store.getSpace(event, spaceId),
    'CoworkSpaces_$_createSpace': async (event, spaceData) => store.createSpace(event, spaceData),
    'CoworkSpaces_$_updateSpace': async (event, spaceId, updates) => store.updateSpace(event, spaceId, updates),
    'CoworkSpaces_$_deleteSpace': async (event, spaceId) => store.deleteSpace(event, spaceId),
    'CoworkSpaces_$_addFolderToSpace': async (event, spaceId, folderPath) => store.addFolderToSpace(event, spaceId, folderPath),
    'CoworkSpaces_$_removeFolderFromSpace': async (event, spaceId, folderPath) => store.removeFolderFromSpace(event, spaceId, folderPath),
    'CoworkSpaces_$_addProjectToSpace': async (event, spaceId, project) => store.addProjectToSpace(event, spaceId, project),
    'CoworkSpaces_$_removeProjectFromSpace': async (event, spaceId, projectId) => store.removeProjectFromSpace(event, spaceId, projectId),
    'CoworkSpaces_$_addLinkToSpace': async (event, spaceId, link) => store.addLinkToSpace(event, spaceId, link),
    'CoworkSpaces_$_removeLinkFromSpace': async (event, spaceId, linkId) => store.removeLinkFromSpace(event, spaceId, linkId),
    'CoworkSpaces_$_getAutoMemoryDir': async (event, spaceId) => store.getAutoMemoryDir(event, spaceId),
    'CoworkSpaces_$_listFolderContents': async (event, folderPath) => store.listFolderContents(event, folderPath),
    'CoworkSpaces_$_readFileContents': async (event, filePath) => store.readFileContents(event, filePath),
    'CoworkSpaces_$_openFile': async (event, filePath) => store.openFile(event, filePath),
    'CoworkSpaces_$_copyFilesToSpaceFolder': async (event, spaceId, files) => store.copyFilesToSpaceFolder(event, spaceId, files),
    'CoworkSpaces_$_createSpaceFolder': async (event, spaceId, folderName) => store.createSpaceFolder(event, spaceId, folderName),
    'CoworkSpaces_$_classifySessions': async (event, sessions) => store.classifySessions(event, sessions),
    'CoworkSpaces_$_setAutoDescription': async (event, spaceId, description) => store.setAutoDescription(event, spaceId, description),
    'CoworkSpaces_$_summarizeSpace': async (event, spaceId) => store.summarizeSpace(event, spaceId),
    'CoworkSpaces_$_onSpaceEvent': async (event, callback) => store.onSpaceEvent(event, callback),
  };
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const MIME_MAP = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.js': 'text/javascript', '.ts': 'text/typescript', '.jsx': 'text/javascript',
    '.tsx': 'text/typescript', '.html': 'text/html', '.css': 'text/css',
    '.xml': 'text/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
    '.toml': 'text/toml', '.csv': 'text/csv', '.sh': 'text/x-shellscript',
    '.py': 'text/x-python', '.rb': 'text/x-ruby', '.rs': 'text/x-rust',
    '.go': 'text/x-go', '.java': 'text/x-java', '.c': 'text/x-c',
    '.cpp': 'text/x-c++', '.h': 'text/x-c', '.hpp': 'text/x-c++',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.pdf': 'application/pdf',
  };
  return MIME_MAP[ext] || 'text/plain';
}

const BINARY_MIME_PREFIXES = ['image/', 'audio/', 'video/', 'application/pdf', 'application/octet'];

function isBinaryMime(mime) {
  return BINARY_MIME_PREFIXES.some(p => mime.startsWith(p));
}

// Public API: front-door validator. Logs every block with the original
// input. Returns the file content or null. Internal _readVerifiedContent
// trusts its input — it can only be reached after verifyPath succeeds.
function readLocalFileContent(rawPath, context) {
  var real = verifyPath(rawPath);
  if (!real) {
    console.warn('[Cowork] ' + (context || 'readLocalFileContent') + ' BLOCKED:', rawPath);
    return null;
  }
  return _readVerifiedContent(real);
}

function _readVerifiedContent(real) {
  var buf = fs.readFileSync(real);
  var mime = getMimeType(real);
  var fileName = path.basename(real);
  if (isBinaryMime(mime)) {
    return { content: buf.toString('base64'), mimeType: mime, fileName: fileName, encoding: 'base64' };
  }
  return { content: buf.toString('utf-8'), mimeType: mime, fileName: fileName, encoding: 'utf-8' };
}

const XDG_APP_DIRS = [
  '/usr/share/applications',
  '/usr/local/share/applications',
  path.join(_realHomeDir, '.local', 'share', 'applications'),
];

function readDesktopFile(desktopFile) {
  if (!desktopFile) return null;
  if (path.basename(desktopFile) !== desktopFile) return null;
  for (const dir of XDG_APP_DIRS) {
    try {
      return fs.readFileSync(path.join(dir, desktopFile), 'utf-8');
    } catch (_) {}
  }
  return null;
}

function isTerminalApp(desktopFile) {
  const content = readDesktopFile(desktopFile);
  if (!content) return false;
  return /^Terminal\s*=\s*true/m.test(content);
}

function getDesktopFileForMime(mime) {
  try {
    return execFileSync('xdg-mime', ['query', 'default', mime], {
      encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim() || null;
  } catch (_) {
    return null;
  }
}

function getExecFromDesktop(desktopFile) {
  const content = readDesktopFile(desktopFile);
  if (!content) return null;
  const match = content.match(/^Exec\s*=\s*(\S+)/m);
  return match ? match[1] : null;
}


// Terminal emulator resolution — cached after first successful lookup.
// EVERY path goes through validateBinary() so PATH-hijacking attacks
// (malicious 'kitty' on $PATH) are blocked the same way $TERMINAL is.
let _resolvedTerminal = undefined;

const _TERMINAL_SAFE_DIRS = ['/usr/bin/', '/usr/local/bin/', '/usr/lib/', '/snap/bin/'];

function validateTerminalBinary(binName) {
  // Resolve the binary via `which` and confirm it lives in a system dir
  // (or is accepted by the exec capability registry). Returns the
  // resolved path or null.
  var resolvedPath;
  try {
    resolvedPath = execFileSync('which', [binName], { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return null;
  }
  if (!resolvedPath) return null;
  var registry = global.__coworkExecRegistry || null;
  if (registry) {
    var cap = registry.resolve(resolvedPath, []);
    if (cap && (cap.capabilityId === 'system-cmd' || (typeof cap.capabilityId === 'string' && cap.capabilityId.indexOf('system-') === 0))) {
      return resolvedPath;
    }
    return null;
  }
  // Registry not available — fall back to system dir check.
  if (_TERMINAL_SAFE_DIRS.some(function(d) { return resolvedPath.startsWith(d); })) {
    return resolvedPath;
  }
  return null;
}

function resolveTerminal() {
  if (_resolvedTerminal !== undefined) return _resolvedTerminal;
  // 1. $TERMINAL env var
  const envTerm = process.env.TERMINAL;
  if (envTerm) {
    var envResolved = validateTerminalBinary(envTerm);
    if (envResolved) {
      _resolvedTerminal = { bin: envResolved, spawn: ['-e'] };
      return _resolvedTerminal;
    }
    console.warn('[Cowork] $TERMINAL not in safe dirs / registry, ignoring:', envTerm);
  }
  // 2. xdg-terminal-exec
  var xdgResolved = validateTerminalBinary('xdg-terminal-exec');
  if (xdgResolved) {
    _resolvedTerminal = { bin: xdgResolved, spawn: null };
    return _resolvedTerminal;
  }
  // 3. Common terminal emulators
  const terminals = [
    'kitty', 'ghostty', 'alacritty', 'foot', 'wezterm',
    'gnome-terminal', 'konsole', 'xfce4-terminal', 'mate-terminal',
    'tilix', 'lxterminal', 'terminology', 'sakura', 'xterm',
  ];
  const dashDashTerminals = new Set(['gnome-terminal', 'konsole']);
  for (const t of terminals) {
    var resolved = validateTerminalBinary(t);
    if (resolved) {
      _resolvedTerminal = { bin: resolved, spawn: dashDashTerminals.has(t) ? ['--'] : ['-e'] };
      return _resolvedTerminal;
    }
  }
  _resolvedTerminal = null;
  return null;
}

// Public API: front-door validator. Logs blocks with the original input.
// Internal _xdgOpenVerified trusts its input.
function xdgOpen(rawPath, context) {
  var real = verifyPath(rawPath);
  if (!real) {
    console.warn('[Cowork] ' + (context || 'xdgOpen') + ' BLOCKED:', rawPath);
    return;
  }
  _xdgOpenVerified(real);
}

function _xdgOpenVerified(real) {
  try { if (fs.statSync(real).isDirectory()) {
    var child = execFile('xdg-open', [real], { stdio: 'ignore' });
    child.unref();
    return;
  }} catch (_) {}
  var mime = getMimeType(real);
  var desktop = getDesktopFileForMime(mime);
  if (isTerminalApp(desktop)) {
    var cmd = getExecFromDesktop(desktop);
    if (cmd) {
      var term = resolveTerminal();
      if (term) {
        var tchild = term.spawn
          ? execFile(term.bin, [].concat(term.spawn, [cmd, real]), { stdio: 'ignore' })
          : execFile(term.bin, [cmd, real], { stdio: 'ignore' });
        tchild.unref();
        return;
      }
    }
  }
  var ochild = execFile('xdg-open', [real], { stdio: 'ignore' });
  ochild.unref();
}

function whichApplicationForFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!ext) return null;
  // Use extension-based MIME lookup so the file doesn't need to exist on disk
  const mime = getMimeType(filename);
  try {
    const desktop = execFileSync('xdg-mime', ['query', 'default', mime], {
      encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (!desktop) return null;
    const appName = desktop.replace(/\.desktop$/, '').replace(/-/g, ' ');
    return { appName: appName || 'Default Application' };
  } catch (_) {
    return null;
  }
}

// -- Override registry --
// Keys are matched via channel.includes(key). This handles the
// _$_Namespace_$_Method pattern regardless of UUID prefix.

function createOverrideRegistry(getProcessState) {
  return {
    // ClaudeCode — Code tab readiness
    'ClaudeCode_$_getStatus': async () => 'ready',
    'ClaudeCode_$_prepare': async () => ({ ...CLAUDE_CODE_PREPARE }),
    'ClaudeCode_$_checkGitAvailable': async () => ({ available: true }),

    // ComputerUseTcc — Linux has no TCC UI; deny by default for safety
    'ComputerUseTcc_$_getState': async () => ({ ...COMPUTER_USE_TCC_GRANTED }),
    'ComputerUseTcc_$_requestAccess': async () => ({ ...COMPUTER_USE_TCC_REQUEST_GRANTED }),
    'ComputerUseTcc_$_requestAccessibility': async () => ({ ...COMPUTER_USE_TCC_REQUEST_GRANTED }),
    'ComputerUseTcc_$_requestScreenRecording': async () => ({ ...COMPUTER_USE_TCC_REQUEST_GRANTED }),
    'ComputerUseTcc_$_openSystemSettings': async () => {},
    'ComputerUseTcc_$_getCurrentSessionGrants': async () => ([]),
    'ComputerUseTcc_$_revokeGrant': async () => {},

    // ClaudeVM — report VM as running and ready (webapp expects string "ready")
    'ClaudeVM_$_getRunningStatus': async () => CLAUDE_VM_RUNNING_STATUS,
    'ClaudeVM_$_getDownloadStatus': async () => CLAUDE_VM_DOWNLOAD_STATUS,
    'ClaudeVM_$_isSupported': async () => 'supported',
    'ClaudeVM_$_getSupportStatus': async () => 'supported',
    'ClaudeVM_$_checkVirtualMachinePlatform': async () => ({ supported: true }),
    'ClaudeVM_$_apiReachability': async () => ({ reachable: true }),
    'ClaudeVM_$_isProcessRunning': async (...args) => getProcessState(args),
    'ClaudeVM_$_startVM': async () => ({ success: true }),
    'ClaudeVM_$_download': async () => ({ success: true }),
    'ClaudeVM_$_deleteAndReinstall': async () => ({ success: true }),

    // FileSystem — single front-door validation per call.
    // readLocalFileContent and xdgOpen validate at their boundary and
    // log every block. Handlers just decode and delegate.
    'FileSystem_$_readLocalFile': async (_event, _sessionId, filePath) => {
      var decoded;
      try { decoded = decodeURIComponent(filePath); } catch (_) { return null; }
      try {
        return readLocalFileContent(decoded, 'readLocalFile');
      } catch (e) {
        console.error('[Cowork] readLocalFile failed:', e.code || e.message);
        return null;
      }
    },

    'FileSystem_$_openLocalFile': async (_event, _sessionId, filePath, showInFolder) => {
      var decoded;
      try { decoded = decodeURIComponent(filePath); } catch (_) { return; }
      if (showInFolder) {
        // Try the parent directory; if that's outside allowed roots
        // (e.g. file IS the home dir), fall back to opening the file itself
        // so users can reveal-in-finder their home.
        var parent = path.dirname(decoded);
        var parentReal = verifyPath(parent);
        if (parentReal) {
          xdgOpen(parent, 'openLocalFile.parent');
        } else {
          xdgOpen(decoded, 'openLocalFile.fallback');
        }
      } else {
        xdgOpen(decoded, 'openLocalFile');
      }
    },

    'FileSystem_$_whichApplication': async (_event, filename) => {
      return whichApplicationForFile(filename);
    },

    'FileSystem_$_showInFolder': async (_event, filePath) => {
      var decoded;
      try { decoded = decodeURIComponent(filePath); } catch (_) { return; }
      xdgOpen(path.dirname(decoded), 'showInFolder');
    },

    'FileSystem_$_getSystemPath': async (_event, name) => {
      const { app } = require('electron');
      try {
        return app.getPath(name);
      } catch (_) {
        return null;
      }
    },

    'FileSystem_$_writeFileDownloadAndOpen': async (_event, filename, url) => {
      vlog('[Cowork] writeFileDownloadAndOpen: ' + filename);
      try {
        const { app, net } = require('electron');
        // Validate filename
        if (filename !== path.basename(filename) || filename.includes('..')) {
          console.error('[Cowork] writeFileDownloadAndOpen: invalid filename');
          return;
        }
        const response = await net.fetch(url);
        if (!response.ok) {
          console.error('[Cowork] writeFileDownloadAndOpen: fetch failed:', response.status);
          return;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        let downloadsDir;
        try { downloadsDir = app.getPath('downloads'); }
        catch (_) { downloadsDir = path.join(require('os').homedir(), 'Downloads'); }
        fs.mkdirSync(downloadsDir, { recursive: true });
        const ext = path.extname(filename);
        const stem = path.basename(filename, ext);
        let dest = path.join(downloadsDir, filename);
        let i = 1;
        while (fs.existsSync(dest)) {
          dest = path.join(downloadsDir, `${stem}_${i++}${ext}`);
        }
        fs.writeFileSync(dest, buffer);
        vlog('[Cowork] Downloaded to: ' + dest);
        xdgOpen(dest);
      } catch (e) {
        console.error('[Cowork] writeFileDownloadAndOpen failed:', e.message);
      }
    },

    // Menu — Linux has no native menu bar; serve popup from stored application menu
    'MainWindowTitleBar_$_requestMainMenuPopup': async (event) => {
      const menu = global.__coworkApplicationMenu;
      if (!menu || typeof menu.popup !== 'function') return;
      const { BrowserWindow } = require('electron');
      const win = event?.sender ? BrowserWindow.fromWebContents(event.sender) : BrowserWindow.getFocusedWindow();
      try { menu.popup({ window: win || undefined }); } catch (_) {}
    },
    'BrowserNavigation_$_requestMainMenuPopup': async (event) => {
      const menu = global.__coworkApplicationMenu;
      if (!menu || typeof menu.popup !== 'function') return;
      const { BrowserWindow } = require('electron');
      const win = event?.sender ? BrowserWindow.fromWebContents(event.sender) : BrowserWindow.getFocusedWindow();
      try { menu.popup({ window: win || undefined }); } catch (_) {}
    },

    // CoworkSpaces — file-backed implementation for Linux
    ...createSpacesOverrides(),

    // Startup — Linux has no macOS login items; report disabled
    'Startup_$_isStartupOnLoginEnabled': async () => false,
    'Startup_$_setStartupOnLoginEnabled': async (_event, enabled) => {
      vlog('[ipc:setStartupOnLoginEnabled] enabled=' + enabled + ' (no-op on Linux)');
      return null;
    },
    'Startup_$_isMenuBarEnabled': async () => false,
    'Startup_$_setMenuBarEnabled': async (_event, enabled) => {
      vlog('[ipc:setMenuBarEnabled] enabled=' + enabled + ' (no-op on Linux)');
      return null;
    },

    // LocalAgentModeSessions — Bridge handlers are intentionally NOT overridden.
    // The asar's LocalAgentModeSessionManager owns these; overriding them blocks
    // the manual user-acceptance flow (Allow/Deny clicks) from reaching the
    // bridge. Wrapper-side bounds on this flow are enforced elsewhere:
    //   - Auto-permissions toggle TTL cap: see Phase 2 in frame-fix-wrapper.js
    //   - Working-dir refusals: see Phase 3 in claude-swift/js/index.js
    //   - Channel surface canary: see Phase 4 in ipc_tap.js

    // ================================================================
    // MCP handlers — Desktop MCP integration (not CLI MCP)
    // ================================================================

    'LocalAgentModeSessions_$_mcpCallTool': async (_event, ...args) => {
      vlog('[ipc:mcpCallTool] called');
      return null;
    },

    'LocalAgentModeSessions_$_mcpListResources': async (_event, ...args) => {
      vlog('[ipc:mcpListResources] called');
      return [];
    },

    'LocalAgentModeSessions_$_mcpReadResource': async (_event, ...args) => {
      vlog('[ipc:mcpReadResource] called');
      return null;
    },

    // ================================================================
    // Permissions / Folders — Linux has no TCC or Chrome extension model
    // ================================================================

    'LocalAgentModeSessions_$_requestFolderTccAccess': async (_event, ...args) => {
      vlog('[ipc:requestFolderTccAccess] called (denied on Linux — no TCC UI)');
      return { granted: false };
    },

    'LocalAgentModeSessions_$_setChromePermissionMode': async (_event, mode) => {
      vlog('[ipc:setChromePermissionMode] mode=' + mode);
      return null;
    },

    // ================================================================
    // Session management — event relay and session lifecycle
    // ================================================================

    'LocalAgentModeSessions_$_onCoworkFromMain': async (_event, ...args) => {
      // Main process event relay to webapp — acknowledged
      return null;
    },

    'LocalAgentModeSessions_$_onRemoteSessionStart': async (_event, ...args) => {
      vlog('[ipc:onRemoteSessionStart] called');
      return null;
    },

    'LocalAgentModeSessions_$_openOutputsDir': async (_event, sessionId) => {
      vlog('[ipc:openOutputsDir] sessionId=' + sessionId);
      // Open the session's outputs directory in the file manager
      const orchestrator = global.__coworkSessionOrchestrator;
      const dirs = global.__coworkDirs;
      if (dirs && typeof sessionId === 'string' && sessionId.trim()) {
        const outputsDir = path.join(dirs.claudeLocalAgentRoot, 'outputs');
        try {
          if (fs.existsSync(outputsDir)) {
            xdgOpen(outputsDir);
            return null;
          }
        } catch (_) {}
      }
      // Fallback: open the local-agent-mode-sessions root
      if (dirs) {
        try { xdgOpen(dirs.claudeLocalAgentRoot); } catch (_) {}
      }
      return null;
    },

    'LocalAgentModeSessions_$_setDraftSessionFolders': async (_event, folders) => {
      vlog('[ipc:setDraftSessionFolders] folders=' + JSON.stringify(folders));
      return null;
    },

    // ================================================================
    // Plugin/Skill — directory listing and skill sync
    // ================================================================

    'LocalAgentModeSessions_$_respondDirectoryServers': async (_event, ...args) => {
      vlog('[ipc:respondDirectoryServers] called');
      return null;
    },

    'LocalAgentModeSessions_$_respondPluginSearch': async (_event, ...args) => {
      vlog('[ipc:respondPluginSearch] called');
      return null;
    },

    'LocalAgentModeSessions_$_syncSkills': async (_event, ...args) => {
      vlog('[ipc:syncSkills] called');
      return null;
    },

    // ================================================================
    // Sharing — not supported on Linux desktop
    // ================================================================

    'LocalAgentModeSessions_$_shareSession': async (_event, sessionId) => {
      vlog('[ipc:shareSession] sessionId=' + sessionId + ' (not supported on Linux)');
      return null;
    },
  };
}

// -- Channel matching --

function matchOverride(channel, registry) {
  if (typeof channel !== 'string') return null;
  for (const suffix of Object.keys(registry)) {
    if (channel.endsWith(suffix)) {
      return registry[suffix];
    }
  }
  return null;
}

// -- Proactive EIPC registration --
// Some handlers (ComputerUseTcc, CoworkSpaces) are never registered by the
// asar on Linux because they depend on macOS-only native modules. The webapp
// still invokes them, causing "No handler registered" errors. We proactively
// register these on ipcMain once we discover the EIPC UUID. Only handlers
// the asar never registers need this — others are intercepted at
// webContents.ipc.handle() registration time.

const PROACTIVE_ONLY_SUFFIXES = new Set([
  'ComputerUseTcc_$_getState',
  'ComputerUseTcc_$_requestAccess',
  'ComputerUseTcc_$_requestAccessibility',
  'ComputerUseTcc_$_requestScreenRecording',
  'ComputerUseTcc_$_openSystemSettings',
  'ComputerUseTcc_$_getCurrentSessionGrants',
  'ComputerUseTcc_$_revokeGrant',
  // CoworkSpaces — proactive because the asar's native handler registration
  // depends on account IPC from the renderer, which often never arrives on Linux.
  // Without proactive registration, getAllSpaces has no handler and fails silently.
  'CoworkSpaces_$_getAllSpaces',
  'CoworkSpaces_$_getSpace',
  'CoworkSpaces_$_createSpace',
  'CoworkSpaces_$_updateSpace',
  'CoworkSpaces_$_deleteSpace',
  'CoworkSpaces_$_addFolderToSpace',
  'CoworkSpaces_$_removeFolderFromSpace',
  'CoworkSpaces_$_addProjectToSpace',
  'CoworkSpaces_$_removeProjectFromSpace',
  'CoworkSpaces_$_addLinkToSpace',
  'CoworkSpaces_$_removeLinkFromSpace',
  'CoworkSpaces_$_getAutoMemoryDir',
  'CoworkSpaces_$_listFolderContents',
  'CoworkSpaces_$_readFileContents',
  'CoworkSpaces_$_openFile',
  'CoworkSpaces_$_copyFilesToSpaceFolder',
  'CoworkSpaces_$_createSpaceFolder',
  'CoworkSpaces_$_classifySessions',
  'CoworkSpaces_$_setAutoDescription',
  'CoworkSpaces_$_summarizeSpace',
  'CoworkSpaces_$_onSpaceEvent',
  // Startup — Linux has no macOS login items. The asar's handler calls
  // app.getLoginItemSettings() which crashes on Linux. The asar registers
  // these on webContents.ipc.handle() which our patch intercepts, but
  // contents.ipc.removeHandler() (unpatched) can clear the override before
  // the settings page invokes them. Proactive registration on ipcMain
  // provides a stable fallback protected from removal.
  'Startup_$_isStartupOnLoginEnabled',
  'Startup_$_setStartupOnLoginEnabled',
  'Startup_$_isMenuBarEnabled',
  'Startup_$_setMenuBarEnabled',
]);

const EIPC_NAMESPACES = ['claude.web', 'claude.hybrid', 'claude.settings'];
const _registeredUuids = new Set();
const _proactiveChannels = new Set();

function extractEipcUuid(channel) {
  if (typeof channel !== 'string' || !channel.startsWith('$eipc_message$_')) return null;
  const match = channel.match(/^\$eipc_message\$_([a-f0-9-]+)_\$_/);
  return match ? match[1] : null;
}

function proactivelyRegisterOverrides(ipcMainHandle, ipcMainRemoveHandler, registry, uuid) {
  if (_registeredUuids.has(uuid)) return _proactiveChannels;
  _registeredUuids.add(uuid);
  for (const suffix of PROACTIVE_ONLY_SUFFIXES) {
    const handler = registry[suffix];
    if (!handler) continue;
    for (const ns of EIPC_NAMESPACES) {
      const fullChannel = `$eipc_message$_${uuid}_$_${ns}_$_${suffix}`;
      try {
        try { ipcMainRemoveHandler(fullChannel); } catch (_) {}
        ipcMainHandle(fullChannel, handler);
        _proactiveChannels.add(fullChannel);
      } catch (e) {
        // Handler already registered through another path
      }
    }
  }
  console.log('[Cowork] Proactively registered ' + _proactiveChannels.size + ' fallback handlers on ipcMain for UUID ' + uuid);
  return _proactiveChannels;
}

function isProactiveChannel(channel) {
  return _proactiveChannels.has(channel);
}

module.exports = {
  createOverrideRegistry,
  matchOverride,
  extractEipcUuid,
  proactivelyRegisterOverrides,
  isProactiveChannel,
  isPathWithinAllowedRoots,
  PROACTIVE_ONLY_SUFFIXES,
  getMimeType,
  isBinaryMime,
  readLocalFileContent,
};
