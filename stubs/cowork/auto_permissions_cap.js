'use strict';

// ============================================================
// Auto-permissions toggle TTL cap (Phase 2)
// ============================================================
// The asar exposes two preference toggles that skip permission prompts:
//   - autoPermissionsModeEnabled
//   - bypassPermissionsModeEnabled
// Both default to false and have no built-in TTL. This module wraps the
// AppPreferences_$_setPreference IPC handler so flipping either to true
// schedules an auto-revert to false after CAP_MS wall-clock.
//
// Rails not barriers: this is an opinionated default. The user can edit
// DEFAULT_CAP_MS (or pass capMs to createAutoPermissionsCap) for a
// different policy, or remove the cap entirely if their threat model
// differs. The wrapper does not enforce against the user — it bounds
// drift in upstream defaults across a multi-week shipping cadence.
//
// Closure-private state: no exports of state-setting functions. Each
// call to createAutoPermissionsCap() returns its own closure with its
// own timers. Timers reset on process exit (no persistence).

const DEFAULT_CAP_MS = 60 * 60 * 1000;

function createAutoPermissionsCap({ capMs = DEFAULT_CAP_MS, log = console.log } = {}) {
  let _setPreferenceHandler = null;
  let _capturedSender = null;
  const _capTimers = {
    autoPermissionsModeEnabled: null,
    bypassPermissionsModeEnabled: null,
  };

  function _scheduleAutoDisable(key) {
    if (_capTimers[key]) clearTimeout(_capTimers[key]);
    _capTimers[key] = setTimeout(() => {
      _capTimers[key] = null;
      if (!_setPreferenceHandler || !_capturedSender) return;
      try {
        const fauxEvent = { sender: _capturedSender, frameId: 0, processId: 0 };
        Promise.resolve(_setPreferenceHandler(fauxEvent, key, false))
          .then(() => log('[auto-permissions-cap] auto-disabled ' + key + ' after ' + (capMs / 60000) + 'min cap'))
          .catch((e) => log('[auto-permissions-cap] auto-disable of ' + key + ' failed: ' + (e && e.message)));
      } catch (e) {
        log('[auto-permissions-cap] sync error scheduling auto-disable: ' + (e && e.message));
      }
    }, capMs);
  }

  function wrapHandler(handler) {
    _setPreferenceHandler = handler;
    return async function wrappedSetPreference(event, key, value) {
      if (event && event.sender) _capturedSender = event.sender;
      const result = await handler(event, key, value);
      if (key in _capTimers) {
        if (value === true) {
          _scheduleAutoDisable(key);
        } else if (_capTimers[key]) {
          clearTimeout(_capTimers[key]);
          _capTimers[key] = null;
        }
      }
      return result;
    };
  }

  function hasTimer(key) {
    return _capTimers[key] !== null && _capTimers[key] !== undefined;
  }

  return Object.freeze({ wrapHandler, hasTimer, CAP_MS: capMs });
}

module.exports = { createAutoPermissionsCap, DEFAULT_CAP_MS };
