const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSessionStore,
  detectJsonIndentation,
  deriveMetadataPathFromConfigDir,
  findSessionMetadataPath,
  getSessionDirectory,
  isLocalSessionMetadataFilePath,
} = require('../../../stubs/cowork/session_store.js');
const {
  sanitizeTranscriptProjectKey,
} = require('../../../stubs/cowork/transcript_store.js');

function createTempRoot(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-session-store-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

function writeSessionFixture(localAgentRoot, sessionId, relativeDir) {
  const metadataDir = path.join(localAgentRoot, relativeDir);
  fs.mkdirSync(metadataDir, { recursive: true });
  const metadataPath = path.join(metadataDir, sessionId + '.json');
  fs.writeFileSync(metadataPath, JSON.stringify({ sessionId }, null, 2), 'utf8');
  return metadataPath;
}

function writeTranscript(sessionDirectory, projectKey, cliSessionId, lines) {
  const transcriptDir = path.join(sessionDirectory, '.claude', 'projects', projectKey);
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, cliSessionId + '.jsonl'), lines.join('\n') + '\n', 'utf8');
}

function writeAuditLog(sessionDirectory, lines) {
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(path.join(sessionDirectory, 'audit.jsonl'), lines.join('\n') + '\n', 'utf8');
}

test('findSessionMetadataPath locates local session metadata recursively', (t) => {
  const localAgentRoot = createTempRoot(t);
  const sessionId = 'local_demo_session';
  const metadataPath = writeSessionFixture(localAgentRoot, sessionId, 'user/org');

  assert.equal(findSessionMetadataPath(localAgentRoot, sessionId), metadataPath);
  assert.equal(getSessionDirectory(localAgentRoot, sessionId), metadataPath.replace(/\.json$/, ''));
});

test('normalizeSessionRecord repairs synthetic cwd and cliSessionId from transcript candidate', (t) => {
  const localAgentRoot = createTempRoot(t);
  const sessionId = 'local_demo_session';
  const metadataPath = writeSessionFixture(localAgentRoot, sessionId, 'user/org');
  const sessionDirectory = metadataPath.replace(/\.json$/, '');
  const preferredProjectKey = sanitizeTranscriptProjectKey('/home/zack/dev/claude-cowork-linux');

  writeTranscript(sessionDirectory, 'wrong-project', 'stale-cli-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"progress","data":{"type":"hook_progress"}}',
  ]);
  writeTranscript(sessionDirectory, preferredProjectKey, 'fresh-cli-session', [
    '{"type":"user","message":{"role":"user","content":"hello"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  ]);

  const store = createSessionStore({ localAgentRoot });
  const normalized = store.normalizeSessionRecord({
    sessionId,
    cliSessionId: 'stale-cli-session',
    cwd: '/sessions/demo-session',
    processName: 'demo-session',
    userSelectedFolders: ['/home/zack/dev/claude-cowork-linux'],
  });

  assert.equal(normalized.cwd, '/home/zack/dev/claude-cowork-linux');
  assert.equal(normalized.cliSessionId, 'fresh-cli-session');
});

test('normalizeSerializedMetadata rewrites synthetic cwd and stale cliSessionId for metadata files', (t) => {
  const localAgentRoot = createTempRoot(t);
  const sessionId = 'local_demo_session';
  const metadataPath = writeSessionFixture(localAgentRoot, sessionId, 'user/org');
  const sessionDirectory = metadataPath.replace(/\.json$/, '');
  const preferredProjectKey = sanitizeTranscriptProjectKey('/home/zack/dev/claude-cowork-linux');

  writeTranscript(sessionDirectory, 'wrong-project', 'stale-cli-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"progress","data":{"type":"hook_progress"}}',
  ]);
  writeTranscript(sessionDirectory, preferredProjectKey, 'fresh-cli-session', [
    '{"type":"user","message":{"role":"user","content":"hello"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  ]);

  const serialized = JSON.stringify({
    sessionId,
    cliSessionId: 'stale-cli-session',
    cwd: '/sessions/demo-session',
    processName: 'demo-session',
    userSelectedFolders: ['/home/zack/dev/claude-cowork-linux'],
  }, null, 2) + '\n';

  const store = createSessionStore({ localAgentRoot });
  const normalizedSerialized = store.normalizeSerializedMetadata(metadataPath, serialized);
  const parsedNormalized = JSON.parse(normalizedSerialized);

  assert.equal(parsedNormalized.cwd, '/home/zack/dev/claude-cowork-linux');
  assert.equal(parsedNormalized.cliSessionId, 'fresh-cli-session');
  assert.equal(normalizedSerialized.endsWith('\n'), true);
});

test('normalizeSessionRecord repairs relative userSelectedFolders from audit cwd for the active cli session', (t) => {
  const localAgentRoot = createTempRoot(t);
  const sessionId = 'local_demo_session';
  const metadataPath = writeSessionFixture(localAgentRoot, sessionId, 'user/org');
  const sessionDirectory = metadataPath.replace(/\.json$/, '');

  writeAuditLog(sessionDirectory, [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/home/zack/.local/share/claude-desktop',
      session_id: 'old-cli-session',
      _audit_timestamp: '2026-03-11T07:59:04.600Z',
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/home/zack/dev/claude-cowork-linux',
      session_id: 'fresh-cli-session',
      _audit_timestamp: '2026-03-14T10:54:15.948Z',
    }),
  ]);

  const store = createSessionStore({ localAgentRoot });
  const normalized = store.normalizeSessionRecord({
    sessionId,
    cliSessionId: 'fresh-cli-session',
    cwd: '/sessions/demo-session',
    processName: 'demo-session',
    userSelectedFolders: ['./.asar-cache/app.asar'],
  });

  assert.equal(normalized.cwd, '/home/zack/dev/claude-cowork-linux');
  assert.deepEqual(normalized.userSelectedFolders, ['/home/zack/dev/claude-cowork-linux']);
});

test('local session metadata helpers recognize canonical metadata files', (t) => {
  const localAgentRoot = createTempRoot(t);
  const metadataPath = writeSessionFixture(localAgentRoot, 'local_demo_session', 'user/org');
  const configDir = metadataPath.replace(/\.json$/, '') + '/.claude';

  assert.equal(isLocalSessionMetadataFilePath(localAgentRoot, metadataPath), true);
  assert.equal(isLocalSessionMetadataFilePath(localAgentRoot, path.join(localAgentRoot, 'other.json')), false);
  assert.equal(deriveMetadataPathFromConfigDir(configDir), metadataPath);
  assert.equal(detectJsonIndentation('{\n    "a": 1\n}\n'), '    ');
});

test('getSessionInfoForConfigDir resolves the local session record through the canonical metadata path', (t) => {
  const localAgentRoot = createTempRoot(t);
  const sessionId = 'local_demo_session';
  const metadataPath = writeSessionFixture(localAgentRoot, sessionId, 'user/org');
  const configDir = metadataPath.replace(/\.json$/, '') + '/.claude';

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
    cwd: '/home/zack/dev/claude-cowork-linux',
    remoteSessionId: 'remote-existing',
    remoteSessionAccessToken: 'bridge-token',
    userSelectedFolders: ['/home/zack/dev/claude-cowork-linux'],
  }, null, 2) + '\n', 'utf8');

  const store = createSessionStore({ localAgentRoot });
  const sessionInfo = store.getSessionInfoForConfigDir(configDir);

  assert.ok(sessionInfo);
  assert.equal(sessionInfo.metadataPath, metadataPath);
  assert.equal(sessionInfo.sessionData.sessionId, sessionId);
  assert.equal(sessionInfo.sessionData.remoteSessionId, 'remote-existing');
  assert.equal(sessionInfo.sessionData.remoteSessionAccessToken, 'bridge-token');
});

test('persistSessionIdentityForMetadataPath updates remote session identity on the same local session record', (t) => {
  const localAgentRoot = createTempRoot(t);
  const sessionId = 'local_demo_session';
  const metadataPath = writeSessionFixture(localAgentRoot, sessionId, 'user/org');

  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
    cliSessionId: 'resume-cli-session',
    cwd: '/home/zack/dev/claude-cowork-linux',
    userSelectedFolders: ['/home/zack/dev/claude-cowork-linux'],
  }, null, 2) + '\n', 'utf8');

  const store = createSessionStore({ localAgentRoot });
  const result = store.persistSessionIdentityForMetadataPath(metadataPath, {
    remoteSessionAccessToken: 'bridge-token',
    remoteSessionId: 'remote-created',
  });
  const persisted = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

  assert.equal(result.success, true);
  assert.equal(result.sessionData.sessionId, sessionId);
  assert.equal(result.sessionData.remoteSessionId, 'remote-created');
  assert.equal(result.sessionData.remoteSessionAccessToken, 'bridge-token');
  assert.equal(persisted.sessionId, sessionId);
  assert.equal(persisted.cliSessionId, 'resume-cli-session');
  assert.equal(persisted.remoteSessionId, 'remote-created');
  assert.equal(persisted.remoteSessionAccessToken, 'bridge-token');
});

test('resolveMutationSessionId prefers the session that was just opened for the same workspace', (t) => {
  const localAgentRoot = createTempRoot(t);
  const activeSessionId = 'local_active_session';
  const duplicateSessionId = 'local_duplicate_session';
  const activeMetadataPath = writeSessionFixture(localAgentRoot, activeSessionId, 'user/org');
  const duplicateMetadataPath = writeSessionFixture(localAgentRoot, duplicateSessionId, 'user/org');
  const projectKey = sanitizeTranscriptProjectKey('/home/zack/dev/claude-cowork-linux');

  const activeSerialized = JSON.stringify({
    sessionId: activeSessionId,
    cliSessionId: 'active-cli',
    cwd: '/sessions/active-workspace',
    processName: 'active-workspace',
    userSelectedFolders: ['/home/zack/dev/claude-cowork-linux'],
    isArchived: false,
  }, null, 2);
  const duplicateSerialized = JSON.stringify({
    sessionId: duplicateSessionId,
    cliSessionId: 'duplicate-cli',
    cwd: '/sessions/duplicate-workspace',
    processName: 'duplicate-workspace',
    userSelectedFolders: ['/home/zack/dev/claude-cowork-linux'],
    isArchived: false,
  }, null, 2);

  fs.writeFileSync(activeMetadataPath, activeSerialized, 'utf8');
  fs.writeFileSync(duplicateMetadataPath, duplicateSerialized, 'utf8');

  writeTranscript(activeMetadataPath.replace(/\.json$/, ''), projectKey, 'active-cli', [
    '{"type":"user","message":{"role":"user","content":"hello"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  ]);
  writeTranscript(duplicateMetadataPath.replace(/\.json$/, ''), projectKey, 'duplicate-cli', [
    '{"type":"queue-operation","operation":"enqueue"}',
  ]);

  const store = createSessionStore({ localAgentRoot });
  store.observeSessionId(activeSessionId);

  assert.equal(store.resolveMutationSessionId(duplicateSessionId), activeSessionId);
  assert.equal(store.resolveMutationSessionId(activeSessionId), activeSessionId);
});

// --- cross-session routing (two live sessions on one folder) -------------

function writeNamedSession(localAgentRoot, sessionId, fields, turns) {
  const metadataPath = writeSessionFixture(localAgentRoot, sessionId, 'user/org');
  const folder = fields.userSelectedFolders[0];
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
    cliSessionId: sessionId + '-cli',
    cwd: '/sessions/' + fields.processName,
    isArchived: false,
    ...fields,
  }, null, 2), 'utf8');
  if (turns !== null) {
    const lines = [];
    for (let i = 0; i < turns; i += 1) {
      lines.push('{"type":"user","message":{"role":"user","content":"q' + i + '"}}');
      lines.push('{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"a"}]}}');
    }
    if (lines.length === 0) {
      lines.push('{"type":"queue-operation","operation":"enqueue"}');
    }
    writeTranscript(metadataPath.replace(/\.json$/, ''), sanitizeTranscriptProjectKey(folder), sessionId + '-cli', lines);
  }
  return metadataPath;
}

test('resolveMutationSessionId never reroutes between two live sessions on the same folder', async (t) => {
  const localAgentRoot = createTempRoot(t);
  const folder = '/home/zack/Projects/Shared';
  writeNamedSession(localAgentRoot, 'local_A', { processName: 'proc-a', userSelectedFolders: [folder] }, 10);
  writeNamedSession(localAgentRoot, 'local_B', { processName: 'proc-b', userSelectedFolders: [folder] }, 12);

  const store = createSessionStore({ localAgentRoot });
  store.observeSessionId('local_A'); // user focuses A
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.observeSessionRead(store.getSessionInfo('local_B').sessionData); // UI refreshes B

  // Before the fix both resolved to local_B: the prompt typed in A ran in B.
  assert.equal(store.resolveMutationSessionId('local_A'), 'local_A');
  assert.equal(store.resolveMutationSessionId('local_B'), 'local_B');
});

test('resolveMutationSessionId does not reroute a new session that has no transcript yet', async (t) => {
  const localAgentRoot = createTempRoot(t);
  const folder = '/home/zack/Projects/Shared';
  writeNamedSession(localAgentRoot, 'local_new', { processName: 'proc-new', userSelectedFolders: [folder] }, null);
  writeNamedSession(localAgentRoot, 'local_live', { processName: 'proc-live', userSelectedFolders: [folder] }, 3);

  const store = createSessionStore({ localAgentRoot });
  store.observeSessionId('local_new');
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.observeSessionId('local_live');

  assert.equal(store.resolveMutationSessionId('local_new'), 'local_new');
});

test('getSessionInfoByProcessName finds the session that owns a vm process name', (t) => {
  const localAgentRoot = createTempRoot(t);
  writeNamedSession(localAgentRoot, 'local_A', {
    processName: 'beautiful-epic-sagan',
    vmProcessName: 'beautiful-epic-sagan',
    userSelectedFolders: ['/home/zack/Projects/HoP'],
  }, 1);
  writeNamedSession(localAgentRoot, 'local_B', {
    processName: 'keen-tender-hopper',
    userSelectedFolders: ['/home/zack/Projects/TPMS'],
  }, 1);

  const store = createSessionStore({ localAgentRoot });
  assert.equal(store.getSessionInfoByProcessName('beautiful-epic-sagan').preferredRoot, '/home/zack/Projects/HoP');
  assert.equal(store.getSessionInfoByProcessName('keen-tender-hopper').preferredRoot, '/home/zack/Projects/TPMS');
  assert.equal(store.getSessionInfoByProcessName('no-such-name'), null);
  assert.equal(store.getSessionInfoByProcessName(''), null);
});

test('getSessionInfoByProcessName picks up a session created after the first scan', async (t) => {
  const localAgentRoot = createTempRoot(t);
  writeNamedSession(localAgentRoot, 'local_A', { processName: 'first-name', userSelectedFolders: ['/home/zack/A'] }, 1);
  const store = createSessionStore({ localAgentRoot });
  assert.ok(store.getSessionInfoByProcessName('first-name'));

  writeNamedSession(localAgentRoot, 'local_C', { processName: 'later-name', userSelectedFolders: ['/home/zack/C'] }, 1);
  // listLocalSessionMetadataFiles caches the directory walk for 5 s.
  await new Promise((resolve) => setTimeout(resolve, 5100));
  assert.equal(store.getSessionInfoByProcessName('later-name').preferredRoot, '/home/zack/C');
});

test('getSessionInfoByProcessName refuses a name that two sessions share', (t) => {
  const localAgentRoot = createTempRoot(t);
  writeNamedSession(localAgentRoot, 'local_A', { processName: 'dup-name', userSelectedFolders: ['/home/zack/A'] }, 1);
  writeNamedSession(localAgentRoot, 'local_B', { processName: 'dup-name', userSelectedFolders: ['/home/zack/B'] }, 1);

  const store = createSessionStore({ localAgentRoot });
  assert.equal(store.getSessionInfoByProcessName('dup-name'), null);
});
