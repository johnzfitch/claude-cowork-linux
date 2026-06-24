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
