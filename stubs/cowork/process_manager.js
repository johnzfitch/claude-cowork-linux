const fs = require('fs');
const path = require('path');
const { classifyEnvEntry } = require('./credential_classifier.js');

const DEFAULT_STDIO = ['pipe', 'pipe', 'pipe'];

function deriveSessionDirectory(configDirPath) {
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
  const sessionDirectory = deriveSessionDirectory(configDirPath);
  if (!sessionDirectory) {
    return null;
  }
  return sessionDirectory + '.json';
}

function getPreferredWorkspaceFromSessionMetadata(sessionData) {
  if (!sessionData || typeof sessionData !== 'object' || Array.isArray(sessionData)) {
    return null;
  }

  if (Array.isArray(sessionData.userSelectedFolders)) {
    for (const folderPath of sessionData.userSelectedFolders) {
      if (typeof folderPath === 'string' && path.isAbsolute(folderPath)) {
        return path.resolve(folderPath);
      }
    }
  }

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

function collectAddDirArgs(args) {
  if (!Array.isArray(args)) {
    return [];
  }

  const addDirArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--add-dir' && typeof args[index + 1] === 'string') {
      addDirArgs.push(args[index + 1]);
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--add-dir=')) {
      addDirArgs.push(arg.slice('--add-dir='.length));
    }
  }
  return addDirArgs;
}

function resolveHostCwdPath(context) {
  const {
    args,
    canonicalizePathForHostAccess,
    configDirPath,
    providedCwd,
    sharedCwdPath,
    trace = () => {},
  } = context || {};

  const candidates = [];
  if (typeof sharedCwdPath === 'string' && sharedCwdPath.trim()) {
    candidates.push({ label: 'sharedCwdPath', value: sharedCwdPath });
  }

  const metadataWorkspace = readPreferredWorkspaceFromConfigDir(configDirPath, trace);
  if (metadataWorkspace) {
    candidates.push({ label: 'session metadata', value: metadataWorkspace });
  }

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

  if (typeof providedCwd === 'string' && providedCwd.trim()) {
    candidates.push({ label: 'options.cwd', value: providedCwd });
  }

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

class EnvironmentBuilder {
  constructor(deps) {
    this._deps = deps || {};
    this._baseEnv = {};
    this._additionalEnv = {};
  }

  withBaseEnv(baseEnv) {
    this._baseEnv = baseEnv && typeof baseEnv === 'object' ? { ...baseEnv } : {};
    return this;
  }

  withAdditionalEnv(additionalEnv) {
    this._additionalEnv = additionalEnv && typeof additionalEnv === 'object' ? { ...additionalEnv } : {};
    return this;
  }

  build(context) {
    const { processId, onError } = context || {};
    const {
      filterEnv,
      trace = () => {},
      translateVmPathStrict,
    } = this._deps;

    const translatedEnv = { ...this._additionalEnv };
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

class ProcessManager {
  constructor(deps) {
    this._deps = deps || {};
  }

  buildSpawnOptions(context) {
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

    const {
      cwd: providedCwd,
      env: ignoredEnv,
      stdio: ignoredStdio,
      ...safeOptions
    } = options || {};

    if (ignoredEnv && typeof ignoredEnv === 'object') {
      trace('WARNING: spawn() ignoring options.env override');
    }
    if (ignoredStdio !== undefined) {
      trace('WARNING: spawn() ignoring options.stdio override');
    }

    const resolvedCwd = resolveHostCwdPath({
      args,
      canonicalizePathForHostAccess,
      configDirPath: envResult.translatedEnv.CLAUDE_CONFIG_DIR,
      providedCwd,
      sharedCwdPath,
      trace,
    });

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
  deriveSessionDirectory,
  deriveSessionMetadataPath,
  EnvironmentBuilder,
  getPreferredWorkspaceFromSessionMetadata,
  ProcessManager,
  readPreferredWorkspaceFromConfigDir,
  resolveHostCwdPath,
  createProcessManager,
};
