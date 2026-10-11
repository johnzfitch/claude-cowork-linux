'use strict';

// The opt-in bubblewrap sandbox (CLAUDE_COWORK_SANDBOX=1).
//
// Until this test existed the sandbox never ran: the swift stub required
// process_manager.js one directory too shallow, inside a try/catch that ate
// the MODULE_NOT_FOUND, and the profile it would have built cleared the
// environment and hid the CLI binary. The unit tests pin the profile; the
// end-to-end tests run a probe under real bwrap (skipped where bwrap cannot
// create namespaces) and check what it could and could not touch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..', '..');
const PM_PATH = path.join(REPO, 'stubs', 'cowork', 'process_manager.js');
const pm = require(PM_PATH);

// ---------------------------------------------------------------------------
// Profile construction (pure)
// ---------------------------------------------------------------------------

function fakeFs(dirs, files = []) {
  const d = new Set(dirs);
  const f = new Set(files);
  return { kind: (p) => (d.has(p) ? 'dir' : f.has(p) ? 'file' : null) };
}

const HOME = '/home/u';
const SESSION = HOME + '/.config/Claude/local-agent-mode-sessions/sessions/s1';
const BASE_DIRS = [HOME, HOME + '/.ssh', HOME + '/.aws', HOME + '/.config/gcloud', HOME + '/.config/Claude', SESSION, HOME + '/proj', '/run/user/1000'];

function build(over = {}) {
  return pm.buildBwrapArgs('/usr/bin/claude', ['--print'], {
    home: HOME,
    cwd: HOME + '/proj',
    env: { XDG_RUNTIME_DIR: '/run/user/1000' },
    sessionDir: SESSION,
    mounts: [{ path: HOME + '/proj', readOnly: false }],
    ...over,
  }, fakeFs(over.dirs || BASE_DIRS, over.files || [HOME + '/.netrc']));
}

function pairs(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag) out.push(args[i + 1]);
  return out;
}

test('profile: read-only root first, then fresh /proc, /dev and /tmp', () => {
  const { args } = build();
  assert.deepEqual(args.slice(0, 9), ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']);
});

test('profile: never clears the environment (it is already filtered)', () => {
  assert.ok(!build().args.includes('--clearenv'));
});

test('profile: session dir, attached folders and cwd are writable; ro mounts are not', () => {
  const r = build({ mounts: [{ path: HOME + '/proj', readOnly: false }, { path: HOME + '/docs', readOnly: true }], dirs: [...BASE_DIRS, HOME + '/docs'] });
  assert.ok(r.summary.writable.includes(SESSION));
  assert.ok(r.summary.writable.includes(HOME + '/proj'));
  assert.ok(r.summary.readOnly.includes(HOME + '/docs'));
  assert.ok(!r.summary.writable.includes(HOME + '/docs'));
});

test('profile: credential stores and Desktop state are hidden', () => {
  const r = build();
  for (const p of [HOME + '/.ssh', HOME + '/.aws', HOME + '/.config/gcloud', HOME + '/.config/Claude', '/run/user/1000']) {
    assert.ok(r.summary.hidden.includes(p), p + ' should be hidden');
    assert.ok(pairs(r.args, '--tmpfs').includes(p));
  }
  // A secret FILE is masked with /dev/null, not a tmpfs.
  const i = r.args.indexOf(HOME + '/.netrc');
  assert.equal(r.args[i - 1], '/dev/null');
  assert.equal(r.args[i - 2], '--ro-bind');
});

test('profile: the session dir under hidden ~/.config/Claude is bound again after the hide', () => {
  const { args } = build();
  const hideAt = args.indexOf(HOME + '/.config/Claude', args.indexOf('--tmpfs', 9));
  const lastBind = args.lastIndexOf(SESSION);
  assert.ok(hideAt > 0 && lastBind > hideAt, 'session dir must be re-bound after ~/.config/Claude is hidden');
});

test('profile: Bedrock sessions keep ~/.aws, Vertex sessions keep ~/.config/gcloud', () => {
  const bedrock = build({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } });
  assert.ok(!bedrock.summary.hidden.includes(HOME + '/.aws'));
  assert.ok(bedrock.summary.hidden.includes(HOME + '/.ssh'));
  const vertex = build({ env: { CLAUDE_CODE_USE_VERTEX: '1' } });
  assert.ok(!vertex.summary.hidden.includes(HOME + '/.config/gcloud'));
  const profileOnly = build({ env: { AWS_PROFILE: 'work' } });
  assert.ok(!profileOnly.summary.hidden.includes(HOME + '/.aws'));
});

test('profile: a folder the user attached is not hidden even if it is a secret store', () => {
  const r = build({ mounts: [{ path: HOME + '/.ssh', readOnly: true }] });
  assert.ok(!r.summary.hidden.includes(HOME + '/.ssh'));
  assert.ok(r.summary.readOnly.includes(HOME + '/.ssh'));
});

test('profile: attaching $HOME itself still hides the secrets inside it', () => {
  const r = build({ mounts: [{ path: HOME, readOnly: false }] });
  assert.ok(r.summary.writable.includes(HOME));
  assert.ok(r.summary.hidden.includes(HOME + '/.ssh'));
  assert.ok(r.args.lastIndexOf(HOME + '/.ssh') > r.args.indexOf(HOME), 'hide must come after the $HOME bind');
});

test('profile: the CLI directory is exposed read-only even under a hidden dir', () => {
  const vm = HOME + '/.config/Claude/claude-code-vm/2.1.0';
  const r = build({ exposeReadOnly: [vm], dirs: [...BASE_DIRS, vm] });
  assert.ok(r.summary.readOnly.includes(vm));
  assert.ok(r.args.lastIndexOf(vm) > r.args.indexOf(HOME + '/.config/Claude', 9));
});

test('profile: namespaces, die-with-parent, chdir, then the command', () => {
  const { args } = build();
  for (const f of ['--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session', '--die-with-parent']) assert.ok(args.includes(f), f);
  assert.deepEqual(pairs(args, '--chdir'), [HOME + '/proj']);
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', '/usr/bin/claude', '--print']);
});

test('profile: paths that do not exist are skipped, not bound', () => {
  const r = build({ mounts: [{ path: HOME + '/gone', readOnly: false }] });
  assert.ok(!r.args.includes(HOME + '/gone'));
});

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function runNode(code, env) {
  return spawnSync(process.execPath, ['-e', code], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000 });
}

test('not requested: wrapWithBwrap returns null and changes nothing', () => {
  const r = runNode(`process.stdout.write(String(require(${JSON.stringify(PM_PATH)}).wrapWithBwrap('/bin/true', [], {})))`, { CLAUDE_COWORK_SANDBOX: '' });
  assert.equal(r.stdout, 'null');
});

test('NO_SANDBOX wins over SANDBOX', () => {
  const r = runNode(`process.stdout.write(String(require(${JSON.stringify(PM_PATH)}).wrapWithBwrap('/bin/true', [], {})))`, { CLAUDE_COWORK_SANDBOX: '1', CLAUDE_COWORK_NO_SANDBOX: '1' });
  assert.equal(r.stdout, 'null');
});

test('requested but bwrap unusable: refuses instead of running unsandboxed', () => {
  const r = runNode(`
    try { require(${JSON.stringify(PM_PATH)}).wrapWithBwrap('/bin/true', [], {}); process.stdout.write('NO THROW'); }
    catch (e) { process.stdout.write('THREW: ' + e.message); }
  `, { CLAUDE_COWORK_SANDBOX: '1', PATH: '/nonexistent' });
  assert.match(r.stdout, /^THREW: CLAUDE_COWORK_SANDBOX=1 is set but bubblewrap/);
});

test('the swift stub requires every cowork module at the same depth', () => {
  // The old sandbox hook used '../../../cowork/', one level short, and its
  // try/catch hid the MODULE_NOT_FOUND.
  const src = fs.readFileSync(path.join(REPO, 'stubs', '@ant', 'claude-swift', 'js', 'index.js'), 'utf8');
  const reqs = [...src.matchAll(/require\('((?:\.\.\/)+)cowork\//g)].map((m) => m[1]);
  assert.ok(reqs.length > 5);
  assert.deepEqual([...new Set(reqs)], ['../../../../']);
  assert.match(src, /\{ wrapWithBwrap \} = require\('\.\.\/\.\.\/\.\.\/\.\.\/cowork\/process_manager\.js'\)/);
});

// ---------------------------------------------------------------------------
// End to end under real bwrap
// ---------------------------------------------------------------------------

const bwrapUsable = spawnSync('bwrap', ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--unshare-pid', '--die-with-parent', '--', 'true'], { stdio: 'ignore' }).status === 0;

test('end to end: a sandboxed session can only write where it should', { skip: bwrapUsable ? false : 'bwrap cannot create namespaces here' }, (t) => {
  // Outside os.tmpdir(): the sandbox replaces /tmp, which would make every
  // write "succeed" into a throwaway tmpfs and hide the read-only root.
  const root = fs.mkdtempSync(path.join(REPO, '.tmp-sandbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const session = path.join(home, '.config', 'Claude', 'local-agent-mode-sessions', 'sessions', 's1');
  const proj = path.join(home, 'proj');
  const docs = path.join(home, 'docs');
  for (const d of [path.join(session, '.claude'), path.join(session, 'mnt'), proj, docs, path.join(home, '.ssh')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_test'), 'PRIVATE KEY');
  fs.writeFileSync(path.join(home, '.netrc'), 'machine x password hunter2');
  fs.writeFileSync(path.join(home, '.config', 'Claude', 'Cookies'), 'desktop session cookie');
  fs.symlinkSync(proj, path.join(session, 'mnt', 'proj'));
  fs.symlinkSync(docs, path.join(session, 'mnt', 'docs'));

  const probe = path.join(proj, '.probe.js');
  fs.writeFileSync(probe, `
    const fs = require('fs');
    const r = {};
    const tryWrite = (k, p) => { try { fs.writeFileSync(p, 'x'); r[k] = 'ok'; } catch (e) { r[k] = e.code; } };
    const tryRead = (k, p) => { try { r[k] = fs.readFileSync(p, 'utf8'); } catch (e) { r[k] = e.code; } };
    tryWrite('proj', ${JSON.stringify(path.join(proj, 'out.txt'))});
    tryWrite('session', ${JSON.stringify(path.join(session, '.claude', 'state.json'))});
    tryWrite('docs', ${JSON.stringify(path.join(docs, 'out.txt'))});
    tryWrite('home', ${JSON.stringify(path.join(home, 'outside.txt'))});
    tryRead('ssh', ${JSON.stringify(path.join(home, '.ssh', 'id_test'))});
    tryRead('netrc', ${JSON.stringify(path.join(home, '.netrc'))});
    tryRead('cookies', ${JSON.stringify(path.join(home, '.config', 'Claude', 'Cookies'))});
    r.cwd = process.cwd();
    r.env = process.env.PROBE_ENV || null;
    r.pid1 = fs.readFileSync('/proc/1/cmdline', 'utf8').split('\\0')[0];
    process.stdout.write(JSON.stringify(r));
  `);

  const wrapperCode = `
    global.__coworkPasswdHomedir = ${JSON.stringify(home)};
    const pm = require(${JSON.stringify(PM_PATH)});
    const w = pm.wrapWithBwrap(process.execPath, [${JSON.stringify(probe)}], {
      home: ${JSON.stringify(home)},
      cwd: ${JSON.stringify(proj)},
      env: { CLAUDE_CONFIG_DIR: ${JSON.stringify(path.join(session, '.claude'))} },
      additionalMounts: { proj: { path: 'proj', mode: 'rw' }, docs: { path: 'docs', mode: 'ro' } },
    });
    const r = require('child_process').spawnSync(w.command, w.args, { env: { PATH: process.env.PATH, PROBE_ENV: 'kept' }, encoding: 'utf8' });
    process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr, summary: w.summary }));
  `;
  const out = runNode(wrapperCode, { CLAUDE_COWORK_SANDBOX: '1' });
  assert.equal(out.status, 0, out.stderr);
  const res = JSON.parse(out.stdout);
  assert.equal(res.status, 0, 'probe failed inside the sandbox: ' + res.stderr);
  const p = JSON.parse(res.stdout);

  assert.equal(p.proj, 'ok', 'attached rw folder must be writable');
  assert.equal(p.session, 'ok', 'session dir must be writable');
  assert.equal(p.docs, 'EROFS', 'attached ro folder must be read-only');
  assert.equal(p.home, 'EROFS', 'the rest of $HOME must be read-only');
  assert.ok(!fs.existsSync(path.join(home, 'outside.txt')));
  assert.equal(p.ssh, 'ENOENT', '~/.ssh must be hidden');
  // Masked with /dev/null: bwrap's bind is nodev, so opening it is EACCES
  // (older kernels/bwrap versions read it as empty). Either way: no secret.
  assert.ok(p.netrc === '' || p.netrc === 'EACCES', '~/.netrc must be unreadable, got ' + JSON.stringify(p.netrc));
  assert.equal(p.cookies, 'ENOENT', 'Claude Desktop state must be hidden');
  assert.equal(p.cwd, proj);
  assert.equal(p.env, 'kept', 'the (already filtered) environment must reach the CLI');
  assert.notEqual(p.pid1, '', 'expected a private PID namespace');
  assert.equal(fs.readFileSync(path.join(proj, 'out.txt'), 'utf8'), 'x', 'writes to the attached folder must reach the host');
});
