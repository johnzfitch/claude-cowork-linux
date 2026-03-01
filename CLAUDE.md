# Claude Cowork Linux

Reverse-engineered Linux port of Claude Desktop's Cowork (Local Agent Mode).
Replaces macOS VM + Swift addon with direct process spawning on Linux.

## Architecture Overview

```
                        ┌─────────────────────────────────┐
                        │     Claude Desktop (Electron)    │
                        │         app.asar (minified)      │
                        └──────────────┬──────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
   ┌──────────▼──────────┐  ┌─────────▼─────────┐  ┌──────────▼──────────┐
   │   linux-loader.js   │  │ ipc-handler-setup  │  │ Swift Stub (index.js)│
   │ (bootstrap, spoof,  │  │ (parallel handlers │  │ stubs/@ant/claude-   │
   │  IPC, sessions.json)│  │  from asar extract)│  │ swift/js/index.js    │
   └──────────┬──────────┘  └─────────┬─────────┘  └──────────┬──────────┘
              │                        │                        │
              │           ┌────────────┘                        │
              │           │                                     │
   ┌──────────▼───────────▼──┐                     ┌───────────▼──────────┐
   │  cowork/sdk_bridge.js   │                     │   vm.spawn() / kill  │
   │  (dead code for spawn;  │                     │   filterEnv()        │
   │   kept for bridge state)│                     │   path translation   │
   └─────────────────────────┘                     └───────────┬──────────┘
                                                               │
                                                    ┌──────────▼──────────┐
                                                    │   Claude Code CLI   │
                                                    │  (~/.local/bin/     │
                                                    │        claude)      │
                                                    └─────────────────────┘
```

**Critical**: The asar's own `LocalAgentModeSessionManager` drives the spawn lifecycle.
It calls `vm.spawn()` on the Swift stub directly. `sdk_bridge.js` initializes but is NOT
used for spawning. Do not add spawn logic to `sdk_bridge.js` expecting it to run.

## Current Status

- Regular Claude chat: WORKING
- Cowork (Local Agent Mode): WORKING (auth fixed 2026-02-13)
- Session persistence between restarts: IMPLEMENTED (env var path fix 2026-02-13)

## Key Files

| File | Purpose | Modified by us? |
|------|---------|-----------------|
| `stubs/@ant/claude-swift/js/index.js` | **THE** critical stub. Replaces macOS Swift VM addon. Handles `vm.spawn()`, `filterEnv()`, path translation, mount symlinks, process I/O | YES — primary |
| `linux-loader.js` | Electron bootstrap: platform spoofing, IPC handler registration, session lifecycle, `sessions.json` persistence, transcript migration | YES — primary |
| `cowork/sdk_bridge.js` | SDK bridge class. Initializes but **spawn is dead code** — kept for bridge state/transcript/conversation ID extraction | YES — but largely unused |
| `cowork/event_dispatch.js` | EIPC event dispatch, handler registration | YES — minor |
| `linux-app-extracted/ipc-handler-setup.js` | Parallel IPC handler implementation extracted from asar. **Untracked build artifact** — changes here must mirror `linux-loader.js` | YES — parallel |
| `test-launch.sh` | Launch script: `--password-store=gnome-libsecret`, Wayland/Ozone flags, asar repacking | YES |
| `.claude/session-resume.md` | Detailed session-by-session changelog and testing checklist | YES |

## Critical Path Chains

### Chain 1: Spawn → CLI Execution

```
User sends message in webapp
  → webapp calls IPC: LocalAgentModeSessions_$_sendMessage
  → asar's LocalAgentModeSessionManager handles it
  → calls vm.spawn() on Swift stub with:
      - command: /usr/local/bin/claude
      - args: [--resume <ccId>, --output-format stream-json, ...]
      - envVars: {CLAUDE_CONFIG_DIR: "/sessions/<name>/mnt/.claude", CLAUDE_CODE_OAUTH_TOKEN: <token>, ...}
      - additionalMounts: {".claude": {path: ".../.claude", mode: "rwd"}, ...}
  → Swift stub spawn():
      1. createMountSymlinks() — sets up mnt/ symlinks to host dirs
      2. resolveClaudeBinaryPath() — finds ~/.local/bin/claude
      3. Translates /sessions/ paths in ARGS → SESSIONS_BASE host paths
      4. Translates /sessions/ paths in ENVVARS → SESSIONS_BASE host paths  ← NEW FIX
      5. filterEnv() — allowlist + asar env vars merged
      6. nodeSpawn(command, args, {env, cwd})
  → Claude Code CLI runs on host, authenticates via CLAUDE_CODE_OAUTH_TOKEN
  → CLI streams JSON to stdout → stub relays via _onStdout → asar processes
```

**Where things can break**:
- If envVars aren't path-translated, `CLAUDE_CONFIG_DIR` points to wrong dir (transcripts lost)
- If `CLAUDE_CODE_OAUTH_TOKEN` is missing/corrupted, CLI gets 401
- If binary path resolution fails, spawn errors silently

### Chain 2: Path Translation & Symlink Resolution

```
FILESYSTEM LAYOUT:

/sessions/                                              ← ROOT SYMLINK (created by setup)
  → ~/.local/share/claude-cowork/sessions/              ← ACTUAL HOST DIR (SESSIONS_BASE equivalent via symlink)

~/Library/Application Support/Claude/
  └── LocalAgentModeSessions/
      └── sessions/                                     ← SESSIONS_BASE (in Swift stub)
          └── <session-name>/                           ← e.g., optimistic-zealous-dirac
              └── mnt/
                  ├── .claude → ~/.config/Claude/local-agent-mode-sessions/<userId>/<orgId>/<sessionId>/.claude
                  ├── .skills → ~/.config/Claude/local-agent-mode-sessions/skills-plugin/...
                  ├── claude-cowork-linux → ~/dev/claude-cowork-linux      ← user's working dir
                  └── uploads → ~/.config/Claude/local-agent-mode-sessions/.../<sessionId>/uploads

~/.config/Claude/local-agent-mode-sessions/
  └── <userId>/
      └── <orgId>/
          └── <sessionId>/                              ← ASAR SESSION STORAGE DIR
              ├── .claude/
              │   ├── projects/                         ← WHERE ASAR LOOKS FOR TRANSCRIPTS
              │   │   └── <project-hash>/
              │   │       └── <ccId>.jsonl              ← TRANSCRIPT FILE
              │   └── plans/
              └── uploads/
```

**The critical chain**:
1. Asar sets `CLAUDE_CONFIG_DIR=/sessions/<name>/mnt/.claude` (VM-internal path)
2. Stub translates to `SESSIONS_BASE/<name>/mnt/.claude` (host path)
3. That resolves through symlink to `~/.config/Claude/local-agent-mode-sessions/.../<sessionId>/.claude`
4. CLI writes transcripts to `<that>/projects/<hash>/<ccId>.jsonl`
5. Asar's `getTranscript()` looks in `<sessionStorageDir>/<sessionId>/.claude/projects/` — same place

**If step 2 is missing** (the bug we fixed), the CLI sees `/sessions/<name>/mnt/.claude` which
resolves via the root `/sessions/` symlink to `~/.local/share/claude-cowork/sessions/<name>/mnt/.claude/`
— a completely different directory. Transcripts get written there, asar looks in the other place, finds nothing.

### Chain 3: Session Persistence Across Restarts

```
SAVE PATH (during session):
  Message sent → CLI returns session_id in stream-json
    → extractConversationId() captures it
    → onConversationId callback → linux-loader.js saves to session object
    → scheduleSave() → writes sessions.json

LOAD PATH (on restart):
  linux-loader.js startup
    → loadSessionState() reads sessions.json
    → hydrateSessionPayload() restores localAgentSessions Map
    → ensureAsarClaudeConfigDir() creates .claude/projects/ for each session
    → migrateTranscriptsForExistingSessions() symlinks old transcripts to expected dirs

  User clicks session in sidebar
    → webapp calls getTranscript(sessionId)
    → asar's LocalAgentModeSessionManager.getTranscript() looks for .jsonl on disk
    → finds file at <sessionStorageDir>/<sessionId>/.claude/projects/<hash>/<ccId>.jsonl
    → parses and returns transcript → messages appear in UI

  User sends message
    → sendMessage IPC → asar calls vm.spawn() with --resume <ccId>
    → CLI resumes from its own transcript → conversation continues
```

### Chain 4: Auth Flow

```
Launch → Electron loads claude.ai in BrowserWindow
  → User logs in via webapp (or session cookie exists)
  → Asar performs OAuth token exchange
  → Token stored via safeStorage (encrypted, gnome-keyring on Linux)

Send message:
  → Asar retrieves token from safeStorage
  → Passes as envVar: CLAUDE_CODE_OAUTH_TOKEN=<token>
  → Stub's filterEnv() merges into spawn env
  → CLI handles internally via its OAuth code path
  → CLI calls api.anthropic.com with proper auth headers
```

**DO NOT** inject `ANTHROPIC_AUTH_TOKEN` — it bypasses the CLI's OAuth handler and causes 401.
See "Critical: Auth Flow" section below for full details.

### Chain 5: IPC Handler Registration (EIPC)

```
Asar registers handlers via ipcMain.handle():
  → linux-loader.js intercepts via patched _invokeHandlers.set
  → Registers our handler instead of (or alongside) the asar's
  → Handler format: $eipc_message$_<uuid>_$_<namespace>_$_<handlerName>
  → Namespaces: claude.web, claude.hybrid, claude.settings
  → Each handler registered for all 3 namespaces

Key handlers we intercept:
  LocalAgentModeSessions_$_start       → create session, spawn CLI
  LocalAgentModeSessions_$_sendMessage → send user message to CLI
  LocalAgentModeSessions_$_stop        → kill CLI process
  LocalAgentModeSessions_$_getSession  → return session metadata
  LocalAgentModeSessions_$_getAll      → return all sessions
  LocalAgentModeSessions_$_getTranscript → return conversation history
  AppFeatures_$_getSupportedFeatures   → enable cowork feature flag
  ClaudeVM_$_*                         → stub out VM operations
  ClaudeCode_$_prepare/getStatus       → stub out CLI preparation
```

## Critical: Auth Flow (DO NOT CHANGE)

The auth flow is fragile. The following behavior is correct and intentional:

1. The asar performs OAuth token exchange using session cookies from claude.ai
2. The asar passes env vars to the CLI via `vm.spawn()`:
   - `CLAUDE_CODE_OAUTH_TOKEN=<token>` -- the real auth token
   - `ANTHROPIC_API_KEY=""` -- intentionally empty
   - `ANTHROPIC_BASE_URL=https://api.anthropic.com`
3. Our stub's `filterEnv()` merges these into the spawned process env
4. The CLI handles `CLAUDE_CODE_OAUTH_TOKEN` through its own internal OAuth code path

### DO NOT:
- Inject `ANTHROPIC_AUTH_TOKEN` from the OAuth token. This bypasses the CLI's
  OAuth handling and sends the token as a raw Bearer header, which the API
  rejects with 401: "OAuth authentication is currently not supported."
- Store the token from `addApprovedOauthToken()`. On macOS the VM's MITM proxy
  uses it; on Linux we don't need it because the asar already passes
  `CLAUDE_CODE_OAUTH_TOKEN` in the spawn env vars.
- Override or delete `CLAUDE_CODE_OAUTH_TOKEN` from the env vars.
- Set `ANTHROPIC_API_KEY` to the OAuth token (different token type).

### Why macOS is different:
On macOS, the CLI runs inside a VM with a MITM proxy that intercepts ALL
outbound HTTPS. The proxy transforms auth headers before forwarding to the API.
On Linux there is no VM or proxy -- the CLI talks directly to api.anthropic.com
and must authenticate via its own `CLAUDE_CODE_OAUTH_TOKEN` code path.

## Debugging Guide

### Log sources

| Log prefix | Source | Where |
|------------|--------|-------|
| `[TRACE]` | Swift stub `trace()` | `~/Library/Application Support/Claude/logs/claude-swift-trace.log` |
| `[claude-swift]` | Swift stub `console.log()` | stdout (captured by test-launch.sh) |
| `[Cowork]` | linux-loader.js | stdout |
| `[ipc-setup]` | ipc-handler-setup.js | stdout |
| `[sdk-bridge]` | sdk_bridge.js | stdout |
| `[MAIN_LOG]` | Asar's main process logger | stdout |
| `[COWORK_VM]` | Asar's VM manager | stdout |
| `[CONSOLE:N]` | Chromium renderer (webapp) | stdout (line N in source) |

### Common issues and what to grep for

**"Projects directory not found"** → asar can't find `<sessionDir>/.claude/projects/`.
Fix: `ensureAsarClaudeConfigDir()` in linux-loader.js creates it.

**"Session file not found for <uuid>"** → asar's `LocalSessionManager.getTranscript()`
(NOT `LocalAgentModeSessions`) can't find the .jsonl in `~/.claude/projects/`.
This is the regular LocalSessions manager, not the Cowork one. Cosmetic for our use case.

**"conversation_uuid: Input should be a valid UUID...found 'l'"** → webapp tries to
use `local_<uuid>` as an API parameter. Cosmetic — local sessions use IPC, not the API.

**401 auth errors** → likely ANTHROPIC_AUTH_TOKEN injection. Check filterEnv() hasn't been
modified to inject auth headers. See "Critical: Auth Flow" above.

**Empty transcript after restart** → `CLAUDE_CONFIG_DIR` path mismatch. Check:
1. `grep "Translated envVar CLAUDE_CONFIG_DIR" ~/Library/Application\ Support/Claude/logs/claude-swift-trace.log`
2. The translated path should go through SESSIONS_BASE, not through /sessions/ symlink
3. The .claude symlink in mnt/ should resolve to the asar session storage dir
4. The .jsonl file should exist at `~/.config/Claude/local-agent-mode-sessions/.../<sessionId>/.claude/projects/<hash>/<ccId>.jsonl`

**SDK bridge initialized but never used** → Expected. The asar drives spawning via vm.spawn().
The bridge is dead code for spawn but kept for state management.

### Verifying transcript path chain

```bash
# 1. Check what CLAUDE_CONFIG_DIR is set to (from trace log)
grep "Translated envVar CLAUDE_CONFIG_DIR" ~/Library/Application\ Support/Claude/logs/claude-swift-trace.log

# 2. Check where the .claude symlink points
readlink ~/Library/Application\ Support/Claude/LocalAgentModeSessions/sessions/<session-name>/mnt/.claude

# 3. Check if transcripts exist at the asar-expected location
find ~/.config/Claude/local-agent-mode-sessions/ -name "*.jsonl" -path "*projects*"

# 4. Check if transcripts are at the OLD wrong location
find ~/.local/share/claude-cowork/sessions/ -name "*.jsonl" -path "*projects*"

# 5. Check sessions.json for ccConversationId
python3 -c "import json; d=json.load(open('$HOME/.config/Claude/LocalAgentModeSessions/sessions.json')); [print(s.get('sessionId','?'), s.get('ccConversationId','MISSING')) for s in d.get('sessions',[])]"
```

## Known Issues

- The `conversation_uuid` validation error in React Query logs is cosmetic (see Chain 3).
- `sdk_bridge.js` spawn code is dead — the asar calls `vm.spawn()` directly. The bridge
  code is kept for compatibility but should not be relied upon for spawn-time behavior.
- The asar's built-in `localAgentModeSessionManager` has its own session storage
  (`~/.config/Claude/local-agent-mode-sessions/<user-id>/<org-id>/`) that is independent
  of our `sessions.json`. Our IPC handlers intercept all eipc calls so the asar's storage
  is bypassed, but any main-process code that queries the manager directly won't find
  our sessions.
- `ipc-handler-setup.js` is an untracked build artifact from asar extraction. Changes
  there must be kept in sync with `linux-loader.js` manually.
- The D-Bus warning `Unknown method: ProvideXdgActivationToken` still appears in logs
  on KDE Wayland (Electron doesn't implement it). The tray activation itself works via
  the KWin scripting workaround, but the warning can't be suppressed from JS.

## Build / Test

```bash
# Launch cowork
./test-launch.sh

# Full log capture
./test-launch.sh 2>&1 | tee ~/cowork-full-log.txt

# Verify transcript path is correct after a session
grep "Translated envVar CLAUDE_CONFIG_DIR" ~/Library/Application\ Support/Claude/logs/claude-swift-trace.log
```

## Code Style Notes

- Use `trace()` for debug logging (writes to claude-swift-trace.log)
- Auth-related env var values must NEVER be logged unredacted (use `redactForLogs()`)
- Security: all spawned commands use `execFile`/`spawn` with argument arrays, never string interpolation
- Paths under `SESSIONS_BASE` are validated with `isPathSafe()` to prevent traversal

## Historical Bugs (for context)

1. **Auth 401** (2026-02-13): Injecting `ANTHROPIC_AUTH_TOKEN` into spawn env caused the API
   to reject with "OAuth authentication not supported." Fix: removed the injection, let the
   CLI use `CLAUDE_CODE_OAUTH_TOKEN` natively.

2. **Projects directory not found** (2026-02-13): `.claude/projects/` didn't exist in session
   storage dirs. Fix: `ensureAsarClaudeConfigDir()` creates it proactively.

3. **Transcript path mismatch** (2026-02-13): `CLAUDE_CONFIG_DIR` env var contained a VM-internal
   path (`/sessions/...`) that resolved via the root `/sessions/` symlink to `~/.local/share/...`
   instead of the asar-expected `~/.config/Claude/...` path. Fix: translate `/sessions/` paths
   in envVars (not just args) in the Swift stub's `spawn()`, so the path goes through SESSIONS_BASE
   and follows the `.claude` mount symlink to the asar-expected location.

4. **Tray icon click does nothing on KDE Wayland** (2026-03-01): KDE Plasma calls
   `ProvideXdgActivationToken` on `org.kde.StatusNotifierItem` before `Activate`.
   Electron doesn't implement this D-Bus method, so the compositor never grants an
   activation token and `BrowserWindow.focus()` silently fails on Wayland (the window
   can't steal focus). Fix: monkey-patch `BrowserWindow.prototype.focus()` and `.show()`
   on KDE Wayland to also activate the window via KWin's scripting D-Bus API
   (`org.kde.kwin.Scripting.loadScript` → `start` → `unloadScript`).
