const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  computeFileContentHash,
  hasStrongFingerprintMatch,
  fingerprintsLikelyMatch,
  getFingerprintMatchConfidence,
  normalizeAbsolutePath,
  readFileFingerprint,
} = require('../../../stubs/cowork/file_identity.js');

function createTempDir(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-file-identity-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

test('normalizeAbsolutePath resolves only absolute paths', () => {
  assert.equal(normalizeAbsolutePath('/tmp/demo'), path.resolve('/tmp/demo'));
  assert.equal(normalizeAbsolutePath('relative/demo'), null);
  assert.equal(normalizeAbsolutePath(''), null);
});

test('readFileFingerprint captures stable stat-based identity', (t) => {
  const tempRoot = createTempDir(t);
  const filePath = path.join(tempRoot, 'note.txt');
  fs.writeFileSync(filePath, 'hello\n', 'utf8');

  const fingerprint = readFileFingerprint(filePath);
  assert.equal(typeof fingerprint.dev, 'number');
  assert.equal(typeof fingerprint.ino, 'number');
  assert.equal(fingerprint.size, 6);
});

test('getFingerprintMatchConfidence prefers inode matches and falls back to metadata', (t) => {
  const tempRoot = createTempDir(t);
  const sourcePath = path.join(tempRoot, 'source.txt');
  const copyPath = path.join(tempRoot, 'copy.txt');
  fs.writeFileSync(sourcePath, 'same\n', 'utf8');
  fs.copyFileSync(sourcePath, copyPath);

  const sourceFingerprint = readFileFingerprint(sourcePath);
  const renamedPath = path.join(tempRoot, 'renamed.txt');
  fs.renameSync(sourcePath, renamedPath);
  const renamedFingerprint = readFileFingerprint(renamedPath);
  const copyFingerprint = readFileFingerprint(copyPath);

  assert.equal(getFingerprintMatchConfidence(sourceFingerprint, renamedFingerprint), 'strong');
  assert.equal(getFingerprintMatchConfidence(renamedFingerprint, copyFingerprint), 'medium');
  assert.equal(hasStrongFingerprintMatch(renamedFingerprint, copyFingerprint), false);
  assert.equal(fingerprintsLikelyMatch(renamedFingerprint, copyFingerprint), true);
});

test('computeFileContentHash is available for ambiguity resolution', (t) => {
  const tempRoot = createTempDir(t);
  const filePath = path.join(tempRoot, 'hash.txt');
  fs.writeFileSync(filePath, 'hash-me\n', 'utf8');

  const digest = computeFileContentHash(filePath);
  assert.match(digest, /^[a-f0-9]{64}$/);
});
