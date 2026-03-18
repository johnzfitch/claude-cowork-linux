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

// -- Helpers --

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

function readLocalFileContent(filePath) {
  const buf = fs.readFileSync(filePath);
  const mime = getMimeType(filePath);
  const fileName = path.basename(filePath);
  if (isBinaryMime(mime)) {
    return { content: buf.toString('base64'), mimeType: mime, fileName, encoding: 'base64' };
  }
  return { content: buf.toString('utf-8'), mimeType: mime, fileName, encoding: 'utf-8' };
}

const XDG_APP_DIRS = [
  '/usr/share/applications',
  '/usr/local/share/applications',
  path.join(require('os').homedir(), '.local', 'share', 'applications'),
];

function readDesktopFile(desktopFile) {
  if (!desktopFile) return null;
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
// Checks: $TERMINAL env, xdg-terminal-exec, then common emulators.
let _resolvedTerminal = undefined;
function resolveTerminal() {
  if (_resolvedTerminal !== undefined) return _resolvedTerminal;
  // 1. Respect $TERMINAL env var (user's explicit preference)
  const envTerm = process.env.TERMINAL;
  if (envTerm) {
    try {
      execFileSync('which', [envTerm], { stdio: 'ignore' });
      _resolvedTerminal = { bin: envTerm, spawn: ['-e'] };
      return _resolvedTerminal;
    } catch (_) {}
  }
  // 2. xdg-terminal-exec (proposed XDG Default Terminal Spec)
  try {
    execFileSync('which', ['xdg-terminal-exec'], { stdio: 'ignore' });
    _resolvedTerminal = { bin: 'xdg-terminal-exec', spawn: null };
    return _resolvedTerminal;
  } catch (_) {}
  // 3. Common terminal emulators (GPU-accelerated first, then traditional)
  const terminals = [
    'kitty', 'ghostty', 'alacritty', 'foot', 'wezterm',
    'gnome-terminal', 'konsole', 'xfce4-terminal', 'mate-terminal',
    'tilix', 'lxterminal', 'terminology', 'sakura', 'xterm',
  ];
  // gnome-terminal/konsole use '--' instead of '-e' for command separation
  const dashDashTerminals = new Set(['gnome-terminal', 'konsole']);
  for (const t of terminals) {
    try {
      execFileSync('which', [t], { stdio: 'ignore' });
      _resolvedTerminal = { bin: t, spawn: dashDashTerminals.has(t) ? ['--'] : ['-e'] };
      return _resolvedTerminal;
    } catch (_) {}
  }
  _resolvedTerminal = null;
  return null;
}

function xdgOpen(filePath) {
  // Directories should always open in the file manager via xdg-open
  try { if (fs.statSync(filePath).isDirectory()) {
    const child = execFile('xdg-open', [filePath], { stdio: 'ignore' });
    child.unref();
    return;
  }} catch (_) {}
  const mime = getMimeType(filePath);
  const desktop = getDesktopFileForMime(mime);
  if (isTerminalApp(desktop)) {
    const cmd = getExecFromDesktop(desktop);
    if (cmd) {
      // Resolve which terminal emulator to use (cached after first lookup)
      const term = resolveTerminal();
      if (term) {
        const child = term.spawn
          ? execFile(term.bin, [...term.spawn, cmd, filePath], { stdio: 'ignore' })
          : execFile(term.bin, [cmd, filePath], { stdio: 'ignore' });
        child.unref();
        return;
      }
    }
  }
  // Non-terminal app or no terminal found: use xdg-open
  const child = execFile('xdg-open', [filePath], { stdio: 'ignore' });
  child.unref();
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

    // ComputerUseTcc — Linux has no TCC, report granted
    'ComputerUseTcc_$_getState': async () => ({ ...COMPUTER_USE_TCC_GRANTED }),
    'ComputerUseTcc_$_requestAccess': async () => ({ ...COMPUTER_USE_TCC_REQUEST_GRANTED }),
    'ComputerUseTcc_$_requestAccessibility': async () => ({ ...COMPUTER_USE_TCC_REQUEST_GRANTED }),
    'ComputerUseTcc_$_requestScreenRecording': async () => ({ ...COMPUTER_USE_TCC_REQUEST_GRANTED }),
    'ComputerUseTcc_$_openSystemSettings': async () => {},
    'ComputerUseTcc_$_getCurrentSessionGrants': async () => ([]),
    'ComputerUseTcc_$_revokeGrant': async () => {},

    // ClaudeVM — report VM as running and ready
    'ClaudeVM_$_getRunningStatus': async () => ({ ...CLAUDE_VM_RUNNING_STATUS }),
    'ClaudeVM_$_getDownloadStatus': async () => ({ ...CLAUDE_VM_DOWNLOAD_STATUS }),
    'ClaudeVM_$_isSupported': async () => 'supported',
    'ClaudeVM_$_getSupportStatus': async () => 'supported',
    'ClaudeVM_$_checkVirtualMachinePlatform': async () => ({ supported: true }),
    'ClaudeVM_$_apiReachability': async () => ({ reachable: true }),
    'ClaudeVM_$_isProcessRunning': async (...args) => getProcessState(args),
    'ClaudeVM_$_startVM': async () => ({ success: true }),
    'ClaudeVM_$_download': async () => ({ success: true }),
    'ClaudeVM_$_deleteAndReinstall': async () => ({ success: true }),

    // FileSystem — proper Linux implementations
    'FileSystem_$_readLocalFile': async (_event, sessionId, filePath) => {
      const decoded = decodeURIComponent(filePath);
      if (!path.isAbsolute(decoded)) return null;
      try {
        return readLocalFileContent(decoded);
      } catch (e) {
        console.error('[Cowork] readLocalFile failed:', decoded, e.code || e.message);
        return null;
      }
    },

    'FileSystem_$_openLocalFile': async (_event, sessionId, filePath, showInFolder) => {
      const decoded = decodeURIComponent(filePath);
      console.log('[Cowork] openLocalFile:', decoded, 'showInFolder:', showInFolder);
      if (!path.isAbsolute(decoded)) return;
      try {
        if (showInFolder) {
          xdgOpen(path.dirname(decoded));
        } else {
          xdgOpen(decoded);
        }
      } catch (e) {
        console.error('[Cowork] openLocalFile failed:', decoded, e.code || e.message);
      }
    },

    'FileSystem_$_whichApplication': async (_event, filename) => {
      return whichApplicationForFile(filename);
    },

    'FileSystem_$_showInFolder': async (_event, filePath) => {
      const decoded = decodeURIComponent(filePath);
      console.log('[Cowork] showInFolder:', decoded);
      try {
        // D-Bus FileManager1 isn't available on Hyprland/wlroots compositors.
        // Open the parent directory with xdg-open instead.
        xdgOpen(path.dirname(decoded));
      } catch (_) {}
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
      console.log('[Cowork] writeFileDownloadAndOpen:', filename);
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
        console.log('[Cowork] Downloaded to:', dest);
        xdgOpen(dest);
      } catch (e) {
        console.error('[Cowork] writeFileDownloadAndOpen failed:', e.message);
      }
    },

    // CoworkSpaces — not implemented on Linux
    'CoworkSpaces_$_getAllSpaces': async () => ([]),
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
  'CoworkSpaces_$_getAllSpaces',
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
  console.log('[Cowork] Proactively registered', _proactiveChannels.size, 'fallback handlers on ipcMain for UUID', uuid);
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
  PROACTIVE_ONLY_SUFFIXES,
  getMimeType,
  isBinaryMime,
  readLocalFileContent,
};
