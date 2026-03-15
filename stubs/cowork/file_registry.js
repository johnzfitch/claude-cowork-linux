const fs = require('fs');
const path = require('path');

const {
  getSessionFileRegistryPath,
} = require('./dirs.js');
const {
  hasStrongFingerprintMatch,
  getFingerprintMatchConfidence,
  normalizeAbsolutePath,
  readFileFingerprint,
} = require('./file_identity.js');
const {
  isPathWithinRoots,
  normalizeAuthorizedRoots,
} = require('./file_watch_manager.js');

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch (_) {
    return false;
  }
}

function createFileId() {
  return 'file_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function parseRegistryLines(serializedValue) {
  if (typeof serializedValue !== 'string' || !serializedValue.trim()) {
    return [];
  }

  const entries = [];
  for (const line of serializedValue.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch (_) {}
  }
  return entries;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  const normalizedHistory = [];
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const normalizedPath = normalizeAbsolutePath(entry.path);
    if (!normalizedPath) {
      continue;
    }
    normalizedHistory.push({
      at: typeof entry.at === 'string' && entry.at.trim() ? entry.at : null,
      path: normalizedPath,
      reason: typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason : 'history',
    });
  }
  return normalizedHistory;
}

function normalizeProvenance(provenance) {
  const normalized = provenance && typeof provenance === 'object' ? { ...provenance } : {};
  if (typeof normalized.created_by !== 'string' || !normalized.created_by.trim()) {
    normalized.created_by = 'cowork';
  }
  if (typeof normalized.linked_by !== 'string' || !normalized.linked_by.trim()) {
    normalized.linked_by = 'user';
  }
  return normalized;
}

function normalizeRegistryEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const localSessionId = typeof entry.localSessionId === 'string' && entry.localSessionId.trim()
    ? entry.localSessionId
    : null;
  const fileId = typeof entry.fileId === 'string' && entry.fileId.trim()
    ? entry.fileId
    : null;
  const originalPath = normalizeAbsolutePath(entry.originalPath);
  const currentPath = normalizeAbsolutePath(entry.currentPath);
  if (!localSessionId || !fileId || !originalPath || !currentPath) {
    return null;
  }

  return {
    fileId,
    localSessionId,
    originalPath,
    currentPath,
    status: typeof entry.status === 'string' && entry.status.trim() ? entry.status : 'active',
    fingerprint: entry.fingerprint && typeof entry.fingerprint === 'object' ? { ...entry.fingerprint } : null,
    authorizedRoots: normalizeAuthorizedRoots(entry.authorizedRoots),
    provenance: normalizeProvenance(entry.provenance),
    createdAt: typeof entry.createdAt === 'string' && entry.createdAt.trim() ? entry.createdAt : null,
    updatedAt: typeof entry.updatedAt === 'string' && entry.updatedAt.trim() ? entry.updatedAt : null,
    history: normalizeHistory(entry.history),
  };
}

function createFileResolutionResult(context) {
  const entry = context && context.entry && typeof context.entry === 'object'
    ? context.entry
    : null;
  const requestedPath = normalizeAbsolutePath(context && context.requestedPath);
  const resolvedPath = normalizeAbsolutePath(context && context.resolvedPath);
  const candidates = Array.isArray(context && context.candidates)
    ? context.candidates
      .map((candidate) => {
        if (!candidate || typeof candidate !== 'object') {
          return null;
        }
        const candidatePath = normalizeAbsolutePath(candidate.path);
        if (!candidatePath) {
          return null;
        }
        return {
          confidence: typeof candidate.confidence === 'string' && candidate.confidence.trim()
            ? candidate.confidence
            : null,
          path: candidatePath,
          reason: typeof candidate.reason === 'string' && candidate.reason.trim()
            ? candidate.reason
            : null,
        };
      })
      .filter(Boolean)
    : [];

  return {
    authorized: !!(context && context.authorized),
    candidates,
    entry,
    file: entry ? {
      authorizedRoots: Array.isArray(entry.authorizedRoots) ? entry.authorizedRoots.slice() : [],
      currentPath: entry.currentPath,
      fileId: entry.fileId,
      history: Array.isArray(entry.history) ? entry.history.slice() : [],
      originalPath: entry.originalPath,
      provenance: entry.provenance ? { ...entry.provenance } : null,
      status: entry.status,
    } : null,
    fileId: entry && typeof entry.fileId === 'string' ? entry.fileId : null,
    relinkRequired: !!(context && context.relinkRequired),
    requestedPath: requestedPath || (typeof context?.requestedPath === 'string' ? context.requestedPath : null),
    resolvedPath: resolvedPath || (typeof context?.resolvedPath === 'string' ? context.resolvedPath : null),
    resolution: typeof context?.resolution === 'string' && context.resolution.trim()
      ? context.resolution
      : 'invalid',
  };
}

function getKnownPaths(entry) {
  const knownPaths = new Set();
  if (!entry || typeof entry !== 'object') {
    return knownPaths;
  }

  if (typeof entry.originalPath === 'string') {
    knownPaths.add(entry.originalPath);
  }
  if (typeof entry.currentPath === 'string') {
    knownPaths.add(entry.currentPath);
  }
  for (const historyEntry of entry.history || []) {
    if (historyEntry && typeof historyEntry.path === 'string') {
      knownPaths.add(historyEntry.path);
    }
  }
  return knownPaths;
}

function appendHistoryEntry(history, targetPath, at, reason) {
  const normalizedHistory = normalizeHistory(history);
  const normalizedTargetPath = normalizeAbsolutePath(targetPath);
  if (!normalizedTargetPath) {
    return normalizedHistory;
  }

  const previousEntry = normalizedHistory[normalizedHistory.length - 1];
  if (previousEntry && previousEntry.path === normalizedTargetPath) {
    return normalizedHistory;
  }

  return normalizedHistory.concat({
    at,
    path: normalizedTargetPath,
    reason: typeof reason === 'string' && reason.trim() ? reason : 'updated',
  });
}

function readRegistryFile(registryPath) {
  if (typeof registryPath !== 'string' || !registryPath.trim() || !pathExists(registryPath)) {
    return [];
  }

  try {
    return parseRegistryLines(fs.readFileSync(registryPath, 'utf8'))
      .map((entry) => normalizeRegistryEntry(entry))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function listCandidateFiles(rootPath, limit) {
  const normalizedRoot = normalizeAbsolutePath(rootPath);
  if (!normalizedRoot || !pathExists(normalizedRoot)) {
    return [];
  }

  const pendingPaths = [normalizedRoot];
  const candidateFiles = [];
  while (pendingPaths.length > 0 && candidateFiles.length < limit) {
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
      if (entry.isFile()) {
        candidateFiles.push(entryPath);
      }
      if (candidateFiles.length >= limit) {
        break;
      }
    }
  }

  return candidateFiles;
}

class FileRegistry {
  constructor(options) {
    const {
      dirs,
      idFactory,
      maxScanEntries,
      now,
      watchManager,
    } = options || {};

    this._dirs = dirs || null;
    this._watchManager = watchManager || null;
    this._idFactory = typeof idFactory === 'function' ? idFactory : createFileId;
    this._maxScanEntries = Number.isInteger(maxScanEntries) && maxScanEntries > 0
      ? maxScanEntries
      : 2048;
    this._now = typeof now === 'function'
      ? now
      : () => new Date().toISOString();
  }

  getRegistryPath(localSessionId) {
    return getSessionFileRegistryPath(this._dirs, localSessionId);
  }

  listEntries(localSessionId) {
    return this._loadEntries(localSessionId);
  }

  getEntryByKnownPath(localSessionId, targetPath) {
    const normalizedTargetPath = normalizeAbsolutePath(targetPath);
    if (!normalizedTargetPath) {
      return null;
    }

    return this._loadEntries(localSessionId).find((entry) => getKnownPaths(entry).has(normalizedTargetPath)) || null;
  }

  getEntryByFileId(localSessionId, fileId) {
    if (typeof localSessionId !== 'string' || !localSessionId.trim()) {
      return null;
    }
    if (typeof fileId !== 'string' || !fileId.trim()) {
      return null;
    }

    return this._loadEntries(localSessionId).find((entry) => entry.fileId === fileId) || null;
  }

  trackPath(context) {
    const {
      authorizedRoots,
      localSessionId,
      provenance,
      targetPath,
    } = context || {};

    if (typeof localSessionId !== 'string' || !localSessionId.trim()) {
      return null;
    }

    const normalizedTargetPath = normalizeAbsolutePath(targetPath);
    if (!normalizedTargetPath || !pathExists(normalizedTargetPath)) {
      return null;
    }

    const normalizedRoots = normalizeAuthorizedRoots(authorizedRoots);
    if (normalizedRoots.length > 0 && !isPathWithinRoots(normalizedTargetPath, normalizedRoots)) {
      return null;
    }

    const fingerprint = readFileFingerprint(normalizedTargetPath);
    const now = this._now();
    const existingEntry = this._findExistingEntry(localSessionId, normalizedTargetPath);

    if (!existingEntry) {
      const nextEntry = {
        fileId: this._idFactory(),
        localSessionId,
        originalPath: normalizedTargetPath,
        currentPath: normalizedTargetPath,
        status: 'active',
        fingerprint,
        authorizedRoots: normalizedRoots,
        provenance: normalizeProvenance(provenance),
        createdAt: now,
        updatedAt: now,
        history: appendHistoryEntry([], normalizedTargetPath, now, 'observed'),
      };
      this._appendEntry(localSessionId, nextEntry);
      return nextEntry;
    }

    const nextEntry = {
      ...existingEntry,
      currentPath: normalizedTargetPath,
      status: 'active',
      fingerprint: fingerprint || existingEntry.fingerprint,
      authorizedRoots: normalizedRoots.length > 0
        ? normalizedRoots
        : existingEntry.authorizedRoots,
      provenance: {
        ...existingEntry.provenance,
        ...normalizeProvenance(provenance),
      },
      updatedAt: now,
      history: appendHistoryEntry(existingEntry.history, normalizedTargetPath, now, 'observed'),
    };

    if (JSON.stringify(nextEntry) === JSON.stringify(existingEntry)) {
      return existingEntry;
    }

    this._appendEntry(localSessionId, nextEntry);
    return nextEntry;
  }

  relinkPath(context) {
    const {
      authorizedRoots,
      currentPath,
      localSessionId,
      provenance,
      reason,
      resolution,
      targetPath,
    } = context || {};

    const normalizedCurrentPath = normalizeAbsolutePath(currentPath);
    const normalizedTargetPath = normalizeAbsolutePath(targetPath);
    if (
      typeof localSessionId !== 'string' ||
      !localSessionId.trim() ||
      !normalizedCurrentPath ||
      !normalizedTargetPath ||
      !pathExists(normalizedTargetPath)
    ) {
      return null;
    }

    const entry = this.getEntryByKnownPath(localSessionId, normalizedCurrentPath);
    if (!entry) {
      return null;
    }

    const relinkResult = this.relinkFile({
      authorizedRoots,
      fileId: entry.fileId,
      localSessionId,
      provenance,
      reason,
      resolution,
      targetPath: normalizedTargetPath,
    });
    return relinkResult && relinkResult.entry ? relinkResult.entry : null;
  }

  relinkFile(context) {
    const {
      authorizedRoots,
      fileId,
      localSessionId,
      provenance,
      reason,
      resolution,
      targetPath,
    } = context || {};

    const normalizedTargetPath = normalizeAbsolutePath(targetPath);
    if (
      typeof localSessionId !== 'string' ||
      !localSessionId.trim() ||
      typeof fileId !== 'string' ||
      !fileId.trim()
    ) {
      return createFileResolutionResult({
        authorized: false,
        entry: null,
        relinkRequired: false,
        requestedPath: normalizedTargetPath || targetPath,
        resolvedPath: normalizedTargetPath || targetPath,
        resolution: 'context_required',
      });
    }

    const entry = this.getEntryByFileId(localSessionId, fileId);
    if (!entry) {
      return createFileResolutionResult({
        authorized: false,
        entry: null,
        relinkRequired: false,
        requestedPath: normalizedTargetPath || targetPath,
        resolvedPath: normalizedTargetPath || targetPath,
        resolution: 'not_found',
      });
    }

    if (!normalizedTargetPath) {
      return createFileResolutionResult({
        authorized: false,
        entry,
        relinkRequired: true,
        requestedPath: targetPath,
        resolvedPath: targetPath,
        resolution: 'invalid',
      });
    }

    const normalizedRoots = normalizeAuthorizedRoots(authorizedRoots);
    const boundedRoots = normalizedRoots.length > 0
      ? normalizedRoots
      : Array.isArray(entry.authorizedRoots)
        ? entry.authorizedRoots
        : [];
    const entryRoots = Array.isArray(entry.authorizedRoots) ? entry.authorizedRoots : [];
    const withinBoundedRoots = boundedRoots.length > 0 && isPathWithinRoots(normalizedTargetPath, boundedRoots);
    const withinEntryRoots = entryRoots.length === 0 || isPathWithinRoots(normalizedTargetPath, entryRoots);
    if (!withinBoundedRoots || !withinEntryRoots) {
      return createFileResolutionResult({
        authorized: false,
        entry,
        relinkRequired: true,
        requestedPath: normalizedTargetPath,
        resolvedPath: normalizedTargetPath,
        resolution: 'unauthorized',
      });
    }

    if (!pathExists(normalizedTargetPath)) {
      return createFileResolutionResult({
        authorized: true,
        entry,
        relinkRequired: true,
        requestedPath: normalizedTargetPath,
        resolvedPath: normalizedTargetPath,
        resolution: 'missing',
      });
    }

    const now = this._now();
    const nextEntry = {
      ...entry,
      currentPath: normalizedTargetPath,
      status: 'relinked',
      fingerprint: readFileFingerprint(normalizedTargetPath) || entry.fingerprint,
      authorizedRoots: boundedRoots,
      provenance: normalizeProvenance({
        ...entry.provenance,
        ...(provenance && typeof provenance === 'object' ? provenance : {}),
      }),
      updatedAt: now,
      history: appendHistoryEntry(entry.history, normalizedTargetPath, now, reason || 'relinked'),
    };
    this._appendEntry(localSessionId, nextEntry);
    return createFileResolutionResult({
      authorized: true,
      entry: nextEntry,
      relinkRequired: false,
      requestedPath: normalizedTargetPath,
      resolvedPath: normalizedTargetPath,
      resolution: typeof resolution === 'string' && resolution.trim() ? resolution : 'relinked',
    });
  }

  resolvePath(context) {
    const {
      authorizedRoots,
      localSessionId,
      provenance,
      targetPath,
    } = context || {};

    const normalizedTargetPath = normalizeAbsolutePath(targetPath);
    if (!normalizedTargetPath) {
      return {
        ...createFileResolutionResult({
          authorized: false,
          entry: null,
          relinkRequired: false,
          requestedPath: targetPath,
          resolvedPath: targetPath,
          resolution: 'invalid',
        }),
      };
    }

    const normalizedRoots = normalizeAuthorizedRoots(authorizedRoots);
    if (normalizedRoots.length > 0 && !isPathWithinRoots(normalizedTargetPath, normalizedRoots)) {
      const unauthorizedEntry = typeof localSessionId === 'string' && localSessionId.trim()
        ? this.getEntryByKnownPath(localSessionId, normalizedTargetPath)
        : null;
      return {
        ...createFileResolutionResult({
          authorized: false,
          entry: unauthorizedEntry,
          relinkRequired: !!unauthorizedEntry,
          requestedPath: normalizedTargetPath,
          resolvedPath: normalizedTargetPath,
          resolution: 'unauthorized',
        }),
      };
    }

    if (pathExists(normalizedTargetPath)) {
      const trackedEntry = this.trackPath({
        authorizedRoots: normalizedRoots,
        localSessionId,
        provenance,
        targetPath: normalizedTargetPath,
      });
      return {
        ...createFileResolutionResult({
          authorized: true,
          entry: trackedEntry,
          relinkRequired: false,
          requestedPath: normalizedTargetPath,
          resolvedPath: normalizedTargetPath,
          resolution: trackedEntry ? 'exact' : 'untracked',
        }),
      };
    }

    if (typeof localSessionId !== 'string' || !localSessionId.trim()) {
      return {
        ...createFileResolutionResult({
          authorized: false,
          entry: null,
          relinkRequired: false,
          requestedPath: normalizedTargetPath,
          resolvedPath: normalizedTargetPath,
          resolution: 'missing',
        }),
      };
    }

    const entry = this.getEntryByKnownPath(localSessionId, normalizedTargetPath);
    if (!entry) {
      return {
        ...createFileResolutionResult({
          authorized: true,
          entry: null,
          relinkRequired: false,
          requestedPath: normalizedTargetPath,
          resolvedPath: normalizedTargetPath,
          resolution: 'missing',
        }),
      };
    }

    if (normalizedRoots.length === 0) {
      return this._markMissing(localSessionId, entry, 'missing', normalizedTargetPath, false);
    }

    if (!isPathWithinRoots(entry.currentPath, normalizedRoots) && !isPathWithinRoots(entry.originalPath, normalizedRoots)) {
      return {
        ...createFileResolutionResult({
          authorized: false,
          entry,
          relinkRequired: true,
          requestedPath: normalizedTargetPath,
          resolvedPath: normalizedTargetPath,
          resolution: 'unauthorized',
        }),
      };
    }

    if (pathExists(entry.currentPath)) {
      return {
        ...createFileResolutionResult({
          authorized: true,
          entry,
          relinkRequired: false,
          requestedPath: normalizedTargetPath,
          resolvedPath: entry.currentPath,
          resolution: 'registry',
        }),
      };
    }

    const watcherCandidate = this._watchManager && typeof this._watchManager.resolveCandidatePath === 'function'
      ? this._watchManager.resolveCandidatePath({
        authorizedRoots: normalizedRoots,
        localSessionId,
        targetPath: normalizedTargetPath,
      })
      : null;

    if (
      watcherCandidate &&
      typeof watcherCandidate.toPath === 'string' &&
      pathExists(watcherCandidate.toPath)
    ) {
      const relinkedResult = this.relinkFile({
        authorizedRoots: normalizedRoots,
        fileId: entry.fileId,
        localSessionId,
        reason: watcherCandidate.evidence || 'watcher',
        resolution: 'watcher',
        targetPath: watcherCandidate.toPath,
      });
      return relinkedResult;
    }

    const recovery = this._scanForRecoveryCandidate(entry, normalizedRoots);
    if (recovery.type === 'single') {
      const relinkedResult = this.relinkFile({
        authorizedRoots: normalizedRoots,
        fileId: entry.fileId,
        localSessionId,
        reason: recovery.reason,
        resolution: 'recovered',
        targetPath: recovery.path,
      });
      return relinkedResult;
    }

    if (recovery.type === 'ambiguous') {
      return this._markMissing(localSessionId, entry, 'missing', normalizedTargetPath, true, 'ambiguous', recovery.candidates);
    }

    return this._markMissing(localSessionId, entry, 'missing', normalizedTargetPath, true);
  }

  _findExistingEntry(localSessionId, targetPath) {
    const normalizedTargetPath = normalizeAbsolutePath(targetPath);
    if (!normalizedTargetPath) {
      return null;
    }

    const entries = this._loadEntries(localSessionId);
    for (const entry of entries) {
      if (getKnownPaths(entry).has(normalizedTargetPath)) {
        return entry;
      }
    }
    return null;
  }

  _loadEntries(localSessionId) {
    const registryPath = this.getRegistryPath(localSessionId);
    const entries = readRegistryFile(registryPath);
    const latestByFileId = new Map();
    for (const entry of entries) {
      latestByFileId.set(entry.fileId, entry);
    }
    return Array.from(latestByFileId.values());
  }

  _appendEntry(localSessionId, entry) {
    const registryPath = this.getRegistryPath(localSessionId);
    if (!registryPath) {
      return;
    }

    fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(registryPath, JSON.stringify(entry) + '\n', 'utf8');
  }

  _scanForRecoveryCandidate(entry, authorizedRoots) {
    const knownPaths = getKnownPaths(entry);
    const targetBasename = path.basename(entry.currentPath || entry.originalPath);
    const rankedCandidates = [];
    let remainingBudget = this._maxScanEntries;

    for (const rootPath of authorizedRoots) {
      if (remainingBudget <= 0) {
        break;
      }

      const files = listCandidateFiles(rootPath, remainingBudget);
      remainingBudget -= files.length;
      for (const filePath of files) {
        if (knownPaths.has(filePath) || path.basename(filePath) !== targetBasename) {
          continue;
        }
        const fingerprint = readFileFingerprint(filePath);
        const confidence = getFingerprintMatchConfidence(entry.fingerprint, fingerprint);
        if (!hasStrongFingerprintMatch(entry.fingerprint, fingerprint)) {
          continue;
        }
        rankedCandidates.push({
          confidence,
          path: filePath,
          reason: confidence === 'strong' ? 'fingerprint' : 'metadata',
        });
      }
    }

    if (rankedCandidates.length === 0) {
      return { type: 'none' };
    }

    const confidenceScore = {
      strong: 2,
      medium: 1,
    };
    rankedCandidates.sort((left, right) => confidenceScore[right.confidence] - confidenceScore[left.confidence]);

    if (
      rankedCandidates.length > 1 &&
      rankedCandidates[0].confidence === rankedCandidates[1].confidence &&
      rankedCandidates[0].path !== rankedCandidates[1].path
    ) {
      return {
        type: 'ambiguous',
        candidates: rankedCandidates,
      };
    }

    return {
      path: rankedCandidates[0].path,
      reason: rankedCandidates[0].reason,
      type: 'single',
    };
  }

  _markMissing(localSessionId, entry, status, targetPath, relinkRequired, resolution, candidates) {
    const now = this._now();
    const nextEntry = {
      ...entry,
      status: status || 'missing',
      updatedAt: now,
      history: appendHistoryEntry(entry.history, targetPath, now, status || 'missing'),
    };
    this._appendEntry(localSessionId, nextEntry);

    return createFileResolutionResult({
      authorized: true,
      candidates,
      entry: nextEntry,
      relinkRequired: !!relinkRequired,
      requestedPath: targetPath,
      resolvedPath: normalizeAbsolutePath(targetPath),
      resolution: resolution || 'missing',
    });
  }
}

function createFileRegistry(options) {
  return new FileRegistry(options);
}

module.exports = {
  FileRegistry,
  appendHistoryEntry,
  createFileRegistry,
  createFileResolutionResult,
  createFileId,
  getKnownPaths,
  normalizeRegistryEntry,
  normalizeProvenance,
  parseRegistryLines,
  readRegistryFile,
};
