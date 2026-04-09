const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getTranscriptProjectKeyCandidates,
  isConversationBearingMessage,
  getTranscriptMessageType,
  parseTranscriptLine,
  sanitizeTranscriptProjectKey,
} = require('../../../stubs/cowork/transcript_store.js');

test('sanitizeTranscriptProjectKey no longer collides for structurally different paths', () => {
  assert.notEqual(
    sanitizeTranscriptProjectKey('/tmp/a-b'),
    sanitizeTranscriptProjectKey('/tmp/a/b'),
  );
});

test('getTranscriptProjectKeyCandidates includes both b64 and legacy keys', () => {
  const keys = getTranscriptProjectKeyCandidates('/home/zack/dev/project');
  assert.ok(keys.length >= 1);
  assert.ok(keys[0].startsWith('b64-'));
});

test('sanitizeTranscriptProjectKey returns null for empty input', () => {
  assert.equal(sanitizeTranscriptProjectKey(''), null);
  assert.equal(sanitizeTranscriptProjectKey(null), null);
  assert.equal(sanitizeTranscriptProjectKey(undefined), null);
});

// ============================================================================
// parseTranscriptLine
// ============================================================================

test('parseTranscriptLine parses valid JSON', () => {
  const result = parseTranscriptLine('{"type":"user","message":"hello"}');
  assert.deepEqual(result, { type: 'user', message: 'hello' });
});

test('parseTranscriptLine returns null for invalid JSON', () => {
  assert.equal(parseTranscriptLine('{not json}'), null);
});

test('parseTranscriptLine returns null for empty string', () => {
  assert.equal(parseTranscriptLine(''), null);
});

test('parseTranscriptLine returns null for whitespace-only', () => {
  assert.equal(parseTranscriptLine('   '), null);
});

test('parseTranscriptLine returns null for null and undefined', () => {
  assert.equal(parseTranscriptLine(null), null);
  assert.equal(parseTranscriptLine(undefined), null);
});

// ============================================================================
// getTranscriptMessageType
// ============================================================================

test('getTranscriptMessageType returns type from message.type', () => {
  assert.equal(getTranscriptMessageType({ type: 'user' }), 'user');
});

test('getTranscriptMessageType returns type from nested message.message.type', () => {
  assert.equal(getTranscriptMessageType({ message: { type: 'assistant' } }), 'assistant');
});

test('getTranscriptMessageType returns null for non-object', () => {
  assert.equal(getTranscriptMessageType('string'), null);
  assert.equal(getTranscriptMessageType(42), null);
  assert.equal(getTranscriptMessageType(null), null);
});

test('getTranscriptMessageType returns null for empty object', () => {
  assert.equal(getTranscriptMessageType({}), null);
});

// ============================================================================
// isConversationBearingMessage
// ============================================================================

test('isConversationBearingMessage returns true for user messages', () => {
  assert.equal(isConversationBearingMessage({ type: 'user' }), true);
});

test('isConversationBearingMessage returns true for assistant messages', () => {
  assert.equal(isConversationBearingMessage({ type: 'assistant' }), true);
});

test('isConversationBearingMessage returns true for tool_use messages', () => {
  assert.equal(isConversationBearingMessage({ type: 'tool_use' }), true);
});

test('isConversationBearingMessage returns true for tool_result messages', () => {
  assert.equal(isConversationBearingMessage({ type: 'tool_result' }), true);
});

test('isConversationBearingMessage returns true for nested message type with role assistant', () => {
  assert.equal(isConversationBearingMessage({ type: 'message', message: { type: 'message', role: 'assistant' } }), true);
});

test('isConversationBearingMessage returns false for queue-operation (metadata)', () => {
  assert.equal(isConversationBearingMessage({ type: 'queue-operation' }), false);
});

test('isConversationBearingMessage returns false for progress (metadata)', () => {
  assert.equal(isConversationBearingMessage({ type: 'progress' }), false);
});

test('isConversationBearingMessage returns false for null and undefined', () => {
  assert.equal(isConversationBearingMessage(null), false);
  assert.equal(isConversationBearingMessage(undefined), false);
});
