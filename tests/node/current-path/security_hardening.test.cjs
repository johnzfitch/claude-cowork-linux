'use strict';

// Security hardening tests — validates that all deny-by-default policies hold.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ============================================================
// 1. TCC stubs deny by default (both code paths)
// ============================================================

describe('TCC stubs deny by default', () => {
  const stubs = require('../../../stubs/cowork/linux_ipc_stubs.js');
  const {
    createOverrideRegistry,
    matchOverride,
  } = require('../../../stubs/cowork/ipc_overrides.js');

  it('linux_ipc_stubs: COMPUTER_USE_TCC_GRANTED is denied', () => {
    assert.equal(stubs.COMPUTER_USE_TCC_GRANTED.granted, false);
    assert.equal(stubs.COMPUTER_USE_TCC_GRANTED.status, 'denied');
  });

  it('linux_ipc_stubs: COMPUTER_USE_TCC_REQUEST_GRANTED is denied', () => {
    assert.equal(stubs.COMPUTER_USE_TCC_REQUEST_GRANTED.granted, false);
  });

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

  // claude-native can't be require()'d directly from tests because it depends on
  // electron and on paths that only resolve inside the extracted app tree.
  // Instead, verify the source code contains the correct deny-by-default values.
  it('claude-native source: isAccessibilityEnabled returns false', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'stubs', '@ant', 'claude-native', 'index.js'), 'utf8'
    );
    assert.ok(src.includes('isAccessibilityEnabled: () => false'),
      'isAccessibilityEnabled must return false');
    assert.ok(!src.includes('isAccessibilityEnabled: () => true'),
      'isAccessibilityEnabled must NOT return true');
  });

  it('claude-native source: hasScreenCapturePermission returns false', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'stubs', '@ant', 'claude-native', 'index.js'), 'utf8'
    );
    assert.ok(src.includes('hasScreenCapturePermission: () => false'),
      'hasScreenCapturePermission must return false');
    assert.ok(!src.includes('hasScreenCapturePermission: () => true'),
      'hasScreenCapturePermission must NOT return true');
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
  const { createOverrideRegistry, matchOverride } = require('../../../stubs/cowork/ipc_overrides.js');

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
// 6. launch.sh debug ports bind to localhost
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
    // Should use conditional sandbox check instead of always adding --no-sandbox
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
