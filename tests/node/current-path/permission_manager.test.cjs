'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createPermissionManager } = require('../../../stubs/cowork/permission_manager.js');

describe('PermissionManager', () => {
  let tmpDir;
  let persistPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
    persistPath = path.join(tmpDir, 'permissions.json');
  });

  describe('initial state', () => {
    it('returns not_determined for unset permissions', () => {
      const pm = createPermissionManager({ persistPath });
      assert.equal(pm.getStatus('accessibility'), 'not_determined');
      assert.equal(pm.getStatus('screen'), 'not_determined');
      assert.equal(pm.getStatus('camera'), 'not_determined');
    });

    it('isGranted returns false for unset permissions', () => {
      const pm = createPermissionManager({ persistPath });
      assert.equal(pm.isGranted('accessibility'), false);
      assert.equal(pm.isGranted('screen'), false);
    });

    it('getTccState reports canPrompt: true', () => {
      const pm = createPermissionManager({ persistPath });
      const state = pm.getTccState();
      assert.equal(state.canPrompt, true);
      assert.equal(state.accessibility, 'not_determined');
      assert.equal(state.screenCapture, 'not_determined');
    });
  });

  describe('media access status', () => {
    it('maps camera/microphone/screen to correct permission names', () => {
      const pm = createPermissionManager({ persistPath });
      assert.equal(pm.getMediaAccessStatus('camera'), 'not_determined');
      assert.equal(pm.getMediaAccessStatus('microphone'), 'not_determined');
      assert.equal(pm.getMediaAccessStatus('screen'), 'not_determined');
    });
  });

  describe('persistence', () => {
    it('persists grants to disk and reloads them', () => {
      const pm1 = createPermissionManager({ persistPath });
      // Simulate a grant by writing directly (since dialog can't be tested)
      fs.writeFileSync(persistPath, JSON.stringify({
        grants: {
          accessibility: { granted: true, timestamp: Date.now() },
          screen: { granted: false, timestamp: Date.now() },
        },
      }), 'utf8');

      const pm2 = createPermissionManager({ persistPath });
      assert.equal(pm2.isGranted('accessibility'), true);
      assert.equal(pm2.getStatus('accessibility'), 'granted');
      assert.equal(pm2.isGranted('screen'), false);
      assert.equal(pm2.getStatus('screen'), 'denied');
    });

    it('expires grants older than 30 days', () => {
      const thirtyOneDaysAgo = Date.now() - (31 * 24 * 60 * 60 * 1000);
      fs.writeFileSync(persistPath, JSON.stringify({
        grants: {
          accessibility: { granted: true, timestamp: thirtyOneDaysAgo },
        },
      }), 'utf8');

      const pm = createPermissionManager({ persistPath });
      assert.equal(pm.isGranted('accessibility'), false);
      assert.equal(pm.getStatus('accessibility'), 'not_determined');
    });

    it('does not expire grants within 30 days', () => {
      const twentyNineDaysAgo = Date.now() - (29 * 24 * 60 * 60 * 1000);
      fs.writeFileSync(persistPath, JSON.stringify({
        grants: {
          screen: { granted: true, timestamp: twentyNineDaysAgo },
        },
      }), 'utf8');

      const pm = createPermissionManager({ persistPath });
      assert.equal(pm.isGranted('screen'), true);
      assert.equal(pm.getStatus('screen'), 'granted');
    });
  });

  describe('revocation', () => {
    it('revoke removes a grant', () => {
      fs.writeFileSync(persistPath, JSON.stringify({
        grants: {
          accessibility: { granted: true, timestamp: Date.now() },
        },
      }), 'utf8');

      const pm = createPermissionManager({ persistPath });
      assert.equal(pm.isGranted('accessibility'), true);

      pm.revoke('accessibility');
      assert.equal(pm.isGranted('accessibility'), false);
      assert.equal(pm.getStatus('accessibility'), 'not_determined');
    });

    it('revoke persists to disk', () => {
      fs.writeFileSync(persistPath, JSON.stringify({
        grants: {
          screen: { granted: true, timestamp: Date.now() },
        },
      }), 'utf8');

      const pm1 = createPermissionManager({ persistPath });
      pm1.revoke('screen');

      const pm2 = createPermissionManager({ persistPath });
      assert.equal(pm2.isGranted('screen'), false);
    });
  });

  describe('getCurrentGrants', () => {
    it('returns only active non-expired grants', () => {
      const now = Date.now();
      const expired = now - (31 * 24 * 60 * 60 * 1000);
      fs.writeFileSync(persistPath, JSON.stringify({
        grants: {
          accessibility: { granted: true, timestamp: now },
          screen: { granted: false, timestamp: now },  // denied, not a grant
          camera: { granted: true, timestamp: expired }, // expired
        },
      }), 'utf8');

      const pm = createPermissionManager({ persistPath });
      const grants = pm.getCurrentGrants();
      assert.equal(grants.length, 1);
      assert.equal(grants[0].permission, 'accessibility');
    });
  });

  describe('getTccState aggregation', () => {
    it('reflects granted permissions', () => {
      fs.writeFileSync(persistPath, JSON.stringify({
        grants: {
          accessibility: { granted: true, timestamp: Date.now() },
          screen: { granted: true, timestamp: Date.now() },
        },
      }), 'utf8');

      const pm = createPermissionManager({ persistPath });
      const state = pm.getTccState();
      assert.equal(state.accessibility, 'granted');
      assert.equal(state.screenCapture, 'granted');
      assert.equal(state.canPrompt, true);
    });

    it('reflects denied permissions', () => {
      fs.writeFileSync(persistPath, JSON.stringify({
        grants: {
          accessibility: { granted: false, timestamp: Date.now() },
        },
      }), 'utf8');

      const pm = createPermissionManager({ persistPath });
      const state = pm.getTccState();
      assert.equal(state.accessibility, 'denied');
      assert.equal(state.screenCapture, 'not_determined');
    });
  });

  describe('no persist path', () => {
    it('works without persistence', () => {
      const pm = createPermissionManager({});
      assert.equal(pm.getStatus('accessibility'), 'not_determined');
      assert.equal(pm.isGranted('accessibility'), false);
      pm.revoke('accessibility'); // should not throw
    });
  });

  describe('corrupt persist file', () => {
    it('handles corrupt JSON gracefully', () => {
      fs.writeFileSync(persistPath, 'not json', 'utf8');
      const pm = createPermissionManager({ persistPath });
      assert.equal(pm.getStatus('accessibility'), 'not_determined');
    });
  });
});
