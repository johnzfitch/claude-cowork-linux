'use strict';

// ============================================================
// Bridge channel surface canary (Phase 4)
// ============================================================
// Opt-in observer that fires at IPC handler registration time when a
// previously-unseen, bridge-related channel suffix shows up. The
// regression alarm for "Anthropic shipped a new bridge channel between
// releases."
//
// Suppress repeats per-suffix per-process. One warning, one line in
// the canary log file, then quiet for the rest of the session.
//
// Enable via:
//   CLAUDE_COWORK_IPC_TAP=1   (existing env var; turns on tap + canary)
//   CLAUDE_COWORK_BRIDGE_CANARY=1   (canary only, no full tap)
//
// Known-good seed = the twelve channel suffixes the wrapper used to
// shadow (now intentionally left to the asar's native handler). Extend
// as new cowork-original bridge channels are audited.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_KNOWN_GOOD = Object.freeze(new Set([
  'LocalAgentModeSessions_$_abandonBridgeEnvironment',
  'LocalAgentModeSessions_$_deleteBridgeAgentMemory',
  'LocalAgentModeSessions_$_deleteBridgeSession',
  'LocalAgentModeSessions_$_getBridgeConsent',
  'LocalAgentModeSessions_$_getSessionsBridgeEnabled',
  'LocalAgentModeSessions_$_kickBridgePoll',
  'LocalAgentModeSessions_$_onBridgePermissionPreflight',
  'LocalAgentModeSessions_$_resetBridge',
  'LocalAgentModeSessions_$_resetBridgeSession',
  'LocalAgentModeSessions_$_respondBridgePermissionPreflight',
  'LocalAgentModeSessions_$_sessionsBridgeStatus',
  'LocalAgentModeSessions_$_setSessionsBridgeEnabled',
]));

const BRIDGE_RE = /[Bb]ridge/;
const SUFFIX_ANCHOR = 'LocalAgentModeSessions_$_';

function isEnabledByEnv() {
  return process.env.CLAUDE_COWORK_IPC_TAP === '1'
      || process.env.CLAUDE_COWORK_BRIDGE_CANARY === '1';
}

function defaultLogPath() {
  const xdgState = process.env.XDG_STATE_HOME || path.join(global.__coworkPasswdHomedir || os.userInfo().homedir, '.local', 'state');
  return path.join(xdgState, 'claude-cowork', 'logs', 'bridge-canary.jsonl');
}

function extractSuffix(channel) {
  if (typeof channel !== 'string') return null;
  const idx = channel.lastIndexOf(SUFFIX_ANCHOR);
  if (idx < 0) return null;
  return channel.slice(idx);
}

function isBridgeRelated(suffix) {
  return typeof suffix === 'string' && BRIDGE_RE.test(suffix);
}

function createBridgeCanary({
  enabled = isEnabledByEnv(),
  knownGood = DEFAULT_KNOWN_GOOD,
  logPath = defaultLogPath(),
  log = console.warn,
  writeFn = fs.appendFileSync,
  mkdirFn = fs.mkdirSync,
} = {}) {
  const seen = new Set();

  function observe(channel) {
    if (!enabled) return false;
    const suffix = extractSuffix(channel);
    if (!suffix) return false;
    if (!isBridgeRelated(suffix)) return false;
    if (knownGood.has(suffix)) return false;
    if (seen.has(suffix)) return false;
    seen.add(suffix);
    const msg = '[bridge-canary] new bridge-related IPC channel observed: '
      + suffix
      + ' — review SECURITY.md and verify whether this should be wrapped or left to the asar\'s native handler';
    log(msg);
    try {
      mkdirFn(path.dirname(logPath), { recursive: true, mode: 0o700 });
      writeFn(logPath, JSON.stringify({ ts: new Date().toISOString(), suffix }) + '\n', { mode: 0o600 });
    } catch (_) {}
    return true;
  }

  return Object.freeze({ observe, enabled });
}

module.exports = {
  createBridgeCanary,
  DEFAULT_KNOWN_GOOD,
  extractSuffix,
  isBridgeRelated,
};
