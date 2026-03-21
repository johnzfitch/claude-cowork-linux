const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  createDirs,
  getSessionFileRegistryPath,
  getSessionWatchStatePath,
  resolveAbsoluteDirectory,
} = require('../../../stubs/cowork/dirs.js');

test('resolveAbsoluteDirectory falls back when env value is missing or relative', () => {
  assert.equal(
    resolveAbsoluteDirectory(undefined, '/fallback/path'),
    path.resolve('/fallback/path')
  );
  assert.equal(
    resolveAbsoluteDirectory('relative/path', '/fallback/path'),
    path.resolve('/fallback/path')
  );
  assert.equal(
    resolveAbsoluteDirectory('/custom/path', '/fallback/path'),
    path.resolve('/custom/path')
  );
});

test('createDirs uses XDG defaults when env vars are unset', () => {
  const dirs = createDirs({
    env: {},
    homeDir: '/home/tester',
  });

  assert.equal(dirs.xdgConfigHome, '/home/tester/.config');
  assert.equal(dirs.xdgDataHome, '/home/tester/.local/share');
  assert.equal(dirs.xdgCacheHome, '/home/tester/.cache');
  assert.equal(dirs.xdgStateHome, '/home/tester/.local/state');
  assert.equal(dirs.xdgRuntimeDir, '/home/tester/.local/state/runtime');
  assert.equal(dirs.claudeConfigRoot, '/home/tester/.config/Claude');
  assert.equal(dirs.claudeLocalAgentRoot, '/home/tester/.config/Claude/local-agent-mode-sessions');
  assert.equal(dirs.claudeSessionsBase, '/home/tester/.config/Claude/local-agent-mode-sessions/sessions');
  assert.equal(dirs.coworkLogsDir, '/home/tester/.local/state/claude-cowork/logs');
  assert.deepEqual(dirs.claudeVmRoots, [
    '/home/tester/.config/Claude/claude-code-vm',
    '/home/tester/.local/share/claude-cowork/claude-code-vm',
  ]);
});

test('createDirs respects absolute XDG overrides', () => {
  const dirs = createDirs({
    env: {
      XDG_CONFIG_HOME: '/tmp/config-home',
      XDG_DATA_HOME: '/tmp/data-home',
      XDG_CACHE_HOME: '/tmp/cache-home',
      XDG_STATE_HOME: '/tmp/state-home',
      XDG_RUNTIME_DIR: '/run/user/1234',
    },
    homeDir: '/home/tester',
  });

  assert.equal(dirs.xdgConfigHome, '/tmp/config-home');
  assert.equal(dirs.xdgDataHome, '/tmp/data-home');
  assert.equal(dirs.xdgCacheHome, '/tmp/cache-home');
  assert.equal(dirs.xdgStateHome, '/tmp/state-home');
  assert.equal(dirs.xdgRuntimeDir, '/run/user/1234');
  assert.equal(dirs.claudeConfigRoot, '/tmp/config-home/Claude');
  assert.equal(dirs.coworkConfigRoot, '/tmp/config-home/claude-cowork');
  assert.equal(dirs.coworkDataRoot, '/tmp/data-home/claude-cowork');
  assert.equal(dirs.coworkCacheRoot, '/tmp/cache-home/claude-cowork');
  assert.equal(dirs.coworkStateRoot, '/tmp/state-home/claude-cowork');
  assert.equal(dirs.coworkLogsDir, '/tmp/state-home/claude-cowork/logs');
});

test('session file registry helpers map local sessions into XDG data and state roots', () => {
  const dirs = createDirs({
    env: {},
    homeDir: '/home/tester',
  });

  assert.equal(
    getSessionFileRegistryPath(dirs, 'local_demo'),
    '/home/tester/.local/share/claude-cowork/sessions/local_demo/files.jsonl'
  );
  assert.equal(
    getSessionWatchStatePath(dirs, 'local_demo'),
    '/home/tester/.local/state/claude-cowork/sessions/local_demo/watch-state.json'
  );
});
