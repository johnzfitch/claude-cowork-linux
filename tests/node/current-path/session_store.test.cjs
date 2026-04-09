const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSessionStore,
  deriveMetadataPathFromConfigDir,
  findSessionMetadataPath,
  getSessionDirectory,
  isLocalSessionMetadataFilePath,
} = require('../../../stubs/cowork/session_store.js');

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


test('findSessionMetadataPath locates local session metadata recursively', (t) => {
  const localAgentRoot = createTempRoot(t);
  const sessionId = 'local_demo_session';
  const metadataPath = writeSessionFixture(localAgentRoot, sessionId, 'user/org');

  assert.equal(findSessionMetadataPath(localAgentRoot, sessionId), metadataPath);
  assert.equal(getSessionDirectory(localAgentRoot, sessionId), metadataPath.replace(/\.json$/, ''));
});

test('normalizeSessionRecord repairs synthetic cwd from userSelectedFolders', (t) => {
  const localAgentRoot = createTempRoot(t);

  const store = createSessionStore({ localAgentRoot });
  const normalized = store.normalizeSessionRecord({
    sessionId: 'local_demo_session',
    cliSessionId: 'stale-cli-session',
    cwd: '/sessions/demo-session',
    processName: 'demo-session',
    userSelectedFolders: ['/home/zack/dev/claude-cowork-linux'],
  });

  assert.equal(normalized.cwd, '/home/zack/dev/claude-cowork-linux');
});

test('normalizeSessionRecord preserves cwd when userSelectedFolders contains canonical paths', (t) => {
  const localAgentRoot = createTempRoot(t);

  const store = createSessionStore({ localAgentRoot });
  const normalized = store.normalizeSessionRecord({
    sessionId: 'local_demo_session',
    cliSessionId: 'fresh-cli-session',
    cwd: '/home/zack/dev/claude-cowork-linux',
    userSelectedFolders: ['/home/zack/dev/claude-cowork-linux'],
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

