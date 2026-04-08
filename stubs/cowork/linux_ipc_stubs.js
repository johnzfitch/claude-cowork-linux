'use strict';

// Canonical IPC stub responses for Linux.
//
// Three insertion points in frame-fix-wrapper.js reference these values:
//   1. getSyntheticIPCResponse()   — _invokeHandlers.has() fallback + ipcMain.handle() intercept
//   2. getLinuxIpcOverrides()      — webContents.ipc handler replacement (per-window)
//   3. Inline ClaudeVM/ClaudeCode  — ipcMain.handle() intercept inside require('electron') hook
//
// The insertion TIMING stays where it is (each fires at a different point
// in the Electron lifecycle). Only the DATA is consolidated here.

const STUB_CLAUDE_CODE_VERSION = '2.1.72';

const CLAUDE_CODE_STATUS = Object.freeze({
  status: 'ready',
  ready: true,
  installed: true,
  downloading: false,
  progress: 100,
  version: STUB_CLAUDE_CODE_VERSION,
});

const CLAUDE_CODE_PREPARE = Object.freeze({ ready: true, success: true });

const CLAUDE_VM_RUNNING_STATUS = 'ready';

const CLAUDE_VM_DOWNLOAD_STATUS = 'ready';

// getSyntheticIPCResponse uses denial stubs (fires early, before asar init)
const COMPUTER_USE_TCC_DENIED = Object.freeze({
  accessibility: 'denied',
  screenCapture: 'denied',
  canPrompt: false,
});

const COMPUTER_USE_TCC_REQUEST_DENIED = Object.freeze({
  success: false,
  accessibility: 'denied',
  screenCapture: 'denied',
  canPrompt: false,
});

// getLinuxIpcOverrides — deny by default (Linux has no TCC UI to prompt the user)
const COMPUTER_USE_TCC_GRANTED = Object.freeze({ granted: false, status: 'denied' });
const COMPUTER_USE_TCC_REQUEST_GRANTED = Object.freeze({ granted: false });

module.exports = {
  CLAUDE_CODE_PREPARE,
  CLAUDE_CODE_STATUS,
  CLAUDE_VM_DOWNLOAD_STATUS,
  CLAUDE_VM_RUNNING_STATUS,
  COMPUTER_USE_TCC_DENIED,
  COMPUTER_USE_TCC_GRANTED,
  COMPUTER_USE_TCC_REQUEST_DENIED,
  COMPUTER_USE_TCC_REQUEST_GRANTED,
  STUB_CLAUDE_CODE_VERSION,
};
