const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function normalizeAbsolutePath(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim() || !path.isAbsolute(targetPath)) {
    return null;
  }
  return path.resolve(targetPath);
}

function toSerializableNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function areEquivalentMtimeMs(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return false;
  }
  return Math.abs(left - right) < 1000;
}

function fingerprintFromStat(stat, options) {
  if (!stat || typeof stat !== 'object') {
    return null;
  }

  const fingerprint = {
    dev: toSerializableNumber(stat.dev),
    ino: toSerializableNumber(stat.ino),
    size: toSerializableNumber(stat.size),
    mtimeMs: toSerializableNumber(stat.mtimeMs),
  };

  if (options && typeof options.contentHash === 'string' && options.contentHash.trim()) {
    fingerprint.contentHash = options.contentHash;
  }

  return fingerprint;
}

function computeFileContentHash(filePath, options) {
  const normalizedPath = normalizeAbsolutePath(filePath);
  if (!normalizedPath) {
    return null;
  }

  const hashAlgorithm = options && typeof options.hashAlgorithm === 'string' && options.hashAlgorithm.trim()
    ? options.hashAlgorithm
    : 'sha256';
  const hasher = crypto.createHash(hashAlgorithm);
  const fileBuffer = fs.readFileSync(normalizedPath);
  hasher.update(fileBuffer);
  return hasher.digest('hex');
}

function readFileFingerprint(filePath, options) {
  const normalizedPath = normalizeAbsolutePath(filePath);
  if (!normalizedPath) {
    return null;
  }

  let stat;
  try {
    stat = fs.statSync(normalizedPath);
  } catch (_) {
    return null;
  }

  const includeContentHash = !!(options && options.includeContentHash && stat.isFile());
  return fingerprintFromStat(stat, {
    contentHash: includeContentHash ? computeFileContentHash(normalizedPath, options) : null,
  });
}

function getFingerprintMatchConfidence(left, right) {
  if (!left || typeof left !== 'object' || !right || typeof right !== 'object') {
    return 'none';
  }

  if (
    Number.isFinite(left.dev) &&
    Number.isFinite(left.ino) &&
    Number.isFinite(right.dev) &&
    Number.isFinite(right.ino) &&
    left.dev === right.dev &&
    left.ino === right.ino
  ) {
    return 'strong';
  }

  if (
    typeof left.contentHash === 'string' &&
    typeof right.contentHash === 'string' &&
    left.contentHash &&
    left.contentHash === right.contentHash
  ) {
    return 'strong';
  }

  if (
    Number.isFinite(left.size) &&
    Number.isFinite(right.size) &&
    Number.isFinite(left.mtimeMs) &&
    Number.isFinite(right.mtimeMs) &&
    left.size === right.size &&
    areEquivalentMtimeMs(left.mtimeMs, right.mtimeMs)
  ) {
    return 'medium';
  }

  if (
    Number.isFinite(left.size) &&
    Number.isFinite(right.size) &&
    left.size === right.size
  ) {
    return 'weak';
  }

  return 'none';
}

function hasStrongFingerprintMatch(left, right) {
  return getFingerprintMatchConfidence(left, right) === 'strong';
}

function fingerprintsLikelyMatch(left, right) {
  const confidence = getFingerprintMatchConfidence(left, right);
  return confidence === 'strong' || confidence === 'medium';
}

module.exports = {
  computeFileContentHash,
  fingerprintFromStat,
  hasStrongFingerprintMatch,
  fingerprintsLikelyMatch,
  getFingerprintMatchConfidence,
  normalizeAbsolutePath,
  readFileFingerprint,
  areEquivalentMtimeMs,
};
