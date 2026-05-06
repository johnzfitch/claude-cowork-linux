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
const {
  extractCliSessionId,
  isFlatlineResumeResult,
  isSuccessfulResult,
} = require('./stream_protocol.js');

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

function buildBridgeSpawnArgs(args, remoteSessionId, sdkUrl) {
  // Build CLI arguments for bridge session spawns.
  // Removes asar-specific flags and adds bridge-specific flags.
  const preservedArgs = removeFlagArgs(args, [
    '--resume',
    '--print',
    '--session-id',
    '--sdk-url',
    '--input-format',
    '--output-format',
    '--replay-user-messages',
  ]);

  const bridgeArgs = [
    '--print',
    '--session-id',
    remoteSessionId,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--replay-user-messages',
  ];

  if (typeof sdkUrl === 'string' && sdkUrl.trim()) {

    try {
      const parsedSdkUrl = new URL(sdkUrl);
      const ALLOWED_SDK_HOSTS = ['api.anthropic.com'];
      const hostAllowed = ALLOWED_SDK_HOSTS.some(h =>
        parsedSdkUrl.hostname === h || parsedSdkUrl.hostname.endsWith('.' + h)
      );
      if (!hostAllowed) {
        console.warn('[Cowork] Blocked --sdk-url with disallowed host:', parsedSdkUrl.hostname);
      } else if (parsedSdkUrl.protocol !== 'https:') {
        console.warn('[Cowork] Blocked non-HTTPS --sdk-url');
      } else {
        bridgeArgs.push('--sdk-url', sdkUrl);
      }
    } catch (_e) {
      // Don't log sdkUrl verbatim — user-controlled, may contain
      // newlines (log injection) or credentials
      console.warn('[Cowork] Blocked malformed --sdk-url');
    }
  }

  return [...bridgeArgs, ...preservedArgs];
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
// BRIDGE-STATE READER
// ============================================================================
// Reads bridge-state.json written by Claude Desktop's bridge infrastructure.
// There's one dispatch session per environment — all task spawns share it.
// Returns the first remoteSessionId (cse_*) found, regardless of which
// task session is being spawned.

function readRemoteSessionIdFromBridgeState(deps) {
  const {
    bridgeStatePath,
    readFileSync = fs.readFileSync,
    trace = () => {},
  } = deps || {};

  const defaultBridgePath = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'Claude', 'bridge-state.json'
  );
  const filePath = typeof bridgeStatePath === 'string' && bridgeStatePath.trim()
    ? bridgeStatePath
    : defaultBridgePath;

  // Single read attempt — the file is either present or not.
  // Retrying with Atomics.wait blocked the main process ~400ms for the
  // common non-dispatch case where the file simply doesn't exist.
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      trace('[bridge-creds] bridge-state.json: missing (' + filePath + ')');
    } else {
      trace('[bridge-creds] bridge-state.json: read error: ' + err.message);
    }
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    trace('[bridge-creds] bridge-state.json: parse-error: ' + err.message);
    return null;
  }

  // Real schema: dict keyed by "userId:orgId", values are session entries
  const entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.entries(parsed).filter(([, v]) => v && typeof v === 'object')
    : (Array.isArray(parsed) ? parsed.map((v, i) => [String(i), v]) : []);

  if (entries.length > 0) {
    const fieldNames = Object.keys(entries[0][1]).sort();
    trace('[bridge-creds] bridge-state.json schema: entryCount=' + entries.length
      + ', fieldNames=[' + fieldNames.join(',') + ']');
  }

  for (const [key, entry] of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.remoteSessionId === 'string' && entry.remoteSessionId.startsWith('cse_')) {
      trace('[bridge-creds] found remoteSessionId=' + entry.remoteSessionId
        + ' (from key=' + key + ', localSessionId=' + (entry.localSessionId || 'n/a') + ')');
      return entry.remoteSessionId;
    }
  }

  trace('[bridge-creds] bridge-state.json: no cse_* entry found');
  return null;
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
    // Phase 4: Live event dispatch state (per-session maps)
    this._liveAssistantMessageCache = new Map();
    this._liveAssistantStreamState = new Map();
    this._liveSessionCompatibilityState = new Map();
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
      } else if (
      normalizedCommand === 'bash' ||
      commandBasename === 'bash'
    ) {
      const bashCandidates = ['/usr/bin/bash', '/bin/bash'];
      hostCommand = bashCandidates.find((c) => fs.existsSync(c));
      if (!hostCommand) {
        trace('bash requested but not found on host');
        if (typeof onError === 'function') {
          onError(processId, 'bash not found', '');
        }
        return { success: false, error: 'bash not found' };
      }
      trace('Translated bash command: ' + normalizedCommand + ' -> ' + hostCommand);
    } else if (allowedPrefixes.some((prefix) => normalizedCommand.startsWith(prefix))) {
      if (fs.existsSync(normalizedCommand)) {
        hostCommand = normalizedCommand;
        trace('Command is an allowed absolute path: ' + normalizedCommand);
      } else {
        hostCommand = resolveClaudeBinaryPath();
        trace('Allowed absolute path missing, resolved: ' + normalizedCommand + ' -> ' + hostCommand);
      }
    } else {
      trace('Unexpected command blocked: "' + String(command) + '" (type=' + typeof command + ')');
      if (typeof onError === 'function') {
        onError(processId, 'Unexpected command: ' + String(command), '');
      }
      return { success: false, error: 'Unexpected command' };
    }

    // Security check: Ensure resolved command is in allowed directories
    const commandIsAllowed = hostCommand === 'claude' ||
      allowedPrefixes.some((prefix) => hostCommand.startsWith(prefix));
    if (!commandIsAllowed) {
      trace('Command outside allowed directories: ' + hostCommand);
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

    // Symlink global config (skills, commands, etc.) into session .claude dir
    if (typeof hostConfigDir === 'string' && hostConfigDir.trim()) {
      try {
        const resolvedConfigDir = fs.realpathSync(hostConfigDir);
        symlinkGlobalConfig(resolvedConfigDir, trace);
      } catch (e) {
        trace('WARNING: Could not resolve CLAUDE_CONFIG_DIR for global config symlinks: ' + e.message);
      }
    }

    // Step 8: Update sessions API with OAuth token if available
    const spawnOAuthToken = translatedEnvVars.CLAUDE_CODE_OAUTH_TOKEN;
    if (
      spawnOAuthToken && typeof spawnOAuthToken === 'string' && spawnOAuthToken.trim() &&
      this._deps.sessionsApi && typeof this._deps.sessionsApi.updateAuthToken === 'function'
    ) {
      this._deps.sessionsApi.updateAuthToken(spawnOAuthToken);
      trace('Injected spawn-time OAuth token into sessions API');
    }

    // Step 9: Attempt bridge session resolution for dispatch mode.
    // bridge-state.json has one entry per dispatch environment — all task
    // spawns share the same remoteSessionId (cse_*).
    const metadataPath = deriveSessionMetadataPath(hostConfigDir);
    const bridgeSession = this._resolveBridgeSession({
      metadataPath,
      translatedEnvVars,
      trace,
    });
    
    // If bridge session is available, mark dispatch mode but do NOT modify
    // CLI args. The asar has its own bridge transport ([transport:bridge],
    // [transport:sse]) that connects to CCR, receives work items, and
    // relays CLI stdout events back. The CLI just runs normally with
    // --resume and produces output on stdout. The remote session ID
    // (cse_*) is NOT a CLI concept — it's managed by the asar's bridge.
    //
    // The asar already sets USE_CCR_V2, ENVIRONMENT_KIND, etc. in its
    // spawn env vars, so our injection is defense-in-depth only.
    if (bridgeSession) {
      Object.assign(translatedEnvVars, {
        CLAUDE_CODE_ENTRYPOINT: translatedEnvVars.CLAUDE_CODE_ENTRYPOINT || 'claude-desktop',
        CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge',
        CLAUDE_CODE_IS_COWORK: '1',
        CLAUDE_CODE_USE_CCR_V2: '1',
        CLAUDE_CODE_USE_COWORK_PLUGINS: '1',
      });
      trace('[bridge-creds] dispatch detected: remoteSessionId='
        + bridgeSession.remoteSessionId
        + ' (asar bridge transport handles CCR relay, CLI args untouched)');
    }

    // Inject user's local skills as an additional --plugin-dir so Cowork
    // sessions can access skills installed outside the server-provisioned set.
    // Bridge-mode spawns are marked above because the asar does not always set
    // the cowork flags before we prepare the CLI invocation.
    if (translatedEnvVars && translatedEnvVars.CLAUDE_CODE_IS_COWORK) {
      const localSkillsDir = GLOBAL_CLAUDE_DIR + path.sep + 'skills';
      if (fs.existsSync(localSkillsDir)) {
        const alreadyIncluded = hostArgs.some((arg, i) =>
          i > 0 && hostArgs[i - 1] === '--plugin-dir' && arg === localSkillsDir
        );
        if (!alreadyIncluded) {
          hostArgs.push('--plugin-dir', localSkillsDir);
          trace('Injected local skills --plugin-dir: ' + localSkillsDir);
        }
      }
    }

    // Step 10: Resolve working directory for CLI spawn
    const hostCwdPath = resolveHostCwdPath({
      args: hostArgs,
      canonicalizePathForHostAccess,
      configDirPath: hostConfigDir,
      sharedCwdPath,
      trace,
    });

    // Step 11: Check for resume arguments and session metadata
    // Only strip --resume when we have positive evidence the transcript is
    // unresumable (e.g. corrupt/empty file on disk). If no local transcript
    // exists at all, trust the asar's --resume — the CLI may store session
    // state server-side or in a location we don't scan.
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

      if (!resumePlan.shouldResume && resumePlan.reason === 'transcript_not_resumable') {
        hostArgs = removeResumeArgs(hostArgs, trace);
      } else if (resumePlan.shouldResume && resumePlan.resumeCliSessionId) {
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
      bridgeSession: bridgeSession || null,
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
      trace = () => {},
    } = context || {};

    // Read bridge-state.json — find any cse_* remoteSessionId.
    // There's one dispatch session per environment; all task spawns share it.
    const remoteSessionId = readRemoteSessionIdFromBridgeState({
      bridgeStatePath: this._deps.bridgeStatePath || null,
      readFileSync: this._deps.readFileSync || undefined,
      trace,
      waitMs: this._deps.bridgeStateRetryDelayMs || undefined,
    });

    if (!remoteSessionId) {
      trace('[bridge-creds] skipped: no bridge-state entry (degrading to non-bridge spawn)');
      return null;
    }

    // Don't call /bridge ourselves — the CLI's initEnvLessBridgeCore handles
    // its own OAuth token exchange and bridge credential fetching internally.
    // We just need to tell the CLI which session to use and that it should
    // activate the CCR v2 transport.
    return {
      remoteSessionId,
      source: 'bridge_state',
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

    const sessionId = extractCliSessionId(parsedLine);
    if (sessionId) {
      return { action: 'extract_session_id', sessionId };
    }

    if (isFlatlineResumeResult(parsedLine)) {
      return { action: 'flatline_detected' };
    }

    if (isSuccessfulResult(parsedLine)) {
      return { action: 'success' };
    }

    return { action: 'forward' };
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

  // --- Phase 2: Session record normalization ---
  // Public API — delegates to sessionStore which owns the implementation.
  // Callers should use this instead of sessionStore.normalizeSessionRecord() directly.
  normalizeSessionRecord(sessionData) {
    if (!this._sessionStore || typeof this._sessionStore.normalizeSessionRecord !== 'function') {
      return sessionData;
    }
    return this._sessionStore.normalizeSessionRecord(sessionData);
  }

  // --- Phase 4: Live event dispatch normalization ---

  _isLocalSessionEventChannel(channel) {
    return typeof channel === 'string' && (
      channel.includes('LocalAgentModeSessions_$_onEvent') ||
      channel.includes('LocalSessions_$_onEvent')
    );
  }

  _getLocalSessionEventSessionId(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    if (typeof payload.sessionId === 'string') {
      return payload.sessionId;
    }
    if (typeof payload.session_id === 'string') {
      return payload.session_id;
    }
    if (payload.message && typeof payload.message === 'object') {
      if (typeof payload.message.sessionId === 'string') {
        return payload.message.sessionId;
      }
      if (typeof payload.message.session_id === 'string') {
        return payload.message.session_id;
      }
    }
    return null;
  }

  _getOrCreateCompatibilityState(sessionId) {
    if (!this._liveSessionCompatibilityState.has(sessionId)) {
      this._liveSessionCompatibilityState.set(sessionId, {
        queueOperations: [],
        queueSize: null,
        progress: null,
        lastPrompt: null,
        updatedAt: 0,
      });
    }
    return this._liveSessionCompatibilityState.get(sessionId);
  }

  _cloneCompatibilityState(sessionId) {
    const state = this._liveSessionCompatibilityState.get(sessionId);
    if (!state) {
      return null;
    }
    return {
      queueOperations: cloneSerializable(state.queueOperations),
      queueSize: state.queueSize,
      progress: cloneSerializable(state.progress),
      lastPrompt: cloneSerializable(state.lastPrompt),
      updatedAt: state.updatedAt,
    };
  }

  _mergeQueueOperationState(state, queuePayload) {
    if (!state || !queuePayload || typeof queuePayload !== 'object') {
      return false;
    }

    const rawPayload = cloneSerializable(queuePayload);
    if (Array.isArray(rawPayload.operations)) {
      state.queueOperations = rawPayload.operations.map((entry) => cloneSerializable(entry));
      state.queueSize = state.queueOperations.length;
      return true;
    }

    const extractId = (v) => {
      if (!v || typeof v !== 'object') return null;
      const c = v.id ?? v.operation_id ?? v.request_id ?? v.uuid ?? v.name ?? null;
      return typeof c === 'string' || typeof c === 'number' ? String(c) : null;
    };

    const operation = rawPayload.operation && typeof rawPayload.operation === 'object'
      ? cloneSerializable(rawPayload.operation)
      : rawPayload;
    const operationId = extractId(operation);
    const action = String(operation.action ?? operation.subtype ?? operation.operation ?? '').toLowerCase();
    if (action.includes('remove') || action.includes('dequeue') || action.includes('complete') || action.includes('finish')) {
      if (operationId) {
        state.queueOperations = state.queueOperations.filter((entry) => extractId(entry) !== operationId);
      } else if (state.queueOperations.length > 0) {
        state.queueOperations = state.queueOperations.slice(1);
      }
    } else if (operationId) {
      const existingIndex = state.queueOperations.findIndex((entry) => extractId(entry) === operationId);
      if (existingIndex >= 0) {
        state.queueOperations[existingIndex] = operation;
      } else {
        state.queueOperations.push(operation);
      }
    } else {
      state.queueOperations.push(operation);
    }

    const queueSize = rawPayload.queue_size ?? rawPayload.size ?? rawPayload.pending ?? null;
    state.queueSize = typeof queueSize === 'number' ? queueSize : state.queueOperations.length;
    return true;
  }

  _applyMetadataMessage(sessionId, sdkMessage) {
    if (typeof sessionId !== 'string' || !sdkMessage || typeof sdkMessage !== 'object') {
      return false;
    }

    const messageType = sdkMessage.type;
    if (!LIVE_EVENT_METADATA_TYPES.has(messageType)) {
      return false;
    }

    const state = this._getOrCreateCompatibilityState(sessionId);
    let updated = false;

    if (messageType === 'queue-operation') {
      updated = this._mergeQueueOperationState(state, sdkMessage);
    } else if (messageType === 'progress') {
      state.progress = {
        current: typeof sdkMessage.current === 'number' ? sdkMessage.current : (typeof sdkMessage.completed === 'number' ? sdkMessage.completed : null),
        total: typeof sdkMessage.total === 'number' ? sdkMessage.total : (typeof sdkMessage.max === 'number' ? sdkMessage.max : null),
        phase: typeof sdkMessage.phase === 'string' ? sdkMessage.phase : (typeof sdkMessage.status === 'string' ? sdkMessage.status : null),
        raw: cloneSerializable(sdkMessage),
      };
      updated = true;
    } else if (messageType === 'last-prompt') {
      const promptValue = sdkMessage.prompt ?? sdkMessage.last_prompt ?? sdkMessage.text ?? sdkMessage.value ?? sdkMessage.message ?? null;
      state.lastPrompt = {
        text: typeof promptValue === 'string' ? promptValue : null,
        raw: cloneSerializable(sdkMessage),
      };
      updated = true;
    }

    if (updated) {
      state.updatedAt = Date.now();
    }
    return updated;
  }

  _finalizeCompatibilityState(sessionId) {
    const state = this._liveSessionCompatibilityState.get(sessionId);
    if (!state) {
      return;
    }
    if (state.progress && typeof state.progress === 'object' && !state.progress.phase) {
      state.progress = { ...state.progress, phase: 'completed' };
    }
    state.queueOperations = [];
    state.queueSize = 0;
    state.updatedAt = Date.now();
  }

  _attachCompatibilityState(sessionId, payload) {
    const compatibilityState = this._cloneCompatibilityState(sessionId);
    if (!compatibilityState || !payload || typeof payload !== 'object') {
      return payload;
    }
    return { ...payload, coworkCompatibilityState: compatibilityState };
  }

  _clearLiveSessionState(sessionId) {
    this._liveAssistantMessageCache.delete(sessionId);
    this._liveAssistantStreamState.delete(sessionId);
    this._liveSessionCompatibilityState.delete(sessionId);
  }

  _buildSyntheticAssistantFromStreamEvent(sessionId, streamMessage) {
    if (!streamMessage || typeof streamMessage !== 'object' || streamMessage.type !== 'stream_event') {
      return null;
    }

    const streamEvent = streamMessage.event;
    if (!streamEvent || typeof streamEvent !== 'object') {
      return null;
    }

    let currentAssistantMessage = this._liveAssistantStreamState.get(sessionId) || null;

    if (streamEvent.type === 'message_start') {
      const startingMessage = streamEvent.message;
      if (!startingMessage || startingMessage.role !== 'assistant') {
        return null;
      }

      currentAssistantMessage = {
        type: 'assistant',
        uuid: streamMessage.uuid || null,
        session_id: streamMessage.session_id || null,
        parent_tool_use_id: streamMessage.parent_tool_use_id ?? null,
        message: {
          ...startingMessage,
          content: cloneMessageContent(startingMessage.content),
        },
      };
      this._liveAssistantStreamState.set(sessionId, currentAssistantMessage);
      return cloneAssistantSdkMessage(currentAssistantMessage);
    }

    if (!isAssistantSdkMessage(currentAssistantMessage)) {
      return null;
    }

    currentAssistantMessage = {
      ...currentAssistantMessage,
      uuid: currentAssistantMessage.uuid || streamMessage.uuid || null,
      session_id: currentAssistantMessage.session_id || streamMessage.session_id || null,
      parent_tool_use_id: currentAssistantMessage.parent_tool_use_id ?? streamMessage.parent_tool_use_id ?? null,
      message: {
        ...currentAssistantMessage.message,
        content: cloneMessageContent(currentAssistantMessage.message.content),
      },
    };

    const currentContent = currentAssistantMessage.message.content;

    if (streamEvent.type === 'content_block_start') {
      currentContent[streamEvent.index] = streamEvent.content_block && typeof streamEvent.content_block === 'object'
        ? { ...streamEvent.content_block }
        : streamEvent.content_block;
    } else if (streamEvent.type === 'content_block_delta') {
      const currentBlock = currentContent[streamEvent.index];
      if (!currentBlock || typeof currentBlock !== 'object') {
        return null;
      }

      if (streamEvent.delta && streamEvent.delta.type === 'text_delta' && currentBlock.type === 'text') {
        currentContent[streamEvent.index] = {
          ...currentBlock,
          text: mergeStreamingText(currentBlock.text, streamEvent.delta.text),
        };
      } else if (streamEvent.delta && streamEvent.delta.type === 'thinking_delta' && currentBlock.type === 'thinking') {
        currentContent[streamEvent.index] = {
          ...currentBlock,
          thinking: mergeStreamingText(currentBlock.thinking, streamEvent.delta.thinking),
        };
      } else if (streamEvent.delta && streamEvent.delta.type === 'signature_delta' && currentBlock.type === 'thinking') {
        currentContent[streamEvent.index] = {
          ...currentBlock,
          signature: streamEvent.delta.signature || currentBlock.signature || '',
        };
      } else if (streamEvent.delta && streamEvent.delta.type === 'input_json_delta' && currentBlock.type === 'tool_use') {
        const partialJson = mergeStreamingText(currentBlock.__coworkPartialJson, streamEvent.delta.partial_json);
        let parsedInput;
        try { parsedInput = JSON.parse(partialJson); } catch (_) { parsedInput = undefined; }
        currentContent[streamEvent.index] = {
          ...currentBlock,
          __coworkPartialJson: partialJson,
          ...(parsedInput !== undefined ? { input: parsedInput } : {}),
        };
      } else if (streamEvent.delta && streamEvent.delta.type === 'citations_delta' && currentBlock.type === 'text') {
        currentContent[streamEvent.index] = {
          ...currentBlock,
          citations: [
            ...(Array.isArray(currentBlock.citations) ? currentBlock.citations : []),
            streamEvent.delta.citation,
          ],
        };
      }
    } else if (streamEvent.type === 'message_delta') {
      currentAssistantMessage.message = {
        ...currentAssistantMessage.message,
        stop_reason: streamEvent.delta ? streamEvent.delta.stop_reason : currentAssistantMessage.message.stop_reason,
        stop_sequence: streamEvent.delta ? streamEvent.delta.stop_sequence : currentAssistantMessage.message.stop_sequence,
        context_management: streamEvent.context_management ?? currentAssistantMessage.message.context_management,
        usage: {
          ...(currentAssistantMessage.message.usage || {}),
          ...(streamEvent.usage || {}),
        },
      };
    } else if (streamEvent.type !== 'content_block_stop' && streamEvent.type !== 'message_stop') {
      return null;
    }

    this._liveAssistantStreamState.set(sessionId, currentAssistantMessage);
    return cloneAssistantSdkMessage(currentAssistantMessage);
  }

  // Public API: normalize a live event payload before dispatching to renderer.
  // Returns an array of payloads (0 = drop, 1 = pass through, 2 = stream_event → synthetic assistant + original).
  normalizeLiveEvent(channel, payload) {
    if (!this._isLocalSessionEventChannel(channel) || !payload || typeof payload !== 'object') {
      return [payload];
    }

    const sessionId = this._getLocalSessionEventSessionId(payload);
    if (!sessionId) {
      return [payload];
    }

    if (payload.type === 'start' || payload.type === 'close' || payload.type === 'stopped' || payload.type === 'deleted') {
      this._clearLiveSessionState(sessionId);
      return [payload];
    }

    if (LIVE_EVENT_METADATA_TYPES.has(payload.type)) {
      this._applyMetadataMessage(sessionId, payload);
      return [];
    }

    if (payload.type === 'transcript_loaded' && Array.isArray(payload.messages)) {
      const normalizedMessages = [];
      for (const message of payload.messages) {
        if (message && typeof message === 'object' && LIVE_EVENT_METADATA_TYPES.has(message.type)) {
          this._applyMetadataMessage(sessionId, message);
          continue;
        }
        if (message && typeof message === 'object' && LIVE_EVENT_IGNORED_TYPES.has(message.type)) {
          continue;
        }
        normalizedMessages.push(message);
      }
      return [this._attachCompatibilityState(sessionId, {
        ...payload,
        messages: mergeConsecutiveAssistantMessages(normalizedMessages),
      })];
    }

    if (payload.type !== 'message' || !payload.message || typeof payload.message !== 'object') {
      return [this._attachCompatibilityState(sessionId, payload)];
    }

    if (LIVE_EVENT_METADATA_TYPES.has(payload.message.type)) {
      this._applyMetadataMessage(sessionId, payload.message);
      return [];
    }

    if (payload.message.type === 'result') {
      this._liveAssistantStreamState.delete(sessionId);
      this._finalizeCompatibilityState(sessionId);
      return [this._attachCompatibilityState(sessionId, payload)];
    }

    if (payload.message.type === 'stream_event') {
      const syntheticAssistantMessage = this._buildSyntheticAssistantFromStreamEvent(sessionId, payload.message);
      if (!syntheticAssistantMessage) {
        return [this._attachCompatibilityState(sessionId, payload)];
      }

      const previousMessage = this._liveAssistantMessageCache.get(sessionId);
      const mergedAssistantMessage = mergeAssistantSdkMessages(previousMessage, syntheticAssistantMessage) || syntheticAssistantMessage;
      this._liveAssistantMessageCache.set(sessionId, mergedAssistantMessage);

      return [
        this._attachCompatibilityState(sessionId, payload),
        this._attachCompatibilityState(sessionId, {
          ...payload,
          message: mergedAssistantMessage,
        }),
      ];
    }

    if (!isAssistantSdkMessage(payload.message)) {
      return [this._attachCompatibilityState(sessionId, payload)];
    }

    const previousMessage = this._liveAssistantMessageCache.get(sessionId);
    if (previousMessage) {
      const mergedAssistantMessage = mergeAssistantSdkMessages(previousMessage, payload.message);
      if (mergedAssistantMessage) {
        this._liveAssistantMessageCache.set(sessionId, mergedAssistantMessage);
        return [this._attachCompatibilityState(sessionId, {
          ...payload,
          message: mergedAssistantMessage,
        })];
      }
    }

    this._liveAssistantMessageCache.set(sessionId, payload.message);
    return [this._attachCompatibilityState(sessionId, payload)];
  }
}

// Phase 1: Message type filtering — constants and functions live in
// session_normalization.js (leaf module with zero project imports).
const {
  LIVE_EVENT_IGNORED_TYPES,
  LIVE_EVENT_METADATA_TYPES,
  TRANSCRIPT_IGNORED_TYPES,
  SDK_STDOUT_IGNORED_TYPES,
  isIgnoredLiveEventType,
  filterTranscriptMessages,
  getIgnoredSdkMessageType,
} = require('./session_normalization.js');

// =============================================================================
// PHASE 3: Consolidated SDK Message Transformation (NORM-102)
// =============================================================================

function cloneSerializable(value) {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

function isAssistantSdkMessage(message) {
  return !!(
    message &&
    typeof message === 'object' &&
    message.type === 'assistant' &&
    message.message &&
    typeof message.message === 'object' &&
    message.message.type === 'message' &&
    message.message.role === 'assistant' &&
    Array.isArray(message.message.content)
  );
}

function cloneMessageContent(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block) => {
    if (!block || typeof block !== 'object') {
      return block;
    }
    const clonedBlock = { ...block };
    delete clonedBlock.__coworkPartialJson;
    return clonedBlock;
  });
}

function cloneAssistantSdkMessage(message) {
  if (!isAssistantSdkMessage(message)) {
    return null;
  }
  return {
    ...message,
    message: {
      ...message.message,
      content: cloneMessageContent(message.message.content),
    },
  };
}

function mergeStreamingText(previousValue, nextValue) {
  if (typeof previousValue !== 'string' || !previousValue) {
    return typeof nextValue === 'string' ? nextValue : previousValue;
  }
  if (typeof nextValue !== 'string' || !nextValue) {
    return previousValue;
  }
  if (nextValue.startsWith(previousValue)) {
    return nextValue;
  }
  if (previousValue.startsWith(nextValue) || previousValue.endsWith(nextValue)) {
    return previousValue;
  }
  return previousValue + nextValue;
}

function findMergeableAssistantBlockIndex(previousBlocks, nextBlock, fallbackIndex) {
  if (!Array.isArray(previousBlocks) || !nextBlock || typeof nextBlock !== 'object') {
    return -1;
  }

  if (nextBlock.id) {
    const byIdIndex = previousBlocks.findIndex((block) => block && typeof block === 'object' && block.id === nextBlock.id);
    if (byIdIndex !== -1) {
      return byIdIndex;
    }
  }

  const fallbackBlock = previousBlocks[fallbackIndex];
  if (fallbackBlock && typeof fallbackBlock === 'object' && fallbackBlock.type === nextBlock.type) {
    return fallbackIndex;
  }

  return -1;
}

function mergeAssistantContentBlock(previousBlock, nextBlock) {
  if (!previousBlock || typeof previousBlock !== 'object') {
    return nextBlock && typeof nextBlock === 'object' ? { ...nextBlock } : nextBlock;
  }
  if (!nextBlock || typeof nextBlock !== 'object') {
    return { ...previousBlock };
  }
  if (previousBlock.type !== nextBlock.type) {
    return { ...nextBlock };
  }

  const mergedBlock = {
    ...previousBlock,
    ...nextBlock,
  };

  if (mergedBlock.type === 'text') {
    mergedBlock.text = mergeStreamingText(previousBlock.text, nextBlock.text);
    if (Array.isArray(previousBlock.citations) || Array.isArray(nextBlock.citations)) {
      mergedBlock.citations = [
        ...(Array.isArray(previousBlock.citations) ? previousBlock.citations : []),
        ...(Array.isArray(nextBlock.citations) ? nextBlock.citations : []),
      ];
    }
  } else if (mergedBlock.type === 'thinking') {
    mergedBlock.thinking = mergeStreamingText(previousBlock.thinking, nextBlock.thinking);
    mergedBlock.signature = nextBlock.signature || previousBlock.signature || '';
  } else if (mergedBlock.type === 'tool_use') {
    if (previousBlock.input && nextBlock.input && typeof previousBlock.input === 'object' && typeof nextBlock.input === 'object') {
      mergedBlock.input = {
        ...previousBlock.input,
        ...nextBlock.input,
      };
    } else if (nextBlock.input === undefined) {
      mergedBlock.input = previousBlock.input;
    }
  } else if (mergedBlock.type === 'tool_result') {
    if (Array.isArray(previousBlock.content) || Array.isArray(nextBlock.content)) {
      mergedBlock.content = [
        ...(Array.isArray(previousBlock.content) ? previousBlock.content : []),
        ...(Array.isArray(nextBlock.content) ? nextBlock.content : []),
      ];
    }
  }

  if ('__coworkPartialJson' in previousBlock || '__coworkPartialJson' in nextBlock) {
    mergedBlock.__coworkPartialJson = mergeStreamingText(previousBlock.__coworkPartialJson, nextBlock.__coworkPartialJson);
  }

  return mergedBlock;
}

function mergeAssistantContent(previousContent, nextContent) {
  const mergedContent = cloneMessageContent(previousContent);
  const normalizedNextContent = cloneMessageContent(nextContent);

  for (let index = 0; index < normalizedNextContent.length; index += 1) {
    const nextBlock = normalizedNextContent[index];
    if (!nextBlock || typeof nextBlock !== 'object') {
      mergedContent.push(nextBlock);
      continue;
    }

    const targetIndex = findMergeableAssistantBlockIndex(mergedContent, nextBlock, index);
    if (targetIndex === -1) {
      mergedContent.push({ ...nextBlock });
      continue;
    }

    mergedContent[targetIndex] = mergeAssistantContentBlock(mergedContent[targetIndex], nextBlock);
  }

  return mergedContent;
}

function mergeAssistantSdkMessages(previousMessage, nextMessage) {
  if (!isAssistantSdkMessage(previousMessage) || !isAssistantSdkMessage(nextMessage)) {
    return null;
  }

  const previousId = previousMessage.message && previousMessage.message.id;
  const nextId = nextMessage.message && nextMessage.message.id;
  if (!previousId || !nextId || previousId !== nextId) {
    return null;
  }

  return {
    ...previousMessage,
    ...nextMessage,
    uuid: previousMessage.uuid || nextMessage.uuid,
    session_id: previousMessage.session_id || nextMessage.session_id,
    parent_tool_use_id: previousMessage.parent_tool_use_id ?? nextMessage.parent_tool_use_id ?? null,
    message: {
      ...previousMessage.message,
      ...nextMessage.message,
      content: mergeAssistantContent(previousMessage.message.content, nextMessage.message.content),
    },
  };
}

function mergeConsecutiveAssistantMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const mergedMessages = [];
  for (const message of messages) {
    const previousMessage = mergedMessages[mergedMessages.length - 1];
    const mergedAssistantMessage = mergeAssistantSdkMessages(previousMessage, message);
    if (mergedAssistantMessage) {
      mergedMessages[mergedMessages.length - 1] = mergedAssistantMessage;
      continue;
    }
    mergedMessages.push(message);
  }
  return mergedMessages;
}

function getSdkMessageSessionId(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  if (typeof message.sessionId === 'string') {
    return message.sessionId;
  }
  if (typeof message.session_id === 'string') {
    return message.session_id;
  }
  if (message.message && typeof message.message === 'object') {
    if (typeof message.message.sessionId === 'string') {
      return message.message.sessionId;
    }
    if (typeof message.message.session_id === 'string') {
      return message.message.session_id;
    }
  }
  return null;
}

function inferLocalSessionIdFromMessages(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (const message of messages) {
    const sessionId = getSdkMessageSessionId(message);
    if (typeof sessionId === 'string' && sessionId.startsWith('local_')) {
      return sessionId;
    }
  }
  return null;
}

function transformSdkMessages(messages, sessionIdOverride) {
  if (!Array.isArray(messages)) {
    return messages;
  }

  const sessionId = typeof sessionIdOverride === 'string' && sessionIdOverride.startsWith('local_')
    ? sessionIdOverride
    : inferLocalSessionIdFromMessages(messages);
  const normalizedMessages = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    if (LIVE_EVENT_METADATA_TYPES.has(message.type)) {
      continue;
    }
    if (LIVE_EVENT_IGNORED_TYPES.has(message.type)) {
      continue;
    }

    if (message.type === 'message' && message.message && typeof message.message === 'object') {
      if (LIVE_EVENT_METADATA_TYPES.has(message.message.type)) {
        continue;
      }
      if (LIVE_EVENT_IGNORED_TYPES.has(message.message.type)) {
        continue;
      }
    }

    normalizedMessages.push(message);
  }

  return mergeConsecutiveAssistantMessages(normalizedMessages);
}

// Global Claude Code config directory (skills, commands, settings, etc.)
const GLOBAL_CLAUDE_DIR = path.join(os.homedir(), '.claude');

/**
 * Symlink global Claude Code config into a session's CLAUDE_CONFIG_DIR.
 *
 * The CLI uses CLAUDE_CONFIG_DIR as its config root, which points to the
 * per-session .claude dir. Without these symlinks, the CLI can't find
 * the user's global skills, commands, settings, hooks, or CLAUDE.md.
 *
 * Only read-mostly global config is symlinked. Session-specific dirs
 * (projects, plans, session-env, backups, shell-snapshots) are left alone
 * so transcript storage and session isolation work correctly.
 *
 * @param {string} sessionClaudeDir - Resolved host path to session .claude dir
 * @param {function} [trace] - Logging function
 */
function symlinkGlobalConfig(sessionClaudeDir, trace = () => {}) {
  if (!fs.existsSync(GLOBAL_CLAUDE_DIR)) {
    trace('No global .claude dir found, skipping config symlinks');
    return;
  }

  const GLOBAL_DIRS = ['commands', 'skills', 'agents', 'hooks', 'plugins'];
  const GLOBAL_FILES = ['CLAUDE.md', 'settings.json', 'settings.local.json'];

  trace('=== SYMLINK GLOBAL CONFIG ===');
  trace('Global: ' + GLOBAL_CLAUDE_DIR);
  trace('Session: ' + sessionClaudeDir);

  for (const name of [...GLOBAL_DIRS, ...GLOBAL_FILES]) {
    const globalPath = path.join(GLOBAL_CLAUDE_DIR, name);
    const sessionPath = path.join(sessionClaudeDir, name);

    if (!fs.existsSync(globalPath)) {
      continue;
    }

    try {
      const stat = fs.lstatSync(sessionPath);
      if (stat.isSymbolicLink() && fs.readlinkSync(sessionPath) === globalPath) {
        continue;
      }
      trace('  SKIP ' + name + ': session already has its own copy');
      continue;
    } catch (_) {
      // lstatSync throws if path doesn't exist -- create the symlink
    }

    try {
      fs.symlinkSync(globalPath, sessionPath);
      trace('  LINKED ' + name + ' -> ' + globalPath);
    } catch (e) {
      trace('  ERROR linking ' + name + ': ' + e.message);
    }
  }

  trace('=== END GLOBAL CONFIG ===');
}

function createSessionOrchestrator(deps) {
  const orchestrator = new SessionOrchestrator(deps);
  // Expose for patchEventDispatch in frame-fix-wrapper.js (bootstraps before
  // the orchestrator exists, upgrades to full normalization once available).
  global.__coworkSessionOrchestrator = orchestrator;
  return orchestrator;
}

module.exports = {
  MountManager,
  SessionOrchestrator,
  createSessionOrchestrator,
  removeResumeArgs,
  symlinkGlobalConfig,
  // Bridge credential helpers
  readRemoteSessionIdFromBridgeState,
  // Bridge spawn args (exported for testing)
  buildBridgeSpawnArgs,
  // Phase 1: Message type filtering
  LIVE_EVENT_IGNORED_TYPES,
  LIVE_EVENT_METADATA_TYPES,
  TRANSCRIPT_IGNORED_TYPES,
  SDK_STDOUT_IGNORED_TYPES,
  isIgnoredLiveEventType,
  filterTranscriptMessages,
  getIgnoredSdkMessageType,
  // Phase 3: SDK message transformation
  transformSdkMessages,
  mergeConsecutiveAssistantMessages,
  mergeAssistantSdkMessages,
  isAssistantSdkMessage,
  cloneAssistantSdkMessage,
  cloneSerializable,
};
