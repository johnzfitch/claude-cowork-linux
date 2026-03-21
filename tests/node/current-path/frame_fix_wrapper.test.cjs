const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

function loadFrameFixHelpers(overrides) {
  const wrapperPath = path.join(__dirname, '..', '..', '..', 'stubs', 'frame-fix', 'frame-fix-wrapper.js');
  const source = fs.readFileSync(wrapperPath, 'utf8');
  const helperStart = source.indexOf('function wrapAliasedFileSystemHandler');
  const ipcTapEnd = source.indexOf('// ============================================================\n// IPC TAP');
  const criticalEnd = source.indexOf('// ============================================================\n// CRITICAL: Patch ipcMain IMMEDIATELY before any asar code runs');
  const helperEnd = ipcTapEnd !== -1 ? ipcTapEnd : criticalEnd;
  if (helperStart === -1 || helperEnd === -1 || helperEnd <= helperStart) {
    throw new Error('Failed to locate frame-fix helper block in ' + wrapperPath);
  }

  const helperSource = source.slice(helperStart, helperEnd);
  const context = {
    REAL_PLATFORM: 'linux',
    console: {
      log: () => {},
      error: () => {},
    },
    global: {},
    DEFAULT_FILESYSTEM_PATH_ALIASES: overrides && overrides.DEFAULT_FILESYSTEM_PATH_ALIASES
      ? overrides.DEFAULT_FILESYSTEM_PATH_ALIASES
      : [],
    isFileSystemPathRewriteChannel: overrides && overrides.isFileSystemPathRewriteChannel
      ? overrides.isFileSystemPathRewriteChannel
      : (() => false),
    rewriteAliasedFilePath: overrides && overrides.rewriteAliasedFilePath
      ? overrides.rewriteAliasedFilePath
      : ((value) => value),
    require: overrides && typeof overrides.require === 'function'
      ? overrides.require
      : (() => {
        throw new Error('Unexpected require');
      }),
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: path.basename(wrapperPath) });
  return context;
}

test('installLinuxMenuInterceptors tolerates missing app.setApplicationMenu and hides menus instead of throwing', () => {
  const app = new EventEmitter();
  const fakeWindow = {
    hiddenStates: [],
    setMenuBarVisibility(value) {
      this.hiddenStates.push(value);
    },
  };
  const electronModule = {
    app,
    BrowserWindow: {
      getAllWindows() {
        return [fakeWindow];
      },
    },
    Menu: {
      calls: [],
      setApplicationMenu(menu) {
        this.calls.push(menu);
      },
      setDefaultApplicationMenu() {
        if (typeof app.setApplicationMenu !== 'function') {
          throw new TypeError('app.setApplicationMenu is not a function');
        }
        return app.setApplicationMenu(null);
      },
    },
  };

  const helpers = loadFrameFixHelpers({
    require(request) {
      if (request === 'electron') {
        return electronModule;
      }
      throw new Error('Unexpected require: ' + request);
    },
  });

  helpers.installLinuxMenuInterceptors(electronModule);

  assert.equal(typeof app.setApplicationMenu, 'function');
  assert.doesNotThrow(() => {
    electronModule.Menu.setDefaultApplicationMenu();
  });
  assert.deepEqual(electronModule.Menu.calls, []);
  assert.deepEqual(fakeWindow.hiddenStates, [false]);
});

test('installLinuxMenuInterceptors accepts function-valued electron.Menu with static methods', () => {
  const app = new EventEmitter();
  const fakeWindow = {
    hiddenStates: [],
    setMenuBarVisibility(value) {
      this.hiddenStates.push(value);
    },
  };
  function Menu() {}
  Menu.calls = [];
  Menu.setApplicationMenu = function(menu) {
    Menu.calls.push(menu);
  };
  Menu.setDefaultApplicationMenu = function() {
    if (typeof app.setApplicationMenu !== 'function') {
      throw new TypeError('app.setApplicationMenu is not a function');
    }
    return app.setApplicationMenu(null);
  };

  const electronModule = {
    app,
    BrowserWindow: {
      getAllWindows() {
        return [fakeWindow];
      },
    },
    Menu,
  };

  const helpers = loadFrameFixHelpers();
  helpers.installLinuxMenuInterceptors(electronModule);

  assert.equal(typeof app.setApplicationMenu, 'function');
  assert.doesNotThrow(() => {
    electronModule.Menu.setDefaultApplicationMenu();
  });
  assert.deepEqual(Menu.calls, []);
  assert.deepEqual(fakeWindow.hiddenStates, [false]);
});

test('installLinuxMenuInterceptors retries after an early electron shape without Menu', () => {
  const helpers = loadFrameFixHelpers();
  const earlyElectronModule = { app: new EventEmitter() };
  helpers.installLinuxMenuInterceptors(earlyElectronModule);

  assert.equal(helpers.global.__coworkLinuxMenuInterceptorsInstalled, undefined);

  const app = new EventEmitter();
  const fakeWindow = {
    hiddenStates: [],
    setMenuBarVisibility(value) {
      this.hiddenStates.push(value);
    },
  };
  const lateElectronModule = {
    app,
    BrowserWindow: {
      getAllWindows() {
        return [fakeWindow];
      },
    },
    Menu: {
      calls: [],
      setApplicationMenu(menu) {
        this.calls.push(menu);
      },
      setDefaultApplicationMenu() {
        return this.setApplicationMenu(null);
      },
    },
  };

  helpers.installLinuxMenuInterceptors(lateElectronModule);

  assert.equal(helpers.global.__coworkLinuxMenuInterceptorsInstalled, true);
  assert.doesNotThrow(() => {
    lateElectronModule.Menu.setDefaultApplicationMenu();
  });
  assert.deepEqual(lateElectronModule.Menu.calls, []);
  assert.deepEqual(fakeWindow.hiddenStates, [false]);
});

test('describeLinuxMenuApiShape reports uncovered menu API surface', () => {
  const helpers = loadFrameFixHelpers();
  const app = new EventEmitter();
  const electronModule = {
    app,
    Menu: {
      setApplicationMenu() {},
    },
  };

  const shape = helpers.describeLinuxMenuApiShape(electronModule);

  assert.equal(shape.hasMenuObject, true);
  assert.equal(shape.hasMenuSetApplicationMenu, true);
  assert.equal(shape.hasMenuSetDefaultApplicationMenu, false);
  assert.equal(shape.hasAppObject, true);
  assert.equal(shape.hasAppSetApplicationMenu, false);
  assert.deepEqual(Array.from(shape.missing), [
    'Menu.setDefaultApplicationMenu',
    'app.setApplicationMenu',
  ]);
});

test('describeLinuxMenuApiShape treats function-valued Menu as present', () => {
  const helpers = loadFrameFixHelpers();
  function Menu() {}
  Menu.setApplicationMenu = function() {};

  const shape = helpers.describeLinuxMenuApiShape({
    app: new EventEmitter(),
    Menu,
  });

  assert.equal(shape.hasMenuObject, true);
  assert.equal(shape.hasMenuSetApplicationMenu, true);
  assert.equal(shape.hasMenuSetDefaultApplicationMenu, false);
  assert.deepEqual(Array.from(shape.missing), [
    'Menu.setDefaultApplicationMenu',
    'app.setApplicationMenu',
  ]);
});

test('installLinuxMenuInterceptors stores menu in global.__coworkApplicationMenu', () => {
  const app = new EventEmitter();
  const fakeWindow = {
    setMenuBarVisibility() {},
  };
  const electronModule = {
    app,
    BrowserWindow: {
      getAllWindows() { return [fakeWindow]; },
    },
    Menu: {
      setApplicationMenu() {},
    },
  };

  const helpers = loadFrameFixHelpers();
  helpers.installLinuxMenuInterceptors(electronModule);

  const fakeMenu = { label: 'File', popup() {} };
  electronModule.Menu.setApplicationMenu(fakeMenu);
  assert.equal(helpers.global.__coworkApplicationMenu, fakeMenu);
});

test('LIVE_EVENT_IGNORED_TYPES includes progress and last-prompt alongside queue-operation', () => {
  // Validate the canonical set in session_normalization.js (single source of truth).
  const { LIVE_EVENT_IGNORED_TYPES } = require('../../../stubs/cowork/session_normalization.js');
  const expectedTypes = ['queue-operation', 'progress', 'last-prompt', 'rate_limit_event'];
  for (const type of expectedTypes) {
    assert.ok(LIVE_EVENT_IGNORED_TYPES.has(type), `missing type: ${type}`);
  }
  assert.strictEqual(LIVE_EVENT_IGNORED_TYPES.size, expectedTypes.length, 'unexpected extra types in set');
});

test('isIgnoredLiveEventType only filters onEvent channels', () => {
  // Validate the channel guard in the consolidated isIgnoredLiveEventType.
  const { isIgnoredLiveEventType } = require('../../../stubs/cowork/session_normalization.js');
  // Should filter onEvent channels with a matching payload type
  assert.strictEqual(
    isIgnoredLiveEventType('$eipc_message$_uuid_$_ns_$_LocalAgentModeSessions_$_onEvent', { type: 'progress' }),
    'progress',
  );
  assert.strictEqual(
    isIgnoredLiveEventType('$eipc_message$_uuid_$_ns_$_LocalSessions_$_onEvent', { type: 'rate_limit_event' }),
    'rate_limit_event',
  );
  // Should NOT filter non-onEvent channels
  assert.strictEqual(
    isIgnoredLiveEventType('$eipc_message$_uuid_$_ns_$_LocalAgentModeSessions_$_getSession', { type: 'progress' }),
    null,
  );
  // Should NOT filter non-ignored types
  assert.strictEqual(
    isIgnoredLiveEventType('$eipc_message$_uuid_$_ns_$_LocalAgentModeSessions_$_onEvent', { type: 'assistant' }),
    null,
  );
});

test('registerElectronAppListener degrades safely when electron app is unavailable', () => {
  const helpers = loadFrameFixHelpers({
    require(request) {
      if (request === 'electron') {
        return {};
      }
      throw new Error('Unexpected require: ' + request);
    },
  });

  const result = helpers.registerElectronAppListener(null, 'window-all-closed', () => {}, 'window-all-closed');
  assert.equal(result, false);
});

test('wrapAliasedFileSystemHandler rewrites stale historical file paths on the early invokeHandlers path', async () => {
  const seenPaths = [];
  const helpers = loadFrameFixHelpers({
    DEFAULT_FILESYSTEM_PATH_ALIASES: [
      {
        from: '/home/zack/dev/claude-cowork-linux/backend',
        to: '/home/zack/dev/claude-linux/backend',
      },
    ],
    isFileSystemPathRewriteChannel(channel) {
      return channel.endsWith('filesystem_$_readlocalfile');
    },
    rewriteAliasedFilePath(inputPath) {
      if (inputPath === '/home/zack/dev/claude-cowork-linux/backend/src/types.ts') {
        return '/home/zack/dev/claude-linux/backend/src/types.ts';
      }
      return inputPath;
    },
  });

  const wrapped = helpers.wrapAliasedFileSystemHandler(
    '$eipc_message$_x_$_claude.web_$_filesystem_$_readlocalfile',
    async (targetPath) => {
      seenPaths.push(targetPath);
      return { ok: true };
    },
  );

  const result = await wrapped('/home/zack/dev/claude-cowork-linux/backend/src/types.ts');
  assert.deepEqual(seenPaths, ['/home/zack/dev/claude-linux/backend/src/types.ts']);
  assert.deepEqual(result, { ok: true });
});

test('wrapAliasedFileSystemHandler defers to the asar adapter once it is available', async () => {
  const seenPaths = [];
  const helpers = loadFrameFixHelpers({
    isFileSystemPathRewriteChannel(channel) {
      return channel.endsWith('filesystem_$_readlocalfile');
    },
  });

  const wrapped = helpers.wrapAliasedFileSystemHandler(
    '$eipc_message$_x_$_claude.web_$_filesystem_$_readlocalfile',
    async (targetPath) => {
      seenPaths.push(targetPath);
      return { ok: true };
    },
    () => ({
      wrapHandler(channel, handler) {
        return async (...args) => handler('/registry/recovered.txt', ...args.slice(1));
      },
    }),
  );

  const result = await wrapped('/historical/file.txt');
  assert.deepEqual(seenPaths, ['/registry/recovered.txt']);
  assert.deepEqual(result, { ok: true });
});

test('wrapAliasedFileSystemHandler fallback rewrites real extracted-app readLocalFile(sessionId, path) shapes', async () => {
  const seenCalls = [];
  const helpers = loadFrameFixHelpers({
    DEFAULT_FILESYSTEM_PATH_ALIASES: [
      {
        from: '/historical/root',
        to: '/resolved/root',
      },
    ],
    isFileSystemPathRewriteChannel(channel) {
      return channel.endsWith('filesystem_$_readlocalfile');
    },
    rewriteAliasedFilePath(inputPath) {
      if (inputPath === '/historical/root/file.txt') {
        return '/resolved/root/file.txt';
      }
      return inputPath;
    },
  });

  const wrapped = helpers.wrapAliasedFileSystemHandler(
    '$eipc_message$_x_$_claude.web_$_filesystem_$_readlocalfile',
    async (event, sessionId, targetPath) => {
      seenCalls.push({ event, sessionId, targetPath });
      return { ok: true };
    },
  );

  const event = { sender: { id: 55 } };
  const result = await wrapped(event, 'local_demo', '/historical/root/file.txt');
  assert.deepEqual(seenCalls, [{
    event,
    sessionId: 'local_demo',
    targetPath: '/resolved/root/file.txt',
  }]);
  assert.deepEqual(result, { ok: true });
});

test('wrapAliasedFileSystemHandler preserves structured relink-required errors from the delegated adapter boundary', async () => {
  const helpers = loadFrameFixHelpers({
    isFileSystemPathRewriteChannel(channel) {
      return channel.endsWith('filesystem_$_readlocalfile');
    },
  });

  const wrapped = helpers.wrapAliasedFileSystemHandler(
    '$eipc_message$_x_$_claude.web_$_filesystem_$_readlocalfile',
    async () => ({ ok: true }),
    () => ({
      wrapHandler() {
        return async () => {
          const error = new Error('Missing tracked FileSystem path requires relink: /workspace/missing.txt');
          error.code = 'COWORK_FILE_RELINK_REQUIRED';
          error.fileId = 'file_missing';
          error.fileResolution = 'missing';
          error.localSessionId = 'local_demo';
          error.requestedPath = '/workspace/missing.txt';
          error.resolvedPath = '/workspace/missing.txt';
          error.relinkRequired = true;
          error.candidates = [];
          error.ambiguity = null;
          throw error;
        };
      },
    }),
  );

  await assert.rejects(
    async () => {
      await wrapped({ sender: { id: 56 } }, 'local_demo', '/workspace/missing.txt');
    },
    (error) => {
      assert.equal(error.code, 'COWORK_FILE_RELINK_REQUIRED');
      assert.equal(error.fileId, 'file_missing');
      assert.equal(error.fileResolution, 'missing');
      assert.equal(error.localSessionId, 'local_demo');
      assert.equal(error.requestedPath, '/workspace/missing.txt');
      assert.equal(error.resolvedPath, '/workspace/missing.txt');
      assert.equal(error.relinkRequired, true);
      return true;
    }
  );
});
