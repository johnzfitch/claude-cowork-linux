'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIpcTap,
  safeSerialize,
  truncatePayload,
} = require('../../../stubs/cowork/ipc_tap.js');

describe('truncatePayload', () => {
  it('returns short strings unchanged', () => {
    assert.strictEqual(truncatePayload('hello'), 'hello');
  });

  it('truncates strings over MAX_PAYLOAD_LENGTH', () => {
    const long = 'x'.repeat(5000);
    const result = truncatePayload(long);
    assert.ok(result.length < long.length);
    assert.ok(result.includes('[truncated'));
  });

  it('serializes objects to JSON', () => {
    const result = truncatePayload({ key: 'value' });
    assert.strictEqual(result, '{"key":"value"}');
  });

  it('returns undefined for undefined', () => {
    assert.strictEqual(truncatePayload(undefined), undefined);
  });
});

describe('safeSerialize', () => {
  it('redacts credential values', () => {
    const result = safeSerialize({ token: 'sk-ant-sid01-xxxxxxxxxxxxxxxx' });
    assert.ok(!result.includes('sk-ant-sid01'), 'Should redact token prefix');
  });

  it('handles unserializable values', () => {
    const circular = {};
    circular.self = circular;
    const result = safeSerialize(circular);
    assert.strictEqual(result, '[unserializable]');
  });

  it('preserves safe values', () => {
    const result = safeSerialize({ path: '/home/user/project' });
    assert.ok(result.includes('/home/user/project'));
  });
});

describe('createIpcTap disabled', () => {
  it('returns no-op tap when disabled', () => {
    const tap = createIpcTap({ enabled: false });
    assert.strictEqual(tap.enabled, false);
    assert.deepStrictEqual(tap.getStats(), {});
  });
});

describe('createIpcTap enabled', () => {
  it('tracks handler registrations and invocations', async () => {
    const tap = createIpcTap({ enabled: true });
    assert.strictEqual(tap.enabled, true);

    // Simulate ipcMain with a handle method
    const handlers = new Map();
    const mockIpcMain = {
      handle: function(channel, handler) {
        handlers.set(channel, handler);
      },
    };

    tap.wrapHandle(mockIpcMain);

    // Register a handler via the wrapped ipcMain
    mockIpcMain.handle('test_$_ns_$_Cat_$_getStatus', async () => {
      return { status: 'ready' };
    });

    const stats = tap.getStats();
    assert.strictEqual(stats.registrations, 1);

    // Invoke the handler
    const handler = handlers.get('test_$_ns_$_Cat_$_getStatus');
    const result = await handler({}, 'arg1');
    assert.deepStrictEqual(result, { status: 'ready' });

    const statsAfter = tap.getStats();
    assert.strictEqual(statsAfter.handleCalls, 1);
    assert.strictEqual(statsAfter.handleErrors, 0);
  });

  it('records platform errors in stats', async () => {
    const tap = createIpcTap({ enabled: true });
    const handlers = new Map();
    const mockIpcMain = {
      handle: function(channel, handler) {
        handlers.set(channel, handler);
      },
    };

    tap.wrapHandle(mockIpcMain);

    mockIpcMain.handle('test_$_ns_$_VM_$_getStatus', async () => {
      throw new Error('Unsupported platform: linux-x64');
    });

    const handler = handlers.get('test_$_ns_$_VM_$_getStatus');
    await assert.rejects(() => handler({}), /Unsupported platform/);

    const stats = tap.getStats();
    assert.strictEqual(stats.handleErrors, 1);
    assert.strictEqual(stats.platformErrors, 1);
    assert.ok(stats.channels['test_$_ns_$_VM_$_getStatus']);
    assert.strictEqual(stats.channels['test_$_ns_$_VM_$_getStatus'].platformErrorCount, 1);
  });

  it('tracks webContents.send calls', () => {
    const tap = createIpcTap({ enabled: true });
    const sent = [];
    const mockContents = {
      send: function(channel, ...args) {
        sent.push({ channel, args });
      },
    };

    tap.wrapWebContents(mockContents);
    mockContents.send('test-channel', { data: 'hello' });

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].channel, 'test-channel');

    const stats = tap.getStats();
    assert.strictEqual(stats.sendCalls, 1);
  });

  it('does not double-wrap webContents', () => {
    const tap = createIpcTap({ enabled: true });
    let callCount = 0;
    const mockContents = {
      send: function() { callCount += 1; },
    };

    tap.wrapWebContents(mockContents);
    tap.wrapWebContents(mockContents); // second wrap should be no-op
    mockContents.send('ch', {});

    // If double-wrapped, callCount would be 2+ from nested wraps
    assert.strictEqual(callCount, 1);
  });

  it('wraps _invokeHandlers Map for EIPC channels', async () => {
    const tap = createIpcTap({ enabled: true });
    const map = new Map();
    const mockInvokeHandlers = {
      set: (ch, h) => map.set(ch, h),
      get: (ch) => map.get(ch),
    };

    tap.wrapInvokeHandlers(mockInvokeHandlers);

    // Register via set (as the asar does)
    mockInvokeHandlers.set('$eipc$_uuid_$_ns_$_ClaudeVM_$_getStatus', async () => {
      throw new Error('Unsupported platform: linux-x64');
    });

    const stats = tap.getStats();
    assert.strictEqual(stats.registrations, 1);

    // Invoke the wrapped handler
    const handler = map.get('$eipc$_uuid_$_ns_$_ClaudeVM_$_getStatus');
    await assert.rejects(() => handler({}), /Unsupported platform/);

    const statsAfter = tap.getStats();
    assert.strictEqual(statsAfter.handleErrors, 1);
    assert.strictEqual(statsAfter.platformErrors, 1);
    const chStats = statsAfter.channels['$eipc$_uuid_$_ns_$_ClaudeVM_$_getStatus'];
    assert.ok(chStats);
    assert.strictEqual(chStats.platformErrorCount, 1);
    assert.strictEqual(chStats.method, 'getStatus');
    assert.strictEqual(chStats.shape, 'status');
  });

  it('parses EIPC channels and classifies methods', async () => {
    const tap = createIpcTap({ enabled: true });
    const handlers = new Map();
    const mockIpcMain = {
      handle: function(channel, handler) {
        handlers.set(channel, handler);
      },
    };

    tap.wrapHandle(mockIpcMain);
    const channelName = '$eipc_message$_uuid_$_claude.web_$_ClaudeCode_$_getStatus';
    mockIpcMain.handle(channelName, async () => 'ok');

    // Channel stats are populated after invocation, not just registration
    const handler = handlers.get(channelName);
    await handler({});

    const stats = tap.getStats();
    const channelStats = stats.channels[channelName];
    assert.ok(channelStats);
    assert.strictEqual(channelStats.method, 'getStatus');
    assert.strictEqual(channelStats.category, 'ClaudeCode');
    assert.strictEqual(channelStats.shape, 'status');
  });
});
