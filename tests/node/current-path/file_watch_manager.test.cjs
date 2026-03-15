const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createDirs,
} = require('../../../stubs/cowork/dirs.js');
const {
  createFileWatchManager,
  isPathWithinRoots,
  normalizeAuthorizedRoots,
} = require('../../../stubs/cowork/file_watch_manager.js');

function createTempHome(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-file-watch-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

test('normalizeAuthorizedRoots deduplicates absolute roots', () => {
  assert.deepEqual(normalizeAuthorizedRoots([
    '/tmp/demo',
    '/tmp/demo',
    'relative',
  ]), [path.resolve('/tmp/demo')]);
});

test('isPathWithinRoots enforces bounded recovery roots', () => {
  assert.equal(isPathWithinRoots('/tmp/demo/file.txt', ['/tmp/demo']), true);
  assert.equal(isPathWithinRoots('/tmp/other/file.txt', ['/tmp/demo']), false);
});

test('recordPathUpdate persists watcher evidence and resolveCandidatePath replays it', (t) => {
  const homeDir = createTempHome(t);
  const dirs = createDirs({ env: {}, homeDir });
  const manager = createFileWatchManager({
    dirs,
    now: () => '2026-03-14T12:00:00.000Z',
  });

  const workspaceRoot = path.join(homeDir, 'workspace');
  const oldPath = path.join(workspaceRoot, 'notes-old.txt');
  const newPath = path.join(workspaceRoot, 'notes-new.txt');
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const result = manager.recordPathUpdate({
    authorizedRoots: [workspaceRoot],
    fromPath: oldPath,
    localSessionId: 'local_demo',
    toPath: newPath,
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(result.watchStatePath), true);
  assert.deepEqual(manager.resolveCandidatePath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: oldPath,
  }), {
    detectedAt: '2026-03-14T12:00:00.000Z',
    evidence: 'watcher',
    fromPath: oldPath,
    toPath: newPath,
  });
});

test('recordPathUpdate rejects watcher evidence outside authorized roots', (t) => {
  const homeDir = createTempHome(t);
  const dirs = createDirs({ env: {}, homeDir });
  const manager = createFileWatchManager({ dirs });

  const result = manager.recordPathUpdate({
    authorizedRoots: [path.join(homeDir, 'workspace')],
    fromPath: path.join(homeDir, 'workspace', 'allowed.txt'),
    localSessionId: 'local_demo',
    toPath: path.join(homeDir, 'other', 'blocked.txt'),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /authorized roots/);
});
