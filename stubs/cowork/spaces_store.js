'use strict';

// Spaces store — file-backed implementation of CoworkSpaces IPC handlers for Linux.
//
// On macOS, spaces are managed by a native Swift module. On Linux, we persist
// them to spaces.json under the local-agent-mode-sessions directory.
//
// Path: <localAgentRoot>/<accountId>/<orgId>/spaces.json

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Hard caps to prevent unbounded growth of spaces.json. Even with rate
// limits a malicious renderer could grow the file to GB scale over time.
const MAX_SPACES_FILE_BYTES = 5 * 1024 * 1024;    // 5 MB total
const MAX_SPACES_COUNT = 200;
const MAX_FOLDERS_PER_SPACE = 100;
const MAX_PROJECTS_PER_SPACE = 500;
const MAX_LINKS_PER_SPACE = 500;

function createSpacesStore(options) {
  const { localAgentRoot, isPathAllowed, trace = () => {} } = options || {};

  // Rate limiter for write operations. A compromised renderer can't exhaust
  // disk by spamming createSpace/updateSpace/etc.
  const _writeTimestamps = [];
  const WRITE_RATE_LIMIT = 30;       // max writes
  const WRITE_RATE_WINDOW_MS = 60000; // per minute
  function checkWriteRate() {
    const now = Date.now();
    while (_writeTimestamps.length > 0 && _writeTimestamps[0] < now - WRITE_RATE_WINDOW_MS) {
      _writeTimestamps.shift();
    }
    if (_writeTimestamps.length >= WRITE_RATE_LIMIT) {
      trace('[spaces] Write rate limit exceeded (' + WRITE_RATE_LIMIT + '/min)');
      return false;
    }
    _writeTimestamps.push(now);
    return true;
  }

  // Path validation for folder registration (addFolderToSpace).
  // Stricter than the general FileSystem allowlist: homedir only, no /tmp.
  // /tmp is world-writable — another user could swap contents between
  // registration and read, violating the trust boundary.
  function requireAllowedPath(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
    if (typeof isPathAllowed === 'function') {
      if (!isPathAllowed(p)) return false;
    }
    // Always enforce: no /tmp for space folder registration
    const normalized = path.normalize(p);
    if (normalized === '/tmp' || normalized.startsWith('/tmp/')) return false;
    // Homedir from /etc/passwd, not $HOME
    const home = global.__coworkPasswdHomedir || require('os').userInfo().homedir;
    return normalized === home || normalized.startsWith(home + path.sep);
  }

  // Resolve a path through realpathSync, defeating symlinks.
  // Returns null if the path doesn't exist (can't be resolved = can't be read).
  function resolvePath(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
    try {
      return fs.realpathSync(p);
    } catch (_) {
      return null;
    }
  }

  // Resolve the nearest EXISTING ancestor of p through realpathSync. Used by
  // create operations where the target (and possibly some parent dirs) don't
  // exist yet, but we still must ensure no symlink in the existing portion of
  // the chain redirects the write outside the allowed roots. Returns null if
  // nothing along the chain can be resolved.
  function resolveExistingAncestor(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
    let cur = path.normalize(p);
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) return null; // reached fs root without an existing dir
      cur = parent;
    }
    return resolvePath(cur);
  }

  // Sanitize a value from the renderer to a plain string (max 10KB).
  // Rejects objects, arrays, and excessively large strings.
  function sanitizeString(v, maxLen) {
    if (typeof v !== 'string') return null;
    if (v.length > (maxLen || 10240)) return null;
    return v;
  }

  // Sanitize an object from the renderer: allow only plain key-value pairs
  // with string/number/boolean/null values. Rejects nested objects, arrays,
  // prototype-polluting keys, and enforces max depth of 1 + max size.
  function sanitizeObject(obj, maxKeys) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const clean = {};
    const keys = Object.keys(obj);
    if (keys.length > (maxKeys || 50)) return null;
    for (const k of keys) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const v = obj[k];
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        if (typeof v === 'string' && v.length > 10240) continue;
        clean[k] = v;
      }
    }
    return clean;
  }

  // Read-path validation: resolve the path ONCE through realpathSync and
  // return the resolved path if it falls within a registered folder. The
  // caller MUST use the returned path for the actual operation — not the
  // raw input. Resolving twice creates a TOCTOU window where a symlink
  // swap between resolve and use can redirect the read.
  //
  // The registered folder paths are ALREADY resolved (addFolderToSpace
  // stored the realpathSync'd result). We do NOT re-resolve them here —
  // re-resolving would follow any symlinks placed at that path AFTER
  // registration, reopening the symlink-swap attack.
  function resolveWithinRegisteredFolder(filePath) {
    const resolved = resolvePath(filePath);
    if (!resolved) return null;
    const spaces = readSpaces();
    for (const space of spaces) {
      for (const folder of (space.folders || [])) {
        const registeredPath = folder.path;
        if (typeof registeredPath !== 'string') continue;
        if (resolved === registeredPath || resolved.startsWith(registeredPath + path.sep)) {
          return resolved;
        }
      }
    }
    return null;
  }

  // Legacy boolean variant kept for callers that only need the predicate.
  function isWithinRegisteredFolder(filePath) {
    return resolveWithinRegisteredFolder(filePath) !== null;
  }

  // Discover the spaces.json path by walking localAgentRoot/<accountId>/<orgId>/
  let spacesJsonPath = null;

  function discoverSpacesPath() {
    if (spacesJsonPath) return spacesJsonPath;
    if (!localAgentRoot || !fs.existsSync(localAgentRoot)) {
      trace('[spaces] localAgentRoot not found: ' + localAgentRoot);
      return null;
    }

    try {
      const accountDirs = fs.readdirSync(localAgentRoot, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const accountDir of accountDirs) {
        const accountPath = path.join(localAgentRoot, accountDir.name);
        const orgDirs = fs.readdirSync(accountPath, { withFileTypes: true })
          .filter(d => d.isDirectory());
        for (const orgDir of orgDirs) {
          const candidate = path.join(accountPath, orgDir.name, 'spaces.json');
          if (fs.existsSync(candidate)) {
            spacesJsonPath = candidate;
            trace('[spaces] Found spaces.json: ' + spacesJsonPath);
            return spacesJsonPath;
          }
        }
        // If no spaces.json yet, use first org dir
        if (orgDirs.length > 0) {
          spacesJsonPath = path.join(accountPath, orgDirs[0].name, 'spaces.json');
          trace('[spaces] Will create spaces.json: ' + spacesJsonPath);
          return spacesJsonPath;
        }
      }
    } catch (e) {
      trace('[spaces] Error discovering spaces path: ' + e.message);
    }
    return null;
  }

  // _readState tracks whether the last readSpaces() returned [] because
  // the file genuinely was missing/empty (safe to write) vs because parsing
  // failed (NOT safe to write — would clobber user's real data).
  let _lastReadOk = true;

  function readSpaces() {
    const p = discoverSpacesPath();
    if (!p) { _lastReadOk = true; return []; }
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      // ENOENT is fine — file just doesn't exist yet.
      _lastReadOk = (e && e.code === 'ENOENT');
      return [];
    }
    try {
      const data = JSON.parse(raw);
      _lastReadOk = true;
      return Array.isArray(data.spaces) ? data.spaces : [];
    } catch (e) {
      // Parse failure: file exists but is corrupt. Refuse subsequent
      // writes so we don't silently overwrite the user's broken-but-real data.
      _lastReadOk = false;
      trace('[spaces] PARSE FAILED, refusing writes until resolved: ' + e.message);
      return [];
    }
  }

  function writeSpaces(spaces) {
    if (!_lastReadOk) {
      trace('[spaces] Write BLOCKED: previous read failed to parse — refusing to clobber existing file');
      return false;
    }
    if (!Array.isArray(spaces)) return false;
    // Cap total space count and per-space array sizes before serializing.
    if (spaces.length > MAX_SPACES_COUNT) {
      trace('[spaces] Write BLOCKED: too many spaces (' + spaces.length + ' > ' + MAX_SPACES_COUNT + ')');
      return false;
    }
    for (var si = 0; si < spaces.length; si++) {
      var s = spaces[si];
      if (s && Array.isArray(s.folders) && s.folders.length > MAX_FOLDERS_PER_SPACE) {
        trace('[spaces] Write BLOCKED: too many folders in space ' + s.id);
        return false;
      }
      if (s && Array.isArray(s.projects) && s.projects.length > MAX_PROJECTS_PER_SPACE) {
        trace('[spaces] Write BLOCKED: too many projects in space ' + s.id);
        return false;
      }
      if (s && Array.isArray(s.links) && s.links.length > MAX_LINKS_PER_SPACE) {
        trace('[spaces] Write BLOCKED: too many links in space ' + s.id);
        return false;
      }
    }
    if (!checkWriteRate()) return false;
    const p = discoverSpacesPath();
    if (!p) {
      trace('[spaces] Cannot write — no path discovered');
      return false;
    }
    const payload = JSON.stringify({ spaces }, null, 4) + '\n';
    if (Buffer.byteLength(payload, 'utf8') > MAX_SPACES_FILE_BYTES) {
      trace('[spaces] Write BLOCKED: payload exceeds ' + MAX_SPACES_FILE_BYTES + ' bytes');
      return false;
    }
    try {
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Atomic write: write to temp file then rename. Use random suffix
      // (not just pid) so two SpacesStore instances in the same process
      // can't collide on the temp filename.
      const tmp = p + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2);
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, p);
      return true;
    } catch (e) {
      trace('[spaces] Write error: ' + e.message);
      return false;
    }
  }

  function findSpace(spaceId) {
    return readSpaces().find(s => s.id === spaceId) || null;
  }

  // -- IPC handlers (match CoworkSpaces_$_* contract) --

  function getAllSpaces() {
    return readSpaces();
  }

  function getSpace(_event, spaceId) {
    return findSpace(spaceId);
  }

  function createSpace(_event, spaceData) {
    if (!spaceData || typeof spaceData !== 'object') return null;
    const spaces = readSpaces();
    const now = Date.now();
    const newSpace = {
      id: randomUUID(),
      name: sanitizeString(spaceData.name, 512) || 'Untitled',
      folders: [],
      projects: [],
      links: [],
      origin: sanitizeString(spaceData.origin, 64) || 'user',
      createdAt: now,
      updatedAt: now,
    };
    const instr = sanitizeString(spaceData.instructions, 65536);
    if (instr) {
      newSpace.instructions = instr;
    }
    spaces.push(newSpace);
    if (!writeSpaces(spaces)) {
      trace('[spaces] createSpace: write failed, returning null');
      return null;
    }
    trace('[spaces] Created space: ' + newSpace.id + ' (' + newSpace.name + ')');
    return newSpace;
  }

  function updateSpace(_event, spaceId, updates) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return null;
    const spaces = readSpaces();
    const index = spaces.findIndex(s => s.id === spaceId);
    if (index === -1) {
      trace('[spaces] updateSpace: not found ' + spaceId);
      return null;
    }
    // Allowlist: only permit known scalar fields to be updated.
    // Structured fields (folders, projects, links) have their own add/remove handlers.
    const allowed = {};
    if ('name' in updates) allowed.name = sanitizeString(updates.name, 512);
    if ('instructions' in updates) allowed.instructions = sanitizeString(updates.instructions, 65536);
    if ('origin' in updates) allowed.origin = sanitizeString(updates.origin, 64);
    if ('autoDescription' in updates) allowed.autoDescription = sanitizeString(updates.autoDescription, 65536);
    const updated = { ...spaces[index], ...allowed, updatedAt: Date.now() };
    updated.id = spaces[index].id;
    updated.createdAt = spaces[index].createdAt;
    spaces[index] = updated;
    if (!writeSpaces(spaces)) return null;
    trace('[spaces] Updated space: ' + spaceId);
    return updated;
  }

  function deleteSpace(_event, spaceId) {
    const spaces = readSpaces();
    const filtered = spaces.filter(s => s.id !== spaceId);
    if (filtered.length === spaces.length) {
      return false;
    }
    if (!writeSpaces(filtered)) return false;
    trace('[spaces] Deleted space: ' + spaceId);
    return true;
  }

  function addFolderToSpace(_event, spaceId, folderPath) {
    if (!requireAllowedPath(folderPath)) {
      trace('[spaces] addFolderToSpace BLOCKED (outside allowed roots): ' + folderPath);
      return null;
    }
    // Store the RESOLVED path so symlink swaps after registration
    // can't redirect reads to unintended locations.
    const resolved = resolvePath(folderPath);
    if (!resolved) {
      trace('[spaces] addFolderToSpace BLOCKED (path does not exist): ' + folderPath);
      return null;
    }
    if (!requireAllowedPath(resolved)) {
      trace('[spaces] addFolderToSpace BLOCKED (resolved path outside allowed roots): ' + resolved);
      return null;
    }
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return null;
    if (!Array.isArray(space.folders)) space.folders = [];
    if (!space.folders.some(f => f.path === resolved)) {
      space.folders.push({ path: resolved });
    }
    space.updatedAt = Date.now();
    if (!writeSpaces(spaces)) return null;
    return space;
  }

  function removeFolderFromSpace(_event, spaceId, folderPath) {
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space || !Array.isArray(space.folders)) return null;
    const resolved = resolvePath(folderPath);
    space.folders = space.folders.filter(f => f.path !== folderPath && f.path !== resolved);
    space.updatedAt = Date.now();
    if (!writeSpaces(spaces)) return null;
    return space;
  }

  function addProjectToSpace(_event, spaceId, project) {
    const sanitized = sanitizeObject(project, 20);
    if (!sanitized) return null;
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return null;
    if (!Array.isArray(space.projects)) space.projects = [];
    space.projects.push(sanitized);
    space.updatedAt = Date.now();
    if (!writeSpaces(spaces)) return null;
    return space;
  }

  function removeProjectFromSpace(_event, spaceId, projectId) {
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space || !Array.isArray(space.projects)) return null;
    // Use 'id' in p check + ?? to handle id=0, id='', etc. correctly.
    space.projects = space.projects.filter(p => (p && 'id' in p ? p.id : p) !== projectId);
    space.updatedAt = Date.now();
    if (!writeSpaces(spaces)) return null;
    return space;
  }

  function addLinkToSpace(_event, spaceId, link) {
    const sanitized = sanitizeObject(link, 20);
    if (!sanitized) return null;
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return null;
    if (!Array.isArray(space.links)) space.links = [];
    space.links.push(sanitized);
    space.updatedAt = Date.now();
    if (!writeSpaces(spaces)) return null;
    return space;
  }

  function removeLinkFromSpace(_event, spaceId, linkId) {
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space || !Array.isArray(space.links)) return null;
    space.links = space.links.filter(l => (l && 'id' in l ? l.id : l) !== linkId);
    space.updatedAt = Date.now();
    if (!writeSpaces(spaces)) return null;
    return space;
  }

  function getAutoMemoryDir(_event, spaceId) {
    if (typeof spaceId !== 'string' || !/^[0-9a-f-]+$/i.test(spaceId)) return null;
    const p = discoverSpacesPath();
    if (!p) return null;
    const spacesDir = path.join(path.dirname(p), 'spaces', spaceId, 'memory');
    const normalized = path.normalize(spacesDir);
    if (!normalized.startsWith(localAgentRoot + path.sep)) return null;
    try {
      if (!fs.existsSync(spacesDir)) {
        fs.mkdirSync(spacesDir, { recursive: true });
      }
    } catch (_) {}
    return spacesDir;
  }

  function listFolderContents(_event, folderPath) {
    const resolved = resolveWithinRegisteredFolder(folderPath);
    if (!resolved) {
      trace('[spaces] listFolderContents BLOCKED: ' + folderPath);
      return [];
    }
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      return entries.map(e => ({
        name: e.name,
        path: path.join(resolved, e.name),
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
      }));
    } catch (_) {
      return [];
    }
  }

  function readFileContents(_event, filePath) {
    const resolved = resolveWithinRegisteredFolder(filePath);
    if (!resolved) {
      trace('[spaces] readFileContents BLOCKED: ' + filePath);
      return null;
    }
    try {
      return fs.readFileSync(resolved, 'utf8');
    } catch (_) {
      return null;
    }
  }

  function openFile(_event, filePath) {
    const resolved = resolveWithinRegisteredFolder(filePath);
    if (!resolved) {
      trace('[spaces] openFile BLOCKED: ' + filePath);
      return false;
    }
    try {
      const { execFile } = require('child_process');
      execFile('xdg-open', [resolved], { timeout: 5000 });
    } catch (_) {}
    return true;
  }

  function copyFilesToSpaceFolder(_event, spaceId, files) {
    // No-op stub — would need implementation for drag-and-drop
    trace('[spaces] copyFilesToSpaceFolder: stub (spaceId=' + spaceId + ')');
    return true;
  }

  function createSpaceFolder(_event, parentPath, folderName) {
    // Contract (asar 1.14271.0): the renderer's "New Project" flow invokes
    // this with a filesystem parentPath at position 0 and a folderName at
    // position 1 — confirmed against the bundle's IPC validator, which names
    // the args "parentPath" then "folderName". We create
    // <parentPath>/<folderName> on disk, dedup on collision ("name (1)",
    // "name (2)", …) to match the native impl, and return the created path.
    //
    // Older builds used (spaceId, name) rooted under
    // localAgentRoot/spaces/<uuid>; that contract changed and the old shape
    // rejected every call with "invalid spaceId", so project creation failed.
    if (typeof folderName !== 'string') return null;
    const name = folderName.trim();
    if (name.length === 0 || name.length > 255) {
      trace('[spaces] createSpaceFolder BLOCKED (invalid name): ' + folderName);
      return null;
    }
    // folderName must be a single path segment — no separators or traversal.
    if (/[/\\]/.test(name) || name === '.' || name === '..' || name.includes('\0')) {
      trace('[spaces] createSpaceFolder BLOCKED (invalid name): ' + name);
      return null;
    }
    if (typeof parentPath !== 'string' || !path.isAbsolute(parentPath) || parentPath.includes('\0')) {
      trace('[spaces] createSpaceFolder BLOCKED (invalid parentPath): ' + parentPath);
      return null;
    }
    // Security: the native macOS impl relies on the OS sandbox; Linux has
    // none, so confine creation to allowed roots (homedir, no /tmp) — the
    // same policy as addFolderToSpace. Validate the normalized target so a
    // parentPath containing `..` segments can't escape lexically.
    const base = path.normalize(path.join(parentPath, name));
    if (!requireAllowedPath(base)) {
      trace('[spaces] createSpaceFolder BLOCKED (outside allowed roots): ' + base);
      return null;
    }
    // A lexical check alone is insufficient on Linux: a symlinked ancestor
    // (e.g. ~/Projects -> /etc) would let recursive mkdir escape the home
    // confinement. Mirror addFolderToSpace's symlink defense by resolving the
    // nearest EXISTING ancestor through realpath and requiring it to stay
    // within the allowed roots. We resolve the nearest existing ancestor
    // (rather than parentPath itself) so a not-yet-created Projects tree still
    // works — recursive mkdir then only adds fresh, non-symlink segments below
    // a verified-real directory.
    const resolvedAncestor = resolveExistingAncestor(base);
    if (!resolvedAncestor || !requireAllowedPath(resolvedAncestor)) {
      trace('[spaces] createSpaceFolder BLOCKED (symlinked/escaping ancestor): ' + base);
      return null;
    }
    try {
      let target = base;
      for (let i = 1; fs.existsSync(target); i++) {
        if (i > 1000) {
          trace('[spaces] createSpaceFolder BLOCKED (too many collisions): ' + base);
          return null;
        }
        target = path.normalize(path.join(parentPath, name + ' (' + i + ')'));
        if (!requireAllowedPath(target)) {
          trace('[spaces] createSpaceFolder BLOCKED (outside allowed roots): ' + target);
          return null;
        }
      }
      fs.mkdirSync(target, { recursive: true });
      trace('[spaces] createSpaceFolder created: ' + target);
      return target;
    } catch (e) {
      trace('[spaces] createSpaceFolder error: ' + e.message);
      return null;
    }
  }

  function classifySessions(_event, sessions) {
    if (!Array.isArray(sessions)) return {};
    const spaces = readSpaces();
    const result = {};
    for (const session of sessions) {
      if (!session || typeof session !== 'object') continue;
      const rawFolders = session.userSelectedFolders;
      if (!Array.isArray(rawFolders)) continue;
      // Resolve session folder paths so renderer can't fake containment
      // with unresolved symlink paths. Skip non-existent paths.
      const resolvedFolders = [];
      for (const f of rawFolders) {
        if (typeof f !== 'string') continue;
        const r = resolvePath(f);
        if (r) resolvedFolders.push(r);
      }
      if (resolvedFolders.length === 0) continue;
      for (const space of spaces) {
        for (const sf of (space.folders || [])) {
          // sf.path is already resolved (stored at registration time)
          const registeredPath = sf.path;
          if (typeof registeredPath !== 'string') continue;
          if (resolvedFolders.some(f => f === registeredPath || f.startsWith(registeredPath + path.sep))) {
            if (!result[space.id]) result[space.id] = [];
            const sid = sanitizeString(session.sessionId || session.id, 256);
            if (sid) result[space.id].push(sid);
            break;
          }
        }
      }
    }
    return result;
  }

  function setAutoDescription(_event, spaceId, description) {
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return null;
    var sanitized = sanitizeString(description, 65536);
    if (sanitized === null) return null;
    space.autoDescription = sanitized;
    space.updatedAt = Date.now();
    if (!writeSpaces(spaces)) return null;
    return space;
  }

  function summarizeSpace(_event, spaceId) {
    const space = findSpace(spaceId);
    if (!space) return null;
    return {
      id: space.id,
      name: space.name,
      folderCount: (space.folders || []).length,
      projectCount: (space.projects || []).length,
      linkCount: (space.links || []).length,
      instructions: space.instructions || null,
      autoDescription: space.autoDescription || null,
    };
  }

  // Event subscription — no-op, the renderer doesn't need real-time events on Linux
  // since we don't have native filesystem watchers wired to spaces.
  function onSpaceEvent(_event, _callback) {
    return { dispose: () => {} };
  }

  return {
    getAllSpaces,
    getSpace,
    createSpace,
    updateSpace,
    deleteSpace,
    addFolderToSpace,
    removeFolderFromSpace,
    addProjectToSpace,
    removeProjectFromSpace,
    addLinkToSpace,
    removeLinkFromSpace,
    getAutoMemoryDir,
    listFolderContents,
    readFileContents,
    openFile,
    copyFilesToSpaceFolder,
    createSpaceFolder,
    classifySessions,
    setAutoDescription,
    summarizeSpace,
    onSpaceEvent,
  };
}

module.exports = { createSpacesStore };
