'use strict';

// ============================================================
// Startup self-test for wrapper rails (Phase 7)
// ============================================================
// Runs once per app.whenReady(). Confirms the three load-bearing rails
// from Phase 1-3 are present, writes a single JSON-line result to
// ~/.local/state/claude-cowork/logs/cowork-startup.log, and on failure
// emits a [COWORK STARTUP CHECK FAILED] console line plus a one-time
// desktop notification.
//
// Why this is a check, not a test: the wrapper modifies an unmodified
// upstream asar. An asar refactor could move our IPC interception seam
// or rename channels, silently bypassing a rail we still believe is
// engaged. This check is the sanity verification.

const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultLogPath() {
  const xdgState = process.env.XDG_STATE_HOME || path.join(global.__coworkPasswdHomedir || os.userInfo().homedir, '.local', 'state');
  return path.join(xdgState, 'claude-cowork', 'logs', 'cowork-startup.log');
}

function runStartupCheck({
  ipcOverridesRegistry = null,
  autoPermissionsCap = null,
  mountRootBound = null,
  execCapabilityRegistry = null,
  log = console.log,
  warn = console.warn,
  writeFn = fs.appendFileSync,
  mkdirFn = fs.mkdirSync,
  logPath = defaultLogPath(),
  notify = null,
} = {}) {
  const results = [];

  // Check 1: bridge IPC overrides are absent.
  // createOverrideRegistry(stub) returns the override map; no key should
  // contain "Bridge" because Phase 1 removed all twelve.
  let bridgeFound = [];
  if (ipcOverridesRegistry && typeof ipcOverridesRegistry === 'object') {
    for (const key of Object.keys(ipcOverridesRegistry)) {
      if (typeof key === 'string' && key.includes('Bridge')) bridgeFound.push(key);
    }
  } else {
    bridgeFound = ['<registry not provided>'];
  }
  results.push({
    check: 'bridge_overrides_absent',
    ok: bridgeFound.length === 0,
    detail: bridgeFound,
  });

  // Check 2: AppPreferences_$_setPreference interceptor armed (the cap
  // factory created an object with the expected shape).
  results.push({
    check: 'auto_permissions_cap_armed',
    ok: !!(autoPermissionsCap && typeof autoPermissionsCap.wrapHandler === 'function'),
  });

  // Check 3: createMountSymlinks mount-bound rule is reachable (the
  // predicate module loaded and exports the expected function).
  results.push({
    check: 'mount_bound_armed',
    ok: !!(mountRootBound && typeof mountRootBound.isMountRootTooBroad === 'function'),
  });

  // Check 4: exec capability registry is armed (frozen map replaces
  // directory-based allowlists for command execution).
  results.push({
    check: 'exec_capability_registry_armed',
    ok: !!(execCapabilityRegistry && typeof execCapabilityRegistry.resolve === 'function'),
  });

  const ok = results.every((r) => r.ok);
  const entry = {
    ts: new Date().toISOString(),
    ok,
    results,
  };

  try {
    mkdirFn(path.dirname(logPath), { recursive: true, mode: 0o700 });
    writeFn(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (_) {}

  if (!ok) {
    const failed = results.filter((r) => !r.ok).map((r) => r.check);
    warn('[COWORK STARTUP CHECK FAILED] ' + failed.join(', '));
    if (typeof notify === 'function') {
      try { notify('Cowork wrapper rails not engaged — review startup log.'); } catch (_) {}
    }
  } else {
    log('[cowork-startup] all rails engaged');
  }

  return entry;
}

module.exports = { runStartupCheck, defaultLogPath };
