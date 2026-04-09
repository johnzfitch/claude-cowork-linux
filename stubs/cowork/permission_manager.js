'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================================
// PERMISSION MANAGER — Electron-native permission prompting for Linux
// ============================================================================
// Replaces macOS TCC (Transparency, Consent, and Control) with Electron dialog
// prompts. Manages user permission grants with persistence and expiry.
//
// On macOS, the system's TCC framework prompts users and remembers choices.
// On Linux, there's no equivalent system — this module provides the prompting
// layer using Electron's dialog API and persists grants to disk.

const GRANT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const PERMISSION_DESCRIPTIONS = {
  accessibility: 'Claude wants to use accessibility features to interact with your desktop.',
  camera: 'Claude wants to access your camera.',
  microphone: 'Claude wants to access your microphone.',
  screen: 'Claude wants to capture your screen.',
};

function createPermissionManager(options) {
  const { persistPath } = options || {};
  const _grants = new Map(); // permission -> { granted: boolean, timestamp: number }

  // Load persisted grants on creation
  if (persistPath) {
    try {
      const data = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
      if (data && typeof data === 'object' && data.grants) {
        const now = Date.now();
        for (const [perm, grant] of Object.entries(data.grants)) {
          if (grant && typeof grant.timestamp === 'number' && (now - grant.timestamp) < GRANT_EXPIRY_MS) {
            _grants.set(perm, grant);
          }
        }
      }
    } catch (_) {
      // No persisted grants or corrupt file — start fresh
    }
  }

  function _persist() {
    if (!persistPath) return;
    try {
      const dir = path.dirname(persistPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const data = { grants: Object.fromEntries(_grants) };
      fs.writeFileSync(persistPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    } catch (_) {
      // Best effort persistence
    }
  }

  function _getGrant(permission) {
    const grant = _grants.get(permission);
    if (!grant) return null;
    if ((Date.now() - grant.timestamp) >= GRANT_EXPIRY_MS) {
      _grants.delete(permission);
      _persist();
      return null;
    }
    return grant;
  }

  function isGranted(permission) {
    const grant = _getGrant(permission);
    return grant ? grant.granted : false;
  }

  function getStatus(permission) {
    const grant = _getGrant(permission);
    if (!grant) return 'not_determined';
    return grant.granted ? 'granted' : 'denied';
  }

  async function requestWithDialog(permission, description) {
    // Check if already granted
    const existing = _getGrant(permission);
    if (existing) return existing.granted;

    // Show Electron dialog
    try {
      const { dialog } = require('electron');
      const result = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Allow', 'Deny'],
        defaultId: 1,
        cancelId: 1,
        title: 'Permission Request',
        message: description || PERMISSION_DESCRIPTIONS[permission] || `Claude is requesting ${permission} access.`,
        detail: 'You can change this later in the application settings.',
      });

      const granted = result.response === 0;
      _grants.set(permission, { granted, timestamp: Date.now() });
      _persist();
      return granted;
    } catch (e) {
      // Dialog failed (no focused window, etc.) — deny by default
      console.warn('[PermissionManager] Dialog failed for ' + permission + ':', e.message);
      return false;
    }
  }

  function revoke(permission) {
    _grants.delete(permission);
    _persist();
  }

  function getMediaAccessStatus(mediaType) {
    // Map Electron media types to our permission names
    const permMap = { camera: 'camera', microphone: 'microphone', screen: 'screen' };
    const perm = permMap[mediaType] || mediaType;
    return getStatus(perm);
  }

  async function requestMediaAccess(mediaType) {
    const permMap = { camera: 'camera', microphone: 'microphone', screen: 'screen' };
    const perm = permMap[mediaType] || mediaType;
    return requestWithDialog(perm, PERMISSION_DESCRIPTIONS[perm]);
  }

  function getTccState() {
    return {
      accessibility: getStatus('accessibility'),
      screenCapture: getStatus('screen'),
      canPrompt: true,
    };
  }

  async function requestTccAccess() {
    // Request both accessibility and screen capture
    const accessGranted = await requestWithDialog('accessibility');
    const screenGranted = await requestWithDialog('screen');
    return {
      granted: accessGranted && screenGranted,
      accessibility: getStatus('accessibility'),
      screenCapture: getStatus('screen'),
    };
  }

  async function requestBridgeConsent() {
    try {
      const { dialog } = require('electron');
      const result = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Allow', 'Deny'],
        defaultId: 1,
        cancelId: 1,
        title: 'Bridge Connection',
        message: 'Claude wants to enable the sessions bridge.',
        detail: 'The bridge allows Claude to sync session state with the remote server. This enables features like session sharing and remote collaboration.',
      });
      return { consented: result.response === 0 };
    } catch (e) {
      console.warn('[PermissionManager] Bridge consent dialog failed:', e.message);
      return { consented: false };
    }
  }

  async function requestFolderAccess(folderPath) {
    try {
      const { dialog } = require('electron');
      const detail = folderPath
        ? `Claude wants to access: ${folderPath}`
        : 'Claude wants to access a folder on your system.';
      const result = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Allow', 'Deny'],
        defaultId: 1,
        cancelId: 1,
        title: 'Folder Access',
        message: 'Claude is requesting folder access.',
        detail,
      });
      return { granted: result.response === 0 };
    } catch (e) {
      console.warn('[PermissionManager] Folder access dialog failed:', e.message);
      return { granted: false };
    }
  }

  function getCurrentGrants() {
    const grants = [];
    for (const [permission, grant] of _grants) {
      if (grant.granted && (Date.now() - grant.timestamp) < GRANT_EXPIRY_MS) {
        grants.push({ permission, grantedAt: grant.timestamp });
      }
    }
    return grants;
  }

  return {
    getCurrentGrants,
    getMediaAccessStatus,
    getStatus,
    getTccState,
    isGranted,
    requestBridgeConsent,
    requestFolderAccess,
    requestMediaAccess,
    requestTccAccess,
    requestWithDialog,
    revoke,
  };
}

module.exports = { createPermissionManager };
