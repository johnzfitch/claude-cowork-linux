const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_FILESYSTEM_PATH_ALIASES,
  createAsarAdapter,
  describeFileSystemRelinkIpcSurface,
  filterTranscriptMessages,
  getFileSystemRequestContext,
  isFileSystemPathRewriteChannel,
  isLocalSessionMutationChannel,
  isLocalSessionResultChannel,
  rewriteAliasedFilePath,
} = require('../../../stubs/cowork/asar_adapter.js');
const {
  createDirs,
} = require('../../../stubs/cowork/dirs.js');
const {
  createSessionOrchestrator,
} = require('../../../stubs/cowork/session_orchestrator.js');
const {
  createSessionStore,
} = require('../../../stubs/cowork/session_store.js');

function createTempDir(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-asar-adapter-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

test('isLocalSessionResultChannel matches local session read channels', () => {
  assert.equal(isLocalSessionResultChannel('$eipc_message$_cowork_$_claude.web_$_LocalAgentModeSessions_$_getSession'), true);
  assert.equal(isLocalSessionResultChannel('$eipc_message$_cowork_$_claude.web_$_LocalSessions_$_getAll'), true);
  assert.equal(isLocalSessionResultChannel('$eipc_message$_cowork_$_claude.web_$_LocalAgentModeSessions_$_getTranscript'), true);
  assert.equal(isLocalSessionResultChannel('$eipc_message$_cowork_$_claude.web_$_ClaudeCode_$_getStatus'), false);
});

test('isLocalSessionMutationChannel matches local session mutating channels', () => {
  assert.equal(isLocalSessionMutationChannel('$eipc_message$_cowork_$_claude.web_$_LocalAgentModeSessions_$_sendMessage'), true);
  assert.equal(isLocalSessionMutationChannel('$eipc_message$_cowork_$_claude.web_$_LocalSessions_$_setModel'), true);
  assert.equal(isLocalSessionMutationChannel('$eipc_message$_cowork_$_claude.web_$_LocalSessions_$_getAll'), false);
});

test('isFileSystemPathRewriteChannel matches bounded FileSystem channels', () => {
  assert.equal(
    isFileSystemPathRewriteChannel('$eipc_message$_x_$_claude.web_$_FileSystem_$_readLocalFile'),
    true
  );
  assert.equal(
    isFileSystemPathRewriteChannel('$eipc_message$_x_$_claude.web_$_FileSystem_$_openLocalFile'),
    true
  );
  assert.equal(
    isFileSystemPathRewriteChannel('$eipc_message$_x_$_claude.web_$_FileSystem_$_whichApplication'),
    true
  );
  assert.equal(
    isFileSystemPathRewriteChannel('$eipc_message$_x_$_claude.web_$_FileSystem_$_deleteLocalFile'),
    false
  );
});

test('describeFileSystemRelinkIpcSurface documents the current narrow relink IPC boundary', () => {
  const surface = describeFileSystemRelinkIpcSurface();

  assert.equal(surface.relinkRequestChannel, null);
  assert.deepEqual(surface.structuredFailureChannels, [
    {
      args: ['sessionId', 'path'],
      method: 'claude.web.FileSystem.readLocalFile',
    },
    {
      args: ['sessionId', 'path', 'showInFolder?'],
      method: 'claude.web.FileSystem.openLocalFile',
    },
  ]);
  assert.deepEqual(surface.chooserOnlyChannels, [
    'claude.settings.FilePickers.getFilePath',
    'claude.settings.FilePickers.getDirectoryPath',
    'claude.web.FileSystem.browseFiles',
    'claude.web.FileSystem.browseFolder',
  ]);
  assert.equal(surface.missingRequestContract.method, 'claude.web.FileSystem.relinkLocalFile');
  assert.deepEqual(surface.missingRequestContract.args, ['localSessionId', 'fileId', 'targetPath']);
});

test('filterTranscriptMessages strips queue/progress/last-prompt metadata from transcript IPC results', () => {
  const filtered = filterTranscriptMessages([
    { type: 'queue-operation' },
    { type: 'progress' },
    { type: 'last-prompt' },
    { type: 'user' },
    { type: 'assistant' },
  ]);

  assert.deepEqual(filtered, [
    { type: 'user' },
    { type: 'assistant' },
  ]);
});

test('wrapHandler normalizes getSession and getAll results through the orchestrator', async () => {
  const adapter = createAsarAdapter({
    sessionOrchestrator: {
      normalizeSessionRecord(sessionRecord) {
        return {
          ...sessionRecord,
          normalized: true,
        };
      },
    },
  });

  const getSessionHandler = adapter.wrapHandler(
    '$eipc_message$_cowork_$_claude.web_$_LocalAgentModeSessions_$_getSession',
    async () => ({ sessionId: 'local_demo' }),
  );
  const getAllHandler = adapter.wrapHandler(
    '$eipc_message$_cowork_$_claude.web_$_LocalSessions_$_getAll',
    async () => ([{ sessionId: 'local_a' }, { sessionId: 'local_b' }]),
  );

  const singleResult = await getSessionHandler();
  const listResult = await getAllHandler();

  assert.equal(singleResult.normalized, true);
  assert.deepEqual(listResult, [
    { sessionId: 'local_a', normalized: true },
    { sessionId: 'local_b', normalized: true },
  ]);
});

test('wrapHandler normalizes getTranscript results through the adapter', async () => {
  const adapter = createAsarAdapter({ sessionStore: null });
  const handler = adapter.wrapHandler(
    '$eipc_message$_cowork_$_claude.web_$_LocalAgentModeSessions_$_getTranscript',
    async () => ([{ type: 'queue-operation' }, { type: 'assistant' }]),
  );

  const result = await handler();
  assert.deepEqual(result, [{ type: 'assistant' }]);
});

test('wrapHandler rewrites mutating local-session calls to the canonical active session', async () => {
  const seenSessionIds = [];
  const adapter = createAsarAdapter({
    sessionStore: {
      resolveMutationSessionId(sessionId) {
        return sessionId === 'local_duplicate' ? 'local_active' : sessionId;
      },
    },
  });

  const handler = adapter.wrapHandler(
    '$eipc_message$_cowork_$_claude.web_$_LocalAgentModeSessions_$_sendMessage',
    async (sessionId, messageText) => {
      seenSessionIds.push(sessionId);
      return { sessionId, messageText };
    },
  );

  const result = await handler('local_duplicate', 'hello');
  assert.deepEqual(seenSessionIds, ['local_active']);
  assert.equal(result.sessionId, 'local_active');
});

test('rewriteAliasedFilePath remaps stale historical repo paths when target exists', (t) => {
  const tempRoot = createTempDir(t);
  const oldRoot = path.join(tempRoot, 'claude-cowork-linux');
  const newRoot = path.join(tempRoot, 'claude-linux');
  const oldPath = path.join(oldRoot, 'backend', 'src', 'environment.test.ts');
  const newPath = path.join(newRoot, 'backend', 'src', 'environment.test.ts');

  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(newPath, 'ok\n', 'utf8');

  const rewritten = rewriteAliasedFilePath(oldPath, [
    { from: path.join(oldRoot, 'backend'), to: path.join(newRoot, 'backend') },
  ]);
  assert.equal(rewritten, newPath);
});

test('rewriteAliasedFilePath leaves path unchanged when alias target is missing', (t) => {
  const tempRoot = createTempDir(t);
  const oldPath = path.join(tempRoot, 'claude-cowork-linux', 'cowork-ui', 'src', 'hooks', 'useStream.ts');

  const rewritten = rewriteAliasedFilePath(oldPath, [
    {
      from: path.join(tempRoot, 'claude-cowork-linux', 'cowork-ui'),
      to: path.join(tempRoot, 'claude-linux', 'cowork-ui'),
    },
  ]);
  assert.equal(rewritten, oldPath);
});

test('rewriteAliasedFilePath handles doubled paths by extracting sessions/ portion', (t) => {
  const tempRoot = createTempDir(t);
  const legacyRoot = path.join(tempRoot, 'Library', 'Application Support', 'Claude', 'LocalAgentModeSessions');
  const xdgRoot = path.join(tempRoot, '.config', 'Claude', 'local-agent-mode-sessions');

  // Create the target file at the XDG path
  const targetFile = path.join(xdgRoot, 'sessions', 'my-session', 'mnt', 'file.md');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, 'test\n', 'utf8');

  // Doubled path: legacy root + absolute path (without leading /) containing legacy root again
  const doubledPath = path.join(
    legacyRoot,
    tempRoot.substring(1), // strip leading / to simulate how asar doubles it
    'Library', 'Application Support', 'Claude', 'LocalAgentModeSessions',
    'sessions', 'my-session', 'mnt', 'file.md'
  );

  const rewritten = rewriteAliasedFilePath(doubledPath, [
    { from: legacyRoot, to: xdgRoot },
  ]);
  assert.equal(rewritten, targetFile);
});

test('rewriteAliasedFilePath rewrites macOS LocalAgentModeSessions paths to XDG', (t) => {
  const tempRoot = createTempDir(t);
  const legacyRoot = path.join(tempRoot, 'Library', 'Application Support', 'Claude', 'LocalAgentModeSessions');
  const xdgRoot = path.join(tempRoot, '.config', 'Claude', 'local-agent-mode-sessions');

  // Create the target file at the XDG path
  const targetFile = path.join(xdgRoot, 'sessions', 'great-nice-lovelace', 'mnt', 'uploads', 'report.md');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, 'content\n', 'utf8');

  // Single (non-doubled) macOS path
  const legacyPath = path.join(legacyRoot, 'sessions', 'great-nice-lovelace', 'mnt', 'uploads', 'report.md');

  const rewritten = rewriteAliasedFilePath(legacyPath, [
    { from: legacyRoot, to: xdgRoot },
  ]);
  assert.equal(rewritten, targetFile);
});

test('rewriteIpcArgs remaps stale FileSystem paths before delegating to the asar handler', async (t) => {
  const tempRoot = createTempDir(t);
  const oldRoot = path.join(tempRoot, 'claude-cowork-linux');
  const newRoot = path.join(tempRoot, 'claude-linux');
  const oldPath = path.join(oldRoot, 'cowork-ui', 'src', 'hooks', 'useStream.ts');
  const newPath = path.join(newRoot, 'cowork-ui', 'src', 'hooks', 'useStream.ts');

  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(newPath, 'export {}\n', 'utf8');

  const adapter = createAsarAdapter({
    sessionStore: null,
    fileSystemPathAliases: [
      { from: path.join(oldRoot, 'cowork-ui'), to: path.join(newRoot, 'cowork-ui') },
    ],
  });

  const seenPaths = [];
  const handler = adapter.wrapHandler(
    '$eipc_message$_x_$_claude.web_$_FileSystem_$_readLocalFile',
    async (targetPath) => {
      seenPaths.push(targetPath);
      return { ok: true };
    },
  );

  await handler(oldPath);
  assert.deepEqual(seenPaths, [newPath]);
});

test('rewriteIpcArgs prefers registry-backed orchestrator resolution before alias fallback', async () => {
  const seenPaths = [];
  const adapter = createAsarAdapter({
    fileSystemPathAliases: [
      {
        from: '/historical/root',
        to: '/alias/root',
      },
    ],
    sessionOrchestrator: {
      resolveFileSystemPath({ targetPath }) {
        return {
          resolvedPath: targetPath === '/historical/root/file.txt'
            ? '/registry/root/file.txt'
            : targetPath,
          resolution: targetPath === '/historical/root/file.txt' ? 'registry' : 'missing',
        };
      },
    },
    sessionStore: null,
  });

  const handler = adapter.wrapHandler(
    '$eipc_message$_x_$_claude.web_$_FileSystem_$_readLocalFile',
    async (targetPath) => {
      seenPaths.push(targetPath);
      return { ok: true };
    },
  );

  await handler('/historical/root/file.txt');
  assert.deepEqual(seenPaths, ['/registry/root/file.txt']);
});

test('getFileSystemRequestContext parses real extracted-app read/open argument shapes', () => {
  assert.deepEqual(
    getFileSystemRequestContext(
      '$eipc_message$_x_$_claude.web_$_FileSystem_$_readLocalFile',
      [{ sender: { id: 1 } }, 'local_demo', '/workspace/file.txt']
    ),
    {
      eventArg: { sender: { id: 1 } },
      localSessionId: 'local_demo',
      payloadArgs: ['local_demo', '/workspace/file.txt'],
      restArgs: [],
      targetPath: '/workspace/file.txt',
    }
  );

  assert.deepEqual(
    getFileSystemRequestContext(
      '$eipc_message$_x_$_claude.web_$_FileSystem_$_openLocalFile',
      [{ sender: { id: 2 } }, 'local_demo', '/workspace/file.txt', true]
    ),
    {
      eventArg: { sender: { id: 2 } },
      localSessionId: 'local_demo',
      payloadArgs: ['local_demo', '/workspace/file.txt', true],
      restArgs: [true],
      targetPath: '/workspace/file.txt',
    }
  );
});

test('getFileSystemRequestContext preserves legacy path-first and unscoped FileSystem argument shapes', () => {
  assert.deepEqual(
    getFileSystemRequestContext(
      '$eipc_message$_x_$_claude.web_$_FileSystem_$_readLocalFile',
      [{ sender: { id: 5 } }, '/workspace/file.txt']
    ),
    {
      eventArg: { sender: { id: 5 } },
      localSessionId: null,
      payloadArgs: ['/workspace/file.txt'],
      restArgs: [],
      targetPath: '/workspace/file.txt',
    }
  );

  assert.deepEqual(
    getFileSystemRequestContext(
      '$eipc_message$_x_$_claude.web_$_FileSystem_$_whichApplication',
      [{ sender: { id: 6 } }, '/usr/bin/node']
    ),
    {
      eventArg: { sender: { id: 6 } },
      localSessionId: null,
      payloadArgs: ['/usr/bin/node'],
      restArgs: [],
      targetPath: '/usr/bin/node',
    }
  );
});

test('wrapHandler rewrites real extracted-app readLocalFile(sessionId, path) calls against the explicit session id', async () => {
  const seenCalls = [];
  const adapter = createAsarAdapter({
    sessionOrchestrator: {
      resolveFileSystemPath({ localSessionId, targetPath }) {
        seenCalls.push({ localSessionId, targetPath });
        return {
          resolvedPath: '/resolved/by-registry.txt',
          resolution: 'registry',
        };
      },
    },
    sessionStore: null,
  });

  const handler = adapter.wrapHandler(
    '$eipc_message$_x_$_claude.web_$_FileSystem_$_readLocalFile',
    async (event, sessionId, targetPath) => ({ event, sessionId, targetPath }),
  );

  const result = await handler({ sender: { id: 3 } }, 'local_demo', '/workspace/file.txt');
  assert.deepEqual(seenCalls, [{
    localSessionId: 'local_demo',
    targetPath: '/workspace/file.txt',
  }]);
  assert.equal(result.sessionId, 'local_demo');
  assert.equal(result.targetPath, '/resolved/by-registry.txt');
});

test('wrapHandler rewrites real extracted-app openLocalFile(sessionId, path, showInFolder) calls without disturbing tail args', async () => {
  const adapter = createAsarAdapter({
    sessionOrchestrator: {
      resolveFileSystemPath() {
        return {
          resolvedPath: '/resolved/by-registry.txt',
          resolution: 'registry',
        };
      },
    },
    sessionStore: null,
  });

  const seenCalls = [];
  const handler = adapter.wrapHandler(
    '$eipc_message$_x_$_claude.web_$_FileSystem_$_openLocalFile',
    async (event, sessionId, targetPath, showInFolder) => {
      seenCalls.push({ sessionId, targetPath, showInFolder });
      return { ok: true };
    },
  );

  await handler({ sender: { id: 4 } }, 'local_demo', '/workspace/file.txt', true);
  assert.deepEqual(seenCalls, [{
    sessionId: 'local_demo',
    showInFolder: true,
    targetPath: '/resolved/by-registry.txt',
  }]);
});

test('wrapHandler rejects existing FileSystem paths outside authorized roots instead of passing through', async () => {
  const adapter = createAsarAdapter({
    sessionOrchestrator: {
      resolveFileSystemPath() {
        return {
          authorized: false,
          resolvedPath: '/outside/root/secret.txt',
          resolution: 'unauthorized',
        };
      },
    },
    sessionStore: null,
  });

  const handler = adapter.wrapHandler(
    '$eipc_message$_x_$_claude.web_$_FileSystem_$_readLocalFile',
    async () => ({ ok: true }),
  );

  await assert.rejects(
    handler({ sender: { id: 7 } }, '/outside/root/secret.txt'),
    /Unauthorized FileSystem path/
  );
});

test('wrapHandler rejects FileSystem access when session context has not been established', async () => {
  const adapter = createAsarAdapter({
    sessionOrchestrator: {
      resolveFileSystemPath() {
        return {
          authorized: false,
          resolvedPath: '/workspace/file.txt',
          resolution: 'context_required',
        };
      },
    },
    sessionStore: null,
  });

  const handler = adapter.wrapHandler(
    '$eipc_message$_x_$_claude.web_$_FileSystem_$_readLocalFile',
    async () => ({ ok: true }),
  );

  await assert.rejects(
    handler({ sender: { id: 9 } }, '/workspace/file.txt'),
    /Missing FileSystem session context/
  );
});

test('wrapHandler surfaces structured relink-required errors for missing tracked files', async () => {
  const adapter = createAsarAdapter({
    sessionOrchestrator: {
      resolveFileSystemPath({ localSessionId, targetPath }) {
        assert.equal(localSessionId, 'local_demo');
        assert.equal(targetPath, '/workspace/missing.txt');
        return {
          authorized: true,
          candidates: [],
          entry: {
            fileId: 'file_missing',
            currentPath: '/workspace/missing.txt',
            originalPath: '/workspace/missing.txt',
            status: 'missing',
            authorizedRoots: ['/workspace'],
            provenance: { created_by: 'cowork', linked_by: 'user' },
            history: [],
          },
          file: {
            fileId: 'file_missing',
            currentPath: '/workspace/missing.txt',
            originalPath: '/workspace/missing.txt',
            status: 'missing',
            authorizedRoots: ['/workspace'],
            provenance: { created_by: 'cowork', linked_by: 'user' },
            history: [],
          },
          fileId: 'file_missing',
          relinkRequired: true,
          requestedPath: '/workspace/missing.txt',
          resolvedPath: '/workspace/missing.txt',
          resolution: 'missing',
        };
      },
    },
    sessionStore: null,
  });

  const handler = adapter.wrapHandler(
    '$eipc_message$_x_$_claude.web_$_FileSystem_$_readLocalFile',
    async () => ({ ok: true }),
  );

  await assert.rejects(
    async () => {
      await handler({ sender: { id: 10 } }, 'local_demo', '/workspace/missing.txt');
    },
    (error) => {
      assert.equal(error.code, 'COWORK_FILE_RELINK_REQUIRED');
      assert.equal(error.fileResolution, 'missing');
      assert.equal(error.fileId, 'file_missing');
      assert.equal(error.localSessionId, 'local_demo');
      assert.equal(error.relinkRequired, true);
      assert.equal(error.requestedPath, '/workspace/missing.txt');
      assert.equal(error.resolvedPath, '/workspace/missing.txt');
      assert.equal(error.ambiguity, null);
      return true;
    }
  );
});

test('wrapHandler surfaces structured relink-required errors for ambiguous tracked files on real openLocalFile shapes', async () => {
  const adapter = createAsarAdapter({
    sessionOrchestrator: {
      resolveFileSystemPath({ localSessionId, targetPath }) {
        assert.equal(localSessionId, 'local_demo');
        assert.equal(targetPath, '/workspace/note.txt');
        return {
          authorized: true,
          candidates: [
            { path: '/workspace/a/note.txt', confidence: 'strong', reason: 'fingerprint' },
            { path: '/workspace/b/note.txt', confidence: 'strong', reason: 'fingerprint' },
          ],
          entry: {
            fileId: 'file_ambiguous',
            currentPath: '/workspace/note.txt',
            originalPath: '/workspace/note.txt',
            status: 'missing',
            authorizedRoots: ['/workspace'],
            provenance: { created_by: 'cowork', linked_by: 'user' },
            history: [],
          },
          file: {
            fileId: 'file_ambiguous',
            currentPath: '/workspace/note.txt',
            originalPath: '/workspace/note.txt',
            status: 'missing',
            authorizedRoots: ['/workspace'],
            provenance: { created_by: 'cowork', linked_by: 'user' },
            history: [],
          },
          fileId: 'file_ambiguous',
          relinkRequired: true,
          requestedPath: '/workspace/note.txt',
          resolvedPath: '/workspace/note.txt',
          resolution: 'ambiguous',
        };
      },
    },
    sessionStore: null,
  });

  const handler = adapter.wrapHandler(
    '$eipc_message$_x_$_claude.web_$_FileSystem_$_openLocalFile',
    async () => ({ ok: true }),
  );

  await assert.rejects(
    async () => {
      await handler({ sender: { id: 11 } }, 'local_demo', '/workspace/note.txt', true);
    },
    (error) => {
      assert.equal(error.code, 'COWORK_FILE_RELINK_REQUIRED');
      assert.equal(error.fileResolution, 'ambiguous');
      assert.equal(error.fileId, 'file_ambiguous');
      assert.equal(error.localSessionId, 'local_demo');
      assert.equal(error.candidates.length, 2);
      assert.deepEqual(error.ambiguity, {
        candidates: error.candidates,
      });
      return true;
    }
  );
});

test('wrapHandler resolves FileSystem paths against the requesting session instead of another active session', async (t) => {
  const tempRoot = createTempDir(t);
  const localAgentRoot = path.join(tempRoot, 'claude-local');
  const workspaceOne = path.join(tempRoot, 'workspace-one');
  const workspaceTwo = path.join(tempRoot, 'workspace-two');
  const sessionOneId = 'local_one';
  const sessionTwoId = 'local_two';
  const metadataOnePath = path.join(localAgentRoot, 'user', 'org', sessionOneId + '.json');
  const metadataTwoPath = path.join(localAgentRoot, 'user', 'org', sessionTwoId + '.json');
  const stalePath = path.join(workspaceOne, 'src', 'note.txt');
  const recoveredPath = path.join(workspaceOne, 'dst', 'note.txt');
  const otherSessionPath = path.join(workspaceTwo, 'src', 'note.txt');
  fs.mkdirSync(path.dirname(metadataOnePath), { recursive: true });
  fs.mkdirSync(path.dirname(stalePath), { recursive: true });
  fs.mkdirSync(path.dirname(recoveredPath), { recursive: true });
  fs.mkdirSync(path.dirname(otherSessionPath), { recursive: true });
  fs.writeFileSync(metadataOnePath, JSON.stringify({
    cwd: workspaceOne,
    sessionId: sessionOneId,
    userSelectedFolders: [workspaceOne],
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(metadataTwoPath, JSON.stringify({
    cwd: workspaceTwo,
    sessionId: sessionTwoId,
    userSelectedFolders: [workspaceTwo],
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(stalePath, 'hello\n', 'utf8');
  fs.writeFileSync(otherSessionPath, 'hello\n', 'utf8');

  const sessionStore = createSessionStore({ localAgentRoot });
  sessionStore.observeSessionId(sessionTwoId);
  const sessionOrchestrator = createSessionOrchestrator({
    dirs: createDirs({ env: {}, homeDir: tempRoot }),
    sessionStore,
  });

  sessionOrchestrator.resolveFileSystemPath({
    localSessionId: sessionOneId,
    targetPath: stalePath,
  });
  fs.renameSync(stalePath, recoveredPath);

  const adapter = createAsarAdapter({
    sessionOrchestrator,
    sessionStore,
  });

  const getSessionHandler = adapter.wrapHandler(
    '$eipc_message$_cowork_$_claude.web_$_LocalAgentModeSessions_$_getSession',
    async () => ({ sessionId: sessionOneId }),
  );
  await getSessionHandler({ sender: { id: 101 } }, sessionOneId);

  const seenPaths = [];
  const fileHandler = adapter.wrapHandler(
    '$eipc_message$_x_$_claude.web_$_FileSystem_$_readLocalFile',
    async (event, targetPath) => {
      seenPaths.push(targetPath);
      return { ok: true };
    },
  );

  await fileHandler({ sender: { id: 101 } }, stalePath);
  assert.deepEqual(seenPaths, [recoveredPath]);
});

test('default file-system aliases include macOS-to-XDG mapping and project sources', () => {
  const homeDir = require('os').homedir();
  const xdgConfigHome = (typeof process.env.XDG_CONFIG_HOME === 'string' && process.env.XDG_CONFIG_HOME.trim())
    ? require('path').resolve(process.env.XDG_CONFIG_HOME)
    : require('path').join(homeDir, '.config');

  assert.equal(DEFAULT_FILESYSTEM_PATH_ALIASES.length, 3);

  // First alias: macOS LocalAgentModeSessions → XDG local-agent-mode-sessions
  assert.equal(
    DEFAULT_FILESYSTEM_PATH_ALIASES[0].from,
    require('path').join(homeDir, 'Library', 'Application Support', 'Claude', 'LocalAgentModeSessions'),
  );
  assert.equal(
    DEFAULT_FILESYSTEM_PATH_ALIASES[0].to,
    require('path').join(xdgConfigHome, 'Claude', 'local-agent-mode-sessions'),
  );

  // Remaining aliases: project-specific
  assert.equal(DEFAULT_FILESYSTEM_PATH_ALIASES[1].from, require('path').join(homeDir, 'dev', 'claude-cowork-linux', 'backend'));
  assert.equal(DEFAULT_FILESYSTEM_PATH_ALIASES[2].from, require('path').join(homeDir, 'dev', 'claude-cowork-linux', 'cowork-ui'));
});

test('wrapHandler marks start/getSession activity in the session store', async () => {
  const observed = [];
  const adapter = createAsarAdapter({
    sessionStore: {
      observeSessionId(sessionId) {
        observed.push(['id', sessionId]);
      },
      observeSessionRead(sessionRecord) {
        observed.push(['read', sessionRecord.sessionId]);
        return {
          ...sessionRecord,
          normalized: true,
        };
      },
    },
  });

  const startHandler = adapter.wrapHandler(
    '$eipc_message$_cowork_$_claude.web_$_LocalAgentModeSessions_$_start',
    async () => ({ sessionId: 'local_started' }),
  );
  const getSessionHandler = adapter.wrapHandler(
    '$eipc_message$_cowork_$_claude.web_$_LocalAgentModeSessions_$_getSession',
    async () => ({ sessionId: 'local_opened' }),
  );

  const startResult = await startHandler();
  const getSessionResult = await getSessionHandler('local_opened');

  assert.deepEqual(observed, [
    ['id', 'local_started'],
    ['read', 'local_opened'],
  ]);
  assert.equal(startResult.sessionId, 'local_started');
  assert.equal(getSessionResult.normalized, true);
});
