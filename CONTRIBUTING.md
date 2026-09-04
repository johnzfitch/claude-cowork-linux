# Contributing

Thanks for your interest. This is a small, focused project -- contributions that improve
compatibility, fix bugs, or extend distro support are very welcome.

## Before You Start

- **Check open issues** -- someone may already be working on it
- **Open an issue first** for non-trivial changes so we can align before you invest time
- **Get oriented** -- see "Orientation" below for what to read before touching the stubs

## Orientation

This project is a compatibility layer: it stubs macOS-native modules so an unmodified
Claude Desktop runs on Linux. Almost every bug lives in one of a few chains, so it's
worth knowing which one you're in before you start:

- **[README "Architecture"](README.md#-architecture)** -- how the stubs, the frame-fix
  wrapper, and the repacked asar fit together, plus **path translation** and **mount
  symlinks**, which are the two easiest things to break.
- **[README "How It Works"](README.md#-how-it-works)** -- startup sequence, from launcher
  through asar patching to a live Cowork session.
- **[README "Project Structure"](README.md#-project-structure)** -- what each file does.
- **[docs/OAUTH-COMPLIANCE.md](docs/OAUTH-COMPLIANCE.md)** -- the auth chain. Read this
  before any change that touches env vars reaching a spawned process.
- **[COMPAT.md](COMPAT.md)** -- which asar versions are known-good, and which contract
  changes landed in which build. Bundle-version-specific breakage usually starts here.

Two things that are easy to get wrong and are worth calling out up front:

- **IPC contracts shift between asar builds.** Handler signatures and channel namespaces
  change without notice. Prefer stubs that accept both the old and new shape so a user
  rolling back an update isn't broken -- see `pickPathArg` in `stubs/cowork/spaces_store.js`.
- **Path containment is not the same as path normalization.** Anything resolving a
  renderer-supplied path must realpath it and prove containment before use, and must
  fail closed on anything it can't prove -- including symlinks that don't resolve.

## Agent-Assisted Contributions

Contributions written with an AI coding agent are welcome, with two conditions:

1. **You have read and understood the diff**, and can explain why each change is there.
   Review load is the bottleneck in this project, not typing.
2. **No agent instruction files in the repo.** `CLAUDE.md`, `AGENTS.md`, `.cursorrules`,
   `.github/copilot-instructions.md` and equivalents are out of scope, and a PR adding
   one will be asked to remove it.

The second point is a security boundary, not a style preference. Agents read those files
automatically and treat them with the authority of an instruction from the person running
them -- so a file in a public repo becomes a way to steer any contributor's or maintainer's
agent, and it's editable by anyone who can open a PR. Keeping the repo free of them means
a checkout carries no instructions to a reader that a human wouldn't see in review.
Documentation for humans belongs in `README.md`, `docs/`, or here. Keep your own agent
config outside the repo (`~/.claude/`, or untracked and gitignored locally).

## Testing a Fork End to End

`install.sh` defaults to cloning this repo's `master`, so a fork's changes to
the stubs and scripts won't be exercised by a plain `bash install.sh`. Three
environment variables override that, which is the supported way to run your own
branch through the real install path before opening a PR:

```sh
CLAUDE_REPO_URL="https://github.com/<you>/claude-cowork-linux.git" \
CLAUDE_REPO_REF="my-branch" \
bash install.sh --force
```

- `CLAUDE_REPO_URL` -- repository to clone (default: this repo)
- `CLAUDE_REPO_REF` -- branch/tag to check out (default: the remote's default branch)
- `CLAUDE_INSTALL_DIR` -- install location (default: `~/.local/share/claude-desktop`)

`COWORK_DIR` in the generated launcher derives from the install dir, so an
override propagates rather than half-applying.

Note the `PKGBUILD` is separate: its `source=()` clones this repo by URL, so
`makepkg` runs **master's** scripts even from a fork checkout. To exercise the
AUR path against your branch, point `source=` at your fork first -- otherwise a
bug you have already fixed will still reproduce in `build()`.

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
# All tests (571 tests across 36 files)
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
