'use strict';

// Security hardening tests — validates permission prompting and access control.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ============================================================
// 1. TCC stubs are prompt-capable (not hard-deny)
// ============================================================

describe('TCC stubs are prompt-capable', () => {
  const stubs = require('../../../stubs/cowork/linux_ipc_stubs.js');
  const {
    createOverrideRegistry,
    matchOverride,
  } = require('../../../stubs/cowork/ipc_overrides.js');

  it('linux_ipc_stubs: COMPUTER_USE_TCC_PROMPT_CAPABLE has canPrompt: true', () => {
    assert.equal(stubs.COMPUTER_USE_TCC_PROMPT_CAPABLE.canPrompt, true);
  });

  it('linux_ipc_stubs: COMPUTER_USE_TCC_INITIAL has not_determined status', () => {
    assert.equal(stubs.COMPUTER_USE_TCC_INITIAL.accessibility, 'not_determined');
    assert.equal(stubs.COMPUTER_USE_TCC_INITIAL.screenCapture, 'not_determined');
    assert.equal(stubs.COMPUTER_USE_TCC_INITIAL.canPrompt, true);
  });

  it('ipc_overrides: ComputerUseTcc_$_getState returns prompt-capable state (no permission manager)', async () => {
    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }), null);
    const handler = matchOverride('claude.web_$_ComputerUseTcc_$_getState', registry);
    const result = await handler();
    assert.equal(result.canPrompt, true);
    assert.equal(result.accessibility, 'not_determined');
    assert.equal(result.screenCapture, 'not_determined');
  });

  it('ipc_overrides: requestAccessibility returns canPrompt: true without manager', async () => {
    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }), null);
    const handler = matchOverride('claude.web_$_ComputerUseTcc_$_requestAccessibility', registry);
    const result = await handler();
    assert.equal(result.granted, false);
    assert.equal(result.canPrompt, true);
  });

  it('ipc_overrides: requestScreenRecording returns canPrompt: true without manager', async () => {
    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }), null);
    const handler = matchOverride('claude.web_$_ComputerUseTcc_$_requestScreenRecording', registry);
    const result = await handler();
    assert.equal(result.granted, false);
    assert.equal(result.canPrompt, true);
  });

  // claude-native delegates to permission manager instead of hardcoding false
  it('claude-native source: delegates to permission manager', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'stubs', '@ant', 'claude-native', 'index.js'), 'utf8'
    );
    assert.ok(src.includes('__coworkPermissionManager'),
      'Permission checks must delegate to permission manager');
  });
});

// ============================================================
// 2. FileSystem allowlist-only access
// ============================================================

describe('FileSystem allowlist-only access', () => {
  const {
    isPathWithinAllowedRoots,
    createOverrideRegistry,
    matchOverride,
  } = require('../../../stubs/cowork/ipc_overrides.js');

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
    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }), null);
    const handler = matchOverride('claude.web_$_FileSystem_$_readLocalFile', registry);
    const result = await handler(null, 'local_session', '/etc/hostname');
    assert.equal(result, null);
  });

  it('readLocalFile succeeds for paths within allowed roots', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const testFile = path.join(tmpDir, 'allowed.txt');
    fs.writeFileSync(testFile, 'allowed content', 'utf8');

    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }), null);
    const handler = matchOverride('claude.web_$_FileSystem_$_readLocalFile', registry);
    const result = await handler(null, 'local_session', testFile);
    assert.ok(result);
    assert.equal(result.content, 'allowed content');
  });
});

// ============================================================
// 3. getBridgeConsent — defaults to deny without permission manager
// ============================================================

describe('getBridgeConsent defaults without permission manager', () => {
  const { createOverrideRegistry, matchOverride } = require('../../../stubs/cowork/ipc_overrides.js');

  it('returns consented: false when no permission manager provided', async () => {
    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }), null);
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
    const args = buildBridgeSpawnArgs([], 'cse_test', 'https://api.anthropic.com');
    assert.ok(args.includes('--sdk-url'));
    assert.ok(args.includes('https://api.anthropic.com'));
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
// 5. launch.sh debug ports bind to localhost
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
// 6. No deny-lists of sensitive paths in codebase
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
// 7. No global fs monkey-patching
// ============================================================

describe('No global fs monkey-patching', () => {
  it('session_store.js does not export installMetadataPersistenceGuard', () => {
    const sessionStore = require('../../../stubs/cowork/session_store.js');
    assert.equal(typeof sessionStore.installMetadataPersistenceGuard, 'undefined',
      'installMetadataPersistenceGuard must not be exported');
  });

  it('session_store.js source has no fs.writeFileSync wrapping', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'stubs', 'cowork', 'session_store.js'), 'utf8'
    );
    assert.ok(!src.includes('fs.writeFileSync = '),
      'session_store.js must not monkey-patch fs.writeFileSync');
    assert.ok(!src.includes('fs.writeFile = '),
      'session_store.js must not monkey-patch fs.writeFile');
  });
});
