// SECURITY: Allowlist of base process environment variables to forward.
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  'NODE_ENV', 'ELECTRON_RUN_AS_NODE',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'
];

// SECURITY: Positive allowlist for additionalEnv keys from the renderer.
// Only keys in this set or matching ADDITIONAL_ENV_PREFIX_ALLOWLIST pass through.
const ADDITIONAL_ENV_ALLOWLIST = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'VERTEX_PROJECT',
  'VERTEX_REGION',
]);

// Prefix patterns for allowed additional env keys.
const ADDITIONAL_ENV_PREFIX_ALLOWLIST = [
  'CLAUDE_',
  'ANTHROPIC_',
];

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
      if (ADDITIONAL_ENV_ALLOWLIST.has(key)) {
        filtered[key] = val;
        continue;
      }
      if (ADDITIONAL_ENV_PREFIX_ALLOWLIST.some(p => key.startsWith(p))) {
        filtered[key] = val;
        continue;
      }
      log('SECURITY: filtered out additionalEnv key not in allowlist: ' + key);
    }
  }
  return filtered;
}

module.exports = {
  ENV_ALLOWLIST,
  ADDITIONAL_ENV_ALLOWLIST,
  ADDITIONAL_ENV_PREFIX_ALLOWLIST,
  filterEnv,
};
