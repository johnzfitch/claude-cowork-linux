'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  createBridgeCanary,
  DEFAULT_KNOWN_GOOD,
  extractSuffix,
  isBridgeRelated,
} = require('../../../stubs/cowork/bridge_canary.js');

function makeStubs() {
  const logs = [];
  const writes = [];
  return {
    logs,
    writes,
    log: (msg) => logs.push(msg),
    writeFn: (p, content) => writes.push({ path: p, content }),
    mkdirFn: () => {},
  };
}

describe('bridge canary', () => {
  test('extractSuffix isolates LocalAgentModeSessions_$_ tail', () => {
    assert.equal(
      extractSuffix('$eipc_message$_uuid_$_claude.web_$_LocalAgentModeSessions_$_newBridgeMethod'),
      'LocalAgentModeSessions_$_newBridgeMethod',
    );
    assert.equal(
      extractSuffix('FileSystem_$_readLocalFile'),
      null,
      'non-LocalAgentModeSessions channels return null',
    );
    assert.equal(extractSuffix(null), null);
    assert.equal(extractSuffix(undefined), null);
    assert.equal(extractSuffix(42), null);
  });

  test('isBridgeRelated matches Bridge or bridge anywhere', () => {
    assert.equal(isBridgeRelated('LocalAgentModeSessions_$_getBridgeConsent'), true);
    assert.equal(isBridgeRelated('LocalAgentModeSessions_$_bridge'), true);
    assert.equal(isBridgeRelated('LocalAgentModeSessions_$_someBridgePoll'), true);
    assert.equal(isBridgeRelated('LocalAgentModeSessions_$_start'), false);
    assert.equal(isBridgeRelated('LocalAgentModeSessions_$_listSessions'), false);
  });

  test('disabled canary observes nothing', () => {
    const s = makeStubs();
    const canary = createBridgeCanary({ enabled: false, ...s });
    assert.equal(
      canary.observe('uuid_$_LocalAgentModeSessions_$_brandNewBridgeMethod'),
      false,
    );
    assert.equal(s.logs.length, 0);
    assert.equal(s.writes.length, 0);
  });

  test('does not fire for known-good bridge channels', () => {
    const s = makeStubs();
    const canary = createBridgeCanary({ enabled: true, ...s });
    for (const suffix of DEFAULT_KNOWN_GOOD) {
      assert.equal(canary.observe('prefix_$_' + suffix), false);
    }
    assert.equal(s.logs.length, 0);
  });

  test('does not fire for non-bridge LocalAgentModeSessions channels', () => {
    const s = makeStubs();
    const canary = createBridgeCanary({ enabled: true, ...s });
    assert.equal(canary.observe('uuid_$_LocalAgentModeSessions_$_listSessions'), false);
    assert.equal(canary.observe('uuid_$_LocalAgentModeSessions_$_start'), false);
    assert.equal(s.logs.length, 0);
  });

  test('does not fire for non-LocalAgentModeSessions channels even if bridge-named', () => {
    const s = makeStubs();
    const canary = createBridgeCanary({ enabled: true, ...s });
    // Suffix anchor requires LocalAgentModeSessions_$_ prefix.
    assert.equal(canary.observe('SomethingElse_$_getBridgeStatus'), false);
    assert.equal(s.logs.length, 0);
  });

  test('fires exactly once per new bridge suffix', () => {
    const s = makeStubs();
    const canary = createBridgeCanary({ enabled: true, ...s });
    const novelSuffix = 'LocalAgentModeSessions_$_newBridgeFlow';
    assert.equal(canary.observe('uuid_$_' + novelSuffix), true);
    assert.equal(canary.observe('uuid_$_' + novelSuffix), false, 'second observation is suppressed');
    assert.equal(canary.observe('anotherUuid_$_' + novelSuffix), false, 'suppression keyed on suffix, not full channel');
    assert.equal(s.logs.length, 1);
    assert.match(s.logs[0], /new bridge-related IPC channel observed/);
    assert.match(s.logs[0], /newBridgeFlow/);
    assert.match(s.logs[0], /review SECURITY\.md/);
  });

  test('fires for distinct new bridge suffixes independently', () => {
    const s = makeStubs();
    const canary = createBridgeCanary({ enabled: true, ...s });
    assert.equal(canary.observe('uuid_$_LocalAgentModeSessions_$_newBridgeA'), true);
    assert.equal(canary.observe('uuid_$_LocalAgentModeSessions_$_newBridgeB'), true);
    assert.equal(canary.observe('uuid_$_LocalAgentModeSessions_$_newBridgeA'), false);
    assert.equal(s.logs.length, 2);
  });

  test('writes a JSONL line per new observation', () => {
    const s = makeStubs();
    const canary = createBridgeCanary({ enabled: true, ...s });
    canary.observe('uuid_$_LocalAgentModeSessions_$_newBridgeC');
    assert.equal(s.writes.length, 1);
    assert.match(s.writes[0].content, /"suffix":"LocalAgentModeSessions_\$_newBridgeC"/);
    assert.match(s.writes[0].content, /"ts":"\d{4}-\d{2}-\d{2}T/);
  });

  test('CLAUDE_COWORK_IPC_TAP=1 enables via env-var gate', (t) => {
    const prev = process.env.CLAUDE_COWORK_IPC_TAP;
    const prev2 = process.env.CLAUDE_COWORK_BRIDGE_CANARY;
    delete process.env.CLAUDE_COWORK_BRIDGE_CANARY;
    process.env.CLAUDE_COWORK_IPC_TAP = '1';
    t.after(() => {
      if (prev === undefined) delete process.env.CLAUDE_COWORK_IPC_TAP;
      else process.env.CLAUDE_COWORK_IPC_TAP = prev;
      if (prev2 !== undefined) process.env.CLAUDE_COWORK_BRIDGE_CANARY = prev2;
    });
    const s = makeStubs();
    const canary = createBridgeCanary({ ...s }); // default enabled = isEnabledByEnv()
    assert.equal(canary.enabled, true);
    canary.observe('uuid_$_LocalAgentModeSessions_$_newBridgeViaIpcTap');
    assert.equal(s.logs.length, 1);
  });

  test('CLAUDE_COWORK_BRIDGE_CANARY=1 enables independently', (t) => {
    const prev = process.env.CLAUDE_COWORK_IPC_TAP;
    const prev2 = process.env.CLAUDE_COWORK_BRIDGE_CANARY;
    delete process.env.CLAUDE_COWORK_IPC_TAP;
    process.env.CLAUDE_COWORK_BRIDGE_CANARY = '1';
    t.after(() => {
      if (prev !== undefined) process.env.CLAUDE_COWORK_IPC_TAP = prev;
      if (prev2 === undefined) delete process.env.CLAUDE_COWORK_BRIDGE_CANARY;
      else process.env.CLAUDE_COWORK_BRIDGE_CANARY = prev2;
    });
    const s = makeStubs();
    const canary = createBridgeCanary({ ...s });
    assert.equal(canary.enabled, true);
    canary.observe('uuid_$_LocalAgentModeSessions_$_newBridgeViaCanaryFlag');
    assert.equal(s.logs.length, 1);
  });

  test('env-var gate off keeps canary silent', (t) => {
    const prev = process.env.CLAUDE_COWORK_IPC_TAP;
    const prev2 = process.env.CLAUDE_COWORK_BRIDGE_CANARY;
    delete process.env.CLAUDE_COWORK_IPC_TAP;
    delete process.env.CLAUDE_COWORK_BRIDGE_CANARY;
    t.after(() => {
      if (prev !== undefined) process.env.CLAUDE_COWORK_IPC_TAP = prev;
      if (prev2 !== undefined) process.env.CLAUDE_COWORK_BRIDGE_CANARY = prev2;
    });
    const s = makeStubs();
    const canary = createBridgeCanary({ ...s });
    assert.equal(canary.enabled, false);
    assert.equal(canary.observe('uuid_$_LocalAgentModeSessions_$_newBridgeSilent'), false);
    assert.equal(s.logs.length, 0);
  });
});
