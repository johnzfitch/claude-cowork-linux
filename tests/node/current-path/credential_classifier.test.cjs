'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyEnvEntry,
  isLikelyCredentialKey,
  isLikelyCredentialValue,
  redactCredentials,
  shannonEntropy,
} = require('../../../stubs/cowork/credential_classifier.js');

describe('shannonEntropy', () => {
  it('returns 0 for empty string', () => {
    assert.strictEqual(shannonEntropy(''), 0);
  });

  it('returns 0 for single-char string', () => {
    assert.strictEqual(shannonEntropy('aaaa'), 0);
  });

  it('returns 1 for two equally distributed chars', () => {
    const e = shannonEntropy('ab');
    assert.ok(Math.abs(e - 1.0) < 0.01, 'Expected ~1.0, got ' + e);
  });

  it('returns higher entropy for random-looking strings', () => {
    const high = shannonEntropy('aB3xZ9qW7mK2pR5');
    assert.ok(high > 3.0, 'Expected > 3.0, got ' + high);
  });
});

describe('isLikelyCredentialValue', () => {
  it('detects sk-ant-sid tokens', () => {
    assert.ok(isLikelyCredentialValue('sk-ant-sid01-xxxxxxxxxxxxxxxx'));
  });

  it('detects clt- tokens', () => {
    assert.ok(isLikelyCredentialValue('clt-abcdefghijklmnop'));
  });

  it('detects JWT tokens', () => {
    assert.ok(isLikelyCredentialValue('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
  });

  it('detects GitHub PATs', () => {
    assert.ok(isLikelyCredentialValue('ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));
  });

  it('detects AWS access keys', () => {
    assert.ok(isLikelyCredentialValue('AKIAIOSFODNN7EXAMPLE'));
  });

  it('returns false for short strings', () => {
    assert.ok(!isLikelyCredentialValue('short'));
  });

  it('returns false for standard UUIDs', () => {
    assert.ok(!isLikelyCredentialValue('550e8400-e29b-41d4-a716-446655440000'));
  });

  it('returns false for short file paths', () => {
    assert.ok(!isLikelyCredentialValue('/home/user/'));
  });

  it('returns false for version strings', () => {
    assert.ok(!isLikelyCredentialValue('3.0.7'));
  });

  it('returns false for typical Unix paths', () => {
    assert.ok(!isLikelyCredentialValue('/usr/local/bin'));
  });
});

describe('isLikelyCredentialKey', () => {
  it('detects token-related keys', () => {
    assert.ok(isLikelyCredentialKey('CLAUDE_CODE_OAUTH_TOKEN'));
    assert.ok(isLikelyCredentialKey('access_token'));
    assert.ok(isLikelyCredentialKey('API_KEY'));
    assert.ok(isLikelyCredentialKey('session_secret'));
  });

  it('does not flag standard env vars', () => {
    assert.ok(!isLikelyCredentialKey('PATH'));
    assert.ok(!isLikelyCredentialKey('HOME'));
    assert.ok(!isLikelyCredentialKey('TERM'));
    assert.ok(!isLikelyCredentialKey('NODE_ENV'));
  });
});

describe('classifyEnvEntry', () => {
  it('returns credential for known token values', () => {
    assert.strictEqual(classifyEnvEntry('ANYTHING', 'sk-ant-sid01-xxxxxxxxxxxxxxxx'), 'credential');
  });

  it('returns suspect for credential-like key with long value', () => {
    assert.strictEqual(classifyEnvEntry('MY_SECRET_KEY', 'some-value-here'), 'suspect');
  });

  it('returns safe for PATH', () => {
    assert.strictEqual(classifyEnvEntry('PATH', '/usr/local/bin:/usr/bin'), 'safe');
  });

  it('returns safe for HOME', () => {
    assert.strictEqual(classifyEnvEntry('HOME', '/home/zack'), 'safe');
  });

  it('returns safe for TERM', () => {
    assert.strictEqual(classifyEnvEntry('TERM', 'xterm-256color'), 'safe');
  });
});

describe('redactCredentials', () => {
  it('redacts env-var-style credentials', () => {
    const input = 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-sid01-xxxxxxxxxxxxxxxx';
    const result = redactCredentials(input);
    assert.ok(result.includes('[REDACTED]'), 'Should contain [REDACTED]');
    assert.ok(!result.includes('sk-ant-sid01'), 'Should not contain token');
  });

  it('redacts JSON-style credentials', () => {
    const input = '{"access_token": "clt-abcdefghijklmnop"}';
    const result = redactCredentials(input);
    assert.ok(result.includes('[REDACTED]'), 'Should contain [REDACTED]');
    assert.ok(!result.includes('clt-abcdefghij'), 'Should not contain token');
  });

  it('redacts Authorization headers', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const result = redactCredentials(input);
    assert.ok(result.includes('[REDACTED]'), 'Should contain [REDACTED]');
    assert.ok(!result.includes('eyJhbGci'), 'Should not contain token');
  });

  it('redacts Cookie headers', () => {
    const input = 'Cookie: sessionKey=sk-ant-sid01-xxxxxxxxxxxxxxxx';
    const result = redactCredentials(input);
    assert.ok(result.includes('[REDACTED]'), 'Should contain [REDACTED]');
  });

  it('does NOT redact normal UUIDs', () => {
    const input = 'session_id=550e8400-e29b-41d4-a716-446655440000';
    const result = redactCredentials(input);
    assert.ok(!result.includes('[REDACTED]'), 'Should NOT contain [REDACTED] for UUID');
  });

  it('does NOT redact simple file paths', () => {
    const input = 'PATH=/usr/bin:/bin';
    const result = redactCredentials(input);
    assert.ok(!result.includes('[REDACTED]'), 'Should NOT redact simple PATH');
  });

  it('has known limitation: long varied paths may be redacted', () => {
    // Known limitation: very long paths with high character diversity
    // (entropy > 3.5) can be false-flagged as credentials.
    // This is acceptable as it errs on the side of safety.
    const input = 'PATH=/usr/local/bin:/usr/bin:/home/user/.local/bin';
    const result = redactCredentials(input);
    // This is currently redacted - documenting known behavior
    assert.ok(result.includes('[REDACTED]'));
  });

  it('does NOT redact version strings', () => {
    const input = 'version=3.0.7-beta.1';
    const result = redactCredentials(input);
    assert.ok(!result.includes('[REDACTED]'));
  });
});
