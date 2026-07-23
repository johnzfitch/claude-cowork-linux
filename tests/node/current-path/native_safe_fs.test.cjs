'use strict';

// Coverage for the Linux @ant/claude-native "safe-fs containment" API added
// for asar 1.22209.x (openRootDir + *Beneath). Verifies the round-trip works
// (delegating byte I/O to Node FileHandles) and that containment is fail-closed
// against separator / '..' / symlink escapes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const safeFs = require('../../../stubs/@ant/claude-native/safe_fs.js');

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safefs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

test('openRootDir returns a canonical handle; rejects missing dir and files', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);
  assert.equal(h.__safeRoot, root);
  assert.equal(typeof h.close, 'function');
  await h.close();

  await assert.rejects(() => safeFs.openRootDir(path.join(root, 'nope')));
  const f = path.join(root, 'file');
  fs.writeFileSync(f, 'x');
  await assert.rejects(() => safeFs.openRootDir(f), /not a directory/);
  await assert.rejects(() => safeFs.openRootDir('relative/path'));
});

test('mkdir/open/write/read/rename/unlink round-trip beneath the root', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);

  await safeFs.mkdirBeneath(h, ['sub'], { recursive: true });
  assert.ok(fs.statSync(path.join(root, 'sub')).isDirectory());

  // openBeneath returns a Node FileHandle: write then read with the exact
  // (buffer, offset, length, position) signature the caller uses.
  const fh = await safeFs.openBeneath(h, ['sub', 'a.txt'], 'w+', 0o600);
  await fh.write(Buffer.from('hello world'), 0, 11, 0);
  const buf = Buffer.alloc(11);
  await fh.read(buf, 0, 11, 0);
  assert.equal(buf.toString('utf8'), 'hello world');
  const st = await fh.stat();
  assert.equal(st.size, 11);
  await fh.close();

  await safeFs.renameBeneath(h, ['sub', 'a.txt'], ['sub', 'b.txt']);
  assert.ok(fs.existsSync(path.join(root, 'sub', 'b.txt')));
  assert.ok(!fs.existsSync(path.join(root, 'sub', 'a.txt')));

  await safeFs.unlinkBeneath(h, ['sub', 'b.txt']);
  assert.ok(!fs.existsSync(path.join(root, 'sub', 'b.txt')));
});

test('containment is fail-closed: separators, dotdot, and symlink escape are denied', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);

  const denied = (p) => assert.rejects(p, (e) => e.code === 'EACCES');

  await denied(() => safeFs.mkdirBeneath(h, ['..'], {}));
  await denied(() => safeFs.mkdirBeneath(h, ['a/b'], {}));           // embedded separator
  await denied(() => safeFs.openBeneath(h, ['..', 'etc'], 'r'));
  await denied(() => safeFs.unlinkBeneath(h, ['\0evil']));

  // A missing handle is rejected too.
  await denied(() => safeFs.mkdirBeneath(null, ['x'], {}));

  // Symlink escape: root/link -> outside; writing beneath it must be denied.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'safefs-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, 'link'));
  await denied(() => safeFs.openBeneath(h, ['link', 'pwned'], 'w'));
  assert.ok(!fs.existsSync(path.join(outside, 'pwned')), 'nothing may be written outside the root');
});
