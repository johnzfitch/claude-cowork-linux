'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function existsExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function realpathSafe(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  if (p.charCodeAt(0) !== 47) return null;
  if (p.indexOf('\0') >= 0) return null;
  var segs = p.split('/');
  for (var i = 1; i < segs.length; i++) {
    if (segs[i] === '' || segs[i] === '.' || segs[i] === '..') return null;
  }
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return null;
  }
}

function createExecCapabilityRegistry({
  homedir = os.userInfo().homedir,
  resolveClaudeBinaryPath = null,
} = {}) {
  var home;
  try { home = fs.realpathSync(homedir); } catch (_) { home = homedir; }

  var SYSTEM_PATHS = Object.freeze({
    git:          Object.freeze(['/usr/bin/git', '/usr/local/bin/git']),
    bash:         Object.freeze(['/usr/bin/bash', '/bin/bash']),
    'xdg-open':   Object.freeze(['/usr/bin/xdg-open']),
    'xdg-mime':   Object.freeze(['/usr/bin/xdg-mime', '/usr/local/bin/xdg-mime']),
    which:        Object.freeze(['/usr/bin/which']),
    curl:         Object.freeze(['/usr/bin/curl', '/usr/local/bin/curl']),
    'notify-send':Object.freeze(['/usr/bin/notify-send']),
    gdbus:        Object.freeze(['/usr/bin/gdbus']),
  });

  var systemPathIndex = new Map();
  for (var name in SYSTEM_PATHS) {
    var paths = SYSTEM_PATHS[name];
    for (var pi = 0; pi < paths.length; pi++) {
      systemPathIndex.set(paths[pi], 'system-' + name);
    }
  }

  var USER_MCP_PREFIXES = Object.freeze([
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
  ]);

  var SYSTEM_CMD_PREFIXES = Object.freeze([
    '/usr/bin/',
    '/usr/local/bin/',
    '/usr/lib/',
    '/snap/bin/',
  ]);

  var CLAUDE_SEARCH_PATHS = Object.freeze([
    home + '/.local/bin/claude',
    home + '/.local/share/mise/shims/claude',
    home + '/.asdf/shims/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ]);

  var _claudeBinaryCache = undefined;

  function resolveClaudeCli() {
    if (_claudeBinaryCache !== undefined) return _claudeBinaryCache;
    if (typeof resolveClaudeBinaryPath === 'function') {
      var result = resolveClaudeBinaryPath();
      if (result) { _claudeBinaryCache = result; return result; }
    }
    for (var ci = 0; ci < CLAUDE_SEARCH_PATHS.length; ci++) {
      if (existsExecutable(CLAUDE_SEARCH_PATHS[ci])) {
        _claudeBinaryCache = CLAUDE_SEARCH_PATHS[ci];
        return _claudeBinaryCache;
      }
    }
    _claudeBinaryCache = null;
    return null;
  }

  function resolve(binaryPath, args) {
    if (typeof binaryPath !== 'string' || binaryPath.length === 0) return null;

    var real = realpathSafe(binaryPath);

    var claudePath = resolveClaudeCli();
    if (claudePath && (binaryPath === claudePath || real === claudePath)) {
      return { capabilityId: 'claude-cli', cmd: claudePath, args: args || [] };
    }

    if (real) {
      var sysId = systemPathIndex.get(real);
      if (sysId) {
        return { capabilityId: sysId, cmd: real, args: args || [] };
      }
    }

    if (!real) {
      console.warn('[exec-capability] BLOCKED (unresolvable): ' + binaryPath);
      return null;
    }

    for (var si = 0; si < SYSTEM_CMD_PREFIXES.length; si++) {
      if (real.startsWith(SYSTEM_CMD_PREFIXES[si])) {
        return { capabilityId: 'system-cmd', cmd: real, args: args || [] };
      }
    }

    for (var ui = 0; ui < USER_MCP_PREFIXES.length; ui++) {
      if (real.startsWith(USER_MCP_PREFIXES[ui])) {
        return { capabilityId: 'user-mcp', cmd: real, args: args || [] };
      }
    }

    console.warn('[exec-capability] BLOCKED: ' + binaryPath);
    return null;
  }

  var CAPABILITY_LABELS = Object.freeze({
    bash: 'Bash shell', git: 'Git',
    'xdg-open': 'XDG open', 'xdg-mime': 'XDG MIME query',
    which: 'which', curl: 'curl',
    'notify-send': 'notify-send', gdbus: 'D-Bus client',
  });

  function resolveCapability(id) {
    if (id === 'claude-cli') {
      var p = resolveClaudeCli();
      return p ? { exec: p, label: 'Claude Code CLI' } : null;
    }
    var name = typeof id === 'string' && id.startsWith('system-') ? id.slice(7) : null;
    if (name && SYSTEM_PATHS[name]) {
      var paths = SYSTEM_PATHS[name];
      for (var i = 0; i < paths.length; i++) {
        if (existsExecutable(paths[i])) return { exec: paths[i], label: CAPABILITY_LABELS[name] || name };
      }
    }
    return null;
  }

  function resolveDisclaimerCommand(args) {
    if (!Array.isArray(args) || args.length === 0) return null;
    var cmd = args[0];
    var rest = args.slice(1);
    if (/claude\.app\/Contents\/MacOS\/[Cc]laude$/.test(cmd)) {
      var claudePath = resolveClaudeCli();
      return claudePath ? { cmd: claudePath, rest: rest } : null;
    }
    var resolved = resolve(cmd, rest);
    return resolved ? { cmd: resolved.cmd, rest: rest } : null;
  }

  function invalidateClaudeCache() {
    _claudeBinaryCache = undefined;
  }

  return Object.freeze({
    resolve: resolve,
    resolveCapability: resolveCapability,
    resolveDisclaimerCommand: resolveDisclaimerCommand,
    invalidateClaudeCache: invalidateClaudeCache,
    SYSTEM_PATHS: SYSTEM_PATHS,
    USER_MCP_PREFIXES: USER_MCP_PREFIXES,
    SYSTEM_CMD_PREFIXES: SYSTEM_CMD_PREFIXES,
  });
}

module.exports = Object.freeze({
  createExecCapabilityRegistry: createExecCapabilityRegistry,
  realpathSafe: realpathSafe,
  existsExecutable: existsExecutable,
});
