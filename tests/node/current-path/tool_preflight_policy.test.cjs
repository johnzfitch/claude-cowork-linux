'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const {
  shouldAutoApproveToolPreflight,
  READ_SET,
  isContainedIn,
} = require('../../../stubs/cowork/tool_preflight_policy.js');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'));
}

describe('tool preflight path policy', () => {
  test('READ_SET contains only audited read-only tools', () => {
    assert.ok(READ_SET.has('read_file'));
    assert.ok(READ_SET.has('list_dir'));
    assert.ok(READ_SET.has('grep'));
    assert.ok(READ_SET.has('head'));
    assert.ok(READ_SET.has('tail'));
    assert.ok(!READ_SET.has('find'), 'find has -exec');
    assert.ok(!READ_SET.has('bash'), 'bash is shell evaluation');
    assert.ok(!READ_SET.has('write_file'));
    assert.ok(!READ_SET.has('run_command'));
  });

  test('read tool, path inside cwd: auto-approves', () => {
    const cwd = makeTmp();
    try {
      const inside = path.join(cwd, 'foo.txt');
      fs.writeFileSync(inside, '');
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'read_file', paths: [inside], cwd }), true);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test('read tool, dotfile inside cwd: auto-approves (no carve-out)', () => {
    const cwd = makeTmp();
    try {
      const dotfile = path.join(cwd, '.env');
      fs.writeFileSync(dotfile, 'TOKEN=secret');
      // No dotfile carve-out: cwd is the consent boundary.
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'read_file', paths: [dotfile], cwd }), true);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test('read tool, path outside cwd: forced to prompt', () => {
    const cwd = makeTmp();
    const outside = makeTmp();
    try {
      const outsideFile = path.join(outside, 'other.txt');
      fs.writeFileSync(outsideFile, '');
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'read_file', paths: [outsideFile], cwd }), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('symlink inside cwd pointing outside: forced to prompt (realpath catches escape)', () => {
    const cwd = makeTmp();
    const outside = makeTmp();
    try {
      const linkInsideCwd = path.join(cwd, 'escape');
      fs.symlinkSync(outside, linkInsideCwd);
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'read_file', paths: [linkInsideCwd], cwd }), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('write tool inside cwd: forced to prompt (writes never auto-approve)', () => {
    const cwd = makeTmp();
    try {
      const inside = path.join(cwd, 'foo.txt');
      fs.writeFileSync(inside, '');
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'write_file', paths: [inside], cwd }), false);
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'edit_file', paths: [inside], cwd }), false);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test('bash tool even with safe-looking argv: forced to prompt', () => {
    const cwd = makeTmp();
    try {
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'bash', paths: [], cwd }), false);
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'run_command', paths: [], cwd }), false);
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'exec', paths: [], cwd }), false);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test('find with -exec NOT in READ_SET: forced to prompt', () => {
    const cwd = makeTmp();
    try {
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'find', paths: [cwd], cwd }), false);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test('read tool with multiple path args, one outside cwd: all-or-nothing', () => {
    const cwd = makeTmp();
    const outside = makeTmp();
    try {
      const insidePath = path.join(cwd, 'a.txt');
      const outsidePath = path.join(outside, 'b.txt');
      fs.writeFileSync(insidePath, '');
      fs.writeFileSync(outsidePath, '');
      assert.equal(
        shouldAutoApproveToolPreflight({ tool: 'read_file', paths: [insidePath, outsidePath], cwd }),
        false,
        'one out-of-bounds path forces prompt for the whole request',
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('cwd equals path: auto-approves (boundary equality counts as containment)', () => {
    const cwd = makeTmp();
    try {
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'list_dir', paths: [cwd], cwd }), true);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test('isContainedIn never matches a sibling sharing prefix', () => {
    assert.equal(isContainedIn('/a/b-c', '/a/b'), false, 'no substring match — sep boundary required');
    assert.equal(isContainedIn('/a/b/c', '/a/b'), true);
    assert.equal(isContainedIn('/a/b', '/a/b'), true);
  });

  test('rejects invalid input shapes', () => {
    const cwd = makeTmp();
    try {
      assert.equal(shouldAutoApproveToolPreflight({}), false);
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'read_file', cwd }), false);
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'read_file', paths: null, cwd }), false);
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'read_file', paths: 'not-array', cwd }), false);
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'read_file', paths: [123], cwd }), false);
      assert.equal(shouldAutoApproveToolPreflight({ tool: null, paths: [], cwd }), false);
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'read_file', paths: [], cwd: null }), false);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test('empty paths array auto-approves a READ_SET tool (e.g. list_dir of cwd)', () => {
    const cwd = makeTmp();
    try {
      // Tools that take no path arguments still get auto-approved if in READ_SET.
      // (Callers can choose to require a non-empty paths array if their semantics differ.)
      assert.equal(shouldAutoApproveToolPreflight({ tool: 'read_file', paths: [], cwd }), true);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
