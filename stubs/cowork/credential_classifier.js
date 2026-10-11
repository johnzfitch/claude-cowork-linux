'use strict';

// ============================================================================
// CREDENTIAL CLASSIFIER
// ============================================================================
// This module protects user privacy by detecting and redacting credentials
// from logs, traces, and IPC messages. It's a critical security component
// that prevents accidental leakage of API keys, tokens, and passwords.
//
// PRIVACY PROTECTION:
//   - Redacts OAuth tokens before logging (complies with Anthropic AUP)
//   - Prevents API keys from appearing in debug output
//   - Protects session cookies and authentication headers
//
// DETECTION METHODS:
//   1. Known token prefixes (sk-ant-, eyJ, ghp_, etc.)
//   2. Shannon entropy analysis for high-randomness strings
//   3. Environment variable key patterns (TOKEN, SECRET, PASSWORD, etc.)
//   4. HTTP header patterns (Authorization, Cookie)
//
// Used throughout the codebase wherever logging or tracing occurs.

// Known token prefixes for various services
// These are used to quickly identify credentials without entropy analysis
const TOKEN_PREFIXES = [
  { prefix: 'sk-ant-sid',  label: 'anthropic-session-key' },
  { prefix: 'sk-ant-',     label: 'anthropic-api-key' },
  { prefix: 'clt-',        label: 'claude-token' },
  { prefix: 'eyJ',         label: 'jwt-base64' },
  { prefix: 'ghp_',        label: 'github-pat' },
  { prefix: 'ghs_',        label: 'github-server' },
  { prefix: 'gho_',        label: 'github-oauth' },
  { prefix: 'xoxb-',       label: 'slack-bot' },
  { prefix: 'xoxp-',       label: 'slack-user' },
  { prefix: 'AKIA',        label: 'aws-access-key' },
  { prefix: 'sk-proj-',    label: 'openai-project-key' },
];

// Entropy threshold for detecting high-randomness strings (likely secrets)
// Shannon entropy measures the randomness of a string - high entropy
// indicates a cryptographically random value (like an API key or token)
const HIGH_ENTROPY_THRESHOLD = 3.5;
const MIN_SECRET_LENGTH = 16;

function shannonEntropy(str) {
  // Calculate Shannon entropy to measure string randomness.
  // High entropy (>3.5) indicates a cryptographically random value.
  // 
  // Formula: H(X) = -Σ p(x) * log₂(p(x))
  // where p(x) is the probability of character x
  //
  // Example entropies:
  //   "aaaaaaaa" = 0 (no randomness)
  //   "abcdefgh" = 3.0 (some variety)
  //   "xK9mP2qL" = 3.8 (high randomness, likely a token)
  if (typeof str !== 'string' || str.length === 0) return 0;
  
  // Count character frequencies
  const freq = {};
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  
  // Calculate entropy
  const len = str.length;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isLikelyCredentialValue(value) {
  // Detect if a value looks like a credential based on:
  //   1. Known token prefixes (sk-ant-, eyJ, ghp_, etc.)
  //   2. High entropy + sufficient length (cryptographic randomness)
  if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return false;
  if (TOKEN_PREFIXES.some(t => value.startsWith(t.prefix))) return true;
  if (value.length >= 20 && shannonEntropy(value) >= HIGH_ENTROPY_THRESHOLD) return true;
  return false;
}

function isLikelyCredentialKey(key) {
  // Detect if an environment variable or object key name suggests credentials.
  // Looks for patterns like: TOKEN, SECRET, PASSWORD, API_KEY, etc.
  // Excludes safe environment variables like PATH, HOME, etc.
  if (typeof key !== 'string') return false;
  return /token|secret|key|credential|auth|password|cookie/i.test(key)
    && !/^(PATH|HOME|USER|SHELL|TERM|LANG|NODE_ENV)$/i.test(key);
}

function classifyEnvEntry(key, value) {
  // Classify an environment variable as safe, suspect, or credential.
  // Returns: 'credential' (definitely sensitive), 'suspect' (possibly sensitive), 'safe'
  //
  // Used to determine logging behavior:
  //   - 'credential': Always redact, log as [REDACTED]
  //   - 'suspect': Redact if suspicious key + non-trivial value
  //   - 'safe': Log as-is
  if (isLikelyCredentialValue(value)) return 'credential';
  if (isLikelyCredentialKey(key) && typeof value === 'string' && value.length > 8) return 'suspect';
  return 'safe';
}

// Fast pre-check regex: if none of these patterns appear, the string
// cannot contain credentials and we can skip all 4 replacement passes.
// This covers: known token prefixes, sensitive env var key names,
// Authorization/Cookie headers, and long alphanumeric runs (potential tokens).
// The trailing alternative lets Pattern 5 see URL parameters (code=, state=,
// sig=, ...) whose names contain none of the words before it.
const _FAST_CREDENTIAL_CHECK = /sk-ant-|clt-|eyJ|ghp_|ghs_|gho_|xox[bp]-|AKIA|sk-proj-|token|secret|key|credential|auth|password|cookie|Authorization|Cookie|[?&#](?:code|state|session|sig|signature)=/i;

function redactCredentials(text) {
  // PRIVACY PROTECTION: Redact credentials from any text before logging.
  // This is the primary defense against credential leakage in logs and traces.
  //
  // IMPORTANT: This function is called on ALL trace() and log() output to ensure
  // OAuth tokens never appear in logs (required by Anthropic Acceptable Use Policy).
  const result = String(text);

  // Fast path: skip all regex work if no sensitive patterns are present.
  // Most trace() calls are mundane log lines with no credentials.
  if (!_FAST_CREDENTIAL_CHECK.test(result)) return result;

  let out = result;

  // Pattern 1: Environment variable style (KEY=value)
  out = out.replace(/([A-Z_][A-Z0-9_]*=)([^\s&"]+)/g, (match, prefix, value) => {
    const key = prefix.slice(0, -1);
    if (classifyEnvEntry(key, value) !== 'safe') return prefix + '[REDACTED]';
    return match;
  });

  // Pattern 2: JSON style ("key": "value")
  out = out.replace(/("[^"]*"\s*:\s*")([^"]+)(")/g, (match, pre, value, post) => {
    const key = pre.match(/"([^"]*)"/)?.[1] || '';
    if (classifyEnvEntry(key, value) !== 'safe') return pre + '[REDACTED]' + post;
    return match;
  });

  // Pattern 3: HTTP Authorization and Cookie headers
  out = out.replace(/(Authorization:\s*(?:Bearer\s+|Basic\s+))([^\s\r\n]+)/gi, '$1[REDACTED]');
  out = out.replace(/(Cookie:\s*)([^\r\n]+)/gi, '$1[REDACTED]');

  // Pattern 4: Bare high-entropy tokens (last resort catch-all)
  out = out.replace(/\b([A-Za-z0-9_-]{32,})\b/g, (match) => {
    if (isLikelyCredentialValue(match)) return '[REDACTED]';
    return match;
  });

  // Pattern 5: credential-bearing URL parameters. An OAuth callback such as
  // claude://.../callback?code=AbCd1234&state=xyz carries a short-lived
  // authorization code that Patterns 1-4 all miss: the key is lowercase, the
  // value is short, and its entropy is unremarkable.
  out = out.replace(_URL_CREDENTIAL_PARAM, '$1[REDACTED]');

  return out;
}

// Query/fragment parameters whose values are credentials in OAuth and
// session flows. Matched only after ? & or #, so prose like "code=foo" is
// left alone.
const _URL_CREDENTIAL_PARAM = /([?&#](?:code|state|token|access_token|refresh_token|id_token|code_verifier|client_secret|session|session_key|sessionKey|auth|key|secret|password|signature|sig)=)([^&#\s"'`<>]+)/gi;

function redactUrl(url) {
  // Display form of a URL for logs: scheme, host and path survive; every
  // query and fragment VALUE is replaced, and parameter names are kept so a
  // log still says which callback arrived. Used for claude:// deep links,
  // whose query string is the OAuth authorization code and state. Anything
  // that does not parse as a URL is withheld rather than logged raw.
  if (typeof url !== 'string' || url.length === 0) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return '[unparseable URL withheld]';
  }
  let shown = parsed.protocol + '//' + parsed.host + parsed.pathname;
  if (parsed.search.length > 1) {
    // A parameter name is kept only when it has a value and looks like an
    // ordinary identifier. A bare "?AbCd1234" parses as a NAME with an empty
    // value, so trusting searchParams.keys() would log the secret as a name.
    const parts = parsed.search.slice(1).split('&').map((part) => {
      const eq = part.indexOf('=');
      const name = eq > 0 ? part.slice(0, eq) : '';
      return /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(name) ? name + '=[REDACTED]' : '[REDACTED]';
    });
    shown += '?' + parts.join('&');
  }
  if (parsed.hash) shown += '#[REDACTED]';
  return shown;
}

function redactHomeDir(text) {
  // Replace the user's home-directory prefix with '~' in log output so that
  // absolute paths don't leak the OS username. Desktop logs are routinely
  // pasted into public bug reports (see the issue templates), so keeping the
  // username out of them is basic PII hygiene. This is a display-only
  // transform — it never touches the paths used for filesystem operations.
  if (typeof text !== 'string' || text.length === 0) return text;
  let home = typeof global !== 'undefined' ? global.__coworkPasswdHomedir : undefined;
  if (typeof home !== 'string' || !home) {
    try {
      home = require('os').userInfo().homedir;
    } catch (_) {
      home = process.env.HOME || '';
    }
  }
  // Guard against an empty or root ('/') home, which would corrupt every path.
  if (typeof home !== 'string' || home.length < 2) return text;
  // Only rewrite `home` when it forms a complete path segment — i.e. it is
  // immediately followed by a path separator, ends the token, or is followed
  // by a delimiter. A plain substring replace would corrupt a different path
  // that merely shares the prefix (e.g. turn /home/bob2 into ~2 when
  // home=/home/bob).
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped + '(?=/|$|[\\s"\'`:,;)\\]}])', 'g'), '~');
}

module.exports = {
  classifyEnvEntry,
  isLikelyCredentialKey,
  isLikelyCredentialValue,
  redactCredentials,
  redactHomeDir,
  redactUrl,
  shannonEntropy,
};
