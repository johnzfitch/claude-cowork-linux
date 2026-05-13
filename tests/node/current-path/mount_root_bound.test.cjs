'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { isMountRootTooBroad } = require('../../../stubs/cowork/mount_root_bound.js');

describe('mount root bound', () => {
  test('refuses hostPath === homedir (empty relativePath case)', () => {
    // createMountSymlinks sets hostPath = _homedir when relativePath === ''.
    // The predicate must catch that.
    assert.equal(isMountRootTooBroad('/home/alice', '/home/alice'), true);
  });

  test("refuses '/' as a mount target", () => {
    assert.equal(isMountRootTooBroad('/', '/home/alice'), true);
  });

  test('refuses two-segment paths like /home/user, /var/tmp, /opt/foo', () => {
    assert.equal(isMountRootTooBroad('/home/alice', '/root'), true);
    assert.equal(isMountRootTooBroad('/var/tmp', '/root'), true);
    assert.equal(isMountRootTooBroad('/opt/foo', '/root'), true);
  });

  test('refuses single-segment paths like /usr, /etc', () => {
    assert.equal(isMountRootTooBroad('/usr', '/root'), true);
    assert.equal(isMountRootTooBroad('/etc', '/root'), true);
  });

  test('accepts three-segment paths like /home/user/project', () => {
    assert.equal(isMountRootTooBroad('/home/alice/project', '/root'), false);
    assert.equal(isMountRootTooBroad('/opt/foo/bar', '/root'), false);
  });

  test('accepts deeper paths', () => {
    assert.equal(isMountRootTooBroad('/home/alice/projects/myapp/src', '/root'), false);
  });

  test('refuses null/undefined/empty string', () => {
    assert.equal(isMountRootTooBroad('', '/home/alice'), true);
    assert.equal(isMountRootTooBroad(null, '/home/alice'), true);
    assert.equal(isMountRootTooBroad(undefined, '/home/alice'), true);
  });

  test('symlink that resolves to a shallow path is refused (realpath catches escape)', () => {
    if (!fs.existsSync('/home')) return; // pragmatically skip in minimal containers
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-bound-test-'));
    const linkPath = path.join(tmpDir, 'shallow-link');
    try {
      fs.symlinkSync('/home', linkPath);
      // linkPath itself has many segments (/tmp/.../shallow-link) but realpath
      // resolves to /home (1 segment), which is shallower than 3. Refuse.
      assert.equal(isMountRootTooBroad(linkPath, '/root'), true);
    } finally {
      try { fs.unlinkSync(linkPath); } catch (_) {}
      try { fs.rmdirSync(tmpDir); } catch (_) {}
    }
  });

  test('non-existent 3+ segment path is accepted (lexical fallback)', () => {
    // realpath throws ENOENT; predicate falls back to path.resolve and counts
    // segments lexically. A 3-segment-deep planned mount root is fine.
    assert.equal(isMountRootTooBroad('/home/alice/not-yet-created', '/root'), false);
  });

  test('non-existent shallow path is still refused (lexical fallback)', () => {
    assert.equal(isMountRootTooBroad('/var/missing', '/root'), true);
  });
});
