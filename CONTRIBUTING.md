# Contributing

Thanks for your interest. This is a small, focused project -- contributions that improve
compatibility, fix bugs, or extend distro support are very welcome.

## Before You Start

- **Check open issues** -- someone may already be working on it
- **Open an issue first** for non-trivial changes so we can align before you invest time
- **Read [CLAUDE.md](CLAUDE.md)** -- it documents the architecture, critical path chains,
  and things that are easy to break (especially auth and path translation)

## What's Most Useful

- Distro-specific fixes (package names, binary paths, keyring providers)
- New binary resolution paths in the Swift stub
- `install.sh` robustness improvements (edge cases, `--doctor` checks)
- Test coverage additions in `tests/node/current-path/`
- stubs/cowork/ module improvements (session orchestration, IPC handling)

## What's Out of Scope

- Auto-update mechanisms (security surface concern -- see issue #37)
- Features that require modifying Claude Desktop's unmodified renderer code
- Any change to credential handling that hasn't been reviewed against [OAUTH-COMPLIANCE.md](docs/OAUTH-COMPLIANCE.md)

## Development Setup

```bash
git clone https://github.com/johnzfitch/claude-cowork-linux
cd claude-cowork-linux
./install.sh           # full install
./launch.sh            # launch with auto-asar repack
./launch-devtools.sh   # launch with Node.js inspector
./install.sh --doctor  # validate environment
```

### Running Tests

```bash
# All tests (215+ tests across 18 files)
node --test tests/node/current-path/*.test.cjs

# Single module
node --test tests/node/current-path/session_orchestrator.test.cjs
```

### Log Paths

Logs during development:

```bash
# Swift stub trace log (most useful)
tail -f ~/.local/state/claude-cowork/logs/claude-swift-trace.log

# Full session log
./launch.sh 2>&1 | tee ~/cowork-full-log.txt
```

## Module Conventions

### stubs/cowork/ modules

Each module in `stubs/cowork/` follows these conventions:

- CommonJS (`require`/`module.exports`) -- the asar uses CommonJS
- Pure Node.js, no external dependencies
- Each module exports a single concern (e.g., `session_store.js` handles session persistence)
- Test file lives at `tests/node/current-path/<module_name>.test.cjs`
- Uses `node:test` and `node:assert` (no test frameworks)

### Path aliasing

The `dirs.js` module provides transparent macOS-to-XDG path aliasing:

- `~/Library/Application Support/Claude/` maps to `~/.config/Claude/`
- `~/Library/Logs/Claude/` maps to `~/.local/state/claude-cowork/logs/`
- `~/Library/Caches/Claude/` maps to `~/.cache/claude-cowork/`

All path references in code and docs should use XDG paths.

## Code Style

- **No emojis in commit messages**
- Commit format: brief summary (50 chars), blank line, explanation (72-char wrap), focus on "why"
- Branch prefixes: `feature/`, `fix/`, `refactor/`, `docs/`, `test/`
- Security: spawned commands use `execFile`/`spawn` with argument arrays -- never string interpolation
- Use `trace()` for debug logging (writes to trace log, not stdout)
- Auth-related env var values must never be logged unredacted -- use `redactForLogs()`
- Never commit: API keys, tokens, `.env` files, or anything in `~/.config/Claude/`

## Security-Sensitive Areas

Changes to these files require extra care and a note in your PR explaining the security impact:

- `stubs/@ant/claude-swift/js/index.js` -- `filterEnv()`, `spawn()`, `isPathSafe()`
- `stubs/@ant/claude-native/index.js` -- `AuthRequest.start()`, `ALLOWED_AUTH_ORIGINS`
- `stubs/cowork/credential_classifier.js` -- credential detection patterns
- `stubs/cowork/sessions_api.js` -- CRLF guards, FD bounds checking
- `stubs/cowork/asar_adapter.js` -- path traversal protection
- `stubs/cowork/process_manager.js` -- process spawning

If your change affects credential handling, verify it against [OAUTH-COMPLIANCE.md](docs/OAUTH-COMPLIANCE.md).
