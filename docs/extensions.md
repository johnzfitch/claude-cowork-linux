# Extensions and MCP Servers

## Overview

Claude Desktop supports two types of extensions:

1. **MCP Servers** (Model Context Protocol) - Local tools that provide capabilities like filesystem access, database queries, etc.
2. **Chrome Extension Integration** - Allows Claude to interact with web browsers

## Current Status on Linux

### What Works
- ✅ **MCP Servers** via `claude_desktop_config.json` - Fully functional
- ✅ **Local agent mode** - Works out of the box
- ✅ **Core Claude Code functionality** - Full support

### What Doesn't Work (Yet)
- ❌ **Chrome Extension Native Host** - Requires binary not included in this port
- ⚠️ **Extension filesystem** - Non-critical warning, app functions without it

## MCP Servers (Recommended)

MCP servers are the primary way to extend Claude Desktop functionality on Linux.

### Configuration

Edit `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/yourusername/projects"]
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    }
  }
}
```

### Available MCP Servers

Official MCP servers from Anthropic:
- **@modelcontextprotocol/server-filesystem** - Read/write local files
- **@modelcontextprotocol/server-postgres** - Query PostgreSQL databases
- **@modelcontextprotocol/server-sqlite** - Query SQLite databases
- **@modelcontextprotocol/server-github** - GitHub API integration
- **@modelcontextprotocol/server-google-drive** - Google Drive access
- **@modelcontextprotocol/server-slack** - Slack integration

Find more at: https://github.com/modelcontextprotocol/servers

### Example: Filesystem Access

```json
{
  "mcpServers": {
    "myproject": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/home/zack/projects/myapp"
      ]
    }
  }
}
```

After adding this, restart Claude Desktop. The filesystem tools will appear in your conversations.

## Chrome Extension (Not Yet Supported)

### What is it?

The Chrome Extension integration allows Claude to:
- Read web page content
- Execute JavaScript on pages
- Fill out forms
- Take screenshots of web pages
- Navigate browser tabs

### Why it doesn't work on Linux (yet)

The integration requires a native messaging host binary (`chrome-native-host`) that:
1. Acts as a bridge between Claude Desktop and the Chrome extension
2. Was only built for macOS and Windows in the original app
3. Lives at a hardcoded development path not included in the DMG

### Warning Messages

You'll see this warning in the logs - it's **harmless**:

```
[Chrome Extension MCP] Skipping native host setup: binary not found at
/home/zack/dev/packages/desktop/chrome-native-host/artifacts/chrome-native-host
```

This is expected and the app works fine without it.

### Possible Future Support

To add Chrome Extension support, we would need to:

1. **Extract or build the native host binary:**
   - Option A: Extract from a Windows build (if included)
   - Option B: Find/build the source code
   - Option C: Stub it out (like we did with the Swift addon)

2. **Place it in the expected location:**
   ```bash
   # For unpackaged (current setup)
   mkdir -p app/../../packages/desktop/chrome-native-host/artifacts/
   cp chrome-native-host app/../../packages/desktop/chrome-native-host/artifacts/

   # For packaged (future)
   # Would go in app/resources/chrome-native-host
   ```

3. **Set up Chrome native messaging manifest:**
   - Written to `~/.config/google-chrome/NativeMessagingHosts/` (Linux)
   - Done automatically by the app once binary is present

4. **Install the Chrome extension:**
   - https://chrome.google.com/webstore/detail/fcoeoabgfenejglbffodgkkbkcdhcgfn
   - Extension ID: `fcoeoabgfenejglbffodgkkbkcdhcgfn`

## Extension Filesystem Warning

You might see: `Extension filesystem not found in installed extensions`

This is **non-critical**. The app works without it. This refers to an internal extension system, separate from MCP servers.

## Directories

Claude Desktop uses these directories on Linux:

```
~/.config/Claude/
├── claude_desktop_config.json    # MCP server configuration
├── Claude Extensions/             # Extension storage (empty for now)
├── Claude Extensions Settings/    # Extension settings
├── extensions-installations.json  # Installed extensions registry
├── extensions-blocklist.json      # Blocked extensions list
└── logs/                          # Application logs
```

## Recommendations

**For extending Claude Desktop on Linux, use MCP servers.** They:
- Work out of the box (no binary compilation needed)
- Are officially supported by Anthropic
- Cover most use cases (filesystem, databases, APIs)
- Easy to configure via JSON
- Actively maintained

The Chrome Extension integration is a nice-to-have but not essential for most workflows.

## Examples

### Example 1: Project Workspace

```json
{
  "mcpServers": {
    "workspace": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/zack/workspace"]
    }
  }
}
```

### Example 2: Database + GitHub

```json
{
  "mcpServers": {
    "database": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

### Example 3: Custom MCP Server

You can write your own MCP server in any language. See the MCP documentation:
- https://modelcontextprotocol.io/
- https://github.com/modelcontextprotocol/specification

## Troubleshooting

### MCP Server Not Appearing

1. Check config syntax: `cat ~/.config/Claude/claude_desktop_config.json | jq .`
2. Check logs: `tail -f ~/.local/share/claude-cowork/logs/claude-cowork.log`
3. Restart Claude Desktop completely
4. Verify the command works standalone: `npx -y @modelcontextprotocol/server-filesystem --help`

### Permission Errors

MCP servers run with your user permissions. Make sure:
- Filesystem paths are readable/writable by your user
- Database credentials are correct
- API tokens are valid

## See Also

- MCP Server Directory: https://github.com/modelcontextprotocol/servers
- MCP Documentation: https://modelcontextprotocol.io/
- Claude Desktop Config: `~/.config/Claude/claude_desktop_config.json`
