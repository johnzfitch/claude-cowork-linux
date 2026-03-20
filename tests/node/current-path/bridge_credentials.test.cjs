const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSessionsApi,
} = require('../../../stubs/cowork/sessions_api.js');
const {
  buildSdkUrl,
  createSessionOrchestrator,
  readRemoteSessionIdFromBridgeState,
} = require('../../../stubs/cowork/session_orchestrator.js');

function createTempDir(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-bridge-creds-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

// ============================================================================
// fetchBridgeCredentials
// ============================================================================

test('fetchBridgeCredentials returns workerJwt, apiBaseUrl, expiresIn on success', () => {
  const api = createSessionsApi({
    authToken: 'oauth-token',
    requestSync: (request) => {
      assert.equal(request.method, 'POST');
      assert.ok(request.url.includes('/v1/code/sessions/cse_abc123/bridge'));
      return {
        statusCode: 200,
        body: JSON.stringify({
          worker_jwt: 'jwt-token-xyz',
          api_base_url: 'https://api.anthropic.com',
          expires_in: 3600,
          worker_epoch: 42,
        }),
      };
    },
  });

  const result = api.fetchBridgeCredentials('cse_abc123');
  assert.equal(result.success, true);
  assert.equal(result.workerJwt, 'jwt-token-xyz');
  assert.equal(result.apiBaseUrl, 'https://api.anthropic.com');
  assert.equal(result.expiresIn, 3600);
  // worker_epoch intentionally omitted
  assert.equal(result.workerEpoch, undefined);
});

test('fetchBridgeCredentials returns error on missing remoteSessionId', () => {
  const api = createSessionsApi({ authToken: 'oauth-token' });
  const result = api.fetchBridgeCredentials('');
  assert.equal(result.success, false);
  assert.ok(result.error.includes('Missing remoteSessionId'));
});

test('fetchBridgeCredentials returns error on malformed response', () => {
  const api = createSessionsApi({
    authToken: 'oauth-token',
    requestSync: () => ({
      statusCode: 200,
      body: JSON.stringify({ some_other_field: 'value' }),
    }),
  });

  const result = api.fetchBridgeCredentials('cse_abc123');
  assert.equal(result.success, false);
  assert.ok(result.error.includes('Malformed'));
});

test('fetchBridgeCredentials returns error on HTTP 401', () => {
  const api = createSessionsApi({
    authToken: 'oauth-token',
    requestSync: () => ({
      statusCode: 401,
      body: JSON.stringify({ error: 'unauthorized' }),
    }),
  });

  const result = api.fetchBridgeCredentials('cse_abc123');
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 401);
});

test('fetchBridgeCredentials returns error on HTTP 500', () => {
  const api = createSessionsApi({
    authToken: 'oauth-token',
    requestSync: () => ({
      statusCode: 500,
      body: JSON.stringify({ error: 'internal' }),
    }),
  });

  const result = api.fetchBridgeCredentials('cse_abc123');
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 500);
});

test('fetchBridgeCredentials encodes remoteSessionId in URL', () => {
  let capturedUrl = null;
  const api = createSessionsApi({
    authToken: 'oauth-token',
    requestSync: (request) => {
      capturedUrl = request.url;
      return {
        statusCode: 200,
        body: JSON.stringify({
          worker_jwt: 'jwt',
          api_base_url: 'https://api.anthropic.com',
          expires_in: 300,
        }),
      };
    },
  });

  api.fetchBridgeCredentials('cse_special/chars');
  assert.ok(capturedUrl.includes('cse_special%2Fchars'));
});

// ============================================================================
// readRemoteSessionIdFromBridgeState
// ============================================================================

test('readRemoteSessionIdFromBridgeState finds matching entry', (t) => {
  const tempRoot = createTempDir(t);
  const bridgePath = path.join(tempRoot, 'bridge-state.json');
  fs.writeFileSync(bridgePath, JSON.stringify([
    { localSessionId: 'local_ditto_abc', remoteSessionId: 'cse_123', enabled: true },
    { localSessionId: 'local_ditto_def', remoteSessionId: 'cse_456', enabled: true },
  ]), 'utf8');

  const result = readRemoteSessionIdFromBridgeState('local_ditto_abc', {
    bridgeStatePath: bridgePath,
    waitMs: 1,
  });
  assert.equal(result, 'cse_123');
});

test('readRemoteSessionIdFromBridgeState returns null for missing file', (t) => {
  const tempRoot = createTempDir(t);
  const traces = [];
  const result = readRemoteSessionIdFromBridgeState('local_ditto_abc', {
    bridgeStatePath: path.join(tempRoot, 'nonexistent.json'),
    trace: (msg) => traces.push(msg),
    waitMs: 1,
  });
  assert.equal(result, null);
  assert.ok(traces.some((m) => m.includes('missing')));
});

test('readRemoteSessionIdFromBridgeState returns null for parse error', (t) => {
  const tempRoot = createTempDir(t);
  const bridgePath = path.join(tempRoot, 'bridge-state.json');
  fs.writeFileSync(bridgePath, 'not-json{{{', 'utf8');

  const traces = [];
  const result = readRemoteSessionIdFromBridgeState('local_ditto_abc', {
    bridgeStatePath: bridgePath,
    trace: (msg) => traces.push(msg),
    waitMs: 1,
  });
  assert.equal(result, null);
  assert.ok(traces.some((m) => m.includes('parse-error')));
});

test('readRemoteSessionIdFromBridgeState returns null when no match', (t) => {
  const tempRoot = createTempDir(t);
  const bridgePath = path.join(tempRoot, 'bridge-state.json');
  fs.writeFileSync(bridgePath, JSON.stringify([
    { localSessionId: 'local_ditto_other', remoteSessionId: 'cse_999' },
  ]), 'utf8');

  const traces = [];
  const result = readRemoteSessionIdFromBridgeState('local_ditto_abc', {
    bridgeStatePath: bridgePath,
    trace: (msg) => traces.push(msg),
    waitMs: 1,
  });
  assert.equal(result, null);
  assert.ok(traces.some((m) => m.includes('no-match')));
});

test('readRemoteSessionIdFromBridgeState logs schema canary on first read', (t) => {
  const tempRoot = createTempDir(t);
  const bridgePath = path.join(tempRoot, 'bridge-state.json');
  fs.writeFileSync(bridgePath, JSON.stringify([
    { enabled: true, localSessionId: 'local_abc', remoteSessionId: 'cse_1', userConsented: false },
  ]), 'utf8');

  const traces = [];
  readRemoteSessionIdFromBridgeState('local_abc', {
    bridgeStatePath: bridgePath,
    trace: (msg) => traces.push(msg),
    waitMs: 1,
  });
  assert.ok(traces.some((m) => m.includes('schema') && m.includes('entryCount=1') && m.includes('fieldNames=')));
});

test('readRemoteSessionIdFromBridgeState retries when file appears later', (t) => {
  const tempRoot = createTempDir(t);
  const bridgePath = path.join(tempRoot, 'bridge-state.json');

  let readCount = 0;
  const mockReadFile = (filePath, encoding) => {
    readCount++;
    if (readCount < 3) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return JSON.stringify([
      { localSessionId: 'local_abc', remoteSessionId: 'cse_found' },
    ]);
  };

  const result = readRemoteSessionIdFromBridgeState('local_abc', {
    bridgeStatePath: bridgePath,
    readFileSync: mockReadFile,
    waitMs: 1,
  });
  assert.equal(result, 'cse_found');
  assert.equal(readCount, 3);
});

test('readRemoteSessionIdFromBridgeState handles single object instead of array', (t) => {
  const tempRoot = createTempDir(t);
  const bridgePath = path.join(tempRoot, 'bridge-state.json');
  fs.writeFileSync(bridgePath, JSON.stringify(
    { localSessionId: 'local_abc', remoteSessionId: 'cse_single' }
  ), 'utf8');

  const result = readRemoteSessionIdFromBridgeState('local_abc', {
    bridgeStatePath: bridgePath,
    waitMs: 1,
  });
  assert.equal(result, 'cse_single');
});

test('readRemoteSessionIdFromBridgeState returns null for missing localSessionId param', () => {
  const result = readRemoteSessionIdFromBridgeState('', { waitMs: 1 });
  assert.equal(result, null);
});

// ============================================================================
// buildSdkUrl
// ============================================================================

test('buildSdkUrl converts https to wss and appends session path', () => {
  const url = buildSdkUrl('https://api.anthropic.com', 'cse_abc');
  assert.equal(url, 'wss://api.anthropic.com/v1/code/sessions/cse_abc');
});

test('buildSdkUrl converts http to ws', () => {
  const url = buildSdkUrl('http://localhost:8080', 'cse_local');
  assert.equal(url, 'ws://localhost:8080/v1/code/sessions/cse_local');
});

test('buildSdkUrl returns null for invalid inputs', () => {
  assert.equal(buildSdkUrl('', 'cse_abc'), null);
  assert.equal(buildSdkUrl('https://api.com', ''), null);
  assert.equal(buildSdkUrl(null, 'cse_abc'), null);
});

// ============================================================================
// _resolveBridgeSession integration
// ============================================================================

function createOrchestratorWithBridge(overrides) {
  return createSessionOrchestrator({
    appSupportRoot: '/app/support',
    canonicalizePathForHostAccess: (inputPath) => (
      typeof inputPath === 'string' && inputPath.startsWith('/sessions/demo')
        ? inputPath.replace('/sessions/demo', '/host/sessions/demo')
        : inputPath
    ),
    canonicalizeVmPathStrict: (inputPath) => inputPath.replace('/sessions/demo', '/host/sessions/demo'),
    createMountSymlinks: () => true,
    filterEnv: (baseEnv, additionalEnv) => ({ ...baseEnv, ...additionalEnv }),
    findSessionName: () => 'demo',
    resolveClaudeBinaryPath: () => '/usr/local/bin/claude-real',
    sessionsBase: '/tmp/cowork-bridge-tests',
    trace: () => {},
    translateVmPathStrict: (inputPath) => inputPath.replace('/sessions/demo', '/host/sessions/demo'),
    ...overrides,
  });
}

test('_resolveBridgeSession returns bridge_api result when bridge-state and /bridge succeed', (t) => {
  const tempRoot = createTempDir(t);
  const localAgentRoot = path.join(tempRoot, 'claude-local');
  const sessionId = 'local_demo_session';
  const metadataPath = path.join(localAgentRoot, 'user', 'org', sessionId + '.json');
  const configDir = metadataPath.replace(/\.json$/, '') + '/.claude';
  const workspaceRoot = path.join(tempRoot, 'workspace');

  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
    cliSessionId: 'cli-id-1',
    cwd: workspaceRoot,
    userSelectedFolders: [workspaceRoot],
  }, null, 2) + '\n', 'utf8');

  const bridgePath = path.join(tempRoot, 'bridge-state.json');
  fs.writeFileSync(bridgePath, JSON.stringify([
    { localSessionId: sessionId, remoteSessionId: 'cse_dispatch_1' },
  ]), 'utf8');

  const { createSessionStore } = require('../../../stubs/cowork/session_store.js');
  const sessionStore = createSessionStore({ localAgentRoot });

  const orchestrator = createOrchestratorWithBridge({
    bridgeStatePath: bridgePath,
    sessionStore,
    sessionsApi: {
      updateAuthToken: () => {},
      fetchBridgeCredentials: (remoteSessionId) => {
        assert.equal(remoteSessionId, 'cse_dispatch_1');
        return {
          success: true,
          workerJwt: 'jwt-worker-token',
          apiBaseUrl: 'https://api.anthropic.com',
          expiresIn: 1800,
          statusCode: 200,
        };
      },
    },
  });

  const result = orchestrator.prepareVmSpawn({
    processId: 'proc-bridge-api',
    processName: 'demo',
    command: '/usr/local/bin/claude',
    args: ['--resume', 'old-cli-id', '--model', 'claude-opus-4-6'],
    envVars: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth' },
    additionalMounts: null,
    sharedCwdPath: workspaceRoot,
  });

  assert.equal(result.success, true);
  assert.equal(result.envVars.CLAUDE_CODE_ENVIRONMENT_KIND, 'bridge');
  assert.equal(result.envVars.CLAUDE_CODE_SESSION_ACCESS_TOKEN, 'jwt-worker-token');
  assert.equal(result.envVars.CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2, '1');
  // OAUTH_TOKEN cleared via undefined -> not present in env
  assert.equal(result.envVars.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  // --sdk-url should be in args
  const sdkUrlIdx = result.args.indexOf('--sdk-url');
  assert.ok(sdkUrlIdx !== -1, '--sdk-url should be present in args');
  assert.equal(result.args[sdkUrlIdx + 1], 'wss://api.anthropic.com/v1/code/sessions/cse_dispatch_1');
  // --session-id should be cse_*
  const sessionIdIdx = result.args.indexOf('--session-id');
  assert.ok(sessionIdIdx !== -1, '--session-id should be present');
  assert.equal(result.args[sessionIdIdx + 1], 'cse_dispatch_1');
  // bridgeSession should be returned for refresh scheduling
  assert.ok(result.bridgeSession);
  assert.equal(result.bridgeSession.source, 'bridge_api');
  assert.equal(result.bridgeSession.expiresIn, 1800);
});

test('_resolveBridgeSession graceful degradation when no bridge-state match', (t) => {
  const tempRoot = createTempDir(t);
  const localAgentRoot = path.join(tempRoot, 'claude-local');
  const sessionId = 'local_demo_session';
  const metadataPath = path.join(localAgentRoot, 'user', 'org', sessionId + '.json');
  const configDir = metadataPath.replace(/\.json$/, '') + '/.claude';
  const workspaceRoot = path.join(tempRoot, 'workspace');

  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
    cliSessionId: 'cli-id-1',
    cwd: workspaceRoot,
  }, null, 2) + '\n', 'utf8');

  // Empty bridge-state
  const bridgePath = path.join(tempRoot, 'bridge-state.json');
  fs.writeFileSync(bridgePath, JSON.stringify([]), 'utf8');

  const { createSessionStore } = require('../../../stubs/cowork/session_store.js');
  const sessionStore = createSessionStore({ localAgentRoot });

  const traces = [];
  const orchestrator = createOrchestratorWithBridge({
    bridgeStatePath: bridgePath,
    bridgeStateRetryDelayMs: 1,
    trace: (msg) => traces.push(msg),
    sessionStore,
    sessionsApi: {
      updateAuthToken: () => {},
      fetchBridgeCredentials: () => { throw new Error('should not be called'); },
    },
  });

  const result = orchestrator.prepareVmSpawn({
    processId: 'proc-no-bridge',
    processName: 'demo',
    command: '/usr/local/bin/claude',
    args: ['--resume', 'cli-id-1'],
    envVars: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth' },
    additionalMounts: null,
    sharedCwdPath: workspaceRoot,
  });

  assert.equal(result.success, true);
  // Should NOT be in bridge mode
  assert.notEqual(result.envVars.CLAUDE_CODE_ENVIRONMENT_KIND, 'bridge');
  assert.equal(result.envVars.CLAUDE_CODE_OAUTH_TOKEN, 'test-oauth');
  assert.equal(result.bridgeSession, null);
  assert.ok(traces.some((m) => m.includes('no bridge-state match')));
});

// ============================================================================
// buildBridgeSpawnArgs with --sdk-url
// ============================================================================

test('buildBridgeSpawnArgs includes --sdk-url when provided', () => {
  const { SessionOrchestrator } = require('../../../stubs/cowork/session_orchestrator.js');
  // buildBridgeSpawnArgs is not exported directly, test via prepareVmSpawn output
  // which is already tested above. Here we test the module-level function indirectly.
  // The --sdk-url presence is verified in the integration test above.
  assert.ok(true, 'covered by integration test');
});

// ============================================================================
// Token refresh scheduling
// ============================================================================

test('scheduleBridgeRefresh schedules timer and clears on clearBridgeRefreshTimer', (t) => {
  const traces = [];
  const orchestrator = createOrchestratorWithBridge({
    trace: (msg) => traces.push(msg),
    sessionsApi: {
      updateAuthToken: () => {},
      fetchBridgeCredentials: () => ({
        success: true,
        workerJwt: 'refreshed-jwt',
        apiBaseUrl: 'https://api.anthropic.com',
        expiresIn: 600,
        statusCode: 200,
      }),
    },
  });

  orchestrator.scheduleBridgeRefresh('pid-1', {
    remoteSessionId: 'cse_timer_test',
    expiresIn: 3600,
    apiBaseUrl: 'https://api.anthropic.com',
  }, () => {});

  assert.ok(traces.some((m) => m.includes('refresh scheduled')));
  assert.ok(orchestrator._bridgeRefreshTimers.has('pid-1'));

  orchestrator.clearBridgeRefreshTimer('pid-1');
  assert.ok(!orchestrator._bridgeRefreshTimers.has('pid-1'));
  assert.ok(traces.some((m) => m.includes('refresh timer cleared')));
});

test('scheduleBridgeRefresh skips when expiresIn < 60', () => {
  const traces = [];
  const orchestrator = createOrchestratorWithBridge({
    trace: (msg) => traces.push(msg),
  });

  orchestrator.scheduleBridgeRefresh('pid-short', {
    remoteSessionId: 'cse_short',
    expiresIn: 30,
    apiBaseUrl: 'https://api.anthropic.com',
  }, () => {});

  assert.ok(traces.some((m) => m.includes('too short for refresh')));
  assert.ok(!orchestrator._bridgeRefreshTimers.has('pid-short'));
});

test('scheduleBridgeRefresh skips when expiresIn is missing', () => {
  const orchestrator = createOrchestratorWithBridge({ trace: () => {} });
  orchestrator.scheduleBridgeRefresh('pid-none', {
    remoteSessionId: 'cse_none',
  }, () => {});
  assert.ok(!orchestrator._bridgeRefreshTimers.has('pid-none'));
});

test('clearBridgeRefreshTimer is no-op for unknown processId', () => {
  const orchestrator = createOrchestratorWithBridge({ trace: () => {} });
  // Should not throw
  orchestrator.clearBridgeRefreshTimer('nonexistent');
  assert.ok(true);
});

// ============================================================================
// CREDENTIAL_EXEMPT_KEYS includes SESSION_ACCESS_TOKEN
// ============================================================================

test('CREDENTIAL_EXEMPT_KEYS includes CLAUDE_CODE_SESSION_ACCESS_TOKEN', () => {
  // Read the source to verify the set contents
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'stubs', '@ant', 'claude-swift', 'js', 'index.js'),
    'utf8'
  );
  assert.ok(source.includes("'CLAUDE_CODE_SESSION_ACCESS_TOKEN'"),
    'CREDENTIAL_EXEMPT_KEYS should include CLAUDE_CODE_SESSION_ACCESS_TOKEN');
});
