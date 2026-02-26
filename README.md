<div align="center">

<img src="https://github.com/user-attachments/assets/b50a50bb-2404-4153-a312-aa5784a16928" alt="Claude Cowork for Linux (Unofficial)" width="800">

 # Claude Cowork on Linux
 ### No macOS, no VM required.

<br>

![Platform](https://img.shields.io/badge/platform-Linux%20x86__64-blue?style=flat-square)
![Tested](https://img.shields.io/badge/tested-Arch%20Linux-1793D1?style=flat-square&logo=archlinux&logoColor=white)
![Status](https://img.shields.io/badge/status-Working-success?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

**[Quick Start](#-quick-start)** · **[How It Works](#-how-it-works)** · **[Manual Setup](#-manual-setup)** · **[Troubleshooting](#-troubleshooting)**

</div>

---

## Fork Changes

This fork adds **Linux UI fixes** to `test-launch.sh` that the upstream installer misses. These are applied automatically before every asar repack and work on **any x86_64 Linux distro** (tested on Nobara/Fedora KDE, should work on Ubuntu, Arch, Debian, etc.):

| Fix | Problem | Solution |
|:----|:--------|:---------|
| **i18n paths** | DMG extracts locale files to `resources/*.json`, but the app expects `resources/i18n/*.json` | Copies JSON files into the expected subdirectory |
| **Entry point** | `package.json` points to `index.pre.js`, bypassing the frame-fix wrapper entirely | Redirects to `frame-fix-entry.js` so the BrowserWindow patch loads |
| **Window decorations** | macOS-specific `titleBarStyle:"hidden"`, `titleBarOverlay`, `trafficLightPosition` produce a frameless window on Linux | Patches the Vite bundle directly via `sed` to remove these options |
| **App icon** | Desktop entry references `icon.icns` (macOS format), which Linux can't display | Extracts PNGs from `electron.icns` via Python/Pillow into XDG icon dirs |

All fixes are idempotent — they check whether they're needed before applying.

> Upstream repo: [johnzfitch/claude-cowork-linux](https://github.com/johnzfitch/claude-cowork-linux)

---

## ![](.github/assets/icons/info-24x24.png) Overview

Claude Cowork is a special Claude Desktop build that works inside a folder you point it at—it reads, writes, and organizes files there while it runs a plan. Cowork is currently a **macOS-only preview** backed by a sandboxed Linux VM; this repo reverse-engineers and stubs the macOS-native pieces so Cowork can run directly on Linux (x86_64)—no VM and no macOS required. The stub translates VM paths to host paths so Cowork points at the right files on Linux.

**How it works:**

| Step | Description |
|:-----|:------------|
| ![](.github/assets/icons/script-24x24.png) **Stubbing** | Replace macOS-only native modules (`@ant/claude-swift`, `@ant/claude-native`) with JavaScript |
| ![](.github/assets/icons/console-24x24.png) **Direct Execution** | Run the Claude Code binary directly (no VM needed—we're already on Linux!) |
| ![](.github/assets/icons/translation-24x24.png) **Path Translation** | Convert VM paths to host paths transparently |
| ![](.github/assets/icons/platform-24x24.png) **Platform Spoofing** | Send macOS headers so the server enables the feature |

---

## ![](.github/assets/icons/status-24x24.png) Status

- **Unofficial research preview**: This is reverse-engineered and may break when Claude Desktop updates.
- **Linux support**: Currently targets **Linux x86_64**. Wayland: auto-detected via `$WAYLAND_DISPLAY` / `$XDG_SESSION_TYPE` (Ozone backend).
- **Access**: Requires your own Claude Desktop DMG and an account with Cowork enabled.

---

## ![](.github/assets/icons/checkbox-24x24.png) Requirements

- **Linux x86_64** (tested on Arch Linux, kernel 6.18.7)
- **Node.js / npm** (for Electron)
- **p7zip** (to extract the macOS DMG)
- **Python 3.11+** (for auto-download and patches)
- **Claude Max subscription** for Cowork access

---

## ![](.github/assets/icons/rocket-24x24.png) Quick Start

### Method 1: install.sh (recommended)

```bash
git clone https://github.com/johnzfitch/claude-cowork-linux.git
cd claude-cowork-linux
./install.sh          # auto-downloads the latest DMG
claude-desktop
```

### Method 2: AUR (Arch Linux)

```bash
yay -S claude-cowork-linux       # auto-downloads the latest DMG
```

### Method 3: curl pipe

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master/install.sh)
```

The installer automatically downloads the latest Claude Desktop DMG (using [rnet](https://github.com/nicholasgasior/rnet) to bypass Cloudflare on the API endpoint, then curl for the CDN download). You can also provide a DMG manually:

```bash
./install.sh ~/Downloads/Claude-*.dmg
# or
CLAUDE_DMG=~/Downloads/Claude-1.1.4010.dmg ./install.sh
```

> [!IMPORTANT]
> This repo does not include Anthropic's proprietary code. The installer downloads it directly from Anthropic's CDN.

---

## ![](.github/assets/icons/architecture-24x24.png) Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Desktop (Electron)                   │
├─────────────────────────────────────────────────────────────────┤
│  Main Process (index.js)                                        │
│  ├── Platform headers: darwin/14.0 (spoofed)                    │
│  ├── Platform gate: patched for Linux support                   │
│  └── LocalAgentModeSessionManager                               │
├─────────────────────────────────────────────────────────────────┤
│  @ant/claude-swift (STUBBED)                                    │
│  ├── vm.setEventCallbacks() → Register process event handlers   │
│  ├── vm.startVM() → No-op (we're already on Linux)              │
│  ├── vm.spawn() → Creates mount symlinks, spawns processes      │
│  ├── vm.kill() → Kills spawned processes                        │
│  └── vm.writeStdin() → Writes to process stdin                  │
├─────────────────────────────────────────────────────────────────┤
│  @ant/claude-native (STUBBED)                                   │
│  ├── AuthRequest → Opens system browser (xdg-open)              │
│  └── Platform helpers → Minimal compatibility shims             │
├─────────────────────────────────────────────────────────────────┤
│  Claude Code Binary                                             │
│  └── ~/.config/Claude/claude-code-vm/{version}/claude (ELF x86_64) │
└─────────────────────────────────────────────────────────────────┘
```

### Path Translation

The stub translates VM paths to host paths:

| VM Path | Host Path |
|:--------|:----------|
| `/usr/local/bin/claude` | `~/.config/Claude/claude-code-vm/2.1.5/claude` |
| `/sessions/...` | `~/.local/share/claude-cowork/sessions/...` |

### Mount Symlinks

When you select a folder in Cowork, the stub creates symlinks to make it accessible at the expected VM path:

```
~/.local/share/claude-cowork/sessions/<session-name>/mnt/
├── <folder>  → /home/user/path/to/selected/folder (symlink)
├── .claude   → ~/.config/Claude/.../session/.claude (symlink)
├── .skills   → ~/.config/Claude/.../skills-plugin/... (symlink)
└── uploads/  (directory for file uploads)
```

The `additionalMounts` parameter from Claude Desktop provides the mapping between mount names and host paths.

> [!NOTE]
> The Claude Code binary expects `/sessions` to exist. `install.sh` creates `/sessions` as a symlink into `~/.local/share/claude-cowork/sessions` (requires `sudo` once) so you don't need a world-writable root directory.

---

## ![](.github/assets/icons/how-it-works-24x24.png) How It Works

<details>
<summary><strong>1. Platform Spoofing</strong></summary>

The app sends these headers to Anthropic's servers:

```javascript
'Anthropic-Client-OS-Platform': 'darwin'
'Anthropic-Client-OS-Version': '14.0'
```

This makes the server think we're on macOS 14 (Sonoma), enabling Cowork features.

</details>

<details>
<summary><strong>2. Platform Gate Bypass</strong></summary>

The platform-gate function (minified name changes per build — `xPt()` in v1.1.3963, `wj()` in older builds) checks if Cowork is supported. `patches/enable-cowork.py` finds it automatically and replaces it to unconditionally return `{status: "supported"}`.

</details>

<details>
<summary><strong>3. Swift Addon Stub</strong></summary>

The original `@ant/claude-swift` uses Apple's Virtualization Framework. Our stub:

- Implements the same API surface
- Uses Node.js `child_process` to spawn real processes
- Line-buffers JSON output for proper stream parsing
- Translates VM paths to host paths

Key insight: The app calls `Si()` which returns `module.default.vm`, so methods must be on the `vm` object.

</details>

<details>
<summary><strong>4. Native Utilities Stub</strong></summary>

The app also expects `@ant/claude-native` (a macOS-specific native module). Our stub provides minimal compatibility so the app can start on Linux. For example, OAuth flows fall back to opening the system browser via `xdg-open`.

</details>

<details>
<summary><strong>5. Direct Execution</strong></summary>

On macOS, Cowork runs a Linux VM. On Linux, we skip the VM entirely and run the Claude Code binary directly on the host. This is actually simpler and faster!

The binary is a Bun-compiled executable at:
```
~/.config/Claude/claude-code-vm/{version}/claude
```

</details>

---

## ![](.github/assets/icons/folder-24x24.png) Project Structure

```
claude-cowork-linux/
├── stubs/
│   ├── @ant/claude-swift/js/index.js   # Primary stub: vm.spawn(), filterEnv(), path translation
│   ├── @ant/claude-native/index.js     # Auth (xdg-open), keyboard constants, platform helpers
│   └── frame-fix/
│       ├── frame-fix-wrapper.js        # Early bootstrap: TMPDIR fix, platform spoofing, VM markers
│       └── frame-fix-entry.js          # Entry point: loads frame-fix-wrapper then main index.js
├── cowork/
│   ├── event_dispatch.js               # EIPC event dispatch for LocalAgentModeSessions
│   └── sdk_bridge.js                   # SDK bridge (spawn dead code, kept for session state)
├── docs/
│   ├── extensions.md                   # MCP and Chrome Extension integration overview
│   ├── known-issues.md                 # Safe Storage encryption, keyring setup
│   └── safestorage-tokens.md           # How to persist tokens across restarts
├── config/
│   └── hyprland/claude.conf            # Optional: Hyprland window rules
├── patches/
│   └── enable-cowork.py               # Patches platform gate to return {status:"supported"}
├── .github/assets/                     # README icons and hero image
├── linux-loader.js                     # Entry point: platform spoofing, IPC setup, session lifecycle
├── install.sh                          # One-click installer: downloads DMG, deploys stubs
├── test-launch.sh                      # Dev launcher: repacks asar, runs AppImage electron
├── test-launch-devtools.sh             # Dev launcher with --inspect (Node.js DevTools)
├── test-flow.sh                        # Pre-flight checks: env vars, stub URLs, log scanning
├── PKGBUILD                            # Arch Linux AUR package definition
├── OAUTH-COMPLIANCE.md                 # OAuth token handling audit
├── CLAUDE.md                           # Project guide and critical paths
├── README.md                           # This file
└── LICENSE
```

After running `install.sh`, the `linux-app-extracted/` directory will contain the extracted Claude Desktop.

---

## ![](.github/assets/icons/console-24x24.png) Manual Setup

If the automated installer doesn't work, follow these steps:

<details>
<parameter name="summary"><strong>1. Extract Claude Desktop from DMG</strong></summary>

The installer handles `app.asar` extraction automatically. For manual extraction or older unpacked versions:

```bash
# Extract DMG with 7z
7z x Claude-*.dmg -o/tmp/claude-extract

# Create app directory
mkdir -p linux-app-extracted

# For newer versions (app.asar):
if [ -f "/tmp/claude-extract/Claude/Claude.app/Contents/Resources/app.asar" ]; then
    npx --yes asar extract "/tmp/claude-extract/Claude/Claude.app/Contents/Resources/app.asar" linux-app-extracted
    # Copy unpacked files if they exist
    [ -d "/tmp/claude-extract/Claude/Claude.app/Contents/Resources/app.asar.unpacked" ] && \
        cp -r "/tmp/claude-extract/Claude/Claude.app/Contents/Resources/app.asar.unpacked/"* linux-app-extracted/
# For older versions (unpacked app/):
elif [ -d "/tmp/claude-extract/Claude/Claude.app/Contents/Resources/app" ]; then
    cp -r "/tmp/claude-extract/Claude/Claude.app/Contents/Resources/app/"* linux-app-extracted/
fi

# Cleanup
rm -rf /tmp/claude-extract
```

</details>

<details>
<summary><strong>2. Install Stub Modules</strong></summary>

```bash
# Copy our stubs over the original modules
cp -r stubs/@ant/* linux-app-extracted/node_modules/@ant/
```

</details>

<details>
<summary><strong>3. Patch index.js</strong></summary>

Run the cowork patch (auto-detects the minified function name):

```bash
python3 patches/enable-cowork.py linux-app-extracted/.vite/build/index.js
```

</details>

<details>
<summary><strong>4. Create Required Directories</strong></summary>

```bash
# Create user session directory
mkdir -p ~/.local/share/claude-cowork/sessions
chmod 700 ~/.local/share/claude-cowork/sessions

# Create symlink (requires sudo once)
sudo ln -s ~/.local/share/claude-cowork/sessions /sessions
```

</details>

<details>
<summary><strong>5. Install Electron</strong></summary>

```bash
npm init -y
npm install electron
```

</details>

---

## ![](.github/assets/icons/warning-24x24.png) Troubleshooting

<details>
<summary><strong>Verify patches were applied</strong></summary>

Check that the Cowork patch is present in `linux-app-extracted/.vite/build/index.js`:

```bash
grep -q 'cowork-patched' linux-app-extracted/.vite/build/index.js && echo "✓ Cowork patch applied" || echo "✗ Patch missing - run ./install.sh"
```

The patch replaces the platform-gate function to return `{status:"supported"}` unconditionally, enabling Cowork on Linux. The `/*cowork-patched*/` marker indicates successful patching.

</details>

<details>
<summary><strong>EACCES: permission denied, mkdir '/sessions'</strong></summary>

Create a symlink to user space instead of a world-writable directory:

```bash
mkdir -p ~/.local/share/claude-cowork/sessions
sudo ln -s ~/.local/share/claude-cowork/sessions /sessions
```

</details>

<details>
<summary><strong>Unexpected non-whitespace character after JSON</strong></summary>

JSON parsing issue. The stub uses line buffering to send complete JSON objects. If this persists, check the trace log:

```bash
cat ~/.local/share/claude-cowork/logs/claude-swift-trace.log
```

</details>

<details>
<summary><strong>Failed to start Claude's workspace</strong></summary>

Check that:

1. The swift stub is properly loaded (check for `[claude-swift-stub] LOADING MODULE` in logs)
2. The Claude binary exists at `~/.config/Claude/claude-code-vm/{version}/claude`
3. You have Cowork enabled on your account (Max subscription)

</details>

<details>
<summary><strong>Process exits immediately (code=1)</strong></summary>

Check stderr in the trace log for the actual error:

```bash
tail -50 ~/.local/share/claude-cowork/logs/claude-swift-trace.log
```

Common issues:
- Missing `/sessions` symlink
- Binary not found
- Permission issues

</details>

<details>
<summary><strong>t.setEventCallbacks is not a function</strong></summary>

This means the stub isn't exporting methods correctly. The app expects:
- `module.default.vm.setEventCallbacks()` — NOT on the class directly

Ensure the stub has methods on the `this.vm` object, not just the class.

</details>

<details>
<summary><strong>Global shortcuts don't work on Wayland (GNOME)</strong></summary>

The app enables `GlobalShortcutsPortal` for Wayland global shortcut support via `xdg-desktop-portal`. This works on **KDE Plasma** and **Hyprland** but **not on GNOME** — `xdg-desktop-portal-gnome` has not implemented the GlobalShortcuts portal yet.

**Workaround for GNOME Wayland users:** Set a custom shortcut in GNOME Settings > Keyboard > Custom Shortcuts to launch `claude-desktop`.

</details>

---

## ![](.github/assets/icons/console-24x24.png) Development

```bash
./test-launch.sh              # repacks asar automatically if stubs changed
./test-launch-devtools.sh     # with Node.js inspector
./test-flow.sh                # pre-flight: env, stub URLs, log errors
```

### Debug Logging

```bash
# Include Claude Code stdout/stderr in the trace log (redacted, but still treat logs as sensitive)
export CLAUDE_COWORK_TRACE_IO=1

# Enable debug mode
export CLAUDE_COWORK_DEBUG=1

# Enable Electron logging
export ELECTRON_ENABLE_LOGGING=1

# Clear old logs
rm -f ~/.local/share/claude-cowork/logs/claude-swift-trace.log

# Run with output capture
./test-launch.sh 2>&1 | tee /tmp/claude-full.log

# In another terminal, watch the trace
tail -f ~/.local/share/claude-cowork/logs/claude-swift-trace.log
```

### Trace Log Format

The stub writes to `~/.local/share/claude-cowork/logs/claude-swift-trace.log`:

```
[timestamp] === MODULE LOADING ===
[timestamp] vm.setEventCallbacks() CALLED
[timestamp] vm.startVM() bundlePath=... memoryGB=4
[timestamp] vm.spawn() id=... cmd=... args=[...]
[timestamp] Translated command: /usr/local/bin/claude -> ~/.config/Claude/...
[timestamp] stdout line: {"type":"stream_event",...}
[timestamp] Process ... exited: code=0
```

---

## ![](.github/assets/icons/shield-security-protection-24x24.png) Security

This project includes security hardening:

- **Command injection prevention** - Uses `execFile()` instead of `exec()`
- **Path traversal protection** - Validates session paths
- **Environment filtering** - Allowlist of safe environment variables
- **Secure permissions** - Session directory uses 700, not 777
- **Symlink for /sessions** - No world-writable directories
- **URL origin validation** - `Auth_$_doAuthInBrowser` and `AuthRequest.start()` enforce Anthropic-only domains
- **OAuth compliance** - `BLOCKED_ENV_KEY_PATTERN` + `CREDENTIAL_EXEMPT_KEYS` prevent token leakage to subprocesses

---

## Legal Notice

> [!CAUTION]
> This project is for **educational and research purposes**. Claude Desktop is proprietary software owned by Anthropic PBC. Use of Cowork requires a valid Claude Max subscription.
>
> This repository contains only stub implementations and patches—**not** the Claude Desktop application itself. You must obtain Claude Desktop directly from Anthropic.
>
> This project is **not affiliated with, endorsed by, or sponsored by** Anthropic. "Claude" is a trademark of Anthropic PBC.

---

## Credits

Reverse engineered and implemented by examining the Claude Desktop Electron app structure, binary analysis with pyghidra-lite, and iterative debugging.

---

<div align="center">

**MIT License** · See [LICENSE](LICENSE) for details

</div>
