'use strict';

// Security hardening tests — validates that all deny-by-default policies hold,
// plus mount path validation, env filtering, and session metadata integrity.

const { describe, it } = require('node:test');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  validateMountName,
  validateRelativePathWithinHome,
} = require('../../../stubs/cowork/dirs.js');

const {
  filterEnv,
  ADDITIONAL_ENV_ALLOWLIST,
  ADDITIONAL_ENV_PREFIX_ALLOWLIST,
} = require('../../../stubs/cowork/env_filter.js');

const {
  computeMetadataChecksum,
  verifyMetadataChecksum,
  findSessionMetadataPath,
} = require('../../../stubs/cowork/session_store.js');

const {
  createOverrideRegistry,
  matchOverride,
  isPathWithinAllowedRoots,
} = require('../../../stubs/cowork/ipc_overrides.js');

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-hardening-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setupPackedStubFixture(tempRoot) {
  const tempHome = path.join(tempRoot, 'home');
  const tempRepoRoot = path.join(tempRoot, 'packed-app');
  const tempCoworkRoot = path.join(tempRepoRoot, 'cowork');
  const tempStubDir = path.join(tempRepoRoot, 'stubs', '@ant', 'claude-swift', 'js');
  const modulePath = path.join(tempStubDir, 'index.js');

  fs.mkdirSync(tempHome, { recursive: true });
  fs.mkdirSync(tempStubDir, { recursive: true });
  const repoRoot = path.join(__dirname, '..', '..', '..');
  fs.cpSync(path.join(repoRoot, 'stubs', 'cowork'), tempCoworkRoot, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'stubs', '@ant', 'claude-swift', 'js', 'index.js'), modulePath);

  return { tempHome, tempRepoRoot, modulePath };
}

// ============================================================
// 1. TCC stubs deny by default (both code paths)
// ============================================================

describe('TCC stubs deny by default', () => {
  const stubs = require('../../../stubs/cowork/linux_ipc_stubs.js');

  it('ipc_overrides: ComputerUseTcc_$_getState returns denied', async () => {
    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
    const handler = matchOverride('claude.web_$_ComputerUseTcc_$_getState', registry);
    const result = await handler();
    assert.equal(result.granted, false);
    assert.equal(result.status, 'denied');
  });

  it('ipc_overrides: requestAccessibility returns denied', async () => {
    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
    const handler = matchOverride('claude.web_$_ComputerUseTcc_$_requestAccessibility', registry);
    const result = await handler();
    assert.equal(result.granted, false);
  });

  it('ipc_overrides: requestScreenRecording returns denied', async () => {
    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
    const handler = matchOverride('claude.web_$_ComputerUseTcc_$_requestScreenRecording', registry);
    const result = await handler();
    assert.equal(result.granted, false);
  });

  it('ipc_overrides: requestFolderTccAccess returns denied', async () => {
    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
    const handler = matchOverride('claude.web_$_LocalAgentModeSessions_$_requestFolderTccAccess', registry);
    const result = await handler();
    assert.equal(result.granted, false);
  });
});

// ============================================================
// 2. FileSystem allowlist-only access
// ============================================================

describe('FileSystem allowlist-only access', () => {
  it('allows paths within home directory', () => {
    const homeFile = path.join(os.homedir(), 'test-file.txt');
    assert.ok(isPathWithinAllowedRoots(homeFile));
  });

  it('allows paths within /tmp', () => {
    assert.ok(isPathWithinAllowedRoots('/tmp/some-file.txt'));
  });

  it('rejects paths outside allowed roots', () => {
    assert.ok(!isPathWithinAllowedRoots('/etc/hostname'));
  });

  it('rejects /var paths', () => {
    assert.ok(!isPathWithinAllowedRoots('/var/log/syslog'));
  });

  it('rejects /usr paths', () => {
    assert.ok(!isPathWithinAllowedRoots('/usr/share/doc/readme'));
  });

  it('readLocalFile returns null for paths outside allowed roots', async () => {
    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
    const handler = matchOverride('claude.web_$_FileSystem_$_readLocalFile', registry);
    const result = await handler(null, 'local_session', '/etc/hostname');
    assert.equal(result, null);
  });

  it('readLocalFile succeeds for paths within allowed roots', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const testFile = path.join(tmpDir, 'allowed.txt');
    fs.writeFileSync(testFile, 'allowed content', 'utf8');

    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
    const handler = matchOverride('claude.web_$_FileSystem_$_readLocalFile', registry);
    const result = await handler(null, 'local_session', testFile);
    assert.ok(result);
    assert.equal(result.content, 'allowed content');
  });
});

// ============================================================
// 3. getBridgeConsent denies by default
// ============================================================

describe('getBridgeConsent denies by default', () => {
  it('returns consented: false', async () => {
    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
    const handler = matchOverride('claude.web_$_LocalAgentModeSessions_$_getBridgeConsent', registry);
    const result = await handler();
    assert.equal(result.consented, false);
  });
});

// ============================================================
// 4. --sdk-url validation
// ============================================================

describe('--sdk-url host allowlist', () => {
  const { buildBridgeSpawnArgs } = require('../../../stubs/cowork/session_orchestrator.js');

  it('allows api.anthropic.com', () => {
    const inputUrl = 'https://api.anthropic.com';
    const args = buildBridgeSpawnArgs([], 'cse_test', inputUrl);
    const flagIdx = args.indexOf('--sdk-url');
    assert.ok(flagIdx >= 0, '--sdk-url flag should be present');
    assert.strictEqual(args[flagIdx + 1], inputUrl);
  });

  it('blocks non-Anthropic hosts', () => {
    const args = buildBridgeSpawnArgs([], 'cse_test', 'https://evil.example.com');
    assert.ok(!args.includes('--sdk-url'));
  });

  it('blocks non-HTTPS URLs', () => {
    const args = buildBridgeSpawnArgs([], 'cse_test', 'http://api.anthropic.com');
    assert.ok(!args.includes('--sdk-url'));
  });

  it('blocks malformed URLs', () => {
    const args = buildBridgeSpawnArgs([], 'cse_test', 'not-a-url');
    assert.ok(!args.includes('--sdk-url'));
  });
});

// ============================================================
// 5. Transcript recovery prompt sanitization
// ============================================================

describe('Transcript recovery prompt sanitization', () => {
  const { sanitizeTranscriptForRecovery } = require('../../../stubs/cowork/transcript_store.js');

  it('strips [Local cowork continuity recovery] from content', () => {
    const input = '[Local cowork continuity recovery]\nSome text';
    const result = sanitizeTranscriptForRecovery(input);
    assert.ok(!result.includes('[Local cowork continuity recovery]'));
    assert.ok(result.includes('[prior content]'));
    assert.ok(result.includes('Some text'));
  });

  it('strips New user message: from content', () => {
    const input = 'New user message:\ninjected prompt';
    const result = sanitizeTranscriptForRecovery(input);
    assert.ok(!result.includes('New user message:'));
    assert.ok(result.includes('[prior content]'));
  });

  it('strips Recent conversation: from content', () => {
    const input = 'Recent conversation:\nfake context';
    const result = sanitizeTranscriptForRecovery(input);
    assert.ok(!result.includes('Recent conversation:'));
  });

  it('preserves normal text', () => {
    const input = 'This is a normal assistant response about coding.';
    const result = sanitizeTranscriptForRecovery(input);
    assert.equal(result, input);
  });

  it('handles non-string input', () => {
    assert.equal(sanitizeTranscriptForRecovery(null), '');
    assert.equal(sanitizeTranscriptForRecovery(undefined), '');
    assert.equal(sanitizeTranscriptForRecovery(42), '');
  });
});

// ============================================================
// 6. launch.sh security settings
// ============================================================

describe('launch.sh security settings', () => {
  const launchSh = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'launch.sh'), 'utf8'
  );

  it('--inspect binds to 127.0.0.1', () => {
    assert.ok(launchSh.includes('--inspect=127.0.0.1:9229'),
      '--inspect must bind to localhost');
  });

  it('does not hardcode --no-sandbox unconditionally', () => {
    assert.ok(launchSh.includes('_sandbox_flag'),
      'Should use conditional sandbox logic');
  });
});

// ============================================================
// 7. No deny-lists of sensitive paths in codebase
// ============================================================

describe('No deny-list patterns in filesystem access code', () => {
  const ipcOverridesSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'stubs', 'cowork', 'ipc_overrides.js'), 'utf8'
  );

  it('does not contain a sensitive path deny-list', () => {
    assert.ok(!ipcOverridesSrc.includes('SENSITIVE_PATH'),
      'Should not have a deny-list of sensitive paths');
    assert.ok(!ipcOverridesSrc.includes('/etc/shadow'),
      'Should not enumerate specific sensitive files');
    assert.ok(!ipcOverridesSrc.includes('.ssh'),
      'Should not enumerate specific sensitive directories');
  });

  it('uses allowlist-based access control', () => {
    assert.ok(ipcOverridesSrc.includes('isPathWithinAllowedRoots'),
      'Should use allowlist-based path checking');
    assert.ok(ipcOverridesSrc.includes('_allowedFsRoots'),
      'Should define allowed filesystem roots');
  });
});

// ============================================================
// 8. Mount name validation (unit)
// ============================================================

test('validateMountName accepts valid simple names', () => {
  assert.equal(validateMountName('.claude'), true);
  assert.equal(validateMountName('uploads'), true);
  assert.equal(validateMountName('project'), true);
  assert.equal(validateMountName('outputs'), true);
  assert.equal(validateMountName('.skills'), true);
});

test('validateMountName accepts valid nested paths', () => {
  assert.equal(validateMountName('.local-plugins/cache/mcpb-cache'), true);
  assert.equal(validateMountName('some/nested/dir'), true);
});

test('validateMountName enforces containment within mount directory', () => {
  assert.equal(validateMountName('..'), false);
  assert.equal(validateMountName('../escape'), false);
  assert.equal(validateMountName('foo/../../escape'), false);
  assert.equal(validateMountName('/absolute/path'), false);
  assert.equal(validateMountName(''), false);
  assert.equal(validateMountName(42), false);
  assert.equal(validateMountName(null), false);
});

// ============================================================
// 9. Relative path home containment (unit)
// ============================================================

test('validateRelativePathWithinHome accepts paths within home directory', () => {
  assert.equal(validateRelativePathWithinHome('projects/my-app'), true);
  assert.equal(validateRelativePathWithinHome('.config/Claude'), true);
  assert.equal(validateRelativePathWithinHome('Documents'), true);
});

test('validateRelativePathWithinHome accepts empty path (homedir itself)', () => {
  assert.equal(validateRelativePathWithinHome(''), true);
});

test('validateRelativePathWithinHome enforces containment within home', () => {
  assert.equal(validateRelativePathWithinHome('../../outside'), false);
  assert.equal(validateRelativePathWithinHome('/etc/passwd'), false);
  assert.equal(validateRelativePathWithinHome(null), false);
  assert.equal(validateRelativePathWithinHome(42), false);
});

// ============================================================
// 10. Mount path validation (integration via vm.spawn)
// ============================================================

test('createMountSymlinks rejects mount names that escape mnt directory', (t) => {
  const tempRoot = createTempDir(t);
  const { tempHome, tempRepoRoot, modulePath } = setupPackedStubFixture(tempRoot);
  const fakeClaudePath = path.join(tempHome, '.local', 'bin', 'claude');
  const workspaceDir = path.join(tempHome, 'workspace');
  fs.mkdirSync(path.dirname(fakeClaudePath), { recursive: true });
  fs.writeFileSync(fakeClaudePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const escapeTarget = path.join(tempRoot, 'escaped-dir');
  fs.mkdirSync(escapeTarget, { recursive: true });

  const script = `
    const addon = require(${JSON.stringify(modulePath)});
    addon.vm.setEventCallbacks(() => {}, () => {}, () => {}, () => {}, () => {}, () => {});

    const result = addon.vm.spawn(
      'proc-1', 'demo',
      ${JSON.stringify(fakeClaudePath)},
      [],
      {},
      { CLAUDE_CONFIG_DIR: ${JSON.stringify(path.join(tempHome, '.claude'))} },
      {
        '.claude': { path: '.config/Claude/sessions/.claude', mode: 'rw' },
        '../escaped': { path: 'workspace', mode: 'rw' },
      },
      false,
      [],
      ${JSON.stringify(workspaceDir)}
    );

    const fs = require('fs');
    const path = require('path');
    const sessionsBase = path.join(${JSON.stringify(tempHome)}, '.config', 'Claude', 'local-agent-mode-sessions', 'sessions');
    const mntDirs = [];
    try {
      const sessions = fs.readdirSync(sessionsBase);
      for (const s of sessions) {
        const mnt = path.join(sessionsBase, s, 'mnt');
        if (fs.existsSync(mnt)) {
          mntDirs.push(...fs.readdirSync(mnt));
        }
      }
    } catch (_) {}
    fs.writeFileSync(${JSON.stringify(path.join(tempRoot, 'result.json'))},
      JSON.stringify({ mntContents: mntDirs }));
    process.exit(0);
  `;

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: tempRepoRoot,
    env: { ...process.env, HOME: tempHome },
    encoding: 'utf8',
    timeout: 5000,
  });

  const resultPath = path.join(tempRoot, 'result.json');
  assert.ok(fs.existsSync(resultPath), 'result file should exist: ' + (child.stderr || child.stdout));
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.ok(!result.mntContents.includes('escaped'),
    'escaped mount should not exist in mnt/, got: ' + JSON.stringify(result.mntContents));
  assert.ok(!result.mntContents.includes('..'),
    '.. should not appear in mnt/, got: ' + JSON.stringify(result.mntContents));
});

test('createMountSymlinks rejects relative paths that escape home directory', (t) => {
  const tempRoot = createTempDir(t);
  const { tempHome, tempRepoRoot, modulePath } = setupPackedStubFixture(tempRoot);
  const fakeClaudePath = path.join(tempHome, '.local', 'bin', 'claude');
  const workspaceDir = path.join(tempHome, 'workspace');
  fs.mkdirSync(path.dirname(fakeClaudePath), { recursive: true });
  fs.writeFileSync(fakeClaudePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const script = `
    const addon = require(${JSON.stringify(modulePath)});
    addon.vm.setEventCallbacks(() => {}, () => {}, () => {}, () => {}, () => {}, () => {});

    const result = addon.vm.spawn(
      'proc-1', 'demo',
      ${JSON.stringify(fakeClaudePath)},
      [],
      {},
      { CLAUDE_CONFIG_DIR: ${JSON.stringify(path.join(tempHome, '.claude'))} },
      {
        'legit': { path: 'workspace', mode: 'rw' },
        'bad-uploads': { path: '../../etc', mode: 'ro' },
      },
      false,
      [],
      ${JSON.stringify(workspaceDir)}
    );

    const fs = require('fs');
    const path = require('path');
    const sessionsBase = path.join(${JSON.stringify(tempHome)}, '.config', 'Claude', 'local-agent-mode-sessions', 'sessions');
    const mntDirs = [];
    try {
      const sessions = fs.readdirSync(sessionsBase);
      for (const s of sessions) {
        const mnt = path.join(sessionsBase, s, 'mnt');
        if (fs.existsSync(mnt)) {
          mntDirs.push(...fs.readdirSync(mnt));
        }
      }
    } catch (_) {}
    fs.writeFileSync(${JSON.stringify(path.join(tempRoot, 'result.json'))},
      JSON.stringify({ mntContents: mntDirs }));
    process.exit(0);
  `;

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: tempRepoRoot,
    env: { ...process.env, HOME: tempHome },
    encoding: 'utf8',
    timeout: 5000,
  });

  const resultPath = path.join(tempRoot, 'result.json');
  assert.ok(fs.existsSync(resultPath), 'result file should exist: ' + (child.stderr || child.stdout));
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.ok(!result.mntContents.includes('bad-uploads'),
    'mount with escaping relative path should not be created, got: ' + JSON.stringify(result.mntContents));
});

// ============================================================
// 11. Environment variable allowlist
// ============================================================

test('filterEnv forwards every key in ADDITIONAL_ENV_ALLOWLIST', () => {
  const input = {};
  for (const key of ADDITIONAL_ENV_ALLOWLIST) {
    input[key] = 'val-' + key;
  }
  const result = filterEnv({}, input);
  for (const key of ADDITIONAL_ENV_ALLOWLIST) {
    assert.equal(result[key], 'val-' + key, key + ' should pass through');
  }
});

test('filterEnv forwards keys matching prefix allowlist', () => {
  const result = filterEnv({}, {
    CLAUDE_CUSTOM_SETTING: 'a',
    ANTHROPIC_CUSTOM_FLAG: 'b',
  });
  assert.equal(result.CLAUDE_CUSTOM_SETTING, 'a');
  assert.equal(result.ANTHROPIC_CUSTOM_FLAG, 'b');
});

test('filterEnv rejects additionalEnv keys not in allowlist or prefix list', () => {
  const result = filterEnv({}, {
    LD_PRELOAD: 'bad',
    NODE_OPTIONS: 'bad',
    PYTHONPATH: 'bad',
    RANDOM_KEY: 'bad',
    BASH_ENV: 'bad',
  });
  assert.equal(result.LD_PRELOAD, undefined);
  assert.equal(result.NODE_OPTIONS, undefined);
  assert.equal(result.PYTHONPATH, undefined);
  assert.equal(result.RANDOM_KEY, undefined);
  assert.equal(result.BASH_ENV, undefined);
});

test('filterEnv forwards base env through ENV_ALLOWLIST only', () => {
  const result = filterEnv({ PATH: '/usr/bin', HOME: '/home/user', UNRELATED: 'val' }, {});
  assert.equal(result.PATH, '/usr/bin');
  assert.equal(result.HOME, '/home/user');
  assert.equal(result.UNRELATED, undefined);
});

test('ADDITIONAL_ENV_ALLOWLIST contains expected production keys', () => {
  const expected = [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'VERTEX_PROJECT',
    'VERTEX_REGION',
  ];
  for (const key of expected) {
    assert.ok(ADDITIONAL_ENV_ALLOWLIST.has(key), key + ' should be in ADDITIONAL_ENV_ALLOWLIST');
  }
});

// ============================================================
// 12. Session metadata integrity
// ============================================================

test('computeMetadataChecksum produces consistent hash', () => {
  const data = { sessionId: 'abc', cwd: '/home/user' };
  const hash1 = computeMetadataChecksum(data);
  const hash2 = computeMetadataChecksum(data);
  assert.equal(hash1, hash2);
  assert.equal(typeof hash1, 'string');
  assert.equal(hash1.length, 64);
});

test('computeMetadataChecksum excludes _checksum field from hash', () => {
  const data = { sessionId: 'abc', cwd: '/home/user' };
  const dataWithChecksum = { ...data, _checksum: 'old-value' };
  assert.equal(computeMetadataChecksum(data), computeMetadataChecksum(dataWithChecksum));
});

test('verifyMetadataChecksum validates correct checksum', () => {
  const data = { sessionId: 'abc', cwd: '/home/user' };
  data._checksum = computeMetadataChecksum(data);
  const result = verifyMetadataChecksum(data);
  assert.equal(result.valid, true);
});

test('verifyMetadataChecksum detects modified data', () => {
  const data = { sessionId: 'abc', cwd: '/home/user' };
  data._checksum = computeMetadataChecksum(data);
  data.cwd = '/tmp/tampered';
  const result = verifyMetadataChecksum(data);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'checksum_mismatch');
});

test('verifyMetadataChecksum handles missing checksum gracefully', () => {
  const result = verifyMetadataChecksum({ sessionId: 'abc' });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_checksum');
});

test('findSessionMetadataPath enforces sessionId format', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-'));
  try {
    assert.equal(findSessionMetadataPath(tmpDir, '../escape'), null);
    assert.equal(findSessionMetadataPath(tmpDir, 'has/slash'), null);
    assert.equal(findSessionMetadataPath(tmpDir, ''), null);
    assert.equal(findSessionMetadataPath(tmpDir, null), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
