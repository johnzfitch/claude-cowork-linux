'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPortalShortcuts, _test } = require('../../../stubs/cowork/portal_shortcuts.js');
const { pad, bWriteStr, bWriteVariantStr, bWriteDictSV, readStr } = _test;

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

describe('Portal Shortcuts — D-Bus wire format', () => {
  it('bWriteStr pads to 4-byte alignment', () => {
    const buf = Buffer.alloc(64);
    // Write at offset 1 (unaligned) — should pad to 4
    const end = bWriteStr(buf, 1, 'hi');
    // Padded to offset 4, then UINT32(2) + 'hi' + NUL = 4 + 4 + 2 + 1 = 11
    assert.equal(buf.readUInt32LE(4), 2); // string length at offset 4
    assert.equal(buf.toString('utf8', 8, 10), 'hi');
    assert.equal(buf[10], 0); // NUL
    assert.equal(end, 11);
  });

  it('bWriteStr at aligned offset has no extra padding', () => {
    const buf = Buffer.alloc(64);
    const end = bWriteStr(buf, 0, 'abc');
    assert.equal(buf.readUInt32LE(0), 3);
    assert.equal(buf.toString('utf8', 4, 7), 'abc');
    assert.equal(end, 8); // 4 + 3 + 1
  });

  it('bWriteVariantStr aligns string value inside variant', () => {
    const buf = Buffer.alloc(64);
    // Start at offset 0: sig(3 bytes) → offset 3 → pad to 4 → UINT32 + data
    const end = bWriteVariantStr(buf, 0, 'test');
    assert.equal(buf[0], 1);    // sig length
    assert.equal(buf[1], 0x73); // 's'
    assert.equal(buf[2], 0);    // sig NUL
    // String value should be at offset 4 (padded from 3)
    assert.equal(buf.readUInt32LE(4), 4); // string length
    assert.equal(buf.toString('utf8', 8, 12), 'test');
    assert.equal(end, 13); // 4 + 4 + 4 + 1
  });

  it('bWriteDictSV array length excludes alignment padding', () => {
    const buf = Buffer.alloc(256);
    const end = bWriteDictSV(buf, 0, [['key', 'val']]);
    const arrLen = buf.readUInt32LE(0);
    // Array data starts at pad(4, 8) = 8
    // Dict entry at 8: bWriteStr('key') = UINT32(3)+'key'+NUL = 8 bytes → offset 16
    // bWriteVariantStr('val'): sig(3) → 19, pad(19,4)=20, UINT32(3)+'val'+NUL = 8 → 28
    // Data length = 28 - 8 = 20
    assert.equal(arrLen, end - 8, 'array length should be data bytes only');
    assert.equal(arrLen, 20);
    assert.equal(end, 28);
  });

  it('bWriteDictSV with two entries has correct length', () => {
    const buf = Buffer.alloc(512);
    const end = bWriteDictSV(buf, 0, [
      ['session_handle_token', 'tok1'],
      ['handle_token', 'tok2'],
    ]);
    const arrLen = buf.readUInt32LE(0);
    assert.equal(arrLen, end - 8, 'array length = total - data start');
    // Verify first key is readable
    const k1 = readStr(buf, 8);
    assert.equal(k1.v, 'session_handle_token');
  });

  it('bWriteDictSV at non-zero offset pads array to 4', () => {
    const buf = Buffer.alloc(256);
    // Start at offset 5 (unaligned for array)
    const end = bWriteDictSV(buf, 5, [['k', 'v']]);
    // Array length UINT32 should be at pad(5, 4) = 8
    const arrLen = buf.readUInt32LE(8);
    // Data starts at pad(12, 8) = 16
    assert.equal(arrLen, end - 16);
  });

  it('empty bWriteDictSV produces zero-length array', () => {
    const buf = Buffer.alloc(64);
    const end = bWriteDictSV(buf, 0, []);
    const arrLen = buf.readUInt32LE(0);
    assert.equal(arrLen, 0);
    // Data start = pad(4, 8) = 8, end should also be 8 (no data)
    assert.equal(end, 8);
  });
});

describe('Portal Shortcuts — register/unregister state', () => {
  it('tracks registered shortcuts', () => {
    const ps = createPortalShortcuts();
    assert.equal(ps.isRegistered('Ctrl+Alt+Space'), false);
  });

  it('isAvailable checks for session bus', () => {
    const ps = createPortalShortcuts();
    // Should return true on a system with a session bus
    const result = ps.isAvailable();
    assert.equal(typeof result, 'boolean');
  });
});
