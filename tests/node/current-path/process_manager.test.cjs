const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_STDIO,
  createProcessManager,
} = require('../../../stubs/cowork/process_manager.js');

function createTempDir(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-process-manager-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

test('buildSpawnOptions translates VM env vars and sanitizes cwd/env/stdio', () => {
  const processManager = createProcessManager({
    canonicalizePathForHostAccess: (inputPath) => '/canonical' + inputPath,
    filterEnv: (baseEnv, additionalEnv) => ({
      PATH: baseEnv.PATH,
      ...additionalEnv,
      FILTERED: 'yes',
    }),
    trace: () => {},
    translateVmPathStrict: (inputPath) => inputPath.replace('/sessions/demo', '/host/sessions/demo'),
  });

  const result = processManager.buildSpawnOptions({
    processId: 'proc-1',
    options: {
      cwd: '/sessions/demo/mnt/project',
      env: { SHOULD_NOT_PASS: '1' },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    },
    envVars: {
      CLAUDE_CONFIG_DIR: '/sessions/demo/.claude',
      KEEP_ME: '1',
    },
    sharedCwdPath: '/sessions/demo/mnt/project',
  });

  assert.equal(result.success, true);
  assert.equal(result.envVars.CLAUDE_CONFIG_DIR, '/host/sessions/demo/.claude');
  assert.equal(result.spawnOptions.cwd, '/canonical/sessions/demo/mnt/project');
  assert.deepEqual(result.spawnOptions.stdio, DEFAULT_STDIO);
  assert.equal(result.spawnOptions.detached, true);
  assert.equal(result.spawnOptions.env.FILTERED, 'yes');
  assert.equal(result.spawnOptions.env.KEEP_ME, '1');
  assert.equal(result.spawnOptions.env.SHOULD_NOT_PASS, undefined);
});

test('buildSpawnOptions fails when CLAUDE_CONFIG_DIR VM path cannot be translated', () => {
  let capturedError = null;
  const processManager = createProcessManager({
    canonicalizePathForHostAccess: (inputPath) => inputPath,
    filterEnv: () => ({}),
    trace: () => {},
    translateVmPathStrict: () => {
      throw new Error('bad path');
    },
  });

  const result = processManager.buildSpawnOptions({
    processId: 'proc-2',
    envVars: {
      CLAUDE_CONFIG_DIR: '/sessions/demo/.claude',
    },
    onError: (processId, message) => {
      capturedError = { processId, message };
    },
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Failed to translate envVar CLAUDE_CONFIG_DIR/);
  assert.deepEqual(capturedError, {
    processId: 'proc-2',
    message: result.error,
  });
});

test('buildSpawnOptions derives cwd from session metadata when sharedCwdPath is missing', (t) => {
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

  const processManager = createProcessManager({
    canonicalizePathForHostAccess: (inputPath) => inputPath,
    filterEnv: (baseEnv, additionalEnv) => ({
      PATH: baseEnv.PATH,
      ...additionalEnv,
    }),
    trace: () => {},
    translateVmPathStrict: (inputPath) => inputPath,
  });

  const result = processManager.buildSpawnOptions({
    processId: 'proc-3',
    args: ['--model', 'claude-opus-4-6'],
    envVars: {
      CLAUDE_CONFIG_DIR: configDir,
    },
    sharedCwdPath: null,
  });

  assert.equal(result.success, true);
  assert.equal(result.spawnOptions.cwd, '/home/zack/dev/canonical-workspace');
});
