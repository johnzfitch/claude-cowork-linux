'use strict';

// ============================================================
// Mount-root bound (Phase 3)
// ============================================================
// When the user starts a Cowork session, they pick a folder to mount
// into the session sandbox. That folder is the agent's working-dir
// blast radius. We refuse mount roots that are so broad the bound is
// meaningless: $HOME itself, /, or anything shallower than three path
// segments (e.g. /home/user, /var/tmp, /opt).
//
// Principle, not enumeration: no allowlist of "sensitive paths". The
// rule covers the class — shallow roots — without naming members.
// The user can edit the rule if their threat model differs.

const path = require('path');
const fs = require('fs');

function isMountRootTooBroad(hostPath, homedir) {
  if (typeof hostPath !== 'string' || hostPath.length === 0) return true;
  if (hostPath === homedir) return true;
  if (hostPath === '/') return true;
  let resolved;
  try {
    resolved = path.resolve(fs.realpathSync(hostPath));
  } catch (_) {
    resolved = path.resolve(hostPath);
  }
  const segments = resolved.split(path.sep).filter(Boolean);
  return segments.length < 3;
}

module.exports = { isMountRootTooBroad };
