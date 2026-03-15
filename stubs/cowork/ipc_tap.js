'use strict';

const fs = require('fs');
const path = require('path');
const { redactCredentials } = require('./credential_classifier.js');
const { parseEipcChannel, classifyMethod, isPlatformError } = require('./eipc_channel.js');

const MAX_PAYLOAD_LENGTH = 4000;

function truncatePayload(value) {
  if (value === undefined) return undefined;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof str !== 'string') return String(value);
  if (str.length <= MAX_PAYLOAD_LENGTH) return str;
  return str.slice(0, MAX_PAYLOAD_LENGTH) + '...[truncated ' + str.length + ' chars]';
}

function safeSerialize(value) {
  try {
    return redactCredentials(truncatePayload(value));
  } catch (_) {
    return '[unserializable]';
  }
}

function createIpcTap(options) {
  const {
    logDir = null,
    enabled = false,
  } = options || {};

  if (!enabled) {
    return {
      enabled: false,
      wrapHandle: (ipcMain) => ipcMain,
      wrapInvokeHandlers: (m) => m,
      wrapWebContents: () => {},
      getStats: () => ({}),
    };
  }

  const logPath = logDir
    ? path.join(logDir, 'ipc-tap.jsonl')
    : null;
  let logFd = null;
  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
      logFd = fs.openSync(logPath, 'a', 0o600);
    } catch (e) {
      console.error('[IPC-TAP] Failed to open log file:', e.message);
    }
  }

  const stats = {
    handleCalls: 0,
    handleErrors: 0,
    platformErrors: 0,
    sendCalls: 0,
    registrations: 0,
    channels: new Map(),
  };

  function recordEntry(entry) {
    const line = JSON.stringify(entry) + '\n';
    if (logFd !== null) {
      try {
        fs.writeSync(logFd, line);
      } catch (_) {}
    }
    // Also emit to stdout for real-time grep
    console.log('[IPC-TAP] ' + line.trimEnd());
  }

  function recordChannelStats(channel, direction, durationMs, error) {
    let channelStats = stats.channels.get(channel);
    if (!channelStats) {
      const parsed = parseEipcChannel(channel);
      channelStats = {
        method: parsed ? parsed.method : null,
        category: parsed ? parsed.category : null,
        namespace: parsed ? parsed.namespace : null,
        shape: parsed ? classifyMethod(parsed.method) : 'unknown',
        invokeCount: 0,
        errorCount: 0,
        platformErrorCount: 0,
        sendCount: 0,
        totalDurationMs: 0,
        lastSeen: 0,
        errors: [],
      };
      stats.channels.set(channel, channelStats);
    }

    channelStats.lastSeen = Date.now();
    if (direction === 'handle') {
      channelStats.invokeCount += 1;
      channelStats.totalDurationMs += durationMs || 0;
      if (error) {
        channelStats.errorCount += 1;
        if (isPlatformError(error)) {
          channelStats.platformErrorCount += 1;
        }
        // Keep last 3 unique error messages per channel
        const msg = typeof error === 'string' ? error : (error.message || String(error));
        if (!channelStats.errors.includes(msg)) {
          channelStats.errors.push(msg);
          if (channelStats.errors.length > 3) channelStats.errors.shift();
        }
      }
    } else if (direction === 'send') {
      channelStats.sendCount += 1;
    }
  }

  // Wrap a raw handler function with tap instrumentation
  function wrapHandlerFn(channel, handler) {
    if (typeof handler !== 'function') return handler;
    const parsed = parseEipcChannel(channel);

    return async function(...args) {
      stats.handleCalls += 1;
      const startTime = Date.now();

      recordEntry({
        ts: startTime,
        dir: 'invoke',
        channel,
        method: parsed ? parsed.method : null,
        args: safeSerialize(args),
      });

      try {
        const result = await handler(...args);
        const duration = Date.now() - startTime;
        recordChannelStats(channel, 'handle', duration, null);

        recordEntry({
          ts: Date.now(),
          dir: 'result',
          channel,
          method: parsed ? parsed.method : null,
          durationMs: duration,
          result: safeSerialize(result),
        });

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        stats.handleErrors += 1;
        if (isPlatformError(error)) {
          stats.platformErrors += 1;
        }
        recordChannelStats(channel, 'handle', duration, error);

        recordEntry({
          ts: Date.now(),
          dir: 'error',
          channel,
          method: parsed ? parsed.method : null,
          durationMs: duration,
          error: error.message || String(error),
          isPlatformError: isPlatformError(error),
          shape: parsed ? classifyMethod(parsed.method) : 'unknown',
        });

        throw error;
      }
    };
  }

  function recordRegistration(channel) {
    stats.registrations += 1;
    const parsed = parseEipcChannel(channel);
    recordEntry({
      ts: Date.now(),
      dir: 'register',
      channel: typeof channel === 'string' ? channel : String(channel),
      method: parsed ? parsed.method : null,
      category: parsed ? parsed.category : null,
      shape: parsed ? classifyMethod(parsed.method) : 'unknown',
    });
  }

  function wrapHandle(ipcMain) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return ipcMain;

    const originalHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = function(channel, handler) {
      recordRegistration(channel);
      return originalHandle(channel, wrapHandlerFn(channel, handler));
    };

    return ipcMain;
  }

  // Tap the _invokeHandlers Map directly — this is where EIPC handlers
  // are registered. The asar uses _invokeHandlers.set(channel, handler)
  // instead of ipcMain.handle(), so wrapHandle() alone misses them.
  function wrapInvokeHandlers(invokeHandlers) {
    if (!invokeHandlers || typeof invokeHandlers.set !== 'function') return invokeHandlers;

    const originalSet = invokeHandlers.set.bind(invokeHandlers);
    const originalGet = invokeHandlers.get.bind(invokeHandlers);

    invokeHandlers.set = function(channel, handler) {
      recordRegistration(channel);
      return originalSet(channel, wrapHandlerFn(channel, handler));
    };

    invokeHandlers.get = function(channel) {
      const handler = originalGet(channel);
      // Don't double-wrap on get — the handler was already wrapped on set.
      // But if it's a handler we haven't seen (injected externally), wrap it.
      if (handler && !handler.__ipcTapWrapped) {
        const wrapped = wrapHandlerFn(channel, handler);
        wrapped.__ipcTapWrapped = true;
        return wrapped;
      }
      return handler;
    };

    return invokeHandlers;
  }

  const tappedContents = new WeakSet();

  function wrapWebContents(contents) {
    if (!contents || typeof contents.send !== 'function') return;
    if (tappedContents.has(contents)) return;
    tappedContents.add(contents);

    const originalSend = contents.send.bind(contents);
    contents.send = function(channel, ...args) {
      stats.sendCalls += 1;
      recordChannelStats(channel, 'send', 0, null);

      recordEntry({
        ts: Date.now(),
        dir: 'send',
        channel,
        payload: safeSerialize(args.length === 1 ? args[0] : args),
      });

      return originalSend(channel, ...args);
    };
  }

  function getStats() {
    const channelSummary = {};
    for (const [channel, channelStats] of stats.channels) {
      channelSummary[channel] = { ...channelStats };
    }
    return {
      handleCalls: stats.handleCalls,
      handleErrors: stats.handleErrors,
      platformErrors: stats.platformErrors,
      sendCalls: stats.sendCalls,
      registrations: stats.registrations,
      uniqueChannels: stats.channels.size,
      channels: channelSummary,
    };
  }

  function writeSummary() {
    const summary = getStats();
    recordEntry({
      ts: Date.now(),
      dir: 'summary',
      ...summary,
      channels: undefined,
    });

    // Write per-channel stats sorted by error count (interesting ones first)
    const sorted = Object.entries(summary.channels)
      .sort((a, b) => (b[1].platformErrorCount - a[1].platformErrorCount) || (b[1].errorCount - a[1].errorCount));
    for (const [channel, channelStats] of sorted) {
      recordEntry({
        ts: Date.now(),
        dir: 'channel_summary',
        channel,
        ...channelStats,
      });
    }

    if (logPath) {
      console.log('[IPC-TAP] Summary written to ' + logPath);
      console.log('[IPC-TAP] ' + summary.registrations + ' registered, '
        + summary.handleCalls + ' invoked, '
        + summary.handleErrors + ' errors ('
        + summary.platformErrors + ' platform), '
        + summary.sendCalls + ' sent, '
        + summary.uniqueChannels + ' unique channels');
    }
  }

  // Write summary on exit
  process.on('exit', writeSummary);

  console.log('[IPC-TAP] Enabled, logging to ' + (logPath || 'stdout'));

  return {
    enabled: true,
    wrapHandle,
    wrapInvokeHandlers,
    wrapWebContents,
    getStats,
    writeSummary,
  };
}

module.exports = {
  createIpcTap,
  safeSerialize,
  truncatePayload,
};
