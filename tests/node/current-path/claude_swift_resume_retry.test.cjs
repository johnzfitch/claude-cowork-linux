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
  // Args: --session-id + --fork-session appended for CCR, --resume preserved
  const sessionIdIdx = spawnedArgs.indexOf('--session-id');
  assert.ok(sessionIdIdx !== -1, '--session-id should be appended');
  assert.equal(spawnedArgs[sessionIdIdx + 1], 'cse_remote-created');
  assert.ok(spawnedArgs.includes('--fork-session'), '--fork-session required with --resume + --session-id');
  assert.ok(spawnedArgs.includes('--resume'), '--resume preserved for desktop transcript tracking');
  assert.ok(spawnedArgs.includes('legacy-cli-session'), '--resume value preserved');
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

test('claude-swift retries a flatlined resumed turn through transcript continuity and persists the new cliSessionId', (t) => {
  const tempRoot = createTempDir(t);
  const { tempHome, tempRepoRoot, modulePath } = setupPackedStubFixture(tempRoot);
  const workspaceDir = path.join(tempRoot, 'workspace');
  const sessionDirectory = path.join(tempRoot, 'local_demo_session');
  const configDir = path.join(sessionDirectory, '.claude');
  const metadataPath = sessionDirectory + '.json';
  const attemptFile = path.join(tempRoot, 'attempt-count.txt');
  const resultFile = path.join(tempRoot, 'result.json');
  const continuityInputFile = path.join(tempRoot, 'continuity-input.txt');
  const workerPath = path.join(tempRoot, 'flatline-worker.js');
  const fakeClaudePath = path.join(tempHome, '.local', 'bin', 'cowork-flatline-runner');
  const transcriptDir = path.join(configDir, 'projects', sanitizeTranscriptProjectKey(workspaceDir));

  fs.mkdirSync(path.dirname(fakeClaudePath), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId: 'local_demo_session',
    cliSessionId: 'resume-cli-session',
    cwd: workspaceDir,
    userSelectedFolders: [workspaceDir],
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(transcriptDir, 'resume-cli-session.jsonl'), [
    '{"type":"user","message":{"role":"user","content":"hello"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(workerPath, `
    const fs = require('fs');
    const attemptFile = process.env.FLATLINE_ATTEMPT_FILE;
    let attempts = 0;
    try {
      attempts = Number(fs.readFileSync(attemptFile, 'utf8')) || 0;
    } catch (_) {}
    attempts += 1;
    fs.writeFileSync(attemptFile, String(attempts), 'utf8');

    let stdinText = '';
    process.stdin.on('data', (chunk) => {
      stdinText += chunk.toString();
    });

    setTimeout(() => {
      if (process.argv.includes('--resume')) {
        process.stdout.write(JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          num_turns: 0,
          session_id: 'resume-cli-session',
        }) + '\\n');
        process.exit(0);
        return;
      }

      fs.writeFileSync(process.env.CONTINUITY_INPUT_FILE, stdinText, 'utf8');
      if (
        stdinText.includes('[Local cowork continuity recovery]') &&
        stdinText.includes('Assistant: hi') &&
        stdinText.includes('replay-me')
      ) {
        process.stdout.write(JSON.stringify({
          type: 'stream_event',
          event: { type: 'assistant_delta', text: 'fresh reply' },
        }) + '\\n');
        process.stdout.write(JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 1,
          session_id: 'fresh-cli-session',
        }) + '\\n');
        process.exit(0);
        return;
      }

      process.stdout.write(JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 0,
        session_id: 'fresh-cli-session',
      }) + '\\n');
      process.exit(2);
    }, 50);
  `, 'utf8');
  fs.writeFileSync(fakeClaudePath, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(workerPath) + ' "$@"\n', 'utf8');
  fs.chmodSync(fakeClaudePath, 0o755);

  const child = runSwiftRetryHarness({
    attemptFile,
    configDir,
    fakeClaudePath,
    modulePath,
    resultFile,
    sharedCwdPath: workspaceDir,
    tempHome,
    tempRepoRoot,
    workerEnv: {
      CONTINUITY_INPUT_FILE: continuityInputFile,
    },
    stdinText: 'replay-me\n',
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);

  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const persisted = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const combinedOutput = result.outputs.map((entry) => entry.data).join('');
  const continuityInput = fs.readFileSync(continuityInputFile, 'utf8');

  assert.equal(fs.readFileSync(attemptFile, 'utf8'), '2');
  assert.equal(result.exits.length, 1);
  assert.equal(result.exits[0].code, 0);
  assert.match(combinedOutput, /"type":"stream_event"/);
  assert.match(combinedOutput, /"subtype":"success"/);
  assert.doesNotMatch(combinedOutput, /"subtype":"error_during_execution"/);
  assert.match(continuityInput, /\[Local cowork continuity recovery\]/);
  assert.match(continuityInput, /Assistant: hi/);
  assert.match(continuityInput, /replay-me/);
  assert.equal(persisted.sessionId, 'local_demo_session');
  assert.equal(persisted.cliSessionId, 'fresh-cli-session');
});

test('claude-swift skips plaintext continuity hydration for stream-json retries and falls back to raw replay', (t) => {
  const tempRoot = createTempDir(t);
  const { tempHome, tempRepoRoot, modulePath } = setupPackedStubFixture(tempRoot);
  const workspaceDir = path.join(tempRoot, 'workspace');
  const sessionDirectory = path.join(tempRoot, 'local_demo_session');
  const configDir = path.join(sessionDirectory, '.claude');
  const metadataPath = sessionDirectory + '.json';
  const attemptFile = path.join(tempRoot, 'attempt-count.txt');
  const resultFile = path.join(tempRoot, 'result.json');
  const replayInputFile = path.join(tempRoot, 'stream-json-input.txt');
  const workerPath = path.join(tempRoot, 'stream-json-worker.js');
  const fakeClaudePath = path.join(tempHome, '.local', 'bin', 'cowork-stream-json-runner');
  const transcriptDir = path.join(configDir, 'projects', sanitizeTranscriptProjectKey(workspaceDir));

  fs.mkdirSync(path.dirname(fakeClaudePath), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId: 'local_demo_session',
    cliSessionId: 'resume-cli-session',
    cwd: workspaceDir,
    userSelectedFolders: [workspaceDir],
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(transcriptDir, 'resume-cli-session.jsonl'), [
    '{"type":"user","message":{"role":"user","content":"hello"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(workerPath, `
    const fs = require('fs');
    const attemptFile = process.env.FLATLINE_ATTEMPT_FILE;
    let attempts = 0;
    try {
      attempts = Number(fs.readFileSync(attemptFile, 'utf8')) || 0;
    } catch (_) {}
    attempts += 1;
    fs.writeFileSync(attemptFile, String(attempts), 'utf8');

    let stdinText = '';
    process.stdin.on('data', (chunk) => {
      stdinText += chunk.toString();
    });

    setTimeout(() => {
      if (process.argv.includes('--resume')) {
        process.stdout.write(JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          num_turns: 0,
          session_id: 'resume-cli-session',
        }) + '\\n');
        process.exit(0);
        return;
      }

      fs.writeFileSync(process.env.STREAM_JSON_INPUT_FILE, stdinText, 'utf8');
      const lines = stdinText.split(/\\n+/).filter(Boolean);
      const allValidJson = lines.length > 0 && lines.every((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch (_) {
          return false;
        }
      });

      if (
        allValidJson &&
        stdinText.includes('"type":"user_input"') &&
        !stdinText.includes('[Local cowork continuity recovery]')
      ) {
        process.stdout.write(JSON.stringify({
          type: 'stream_event',
          event: { type: 'assistant_delta', text: 'stream-json reply' },
        }) + '\\n');
        process.stdout.write(JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 1,
          session_id: 'fresh-stream-json-session',
        }) + '\\n');
        process.exit(0);
        return;
      }

      process.stdout.write(JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 0,
        session_id: 'fresh-stream-json-session',
      }) + '\\n');
      process.exit(2);
    }, 50);
  `, 'utf8');
  fs.writeFileSync(fakeClaudePath, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(workerPath) + ' "$@"\n', 'utf8');
  fs.chmodSync(fakeClaudePath, 0o755);

  const streamJsonInput = '{"type":"user_input","text":"replay-json"}\n';
  const child = runSwiftRetryHarness({
    attemptFile,
    configDir,
    fakeClaudePath,
    modulePath,
    resultFile,
    sharedCwdPath: workspaceDir,
    tempHome,
    tempRepoRoot,
    workerArgs: ['--input-format', 'stream-json', '--resume', 'resume-cli-session'],
    workerEnv: {
      STREAM_JSON_INPUT_FILE: replayInputFile,
    },
    stdinText: streamJsonInput,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);

  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const persisted = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const combinedOutput = result.outputs.map((entry) => entry.data).join('');
  const replayInput = fs.readFileSync(replayInputFile, 'utf8');

  assert.equal(fs.readFileSync(attemptFile, 'utf8'), '2');
  assert.equal(result.exits.length, 1);
  assert.equal(result.exits[0].code, 0);
  assert.match(combinedOutput, /"subtype":"success"/);
  assert.equal(replayInput, streamJsonInput);
  assert.doesNotMatch(replayInput, /\[Local cowork continuity recovery\]/);
  assert.equal(persisted.sessionId, 'local_demo_session');
  assert.equal(persisted.cliSessionId, 'fresh-stream-json-session');
});

test('claude-swift falls back to a plain fresh retry when no continuity transcript can be built safely', (t) => {
  const tempRoot = createTempDir(t);
  const { tempHome, tempRepoRoot, modulePath } = setupPackedStubFixture(tempRoot);
  const workspaceDir = path.join(tempRoot, 'workspace');
  const sessionDirectory = path.join(tempRoot, 'local_demo_session');
  const configDir = path.join(sessionDirectory, '.claude');
  const metadataPath = sessionDirectory + '.json';
  const attemptFile = path.join(tempRoot, 'attempt-count.txt');
  const resultFile = path.join(tempRoot, 'result.json');
  const fallbackInputFile = path.join(tempRoot, 'fallback-input.txt');
  const workerPath = path.join(tempRoot, 'fallback-worker.js');
  const fakeClaudePath = path.join(tempHome, '.local', 'bin', 'cowork-fallback-runner');
  const transcriptDir = path.join(configDir, 'projects', sanitizeTranscriptProjectKey(workspaceDir));
  const transcriptPath = path.join(transcriptDir, 'resume-cli-session.jsonl');

  fs.mkdirSync(path.dirname(fakeClaudePath), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({
    sessionId: 'local_demo_session',
    cliSessionId: 'resume-cli-session',
    cwd: workspaceDir,
    userSelectedFolders: [workspaceDir],
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(transcriptPath, [
    '{"type":"user","message":{"role":"user","content":"fallback context"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"fallback answer"}]}}',
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(workerPath, `
    const fs = require('fs');
    const attemptFile = process.env.FLATLINE_ATTEMPT_FILE;
    let attempts = 0;
    try {
      attempts = Number(fs.readFileSync(attemptFile, 'utf8')) || 0;
    } catch (_) {}
    attempts += 1;
    fs.writeFileSync(attemptFile, String(attempts), 'utf8');

    let stdinText = '';
    process.stdin.on('data', (chunk) => {
      stdinText += chunk.toString();
    });

    setTimeout(() => {
      if (process.argv.includes('--resume')) {
        try {
          fs.unlinkSync(process.env.TRANSCRIPT_TO_DELETE);
        } catch (_) {}
        process.stdout.write(JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          num_turns: 0,
          session_id: 'resume-cli-session',
        }) + '\\n');
        process.exit(0);
        return;
      }

      fs.writeFileSync(process.env.FALLBACK_INPUT_FILE, stdinText, 'utf8');
      if (stdinText === 'fallback-me\\n') {
        process.stdout.write(JSON.stringify({
          type: 'stream_event',
          event: { type: 'assistant_delta', text: 'fresh fallback reply' },
        }) + '\\n');
        process.stdout.write(JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 1,
          session_id: 'fresh-fallback-session',
        }) + '\\n');
        process.exit(0);
        return;
      }

      process.stdout.write(JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 0,
        session_id: 'fresh-fallback-session',
      }) + '\\n');
      process.exit(2);
    }, 50);
  `, 'utf8');
  fs.writeFileSync(fakeClaudePath, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(workerPath) + ' "$@"\n', 'utf8');
  fs.chmodSync(fakeClaudePath, 0o755);

  const child = runSwiftRetryHarness({
    attemptFile,
    configDir,
    fakeClaudePath,
    modulePath,
    resultFile,
    sharedCwdPath: workspaceDir,
    tempHome,
    tempRepoRoot,
    workerEnv: {
      FALLBACK_INPUT_FILE: fallbackInputFile,
      TRANSCRIPT_TO_DELETE: transcriptPath,
    },
    stdinText: 'fallback-me\n',
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);

  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const persisted = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const combinedOutput = result.outputs.map((entry) => entry.data).join('');
  const fallbackInput = fs.readFileSync(fallbackInputFile, 'utf8');

  assert.equal(fs.readFileSync(attemptFile, 'utf8'), '2');
  assert.equal(result.exits.length, 1);
  assert.equal(result.exits[0].code, 0);
  assert.match(combinedOutput, /"subtype":"success"/);
  assert.equal(fallbackInput, 'fallback-me\n');
  assert.doesNotMatch(fallbackInput, /\[Local cowork continuity recovery\]/);
  assert.equal(persisted.sessionId, 'local_demo_session');
  assert.equal(persisted.cliSessionId, 'fresh-fallback-session');
});
