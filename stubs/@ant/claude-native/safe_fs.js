'use strict';

// Linux implementation of @ant/claude-native's "safe-fs containment" API,
// introduced in asar 1.22209.x. The native module opens a directory as a root
// and performs *Beneath operations that cannot escape it (openat2
// RESOLVE_BENEATH on macOS). Linux Electron has no such binding, so on 1.22209.x
// the app threw "t.openRootDir is not a function" -> UnsafeRootError, breaking
// the write paths that use it (artifacts, uploads, attachments, transcripts).
//
// Containment is two layers. resolveBeneath() is the lexical + nearest-
// existing-ancestor realpath check spaces_store also uses; it rejects bad
// segments up front. It alone is a check-then-use, though: the connected
// folder is writable by the agent, which can swap a directory for a symlink
// between the check and the syscall and send the operation outside the root.
// So every *Beneath op is then anchored: the parent directory is opened, the
// kernel's own path for that fd (/proc/self/fd/N) is proven to sit beneath the
// root, and the operation runs on "/proc/self/fd/N/<name>". Lookup through
// that magic link lands on the pinned directory inode, so a later symlink
// swap of any ancestor cannot redirect it, and the final component is never
// followed (O_NOFOLLOW / unlink / rename / mkdir don't follow it). Symlinks
// that stay inside the root still work, as they do under the native
// RESOLVE_BENEATH. Everything fails closed with EACCES -- including a missing
// /proc, since Electron on Linux cannot run without one anyway.
//
// What this cannot close without openat2(RESOLVE_BENEATH), which Node does not
// expose: the pinned directory itself can be RENAMED out of the root between
// the check and the op, and the op then lands in it at its new location. That
// is a much smaller hole than a symlink swap -- rename() only moves the
// directory somewhere the mover can already write, and the op still touches
// only that directory's own entries, never an arbitrary path such as ~/.ssh.
// It is narrowed further by checking again after the op: openBeneath refuses
// (closes, EACCES) an fd whose file is not beneath the root, so no remote
// content is ever written through it, and the other ops report EACCES.
// openBeneath hands back a raw numeric fd, matching the native module: the
// caller stores that value and drives it through the node:fs callback API
// (write / read / fstat / fsync / ftruncate / fchmod), which requires an int32.

const fs = require('fs');
const path = require('path');

function denied(msg) {
  return Object.assign(new Error(msg), { code: 'EACCES' });
}

function rootPathOf(root) {
  if (!root || typeof root.__safeRoot !== 'string') {
    throw denied('safe-fs: a handle from openRootDir is required');
  }
  return root.__safeRoot;
}

// Join root + single-component segments and prove the result stays within the
// root, rejecting separators, '.', '..', NUL, and symlinked-ancestor escapes.
function resolveBeneath(root, segments) {
  const base = rootPathOf(root);
  const segs = Array.isArray(segments) ? segments : [segments];
  for (const s of segs) {
    if (typeof s !== 'string' || s.length === 0 ||
        s === '.' || s === '..' ||
        s.indexOf('/') >= 0 || s.indexOf('\\') >= 0 || s.indexOf('\0') >= 0) {
      throw denied('safe-fs: unsafe path segment: ' + String(s));
    }
  }
  const target = path.resolve(base, ...segs);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw denied('safe-fs: path escapes root');
  }
  // Symlink defense: the nearest EXISTING ancestor must realpath within base,
  // so a symlink in the existing portion of the chain can't redirect the op.
  let cur = target;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  let realCur;
  try { realCur = fs.realpathSync(cur); } catch (_) { realCur = cur; }
  if (realCur !== base && !realCur.startsWith(base + path.sep)) {
    throw denied('safe-fs: symlinked path escapes root');
  }
  return target;
}

async function openRootDir(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
    throw Object.assign(new Error('openRootDir: absolute path required'), { code: 'EINVAL' });
  }
  // realpath up front so the stored root is canonical (mirrors the native
  // "open the dir, hold the fd" contract). Throws ENOENT if it doesn't exist —
  // same failure the caller already handles.
  const real = await fs.promises.realpath(rootPath);
  const st = await fs.promises.stat(real);
  if (!st.isDirectory()) {
    throw Object.assign(new Error('openRootDir: not a directory: ' + rootPath), { code: 'ENOTDIR' });
  }
  return { __safeRoot: real, close: async () => {} };
}

const PROC_FD = '/proc/self/fd/';

function isWithin(base, p) {
  return p === base || p.startsWith(base + path.sep);
}

function fdCall(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, val) => (err ? reject(err) : resolve(val)));
  });
}

function closeQuietly(fd) {
  fs.close(fd, () => {});
}

// Open a directory and prove, from the fd itself, that it lies beneath base.
// Returns { fd, real }; the caller owns the fd.
async function openDirBeneath(base, dirPath) {
  const c = fs.constants;
  const fd = await fdCall(fs.open, dirPath, c.O_RDONLY | c.O_DIRECTORY);
  try {
    let real;
    try {
      real = await fs.promises.readlink(PROC_FD + fd);
    } catch (_) {
      throw denied('safe-fs: cannot verify the directory (is /proc mounted?)');
    }
    if (!isWithin(base, real)) throw denied('safe-fs: path escapes root');
    return { fd, real };
  } catch (e) {
    closeQuietly(fd);
    throw e;
  }
}

// Run fn on an anchored path for absPath's final component: its parent is
// pinned by fd and verified, so nothing above the final component can be
// swapped out from under the operation.
// release(result) undoes a result the caller will never see (closes an fd).
async function inPinnedParent(base, absPath, fn, release) {
  const dir = await openDirBeneath(base, path.dirname(absPath));
  try {
    const result = await fn(PROC_FD + dir.fd + '/' + path.basename(absPath), dir);
    // The pinned directory can be renamed out of the root while fn runs (see
    // the header). The op has happened, but its caller must not believe it
    // happened beneath the root.
    try {
      await assertFdBeneath(base, dir.fd);
    } catch (e) {
      if (release) release(result);
      throw e;
    }
    return result;
  } finally {
    closeQuietly(dir.fd);
  }
}

// Prove an open fd (file or directory) is still beneath base, by the kernel's
// own path for it.
async function assertFdBeneath(base, fd) {
  let real;
  try {
    real = await fs.promises.readlink(PROC_FD + fd);
  } catch (_) {
    throw denied('safe-fs: cannot verify the path (is /proc mounted?)');
  }
  if (!isWithin(base, real)) throw denied('safe-fs: path left the root during the operation');
}

// openFd, then refuse the fd unless its file is beneath base. Closing it here
// means nothing the caller writes can reach a file whose directory was moved
// out of the root mid-open.
async function openFdBeneath(base, p, nflags, fmode) {
  const fd = await openFd(p, nflags, fmode);
  try {
    await assertFdBeneath(base, fd);
  } catch (e) {
    closeQuietly(fd);
    throw e;
  }
  return fd;
}

async function mkdirBeneath(root, segments, opts) {
  const base = rootPathOf(root);
  const target = resolveBeneath(root, segments);
  const o = opts || {};
  if (target === base) return fs.promises.mkdir(base, o);
  const recursive = typeof o === 'object' && o.recursive === true;
  if (!recursive) {
    return inPinnedParent(base, target, (p) => fs.promises.mkdir(p, o));
  }
  // mkdir -p, one pinned level at a time. Returns the first directory created,
  // or undefined if all existed -- fs.mkdir's recursive contract.
  const mode = o.mode;
  const rel = path.relative(base, target).split(path.sep);
  let dir = await openDirBeneath(base, base);
  let first;
  try {
    for (const seg of rel) {
      const p = PROC_FD + dir.fd + '/' + seg;
      try {
        await fs.promises.mkdir(p, mode === undefined ? {} : { mode });
        if (first === undefined) first = path.join(dir.real, seg);
      } catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;
      }
      const next = await openDirBeneath(base, p);
      closeQuietly(dir.fd);
      dir = next;
    }
  } finally {
    closeQuietly(dir.fd);
  }
  return first;
}

async function unlinkBeneath(root, segments) {
  const base = rootPathOf(root);
  const target = resolveBeneath(root, segments);
  if (target === base) return fs.promises.unlink(base);
  return inPinnedParent(base, target, (p) => fs.promises.unlink(p));
}

async function inheritReplacedMode(base, fromPath, toPath) {
  // The app writes files atomically: temp file next to the target, then rename
  // over it. rename() swaps the inode, so the replacement would carry the temp
  // file's mode and silently drop the permissions the user's file had (a 0664
  // file came back 0600). Copy the target's mode onto the source first, so a
  // file that keeps its place keeps its permissions.
  //
  // Best effort, and every failure falls toward the source keeping its own
  // (app-chosen, normally 0600) mode -- never toward changing something else.
  //
  // The connected folder is writable by the agent, so the source can be
  // swapped between resolveBeneath() and here. A path-based chmod() would
  // follow a swapped-in symlink (final component or any ancestor) and apply
  // the target's mode -- which the agent also controls -- to any file the
  // user owns. So the chmod is done on an fd, and only after proving what
  // that fd is:
  //   - O_NOFOLLOW: a final-component symlink fails with ELOOP;
  //   - fstat: a regular file with exactly one link, so a hard link to some
  //     other name cannot be chmodded through this one;
  //   - /proc/self/fd: the kernel's own path for the opened inode must sit
  //     beneath the root, which catches a swapped ancestor directory.
  // Only the permission bits are copied: setuid/setgid/sticky never transfer
  // onto content a remote peer just wrote.
  let mode;
  try {
    // lstat, and only for a regular file: a symlink must not donate its 0777.
    const st = await fs.promises.lstat(toPath);
    if (!st.isFile()) return;
    mode = st.mode & 0o777;
  } catch (_) {
    return; // No target yet, or its mode is unreadable.
  }
  const c = fs.constants;
  let fd;
  try {
    fd = await fdCall(fs.open, fromPath,
      c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK | c.O_NOCTTY);
  } catch (_) {
    return;
  }
  try {
    const st = await fdCall(fs.fstat, fd);
    if (!st.isFile() || st.nlink !== 1) return;
    const opened = await fs.promises.readlink(PROC_FD + fd);
    if (!isWithin(base, opened)) return;
    await fdCall(fs.fchmod, fd, mode);
  } catch (_) {
    // /proc unavailable, or the fd vanished: leave the source's mode alone.
  } finally {
    closeQuietly(fd);
  }
}

async function renameBeneath(root, fromSegments, toSegments) {
  const base = rootPathOf(root);
  const from = resolveBeneath(root, fromSegments);
  const to = resolveBeneath(root, toSegments);
  if (from === base || to === base) {
    // Renaming the root itself, or onto it: no parent of ours to pin, and the
    // kernel refuses both anyway (EBUSY / EINVAL / ENOTEMPTY). Let it say so.
    return fs.promises.rename(from, to);
  }
  return inPinnedParent(base, from, (fromP) =>
    inPinnedParent(base, to, async (toP) => {
      await inheritReplacedMode(base, fromP, toP);
      return fs.promises.rename(fromP, toP);
    }));
}

// Node string open-flags -> numeric, so we can OR in O_NOFOLLOW. Mirrors the
// table in Node's fs docs; anything unrecognized is rejected rather than
// silently opened without the no-follow bit.
const FLAG_MAP = {
  r: fs.constants.O_RDONLY,
  'r+': fs.constants.O_RDWR,
  rs: fs.constants.O_RDONLY | fs.constants.O_SYNC,
  'sr': fs.constants.O_RDONLY | fs.constants.O_SYNC,
  'rs+': fs.constants.O_RDWR | fs.constants.O_SYNC,
  'sr+': fs.constants.O_RDWR | fs.constants.O_SYNC,
  w: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
  wx: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
  'xw': fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
  'w+': fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC,
  'wx+': fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
  'xw+': fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
  a: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
  ax: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_EXCL,
  'xa': fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_EXCL,
  as: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_SYNC,
  'sa': fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_SYNC,
  'a+': fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND,
  'ax+': fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_EXCL,
  'xa+': fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_EXCL,
  'as+': fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_SYNC,
  'sa+': fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_SYNC,
};

function numericFlags(flags) {
  if (flags == null) return FLAG_MAP.r;
  if (typeof flags === 'number') return flags;
  if (typeof flags === 'string' && Object.prototype.hasOwnProperty.call(FLAG_MAP, flags)) {
    return FLAG_MAP[flags];
  }
  throw denied('safe-fs: unsupported open flags: ' + String(flags));
}

function openFd(target, nflags, fmode) {
  // fs.open's callback form yields a raw numeric fd. Deliberately NOT
  // fs.promises.open().fd: that would leave a FileHandle whose finalizer closes
  // the descriptor as soon as it is garbage collected, yanking the fd out from
  // under a caller that still holds the number ("Warning: Closing file
  // descriptor N on garbage collection").
  return new Promise((resolve, reject) => {
    fs.open(target, nflags, fmode, (err, fd) => (err ? reject(err) : resolve(fd)));
  });
}

async function openBeneath(root, segments, flags, mode) {
  // Returns a RAW NUMERIC fd, matching the macOS native module. The caller
  // (Claude Desktop's main bundle) does not use FileHandle methods: it stores
  // this value and passes it to the node:fs *callback* APIs — fs.write, fs.read,
  // fs.fstat, fs.fsync, fs.ftruncate, fs.fchmod — each of which validates fd as
  // an int32. Handing back an fs.promises FileHandle made every one of those
  // throw ERR_INVALID_ARG_TYPE, which broke bridge file transfers (#file-commit).
  // Mode defaults to 0o600 to match the native call's `?? 384`.
  //
  // O_NOFOLLOW on the final component. resolveBeneath's ancestor realpath
  // cannot see through a *dangling* symlink: existsSync() is false for a
  // broken link, so the walk skips past it to the (legitimate) parent and the
  // check passes — then open('w') follows the link and creates the file at its
  // target, outside the root. O_NOFOLLOW closes that atomically: the kernel
  // fails with ELOOP instead of following a final-component symlink.
  const base = rootPathOf(root);
  const target = resolveBeneath(root, segments);
  const nflags = numericFlags(flags) | fs.constants.O_NOFOLLOW;
  const fmode = mode == null ? 0o600 : mode;
  if (target === base) return openFdBeneath(base, base, nflags, fmode);
  try {
    return await inPinnedParent(base, target, (p) => openFdBeneath(base, p, nflags, fmode), closeQuietly);
  } catch (e) {
    if (!e || e.code !== 'ELOOP') throw e;
    // The final component IS a symlink. Native RESOLVE_BENEATH permits links
    // that stay inside the root, so mirror that: resolve it and re-open the
    // realpath (which by definition has no symlink at its final component),
    // anchored the same way. A dangling link cannot be resolved -> denied,
    // which is the escape above.
    let real;
    try {
      real = await fs.promises.realpath(target);
    } catch (_) {
      throw denied('safe-fs: symlinked path escapes root');
    }
    if (real === base || !isWithin(base, real)) {
      throw denied('safe-fs: symlinked path escapes root');
    }
    return inPinnedParent(base, real, (p) => openFdBeneath(base, p, nflags, fmode), closeQuietly);
  }
}

module.exports = {
  resolveBeneath,
  openRootDir,
  mkdirBeneath,
  unlinkBeneath,
  renameBeneath,
  openBeneath,
};
