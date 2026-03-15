const os = require('os');
const path = require('path');
const fs = require('fs');

function resolveAbsoluteDirectory(value, fallbackPath) {
  if (typeof value === 'string' && value.trim() && path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(fallbackPath);
}

function getCoworkSessionDataDir(dirs, localSessionId) {
  if (!dirs || typeof dirs !== 'object') {
    return null;
  }
  if (typeof localSessionId !== 'string' || !localSessionId.trim()) {
    return null;
  }
  return path.join(dirs.coworkSessionsDataRoot, localSessionId);
}

function getCoworkSessionStateDir(dirs, localSessionId) {
  if (!dirs || typeof dirs !== 'object') {
    return null;
  }
  if (typeof localSessionId !== 'string' || !localSessionId.trim()) {
    return null;
  }
  return path.join(dirs.coworkSessionsStateRoot, localSessionId);
}

function getSessionFileRegistryPath(dirs, localSessionId) {
  const sessionDir = getCoworkSessionDataDir(dirs, localSessionId);
  return sessionDir ? path.join(sessionDir, 'files.jsonl') : null;
}

function getSessionWatchStatePath(dirs, localSessionId) {
  const sessionDir = getCoworkSessionStateDir(dirs, localSessionId);
  return sessionDir ? path.join(sessionDir, 'watch-state.json') : null;
}

function createDirs(options) {
  const env = options && options.env && typeof options.env === 'object' ? options.env : process.env;
  const homeDir = options && typeof options.homeDir === 'string' && options.homeDir.trim()
    ? path.resolve(options.homeDir)
    : os.homedir();

  const xdgConfigHome = resolveAbsoluteDirectory(env.XDG_CONFIG_HOME, path.join(homeDir, '.config'));
  const xdgDataHome = resolveAbsoluteDirectory(env.XDG_DATA_HOME, path.join(homeDir, '.local', 'share'));
  const xdgCacheHome = resolveAbsoluteDirectory(env.XDG_CACHE_HOME, path.join(homeDir, '.cache'));
  const xdgStateHome = resolveAbsoluteDirectory(env.XDG_STATE_HOME, path.join(homeDir, '.local', 'state'));
  const xdgRuntimeDir = resolveAbsoluteDirectory(env.XDG_RUNTIME_DIR, path.join(xdgStateHome, 'runtime'));

  const legacyClaudeAppSupportRoot = path.join(homeDir, 'Library', 'Application Support', 'Claude');

  const claudeConfigRoot = path.join(xdgConfigHome, 'Claude');
  const claudeLogsDir = path.join(claudeConfigRoot, 'logs');
  const claudeLocalAgentRoot = path.join(claudeConfigRoot, 'local-agent-mode-sessions');
  const claudeVmBundlesDir = path.join(claudeConfigRoot, 'vm_bundles');

  const coworkConfigRoot = path.join(xdgConfigHome, 'claude-cowork');
  const coworkDataRoot = path.join(xdgDataHome, 'claude-cowork');
  const coworkCacheRoot = path.join(xdgCacheHome, 'claude-cowork');
  const coworkStateRoot = path.join(xdgStateHome, 'claude-cowork');
  const coworkSessionsDataRoot = path.join(coworkDataRoot, 'sessions');
  const coworkSessionsStateRoot = path.join(coworkStateRoot, 'sessions');
  const coworkLogsDir = path.join(coworkStateRoot, 'logs');
  const legacyCoworkLogsDir = path.join(coworkDataRoot, 'logs');

  return {
    homeDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
    xdgRuntimeDir,
    claudeConfigRoot,
    claudeLogsDir,
    claudeLocalAgentRoot,
    claudeVmBundlesDir,
    claudeSessionsBase: path.join(claudeLocalAgentRoot, 'sessions'),
    claudeVmRoots: [
      path.join(claudeConfigRoot, 'claude-code-vm'),
      path.join(coworkDataRoot, 'claude-code-vm'),
      path.join(legacyClaudeAppSupportRoot, 'claude-code-vm'),
    ],
    coworkConfigRoot,
    coworkDataRoot,
    coworkCacheRoot,
    coworkStateRoot,
    coworkSessionsDataRoot,
    coworkSessionsStateRoot,
    coworkLogsDir,
    legacyCoworkLogsDir,
    legacyClaudeAppSupportRoot,
  };
}

function isPathSafe(basePath, targetPath) {
  const resolved = path.resolve(basePath, targetPath);
  return resolved.startsWith(path.resolve(basePath) + path.sep) || resolved === path.resolve(basePath);
}

function translateVmPathStrict(sessionsBase, vmPath) {
  if (typeof vmPath !== 'string' || !vmPath.startsWith('/sessions/')) {
    throw new Error('Not a VM path: ' + vmPath);
  }
  const sessionPath = vmPath.substring('/sessions/'.length);
  if (sessionPath.includes('..') || !isPathSafe(sessionsBase, sessionPath)) {
    throw new Error('Path traversal blocked: ' + vmPath);
  }
  return path.join(sessionsBase, sessionPath);
}

function canonicalizeHostPath(hostPath) {
  if (typeof hostPath !== 'string') {
    return hostPath;
  }
  if (hostPath.startsWith('/sessions/')) {
    throw new Error('canonicalizeHostPath called with raw VM path: ' + hostPath);
  }
  if (!path.isAbsolute(hostPath)) {
    return hostPath;
  }
  try {
    return fs.realpathSync(hostPath);
  } catch (_) {
    const segments = [];
    let current = path.dirname(hostPath);
    segments.push(path.basename(hostPath));
    while (current !== path.dirname(current)) {
      try {
        return path.join(fs.realpathSync(current), ...segments);
      } catch (_) {
        segments.unshift(path.basename(current));
        current = path.dirname(current);
      }
    }
    return hostPath;
  }
}

function canonicalizeVmPathStrict(sessionsBase, vmPath) {
  return canonicalizeHostPath(translateVmPathStrict(sessionsBase, vmPath));
}

function canonicalizePathForHostAccess(sessionsBase, inputPath) {
  if (typeof inputPath === 'string' && inputPath.startsWith('/sessions/')) {
    return canonicalizeVmPathStrict(sessionsBase, inputPath);
  }
  return canonicalizeHostPath(inputPath);
}

module.exports = {
  canonicalizeHostPath,
  canonicalizePathForHostAccess,
  canonicalizeVmPathStrict,
  createDirs,
  getCoworkSessionDataDir,
  getCoworkSessionStateDir,
  getSessionFileRegistryPath,
  getSessionWatchStatePath,
  isPathSafe,
  resolveAbsoluteDirectory,
  translateVmPathStrict,
};
