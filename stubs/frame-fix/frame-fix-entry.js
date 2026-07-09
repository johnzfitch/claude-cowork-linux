// Load frame fix first
require('./frame-fix-wrapper.js');

// Then load the real main entry.
//
// Newer asars (observed on 1.19367.0) split the Electron main entry in two:
//   .vite/build/index.pre.js  — the true entry. It stashes the
//     @sentry/electron/main namespace onto globalThis.__sentryElectronMain
//     and then require()s ./index.js itself.
//   .vite/build/index.js      — carries the yukonSilver/cowork patches, but
//     now begins with a "sentryMainShim" that THROWS if __sentryElectronMain
//     is unset.
// Loading index.js directly skips the stash and crashes on startup with
// "sentryMainShim: globalThis.__sentryElectronMain is unset". Loading
// index.pre.js runs the stash and then pulls in the (patched) index.js, so
// the patches still apply.
//
// Older asars (<= the 1.6259.1 baseline) have no index.pre.js, so fall back
// to index.js there. Detect at runtime rather than assuming either layout.
const fs = require('node:fs');
const path = require('node:path');

const preEntry = path.join(__dirname, '.vite', 'build', 'index.pre.js');
if (fs.existsSync(preEntry)) {
  require('./.vite/build/index.pre.js');
} else {
  require('./.vite/build/index.js');
}
