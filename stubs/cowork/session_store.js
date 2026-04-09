'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ============================================================================
// SESSION STORE — STATELESS PATH UTILITIES
// ============================================================================
// Minimal path validation and session metadata lookup utilities for the Linux
// compatibility layer. These translate VM-internal paths to host paths and
// validate session working directories.
//
// The Asar's LocalAgentModeSessionManager owns session lifecycle, transcript
// discovery, and persistence. This module only provides the platform-specific
// path repair that the Asar can't do (it assumes macOS VM paths).

function isCanonicalHostPath(targetPath) {
  return (
    typeof targetPath === 'string' &&
    targetPath.trim() &&
    path.isAbsolute(targetPath) &&
    !targetPath.startsWith('/sessions/')
  );
}

function isDesktopRuntimePath(targetPath) {
  if (!isCanonicalHostPath(targetPath)) {
    return false;
  }
  const homeDir = os.homedir();
  const xdgDataHome = typeof process.env.XDG_DATA_HOME === 'string' && process.env.XDG_DATA_HOME.trim()
    ? path.resolve(process.env.XDG_DATA_HOME)
    : path.join(homeDir, '.local', 'share');
  const desktopDataRoot = path.join(xdgDataHome, 'claude-desktop');
  const normalizedTargetPath = path.resolve(targetPath);
  return normalizedTargetPath === desktopDataRoot || normalizedTargetPath.startsWith(desktopDataRoot + path.sep);
}

function isSyntheticSessionCwd(targetPath, sessionData) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    return false;
  }
  if (targetPath.startsWith('/sessions/')) {
    return true;
  }
  const processNames = [
    sessionData && typeof sessionData.processName === 'string' ? sessionData.processName : null,
    sessionData && typeof sessionData.vmProcessName === 'string' ? sessionData.vmProcessName : null,
  ].filter(Boolean);
  return processNames.some((processName) => targetPath === path.join('/home', processName));
}

function shouldRepairSessionCwd(targetPath, sessionData) {
  if (!isCanonicalHostPath(targetPath)) {
    return true;
  }
  return isSyntheticSessionCwd(targetPath, sessionData) || isDesktopRuntimePath(targetPath);
}

function getPreferredSessionRoot(sessionData) {
  if (!sessionData || typeof sessionData !== 'object' || !Array.isArray(sessionData.userSelectedFolders)) {
    return null;
  }
  for (const folderPath of sessionData.userSelectedFolders) {
    if (isCanonicalHostPath(folderPath) && !isDesktopRuntimePath(folderPath)) {
      return path.resolve(folderPath);
    }
  }
  return null;
}

function getAuthorizedSessionRoots(sessionData) {
  if (!sessionData || typeof sessionData !== 'object' || !Array.isArray(sessionData.userSelectedFolders)) {
    return [];
  }
  const seenRoots = new Set();
  const authorizedRoots = [];
  for (const folderPath of sessionData.userSelectedFolders) {
    if (!isCanonicalHostPath(folderPath) || isDesktopRuntimePath(folderPath)) {
      continue;
    }
    const normalizedPath = path.resolve(folderPath);
    if (seenRoots.has(normalizedPath)) {
      continue;
    }
    seenRoots.add(normalizedPath);
    authorizedRoots.push(normalizedPath);
  }
  return authorizedRoots;
}

// -- Session metadata file discovery --
// Cached to avoid repeated recursive scans (was the #1 profiler hot spot).

let _metadataFileCache = null;
let _metadataFileCacheRoot = null;
let _metadataFileCacheTs = 0;
const METADATA_CACHE_TTL_MS = 5000;
let _metadataFileIndex = null;

function invalidateMetadataFileCache() {
  _metadataFileCache = null;
  _metadataFileIndex = null;
  _metadataFileCacheTs = 0;
}

function listLocalSessionMetadataFiles(rootPath) {
  const now = Date.now();
  if (_metadataFileCache && _metadataFileCacheRoot === rootPath && (now - _metadataFileCacheTs) < METADATA_CACHE_TTL_MS) {
    return _metadataFileCache;
  }

  const pendingPaths = [rootPath];
  const metadataFiles = [];
  while (pendingPaths.length > 0) {
    const currentPath = pendingPaths.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        pendingPaths.push(entryPath);
        continue;
      }
      if (entry.isFile() && /^local_[^/\\]+\.json$/i.test(entry.name)) {
        metadataFiles.push(entryPath);
      }
    }
  }

  _metadataFileCache = metadataFiles;
  _metadataFileCacheRoot = rootPath;
  _metadataFileCacheTs = now;
  _metadataFileIndex = new Map();
  for (const filePath of metadataFiles) {
    _metadataFileIndex.set(path.basename(filePath), filePath);
  }
  return metadataFiles;
}

function findSessionMetadataPath(localAgentRoot, sessionId) {
  if (typeof localAgentRoot !== 'string' || !localAgentRoot.trim()) return null;
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;

  const targetName = sessionId + '.json';
  listLocalSessionMetadataFiles(localAgentRoot);
  if (_metadataFileIndex) {
    return _metadataFileIndex.get(targetName) || null;
  }
  return null;
}

function getSessionDirectory(localAgentRoot, sessionId) {
  const metadataPath = findSessionMetadataPath(localAgentRoot, sessionId);
  if (!metadataPath) return null;
  return metadataPath.replace(/\.json$/i, '');
}

function isLocalSessionMetadataFilePath(localAgentRoot, filePath) {
  if (typeof localAgentRoot !== 'string' || !localAgentRoot.trim()) return false;
  if (typeof filePath !== 'string' || !filePath.trim()) return false;
  const normalizedPath = path.resolve(filePath);
  const normalizedRoot = path.resolve(localAgentRoot);
  if (!normalizedPath.startsWith(normalizedRoot + path.sep)) return false;
  return /^local_[^/\\]+\.json$/i.test(path.basename(normalizedPath));
}

function deriveMetadataPathFromConfigDir(configDirPath) {
  if (typeof configDirPath !== 'string' || !configDirPath.trim()) return null;
  const normalizedPath = path.resolve(configDirPath);
  if (path.basename(normalizedPath) !== '.claude') return null;
  return path.dirname(normalizedPath) + '.json';
}

// -- Stateless session record normalization --
// Fixes VM paths and synthetic CWDs in session metadata. No transcript
// selection, no audit log parsing, no caching — just path repair.

function normalizeSessionRecord(localAgentRoot, sessionData) {
  if (!sessionData || typeof sessionData !== 'object' || Array.isArray(sessionData)) {
    return sessionData;
  }

  const nextSessionData = { ...sessionData };
  const preferredRoot = getPreferredSessionRoot(nextSessionData);

  if (preferredRoot && shouldRepairSessionCwd(nextSessionData.cwd, nextSessionData)) {
    nextSessionData.cwd = preferredRoot;
  }

  return nextSessionData;
}

// -- Lightweight session store --
// Provides the minimum API surface that session_orchestrator.js and
// asar_adapter.js need. Stateless: no observation tracking, no mutation
// routing, no global fs monkey-patching.

function createSessionStore(options) {
  const { localAgentRoot } = options || {};

  return {
    getSessionDirectory(sessionId) {
      return getSessionDirectory(localAgentRoot, sessionId);
    },

    normalizeSessionRecord(sessionData) {
      return normalizeSessionRecord(localAgentRoot, sessionData);
    },

    getSessionInfo(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
      const metadataPath = findSessionMetadataPath(localAgentRoot, sessionId);
      if (!metadataPath) return null;
      let rawSessionData;
      try {
        rawSessionData = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      } catch (_) {
        return null;
      }
      const sessionData = normalizeSessionRecord(localAgentRoot, rawSessionData);
      const preferredRoot = getPreferredSessionRoot(sessionData);
      const sessionDirectory = metadataPath.replace(/\.json$/i, '');
      return { metadataPath, preferredRoot, rawSessionData, sessionDirectory, sessionData };
    },

    getSessionInfoByMetadataPath(metadataPath) {
      if (!metadataPath) return null;
      let rawSessionData;
      try {
        rawSessionData = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      } catch (_) {
        return null;
      }
      const sessionData = normalizeSessionRecord(localAgentRoot, rawSessionData);
      const preferredRoot = getPreferredSessionRoot(sessionData);
      const sessionDirectory = metadataPath.replace(/\.json$/i, '');
      return { metadataPath, preferredRoot, rawSessionData, sessionDirectory, sessionData };
    },

    getSessionInfoForConfigDir(configDirPath) {
      return this.getSessionInfoByMetadataPath(deriveMetadataPathFromConfigDir(configDirPath));
    },

    getAuthorizedRoots(sessionId) {
      const info = this.getSessionInfo(sessionId);
      if (!info) return [];
      return getAuthorizedSessionRoots(info.sessionData);
    },
  };
}

module.exports = {
  createSessionStore,
  deriveMetadataPathFromConfigDir,
  findSessionMetadataPath,
  getAuthorizedSessionRoots,
  getPreferredSessionRoot,
  getSessionDirectory,
  invalidateMetadataFileCache,
  isCanonicalHostPath,
  isDesktopRuntimePath,
  isLocalSessionMetadataFilePath,
  isSyntheticSessionCwd,
  normalizeSessionRecord,
  shouldRepairSessionCwd,
};
