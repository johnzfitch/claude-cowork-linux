'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  createAutoPermissionsCap,
  DEFAULT_CAP_MS,
} = require('../../../stubs/cowork/auto_permissions_cap.js');

describe('auto-permissions TTL cap', () => {
  test('default cap is 60 minutes', () => {
    assert.equal(DEFAULT_CAP_MS, 60 * 60 * 1000);
    const cap = createAutoPermissionsCap();
    assert.equal(cap.CAP_MS, 60 * 60 * 1000);
  });

  test('setting autoPermissionsModeEnabled to true schedules a timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cap = createAutoPermissionsCap({ log: () => {} });
    const wrapped = cap.wrapHandler(async () => null);
    assert.equal(cap.hasTimer('autoPermissionsModeEnabled'), false);
    await wrapped({ sender: {} }, 'autoPermissionsModeEnabled', true);
    assert.equal(cap.hasTimer('autoPermissionsModeEnabled'), true);
  });

  test('setting to false before timer fires clears the timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cap = createAutoPermissionsCap({ log: () => {} });
    const wrapped = cap.wrapHandler(async () => null);
    await wrapped({ sender: {} }, 'autoPermissionsModeEnabled', true);
    assert.equal(cap.hasTimer('autoPermissionsModeEnabled'), true);
    await wrapped({ sender: {} }, 'autoPermissionsModeEnabled', false);
    assert.equal(cap.hasTimer('autoPermissionsModeEnabled'), false);
  });

  test('re-setting to true resets the deadline (does not stack)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cap = createAutoPermissionsCap({ log: () => {} });
    const wrapped = cap.wrapHandler(async () => null);
    await wrapped({ sender: {} }, 'autoPermissionsModeEnabled', true);
    t.mock.timers.tick(30 * 60 * 1000);
    await wrapped({ sender: {} }, 'autoPermissionsModeEnabled', true);
    t.mock.timers.tick(30 * 60 * 1000);
    // Old timer would have fired 30 min ago; reset means we still have 30 min left.
    assert.equal(cap.hasTimer('autoPermissionsModeEnabled'), true);
    t.mock.timers.tick(30 * 60 * 1000);
    assert.equal(cap.hasTimer('autoPermissionsModeEnabled'), false);
  });

  test('timer fire invokes captured handler with (event, key, false)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const calls = [];
    const original = async (event, key, value) => {
      calls.push({ key, value, hasSender: !!(event && event.sender) });
      return null;
    };
    const cap = createAutoPermissionsCap({ log: () => {} });
    const wrapped = cap.wrapHandler(original);
    await wrapped({ sender: { id: 'test-sender' } }, 'autoPermissionsModeEnabled', true);
    assert.equal(calls.length, 1, 'initial set fires through');
    t.mock.timers.tick(60 * 60 * 1000);
    // Synchronous part of the setTimeout callback invokes the handler;
    // calls.push runs sync before the first await inside the async handler.
    assert.equal(calls.length, 2, 'cap fire invokes handler');
    assert.deepEqual(
      { key: calls[1].key, value: calls[1].value, hasSender: calls[1].hasSender },
      { key: 'autoPermissionsModeEnabled', value: false, hasSender: true },
    );
  });

  test('bypassPermissionsModeEnabled has identical TTL behavior', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cap = createAutoPermissionsCap({ log: () => {} });
    const wrapped = cap.wrapHandler(async () => null);
    await wrapped({ sender: {} }, 'bypassPermissionsModeEnabled', true);
    assert.equal(cap.hasTimer('bypassPermissionsModeEnabled'), true);
    await wrapped({ sender: {} }, 'bypassPermissionsModeEnabled', false);
    assert.equal(cap.hasTimer('bypassPermissionsModeEnabled'), false);
  });

  test('setting any other preference key does not arm a timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cap = createAutoPermissionsCap({ log: () => {} });
    const wrapped = cap.wrapHandler(async () => null);
    await wrapped({ sender: {} }, 'someOtherPreference', true);
    await wrapped({ sender: {} }, 'theme', 'dark');
    await wrapped({ sender: {} }, 'locale', 'en-US');
    assert.equal(cap.hasTimer('autoPermissionsModeEnabled'), false);
    assert.equal(cap.hasTimer('bypassPermissionsModeEnabled'), false);
  });

  test('two toggles have independent timers', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cap = createAutoPermissionsCap({ log: () => {} });
    const wrapped = cap.wrapHandler(async () => null);
    await wrapped({ sender: {} }, 'autoPermissionsModeEnabled', true);
    await wrapped({ sender: {} }, 'bypassPermissionsModeEnabled', true);
    assert.equal(cap.hasTimer('autoPermissionsModeEnabled'), true);
    assert.equal(cap.hasTimer('bypassPermissionsModeEnabled'), true);
    await wrapped({ sender: {} }, 'autoPermissionsModeEnabled', false);
    assert.equal(cap.hasTimer('autoPermissionsModeEnabled'), false);
    assert.equal(cap.hasTimer('bypassPermissionsModeEnabled'), true, 'bypass timer should be independent');
  });

  test('wrapHandler returns a pass-through for the initial call', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cap = createAutoPermissionsCap({ log: () => {} });
    const wrapped = cap.wrapHandler(async (_event, _key, value) => `result-${value}`);
    const result = await wrapped({ sender: {} }, 'autoPermissionsModeEnabled', true);
    assert.equal(result, 'result-true');
  });

  test('cap survives custom capMs', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cap = createAutoPermissionsCap({ capMs: 5000, log: () => {} });
    assert.equal(cap.CAP_MS, 5000);
    const calls = [];
    const wrapped = cap.wrapHandler(async (event, key, value) => { calls.push({ key, value }); });
    await wrapped({ sender: {} }, 'autoPermissionsModeEnabled', true);
    assert.equal(calls.length, 1);
    t.mock.timers.tick(4000);
    assert.equal(calls.length, 1, 'should not fire before cap');
    t.mock.timers.tick(2000);
    assert.equal(calls.length, 2, 'should fire after cap elapsed');
  });
});
