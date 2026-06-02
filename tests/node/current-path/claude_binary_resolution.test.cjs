const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Regression coverage for issue #132: a claude-code-vm root that holds a
// binary which cannot run on Linux (a stale macOS Mach-O build, a dangling
// symlink, or a corrupt/partial download) must NOT be selected for spawn --
// doing so surfaces as "Claude Code process exited with code 127". The
// resolver should skip such entries and fall through to the native Linux
// binary (CLAUDE_CODE_PATH / ~/.local/bin/claude).

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x01, 0x01]); // ELF
const MACHO_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00]);      // Mach-O 64-bit

function stageStub(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-binresolve-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const tempHome = path.join(tempRoot, 'home');
  const tempRepoRoot = path.join(tempRoot, 'packed-app');
  const tempStubDir = path.join(tempRepoRoot, 'stubs', '@ant', 'claude-swift', 'js');
  const modulePath = path.join(tempStubDir, 'index.js');

  fs.mkdirSync(tempStubDir, { recursive: true });
  fs.mkdirSync(tempHome, { recursive: true });
  const repoRoot = path.join(__dirname, '..', '..', '..');
  // The stub requires ../../../../cowork relative to its js/ dir, so cowork
  // must sit at the temp repo root as a sibling of stubs/.
  fs.cpSync(path.join(repoRoot, 'stubs', 'cowork'), path.join(tempRepoRoot, 'cowork'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'stubs', '@ant', 'claude-swift', 'js', 'index.js'),
    modulePath,
  );
  return { tempHome, tempRepoRoot, modulePath };
}

function writeBinary(p, magic) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, magic);
  fs.chmodSync(p, 0o755);
}

// Run resolveClaudeBinaryPath() in a child process so DIRS picks up our
// temp HOME/XDG_CONFIG_HOME at module-load time.
function resolveInChild({ tempHome, tempRepoRoot, modulePath }, extraEnv = {}) {
  // Exit immediately after resolving so the stub's async event/log noise
  // doesn't append to our marker on stdout.
  const script = `
    const addon = require(${JSON.stringify(modulePath)});
    const r = addon.resolveClaudeBinaryPath();
    process.stdout.write('<<RESOLVED>>' + r + '<<END>>');
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: tempRepoRoot,
    env: {
      ...process.env,
      HOME: tempHome,
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      XDG_DATA_HOME: path.join(tempHome, '.local', 'share'),
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const m = /<<RESOLVED>>([\s\S]*?)<<END>>/.exec(child.stdout);
  assert.ok(m, 'resolver produced no output: ' + child.stdout);
  return m[1];
}

test('a Mach-O binary in claude-code-vm is skipped in favor of CLAUDE_CODE_PATH', (t) => {
  const ctx = stageStub(t);
  const vmBin = path.join(ctx.tempHome, '.config', 'Claude', 'claude-code-vm', '1.0.0', 'claude');
  writeBinary(vmBin, MACHO_MAGIC);

  const nativeBin = path.join(ctx.tempHome, '.local', 'bin', 'claude');
  writeBinary(nativeBin, ELF_MAGIC);

  const resolved = resolveInChild(ctx, { CLAUDE_CODE_PATH: nativeBin });
  assert.equal(resolved, nativeBin, 'should not select the Mach-O claude-code-vm binary');
});

test('a symlink resolving to a Mach-O binary is skipped', (t) => {
  const ctx = stageStub(t);
  const vmDir = path.join(ctx.tempHome, '.config', 'Claude', 'claude-code-vm', '1.0.0');
  fs.mkdirSync(vmDir, { recursive: true });
  // fs.existsSync() follows the link, so this passes the early existence
  // check and must be rejected by the realpath + magic-byte guard itself
  // (i.e. it exercises isRunnableLinuxBinary, not just the existsSync skip).
  const machoTarget = path.join(vmDir, 'claude.real');
  writeBinary(machoTarget, MACHO_MAGIC);
  fs.symlinkSync(machoTarget, path.join(vmDir, 'claude'));

  const nativeBin = path.join(ctx.tempHome, '.local', 'bin', 'claude');
  writeBinary(nativeBin, ELF_MAGIC);

  const resolved = resolveInChild(ctx, { CLAUDE_CODE_PATH: nativeBin });
  assert.equal(resolved, nativeBin, 'should not select a symlink to a Mach-O binary');
});

test('a dangling symlink in claude-code-vm is skipped', (t) => {
  const ctx = stageStub(t);
  const vmDir = path.join(ctx.tempHome, '.config', 'Claude', 'claude-code-vm', '1.0.0');
  fs.mkdirSync(vmDir, { recursive: true });
  fs.symlinkSync(path.join(ctx.tempHome, 'does-not-exist'), path.join(vmDir, 'claude'));

  const nativeBin = path.join(ctx.tempHome, '.local', 'bin', 'claude');
  writeBinary(nativeBin, ELF_MAGIC);

  const resolved = resolveInChild(ctx, { CLAUDE_CODE_PATH: nativeBin });
  assert.equal(resolved, nativeBin, 'should not select a dangling symlink');
});

test('a valid Linux ELF in claude-code-vm is preferred', (t) => {
  const ctx = stageStub(t);
  const vmBin = path.join(ctx.tempHome, '.config', 'Claude', 'claude-code-vm', '2.0.0', 'claude');
  writeBinary(vmBin, ELF_MAGIC);

  const resolved = resolveInChild(ctx);
  assert.equal(resolved, vmBin, 'a runnable Linux binary in claude-code-vm should win');
});
