'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyMethod,
  isPlatformError,
  parseEipcChannel,
  SAFE_DEFAULTS,
} = require('../../../stubs/cowork/eipc_channel.js');

describe('parseEipcChannel', () => {
  it('extracts method from full EIPC channel', () => {
    const result = parseEipcChannel('$eipc_message$_abc123_$_claude.web_$_ClaudeCode_$_getStatus');
    assert.ok(result);
    assert.strictEqual(result.method, 'getStatus');
    assert.strictEqual(result.category, 'ClaudeCode');
    assert.strictEqual(result.namespace, 'claude.web');
  });

  it('handles minimal 3-segment channels', () => {
    const result = parseEipcChannel('prefix_$_ns_$_method');
    assert.ok(result);
    assert.strictEqual(result.method, 'method');
  });

  it('returns null for non-string input', () => {
    assert.strictEqual(parseEipcChannel(null), null);
    assert.strictEqual(parseEipcChannel(42), null);
  });

  it('returns null for insufficient segments', () => {
    assert.strictEqual(parseEipcChannel('only_$_two'), null);
    assert.strictEqual(parseEipcChannel('noseparators'), null);
  });
});

describe('classifyMethod', () => {
  it('maps getStatus to status', () => {
    assert.strictEqual(classifyMethod('getStatus'), 'status');
  });

  it('maps prepare to prepare', () => {
    assert.strictEqual(classifyMethod('prepare'), 'prepare');
  });

  it('maps isProcessRunning to process', () => {
    assert.strictEqual(classifyMethod('isProcessRunning'), 'process');
  });

  it('maps renamed variants: checkState to status', () => {
    assert.strictEqual(classifyMethod('getState'), 'status');
  });

  it('maps initialize to prepare', () => {
    assert.strictEqual(classifyMethod('initialize'), 'prepare');
  });

  it('maps requestAccess to access', () => {
    assert.strictEqual(classifyMethod('requestAccess'), 'access');
  });

  it('maps getAll to list', () => {
    assert.strictEqual(classifyMethod('getAll'), 'list');
  });

  it('returns unknown for unrecognized methods', () => {
    assert.strictEqual(classifyMethod('somethingRandom'), 'unknown');
  });

  it('returns unknown for non-string input', () => {
    assert.strictEqual(classifyMethod(null), 'unknown');
  });
});

describe('isPlatformError', () => {
  it('catches "Unsupported platform: linux-x64"', () => {
    assert.ok(isPlatformError(new Error('Unsupported platform: linux-x64')));
  });

  it('catches "No VM available"', () => {
    assert.ok(isPlatformError({ message: 'No VM available for this platform' }));
  });

  it('catches "darwin only"', () => {
    assert.ok(isPlatformError('This feature requires darwin'));
  });

  it('catches virtualization errors', () => {
    assert.ok(isPlatformError(new Error('Virtualization framework not available')));
  });

  it('does not match generic errors', () => {
    assert.ok(!isPlatformError(new Error('File not found')));
    assert.ok(!isPlatformError(new Error('Permission denied')));
  });

  it('handles null/undefined', () => {
    assert.ok(!isPlatformError(null));
    assert.ok(!isPlatformError(undefined));
  });
});

describe('SAFE_DEFAULTS', () => {
  it('has defaults for status shape', () => {
    assert.ok(SAFE_DEFAULTS.status);
    assert.strictEqual(SAFE_DEFAULTS.status.ready, true);
  });

  it('has defaults for prepare shape', () => {
    assert.ok(SAFE_DEFAULTS.prepare);
    assert.strictEqual(SAFE_DEFAULTS.prepare.success, true);
  });

  it('has defaults for process shape', () => {
    assert.ok(SAFE_DEFAULTS.process);
    assert.strictEqual(SAFE_DEFAULTS.process.running, false);
  });

  it('has array default for list shape', () => {
    assert.ok(Array.isArray(SAFE_DEFAULTS.list));
  });
});
