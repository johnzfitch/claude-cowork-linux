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
// Actual byte I/O is delegated to Node's fs.promises FileHandle, whose
// read(buffer, offset, length, position) / write / stat / close / sync /
// truncate signatures are exactly what the caller drives.

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

async function openBeneath(root, segments, flags, mode) {
  // Returns a Node fs.promises FileHandle — read(buf,off,len,pos) / write /
  // stat / close / sync / truncate — the exact surface the caller uses. Mode
  // defaults to 0o600 to match the native call's `?? 384`.
  return fs.promises.open(resolveBeneath(root, segments), flags, mode == null ? 0o600 : mode);
}

module.exports = {
  resolveBeneath,
  openRootDir,
  mkdirBeneath,
  unlinkBeneath,
  renameBeneath,
  openBeneath,
};
