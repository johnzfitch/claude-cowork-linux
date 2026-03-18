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

function redactCredentials(text) {
  // PRIVACY PROTECTION: Redact credentials from any text before logging.
  // This is the primary defense against credential leakage in logs and traces.
  //
  // Handles multiple formats:
  //   1. Environment variables: ANTHROPIC_API_KEY=sk-ant-123... → ANTHROPIC_API_KEY=[REDACTED]
  //   2. JSON objects: {"token": "eyJ..."} → {"token": "[REDACTED]"}
  //   3. HTTP headers: Authorization: Bearer sk-ant-123 → Authorization: Bearer [REDACTED]
  //   4. Bare tokens: sk-ant-sid123456... → [REDACTED]
  //
  // IMPORTANT: This function is called on ALL trace() and log() output to ensure
  // OAuth tokens never appear in logs (required by Anthropic Acceptable Use Policy).
  let result = String(text);
  
  // Pattern 1: Environment variable style (KEY=value)
  result = result.replace(/([A-Z_][A-Z0-9_]*=)([^\s&"]+)/g, (match, prefix, value) => {
    const key = prefix.slice(0, -1);
    if (classifyEnvEntry(key, value) !== 'safe') return prefix + '[REDACTED]';
    return match;
  });
  
  // Pattern 2: JSON style ("key": "value")
  result = result.replace(/("[^"]*"\s*:\s*")([^"]+)(")/g, (match, pre, value, post) => {
    const key = pre.match(/"([^"]*)"/)?.[1] || '';
    if (classifyEnvEntry(key, value) !== 'safe') return pre + '[REDACTED]' + post;
    return match;
  });
  
  // Pattern 3: HTTP Authorization and Cookie headers
  result = result.replace(/(Authorization:\s*(?:Bearer\s+|Basic\s+))([^\s\r\n]+)/gi, '$1[REDACTED]');
  result = result.replace(/(Cookie:\s*)([^\r\n]+)/gi, '$1[REDACTED]');
  
  // Pattern 4: Bare high-entropy tokens (last resort catch-all)
  result = result.replace(/\b([A-Za-z0-9_-]{32,})\b/g, (match) => {
    if (isLikelyCredentialValue(match)) return '[REDACTED]';
    return match;
  });
  
  return result;
}

module.exports = {
  HIGH_ENTROPY_THRESHOLD,
  MIN_SECRET_LENGTH,
  TOKEN_PREFIXES,
  classifyEnvEntry,
  isLikelyCredentialKey,
  isLikelyCredentialValue,
  redactCredentials,
  shannonEntropy,
};
