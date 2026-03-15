const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getPreferredProjectKey,
  handleFlatlineResumeFailure,
  handleResumeFailure,
  isRemoteConversationMissingError,
  planSessionResume,
} = require('../../../stubs/cowork/resume_coordinator.js');

function createTempSessionDir(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-resume-coordinator-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

function writeTranscript(sessionDir, projectKey, cliSessionId, lines) {
  const transcriptDir = path.join(sessionDir, '.claude', 'projects', projectKey);
  fs.mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, cliSessionId + '.jsonl');
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf8');
  return transcriptPath;
}

function createSessionData(overrides) {
  return {
    sessionId: 'local_test_session',
    cwd: '/sessions/example-session',
    userSelectedFolders: ['/home/zack/dev/claude-cowork-linux'],
    cliSessionId: null,
    ...overrides,
  };
}

test('getPreferredProjectKey derives the transcript project key from selected workspace', () => {
  const sessionData = createSessionData();
  assert.equal(
    getPreferredProjectKey(sessionData),
    '-home-zack-dev-claude-cowork-linux',
  );
});

test('planSessionResume upgrades stale cliSessionId to the best resumable transcript candidate', (t) => {
  const sessionDir = createTempSessionDir(t);
  const sessionData = createSessionData({ cliSessionId: 'stale-cli-session' });
  const preferredProjectKey = getPreferredProjectKey(sessionData);

  writeTranscript(sessionDir, 'wrong-project', 'stale-cli-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"progress","data":{"type":"hook_progress"}}',
  ]);
  writeTranscript(sessionDir, preferredProjectKey, 'best-cli-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"user","message":{"role":"user","content":"recover context"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"restored"}]}}',
  ]);

  const plan = planSessionResume({
    sessionData,
    sessionDirectory: sessionDir,
  });

  assert.equal(plan.shouldResume, true);
  assert.equal(plan.resumeCliSessionId, 'best-cli-session');
  assert.equal(plan.sessionData.cliSessionId, 'best-cli-session');
  assert.equal(plan.reason, 'resume_best_transcript_candidate');
  assert.ok(plan.transcriptCandidate);
  assert.equal(plan.transcriptCandidate.projectKey, preferredProjectKey);
});

test('planSessionResume falls back to fresh execution when no resumable transcript exists', (t) => {
  const sessionDir = createTempSessionDir(t);
  const sessionData = createSessionData({ cliSessionId: 'queue-only-session' });
  const preferredProjectKey = getPreferredProjectKey(sessionData);

  writeTranscript(sessionDir, preferredProjectKey, 'queue-only-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"queue-operation","operation":"dequeue"}',
    '{"type":"last-prompt","lastPrompt":"claude> "}',
  ]);

  const plan = planSessionResume({
    sessionData,
    sessionDirectory: sessionDir,
  });

  assert.equal(plan.shouldResume, false);
  assert.equal(plan.resumeCliSessionId, null);
  assert.equal(plan.reason, 'transcript_not_resumable');
  assert.ok(plan.transcriptCandidate);
  assert.equal(plan.transcriptCandidate.resumable, false);
});

test('handleResumeFailure clears only cliSessionId for missing remote conversations and preserves transcript continuity', (t) => {
  const sessionDir = createTempSessionDir(t);
  const sessionData = createSessionData({ cliSessionId: 'missing-remote-session' });
  const preferredProjectKey = getPreferredProjectKey(sessionData);

  writeTranscript(sessionDir, preferredProjectKey, 'missing-remote-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"user","message":{"role":"user","content":"hello"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  ]);

  const result = handleResumeFailure({
    sessionData,
    sessionDirectory: sessionDir,
    errorMessage: 'No conversation found with session ID: missing-remote-session',
  });

  assert.equal(result.clearCliSessionId, true);
  assert.equal(result.continueLocally, true);
  assert.equal(result.shouldResume, false);
  assert.equal(result.resumeCliSessionId, null);
  assert.equal(result.sessionData.cliSessionId, null);
  assert.equal(result.sessionData.error, 'No conversation found with session ID: missing-remote-session');
  assert.ok(result.transcriptCandidate);
  assert.equal(result.transcriptCandidate.cliSessionId, 'missing-remote-session');
  assert.equal(result.transcriptCandidate.resumable, true);
});

test('handleResumeFailure leaves cliSessionId intact for unrelated errors', (t) => {
  const sessionDir = createTempSessionDir(t);
  const sessionData = createSessionData({ cliSessionId: 'current-cli-session' });
  const preferredProjectKey = getPreferredProjectKey(sessionData);

  writeTranscript(sessionDir, preferredProjectKey, 'current-cli-session', [
    '{"type":"user","message":{"role":"user","content":"hello"}}',
  ]);

  const result = handleResumeFailure({
    sessionData,
    sessionDirectory: sessionDir,
    errorMessage: 'network timeout while connecting to upstream',
  });

  assert.equal(result.clearCliSessionId, false);
  assert.equal(result.continueLocally, false);
  assert.equal(result.sessionData.cliSessionId, 'current-cli-session');
  assert.equal(result.reason, 'non_resume_error');
});

test('handleFlatlineResumeFailure clears only cliSessionId and requests a fresh retry', (t) => {
  const sessionDir = createTempSessionDir(t);
  const sessionData = createSessionData({ cliSessionId: 'resume-cli-session' });
  const preferredProjectKey = getPreferredProjectKey(sessionData);

  writeTranscript(sessionDir, preferredProjectKey, 'resume-cli-session', [
    '{"type":"user","message":{"role":"user","content":"hello"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  ]);

  const result = handleFlatlineResumeFailure({
    sessionData,
    sessionDirectory: sessionDir,
  });

  assert.equal(result.clearCliSessionId, true);
  assert.equal(result.continueLocally, true);
  assert.equal(result.retryFresh, true);
  assert.equal(result.shouldResume, false);
  assert.equal(result.resumeCliSessionId, null);
  assert.equal(result.sessionData.cliSessionId, null);
  assert.equal(result.sessionData.error, 'Resume turn exited without a first assistant response');
  assert.equal(result.reason, 'resume_flatline_no_first_response');
});

test('isRemoteConversationMissingError matches the concrete Claude resume failure string', () => {
  assert.equal(
    isRemoteConversationMissingError('No conversation found with session ID: 4955b66f-fae5-43cb-b124-95b07339d17b'),
    true,
  );
  assert.equal(
    isRemoteConversationMissingError('network timeout'),
    false,
  );
});
