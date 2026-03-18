const os = require('os');
const path = require('path');
const fs = require('fs');

// ============================================================================
// DIRECTORY STRUCTURE & PATH MANAGEMENT
// ============================================================================
// This module provides XDG-compliant directory paths for Linux and handles
// VM-to-host path translation. It's the foundation for all file operations
// in the cowork system.
//
// XDG BASE DIRECTORY SPECIFICATION:
//   - XDG_CONFIG_HOME: ~/.config (application configuration)
//   - XDG_DATA_HOME: ~/.local/share (application data)
//   - XDG_CACHE_HOME: ~/.cache (disposable cache files)
//   - XDG_STATE_HOME: ~/.local/state (persistent state/logs)
//
// PATH TRANSLATION:
//   VM path:   /sessions/<name>/mnt/.claude
//   Host path: ~/.config/Claude/local-agent-mode-sessions/sessions/<name>/mnt/.claude
//
// SECURITY:
//   - Path traversal protection (blocks ../ patterns)
//   - Validates all paths stay within sessions base directory
//   - Canonicalization to resolve symlinks safely

function resolveAbsoluteDirectory(value, fallbackPath) {
  // Resolve directory path with fallback if value is not a valid absolute path.
  // Used for XDG environment variables that may not be set.
  if (typeof value === 'string' && value.trim() && path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(fallbackPath);
}

function getCoworkSessionDataDir(dirs, localSessionId) {
  // Get the data directory for a specific session.
  // Path: ~/.local/share/claude-cowork/sessions/<sessionId>
  // Used for persistent session data (file registry, etc.)
  if (!dirs || typeof dirs !== 'object') {
    return null;
  }
  if (typeof localSessionId !== 'string' || !localSessionId.trim()) {
    return null;
  }
  return path.join(dirs.coworkSessionsDataRoot, localSessionId);
}

function getCoworkSessionStateDir(dirs, localSessionId) {
  // Get the state directory for a specific session.
  // Path: ~/.local/state/claude-cowork/sessions/<sessionId>
  // Used for runtime state (watch state, ephemeral data)
  if (!dirs || typeof dirs !== 'object') {
    return null;
  }
  if (typeof localSessionId !== 'string' || !localSessionId.trim()) {
    return null;
  }
  return path.join(dirs.coworkSessionsStateRoot, localSessionId);
}

function getSessionFileRegistryPath(dirs, localSessionId) {
  // Get path to session's file registry (files.jsonl).
  // This JSONL file tracks all files the session has accessed.
  const sessionDir = getCoworkSessionDataDir(dirs, localSessionId);
  return sessionDir ? path.join(sessionDir, 'files.jsonl') : null;
}

function getSessionWatchStatePath(dirs, localSessionId) {
  // Get path to session's file watch state (watch-state.json).
  // Tracks which files are being watched for changes.
  const sessionDir = getCoworkSessionStateDir(dirs, localSessionId);
  return sessionDir ? path.join(sessionDir, 'watch-state.json') : null;
}

function createDirs(options) {
  // Create and return all directory paths used by claude-cowork-linux.
  // Follows XDG Base Directory Specification for Linux compliance.
  //
  // Directory structure:
  //   Config:  ~/.config/Claude (app settings, session metadata)
  //   Data:    ~/.local/share/claude-cowork (persistent data)
  //   Cache:   ~/.cache/claude-cowork (disposable cache)
  //   State:   ~/.local/state/claude-cowork (logs, runtime state)
  //
  // Legacy compatibility: Also includes macOS paths for migration support.
  const env = options && options.env && typeof options.env === 'object' ? options.env : process.env;
  const homeDir = options && typeof options.homeDir === 'string' && options.homeDir.trim()
    ? path.resolve(options.homeDir)
    : os.homedir();

  // Resolve XDG paths with fallbacks to Linux defaults
  const xdgConfigHome = resolveAbsoluteDirectory(env.XDG_CONFIG_HOME, path.join(homeDir, '.config'));
  const xdgDataHome = resolveAbsoluteDirectory(env.XDG_DATA_HOME, path.join(homeDir, '.local', 'share'));
  const xdgCacheHome = resolveAbsoluteDirectory(env.XDG_CACHE_HOME, path.join(homeDir, '.cache'));
  const xdgStateHome = resolveAbsoluteDirectory(env.XDG_STATE_HOME, path.join(homeDir, '.local', 'state'));
  const xdgRuntimeDir = resolveAbsoluteDirectory(env.XDG_RUNTIME_DIR, path.join(xdgStateHome, 'runtime'));

  // Legacy macOS path for migration/compatibility
  const legacyClaudeAppSupportRoot = path.join(homeDir, 'Library', 'Application Support', 'Claude');

  // Claude Desktop paths (shared between macOS and Linux builds)
  const claudeConfigRoot = path.join(xdgConfigHome, 'Claude');
  const claudeLogsDir = path.join(claudeConfigRoot, 'logs');
  const claudeLocalAgentRoot = path.join(claudeConfigRoot, 'local-agent-mode-sessions');
  const claudeVmBundlesDir = path.join(claudeConfigRoot, 'vm_bundles');

  // Cowork-specific paths (Linux-specific extensions)
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
  // SECURITY: Check if targetPath stays within basePath (path traversal protection).
  // Returns false if targetPath contains ../ patterns that escape basePath.
  // 
  // Example:
  //   isPathSafe('/sessions', 'user/project') → true
  //   isPathSafe('/sessions', '../etc/passwd') → false
  const resolved = path.resolve(basePath, targetPath);
  return resolved.startsWith(path.resolve(basePath) + path.sep) || resolved === path.resolve(basePath);
}

function translateVmPathStrict(sessionsBase, vmPath) {
  // SECURITY: Translate VM path to host path with strict validation.
  // VM paths start with /sessions/ and must be translated to the real
  // sessions directory on the Linux host.
  //
  // Translation example:
  //   /sessions/demo/mnt/.claude
  //     → ~/.config/Claude/local-agent-mode-sessions/sessions/demo/mnt/.claude
  //
  // SECURITY CHECKS:
  //   - Validates path starts with /sessions/
  //   - Blocks path traversal attempts (../)
  //   - Ensures result stays within sessions base directory
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
  // Resolve symlinks in a host path to get the canonical absolute path.
  // Falls back to partial resolution if intermediate directories don't exist.
  //
  // Example:
  //   /home/user/project → /home/realuser/project (if /home/user is a symlink)
  if (typeof hostPath !== 'string') {
    return hostPath;
  }
  if (hostPath.startsWith('/sessions/')) {
    throw new Error('canonicalizeHostPath called with raw VM path: ' + hostPath);
  }
  if (!path.isAbsolute(hostPath)) {
    return hostPath;
  }
  
  // Try to resolve the full path
  try {
    return fs.realpathSync(hostPath);
  } catch (_) {
    // If full path doesn't exist, resolve as much as possible
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
  // Translate VM path to host path, then canonicalize it.
  // Combines translateVmPathStrict() + canonicalizeHostPath().
  return canonicalizeHostPath(translateVmPathStrict(sessionsBase, vmPath));
}

function canonicalizePathForHostAccess(sessionsBase, inputPath) {
  // Canonicalize any path (VM or host) for host filesystem access.
  // - If path starts with /sessions/, translate it first
  // - Otherwise, canonicalize it as a host path
  //
  // This is the main entry point for path resolution throughout the codebase.
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
