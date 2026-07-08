// Load frame fix first
require('./frame-fix-wrapper.js');
// Then load the prelude entry (index.pre.js), which is the real main in the
// upstream package.json. It stashes the @sentry/electron/main namespace into
// globalThis.__sentryElectronMain and then require()s the patched main
// (index.js, which carries the yukonSilver patches). Loading index.js directly
// skips that stash, so the Sentry main shim throws
// "globalThis.__sentryElectronMain is unset" on Claude Desktop >= 1.19367.0.
require('./.vite/build/index.pre.js');
