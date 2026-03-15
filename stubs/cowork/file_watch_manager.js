const fs = require('fs');
const path = require('path');

const {
  getSessionWatchStatePath,
} = require('./dirs.js');
const {
  normalizeAbsolutePath,
} = require('./file_identity.js');

function normalizeAuthorizedRoots(authorizedRoots) {
  if (!Array.isArray(authorizedRoots)) {
    return [];
  }

  const seenRoots = new Set();
  const normalizedRoots = [];
  for (const rootPath of authorizedRoots) {
    const normalizedRoot = normalizeAbsolutePath(rootPath);
    if (!normalizedRoot || seenRoots.has(normalizedRoot)) {
      continue;
    }
    seenRoots.add(normalizedRoot);
    normalizedRoots.push(normalizedRoot);
  }
  return normalizedRoots;
}

function isPathWithinRoots(targetPath, authorizedRoots) {
  const normalizedPath = normalizeAbsolutePath(targetPath);
  if (!normalizedPath) {
    return false;
  }

  const normalizedRoots = normalizeAuthorizedRoots(authorizedRoots);
  return normalizedRoots.some((rootPath) => (
    normalizedPath === rootPath ||
    normalizedPath.startsWith(rootPath + path.sep)
  ));
}

function readWatchStateFile(watchStatePath) {
  if (typeof watchStatePath !== 'string' || !watchStatePath.trim() || !fs.existsSync(watchStatePath)) {
    return {
      updates: [],
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(watchStatePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.updates)) {
      return { updates: [] };
    }
    return parsed;
  } catch (_) {
    return { updates: [] };
  }
}

class FileWatchManager {
  constructor(options) {
    const { dirs, maxUpdatesPerSession, now } = options || {};
    this._dirs = dirs || null;
    this._maxUpdatesPerSession = Number.isInteger(maxUpdatesPerSession) && maxUpdatesPerSession > 0
      ? maxUpdatesPerSession
      : 256;
    this._now = typeof now === 'function'
      ? now
      : () => new Date().toISOString();
  }

  getWatchStatePath(localSessionId) {
    return getSessionWatchStatePath(this._dirs, localSessionId);
  }

  readWatchState(localSessionId) {
    return readWatchStateFile(this.getWatchStatePath(localSessionId));
  }

  recordPathUpdate(context) {
    const {
      localSessionId,
      fromPath,
      toPath,
      authorizedRoots,
      evidence,
    } = context || {};

    if (typeof localSessionId !== 'string' || !localSessionId.trim()) {
      return {
        ok: false,
        error: 'Missing local session id',
      };
    }

    const normalizedFromPath = normalizeAbsolutePath(fromPath);
    const normalizedToPath = normalizeAbsolutePath(toPath);
    if (!normalizedFromPath || !normalizedToPath) {
      return {
        ok: false,
        error: 'Path update requires absolute paths',
      };
    }

    const normalizedRoots = normalizeAuthorizedRoots(authorizedRoots);
    if (
      normalizedRoots.length > 0 &&
      (
        !isPathWithinRoots(normalizedFromPath, normalizedRoots) ||
        !isPathWithinRoots(normalizedToPath, normalizedRoots)
      )
    ) {
      return {
        ok: false,
        error: 'Watcher update is outside authorized roots',
      };
    }

    const watchStatePath = this.getWatchStatePath(localSessionId);
    if (!watchStatePath) {
      return {
        ok: false,
        error: 'Missing watch state path',
      };
    }

    const currentState = readWatchStateFile(watchStatePath);
    const nextUpdate = {
      fromPath: normalizedFromPath,
      toPath: normalizedToPath,
      evidence: typeof evidence === 'string' && evidence.trim() ? evidence : 'watcher',
      detectedAt: this._now(),
    };
    const nextUpdates = currentState.updates
      .filter((entry) => !entry || entry.fromPath !== normalizedFromPath)
      .concat(nextUpdate)
      .slice(-this._maxUpdatesPerSession);

    fs.mkdirSync(path.dirname(watchStatePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(watchStatePath, JSON.stringify({
      localSessionId,
      updates: nextUpdates,
    }, null, 2) + '\n', 'utf8');

    return {
      ok: true,
      update: nextUpdate,
      watchStatePath,
    };
  }

  resolveCandidatePath(context) {
    const {
      localSessionId,
      targetPath,
      authorizedRoots,
    } = context || {};

    const normalizedTargetPath = normalizeAbsolutePath(targetPath);
    if (typeof localSessionId !== 'string' || !localSessionId.trim() || !normalizedTargetPath) {
      return null;
    }

    const normalizedRoots = normalizeAuthorizedRoots(authorizedRoots);
    if (normalizedRoots.length > 0 && !isPathWithinRoots(normalizedTargetPath, normalizedRoots)) {
      return null;
    }

    const watchState = this.readWatchState(localSessionId);
    for (let index = watchState.updates.length - 1; index >= 0; index -= 1) {
      const update = watchState.updates[index];
      if (!update || update.fromPath !== normalizedTargetPath) {
        continue;
      }
      if (normalizedRoots.length > 0 && !isPathWithinRoots(update.toPath, normalizedRoots)) {
        continue;
      }
      return update;
    }

    return null;
  }
}

function createFileWatchManager(options) {
  return new FileWatchManager(options);
}

module.exports = {
  FileWatchManager,
  createFileWatchManager,
  isPathWithinRoots,
  normalizeAuthorizedRoots,
  readWatchStateFile,
};
