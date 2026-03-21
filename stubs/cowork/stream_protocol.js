'use strict';

const { getIgnoredSdkMessageType } = require('./session_normalization.js');

function parseJsonLine(line) {
  if (typeof line !== 'string') {
    return null;
  }
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function hasAssistantResponse(parsedLine) {
  if (!parsedLine || typeof parsedLine !== 'object') {
    return false;
  }
  if (parsedLine.type === 'stream_event') {
    return true;
  }
  if (parsedLine.type === 'result' && Number(parsedLine.num_turns || 0) > 0) {
    return true;
  }
  if (parsedLine.type === 'assistant') {
    return true;
  }
  if (parsedLine.type === 'message' && parsedLine.message && typeof parsedLine.message === 'object') {
    if (parsedLine.message.role === 'assistant' || parsedLine.message.type === 'assistant') {
      return true;
    }
  }
  return false;
}

function isFlatlineResumeResult(parsedLine) {
  if (!parsedLine || typeof parsedLine !== 'object') {
    return false;
  }
  return parsedLine.type === 'result' &&
    parsedLine.is_error === true &&
    Number(parsedLine.num_turns || 0) === 0;
}

function isSuccessfulResult(parsedLine) {
  if (!parsedLine || typeof parsedLine !== 'object') {
    return false;
  }
  return parsedLine.type === 'result' &&
    parsedLine.is_error !== true &&
    (parsedLine.subtype === 'success' || Number(parsedLine.num_turns || 0) > 0);
}

function extractCliSessionId(parsedLine) {
  if (!parsedLine || typeof parsedLine !== 'object') {
    return null;
  }

  const directCandidates = [
    parsedLine.session_id,
    parsedLine.sessionId,
    parsedLine.cliSessionId,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }

  if (parsedLine.event && typeof parsedLine.event === 'object') {
    const eventCandidates = [
      parsedLine.event.session_id,
      parsedLine.event.sessionId,
      parsedLine.event.cliSessionId,
    ];
    for (const candidate of eventCandidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }
  }

  if (parsedLine.message && typeof parsedLine.message === 'object') {
    const messageCandidates = [
      parsedLine.message.session_id,
      parsedLine.message.sessionId,
      parsedLine.message.cliSessionId,
    ];
    for (const candidate of messageCandidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }
  }

  return null;
}

module.exports = {
  extractCliSessionId,
  getIgnoredSdkMessageType,
  hasAssistantResponse,
  isFlatlineResumeResult,
  isSuccessfulResult,
  parseJsonLine,
};
