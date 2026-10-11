'use strict';

// End to end: the portal shortcuts client on a real D-Bus session bus, against
// tests/fixtures/fake_global_shortcuts_portal.py, which enforces the rules of
// xdg-desktop-portal that decide whether a client works at all -- a session
// belongs to the connection that created it and dies with it, and Response /
// Activated are unicast to that connection.
//
// The client that shipped from v4.3.0 to v5.3.0 ran each call as a separate
// `gdbus` process. Against these rules it timed out waiting for the
// CreateSession Response (sent to a process that had already exited) and its
// session was closed the moment that process disconnected, so global
// shortcuts on Wayland never bound anything.
//
// Skipped where dbus-run-session or python3-gi is not installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..', '..');
const CLIENT = path.join(REPO, 'stubs', 'cowork', 'portal_shortcuts.js');
const FAKE = path.join(REPO, 'tests', 'fixtures', 'fake_global_shortcuts_portal.py');

const haveBus = spawnSync('dbus-run-session', ['--', 'true'], { stdio: 'ignore' }).status === 0;
const haveGi = spawnSync('python3', ['-c', 'from gi.repository import Gio, GLib'], { stdio: 'ignore' }).status === 0;
const skip = haveBus && haveGi ? false : 'needs dbus-run-session and python3-gi';

// Runs `driverBody` (an async function body with `createPortalShortcuts`,
// `state()`, `fire(id)` and `sleep(ms)` in scope) on a private session bus,
// with the fake portal running unless startPortal is false. Returns its result.
function onPrivateBus(t, driverBody, { startPortal = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-dbus-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const driver = path.join(dir, 'driver.js');
  fs.writeFileSync(driver, `
    const { execFileSync } = require('child_process');
    const { createPortalShortcuts } = require(${JSON.stringify(CLIENT)});
    const gd = (method, ...args) => execFileSync('gdbus', ['call', '--session',
      '--dest', 'org.freedesktop.portal.Desktop', '--object-path', '/test',
      '--method', 'org.example.FakePortal.' + method, ...args], { encoding: 'utf8' });
    const state = () => JSON.parse(gd('State').trim().slice(2, -3).replace(/\\\\'/g, "'"));
    const fire = (id) => gd('Fire', id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    console.log = console.warn = console.error = () => {};
    (async () => { ${driverBody} })()
      .then((r) => { process.stdout.write('RESULT' + JSON.stringify(r)); process.exit(0); })
      .catch((e) => { process.stdout.write('ERROR' + e.stack); process.exit(1); });
  `);
  const log = path.join(dir, 'fake.log');
  const script = (startPortal
    ? `python3 ${JSON.stringify(FAKE)} > ${JSON.stringify(log)} 2>&1 &
       for i in $(seq 100); do grep -q READY ${JSON.stringify(log)} && break; sleep 0.1; done
       grep -q READY ${JSON.stringify(log)} || { echo "fake portal did not start"; cat ${JSON.stringify(log)}; exit 3; }
    ` : '') + `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(driver)}`;
  const r = spawnSync('dbus-run-session', ['--', 'bash', '-c', script], { encoding: 'utf8', timeout: 60000 });
  const out = r.stdout || '';
  const i = out.indexOf('RESULT');
  assert.ok(i >= 0, 'driver failed: ' + out + (r.stderr || ''));
  return JSON.parse(out.slice(i + 'RESULT'.length));
}

const ID = 'claude-ctrl-alt-space';

test('a registered shortcut is bound by the session owner and fires its callback', { skip }, (t) => {
  const r = onPrivateBus(t, `
    let fired = 0;
    const p = createPortalShortcuts();
    const t0 = Date.now();
    const ok = await p.register('Ctrl+Alt+Space', () => { fired++; });
    const ms = Date.now() - t0;
    await sleep(200);
    const s = state();
    fire(${JSON.stringify(ID)});
    await sleep(300);
    p.destroy();
    return { ok, ms, s, fired };
  `);
  assert.equal(r.ok, true);
  assert.ok(r.ms < 5000, 'register took ' + r.ms + ' ms (a missed Response times out at 10 s)');
  const sessions = Object.values(r.s.sessions);
  assert.equal(sessions.length, 1, 'expected exactly one live session: ' + JSON.stringify(r.s));
  assert.deepEqual(sessions[0].bound, [ID]);
  assert.equal(r.fired, 1, 'Activated must reach the callback exactly once');
});

test('removing one of two shortcuts re-binds the rest; removing the last closes the session', { skip }, (t) => {
  const r = onPrivateBus(t, `
    const p = createPortalShortcuts();
    await p.register('Ctrl+Alt+Space', () => {});
    await p.register('Ctrl+Alt+K', () => {});
    await sleep(200);
    const both = state();
    p.unregister('Ctrl+Alt+K');
    await sleep(300);
    const one = state();
    p.unregister('Ctrl+Alt+Space');
    await sleep(500);
    const none = state();
    const again = await p.register('Ctrl+Alt+Space', () => {});
    await sleep(200);
    const reopened = state();
    p.destroy();
    await sleep(500);
    const destroyed = state();
    return { both, one, none, again, reopened, destroyed };
  `);
  assert.deepEqual(Object.values(r.both.sessions)[0].bound.sort(), ['claude-ctrl-alt-k', ID].sort());
  assert.deepEqual(Object.values(r.one.sessions)[0].bound, [ID]);
  // The last shortcut released: no live session, closed by Session.Close.
  assert.deepEqual(r.none.sessions, {});
  assert.equal(r.none.closed.at(-1).reason, 'Close');
  // And a later register opens a fresh, working session.
  assert.equal(r.again, true);
  assert.deepEqual(Object.values(r.reopened.sessions)[0].bound, [ID]);
  // destroy() drops the connection, which ends the session on the portal side.
  assert.deepEqual(r.destroyed.sessions, {});
});

test('with no portal on the bus, register() resolves false so the wrapper can fall back', { skip }, (t) => {
  const r = onPrivateBus(t, `
    const p = createPortalShortcuts();
    const ok = await p.register('Ctrl+Alt+Space', () => {});
    return { ok, registered: p.isRegistered('Ctrl+Alt+Space') };
  `, { startPortal: false });
  assert.equal(r.ok, false);
  assert.equal(r.registered, false, 'a failed shortcut must not be reported as registered');
});
