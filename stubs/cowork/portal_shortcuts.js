'use strict';

// ============================================================================
// PORTAL GLOBAL SHORTCUTS — inline D-Bus client
// ============================================================================
// Implements global keyboard shortcuts on Wayland via the xdg-desktop-portal
// GlobalShortcuts D-Bus API. Replaces Electron's globalShortcut.register()
// which uses X11 XGrabKey and silently fails on Wayland.
//
// Uses a minimal D-Bus wire protocol client over the session bus Unix socket.
// No npm dependencies, no child processes — runs inline in the Electron main
// process. Works on any compositor implementing the portal: KDE, Hyprland,
// GNOME 48+, wlroots-based (Sway, River), COSMIC, etc.

const net = require('net');

// ── Constants ───────────────────────────────────────────────────────────
const LE = 0x6C;
const METHOD_CALL = 1;
const METHOD_RETURN = 2;
const MSG_ERROR = 3;
const SIGNAL = 4;

const PORTAL_DEST = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const PORTAL_IFACE = 'org.freedesktop.portal.GlobalShortcuts';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';

// ── Accelerator translation ─────────────────────────────────────────────
const MODIFIER_MAP = {
  ctrl: '<ctrl>', control: '<ctrl>',
  alt: '<alt>', shift: '<shift>',
  super: '<super>', meta: '<super>', command: '<super>',
  commandorcontrol: '<ctrl>', cmdorctrl: '<ctrl>',
};

function electronAccelToPortal(accel) {
  const parts = accel.split('+');
  const key = parts.pop().toLowerCase();
  return parts.map(m => MODIFIER_MAP[m.toLowerCase()] || '').filter(Boolean).join('') + key;
}

function acceleratorToId(accel) {
  return 'claude-' + accel.toLowerCase().replace(/[+\s]+/g, '-');
}

// ── D-Bus wire protocol helpers ─────────────────────────────────────────
// All little-endian. We only implement enough to talk to the portal.

function pad(off, n) { return (off + n - 1) & ~(n - 1); }

// Write a header field struct: byte(code) + variant(sig, value)
// Each struct is 8-byte aligned.
function writeHeaderField(buf, off, code, sig, value) {
  off = pad(off, 8);
  buf[off++] = code;
  // variant signature
  buf[off++] = 1;            // sig length = 1
  buf[off++] = sig.charCodeAt(0);
  buf[off++] = 0;            // sig nul
  if (sig === 's' || sig === 'o') {
    buf.writeUInt32LE(value.length, off); off += 4;
    buf.write(value, off); off += value.length;
    buf[off++] = 0;
  } else if (sig === 'g') {
    buf[off++] = value.length;
    buf.write(value, off); off += value.length;
    buf[off++] = 0;
  }
  return off;
}

function buildMessage(type, serial, dest, path, iface, member, bodySig, bodyBuf, bodyLen) {
  const hf = Buffer.alloc(512);
  let h = 0;
  h = writeHeaderField(hf, h, 1, 'o', path);      // PATH
  if (iface) h = writeHeaderField(hf, h, 2, 's', iface);  // INTERFACE
  h = writeHeaderField(hf, h, 3, 's', member);     // MEMBER
  h = writeHeaderField(hf, h, 6, 's', dest);       // DESTINATION
  if (bodySig) h = writeHeaderField(hf, h, 8, 'g', bodySig); // SIGNATURE
  const hfLen = h;

  const headerTotal = 12 + 4 + hfLen;
  const headerPad = (8 - (headerTotal % 8)) % 8;
  const bLen = bodyLen || 0;
  const msg = Buffer.alloc(headerTotal + headerPad + bLen);

  let m = 0;
  msg[m++] = LE;
  msg[m++] = type;
  msg[m++] = 0;          // flags
  msg[m++] = 1;          // protocol version
  msg.writeUInt32LE(bLen, m); m += 4;   // body length
  msg.writeUInt32LE(serial, m); m += 4; // serial
  msg.writeUInt32LE(hfLen, m); m += 4;  // header fields array length
  hf.copy(msg, m, 0, hfLen); m += hfLen;
  m = pad(m, 8); // pad before body
  if (bodyBuf && bLen > 0) {
    bodyBuf.copy(msg, m, 0, bLen);
  }
  return msg;
}

// Body marshalling helpers
// D-Bus strings ('s', 'o') have 4-byte alignment: pad + UINT32 length + data + NUL
function bWriteStr(buf, off, s) {
  off = pad(off, 4);
  buf.writeUInt32LE(s.length, off); off += 4;
  buf.write(s, off); off += s.length;
  buf[off++] = 0;
  return off;
}

function bWriteObjPath(buf, off, s) { return bWriteStr(buf, off, s); }

function bWriteVariantStr(buf, off, s) {
  // variant: SIGNATURE (1-byte len + sig + NUL) + value (aligned per type)
  buf[off++] = 1; buf[off++] = 0x73; buf[off++] = 0; // sig: 's'
  // bWriteStr pads to 4-byte alignment for the string value
  return bWriteStr(buf, off, s);
}

// Write a{sv} dict with string→string entries
// D-Bus arrays: UINT32 length + alignment padding + elements
// The length does NOT include the alignment padding (per spec)
function bWriteDictSV(buf, off, entries) {
  off = pad(off, 4); // arrays have 4-byte alignment (for the UINT32 length)
  const lenPos = off;
  off += 4;
  const dataStart = pad(off, 8); // dict entries ({sv}) are 8-byte aligned
  let aOff = dataStart;
  for (const [key, val] of entries) {
    aOff = pad(aOff, 8); // each dict entry struct aligns to 8
    aOff = bWriteStr(buf, aOff, key);
    aOff = bWriteVariantStr(buf, aOff, val);
  }
  buf.writeUInt32LE(aOff - dataStart, lenPos); // array byte length (excludes padding)
  return aOff;
}

// ── Message parsing ─────────────────────────────────────────────────────

// Read functions respect D-Bus alignment rules (alignment relative to body/stream start)
function readStr(buf, off) {
  off = pad(off, 4); // string type has 4-byte alignment
  const len = buf.readUInt32LE(off);
  return { v: buf.toString('utf8', off + 4, off + 4 + len), end: off + 4 + len + 1 };
}

function readObjPath(buf, off) { return readStr(buf, off); }

function readSig(buf, off) {
  // SIGNATURE type has 1-byte alignment: byte(len) + chars + NUL
  const len = buf[off];
  return { v: buf.toString('utf8', off + 1, off + 1 + len), end: off + 1 + len + 1 };
}

function readVariant(buf, off) {
  const sig = readSig(buf, off); off = sig.end;
  if (sig.v === 's' || sig.v === 'o') return readStr(buf, off);
  if (sig.v === 'u') { off = pad(off, 4); return { v: buf.readUInt32LE(off), end: off + 4 }; }
  if (sig.v === 'b') { off = pad(off, 4); return { v: buf.readUInt32LE(off) !== 0, end: off + 4 }; }
  if (sig.v === 't') {
    off = pad(off, 8);
    const lo = buf.readUInt32LE(off), hi = buf.readUInt32LE(off + 4);
    return { v: hi * 0x100000000 + lo, end: off + 8 };
  }
  if (sig.v === 'g') return readSig(buf, off); // SIGNATURE value
  if (sig.v === 'v') return readVariant(buf, off);
  return { v: null, end: off };
}

function parseMsg(buf) {
  if (buf.length < 16 || buf[0] !== LE) return null;
  const type = buf[1];
  const bodyLen = buf.readUInt32LE(4);
  const serial = buf.readUInt32LE(8);
  const hfLen = buf.readUInt32LE(12);
  const headerTotal = pad(16 + hfLen, 8);
  const totalLen = headerTotal + bodyLen;
  if (buf.length < totalLen) return null;

  // Parse header fields
  const fields = {};
  let off = 16;
  const hfEnd = 16 + hfLen;
  while (off < hfEnd - 1) {
    off = pad(off, 8);
    if (off >= hfEnd) break;
    const code = buf[off++];
    const v = readVariant(buf, off);
    off = v.end;
    fields[code] = v.v;
  }

  return {
    type, serial, totalLen, bodyLen,
    replySerial: fields[5] || 0,
    path: fields[1] || '',
    iface: fields[2] || '',
    member: fields[3] || '',
    errorName: fields[4] || '',
    sender: fields[7] || '',
    sig: fields[8] || '',
    body: buf.slice(headerTotal, headerTotal + bodyLen),
  };
}

// Parse Response body: uint32 status, a{sv} results
function parseResponseBody(body) {
  if (body.length < 4) return { status: -1, sessionHandle: null };
  let off = 0;
  const status = body.readUInt32LE(off); off += 4;
  let sessionHandle = null;
  try {
    off = pad(off, 4);
    const arrLen = body.readUInt32LE(off); off += 4;
    const arrEnd = off + arrLen;
    while (off < arrEnd && off < body.length - 4) {
      off = pad(off, 8);
      const k = readStr(body, off); off = k.end;
      const v = readVariant(body, off); off = v.end;
      if (k.v === 'session_handle') sessionHandle = v.v;
    }
  } catch (_) {}
  return { status, sessionHandle };
}

// Parse Activated body: objectpath session, string shortcut_id, uint64 ts, a{sv}
function parseActivatedBody(body) {
  try {
    let off = 0;
    const sess = readObjPath(body, off); off = sess.end;
    const id = readStr(body, off);
    return id.v;
  } catch (_) { return null; }
}

// ── D-Bus connection ────────────────────────────────────────────────────

function createConnection() {
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS || '';
  const socketPath = addr.replace(/^unix:path=/, '').split(/[,;]/)[0];
  if (!socketPath) return null;

  let conn = null;
  let serial = 0;
  let uniqueName = null;
  let authed = false;
  let authCb = null;
  let pending = new Map();
  let sigHandlers = [];
  let recvBuf = Buffer.alloc(0);

  function nextSerial() { return ++serial; }

  function start() {
    return new Promise((resolve, reject) => {
      conn = net.connect(socketPath, () => {
        conn.write(Buffer.from([0]));
        const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
        conn.write('AUTH EXTERNAL ' + Buffer.from(String(uid)).toString('hex') + '\r\n');
        authCb = { resolve, reject };
      });
      conn.on('data', onData);
      conn.on('error', e => { if (authCb) { authCb.reject(e); authCb = null; } });
      conn.on('close', () => { conn = null; authed = false; });
    });
  }

  function onData(chunk) {
    if (!authed) {
      if (chunk.toString().includes('OK')) {
        conn.write('BEGIN\r\n');
        authed = true;
        // Send Hello
        const s = nextSerial();
        const msg = buildMessage(METHOD_CALL, s,
          'org.freedesktop.DBus', '/org/freedesktop/DBus',
          'org.freedesktop.DBus', 'Hello', null, null, 0);
        pending.set(s, {
          resolve: (m) => {
            if (m.body && m.body.length > 4) {
              uniqueName = readStr(m.body, 0).v;
            }
            if (authCb) { authCb.resolve(uniqueName); authCb = null; }
          },
          reject: (e) => { if (authCb) { authCb.reject(e); authCb = null; } },
        });
        conn.write(msg);
      }
      return;
    }

    recvBuf = Buffer.concat([recvBuf, chunk]);
    while (recvBuf.length >= 16) {
      const m = parseMsg(recvBuf);
      if (!m) break;
      recvBuf = recvBuf.slice(m.totalLen);
      if (m.type === METHOD_RETURN || m.type === MSG_ERROR) {
        const p = pending.get(m.replySerial);
        if (p) {
          pending.delete(m.replySerial);
          if (m.type === MSG_ERROR) {
            let errMsg = m.errorName || 'D-Bus error';
            if (m.body && m.body.length > 4) {
              try { errMsg += ': ' + readStr(m.body, 0).v; } catch (_) {}
            }
            p.reject(new Error(errMsg));
          } else {
            p.resolve(m);
          }
        }
      } else if (m.type === SIGNAL) {
        for (const h of sigHandlers) { if (h.match(m)) h.fn(m); }
      }
    }
  }

  function call(dest, path, iface, member, bodySig, bodyBuf, bodyLen) {
    return new Promise((resolve, reject) => {
      const s = nextSerial();
      pending.set(s, { resolve, reject });
      const msg = buildMessage(METHOD_CALL, s, dest, path, iface, member, bodySig, bodyBuf, bodyLen);
      conn.write(msg);
      setTimeout(() => { if (pending.has(s)) { pending.delete(s); reject(new Error('timeout: ' + member)); } }, 10000);
    });
  }

  function addMatch(rule) {
    const body = Buffer.alloc(4 + rule.length + 1);
    const len = bWriteStr(body, 0, rule);
    return call('org.freedesktop.DBus', '/org/freedesktop/DBus',
      'org.freedesktop.DBus', 'AddMatch', 's', body, len);
  }

  function onSignal(matchFn, fn) { sigHandlers.push({ match: matchFn, fn }); }
  function getName() { return uniqueName; }
  function destroy() { if (conn) { conn.destroy(); conn = null; } pending.clear(); sigHandlers = []; }

  return { start, call, addMatch, onSignal, getName, destroy, nextSerial };
}

// ── Portal shortcuts client ─────────────────────────────────────────────

function createPortalShortcuts() {
  const shortcuts = new Map();
  let dbus = null;
  let sessionHandle = null;
  let starting = null;
  let available = null;

  function isAvailable() {
    if (available !== null) return available;
    const addr = process.env.DBUS_SESSION_BUS_ADDRESS || '';
    if (!addr.includes('unix:path=')) { available = false; return false; }
    try {
      require('fs').accessSync(addr.replace(/^unix:path=/, '').split(/[,;]/)[0]);
      available = true;
    } catch { available = false; }
    return available;
  }

  async function ensureSession() {
    if (sessionHandle) return sessionHandle;
    if (starting) return starting;

    starting = (async () => {
      try {
        dbus = createConnection();
        const name = await dbus.start();
        const sender = name.replace(/^:/, '').replace(/\./g, '_');
        const token = 'claude_' + process.pid;
        const reqToken = 'claude_req_' + process.pid;
        const expectedReqPath = '/org/freedesktop/portal/desktop/request/' + sender + '/' + reqToken;

        // Subscribe to signals
        await dbus.addMatch("type='signal',interface='" + REQUEST_IFACE + "',member='Response',path='" + expectedReqPath + "'");
        await dbus.addMatch("type='signal',interface='" + PORTAL_IFACE + "',member='Activated'");

        // Activated handler
        dbus.onSignal(
          m => m.iface === PORTAL_IFACE && m.member === 'Activated',
          m => {
            const id = parseActivatedBody(m.body);
            if (!id) return;
            for (const [, e] of shortcuts) {
              if (e.id === id && typeof e.callback === 'function') {
                try { e.callback(); } catch (err) { console.error('[portal-shortcuts] Callback error:', err.message); }
                break;
              }
            }
          }
        );

        // Response promise — match ANY Response signal (path may differ from expected)
        const responseP = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('CreateSession response timeout')), 10000);
          dbus.onSignal(
            m => m.iface === REQUEST_IFACE && m.member === 'Response',
            m => { clearTimeout(timer); resolve(parseResponseBody(m.body)); }
          );
        });

        // CreateSession call body: a{sv}
        const body = Buffer.alloc(512);
        const bLen = bWriteDictSV(body, 0, [
          ['session_handle_token', token],
          ['handle_token', reqToken],
        ]);
        const callResp = await dbus.call(PORTAL_DEST, PORTAL_PATH, PORTAL_IFACE, 'CreateSession', 'a{sv}', body, bLen);
        // If portal used a different request path, re-subscribe on the actual one
        if (callResp.body && callResp.body.length > 4) {
          const actualReqPath = readStr(callResp.body, 0).v;
          if (actualReqPath !== expectedReqPath) {
            await dbus.addMatch("type='signal',interface='" + REQUEST_IFACE + "',member='Response',path='" + actualReqPath + "'");
          }
        }

        const resp = await responseP;
        if (resp.status !== 0) throw new Error('CreateSession rejected (status ' + resp.status + ')');
        sessionHandle = resp.sessionHandle || '/org/freedesktop/portal/desktop/session/' + sender + '/' + token;
        console.log('[portal-shortcuts] Session created:', sessionHandle);
        return sessionHandle;
      } catch (e) {
        console.error('[portal-shortcuts] Session failed:', e.message);
        sessionHandle = null;
        if (dbus) { dbus.destroy(); dbus = null; }
        throw e;
      } finally { starting = null; }
    })();
    return starting;
  }

  async function bindAll() {
    if (!sessionHandle || !dbus || shortcuts.size === 0) return;
    try {
      // Body: oa(sa{sv})sa{sv} — session, shortcuts, parent_window, options
      const body = Buffer.alloc(4096);
      let off = 0;

      // objectpath session_handle
      off = bWriteObjPath(body, off, sessionHandle);

      // a(sa{sv}) shortcuts array
      off = pad(off, 4); // array has 4-byte alignment
      const outerLenPos = off;
      off += 4;
      const outerDataStart = pad(off, 8); // struct (sa{sv}) is 8-byte aligned
      off = outerDataStart;
      for (const [, e] of shortcuts) {
        off = pad(off, 8); // each struct is 8-byte aligned
        off = bWriteStr(body, off, e.id);
        // inner a{sv} — bWriteDictSV handles its own alignment
        off = bWriteDictSV(body, off, [
          ['description', e.description || 'Claude shortcut'],
          ['preferred_trigger', e.portalTrigger],
        ]);
      }
      body.writeUInt32LE(off - outerDataStart, outerLenPos);

      // string parent_window
      off = bWriteStr(body, off, '');

      // a{sv} options (empty) — bWriteDictSV handles alignment
      off = bWriteDictSV(body, off, []);

      await dbus.call(PORTAL_DEST, PORTAL_PATH, PORTAL_IFACE, 'BindShortcuts',
        'oa(sa{sv})sa{sv}', body, off);
      console.log('[portal-shortcuts] Bound', shortcuts.size, 'shortcut(s)');
    } catch (e) {
      console.error('[portal-shortcuts] BindShortcuts failed:', e.message);
    }
  }

  async function register(accel, callback) {
    if (!isAvailable()) return false;
    shortcuts.set(accel, {
      id: acceleratorToId(accel),
      callback,
      portalTrigger: electronAccelToPortal(accel),
      description: 'Claude: ' + accel,
    });
    try {
      await ensureSession();
      await bindAll();
      console.log('[portal-shortcuts] Registered:', accel, '→', shortcuts.get(accel).portalTrigger);
      return true;
    } catch (e) {
      console.warn('[portal-shortcuts] Failed to register', accel, ':', e.message);
      return false;
    }
  }

  function unregister(accel) {
    shortcuts.delete(accel);
    if (sessionHandle && shortcuts.size > 0) bindAll().catch(() => {});
  }

  function unregisterAll() {
    shortcuts.clear();
    if (sessionHandle) bindAll().catch(() => {});
  }

  function isRegistered(accel) { return shortcuts.has(accel); }

  function destroy() {
    shortcuts.clear();
    sessionHandle = null;
    if (dbus) { dbus.destroy(); dbus = null; }
  }

  return {
    register, unregister, unregisterAll, isRegistered, isAvailable, destroy,
    _electronAccelToPortal: electronAccelToPortal,
    _acceleratorToId: acceleratorToId,
    _parseActivatedBody: parseActivatedBody,
    _parseResponseBody: parseResponseBody,
  };
}

module.exports = { createPortalShortcuts, _test: { pad, bWriteStr, bWriteObjPath, bWriteVariantStr, bWriteDictSV, buildMessage, parseMsg, readStr } };
