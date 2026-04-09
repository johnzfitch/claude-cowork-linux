'use strict';

// ============================================================================
// TRANSCRIPT STORE — PATH UTILITIES ONLY
// ============================================================================
// Minimal transcript path key generation for the Linux compatibility layer.
// The Asar's LocalAgentModeSessionManager handles transcript discovery,
// selection, and parsing. This module only provides the path encoding that
// the spawn chain needs to set up project directories.

const { TRANSCRIPT_IGNORED_TYPES } = require('./session_normalization.js');

const RESUMABLE_MESSAGE_TYPES = new Set([
  'assistant',
  'tool_result',
  'tool_use',
  'user',
]);

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

function legacySanitizeTranscriptProjectKey(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    return null;
  }
  return inputPath.replace(/[^A-Za-z0-9]/g, '-');
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
  if (!messageType) return false;
  if (TRANSCRIPT_IGNORED_TYPES.has(messageType)) return false;
  if (RESUMABLE_MESSAGE_TYPES.has(messageType)) return true;
  if (messageType === 'message') {
    const role = message.message && typeof message.message === 'object'
      ? message.message.role
      : null;
    return role === 'assistant' || role === 'user';
  }
  return false;
}

module.exports = {
  getTranscriptProjectKeyCandidates,
  isConversationBearingMessage,
  getTranscriptMessageType,
  parseTranscriptLine,
  sanitizeTranscriptProjectKey,
};
