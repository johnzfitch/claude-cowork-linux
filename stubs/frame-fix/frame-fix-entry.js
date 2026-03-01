// Load frame fix first (patches platform, IPC handlers, BrowserWindow)
require('./frame-fix-wrapper.js');
// Then load patched main (index.js has yukonSilver patches)
require('./.vite/build/index.js');

// ============================================================
// Post-load: Replace IPC handlers that crash on Linux
// ============================================================
// The asar registers handlers for ClaudeVM (macOS VM management) and
// ClaudeCode (binary download) that crash on Linux. We replace them
// with static stubs AFTER the asar has registered them.
const { ipcMain, app } = require('electron');

const EIPC_UUID = '61a9f65f-1ad1-4154-b2da-52d6d0694886';
const NAMESPACE = 'claude.web';

const IPC_STUBS = {
  'ClaudeVM_$_getDownloadStatus': { status: 'ready', downloaded: true, installed: true, progress: 100, version: 'linux-native-1.0.0' },
  'ClaudeVM_$_download': { status: 'ready', downloaded: true, progress: 100 },
  'ClaudeVM_$_getRunningStatus': { running: true, connected: true, status: 'connected' },
  'ClaudeVM_$_startVM': { started: true, status: 'running' },
  'ClaudeVM_$_checkVirtualMachinePlatform': { supported: true, enabled: true },
  'ClaudeVM_$_enableVirtualMachinePlatform': { success: true },
  'ClaudeVM_$_setYukonSilverConfig': { success: true },
  'ClaudeVM_$_deleteAndReinstall': { success: true },
};

function replaceHandlers(label) {
  let replaced = 0;
  for (const [suffix, response] of Object.entries(IPC_STUBS)) {
    const channel = `$eipc_message$_${EIPC_UUID}_$_${NAMESPACE}_$_${suffix}`;
    try {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async () => response);
      replaced++;
    } catch (e) {
      // Handler might not be registered yet
    }
  }
  if (replaced > 0) console.log(`[IPC-PostLoad] ${label}: replaced ${replaced} handler(s) with Linux stubs`);
  return replaced;
}

// Try immediately (handlers registered synchronously during require)
replaceHandlers('sync');

// Also try on next tick (handlers registered via setImmediate/nextTick)
process.nextTick(() => replaceHandlers('nextTick'));

// Also try after app is ready (handlers registered in whenReady callback)
app.whenReady().then(() => {
  replaceHandlers('whenReady');
  // Final attempt after a short delay for any async registration
  setTimeout(() => replaceHandlers('delayed'), 500);
});
