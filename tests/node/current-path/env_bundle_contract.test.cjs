'use strict';

// What Claude Desktop puts in vm.spawn()'s envVars, and what filterEnv must do
// with it. The key sets below were read off the session-env builders in asar
// 1.26832.0 (the build COMPAT.md pins): the first-party builder, the
// managed-settings policy keys it merges in, and each third-party provider's
// sessionEnvVars(). On macOS these reach the CLI verbatim inside the VM.
//
// Before this test, filterEnv dropped Vertex's CLOUD_ML_REGION and
// GOOGLE_CLOUD_PROJECT, Bedrock's AWS_BEARER_TOKEN_BEDROCK / AWS_PROFILE /
// AWS_CONFIG_FILE, the session's API_TIMEOUT_MS and MCP_CONNECTION_NONBLOCKING,
// and an organisation's DISABLE_TELEMETRY / DISABLE_ERROR_REPORTING policy --
// none of which matched the CLAUDE_/ANTHROPIC_ prefix rule.

const test = require('node:test');
const assert = require('node:assert/strict');

const { filterEnv } = require('../../../stubs/cowork/env_filter.js');

const BUNDLE_SESSION_KEYS = {
  firstParty: [
    'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_BASE_URL', 'USE_STAGING_OAUTH', 'USE_LOCAL_OAUTH',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_SUBSCRIPTION_TYPE',
    'CLAUDE_CODE_RATE_LIMIT_TIER', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL', 'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
    'MCP_CONNECTION_NONBLOCKING', 'API_TIMEOUT_MS', 'CLAUDE_CODE_DISABLE_CRON',
    'CLAUDE_CODE_ATTRIBUTION_HEADER', 'CLAUDE_CODE_HOST_CREDS_FILE',
  ],
  managedSettings: [
    'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL',
    'CLAUDE_CODE_ENABLE_AUTO_MODE', 'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
    'DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING', 'DISABLE_FEEDBACK_COMMAND',
    'DISABLE_GROWTHBOOK', 'DISABLE_TELEMETRY', 'ENABLE_TOOL_SEARCH', 'OTEL_TRACES_EXPORTER',
  ],
  gateway: [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ],
  vertex: [
    'ANTHROPIC_VERTEX_PROJECT_ID', 'GOOGLE_CLOUD_PROJECT', 'CLOUD_ML_REGION',
    'ANTHROPIC_VERTEX_BASE_URL', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
    'CLAUDE_CODE_USE_VERTEX',
  ],
  bedrock: [
    'AWS_REGION', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_BEDROCK_SERVICE_TIER',
    'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'CLAUDE_CODE_USE_BEDROCK',
  ],
  bedrockMantle: ['ANTHROPIC_BEDROCK_MANTLE_BASE_URL'],
  foundry: [
    'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_API_KEY',
    'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_BASE_URL',
  ],
};

for (const [builder, keys] of Object.entries(BUNDLE_SESSION_KEYS)) {
  test(`filterEnv forwards every key the ${builder} session builder sends`, () => {
    const input = Object.fromEntries(keys.map((k) => [k, 'v-' + k]));
    const out = filterEnv({}, input);
    const dropped = keys.filter((k) => out[k] !== 'v-' + k);
    assert.deepEqual(dropped, [], 'dropped: ' + dropped.join(', '));
  });
}

test('a bundle "" clears a credential the user exported in their shell', () => {
  // First-party sessions send ANTHROPIC_API_KEY="" so a key in the user's
  // shell cannot switch the session onto API billing.
  const out = filterEnv({ ANTHROPIC_API_KEY: 'sk-ant-from-shell' }, { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' });
  assert.equal(out.ANTHROPIC_API_KEY, '');
  assert.equal(out.ANTHROPIC_AUTH_TOKEN, '');
});

test('ANTHROPIC_AUTH_TOKEN reaches the CLI only when the bundle sets it', () => {
  // Bearer-scheme credentials (gateways, sk-ant-oat keys) are sent this way.
  assert.equal(filterEnv({}, { ANTHROPIC_AUTH_TOKEN: 'bearer-cred' }).ANTHROPIC_AUTH_TOKEN, 'bearer-cred');
  // The same variable in the user's shell is not inherited.
  assert.equal(filterEnv({ ANTHROPIC_AUTH_TOKEN: 'shell-cred' }, {}).ANTHROPIC_AUTH_TOKEN, undefined);
});

test('a dropped key is reported by name, once, never with its value', (t) => {
  const warned = [];
  t.mock.method(console, 'warn', (...args) => warned.push(args.join(' ')));
  const key = 'NOT_ON_ANY_LIST_' + process.pid;
  filterEnv({}, { [key]: 'secret-value-123' });
  filterEnv({}, { [key]: 'secret-value-123' });
  const mine = warned.filter((w) => w.includes(key));
  assert.equal(mine.length, 1);
  assert.ok(!mine[0].includes('secret-value-123'));
});
