// Load frame fix first
require('./frame-fix-wrapper.js');
// Load the app's real main entry.
//
// Newer Claude Desktop builds split the main process into two files:
//   index.pre.js  — stashes the @sentry/electron/main namespace on
//                   globalThis.__sentryElectronMain, then require()s index.js
//   index.js      — the real main; a sentry shim guard throws
//                   "globalThis.__sentryElectronMain is unset" if index.pre.js
//                   did not run first.
// Requiring index.js directly skips the stash and crashes the main process on
// launch. Load index.pre.js when present (it chains to index.js itself); fall
// back to index.js for older single-entry builds that ship no index.pre.js.
const fs = require('fs');
const path = require('path');
const preEntry = path.join(__dirname, '.vite', 'build', 'index.pre.js');
require(fs.existsSync(preEntry) ? './.vite/build/index.pre.js' : './.vite/build/index.js');
