const fs = require('fs');
const path = require('path');

// @session-refactor:NORM-004 DEFINITION — message types to drop from transcript reads (asar_adapter.js)
// NOTE: Same set as NORM-001 (frame-fix-wrapper.js) but used for transcript filtering, not live events
const IGNORED_LOCAL_SESSION_MESSAGE_TYPES = new Set([
  'last-prompt',
  'progress',
  'queue-operation',
  'rate_limit_event',
]);

// Compute the macOS-style legacy path that the asar's minified code constructs
// and the XDG path that Electron actually uses on Linux.
const os = require('os');
const _homeDir = os.homedir();
const _xdgConfigHome = (typeof process.env.XDG_CONFIG_HOME === 'string' && process.env.XDG_CONFIG_HOME.trim())
  ? path.resolve(process.env.XDG_CONFIG_HOME)
  : path.join(_homeDir, '.config');
const _legacyLocalAgentRoot = path.join(_homeDir, 'Library', 'Application Support', 'Claude', 'LocalAgentModeSessions');
const _xdgLocalAgentRoot = path.join(_xdgConfigHome, 'Claude', 'local-agent-mode-sessions');

const DEFAULT_FILESYSTEM_PATH_ALIASES = [
  // Critical: macOS-style paths the asar constructs → actual XDG paths on Linux
  {
    from: _legacyLocalAgentRoot,
    to: _xdgLocalAgentRoot,
  },
  // Project-specific aliases (historical)
  {
    from: path.join(_homeDir, 'dev', 'claude-cowork-linux', 'backend'),
    to: path.join(_homeDir, 'dev', 'claude-linux', 'backend'),
  },
  {
    from: path.join(_homeDir, 'dev', 'claude-cowork-linux', 'cowork-ui'),
    to: path.join(_homeDir, 'dev', 'claude-linux', 'cowork-ui'),
  },
];

function isLocalSessionResultChannel(channel) {
  if (typeof channel !== 'string') {
    return false;
  }
  const normalizedChannel = channel.toLowerCase();
  const isLocalSessionChannel = normalizedChannel.includes('localagentmodesessions') || normalizedChannel.includes('localsessions');
  if (!isLocalSessionChannel) {
    return false;
  }
  return normalizedChannel.includes('getsession') ||
    normalizedChannel.includes('getall') ||
    normalizedChannel.includes('gettranscript');
}

// @session-refactor:NORM-005 DEFINITION — filter transcript messages, removing ignored types
function filterTranscriptMessages(result) {
  if (!Array.isArray(result)) {
    return result;
  }

  return result.filter((message) => {
    if (!message || typeof message !== 'object') {
      return false;
    }
    // @session-refactor:NORM-004 CALLER — uses IGNORED_LOCAL_SESSION_MESSAGE_TYPES
    if (IGNORED_LOCAL_SESSION_MESSAGE_TYPES.has(message.type)) {
      return false;
    }
    // @session-refactor:NORM-004 CALLER — uses IGNORED_LOCAL_SESSION_MESSAGE_TYPES (nested message)
    if (message.type === 'message' && message.message && typeof message.message === 'object') {
      if (IGNORED_LOCAL_SESSION_MESSAGE_TYPES.has(message.message.type)) {
        return false;
      }
    }
    return true;
  });
}

function isLocalSessionMutationChannel(channel) {
  if (typeof channel !== 'string') {
    return false;
  }
  const normalizedChannel = channel.toLowerCase();
  const isLocalSessionChannel = normalizedChannel.includes('localagentmodesessions') || normalizedChannel.includes('localsessions');
  if (!isLocalSessionChannel) {
    return false;
  }
  return normalizedChannel.includes('sendmessage') ||
    normalizedChannel.includes('setmodel') ||
    normalizedChannel.includes('updatesession') ||
    normalizedChannel.includes('stop') ||
    normalizedChannel.includes('archive') ||
    normalizedChannel.includes('openoutputsdir') ||
    normalizedChannel.includes('sharesession') ||
    normalizedChannel.includes('setmcpservers') ||
    normalizedChannel.includes('mcpcalltool') ||
    normalizedChannel.includes('mcpreadresource') ||
    normalizedChannel.includes('mcplistresources');
}

function isLocalSessionActivationChannel(channel) {
  if (typeof channel !== 'string') {
    return false;
  }
  const normalizedChannel = channel.toLowerCase();
  const isLocalSessionChannel = normalizedChannel.includes('localagentmodesessions') || normalizedChannel.includes('localsessions');
  if (!isLocalSessionChannel) {
    return false;
  }
  return normalizedChannel.includes('start') ||
    normalizedChannel.includes('getsession') ||
    normalizedChannel.includes('gettranscript') ||
    normalizedChannel.includes('setfocusedsession');
}

function isFileSystemPathRewriteChannel(channel) {
  if (typeof channel !== 'string') {
    return false;
  }
  const normalizedChannel = channel.toLowerCase();
  return normalizedChannel.endsWith('filesystem_$_readlocalfile') ||
    normalizedChannel.endsWith('filesystem_$_openlocalfile') ||
    normalizedChannel.endsWith('filesystem_$_whichapplication');
}

function isSessionScopedFileSystemPathChannel(channel) {
  if (typeof channel !== 'string') {
    return false;
  }
  const normalizedChannel = channel.toLowerCase();
  return normalizedChannel.endsWith('filesystem_$_readlocalfile') ||
    normalizedChannel.endsWith('filesystem_$_openlocalfile');
}

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch (_) {
    return false;
  }
}

function rewriteAliasedFilePath(inputPath, aliases) {
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) {
    return inputPath;
  }
  if (pathExists(inputPath)) {
    return inputPath;
  }

  const normalizedInput = path.resolve(inputPath);
  for (const alias of aliases || []) {
    if (!alias || typeof alias !== 'object') {
      continue;
    }
    const fromRoot = typeof alias.from === 'string' && alias.from.trim() ? path.resolve(alias.from) : null;
    const toRoot = typeof alias.to === 'string' && alias.to.trim() ? path.resolve(alias.to) : null;
    if (!fromRoot || !toRoot) {
      continue;
    }
    if (normalizedInput !== fromRoot && !normalizedInput.startsWith(fromRoot + path.sep)) {
      continue;
    }

    const relativePath = path.relative(fromRoot, normalizedInput);
    const candidatePath = path.resolve(path.join(toRoot, relativePath));
    if (pathExists(candidatePath)) {
      return candidatePath;
    }

    // Handle doubled paths: the asar sometimes joins a base with an already-absolute
    // path (minus leading /), producing paths like:
    //   <fromRoot>/home/user/<fromRoot>/sessions/name/mnt/file.md
    // Extract just the sessions/... portion and try again.
    const sessionsIdx = relativePath.indexOf('sessions' + path.sep);
    if (sessionsIdx > 0) {
      const sessionsRelative = relativePath.substring(sessionsIdx);
      const dedupedCandidate = path.resolve(path.join(toRoot, sessionsRelative));
      if (pathExists(dedupedCandidate)) {
        return dedupedCandidate;
      }
    }
  }

  return inputPath;
}

function isElectronIpcEvent(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return !!(
    value.sender ||
    value.senderFrame ||
    value.frameId ||
    value.processId
  );
}

function splitIpcArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return {
      eventArg: null,
      payloadArgs: [],
    };
  }
  if (isElectronIpcEvent(args[0])) {
    return {
      eventArg: args[0],
      payloadArgs: args.slice(1),
    };
  }
  return {
    eventArg: null,
    payloadArgs: args.slice(),
  };
}

function joinIpcArgs(eventArg, payloadArgs) {
  return eventArg ? [eventArg, ...(payloadArgs || [])] : (payloadArgs || []);
}

function getSessionContextKey(eventArg) {
  if (!isElectronIpcEvent(eventArg)) {
    return null;
  }
  if (eventArg.sender && (typeof eventArg.sender.id === 'number' || typeof eventArg.sender.id === 'string')) {
    return 'sender:' + String(eventArg.sender.id);
  }
  if (typeof eventArg.frameId === 'number' || typeof eventArg.frameId === 'string') {
    return 'frame:' + String(eventArg.frameId);
  }
  if (typeof eventArg.processId === 'number' || typeof eventArg.processId === 'string') {
    return 'process:' + String(eventArg.processId);
  }
  return null;
}

function getExplicitSessionIdFromPayload(payloadArgs) {
  if (!Array.isArray(payloadArgs)) {
    return null;
  }

  for (const arg of payloadArgs) {
    if (typeof arg === 'string' && arg.startsWith('local_')) {
      return arg;
    }
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
      continue;
    }
    if (typeof arg.localSessionId === 'string' && arg.localSessionId.trim()) {
      return arg.localSessionId;
    }
    if (typeof arg.sessionId === 'string' && arg.sessionId.startsWith('local_')) {
      return arg.sessionId;
    }
  }

  return null;
}

function getFileSystemRequestContext(channel, args) {
  const { eventArg, payloadArgs } = splitIpcArgs(args);
  const normalizedChannel = typeof channel === 'string' ? channel.toLowerCase() : '';
  const hasExplicitSessionSlot = isSessionScopedFileSystemPathChannel(normalizedChannel) &&
    typeof payloadArgs[0] === 'string' &&
    payloadArgs[0].startsWith('local_');

  if (hasExplicitSessionSlot) {
    const [localSessionId, targetPath, ...rest] = payloadArgs;
    return {
      eventArg,
      localSessionId: typeof localSessionId === 'string' && localSessionId.trim() ? localSessionId : null,
      payloadArgs,
      restArgs: rest,
      targetPath: typeof targetPath === 'string' ? targetPath : null,
    };
  }

  const [targetPath, ...rest] = payloadArgs;
  return {
    eventArg,
    localSessionId: getExplicitSessionIdFromPayload(rest),
    payloadArgs,
    restArgs: rest,
    targetPath: typeof targetPath === 'string' ? targetPath : null,
  };
}

function attachFileResolutionDetails(error, resolution, localSessionId) {
  if (!error || typeof error !== 'object' || !resolution || typeof resolution !== 'object') {
    return error;
  }

  error.fileId = typeof resolution.fileId === 'string' ? resolution.fileId : null;
  error.fileResolution = typeof resolution.resolution === 'string' ? resolution.resolution : null;
  error.localSessionId = typeof localSessionId === 'string' && localSessionId.trim() ? localSessionId : null;
  error.sessionId = error.localSessionId;
  error.relinkRequired = !!resolution.relinkRequired;
  error.requestedPath = typeof resolution.requestedPath === 'string' ? resolution.requestedPath : null;
  error.resolvedPath = typeof resolution.resolvedPath === 'string' ? resolution.resolvedPath : null;
  error.candidates = Array.isArray(resolution.candidates) ? resolution.candidates.slice() : [];
  error.ambiguity = error.fileResolution === 'ambiguous'
    ? {
      candidates: error.candidates.slice(),
    }
    : null;
  error.file = resolution.file && typeof resolution.file === 'object'
    ? {
      ...resolution.file,
      authorizedRoots: Array.isArray(resolution.file.authorizedRoots)
        ? resolution.file.authorizedRoots.slice()
        : [],
      history: Array.isArray(resolution.file.history)
        ? resolution.file.history.slice()
        : [],
      provenance: resolution.file.provenance && typeof resolution.file.provenance === 'object'
        ? { ...resolution.file.provenance }
        : null,
    }
    : null;
  return error;
}

function describeFileSystemRelinkIpcSurface() {
  return {
    chooserOnlyChannels: [
      'claude.settings.FilePickers.getFilePath',
      'claude.settings.FilePickers.getDirectoryPath',
      'claude.web.FileSystem.browseFiles',
      'claude.web.FileSystem.browseFolder',
    ],
    missingRequestContract: {
      args: ['localSessionId', 'fileId', 'targetPath'],
      method: 'claude.web.FileSystem.relinkLocalFile',
      reason: 'No existing extracted-app FileSystem or FilePickers IPC method accepts a fileId-scoped relink commit.',
      result: ['resolution', 'resolvedPath', 'fileId', 'file'],
    },
    relinkRequestChannel: null,
    structuredFailureChannels: [
      {
        args: ['sessionId', 'path'],
        method: 'claude.web.FileSystem.readLocalFile',
      },
      {
        args: ['sessionId', 'path', 'showInFolder?'],
        method: 'claude.web.FileSystem.openLocalFile',
      },
    ],
  };
}

class AsarAdapter {
  constructor(options) {
    const { sessionOrchestrator, sessionStore } = options || {};
    this._allowActiveSessionFallback = !!(options && options.allowActiveSessionFallback);
    this._sessionOrchestrator = sessionOrchestrator || null;
    this._sessionStore = sessionStore;
    this._sessionContextBySender = new Map();
    this._fileSystemPathAliases = Array.isArray(options && options.fileSystemPathAliases) &&
      options.fileSystemPathAliases.length > 0
      ? options.fileSystemPathAliases.slice()
      : DEFAULT_FILESYSTEM_PATH_ALIASES.slice();
  }

  // @session-refactor:NORM-006 DEFINITION — normalize IPC results (filter transcripts, repair session records)
  normalizeIpcResult(channel, result) {
    if (!isLocalSessionResultChannel(channel)) {
      return result;
    }

    const normalizedChannel = String(channel).toLowerCase();
    if (normalizedChannel.includes('gettranscript')) {
      // @session-refactor:NORM-005 CALLER — filter transcript messages
      return filterTranscriptMessages(result);
    }
    if (normalizedChannel.includes('getsession')) {
      // @session-refactor:NORM-020 CALLER — normalize single session record
      return this._sessionStore && typeof this._sessionStore.normalizeSessionRecord === 'function'
        ? this._sessionStore.normalizeSessionRecord(result)
        : result;
    }
    if (normalizedChannel.includes('getall') && Array.isArray(result)) {
      // @session-refactor:NORM-020 CALLER — normalize array of session records
      return this._sessionStore && typeof this._sessionStore.normalizeSessionRecord === 'function'
        ? result.map((entry) => this._sessionStore.normalizeSessionRecord(entry))
        : result;
    }
    return result;
  }

  rewriteIpcArgs(channel, args) {
    if (!Array.isArray(args) || args.length === 0) {
      return args;
    }

    if (!isLocalSessionMutationChannel(channel) || !this._sessionStore) {
      return args;
    }

    const { eventArg, payloadArgs } = splitIpcArgs(args);
    const [sessionId, ...rest] = payloadArgs;
    const routedSessionId = this._sessionStore.resolveMutationSessionId(sessionId);
    if (!routedSessionId || routedSessionId === sessionId) {
      return args;
    }

    return joinIpcArgs(eventArg, [routedSessionId, ...rest]);
  }

  observeLocalSessionActivity(channel, args, result) {
    if (!this._sessionStore || !isLocalSessionActivationChannel(channel)) {
      return result;
    }

    const normalizedChannel = String(channel).toLowerCase();
    const { eventArg, payloadArgs } = splitIpcArgs(args);
    if (normalizedChannel.includes('start')) {
      if (
        result &&
        typeof result === 'object' &&
        typeof result.sessionId === 'string' &&
        typeof this._sessionStore.observeSessionId === 'function'
      ) {
        this._sessionStore.observeSessionId(result.sessionId);
        this._rememberSessionContext(eventArg, result.sessionId);
      }
      return result;
    }

    if (normalizedChannel.includes('getsession') && typeof this._sessionStore.observeSessionRead === 'function') {
      const observedResult = this._sessionStore.observeSessionRead(result);
      if (observedResult && typeof observedResult.sessionId === 'string') {
        this._rememberSessionContext(eventArg, observedResult.sessionId);
      }
      return observedResult;
    }

    if (normalizedChannel.includes('gettranscript') || normalizedChannel.includes('setfocusedsession')) {
      const [sessionId] = payloadArgs;
      if (typeof sessionId === 'string' && typeof this._sessionStore.observeSessionId === 'function') {
        this._sessionStore.observeSessionId(sessionId);
        this._rememberSessionContext(eventArg, sessionId);
      }
    }

    return result;
  }

  _rememberSessionContext(eventArg, localSessionId) {
    const sessionContextKey = getSessionContextKey(eventArg);
    if (!sessionContextKey || typeof localSessionId !== 'string' || !localSessionId.trim()) {
      return;
    }
    this._sessionContextBySender.set(sessionContextKey, localSessionId);
  }

  _rewriteFileSystemArgs(channel, args) {
    const normalizedChannel = typeof channel === 'string' ? channel.toLowerCase() : '';
    const fileSystemRequest = getFileSystemRequestContext(normalizedChannel, args);
    const {
      eventArg,
      localSessionId: explicitLocalSessionId,
      payloadArgs,
      restArgs,
      targetPath,
    } = fileSystemRequest;
    if (typeof targetPath !== 'string') {
      return { rewrittenArgs: args };
    }

    const sessionContextKey = getSessionContextKey(eventArg);
    const contextSessionId = explicitLocalSessionId ||
      (sessionContextKey ? this._sessionContextBySender.get(sessionContextKey) || null : null);
    const registryResolution = this._sessionOrchestrator && typeof this._sessionOrchestrator.resolveFileSystemPath === 'function'
      ? this._sessionOrchestrator.resolveFileSystemPath({
        allowActiveSessionFallback: this._allowActiveSessionFallback && !contextSessionId,
        localSessionId: contextSessionId,
        targetPath,
      })
      : null;

    if (registryResolution && registryResolution.resolution === 'unauthorized') {
      const error = new Error('Unauthorized FileSystem path for current session: ' + targetPath);
      error.code = 'COWORK_UNAUTHORIZED_PATH';
      error.sessionId = contextSessionId || null;
      throw attachFileResolutionDetails(error, registryResolution, contextSessionId);
    }
    if (registryResolution && registryResolution.resolution === 'context_required') {
      const error = new Error('Missing FileSystem session context for path: ' + targetPath);
      error.code = 'COWORK_MISSING_SESSION_CONTEXT';
      throw attachFileResolutionDetails(error, registryResolution, contextSessionId);
    }
    if (registryResolution && registryResolution.resolution === 'unavailable') {
      const error = new Error('File registry unavailable for path resolution: ' + targetPath);
      error.code = 'COWORK_FILE_REGISTRY_UNAVAILABLE';
      throw attachFileResolutionDetails(error, registryResolution, contextSessionId);
    }
    if (
      registryResolution &&
      registryResolution.relinkRequired &&
      registryResolution.fileId &&
      (registryResolution.resolution === 'missing' || registryResolution.resolution === 'ambiguous')
    ) {
      const error = new Error(
        registryResolution.resolution === 'ambiguous'
          ? 'Ambiguous FileSystem relink required for path: ' + targetPath
          : 'Missing tracked FileSystem path requires relink: ' + targetPath
      );
      error.code = 'COWORK_FILE_RELINK_REQUIRED';
      error.sessionId = contextSessionId || null;
      throw attachFileResolutionDetails(error, registryResolution, contextSessionId);
    }

    const registryResolvedPath = registryResolution &&
      typeof registryResolution.resolvedPath === 'string' &&
      registryResolution.resolution !== 'missing' &&
      registryResolution.resolution !== 'invalid' &&
      registryResolution.resolution !== 'context_required' &&
      registryResolution.resolution !== 'unavailable' &&
      registryResolution.resolution !== 'unauthorized'
      ? registryResolution.resolvedPath
      : targetPath;
    const rewrittenPath = registryResolvedPath !== targetPath
      ? registryResolvedPath
      : rewriteAliasedFilePath(targetPath, this._fileSystemPathAliases);

    const nextPayloadArgs = explicitLocalSessionId && payloadArgs[0] === explicitLocalSessionId
      ? [payloadArgs[0], rewrittenPath, ...restArgs]
      : [rewrittenPath, ...restArgs];

    return {
      rewrittenArgs: rewrittenPath !== targetPath
        ? joinIpcArgs(eventArg, nextPayloadArgs)
        : args,
    };
  }

  wrapHandler(channel, handler) {
    if (typeof handler !== 'function') {
      return handler;
    }

    const self = this;
    const wrappedHandler = async function(...args) {
      let rewrittenArgs = args;
      if (isFileSystemPathRewriteChannel(channel)) {
        rewrittenArgs = self._rewriteFileSystemArgs(channel, args).rewrittenArgs;
      }
      rewrittenArgs = self.rewriteIpcArgs(channel, rewrittenArgs);
      const result = await handler(...rewrittenArgs);
      const observedResult = self.observeLocalSessionActivity(channel, rewrittenArgs, result);
      return self.normalizeIpcResult(channel, observedResult);
    };
    wrappedHandler.__coworkLocalSessionWrapped = true;
    return wrappedHandler;
  }
}

function createAsarAdapter(options) {
  return new AsarAdapter(options);
}

// @session-refactor:NORM-005 DEFINITION — export surface for filterTranscriptMessages
// @session-refactor:NORM-006 DEFINITION — export surface for AsarAdapter.normalizeIpcResult
module.exports = {
  createAsarAdapter,
  DEFAULT_FILESYSTEM_PATH_ALIASES,
  describeFileSystemRelinkIpcSurface,
  filterTranscriptMessages,
  getFileSystemRequestContext,
  isFileSystemPathRewriteChannel,
  isLocalSessionMutationChannel,
  isLocalSessionResultChannel,
  rewriteAliasedFilePath,
};
