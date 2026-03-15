'use strict';

function parseEipcChannel(channel) {
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

const METHOD_SHAPES = {
  status:   /^(get)?(status|state|running|support|health)/i,
  prepare:  /^(prepare|init|setup|install|download)/i,
  access:   /^(request|get|check|has)(access|auth|permission)/i,
  process:  /^(is|get|check)(process|running|alive)/i,
  list:     /^(get|list|fetch|load)(all|sessions|items)/i,
};

function classifyMethod(method) {
  if (typeof method !== 'string') return 'unknown';
  for (const [shape, pattern] of Object.entries(METHOD_SHAPES)) {
    if (pattern.test(method)) return shape;
  }
  return 'unknown';
}

const PLATFORM_ERROR_PATTERN = /unsupported|not.?supported|darwin|linux.?x64|no.?vm|virtualization/i;

function isPlatformError(error) {
  if (!error) return false;
  const msg = typeof error === 'string' ? error : (error.message || '');
  return PLATFORM_ERROR_PATTERN.test(msg);
}

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
