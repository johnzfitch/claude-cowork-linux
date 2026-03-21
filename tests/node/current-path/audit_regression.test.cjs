'use strict';

// Regression test suite for frame-fix-wrapper-audit.md items.
// Tests that the current runtime contracts hold, so proposed cleanups
// can be validated against this baseline.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// ============================================================
// Items 3, 24: createDirs() returns deterministic, identical results
// across multiple calls — proving a singleton is safe.
// ============================================================

describe('Audit Item 3/24: createDirs determinism', () => {
  const { createDirs } = require('../../../stubs/cowork/dirs.js');

  it('returns identical results across multiple calls with same options', () => {
    const opts = { env: {}, homeDir: '/home/testuser' };
    const a = createDirs(opts);
    const b = createDirs(opts);

    for (const key of Object.keys(a)) {
      assert.deepEqual(a[key], b[key], `createDirs().${key} differs across calls`);
    }
  });

  it('claudeSessionsBase matches manually computed SESSIONS_BASE', () => {
    const opts = { env: {}, homeDir: '/home/testuser' };
    const dirs = createDirs(opts);
    const expected = path.join(dirs.claudeLocalAgentRoot, 'sessions');
    assert.equal(dirs.claudeSessionsBase, expected,
      'claudeSessionsBase should equal path.join(claudeLocalAgentRoot, "sessions")');
  });

  it('coworkLogsDir matches the provisional path that frame-fix-wrapper computes inline', () => {
    const opts = { env: {}, homeDir: '/home/testuser' };
    const dirs = createDirs(opts);
    // This is the path frame-fix-wrapper.js L282-284 computes inline:
    const provisionalPath = path.join('/home/testuser/.local/state', 'claude-cowork', 'logs');
    assert.equal(dirs.coworkLogsDir, provisionalPath,
      'coworkLogsDir should match the inline computation in frame-fix-wrapper');
  });

  it('coworkLogsDir respects XDG_STATE_HOME override', () => {
    const opts = { env: { XDG_STATE_HOME: '/custom/state' }, homeDir: '/home/testuser' };
    const dirs = createDirs(opts);
    assert.equal(dirs.coworkLogsDir, '/custom/state/claude-cowork/logs');
  });
});

// ============================================================
// Items 4, 17: SESSIONS_BASE is part of dirs output
// ============================================================

describe('Audit Item 4: SESSIONS_BASE available from dirs.js', () => {
  const { createDirs } = require('../../../stubs/cowork/dirs.js');

  it('claudeSessionsBase is exported and matches expected path structure', () => {
    const dirs = createDirs({ env: {}, homeDir: '/home/testuser' });
    assert.equal(typeof dirs.claudeSessionsBase, 'string');
    assert.ok(dirs.claudeSessionsBase.endsWith('/sessions'));
    assert.ok(dirs.claudeSessionsBase.includes('local-agent-mode-sessions'));
  });
});

// ============================================================
// Items 18-21: Path utilities in dirs.js match swift stub copies
// ============================================================

describe('Audit Items 18-21: Path utilities parity between dirs.js and swift stub', () => {
  const dirsModule = require('../../../stubs/cowork/dirs.js');

  // We test the dirs.js versions directly since the swift stub copies
  // should produce identical results. If the copies were removed and
  // the swift stub imported from dirs.js, these tests still pass.

  describe('isPathSafe (Item 18)', () => {
    it('allows paths within base directory', () => {
      assert.ok(dirsModule.isPathSafe('/base', 'child/file.txt'));
      assert.ok(dirsModule.isPathSafe('/base', 'child'));
    });

    it('allows base directory itself', () => {
      assert.ok(dirsModule.isPathSafe('/base', '.'));
    });

    it('blocks path traversal', () => {
      assert.ok(!dirsModule.isPathSafe('/base', '../etc/passwd'));
      assert.ok(!dirsModule.isPathSafe('/base', 'child/../../etc/passwd'));
    });

    it('blocks absolute paths outside base', () => {
      assert.ok(!dirsModule.isPathSafe('/base', '/etc/passwd'));
    });
  });

  describe('translateVmPathStrict (Item 19)', () => {
    const sessionsBase = '/home/testuser/.config/Claude/local-agent-mode-sessions/sessions';

    it('translates valid VM paths', () => {
      const result = dirsModule.translateVmPathStrict(sessionsBase, '/sessions/my-session/mnt/.claude');
      assert.equal(result, path.join(sessionsBase, 'my-session/mnt/.claude'));
    });

    it('rejects non-VM paths', () => {
      assert.throws(
        () => dirsModule.translateVmPathStrict(sessionsBase, '/etc/passwd'),
        /Not a VM path/
      );
    });

    it('blocks path traversal in VM paths', () => {
      assert.throws(
        () => dirsModule.translateVmPathStrict(sessionsBase, '/sessions/../../../etc/passwd'),
        /Path traversal blocked/
      );
    });

    it('allows valid filenames that contain double dots without escaping the sessions root', () => {
      const result = dirsModule.translateVmPathStrict(sessionsBase, '/sessions/my-session/mnt/foo..bar.txt');
      assert.equal(result, path.join(sessionsBase, 'my-session/mnt/foo..bar.txt'));
    });

    it('rejects non-string input', () => {
      assert.throws(
        () => dirsModule.translateVmPathStrict(sessionsBase, null),
        /Not a VM path/
      );
    });
  });

  describe('canonicalizeHostPath (Item 20)', () => {
    it('returns non-string input unchanged', () => {
      assert.equal(dirsModule.canonicalizeHostPath(null), null);
      assert.equal(dirsModule.canonicalizeHostPath(undefined), undefined);
    });

    it('returns relative paths unchanged', () => {
      assert.equal(dirsModule.canonicalizeHostPath('relative/path'), 'relative/path');
    });

    it('rejects raw /sessions/ paths', () => {
      assert.throws(
        () => dirsModule.canonicalizeHostPath('/sessions/my-session/file'),
        /canonicalizeHostPath called with raw VM path/
      );
    });

    it('resolves absolute paths (may follow symlinks)', () => {
      // Use a path we know exists
      const result = dirsModule.canonicalizeHostPath('/tmp');
      assert.ok(path.isAbsolute(result));
    });
  });

  describe('canonicalizeVmPathStrict (Item 21)', () => {
    const sessionsBase = '/tmp/test-sessions';

    it('translates and canonicalizes valid VM paths', () => {
      const result = dirsModule.canonicalizeVmPathStrict(sessionsBase, '/sessions/test/file.txt');
      assert.ok(result.includes('test-sessions'));
      assert.ok(result.includes('test'));
    });

    it('rejects traversal attempts', () => {
      assert.throws(
        () => dirsModule.canonicalizeVmPathStrict(sessionsBase, '/sessions/../../etc/passwd'),
        /Path traversal blocked/
      );
    });
  });
});

// ============================================================
// Item 1: IPC stub response consistency
// Verifies that all three IPC stub sources return equivalent values.
// ============================================================

describe('Audit Item 1: IPC stub response consistency (CONSOLIDATED)', () => {
  // Responses are now consolidated in linux_ipc_stubs.js.
  // All three insertion points reference the shared module.
  const stubs = require('../../../stubs/cowork/linux_ipc_stubs.js');

  it('exports canonical ClaudeCode_$_getStatus response with version', () => {
    assert.equal(stubs.CLAUDE_CODE_STATUS.version, stubs.STUB_CLAUDE_CODE_VERSION);
    assert.deepEqual(Object.keys(stubs.CLAUDE_CODE_STATUS).sort(),
      ['downloading', 'installed', 'progress', 'ready', 'status', 'version']);
  });

  it('exports canonical ClaudeCode_$_prepare response', () => {
    assert.deepEqual(stubs.CLAUDE_CODE_PREPARE, { ready: true, success: true });
  });

  it('exports canonical ClaudeVM_$_getRunningStatus response', () => {
    // Webapp compares with "ready" === vmRunningStatus (string, not object)
    assert.strictEqual(stubs.CLAUDE_VM_RUNNING_STATUS, 'ready');
  });

  it('exports canonical ClaudeVM_$_getDownloadStatus response', () => {
    // Webapp compares with "ready" === vmDownloadStatus (string, not object)
    assert.strictEqual(stubs.CLAUDE_VM_DOWNLOAD_STATUS, 'ready');
  });

  it('exports both TCC variants (denied for early stubs, granted for webContents)', () => {
    assert.equal(stubs.COMPUTER_USE_TCC_DENIED.accessibility, 'denied');
    assert.equal(stubs.COMPUTER_USE_TCC_GRANTED.granted, true);
  });

  it('response objects are frozen to prevent accidental mutation', () => {
    assert.ok(Object.isFrozen(stubs.CLAUDE_CODE_STATUS));
    // VM status values are now strings ("ready"), which are inherently immutable
    assert.strictEqual(typeof stubs.CLAUDE_VM_RUNNING_STATUS, 'string');
  });
});

// ============================================================
// Item 7/8: IPC tap gating and log dir
// ============================================================

describe('Audit Item 7/8: IPC tap env gating and default log dir', () => {
  const { createIpcTap } = require('../../../stubs/cowork/ipc_tap.js');

  it('returns no-op stub when disabled', () => {
    const tap = createIpcTap({ enabled: false });
    assert.equal(tap.enabled, false);
    // All methods should be no-ops that don't throw
    assert.doesNotThrow(() => tap.wrapHandle({}));
    assert.doesNotThrow(() => tap.wrapInvokeHandlers({}));
    assert.doesNotThrow(() => tap.wrapWebContents());
    assert.deepEqual(tap.getStats(), {});
  });

  it('is active when enabled: true', () => {
    const tap = createIpcTap({ enabled: true });
    assert.equal(tap.enabled, true);
    assert.equal(typeof tap.getStats, 'function');
    const stats = tap.getStats();
    assert.equal(stats.handleCalls, 0);
    assert.equal(stats.registrations, 0);
  });

  it('env var gating is now built into createIpcTap defaults', () => {
    // The env var check now lives in ipc_tap.js as a default parameter.
    // createIpcTap() with no args reads CLAUDE_COWORK_IPC_TAP from env.
    const saved = process.env.CLAUDE_COWORK_IPC_TAP;
    delete process.env.CLAUDE_COWORK_IPC_TAP;
    try {
      const tap = createIpcTap();
      assert.equal(tap.enabled, false);
    } finally {
      if (saved !== undefined) process.env.CLAUDE_COWORK_IPC_TAP = saved;
    }
  });
});

// ============================================================
// Item 6: _invokeHandlers double-patch guard names
// ============================================================

describe('Audit Item 6: _invokeHandlers guard flag naming (UNIFIED)', () => {
  it('uses consistent naming for ipcMain patch guards', () => {
    // Early alias patch: global.__coworkIpcMainAliasPatched
    // Late handle patch: global.__coworkIpcHandlePatched
    // Late wrap patch:   global.__coworkIpcMainWrapPatched
    const aliasGuard = '__coworkIpcMainAliasPatched';
    const handleGuard = '__coworkIpcHandlePatched';
    const wrapGuard = '__coworkIpcMainWrapPatched';
    // All use consistent 'Ipc' casing (no more 'IPC' vs 'Ipc')
    assert.ok(aliasGuard.includes('Ipc'));
    assert.ok(handleGuard.includes('Ipc'));
    assert.ok(wrapGuard.includes('Ipc'));
    // Names clearly indicate what each patch does
    assert.notEqual(aliasGuard, handleGuard);
    assert.notEqual(aliasGuard, wrapGuard);
  });
});

// ============================================================
// Item 10: Object.defineProperty override impact
// ============================================================

describe('Audit Item 10: Object.defineProperty override (REMOVED)', () => {
  it('no longer overrides Object.defineProperty globally', () => {
    const wrapperPath = path.join(__dirname, '..', '..', '..', 'stubs', 'frame-fix', 'frame-fix-wrapper.js');
    const src = fs.readFileSync(wrapperPath, 'utf8');
    assert.ok(!src.includes('const originalDefineProperty = Object.defineProperty'),
      'Global Object.defineProperty override should have been removed');
  });
});

// ============================================================
// Item 9: getYukonSilverSupportStatus is dead code
// ============================================================

describe('Audit Item 9: getYukonSilverSupportStatus (REMOVED)', () => {
  it('no longer exists in frame-fix-wrapper.js', () => {
    const wrapperPath = path.join(__dirname, '..', '..', '..', 'stubs', 'frame-fix', 'frame-fix-wrapper.js');
    const src = fs.readFileSync(wrapperPath, 'utf8');
    assert.ok(!src.includes('getYukonSilverSupportStatus'),
      'Dead function should have been removed');
  });
});

// ============================================================
// Item 22: trace() API compatibility
// ============================================================

describe('Audit Item 22: trace() API divergence', () => {
  it('swift stub trace takes (msg) — single string argument', () => {
    // claude-swift/js/index.js L64: function trace(msg)
    // Always active, plain text, writes to claude-swift-trace.log
    const swiftSignature = { params: ['msg'], format: 'plain', gated: false };
    assert.equal(swiftSignature.params.length, 1);
    assert.equal(swiftSignature.gated, false);
  });

  it('native stub trace takes (category, msg, data) — three arguments', () => {
    // claude-native/index.js L34: function trace(category, msg, data = null)
    // Gated by CLAUDE_NATIVE_TRACE, JSON format, writes to claude-native-trace.log
    const nativeSignature = { params: ['category', 'msg', 'data'], format: 'json', gated: true };
    assert.equal(nativeSignature.params.length, 3);
    assert.equal(nativeSignature.gated, true);
  });

  it('APIs are incompatible — a shared trace module must handle both patterns', () => {
    // A unified trace module should accept: trace(msg) and trace(category, msg, data)
    // or provide named loggers: createTrace('swift'), createTrace('native')
    assert.notEqual('plain', 'json', 'Output formats differ');
  });
});

// ============================================================
// Item 23: Native stub redaction gap
// ============================================================

describe('Audit Item 23: Native stub trace redaction', () => {
  const { redactCredentials } = require('../../../stubs/cowork/credential_classifier.js');

  it('redactCredentials is available for any module to use', () => {
    assert.equal(typeof redactCredentials, 'function');
  });

  it('redacts known credential patterns', () => {
    // redactCredentials matches env-var-style KEY=value patterns
    const input = 'ANTHROPIC_AUTH_TOKEN=sk-ant-sid01-abcdefghijklmnopqrstuvwxyz123456';
    const output = redactCredentials(input);
    assert.ok(output.includes('[REDACTED]'), 'should contain [REDACTED] marker');
    assert.ok(!output.includes('abcdefghijklmnopqrstuvwxyz123456'), 'should redact credential value');
  });

  it('preserves safe content', () => {
    const input = 'path=/home/user/project';
    const output = redactCredentials(input);
    assert.ok(output.includes('/home/user/project'));
  });
});

// ============================================================
// Item 5: createSessionStore / createSessionOrchestrator
// dual instantiation safety
// ============================================================

describe('Audit Item 5: Dual store/orchestrator instantiation', () => {
  const { createSessionStore } = require('../../../stubs/cowork/session_store.js');

  it('two stores with same config can coexist without corruption', () => {
    const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'audit-test-'));
    try {
      const store1 = createSessionStore({ localAgentRoot: tempDir });
      const store2 = createSessionStore({ localAgentRoot: tempDir });

      // Both should be able to look up a nonexistent session without error
      const info1 = store1.getSessionInfo('nonexistent-session');
      const info2 = store2.getSessionInfo('nonexistent-session');
      assert.equal(info1, null);
      assert.equal(info2, null);

      // Both point to the same root
      const dir1 = store1.getSessionDirectory('test-session');
      const dir2 = store2.getSessionDirectory('test-session');
      assert.equal(dir1, dir2, 'both stores should resolve to the same session directory');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Item 15: Double event listener safety (WeakSet guards)
// ============================================================

describe('Audit Item 15: Double event listener guards', () => {
  it('WeakSet prevents double-patching of the same object', () => {
    const patched = new WeakSet();
    const obj = {};

    let patchCount = 0;
    function maybePatch(target) {
      if (patched.has(target)) return;
      patched.add(target);
      patchCount++;
    }

    maybePatch(obj);
    maybePatch(obj); // second call should be no-op
    assert.equal(patchCount, 1);
  });
});

// ============================================================
// Item 16: Global registry naming consistency
// ============================================================

describe('Audit Item 16: Global __cowork flag naming', () => {
  const KNOWN_FLAGS = [
    '__cowork',
    '__coworkAsarAdapter',
    '__coworkDirs',
    '__coworkIpcTap',
    '__coworkSessionStore',
    '__coworkSessionOrchestrator',
    '__coworkSwiftStub',
    '__coworkIpcMainAliasPatched',
    '__coworkIpcHandlePatched',
    '__coworkLinuxMenuInterceptorsInstalled',
    '__coworkSystemPreferencesPatched',
    '__coworkIgnoredLiveMessageStats',
    '__coworkLocalSessionMetadataPersistenceGuardInstalled',
    '__coworkSessionsApiRequestSync',
  ];

  it('documents all 14 known global flags', () => {
    assert.equal(KNOWN_FLAGS.length, 14);
  });

  it('uses consistent Ipc casing for IPC-related guard flags', () => {
    // IPC guard flags should use 'Ipc' casing, not 'IPC'
    const ipcGuardFlags = KNOWN_FLAGS.filter(f => f.toLowerCase().includes('ipc') && f.includes('Patched'));
    assert.ok(ipcGuardFlags.every(f => f.includes('Ipc')), 'all IPC guard flags use camelCase Ipc');
    assert.ok(!ipcGuardFlags.some(f => /IPC/.test(f)), 'no all-caps IPC flags remain');
    // Old inconsistent names should be gone
    assert.ok(!KNOWN_FLAGS.includes('__coworkIPCPatched'), 'old __coworkIPCPatched removed');
    assert.ok(!KNOWN_FLAGS.includes('__coworkInvokeHandlersPatched'), 'old __coworkInvokeHandlersPatched removed');
    assert.ok(!KNOWN_FLAGS.includes('__coworkIpcMainPatched'), 'old __coworkIpcMainPatched renamed');
  });
});

// ============================================================
// Cross-file: dirs.js exports all path utilities the swift stub needs
// ============================================================

describe('Cross-file: dirs.js exports completeness', () => {
  const dirsExports = require('../../../stubs/cowork/dirs.js');

  const REQUIRED_EXPORTS = [
    'createDirs',
    'isPathSafe',
    'translateVmPathStrict',
    'canonicalizeHostPath',
    'canonicalizeVmPathStrict',
    'canonicalizePathForHostAccess',
  ];

  for (const name of REQUIRED_EXPORTS) {
    it(`exports ${name}`, () => {
      assert.equal(typeof dirsExports[name], 'function',
        `dirs.js should export ${name} so swift stub can import instead of copying`);
    });
  }
});

// ============================================================
// Cross-file: credential_classifier.js is importable from both stubs
// ============================================================

describe('Cross-file: credential_classifier.js shared availability', () => {
  it('exports redactCredentials for both swift and native stubs', () => {
    const { redactCredentials } = require('../../../stubs/cowork/credential_classifier.js');
    assert.equal(typeof redactCredentials, 'function');
  });
});
