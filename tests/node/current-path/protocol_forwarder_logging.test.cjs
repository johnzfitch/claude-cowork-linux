'use strict';

// protocol-forwarder.js receives the claude:// OAuth callback on its argv. The
// query string is the authorization code and state, and everything the
// forwarder logs is appended to startup.log -- a file the issue templates ask
// people to paste into public bug reports. These tests run the real forwarder
// against a stub `electron` module and read back what reached the log.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..', '..');
const SECRET_CODE = 'AuthCodeSecret0123456789';
const SECRET_STATE = 'StateSecret9876';
const CALLBACK = `claude://claude.ai/login/callback?code=${SECRET_CODE}&state=${SECRET_STATE}`;

function makeTree(t, { gotLock }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'cowork'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'stubs', 'frame-fix', 'protocol-forwarder.js'), path.join(app, 'protocol-forwarder.js'));
  fs.copyFileSync(path.join(REPO, 'stubs', 'cowork', 'credential_classifier.js'), path.join(app, 'cowork', 'credential_classifier.js'));

  // Minimal stand-in for Electron's `app`, resolved through NODE_PATH.
  const mods = path.join(root, 'mods', 'electron');
  fs.mkdirSync(mods, { recursive: true });
  fs.writeFileSync(path.join(mods, 'index.js'), `
    module.exports = { app: {
      setName() {}, getPath() { return ${JSON.stringify(root)}; },
      requestSingleInstanceLock() { return ${gotLock}; },
      releaseSingleInstanceLock() {}, quit() {},
    } };
  `);

  // The no-running-instance branch execs launch.sh; give it a harmless one.
  const coworkDir = path.join(root, 'cowork-dir');
  fs.mkdirSync(coworkDir);
  fs.writeFileSync(path.join(coworkDir, 'launch.sh'), 'exit 0\n');

  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir);
  return { root, app, logDir, coworkDir, nodePath: path.join(root, 'mods') };
}

function runForwarder(tree, argv) {
  const res = spawnSync(process.execPath, [path.join(tree.app, 'protocol-forwarder.js'), ...argv], {
    env: { ...process.env, NODE_PATH: tree.nodePath, CLAUDE_LOG_DIR: tree.logDir, COWORK_DIR: tree.coworkDir },
    encoding: 'utf8',
    timeout: 15000,
  });
  const logPath = path.join(tree.logDir, 'startup.log');
  return { res, log: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '' };
}

for (const gotLock of [false, true]) {
  const branch = gotLock ? 'no running instance (launches launch.sh)' : 'app running (second-instance)';

  test(`forwarder keeps the OAuth code and state out of startup.log -- ${branch}`, (t) => {
    const tree = makeTree(t, { gotLock });
    const { res, log } = runForwarder(tree, ['--some-flag', CALLBACK]);
    assert.equal(res.error, undefined, String(res.error));
    assert.ok(log.length > 0, 'forwarder wrote nothing to startup.log');
    const everything = log + res.stdout + res.stderr;
    assert.ok(!everything.includes(SECRET_CODE), 'authorization code reached the log:\n' + everything);
    assert.ok(!everything.includes(SECRET_STATE), 'state reached the log:\n' + everything);
    assert.match(log, /code=\[REDACTED\]&state=\[REDACTED\]/);
    // Non-URL arguments are still logged; they are what makes the line useful.
    assert.match(log, /--some-flag/);
  });
}

test('forwarder logs no part of the URL when the classifier is missing', (t) => {
  const tree = makeTree(t, { gotLock: false });
  fs.rmSync(path.join(tree.app, 'cowork'), { recursive: true, force: true });
  const { log } = runForwarder(tree, [CALLBACK]);
  assert.ok(log.includes('[claude:// URL withheld]'), log);
  assert.ok(!log.includes(SECRET_CODE));
  assert.ok(!log.includes('claude.ai/login'));
});

test('frame-fix-wrapper redacts the URL it forwards via open-url', () => {
  const src = fs.readFileSync(path.join(REPO, 'stubs', 'frame-fix', 'frame-fix-wrapper.js'), 'utf8');
  const logLines = src.split('\n').filter((l) => /console\.(log|warn|error)\(/.test(l) && /url/i.test(l));
  assert.ok(logLines.length > 0, 'expected the open-url forwarding log line');
  for (const line of logLines) {
    if (/\+\s*url\b/.test(line)) {
      assert.match(line, /redactUrl\(url\)/, 'raw URL concatenated into a log line: ' + line.trim());
    }
  }
});
