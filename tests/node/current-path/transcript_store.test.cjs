const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getTranscriptProjectKeyCandidates,
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
