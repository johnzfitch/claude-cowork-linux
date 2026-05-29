const fs = require('fs');
const path = require('path');
const { classifyEnvEntry } = require('./credential_classifier.js');

const DEFAULT_STDIO = ['pipe', 'pipe', 'pipe'];

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
};
