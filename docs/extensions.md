# Extensions and MCP Servers

## Overview

Claude Desktop supports two types of extensions:

1. **MCP Servers** (Model Context Protocol) - Local tools that provide capabilities like filesystem access, database queries, etc.
2. **Claude in Chrome** - Lets Claude interact with your web browser through a Chrome extension

## Current Status on Linux

| Feature | Status |
|---------|--------|
| MCP servers via `claude_desktop_config.json` | Works. Commands under your home directory must be declared there (see [Which commands are allowed to run](#which-commands-are-allowed-to-run)) |
| Claude in Chrome over the WebSocket bridge | Reported working on asar 1.30096.5 (#187) with the bridge transport passes in `patch-index.sh`; see [COMPAT.md](../COMPAT.md) |
| Chrome extension native messaging host | Not available; the host binary is not shipped for Linux (harmless warning) |
| "Extension filesystem" | Non-critical warning; the app functions without it |

## MCP Servers (Recommended)

MCP servers are the primary way to extend Claude Desktop functionality on Linux.

### Configuration

Edit `~/.config/Claude/claude_desktop_config.json` (`$XDG_CONFIG_HOME/Claude/` if you set
`XDG_CONFIG_HOME`). `install.sh` creates this file with a `preferences` block; keep it and
add `mcpServers` alongside:

```json
{
  "preferences": {
    "chromeExtensionEnabled": true
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/yourusername/projects"]
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  }
}
```

After editing, restart Claude Desktop completely. The tools will appear in your conversations.

### Available MCP Servers

Reference servers maintained by the MCP project at https://github.com/modelcontextprotocol/servers include:
- **@modelcontextprotocol/server-filesystem** - Read/write local files
- **@modelcontextprotocol/server-memory** - Knowledge-graph based persistent memory
- **mcp-server-git** - Git repository tools (Python; run with `uvx mcp-server-git`)
- **Fetch**, **Time**, **Sequential Thinking** and **Everything** (a test server)

The PostgreSQL, SQLite, GitHub, Google Drive and Slack servers that used to be listed here
have been archived by the MCP project and moved to
https://github.com/modelcontextprotocol/servers-archived. That repository and the main
README list maintained alternatives and community servers.

### Which Commands Are Allowed to Run

Claude Desktop launches many of its helper processes, MCP servers included, through a macOS
`disclaimer` wrapper. On Linux, `stubs/frame-fix/frame-fix-wrapper.js` intercepts that
wrapper and asks the exec capability registry (`stubs/cowork/exec_capability_registry.js`)
whether the command may run. A command is admitted if it is:

- the Claude Code CLI,
- one of a few fixed system tools (`git`, `bash`, `xdg-open`, `xdg-mime`, `which`, `curl`, `notify-send`, `gdbus`),
- anything that resolves to a path under `/usr/bin/`, `/usr/local/bin/`, `/usr/lib/` or `/snap/bin/`, or
- a command you declared as an MCP server.

Declared commands are read from `mcpServers` in `~/.config/Claude/claude_desktop_config.json`,
`~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), that file's per-project
`projects[<root>].mcpServers`, and `<root>/.mcp.json` for each of those projects. A bare
command such as `npx` is resolved through `PATH` the way a shell would. The list is re-read
whenever `claude_desktop_config.json` or `.claude.json` changes.

So a server installed under your home directory (for example in `~/.local/bin`,
`~/.cargo/bin`, or an `npx` from nvm or mise) runs only if it is declared. Otherwise the log
shows:

```
[exec-capability] BLOCKED (not a declared MCP server): /home/you/.local/bin/my-server -- add it to "mcpServers" in claude_desktop_config.json or .claude.json to allow it.
```

MCP config files that plugins point at elsewhere are not read, so a server declared only that
way is refused.

## Claude in Chrome

### WebSocket bridge (current bundles)

Newer bundles pair the Claude in Chrome extension over a WebSocket bridge
(`wss://bridge.claudeusercontent.com/chrome/<uuid>`) instead of a native messaging host.
On Electron builds without `net.WebSocket` (Electron 42.1.0, the version in the #187 report,
is one; `install.sh` installs the current `electron` from npm without a version pin), that
bridge failed 21 ms into every attempt with `o.net.WebSocket is not a
constructor`. Two `patch-index.sh` passes (#187) fall back to the bundled `ws` transport when
`net.WebSocket` is absent. With them applied, a contributor reported the extension pairing
and tool calls completing end to end on asar 1.30096.5; a maintainer has not exercised it
(see [COMPAT.md](../COMPAT.md)).

If it still does not pair, see the FAQ entry
["Claude in Chrome never pairs"](FAQ.md#mcp-and-plugins).

The extension is on the Chrome Web Store:
https://chrome.google.com/webstore/detail/fcoeoabgfenejglbffodgkkbkcdhcgfn
(extension ID `fcoeoabgfenejglbffodgkkbkcdhcgfn`).

### Native messaging host (older mechanism, not available)

Older bundles connected to the extension through a native messaging host binary
(`chrome-native-host`) that was only built for macOS and Windows. You'll see this warning
in the logs; it is **harmless**:

```
[Chrome Extension MCP] Skipping native host setup: binary not found at
/home/user/dev/packages/desktop/chrome-native-host/artifacts/chrome-native-host
```

## Extension Filesystem Warning

You might see: `Extension filesystem not found in installed extensions`

This is **non-critical**. The app works without it. This refers to an internal extension system, separate from MCP servers.

## Directories

Claude Desktop and this port use these directories on Linux (XDG-compliant; each `~/.config`,
`~/.local/state` and `~/.local/share` follows the matching `XDG_*_HOME` variable if set):

```
~/.config/Claude/                        # Claude Desktop userData (created 0700 by install.sh)
├── claude_desktop_config.json           # MCP servers + preferences
├── config.json                          # App settings
├── Claude Extensions/                   # Extension storage (created by Claude Desktop)
├── Claude Extensions Settings/          # Extension settings (created by Claude Desktop)
├── local-agent-mode-sessions/sessions/  # Cowork session data
└── claude-code-vm/                      # Claude Code binaries Cowork downloads

~/.local/state/claude-cowork/logs/       # 0700
├── startup.log                          # Launcher and app output
├── claude-swift-trace.log               # Stub trace log (redacted)
└── webapp-assets/                       # Asset dump, --devtools only
```

## Recommendations

**For extending Claude Desktop on Linux, use MCP servers.** They:
- Work out of the box (no binary compilation needed)
- Cover most use cases (filesystem, databases, APIs)
- Are configured with plain JSON

## Examples

### Example 1: Project Workspace

```json
{
  "mcpServers": {
    "workspace": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/workspace"]
    }
  }
}
```

### Example 2: Filesystem + Git

```json
{
  "mcpServers": {
    "workspace": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/workspace"]
    },
    "git": {
      "command": "uvx",
      "args": ["mcp-server-git", "--repository", "/home/user/workspace/myrepo"]
    }
  }
}
```

If `uvx` lives under your home directory (the usual case for a `uv` install), it is admitted
because it is the declared `command` here.

### Example 3: Custom MCP Server

You can write your own MCP server in any language. See the MCP documentation:
- https://modelcontextprotocol.io/
- https://github.com/modelcontextprotocol/modelcontextprotocol (specification)

If its executable lives under your home directory, declare it by absolute path in
`mcpServers` so the exec capability registry admits it.

## Troubleshooting

### MCP Server Not Appearing

1. Check config syntax: `jq . ~/.config/Claude/claude_desktop_config.json` (or `python3 -m json.tool` on the same file)
2. Check whether the command was refused: `grep exec-capability ~/.local/state/claude-cowork/logs/startup.log`
3. Check logs: `tail -f ~/.local/state/claude-cowork/logs/startup.log`
4. Restart Claude Desktop completely
5. Verify the command works standalone: `npx -y @modelcontextprotocol/server-filesystem /tmp` should start and wait for input on stdin (press Ctrl+C to exit)
6. Run `claude-desktop --doctor` for the preflight checks

### Permission Errors

MCP servers run with your user permissions. Make sure:
- Filesystem paths are readable/writable by your user
- Database credentials are correct
- API tokens are valid

## See Also

- MCP Server Directory: https://github.com/modelcontextprotocol/servers
- MCP Documentation: https://modelcontextprotocol.io/
- Claude Desktop Config: `~/.config/Claude/claude_desktop_config.json`
- [FAQ.md](FAQ.md#mcp-and-plugins) - MCP and plugin troubleshooting
