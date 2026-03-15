const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createFileRegistry,
  createFileResolutionResult,
} = require('./file_registry.js');
const {
  createFileWatchManager,
} = require('./file_watch_manager.js');
const {
  createProcessManager,
  deriveSessionDirectory,
  deriveSessionMetadataPath,
  resolveHostCwdPath,
} = require('./process_manager.js');
const {
  handleFlatlineResumeFailure,
  planSessionResume,
} = require('./resume_coordinator.js');
const {
  buildTranscriptContinuityPlan,
} = require('./transcript_store.js');

// ============================================================================
// MOUNT MANAGER
// ============================================================================
// MountManager prepares mount symlinks for session spawns. On macOS, the CLI
// runs in a VM and needs symlinks to access host directories. On Linux, the
// CLI runs directly on the host, so mount symlinks are created for consistency
// but are not strictly necessary for most operations.

class MountManager {
  constructor(deps) {
    this._deps = deps || {};
  }

  prepare(context) {
    // Prepare mount symlinks for CLI spawn:
    //   1. Extract session name from args/envVars/sharedCwdPath
    //   2. Create mount symlinks if session name is found
    //   3. Handle session-less spawns (no VM paths, no mounts needed)
    const {
      processId,
      processName,
      args,
      envVars,
      additionalMounts,
      sharedCwdPath,
      onError,
    } = context || {};
    const {
      createMountSymlinks,
      findSessionName,
      trace = () => {},
    } = this._deps;

    // Step 1: Extract session name
    let sessionName = null;
    try {
      sessionName = findSessionName(args, envVars, sharedCwdPath);
    } catch (error) {
      if (typeof onError === 'function') {
        onError(processId, error.message, error.stack || '');
      }
      return { success: false, error: error.message };
    }

    // Skip if no additional mounts provided
    if (!additionalMounts) {
      trace('Skipping mount symlink creation: no additionalMounts provided');
      return { success: true, sessionName, skipped: true };
    }

    // Skip for session-less spawns (e.g., plugin management commands)
    if (!sessionName) {
      // Session-less spawns (e.g. plugin management: `claude plugin marketplace list`)
      // don't have /sessions/ paths. On Linux the CLI runs on the host directly and
      // doesn't need mount symlinks — the additionalMounts are a macOS VM concept.
      trace('Session-less spawn (no VM path); mount symlinks not needed on Linux');
      return { success: true, sessionName: processName || null, skipped: true };
    }

    // Step 2: Create mount symlinks
    trace('Creating mount symlinks for session: ' + sessionName);
    if (!createMountSymlinks(sessionName, additionalMounts)) {
      const message = 'Failed to create mount symlinks for session: ' + sessionName;
      trace('ERROR: ' + message);
      if (typeof onError === 'function') {
        onError(processId, message, '');
      }
      return { success: false, error: message };
    }

    return { success: true, sessionName, skipped: false };
  }
}

// ============================================================================
// RESUME-ARGUMENT HANDLING
// ============================================================================
// These functions manage the --resume flag in CLI arguments, which tells
// the CLI to continue an existing conversation rather than start fresh.
// They handle finding, removing, and replacing resume arguments.

function findResumeArgIndex(args) {
  // Find the index of --resume flag in args array.
  // Returns -1 if not found or if next arg is missing/invalid.
  if (!Array.isArray(args)) {
    return -1;
  }
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '--resume' && typeof args[index + 1] === 'string' && args[index + 1].trim()) {
      return index;
    }
  }
  return -1;
}

function removeResumeArgs(args, trace) {
  // Remove --resume and its value from args array.
  // Used when retrying a failed session from scratch.
  const resumeArgIndex = findResumeArgIndex(args);
  if (resumeArgIndex === -1) {
    return args;
  }
  const nextArgs = args.slice(0, resumeArgIndex).concat(args.slice(resumeArgIndex + 2));
  trace('Removed stale --resume argument');
  return nextArgs;
}

function replaceResumeArgs(args, cliSessionId, trace) {
  // Replace the --resume argument value with a new session ID.
  // Used when recovering from flatline with a new CLI session ID.
  const resumeArgIndex = findResumeArgIndex(args);
  if (resumeArgIndex === -1) {
    return args;
  }
  if (args[resumeArgIndex + 1] === cliSessionId) {
    return args;
  }
  const nextArgs = args.slice();
  nextArgs[resumeArgIndex + 1] = cliSessionId;
  trace('Updated --resume target to ' + cliSessionId);
  return nextArgs;
}

// ============================================================================
// METADATA PERSISTENCE
// ============================================================================
// These functions handle reading and writing session metadata to disk.
// Metadata includes session IDs, working directory, CLI session ID, and more.
// The metadata file is located at <sessionDir>.json (e.g., /path/to/session.json)

function readSessionDataFromMetadata(metadataPath, trace) {
  // Read and parse session metadata JSON file.
  // Returns null if file doesn't exist or can't be parsed.
  if (typeof metadataPath !== 'string' || !metadataPath.trim() || !fs.existsSync(metadataPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    trace('WARNING: Failed to read session metadata from ' + metadataPath + ': ' + error.message);
    return null;
  }
}

function persistSessionDataToMetadata(metadataPath, sessionData, trace) {
  // Write session metadata to disk as formatted JSON.
  // Returns true on success, false on failure.
  if (typeof metadataPath !== 'string' || !metadataPath.trim() || !sessionData || typeof sessionData !== 'object') {
    return false;
  }

  try {
    fs.writeFileSync(metadataPath, JSON.stringify(sessionData, null, 2) + '\n', 'utf8');
    trace('Persisted refreshed session metadata to ' + metadataPath);
    return true;
  } catch (error) {
    trace('WARNING: Failed to persist session metadata to ' + metadataPath + ': ' + error.message);
    return false;
  }
}

// ============================================================================
// HOST-PATH ENV TRANSLATION
// ============================================================================
// Translates VM-style paths in environment variables to host paths.
// This is critical for CLAUDE_CONFIG_DIR which must point to the real
// session directory on the Linux host, not a VM path like /sessions/...

function translateHostConfigDir(envVars, deps) {
  // Translate CLAUDE_CONFIG_DIR from VM path to host path.
  // VM path format: /sessions/<name>/mnt/.claude
  // Host path format: ~/.config/Claude/local-agent-mode-sessions/sessions/<name>/mnt/.claude
  //
  // This translation ensures the CLI can find its config, transcripts, and
  // state files on the Linux host filesystem.
  const {
    canonicalizePathForHostAccess,
    trace = () => {},
    translateVmPathStrict,
  } = deps || {};

  const translatedEnvVars = envVars && typeof envVars === 'object' ? { ...envVars } : {};
  let hostConfigDir = translatedEnvVars.CLAUDE_CONFIG_DIR;
  
  // Translate /sessions/ paths to host equivalents
  if (typeof hostConfigDir === 'string' && hostConfigDir.startsWith('/sessions/')) {
    try {
      hostConfigDir = canonicalizePathForHostAccess(hostConfigDir);
    } catch (error) {
      try {
        hostConfigDir = translateVmPathStrict(hostConfigDir);
      } catch (_) {
        trace('WARNING: Failed to translate CLAUDE_CONFIG_DIR "' + translatedEnvVars.CLAUDE_CONFIG_DIR + '"');
        hostConfigDir = translatedEnvVars.CLAUDE_CONFIG_DIR;
      }
    }
  }
  return {
    translatedEnvVars,
    hostConfigDir,
  };
}

// ============================================================================
// GENERIC CLI FLAG PARSING
// ============================================================================
// Utility functions for parsing and manipulating CLI arguments.
// These handle both '--flag value' and '--flag=value' formats.

function findFlagValue(args, flagName) {
  // Extract the value of a CLI flag from args array.
  // Supports both '--flag value' and '--flag=value' formats.
  // Returns null if flag is not found or has no value.
  if (!Array.isArray(args) || typeof flagName !== 'string' || !flagName.length) {
    return null;
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    
    // Format: --flag value
    if (arg === flagName && typeof args[index + 1] === 'string' && args[index + 1].trim()) {
      return args[index + 1];
    }
    
    // Format: --flag=value
    if (typeof arg === 'string' && arg.startsWith(flagName + '=')) {
      const value = arg.slice((flagName + '=').length);
      if (value.trim()) {
        return value;
      }
    }
  }

  return null;
}

function removeFlagArgs(args, flagNames) {
  // Remove specified flags and their values from args array.
  // Used to filter out flags that should be replaced or ignored.
  if (!Array.isArray(args) || !Array.isArray(flagNames) || flagNames.length === 0) {
    return Array.isArray(args) ? args.slice() : [];
  }

  const targetFlags = new Set(flagNames);
  const nextArgs = [];
  
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') {
      nextArgs.push(arg);
      continue;
    }

    // Skip flag and its value (format: --flag value)
    if (targetFlags.has(arg)) {
      index += 1;
      continue;
    }

    // Skip inline flag (format: --flag=value)
    const inlineFlag = flagNames.find((flagName) => arg.startsWith(flagName + '='));
    if (inlineFlag) {
      continue;
    }

    nextArgs.push(arg);
  }
  return nextArgs;
}

function buildBridgeSpawnArgs(args, remoteSessionId) {
  // Build CLI arguments for bridge session spawns.
  // Removes asar-specific flags and adds bridge-specific flags.
  const preservedArgs = removeFlagArgs(args, [
    '--resume',
    '--print',
    '--session-id',
    '--input-format',
    '--output-format',
    '--replay-user-messages',
  ]);

  return [
    '--print',
    '--session-id',
    remoteSessionId,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--replay-user-messages',
    ...preservedArgs,
  ];
}

function deriveOrganizationUuidFromMetadataPath(metadataPath) {
  // Extract organization UUID from metadata file path structure.
  // Path format: .../<orgUuid>/<sessionId>.json
  if (typeof metadataPath !== 'string' || !metadataPath.trim()) {
    return null;
  }

  const organizationUuid = path.basename(path.dirname(metadataPath));
  return typeof organizationUuid === 'string' && organizationUuid.trim()
    ? organizationUuid.trim()
    : null;
}

// ============================================================================
// SESSION ORCHESTRATOR
// ============================================================================
// SessionOrchestrator is the main coordinator for CLI spawn operations.
// It integrates all the pieces above:
//   - Mount preparation (MountManager)
//   - Environment building (ProcessManager)
//   - Argument translation and path resolution
//   - Session metadata persistence
//   - File registry and watch management
//   - Flatline recovery and resume handling
//
// This class serves as the boundary between the IPC layer (asar) and the
// low-level spawn operations (Swift stub).

class SessionOrchestrator {
  constructor(deps) {
    this._deps = deps || {};
    this._mountManager = new MountManager(deps);
    this._processManager = createProcessManager(deps);
    this._sessionStore = this._deps.sessionStore || null;
    this._fileWatchManager = this._deps.fileWatchManager || (
      this._deps.dirs ? createFileWatchManager({ dirs: this._deps.dirs }) : null
    );
    this._fileRegistry = this._deps.fileRegistry || (
      this._deps.dirs ? createFileRegistry({
        dirs: this._deps.dirs,
        watchManager: this._fileWatchManager,
      }) : null
    );
  }

  prepareVmSpawn(context) {
    // Main entry point for preparing a CLI spawn operation.
    // Steps:
    //   1. Prepare mount symlinks (MountManager)
    //   2. Resolve and validate command binary path
    //   3. Translate VM paths in arguments to host paths
    //   4. Filter out asar-specific arguments
    //   5. Build spawn options (ProcessManager)
    //   6. Return prepared spawn configuration
    const {
      processId,
      processName,
      command,
      args,
      envVars,
      additionalMounts,
      sharedCwdPath,
      onError,
    } = context || {};
    const {
      appSupportRoot,
      canonicalizePathForHostAccess,
      canonicalizeVmPathStrict,
      claudeVmRoots,
      resolveClaudeBinaryPath,
      sessionsBase,
      trace = () => {},
      translateVmPathStrict,
    } = this._deps;

    // Step 1: Prepare mount symlinks
    const mountResult = this._mountManager.prepare({
      processId,
      processName,
      args,
      envVars,
      additionalMounts,
      sharedCwdPath,
      onError,
    });
    if (!mountResult.success) {
      return mountResult;
    }

    // Step 2: Define allowed binary paths for security
    const home = os.homedir();
    const allowedVmPrefixes = Array.isArray(claudeVmRoots) && claudeVmRoots.length > 0
      ? claudeVmRoots.map((vmRoot) => path.resolve(vmRoot) + path.sep)
      : [path.join(appSupportRoot, 'claude-code-vm') + path.sep];
    const allowedPrefixes = [
      ...allowedVmPrefixes,
      path.join(home, '.local/bin/'),
      path.join(home, '.local/share/claude/'),
      path.join(home, '.npm-global/bin/'),
      '/usr/local/bin/',
      '/usr/bin/',
    ];

    // Step 3: Resolve command to host binary path
    const normalizedCommand = (typeof command === 'string' || command instanceof String)
      ? String(command).trim()
      : '';
    const commandBasename = normalizedCommand ? path.basename(normalizedCommand) : '';

    let hostCommand;
    if (
      normalizedCommand === '/usr/local/bin/claude' ||
      normalizedCommand === 'claude' ||
      commandBasename === 'claude'
    ) {
      hostCommand = resolveClaudeBinaryPath();
      trace('Translated command: ' + normalizedCommand + ' -> ' + hostCommand);
    } else if (allowedPrefixes.some((prefix) => normalizedCommand.startsWith(prefix))) {
      if (fs.existsSync(normalizedCommand)) {
        hostCommand = normalizedCommand;
        trace('Command is an allowed absolute path: ' + normalizedCommand);
      } else {
        hostCommand = resolveClaudeBinaryPath();
        trace('Allowed absolute path missing, resolved: ' + normalizedCommand + ' -> ' + hostCommand);
      }
    } else {
      trace('SECURITY: Unexpected command blocked: "' + String(command) + '" (type=' + typeof command + ')');
      if (typeof onError === 'function') {
        onError(processId, 'Unexpected command: ' + String(command), '');
      }
      return { success: false, error: 'Unexpected command' };
    }

    // Security check: Ensure resolved command is in allowed directories
    const commandIsAllowed = hostCommand === 'claude' ||
      allowedPrefixes.some((prefix) => hostCommand.startsWith(prefix));
    if (!commandIsAllowed) {
      trace('SECURITY: Command outside allowed directories: ' + hostCommand);
      if (typeof onError === 'function') {
        onError(processId, 'Invalid binary path', '');
      }
      return { success: false, error: 'Invalid binary path' };
    }

    // Step 4: Translate VM paths in arguments to host paths
    let hostArgs = (args || []).map((arg) => {
      if (typeof arg === 'string' && arg.startsWith('/sessions/')) {
        try {
          const translated = canonicalizeVmPathStrict(arg);
          trace('Translated arg: ' + arg + ' -> ' + translated);
          return translated;
        } catch (error) {
          trace('WARNING: Failed to translate VM arg path "' + arg + '": ' + error.message);
          return arg;
        }
      }
      return arg;
    });

    // Step 5: Filter out asar-specific arguments
    const filteredArgs = [];
    for (let index = 0; index < hostArgs.length; index += 1) {
      if (hostArgs[index] === '--add-dir' && index + 1 < hostArgs.length && hostArgs[index + 1].endsWith('.asar')) {
        trace('Filtered out --add-dir for asar: ' + hostArgs[index + 1]);
        index += 1;
        continue;
      }
      filteredArgs.push(hostArgs[index]);
    }
    hostArgs = filteredArgs;

    // Step 6: Ensure sessions base directory exists
    try {
      if (!fs.existsSync(sessionsBase)) {
        fs.mkdirSync(sessionsBase, { recursive: true, mode: 0o700 });
        trace('Created sessions dir: ' + sessionsBase);
      }
    } catch (error) {
      trace('Failed to create sessions dir: ' + error.message);
    }

    // Step 7: Translate environment variables (CLAUDE_CONFIG_DIR, etc.)
    const { translatedEnvVars, hostConfigDir } = translateHostConfigDir(envVars, {
      canonicalizePathForHostAccess,
      trace,
      translateVmPathStrict,
    });

    // Step 8: Resolve working directory for CLI spawn
    const hostCwdPath = resolveHostCwdPath({
      args: hostArgs,
      canonicalizePathForHostAccess,
      configDirPath: hostConfigDir,
      sharedCwdPath,
      trace,
    });

    // Step 9: Update sessions API with OAuth token if available
    const spawnOAuthToken = translatedEnvVars.CLAUDE_CODE_OAUTH_TOKEN;
    if (
      spawnOAuthToken && typeof spawnOAuthToken === 'string' && spawnOAuthToken.trim() &&
      this._deps.sessionsApi && typeof this._deps.sessionsApi.updateAuthToken === 'function'
    ) {
      this._deps.sessionsApi.updateAuthToken(spawnOAuthToken);
      trace('Injected spawn-time OAuth token into sessions API');
    }

    // Step 10: Attempt bridge session resolution (remote session API)
    const metadataPath = deriveSessionMetadataPath(hostConfigDir);
    const localSessionInfo = this._getLocalSessionInfo(metadataPath);
    const bridgeSession = this._resolveBridgeSession({
      hostArgs,
      hostCwdPath,
      localSessionInfo,
      metadataPath,
      trace,
    });
    
    // If bridge session is available, configure CLI for bridge mode
    if (bridgeSession) {
      if (typeof bridgeSession.sessionAccessToken !== 'string' || !bridgeSession.sessionAccessToken.trim()) {
        trace('WARNING: Bridge session resolved but sessionAccessToken is empty; falling through to legacy path');
      } else {
        hostArgs = buildBridgeSpawnArgs(hostArgs, bridgeSession.remoteSessionId);
        Object.assign(translatedEnvVars, {
          CLAUDE_CODE_ENTRYPOINT: translatedEnvVars.CLAUDE_CODE_ENTRYPOINT || 'claude-desktop',
          CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge',
          CLAUDE_CODE_IS_COWORK: '1',
          CLAUDE_CODE_OAUTH_TOKEN: '',
          CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2: '1',
          CLAUDE_CODE_SESSION_ACCESS_TOKEN: bridgeSession.sessionAccessToken,
          CLAUDE_CODE_USE_COWORK_PLUGINS: '1',
        });
        trace(
          'Prepared bridge spawn for local session '
            + bridgeSession.localSessionId
            + ' via remote session '
            + bridgeSession.remoteSessionId
        );
      }
    }

    // Step 11: Check for resume arguments and session metadata
    const resumeArgIndex = findResumeArgIndex(hostArgs);
    const currentResumeCliSessionId = resumeArgIndex === -1 ? null : hostArgs[resumeArgIndex + 1];
    const sessionDirectory = deriveSessionDirectory(hostConfigDir);
    if (!bridgeSession && currentResumeCliSessionId && sessionDirectory) {
      const sessionData = {
        cliSessionId: currentResumeCliSessionId,
        userSelectedFolders: typeof hostCwdPath === 'string' && path.isAbsolute(hostCwdPath) ? [hostCwdPath] : [],
      };
      const resumePlan = planSessionResume({
        sessionData,
        sessionDirectory,
      });

      if (!resumePlan.shouldResume) {
        hostArgs = removeResumeArgs(hostArgs, trace);
      } else if (resumePlan.resumeCliSessionId) {
        hostArgs = replaceResumeArgs(hostArgs, resumePlan.resumeCliSessionId, trace);
      }
    }

    trace('vm.spawn() sharedCwdPath=' + sharedCwdPath + ' hostCwdPath=' + hostCwdPath);
    return {
      success: true,
      sessionName: mountResult.sessionName,
      command: hostCommand,
      args: hostArgs,
      envVars: translatedEnvVars,
      sharedCwdPath: hostCwdPath,
    };
  }

  buildSpawnOptions(context) {
    return this._processManager.buildSpawnOptions(context);
  }

  resolveFileSystemPath(context) {
    const {
      allowActiveSessionFallback,
      localSessionId,
      provenance,
      targetPath,
    } = context || {};

    const normalizedTargetPath = typeof targetPath === 'string' && targetPath.trim()
      && path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : null;
    if (!normalizedTargetPath) {
      return createFileResolutionResult({
        authorized: false,
        entry: null,
        relinkRequired: false,
        requestedPath: targetPath,
        resolvedPath: targetPath,
        resolution: 'invalid',
      });
    }

    if (!this._fileRegistry) {
      return createFileResolutionResult({
        authorized: false,
        entry: null,
        relinkRequired: false,
        requestedPath: normalizedTargetPath,
        resolvedPath: normalizedTargetPath,
        resolution: 'unavailable',
      });
    }

    const sessionInfo = this._resolveFileSessionInfo(localSessionId, {
      allowActiveSessionFallback: !!allowActiveSessionFallback,
    });
    if (!sessionInfo) {
      return createFileResolutionResult({
        authorized: false,
        entry: null,
        relinkRequired: false,
        requestedPath: normalizedTargetPath,
        resolvedPath: normalizedTargetPath,
        resolution: 'context_required',
      });
    }

    return this._fileRegistry.resolvePath({
      authorizedRoots: Array.isArray(sessionInfo.authorizedRoots) ? sessionInfo.authorizedRoots : [],
      localSessionId: sessionInfo.localSessionId,
      provenance: provenance || {
        created_by: 'cowork',
        linked_by: 'user',
      },
      targetPath: normalizedTargetPath,
    });
  }

  relinkFileSystemPath(context) {
    const {
      allowActiveSessionFallback,
      fileId,
      localSessionId,
      provenance,
      reason,
      targetPath,
    } = context || {};

    const normalizedTargetPath = typeof targetPath === 'string' && targetPath.trim()
      && path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : null;
    if (!normalizedTargetPath) {
      return createFileResolutionResult({
        authorized: false,
        entry: null,
        relinkRequired: false,
        requestedPath: targetPath,
        resolvedPath: targetPath,
        resolution: 'invalid',
      });
    }

    if (!this._fileRegistry) {
      return createFileResolutionResult({
        authorized: false,
        entry: null,
        relinkRequired: false,
        requestedPath: normalizedTargetPath,
        resolvedPath: normalizedTargetPath,
        resolution: 'unavailable',
      });
    }

    const sessionInfo = this._resolveFileSessionInfo(localSessionId, {
      allowActiveSessionFallback: !!allowActiveSessionFallback,
    });
    if (!sessionInfo) {
      return createFileResolutionResult({
        authorized: false,
        entry: null,
        relinkRequired: false,
        requestedPath: normalizedTargetPath,
        resolvedPath: normalizedTargetPath,
        resolution: 'context_required',
      });
    }

    return this._fileRegistry.relinkFile({
      authorizedRoots: Array.isArray(sessionInfo.authorizedRoots) ? sessionInfo.authorizedRoots : [],
      fileId,
      localSessionId: sessionInfo.localSessionId,
      provenance: provenance || {
        created_by: 'cowork',
        linked_by: 'user',
      },
      reason,
      targetPath: normalizedTargetPath,
    });
  }

  prepareFlatlineRetry(context) {
    const {
      args,
      envVars,
      sharedCwdPath,
    } = context || {};
    const {
      canonicalizePathForHostAccess,
      trace = () => {},
      translateVmPathStrict,
    } = this._deps;

    const { translatedEnvVars, hostConfigDir } = translateHostConfigDir(envVars, {
      canonicalizePathForHostAccess,
      trace,
      translateVmPathStrict,
    });

    const resumeArgIndex = findResumeArgIndex(args);
    const currentResumeCliSessionId = resumeArgIndex === -1 ? null : args[resumeArgIndex + 1];
    const sessionDirectory = deriveSessionDirectory(hostConfigDir);
    if (!currentResumeCliSessionId || !sessionDirectory) {
      return {
        success: false,
        error: 'Missing resumable session context for flatline retry',
      };
    }

    const metadataPath = deriveSessionMetadataPath(hostConfigDir);
    const persistedSessionData = readSessionDataFromMetadata(metadataPath, trace);
    const sessionData = persistedSessionData && typeof persistedSessionData === 'object'
      ? persistedSessionData
      : {
        cliSessionId: currentResumeCliSessionId,
        userSelectedFolders: typeof sharedCwdPath === 'string' && path.isAbsolute(sharedCwdPath)
          ? [sharedCwdPath]
          : [],
      };

    const retryPlan = handleFlatlineResumeFailure({
      sessionData,
      sessionDirectory,
    });
    const continuityPlan = buildTranscriptContinuityPlan({
      localSessionId: sessionData.sessionId,
      preferredRoot: Array.isArray(sessionData.userSelectedFolders) && sessionData.userSelectedFolders.length > 0
        ? sessionData.userSelectedFolders.find((folderPath) => typeof folderPath === 'string' && folderPath.trim()) || null
        : null,
      staleCliSessionId: currentResumeCliSessionId,
      transcriptCandidate: retryPlan.transcriptCandidate,
    });
    if (metadataPath) {
      persistSessionDataToMetadata(metadataPath, retryPlan.sessionData, trace);
    }

    return {
      success: true,
      args: removeResumeArgs(args, trace),
      envVars: translatedEnvVars,
      retryPlan,
      continuityPlan,
      retryMode: continuityPlan ? 'continuity' : 'fresh',
      sharedCwdPath,
    };
  }

  persistRecoveredCliSession(context) {
    const {
      cliSessionId,
      envVars,
    } = context || {};
    const {
      canonicalizePathForHostAccess,
      trace = () => {},
      translateVmPathStrict,
    } = this._deps;

    if (typeof cliSessionId !== 'string' || !cliSessionId.trim()) {
      return {
        success: false,
        error: 'Missing recovered cliSessionId',
      };
    }

    const { hostConfigDir } = translateHostConfigDir(envVars, {
      canonicalizePathForHostAccess,
      trace,
      translateVmPathStrict,
    });
    const metadataPath = deriveSessionMetadataPath(hostConfigDir);
    if (!metadataPath) {
      return {
        success: false,
        error: 'Missing session metadata path for recovered cliSessionId',
      };
    }

    const persistedSessionData = readSessionDataFromMetadata(metadataPath, trace) || {};
    const nextSessionData = {
      ...persistedSessionData,
      cliSessionId,
    };
    delete nextSessionData.error;

    const persisted = persistSessionDataToMetadata(metadataPath, nextSessionData, trace);
    return {
      success: persisted,
      cliSessionId,
      metadataPath,
      sessionData: nextSessionData,
      error: persisted ? null : 'Failed to persist recovered cliSessionId',
    };
  }

  _getLocalSessionInfo(metadataPath) {
    if (!metadataPath) {
      return null;
    }

    if (this._sessionStore && typeof this._sessionStore.getSessionInfoByMetadataPath === 'function') {
      return this._sessionStore.getSessionInfoByMetadataPath(metadataPath);
    }

    const sessionData = readSessionDataFromMetadata(metadataPath, this._deps.trace || (() => {}));
    if (!sessionData || typeof sessionData !== 'object') {
      return null;
    }

    return {
      metadataPath,
      sessionData,
    };
  }

  _resolveBridgeSession(context) {
    const {
      hostArgs,
      hostCwdPath,
      localSessionInfo,
      metadataPath,
      trace = () => {},
    } = context || {};

    const sessionData = localSessionInfo && localSessionInfo.sessionData && typeof localSessionInfo.sessionData === 'object'
      ? localSessionInfo.sessionData
      : null;
    if (!sessionData || typeof sessionData.sessionId !== 'string' || !sessionData.sessionId.trim()) {
      return null;
    }

    const persistedRemoteSessionId = typeof sessionData.remoteSessionId === 'string' && sessionData.remoteSessionId.trim()
      ? sessionData.remoteSessionId
      : null;
    const persistedRemoteSessionAccessToken = typeof sessionData.remoteSessionAccessToken === 'string' && sessionData.remoteSessionAccessToken.trim()
      ? sessionData.remoteSessionAccessToken
      : null;
    if (persistedRemoteSessionId && persistedRemoteSessionAccessToken) {
      return {
        localSessionId: sessionData.sessionId,
        remoteSessionId: persistedRemoteSessionId,
        sessionAccessToken: persistedRemoteSessionAccessToken,
        source: 'metadata',
      };
    }

    if (!this._deps.sessionsApi || typeof this._deps.sessionsApi.ensureSession !== 'function') {
      return null;
    }

    const ensureResult = this._deps.sessionsApi.ensureSession({
      cwd: typeof hostCwdPath === 'string' && hostCwdPath.trim() ? hostCwdPath : sessionData.cwd,
      localSessionId: sessionData.sessionId,
      model: findFlagValue(hostArgs, '--model') || sessionData.model || null,
      organizationUuid: deriveOrganizationUuidFromMetadataPath(metadataPath),
      permissionMode: findFlagValue(hostArgs, '--permission-mode') || sessionData.permissionMode || 'default',
      remoteSessionAccessToken: persistedRemoteSessionAccessToken,
      remoteSessionId: persistedRemoteSessionId,
      title: sessionData.title || null,
      userSelectedFolders: Array.isArray(sessionData.userSelectedFolders) ? sessionData.userSelectedFolders : [],
    });
    if (!ensureResult || ensureResult.success !== true) {
      if (ensureResult && ensureResult.skipped) {
        return null;
      }
      trace(
        'WARNING: Failed to resolve remote session for '
          + sessionData.sessionId
          + ': '
          + (ensureResult && ensureResult.error ? ensureResult.error : 'unknown error')
      );
      return null;
    }
    if (
      typeof ensureResult.remoteSessionId !== 'string' ||
      !ensureResult.remoteSessionId.trim() ||
      typeof ensureResult.sessionAccessToken !== 'string' ||
      !ensureResult.sessionAccessToken.trim()
    ) {
      trace('WARNING: Sessions API returned incomplete bridge session identity for ' + sessionData.sessionId);
      return null;
    }

    const identityPatch = {
      remoteSessionAccessToken: ensureResult.sessionAccessToken,
      remoteSessionId: ensureResult.remoteSessionId,
    };
    if (this._sessionStore && typeof this._sessionStore.persistSessionIdentityForMetadataPath === 'function') {
      const persistenceResult = this._sessionStore.persistSessionIdentityForMetadataPath(metadataPath, identityPatch);
      if (!persistenceResult.success) {
        trace('WARNING: Failed to persist remote session identity: ' + persistenceResult.error);
      }
    } else if (metadataPath) {
      const persistedSessionData = readSessionDataFromMetadata(metadataPath, trace) || {};
      persistSessionDataToMetadata(metadataPath, {
        ...persistedSessionData,
        ...identityPatch,
      }, trace);
    }

    return {
      localSessionId: sessionData.sessionId,
      remoteSessionId: ensureResult.remoteSessionId,
      sessionAccessToken: ensureResult.sessionAccessToken,
      source: ensureResult.source || 'created',
    };
  }

  _resolveFileSessionInfo(localSessionId, options) {
    if (!this._sessionStore) {
      return null;
    }

    if (typeof localSessionId === 'string' && localSessionId.trim() && typeof this._sessionStore.getSessionInfo === 'function') {
      const directSessionInfo = this._sessionStore.getSessionInfo(localSessionId);
      if (directSessionInfo && directSessionInfo.sessionData) {
        return {
          authorizedRoots: typeof this._sessionStore.getAuthorizedRoots === 'function'
            ? this._sessionStore.getAuthorizedRoots(localSessionId)
            : [],
          localSessionId,
          sessionInfo: directSessionInfo,
        };
      }
    }

    if ((options && options.allowActiveSessionFallback) && typeof this._sessionStore.getActiveSessionInfo === 'function') {
      const activeSessionInfo = this._sessionStore.getActiveSessionInfo();
      if (activeSessionInfo && activeSessionInfo.sessionData && typeof activeSessionInfo.sessionData.sessionId === 'string') {
        return {
          authorizedRoots: typeof this._sessionStore.getAuthorizedRoots === 'function'
            ? this._sessionStore.getAuthorizedRoots(activeSessionInfo.sessionData.sessionId)
            : [],
          localSessionId: activeSessionInfo.sessionData.sessionId,
          sessionInfo: activeSessionInfo,
        };
      }
    }

    return null;
  }

  dualWriteEvent(remoteSessionId, event) {
    if (!this._deps.sessionsApi || !remoteSessionId) return;
    if (typeof this._deps.sessionsApi.postEvents !== 'function') return;
    try {
      this._deps.sessionsApi.postEvents(remoteSessionId, [event]);
    } catch (e) {
      const trace = this._deps.trace || (() => {});
      trace('WARNING: dual-write failed: ' + e.message);
    }
  }

  classifyStdoutEvent(parsedLine) {
    if (!parsedLine || typeof parsedLine !== 'object') {
      return { action: 'ignore' };
    }

    const sessionId = this._extractSessionId(parsedLine);
    if (sessionId) {
      return { action: 'extract_session_id', sessionId };
    }

    if (this._isFlatlineResult(parsedLine)) {
      return { action: 'flatline_detected' };
    }

    if (this._isSuccessResult(parsedLine)) {
      return { action: 'success' };
    }

    return { action: 'forward' };
  }

  _extractSessionId(parsedLine) {
    const candidates = [
      parsedLine.session_id,
      parsedLine.sessionId,
      parsedLine.cliSessionId,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }
    if (parsedLine.event && typeof parsedLine.event === 'object') {
      const eventCandidates = [parsedLine.event.session_id, parsedLine.event.sessionId];
      for (const candidate of eventCandidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate;
        }
      }
    }
    return null;
  }

  _isFlatlineResult(parsedLine) {
    return parsedLine.type === 'result' &&
      parsedLine.is_error === true &&
      Number(parsedLine.num_turns || 0) === 0;
  }

  _isSuccessResult(parsedLine) {
    return parsedLine.type === 'result' &&
      parsedLine.is_error !== true &&
      (parsedLine.subtype === 'success' || Number(parsedLine.num_turns || 0) > 0);
  }

  buildRetryInput(processState) {
    if (!processState || typeof processState !== 'object') {
      return null;
    }
    const { lastUserMessage, retryCount } = processState;
    if (typeof lastUserMessage !== 'string' || !lastUserMessage.trim()) {
      return null;
    }
    return {
      type: 'user',
      content: lastUserMessage,
      retryAttempt: typeof retryCount === 'number' ? retryCount : 0,
    };
  }
}

function createSessionOrchestrator(deps) {
  return new SessionOrchestrator(deps);
}

module.exports = {
  MountManager,
  SessionOrchestrator,
  createSessionOrchestrator,
  removeResumeArgs,
};
