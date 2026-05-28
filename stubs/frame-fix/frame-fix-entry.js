// Load frame fix first
require('./frame-fix-wrapper.js');
// Then load via index.pre.js (sets up logging, userData, etc.) which requires index.js itself
require('./.vite/build/index.pre.js');
