const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
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
// readRemoteSessionIdFromBridgeState
// ============================================================================

test('readRemoteSessionIdFromBridgeState finds first cse_* entry in dict-keyed file', (t) => {
  const tempRoot = createTempDir(t);
  const bridgePath = path.join(tempRoot, 'bridge-state.json');
  fs.writeFileSync(bridgePath, JSON.stringify({
    'user-uuid:org-uuid': {
      enabled: true,
      localSessionId: 'local_ditto_abc',
      remoteSessionId: 'cse_dispatch_real',
      processedMessageUuids: [],
    },
  }), 'utf8');

  const traces = [];
  const result = readRemoteSessionIdFromBridgeState({
    bridgeStatePath: bridgePath,
    trace: (msg) => traces.push(msg),
    waitMs: 1,
  });
  assert.equal(result, 'cse_dispatch_real');
  assert.ok(traces.some((m) => m.includes('found remoteSessionId=cse_dispatch_real')));
  assert.ok(traces.some((m) => m.includes('schema') && m.includes('entryCount=1')));
});

test('readRemoteSessionIdFromBridgeState returns null for missing file', (t) => {
  const tempRoot = createTempDir(t);
  const traces = [];
  const result = readRemoteSessionIdFromBridgeState({
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
  const result = readRemoteSessionIdFromBridgeState({
    bridgeStatePath: bridgePath,
    trace: (msg) => traces.push(msg),
    waitMs: 1,
  });
  assert.equal(result, null);
  assert.ok(traces.some((m) => m.includes('parse-error')));
});

test('readRemoteSessionIdFromBridgeState returns null when no cse_* entries', (t) => {
  const tempRoot = createTempDir(t);
  const bridgePath = path.join(tempRoot, 'bridge-state.json');
  fs.writeFileSync(bridgePath, JSON.stringify({
    'user:org': { localSessionId: 'local_ditto_x', remoteSessionId: 'not-a-cse-id' },
  }), 'utf8');

  const traces = [];
  const result = readRemoteSessionIdFromBridgeState({
    bridgeStatePath: bridgePath,
    trace: (msg) => traces.push(msg),
    waitMs: 1,
  });
  assert.equal(result, null);
  assert.ok(traces.some((m) => m.includes('no cse_* entry')));
});

test('readRemoteSessionIdFromBridgeState returns null on ENOENT without retrying', (t) => {
  let readCount = 0;
  const result = readRemoteSessionIdFromBridgeState({
    bridgeStatePath: '/fake/path',
    readFileSync: () => {
      readCount++;
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });
  assert.equal(result, null);
  assert.equal(readCount, 1);
});

test('readRemoteSessionIdFromBridgeState skips non-object values in dict', (t) => {
  const tempRoot = createTempDir(t);
  const bridgePath = path.join(tempRoot, 'bridge-state.json');
  fs.writeFileSync(bridgePath, JSON.stringify({
    'version': 'not-an-object',
    'user:org': { remoteSessionId: 'cse_nested' },
  }), 'utf8');

  const result = readRemoteSessionIdFromBridgeState({
    bridgeStatePath: bridgePath,
    waitMs: 1,
  });
  assert.equal(result, 'cse_nested');
});

// ============================================================================
// _resolveBridgeSession integration
// ============================================================================

function createOrchestratorWithBridge(overrides) {
  return createSessionOrchestrator({
    appSupportRoot: '/app/support',
    bridgeStatePath: '/nonexistent/bridge-state.json',
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

test('_resolveBridgeSession activates v2 transport when bridge-state has cse_* entry', (t) => {
  const tempRoot = createTempDir(t);
  const bridgePath = path.join(tempRoot, 'bridge-state.json');
  fs.writeFileSync(bridgePath, JSON.stringify({
    'user:org': { remoteSessionId: 'cse_dispatch_1', localSessionId: 'local_ditto_org' },
  }), 'utf8');

  const orchestrator = createOrchestratorWithBridge({
    bridgeStatePath: bridgePath,
  });

  const result = orchestrator.prepareVmSpawn({
    processId: 'proc-bridge',
    processName: 'demo',
    command: '/usr/local/bin/claude',
    args: ['--resume', 'old-cli-id', '--model', 'claude-opus-4-6'],
    envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth' },
    additionalMounts: { project: { path: 'project', mode: 'rw' } },
    sharedCwdPath: '/sessions/demo/mnt/project',
  });

  assert.equal(result.success, true);
  assert.equal(result.envVars.CLAUDE_CODE_ENVIRONMENT_KIND, 'bridge');
  assert.equal(result.envVars.CLAUDE_CODE_USE_CCR_V2, '1');
  assert.equal(result.envVars.CLAUDE_CODE_IS_COWORK, '1');
  // OAuth token preserved
  assert.equal(result.envVars.CLAUDE_CODE_OAUTH_TOKEN, 'test-oauth');
  // Args untouched — asar's bridge transport handles CCR relay
  assert.ok(result.args.includes('--resume'), '--resume preserved');
  assert.equal(result.args.indexOf('--session-id'), -1, 'no --session-id (cse_* managed by asar bridge)');
  assert.equal(result.args.indexOf('--fork-session'), -1, 'no --fork-session');
  assert.ok(result.bridgeSession);
  assert.equal(result.bridgeSession.source, 'bridge_state');
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

  // Empty bridge-state (no entries)
  const bridgePath = path.join(tempRoot, 'bridge-state.json');
  fs.writeFileSync(bridgePath, JSON.stringify({}), 'utf8');

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
  assert.ok(traces.some((m) => m.includes('no bridge-state entry')));
});
