const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function createTempDir(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-mount-path-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return tempRoot;
}

test('vm.mountPath accepts canonical host paths and creates the requested directory', (t) => {
  const tempHome = createTempDir(t);
  const hostMountPath = path.join(tempHome, 'workspace', 'project');
  const tempRepoRoot = path.join(tempHome, 'packed-app');
  const tempCoworkRoot = path.join(tempRepoRoot, 'cowork');
  const tempStubDir = path.join(tempRepoRoot, 'stubs', '@ant', 'claude-swift', 'js');
  const modulePath = path.join(tempStubDir, 'index.js');

  fs.mkdirSync(tempStubDir, { recursive: true });
  fs.cpSync('/home/zack/dev/claude-cowork-linux-recovery/stubs/cowork', tempCoworkRoot, { recursive: true });
  fs.copyFileSync('/home/zack/dev/claude-cowork-linux-recovery/stubs/@ant/claude-swift/js/index.js', modulePath);

  const script = `
    const addon = require(${JSON.stringify(modulePath)});
    addon.vm.mountPath('proc-1', 'mnt/workspace', ${JSON.stringify(hostMountPath)}, 'rw')
      .then((result) => {
        if (!result || result.success !== true) {
          console.error('unexpected result', JSON.stringify(result));
          process.exit(2);
        }
        process.exit(0);
      })
      .catch((error) => {
        console.error(error && error.stack ? error.stack : String(error));
        process.exit(1);
      });
  `;

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: tempRepoRoot,
    env: {
      ...process.env,
      HOME: tempHome,
    },
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(fs.existsSync(hostMountPath), true);
  assert.equal(fs.statSync(hostMountPath).isDirectory(), true);
});
