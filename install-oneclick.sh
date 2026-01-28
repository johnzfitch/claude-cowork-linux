#!/bin/bash
#
# Claude Desktop for Linux - One-Click Installer
#
# Usage: curl -fsSL https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master/install-oneclick.sh | bash
#
# This script:
#   1. Checks/installs dependencies (7z, node, electron, asar)
#   2. Downloads Claude macOS DMG from Anthropic's official CDN
#   3. Extracts and patches the app for Linux compatibility
#   4. Installs to /Applications/Claude.app (macOS-style path for compat)
#   5. Creates desktop entry and CLI command
#
# Requirements: Linux with apt/pacman/dnf, Node.js 18+, ~500MB disk space
#
# License: MIT
# Source: https://github.com/johnzfitch/claude-cowork-linux

set -euo pipefail

# ============================================================
# Configuration
# ============================================================

VERSION="2.0.0"
CLAUDE_VERSION="latest"

# Official Anthropic download URLs
DMG_URL_PRIMARY="https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest/Claude.dmg"
DMG_URL_FALLBACK="https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect"

# Minimum expected DMG size (100MB) - basic integrity check
MIN_DMG_SIZE=100000000

# Installation paths
INSTALL_DIR="/Applications/Claude.app"
USER_DATA_DIR="$HOME/Library/Application Support/Claude"
USER_LOG_DIR="$HOME/Library/Logs/Claude"
USER_CACHE_DIR="$HOME/Library/Caches/Claude"

# Temp directory for installation (with cleanup on multiple signals)
WORK_DIR=$(mktemp -d)
cleanup() { rm -rf "$WORK_DIR" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================
# Utility Functions
# ============================================================

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

die() {
    log_error "$@"
    exit 1
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Detect package manager
detect_pkg_manager() {
    if command_exists apt-get; then
        echo "apt"
    elif command_exists pacman; then
        echo "pacman"
    elif command_exists dnf; then
        echo "dnf"
    elif command_exists zypper; then
        echo "zypper"
    elif command_exists nix-env; then
        echo "nix"
    else
        echo "unknown"
    fi
}

# ============================================================
# Dependency Installation
# ============================================================

install_dependencies() {
    log_info "Checking dependencies..."

    local pkg_manager
    pkg_manager=$(detect_pkg_manager)
    local missing=()

    # Check each required command
    if ! command_exists 7z; then
        missing+=("7z")
    fi
    if ! command_exists node; then
        missing+=("nodejs")
    fi
    if ! command_exists npm; then
        missing+=("npm")
    fi
    if ! command_exists bwrap; then
        missing+=("bubblewrap")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_info "Missing packages: ${missing[*]}"
        log_warn "The following packages will be installed via your package manager."
        echo ""
        read -r -p "Continue with installation? [Y/n] " response
        response=${response:-Y}
        if [[ ! "$response" =~ ^[Yy]$ ]]; then
            die "Installation cancelled by user"
        fi

        case "$pkg_manager" in
            apt)
                sudo apt-get update -qq
                sudo apt-get install -y p7zip-full nodejs npm bubblewrap
                ;;
            pacman)
                # Use -Syu for full sync to avoid partial upgrade issues
                sudo pacman -Syu --noconfirm --needed p7zip nodejs npm bubblewrap
                ;;
            dnf)
                sudo dnf install -y p7zip nodejs npm bubblewrap
                ;;
            zypper)
                sudo zypper install -y p7zip nodejs npm bubblewrap
                ;;
            nix)
                nix-env -iA nixpkgs.p7zip nixpkgs.nodejs nixpkgs.bubblewrap
                ;;
            *)
                die "Unknown package manager. Please install manually: p7zip nodejs npm bubblewrap"
                ;;
        esac
    fi

    # Install npm packages to user prefix (avoid sudo npm)
    local npm_prefix="${HOME}/.local"
    mkdir -p "$npm_prefix"

    if ! command_exists asar; then
        log_info "Installing @electron/asar to $npm_prefix..."
        npm config set prefix "$npm_prefix" 2>/dev/null || true
        npm install --silent -g @electron/asar || die "Failed to install asar. Try: npm install -g @electron/asar"
        export PATH="$npm_prefix/bin:$PATH"
    fi

    if ! command_exists electron; then
        log_info "Installing electron to $npm_prefix..."
        npm config set prefix "$npm_prefix" 2>/dev/null || true
        npm install --silent -g electron || die "Failed to install electron. Try: npm install -g electron"
        export PATH="$npm_prefix/bin:$PATH"
    fi

    # Verify all dependencies
    local all_ok=true
    for cmd in 7z node npm asar electron bwrap; do
        if command_exists "$cmd"; then
            log_success "Found: $cmd"
        else
            log_error "Missing: $cmd"
            all_ok=false
        fi
    done

    if [[ "$all_ok" != "true" ]]; then
        die "Some dependencies could not be installed"
    fi

    # Check Node.js version
    local node_version
    node_version=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ "$node_version" -lt 18 ]]; then
        die "Node.js 18+ required, found v$node_version"
    fi
    log_success "Node.js version OK (v$node_version)"
}

# ============================================================
# Download Claude DMG
# ============================================================

download_dmg() {
    local dmg_path="$1"

    # Validate user-provided DMG path (prevent path traversal)
    if [[ -n "${CLAUDE_DMG:-}" ]]; then
        # Resolve to absolute path and check it exists
        local resolved_path
        resolved_path=$(realpath -e "$CLAUDE_DMG" 2>/dev/null) || die "User-provided DMG not found: $CLAUDE_DMG"

        # Verify it's a regular file
        if [[ ! -f "$resolved_path" ]]; then
            die "CLAUDE_DMG must be a regular file: $CLAUDE_DMG"
        fi

        # Basic sanity check - must end in .dmg
        if [[ ! "$resolved_path" =~ \.dmg$ ]]; then
            log_warn "File does not have .dmg extension: $CLAUDE_DMG"
            read -r -p "Continue anyway? [y/N] " response
            if [[ ! "$response" =~ ^[Yy]$ ]]; then
                die "Installation cancelled"
            fi
        fi

        log_info "Using user-provided DMG: $resolved_path"
        cp "$resolved_path" "$dmg_path"
        return 0
    fi

    # Check current directory for existing DMG (safely)
    local existing_dmg=""
    while IFS= read -r -d $'\0' file; do
        existing_dmg="$file"
        break
    done < <(find . -maxdepth 1 \( -name "Claude*.dmg" -o -name "claude*.dmg" \) -type f -print0 2>/dev/null)

    if [[ -n "$existing_dmg" ]]; then
        log_info "Found existing DMG: $existing_dmg"
        read -r -p "Use this DMG? [Y/n] " response
        response=${response:-Y}
        if [[ "$response" =~ ^[Yy]$ ]]; then
            cp "$existing_dmg" "$dmg_path"
            return 0
        fi
    fi

    log_info "Downloading Claude Desktop from Anthropic's official CDN..."
    log_info "Source: $DMG_URL_PRIMARY"
    echo ""

    # Try primary URL first
    if curl -fSL --progress-bar -o "$dmg_path" "$DMG_URL_PRIMARY" 2>/dev/null; then
        log_success "Downloaded from primary CDN"
    elif curl -fSL --progress-bar -o "$dmg_path" "$DMG_URL_FALLBACK" 2>/dev/null; then
        log_success "Downloaded from fallback URL"
    else
        log_error "Failed to download Claude DMG"
        log_info ""
        log_info "Manual download instructions:"
        log_info "  1. Visit https://claude.ai/download"
        log_info "  2. Download the macOS version"
        log_info "  3. Re-run with: CLAUDE_DMG=/path/to/Claude.dmg $0"
        exit 1
    fi

    # Verify download size (minimum 100MB for valid DMG)
    local dmg_size
    dmg_size=$(stat -c%s "$dmg_path" 2>/dev/null || stat -f%z "$dmg_path" 2>/dev/null || echo 0)
    if [[ ! -f "$dmg_path" ]] || [[ "$dmg_size" -lt "$MIN_DMG_SIZE" ]]; then
        die "Download appears incomplete or corrupted (size: ${dmg_size} bytes, expected >100MB)"
    fi
    log_success "Download verified ($(numfmt --to=iec "$dmg_size" 2>/dev/null || echo "${dmg_size} bytes"))"
}

# ============================================================
# Extract and Patch App
# ============================================================

extract_app() {
    local dmg_path="$1"
    local extract_dir="$2"

    log_info "Extracting DMG..."
    7z x -y -o"$extract_dir" "$dmg_path" >/dev/null 2>&1 || die "Failed to extract DMG"

    # Find Claude.app
    local claude_app
    claude_app=$(find "$extract_dir" -name "Claude.app" -type d | head -1)
    if [[ -z "$claude_app" ]]; then
        die "Claude.app not found in DMG"
    fi

    log_success "Extracted Claude.app"
    echo "$claude_app"
}

extract_asar() {
    local claude_app="$1"
    local app_extract_dir="$2"

    local asar_file="$claude_app/Contents/Resources/app.asar"
    if [[ ! -f "$asar_file" ]]; then
        die "app.asar not found"
    fi

    log_info "Extracting app.asar..."
    asar extract "$asar_file" "$app_extract_dir" || die "Failed to extract app.asar"
    log_success "Extracted app code"
}

# ============================================================
# Create Linux Stubs
# ============================================================

create_swift_stub() {
    local stub_dir="$1"
    mkdir -p "$stub_dir"

    cat > "$stub_dir/index.js" << 'SWIFTSTUB'
/**
 * @ant/claude-swift stub for Linux
 * Replaces macOS Swift native module with JS stubs
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn: nodeSpawn, execFileSync } = require('child_process');

const LOG_PREFIX = '[claude-swift-stub]';
const TRACE_ENABLED = !!process.env.CLAUDE_TRACE;

const SESSIONS_BASE = path.join(os.homedir(), '.local/share/claude-cowork/sessions');
const LOG_DIR = path.join(os.homedir(), '.local/share/claude-cowork/logs');
const CLAUDE_BINARY = path.join(os.homedir(), '.config/Claude/claude-code-vm/2.1.5/claude');

const CREATED_DIRS = new Set();

try {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SESSIONS_BASE, { recursive: true, mode: 0o700 });
} catch (e) {}

function trace(category, msg, data = null) {
  if (!TRACE_ENABLED) return;
  console.log(`[TRACE:${category}] ${msg}`);
}

function createEmitterObject(name, extraMethods = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  emitter._stubName = name;

  Object.assign(emitter, {
    initialize: async () => true,
    shutdown: async () => true,
    getState: async () => ({}),
    setState: async () => true,
    isAvailable: () => true,
    isEnabled: () => true,
    isSupported: () => true,
    enable: () => {},
    disable: () => {},
    ...extraMethods,
  });

  return emitter;
}

const notifications = createEmitterObject('notifications', {
  show: async (options) => {
    try {
      const title = String(options?.title || 'Claude').substring(0, 200);
      const body = String(options?.body || '').substring(0, 1000);
      execFileSync('notify-send', [title, body], { timeout: 5000, stdio: 'ignore' });
    } catch (e) {}
    return { id: Date.now().toString() };
  },
  hide: async () => {},
  hideAll: async () => {},
  close: () => {},
  requestAuth: () => Promise.resolve(true),
  getAuthStatus: () => 'authorized',
});

const vm = createEmitterObject('vm', {
  start: async () => ({ success: true }),
  stop: async () => ({ success: true }),
  startVM: async () => ({ success: true }),
  stopVM: async () => ({ success: true }),
  getStatus: async () => ({ running: true, connected: true, supported: true, status: 'supported' }),
  getRunningStatus: () => ({ running: true, connected: true, ready: true, status: 'running' }),
  getDownloadStatus: () => ({ status: 'ready', downloaded: true, installed: true, progress: 100 }),
  getSupportStatus: () => 'supported',
  isGuestConnected: () => true,
  isSupported: () => true,
  needsUpdate: () => false,
  installSdk: async () => ({ success: true }),
  sendMessage: async () => null,

  setEventCallbacks: (onStdout, onStderr, onExit, onError, onNetworkStatus) => {
    vm._onStdout = onStdout;
    vm._onStderr = onStderr;
    vm._onExit = onExit;
    vm._onError = onError;
    vm._onNetworkStatus = onNetworkStatus;
    if (onNetworkStatus) onNetworkStatus('connected');
  },

  spawn: (id, processName, command, args, options, envVars, additionalMounts, isResume, allowedDomains, sharedCwdPath) => {
    const sessionDir = path.join(SESSIONS_BASE, processName);
    if (!CREATED_DIRS.has(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      CREATED_DIRS.add(sessionDir);
    }

    let hostCommand = command;
    if (command === '/usr/local/bin/claude') {
      hostCommand = CLAUDE_BINARY;
    }

    const username = os.userInfo().username;
    const mountMap = {};

    if (additionalMounts && typeof additionalMounts === 'object') {
      for (const [mountName, mountInfo] of Object.entries(additionalMounts)) {
        if (mountInfo && typeof mountInfo === 'object') {
          const relPath = mountInfo.path || '';
          mountMap[mountName] = relPath ? path.join(os.homedir(), relPath) : os.homedir();
        }
      }
    }

    if (!mountMap[username]) mountMap[username] = os.homedir();
    if (!mountMap['.claude']) mountMap['.claude'] = path.join(os.homedir(), '.claude');
    if (!mountMap['.skills']) mountMap['.skills'] = path.join(os.homedir(), '.config/Claude/local-agent-mode-sessions/skills-plugin');
    if (!mountMap['uploads']) mountMap['uploads'] = path.join(sessionDir, 'uploads');

    for (const hostPath of Object.values(mountMap)) {
      if (!CREATED_DIRS.has(hostPath)) {
        try { fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 }); CREATED_DIRS.add(hostPath); } catch(e) {}
      }
    }

    const vmSessionPath = `/sessions/${processName}`;
    const isolateNetwork = process.env.CLAUDE_ISOLATE_NETWORK === 'true';

    const bwrapArgs = [
      '--unshare-user', '--uid', String(process.getuid()), '--gid', String(process.getgid()), '--die-with-parent',
      ...(isolateNetwork ? ['--unshare-net'] : []),
      '--tmpfs', '/',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/etc', '/etc',
      '--bind', os.homedir(), os.homedir(),
      '--tmpfs', '/tmp', '--dev', '/dev', '--proc', '/proc',
    ];

    for (const optDir of ['/lib64', '/lib32', '/opt', '/snap', '/nix']) {
      try { if (fs.existsSync(optDir)) bwrapArgs.push('--ro-bind', optDir, optDir); } catch(e) {}
    }

    bwrapArgs.push('--dir', '/sessions', '--dir', vmSessionPath, '--dir', `${vmSessionPath}/mnt`);

    for (const [mountName, hostPath] of Object.entries(mountMap)) {
      const vmMountPath = `${vmSessionPath}/mnt/${mountName}`;
      bwrapArgs.push('--dir', vmMountPath, '--bind', hostPath, vmMountPath);
    }

    const vmCwd = sharedCwdPath || `${vmSessionPath}/mnt/${username}`;
    bwrapArgs.push('--chdir', vmCwd, '--', hostCommand, ...(args || []));

    const userInfo = os.userInfo();
    const vmEnv = {
      HOME: os.homedir(), USER: userInfo.username, LOGNAME: userInfo.username,
      SHELL: userInfo.shell || '/bin/bash', TERM: process.env.TERM || 'xterm-256color',
      LANG: process.env.LANG || 'en_US.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin',
      TMPDIR: '/tmp', CLAUDE_COWORK_SESSION: processName, CLAUDE_SANDBOX: 'true',
      ...envVars,
      ...(process.env.DISPLAY && { DISPLAY: process.env.DISPLAY }),
      ...(process.env.WAYLAND_DISPLAY && { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }),
    };

    try {
      const proc = nodeSpawn('bwrap', bwrapArgs, { env: vmEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      vm._processes = vm._processes || new Map();
      vm._processes.set(id, proc);

      const cleanup = () => { vm._processes?.delete(id); };

      if (proc.stdout) proc.stdout.on('data', (data) => { if (vm._onStdout) vm._onStdout(id, data.toString('utf-8')); });
      if (proc.stderr) proc.stderr.on('data', (data) => { if (vm._onStderr) vm._onStderr(id, data.toString('utf-8')); });
      proc.on('exit', (code, signal) => { cleanup(); if (vm._onExit) vm._onExit(id, code || 0, signal || ''); });
      proc.on('error', (err) => { cleanup(); if (vm._onError) vm._onError(id, err.message, err.stack); });

      return { success: true, pid: proc.pid };
    } catch (err) {
      if (vm._onError) vm._onError(id, err.message, err.stack);
      return { success: false, error: err.message };
    }
  },

  kill: async (id, signal) => {
    const proc = vm._processes?.get(id);
    if (proc) { try { proc.kill(signal || 'SIGTERM'); } catch (err) {} vm._processes.delete(id); }
  },

  writeStdin: (id, data) => {
    const proc = vm._processes?.get(id);
    if (proc && proc.stdin && !proc.stdin.destroyed) { proc.stdin.write(data); return true; }
    return false;
  },

  readFile: async (sessionName, vmPath) => {
    let hostPath = vmPath;
    if (vmPath?.startsWith('/sessions/')) hostPath = path.join(SESSIONS_BASE, vmPath.substring('/sessions/'.length));
    return fs.readFileSync(hostPath).toString('base64');
  },

  writeFile: async (sessionName, vmPath, base64Content) => {
    let hostPath = vmPath;
    if (vmPath?.startsWith('/sessions/')) hostPath = path.join(SESSIONS_BASE, vmPath.substring('/sessions/'.length));
    const dir = path.dirname(hostPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(hostPath, Buffer.from(base64Content, 'base64'), { mode: 0o600 });
    return true;
  },

  mountPath: async () => ({ success: true }),
  addApprovedOauthToken: async () => ({ success: true }),
  isDebugLoggingEnabled: () => TRACE_ENABLED,
  setDebugLogging: () => {},
  showDebugWindow: () => {},
  hideDebugWindow: () => {},
  isConsoleEnabled: () => !!process.env.CLAUDE_ENABLE_LOGGING,
});

const clipboard = createEmitterObject('clipboard', {
  read: () => {
    try { return execFileSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf-8', timeout: 2000 }); }
    catch (e) { try { return execFileSync('xsel', ['--clipboard', '--output'], { encoding: 'utf-8', timeout: 2000 }); } catch (e2) { return ''; } }
  },
  write: (text) => {
    try { execFileSync('xclip', ['-selection', 'clipboard'], { input: text, timeout: 2000 }); }
    catch (e) { try { execFileSync('xsel', ['--clipboard', '--input'], { input: text, timeout: 2000 }); } catch (e2) {} }
  },
  readImage: async () => null,
  writeImage: async () => {},
  clear: () => {},
});

const dictation = createEmitterObject('dictation', { start: async () => false, stop: async () => {}, isListening: () => false, isRecording: () => false });
const quickAccess = createEmitterObject('quickAccess', { show: () => {}, hide: () => {}, toggle: () => {}, isVisible: () => false, submit: () => {} });
const desktop = createEmitterObject('desktop', {
  getDisplays: async () => [], getActiveWindow: async () => null, getOpenWindows: async () => [], getOpenDocuments: async () => [],
  captureScreen: async () => null, captureScreenshot: async () => null, captureWindow: async () => null, captureWindowScreenshot: async () => null,
  getSessionId: () => 'linux-session-' + Date.now(),
  openFile: (filePath) => { const { execFile } = require('child_process'); execFile('xdg-open', [filePath]); return Promise.resolve(true); },
  revealFile: (filePath) => { const { execFile } = require('child_process'); execFile('xdg-open', [path.dirname(filePath)]); return Promise.resolve(true); },
  previewFile: (filePath) => { const { execFile } = require('child_process'); execFile('xdg-open', [filePath]); return Promise.resolve(true); },
});
const events = createEmitterObject('events', { setListener: (cb) => { events._listener = cb; } });
const windowModule = createEmitterObject('window', {
  focus: async () => {}, blur: async () => {}, minimize: async () => {}, maximize: async () => {}, restore: async () => {}, close: async () => {},
  setTitle: async () => {}, setBounds: async () => {}, getBounds: async () => ({ x: 0, y: 0, width: 800, height: 600 }),
  setWindowButtonPosition: () => {}, setTrafficLightPosition: () => {}, setThemeMode: () => {},
});

async function openFileDialog(options = {}) {
  try {
    const { dialog } = require('electron');
    const isDirectory = options.directory || options.properties?.includes('openDirectory');
    const isMultiple = options.multiple || options.properties?.includes('multiSelections');
    const isSave = options.save;
    const title = options.title || (isDirectory ? 'Select Folder' : 'Select File');
    const defaultPath = options.defaultPath || os.homedir();

    if (isSave) {
      const result = await dialog.showSaveDialog({ title, defaultPath, properties: ['createDirectory', 'showOverwriteConfirmation'] });
      return result.canceled ? [] : [result.filePath];
    } else {
      const properties = isDirectory ? ['openDirectory', 'createDirectory'] : ['openFile'];
      if (isMultiple) properties.push('multiSelections');
      const result = await dialog.showOpenDialog({ title, defaultPath, properties });
      return result.canceled ? [] : result.filePaths;
    }
  } catch (err) { return [os.homedir()]; }
}

const files = createEmitterObject('files', {
  select: async (options) => openFileDialog(options),
  save: async (options) => { const r = await openFileDialog({ ...options, save: true }); return r.length > 0 ? r[0] : null; },
  reveal: (filePath) => { const { spawn } = require('child_process'); spawn('xdg-open', [path.dirname(filePath)], { detached: true, stdio: 'ignore' }); },
  read: (filePath) => Promise.resolve(fs.readFileSync(filePath, 'utf-8')),
  write: (filePath, content) => { fs.writeFileSync(filePath, content, 'utf-8'); return Promise.resolve(true); },
  exists: (filePath) => Promise.resolve(fs.existsSync(filePath)),
  stat: (filePath) => { const s = fs.statSync(filePath); return Promise.resolve({ size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), created: s.birthtime, modified: s.mtime }); },
  list: (dirPath) => { const e = fs.readdirSync(dirPath, { withFileTypes: true }); return Promise.resolve(e.map(x => ({ name: x.name, isFile: x.isFile(), isDirectory: x.isDirectory(), path: path.join(dirPath, x.name) }))); },
});

const midnightOwl = createEmitterObject('midnightOwl', { getState: async () => ({ enabled: false }), setEnabled: () => {}, getEnabled: () => false });
const api = createEmitterObject('api', {});

class ClaudeSwiftInstance extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.notifications = notifications; this.vm = vm; this.clipboard = clipboard; this.dictation = dictation;
    this.quickAccess = quickAccess; this.desktop = desktop; this.events = events; this.window = windowModule;
    this.files = files; this.midnightOwl = midnightOwl; this.api = api;
    this.initialize = async () => true; this.shutdown = async () => {};
    this.setWindowButtonPosition = () => {}; this.setThemeMode = () => {}; this.setApplicationMenu = () => {};
  }
}

const instance = new ClaudeSwiftInstance();

setTimeout(() => {
  instance.emit('guestConnectionChanged', { connected: true });
  instance.emit('guestReady');
  vm.emit('guestConnectionChanged', { connected: true });
  vm.emit('guestReady');
}, 100);

module.exports = instance;
module.exports.default = instance;
module.exports.notifications = notifications; module.exports.vm = vm; module.exports.clipboard = clipboard;
module.exports.dictation = dictation; module.exports.quickAccess = quickAccess; module.exports.desktop = desktop;
module.exports.events = events; module.exports.window = windowModule; module.exports.files = files;
module.exports.midnightOwl = midnightOwl; module.exports.api = api;
SWIFTSTUB

    log_success "Created Swift stub"
}

create_native_stub() {
    local stub_dir="$1"
    mkdir -p "$stub_dir"

    cat > "$stub_dir/index.js" << 'NATIVESTUB'
/**
 * Linux stub for @ant/claude-native
 */

const { ipcMain } = require('electron');
const EventEmitter = require('events');
const path = require('path');
const os = require('os');

const LOG_PREFIX = '[claude-native-stub]';

function safeHandle(channel, handler) {
  try { ipcMain.handle(channel, handler); return true; }
  catch (e) { return false; }
}

const KeyboardKeys = { ESCAPE: 27, ENTER: 13, TAB: 9, BACKSPACE: 8, DELETE: 46, ARROW_UP: 38, ARROW_DOWN: 40, ARROW_LEFT: 37, ARROW_RIGHT: 39 };

class AuthRequest extends EventEmitter {
  start(url) {
    const { execFile } = require('child_process');
    execFile('xdg-open', [url]);
    setTimeout(() => this.emit('error', new Error('Authentication via system browser')), 100);
  }
  cancel() { this.emit('cancelled'); }
  static isAvailable() { return false; }
}

const nativeStub = {
  platform: 'linux', arch: process.arch,
  getSystemTheme: () => 'dark', setDockBadge: () => {}, showNotification: () => {},
  revealInFinder: (p) => { const { spawn } = require('child_process'); spawn('xdg-open', [path.dirname(p)], { detached: true, stdio: 'ignore' }); },
  isAccessibilityEnabled: () => true, requestAccessibilityPermission: () => Promise.resolve(true),
  hasScreenCapturePermission: () => true, requestScreenCapturePermission: () => Promise.resolve(true),
};

function focus_window() { return false; }
function get_active_window_handle() { return null; }
function read_plist_value() { return null; }
function read_cf_pref_value() { return null; }
function read_registry_values() { return null; }
function write_registry_value() { return false; }
function get_app_info_for_file() { return null; }

console.log(LOG_PREFIX, 'stub loaded');

module.exports = {
  KeyboardKeys, AuthRequest,
  focus_window, focusWindow: focus_window, get_active_window_handle, getActiveWindowHandle: get_active_window_handle,
  read_plist_value, readPlistValue: read_plist_value, read_cf_pref_value, readCfPrefValue: read_cf_pref_value,
  read_registry_values, readRegistryValues: read_registry_values, write_registry_value, writeRegistryValue: write_registry_value,
  get_app_info_for_file, getAppInfoForFile: get_app_info_for_file,
  ...nativeStub,
};
module.exports.default = module.exports;
NATIVESTUB

    log_success "Created Native stub"
}

# ============================================================
# Create Linux Loader
# ============================================================

create_linux_loader() {
    local resources_dir="$1"

    cat > "$resources_dir/linux-loader.js" << 'LOADER'
#!/usr/bin/env node
/**
 * linux-loader.js - Claude Linux compatibility layer
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');

console.log('Claude Linux Loader');

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;
const RESOURCES_DIR = __dirname;
const STUB_PATH = path.join(RESOURCES_DIR, 'stubs', '@ant', 'claude-swift', 'js', 'index.js');

let appStarted = false;

Object.defineProperty(process, 'platform', {
  get() { return appStarted ? 'darwin' : REAL_PLATFORM; },
  configurable: true
});

Object.defineProperty(process, 'arch', {
  get() {
    const stack = new Error().stack || '';
    if (stack.includes('internal/') || stack.includes('node:')) return REAL_ARCH;
    if (stack.includes('/app/') || stack.includes('Claude.app') || stack.includes('.vite/build')) return 'arm64';
    return REAL_ARCH;
  },
  configurable: true
});

const originalGetSystemVersion = process.getSystemVersion;
process.getSystemVersion = function() {
  const stack = new Error().stack || '';
  if (stack.includes('/app/') || stack.includes('Claude.app') || stack.includes('.vite/build')) return '14.0.0';
  return originalGetSystemVersion ? originalGetSystemVersion.call(process) : '0.0.0';
};

const originalLoad = Module._load;
let swiftStubCache = null;
let loadingStub = false;
let patchedElectron = null;

function loadSwiftStub() {
  if (swiftStubCache) return swiftStubCache;
  if (!fs.existsSync(STUB_PATH)) throw new Error(`Swift stub not found: ${STUB_PATH}`);
  loadingStub = true;
  try {
    delete require.cache[STUB_PATH];
    swiftStubCache = originalLoad.call(Module, STUB_PATH, module, false);
  } finally { loadingStub = false; }
  return swiftStubCache;
}

Module._load = function(request, parent, isMain) {
  if (loadingStub) return originalLoad.apply(this, arguments);
  if (request.includes('swift_addon') && request.endsWith('.node')) return loadSwiftStub();
  if (request === 'electron' && patchedElectron) return patchedElectron;
  return originalLoad.apply(this, arguments);
};

const electron = require('electron');

const origSysPrefs = electron.systemPreferences || {};
const patchedSysPrefs = {
  getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true,
  getEffectiveAppearance: () => 'light', getAppearance: () => 'light', setAppearance: () => {},
  getAccentColor: () => '007AFF', getColor: () => '#007AFF',
  getUserDefault: () => null, setUserDefault: () => {}, removeUserDefault: () => {},
  subscribeNotification: () => 0, unsubscribeNotification: () => {},
  subscribeWorkspaceNotification: () => 0, unsubscribeWorkspaceNotification: () => {},
  postNotification: () => {}, postLocalNotification: () => {},
  isTrustedAccessibilityClient: () => true, isSwipeTrackingFromScrollEventsEnabled: () => false,
  isAeroGlassEnabled: () => false, isHighContrastColorScheme: () => false,
  isReducedMotion: () => false, isInvertedColorScheme: () => false,
};
for (const [key, val] of Object.entries(patchedSysPrefs)) origSysPrefs[key] = val;

const OrigBrowserWindow = electron.BrowserWindow;
const macOSWindowMethods = {
  setWindowButtonPosition: () => {}, getWindowButtonPosition: () => ({ x: 0, y: 0 }),
  setTrafficLightPosition: () => {}, getTrafficLightPosition: () => ({ x: 0, y: 0 }),
  setWindowButtonVisibility: () => {}, setVibrancy: () => {}, setBackgroundMaterial: () => {},
  setRepresentedFilename: () => {}, getRepresentedFilename: () => '',
  setDocumentEdited: () => {}, isDocumentEdited: () => false,
  setTouchBar: () => {}, setSheetOffset: () => {}, setAutoHideCursor: () => {},
};
for (const [method, impl] of Object.entries(macOSWindowMethods)) {
  if (typeof OrigBrowserWindow.prototype[method] !== 'function') OrigBrowserWindow.prototype[method] = impl;
}

const OrigMenu = electron.Menu;
const origSetApplicationMenu = OrigMenu.setApplicationMenu;
OrigMenu.setApplicationMenu = function(menu) {
  try { if (origSetApplicationMenu) return origSetApplicationMenu.call(OrigMenu, menu); } catch (e) {}
};

const origBuildFromTemplate = OrigMenu.buildFromTemplate;
OrigMenu.buildFromTemplate = function(template) {
  const filtered = (template || []).map(item => {
    if (!item) return null;
    const f = { ...item };
    if (f.role === 'services' || f.role === 'recentDocuments') return null;
    if (f.submenu && Array.isArray(f.submenu)) {
      f.submenu = f.submenu.filter(s => s && s.role !== 'services' && s.role !== 'recentDocuments');
    }
    return f;
  }).filter(Boolean);
  return origBuildFromTemplate.call(OrigMenu, filtered);
};

patchedElectron = electron;

process.on('uncaughtException', (error) => {
  if (error.message && (error.message.includes('is not a function') || error.message.includes('No handler registered'))) {
    console.error('[Error]', error.message);
    return;
  }
  throw error;
});

appStarted = true;
require('./app/.vite/build/index.js');
LOADER

    chmod +x "$resources_dir/linux-loader.js"
    log_success "Created Linux loader"
}

# ============================================================
# Create Launch Script
# ============================================================

create_launcher() {
    local macos_dir="$1"

    cat > "$macos_dir/Claude" << 'LAUNCHER'
#!/bin/bash
# Claude launcher script

SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_PATH"
done

SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/../Resources"
cd "$RESOURCES_DIR"

ELECTRON_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --debug) export CLAUDE_TRACE=1 ;;
    --devtools) ELECTRON_ARGS+=("--inspect") ;;
    --isolate-network) export CLAUDE_ISOLATE_NETWORK=1 ;;
    *) ELECTRON_ARGS+=("$arg") ;;
  esac
done

export ELECTRON_ENABLE_LOGGING=1
# Unbuffered output for real-time streaming
exec stdbuf -oL -eL electron linux-loader.js "${ELECTRON_ARGS[@]}" 2>&1 | stdbuf -oL tee -a ~/Library/Logs/Claude/startup.log
LAUNCHER

    chmod +x "$macos_dir/Claude"
    log_success "Created launcher script"
}

# ============================================================
# Install Application
# ============================================================

confirm_sudo_operations() {
    echo ""
    log_warn "The following operations require sudo (root) privileges:"
    echo "  - Create directory: $INSTALL_DIR"
    echo "  - Copy application files to $INSTALL_DIR"
    echo "  - Create symlink: /usr/local/bin/claude"
    echo ""
    read -r -p "Proceed with installation? [Y/n] " response
    response=${response:-Y}
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        die "Installation cancelled by user"
    fi
}

install_app() {
    local claude_app="$1"
    local app_extract_dir="$2"

    # Show what sudo operations will be performed
    confirm_sudo_operations

    log_info "Installing to $INSTALL_DIR..."

    # Remove old installation (with safety check)
    if [[ -d "$INSTALL_DIR" ]]; then
        log_info "Removing previous installation..."
        sudo rm -rf "$INSTALL_DIR"
    fi

    # Create directory structure
    sudo mkdir -p "$INSTALL_DIR/Contents/"{MacOS,Resources,Frameworks}

    # Copy extracted app code
    sudo cp -r "$app_extract_dir" "$INSTALL_DIR/Contents/Resources/app"

    # Copy resources from original app
    sudo cp -r "$claude_app/Contents/Resources/"* "$INSTALL_DIR/Contents/Resources/" 2>/dev/null || true

    # Create and install stubs
    local stub_swift_dir="$INSTALL_DIR/Contents/Resources/stubs/@ant/claude-swift/js"
    local stub_native_dir="$INSTALL_DIR/Contents/Resources/stubs/@ant/claude-native"

    sudo mkdir -p "$stub_swift_dir" "$stub_native_dir"

    # Create stubs in temp then copy
    create_swift_stub "$WORK_DIR/stubs/swift"
    create_native_stub "$WORK_DIR/stubs/native"

    sudo cp "$WORK_DIR/stubs/swift/index.js" "$stub_swift_dir/index.js"
    sudo cp "$WORK_DIR/stubs/native/index.js" "$stub_native_dir/index.js"

    # Replace original @ant modules with stubs
    sudo cp "$WORK_DIR/stubs/swift/index.js" "$INSTALL_DIR/Contents/Resources/app/node_modules/@ant/claude-swift/js/index.js"
    sudo cp "$WORK_DIR/stubs/native/index.js" "$INSTALL_DIR/Contents/Resources/app/node_modules/@ant/claude-native/index.js"

    # Create Linux loader
    create_linux_loader "$INSTALL_DIR/Contents/Resources"

    # Create launcher
    create_launcher "$INSTALL_DIR/Contents/MacOS"

    # Create symlink in PATH
    sudo ln -sf "$INSTALL_DIR/Contents/MacOS/Claude" /usr/local/bin/claude

    log_success "Installed to $INSTALL_DIR"
}

# ============================================================
# Setup User Environment
# ============================================================

setup_user_dirs() {
    log_info "Setting up user directories..."

    # Create macOS-style directories
    mkdir -p "$USER_DATA_DIR"/{Projects,Conversations,"Claude Extensions","Claude Extensions Settings",claude-code-vm,vm_bundles,blob_storage}
    mkdir -p "$USER_LOG_DIR"
    mkdir -p "$USER_CACHE_DIR"
    mkdir -p ~/Library/Preferences

    # Create default configs if not exist
    if [[ ! -f "$USER_DATA_DIR/config.json" ]]; then
        cat > "$USER_DATA_DIR/config.json" << 'EOF'
{
  "scale": 0,
  "locale": "en-US",
  "userThemeMode": "system",
  "hasTrackedInitialActivation": false
}
EOF
    fi

    if [[ ! -f "$USER_DATA_DIR/claude_desktop_config.json" ]]; then
        cat > "$USER_DATA_DIR/claude_desktop_config.json" << 'EOF'
{
  "preferences": {
    "chromeExtensionEnabled": true
  }
}
EOF
    fi

    # Set permissions
    chmod 700 "$USER_DATA_DIR" "$USER_LOG_DIR" "$USER_CACHE_DIR"

    log_success "User directories created"
}

# ============================================================
# Create Desktop Entry
# ============================================================

create_desktop_entry() {
    log_info "Creating desktop entry..."

    mkdir -p ~/.local/share/applications

    cat > ~/.local/share/applications/claude.desktop << EOF
[Desktop Entry]
Type=Application
Name=Claude
Comment=AI assistant by Anthropic
Exec=/usr/local/bin/claude
Icon=$INSTALL_DIR/Contents/Resources/icon.icns
Terminal=false
Categories=Utility;Development;Chat;
Keywords=AI;assistant;chat;anthropic;
StartupWMClass=Claude
EOF

    chmod +x ~/.local/share/applications/claude.desktop

    if command_exists update-desktop-database; then
        update-desktop-database ~/.local/share/applications 2>/dev/null || true
    fi

    log_success "Desktop entry created"
}

# ============================================================
# Main Installation Flow
# ============================================================

main() {
    echo ""
    echo "=========================================="
    echo " Claude Desktop for Linux - Installer"
    echo " Version: $VERSION"
    echo "=========================================="
    echo ""

    # Check if running as root (bad idea)
    if [[ $EUID -eq 0 ]]; then
        die "Do not run as root. The script will use sudo when needed."
    fi

    # Step 1: Dependencies
    install_dependencies
    echo ""

    # Step 2: Download DMG
    local dmg_path="$WORK_DIR/Claude.dmg"
    download_dmg "$dmg_path"
    echo ""

    # Step 3: Extract
    local extract_dir="$WORK_DIR/extract"
    local claude_app
    claude_app=$(extract_app "$dmg_path" "$extract_dir")
    echo ""

    # Step 4: Extract app.asar
    local app_extract_dir="$WORK_DIR/app-extracted"
    extract_asar "$claude_app" "$app_extract_dir"
    echo ""

    # Step 5: Install
    install_app "$claude_app" "$app_extract_dir"
    echo ""

    # Step 6: User setup
    setup_user_dirs
    echo ""

    # Step 7: Desktop entry
    create_desktop_entry
    echo ""

    # Done!
    echo "=========================================="
    echo -e "${GREEN} Installation Complete!${NC}"
    echo "=========================================="
    echo ""
    echo "Launch Claude:"
    echo "  Command:  claude"
    echo "  Desktop:  Search for 'Claude' in app launcher"
    echo ""
    echo "Options:"
    echo "  claude --debug      Enable trace logging"
    echo "  claude --devtools   Enable Chrome DevTools"
    echo ""
    echo "Logs: ~/Library/Logs/Claude/startup.log"
    echo ""
}

# Run main
main "$@"
