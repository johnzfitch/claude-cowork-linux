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
test('an explicit mode argument is honoured', async (t) => {
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
// --- Option A: atomic replace must not drop the replaced file's permissions ---
// The app writes files atomically: it creates a hidden temp file next to the
// target, fills it, then renames it over the target. rename() swaps the inode,
// so without this the replacement carries the temp file's mode and the user's
// 0664 file silently came back as 0600 (owner report 2026-09-05).
test('renaming onto an existing file inherits the replaced permissions', async (t) => {
  const root = tmpRoot(t);
  fs.chmodSync(root, 0o775);
  const h = await safeFs.openRootDir(root);

  const target = path.join(root, 'notes.md');
  fs.writeFileSync(target, 'alt');
  fs.chmodSync(target, 0o664);

  const tmp = path.join(root, '.notes.md.1234.abc.tmp');
  fs.writeFileSync(tmp, 'neu');
  fs.chmodSync(tmp, 0o600);

  await safeFs.renameBeneath(h, ['.notes.md.1234.abc.tmp'], ['notes.md']);

  assert.equal(fs.readFileSync(target, 'utf8'), 'neu');
  assert.equal((fs.statSync(target).mode & 0o777).toString(8), '664',
    'the file kept its place, so it keeps its permissions');
});
test('renaming onto a free name keeps the source permissions', async (t) => {
  const root = tmpRoot(t);
  fs.chmodSync(root, 0o775);
  const h = await safeFs.openRootDir(root);

  const src = path.join(root, 'quelle.txt');
  fs.writeFileSync(src, 'x');
  fs.chmodSync(src, 0o640);

  await safeFs.renameBeneath(h, ['quelle.txt'], ['ziel.txt']);
  assert.equal((fs.statSync(path.join(root, 'ziel.txt')).mode & 0o777).toString(8), '640');
});

// --- Default mode stays 0600 regardless of the root ---
// #190 proposed relaxing the native module's `?? 384` default to 0664 in a
// group/other-accessible root. Not adopted: this path writes files on behalf of
// a remote peer, the macOS native module creates them 0600, and a user who
// wants them shared can chmod. Pin it so the relaxation does not come back by
// accident.
test('with no mode, a new file is 0600 even in a shared root', async (t) => {
  const root = tmpRoot(t);
  fs.chmodSync(root, 0o777);
  const h = await safeFs.openRootDir(root);
  for (const [name, mode] of [['unset.txt', undefined], ['app-default.txt', 0o600]]) {
    const fd = await safeFs.openBeneath(h, [name], 'w', mode);
    fs.closeSync(fd);
    assert.equal((fs.statSync(path.join(root, name)).mode & 0o777).toString(8), '600', name);
  }
});

// --- inheritReplacedMode must never chmod anything outside the root ---
// renameBeneath checks containment, then copies the target's mode onto the
// source, then renames. The connected folder is writable by the agent, so the
// source can be swapped between the check and the chmod. A path-based chmod()
// follows the swapped-in symlink and applies an attacker-chosen mode to any
// file the user owns. These tests open that window deterministically by
// swapping at the lstat() of the target, which sits inside it.
const REAL_LSTAT = fs.promises.lstat;
const REAL_REALPATH_SYNC = fs.realpathSync;

function swapAtTargetLstat(t, targetPath, swap) {
  const orig = REAL_LSTAT;
  let fired = false;
  fs.promises.lstat = async function (p, ...rest) {
    if (!fired && (p === targetPath || String(p).endsWith('/' + path.basename(targetPath)))) { fired = true; swap(); }
    return orig.call(this, p, ...rest);
  };
  t.after(() => { fs.promises.lstat = orig; });
}

test('a source swapped for an out-of-root symlink mid-rename is never chmodded through', async (t) => {
  const root = tmpRoot(t);
  const outside = tmpRoot(t);
  const victim = path.join(outside, 'authorized_keys');
  fs.writeFileSync(victim, 'ssh-ed25519 AAAA');
  fs.chmodSync(victim, 0o600);

  const h = await safeFs.openRootDir(root);
  const target = path.join(root, 'notes.md');
  fs.writeFileSync(target, 'old');
  fs.chmodSync(target, 0o777);
  const tmp = path.join(root, '.notes.md.tmp');
  fs.writeFileSync(tmp, 'new');

  swapAtTargetLstat(t, target, () => {
    fs.unlinkSync(tmp);
    fs.symlinkSync(victim, tmp);
  });
  await safeFs.renameBeneath(h, ['.notes.md.tmp'], ['notes.md']).catch(() => {});

  assert.equal((fs.statSync(victim).mode & 0o7777).toString(8), '600',
    'a file outside the root had its mode changed through the swapped link');
});

test('a source whose parent is swapped for an out-of-root symlink is never chmodded', async (t) => {
  const root = tmpRoot(t);
  const outside = tmpRoot(t);
  const victim = path.join(outside, '.notes.md.tmp');
  fs.writeFileSync(victim, 'secret');
  fs.chmodSync(victim, 0o600);

  const h = await safeFs.openRootDir(root);
  fs.mkdirSync(path.join(root, 'sub'));
  const target = path.join(root, 'sub', 'notes.md');
  fs.writeFileSync(target, 'old');
  fs.chmodSync(target, 0o666);
  fs.writeFileSync(path.join(root, 'sub', '.notes.md.tmp'), 'new');

  swapAtTargetLstat(t, target, () => {
    fs.renameSync(path.join(root, 'sub'), path.join(root, 'sub.real'));
    fs.symlinkSync(outside, path.join(root, 'sub'));
  });
  await safeFs.renameBeneath(h, ['sub', '.notes.md.tmp'], ['sub', 'notes.md']).catch(() => {});

  assert.equal((fs.statSync(victim).mode & 0o7777).toString(8), '600',
    'a file outside the root had its mode changed through a swapped ancestor');
});

test('a source hard-linked elsewhere does not have the shared inode chmodded', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);
  const other = path.join(root, 'other-name');
  fs.writeFileSync(other, 'x');
  fs.chmodSync(other, 0o600);
  fs.linkSync(other, path.join(root, '.tmp'));
  const target = path.join(root, 'dst');
  fs.writeFileSync(target, 'old');
  fs.chmodSync(target, 0o666);

  await safeFs.renameBeneath(h, ['.tmp'], ['dst']);
  assert.equal((fs.statSync(other).mode & 0o777).toString(8), '600',
    'a second name for the same inode had its mode changed');
});

test('setuid, setgid and sticky bits are never carried onto the replacement', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);
  const target = path.join(root, 'tool');
  fs.writeFileSync(target, '#!/bin/sh\n');
  fs.chmodSync(target, 0o6755);
  const tmp = path.join(root, '.tool.tmp');
  fs.writeFileSync(tmp, 'replacement');
  fs.chmodSync(tmp, 0o600);

  await safeFs.renameBeneath(h, ['.tool.tmp'], ['tool']);
  const mode = fs.statSync(target).mode;
  assert.equal((mode & 0o7000), 0, 'special bits survived: ' + (mode & 0o7777).toString(8));
  assert.equal((mode & 0o777).toString(8), '755');
});

// --- Every *Beneath op is anchored on a pinned, verified parent fd ---
// resolveBeneath() is a check; the syscall that follows is a use. Swapping an
// ancestor directory for an out-of-root symlink in between used to send the
// op outside the root: open('w') created/truncated, unlink deleted, mkdir
// created there. These swap right after resolveBeneath's realpath walk.
function swapAfterResolve(t, swap) {
  const orig = REAL_REALPATH_SYNC;
  let fired = false;
  fs.realpathSync = function (...args) {
    const r = orig.apply(this, args);
    if (!fired) { fired = true; swap(); }
    return r;
  };
  t.after(() => { fs.realpathSync = orig; });
}

function setupSwap(t) {
  const root = tmpRoot(t);
  const outside = tmpRoot(t);
  fs.mkdirSync(path.join(root, 'sub'));
  const swap = () => {
    fs.renameSync(path.join(root, 'sub'), path.join(root, 'sub.real'));
    fs.symlinkSync(outside, path.join(root, 'sub'));
  };
  return { root, outside, swap };
}

test('open("w") through a swapped ancestor neither truncates nor creates outside the root', async (t) => {
  const { root, outside, swap } = setupSwap(t);
  fs.writeFileSync(path.join(outside, 'existing'), 'precious');
  const h = await safeFs.openRootDir(root);

  swapAfterResolve(t, swap);
  await assert.rejects(() => safeFs.openBeneath(h, ['sub', 'existing'], 'w'), { code: 'EACCES' });
  assert.equal(fs.readFileSync(path.join(outside, 'existing'), 'utf8'), 'precious');

  // Re-arm for a create of a fresh name.
  fs.rmSync(path.join(root, 'sub'));
  fs.renameSync(path.join(root, 'sub.real'), path.join(root, 'sub'));
  swapAfterResolve(t, swap);
  await assert.rejects(() => safeFs.openBeneath(h, ['sub', 'planted'], 'w'), { code: 'EACCES' });
  assert.equal(fs.existsSync(path.join(outside, 'planted')), false);
});

test('unlink through a swapped ancestor does not delete outside the root', async (t) => {
  const { root, outside, swap } = setupSwap(t);
  fs.writeFileSync(path.join(outside, 'keep'), 'x');
  const h = await safeFs.openRootDir(root);
  swapAfterResolve(t, swap);
  await assert.rejects(() => safeFs.unlinkBeneath(h, ['sub', 'keep']), { code: 'EACCES' });
  assert.ok(fs.existsSync(path.join(outside, 'keep')));
});

test('mkdir (plain and recursive) through a swapped ancestor creates nothing outside the root', async (t) => {
  const { root, outside, swap } = setupSwap(t);
  const h = await safeFs.openRootDir(root);
  swapAfterResolve(t, swap);
  await assert.rejects(() => safeFs.mkdirBeneath(h, ['sub', 'd1']), { code: 'EACCES' });
  assert.equal(fs.existsSync(path.join(outside, 'd1')), false);

  fs.rmSync(path.join(root, 'sub'));
  fs.renameSync(path.join(root, 'sub.real'), path.join(root, 'sub'));
  swapAfterResolve(t, swap);
  await assert.rejects(() => safeFs.mkdirBeneath(h, ['sub', 'd2', 'd3'], { recursive: true }), { code: 'EACCES' });
  assert.equal(fs.existsSync(path.join(outside, 'd2')), false);
});

test('an ancestor symlink that stays inside the root still works for every op', async (t) => {
  const root = tmpRoot(t);
  fs.mkdirSync(path.join(root, 'real'));
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
  const h = await safeFs.openRootDir(root);

  await safeFs.mkdirBeneath(h, ['link', 'd']);
  await safeFs.mkdirBeneath(h, ['link', 'p', 'q'], { recursive: true });
  const fd = await safeFs.openBeneath(h, ['link', 'f'], 'w');
  fs.writeSync(fd, 'ok');
  fs.closeSync(fd);
  await safeFs.renameBeneath(h, ['link', 'f'], ['link', 'g']);
  assert.equal(fs.readFileSync(path.join(root, 'real', 'g'), 'utf8'), 'ok');
  await safeFs.unlinkBeneath(h, ['link', 'g']);
  assert.ok(fs.statSync(path.join(root, 'real', 'd')).isDirectory());
  assert.ok(fs.statSync(path.join(root, 'real', 'p', 'q')).isDirectory());
  assert.equal(fs.existsSync(path.join(root, 'real', 'g')), false);
});

test('recursive mkdir keeps fs.mkdir\'s return contract and applies the mode', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);
  const first = await safeFs.mkdirBeneath(h, ['a', 'b', 'c'], { recursive: true, mode: 0o700 });
  assert.equal(first, path.join(root, 'a'));
  assert.equal((fs.statSync(path.join(root, 'a', 'b', 'c')).mode & 0o077), 0);
  assert.equal(await safeFs.mkdirBeneath(h, ['a', 'b', 'c'], { recursive: true }), undefined);
  await assert.rejects(() => safeFs.mkdirBeneath(h, ['a']), { code: 'EEXIST' });
  fs.writeFileSync(path.join(root, 'file'), 'x');
  await assert.rejects(() => safeFs.mkdirBeneath(h, ['file', 'x'], { recursive: true }));
});

test('no directory fd is leaked on success or failure', async (t) => {
  const root = tmpRoot(t);
  const h = await safeFs.openRootDir(root);
  const count = () => fs.readdirSync('/proc/self/fd').length;
  // Let any lazily-opened runtime fds settle first.
  await safeFs.mkdirBeneath(h, ['warm']);
  await new Promise((r) => setTimeout(r, 20));
  const before = count();
  for (let i = 0; i < 20; i++) {
    await safeFs.mkdirBeneath(h, ['x' + i, 'y'], { recursive: true });
    const fd = await safeFs.openBeneath(h, ['x' + i, 'f'], 'w');
    fs.closeSync(fd);
    await safeFs.renameBeneath(h, ['x' + i, 'f'], ['x' + i, 'g']);
    await safeFs.unlinkBeneath(h, ['x' + i, 'g']);
    await safeFs.unlinkBeneath(h, ['x' + i, 'missing']).catch(() => {});
    await safeFs.openBeneath(h, ['nope', 'f'], 'r').catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(count(), before);
});

// --- A pinned directory renamed OUT of the root mid-op ---
// The parent fd pins the directory inode, so a symlink swap cannot redirect
// the op -- but the directory itself can be renamed elsewhere between the
// check and the syscall (review on #196). Without openat2(RESOLVE_BENEATH)
// that op still lands in the moved directory; what must hold is that the
// caller is told, and that openBeneath never hands back an fd to a file
// outside the root, so no remote content is written through it.
function moveOnReadlinkCall(t, n, from, to) {
  const orig = REAL_READLINK;
  let calls = 0;
  fs.promises.readlink = async function (p, ...rest) {
    const v = await orig.call(this, p, ...rest);
    if (++calls === n) fs.renameSync(from, to);
    return v;
  };
  t.after(() => { fs.promises.readlink = orig; });
}
const REAL_READLINK = fs.promises.readlink;

test('openBeneath refuses the fd when its directory is moved out after the parent check', async (t) => {
  const root = tmpRoot(t);
  const outside = tmpRoot(t);
  fs.mkdirSync(path.join(root, 'sub'));
  const h = await safeFs.openRootDir(root);
  const before = fs.readdirSync('/proc/self/fd').length;
  // call 1 = parent verification; move right after it.
  moveOnReadlinkCall(t, 1, path.join(root, 'sub'), path.join(outside, 'sub'));
  await assert.rejects(() => safeFs.openBeneath(h, ['sub', 'f'], 'w'), { code: 'EACCES' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.readdirSync('/proc/self/fd').length, before, 'refused fd was not closed');
});

test('openBeneath refuses and closes the fd when the directory moves after the file check', async (t) => {
  const root = tmpRoot(t);
  const outside = tmpRoot(t);
  fs.mkdirSync(path.join(root, 'sub'));
  const h = await safeFs.openRootDir(root);
  const before = fs.readdirSync('/proc/self/fd').length;
  // call 1 = parent check, call 2 = opened-file check; move after call 2 so
  // only the directory re-check (call 3) can catch it.
  moveOnReadlinkCall(t, 2, path.join(root, 'sub'), path.join(outside, 'sub'));
  await assert.rejects(() => safeFs.openBeneath(h, ['sub', 'f'], 'w'), { code: 'EACCES' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.readdirSync('/proc/self/fd').length, before, 'fd from the abandoned open leaked');
});

test('unlink and mkdir report EACCES when their directory is moved out mid-op', async (t) => {
  const root = tmpRoot(t);
  const outside = tmpRoot(t);
  const h = await safeFs.openRootDir(root);

  fs.mkdirSync(path.join(root, 'a'));
  fs.writeFileSync(path.join(root, 'a', 'x'), '');
  moveOnReadlinkCall(t, 1, path.join(root, 'a'), path.join(outside, 'a'));
  await assert.rejects(() => safeFs.unlinkBeneath(h, ['a', 'x']), { code: 'EACCES' });

  fs.promises.readlink = REAL_READLINK;
  fs.mkdirSync(path.join(root, 'b'));
  moveOnReadlinkCall(t, 1, path.join(root, 'b'), path.join(outside, 'b'));
  await assert.rejects(() => safeFs.mkdirBeneath(h, ['b', 'd']), { code: 'EACCES' });
});
