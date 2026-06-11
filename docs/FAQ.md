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

<details>
<summary><strong>install.sh deletes my existing checkout and fails to clone</strong></summary>

**Symptom**: The installer logs `Removing previous (non-git) installation` then fails with `fatal: Unable to read current working directory: No such file or directory`.

**Cause**: The installer checks for a `.git` directory to detect an existing repo. Git worktrees use a `.git` **file** instead, so the check fails, the installer deletes the directory (including its own CWD), and the subsequent clone fails.

**Fix**: Updated in v4.0.1. The installer now uses `git rev-parse` to detect any git repo (clones, worktrees, submodules). If you're on an older version, update:
```bash
cd ~/.local/share/claude-desktop && git pull
```

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

`xdg-desktop-portal-gnome` implements the GlobalShortcuts portal since **GNOME 48** (refined in 50) — shortcuts work there, appear under Settings > Keyboard, and may prompt for confirmation on first registration. On GNOME < 48 the portal is missing and shortcuts silently fail.

**Workaround for GNOME < 48**: Set a custom shortcut in GNOME Settings > Keyboard > Custom Shortcuts to launch `claude-desktop`.

Also works on: KDE Plasma, Hyprland, COSMIC, Sway (via `xdg-desktop-portal-wlr`).

</details>

<details>
<summary><strong>Tray icon invisible or wrong variant (#64)</strong></summary>

The app ships a macOS template tray icon (black-on-transparent) that Linux panels don't auto-tint. The wrapper redirects it to the white variant by default, since most Linux panels are dark. On a light panel, set `CLAUDE_TRAY_ICON=light` before launching to use the black variant instead.

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

## WSL2

<details>
<summary><strong>install.sh fails installing dependencies (npm conflict)</strong></summary>

If Node.js was installed from NodeSource, the distro `npm` package conflicts with it and apt refuses the transaction. The installer now installs missing packages one at a time, so the conflict no longer blocks `zstd`, `curl`, etc. NodeSource's `nodejs` package already bundles npm — don't install distro `npm` alongside it.

</details>

<details>
<summary><strong>Electron fails to start: missing shared libraries</strong></summary>

Fresh minimal Ubuntu/WSL2 installs lack the NSS/NSPR/ALSA libraries the npm Electron build links against. The installer adds them on apt-based systems; manually:

```bash
sudo apt install -y libnspr4 libnss3 libasound2t64   # libasound2 before Ubuntu 24.04
```

`./install.sh --doctor` runs `ldd` against the Electron binary and lists anything unresolved.

</details>

<details>
<summary><strong>OAuth login opens in the Windows browser and never completes</strong></summary>

WSL2's `xdg-open` forwards URLs to Windows via interop, bypassing `$BROWSER`. The login page opens in your Windows browser, but the `claude://` callback is registered in Linux — so the login never round-trips.

Fix: install the opt-in wrapper, which shadows `xdg-open` in `~/.local/bin` and routes `claude://` URLs to `claude-desktop`, `http(s)` to a Linux browser, and everything else to the system `xdg-open`:

```bash
bash install.sh --wsl-xdg-open
```

You need a Linux browser for the OAuth page (install Chrome or Firefox via apt/.deb, **not snap**, so it runs under WSLg). To remove the wrapper: `rm ~/.local/bin/xdg-open`. Note the wrapper affects every app in your WSL session that calls `xdg-open`.

</details>

<details>
<summary><strong>Logged out after every WSL restart</strong></summary>

Stock WSL2 has no Secret Service, so Electron's `safeStorage` falls back to the basic password store and credentials don't survive a WSL restart. This is expected and non-fatal. To persist logins, enable systemd in `/etc/wsl.conf` and set up `gnome-keyring`.

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
<summary><strong>DevTools and webapp asset inspection</strong></summary>

Launch with `--devtools` to open Chromium DevTools and automatically dump all
webapp JS/CSS/JSON assets to disk:

```bash
./launch.sh --devtools
```

Assets are saved to `~/.local/state/claude-cowork/logs/webapp-assets/`.
The previous dump is rotated to `webapp-assets.bak/` on each launch.

**Useful commands after an asar or webapp update:**

```bash
# Compare current vs previous webapp assets to spot protocol changes
diff -rq ~/.local/state/claude-cowork/logs/webapp-assets/ \
         ~/.local/state/claude-cowork/logs/webapp-assets.bak/

# Search dumped assets for IPC handler names
rg "LocalAgentModeSessions" ~/.local/state/claude-cowork/logs/webapp-assets/

# Check which IPC handlers the asar registers
rg "LocalAgentModeSessions_\\\$_" ~/.local/state/claude-cowork/logs/webapp-assets/

# Verify transcript path chain
grep "Translated envVar CLAUDE_CONFIG_DIR" \
  ~/.local/state/claude-cowork/logs/claude-swift-trace.log

# Check if sessions.json has conversation IDs
python3 -c "
import json, os
p = os.path.expanduser('~/.config/Claude/LocalAgentModeSessions/sessions.json')
d = json.load(open(p))
for s in d.get('sessions', []):
    print(s.get('sessionId','?'), s.get('ccConversationId','MISSING'))
"
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
