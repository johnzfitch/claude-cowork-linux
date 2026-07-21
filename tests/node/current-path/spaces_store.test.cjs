'use strict';

// Regression coverage for createSpaceFolder (issue #144 / PR #145).
//
// asar 1.14271.0 changed the "New Project" IPC contract from
// createSpaceFolder(spaceId, folderName) to (parentPath, folderName), which
// broke project creation entirely ("invalid spaceId"). This verifies the new
// contract AND the Linux-specific hardening: creation is confined to the home
// dir (no /tmp), folderName must be a single segment, collisions dedup, and a
// symlinked ancestor cannot redirect mkdir outside the allowed roots.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSpacesStore } = require('../../../stubs/cowork/spaces_store.js');

// The store rejects /tmp on purpose, so the fake home must live OUTSIDE /tmp.
// Root it under the real homedir and point the store's passwd-home override at
// it so requireAllowedPath confines to this temp tree.
function setup(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.homedir(), '.cowork-spaces-test-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    delete global.__coworkPasswdHomedir;
  });
  const tempHome = path.join(tempRoot, 'home');
  fs.mkdirSync(tempHome, { recursive: true });
  global.__coworkPasswdHomedir = tempHome;
  const store = createSpacesStore({
    localAgentRoot: path.join(tempHome, '.config', 'Claude', 'local-agent-mode-sessions'),
    isPathAllowed: () => true, // defer to the store's own home/realpath checks
    trace: () => {},
  });
  return { tempRoot, tempHome, store };
}

test('createSpaceFolder creates <parentPath>/<name> and returns the path', (t) => {
  const { tempHome, store } = setup(t);
  const parent = path.join(tempHome, 'Projects');
  fs.mkdirSync(parent, { recursive: true });

  const created = store.createSpaceFolder(null, parent, 'My Project');
  assert.equal(created, path.join(parent, 'My Project'));
  assert.ok(fs.existsSync(created) && fs.statSync(created).isDirectory());
});

test('createSpaceFolder dedups on collision (name, name (1), name (2))', (t) => {
  const { tempHome, store } = setup(t);
  const parent = path.join(tempHome, 'Projects');
  fs.mkdirSync(parent, { recursive: true });

  const a = store.createSpaceFolder(null, parent, 'Proj');
  const b = store.createSpaceFolder(null, parent, 'Proj');
  const c = store.createSpaceFolder(null, parent, 'Proj');
  assert.equal(a, path.join(parent, 'Proj'));
  assert.equal(b, path.join(parent, 'Proj (1)'));
  assert.equal(c, path.join(parent, 'Proj (2)'));
});

test('createSpaceFolder creates a not-yet-existing parent tree under home', (t) => {
  // Guards against the hardening over-rejecting: the nearest existing ancestor
  // (home) is real, so a brand-new Projects tree must still be created.
  const { tempHome, store } = setup(t);
  const parent = path.join(tempHome, 'brand', 'new', 'tree');
  const created = store.createSpaceFolder(null, parent, 'First');
  assert.equal(created, path.join(parent, 'First'));
  assert.ok(fs.existsSync(created));
});

test('createSpaceFolder rejects a parentPath in /tmp', (t) => {
  const { store } = setup(t);
  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-reject-'));
  t.after(() => fs.rmSync(tmpParent, { recursive: true, force: true }));
  assert.equal(store.createSpaceFolder(null, tmpParent, 'x'), null);
  assert.ok(!fs.existsSync(path.join(tmpParent, 'x')));
});

test('createSpaceFolder rejects a parentPath outside home (/etc)', (t) => {
  const { store } = setup(t);
  assert.equal(store.createSpaceFolder(null, '/etc', 'x'), null);
});

test('createSpaceFolder rejects folderName with separators / traversal / null byte', (t) => {
  const { tempHome, store } = setup(t);
  const parent = path.join(tempHome, 'Projects');
  fs.mkdirSync(parent, { recursive: true });
  for (const bad of ['../escape', 'a/b', '..', '.', 'has\0null', '']) {
    assert.equal(store.createSpaceFolder(null, parent, bad), null, 'should reject name: ' + JSON.stringify(bad));
  }
});

test('createSpaceFolder rejects a parentPath that escapes home via ..', (t) => {
  const { tempHome, store } = setup(t);
  // Lexically under home but ".."-escaping to the real home root.
  const escaping = path.join(tempHome, '..', '..', '..', 'etc');
  assert.equal(store.createSpaceFolder(null, escaping, 'x'), null);
});

test('createSpaceFolder rejects a relative parentPath', (t) => {
  const { store } = setup(t);
  assert.equal(store.createSpaceFolder(null, 'relative/dir', 'x'), null);
});

test('createSpaceFolder rejects a symlinked ancestor that escapes home (no mkdir at target)', (t) => {
  // The core hardening over PR #145's lexical-only check: parentPath is
  // lexically under home, but an ancestor symlink resolves outside it.
  const { tempHome, store } = setup(t);
  // Writable escape target outside home so that WITHOUT the realpath defense
  // the recursive mkdir would succeed there — making this test fail loudly if
  // the symlink defense regresses.
  const escapeTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-escape-'));
  t.after(() => fs.rmSync(escapeTarget, { recursive: true, force: true }));
  const evil = path.join(tempHome, 'evil'); // ~/evil -> /tmp/spaces-escape-XXXX
  fs.symlinkSync(escapeTarget, evil);

  const result = store.createSpaceFolder(null, evil, 'pwned');
  assert.equal(result, null, 'symlinked-ancestor escape must be rejected');
  assert.ok(!fs.existsSync(path.join(escapeTarget, 'pwned')), 'nothing may be created at the escape target');
});

// ── Live onSpaceEvent emission ───────────────────────────────────────────────
// Regression for "CoWork projects don't refresh until the desktop app is
// restarted". Mutations persisted to spaces.json but the renderer was never
// notified, so create/archive/delete/add-folder only appeared after a relaunch
// (which re-runs getAllSpaces()). The store now calls an injected `emit` with
// the shape the renderer's onSpaceEvent handler consumes:
//   { type: 'created'|'updated'|'deleted', space }
function setupWithEvents(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.homedir(), '.cowork-spaces-ev-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    delete global.__coworkPasswdHomedir;
  });
  const tempHome = path.join(tempRoot, 'home');
  fs.mkdirSync(tempHome, { recursive: true });
  global.__coworkPasswdHomedir = tempHome;
  // discoverSpacesPath() writes under <localAgentRoot>/<account>/<org>/; the
  // dirs must exist for writeSpaces() to resolve a path (createSpaceFolder,
  // which the other tests use, never touches spaces.json so it didn't need it).
  const localAgentRoot = path.join(tempHome, '.config', 'Claude', 'local-agent-mode-sessions');
  fs.mkdirSync(path.join(localAgentRoot, 'account-1', 'org-1'), { recursive: true });
  const events = [];
  const store = createSpacesStore({
    localAgentRoot,
    isPathAllowed: () => true,
    trace: () => {},
    emit: (e) => events.push(e),
  });
  return { tempHome, store, events };
}

test('createSpace emits a "created" event with the new space', (t) => {
  const { store, events } = setupWithEvents(t);
  const space = store.createSpace(null, { name: 'Alpha' });
  assert.ok(space && space.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'created');
  assert.equal(events[0].space.id, space.id);
  assert.equal(events[0].space.name, 'Alpha');
});

test('updateSpace emits "updated"; a miss emits nothing', (t) => {
  const { store, events } = setupWithEvents(t);
  const space = store.createSpace(null, { name: 'Alpha' });
  events.length = 0;
  const updated = store.updateSpace(null, space.id, { name: 'Beta' });
  assert.equal(updated.name, 'Beta');
  assert.deepEqual(events.map(e => e.type), ['updated']);
  assert.equal(events[0].space.name, 'Beta');
  events.length = 0;
  assert.equal(store.updateSpace(null, 'no-such-id', { name: 'X' }), null);
  assert.equal(events.length, 0);
});

test('deleteSpace emits "deleted" carrying the id; a miss emits nothing', (t) => {
  const { store, events } = setupWithEvents(t);
  const space = store.createSpace(null, { name: 'Alpha' });
  events.length = 0;
  assert.equal(store.deleteSpace(null, space.id), true);
  assert.deepEqual(events.map(e => e.type), ['deleted']);
  assert.equal(events[0].space.id, space.id);
  events.length = 0;
  assert.equal(store.deleteSpace(null, 'no-such-id'), false);
  assert.equal(events.length, 0);
});

test('addFolderToSpace emits "updated" with the folder; a blocked path emits nothing', (t) => {
  const { tempHome, store, events } = setupWithEvents(t);
  const space = store.createSpace(null, { name: 'Alpha' });
  const folder = path.join(tempHome, 'work');
  fs.mkdirSync(folder, { recursive: true });
  events.length = 0;
  assert.ok(store.addFolderToSpace(null, space.id, folder));
  assert.deepEqual(events.map(e => e.type), ['updated']);
  assert.ok(events[0].space.folders.some(f => f.path === fs.realpathSync(folder)));
  // Outside-home folder is rejected before any write — must not emit.
  events.length = 0;
  assert.equal(store.addFolderToSpace(null, space.id, '/etc'), null);
  assert.equal(events.length, 0);
});

test('a throwing emit transport never fails or loses the mutation', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.homedir(), '.cowork-spaces-ev2-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    delete global.__coworkPasswdHomedir;
  });
  const tempHome = path.join(tempRoot, 'home');
  fs.mkdirSync(tempHome, { recursive: true });
  global.__coworkPasswdHomedir = tempHome;
  const localAgentRoot = path.join(tempHome, '.config', 'Claude', 'local-agent-mode-sessions');
  fs.mkdirSync(path.join(localAgentRoot, 'account-1', 'org-1'), { recursive: true });
  const store = createSpacesStore({
    localAgentRoot,
    isPathAllowed: () => true,
    trace: () => {},
    emit: () => { throw new Error('renderer gone'); },
  });
  const space = store.createSpace(null, { name: 'Alpha' });
  assert.ok(space && space.id, 'mutation must persist even when emit throws');
  assert.equal(store.getSpace(null, space.id).name, 'Alpha');
});

// ── File-op contract: asar 1.22209.x switched (path) -> (spaceId, path) ───────
// The renderer now prepends a spaceId, moving the real path to argument 1.
// The stub must accept BOTH shapes (new build + rollback) or folder browsing
// and file reads silently return empty (BLOCKED on the UUID-as-path).
test('listFolderContents/readFileContents accept both (spaceId, path) and (path)', (t) => {
  const { tempHome, store } = setupWithEvents(t);
  const space = store.createSpace(null, { name: 'S' });
  const folder = path.join(tempHome, 'proj');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'a.txt'), 'hello');
  store.addFolderToSpace(null, space.id, folder);
  const rf = fs.realpathSync(folder);
  const file = path.join(rf, 'a.txt');

  // New (spaceId, path)
  assert.ok(store.listFolderContents(null, space.id, rf).some(e => e.name === 'a.txt'),
    'new (spaceId, path) must list contents');
  assert.equal(store.readFileContents(null, space.id, file), 'hello',
    'new (spaceId, path) must read file');

  // Old (path) — rollback safety
  assert.ok(store.listFolderContents(null, rf).some(e => e.name === 'a.txt'),
    'old (path) must still list contents');
  assert.equal(store.readFileContents(null, file), 'hello',
    'old (path) must still read file');

  // spaceId alone (no path arg) is not a path -> rejected, no crash
  assert.deepEqual(store.listFolderContents(null, space.id), []);
});
