const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  'NODE_ENV', 'ELECTRON_RUN_AS_NODE',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'
];

// Keys that must never be forwarded from additionalEnv to the subprocess.
// These enable loader injection or interpreter hijacking on Linux.
const DENIED_ENV_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'RUBYLIB',
  'PERL5OPT',
  'PERL5LIB',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
]);

// Pattern for OAuth/bearer credential keys that should not transit this layer
// (except for exempt keys the CLI legitimately needs).
const BLOCKED_CREDENTIAL_PATTERN = /oauth[_.]?token|bearer[_.]?token|session_?cookie|ANTHROPIC_AUTH_TOKEN/i;
const CREDENTIAL_EXEMPT_KEYS = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);

function filterEnv(baseEnv, additionalEnv, trace) {
  const log = typeof trace === 'function' ? trace : () => {};
  const filtered = {};
  for (const key of ENV_ALLOWLIST) {
    if (baseEnv[key] !== undefined) {
      filtered[key] = baseEnv[key];
    }
  }
  if (additionalEnv) {
    for (const [key, val] of Object.entries(additionalEnv)) {
      if (DENIED_ENV_KEYS.has(key)) {
        log('SECURITY: denied dangerous additionalEnv key: ' + key);
        continue;
      }
      if (BLOCKED_CREDENTIAL_PATTERN.test(key) && !CREDENTIAL_EXEMPT_KEYS.has(key)) {
        log('SECURITY: denied credential additionalEnv key: ' + key);
        continue;
      }
      filtered[key] = val;
    }
  }
  return filtered;
}

module.exports = {
  ENV_ALLOWLIST,
  DENIED_ENV_KEYS,
  CREDENTIAL_EXEMPT_KEYS,
  filterEnv,
};
