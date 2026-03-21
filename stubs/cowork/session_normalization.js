'use strict';

// Canonical message type sets for session normalization.
// Single source of truth — all modules import from here.

// Types to drop from live event dispatch
const LIVE_EVENT_IGNORED_TYPES = new Set([
  'queue-operation',
  'progress',
  'last-prompt',
  'rate_limit_event',
]);

// Metadata types to extract and accumulate (not forward as regular messages)
const LIVE_EVENT_METADATA_TYPES = new Set([
  'queue-operation',
  'progress',
  'last-prompt',
]);

// Types to drop from transcript reads and conversation analysis
const TRANSCRIPT_IGNORED_TYPES = new Set([
  'last-prompt',
  'progress',
  'queue-operation',
  'rate_limit_event',
]);

// Types to drop from raw SDK stdout lines
const SDK_STDOUT_IGNORED_TYPES = new Set([
  'queue-operation',
  'rate_limit_event',
]);

// Check if a live event should be dropped based on channel and payload type.
function isIgnoredLiveEventType(channel, payload) {
  if (typeof channel !== 'string') {
    return null;
  }
  if (!channel.includes('LocalAgentModeSessions_$_onEvent') && !channel.includes('LocalSessions_$_onEvent')) {
    return null;
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.type === 'message' && payload.message && typeof payload.message === 'object') {
    const messageType = payload.message.type;
    return LIVE_EVENT_IGNORED_TYPES.has(messageType) ? messageType : null;
  }

  return LIVE_EVENT_IGNORED_TYPES.has(payload.type) ? payload.type : null;
}

// Filter transcript messages, removing ignored types.
function filterTranscriptMessages(result) {
  if (!Array.isArray(result)) {
    return result;
  }

  return result.filter((message) => {
    if (!message || typeof message !== 'object') {
      return false;
    }
    if (TRANSCRIPT_IGNORED_TYPES.has(message.type)) {
      return false;
    }
    if (message.type === 'message' && message.message && typeof message.message === 'object') {
      if (TRANSCRIPT_IGNORED_TYPES.has(message.message.type)) {
        return false;
      }
    }
    return true;
  });
}

// Filter ignored types from raw SDK stdout JSON lines.
function getIgnoredSdkMessageType(line) {
  if (typeof line !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (SDK_STDOUT_IGNORED_TYPES.has(parsed.type)) {
      return parsed.type;
    }
    if (parsed.type === 'message' && parsed.message && typeof parsed.message === 'object') {
      const nestedType = parsed.message.type;
      if (SDK_STDOUT_IGNORED_TYPES.has(nestedType)) {
        return nestedType;
      }
    }
  } catch (_) {}
  return null;
}

module.exports = {
  LIVE_EVENT_IGNORED_TYPES,
  LIVE_EVENT_METADATA_TYPES,
  TRANSCRIPT_IGNORED_TYPES,
  SDK_STDOUT_IGNORED_TYPES,
  isIgnoredLiveEventType,
  filterTranscriptMessages,
  getIgnoredSdkMessageType,
};
