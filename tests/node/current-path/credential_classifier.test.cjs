'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyEnvEntry,
  isLikelyCredentialKey,
  isLikelyCredentialValue,
  redactCredentials,
  redactHomeDir,
  redactUrl,
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

  it('does NOT redact long PATH values (fixed false positive)', () => {
    // Previously a known limitation: long paths with high character diversity
    // were false-flagged as credentials. Fixed by fast-path check that skips
    // regex passes when no sensitive patterns are present.
    const input = 'PATH=/usr/local/bin:/usr/bin:/home/user/.local/bin';
    const result = redactCredentials(input);
    assert.ok(!result.includes('[REDACTED]'), 'Should NOT redact PATH values');
  });

  it('does NOT redact version strings', () => {
    const input = 'version=3.0.7-beta.1';
    const result = redactCredentials(input);
    assert.ok(!result.includes('[REDACTED]'));
  });
});

describe('redactHomeDir', () => {
  const HOME = '/home/testuser';
  let prevHome;

  // Pin the home directory via the global the wrapper sets, so the result is
  // deterministic regardless of the machine running the tests.
  function withHome(home, fn) {
    prevHome = global.__coworkPasswdHomedir;
    global.__coworkPasswdHomedir = home;
    try {
      return fn();
    } finally {
      global.__coworkPasswdHomedir = prevHome;
    }
  }

  it('replaces the home-directory prefix with ~', () => {
    withHome(HOME, () => {
      assert.equal(
        redactHomeDir('logging to /home/testuser/.local/state/claude-cowork/logs'),
        'logging to ~/.local/state/claude-cowork/logs'
      );
    });
  });

  it('replaces every occurrence in the string', () => {
    withHome(HOME, () => {
      assert.equal(
        redactHomeDir('/home/testuser/a and /home/testuser/b'),
        '~/a and ~/b'
      );
    });
  });

  it('leaves paths outside the home directory untouched', () => {
    withHome(HOME, () => {
      assert.equal(redactHomeDir('/usr/bin/claude'), '/usr/bin/claude');
    });
  });

  it('does NOT rewrite a different dir that shares the home prefix', () => {
    // Regression: a plain substring replace would turn /home/testuser2/a
    // into ~2/a. Only a complete path segment should be rewritten.
    withHome(HOME, () => {
      assert.equal(redactHomeDir('/home/testuser2/a'), '/home/testuser2/a');
      assert.equal(redactHomeDir('/home/testuserX'), '/home/testuserX');
    });
  });

  it('rewrites the home path when it is the entire token', () => {
    withHome(HOME, () => {
      assert.equal(redactHomeDir('/home/testuser'), '~');
      assert.equal(redactHomeDir('cwd=/home/testuser done'), 'cwd=~ done');
    });
  });

  it('returns non-string / empty input unchanged', () => {
    withHome(HOME, () => {
      assert.equal(redactHomeDir(''), '');
      assert.equal(redactHomeDir(null), null);
      assert.equal(redactHomeDir(42), 42);
    });
  });

  it('does not corrupt paths when home is root or empty', () => {
    withHome('/', () => {
      assert.equal(redactHomeDir('/usr/bin/claude'), '/usr/bin/claude');
    });
    withHome('', () => {
      assert.equal(redactHomeDir('/usr/bin/claude'), '/usr/bin/claude');
    });
  });
});

describe('redactUrl', () => {
  it('keeps scheme, host, path and parameter names; drops every value', () => {
    assert.equal(
      redactUrl('claude://claude.ai/login/callback?code=AbCdEf123456&state=xyz#frag'),
      'claude://claude.ai/login/callback?code=[REDACTED]&state=[REDACTED]#[REDACTED]',
    );
  });

  it('leaves a URL with no query or fragment as it was', () => {
    assert.equal(redactUrl('claude://open'), 'claude://open');
  });

  it('redacts a query that has no name=value pairs', () => {
    assert.equal(redactUrl('claude://x/cb?AbCdEf123456'), 'claude://x/cb?[REDACTED]');
  });

  it('withholds anything that does not parse, rather than logging it', () => {
    assert.equal(redactUrl('claude:// %%%?code=secret'), '[unparseable URL withheld]');
    assert.equal(redactUrl(''), '');
    assert.equal(redactUrl(undefined), '');
  });
});

describe('redactCredentials URL parameters', () => {
  it('redacts an OAuth code and state embedded in a log line', () => {
    const out = redactCredentials('[SingleInstance] forwarding claude://x/cb?code=AbCdEf123456&state=xyz done');
    assert.ok(!out.includes('AbCdEf123456'));
    assert.ok(!out.includes('state=xyz'));
    assert.ok(out.includes('code=[REDACTED]'));
  });

  it('redacts credential-named parameters in ordinary URLs and keeps the rest', () => {
    const out = redactCredentials('see https://example.com/docs?page=2&key=abc123');
    assert.equal(out, 'see https://example.com/docs?page=2&key=[REDACTED]');
  });

  it('leaves prose that merely contains name=value alone', () => {
    assert.equal(redactCredentials('the code=foo in prose stays'), 'the code=foo in prose stays');
  });
});
