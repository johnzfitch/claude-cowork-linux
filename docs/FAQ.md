# FAQ and Troubleshooting

## Installation

<details>
<summary><strong>Which distros are supported?</strong></summary>

Tested: Arch Linux (Hyprland, KDE), openSUSE. Expected to work on Ubuntu 22.04+, Fedora 39+, Debian 12+, and any distro with Node.js 18+, Electron, and p7zip.

NixOS is untested -- Electron + bubblewrap sandboxing may need extra config.

</details>

<details>
<summary><strong>7z gives "Dangerous link path" warnings during install</strong></summary>

This is normal. macOS DMGs include an `/Applications` symlink that 7z flags as dangerous on Linux. The installer tolerates exit codes 1 and 2 from 7z. Extraction succeeds.

</details>

<details>
<summary><strong>Where does the app install?</strong></summary>

| Method | Location |
|--------|----------|
| `install.sh` | `~/.local/share/claude-desktop/` |
| AUR (`yay -S claude-cowork-linux`) | `/usr/lib/claude-cowork/` |

Config and session data go to `~/.config/Claude/` (XDG-compliant).

</details>

<details>
<summary><strong>Do I need Python?</strong></summary>

No. As of v4.0.0, Python is optional. DMG auto-download uses Node.js (`fetch-dmg.js`). Python is only needed for `enable-cowork.py` (the platform gate patch), which the installer runs if Python is available.

</details>

---

## Login and Auth

<details>
<summary><strong>IndexedDB / LevelDB LOCK login loop (#44)</strong></summary>

**Symptom**: App launches but loops on the login screen, or shows "Session expired" repeatedly.

**Cause**: Stale LevelDB LOCK files from a previous crash.

**Fix**:
```bash
rm -f ~/.config/Claude/Local\ Storage/leveldb/LOCK
rm -f ~/.config/Claude/IndexedDB/*/LOCK
claude-desktop
```

This is an upstream Electron bug that affects all Electron apps on unclean shutdown. If it recurs frequently, ensure your DE sends proper close signals (v3.0.4+ handles SIGTERM gracefully).

</details>

<details>
<summary><strong>OAuth 401 errors</strong></summary>

If Cowork sessions fail with 401 auth errors, check that `filterEnv()` hasn't been modified. The correct auth flow:

1. The asar passes `CLAUDE_CODE_OAUTH_TOKEN` to the CLI via spawn env vars
2. The CLI uses this token through its own OAuth code path
3. `ANTHROPIC_AUTH_TOKEN` must NOT be injected (it bypasses OAuth and causes 401)

See [OAUTH-COMPLIANCE.md](OAUTH-COMPLIANCE.md) for full details.

</details>

<details>
<summary><strong>Safe Storage / token persistence</strong></summary>

**Message**: `Electron safeStorage encryption is not available on this system`

**Impact**: You'll need to re-authenticate each time you start the app.

**Fix**: Install a keyring daemon. See [safestorage-tokens.md](safestorage-tokens.md).

Quick fix for most DEs:
```bash
# Arch
sudo pacman -S gnome-keyring libsecret

# Start the daemon
gnome-keyring-daemon --start --components=secrets
```

</details>

---

## Launching

<details>
<summary><strong>Blank or white window</strong></summary>

Usually GPU/rendering issues with Electron.

```bash
# Option 1: Disable GPU (already the default in v4.0.0 launchers)
claude-desktop --disable-gpu

# Option 2: Software rendering
LIBGL_ALWAYS_SOFTWARE=1 claude-desktop

# Option 3: Force XWayland on Wayland
GDK_BACKEND=x11 claude-desktop
```

</details>

<details>
<summary><strong>App won't relaunch / stale lock</strong></summary>

A previous instance left a lock file:

```bash
rm -f ~/.config/Claude/SingletonLock ~/.config/Claude/SingletonSocket ~/.config/Claude/SingletonCookie
claude-desktop
```

Fixed in v3.0.4 -- the app handles SIGTERM and window-close gracefully.

</details>

<details>
<summary><strong>Slow startup</strong></summary>

First launch initializes caches and may download resources. Subsequent starts are faster.

Check `~/.local/state/claude-cowork/logs/startup.log` for bottlenecks.

</details>

---

## Cowork (Local Agent Mode)

<details>
<summary><strong>"Failed to start Claude's workspace"</strong></summary>

1. Run `claude-desktop --doctor` to check your environment
2. Verify the Claude binary exists:
   ```bash
   which claude || ls ~/.local/bin/claude
   ```
3. Check the trace log:
   ```bash
   tail -50 ~/.local/state/claude-cowork/logs/claude-swift-trace.log
   ```
4. Ensure `/sessions` symlink exists:
   ```bash
   ls -la /sessions
   # Should point to ~/.config/Claude/local-agent-mode-sessions/sessions
   ```

</details>

<details>
<summary><strong>Process exits immediately (exit code 1)</strong></summary>

Check stderr in the trace log:
```bash
tail -50 ~/.local/state/claude-cowork/logs/claude-swift-trace.log
```

Common causes:
- Missing `/sessions` symlink
- Claude binary not found
- Permission issues on session directories

</details>

<details>
<summary><strong>Transcripts lost after restart</strong></summary>

This was fixed in v3.0.0 (env var path translation) but can recur if the `/sessions` symlink points to the wrong location.

Verify the path chain:
```bash
# 1. Check /sessions symlink
readlink /sessions
# Should be: ~/.config/Claude/local-agent-mode-sessions/sessions

# 2. Check session .claude symlink resolves correctly
ls -la ~/.config/Claude/local-agent-mode-sessions/sessions/*/mnt/.claude

# 3. Check transcripts exist
find ~/.config/Claude/local-agent-mode-sessions/ -name "*.jsonl" -path "*projects*"
```

</details>

<details>
<summary><strong>Code tab: exit code 126 / binary not executable</strong></summary>

The asar downloads a macOS Mach-O binary to `~/.config/Claude/claude-code/<version>/claude`. `launch.sh` detects this and replaces it with a symlink to your Linux Claude binary.

If the fix didn't apply:
```bash
# Find the Mach-O binary
file ~/.config/Claude/claude-code/*/claude

# Replace manually
LINUX_CLAUDE=$(which claude)
for bin in ~/.config/Claude/claude-code/*/claude; do
  if file "$bin" | grep -q "Mach-O"; then
    mv "$bin" "${bin}.macho-backup"
    ln -s "$(readlink -f "$LINUX_CLAUDE")" "$bin"
  fi
done
```

</details>

---

## Desktop Environment

<details>
<summary><strong>Global shortcuts don't work on GNOME Wayland (#28)</strong></summary>

GNOME's `xdg-desktop-portal-gnome` has not implemented the GlobalShortcuts portal. This is an upstream limitation.

**Workaround**: Set a custom shortcut in GNOME Settings > Keyboard > Custom Shortcuts to launch `claude-desktop`.

Works on: KDE Plasma, Hyprland, Sway (via `xdg-desktop-portal-wlr`).

</details>

<details>
<summary><strong>Hyprland: blurry or incorrect opacity</strong></summary>

Install the window rules:
```bash
cp config/hyprland/claude.conf ~/.config/hypr/
# Add to ~/.config/hypr/hyprland.conf:
source = ~/.config/hypr/claude.conf
```

</details>

<details>
<summary><strong>Missing desktop notifications</strong></summary>

Install `libnotify` and ensure a notification daemon is running (dunst, mako, or your DE's built-in).

```bash
# Arch
sudo pacman -S libnotify

# Debian/Ubuntu
sudo apt install libnotify-bin
```

</details>

---

## MCP and Plugins

<details>
<summary><strong>Chrome Extension not supported</strong></summary>

**Message**: `[Chrome Extension MCP] Skipping native host setup: binary not found`

This is harmless. The Chrome Extension native messaging host binary is only built for macOS/Windows. Use MCP servers instead. See [extensions.md](extensions.md).

</details>

<details>
<summary><strong>MCP server not appearing after config change</strong></summary>

1. Check config syntax:
   ```bash
   cat ~/.config/Claude/claude_desktop_config.json | python3 -m json.tool
   ```
2. Restart Claude Desktop completely
3. Verify the command works standalone:
   ```bash
   npx -y @modelcontextprotocol/server-filesystem --help
   ```

</details>

<details>
<summary><strong>"Extension filesystem not found" warning</strong></summary>

This is non-critical. Refers to an internal extension system, not MCP servers. The app works fine without it.

</details>

---

## Debugging

<details>
<summary><strong>How to capture logs</strong></summary>

```bash
# Full session log
./launch.sh 2>&1 | tee ~/cowork-full-log.txt

# Watch the stub trace log
tail -f ~/.local/state/claude-cowork/logs/claude-swift-trace.log

# Enable verbose trace (includes CLI I/O, redacted)
CLAUDE_COWORK_TRACE_IO=1 ./launch.sh 2>&1 | tee ~/cowork-verbose.log
```

</details>

<details>
<summary><strong>Trace log format</strong></summary>

The stub writes to `~/.local/state/claude-cowork/logs/claude-swift-trace.log`:

```
[timestamp] === MODULE LOADING ===
[timestamp] vm.setEventCallbacks() CALLED
[timestamp] vm.startVM() bundlePath=... memoryGB=4
[timestamp] vm.spawn() id=... cmd=... args=[...]
[timestamp] Translated command: /usr/local/bin/claude -> ~/.config/Claude/...
[timestamp] stdout line: {"type":"stream_event",...}
[timestamp] Process ... exited: code=0
```

</details>

<details>
<summary><strong>Running the doctor command</strong></summary>

```bash
claude-desktop --doctor
# or
./install.sh --doctor
```

Checks: binaries, Node.js version, CLI location, `/sessions` symlink, secret service, patches, stubs.

</details>

---

## Reporting Issues

If your issue isn't listed here:

1. Capture logs (see Debugging section above)
2. Run `claude-desktop --doctor`
3. Report at [github.com/johnzfitch/claude-cowork-linux/issues](https://github.com/johnzfitch/claude-cowork-linux/issues) with:
   - Distro and desktop environment
   - Relevant log snippets (redact any tokens)
   - Steps to reproduce
