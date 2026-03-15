'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractCliSessionId,
  getIgnoredSdkMessageType,
  hasAssistantResponse,
  isFlatlineResumeResult,
  isSuccessfulResult,
  parseJsonLine,
} = require('../../../stubs/cowork/stream_protocol.js');

describe('parseJsonLine', () => {
  it('parses valid JSON', () => {
    const result = parseJsonLine('{"type":"result"}');
    assert.deepStrictEqual(result, { type: 'result' });
  });

  it('returns null for invalid JSON', () => {
    assert.strictEqual(parseJsonLine('not json'), null);
  });

  it('returns null for non-string', () => {
    assert.strictEqual(parseJsonLine(null), null);
  });
});

describe('getIgnoredSdkMessageType', () => {
  it('detects queue-operation type', () => {
    const line = JSON.stringify({ type: 'queue-operation' });
    assert.strictEqual(getIgnoredSdkMessageType(line), 'queue-operation');
  });

  it('detects nested rate_limit_event', () => {
    const line = JSON.stringify({ type: 'message', message: { type: 'rate_limit_event' } });
    assert.strictEqual(getIgnoredSdkMessageType(line), 'rate_limit_event');
  });

  it('returns null for assistant messages', () => {
    const line = JSON.stringify({ type: 'assistant' });
    assert.strictEqual(getIgnoredSdkMessageType(line), null);
  });
});

describe('hasAssistantResponse', () => {
  it('detects stream_event', () => {
    assert.ok(hasAssistantResponse({ type: 'stream_event' }));
  });

  it('detects result with turns', () => {
    assert.ok(hasAssistantResponse({ type: 'result', num_turns: 1 }));
  });

  it('rejects null', () => {
    assert.ok(!hasAssistantResponse(null));
  });
});

describe('isFlatlineResumeResult', () => {
  it('detects flatline', () => {
    assert.ok(isFlatlineResumeResult({ type: 'result', is_error: true, num_turns: 0 }));
  });

  it('rejects successful results', () => {
    assert.ok(!isFlatlineResumeResult({ type: 'result', is_error: false, num_turns: 1 }));
  });
});

describe('isSuccessfulResult', () => {
  it('detects success subtype', () => {
    assert.ok(isSuccessfulResult({ type: 'result', subtype: 'success' }));
  });

  it('detects result with turns', () => {
    assert.ok(isSuccessfulResult({ type: 'result', num_turns: 3 }));
  });

  it('rejects error results', () => {
    assert.ok(!isSuccessfulResult({ type: 'result', is_error: true }));
  });
});

describe('extractCliSessionId', () => {
  it('extracts from direct session_id', () => {
    assert.strictEqual(extractCliSessionId({ session_id: 'abc-123' }), 'abc-123');
  });

  it('extracts from event.session_id', () => {
    assert.strictEqual(extractCliSessionId({ event: { session_id: 'xyz-789' } }), 'xyz-789');
  });

  it('extracts from message.sessionId', () => {
    assert.strictEqual(extractCliSessionId({ message: { sessionId: 'msg-456' } }), 'msg-456');
  });

  it('returns null for no session id', () => {
    assert.strictEqual(extractCliSessionId({ type: 'result' }), null);
  });

  it('returns null for null input', () => {
    assert.strictEqual(extractCliSessionId(null), null);
  });
});
