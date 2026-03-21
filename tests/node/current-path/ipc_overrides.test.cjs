const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createOverrideRegistry,
  matchOverride,
  getMimeType,
  isBinaryMime,
  readLocalFileContent,
} = require('../../../stubs/cowork/ipc_overrides.js');

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-ipc-overrides-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('matchOverride matches channel suffixes regardless of UUID prefix', () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));

  const handler = matchOverride(
    '$eipc_message$_61a9f65f-1ad1-4154-b2da-52d6d0694886_$_claude.web_$_ComputerUseTcc_$_getState',
    registry
  );
  assert.ok(handler, 'should match ComputerUseTcc_$_getState');

  const handler2 = matchOverride(
    '$eipc_message$_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_$_claude.web_$_ClaudeVM_$_getRunningStatus',
    registry
  );
  assert.ok(handler2, 'should match ClaudeVM_$_getRunningStatus with different UUID');
});

test('matchOverride returns null for unregistered channels', () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));

  const handler = matchOverride(
    '$eipc_message$_test_$_claude.web_$_LocalSessions_$_sendMessage',
    registry
  );
  assert.equal(handler, null);
});

test('matchOverride returns null for non-string channels', () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  assert.equal(matchOverride(42, registry), null);
  assert.equal(matchOverride(null, registry), null);
});

test('ComputerUseTcc_$_getState override returns granted shape', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_ComputerUseTcc_$_getState', registry);
  const result = await handler();
  assert.equal(result.granted, true);
  assert.equal(result.status, 'granted');
});

test('ClaudeCode_$_getStatus override returns ready string', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_ClaudeCode_$_getStatus', registry);
  const result = await handler();
  assert.equal(result, 'ready');
});

test('ClaudeVM_$_isSupported override returns supported', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_ClaudeVM_$_isSupported', registry);
  const result = await handler();
  assert.equal(result, 'supported');
});

test('ClaudeVM_$_isProcessRunning override delegates to getProcessState', async () => {
  const calls = [];
  const registry = createOverrideRegistry(function(args) {
    calls.push(args);
    return { running: true, exitCode: null };
  });
  const handler = matchOverride('claude.web_$_ClaudeVM_$_isProcessRunning', registry);
  const result = await handler('event', 'proc-123');
  assert.equal(result.running, true);
  assert.equal(calls.length, 1);
});

test('FileSystem_$_readLocalFile reads text files with correct shape', async (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'test.md');
  fs.writeFileSync(filePath, '# Hello\n\nWorld', 'utf8');

  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_FileSystem_$_readLocalFile', registry);
  const result = await handler(null, 'local_session', filePath);

  assert.equal(result.content, '# Hello\n\nWorld');
  assert.equal(result.mimeType, 'text/markdown');
  assert.equal(result.fileName, 'test.md');
  assert.equal(result.encoding, 'utf-8');
});

test('FileSystem_$_readLocalFile reads binary files as base64', async (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'test.png');
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(filePath, buf);

  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_FileSystem_$_readLocalFile', registry);
  const result = await handler(null, 'local_session', filePath);

  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.encoding, 'base64');
  assert.equal(result.fileName, 'test.png');
  assert.equal(Buffer.from(result.content, 'base64').length, 8);
});

test('FileSystem_$_readLocalFile returns null for non-absolute paths', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_FileSystem_$_readLocalFile', registry);
  const result = await handler(null, 'local_session', 'relative/path.txt');
  assert.equal(result, null);
});

test('FileSystem_$_readLocalFile returns null for missing files', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_FileSystem_$_readLocalFile', registry);
  const result = await handler(null, 'local_session', '/nonexistent/file.txt');
  assert.equal(result, null);
});

test('FileSystem_$_readLocalFile decodes URI-encoded paths', async (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'my file.txt');
  fs.writeFileSync(filePath, 'content', 'utf8');

  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_FileSystem_$_readLocalFile', registry);
  const encoded = encodeURIComponent(filePath);
  const result = await handler(null, 'local_session', encoded);

  assert.equal(result.content, 'content');
});

test('FileSystem_$_whichApplication returns appName shape', async (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'test.txt');
  fs.writeFileSync(filePath, 'x', 'utf8');

  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_FileSystem_$_whichApplication', registry);
  const result = await handler(null, filePath);
  // Result is either null or { appName: string }
  if (result !== null) {
    assert.equal(typeof result.appName, 'string');
  }
});

test('CoworkSpaces_$_getAllSpaces returns empty array', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_CoworkSpaces_$_getAllSpaces', registry);
  const result = await handler();
  assert.deepEqual(result, []);
});

test('getMimeType returns correct types for common extensions', () => {
  assert.equal(getMimeType('/foo/bar.md'), 'text/markdown');
  assert.equal(getMimeType('/foo/bar.json'), 'application/json');
  assert.equal(getMimeType('/foo/bar.png'), 'image/png');
  assert.equal(getMimeType('/foo/bar.unknown'), 'text/plain');
});

test('isBinaryMime correctly classifies mime types', () => {
  assert.equal(isBinaryMime('image/png'), true);
  assert.equal(isBinaryMime('application/pdf'), true);
  assert.equal(isBinaryMime('text/plain'), false);
  assert.equal(isBinaryMime('text/markdown'), false);
});

test('override registry covers all known broken handlers', () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const expectedSuffixes = [
    'ComputerUseTcc_$_getState',
    'ComputerUseTcc_$_requestAccess',
    'ComputerUseTcc_$_requestAccessibility',
    'ComputerUseTcc_$_requestScreenRecording',
    'ComputerUseTcc_$_openSystemSettings',
    'ClaudeVM_$_getRunningStatus',
    'ClaudeVM_$_getDownloadStatus',
    'ClaudeVM_$_isSupported',
    'ClaudeVM_$_getSupportStatus',
    'ClaudeVM_$_isProcessRunning',
    'ClaudeCode_$_getStatus',
    'ClaudeCode_$_prepare',
    'ClaudeCode_$_checkGitAvailable',
    'FileSystem_$_readLocalFile',
    'FileSystem_$_openLocalFile',
    'FileSystem_$_whichApplication',
    'FileSystem_$_showInFolder',
    'FileSystem_$_getSystemPath',
    'MainWindowTitleBar_$_requestMainMenuPopup',
    'BrowserNavigation_$_requestMainMenuPopup',
    'CoworkSpaces_$_getAllSpaces',
    // Phase 4: Dispatch/Bridge
    'LocalAgentModeSessions_$_abandonBridgeEnvironment',
    'LocalAgentModeSessions_$_deleteBridgeAgentMemory',
    'LocalAgentModeSessions_$_deleteBridgeSession',
    'LocalAgentModeSessions_$_getBridgeConsent',
    'LocalAgentModeSessions_$_getSessionsBridgeEnabled',
    'LocalAgentModeSessions_$_kickBridgePoll',
    'LocalAgentModeSessions_$_onBridgePermissionPreflight',
    'LocalAgentModeSessions_$_resetBridge',
    'LocalAgentModeSessions_$_resetBridgeSession',
    'LocalAgentModeSessions_$_respondBridgePermissionPreflight',
    'LocalAgentModeSessions_$_sessionsBridgeStatus',
    'LocalAgentModeSessions_$_setSessionsBridgeEnabled',
    // Phase 4: MCP
    'LocalAgentModeSessions_$_mcpCallTool',
    'LocalAgentModeSessions_$_mcpListResources',
    'LocalAgentModeSessions_$_mcpReadResource',
    // Phase 4: Permissions/Folders
    'LocalAgentModeSessions_$_requestFolderTccAccess',
    'LocalAgentModeSessions_$_setChromePermissionMode',
    // Phase 4: Session Management
    'LocalAgentModeSessions_$_onCoworkFromMain',
    'LocalAgentModeSessions_$_onRemoteSessionStart',
    'LocalAgentModeSessions_$_openOutputsDir',
    'LocalAgentModeSessions_$_setDraftSessionFolders',
    // Phase 4: Plugin/Skill
    'LocalAgentModeSessions_$_respondDirectoryServers',
    'LocalAgentModeSessions_$_respondPluginSearch',
    'LocalAgentModeSessions_$_syncSkills',
    // Phase 4: Sharing
    'LocalAgentModeSessions_$_shareSession',
    // Startup
    'Startup_$_isStartupOnLoginEnabled',
    'Startup_$_setStartupOnLoginEnabled',
    'Startup_$_isMenuBarEnabled',
    'Startup_$_setMenuBarEnabled',
  ];
  for (const suffix of expectedSuffixes) {
    const handler = matchOverride('test_$_' + suffix, registry);
    assert.ok(handler, 'missing override for: ' + suffix);
  }
});

test('override handlers return fresh objects (not shared references)', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_ComputerUseTcc_$_getState', registry);
  const a = await handler();
  const b = await handler();
  assert.notEqual(a, b, 'handlers should return new objects each call');
  assert.deepEqual(a, b);
});

const {
  extractEipcUuid,
  proactivelyRegisterOverrides,
  isProactiveChannel,
} = require('../../../stubs/cowork/ipc_overrides.js');

test('extractEipcUuid extracts UUID from EIPC channel strings', () => {
  assert.equal(
    extractEipcUuid('$eipc_message$_404349b0-8c09-4d5c-b863-8b2ed327d8db_$_claude.web_$_FileSystem_$_readLocalFile'),
    '404349b0-8c09-4d5c-b863-8b2ed327d8db'
  );
  assert.equal(
    extractEipcUuid('$eipc_message$_61a9f65f-1ad1-4154-b2da-52d6d0694886_$_claude.settings_$_Auth_$_getToken'),
    '61a9f65f-1ad1-4154-b2da-52d6d0694886'
  );
});

test('extractEipcUuid returns null for non-EIPC channels', () => {
  assert.equal(extractEipcUuid('regular-ipc-channel'), null);
  assert.equal(extractEipcUuid(42), null);
  assert.equal(extractEipcUuid(null), null);
});

test('proactivelyRegisterOverrides only registers proactive-only handlers', () => {
  const registered = {};
  const removed = [];
  const handleFn = (channel, handler) => { registered[channel] = handler; };
  const removeFn = (channel) => { removed.push(channel); };
  // Use real proactive-only suffixes (ComputerUseTcc) + a non-proactive one
  const registry = {
    'ComputerUseTcc_$_getState': async () => 'tcc',
    'ComputerUseTcc_$_requestAccess': async () => 'access',
    'ClaudeCode_$_getStatus': async () => 'ready',  // NOT proactive-only
  };

  proactivelyRegisterOverrides(handleFn, removeFn, registry, 'test-uuid-1234-5678-abcd-ef0123456789');

  // Only 2 proactive-only handlers * 3 namespaces = 6 channels (ClaudeCode excluded)
  assert.equal(Object.keys(registered).length, 6);
  assert.ok(registered['$eipc_message$_test-uuid-1234-5678-abcd-ef0123456789_$_claude.web_$_ComputerUseTcc_$_getState']);
  assert.ok(registered['$eipc_message$_test-uuid-1234-5678-abcd-ef0123456789_$_claude.hybrid_$_ComputerUseTcc_$_requestAccess']);
  // ClaudeCode should NOT be registered proactively
  assert.ok(!registered['$eipc_message$_test-uuid-1234-5678-abcd-ef0123456789_$_claude.web_$_ClaudeCode_$_getStatus']);
});

test('proactivelyRegisterOverrides skips duplicate UUIDs', () => {
  const calls = [];
  const handleFn = (channel) => { calls.push(channel); };
  const removeFn = () => {};
  const registry = { 'ComputerUseTcc_$_getState': async () => 'tcc' };

  // Use the same UUID as above — should be skipped since we already registered
  proactivelyRegisterOverrides(handleFn, removeFn, registry, 'test-uuid-1234-5678-abcd-ef0123456789');
  assert.equal(calls.length, 0, 'should skip already-registered UUID');
});

test('matchOverride rejects $store$ channels that partially match override suffixes', () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));

  // This should NOT match — the channel ends with _$store$_getState, not _$_apiReachability
  const handler = matchOverride(
    '$eipc_message$_404349b0_$_claude.web_$_ClaudeVM_$_apiReachability_$store$_getState',
    registry
  );
  assert.equal(handler, null, 'should not match $store$ variant');

  // But the actual method channel SHOULD match
  const handler2 = matchOverride(
    '$eipc_message$_404349b0_$_claude.web_$_ClaudeVM_$_apiReachability',
    registry
  );
  assert.ok(handler2, 'should match the actual method channel');
});

test('requestMainMenuPopup calls popup on stored global menu', async () => {
  // Mock electron in require cache so the handler's require('electron') resolves
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  const mockKey = '__mock_electron_for_menu_test__';
  Module._resolveFilename = function(request, ...args) {
    if (request === 'electron') return mockKey;
    return origResolve.call(this, request, ...args);
  };
  require.cache[mockKey] = {
    id: mockKey, filename: mockKey, loaded: true,
    exports: {
      BrowserWindow: {
        fromWebContents() { return null; },
        getFocusedWindow() { return null; },
      },
    },
  };

  try {
    const popupCalls = [];
    global.__coworkApplicationMenu = {
      popup(opts) { popupCalls.push(opts); },
    };
    const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
    const handler = matchOverride('claude.web_$_MainWindowTitleBar_$_requestMainMenuPopup', registry);
    await handler({ sender: null });
    assert.equal(popupCalls.length, 1);
  } finally {
    delete global.__coworkApplicationMenu;
    delete require.cache[mockKey];
    Module._resolveFilename = origResolve;
  }
});

test('requestMainMenuPopup is a no-op when global menu is not set', async () => {
  delete global.__coworkApplicationMenu;
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_BrowserNavigation_$_requestMainMenuPopup', registry);
  await assert.doesNotReject(async () => handler({ sender: null }));
});

test('override handlers return fresh objects for object results (not shared references)', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('claude.web_$_ComputerUseTcc_$_getState', registry);
  const a = await handler();
  const b = await handler();
  assert.notEqual(a, b, 'handlers should return new objects each call');
  assert.deepEqual(a, b);
});

// ================================================================
// Phase 4: Dispatch/Bridge handler tests
// ================================================================

test('getBridgeConsent returns consented shape', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_getBridgeConsent', registry);
  const result = await handler(null);
  assert.deepEqual(result, { consented: true });
});

test('getSessionsBridgeEnabled defaults to false, persists after set', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const getHandler = matchOverride('test_$_LocalAgentModeSessions_$_getSessionsBridgeEnabled', registry);
  const setHandler = matchOverride('test_$_LocalAgentModeSessions_$_setSessionsBridgeEnabled', registry);
  assert.equal(await getHandler(), false);
  await setHandler(null, true);
  assert.equal(await getHandler(), true);
  await setHandler(null, false);
  assert.equal(await getHandler(), false);
});

test('sessionsBridgeStatus reflects enabled state', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const statusHandler = matchOverride('test_$_LocalAgentModeSessions_$_sessionsBridgeStatus', registry);
  const setHandler = matchOverride('test_$_LocalAgentModeSessions_$_setSessionsBridgeEnabled', registry);
  const initial = await statusHandler();
  assert.equal(initial.status, 'disconnected');
  assert.equal(initial.enabled, false);
  await setHandler(null, true);
  const updated = await statusHandler();
  assert.equal(updated.status, 'connected');
  assert.equal(updated.enabled, true);
});

test('bridge no-op handlers return null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const noOpSuffixes = [
    'LocalAgentModeSessions_$_abandonBridgeEnvironment',
    'LocalAgentModeSessions_$_deleteBridgeAgentMemory',
    'LocalAgentModeSessions_$_deleteBridgeSession',
    'LocalAgentModeSessions_$_kickBridgePoll',
    'LocalAgentModeSessions_$_onBridgePermissionPreflight',
    'LocalAgentModeSessions_$_resetBridge',
    'LocalAgentModeSessions_$_resetBridgeSession',
    'LocalAgentModeSessions_$_respondBridgePermissionPreflight',
    'LocalAgentModeSessions_$_setSessionsBridgeEnabled',
  ];
  for (const suffix of noOpSuffixes) {
    const handler = matchOverride('test_$_' + suffix, registry);
    assert.ok(handler, 'missing handler: ' + suffix);
    const result = await handler(null);
    assert.equal(result, null, suffix + ' should return null');
  }
});

// ================================================================
// Phase 4: MCP handler tests
// ================================================================

test('mcpCallTool returns null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_mcpCallTool', registry);
  const result = await handler(null, 'toolName', { arg: 'value' });
  assert.equal(result, null);
});

test('mcpListResources returns empty array', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_mcpListResources', registry);
  const result = await handler(null);
  assert.deepEqual(result, []);
});

test('mcpReadResource returns null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_mcpReadResource', registry);
  const result = await handler(null, 'resource-uri');
  assert.equal(result, null);
});

// ================================================================
// Phase 4: Permissions handler tests
// ================================================================

test('requestFolderTccAccess returns granted on Linux', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_requestFolderTccAccess', registry);
  const result = await handler(null, '/some/path');
  assert.deepEqual(result, { granted: true });
});

test('setChromePermissionMode returns null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_setChromePermissionMode', registry);
  const result = await handler(null, 'auto');
  assert.equal(result, null);
});

// ================================================================
// Phase 4: Session management handler tests
// ================================================================

test('onCoworkFromMain returns null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_onCoworkFromMain', registry);
  const result = await handler(null, { type: 'test' });
  assert.equal(result, null);
});

test('onRemoteSessionStart returns null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_onRemoteSessionStart', registry);
  const result = await handler(null, 'session-123');
  assert.equal(result, null);
});

test('openOutputsDir returns null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_openOutputsDir', registry);
  const result = await handler(null, 'session-123');
  assert.equal(result, null);
});

test('setDraftSessionFolders returns null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_setDraftSessionFolders', registry);
  const result = await handler(null, ['/home/user/project']);
  assert.equal(result, null);
});

// ================================================================
// Phase 4: Plugin/Skill handler tests
// ================================================================

test('respondDirectoryServers returns null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_respondDirectoryServers', registry);
  const result = await handler(null);
  assert.equal(result, null);
});

test('respondPluginSearch returns null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_respondPluginSearch', registry);
  const result = await handler(null);
  assert.equal(result, null);
});

test('syncSkills returns null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_syncSkills', registry);
  const result = await handler(null);
  assert.equal(result, null);
});

// ================================================================
// Phase 4: Sharing handler test
// ================================================================

test('shareSession returns null on Linux', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_LocalAgentModeSessions_$_shareSession', registry);
  const result = await handler(null, 'session-123');
  assert.equal(result, null);
});

// ================================================================
// Startup handler tests
// ================================================================

test('isStartupOnLoginEnabled returns false on Linux', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_Startup_$_isStartupOnLoginEnabled', registry);
  const result = await handler();
  assert.equal(result, false);
});

test('isMenuBarEnabled returns false on Linux', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_Startup_$_isMenuBarEnabled', registry);
  const result = await handler();
  assert.equal(result, false);
});

test('setStartupOnLoginEnabled returns null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_Startup_$_setStartupOnLoginEnabled', registry);
  const result = await handler(null, true);
  assert.equal(result, null);
});

test('setMenuBarEnabled returns null', async () => {
  const registry = createOverrideRegistry(() => ({ running: false, exitCode: 0 }));
  const handler = matchOverride('test_$_Startup_$_setMenuBarEnabled', registry);
  const result = await handler(null, true);
  assert.equal(result, null);
});
