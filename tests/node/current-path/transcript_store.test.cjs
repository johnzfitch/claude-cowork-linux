const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildTranscriptContinuityPlan,
  chooseSessionTranscriptCandidate,
  getTranscriptProjectKeyCandidates,
  inspectTranscriptText,
  listConversationEntriesFromTranscriptFile,
  listTranscriptCandidatesForSession,
  sanitizeTranscriptProjectKey,
} = require('../../../stubs/cowork/transcript_store.js');

function createTempSessionDir(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-transcript-store-'));
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

test('inspectTranscriptText marks queue metadata plus conversation as resumable', () => {
  const inspection = inspectTranscriptText([
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"progress","data":{"type":"hook_progress"}}',
    '{"type":"user","message":{"role":"user","content":"hello"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    '{"type":"last-prompt","lastPrompt":"claude> "}',
  ].join('\n'));

  assert.equal(inspection.resumable, true);
  assert.equal(inspection.conversationEntryCount, 2);
  assert.equal(inspection.typeCounts['queue-operation'], 1);
  assert.equal(inspection.typeCounts.progress, 1);
  assert.equal(inspection.typeCounts.user, 1);
  assert.equal(inspection.typeCounts.assistant, 1);
});

test('inspectTranscriptText marks metadata-only transcripts as not resumable', () => {
  const inspection = inspectTranscriptText([
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"queue-operation","operation":"dequeue"}',
    '{"type":"progress","data":{"type":"hook_progress"}}',
    '{"type":"last-prompt","lastPrompt":"claude> "}',
  ].join('\n'));

  assert.equal(inspection.resumable, false);
  assert.equal(inspection.conversationEntryCount, 0);
});

test('sanitizeTranscriptProjectKey no longer collides for structurally different paths', () => {
  assert.notEqual(
    sanitizeTranscriptProjectKey('/tmp/a-b'),
    sanitizeTranscriptProjectKey('/tmp/a/b'),
  );
});

test('listTranscriptCandidatesForSession inspects transcript conversation counts', (t) => {
  const sessionDir = createTempSessionDir(t);
  const preferredProjectKey = sanitizeTranscriptProjectKey('/home/zack/dev/claude-cowork-linux');

  writeTranscript(sessionDir, preferredProjectKey, 'good-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"user","message":{"role":"user","content":"hello"}}',
  ]);
  writeTranscript(sessionDir, 'foreign-project', 'bad-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"progress","data":{"type":"hook_progress"}}',
  ]);

  const candidates = listTranscriptCandidatesForSession(sessionDir);
  assert.equal(candidates.length, 2);

  const good = candidates.find((candidate) => candidate.cliSessionId === 'good-session');
  const bad = candidates.find((candidate) => candidate.cliSessionId === 'bad-session');

  assert.ok(good);
  assert.ok(bad);
  assert.equal(good.resumable, true);
  assert.equal(good.conversationEntryCount, 1);
  assert.equal(bad.resumable, false);
  assert.equal(bad.conversationEntryCount, 0);
});

test('chooseSessionTranscriptCandidate still finds legacy transcript directories for the preferred workspace', (t) => {
  const sessionDir = createTempSessionDir(t);
  const preferredRoot = '/home/zack/dev/claude-cowork-linux';
  const preferredProjectKey = sanitizeTranscriptProjectKey(preferredRoot);
  const legacyProjectKey = '-home-zack-dev-claude-cowork-linux';

  writeTranscript(sessionDir, legacyProjectKey, 'legacy-cli-session', [
    '{"type":"user","message":{"role":"user","content":"recover context"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"restored"}]}}',
  ]);

  const chosen = chooseSessionTranscriptCandidate({
    sessionDirectory: sessionDir,
    preferredProjectKey,
    preferredProjectKeys: getTranscriptProjectKeyCandidates(preferredRoot),
    cliSessionId: 'legacy-cli-session',
  });

  assert.ok(chosen);
  assert.equal(chosen.cliSessionId, 'legacy-cli-session');
  assert.equal(chosen.projectKey, legacyProjectKey);
});

test('chooseSessionTranscriptCandidate prefers resumable preferred-project transcript over stale current candidate', (t) => {
  const sessionDir = createTempSessionDir(t);
  const preferredProjectKey = sanitizeTranscriptProjectKey('/home/zack/dev/claude-cowork-linux');

  writeTranscript(sessionDir, 'wrong-project', 'stale-cli-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"progress","data":{"type":"hook_progress"}}',
  ]);
  writeTranscript(sessionDir, preferredProjectKey, 'fresh-cli-session', [
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"user","message":{"role":"user","content":"recover context"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"restored"}]}}',
  ]);

  const chosen = chooseSessionTranscriptCandidate({
    sessionDirectory: sessionDir,
    preferredProjectKey,
    cliSessionId: 'stale-cli-session',
  });

  assert.ok(chosen);
  assert.equal(chosen.cliSessionId, 'fresh-cli-session');
  assert.equal(chosen.projectKey, preferredProjectKey);
  assert.equal(chosen.resumable, true);
});

test('chooseSessionTranscriptCandidate keeps the richer current candidate within the same project', (t) => {
  const sessionDir = createTempSessionDir(t);
  const preferredProjectKey = sanitizeTranscriptProjectKey('/home/zack/dev/claude-cowork-linux');

  writeTranscript(sessionDir, preferredProjectKey, 'current-cli-session', [
    '{"type":"user","message":{"role":"user","content":"hello"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    '{"type":"user","message":{"role":"user","content":"followup"}}',
  ]);
  writeTranscript(sessionDir, preferredProjectKey, 'older-cli-session', [
    '{"type":"user","message":{"role":"user","content":"hello"}}',
  ]);

  const chosen = chooseSessionTranscriptCandidate({
    sessionDirectory: sessionDir,
    preferredProjectKey,
    cliSessionId: 'current-cli-session',
  });

  assert.ok(chosen);
  assert.equal(chosen.cliSessionId, 'current-cli-session');
  assert.equal(chosen.conversationEntryCount, 3);
});

test('buildTranscriptContinuityPlan uses recent local transcript entries for recovery hydration', (t) => {
  const sessionDir = createTempSessionDir(t);
  const preferredProjectKey = sanitizeTranscriptProjectKey('/home/zack/dev/claude-cowork-linux');
  const transcriptPath = writeTranscript(sessionDir, preferredProjectKey, 'fresh-cli-session', [
    '{"type":"user","message":{"role":"user","content":"first question"}}',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"first answer"}]}}',
    '{"type":"tool_use","message":{"content":[{"type":"tool_use","name":"ls"}]}}',
    '{"type":"tool_result","message":{"content":"listing complete"}}',
    '{"type":"user","message":{"role":"user","content":"second question"}}',
  ]);

  const entries = listConversationEntriesFromTranscriptFile(transcriptPath);
  assert.equal(entries.length, 5);
  assert.equal(entries[0].role, 'user');
  assert.equal(entries[1].role, 'assistant');
  assert.equal(entries[2].role, 'tool_use');

  const plan = buildTranscriptContinuityPlan({
    localSessionId: 'local_demo_session',
    preferredRoot: '/home/zack/dev/claude-cowork-linux',
    staleCliSessionId: 'stale-cli-session',
    transcriptCandidate: {
      cliSessionId: 'fresh-cli-session',
      resumable: true,
      transcriptPath,
    },
  });

  assert.ok(plan);
  assert.equal(plan.strategy, 'transcript_hydration_prompt');
  assert.equal(plan.localSessionId, 'local_demo_session');
  assert.equal(plan.transcriptCliSessionId, 'fresh-cli-session');
  assert.match(plan.hydratedPrompt, /Local session: local_demo_session/);
  assert.match(plan.hydratedPrompt, /Workspace: \/home\/zack\/dev\/claude-cowork-linux/);
  assert.match(plan.hydratedPrompt, /User: first question/);
  assert.match(plan.hydratedPrompt, /Assistant: first answer/);
  assert.match(plan.hydratedPrompt, /Tool: \[tool_use ls\]/);
  assert.match(plan.hydratedPrompt, /Tool Result: listing complete/);
  assert.match(plan.hydratedPrompt, /New user message:/);
});
