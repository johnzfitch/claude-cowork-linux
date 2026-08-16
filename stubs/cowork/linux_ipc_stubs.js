'use strict';

// Canonical IPC stub responses for Linux.
//
// The single production consumer is ipc_overrides.js, which imports the
// CLAUDE_CODE_*, CLAUDE_VM_* and *_GRANTED values for its override registry.
//
// This header used to name three insertion points in frame-fix-wrapper.js —
// getSyntheticIPCResponse(), getLinuxIpcOverrides() and an inline
// ClaudeVM/ClaudeCode intercept. None of them exist any more; the generic
// early-init fallback in particular was removed deliberately, because a
// catch-all that classified an unknown method and answered it from a default
// table is exactly how a security question gets forged an answer (see the
// DeviceRegistry note in ipc_overrides.js).
//
// Consequence worth knowing before you reuse them: COMPUTER_USE_TCC_DENIED and
// COMPUTER_USE_TCC_REQUEST_DENIED existed for that removed early path and now
// have no production consumer — only a shape assertion in
// tests/node/current-path/audit_regression.test.cjs. They are kept as the
// deny-side counterparts, not because anything returns them today.

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

// Denial stubs for the removed early-init path — see the header. No production
// consumer today; kept as the deny-side counterparts.
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

// The live pair, imported by ipc_overrides.js for ComputerUseTcc_$_getState
// and the three ComputerUseTcc_$_request* channels.
//
// Both DENY, despite the _GRANTED names. The suffix is vestigial: it once
// distinguished these from the *_DENIED constants above, back when the removed
// early-init path answered before the asar was up. What actually separates the
// two sets now is response shape — these carry { granted } / { granted, status },
// the DENIED ones carry { accessibility, screenCapture, canPrompt }.
//
// Do not "fix" the values to match the names: Linux has no TCC UI to prompt the
// user with, so granting screen capture or accessibility here would assert a
// consent the user was never asked for.
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
