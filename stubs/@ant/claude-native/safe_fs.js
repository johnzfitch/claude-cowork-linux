'use strict';

// Linux implementation of @ant/claude-native's "safe-fs containment" API,
// introduced in asar 1.22209.x. The native module opens a directory as a root
// and performs *Beneath operations that cannot escape it (openat2
// RESOLVE_BENEATH on macOS). Linux Electron has no such binding, so on 1.22209.x
// the app threw "t.openRootDir is not a function" -> UnsafeRootError, breaking
// the write paths that use it (artifacts, uploads, attachments, transcripts).
//
// We approximate the containment with realpath checks (lexical + nearest-
// existing-ancestor realpath) — the same defense spaces_store uses. It is
// marginally more TOCTOU-exposed than the native openat2, but fail-closed: any
// segment that could escape the root throws EACCES rather than proceeding.
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

async function mkdirBeneath(root, segments, opts) {
  return fs.promises.mkdir(resolveBeneath(root, segments), opts || {});
}

async function unlinkBeneath(root, segments) {
  return fs.promises.unlink(resolveBeneath(root, segments));
}

async function renameBeneath(root, fromSegments, toSegments) {
  return fs.promises.rename(
    resolveBeneath(root, fromSegments),
    resolveBeneath(root, toSegments)
  );
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
  const nflags = numericFlags(flags);
  const fmode = mode == null ? 0o600 : mode;
  try {
    return await openFd(target, nflags | fs.constants.O_NOFOLLOW, fmode);
  } catch (e) {
    if (!e || e.code !== 'ELOOP') throw e;
    // The final component IS a symlink. Native RESOLVE_BENEATH permits links
    // that stay inside the root, so mirror that: resolve it and re-open the
    // realpath (which by definition has no symlink at its final component).
    // A dangling link cannot be resolved -> denied, which is the escape above.
    let real;
    try {
      real = await fs.promises.realpath(target);
    } catch (_) {
      throw denied('safe-fs: symlinked path escapes root');
    }
    if (real !== base && !real.startsWith(base + path.sep)) {
      throw denied('safe-fs: symlinked path escapes root');
    }
    return openFd(real, nflags | fs.constants.O_NOFOLLOW, fmode);
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
