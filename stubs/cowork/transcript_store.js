const fs = require('fs');
const path = require('path');

const { TRANSCRIPT_IGNORED_TYPES } = require('./session_normalization.js');

const RESUMABLE_MESSAGE_TYPES = new Set([
  'assistant',
  'tool_result',
  'tool_use',
  'user',
]);

function legacySanitizeTranscriptProjectKey(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    return null;
  }
  return inputPath.replace(/[^A-Za-z0-9]/g, '-');
}

function sanitizeTranscriptProjectKey(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    return null;
  }
  return 'b64-' + Buffer.from(inputPath, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function getTranscriptProjectKeyCandidates(inputPath) {
  const preferredKeys = [];
  const preferredKey = sanitizeTranscriptProjectKey(inputPath);
  const legacyKey = legacySanitizeTranscriptProjectKey(inputPath);
  for (const candidate of [preferredKey, legacyKey]) {
    if (typeof candidate !== 'string' || !candidate || preferredKeys.includes(candidate)) {
      continue;
    }
    preferredKeys.push(candidate);
  }
  return preferredKeys;
}

function parseTranscriptLine(line) {
  if (typeof line !== 'string' || !line.trim()) {
    return null;
  }
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function getTranscriptMessageType(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  if (typeof message.type === 'string' && message.type.trim()) {
    return message.type;
  }

  if (message.message && typeof message.message === 'object' && typeof message.message.type === 'string') {
    return message.message.type;
  }

  return null;
}

function isConversationBearingMessage(message) {
  const messageType = getTranscriptMessageType(message);
  if (!messageType) {
    return false;
  }
  if (TRANSCRIPT_IGNORED_TYPES.has(messageType)) {
    return false;
  }
  if (RESUMABLE_MESSAGE_TYPES.has(messageType)) {
    return true;
  }

  if (messageType === 'message') {
    const role = message.message && typeof message.message === 'object'
      ? message.message.role
      : null;
    return role === 'assistant' || role === 'user';
  }

  return false;
}

function inspectTranscriptText(transcriptText) {
  const lines = typeof transcriptText === 'string'
    ? transcriptText.split('\n').filter((line) => line.trim())
    : [];

  const typeCounts = Object.create(null);
  let parsedCount = 0;
  let parseErrorCount = 0;
  let conversationEntryCount = 0;

  for (const line of lines) {
    const parsed = parseTranscriptLine(line);
    if (!parsed) {
      parseErrorCount += 1;
      continue;
    }

    parsedCount += 1;
    const messageType = getTranscriptMessageType(parsed) || 'unknown';
    typeCounts[messageType] = (typeCounts[messageType] || 0) + 1;

    if (isConversationBearingMessage(parsed)) {
      conversationEntryCount += 1;
    }
  }

  return {
    lineCount: lines.length,
    parsedCount,
    parseErrorCount,
    conversationEntryCount,
    resumable: conversationEntryCount > 0,
    typeCounts,
  };
}

function inspectTranscriptFile(transcriptPath) {
  const transcriptText = fs.readFileSync(transcriptPath, 'utf8');
  const inspection = inspectTranscriptText(transcriptText);
  const stats = fs.statSync(transcriptPath);
  return {
    ...inspection,
    transcriptPath,
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function deriveTranscriptEntryRole(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const messageType = getTranscriptMessageType(message);
  if (messageType === 'user' || messageType === 'assistant' || messageType === 'tool_use' || messageType === 'tool_result') {
    return messageType;
  }

  if (messageType === 'message' && message.message && typeof message.message === 'object') {
    const nestedRole = message.message.role;
    if (nestedRole === 'user' || nestedRole === 'assistant') {
      return nestedRole;
    }
  }

  return null;
}

function stringifyTranscriptContentBlock(block) {
  if (typeof block === 'string') {
    return block.trim();
  }

  if (Array.isArray(block)) {
    return block
      .map((entry) => stringifyTranscriptContentBlock(entry))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (!block || typeof block !== 'object') {
    return '';
  }

  if (typeof block.text === 'string' && block.text.trim()) {
    return block.text.trim();
  }

  if (typeof block.content === 'string' && block.content.trim()) {
    return block.content.trim();
  }

  if (Array.isArray(block.content)) {
    return stringifyTranscriptContentBlock(block.content);
  }

  if (block.type === 'tool_use') {
    const toolName = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : 'tool';
    return '[tool_use ' + toolName + ']';
  }

  if (block.type === 'tool_result') {
    const resultText = stringifyTranscriptContentBlock(block.content);
    return resultText ? '[tool_result]\n' + resultText : '[tool_result]';
  }

  if (typeof block.name === 'string' && block.name.trim()) {
    return block.name.trim();
  }

  try {
    return JSON.stringify(block);
  } catch (_) {
    return '';
  }
}

function truncateTranscriptText(text, maxChars) {
  if (typeof text !== 'string') {
    return '';
  }

  const normalizedText = text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalizedText) {
    return '';
  }
  if (typeof maxChars !== 'number' || maxChars <= 0 || normalizedText.length <= maxChars) {
    return normalizedText;
  }
  if (maxChars <= 1) {
    return normalizedText.slice(0, maxChars);
  }
  return normalizedText.slice(0, maxChars - 3).trimEnd() + '...';
}

function listConversationEntriesFromTranscriptText(transcriptText) {
  const lines = typeof transcriptText === 'string'
    ? transcriptText.split('\n').filter((line) => line.trim())
    : [];

  const entries = [];
  for (const line of lines) {
    const parsed = parseTranscriptLine(line);
    if (!parsed || !isConversationBearingMessage(parsed)) {
      continue;
    }

    const role = deriveTranscriptEntryRole(parsed);
    if (!role) {
      continue;
    }

    const contentSource = parsed.message && typeof parsed.message === 'object'
      ? parsed.message.content
      : parsed.content;
    const text = truncateTranscriptText(stringifyTranscriptContentBlock(contentSource), 1200);
    if (!text) {
      continue;
    }

    entries.push({
      role,
      text,
      type: getTranscriptMessageType(parsed),
    });
  }

  return entries;
}

function listConversationEntriesFromTranscriptFile(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) {
    return [];
  }
  return listConversationEntriesFromTranscriptText(fs.readFileSync(transcriptPath, 'utf8'));
}

function buildTranscriptContinuityPlan(options) {
  const {
    localSessionId,
    preferredRoot,
    staleCliSessionId,
    transcriptCandidate,
  } = options || {};

  if (!transcriptCandidate || typeof transcriptCandidate !== 'object' || !transcriptCandidate.transcriptPath) {
    return null;
  }
  if (!transcriptCandidate.resumable) {
    return null;
  }

  let entries = [];
  try {
    entries = listConversationEntriesFromTranscriptFile(transcriptCandidate.transcriptPath);
  } catch (_) {
    return null;
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  const recentEntries = entries.slice(-8);
  const recentConversation = recentEntries
    .map((entry) => {
      const roleLabel = entry.role === 'tool_use'
        ? 'Tool'
        : entry.role === 'tool_result'
          ? 'Tool Result'
          : entry.role === 'assistant'
            ? 'Assistant'
            : 'User';
      return roleLabel + ': ' + entry.text;
    })
    .join('\n\n');

  const hydratedPrompt = [
    '[Local cowork continuity recovery]',
    'A prior remote resume hint failed before any assistant response.',
    'Continue this conversation using the local transcript context below and answer the user naturally.',
    'Do not mention this recovery note unless the user asks about it.',
    localSessionId ? 'Local session: ' + localSessionId : null,
    preferredRoot ? 'Workspace: ' + preferredRoot : null,
    staleCliSessionId ? 'Failed remote resume hint: ' + staleCliSessionId : null,
    transcriptCandidate.cliSessionId ? 'Transcript source: ' + transcriptCandidate.cliSessionId : null,
    '',
    'Recent conversation:',
    recentConversation,
    '',
    'New user message:',
    '',
  ].filter(Boolean).join('\n');

  return {
    strategy: 'transcript_hydration_prompt',
    hydratedPrompt,
    transcriptPath: transcriptCandidate.transcriptPath,
    transcriptCliSessionId: transcriptCandidate.cliSessionId || null,
    localSessionId: localSessionId || null,
    preferredRoot: preferredRoot || null,
    excerptEntryCount: recentEntries.length,
    excerptRoles: recentEntries.map((entry) => entry.role),
  };
}

function listTranscriptCandidatesForSession(sessionDirectory) {
  const projectsRoot = path.join(sessionDirectory, '.claude', 'projects');
  let projectEntries = [];

  try {
    projectEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const candidates = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue;
    }

    const projectDirectory = path.join(projectsRoot, projectEntry.name);
    let transcriptEntries = [];
    try {
      transcriptEntries = fs.readdirSync(projectDirectory, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const transcriptEntry of transcriptEntries) {
      if (!transcriptEntry.isFile() || !transcriptEntry.name.endsWith('.jsonl')) {
        continue;
      }

      const transcriptPath = path.join(projectDirectory, transcriptEntry.name);
      let inspection;
      try {
        inspection = inspectTranscriptFile(transcriptPath);
      } catch (_) {
        continue;
      }

      candidates.push({
        cliSessionId: path.basename(transcriptEntry.name, '.jsonl'),
        projectKey: projectEntry.name,
        ...inspection,
      });
    }
  }

  return candidates;
}

function chooseBestTranscriptCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  return [...candidates].sort((left, right) => {
    if (right.conversationEntryCount !== left.conversationEntryCount) {
      return right.conversationEntryCount - left.conversationEntryCount;
    }
    if (right.lineCount !== left.lineCount) {
      return right.lineCount - left.lineCount;
    }
    return right.mtimeMs - left.mtimeMs;
  })[0] || null;
}

function chooseSessionTranscriptCandidate(options) {
  const {
    sessionDirectory,
    preferredProjectKey,
    preferredProjectKeys,
    cliSessionId,
  } = options || {};

  const candidates = listTranscriptCandidatesForSession(sessionDirectory);
  if (candidates.length === 0) {
    return null;
  }

  const currentCandidate = typeof cliSessionId === 'string'
    ? candidates.find((candidate) => candidate.cliSessionId === cliSessionId) || null
    : null;

  const normalizedPreferredProjectKeys = Array.isArray(preferredProjectKeys)
    ? preferredProjectKeys.filter((candidate) => typeof candidate === 'string' && candidate)
    : [];
  if (
    typeof preferredProjectKey === 'string' &&
    preferredProjectKey &&
    !normalizedPreferredProjectKeys.includes(preferredProjectKey)
  ) {
    normalizedPreferredProjectKeys.unshift(preferredProjectKey);
  }
  const preferredProjectKeySet = new Set(normalizedPreferredProjectKeys);

  const preferredCandidates = preferredProjectKeySet.size > 0
    ? candidates.filter((candidate) => preferredProjectKeySet.has(candidate.projectKey))
    : [];
  const preferredCandidate = chooseBestTranscriptCandidate(preferredCandidates);

  if (!preferredCandidate) {
    return currentCandidate || chooseBestTranscriptCandidate(candidates);
  }
  if (!currentCandidate) {
    return preferredCandidate;
  }
  if (preferredProjectKeySet.has(currentCandidate.projectKey) && preferredProjectKeySet.has(preferredCandidate.projectKey)) {
    return chooseBestTranscriptCandidate([currentCandidate, preferredCandidate]);
  }
  if (!currentCandidate.resumable && preferredCandidate.resumable) {
    return preferredCandidate;
  }
  if (preferredCandidate.conversationEntryCount >= currentCandidate.conversationEntryCount) {
    return preferredCandidate;
  }

  return currentCandidate;
}

module.exports = {
  buildTranscriptContinuityPlan,
  chooseBestTranscriptCandidate,
  chooseSessionTranscriptCandidate,
  getTranscriptProjectKeyCandidates,
  inspectTranscriptFile,
  inspectTranscriptText,
  isConversationBearingMessage,
  listConversationEntriesFromTranscriptFile,
  listConversationEntriesFromTranscriptText,
  listTranscriptCandidatesForSession,
  parseTranscriptLine,
  sanitizeTranscriptProjectKey,
};
