'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  MUTATING_SCHEDULED_TASK_SUFFIXES,
  READ_ONLY_SCHEDULED_TASK_SUFFIXES,
  isMutatingScheduledTaskChannel,
  isReadOnlyScheduledTaskChannel,
  makeRefusedHandler,
} = require('../../../stubs/cowork/scheduled_task_gate.js');

describe('scheduled-task gate (predicate)', () => {
  test('mutating set covers both CCD and Cowork namespaces', () => {
    for (const namespace of ['CCDScheduledTasks', 'CoworkScheduledTasks']) {
      assert.ok(MUTATING_SCHEDULED_TASK_SUFFIXES.has(namespace + '_$_createScheduledTask'));
      assert.ok(MUTATING_SCHEDULED_TASK_SUFFIXES.has(namespace + '_$_updateScheduledTask'));
      assert.ok(MUTATING_SCHEDULED_TASK_SUFFIXES.has(namespace + '_$_updateScheduledTaskStatus'));
      assert.ok(MUTATING_SCHEDULED_TASK_SUFFIXES.has(namespace + '_$_removeApprovedPermission'));
    }
    assert.ok(MUTATING_SCHEDULED_TASK_SUFFIXES.has('CoworkScheduledTasks_$_clearChromePermissions'));
  });

  test('read-only set excludes mutating channels', () => {
    for (const m of MUTATING_SCHEDULED_TASK_SUFFIXES) {
      assert.ok(!READ_ONLY_SCHEDULED_TASK_SUFFIXES.has(m), 'overlap: ' + m);
    }
  });

  test('isMutatingScheduledTaskChannel detects EIPC-prefixed channels', () => {
    assert.equal(isMutatingScheduledTaskChannel('uuid_$_claude.web_$_CCDScheduledTasks_$_createScheduledTask'), true);
    assert.equal(isMutatingScheduledTaskChannel('uuid_$_claude.web_$_CoworkScheduledTasks_$_updateScheduledTask'), true);
    assert.equal(isMutatingScheduledTaskChannel('uuid_$_claude.web_$_CoworkScheduledTasks_$_clearChromePermissions'), true);
  });

  test('isMutatingScheduledTaskChannel rejects read-only channels', () => {
    assert.equal(isMutatingScheduledTaskChannel('uuid_$_claude.web_$_CCDScheduledTasks_$_getAllScheduledTasks'), false);
    assert.equal(isMutatingScheduledTaskChannel('uuid_$_claude.web_$_CCDScheduledTasks_$_onScheduledTaskEvent'), false);
    assert.equal(isMutatingScheduledTaskChannel('uuid_$_claude.web_$_LocalAgentModeSessions_$_getSessionsForScheduledTask'), false);
  });

  test('isMutatingScheduledTaskChannel rejects unrelated channels', () => {
    assert.equal(isMutatingScheduledTaskChannel('uuid_$_claude.web_$_FileSystem_$_readLocalFile'), false);
    assert.equal(isMutatingScheduledTaskChannel('uuid_$_claude.web_$_LocalAgentModeSessions_$_getBridgeConsent'), false);
    assert.equal(isMutatingScheduledTaskChannel(null), false);
    assert.equal(isMutatingScheduledTaskChannel(42), false);
  });

  test('isReadOnlyScheduledTaskChannel covers the documented get* and on* methods', () => {
    assert.equal(isReadOnlyScheduledTaskChannel('uuid_$_claude.web_$_CCDScheduledTasks_$_getAllScheduledTasks'), true);
    assert.equal(isReadOnlyScheduledTaskChannel('uuid_$_claude.web_$_CoworkScheduledTasks_$_onScheduledTaskEvent'), true);
    assert.equal(isReadOnlyScheduledTaskChannel('uuid_$_claude.web_$_LocalSessions_$_getSessionsForScheduledTask'), true);
  });

  test('makeRefusedHandler rejects with structured error', async () => {
    const logs = [];
    const handler = makeRefusedHandler({ log: (m) => logs.push(m), reason: 'test reason' });
    await assert.rejects(
      () => handler({}, 'someArg'),
      (err) => err.code === 'COWORK_SCHEDULED_TASK_REFUSED' && err.message === 'test reason',
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0], /\[scheduled-task-gate\]/);
  });

  test('makeRefusedHandler default reason is informative', async () => {
    const handler = makeRefusedHandler({ log: () => {} });
    await assert.rejects(
      () => handler(),
      /bridge-reachable scheduled-task mutation refused/,
    );
  });
});
