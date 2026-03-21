'use strict';

// ============================================================================
// PORTAL GLOBAL SHORTCUTS
// ============================================================================
// Implements global keyboard shortcuts on Wayland via the xdg-desktop-portal
// GlobalShortcuts D-Bus API. This replaces Electron's globalShortcut.register()
// which uses X11 XGrabKey and silently fails on Wayland.
//
// Works on any compositor implementing the portal: KDE, Hyprland, GNOME 48+,
// wlroots-based (Sway, River), COSMIC, etc.
//
// Uses `gdbus` (ships with glib2) for D-Bus communication — no npm deps.

const { spawn, execFileSync } = require('child_process');

// ── Portal D-Bus constants ──────────────────────────────────────────────
const PORTAL_DEST = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const PORTAL_IFACE = 'org.freedesktop.portal.GlobalShortcuts';

// ── Accelerator translation ─────────────────────────────────────────────
// Electron: "Ctrl+Alt+Space", "CommandOrControl+Shift+P"
// Portal:   "<ctrl><alt>space", "<ctrl><shift>p"

const MODIFIER_MAP = {
  ctrl: '<ctrl>',
  control: '<ctrl>',
  alt: '<alt>',
  shift: '<shift>',
  super: '<super>',
  meta: '<super>',
  command: '<super>',
  commandorcontrol: '<ctrl>',
  cmdorctrl: '<ctrl>',
};

function electronAccelToPortal(accelerator) {
  const parts = accelerator.split('+');
  const key = parts.pop().toLowerCase();
  const mods = parts
    .map(m => MODIFIER_MAP[m.toLowerCase()] || '')
    .filter(Boolean)
    .join('');
  return mods + key;
}

function acceleratorToId(accelerator) {
  // Create a stable ID from the accelerator for portal shortcut identification
  return 'claude-' + accelerator.toLowerCase().replace(/[+\s]+/g, '-');
}

// ── Signal parsing ──────────────────────────────────────────────────────
// gdbus monitor outputs lines like:
//   /org/freedesktop/portal/desktop: org.freedesktop.portal.GlobalShortcuts.Activated (objectpath '...', 'shortcut-id', uint64 123, @a{sv} {})
//   /org/freedesktop/portal/desktop/request/1_123/token: org.freedesktop.portal.Request.Response (uint32 0, {'session_handle': <objectpath '...'>})

const ACTIVATED_RE = /GlobalShortcuts\.Activated\s*\([^,]+,\s*'([^']+)'/;
const RESPONSE_RE = /Request\.Response\s*\(uint32\s+(\d+),\s*\{(.*)\}\)/;
const SESSION_HANDLE_RE = /session_handle.*objectpath\s*'([^']+)'/;

function parseActivatedSignal(line) {
  const m = line.match(ACTIVATED_RE);
  return m ? m[1] : null;
}

function parseResponseSignal(line) {
  const m = line.match(RESPONSE_RE);
  if (!m) return null;
  const status = parseInt(m[1], 10);
  const body = m[2];
  const sessionMatch = body.match(SESSION_HANDLE_RE);
  return {
    status,
    sessionHandle: sessionMatch ? sessionMatch[1] : null,
  };
}

// ── Portal client ───────────────────────────────────────────────────────

function createPortalShortcuts() {
  const _shortcuts = new Map();   // accelerator → { id, callback, portalTrigger }
  let _sessionHandle = null;
  let _monitor = null;
  let _starting = null;
  let _available = null;        // null = unknown, true/false after check

  function isAvailable() {
    if (_available !== null) return _available;
    try {
      execFileSync('gdbus', ['introspect', '--session',
        '--dest', PORTAL_DEST,
        '--object-path', PORTAL_PATH,
      ], { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
      // Check that GlobalShortcuts interface exists
      const out = execFileSync('gdbus', ['introspect', '--session',
        '--dest', PORTAL_DEST,
        '--object-path', PORTAL_PATH,
      ], { timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      _available = out.includes('org.freedesktop.portal.GlobalShortcuts');
    } catch {
      _available = false;
    }
    return _available;
  }

  function gdbusSend(method, args) {
    return new Promise((resolve, reject) => {
      const child = spawn('gdbus', [
        'call', '--session',
        '--dest', PORTAL_DEST,
        '--object-path', PORTAL_PATH,
        '--method', `${PORTAL_IFACE}.${method}`,
        ...args,
      ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => {
        if (code !== 0) reject(new Error(`gdbus ${method} failed (${code}): ${stderr.trim()}`));
        else resolve(stdout.trim());
      });
      child.on('error', reject);
    });
  }

  function startMonitor() {
    if (_monitor) return;
    _monitor = spawn('gdbus', [
      'monitor', '--session',
      '--dest', PORTAL_DEST,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    _monitor.on('error', (err) => {
      console.error('[portal-shortcuts] Monitor error:', err.message);
      _monitor = null;
    });
    _monitor.on('close', () => {
      _monitor = null;
    });

    return _monitor;
  }

  function waitForResponse(monitor, requestPath, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Portal response timeout'));
      }, timeoutMs || 10000);

      function onData(chunk) {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          // Match response on our specific request path
          if (line.includes(requestPath) && line.includes('Response')) {
            const parsed = parseResponseSignal(line);
            if (parsed) {
              cleanup();
              resolve(parsed);
              return;
            }
          }
        }
      }

      function cleanup() {
        clearTimeout(timer);
        if (monitor && monitor.stdout) {
          monitor.stdout.removeListener('data', onData);
        }
      }

      monitor.stdout.on('data', onData);
    });
  }

  function listenForActivations(monitor) {
    monitor.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const shortcutId = parseActivatedSignal(line);
        if (shortcutId) {
          // Find the callback for this shortcut ID
          for (const [, entry] of _shortcuts) {
            if (entry.id === shortcutId && typeof entry.callback === 'function') {
              try { entry.callback(); } catch (e) {
                console.error('[portal-shortcuts] Callback error:', e.message);
              }
              break;
            }
          }
        }
      }
    });
  }

  async function ensureSession() {
    if (_sessionHandle) return _sessionHandle;
    if (_starting) return _starting;

    _starting = (async () => {
      try {
        const monitor = startMonitor();
        if (!monitor) throw new Error('Failed to start gdbus monitor');

        // Generate unique tokens for this session
        const pid = process.pid;
        const token = `claude_${pid}`;
        const reqToken = `claude_req_${pid}`;

        // CreateSession
        const createResult = await gdbusSend('CreateSession', [
          `{"session_handle_token": <"${token}">, "handle_token": <"${reqToken}">}`,
        ]);

        // Parse request path from result
        const reqPathMatch = createResult.match(/objectpath '([^']+)'/);
        if (!reqPathMatch) throw new Error('No request path in CreateSession response: ' + createResult);

        // Wait for the Response signal
        const response = await waitForResponse(monitor, reqPathMatch[1], 10000);
        if (response.status !== 0) {
          throw new Error('CreateSession rejected by portal (status ' + response.status + ')');
        }

        _sessionHandle = response.sessionHandle;
        if (!_sessionHandle) {
          // Construct from convention if not in response
          const busName = await getBusUniqueName();
          _sessionHandle = `/org/freedesktop/portal/desktop/session/${busName.replace(':', '').replace('.', '_')}/${token}`;
        }

        console.log('[portal-shortcuts] Session created:', _sessionHandle);

        // Start listening for activations
        listenForActivations(monitor);

        return _sessionHandle;
      } catch (e) {
        console.error('[portal-shortcuts] Session creation failed:', e.message);
        _sessionHandle = null;
        throw e;
      } finally {
        _starting = null;
      }
    })();

    return _starting;
  }

  async function getBusUniqueName() {
    try {
      const result = await gdbusSend('org.freedesktop.DBus.GetId', []);
      return result;
    } catch {
      return ':1.' + process.pid;
    }
  }

  async function bindAllShortcuts() {
    if (!_sessionHandle || _shortcuts.size === 0) return;

    // Build shortcuts array in GVariant format
    // Format: [("id", {"description": <"desc">, "preferred_trigger": <"<ctrl><alt>space">})]
    const shortcutEntries = [];
    for (const [, entry] of _shortcuts) {
      shortcutEntries.push(
        `("${entry.id}", {"description": <"${entry.description || 'Claude shortcut'}">, "preferred_trigger": <"${entry.portalTrigger}">})`
      );
    }
    const shortcutsArg = `[${shortcutEntries.join(', ')}]`;

    const reqToken = `claude_bind_${Date.now()}`;
    try {
      await gdbusSend('BindShortcuts', [
        `objectpath '${_sessionHandle}'`,
        shortcutsArg,
        '""',
        `{"handle_token": <"${reqToken}">}`,
      ]);
      console.log('[portal-shortcuts] Bound', _shortcuts.size, 'shortcut(s)');
    } catch (e) {
      console.error('[portal-shortcuts] BindShortcuts failed:', e.message);
    }
  }

  // ── Public API (matches Electron's globalShortcut interface) ──────────

  async function register(accelerator, callback) {
    if (!isAvailable()) return false;

    const id = acceleratorToId(accelerator);
    const portalTrigger = electronAccelToPortal(accelerator);

    _shortcuts.set(accelerator, {
      id,
      callback,
      portalTrigger,
      description: 'Claude: ' + accelerator,
    });

    try {
      await ensureSession();
      await bindAllShortcuts();
      console.log('[portal-shortcuts] Registered:', accelerator, '→', portalTrigger);
      return true;
    } catch (e) {
      console.warn('[portal-shortcuts] Failed to register', accelerator, ':', e.message);
      return false;
    }
  }

  function unregister(accelerator) {
    _shortcuts.delete(accelerator);
    if (_sessionHandle && _shortcuts.size > 0) {
      bindAllShortcuts().catch(() => {});
    }
    // If no shortcuts left, the session stays alive but idle
  }

  function unregisterAll() {
    _shortcuts.clear();
    if (_sessionHandle) {
      bindAllShortcuts().catch(() => {});
    }
  }

  function isRegistered(accelerator) {
    return _shortcuts.has(accelerator);
  }

  function destroy() {
    _shortcuts.clear();
    _sessionHandle = null;
    if (_monitor) {
      _monitor.kill();
      _monitor = null;
    }
  }

  return {
    register,
    unregister,
    unregisterAll,
    isRegistered,
    isAvailable,
    destroy,
    // Exported for testing
    _electronAccelToPortal: electronAccelToPortal,
    _acceleratorToId: acceleratorToId,
    _parseActivatedSignal: parseActivatedSignal,
    _parseResponseSignal: parseResponseSignal,
  };
}

module.exports = { createPortalShortcuts };
