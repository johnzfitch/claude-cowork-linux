'use strict';

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

const HIGH_ENTROPY_THRESHOLD = 3.5;
const MIN_SECRET_LENGTH = 16;

function shannonEntropy(str) {
  if (typeof str !== 'string' || str.length === 0) return 0;
  const freq = {};
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  const len = str.length;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isLikelyCredentialValue(value) {
  if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return false;
  if (TOKEN_PREFIXES.some(t => value.startsWith(t.prefix))) return true;
  if (value.length >= 20 && shannonEntropy(value) >= HIGH_ENTROPY_THRESHOLD) return true;
  return false;
}

function isLikelyCredentialKey(key) {
  if (typeof key !== 'string') return false;
  return /token|secret|key|credential|auth|password|cookie/i.test(key)
    && !/^(PATH|HOME|USER|SHELL|TERM|LANG|NODE_ENV)$/i.test(key);
}

function classifyEnvEntry(key, value) {
  if (isLikelyCredentialValue(value)) return 'credential';
  if (isLikelyCredentialKey(key) && typeof value === 'string' && value.length > 8) return 'suspect';
  return 'safe';
}

function redactCredentials(text) {
  let result = String(text);
  // 1. Env-var-style: KEY=value
  result = result.replace(/([A-Z_][A-Z0-9_]*=)([^\s&"]+)/g, (match, prefix, value) => {
    const key = prefix.slice(0, -1);
    if (classifyEnvEntry(key, value) !== 'safe') return prefix + '[REDACTED]';
    return match;
  });
  // 2. JSON-style: "key": "value"
  result = result.replace(/("[^"]*"\s*:\s*")([^"]+)(")/g, (match, pre, value, post) => {
    const key = pre.match(/"([^"]*)"/)?.[1] || '';
    if (classifyEnvEntry(key, value) !== 'safe') return pre + '[REDACTED]' + post;
    return match;
  });
  // 3. HTTP headers
  result = result.replace(/(Authorization:\s*(?:Bearer\s+|Basic\s+))([^\s\r\n]+)/gi, '$1[REDACTED]');
  result = result.replace(/(Cookie:\s*)([^\r\n]+)/gi, '$1[REDACTED]');
  // 4. Bare high-entropy tokens
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
