'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPortalShortcuts } = require('../../../stubs/cowork/portal_shortcuts.js');

describe('Portal Shortcuts — accelerator translation', () => {
  const ps = createPortalShortcuts();

  it('translates Ctrl+Alt+Space', () => {
    assert.equal(ps._electronAccelToPortal('Ctrl+Alt+Space'), '<ctrl><alt>space');
  });

  it('translates Alt+Space', () => {
    assert.equal(ps._electronAccelToPortal('Alt+Space'), '<alt>space');
  });

  it('translates CommandOrControl+Shift+P', () => {
    assert.equal(ps._electronAccelToPortal('CommandOrControl+Shift+P'), '<ctrl><shift>p');
  });

  it('translates CmdOrCtrl+Q', () => {
    assert.equal(ps._electronAccelToPortal('CmdOrCtrl+Q'), '<ctrl>q');
  });

  it('translates Super+A', () => {
    assert.equal(ps._electronAccelToPortal('Super+A'), '<super>a');
  });

  it('translates single key (F12)', () => {
    assert.equal(ps._electronAccelToPortal('F12'), 'f12');
  });

  it('translates Control+Shift+Alt+Delete', () => {
    assert.equal(ps._electronAccelToPortal('Control+Shift+Alt+Delete'), '<ctrl><shift><alt>delete');
  });
});

describe('Portal Shortcuts — accelerator to ID', () => {
  const ps = createPortalShortcuts();

  it('generates stable ID from accelerator', () => {
    assert.equal(ps._acceleratorToId('Ctrl+Alt+Space'), 'claude-ctrl-alt-space');
  });

  it('generates stable ID from simple accelerator', () => {
    assert.equal(ps._acceleratorToId('Alt+Space'), 'claude-alt-space');
  });
});

describe('Portal Shortcuts — signal parsing', () => {
  const ps = createPortalShortcuts();

  it('parses Activated signal', () => {
    const line = "/org/freedesktop/portal/desktop: org.freedesktop.portal.GlobalShortcuts.Activated (objectpath '/org/freedesktop/portal/desktop/session/1_123/claude_456', 'claude-ctrl-alt-space', uint64 1234567890, @a{sv} {})";
    assert.equal(ps._parseActivatedSignal(line), 'claude-ctrl-alt-space');
  });

  it('returns null for non-Activated signal', () => {
    const line = "/org/freedesktop/portal/desktop: org.freedesktop.portal.GlobalShortcuts.Deactivated (objectpath '/session/...', 'id', uint64 0, @a{sv} {})";
    assert.equal(ps._parseActivatedSignal(line), null);
  });

  it('parses Response signal with session handle', () => {
    const line = "/org/freedesktop/portal/desktop/request/1_123/token: org.freedesktop.portal.Request.Response (uint32 0, {'session_handle': <objectpath '/org/freedesktop/portal/desktop/session/1_123/claude_456'>})";
    const result = ps._parseResponseSignal(line);
    assert.equal(result.status, 0);
    assert.equal(result.sessionHandle, '/org/freedesktop/portal/desktop/session/1_123/claude_456');
  });

  it('parses Response signal with non-zero status', () => {
    const line = "/org/freedesktop/portal/desktop/request/1_123/token: org.freedesktop.portal.Request.Response (uint32 1, {})";
    const result = ps._parseResponseSignal(line);
    assert.equal(result.status, 1);
    assert.equal(result.sessionHandle, null);
  });

  it('returns null for non-Response line', () => {
    const line = "some random gdbus monitor output";
    assert.equal(ps._parseResponseSignal(line), null);
  });
});

describe('Portal Shortcuts — register/unregister state', () => {
  it('tracks registered shortcuts', () => {
    const ps = createPortalShortcuts();
    // isRegistered is sync state tracking (doesn't need portal)
    assert.equal(ps.isRegistered('Ctrl+Alt+Space'), false);
  });
});
