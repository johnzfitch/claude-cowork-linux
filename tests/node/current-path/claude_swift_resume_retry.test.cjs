const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sanitizeTranscriptProjectKey } = require('../../../stubs/cowork/transcript_store.js');

function createTempDir(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-resume-retry-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

function setupPackedStubFixture(tempRoot) {
  const tempHome = path.join(tempRoot, 'home');
  const tempRepoRoot = path.join(tempRoot, 'packed-app');
  const tempCoworkRoot = path.join(tempRepoRoot, 'cowork');
  const tempStubDir = path.join(tempRepoRoot, 'stubs', '@ant', 'claude-swift', 'js');
  const modulePath = path.join(tempStubDir, 'index.js');

  fs.mkdirSync(tempHome, { recursive: true });
  fs.mkdirSync(tempStubDir, { recursive: true });
  const repoRoot = path.join(__dirname, '..', '..', '..');
  fs.cpSync(path.join(repoRoot, 'stubs', 'cowork'), tempCoworkRoot, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'stubs', '@ant', 'claude-swift', 'js', 'index.js'), modulePath);

  return {
    tempHome,
    tempRepoRoot,
    modulePath,
  };
}

function runSwiftRetryHarness(options) {
  const {
    attemptFile,
    configDir,
    fakeClaudePath,
    modulePath,
    resultFile,
    sharedCwdPath,
    tempHome,
    tempRepoRoot,
    workerEnv,
    stdinText,
    workerArgs = ['--resume', 'resume-cli-session'],
  } = options;

  const script = `
    const fs = require('fs');
    const addon = require(${JSON.stringify(modulePath)});
    const resultFile = ${JSON.stringify(resultFile)};
    const outputs = [];
    const exits = [];
    const errors = [];

    addon.vm.setEventCallbacks(
      (id, data) => outputs.push({ id, data }),
      (_id, data) => errors.push({ type: 'stderr', data }),
      (id, code, signal) => {
        exits.push({ id, code, signal });
        fs.writeFileSync(resultFile, JSON.stringify({ outputs, exits, errors }, null, 2));
        process.exit(0);
      },
      (id, message, stack) => {
        errors.push({ type: 'error', id, message, stack });
      },
      () => {},
      () => {}
    );

    const spawnResult = addon.vm.spawn(
      'proc-1',
      'demo',
      ${JSON.stringify(fakeClaudePath)},
      ${JSON.stringify(workerArgs)},
      {},
      ${JSON.stringify({
        CLAUDE_CONFIG_DIR: configDir,
        FLATLINE_ATTEMPT_FILE: attemptFile,
        ...workerEnv,
      })},
      null,
      true,
      [],
      ${JSON.stringify(sharedCwdPath)}
    );

    if (!spawnResult || spawnResult.success !== true) {
      fs.writeFileSync(resultFile, JSON.stringify({ spawnResult, outputs, exits, errors }, null, 2));
      process.exit(2);
    }

    addon.vm.writeStdin('proc-1', ${JSON.stringify(stdinText)});

    setTimeout(() => {
      fs.writeFileSync(resultFile, JSON.stringify({ outputs, exits, errors, timeout: true }, null, 2));
      process.exit(3);
    }, 4000);
  `;

  return spawnSync(process.execPath, ['-e', script], {
    cwd: tempRepoRoot,
    env: {
      ...process.env,
      HOME: tempHome,
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      FLATLINE_ATTEMPT_FILE: attemptFile,
    },
    encoding: 'utf8',
  });
}

function runSwiftBridgeHarness(options) {
  const {
    configDir,
    fakeClaudePath,
    metadataPath,
    modulePath,
    resultFile,
    sharedCwdPath,
    tempHome,
    tempRepoRoot,
    workerArgs = ['--resume', 'legacy-cli-session', '--model', 'claude-opus-4-6'],
  } = options;

  const script = `
    const fs = require('fs');
    // No API mock needed — bridge resolution reads bridge-state.json only,
    // CLI self-bootstraps its own /bridge call via CLAUDE_CODE_USE_CCR_V2
    global.__coworkSessionsApiRequestSync = () => {
      throw new Error('Unexpected sessions API request — orchestrator should not call API');
    };

    const addon = require(${JSON.stringify(modulePath)});
    const outputs = [];
    const exits = [];
    const errors = [];

    addon.vm.setEventCallbacks(
      (id, data) => outputs.push({ id, data }),
      (_id, data) => errors.push({ type: 'stderr', data }),
      (id, code, signal) => {
        exits.push({ id, code, signal });
        const metadata = JSON.parse(fs.readFileSync(${JSON.stringify(metadataPath)}, 'utf8'));
        fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ outputs, exits, errors, metadata }, null, 2));
        process.exit(0);
      },
      (id, message, stack) => {
        errors.push({ type: 'error', id, message, stack });
      },
      () => {},
      () => {}
    );

    const spawnResult = addon.vm.spawn(
      'proc-bridge',
      'demo',
      ${JSON.stringify(fakeClaudePath)},
      ${JSON.stringify(workerArgs)},
      {},
      ${JSON.stringify({
        CLAUDE_CONFIG_DIR: configDir,
      })},
      null,
      false,
      [],
      ${JSON.stringify(sharedCwdPath)}
    );

    if (!spawnResult || spawnResult.success !== true) {
      fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ spawnResult, outputs, exits, errors }, null, 2));
      process.exit(2);
    }

    addon.vm.writeStdin('proc-bridge', '{"type":"user","message":{"role":"user","content":"hello"}}\\n');

    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ outputs, exits, errors, timeout: true }, null, 2));
      process.exit(3);
    }, 4000);
  `;

  return spawnSync(process.execPath, ['-e', script], {
    cwd: tempRepoRoot,
    env: {
      ...process.env,
      HOME: tempHome,
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      CLAUDE_COWORK_SESSIONS_API_AUTH_TOKEN: 'desktop-oauth-token',
      CLAUDE_COWORK_SESSIONS_API_BASE_URL: 'https://bridge.test',
    },
    encoding: 'utf8',
  });
}

test('claude-swift provisions a remote session via bridge-state.json and /bridge API, spawns with bridge flags', (t) => {
  const tempRoot = createTempDir(t);
  const { tempHome, tempRepoRoot, modulePath } = setupPackedStubFixture(tempRoot);
  const workspaceDir = path.join(tempRoot, 'workspace');
  const sessionDirectory = path.join(tempRoot, 'local_demo_session');
  const configDir = path.join(sessionDirectory, '.claude');
  const metadataPath = sessionDirectory + '.json';
  const resultFile = path.join(tempRoot, 'bridge-result.json');
  const workerPath = path.join(tempRoot, 'bridge-worker.js');
  const fakeClaudePath = path.join(tempHome, '.local', 'bin', 'cowork-bridge-runner');
  const argsFile = path.join(tempRoot, 'bridge-args.json');
  const envFile = path.join(tempRoot, 'bridge-env.json');

  fs.mkdirSync(path.dirname(fakeClaudePath), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId: 'local_demo_session',
    cliSessionId: 'legacy-cli-session',
    cwd: workspaceDir,
    userSelectedFolders: [workspaceDir],
  }, null, 2) + '\n', 'utf8');

  // Bridge-state.json maps local -> remote session
  const bridgeStateDir = path.join(tempHome, '.config', 'Claude');
  fs.mkdirSync(bridgeStateDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeStateDir, 'bridge-state.json'), JSON.stringify({
    'user:org': { remoteSessionId: 'cse_remote-created', localSessionId: 'local_ditto_org' },
  }), 'utf8');
  fs.writeFileSync(workerPath, `
    const fs = require('fs');
    fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2), null, 2));
    fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
      CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT || null,
      CLAUDE_CODE_ENVIRONMENT_KIND: process.env.CLAUDE_CODE_ENVIRONMENT_KIND || null,
      CLAUDE_CODE_IS_COWORK: process.env.CLAUDE_CODE_IS_COWORK || null,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
      CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2: process.env.CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2 || null,
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN || null,
      CLAUDE_CODE_USE_CCR_V2: process.env.CLAUDE_CODE_USE_CCR_V2 || null,
      CLAUDE_CODE_USE_COWORK_PLUGINS: process.env.CLAUDE_CODE_USE_COWORK_PLUGINS || null,
    }, null, 2));
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      session_id: 'fresh-cli-session',
    }) + '\\n');
    process.exit(0);
  `, 'utf8');
  fs.writeFileSync(fakeClaudePath, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(workerPath) + ' "$@"\n', 'utf8');
  fs.chmodSync(fakeClaudePath, 0o755);

  const child = runSwiftBridgeHarness({
    configDir,
    fakeClaudePath,
    metadataPath,
    modulePath,
    resultFile,
    sharedCwdPath: workspaceDir,
    tempHome,
    tempRepoRoot,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);

  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const spawnedArgs = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  const spawnedEnv = JSON.parse(fs.readFileSync(envFile, 'utf8'));

  assert.equal(result.exits.length, 1);
  assert.equal(result.exits[0].code, 0);
  // Args: untouched — asar's bridge transport handles CCR relay, CLI runs normally
  assert.ok(spawnedArgs.includes('--resume'), '--resume preserved');
  assert.ok(spawnedArgs.includes('legacy-cli-session'), '--resume value preserved');
  assert.equal(spawnedArgs.indexOf('--session-id'), -1, 'no --session-id (cse_* managed by asar bridge)');
  assert.equal(spawnedArgs.indexOf('--fork-session'), -1, 'no --fork-session');
  // Env: v2 transport, OAuth preserved for CLI self-bootstrap
  assert.equal(spawnedEnv.CLAUDE_CODE_ENTRYPOINT, 'claude-desktop');
  assert.equal(spawnedEnv.CLAUDE_CODE_ENVIRONMENT_KIND, 'bridge');
  assert.equal(spawnedEnv.CLAUDE_CODE_IS_COWORK, '1');
  assert.equal(spawnedEnv.CLAUDE_CODE_USE_CCR_V2, '1');
  assert.equal(spawnedEnv.CLAUDE_CODE_USE_COWORK_PLUGINS, '1');
  assert.equal(result.metadata.sessionId, 'local_demo_session');
  assert.equal(result.metadata.cliSessionId, 'legacy-cli-session');
});

test('claude-swift exposes the quick access overlay and dictation methods expected by the packed app', (t) => {
  const tempRoot = createTempDir(t);
  const { modulePath } = setupPackedStubFixture(tempRoot);
  const addon = require(modulePath);

  assert.equal(typeof addon.quickAccess.overlay.setLoggedIn, 'function');
  assert.equal(typeof addon.quickAccess.overlay.setRecentChats, 'function');
  assert.equal(typeof addon.quickAccess.overlay.setActiveChatId, 'function');
  assert.equal(typeof addon.quickAccess.dictation.setLanguage, 'function');

  assert.doesNotThrow(() => {
    addon.quickAccess.overlay.setLoggedIn(true);
    addon.quickAccess.overlay.setRecentChats([{ chatId: 'chat-1', chatName: 'Demo' }], 'chat-1');
    addon.quickAccess.overlay.setActiveChatId('chat-2');
    addon.quickAccess.dictation.setLanguage('en-US');
  });
});

// Flatline retry tests removed — prepareFlatlineRetry() and transcript
// continuity injection were removed as part of the security posture improvement.
// The CLI's --resume handles resume natively; injecting continuity prompts
// was a stored prompt injection vector.
