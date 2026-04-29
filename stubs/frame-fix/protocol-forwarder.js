// protocol-forwarder.js
// Minimal Electron entry point used ONLY when invoked with a claude:// URL.
//
// Two cases:
//   1. Main app IS running: requestSingleInstanceLock() returns false → main app gets
//      'second-instance' with our argv (including the claude:// URL) → handles it → we quit.
//   2. Main app is NOT running: requestSingleInstanceLock() returns true → we got the lock
//      but nobody is listening. Fall back to launching the full app via launch.sh.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');

const logDir = process.env.CLAUDE_LOG_DIR ||
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'claude-cowork', 'logs');
const logFile = path.join(logDir, 'startup.log');

function log(msg) {
  const line = `[protocol-forwarder] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(logFile, line); } catch (_) {}
}

log(`started, argv: ${process.argv.slice(2).join(' ')}`);

// Must match the app name set in frame-fix-wrapper.js before requestSingleInstanceLock(),
// so both processes use the same userData path (~/.config/Claude/SingletonLock).
app.setName('Claude');
log(`userData: ${app.getPath('userData')}`);

const gotLock = app.requestSingleInstanceLock();
log(`requestSingleInstanceLock() returned: ${gotLock}`);

if (!gotLock) {
  // Main app is running and received 'second-instance' with our argv. Done.
  log('main app is running — forwarded via second-instance, quitting');
  app.quit();
} else {
  // No running instance. Launch the full app with the claude:// URL in argv
  // so frame-fix-wrapper.js can emit it via open-url once the asar is ready.
  log('no running instance — launching full app with URL');
  app.releaseSingleInstanceLock();

  const coworkDir = process.env.COWORK_DIR ||
    path.join(os.homedir(), '.local', 'share', 'claude-desktop');
  const launchSh = path.join(coworkDir, 'launch.sh');
  const url = process.argv.find(a => a.startsWith('claude://')) || '';

  log(`launching: bash ${launchSh} ${url}`);
  execFile('bash', [launchSh, url], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  }).unref();

  app.quit();
}
