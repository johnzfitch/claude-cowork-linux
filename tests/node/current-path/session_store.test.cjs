const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSessionStore,
  deriveMetadataPathFromConfigDir,
  findSessionMetadataPath,
  getAuthorizedSessionRoots,
  getPreferredSessionRoot,
  getSessionDirectory,
  invalidateMetadataFileCache,
  isCanonicalHostPath,
  isDesktopRuntimePath,
  isLocalSessionMetadataFilePath,
  isSyntheticSessionCwd,
  normalizeSessionRecord,
  shouldRepairSessionCwd,
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

// ============================================================================
// isCanonicalHostPath
// ============================================================================

test('isCanonicalHostPath returns true for absolute non-/sessions/ paths', () => {
  assert.equal(isCanonicalHostPath('/home/user/project'), true);
});

test('isCanonicalHostPath returns false for /sessions/ VM paths', () => {
  assert.equal(isCanonicalHostPath('/sessions/demo'), false);
});

test('isCanonicalHostPath returns false for empty string', () => {
  assert.ok(!isCanonicalHostPath(''));
});

test('isCanonicalHostPath returns false for relative path', () => {
  assert.equal(isCanonicalHostPath('relative/path'), false);
});

test('isCanonicalHostPath returns false for null and undefined', () => {
  assert.equal(isCanonicalHostPath(null), false);
  assert.equal(isCanonicalHostPath(undefined), false);
});

// ============================================================================
// isDesktopRuntimePath
// ============================================================================

test('isDesktopRuntimePath returns true for paths under the desktop data root', () => {
  const homeDir = os.homedir();
  const desktopDataPath = path.join(homeDir, '.local', 'share', 'claude-desktop', 'something');
  assert.equal(isDesktopRuntimePath(desktopDataPath), true);
});

test('isDesktopRuntimePath returns false for paths outside the desktop data root', () => {
  assert.equal(isDesktopRuntimePath('/home/user/project'), false);
});

test('isDesktopRuntimePath returns false for VM paths (not canonical)', () => {
  assert.equal(isDesktopRuntimePath('/sessions/demo'), false);
});

// ============================================================================
// isSyntheticSessionCwd
// ============================================================================

test('isSyntheticSessionCwd returns true for /sessions/ paths', () => {
  assert.equal(isSyntheticSessionCwd('/sessions/demo-session', {}), true);
});

test('isSyntheticSessionCwd returns true for /home/processName when processName matches', () => {
  assert.equal(isSyntheticSessionCwd('/home/demo-proc', { processName: 'demo-proc' }), true);
});

test('isSyntheticSessionCwd returns true when vmProcessName matches', () => {
  assert.equal(isSyntheticSessionCwd('/home/vm-proc', { vmProcessName: 'vm-proc' }), true);
});

test('isSyntheticSessionCwd returns false for normal paths', () => {
  assert.equal(isSyntheticSessionCwd('/home/user/project', { processName: 'other' }), false);
});

test('isSyntheticSessionCwd returns false for empty and null input', () => {
  assert.equal(isSyntheticSessionCwd('', {}), false);
  assert.equal(isSyntheticSessionCwd(null, {}), false);
});

// ============================================================================
// shouldRepairSessionCwd
// ============================================================================

test('shouldRepairSessionCwd returns true for VM paths', () => {
  assert.equal(shouldRepairSessionCwd('/sessions/demo', {}), true);
});

test('shouldRepairSessionCwd returns true for synthetic paths', () => {
  assert.equal(shouldRepairSessionCwd('/home/demo-proc', { processName: 'demo-proc' }), true);
});

test('shouldRepairSessionCwd returns true for desktop runtime paths', () => {
  const homeDir = os.homedir();
  const desktopPath = path.join(homeDir, '.local', 'share', 'claude-desktop', 'data');
  assert.equal(shouldRepairSessionCwd(desktopPath, {}), true);
});

test('shouldRepairSessionCwd returns false for normal canonical host paths', () => {
  assert.equal(shouldRepairSessionCwd('/home/user/project', {}), false);
});

// ============================================================================
// getPreferredSessionRoot
// ============================================================================

test('getPreferredSessionRoot returns first valid folder from userSelectedFolders', () => {
  const result = getPreferredSessionRoot({
    userSelectedFolders: ['/home/user/project-a', '/home/user/project-b'],
  });
  assert.equal(result, '/home/user/project-a');
});

test('getPreferredSessionRoot returns null when userSelectedFolders is empty or missing', () => {
  assert.equal(getPreferredSessionRoot({ userSelectedFolders: [] }), null);
  assert.equal(getPreferredSessionRoot({}), null);
  assert.equal(getPreferredSessionRoot(null), null);
});

test('getPreferredSessionRoot skips VM paths and desktop runtime paths', () => {
  const homeDir = os.homedir();
  const desktopPath = path.join(homeDir, '.local', 'share', 'claude-desktop', 'data');
  const result = getPreferredSessionRoot({
    userSelectedFolders: ['/sessions/demo', desktopPath, '/home/user/real-project'],
  });
  assert.equal(result, '/home/user/real-project');
});

// ============================================================================
// getAuthorizedSessionRoots
// ============================================================================

test('getAuthorizedSessionRoots returns deduplicated canonical roots', () => {
  const roots = getAuthorizedSessionRoots({
    userSelectedFolders: ['/home/user/project', '/home/user/other', '/home/user/project'],
  });
  assert.deepEqual(roots, ['/home/user/project', '/home/user/other']);
});

test('getAuthorizedSessionRoots skips VM paths and duplicates', () => {
  const roots = getAuthorizedSessionRoots({
    userSelectedFolders: ['/sessions/demo', '/home/user/project', '/home/user/project'],
  });
  assert.deepEqual(roots, ['/home/user/project']);
});

test('getAuthorizedSessionRoots returns empty array for missing userSelectedFolders', () => {
  assert.deepEqual(getAuthorizedSessionRoots({}), []);
  assert.deepEqual(getAuthorizedSessionRoots(null), []);
  assert.deepEqual(getAuthorizedSessionRoots(undefined), []);
});

// ============================================================================
// normalizeSessionRecord (standalone function)
// ============================================================================

test('normalizeSessionRecord standalone repairs synthetic cwd when userSelectedFolders available', () => {
  const result = normalizeSessionRecord('/tmp/fake-root', {
    sessionId: 'local_test',
    cwd: '/sessions/demo-session',
    userSelectedFolders: ['/home/user/dev/project'],
  });
  assert.equal(result.cwd, '/home/user/dev/project');
});

test('normalizeSessionRecord standalone returns sessionData unchanged when cwd is already canonical', () => {
  const input = {
    sessionId: 'local_test',
    cwd: '/home/user/dev/project',
    userSelectedFolders: ['/home/user/dev/project'],
  };
  const result = normalizeSessionRecord('/tmp/fake-root', input);
  assert.equal(result.cwd, '/home/user/dev/project');
});

test('normalizeSessionRecord standalone handles null and undefined input gracefully', () => {
  assert.equal(normalizeSessionRecord('/tmp/fake-root', null), null);
  assert.equal(normalizeSessionRecord('/tmp/fake-root', undefined), undefined);
});

// ============================================================================
// createSessionStore().getSessionInfo
// ============================================================================

test('createSessionStore().getSessionInfo returns session info for existing session', (t) => {
  const localAgentRoot = createTempRoot(t);
  const sessionId = 'local_info_session';
  const metadataPath = writeSessionFixture(localAgentRoot, sessionId, 'user/org');

  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
    cwd: '/sessions/demo',
    userSelectedFolders: ['/home/user/dev/project'],
  }, null, 2), 'utf8');

  invalidateMetadataFileCache();
  const store = createSessionStore({ localAgentRoot });
  const info = store.getSessionInfo(sessionId);

  assert.ok(info);
  assert.equal(info.metadataPath, metadataPath);
  assert.equal(info.sessionData.sessionId, sessionId);
  assert.equal(info.sessionData.cwd, '/home/user/dev/project');
  assert.equal(info.preferredRoot, '/home/user/dev/project');
});

test('createSessionStore().getSessionInfo returns null for non-existent session', (t) => {
  const localAgentRoot = createTempRoot(t);
  invalidateMetadataFileCache();
  const store = createSessionStore({ localAgentRoot });
  assert.equal(store.getSessionInfo('local_nonexistent'), null);
});

test('createSessionStore().getSessionInfo returns null for empty and null sessionId', (t) => {
  const localAgentRoot = createTempRoot(t);
  const store = createSessionStore({ localAgentRoot });
  assert.equal(store.getSessionInfo(''), null);
  assert.equal(store.getSessionInfo(null), null);
});

// ============================================================================
// createSessionStore().getAuthorizedRoots
// ============================================================================

test('createSessionStore().getAuthorizedRoots returns authorized roots from session metadata', (t) => {
  const localAgentRoot = createTempRoot(t);
  const sessionId = 'local_roots_session';
  const metadataPath = writeSessionFixture(localAgentRoot, sessionId, 'user/org');

  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId,
    cwd: '/home/user/dev/project',
    userSelectedFolders: ['/home/user/dev/project', '/home/user/dev/other'],
  }, null, 2), 'utf8');

  invalidateMetadataFileCache();
  const store = createSessionStore({ localAgentRoot });
  const roots = store.getAuthorizedRoots(sessionId);

  assert.deepEqual(roots, ['/home/user/dev/project', '/home/user/dev/other']);
});

test('createSessionStore().getAuthorizedRoots returns empty array for non-existent session', (t) => {
  const localAgentRoot = createTempRoot(t);
  invalidateMetadataFileCache();
  const store = createSessionStore({ localAgentRoot });
  assert.deepEqual(store.getAuthorizedRoots('local_nonexistent'), []);
});

// ============================================================================
// invalidateMetadataFileCache
// ============================================================================

test('invalidateMetadataFileCache causes next findSessionMetadataPath to re-scan', (t) => {
  const localAgentRoot = createTempRoot(t);
  const sessionId = 'local_cache_test';

  invalidateMetadataFileCache();
  assert.equal(findSessionMetadataPath(localAgentRoot, sessionId), null);

  const metadataPath = writeSessionFixture(localAgentRoot, sessionId, 'user/org');

  // Without invalidation, the cache still returns null
  assert.equal(findSessionMetadataPath(localAgentRoot, sessionId), null);

  // After invalidation, it finds the new file
  invalidateMetadataFileCache();
  assert.equal(findSessionMetadataPath(localAgentRoot, sessionId), metadataPath);
});

