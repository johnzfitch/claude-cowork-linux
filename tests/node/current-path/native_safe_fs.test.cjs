'use strict';

// Coverage for the Linux @ant/claude-native "safe-fs containment" API added
// for asar 1.22209.x (openRootDir + *Beneath). Verifies the round-trip works
// (openBeneath hands back a raw numeric fd, as the macOS native module does)
// and that containment is fail-closed against separator / '..' / symlink escapes.

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

  // openBeneath returns a raw numeric fd: write then read it back through the
  // node:fs descriptor API, the way the caller does.
  const fd = await safeFs.openBeneath(h, ['sub', 'a.txt'], 'w+', 0o600);
  fs.writeSync(fd, Buffer.from('hello world'), 0, 11, 0);
  const buf = Buffer.alloc(11);
  fs.readSync(fd, buf, 0, 11, 0);
  assert.equal(buf.toString('utf8'), 'hello world');
  assert.equal(fs.fstatSync(fd).size, 11);
  fs.closeSync(fd);

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
// Regression: a DANGLING symlink at the final component escaped the root.
// existsSync() is false for a broken link, so the nearest-existing-ancestor
// realpath walk skipped past it to the legitimate parent and the check passed —
// then open('w') followed the link and created the file at its target outside
// the root. O_NOFOLLOW on the final component closes it.
test('a dangling symlink at the final component cannot escape the root', async (t) => {
  const root = tmpRoot(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'safefs-dangle-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const h = await safeFs.openRootDir(root);

  // root/dangle -> outside/pwned, which does NOT exist yet.
  fs.symlinkSync(path.join(outside, 'pwned'), path.join(root, 'dangle'));
  await assert.rejects(() => safeFs.openBeneath(h, ['dangle'], 'w'), (e) => e.code === 'EACCES');
  assert.ok(!fs.existsSync(path.join(outside, 'pwned')),
    'a write through a dangling symlink must not create a file outside the root');

  // Same for the read-write and append creation modes.
  for (const flag of ['w+', 'a', 'a+']) {
    await assert.rejects(() => safeFs.openBeneath(h, ['dangle'], flag), (e) => e.code === 'EACCES');
  }
  assert.ok(!fs.existsSync(path.join(outside, 'pwned')), 'still nothing outside the root');
});
// Native RESOLVE_BENEATH permits symlinks that stay inside the root, so a
// link to a sibling file beneath the root must keep working.
test('a symlink that stays inside the root is still usable', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);

  fs.writeFileSync(path.join(root, 'real.txt'), 'inside');
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));

  const fd = await safeFs.openBeneath(h, ['alias.txt'], 'r');
  const buf = Buffer.alloc(6);
  fs.readSync(fd, buf, 0, 6, 0);
  fs.closeSync(fd);
  assert.equal(buf.toString('utf8'), 'inside');
});
test('unsupported open flags are rejected rather than opened without O_NOFOLLOW', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);
  await assert.rejects(() => safeFs.openBeneath(h, ['x.txt'], 'bogus'), (e) => e.code === 'EACCES');
  // Numeric flags pass through (the caller may hand us raw O_* bits).
  const fd = await safeFs.openBeneath(h, ['n.txt'], fs.constants.O_CREAT | fs.constants.O_RDWR);
  fs.closeSync(fd);
  assert.ok(fs.existsSync(path.join(root, 'n.txt')));
});
// Regression: Claude Desktop's main bundle treats openBeneath's return value as
// a NUMERIC file descriptor. Its file wrapper hands that value straight to the
// node:fs *callback* APIs — fs.write(fd, buf, off, len, pos, cb), fs.read,
// fs.fstat, fs.fsync, fs.ftruncate, fs.fchmod — all of which validate fd as an
// int32. Returning an fs.promises FileHandle there throws
//   TypeError [ERR_INVALID_ARG_TYPE]: The "fd" argument must be of type number.
// Observed 2026-09-05: every bridge file transfer failed with
//   [remote-file] commit: file failed (errno=ERR_INVALID_ARG_TYPE)
//   [remote-file] committed 0 files, 1 rejected
// while bash execution (which does not go through this path) kept working.
// The macOS native module returns a raw fd; the Linux stub must match it.
test('openBeneath returns a numeric fd usable with the node:fs callback API', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);

  const fd = await safeFs.openBeneath(h, ['app.txt'], 'w+', 0o600);
  assert.equal(typeof fd, 'number', 'callers hand this straight to fs.write(fd, ...)');

  try {
    const payload = Buffer.from('hello world');
    const written = await new Promise((res, rej) =>
      fs.write(fd, payload, 0, payload.byteLength, null, (e, n) => (e ? rej(e) : res(n))));
    assert.equal(written, 11);

    const buf = Buffer.alloc(11);
    await new Promise((res, rej) =>
      fs.read(fd, buf, 0, 11, 0, (e, n) => (e ? rej(e) : res(n))));
    assert.equal(buf.toString('utf8'), 'hello world');

    const st = await new Promise((res, rej) =>
      fs.fstat(fd, (e, s) => (e ? rej(e) : res(s))));
    assert.equal(st.size, 11);

    await new Promise((res, rej) => fs.fsync(fd, (e) => (e ? rej(e) : res())));
  } finally {
    fs.closeSync(fd);
  }
});
// The ELOOP retry branch (a symlink that legitimately stays inside the root)
// re-opens the realpath and must return a raw fd on that path too.
test('the in-root symlink retry branch also returns a numeric fd', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);

  fs.writeFileSync(path.join(root, 'real.txt'), 'inside');
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));

  const fd = await safeFs.openBeneath(h, ['alias.txt'], 'r');
  assert.equal(typeof fd, 'number');
  try {
    const buf = Buffer.alloc(6);
    await new Promise((res, rej) =>
      fs.read(fd, buf, 0, 6, 0, (e, n) => (e ? rej(e) : res(n))));
    assert.equal(buf.toString('utf8'), 'inside');
  } finally {
    fs.closeSync(fd);
  }
});
test('an explicit mode argument still wins over the derived default', async (t) => {
  const root = tmpRoot(t);
  fs.chmodSync(root, 0o775);
  const h = await safeFs.openRootDir(root);
  const fd = await safeFs.openBeneath(h, ['explicit.txt'], 'w', 0o640);
  fs.closeSync(fd);
  assert.equal((fs.statSync(path.join(root, 'explicit.txt')).mode & 0o777).toString(8), '640');
});
test('overwriting an existing file leaves its permissions alone', async (t) => {
  const root = tmpRoot(t);
  fs.chmodSync(root, 0o700);
  const target = path.join(root, 'keep.txt');
  fs.writeFileSync(target, 'old');
  fs.chmodSync(target, 0o664);

  const h = await safeFs.openRootDir(root);
  const fd = await safeFs.openBeneath(h, ['keep.txt'], 'w');
  fs.closeSync(fd);
  assert.equal((fs.statSync(target).mode & 0o777).toString(8), '664');
});
