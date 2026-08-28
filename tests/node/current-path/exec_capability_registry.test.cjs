'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createExecCapabilityRegistry, realpathSafe, existsExecutable } = require(
  path.resolve(__dirname, '../../../stubs/cowork/exec_capability_registry.js')
);

// Admission for user binaries is now the user's declaration, so fixtures build a
// real config and point the registry at it. env is scoped to the fixture home so
// these never read the developer's own MCP config.
function writeDesktopConfig(tmpHome, mcpServers) {
  const configDir = path.join(tmpHome, '.config', 'Claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'claude_desktop_config.json'),
    JSON.stringify({ mcpServers }),
    'utf8'
  );
}

function makeRegistry(tmpHome, overrides = {}) {
  return createExecCapabilityRegistry({
    homedir: tmpHome,
    env: {
      XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
      CLAUDE_CONFIG_DIR: tmpHome,
      PATH: process.env.PATH || '/usr/bin:/bin',
    },
    ...overrides,
  });
}

function declaredServer(t, name) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-execreg-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
  const binDir = path.join(tmpHome, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const server = path.join(binDir, name);
  fs.writeFileSync(server, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeDesktopConfig(tmpHome, { [name]: { command: server } });
  return { registry: makeRegistry(tmpHome), server, tmpHome };
}

describe('exec_capability_registry', () => {
  describe('realpathSafe', () => {
    it('rejects non-strings', () => {
      assert.strictEqual(realpathSafe(null), null);
      assert.strictEqual(realpathSafe(undefined), null);
      assert.strictEqual(realpathSafe(123), null);
    });

    it('rejects empty strings', () => {
      assert.strictEqual(realpathSafe(''), null);
    });

    it('rejects relative paths', () => {
      assert.strictEqual(realpathSafe('relative/path'), null);
    });

    it('rejects paths with null bytes', () => {
      assert.strictEqual(realpathSafe('/usr/bin/\0git'), null);
    });

    it('rejects paths with dot segments', () => {
      assert.strictEqual(realpathSafe('/usr/../etc/passwd'), null);
      assert.strictEqual(realpathSafe('/usr/./bin/git'), null);
    });

    it('rejects paths with empty segments', () => {
      assert.strictEqual(realpathSafe('/usr//bin/git'), null);
    });

    it('resolves valid existing paths', () => {
      const result = realpathSafe('/usr/bin');
      assert.ok(result !== null);
      assert.ok(result.startsWith('/'));
    });
  });

  describe('existsExecutable', () => {
    it('returns true for existing executables', () => {
      const candidates = ['/usr/bin/bash', '/bin/bash'];
      const exists = candidates.some(p => existsExecutable(p));
      assert.ok(exists, 'bash should exist on the system');
    });

    it('returns false for non-existent paths', () => {
      assert.strictEqual(existsExecutable('/nonexistent/binary'), false);
    });
  });

  describe('createExecCapabilityRegistry', () => {
    let registry;

    beforeEach(() => {
      registry = createExecCapabilityRegistry({
        homedir: os.homedir(),
        resolveClaudeBinaryPath: () => null,
      });
    });

    it('returns a frozen object', () => {
      assert.ok(Object.isFrozen(registry));
    });

    it('exposes expected methods', () => {
      assert.strictEqual(typeof registry.resolve, 'function');
      assert.strictEqual(typeof registry.resolveCapability, 'function');
      assert.strictEqual(typeof registry.resolveDisclaimerCommand, 'function');
      assert.strictEqual(typeof registry.invalidateClaudeCache, 'function');
    });

    it('exposes frozen path arrays', () => {
      assert.ok(Object.isFrozen(registry.SYSTEM_PATHS));
      assert.ok(Object.isFrozen(registry.USER_MCP_PREFIXES));
      assert.ok(Object.isFrozen(registry.SYSTEM_CMD_PREFIXES));
    });

    describe('resolve', () => {
      it('rejects null/undefined/empty', () => {
        assert.strictEqual(registry.resolve(null, []), null);
        assert.strictEqual(registry.resolve(undefined, []), null);
        assert.strictEqual(registry.resolve('', []), null);
      });

      it('resolves system binaries', () => {
        const bash = ['/usr/bin/bash', '/bin/bash'].find(p => fs.existsSync(p));
        if (bash) {
          const result = registry.resolve(bash, ['--version']);
          assert.ok(result);
          assert.ok(result.capabilityId.startsWith('system-'));
        }
      });

      it('resolves system commands by prefix', () => {
        const git = ['/usr/bin/git', '/usr/local/bin/git'].find(p => fs.existsSync(p));
        if (git) {
          const result = registry.resolve(git, ['status']);
          assert.ok(result);
          assert.ok(['system-git', 'system-cmd'].includes(result.capabilityId));
        }
      });

      it('rejects paths outside all registries', () => {
        const result = registry.resolve('/opt/malicious/binary', []);
        assert.strictEqual(result, null);
      });

      it('rejects path traversal', () => {
        const result = registry.resolve('/usr/bin/../../../etc/shadow', []);
        assert.strictEqual(result, null);
      });
    });

    describe('resolveCapability', () => {
      it('resolves system-bash', () => {
        const cap = registry.resolveCapability('system-bash');
        if (cap) {
          assert.ok(cap.exec);
          assert.strictEqual(cap.label, 'Bash shell');
        }
      });

      it('resolves system-git', () => {
        const cap = registry.resolveCapability('system-git');
        if (cap) {
          assert.ok(cap.exec);
          assert.strictEqual(cap.label, 'Git');
        }
      });

      it('returns null for unknown capabilities', () => {
        assert.strictEqual(registry.resolveCapability('unknown-cap'), null);
        assert.strictEqual(registry.resolveCapability(''), null);
      });
    });

    describe('resolveDisclaimerCommand', () => {
      it('rejects empty/null args', () => {
        assert.strictEqual(registry.resolveDisclaimerCommand(null), null);
        assert.strictEqual(registry.resolveDisclaimerCommand([]), null);
        assert.strictEqual(registry.resolveDisclaimerCommand('not-array'), null);
      });

      it('resolves macOS Claude.app path to claude-cli', () => {
        const reg = createExecCapabilityRegistry({
          homedir: os.homedir(),
          resolveClaudeBinaryPath: () => '/usr/local/bin/claude',
        });
        const result = reg.resolveDisclaimerCommand([
          '/Applications/Claude.app/Contents/MacOS/Claude',
          '--version',
        ]);
        // Not guarded on existsSync: resolveClaudeCli() returns whatever
        // resolveClaudeBinaryPath gives it without touching the filesystem, so
        // the old guard only had the effect of skipping these assertions
        // wherever /usr/local/bin/claude was absent -- which is why the
        // capital-C path failing to match went unnoticed.
        assert.ok(result);
        assert.strictEqual(result.cmd, '/usr/local/bin/claude');
        assert.deepStrictEqual(result.rest, ['--version']);
      });

      it('resolves a non-.app claude path (e.g. claude-code-vm) by basename to claude-cli', () => {
        // Regression for #132: before this, only the macOS .app path was
        // recognised; a claude-code-vm/<ver>/claude path fell through, the
        // disclaimer unwrap returned null, and the exit-127 stub ran instead.
        const reg = createExecCapabilityRegistry({
          homedir: os.homedir(),
          resolveClaudeBinaryPath: () => '/usr/local/bin/claude',
        });
        const result = reg.resolveDisclaimerCommand([
          '/home/u/.config/Claude/claude-code-vm/2.0.0/claude',
          '-p', 'hi',
        ]);
        assert.ok(result, 'a claude-basename path must unwrap, not fall through to the stub');
        assert.strictEqual(result.cmd, '/usr/local/bin/claude');
        assert.deepStrictEqual(result.rest, ['-p', 'hi']);
      });

      it('resolves a claude path passed with a leading -- separator (Code tab / HostCLIRunner)', () => {
        // HostCLIRunner (Code tab) invokes the wrapper as
        // `disclaimer -- <cmd> <args...>` -- a leading `--` with no command
        // in args[0]. Before this fix, cmd read args[0] unconditionally, saw
        // the literal string "--", matched neither the claude.app regex nor
        // the basename check, and fell through to the exit-127 stub on every
        // Code-tab session -- same failure mode as #132, a different argv
        // shape at a different call site.
        const reg = createExecCapabilityRegistry({
          homedir: os.homedir(),
          resolveClaudeBinaryPath: () => '/usr/local/bin/claude',
        });
        const result = reg.resolveDisclaimerCommand([
          '--',
          '/home/u/.config/Claude/claude-code/2.1.246/claude.app/Contents/MacOS/claude',
        ]);
        assert.ok(result, 'a leading -- must be skipped, not treated as the command');
        assert.strictEqual(result.cmd, '/usr/local/bin/claude');
        assert.deepStrictEqual(result.rest, []);
      });

      it('rejects a bare -- with no following command', () => {
        const result = registry.resolveDisclaimerCommand(['--']);
        assert.strictEqual(result, null);
      });

      // Why the wrap/unwrap round-trip is kept rather than patched out of the
      // bundle. The asar sets pathToClaudeCodeExecutable from Ql({cmd:r}): with
      // the wrap it is the disclaimer binary and r rides in argv, so this unwrap
      // gets to swap in OUR resolved binary. Neutralise the wrap and the SDK is
      // handed r unchanged -- the asar's claude-code-vm or .app path -- and the
      // substitution never happens. The substitution IS the #132 fix, so it has
      // to survive whatever path the asar picks.
      it('substitutes our resolved binary for every claude path the asar can pick', () => {
        const reg = createExecCapabilityRegistry({
          homedir: os.homedir(),
          resolveClaudeBinaryPath: () => '/usr/local/bin/claude',
        });
        const asarPicks = [
          '/Applications/Claude.app/Contents/MacOS/Claude',
          '/home/u/.config/Claude/claude-code-vm/2.0.0/claude',
          '/home/u/.local/bin/claude',
        ];
        for (const picked of asarPicks) {
          const result = reg.resolveDisclaimerCommand([picked]);
          assert.ok(result, 'must unwrap, not fall through to the exit-127 stub: ' + picked);
          assert.strictEqual(result.cmd, '/usr/local/bin/claude',
            'the asar path must be replaced by ours, never spawned as given: ' + picked);
        }
      });

      it('resolves system binary commands', () => {
        const git = ['/usr/bin/git', '/usr/local/bin/git'].find(p => fs.existsSync(p));
        if (git) {
          const result = registry.resolveDisclaimerCommand([git, 'status']);
          assert.ok(result);
          assert.strictEqual(result.cmd, git);
          assert.deepStrictEqual(result.rest, ['status']);
        }
      });

      it('rejects binaries outside registry', () => {
        const result = registry.resolveDisclaimerCommand(['/opt/evil/hack', '--rm-rf']);
        assert.strictEqual(result, null);
      });

      // The invariant that closes #132/#164 as a class. The disclaimer wrapper
      // is a platform adapter, not a policy layer: the set of commands the
      // bundle routes through it grows between builds, so any admission rule
      // that lives HERE rather than in resolve() goes stale and blocks a
      // legitimate caller. Unwrap must agree with resolve() for every class.
      // The Claude CLI is exempt: that path is deliberate translation (a
      // macOS-shaped path mapped to our own binary), not an admission decision.
      it('agrees with resolve() for every capability class', (t) => {
        const home = fs.realpathSync(os.homedir());
        const candidates = [
          ...['/usr/bin/git', '/usr/local/bin/git', '/usr/bin/curl', '/usr/bin/env', '/bin/bash']
            .filter((p) => fs.existsSync(p)),
          home + '/.local/bin/some-mcp-server',
          home + '/.cargo/bin/some-mcp-server',
          '/opt/evil/hack',
          '/nonexistent/nope',
        ];
        for (const cmd of candidates) {
          const direct = registry.resolve(cmd, ['--flag']);
          const unwrapped = registry.resolveDisclaimerCommand([cmd, '--flag']);
          assert.strictEqual(
            unwrapped === null, direct === null,
            'disclaimer unwrap and resolve() disagree on admitting ' + cmd
          );
          if (direct && unwrapped) {
            assert.strictEqual(
              unwrapped.cmd, direct.cmd,
              'disclaimer unwrap and resolve() disagree on the target for ' + cmd
            );
          }
        }
      });

      it('admits a declared MCP server (regression for #164)', (t) => {
        const { registry: reg, server } = declaredServer(t, 'desktop-commander');
        const result = reg.resolveDisclaimerCommand([server, '--stdio']);
        assert.ok(result, 'a declared MCP server must unwrap, not hit the exit-127 stub');
        assert.strictEqual(result.cmd, server);
        assert.deepStrictEqual(result.rest, ['--stdio']);
      });
    });

    describe('user-mcp capability', () => {
      // Admission is the user's own declaration, not the binary's location.
      // A location allowlist is unbounded in what it permits -- anything the
      // user drops in ~/.local/bin -- and still misses the npm-global case,
      // because package managers symlink out of bin/ into directories no prefix
      // names (#164). Matching the declaration is tighter in both directions.
      function withShim(t, targetRelative, { declare = true } = {}) {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-execreg-'));
        t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
        const binDir = path.join(tmpHome, '.local', 'bin');
        const target = path.join(tmpHome, targetRelative);
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '#!/usr/bin/env node\n', { mode: 0o755 });
        const shim = path.join(binDir, 'mcp-server');
        fs.symlinkSync(target, shim);
        if (declare) writeDesktopConfig(tmpHome, { 'mcp-server': { command: shim } });
        return { registry: makeRegistry(tmpHome), shim, target };
      }

      it('admits an npm-global shim whose target is outside every bin/ prefix', (t) => {
        const { registry: reg, shim } = withShim(t, '.local/lib/node_modules/pkg/dist/index.js');
        const result = reg.resolve(shim, ['--stdio']);
        assert.ok(result, 'a declared shim must resolve even when its target sits elsewhere');
        assert.strictEqual(result.capabilityId, 'user-mcp');
      });

      it('matches either spelling: declaration names the shim, spawn names the target', (t) => {
        const { registry: reg, target } = withShim(t, '.local/lib/node_modules/pkg/dist/index.js');
        const result = reg.resolve(target, []);
        assert.ok(result, 'the realpath of a declared shim names the same file and must match');
        assert.strictEqual(result.capabilityId, 'user-mcp');
      });

      it('spawns the path as requested rather than its realpath', (t) => {
        const { registry: reg, shim, target } = withShim(t, '.local/lib/node_modules/pkg/dist/index.js');
        const result = reg.resolve(shim, []);
        assert.strictEqual(result.cmd, shim,
          'argv[0] and wrapper semantics belong to the shim; the realpath is a path the user never named');
        assert.notStrictEqual(result.cmd, target);
      });

      // The tightening, stated as a test: sitting in an allowlisted directory
      // used to be sufficient and no longer is. This is the case the old
      // location rule admitted and a declaration-based rule refuses.
      it('refuses an undeclared executable sitting in ~/.local/bin', (t) => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-execreg-'));
        t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
        const binDir = path.join(tmpHome, '.local', 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        const stray = path.join(binDir, 'stray');
        fs.writeFileSync(stray, '#!/bin/sh\n', { mode: 0o755 });
        writeDesktopConfig(tmpHome, {});
        assert.strictEqual(makeRegistry(tmpHome).resolve(stray, []), null,
          'location is no longer sufficient; only a declared command is admitted');
      });

      // The loosening, equally deliberate: a declaration outside every prefix is
      // honoured, because the user named it.
      it('admits a declared server that no prefix covers', (t) => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-execreg-'));
        t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
        const vendored = path.join(tmpHome, 'opt', 'vendor', 'server');
        fs.mkdirSync(path.dirname(vendored), { recursive: true });
        fs.writeFileSync(vendored, '#!/bin/sh\n', { mode: 0o755 });
        writeDesktopConfig(tmpHome, { vendor: { command: vendored } });
        const result = makeRegistry(tmpHome).resolve(vendored, []);
        assert.ok(result, 'a declared command is admitted wherever the user put it');
        assert.strictEqual(result.capabilityId, 'user-mcp');
      });

      it('reads declarations from .claude.json, including per-project servers', (t) => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-execreg-'));
        t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
        const projectRoot = path.join(tmpHome, 'work', 'proj');
        const server = path.join(tmpHome, 'tools', 'proj-mcp');
        fs.mkdirSync(projectRoot, { recursive: true });
        fs.mkdirSync(path.dirname(server), { recursive: true });
        fs.writeFileSync(server, '#!/bin/sh\n', { mode: 0o755 });
        fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({
          projects: { [projectRoot]: { mcpServers: { proj: { command: server } } } },
        }), 'utf8');
        const result = makeRegistry(tmpHome).resolve(server, []);
        assert.ok(result, 'per-project declarations in .claude.json must count');
        assert.strictEqual(result.capabilityId, 'user-mcp');
      });

      it('reads declarations from a project .mcp.json', (t) => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-execreg-'));
        t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
        const projectRoot = path.join(tmpHome, 'work', 'proj');
        const server = path.join(tmpHome, 'tools', 'file-mcp');
        fs.mkdirSync(projectRoot, { recursive: true });
        fs.mkdirSync(path.dirname(server), { recursive: true });
        fs.writeFileSync(server, '#!/bin/sh\n', { mode: 0o755 });
        fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({
          projects: { [projectRoot]: {} },
        }), 'utf8');
        fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({
          mcpServers: { files: { command: server } },
        }), 'utf8');
        const result = makeRegistry(tmpHome).resolve(server, []);
        assert.ok(result, 'project-scoped .mcp.json declarations must count');
        assert.strictEqual(result.capabilityId, 'user-mcp');
      });

      it('blocks a dangling declaration (target must exist)', (t) => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-execreg-'));
        t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
        const binDir = path.join(tmpHome, '.local', 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        const shim = path.join(binDir, 'gone');
        fs.symlinkSync(path.join(tmpHome, 'never', 'existed'), shim);
        writeDesktopConfig(tmpHome, { gone: { command: shim } });
        assert.strictEqual(makeRegistry(tmpHome).resolve(shim, []), null);
      });

      it('picks up a newly declared server without a restart', (t) => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-execreg-'));
        t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
        const server = path.join(tmpHome, 'tools', 'late-mcp');
        fs.mkdirSync(path.dirname(server), { recursive: true });
        fs.writeFileSync(server, '#!/bin/sh\n', { mode: 0o755 });
        writeDesktopConfig(tmpHome, {});
        const reg = makeRegistry(tmpHome);
        assert.strictEqual(reg.resolve(server, []), null, 'undeclared to begin with');
        writeDesktopConfig(tmpHome, { late: { command: server } });
        const after = reg.resolve(server, []);
        assert.ok(after, 'editing the config must take effect without relaunching');
        assert.strictEqual(after.capabilityId, 'user-mcp');
      });

      // USER_MCP_PREFIXES no longer admits anything; it only shapes the refusal
      // message. Kept pinned so the list doesn't get deleted as dead weight and
      // take the actionable "declare it in mcpServers" hint with it.
      it('keeps the user dir list for diagnostics only', () => {
        const home = os.homedir();
        const expectedPrefixes = [
          home + '/.local/bin/',
          home + '/.npm-global/bin/',
          home + '/.cargo/bin/',
          home + '/go/bin/',
          home + '/.bun/bin/',
          home + '/.deno/bin/',
          home + '/.local/share/mise/shims/',
          home + '/.asdf/shims/',
          home + '/.volta/bin/',
          home + '/bin/',
        ];
        for (const prefix of expectedPrefixes) {
          assert.ok(
            registry.USER_MCP_PREFIXES.includes(prefix),
            'Missing user MCP prefix: ' + prefix
          );
        }
      });
    });

    describe('system cmd capability', () => {
      it('covers all previously allowed system dirs', () => {
        const expectedPrefixes = ['/usr/bin/', '/usr/local/bin/', '/usr/lib/', '/snap/bin/'];
        for (const prefix of expectedPrefixes) {
          assert.ok(
            registry.SYSTEM_CMD_PREFIXES.includes(prefix),
            'Missing system cmd prefix: ' + prefix
          );
        }
      });
    });

    describe('invalidateClaudeCache', () => {
      it('can be called without error', () => {
        assert.doesNotThrow(() => registry.invalidateClaudeCache());
      });
    });
  });
});
