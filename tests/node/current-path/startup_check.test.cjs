'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { runStartupCheck, defaultLogPath } = require('../../../stubs/cowork/startup_check.js');

function makeStubs() {
  const logs = [];
  const warns = [];
  const writes = [];
  const notifies = [];
  return {
    logs,
    warns,
    writes,
    notifies,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    writeFn: (p, content) => writes.push({ path: p, content }),
    mkdirFn: () => {},
    notify: (m) => notifies.push(m),
    logPath: '/tmp/cowork-startup-test.log',
  };
}

function validDeps() {
  return {
    ipcOverridesRegistry: { 'FileSystem_$_readLocalFile': () => {} },
    autoPermissionsCap: { wrapHandler: () => {}, hasTimer: () => false, CAP_MS: 0 },
    mountRootBound: { isMountRootTooBroad: () => false },
  };
}

describe('startup check', () => {
  test('all rails engaged: ok=true, success log, no warn, no notify', () => {
    const s = makeStubs();
    const entry = runStartupCheck({ ...validDeps(), ...s });
    assert.equal(entry.ok, true);
    assert.equal(entry.results.length, 3);
    for (const r of entry.results) assert.equal(r.ok, true, r.check);
    assert.equal(s.warns.length, 0);
    assert.equal(s.notifies.length, 0);
    assert.equal(s.logs.length, 1);
    assert.match(s.logs[0], /all rails engaged/);
    assert.equal(s.writes.length, 1);
    assert.match(s.writes[0].content, /"ok":true/);
  });

  test('bridge override found: failed check, warn, notify', () => {
    const s = makeStubs();
    const deps = validDeps();
    deps.ipcOverridesRegistry = {
      'FileSystem_$_readLocalFile': () => {},
      'LocalAgentModeSessions_$_getBridgeConsent': () => {}, // leak
    };
    const entry = runStartupCheck({ ...deps, ...s });
    assert.equal(entry.ok, false);
    const failed = entry.results.find((r) => r.check === 'bridge_overrides_absent');
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.detail, ['LocalAgentModeSessions_$_getBridgeConsent']);
    assert.equal(s.warns.length, 1);
    assert.match(s.warns[0], /\[COWORK STARTUP CHECK FAILED\]/);
    assert.match(s.warns[0], /bridge_overrides_absent/);
    assert.equal(s.notifies.length, 1);
    assert.match(s.notifies[0], /rails not engaged/);
  });

  test('missing autoPermissionsCap: failed check, warn, notify', () => {
    const s = makeStubs();
    const deps = validDeps();
    deps.autoPermissionsCap = null;
    const entry = runStartupCheck({ ...deps, ...s });
    assert.equal(entry.ok, false);
    const failed = entry.results.find((r) => r.check === 'auto_permissions_cap_armed');
    assert.equal(failed.ok, false);
    assert.equal(s.warns.length, 1);
    assert.match(s.warns[0], /auto_permissions_cap_armed/);
  });

  test('cap without wrapHandler: failed', () => {
    const s = makeStubs();
    const deps = validDeps();
    deps.autoPermissionsCap = { hasTimer: () => false };
    const entry = runStartupCheck({ ...deps, ...s });
    assert.equal(entry.ok, false);
    const failed = entry.results.find((r) => r.check === 'auto_permissions_cap_armed');
    assert.equal(failed.ok, false);
  });

  test('missing mountRootBound: failed check', () => {
    const s = makeStubs();
    const deps = validDeps();
    deps.mountRootBound = null;
    const entry = runStartupCheck({ ...deps, ...s });
    assert.equal(entry.ok, false);
    const failed = entry.results.find((r) => r.check === 'mount_bound_armed');
    assert.equal(failed.ok, false);
  });

  test('writes a JSON line with iso timestamp and results array', () => {
    const s = makeStubs();
    runStartupCheck({ ...validDeps(), ...s });
    assert.equal(s.writes.length, 1);
    const parsed = JSON.parse(s.writes[0].content.trim());
    assert.equal(parsed.ok, true);
    assert.ok(Array.isArray(parsed.results));
    assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('absent notify callback does not crash on failure', () => {
    const s = makeStubs();
    const deps = validDeps();
    deps.autoPermissionsCap = null;
    delete s.notify;
    const entry = runStartupCheck({ ...deps, ...s, notify: null });
    assert.equal(entry.ok, false);
    // No notify; warn still fired.
    assert.equal(s.warns.length, 1);
  });

  test('write/mkdir failure is swallowed (entry still returned)', () => {
    const s = makeStubs();
    s.writeFn = () => { throw new Error('disk full'); };
    s.mkdirFn = () => { throw new Error('permission denied'); };
    const entry = runStartupCheck({ ...validDeps(), ...s });
    assert.equal(entry.ok, true);
    // Success log still fired because rails are fine; write failure is silent.
    assert.equal(s.logs.length, 1);
  });

  test('defaultLogPath honors XDG_STATE_HOME', (t) => {
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = '/custom/state';
    t.after(() => {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
    });
    assert.equal(defaultLogPath(), '/custom/state/claude-cowork/logs/cowork-startup.log');
  });
});
