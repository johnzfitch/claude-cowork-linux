const fs = require('fs');
const path = require('path');
const { classifyEnvEntry } = require('./credential_classifier.js');

const DEFAULT_STDIO = ['pipe', 'pipe', 'pipe'];

// ============================================================================
// BUBBLEWRAP SANDBOX (opt-in, experimental)
// ============================================================================
// Off by default. Enable with CLAUDE_COWORK_SANDBOX=1; CLAUDE_COWORK_NO_SANDBOX=1
// wins over it. On macOS the CLI runs inside a VM that only sees the folders
// the user attached; this is the closest Linux equivalent we can build without
// one, so a session cannot write outside its own folders or read the common
// places credentials live.
//
// Fail-closed: once requested, a session whose sandbox cannot be built (no
// bwrap, or a bwrap that cannot create namespaces here) is refused rather than
// run unsandboxed.
//
// Profile, in mount order (later mounts stack on earlier ones):
//   1. The whole filesystem read-only (--ro-bind / /), fresh /proc and /dev,
//      private /tmp. The CLI, its interpreter and every system path resolve
//      exactly as on the host, which is what made the old /usr-only profile
//      unrunnable: an npm- or ~/.local-installed CLI was simply not there.
//   2. Writable: the session directory (CLAUDE_CONFIG_DIR's parent, which
//      holds the CLI's config, transcripts and outputs), every folder the user
//      attached (the session's mnt/ symlink targets; `ro` mounts stay
//      read-only), the working directory, and $TMPDIR.
//   3. Hidden (an empty tmpfs over a directory, /dev/null over a file): SSH
//      and GPG keys, cloud and container credentials, password stores and
//      keyrings, browser profiles, Claude Desktop's own state under
//      ~/.config/Claude, and $XDG_RUNTIME_DIR (agent and keyring sockets).
//      The provider the session actually uses keeps its credentials: Bedrock
//      sessions keep ~/.aws, Vertex sessions keep ~/.config/gcloud.
//   4. Anything from step 2 that step 3 covered is bound again, so a session
//      directory under ~/.config/Claude stays visible, and so does a folder
//      the user deliberately attached from inside a hidden one.
//   5. Separate PID, IPC and UTS namespaces, a new session (no TIOCSTI into
//      the parent's terminal), and --die-with-parent. The network is shared:
//      the CLI needs the API and any HTTP MCP servers.
//
// The environment is NOT cleared: it has already been through filterEnv(),
// and the old profile's --clearenv stripped the CLI's own credentials.

const SANDBOX_HIDDEN_DIRS = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store',
  '.pki', '.mozilla', '.local/share/keyrings', '.local/share/kwalletd',
  '.config/Claude', '.config/gcloud', '.config/gh', '.config/op',
  '.config/google-chrome', '.config/chromium', '.config/BraveSoftware',
  '.config/microsoft-edge', '.config/vivaldi',
];
const SANDBOX_HIDDEN_FILES = [
  '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.vault-token',
];

var _bwrapProbe;
function isBwrapAvailable() {
  // Present AND able to build a namespace here. A bwrap that exists but is
  // blocked (AppArmor's unprivileged-userns restriction, a container without
  // user namespaces) must count as unavailable, or every sandboxed spawn fails
  // with a bwrap error instead of the clear refusal below.
  if (_bwrapProbe === undefined) {
    try {
      require('child_process').execFileSync('bwrap', [
        '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
        '--unshare-pid', '--die-with-parent', '--', 'true',
      ], { stdio: 'ignore', timeout: 10000 });
      _bwrapProbe = true;
    } catch (_) {
      _bwrapProbe = false;
    }
  }
  return _bwrapProbe;
}

function sandboxRequested(env) {
  const e = env || process.env;
  if (e.CLAUDE_COWORK_NO_SANDBOX === '1') return false;
  return e.CLAUDE_COWORK_SANDBOX === '1';
}

function shouldUseSandbox() {
  return sandboxRequested(process.env) && isBwrapAvailable();
}

function _isWithin(child, parent) {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}

function _truthy(v) {
  return typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

// Pure: every filesystem question goes through `fsops`, so tests can describe
// a home directory without creating one.
//   opts.home, opts.cwd, opts.env (the CLI's filtered env), opts.sessionDir,
//   opts.mounts: [{ path, readOnly }] (already-resolved host paths)
//   fsops.kind(p) -> 'dir' | 'file' | null
function buildBwrapArgs(command, args, opts, fsops) {
  const home = opts.home;
  const env = opts.env || {};
  const kind = fsops.kind;

  const binds = [];   // { path, readOnly }
  const addBind = (p, readOnly) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return;
    const resolved = path.resolve(p);
    if (resolved === '/' || kind(resolved) === null) return;
    if (binds.some((b) => b.path === resolved)) return;
    binds.push({ path: resolved, readOnly: !!readOnly });
  };
  if (opts.sessionDir) addBind(opts.sessionDir, false);
  for (const m of opts.mounts || []) addBind(m.path, m.readOnly);
  if (opts.cwd) addBind(opts.cwd, false);
  if (env.TMPDIR) addBind(env.TMPDIR, false);
  // The CLI itself, read-only: Claude Desktop's own download lives under
  // ~/.config/Claude/claude-code-vm/, which step 3 hides.
  for (const p of opts.exposeReadOnly || []) addBind(p, true);
  // Provider credential files named in the env stay readable even when they
  // sit inside a hidden directory (step 4 re-binds them).
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) {
    if (env[key]) addBind(env[key], true);
  }

  const keepDirs = new Set();
  if (_truthy(env.CLAUDE_CODE_USE_BEDROCK) || env.AWS_PROFILE) keepDirs.add('.aws');
  if (_truthy(env.CLAUDE_CODE_USE_VERTEX)) keepDirs.add('.config/gcloud');

  const hidden = [];  // { path, isDir }
  const consider = (p, isDir) => {
    const k = kind(p);
    if (k === null || (isDir && k !== 'dir') || (!isDir && k !== 'file')) return;
    // A folder the user attached IS this path: they chose to expose it.
    if (binds.some((b) => b.path === p)) return;
    hidden.push({ path: p, isDir });
  };
  if (home && path.isAbsolute(home)) {
    for (const rel of SANDBOX_HIDDEN_DIRS) {
      if (!keepDirs.has(rel)) consider(path.join(home, rel), true);
    }
    for (const rel of SANDBOX_HIDDEN_FILES) consider(path.join(home, rel), false);
  }
  if (env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR)) consider(path.resolve(env.XDG_RUNTIME_DIR), true);

  const out = [
    '--ro-bind', '/', '/',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ];
  const emitBind = (b) => out.push(b.readOnly ? '--ro-bind' : '--bind', b.path, b.path);
  // /tmp was just replaced by an empty tmpfs; a $TMPDIR under it is bound back.
  binds.forEach(emitBind);
  for (const h of hidden) {
    if (h.isDir) out.push('--tmpfs', h.path);
    else out.push('--ro-bind', '/dev/null', h.path);
  }
  for (const b of binds) {
    if (hidden.some((h) => h.isDir && _isWithin(b.path, h.path) && b.path !== h.path)) emitBind(b);
  }
  if (opts.cwd && path.isAbsolute(opts.cwd)) out.push('--chdir', opts.cwd);
  out.push('--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session', '--die-with-parent');
  out.push('--', command, ...(Array.isArray(args) ? args : []));

  return {
    command: 'bwrap',
    args: out,
    summary: {
      writable: binds.filter((b) => !b.readOnly).map((b) => b.path),
      readOnly: binds.filter((b) => b.readOnly).map((b) => b.path),
      hidden: hidden.map((h) => h.path),
    },
  };
}

function _realFsKind(p) {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch (_) {
    return null;
  }
}

// Host paths of the folders attached to this session: the targets of the
// session's mnt/<name> symlinks (created by createMountSymlinks before the
// spawn), with each mount's ro/rw mode from additionalMounts.
function resolveSessionMounts(sessionDir, additionalMounts) {
  const result = [];
  if (!sessionDir) return result;
  const mntDir = path.join(sessionDir, 'mnt');
  let names = [];
  try { names = fs.readdirSync(mntDir); } catch (_) { return result; }
  for (const name of names) {
    let target;
    try { target = fs.realpathSync(path.join(mntDir, name)); } catch (_) { continue; }
    const info = additionalMounts && typeof additionalMounts === 'object' ? additionalMounts[name] : null;
    result.push({ path: target, readOnly: !!(info && typeof info === 'object' && info.mode === 'ro') });
  }
  return result;
}

// Returns null when no sandbox was requested, { command, args, summary } when
// it was, and throws when it was requested but cannot be provided.
// Accepts the old (command, args, cwd) form as well as (command, args, options).
function wrapWithBwrap(command, args, options) {
  if (!sandboxRequested(process.env)) return null;
  if (!isBwrapAvailable()) {
    throw new Error('CLAUDE_COWORK_SANDBOX=1 is set but bubblewrap is not installed or cannot create '
      + 'namespaces here (try `bwrap --ro-bind / / true`). Refusing to start the session unsandboxed; '
      + 'unset CLAUDE_COWORK_SANDBOX or set CLAUDE_COWORK_NO_SANDBOX=1 to run without it.');
  }
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('sandbox: no command to run');
  }
  const opts = typeof options === 'string' ? { cwd: options } : (options || {});
  const env = opts.env || {};
  let home = opts.home;
  if (!home) {
    try { home = global.__coworkPasswdHomedir || require('os').userInfo().homedir; } catch (_) { home = null; }
  }
  const sessionDir = opts.sessionDir || deriveSessionDirectory(env.CLAUDE_CONFIG_DIR);
  const exposeReadOnly = [];
  if (path.isAbsolute(command)) {
    try { exposeReadOnly.push(path.dirname(fs.realpathSync(command))); } catch (_) {}
  }
  return buildBwrapArgs(command, args, {
    home,
    cwd: opts.cwd,
    env,
    sessionDir,
    exposeReadOnly,
    mounts: opts.mounts || resolveSessionMounts(sessionDir, opts.additionalMounts),
  }, { kind: _realFsKind });
}

// ============================================================================
// SESSION PATH DERIVATION
// ============================================================================
// These functions derive session-related paths from the CLAUDE_CONFIG_DIR
// environment variable. The structure is:
//   <configDir>/.claude  (CLAUDE_CONFIG_DIR)
//   <configDir>          (session directory)
//   <configDir>.json     (session metadata file)

function deriveSessionDirectory(configDirPath) {
  // Extract session directory from CLAUDE_CONFIG_DIR by removing the
  // trailing '.claude' component.
  // Example: /path/to/session/.claude -> /path/to/session
  if (typeof configDirPath !== 'string' || !configDirPath.trim()) {
    return null;
  }
  const normalizedPath = path.resolve(configDirPath);
  if (path.basename(normalizedPath) !== '.claude') {
    return null;
  }
  return path.dirname(normalizedPath);
}

function deriveSessionMetadataPath(configDirPath) {
  // Build path to session metadata file by appending .json to session dir.
  // Example: /path/to/session/.claude -> /path/to/session.json
  const sessionDirectory = deriveSessionDirectory(configDirPath);
  if (!sessionDirectory) {
    return null;
  }
  return sessionDirectory + '.json';
}

// ============================================================================
// WORKSPACE SELECTION LOGIC
// ============================================================================
// These functions determine the preferred working directory for CLI spawns.
// Priority order:
//   1. userSelectedFolders (explicitly user-selected via UI)
//   2. cwd from session metadata (if not a VM path like /sessions/...)
//   3. CLI arguments like --add-dir

function getPreferredWorkspaceFromSessionMetadata(sessionData) {
  // Extract the first valid absolute path from userSelectedFolders,
  // or fall back to the session's cwd if it's a real host path.
  if (!sessionData || typeof sessionData !== 'object' || Array.isArray(sessionData)) {
    return null;
  }

  // First preference: explicit user-selected folders from the UI
  if (Array.isArray(sessionData.userSelectedFolders)) {
    for (const folderPath of sessionData.userSelectedFolders) {
      if (typeof folderPath === 'string' && path.isAbsolute(folderPath)) {
        return path.resolve(folderPath);
      }
    }
  }

  // Second preference: session cwd if it's a host path (not a VM path)
  if (
    typeof sessionData.cwd === 'string' &&
    path.isAbsolute(sessionData.cwd) &&
    !sessionData.cwd.startsWith('/sessions/')
  ) {
    return path.resolve(sessionData.cwd);
  }

  return null;
}

function readPreferredWorkspaceFromConfigDir(configDirPath, trace = () => {}) {
  // Read session metadata file and extract preferred workspace path.
  const metadataPath = deriveSessionMetadataPath(configDirPath);
  if (!metadataPath || !fs.existsSync(metadataPath)) {
    return null;
  }

  try {
    const sessionData = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const preferredWorkspace = getPreferredWorkspaceFromSessionMetadata(sessionData);
    if (preferredWorkspace) {
      trace('Derived host cwd from session metadata: ' + preferredWorkspace);
    }
    return preferredWorkspace;
  } catch (error) {
    trace('WARNING: Failed to read session metadata from ' + metadataPath + ': ' + error.message);
    return null;
  }
}

// ============================================================================
// CWD EXTRACTION FROM CLI INPUTS
// ============================================================================
// These functions parse CLI arguments to extract directory references
// (e.g., --add-dir flags) and resolve the final working directory for spawns.

function collectAddDirArgs(args) {
  // Extract all --add-dir argument values from CLI args array.
  // Handles both '--add-dir value' and '--add-dir=value' formats.
  if (!Array.isArray(args)) {
    return [];
  }

  const addDirArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    // Format: --add-dir <path>
    if (arg === '--add-dir' && typeof args[index + 1] === 'string') {
      addDirArgs.push(args[index + 1]);
      index += 1;
      continue;
    }
    // Format: --add-dir=<path>
    if (typeof arg === 'string' && arg.startsWith('--add-dir=')) {
      addDirArgs.push(arg.slice('--add-dir='.length));
    }
  }
  return addDirArgs;
}

function resolveHostCwdPath(context) {
  // Determine the final working directory for CLI spawn by checking
  // multiple sources in priority order:
  //   1. sharedCwdPath (from IPC caller)
  //   2. session metadata (userSelectedFolders or cwd)
  //   3. --add-dir CLI arguments
  //   4. options.cwd (fallback)
  //
  // Returns the first candidate that can be canonicalized to a valid
  // absolute host path.
  const {
    args,
    canonicalizePathForHostAccess,
    configDirPath,
    providedCwd,
    sharedCwdPath,
    trace = () => {},
  } = context || {};

  const candidates = [];
  
  // Priority 1: Shared cwd from session orchestrator
  if (typeof sharedCwdPath === 'string' && sharedCwdPath.trim()) {
    candidates.push({ label: 'sharedCwdPath', value: sharedCwdPath });
  }

  // Priority 2: Workspace from session metadata
  const metadataWorkspace = readPreferredWorkspaceFromConfigDir(configDirPath, trace);
  if (metadataWorkspace) {
    candidates.push({ label: 'session metadata', value: metadataWorkspace });
  }

  // Priority 3: --add-dir from CLI arguments (first absolute, non-asar path)
  for (const addDirPath of collectAddDirArgs(args)) {
    if (
      typeof addDirPath === 'string' &&
      path.isAbsolute(addDirPath) &&
      !addDirPath.endsWith('.asar')
    ) {
      candidates.push({ label: '--add-dir', value: addDirPath });
      break;
    }
  }

  // Priority 4: options.cwd as fallback
  if (typeof providedCwd === 'string' && providedCwd.trim()) {
    candidates.push({ label: 'options.cwd', value: providedCwd });
  }

  // Try each candidate in priority order
  for (const candidate of candidates) {
    try {
      const resolvedPath = canonicalizePathForHostAccess(candidate.value);
      if (typeof resolvedPath === 'string' && path.isAbsolute(resolvedPath)) {
        trace('Resolved host cwd from ' + candidate.label + ': ' + resolvedPath);
        return resolvedPath;
      }
    } catch (error) {
      trace('WARNING: Failed to resolve host cwd from ' + candidate.label + ' "' + candidate.value + '": ' + error.message);
    }
  }

  return null;
}

// ============================================================================
// SPAWN ENVIRONMENT ASSEMBLY
// ============================================================================
// EnvironmentBuilder handles the critical task of translating VM-style paths
// in environment variables to host paths before spawning the CLI process.
// This ensures CLAUDE_CONFIG_DIR and other env vars point to the correct
// locations on the Linux host.

class EnvironmentBuilder {
  constructor(deps) {
    this._deps = deps || {};
    this._baseEnv = {};
    this._additionalEnv = {};
  }

  withBaseEnv(baseEnv) {
    // Set base environment (typically process.env from parent)
    this._baseEnv = baseEnv && typeof baseEnv === 'object' ? { ...baseEnv } : {};
    return this;
  }

  withAdditionalEnv(additionalEnv) {
    // Set additional environment variables to merge (from asar/IPC)
    this._additionalEnv = additionalEnv && typeof additionalEnv === 'object' ? { ...additionalEnv } : {};
    return this;
  }

  build(context) {
    // Build the final environment for spawn:
    //   1. Translate VM paths (e.g., /sessions/...) to host paths
    //   2. Apply credential classification for safe logging
    //   3. Filter through allowlist with filterEnv()
    //   4. Return merged environment ready for child_process.spawn()
    const { processId, onError } = context || {};
    const {
      filterEnv,
      trace = () => {},
      translateVmPathStrict,
    } = this._deps;

    const translatedEnv = { ...this._additionalEnv };
    
    // Translate all /sessions/ paths to host equivalents
    for (const key of Object.keys(translatedEnv)) {
      const value = translatedEnv[key];
      if (typeof value !== 'string' || !value.startsWith('/sessions/')) {
        continue;
      }

      try {
        const translated = translateVmPathStrict(value);
        const classification = classifyEnvEntry(key, value);
        const safeOldValue = classification === 'safe' ? value : '[REDACTED]';
        const safeNewValue = classification === 'safe' ? translated : '[REDACTED]';
        trace('Translated envVar ' + key + ': ' + safeOldValue + ' -> ' + safeNewValue);
        translatedEnv[key] = translated;
      } catch (error) {
        const safeValue = classifyEnvEntry(key, value) === 'safe' ? value : '[REDACTED]';
        const warning = 'Failed to translate envVar ' + key + '="' + safeValue + '": ' + error.message;
        trace('WARNING: ' + warning);
        
        // CLAUDE_CONFIG_DIR translation failure is fatal
        if (key === 'CLAUDE_CONFIG_DIR') {
          if (typeof onError === 'function') {
            onError(processId, warning, error.stack || '');
          }
          return { success: false, error: warning };
        }
      }
    }

    return {
      success: true,
      translatedEnv,
      env: filterEnv(this._baseEnv, translatedEnv),
    };
  }
}

// ============================================================================
// PROCESS MANAGER
// ============================================================================
// ProcessManager orchestrates all the pieces above to build complete
// spawn options for child_process.spawn(). It:
//   1. Translates environment variables (via EnvironmentBuilder)
//   2. Resolves the working directory (via resolveHostCwdPath)
//   3. Sanitizes spawn options (removes unsafe overrides)
//   4. Returns ready-to-use options for spawning the Claude CLI

class ProcessManager {
  constructor(deps) {
    this._deps = deps || {};
  }

  buildSpawnOptions(context) {
    // Build complete spawn options for Claude CLI process:
    //   - Translate VM env vars to host paths
    //   - Resolve working directory from multiple sources
    //   - Set stdio to pipe mode for IPC
    //   - Return sanitized options for child_process.spawn()
    const {
      args,
      processId,
      options,
      envVars,
      sharedCwdPath,
      onError,
    } = context || {};
    const {
      canonicalizePathForHostAccess,
      filterEnv,
      trace = () => {},
      translateVmPathStrict,
    } = this._deps;

    // Step 1: Build environment with path translation
    const builder = new EnvironmentBuilder({
      filterEnv,
      trace,
      translateVmPathStrict,
    });

    const envResult = builder
      .withBaseEnv(process.env)
      .withAdditionalEnv(envVars)
      .build({ processId, onError });
    if (!envResult.success) {
      return envResult;
    }

    // Step 2: Extract and sanitize spawn options
    const {
      cwd: providedCwd,
      env: ignoredEnv,
      stdio: ignoredStdio,
      ...safeOptions
    } = options || {};

    // Warn about ignored overrides (env/stdio are managed by us)
    if (ignoredEnv && typeof ignoredEnv === 'object') {
      trace('WARNING: spawn() ignoring options.env override');
    }
    if (ignoredStdio !== undefined) {
      trace('WARNING: spawn() ignoring options.stdio override');
    }

    // Step 3: Resolve working directory
    const resolvedCwd = resolveHostCwdPath({
      args,
      canonicalizePathForHostAccess,
      configDirPath: envResult.translatedEnv.CLAUDE_CONFIG_DIR,
      providedCwd,
      sharedCwdPath,
      trace,
    });

    // Step 4: Build final spawn options
    const spawnOptions = {
      ...safeOptions,
      env: envResult.env,
      stdio: DEFAULT_STDIO,
    };
    if (resolvedCwd) {
      spawnOptions.cwd = resolvedCwd;
    } else {
      trace('WARNING: No canonical cwd resolved for spawn()');
    }

    return {
      success: true,
      envVars: envResult.translatedEnv,
      spawnOptions,
    };
  }
}

function createProcessManager(deps) {
  return new ProcessManager(deps);
}

module.exports = {
  DEFAULT_STDIO,
  ProcessManager,
  createProcessManager,
  deriveSessionDirectory,
  deriveSessionMetadataPath,
  resolveHostCwdPath,
  wrapWithBwrap,
  buildBwrapArgs,
  resolveSessionMounts,
  isBwrapAvailable,
  sandboxRequested,
  shouldUseSandbox,
  SANDBOX_HIDDEN_DIRS,
  SANDBOX_HIDDEN_FILES,
};
