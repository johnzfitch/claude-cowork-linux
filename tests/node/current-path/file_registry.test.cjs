const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createDirs,
  getSessionFileRegistryPath,
} = require('../../../stubs/cowork/dirs.js');
const {
  createFileRegistry,
} = require('../../../stubs/cowork/file_registry.js');
const {
  createFileWatchManager,
} = require('../../../stubs/cowork/file_watch_manager.js');

function createTempHome(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-file-registry-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

function createRegistry(homeDir, options) {
  const dirs = createDirs({ env: {}, homeDir });
  const watchManager = createFileWatchManager({
    dirs,
    now: () => '2026-03-14T12:00:00.000Z',
  });
  const registry = createFileRegistry({
    dirs,
    idFactory: () => 'file_fixed',
    now: () => '2026-03-14T12:00:00.000Z',
    watchManager,
    ...(options || {}),
  });
  return {
    dirs,
    registry,
    watchManager,
  };
}

test('resolvePath tracks exact current path hits in the per-session registry', (t) => {
  const homeDir = createTempHome(t);
  const { dirs, registry } = createRegistry(homeDir);
  const workspaceRoot = path.join(homeDir, 'workspace');
  const filePath = path.join(workspaceRoot, 'note.txt');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(filePath, 'hello\n', 'utf8');

  const result = registry.resolvePath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: filePath,
  });

  assert.equal(result.resolution, 'exact');
  assert.equal(result.resolvedPath, filePath);
  assert.equal(result.entry.fileId, 'file_fixed');
  assert.equal(fs.existsSync(getSessionFileRegistryPath(dirs, 'local_demo')), true);
});

test('resolvePath recovers moved files within authorized roots by fingerprint scan', (t) => {
  const homeDir = createTempHome(t);
  const { registry } = createRegistry(homeDir);
  const workspaceRoot = path.join(homeDir, 'workspace');
  const sourceDir = path.join(workspaceRoot, 'src');
  const destinationDir = path.join(workspaceRoot, 'renamed');
  const originalPath = path.join(sourceDir, 'note.txt');
  const movedPath = path.join(destinationDir, 'note.txt');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.writeFileSync(originalPath, 'hello\n', 'utf8');

  registry.trackPath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: originalPath,
  });

  fs.renameSync(originalPath, movedPath);

  const result = registry.resolvePath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: originalPath,
  });

  assert.equal(result.resolution, 'recovered');
  assert.equal(result.resolvedPath, movedPath);
  assert.equal(result.entry.currentPath, movedPath);
  assert.equal(result.entry.status, 'relinked');
});

test('trackPath does not collapse two distinct files that share size and mtime', (t) => {
  const homeDir = createTempHome(t);
  let idCounter = 0;
  const { registry } = createRegistry(homeDir, {
    idFactory: () => 'file_' + (++idCounter),
  });
  const workspaceRoot = path.join(homeDir, 'workspace');
  const firstPath = path.join(workspaceRoot, 'first.txt');
  const secondPath = path.join(workspaceRoot, 'second.txt');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(firstPath, 'same\n', 'utf8');
  fs.writeFileSync(secondPath, 'same\n', 'utf8');

  const sharedTime = new Date('2026-03-14T12:00:00.000Z');
  fs.utimesSync(firstPath, sharedTime, sharedTime);
  fs.utimesSync(secondPath, sharedTime, sharedTime);

  const firstEntry = registry.trackPath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: firstPath,
  });
  const secondEntry = registry.trackPath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: secondPath,
  });

  assert.equal(firstEntry.fileId, 'file_1');
  assert.equal(secondEntry.fileId, 'file_2');
  assert.equal(registry.listEntries('local_demo').length, 2);
});

test('resolvePath uses watcher evidence first for renamed files inside authorized roots', (t) => {
  const homeDir = createTempHome(t);
  const { registry, watchManager } = createRegistry(homeDir);
  const workspaceRoot = path.join(homeDir, 'workspace');
  const originalPath = path.join(workspaceRoot, 'before.txt');
  const renamedPath = path.join(workspaceRoot, 'after.txt');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(originalPath, 'hello\n', 'utf8');

  registry.trackPath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: originalPath,
  });

  fs.renameSync(originalPath, renamedPath);
  watchManager.recordPathUpdate({
    authorizedRoots: [workspaceRoot],
    fromPath: originalPath,
    localSessionId: 'local_demo',
    toPath: renamedPath,
  });

  const result = registry.resolvePath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: originalPath,
  });

  assert.equal(result.resolution, 'watcher');
  assert.equal(result.resolvedPath, renamedPath);
});

test('resolvePath marks deleted files missing when no safe recovery candidate exists', (t) => {
  const homeDir = createTempHome(t);
  const { registry } = createRegistry(homeDir);
  const workspaceRoot = path.join(homeDir, 'workspace');
  const filePath = path.join(workspaceRoot, 'deleted.txt');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(filePath, 'gone\n', 'utf8');

  registry.trackPath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: filePath,
  });

  fs.unlinkSync(filePath);

  const result = registry.resolvePath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: filePath,
  });

  assert.equal(result.resolution, 'missing');
  assert.equal(result.relinkRequired, true);
  assert.equal(result.entry.status, 'missing');
});

test('missing tracked file can be explicitly relinked on the same fileId and then resolves from the registry', (t) => {
  const homeDir = createTempHome(t);
  const { registry } = createRegistry(homeDir);
  const workspaceRoot = path.join(homeDir, 'workspace');
  const originalPath = path.join(workspaceRoot, 'src', 'note.txt');
  const relinkedPath = path.join(workspaceRoot, 'dst', 'note.txt');
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.mkdirSync(path.dirname(relinkedPath), { recursive: true });
  fs.writeFileSync(originalPath, 'hello\n', 'utf8');

  const trackedEntry = registry.trackPath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: originalPath,
  });
  fs.unlinkSync(originalPath);

  const missingResolution = registry.resolvePath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: originalPath,
  });
  fs.writeFileSync(relinkedPath, 'hello\n', 'utf8');

  const relinkResolution = registry.relinkFile({
    authorizedRoots: [workspaceRoot],
    fileId: missingResolution.fileId,
    localSessionId: 'local_demo',
    provenance: {
      linked_by: 'manual-test',
    },
    reason: 'manual_relink',
    targetPath: relinkedPath,
  });

  const resolvedAgain = registry.resolvePath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: originalPath,
  });

  assert.equal(missingResolution.resolution, 'missing');
  assert.equal(missingResolution.fileId, trackedEntry.fileId);
  assert.equal(relinkResolution.resolution, 'relinked');
  assert.equal(relinkResolution.fileId, trackedEntry.fileId);
  assert.equal(relinkResolution.entry.currentPath, relinkedPath);
  assert.equal(resolvedAgain.resolution, 'registry');
  assert.equal(resolvedAgain.fileId, trackedEntry.fileId);
  assert.equal(resolvedAgain.resolvedPath, relinkedPath);
});

test('explicit relink is rejected outside authorized roots', (t) => {
  const homeDir = createTempHome(t);
  const { registry } = createRegistry(homeDir);
  const workspaceRoot = path.join(homeDir, 'workspace');
  const otherRoot = path.join(homeDir, 'other');
  const originalPath = path.join(workspaceRoot, 'src', 'note.txt');
  const outsidePath = path.join(otherRoot, 'dst', 'note.txt');
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
  fs.writeFileSync(originalPath, 'hello\n', 'utf8');
  fs.writeFileSync(outsidePath, 'hello\n', 'utf8');

  const trackedEntry = registry.trackPath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: originalPath,
  });

  const relinkResolution = registry.relinkFile({
    authorizedRoots: [workspaceRoot],
    fileId: trackedEntry.fileId,
    localSessionId: 'local_demo',
    reason: 'manual_relink',
    targetPath: outsidePath,
  });

  assert.equal(relinkResolution.resolution, 'unauthorized');
  assert.equal(relinkResolution.authorized, false);
  assert.equal(relinkResolution.fileId, trackedEntry.fileId);
  assert.equal(relinkResolution.relinkRequired, true);
});

test('explicit relink is rejected when the fileId belongs to another session', (t) => {
  const homeDir = createTempHome(t);
  const { registry } = createRegistry(homeDir);
  const workspaceRoot = path.join(homeDir, 'workspace');
  const originalPath = path.join(workspaceRoot, 'src', 'note.txt');
  const relinkedPath = path.join(workspaceRoot, 'dst', 'note.txt');
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.mkdirSync(path.dirname(relinkedPath), { recursive: true });
  fs.writeFileSync(originalPath, 'hello\n', 'utf8');
  fs.writeFileSync(relinkedPath, 'hello\n', 'utf8');

  const trackedEntry = registry.trackPath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_one',
    targetPath: originalPath,
  });

  const relinkResolution = registry.relinkFile({
    authorizedRoots: [workspaceRoot],
    fileId: trackedEntry.fileId,
    localSessionId: 'local_two',
    reason: 'manual_relink',
    targetPath: relinkedPath,
  });

  assert.equal(relinkResolution.resolution, 'not_found');
  assert.equal(relinkResolution.authorized, false);
  assert.equal(relinkResolution.fileId, null);
});

test('explicit relink updates currentPath and appends history while preserving provenance', (t) => {
  const homeDir = createTempHome(t);
  const { registry } = createRegistry(homeDir);
  const workspaceRoot = path.join(homeDir, 'workspace');
  const originalPath = path.join(workspaceRoot, 'src', 'note.txt');
  const relinkedPath = path.join(workspaceRoot, 'dst', 'note.txt');
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.mkdirSync(path.dirname(relinkedPath), { recursive: true });
  fs.writeFileSync(originalPath, 'hello\n', 'utf8');
  fs.writeFileSync(relinkedPath, 'hello\n', 'utf8');

  const trackedEntry = registry.trackPath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    provenance: {
      created_by: 'seed-test',
      linked_by: 'seed-test',
    },
    targetPath: originalPath,
  });

  const relinkResolution = registry.relinkFile({
    authorizedRoots: [workspaceRoot],
    fileId: trackedEntry.fileId,
    localSessionId: 'local_demo',
    provenance: {
      linked_by: 'manual-test',
    },
    reason: 'manual_relink',
    targetPath: relinkedPath,
  });

  const latestEntry = registry.getEntryByFileId('local_demo', trackedEntry.fileId);

  assert.equal(relinkResolution.entry.currentPath, relinkedPath);
  assert.equal(latestEntry.currentPath, relinkedPath);
  assert.equal(latestEntry.history[latestEntry.history.length - 1].path, relinkedPath);
  assert.equal(latestEntry.history[latestEntry.history.length - 1].reason, 'manual_relink');
  assert.equal(latestEntry.provenance.created_by, 'seed-test');
  assert.equal(latestEntry.provenance.linked_by, 'manual-test');
});

test('resolvePath reports ambiguous recovery instead of guessing between candidates', (t) => {
  const homeDir = createTempHome(t);
  const { registry } = createRegistry(homeDir);
  const workspaceRoot = path.join(homeDir, 'workspace');
  const originalDir = path.join(workspaceRoot, 'a');
  const candidateOneDir = path.join(workspaceRoot, 'b');
  const candidateTwoDir = path.join(workspaceRoot, 'c');
  const originalPath = path.join(originalDir, 'note.txt');
  const candidateOnePath = path.join(candidateOneDir, 'note.txt');
  const candidateTwoPath = path.join(candidateTwoDir, 'note.txt');
  fs.mkdirSync(originalDir, { recursive: true });
  fs.mkdirSync(candidateOneDir, { recursive: true });
  fs.mkdirSync(candidateTwoDir, { recursive: true });
  fs.writeFileSync(originalPath, 'same\n', 'utf8');

  registry.trackPath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: originalPath,
  });

  fs.linkSync(originalPath, candidateOnePath);
  fs.linkSync(originalPath, candidateTwoPath);
  fs.unlinkSync(originalPath);

  const result = registry.resolvePath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: originalPath,
  });

  assert.equal(result.resolution, 'ambiguous');
  assert.equal(result.relinkRequired, true);
});

test('resolvePath rejects recovery outside the session authorized roots', (t) => {
  const homeDir = createTempHome(t);
  const { registry } = createRegistry(homeDir);
  const workspaceRoot = path.join(homeDir, 'workspace');
  const otherRoot = path.join(homeDir, 'other');
  const filePath = path.join(workspaceRoot, 'note.txt');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(otherRoot, { recursive: true });
  fs.writeFileSync(filePath, 'hello\n', 'utf8');

  registry.trackPath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: filePath,
  });

  fs.unlinkSync(filePath);

  const result = registry.resolvePath({
    authorizedRoots: [otherRoot],
    localSessionId: 'local_demo',
    targetPath: filePath,
  });

  assert.equal(result.resolution, 'unauthorized');
  assert.equal(result.relinkRequired, true);
});

test('resolvePath rejects exact existing paths outside authorized roots', (t) => {
  const homeDir = createTempHome(t);
  const { registry } = createRegistry(homeDir);
  const workspaceRoot = path.join(homeDir, 'workspace');
  const otherRoot = path.join(homeDir, 'other');
  const filePath = path.join(otherRoot, 'secret.txt');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(otherRoot, { recursive: true });
  fs.writeFileSync(filePath, 'secret\n', 'utf8');

  const result = registry.resolvePath({
    authorizedRoots: [workspaceRoot],
    localSessionId: 'local_demo',
    targetPath: filePath,
  });

  assert.equal(result.resolution, 'unauthorized');
  assert.equal(result.authorized, false);
});
