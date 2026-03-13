// Inject frame fix and Cowork support before main app loads
const Module = require('module');
const originalRequire = Module.prototype.require;
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');

console.log('[Frame Fix] Wrapper v2.6 loaded');

function ensureDisclaimerHelperShim() {
  if (process.platform !== 'linux') {
    return;
  }

  const helperPath = path.join(path.dirname(process.resourcesPath), 'Helpers', 'disclaimer');
  const helperScript = [
    '#!/usr/bin/env bash',
    'if [ "$#" -eq 0 ]; then',
    '  echo "disclaimer shim: missing target command" >&2',
    '  exit 64',
    'fi',
    'exec "$@"',
    ''
  ].join('\n');

  try {
    fs.mkdirSync(path.dirname(helperPath), { recursive: true, mode: 0o755 });
    let shouldWrite = true;

    try {
      const existing = fs.readFileSync(helperPath, 'utf8');
      if (existing === helperScript) {
        shouldWrite = false;
      }
    } catch (_) {}

    if (shouldWrite) {
      fs.writeFileSync(helperPath, helperScript, { mode: 0o755 });
    }
    fs.chmodSync(helperPath, 0o755);
    console.log('[Frame Fix] disclaimer helper ready at ' + helperPath);
  } catch (e) {
    console.error('[Frame Fix] Failed to provision disclaimer helper:', e.message);
  }
}

ensureDisclaimerHelperShim();

function getDisclaimerHelperPath() {
  return path.join(path.dirname(process.resourcesPath), 'Helpers', 'disclaimer');
}

function resolveHostClaudeBinary() {
  if (process.env.CLAUDE_CODE_PATH && fs.existsSync(process.env.CLAUDE_CODE_PATH)) {
    return process.env.CLAUDE_CODE_PATH;
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/bin/claude'),
    path.join(home, '.npm-global/bin/claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    '/home/linuxbrew/.linuxbrew/bin/claude',
    path.join(home, '.linuxbrew/bin/claude'),
    path.join(home, '.local/share/mise/shims/claude'),
    path.join(home, '.asdf/shims/claude'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {}
  }

  return 'claude';
}

function registerLinuxClaudeProtocolHandler() {
  if (process.platform !== 'linux') {
    return false;
  }

  const home = os.homedir();
  const desktopDir = path.join(os.homedir(), '.local', 'share', 'applications');
  const desktopFile = path.join(desktopDir, 'claude.desktop');
  const launcherCandidates = [
    process.env.CLAUDE_DESKTOP_LAUNCHER,
    path.join(home, '.local', 'bin', 'claude-desktop'),
    path.join(process.cwd(), 'launch.sh'),
    process.execPath,
  ].filter(candidate => typeof candidate === 'string' && candidate.length > 0);
  const execPath = launcherCandidates.find(candidate => {
    try {
      return fs.existsSync(candidate);
    } catch (_) {
      return false;
    }
  }) || process.execPath;
  const desktopEntry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Claude',
    'Comment=AI assistant by Anthropic',
    'Exec=' + execPath + ' %U',
    'Icon=claude',
    'Terminal=false',
    'Categories=Utility;Development;Chat;',
    'Keywords=AI;assistant;chat;anthropic;',
    'StartupWMClass=Claude',
    'MimeType=x-scheme-handler/claude;',
    '',
  ].join('\n');

  try {
    fs.mkdirSync(desktopDir, { recursive: true, mode: 0o755 });
    let shouldWrite = true;
    try {
      if (fs.readFileSync(desktopFile, 'utf8') === desktopEntry) {
        shouldWrite = false;
      }
    } catch (_) {}

    if (shouldWrite) {
      fs.writeFileSync(desktopFile, desktopEntry, { mode: 0o644 });
    }

    try {
      execFileSync('xdg-mime', ['default', 'claude.desktop', 'x-scheme-handler/claude'], { stdio: 'ignore' });
    } catch (_) {}
    try {
      execFileSync('update-desktop-database', [desktopDir], { stdio: 'ignore' });
    } catch (_) {}

    console.log('[Frame Fix] Registered claude:// handler using ' + execPath);
    return true;
  } catch (error) {
    console.error('[Frame Fix] Failed to register claude:// handler:', error.message);
    return false;
  }
}

function isMachOBinary(binaryPath) {
  try {
    const header = fs.readFileSync(binaryPath);
    if (header.length < 4) {
      return false;
    }
    const magicBE = header.readUInt32BE(0);
    const magicLE = header.readUInt32LE(0);
    return magicBE === 0xfeedface ||
      magicBE === 0xfeedfacf ||
      magicBE === 0xcafebabe ||
      magicLE === 0xfeedface ||
      magicLE === 0xfeedfacf ||
      magicLE === 0xcafebabe;
  } catch (_) {
    return false;
  }
}

function rewriteClaudeCodeInvocation(command, args) {
  if (process.platform !== 'linux' || typeof command !== 'string') {
    return null;
  }

  const normalized = path.resolve(command);
  const home = os.homedir();
  const desktopCcdRoot = path.join(home, '.config', 'Claude', 'claude-code') + path.sep;
  if (!normalized.startsWith(desktopCcdRoot)) {
    return null;
  }
  if (path.basename(normalized) !== 'claude') {
    return null;
  }
  if (!isMachOBinary(normalized)) {
    return null;
  }

  return {
    command: resolveHostClaudeBinary(),
    args: Array.isArray(args) ? args : [],
    originalCommand: normalized,
  };
}

function rewriteDisclaimerInvocation(command, args) {
  if (typeof command !== 'string') {
    return null;
  }
  if (path.resolve(command) !== path.resolve(getDisclaimerHelperPath())) {
    return null;
  }
  if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== 'string' || args[0].length === 0) {
    return null;
  }
  return {
    command: args[0],
    args: args.slice(1),
  };
}

function normalizeIpcPathArgument(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = normalizeIpcPathArgument(entry);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  const candidateKeys = ['folderPath', 'filePath', 'path'];
  for (const key of candidateKeys) {
    if (typeof value[key] === 'string') {
      const trimmed = value[key].trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  const listKeys = ['filePaths', 'paths'];
  for (const key of listKeys) {
    if (Array.isArray(value[key])) {
      const normalized = normalizeIpcPathArgument(value[key]);
      if (normalized) {
        return normalized;
      }
    }
  }

  return null;
}

function patchDisclaimerSpawn() {
  if (global.__coworkDisclaimerSpawnPatched) {
    return;
  }
  global.__coworkDisclaimerSpawnPatched = true;

  try {
    const childProcess = require('child_process');
    const originalSpawn = childProcess.spawn;
    const originalSpawnSync = childProcess.spawnSync;
    const originalExecFile = childProcess.execFile;
    const originalExecFileSync = childProcess.execFileSync;

    childProcess.spawn = function(command, args, options) {
      const rewritten = rewriteDisclaimerInvocation(command, args);
      const finalRewrite = rewriteClaudeCodeInvocation(
        rewritten ? rewritten.command : command,
        rewritten ? rewritten.args : args
      );
      if (rewritten) {
        console.log('[Frame Fix] Rewriting disclaimer spawn to ' + rewritten.command);
      }
      if (finalRewrite) {
        console.log('[Frame Fix] Rewriting Claude Code spawn from ' + finalRewrite.originalCommand + ' to ' + finalRewrite.command);
        return originalSpawn.call(this, finalRewrite.command, finalRewrite.args, options);
      }
      if (rewritten) {
        return originalSpawn.call(this, rewritten.command, rewritten.args, options);
      }
      return originalSpawn.call(this, command, args, options);
    };

    childProcess.spawnSync = function(command, args, options) {
      const rewritten = rewriteDisclaimerInvocation(command, args);
      const finalRewrite = rewriteClaudeCodeInvocation(
        rewritten ? rewritten.command : command,
        rewritten ? rewritten.args : args
      );
      if (rewritten) {
        console.log('[Frame Fix] Rewriting disclaimer spawnSync to ' + rewritten.command);
      }
      if (finalRewrite) {
        console.log('[Frame Fix] Rewriting Claude Code spawnSync from ' + finalRewrite.originalCommand + ' to ' + finalRewrite.command);
        return originalSpawnSync.call(this, finalRewrite.command, finalRewrite.args, options);
      }
      if (rewritten) {
        return originalSpawnSync.call(this, rewritten.command, rewritten.args, options);
      }
      return originalSpawnSync.call(this, command, args, options);
    };

    childProcess.execFile = function(command, args, options, callback) {
      let actualArgs = args;
      let actualOptions = options;
      let actualCallback = callback;

      if (typeof actualArgs === 'function') {
        actualCallback = actualArgs;
        actualArgs = undefined;
        actualOptions = undefined;
      } else if (!Array.isArray(actualArgs)) {
        actualCallback = actualOptions;
        actualOptions = actualArgs;
        actualArgs = undefined;
      } else if (typeof actualOptions === 'function') {
        actualCallback = actualOptions;
        actualOptions = undefined;
      }

      const rewritten = rewriteDisclaimerInvocation(command, actualArgs);
      const finalRewrite = rewriteClaudeCodeInvocation(
        rewritten ? rewritten.command : command,
        rewritten ? rewritten.args : actualArgs
      );
      if (rewritten) {
        console.log('[Frame Fix] Rewriting disclaimer execFile to ' + rewritten.command);
      }
      if (finalRewrite) {
        console.log('[Frame Fix] Rewriting Claude Code execFile from ' + finalRewrite.originalCommand + ' to ' + finalRewrite.command);
        return originalExecFile.call(this, finalRewrite.command, finalRewrite.args, actualOptions, actualCallback);
      }
      if (rewritten) {
        return originalExecFile.call(this, rewritten.command, rewritten.args, actualOptions, actualCallback);
      }
      return originalExecFile.call(this, command, actualArgs, actualOptions, actualCallback);
    };

    childProcess.execFileSync = function(command, args, options) {
      let actualArgs = args;
      let actualOptions = options;

      if (!Array.isArray(actualArgs)) {
        actualOptions = actualArgs;
        actualArgs = undefined;
      }

      const rewritten = rewriteDisclaimerInvocation(command, actualArgs);
      const finalRewrite = rewriteClaudeCodeInvocation(
        rewritten ? rewritten.command : command,
        rewritten ? rewritten.args : actualArgs
      );
      if (rewritten) {
        console.log('[Frame Fix] Rewriting disclaimer execFileSync to ' + rewritten.command);
      }
      if (finalRewrite) {
        console.log('[Frame Fix] Rewriting Claude Code execFileSync from ' + finalRewrite.originalCommand + ' to ' + finalRewrite.command);
        return originalExecFileSync.call(this, finalRewrite.command, finalRewrite.args, actualOptions);
      }
      if (rewritten) {
        return originalExecFileSync.call(this, rewritten.command, rewritten.args, actualOptions);
      }
      return originalExecFileSync.call(this, command, actualArgs, actualOptions);
    };

    console.log('[Frame Fix] child_process spawn rewrite enabled');
  } catch (e) {
    console.error('[Frame Fix] Failed to patch disclaimer spawn path:', e.message);
  }
}

patchDisclaimerSpawn();

// ============================================================
// CRITICAL: Patch ipcMain IMMEDIATELY before any asar code runs
// ============================================================
try {
  const electron = require('electron');
  const { ipcMain } = electron;
  if (ipcMain && ipcMain._invokeHandlers && !global.__coworkIpcMainPatched) {
    global.__coworkIpcMainPatched = true;
    const invokeHandlers = ipcMain._invokeHandlers;
    const originalGet = invokeHandlers.get.bind(invokeHandlers);
    const originalSet = invokeHandlers.set.bind(invokeHandlers);
    invokeHandlers.set = function(channel, handler) {
      if (typeof channel === 'string' && channel.includes('ClaudeCode_$_')) {
        if (channel.includes('ClaudeCode_$_getStatus')) {
          console.log('[Cowork] Replacing ClaudeCode_$_getStatus during early registration');
          return originalSet(channel, async () => ({
            status: 'ready',
            ready: true,
            installed: true,
            downloading: false,
            progress: 100,
            version: '2.1.72',
          }));
        }
        if (channel.includes('ClaudeCode_$_prepare')) {
          console.log('[Cowork] Replacing ClaudeCode_$_prepare during early registration');
          return originalSet(channel, async () => ({ ready: true, success: true }));
        }
      }
      return originalSet(channel, handler);
    };
    invokeHandlers.get = function(channel) {
      // Override ClaudeCode handlers that throw "Unsupported platform: linux-x64"
      if (typeof channel === 'string' && channel.includes('ClaudeCode_$_')) {
        if (channel.includes('ClaudeCode_$_getStatus')) {
          console.log('[Cowork] Overriding ClaudeCode_$_getStatus');
          return async () => ({
            status: 'ready',
            ready: true,
            installed: true,
            downloading: false,
            progress: 100,
            version: '2.1.72',
          });
        }
        if (channel.includes('ClaudeCode_$_prepare')) {
          console.log('[Cowork] Overriding ClaudeCode_$_prepare');
          return async () => ({ ready: true, success: true });
        }
      }
      return originalGet(channel);
    };
    console.log('[Cowork] ipcMain._invokeHandlers patched for ClaudeCode');
  }
} catch (e) {
  console.error('[Cowork] Failed to patch ipcMain:', e.message);
}

// ============================================================
// 0. TMPDIR FIX - MUST BE ABSOLUTELY FIRST
// ============================================================
// Fix EXDEV error: App downloads VM to /tmp (tmpfs) then tries to
// rename() to ~/.config/Claude/ (disk). rename() can't cross filesystems.

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;

const vmBundleDir = path.join(os.homedir(), '.config/Claude/vm_bundles');
const vmTmpDir = path.join(vmBundleDir, 'tmp');
const claudeVmBundle = path.join(vmBundleDir, 'claudevm.bundle');
const APP_SUPPORT_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
const LOCAL_AGENT_ROOT = path.join(APP_SUPPORT_ROOT, 'LocalAgentModeSessions');

try {
  // Create temp dir on same filesystem as target
  fs.mkdirSync(vmTmpDir, { recursive: true, mode: 0o700 });

  // Set env vars for any code that reads them directly
  process.env.TMPDIR = vmTmpDir;
  process.env.TMP = vmTmpDir;
  process.env.TEMP = vmTmpDir;

  // CRITICAL: Patch os.tmpdir() directly - it may have cached /tmp already
  const originalTmpdir = os.tmpdir;
  os.tmpdir = function() {
    return vmTmpDir;
  };

  // Pre-create VM bundle to skip download entirely
  fs.mkdirSync(claudeVmBundle, { recursive: true, mode: 0o755 });

  // Create marker files the app checks
  const markers = ['bundle_complete', 'rootfs.img', 'rootfs.img.zst', 'vmlinux', 'config.json'];
  for (const m of markers) {
    const p = path.join(claudeVmBundle, m);
    if (!fs.existsSync(p)) {
      if (m === 'config.json') {
        fs.writeFileSync(p, '{"version":"linux-native","skip_vm":true}', { mode: 0o644 });
      } else {
        fs.writeFileSync(p, 'linux-native-placeholder', { mode: 0o644 });
      }
    }
  }
  fs.writeFileSync(path.join(claudeVmBundle, 'version'), '999.0.0-linux-native', { mode: 0o644 });

  console.log('[TMPDIR] Fixed: ' + vmTmpDir);
  console.log('[TMPDIR] os.tmpdir() patched');
  console.log('[VM_BUNDLE] Ready: ' + claudeVmBundle);
} catch (e) {
  console.error('[TMPDIR] Setup failed:', e.message);
}

// ============================================================
// 0b. PATCH fs.rename TO HANDLE EXDEV ERRORS
// ============================================================
const originalRename = fs.rename;
const originalRenameSync = fs.renameSync;

fs.rename = function(oldPath, newPath, callback) {
  originalRename(oldPath, newPath, (err) => {
    if (err && err.code === 'EXDEV') {
      console.log('[fs.rename] EXDEV detected, using copy+delete for:', oldPath);
      const readStream = fs.createReadStream(oldPath);
      const writeStream = fs.createWriteStream(newPath);
      readStream.on('error', callback);
      writeStream.on('error', callback);
      writeStream.on('close', () => {
        fs.unlink(oldPath, () => callback(null));
      });
      readStream.pipe(writeStream);
    } else {
      callback(err);
    }
  });
};

fs.renameSync = function(oldPath, newPath) {
  try {
    return originalRenameSync(oldPath, newPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      console.log('[fs.renameSync] EXDEV detected, using copy+delete for:', oldPath);
      fs.copyFileSync(oldPath, newPath);
      fs.unlinkSync(oldPath);
      return;
    }
    throw err;
  }
};

console.log('[fs.rename] Patched to handle EXDEV errors');

// ============================================================
// 1. PLATFORM SPOOFING - Immediate, before any app code
// ============================================================

// Helper to check if call is from system/electron internals
function isAppCodeCall(stack) {
  return stack.includes('/.vite/build/index.js') ||
         stack.includes('/app.asar/.vite/build/index.js') ||
         stack.includes('/app.asar/') ||
         stack.includes('/linux-app-extracted/');
}

function isSystemCall(stack) {
  if (isAppCodeCall(stack)) {
    return false;
  }
  return stack.includes('node:internal') ||
         stack.includes('internal/modules') ||
         stack.includes('node:electron') ||
         stack.includes('electron/js2c') ||
         stack.includes('electron.asar') ||
         stack.includes('frame-fix-wrapper');
}

Object.defineProperty(process, 'platform', {
  get() {
    const stack = new Error().stack || '';
    // System/Electron internals need real platform
    if (isSystemCall(stack)) {
      return REAL_PLATFORM;
    }
    // App code sees darwin (for event logging, feature detection, etc)
    return 'darwin';
  },
  configurable: true
});

Object.defineProperty(process, 'arch', {
  get() {
    const stack = new Error().stack || '';
    if (isSystemCall(stack)) {
      return REAL_ARCH;
    }
    return 'arm64';
  },
  configurable: true
});

// Also spoof os.platform() and os.arch()
const originalOsPlatform = os.platform;
const originalOsArch = os.arch;

os.platform = function() {
  const stack = new Error().stack || '';
  if (isSystemCall(stack)) {
    return originalOsPlatform.call(os);
  }
  return 'darwin';
};

os.arch = function() {
  const stack = new Error().stack || '';
  if (isSystemCall(stack)) {
    return originalOsArch.call(os);
  }
  return 'arm64';
};

// Spoof macOS version
const originalGetSystemVersion = process.getSystemVersion;
process.getSystemVersion = function() {
  return '14.0.0';
};

console.log('[Platform] Spoofing: darwin/arm64 macOS 14.0 (immediate)');
console.log('[Platform] Real platform was:', REAL_PLATFORM);

// ============================================================
// Cowork/YukonSilver Support for Linux
// On Linux we run Claude Code directly without a VM
// ============================================================

// Global state for Cowork
global.__cowork = {
  supported: true,
  status: 'supported', // This is what the app checks
  processes: new Map(),
};

// Keep the bootstrap wrapper aligned with the swift stub's session root.
const SESSIONS_BASE = path.join(LOCAL_AGENT_ROOT, 'sessions');
try { fs.mkdirSync(SESSIONS_BASE, { recursive: true, mode: 0o700 }); } catch(e) {}

// Override getYukonSilverSupportStatus globally
// The bundled code might look for this function
global.getYukonSilverSupportStatus = function() {
  console.log('[Cowork] getYukonSilverSupportStatus intercepted - returning supported');
  return 'supported';
};

// Try to intercept via prototype pollution on common patterns
// The app might use an object like: vmStatus.getStatus() or vmSupport.getSupportStatus()
const originalDefineProperty = Object.defineProperty;
Object.defineProperty = function(target, key, descriptor) {
  // Intercept any property that looks like it returns support status
  if (typeof key === 'string' && (key.includes('SupportStatus') || key === 'status' || key === 'supported')) {
    if (descriptor && typeof descriptor.value === 'function') {
      const original = descriptor.value;
      descriptor.value = function(...args) {
        const result = original.apply(this, args);
        if (result === 'unsupported') {
          console.log(`[Cowork] Intercepted ${key} returning unsupported -> supported`);
          return 'supported';
        }
        return result;
      };
    }
  }
  return originalDefineProperty.call(this, target, key, descriptor);
};

console.log('[Cowork] Linux support enabled - VM will be emulated');

const IGNORED_LIVE_MESSAGE_TYPES = new Set(['rate_limit_event']);

function isLocalSessionEventChannel(channel) {
  return typeof channel === 'string' && (
    channel.includes('LocalAgentModeSessions_$_onEvent') ||
    channel.includes('LocalSessions_$_onEvent')
  );
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

function getLiveAssistantMessageCache() {
  if (!global.__coworkLiveAssistantMessageCache) {
    global.__coworkLiveAssistantMessageCache = new Map();
  }
  return global.__coworkLiveAssistantMessageCache;
}

function getLiveAssistantStreamState() {
  if (!global.__coworkLiveAssistantStreamState) {
    global.__coworkLiveAssistantStreamState = new Map();
  }
  return global.__coworkLiveAssistantStreamState;
}

function clearLiveAssistantSessionState(sessionId) {
  getLiveAssistantMessageCache().delete(sessionId);
  getLiveAssistantStreamState().delete(sessionId);
}

function tryParsePartialJson(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch (_) {
    return undefined;
  }
}

function buildSyntheticAssistantPayloadFromStreamEvent(sessionId, streamMessage) {
  if (!streamMessage || typeof streamMessage !== 'object' || streamMessage.type !== 'stream_event') {
    return null;
  }

  const streamEvent = streamMessage.event;
  if (!streamEvent || typeof streamEvent !== 'object') {
    return null;
  }

  const streamState = getLiveAssistantStreamState();
  let currentAssistantMessage = streamState.get(sessionId) || null;

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
    streamState.set(sessionId, currentAssistantMessage);
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
      const parsedInput = tryParsePartialJson(partialJson);
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

  streamState.set(sessionId, currentAssistantMessage);
  return cloneAssistantSdkMessage(currentAssistantMessage);
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

global.__coworkMergeConsecutiveAssistantMessages = mergeConsecutiveAssistantMessages;

function normalizeLiveSessionPayloads(channel, payload) {
  if (!isLocalSessionEventChannel(channel) || !payload || typeof payload !== 'object') {
    return [payload];
  }

  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
  if (!sessionId) {
    return [payload];
  }

  if (payload.type === 'start' || payload.type === 'close' || payload.type === 'stopped' || payload.type === 'deleted') {
    clearLiveAssistantSessionState(sessionId);
    return [payload];
  }

  if (payload.type === 'transcript_loaded' && Array.isArray(payload.messages)) {
    return [{
      ...payload,
      messages: mergeConsecutiveAssistantMessages(payload.messages),
    }];
  }

  if (payload.type !== 'message' || !payload.message || typeof payload.message !== 'object') {
    return [payload];
  }

  if (payload.message.type === 'result') {
    getLiveAssistantStreamState().delete(sessionId);
    return [payload];
  }

  if (payload.message.type === 'stream_event') {
    const syntheticAssistantMessage = buildSyntheticAssistantPayloadFromStreamEvent(sessionId, payload.message);
    if (!syntheticAssistantMessage) {
      return [payload];
    }

    const liveAssistantMessageCache = getLiveAssistantMessageCache();
    const previousMessage = liveAssistantMessageCache.get(sessionId);
    const mergedAssistantMessage = mergeAssistantSdkMessages(previousMessage, syntheticAssistantMessage) || syntheticAssistantMessage;
    liveAssistantMessageCache.set(sessionId, mergedAssistantMessage);

    return [
      payload,
      {
        ...payload,
        message: mergedAssistantMessage,
      },
    ];
  }

  if (!isAssistantSdkMessage(payload.message)) {
    return [payload];
  }

  const liveAssistantMessageCache = getLiveAssistantMessageCache();
  const previousMessage = liveAssistantMessageCache.get(sessionId);
  if (previousMessage) {
    const mergedAssistantMessage = mergeAssistantSdkMessages(previousMessage, payload.message);
    if (mergedAssistantMessage) {
      liveAssistantMessageCache.set(sessionId, mergedAssistantMessage);
      return [{
        ...payload,
        message: mergedAssistantMessage,
      }];
    }
  }

  liveAssistantMessageCache.set(sessionId, payload.message);
  return [payload];
}

function parseRequestedProcessId(args) {
  for (const arg of args) {
    if (typeof arg === 'string') {
      return arg;
    }
    if (arg && typeof arg === 'object' && typeof arg.id === 'string') {
      return arg.id;
    }
  }
  return null;
}

async function getCoworkProcessRunningState(processId) {
  const stub = global.__coworkSwiftStub;
  const specialKeepalive = processId === '__keepalive__' || processId === '__heartbeat__';

  try {
    if (stub && typeof stub.isProcessRunning === 'function' && !stub.isProcessRunning.__coworkSyntheticWrapper) {
      const result = await Promise.resolve(stub.isProcessRunning(processId));
      if (result && typeof result === 'object' && 'running' in result) {
        return {
          running: !!result.running,
          exitCode: result.exitCode ?? null,
        };
      }
      const running = !!result;
      return { running, exitCode: running ? null : 0 };
    }
    if (stub && stub.vm && typeof stub.vm.isProcessRunning === 'function' && !stub.vm.isProcessRunning.__coworkSyntheticWrapper) {
      const result = await Promise.resolve(stub.vm.isProcessRunning(processId));
      if (result && typeof result === 'object' && 'running' in result) {
        return {
          running: !!result.running,
          exitCode: result.exitCode ?? null,
        };
      }
      const running = !!result;
      return { running, exitCode: running ? null : 0 };
    }
  } catch (_) {}

  if (typeof processId === 'string' && global.__cowork.processes.has(processId)) {
    return { running: true, exitCode: null };
  }
  if (specialKeepalive) {
    return { running: true, exitCode: null };
  }
  return { running: false, exitCode: 0 };
}

function getIgnoredLiveMessageType(channel, payload) {
  if (!isLocalSessionEventChannel(channel)) {
    return null;
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.type === 'message' && payload.message && typeof payload.message === 'object') {
    const messageType = payload.message.type;
    return IGNORED_LIVE_MESSAGE_TYPES.has(messageType) ? messageType : null;
  }

  return IGNORED_LIVE_MESSAGE_TYPES.has(payload.type) ? payload.type : null;
}

function logIgnoredLiveMessage(channel, payload, messageType) {
  if (!global.__coworkIgnoredLiveMessageStats) {
    global.__coworkIgnoredLiveMessageStats = new Map();
  }

  const key = `${channel}:${messageType}`;
  const current = global.__coworkIgnoredLiveMessageStats.get(key) || { count: 0, lastLoggedAt: 0 };
  current.count += 1;

  const now = Date.now();
  const shouldLog = current.count <= 3 || (now - current.lastLoggedAt) >= 60000;
  if (shouldLog) {
    current.lastLoggedAt = now;
    console.log('[Cowork] Ignored live session event ' + JSON.stringify({
      channel: channel.includes('LocalAgentModeSessions') ? 'LocalAgentModeSessions.onEvent' : 'LocalSessions.onEvent',
      messageType,
      count: current.count,
      sessionId: payload && typeof payload === 'object' ? (payload.sessionId || null) : null,
    }));
  }

  global.__coworkIgnoredLiveMessageStats.set(key, current);
}

function getSyntheticIPCResponse(channel) {
  if (typeof channel !== 'string') {
    return null;
  }
  if (channel.includes('ComputerUseTcc_$_getState')) {
    return async () => ({
      accessibility: 'denied',
      screenCapture: 'denied',
      canPrompt: false,
    });
  }
  if (channel.includes('ComputerUseTcc_$_requestAccess')) {
    return async () => ({
      success: false,
      accessibility: 'denied',
      screenCapture: 'denied',
      canPrompt: false,
    });
  }
  if (channel.includes('isProcessRunning')) {
    return async (...args) => {
      const processId = parseRequestedProcessId(args);
      // Return object { running, exitCode } - app expects e?.running
      return getCoworkProcessRunningState(processId);
    };
  }
  // ClaudeCode handlers - stub out for Linux to enable the Code tab
  if (channel.includes('ClaudeCode_$_getStatus')) {
    return async () => ({
      status: 'ready',
      ready: true,
      installed: true,
      downloading: false,
      progress: 100,
      version: '2.1.72',
    });
  }
  if (channel.includes('ClaudeCode_$_prepare')) {
    return async () => ({ ready: true, success: true });
  }
  return null;
}

function ensureSyntheticWebIPCHandlers(ipcMain, originalHandle, channel) {
  if (!ipcMain || typeof channel !== 'string') {
    return;
  }
  const marker = '_$_claude.web_$_';
  const markerIndex = channel.indexOf(marker);
  if (markerIndex === -1) {
    return;
  }
  const channelPrefix = channel.slice(0, markerIndex + marker.length);
  const syntheticSuffixes = [
    'ComputerUseTcc_$_getState',
    'ComputerUseTcc_$_requestAccess',
    'ClaudeCode_$_getStatus',
    'ClaudeCode_$_prepare',
  ];
  if (!global.__coworkSyntheticIPCChannels) {
    global.__coworkSyntheticIPCChannels = new Set();
  }
  for (const suffix of syntheticSuffixes) {
    const syntheticChannel = channelPrefix + suffix;
    if (global.__coworkSyntheticIPCChannels.has(syntheticChannel)) {
      continue;
    }
    const syntheticHandler = getSyntheticIPCResponse(syntheticChannel);
    if (!syntheticHandler) {
      continue;
    }
    try {
      ipcMain.removeHandler(syntheticChannel);
    } catch (_) {}
    originalHandle(syntheticChannel, syntheticHandler);
    global.__coworkSyntheticIPCChannels.add(syntheticChannel);
    console.log('[Cowork] Registered synthetic IPC handler: ' + syntheticChannel);
  }
}

// ============================================================
// GRACEFUL SHUTDOWN — on Linux, closing all windows must quit the
// app. The asar's handler checks `process.platform === "darwin"`
// and skips quit on macOS (dock convention). Since we spoof darwin,
// we must register our own handler first to call app.quit().
// Also handle SIGTERM/SIGHUP so WMs, systemd, and kill(1) work.
// ============================================================
let shuttingDown = false;
function gracefulQuit(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] ${reason}, quitting gracefully`);
  try {
    const { app } = require('electron');
    // app.quit() can be cancelled by before-quit handlers (the asar has one).
    // app.exit() is uncancellable — closes all windows and exits immediately.
    app.exit(0);
  } catch (e) {
    process.exit(0);
  }
}

// window-all-closed: registered early so it fires before the asar's
// handler (which short-circuits on "darwin" and never quits)
const { app: _app } = require('electron');
_app.on('window-all-closed', () => {
  gracefulQuit('All windows closed');
});

for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
  process.on(sig, () => gracefulQuit(`Received ${sig}`));
}

function getRendererCompatibilityPatchSource() {
  return [
    '(() => {',
    '  try {',
    '    if (window.__coworkRendererCompatInstalled) return;',
    '    const host = String(window.location && window.location.hostname || "");',
    '    if (!(host === "claude.ai" || host === "claude.com" || host === "preview.claude.ai" || host === "preview.claude.com" || host === "localhost" || host.endsWith(".ant.dev"))) return;',
    '    window.__coworkRendererCompatInstalled = true;',
    '    function ensureProseMirrorStyles() {',
    '      if (!document.head || document.getElementById("cowork-prosemirror-style")) return;',
    '      const style = document.createElement("style");',
    '      style.id = "cowork-prosemirror-style";',
    '      style.textContent = ".ProseMirror{white-space:pre-wrap!important;word-break:break-word;}";',
    '      document.head.appendChild(style);',
    '    }',
    '    const NativeResizeObserver = typeof window.ResizeObserver === "function" ? window.ResizeObserver : null;',
    '    if (NativeResizeObserver && !window.__coworkResizeObserverPatched) {',
    '      window.__coworkResizeObserverPatched = true;',
    '      window.ResizeObserver = class CoworkResizeObserver extends NativeResizeObserver {',
    '        constructor(callback) {',
    '          if (typeof callback !== "function") {',
    '            super(callback);',
    '            return;',
    '          }',
    '          let frameId = 0;',
    '          let pendingArgs = null;',
    '          super((...args) => {',
    '            pendingArgs = args;',
    '            if (frameId) return;',
    '            frameId = window.requestAnimationFrame(() => {',
    '              frameId = 0;',
    '              const deliverArgs = pendingArgs;',
    '              pendingArgs = null;',
    '              if (!deliverArgs) return;',
    '              try {',
    '                callback(...deliverArgs);',
    '              } catch (error) {',
    '                window.setTimeout(() => { throw error; }, 0);',
    '              }',
    '            });',
    '          });',
    '        }',
    '      };',
    '      window.addEventListener("error", (event) => {',
    '        const message = String((event && event.message) || "");',
    '        if (!message.includes("ResizeObserver loop completed with undelivered notifications")) return;',
    '        event.preventDefault();',
    '        event.stopImmediatePropagation();',
    '      }, true);',
    '    }',
    '    function ensureDialogTitle(dialog) {',
    '      if (!(dialog instanceof Element) || dialog.dataset.coworkDialogTitlePatched === "1") return;',
    '      const existingTitle = dialog.querySelector("[data-radix-dialog-title], h1, h2, h3, [role=\\"heading\\"]");',
    '      if (existingTitle && existingTitle.textContent && existingTitle.textContent.trim()) {',
    '        if (!existingTitle.id) existingTitle.id = "cowork-dialog-title-" + Math.random().toString(36).slice(2, 10);',
    '        dialog.setAttribute("aria-labelledby", existingTitle.id);',
    '        dialog.dataset.coworkDialogTitlePatched = "1";',
    '        return;',
    '      }',
    '      const hiddenTitle = document.createElement("h2");',
    '      hiddenTitle.id = "cowork-dialog-title-" + Math.random().toString(36).slice(2, 10);',
    '      hiddenTitle.setAttribute("data-cowork-dialog-title", "true");',
    '      hiddenTitle.textContent = (dialog.getAttribute("aria-label") || dialog.getAttribute("data-dialog-title") || "Dialog").trim() || "Dialog";',
    '      hiddenTitle.style.position = "absolute";',
    '      hiddenTitle.style.width = "1px";',
    '      hiddenTitle.style.height = "1px";',
    '      hiddenTitle.style.padding = "0";',
    '      hiddenTitle.style.margin = "-1px";',
    '      hiddenTitle.style.overflow = "hidden";',
    '      hiddenTitle.style.clip = "rect(0, 0, 0, 0)";',
    '      hiddenTitle.style.whiteSpace = "nowrap";',
    '      hiddenTitle.style.border = "0";',
    '      dialog.prepend(hiddenTitle);',
    '      dialog.setAttribute("aria-labelledby", hiddenTitle.id);',
    '      dialog.dataset.coworkDialogTitlePatched = "1";',
    '    }',
    '    function scanForUntitledDialogs(root) {',
    '      if (!root || typeof root.querySelectorAll !== "function") return;',
    '      if (root instanceof Element && root.matches("[role=\\"dialog\\"], [data-radix-dialog-content]")) ensureDialogTitle(root);',
    '      root.querySelectorAll("[role=\\"dialog\\"], [data-radix-dialog-content]").forEach(ensureDialogTitle);',
    '    }',
    '    const observer = new MutationObserver((mutations) => {',
    '      for (const mutation of mutations) {',
    '        for (const node of mutation.addedNodes) {',
    '          if (node && node.nodeType === Node.ELEMENT_NODE) scanForUntitledDialogs(node);',
    '        }',
    '      }',
    '    });',
    '    const startObserver = () => {',
    '      if (!document.documentElement) return;',
    '      ensureProseMirrorStyles();',
    '      scanForUntitledDialogs(document);',
    '      observer.observe(document.documentElement, { childList: true, subtree: true });',
    '    };',
    '    if (document.readyState === "loading") {',
    '      document.addEventListener("DOMContentLoaded", startObserver, { once: true });',
    '    } else {',
    '      startObserver();',
    '    }',
    '    window.addEventListener("beforeunload", () => observer.disconnect(), { once: true });',
    '  } catch (error) {',
    '    console.warn("[Frame Fix] Renderer compatibility patch failed", error);',
    '  }',
    '})();',
  ].join('\n');
}

Module.prototype.require = function(id) {
  // Intercept claude-swift to inject our Linux implementation
  if (id && id.includes('@ant/claude-swift')) {
    console.log('[Cowork] Intercepting @ant/claude-swift');
    const swiftStub = originalRequire.apply(this, arguments);
    global.__coworkSwiftStub = swiftStub;
    // Ensure the VM reports as supported
    if (swiftStub && swiftStub.vm) {
      const originalGetStatus = swiftStub.vm.getStatus;
      swiftStub.vm.getStatus = function() {
        console.log('[Cowork] vm.getStatus called - returning supported');
        return { supported: true, status: 'supported', running: true, connected: true };
      };
      swiftStub.vm.getSupportStatus = function() {
        console.log('[Cowork] vm.getSupportStatus called - returning supported');
        return 'supported';
      };
      swiftStub.vm.isSupported = function() {
        return true;
      };
      if (typeof swiftStub.vm.isProcessRunning !== 'function') {
        const syntheticVmIsProcessRunning = async function(processId) {
          const state = await getCoworkProcessRunningState(processId);
          return state.running;
        };
        syntheticVmIsProcessRunning.__coworkSyntheticWrapper = true;
        swiftStub.vm.isProcessRunning = syntheticVmIsProcessRunning;
      }
    }
    if (swiftStub && typeof swiftStub.isProcessRunning !== 'function') {
      const syntheticIsProcessRunning = async function(processId) {
        const state = await getCoworkProcessRunningState(processId);
        return state.running;
      };
      syntheticIsProcessRunning.__coworkSyntheticWrapper = true;
      swiftStub.isProcessRunning = syntheticIsProcessRunning;
    }
    return swiftStub;
  }

  const module = originalRequire.apply(this, arguments);

  if (id === 'electron') {
    console.log('[Frame Fix] Intercepting electron module');

    // Intercept ipcMain.handle to inject our VM handlers
    const { ipcMain } = module;
    if (ipcMain && !global.__coworkIPCPatched) {
      global.__coworkIPCPatched = true;

      const invokeHandlers = ipcMain._invokeHandlers;
      if (invokeHandlers && !global.__coworkInvokeHandlersPatched) {
        global.__coworkInvokeHandlersPatched = true;
        const originalHas = invokeHandlers.has.bind(invokeHandlers);
        const originalGet = invokeHandlers.get.bind(invokeHandlers);
        const originalSet = invokeHandlers.set.bind(invokeHandlers);
        invokeHandlers.has = function(channel) {
          return originalHas(channel) || !!getSyntheticIPCResponse(channel);
        };
        invokeHandlers.set = function(channel, handler) {
          if (typeof channel === 'string' && channel.includes('ClaudeCode_$_')) {
            const synthetic = getSyntheticIPCResponse(channel);
            if (synthetic) {
              console.log('[Cowork] Replacing ClaudeCode handler during registration:', channel);
              return originalSet(channel, synthetic);
            }
          }
          return originalSet(channel, handler);
        };
        invokeHandlers.get = function(channel) {
          // For ClaudeCode handlers, ALWAYS return our synthetic handler
          // because the asar's handler throws "Unsupported platform: linux-x64"
          if (typeof channel === 'string' && channel.includes('ClaudeCode_$_')) {
            const synthetic = getSyntheticIPCResponse(channel);
            if (synthetic) {
              console.log('[Cowork] Overriding ClaudeCode handler:', channel);
              return synthetic;
            }
          }
          const existing = originalGet(channel);
          return existing || getSyntheticIPCResponse(channel);
        };
        console.log('[Cowork] _invokeHandlers fallback enabled');
      }

      const originalHandle = ipcMain.handle.bind(ipcMain);
      ipcMain.handle = function(channel, handler) {
        ensureSyntheticWebIPCHandlers(ipcMain, originalHandle, channel);

        if (typeof channel === 'string' && channel.includes('Extensions_$_installDxtUnpacked')) {
          return originalHandle(channel, async (event, folderPath, ...rest) => {
            const normalizedFolderPath = normalizeIpcPathArgument(folderPath);
            if (!normalizedFolderPath) {
              console.log('[Frame Fix] installDxtUnpacked received no usable folder path');
              return null;
            }
            if (normalizedFolderPath !== folderPath) {
              console.log('[Frame Fix] Normalized installDxtUnpacked folder path to ' + normalizedFolderPath);
            }
            return handler(event, normalizedFolderPath, ...rest);
          });
        }

        // Filter ignored message types from transcripts — check both top-level and nested
        if (channel.includes('getTranscript')) {
          return originalHandle(channel, async (...args) => {
            const result = await handler(...args);
            if (Array.isArray(result)) {
              return mergeConsecutiveAssistantMessages(result.filter(msg => {
                if (!msg) return false;
                // Check top-level type
                if (IGNORED_LIVE_MESSAGE_TYPES.has(msg.type)) return false;
                // Check nested message type (matches live filtering logic)
                if (msg.type === 'message' && msg.message && IGNORED_LIVE_MESSAGE_TYPES.has(msg.message.type)) {
                  return false;
                }
                return true;
              }));
            }
            return result;
          });
        }

        const syntheticHandler = getSyntheticIPCResponse(channel);
        if (syntheticHandler) {
          console.log(`[Cowork] Intercepting synthetic IPC handler: ${channel}`);
          return originalHandle(channel, syntheticHandler);
        }

        // Intercept ClaudeVM handlers to inject our Linux implementation
        if (channel.includes('ClaudeVM')) {
          console.log(`[Cowork] Intercepting ClaudeVM handler: ${channel}`);

          // Wrap the handler to override certain methods
          const wrappedHandler = async (...args) => {
            const method = channel.split('_$_').pop();
            console.log(`[Cowork] ClaudeVM.${method} called`);

            // Override specific methods for Linux
            if (method === 'getRunningStatus') {
              return { running: true, connected: true, ready: true, status: 'running' };
            }
            if (method === 'getDownloadStatus') {
              return { status: 'ready', downloaded: true, installed: true, progress: 100 };
            }
            if (method === 'isSupported' || method === 'getSupportStatus') {
              return 'supported';
            }
            if (method === 'isProcessRunning') {
              const processId = parseRequestedProcessId(args);
              // Return object { running, exitCode } - app expects e?.running
              return getCoworkProcessRunningState(processId);
            }

            // Call original handler for other methods
            try {
              return await handler(...args);
            } catch(e) {
              console.log(`[Cowork] ClaudeVM.${method} handler error:`, e.message);
              return null;
            }
          };
          return originalHandle(channel, wrappedHandler);
        }

        // Intercept ClaudeCode handlers for the Code tab feature
        if (channel.includes('ClaudeCode')) {
          console.log(`[Cowork] Intercepting ClaudeCode handler: ${channel}`);

          const wrappedHandler = async (...args) => {
            const method = channel.split('_$_').pop();
            console.log(`[Cowork] ClaudeCode.${method} called`);

            // Override specific methods for Linux - return "ready" status
            if (method === 'getStatus') {
              return {
                status: 'ready',
                ready: true,
                installed: true,
                downloading: false,
                progress: 100,
                version: '2.1.72',
              };
            }
            if (method === 'prepare') {
              return { ready: true, success: true };
            }

            // Call original handler for other methods
            try {
              return await handler(...args);
            } catch(e) {
              console.log(`[Cowork] ClaudeCode.${method} handler error:`, e.message);
              // Return a safe default instead of throwing
              return { ready: true, status: 'ready' };
            }
          };
          return originalHandle(channel, wrappedHandler);
        }

        return originalHandle(channel, handler);
      };

      console.log('[Cowork] IPC handler interception enabled');
    }

    // Stub out macOS-only systemPreferences methods that cause crashes on Linux
    if (module.systemPreferences && !global.__coworkSystemPreferencesPatched) {
      global.__coworkSystemPreferencesPatched = true;
      module.systemPreferences.getMediaAccessStatus = function() {
        console.log('[Frame Fix] Stubbed systemPreferences.getMediaAccessStatus');
        return 'granted';
      };
      module.systemPreferences.askForMediaAccess = async function() {
        console.log('[Frame Fix] Stubbed systemPreferences.askForMediaAccess');
        return true;
      };
      console.log('[Frame Fix] systemPreferences patched for Linux');
    }

    if (module.app && !global.__coworkAppPatched) {
      global.__coworkAppPatched = true;

      if (typeof module.app.getLoginItemSettings === 'function') {
        const originalGetLoginItemSettings = module.app.getLoginItemSettings.bind(module.app);
        module.app.getLoginItemSettings = function(...args) {
          const result = originalGetLoginItemSettings(...args) || {};
          if (REAL_PLATFORM !== 'linux' || typeof result !== 'object') {
            return result;
          }
          return {
            ...result,
            openAtLogin: !!result.openAtLogin,
            openAsHidden: !!result.openAsHidden,
            restoreState: !!result.restoreState,
            wasOpenedAtLogin: !!result.wasOpenedAtLogin,
            wasOpenedAsHidden: !!result.wasOpenedAsHidden,
            executableWillLaunchAtLogin: !!result.executableWillLaunchAtLogin,
          };
        };
      }

      if (typeof module.app.setAsDefaultProtocolClient === 'function') {
        const originalSetAsDefaultProtocolClient = module.app.setAsDefaultProtocolClient.bind(module.app);
        module.app.setAsDefaultProtocolClient = function(protocol, ...args) {
          if (REAL_PLATFORM === 'linux' && protocol === 'claude') {
            return registerLinuxClaudeProtocolHandler();
          }
          return originalSetAsDefaultProtocolClient(protocol, ...args);
        };
      }

      if (typeof module.app.removeAsDefaultProtocolClient === 'function') {
        const originalRemoveAsDefaultProtocolClient = module.app.removeAsDefaultProtocolClient.bind(module.app);
        module.app.removeAsDefaultProtocolClient = function(protocol, ...args) {
          if (REAL_PLATFORM === 'linux' && protocol === 'claude') {
            return true;
          }
          return originalRemoveAsDefaultProtocolClient(protocol, ...args);
        };
      }
    }

    // Patch BrowserWindow to stub macOS-only methods and handle close events
    // The asar's close handler does `if (isMac()) return;` which swallows
    // close events since we spoof darwin. We prepend a listener that forces
    // app.quit() so killactive/WM close works on all Linux DEs.
    let _closePatched = new WeakSet();
    let _sendPatched = new WeakSet();
    let _rendererPatched = new WeakSet();

    function patchWindowClose(win) {
      if (_closePatched.has(win)) return;
      _closePatched.add(win);

      // Stub macOS-only BrowserWindow methods
      if (!win.setWindowButtonPosition) {
        win.setWindowButtonPosition = function() {
          // no-op on Linux
        };
      }
      // Use prependListener so we fire before the asar's handler
      win.prependListener('close', (event) => {
        if (REAL_PLATFORM === 'linux' && !shuttingDown) {
          console.log('[Shutdown] Window close on Linux — scheduling exit');
          // Defer exit so the close event chain finishes without
          // hitting "Object has been destroyed" in downstream handlers
          setImmediate(() => gracefulQuit('Window closed'));
        }
      });
    }

    function patchEventDispatch(contents) {
      if (!contents || _sendPatched.has(contents) || typeof contents.send !== 'function') {
        return;
      }
      _sendPatched.add(contents);
      const originalSend = contents.send.bind(contents);
      contents.send = function(channel, ...args) {
        const normalizedPayloads = args.length > 0
          ? normalizeLiveSessionPayloads(channel, args[0])
          : [undefined];

        let sent = false;
        for (const normalizedPayload of normalizedPayloads) {
          if (args.length > 0) {
            args[0] = normalizedPayload;
          }
          const ignoredType = getIgnoredLiveMessageType(channel, normalizedPayload);
          if (ignoredType) {
            logIgnoredLiveMessage(channel, normalizedPayload, ignoredType);
            continue;
          }
          sent = originalSend(channel, ...args) || sent;
        }

        return sent;
      };
    }

    function patchRendererCompatibility(contents) {
      if (!contents || _rendererPatched.has(contents) || typeof contents.executeJavaScript !== 'function') {
        return;
      }
      _rendererPatched.add(contents);

      const injectCompatibilityPatch = () => {
        const currentUrl = typeof contents.getURL === 'function' ? contents.getURL() : '';
        if (typeof currentUrl === 'string' && currentUrl.startsWith('devtools://')) {
          return;
        }
        contents.executeJavaScript(getRendererCompatibilityPatchSource(), true).catch((error) => {
          console.log('[Frame Fix] Renderer compatibility injection failed:', error && error.message ? error.message : error);
        });
      };

      contents.on('dom-ready', injectCompatibilityPatch);
      setImmediate(injectCompatibilityPatch);
    }

    // Hook webContents creation to catch windows as they appear
    _app.on('web-contents-created', (_event, contents) => {
      const owner = contents.getOwnerBrowserWindow && contents.getOwnerBrowserWindow();
      if (owner) patchWindowClose(owner);
      patchEventDispatch(contents);
      patchRendererCompatibility(contents);
    });

    // Also patch on browser-window-created for certainty
    _app.on('browser-window-created', (_event, win) => {
      patchWindowClose(win);
      if (win && win.webContents) {
        patchEventDispatch(win.webContents);
        patchRendererCompatibility(win.webContents);
      }
    });

    if (module.webContents && typeof module.webContents.getAllWebContents === 'function') {
      for (const contents of module.webContents.getAllWebContents()) {
        patchEventDispatch(contents);
        patchRendererCompatibility(contents);
      }
    }

    const OriginalMenu = module.Menu;

    // Intercept Menu.setApplicationMenu to hide menu bar on Linux
    // This catches the app's later calls to setApplicationMenu that would show the menu
    const originalSetAppMenu = OriginalMenu.setApplicationMenu;
    module.Menu.setApplicationMenu = function(menu) {
      console.log('[Frame Fix] Intercepting setApplicationMenu');
      try {
        // Call original - use call() to preserve correct context
        if (typeof originalSetAppMenu === 'function') {
          originalSetAppMenu.call(OriginalMenu, menu);
        }
      } catch (e) {
        console.log('[Frame Fix] setApplicationMenu error (ignored):', e.message);
      }
      if (REAL_PLATFORM === 'linux') {
        // Hide menu bar on all existing windows after menu is set
        try {
          for (const win of module.BrowserWindow.getAllWindows()) {
            win.setMenuBarVisibility(false);
          }
          console.log('[Frame Fix] Menu bar hidden on all windows');
        } catch (e) {
          console.log('[Frame Fix] setMenuBarVisibility error:', e.message);
        }
      }
    };

    // Intercept shell.showItemInFolder to translate VM paths for scratchpad/file links
    if (module.shell && !global.__coworkShellPatched) {
      global.__coworkShellPatched = true;
      const originalShowItemInFolder = module.shell.showItemInFolder.bind(module.shell);
      const originalOpenPath = typeof module.shell.openPath === 'function'
        ? module.shell.openPath.bind(module.shell)
        : null;

      function openPathOnLinux(targetPath) {
        const commands = [
          ['gio', ['open', targetPath]],
          ['xdg-open', [targetPath]],
        ];

        return new Promise((resolve) => {
          let index = 0;

          const tryNext = (lastError) => {
            if (index >= commands.length) {
              resolve(lastError || 'Failed to open path');
              return;
            }

            const [command, args] = commands[index++];
            execFile(command, args, { timeout: 10000 }, (error) => {
              if (!error) {
                resolve('');
                return;
              }
              tryNext(error && error.message ? error.message : String(error));
            });
          };

          tryNext('');
        });
      }

      function resolveSessionShellPath(fullPath, callerName) {
        let resolvedPath = fullPath;
        let candidatePath = null;
        let sessionRoot = null;
        if (typeof fullPath === 'string') {
          if (fullPath.startsWith('/sessions/')) {
            const sessionPath = fullPath.substring('/sessions/'.length);
            const sessionName = sessionPath.split('/')[0];
            if (!sessionName || sessionName === '.' || sessionName === '..' || sessionName.includes('/')) {
              console.error('[Frame Fix] ' + callerName + ': invalid session name:', fullPath);
              return null;
            }
            sessionRoot = path.join(SESSIONS_BASE, sessionName);
            candidatePath = path.resolve(path.join(SESSIONS_BASE, sessionPath));
          } else if (fullPath === SESSIONS_BASE || fullPath.startsWith(SESSIONS_BASE + path.sep)) {
            const sessionRelative = path.relative(SESSIONS_BASE, fullPath);
            const sessionName = sessionRelative.split(path.sep)[0];
            if (!sessionName || sessionName === '.' || sessionName === '..' || sessionName.includes('/')) {
              console.error('[Frame Fix] ' + callerName + ': invalid host session path:', fullPath);
              return null;
            }
            sessionRoot = path.join(SESSIONS_BASE, sessionName);
            candidatePath = path.resolve(fullPath);
          }
        }
        if (candidatePath && sessionRoot) {
          // Validate containment lexically within the session tree, then canonicalize
          // through mnt symlinks so the file manager lands on the real host location.
          const relativeToRoot = path.relative(sessionRoot, candidatePath);
          if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
            console.error('[Frame Fix] ' + callerName + ': path escapes session root:', fullPath, '->', candidatePath);
            return null;
          }
          try {
            resolvedPath = fs.realpathSync(candidatePath);
          } catch (_) {
            let current = path.dirname(candidatePath);
            let foundAncestor = false;
            while (current !== path.dirname(current)) {
              const relative = path.relative(sessionRoot, current);
              if (relative.startsWith('..') || path.isAbsolute(relative)) {
                console.error('[Frame Fix] ' + callerName + ': no valid ancestor inside session root:', fullPath);
                return null;
              }
              try {
                resolvedPath = fs.realpathSync(current);
                foundAncestor = true;
                break;
              } catch (_) {
                current = path.dirname(current);
              }
            }
            if (!foundAncestor) {
              console.error('[Frame Fix] ' + callerName + ': no valid ancestor found:', fullPath);
              return null;
            }
          }
          console.log('[Frame Fix] ' + callerName + ' translated:', fullPath, '->', resolvedPath);
        }
        return resolvedPath;
      }

      module.shell.openPath = function(fullPath) {
        if (!originalOpenPath && process.platform !== 'linux') {
          return Promise.resolve('');
        }
        const resolvedPath = resolveSessionShellPath(fullPath, 'shell.openPath') ?? fullPath;
        if (process.platform === 'linux' && typeof resolvedPath === 'string') {
          return openPathOnLinux(resolvedPath);
        }
        return originalOpenPath(resolvedPath);
      };

      module.shell.showItemInFolder = function(fullPath) {
        const resolvedPath = resolveSessionShellPath(fullPath, 'shell.showItemInFolder');
        if (!resolvedPath) {
          return false;
        }
        try {
          const stats = fs.statSync(resolvedPath);
          const revealDir = stats.isDirectory() ? resolvedPath : path.dirname(resolvedPath);
          if (process.platform === 'linux') {
            console.log('[Frame Fix] shell.showItemInFolder opening directory directly:', revealDir);
            openPathOnLinux(revealDir).then((errorMessage) => {
              if (errorMessage) {
                console.error('[Frame Fix] shell.openPath failed for directory:', revealDir, errorMessage);
              }
            });
            return true;
          }
          if (originalOpenPath) {
            console.log('[Frame Fix] shell.showItemInFolder opening directory directly:', revealDir);
            originalOpenPath(revealDir).catch((err) => {
              console.error('[Frame Fix] shell.openPath failed for directory:', revealDir, err && err.message ? err.message : err);
            });
            return true;
          }
        } catch (_) {}
        return originalShowItemInFolder(resolvedPath);
      };
      console.log('[Frame Fix] shell.showItemInFolder patched for VM path translation');
    }
  }

  return module;
};
