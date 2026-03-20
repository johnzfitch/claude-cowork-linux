const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSessionOrchestrator,
} = require('../../../stubs/cowork/session_orchestrator.js');
const {
  createDirs,
} = require('../../../stubs/cowork/dirs.js');
const {
  createSessionStore,
} = require('../../../stubs/cowork/session_store.js');

function createTempDir(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-session-orchestrator-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

function writeTranscript(sessionDir, projectKey, cliSessionId, lines) {
  const transcriptDir = path.join(sessionDir, '.claude', 'projects', projectKey);
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, cliSessionId + '.jsonl'), lines.join('\n') + '\n', 'utf8');
}

function createOrchestrator(overrides) {
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
    sessionsBase: '/tmp/cowork-session-tests',
    trace: () => {},
    translateVmPathStrict: (inputPath) => inputPath.replace('/sessions/demo', '/host/sessions/demo'),
    ...overrides,
  });
}

test('prepareVmSpawn translates command, args, cwd, and filters asar add-dir', () => {
  let mountSessionName = null;
  const orchestrator = createOrchestrator({
    createMountSymlinks: (sessionName) => {
      mountSessionName = sessionName;
      return true;
    },
  });

  const result = orchestrator.prepareVmSpawn({
    processId: 'proc-1',
    processName: 'demo',
    command: '/usr/local/bin/claude',
    args: ['--add-dir', '/tmp/app.asar', '--add-dir', '/sessions/demo/mnt/project'],
    envVars: {},
    additionalMounts: { project: { path: 'project', mode: 'rw' } },
    sharedCwdPath: '/sessions/demo/mnt/project',
  });

  assert.equal(result.success, true);
  assert.equal(result.command, '/usr/local/bin/claude-real');
  assert.deepEqual(result.args, ['--add-dir', '/host/sessions/demo/mnt/project']);
  assert.equal(result.sharedCwdPath, '/host/sessions/demo/mnt/project');
  assert.equal(mountSessionName, 'demo');
});

test('prepareVmSpawn replaces stale --resume target with the best resumable transcript candidate', (t) => {
  const tempRoot = createTempDir(t);
  const sessionsBase = path.join(tempRoot, 'sessions');
  fs.mkdirSync(sessionsBase, { recursive: true });
  const sessionDirectory = path.join(tempRoot, 'local_session');
  const configDir = path.join(sessionDirectory, '.claude');
  const preferredProjectKey = '-home-zack-dev-claude-cowork-linux';

  writeTranscript(sessionDirectory, 'wrong-project', 'stale-cli-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"progress","data":{"type":"hook_progress"}}',
  ]);
  writeTranscript(sessionDirectory, preferredProjectKey, 'fresh-cli-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"user","message":{"role":"user","content":"recover context"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"restored"}]}}',
  ]);

  const orchestrator = createOrchestrator({ sessionsBase });
  const result = orchestrator.prepareVmSpawn({
    processId: 'proc-2',
    processName: 'demo',
    command: '/usr/local/bin/claude',
    args: ['--resume', 'stale-cli-session'],
    envVars: {
      CLAUDE_CONFIG_DIR: configDir,
    },
    additionalMounts: null,
    sharedCwdPath: '/home/zack/dev/claude-cowork-linux',
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.args, ['--resume', 'fresh-cli-session']);
});

test('prepareVmSpawn removes --resume when transcript candidate is not resumable', (t) => {
  const tempRoot = createTempDir(t);
  const sessionsBase = path.join(tempRoot, 'sessions');
  fs.mkdirSync(sessionsBase, { recursive: true });
  const sessionDirectory = path.join(tempRoot, 'local_session');
  const configDir = path.join(sessionDirectory, '.claude');
  const preferredProjectKey = '-home-zack-dev-claude-cowork-linux';

  writeTranscript(sessionDirectory, preferredProjectKey, 'queue-only-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"last-prompt","lastPrompt":"claude> "}',
  ]);

  const orchestrator = createOrchestrator({ sessionsBase });
  const result = orchestrator.prepareVmSpawn({
    processId: 'proc-3',
    processName: 'demo',
    command: '/usr/local/bin/claude',
    args: ['--resume', 'queue-only-session', '--model', 'claude-opus-4-6'],
    envVars: {
      CLAUDE_CONFIG_DIR: configDir,
    },
    additionalMounts: null,
    sharedCwdPath: '/home/zack/dev/claude-cowork-linux',
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.args, ['--model', 'claude-opus-4-6']);
});

test('prepareVmSpawn derives host cwd from canonical session metadata when sharedCwdPath is missing', (t) => {
  const tempRoot = createTempDir(t);
  const sessionId = 'local_demo_session';
  const metadataPath = path.join(tempRoot, sessionId + '.json');
  const sessionDirectory = metadataPath.replace(/\.json$/, '');
  const configDir = path.join(sessionDirectory, '.claude');

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
    cwd: '/sessions/demo',
    userSelectedFolders: ['/home/zack/dev/canonical-workspace'],
  }, null, 2), 'utf8');

  const orchestrator = createOrchestrator();
  const result = orchestrator.prepareVmSpawn({
    processId: 'proc-4',
    processName: 'demo',
    command: '/usr/local/bin/claude',
    args: ['--model', 'claude-opus-4-6'],
    envVars: {
      CLAUDE_CONFIG_DIR: configDir,
    },
    additionalMounts: null,
    sharedCwdPath: null,
  });

  assert.equal(result.success, true);
  assert.equal(result.sharedCwdPath, '/home/zack/dev/canonical-workspace');
});

test('prepareVmSpawn derives host cwd from translated --add-dir when sharedCwdPath is missing', () => {
  const orchestrator = createOrchestrator();
  const result = orchestrator.prepareVmSpawn({
    processId: 'proc-5',
    processName: 'demo',
    command: '/usr/local/bin/claude',
    args: ['--add-dir', '/sessions/demo/mnt/project', '--model', 'claude-opus-4-6'],
    envVars: {},
    additionalMounts: null,
    sharedCwdPath: null,
  });

  assert.equal(result.success, true);
  assert.equal(result.sharedCwdPath, '/host/sessions/demo/mnt/project');
});

test('prepareVmSpawn provisions a bridge session through session_store ownership and emits bridge-style flags/env', (t) => {
  const tempRoot = createTempDir(t);
  const localAgentRoot = path.join(tempRoot, 'claude-local');
  const sessionId = 'local_demo_session';
  const metadataPath = path.join(localAgentRoot, 'user', 'org', sessionId + '.json');
  const configDir = metadataPath.replace(/\.json$/, '') + '/.claude';
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const seenEnsureCalls = [];

  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
    cliSessionId: 'legacy-cli-session',
    cwd: workspaceRoot,
    userSelectedFolders: [workspaceRoot],
  }, null, 2) + '\n', 'utf8');

  const sessionStore = createSessionStore({ localAgentRoot });
  const orchestrator = createOrchestrator({
    sessionStore,
    sessionsApi: {
      ensureSession(context) {
        seenEnsureCalls.push(context);
        return {
          success: true,
          remoteSessionId: 'remote-created',
          sessionAccessToken: 'bridge-token',
          source: 'created',
        };
      },
    },
  });

  const result = orchestrator.prepareVmSpawn({
    processId: 'proc-bridge',
    processName: 'demo',
    command: '/usr/local/bin/claude',
    args: ['--resume', 'legacy-cli-session', '--model', 'claude-opus-4-6', '--add-dir', '/sessions/demo/mnt/project'],
    envVars: {
      CLAUDE_CONFIG_DIR: configDir,
    },
    additionalMounts: null,
    sharedCwdPath: workspaceRoot,
  });
  const persisted = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

  assert.equal(result.success, true);
  assert.deepEqual(result.args, [
    '--print',
    '--session-id',
    'remote-created',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--replay-user-messages',
    '--model',
    'claude-opus-4-6',
    '--add-dir',
    '/host/sessions/demo/mnt/project',
  ]);
  assert.equal(result.envVars.CLAUDE_CODE_ENVIRONMENT_KIND, 'bridge');
  assert.equal(result.envVars.CLAUDE_CODE_SESSION_ACCESS_TOKEN, 'bridge-token');
  assert.equal(result.envVars.CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2, '1');
  assert.equal(result.envVars.CLAUDE_CODE_IS_COWORK, '1');
  assert.equal(result.envVars.CLAUDE_CODE_USE_COWORK_PLUGINS, '1');
  assert.equal(seenEnsureCalls.length, 1);
  assert.equal(seenEnsureCalls[0].localSessionId, sessionId);
  assert.equal(seenEnsureCalls[0].cwd, workspaceRoot);
  assert.equal(seenEnsureCalls[0].model, 'claude-opus-4-6');
  assert.equal(persisted.sessionId, sessionId);
  assert.equal(persisted.cliSessionId, 'legacy-cli-session');
  assert.equal(persisted.remoteSessionId, 'remote-created');
  assert.equal(persisted.remoteSessionAccessToken, 'bridge-token');
});

test('prepareFlatlineRetry clears only cliSessionId and removes --resume for the fresh retry', (t) => {
  const tempRoot = createTempDir(t);
  const sessionId = 'local_demo_session';
  const metadataPath = path.join(tempRoot, sessionId + '.json');
  const sessionDirectory = metadataPath.replace(/\.json$/, '');
  const configDir = path.join(sessionDirectory, '.claude');
  const preferredProjectKey = '-home-zack-dev-canonical-workspace';

  fs.mkdirSync(configDir, { recursive: true });
  writeTranscript(sessionDirectory, preferredProjectKey, 'resume-cli-session', [
    '{"type":"user","message":{"role":"user","content":"hello"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  ]);
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
    cliSessionId: 'resume-cli-session',
    cwd: '/home/zack/dev/canonical-workspace',
    userSelectedFolders: ['/home/zack/dev/canonical-workspace'],
    model: 'claude-opus-4-6',
  }, null, 2) + '\n', 'utf8');

  const orchestrator = createOrchestrator();
  const result = orchestrator.prepareFlatlineRetry({
    args: ['--resume', 'resume-cli-session', '--model', 'claude-opus-4-6'],
    envVars: {
      CLAUDE_CONFIG_DIR: configDir,
    },
    sharedCwdPath: '/home/zack/dev/canonical-workspace',
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.args, ['--model', 'claude-opus-4-6']);
  assert.equal(result.retryPlan.clearCliSessionId, true);
  assert.equal(result.retryMode, 'continuity');
  assert.ok(result.continuityPlan);
  assert.match(result.continuityPlan.hydratedPrompt, /Local session: local_demo_session/);
  assert.match(result.continuityPlan.hydratedPrompt, /Assistant: hi/);
  const persisted = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.equal(persisted.cliSessionId, null);
  assert.equal(persisted.model, 'claude-opus-4-6');
  assert.equal(persisted.sessionId, sessionId);
});

test('prepareFlatlineRetry falls back to a plain fresh retry when no safe continuity transcript exists', (t) => {
  const tempRoot = createTempDir(t);
  const sessionId = 'local_demo_session';
  const metadataPath = path.join(tempRoot, sessionId + '.json');
  const sessionDirectory = metadataPath.replace(/\.json$/, '');
  const configDir = path.join(sessionDirectory, '.claude');

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
    cliSessionId: 'resume-cli-session',
    cwd: '/home/zack/dev/canonical-workspace',
    userSelectedFolders: ['/home/zack/dev/canonical-workspace'],
  }, null, 2) + '\n', 'utf8');

  const orchestrator = createOrchestrator();
  const result = orchestrator.prepareFlatlineRetry({
    args: ['--resume', 'resume-cli-session'],
    envVars: {
      CLAUDE_CONFIG_DIR: configDir,
    },
    sharedCwdPath: '/home/zack/dev/canonical-workspace',
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.args, []);
  assert.equal(result.retryMode, 'fresh');
  assert.equal(result.continuityPlan, null);
});

test('persistRecoveredCliSession updates the same local session metadata with the new working cliSessionId', (t) => {
  const tempRoot = createTempDir(t);
  const sessionId = 'local_demo_session';
  const metadataPath = path.join(tempRoot, sessionId + '.json');
  const sessionDirectory = metadataPath.replace(/\.json$/, '');
  const configDir = path.join(sessionDirectory, '.claude');

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
    cliSessionId: null,
    cwd: '/home/zack/dev/canonical-workspace',
    userSelectedFolders: ['/home/zack/dev/canonical-workspace'],
    error: 'Resume turn exited without a first assistant response',
  }, null, 2) + '\n', 'utf8');

  const orchestrator = createOrchestrator();
  const result = orchestrator.persistRecoveredCliSession({
    cliSessionId: 'fresh-cli-session',
    envVars: {
      CLAUDE_CONFIG_DIR: configDir,
    },
  });

  assert.equal(result.success, true);
  const persisted = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.equal(persisted.sessionId, sessionId);
  assert.equal(persisted.cliSessionId, 'fresh-cli-session');
  assert.equal('error' in persisted, false);
});

test('resolveFileSystemPath uses the explicitly requested local session registry to recover moved files', (t) => {
  const tempRoot = createTempDir(t);
  const localAgentRoot = path.join(tempRoot, 'claude-local');
  const sessionId = 'local_demo_session';
  const metadataPath = path.join(localAgentRoot, 'user', 'org', sessionId + '.json');
  const sessionDirectory = metadataPath.replace(/\.json$/, '');
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const originalPath = path.join(workspaceRoot, 'src', 'note.txt');
  const movedPath = path.join(workspaceRoot, 'dst', 'note.txt');

  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.mkdirSync(path.dirname(movedPath), { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    cwd: workspaceRoot,
    sessionId,
    userSelectedFolders: [workspaceRoot],
  }, null, 2) + '\n', 'utf8');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(originalPath, 'hello\n', 'utf8');

  const sessionStore = createSessionStore({ localAgentRoot });
  sessionStore.observeSessionId(sessionId);

  const orchestrator = createSessionOrchestrator({
    dirs: createDirs({ env: {}, homeDir: tempRoot }),
    sessionStore,
  });

  const initialResolution = orchestrator.resolveFileSystemPath({
    localSessionId: sessionId,
    targetPath: originalPath,
  });
  assert.equal(initialResolution.resolution, 'exact');

  fs.renameSync(originalPath, movedPath);

  const recoveredResolution = orchestrator.resolveFileSystemPath({
    localSessionId: sessionId,
    targetPath: originalPath,
  });
  assert.equal(recoveredResolution.resolution, 'recovered');
  assert.equal(recoveredResolution.resolvedPath, movedPath);
});

test('relinkFileSystemPath relinks a missing tracked file on the same session-owned fileId', (t) => {
  const tempRoot = createTempDir(t);
  const localAgentRoot = path.join(tempRoot, 'claude-local');
  const sessionId = 'local_demo_session';
  const metadataPath = path.join(localAgentRoot, 'user', 'org', sessionId + '.json');
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const originalPath = path.join(workspaceRoot, 'src', 'note.txt');
  const relinkedPath = path.join(workspaceRoot, 'dst', 'note.txt');

  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.mkdirSync(path.dirname(relinkedPath), { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    cwd: workspaceRoot,
    sessionId,
    userSelectedFolders: [workspaceRoot],
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(originalPath, 'hello\n', 'utf8');

  const sessionStore = createSessionStore({ localAgentRoot });
  sessionStore.observeSessionId(sessionId);

  const orchestrator = createSessionOrchestrator({
    dirs: createDirs({ env: {}, homeDir: tempRoot }),
    sessionStore,
  });

  const trackedResolution = orchestrator.resolveFileSystemPath({
    localSessionId: sessionId,
    targetPath: originalPath,
  });
  fs.unlinkSync(originalPath);

  const missingResolution = orchestrator.resolveFileSystemPath({
    localSessionId: sessionId,
    targetPath: originalPath,
  });
  fs.writeFileSync(relinkedPath, 'hello\n', 'utf8');

  const relinkResolution = orchestrator.relinkFileSystemPath({
    fileId: missingResolution.fileId,
    localSessionId: sessionId,
    provenance: {
      linked_by: 'manual-test',
    },
    reason: 'manual_relink',
    targetPath: relinkedPath,
  });

  const resolvedAgain = orchestrator.resolveFileSystemPath({
    localSessionId: sessionId,
    targetPath: originalPath,
  });

  assert.equal(trackedResolution.resolution, 'exact');
  assert.equal(missingResolution.resolution, 'missing');
  assert.equal(relinkResolution.resolution, 'relinked');
  assert.equal(relinkResolution.fileId, trackedResolution.fileId);
  assert.equal(relinkResolution.entry.currentPath, relinkedPath);
  assert.equal(resolvedAgain.resolution, 'registry');
  assert.equal(resolvedAgain.fileId, trackedResolution.fileId);
  assert.equal(resolvedAgain.resolvedPath, relinkedPath);
});

test('resolveFileSystemPath fails closed when no local session id is provided', (t) => {
  const tempRoot = createTempDir(t);
  const localAgentRoot = path.join(tempRoot, 'claude-local');
  const sessionId = 'local_demo_session';
  const metadataPath = path.join(localAgentRoot, 'user', 'org', sessionId + '.json');
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const filePath = path.join(workspaceRoot, 'note.txt');

  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    cwd: workspaceRoot,
    sessionId,
    userSelectedFolders: [workspaceRoot],
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(filePath, 'hello\n', 'utf8');

  const sessionStore = createSessionStore({ localAgentRoot });
  sessionStore.observeSessionId(sessionId);

  const orchestrator = createSessionOrchestrator({
    dirs: createDirs({ env: {}, homeDir: tempRoot }),
    sessionStore,
  });

  const resolution = orchestrator.resolveFileSystemPath({
    targetPath: filePath,
  });

  assert.equal(resolution.resolution, 'context_required');
  assert.equal(resolution.authorized, false);
  assert.equal(resolution.entry, null);
});

test('resolveFileSystemPath fails closed when the file registry is unavailable', (t) => {
  const tempRoot = createTempDir(t);
  const filePath = path.join(tempRoot, 'note.txt');
  fs.writeFileSync(filePath, 'hello\n', 'utf8');

  const orchestrator = createSessionOrchestrator({
    sessionStore: null,
  });

  const resolution = orchestrator.resolveFileSystemPath({
    localSessionId: 'local_demo_session',
    targetPath: filePath,
  });

  assert.equal(resolution.resolution, 'unavailable');
  assert.equal(resolution.authorized, false);
});

test('prepareVmSpawn injects spawn-time OAuth token before bridge resolution', () => {
  let updateCalled = false;
  let updateValue = null;
  const mockApi = {
    updateAuthToken(token) {
      updateCalled = true;
      updateValue = token;
    },
    isConfigured() { return true; },
    ensureSession() {
      return { success: false, skipped: true };
    },
  };

  const orchestrator = createOrchestrator({
    sessionsApi: mockApi,
  });

  orchestrator.prepareVmSpawn({
    processId: 'test-process',
    command: '/usr/local/bin/claude',
    args: ['--resume', 'cc-123'],
    envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token-value' },
  });

  assert.ok(updateCalled, 'updateAuthToken should have been called');
  assert.strictEqual(updateValue, 'test-oauth-token-value');
});

test('bridge with empty sessionAccessToken falls through to legacy path', (t) => {
  const tempRoot = createTempDir(t);
  const localAgentRoot = path.join(tempRoot, 'claude-local');
  const sessionId = 'local_session_1';
  const metadataPath = path.join(localAgentRoot, 'user', 'org', sessionId + '.json');
  const configDir = metadataPath.replace(/\.json$/, '') + '/.claude';

  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
  }, null, 2) + '\n', 'utf8');

  const mockApi = {
    updateAuthToken() {},
    isConfigured() { return true; },
    ensureSession() {
      return {
        success: true,
        remoteSessionId: 'remote-123',
        sessionAccessToken: '',
        source: 'created',
      };
    },
  };

  const sessionStore = createSessionStore({ localAgentRoot });
  const orchestrator = createOrchestrator({
    sessionStore,
    sessionsApi: mockApi,
  });

  const result = orchestrator.prepareVmSpawn({
    processId: 'test-process',
    command: '/usr/local/bin/claude',
    args: ['--resume', 'cc-123'],
    envVars: {
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token-value',
      CLAUDE_CONFIG_DIR: configDir,
    },
  });

  assert.ok(result.success);
  assert.notStrictEqual(result.envVars.CLAUDE_CODE_ENVIRONMENT_KIND, 'bridge');
  assert.strictEqual(result.envVars.CLAUDE_CODE_OAUTH_TOKEN, 'test-oauth-token-value');
});

test('dualWriteEvent fires postEvents for assistant events when bridge is active', () => {
  let posted = null;
  const mockApi = {
    postEvents(sessionId, events) {
      posted = { sessionId, events };
      return { success: true };
    },
  };
  const orchestrator = createOrchestrator({
    sessionsApi: mockApi,
  });
  orchestrator.dualWriteEvent('remote-123', { type: 'assistant', content: 'hello' });
  assert.ok(posted);
  assert.strictEqual(posted.sessionId, 'remote-123');
  assert.strictEqual(posted.events.length, 1);
});

test('dualWriteEvent is non-fatal when postEvents throws', () => {
  const mockApi = {
    postEvents() { throw new Error('network error'); },
  };
  const orchestrator = createOrchestrator({
    sessionsApi: mockApi,
  });
  orchestrator.dualWriteEvent('remote-123', { type: 'assistant' });
});

test('dualWriteEvent skips when sessionsApi is not configured', () => {
  const orchestrator = createOrchestrator();
  orchestrator.dualWriteEvent('remote-123', { type: 'assistant' });
});

test('classifyStdoutEvent returns extract_session_id for session id events', () => {
  const orchestrator = createOrchestrator();
  const result = orchestrator.classifyStdoutEvent({ session_id: 'sess-123' });
  assert.strictEqual(result.action, 'extract_session_id');
  assert.strictEqual(result.sessionId, 'sess-123');
});

test('classifyStdoutEvent returns flatline_detected for flatline results', () => {
  const orchestrator = createOrchestrator();
  const result = orchestrator.classifyStdoutEvent({ type: 'result', is_error: true, num_turns: 0 });
  assert.strictEqual(result.action, 'flatline_detected');
});

test('classifyStdoutEvent returns success for successful results', () => {
  const orchestrator = createOrchestrator();
  const result = orchestrator.classifyStdoutEvent({ type: 'result', subtype: 'success' });
  assert.strictEqual(result.action, 'success');
});

test('classifyStdoutEvent returns forward for normal events', () => {
  const orchestrator = createOrchestrator();
  const result = orchestrator.classifyStdoutEvent({ type: 'stream_event', data: {} });
  assert.strictEqual(result.action, 'forward');
});

test('classifyStdoutEvent returns ignore for null', () => {
  const orchestrator = createOrchestrator();
  const result = orchestrator.classifyStdoutEvent(null);
  assert.strictEqual(result.action, 'ignore');
});

test('buildRetryInput builds retry input from process state', () => {
  const orchestrator = createOrchestrator();
  const result = orchestrator.buildRetryInput({
    lastUserMessage: 'please fix the bug',
    retryCount: 2,
  });
  assert.ok(result);
  assert.strictEqual(result.type, 'user');
  assert.strictEqual(result.content, 'please fix the bug');
  assert.strictEqual(result.retryAttempt, 2);
});

test('buildRetryInput returns null for missing message', () => {
  const orchestrator = createOrchestrator();
  assert.strictEqual(orchestrator.buildRetryInput({ retryCount: 0 }), null);
});

test('buildRetryInput returns null for null input', () => {
  const orchestrator = createOrchestrator();
  assert.strictEqual(orchestrator.buildRetryInput(null), null);
});

test('normalizeSessionRecord delegates to sessionStore', () => {
  const orchestrator = createOrchestrator({
    sessionStore: {
      normalizeSessionRecord(data) {
        return { ...data, repaired: true };
      },
    },
  });
  const result = orchestrator.normalizeSessionRecord({ sessionId: 'local_test' });
  assert.deepStrictEqual(result, { sessionId: 'local_test', repaired: true });
});

test('normalizeSessionRecord passes through when no sessionStore', () => {
  const orchestrator = createOrchestrator({ sessionStore: null });
  const input = { sessionId: 'local_test' };
  assert.strictEqual(orchestrator.normalizeSessionRecord(input), input);
});

// --- Phase 3: SDK message transformation tests ---

const {
  transformSdkMessages,
  mergeConsecutiveAssistantMessages,
  mergeAssistantSdkMessages,
  isAssistantSdkMessage,
  filterTranscriptMessages,
} = require('../../../stubs/cowork/session_orchestrator.js');

test('transformSdkMessages strips metadata and ignored types from message list', () => {
  const messages = [
    { type: 'assistant', message: { type: 'message', role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'queue-operation', operations: [] },
    { type: 'progress', current: 1, total: 5 },
    { type: 'last-prompt', text: 'hello' },
    { type: 'rate_limit_event', retryAfter: 5 },
    { type: 'user', message: { type: 'message', role: 'user', content: [{ type: 'text', text: 'bye' }] } },
  ];
  const result = transformSdkMessages(messages, null);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].type, 'assistant');
  assert.strictEqual(result[1].type, 'user');
});

test('transformSdkMessages strips nested metadata types inside message wrappers', () => {
  const messages = [
    { type: 'message', message: { type: 'queue-operation', operations: [] } },
    { type: 'message', message: { type: 'progress', current: 1 } },
    { type: 'assistant', message: { type: 'message', role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'ok' }] } },
  ];
  const result = transformSdkMessages(messages, null);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].type, 'assistant');
});

test('transformSdkMessages passes through non-array input', () => {
  assert.strictEqual(transformSdkMessages(null), null);
  assert.strictEqual(transformSdkMessages('hello'), 'hello');
});

test('mergeConsecutiveAssistantMessages merges same-id assistant messages', () => {
  const messages = [
    { type: 'assistant', message: { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'text', text: 'hello ' }] } },
    { type: 'assistant', message: { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'text', text: 'hello world' }] } },
  ];
  const result = mergeConsecutiveAssistantMessages(messages);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].message.content[0].text, 'hello world');
});

test('mergeConsecutiveAssistantMessages keeps different-id messages separate', () => {
  const messages = [
    { type: 'assistant', message: { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'text', text: 'a' }] } },
    { type: 'assistant', message: { type: 'message', role: 'assistant', id: 'msg_2', content: [{ type: 'text', text: 'b' }] } },
  ];
  const result = mergeConsecutiveAssistantMessages(messages);
  assert.strictEqual(result.length, 2);
});

test('mergeAssistantSdkMessages returns null for non-assistant or mismatched IDs', () => {
  assert.strictEqual(mergeAssistantSdkMessages(null, null), null);
  assert.strictEqual(mergeAssistantSdkMessages(
    { type: 'user', message: { type: 'message', role: 'user', content: [] } },
    { type: 'assistant', message: { type: 'message', role: 'assistant', id: 'a', content: [] } },
  ), null);
  assert.strictEqual(mergeAssistantSdkMessages(
    { type: 'assistant', message: { type: 'message', role: 'assistant', id: 'a', content: [] } },
    { type: 'assistant', message: { type: 'message', role: 'assistant', id: 'b', content: [] } },
  ), null);
});

test('isAssistantSdkMessage validates message shape', () => {
  assert.strictEqual(isAssistantSdkMessage(null), false);
  assert.strictEqual(isAssistantSdkMessage({ type: 'user' }), false);
  assert.strictEqual(isAssistantSdkMessage({
    type: 'assistant',
    message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  }), true);
});

test('filterTranscriptMessages removes ignored types from arrays', () => {
  const input = [
    { type: 'assistant', message: { type: 'message', role: 'assistant', content: [] } },
    { type: 'queue-operation' },
    { type: 'progress' },
    { type: 'last-prompt' },
    { type: 'rate_limit_event' },
    { type: 'message', message: { type: 'queue-operation' } },
    { type: 'user', message: { type: 'message', role: 'user', content: [] } },
  ];
  const result = filterTranscriptMessages(input);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].type, 'assistant');
  assert.strictEqual(result[1].type, 'user');
});

test('filterTranscriptMessages passes through non-array input', () => {
  assert.strictEqual(filterTranscriptMessages(null), null);
  assert.strictEqual(filterTranscriptMessages('string'), 'string');
});

// --- Phase 4: Live event dispatch tests ---

const EVENT_CHANNEL = '$eipc_message$_uuid_$_claude.web_$_LocalAgentModeSessions_$_onEvent';

test('normalizeLiveEvent drops metadata types and accumulates compatibility state', () => {
  const orchestrator = createOrchestrator();
  // queue-operation is metadata — should be accumulated, not dispatched
  const result1 = orchestrator.normalizeLiveEvent(EVENT_CHANNEL, {
    type: 'queue-operation',
    sessionId: 'local_test',
    operations: [{ id: 'op1' }],
  });
  assert.strictEqual(result1.length, 0, 'metadata should be dropped');

  // A non-metadata event should carry the accumulated state
  const result2 = orchestrator.normalizeLiveEvent(EVENT_CHANNEL, {
    type: 'message',
    sessionId: 'local_test',
    message: { type: 'result', stop_reason: 'end_turn' },
  });
  assert.strictEqual(result2.length, 1);
  assert.ok(result2[0].coworkCompatibilityState, 'should have compatibility state attached');
});

test('normalizeLiveEvent passes through non-onEvent channels', () => {
  const orchestrator = createOrchestrator();
  const payload = { type: 'assistant', sessionId: 'local_test' };
  const result = orchestrator.normalizeLiveEvent('some_other_channel', payload);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0], payload, 'should return payload unchanged');
});

test('normalizeLiveEvent clears state on session lifecycle events', () => {
  const orchestrator = createOrchestrator();
  // Accumulate some state
  orchestrator.normalizeLiveEvent(EVENT_CHANNEL, {
    type: 'progress',
    sessionId: 'local_test',
    current: 1,
    total: 5,
  });
  // 'start' should clear it
  const result = orchestrator.normalizeLiveEvent(EVENT_CHANNEL, {
    type: 'start',
    sessionId: 'local_test',
  });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].type, 'start');
  // Next message should have no compatibility state
  const result2 = orchestrator.normalizeLiveEvent(EVENT_CHANNEL, {
    type: 'message',
    sessionId: 'local_test',
    message: { type: 'assistant', role: 'assistant' },
  });
  assert.strictEqual(result2[0].coworkCompatibilityState, undefined);
});

test('normalizeLiveEvent synthesizes assistant from stream_event message_start', () => {
  const orchestrator = createOrchestrator();
  const result = orchestrator.normalizeLiveEvent(EVENT_CHANNEL, {
    type: 'message',
    sessionId: 'local_test',
    message: {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg_1',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    },
  });
  // Returns 2 payloads: original stream_event + synthetic assistant
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[1].message.type, 'assistant');
  assert.strictEqual(result[1].message.message.content[0].text, 'hello');
});

test('normalizeLiveEvent merges consecutive assistant messages by ID', () => {
  const orchestrator = createOrchestrator();
  const mkAssistant = (text) => ({
    type: 'message',
    sessionId: 'local_test',
    message: {
      type: 'assistant',
      message: { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'text', text }] },
    },
  });
  orchestrator.normalizeLiveEvent(EVENT_CHANNEL, mkAssistant('hello'));
  const result = orchestrator.normalizeLiveEvent(EVENT_CHANNEL, mkAssistant('hello world'));
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].message.message.content[0].text, 'hello world');
});

test('normalizeLiveEvent handles transcript_loaded with metadata extraction', () => {
  const orchestrator = createOrchestrator();
  const result = orchestrator.normalizeLiveEvent(EVENT_CHANNEL, {
    type: 'transcript_loaded',
    sessionId: 'local_test',
    messages: [
      { type: 'queue-operation', operations: [] },
      { type: 'progress', current: 1, total: 5 },
      { type: 'rate_limit_event' },
      { type: 'assistant', message: { type: 'message', role: 'assistant', id: 'a', content: [{ type: 'text', text: 'hi' }] } },
    ],
  });
  assert.strictEqual(result.length, 1);
  // queue-operation and progress accumulated, rate_limit_event dropped, assistant kept
  assert.strictEqual(result[0].messages.length, 1);
  assert.strictEqual(result[0].messages[0].type, 'assistant');
  assert.ok(result[0].coworkCompatibilityState, 'should carry accumulated metadata');
});
