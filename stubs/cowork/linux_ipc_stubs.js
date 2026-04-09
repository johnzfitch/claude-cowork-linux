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

// Early TCC stub (fires before asar init, before permission manager is available).
// Reports canPrompt: true so the webapp knows it can request permissions.
const COMPUTER_USE_TCC_INITIAL = Object.freeze({
  accessibility: 'not_determined',
  screenCapture: 'not_determined',
  canPrompt: true,
});

const COMPUTER_USE_TCC_REQUEST_INITIAL = Object.freeze({
  success: false,
  accessibility: 'not_determined',
  screenCapture: 'not_determined',
  canPrompt: true,
});

// Default responses for getLinuxIpcOverrides — prompt-capable
const COMPUTER_USE_TCC_PROMPT_CAPABLE = { granted: false, status: 'not_determined', canPrompt: true };
const COMPUTER_USE_TCC_REQUEST_PROMPT_CAPABLE = { granted: false, canPrompt: true };

module.exports = {
  CLAUDE_CODE_PREPARE,
  CLAUDE_CODE_STATUS,
  CLAUDE_VM_DOWNLOAD_STATUS,
  CLAUDE_VM_RUNNING_STATUS,
  COMPUTER_USE_TCC_INITIAL,
  COMPUTER_USE_TCC_PROMPT_CAPABLE,
  COMPUTER_USE_TCC_REQUEST_INITIAL,
  COMPUTER_USE_TCC_REQUEST_PROMPT_CAPABLE,
  STUB_CLAUDE_CODE_VERSION,
};
