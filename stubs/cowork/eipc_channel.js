'use strict';

// ============================================================================
// EIPC CHANNEL PARSER
// ============================================================================
// Parse and classify Electron IPC channel names in the EIPC format used
// by Claude Desktop. EIPC (Electron IPC) is a structured naming convention
// that encodes metadata into channel names.
//
// EIPC CHANNEL FORMAT:
//   $eipc_message$_<uuid>_$_<namespace>_$_<category>_$_<method>
//
// Example:
//   $eipc_message$_123_$_claude.web_$_LocalAgentModeSessions_$_start
//
// Components:
//   - namespace: API namespace (claude.web, claude.hybrid, claude.settings)
//   - category: API category (LocalAgentModeSessions, ClaudeVM, etc.)
//   - method: Method name (start, stop, getAll, etc.)
//
// This parser helps with IPC debugging and provides safe defaults for
// macOS-specific methods that aren't available on Linux.

function parseEipcChannel(channel) {
  // Parse EIPC channel name into structured components.
  // Returns null if channel doesn't match EIPC format.
  //
  // Output format:
  //   {
  //     raw: 'full_channel_name',
  //     method: 'start',
  //     category: 'LocalAgentModeSessions',
  //     namespace: 'claude.web'
  //   }
  if (typeof channel !== 'string') return null;
  const segments = channel.split('_$_');
  if (segments.length < 3) return null;
  return {
    raw: channel,
    method: segments[segments.length - 1],
    category: segments.length >= 4 ? segments[segments.length - 2] : null,
    namespace: segments.length >= 3 ? segments[segments.length - 3] : null,
  };
}

// Pattern matching for method classification
// Helps identify what type of operation an IPC method performs
const METHOD_SHAPES = {
  status:   /^(get)?(status|state|running|support|health)/i,
  prepare:  /^(prepare|init|setup|install|download)/i,
  access:   /^(request|get|check|has)(access|auth|permission)/i,
  process:  /^(is|get|check)(process|running|alive)/i,
  list:     /^(get|list|fetch|load)(all|sessions|items)/i,
};

function classifyMethod(method) {
  // Classify IPC method by matching against known patterns.
  // Returns: 'status', 'prepare', 'access', 'process', 'list', or 'unknown'
  //
  // Used to provide appropriate default responses for macOS-only methods.
  if (typeof method !== 'string') return 'unknown';
  for (const [shape, pattern] of Object.entries(METHOD_SHAPES)) {
    if (pattern.test(method)) return shape;
  }
  return 'unknown';
}

// Pattern for detecting platform-specific errors
// These errors occur when the webapp calls macOS-specific features
const PLATFORM_ERROR_PATTERN = /unsupported|not.?supported|darwin|linux.?x64|no.?vm|virtualization/i;

function isPlatformError(error) {
  // Detect platform-specific errors that are expected on Linux.
  // These errors occur when the app tries macOS-specific features.
  //
  // Example messages:
  //   - "not supported on this platform"
  //   - "VM not available on Linux"
  //   - "Darwin-only feature"
  //
  // Used to filter out expected errors from error counts in IPC tap.
  if (!error) return false;
  const msg = typeof error === 'string' ? error : (error.message || '');
  return PLATFORM_ERROR_PATTERN.test(msg);
}

// Safe default responses for macOS-specific methods
// These defaults allow the webapp to work on Linux even when certain
// macOS features aren't available (like VM download/preparation)
const SAFE_DEFAULTS = {
  status:  { status: 'ready', ready: true, installed: true, downloading: false, progress: 100 },
  prepare: { ready: true, success: true },
  access:  { authorized: true, granted: true },
  process: { running: false, exitCode: 0 },
  list:    [],
};

module.exports = {
  METHOD_SHAPES,
  PLATFORM_ERROR_PATTERN,
  SAFE_DEFAULTS,
  classifyMethod,
  isPlatformError,
  parseEipcChannel,
};
