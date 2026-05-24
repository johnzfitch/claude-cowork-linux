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

function createSpacesStore(options) {
  const { localAgentRoot, isPathAllowed, trace = () => {} } = options || {};

  // Path validation gate — reuses the caller's isPathWithinAllowedRoots().
  // Every function that touches user-supplied paths MUST call this.
  function requireAllowedPath(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
    if (typeof isPathAllowed === 'function') return isPathAllowed(p);
    // Fallback: restrict to homedir if no validator was injected
    const home = require('os').homedir();
    const resolved = path.normalize(p);
    return resolved === home || resolved.startsWith(home + path.sep);
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

  function readSpaces() {
    const p = discoverSpacesPath();
    if (!p) return [];
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(data.spaces) ? data.spaces : [];
    } catch (_) {
      return [];
    }
  }

  function writeSpaces(spaces) {
    const p = discoverSpacesPath();
    if (!p) {
      trace('[spaces] Cannot write — no path discovered');
      return false;
    }
    try {
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(p, JSON.stringify({ spaces }, null, 4) + '\n', 'utf8');
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
    const spaces = readSpaces();
    const now = Date.now();
    const newSpace = {
      id: randomUUID(),
      name: spaceData.name || 'Untitled',
      folders: Array.isArray(spaceData.folders) ? spaceData.folders : [],
      projects: Array.isArray(spaceData.projects) ? spaceData.projects : [],
      links: Array.isArray(spaceData.links) ? spaceData.links : [],
      origin: spaceData.origin || 'user',
      createdAt: now,
      updatedAt: now,
    };
    if (spaceData.instructions) {
      newSpace.instructions = spaceData.instructions;
    }
    spaces.push(newSpace);
    writeSpaces(spaces);
    trace('[spaces] Created space: ' + newSpace.id + ' (' + newSpace.name + ')');
    return newSpace;
  }

  function updateSpace(_event, spaceId, updates) {
    const spaces = readSpaces();
    const index = spaces.findIndex(s => s.id === spaceId);
    if (index === -1) {
      trace('[spaces] updateSpace: not found ' + spaceId);
      return null;
    }
    const updated = { ...spaces[index], ...updates, updatedAt: Date.now() };
    // Don't allow overwriting id or createdAt
    updated.id = spaces[index].id;
    updated.createdAt = spaces[index].createdAt;
    spaces[index] = updated;
    writeSpaces(spaces);
    trace('[spaces] Updated space: ' + spaceId);
    return updated;
  }

  function deleteSpace(_event, spaceId) {
    const spaces = readSpaces();
    const filtered = spaces.filter(s => s.id !== spaceId);
    if (filtered.length === spaces.length) {
      return false;
    }
    writeSpaces(filtered);
    trace('[spaces] Deleted space: ' + spaceId);
    return true;
  }

  function addFolderToSpace(_event, spaceId, folderPath) {
    if (!requireAllowedPath(folderPath)) {
      trace('[spaces] addFolderToSpace BLOCKED (outside allowed roots): ' + folderPath);
      return null;
    }
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return null;
    if (!Array.isArray(space.folders)) space.folders = [];
    // Avoid duplicates
    if (!space.folders.some(f => f.path === folderPath)) {
      space.folders.push({ path: folderPath });
    }
    space.updatedAt = Date.now();
    writeSpaces(spaces);
    return space;
  }

  function removeFolderFromSpace(_event, spaceId, folderPath) {
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space || !Array.isArray(space.folders)) return null;
    space.folders = space.folders.filter(f => f.path !== folderPath);
    space.updatedAt = Date.now();
    writeSpaces(spaces);
    return space;
  }

  function addProjectToSpace(_event, spaceId, project) {
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return null;
    if (!Array.isArray(space.projects)) space.projects = [];
    space.projects.push(project);
    space.updatedAt = Date.now();
    writeSpaces(spaces);
    return space;
  }

  function removeProjectFromSpace(_event, spaceId, projectId) {
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space || !Array.isArray(space.projects)) return null;
    space.projects = space.projects.filter(p => (p.id || p) !== projectId);
    space.updatedAt = Date.now();
    writeSpaces(spaces);
    return space;
  }

  function addLinkToSpace(_event, spaceId, link) {
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return null;
    if (!Array.isArray(space.links)) space.links = [];
    space.links.push(link);
    space.updatedAt = Date.now();
    writeSpaces(spaces);
    return space;
  }

  function removeLinkFromSpace(_event, spaceId, linkId) {
    const spaces = readSpaces();
    const space = spaces.find(s => s.id === spaceId);
    if (!space || !Array.isArray(space.links)) return null;
    space.links = space.links.filter(l => (l.id || l) !== linkId);
    space.updatedAt = Date.now();
    writeSpaces(spaces);
    return space;
  }

  function getAutoMemoryDir(_event, spaceId) {
    // Return the memory directory for the space
    const p = discoverSpacesPath();
    if (!p) return null;
    const spacesDir = path.join(path.dirname(p), 'spaces', spaceId, 'memory');
    try {
      if (!fs.existsSync(spacesDir)) {
        fs.mkdirSync(spacesDir, { recursive: true });
      }
    } catch (_) {}
    return spacesDir;
  }

  function listFolderContents(_event, folderPath) {
    if (!requireAllowedPath(folderPath)) {
      trace('[spaces] listFolderContents BLOCKED (outside allowed roots): ' + folderPath);
      return [];
    }
    try {
      const entries = fs.readdirSync(folderPath, { withFileTypes: true });
      return entries.map(e => ({
        name: e.name,
        path: path.join(folderPath, e.name),
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
      }));
    } catch (_) {
      return [];
    }
  }

  function readFileContents(_event, filePath) {
    if (!requireAllowedPath(filePath)) {
      trace('[spaces] readFileContents BLOCKED (outside allowed roots): ' + filePath);
      return null;
    }
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (_) {
      return null;
    }
  }

  function openFile(_event, filePath) {
    if (!requireAllowedPath(filePath)) {
      trace('[spaces] openFile BLOCKED (outside allowed roots): ' + filePath);
      return false;
    }
    try {
      const { execFile } = require('child_process');
      execFile('xdg-open', [filePath], { timeout: 5000 });
    } catch (_) {}
    return true;
  }

  function copyFilesToSpaceFolder(_event, spaceId, files) {
    // No-op stub — would need implementation for drag-and-drop
    trace('[spaces] copyFilesToSpaceFolder: stub (spaceId=' + spaceId + ')');
    return true;
  }

  function createSpaceFolder(_event, spaceId, folderName) {
    if (typeof folderName !== 'string' || /\.\.[\\/]/.test(folderName) || path.isAbsolute(folderName)) {
      trace('[spaces] createSpaceFolder BLOCKED (path traversal): ' + folderName);
      return null;
    }
    const p = discoverSpacesPath();
    if (!p) return null;
    const spaceFolderPath = path.join(path.dirname(p), 'spaces', spaceId, folderName);
    if (!requireAllowedPath(spaceFolderPath)) {
      trace('[spaces] createSpaceFolder BLOCKED (outside allowed roots): ' + spaceFolderPath);
      return null;
    }
    try {
      fs.mkdirSync(spaceFolderPath, { recursive: true });
      return spaceFolderPath;
    } catch (e) {
      trace('[spaces] createSpaceFolder error: ' + e.message);
      return null;
    }
  }

  function classifySessions(_event, sessions) {
    // Classify which sessions belong to which spaces based on userSelectedFolders
    const spaces = readSpaces();
    const result = {};
    for (const session of (sessions || [])) {
      const folders = session.userSelectedFolders || [];
      for (const space of spaces) {
        for (const sf of (space.folders || [])) {
          if (folders.some(f => f === sf.path || f.startsWith(sf.path + '/'))) {
            if (!result[space.id]) result[space.id] = [];
            result[space.id].push(session.sessionId || session.id);
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
    space.autoDescription = description;
    space.updatedAt = Date.now();
    writeSpaces(spaces);
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
