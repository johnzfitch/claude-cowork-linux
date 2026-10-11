// Environment for the spawned Claude Code CLI.
//
// Two sources, two rules:
//   - baseEnv is this process's own environment, i.e. the user's shell. Only
//     ENV_ALLOWLIST crosses, so a token or key the user exported for some
//     other tool does not reach the CLI.
//   - additionalEnv is the envVars Claude Desktop passes to vm.spawn(). On
//     macOS those go into the VM verbatim; here a key crosses if it is in
//     ADDITIONAL_ENV_ALLOWLIST or starts with an ADDITIONAL_ENV_PREFIX_ALLOWLIST
//     prefix. Anything else is dropped -- including loader and interpreter
//     hooks such as LD_PRELOAD or NODE_OPTIONS -- and its NAME (never its
//     value) is logged once, so a key a new bundle starts sending shows up in
//     startup.log instead of silently going missing.
//
// additionalEnv is applied after baseEnv, so a key the bundle sets to ""
// overrides an inherited one. The bundle relies on that: for first-party
// sessions it sends ANTHROPIC_API_KEY="" and ANTHROPIC_AUTH_TOKEN="" so a key
// in the user's shell cannot redirect the session's billing or identity.

const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  'NODE_ENV', 'ELECTRON_RUN_AS_NODE',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'
];

// Keys the bundle sends that the prefix rule below does not cover. Read off
// the session-env builders in asar 1.26832.0 (first-party, Vertex, Bedrock,
// Bedrock Mantle and Foundry providers, plus managed-settings policy keys);
// tests/node/current-path/env_bundle_contract.test.cjs pins the full set.
const ADDITIONAL_ENV_ALLOWLIST = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  // Session behaviour
  'API_TIMEOUT_MS',
  'MCP_CONNECTION_NONBLOCKING',
  'USE_STAGING_OAUTH',
  'USE_LOCAL_OAUTH',
  // Managed-settings policy (an organisation turning these off must reach the CLI)
  'DISABLE_AUTOUPDATER',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_FEEDBACK_COMMAND',
  'DISABLE_GROWTHBOOK',
  'DISABLE_TELEMETRY',
  'ENABLE_TOOL_SEARCH',
  // Amazon Bedrock
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  // Google Vertex AI
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'CLOUD_ML_REGION',
  'VERTEX_PROJECT',
  'VERTEX_REGION',
]);

// Prefix patterns for allowed additional env keys. OTEL_ carries an
// organisation's telemetry-export settings from managed configuration.
const ADDITIONAL_ENV_PREFIX_ALLOWLIST = [
  'CLAUDE_',
  'ANTHROPIC_',
  'OTEL_',
];

// Names already reported as dropped, so each appears in startup.log once per
// app run rather than once per spawn.
const _reportedDrops = new Set();

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
      log('filtered additionalEnv key: ' + key);
      if (!_reportedDrops.has(key)) {
        _reportedDrops.add(key);
        console.warn('[env-filter] dropped Claude Desktop env key not on the allowlist: ' + key);
      }
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
