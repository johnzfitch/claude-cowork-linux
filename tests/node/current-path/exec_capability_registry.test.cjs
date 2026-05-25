'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createExecCapabilityRegistry, realpathSafe, existsExecutable } = require(
  path.resolve(__dirname, '../../../stubs/cowork/exec_capability_registry.js')
);

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
        if (fs.existsSync('/usr/local/bin/claude')) {
          assert.ok(result);
          assert.strictEqual(result.cmd, '/usr/local/bin/claude');
          assert.deepStrictEqual(result.rest, ['--version']);
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
    });

    describe('user-mcp capability', () => {
      it('covers all previously allowed user dirs', () => {
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
