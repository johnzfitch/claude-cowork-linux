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

## ![](.github/assets/icons/info-32x32.png) Overview

Claude Cowork is a special Claude Desktop build that works inside a folder you point it at—it reads, writes, and organizes files there while it runs a plan. Cowork is currently a **macOS-only preview** backed by a sandboxed Linux VM; this repo reverse-engineers and stubs the macOS-native pieces so Cowork can run directly on Linux (x86_64 + X11)—no VM and no macOS required. The stub translates VM paths to host paths so Cowork points at the right files on Linux.

**How it works:**

| Step | Description |
|:-----|:------------|
| ![](.github/assets/icons/script.png) **Stubbing** | Replace the native Swift addon (`@ant/claude-swift`) with JavaScript |
| ![](.github/assets/icons/console.png) **Direct Execution** | Run the Claude Code binary directly (no VM needed—we're already on Linux!) |
| ![](.github/assets/icons/folder.png) **Path Translation** | Convert VM paths to host paths transparently |
| ![](.github/assets/icons/lock.png) **Platform Spoofing** | Send macOS headers so the server enables the feature |

---

## ![](.github/assets/icons/alert.png) Status

- **Unofficial research preview**: This is reverse-engineered and may break when Claude Desktop updates.
- **Linux support**: Currently targets **Linux x86_64 + X11** (Wayland support is not implemented).
- **Access**: Requires your own Claude Desktop DMG and an account with Cowork enabled.

---

## ![](.github/assets/icons/checkbox.png) Requirements

- **Linux x86_64** (tested on Arch Linux, kernel 6.17.9)
- **Node.js / npm** (for Electron)
- **p7zip** (to extract the macOS DMG)
- **Claude Desktop DMG** (download from [claude.ai/download](https://claude.ai/download))
- **Claude Max subscription** for Cowork access
- **One-time sudo** (recommended) to create the `/sessions` symlink

---

## ![](.github/assets/icons/rocket.png) Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/johnzfitch/claude-cowork-linux.git
cd claude-cowork-linux

# 2. Run the installer (provide path to Claude Desktop DMG)
./install.sh ~/Downloads/Claude-*.dmg

# 3. Launch
./run.sh
```

The installer will:
- Extract the Claude Desktop app from the DMG
- Apply Linux compatibility patches
- Install our stub modules
- Create required directories
- Install Electron
- Prompt once for `sudo` to create `/sessions` as a symlink into user space (required by the Claude Code binary)

> [!IMPORTANT]
> You must provide your own Claude Desktop DMG file. This repo does not include Anthropic's proprietary code.

---

## ![](.github/assets/icons/settings.png) Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Desktop (Electron)                    │
├─────────────────────────────────────────────────────────────────┤
│  Main Process (index.js)                                        │
│  ├── Platform headers: darwin/14.0 (spoofed)                    │
│  ├── Ege() function: patched for Linux support                  │
│  └── LocalAgentModeSessionManager                               │
├─────────────────────────────────────────────────────────────────┤
│  @ant/claude-swift (STUBBED)                                    │
│  ├── vm.setEventCallbacks() → Register process event handlers   │
│  ├── vm.startVM() → No-op (we're already on Linux)              │
│  ├── vm.spawn() → Spawns real processes via child_process       │
│  ├── vm.kill() → Kills spawned processes                        │
│  └── vm.writeStdin() → Writes to process stdin                  │
├─────────────────────────────────────────────────────────────────┤
│  Claude Code Binary                                             │
│  └── ~/.config/Claude/claude-code-vm/2.1.5/claude (ELF x86_64) │
└─────────────────────────────────────────────────────────────────┘
```

### Path Translation

The stub translates VM paths to host paths:

| VM Path | Host Path |
|:--------|:----------|
| `/usr/local/bin/claude` | `~/.config/Claude/claude-code-vm/2.1.5/claude` |
| `/sessions/...` | `~/.local/share/claude-cowork/sessions/...` |

> [!NOTE]
> The Claude Code binary expects `/sessions` to exist. `install.sh` creates `/sessions` as a symlink into `~/.local/share/claude-cowork/sessions` (requires `sudo` once) so you don't need a world-writable root directory.

---

## ![](.github/assets/icons/key.png) How It Works

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

The `Ege()` function checks if Cowork is supported. We patch it to return `{status: "supported"}` for Linux:

```javascript
if (process.platform === 'linux') {
  return { status: "supported" };
}
```

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
<summary><strong>4. Direct Execution</strong></summary>

On macOS, Cowork runs a Linux VM. On Linux, we skip the VM entirely and run the Claude Code binary directly on the host. This is actually simpler and faster!

The binary is a Bun-compiled executable at:
```
~/.config/Claude/claude-code-vm/2.1.5/claude
```

</details>

---

## ![](.github/assets/icons/folder.png) Project Structure

```
claude-cowork-linux/
├── stubs/
│   └── @ant/
│       ├── claude-swift/
│       │   └── js/index.js       # Swift addon stub (VM emulation)
│       └── claude-native/
│           └── index.js          # Native utilities stub
├── .github/
│   └── assets/icons/             # Documentation icons
├── install.sh                    # Automated installer
├── run.sh                        # Launch script
└── README.md                     # This file
```

After running `install.sh`, the `app/` directory will contain the extracted Claude Desktop.

---

## ![](.github/assets/icons/console.png) Manual Setup

If the automated installer doesn't work, follow these steps:

<details>
<summary><strong>1. Extract Claude Desktop from DMG</strong></summary>

```bash
# Extract DMG with 7z
7z x Claude-*.dmg -o/tmp/claude-extract

# Copy app resources
mkdir -p app
cp -r "/tmp/claude-extract/Claude/Claude.app/Contents/Resources/app/"* app/

# Cleanup
rm -rf /tmp/claude-extract
```

</details>

<details>
<summary><strong>2. Install Stub Modules</strong></summary>

```bash
# Copy our stubs over the original modules
cp -r stubs/@ant/* app/node_modules/@ant/
```

</details>

<details>
<summary><strong>3. Patch index.js</strong></summary>

Edit `app/.vite/build/index.js` and find the `Ege()` function. Add this at the start:

```javascript
if (process.platform === 'linux') {
  return { status: "supported" };
}
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
2. The Claude binary exists at `~/.config/Claude/claude-code-vm/2.1.5/claude`
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

---

## ![](.github/assets/icons/console.png) Development

### Enable Debug Logging

```bash
# Clear old logs
rm -f ~/.local/share/claude-cowork/logs/claude-swift-trace.log

# Run with output capture
./run.sh 2>&1 | tee /tmp/claude-full.log

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

## ![](.github/assets/icons/shield-security-protection-16x16.png) Security

This project includes security hardening:

- **Command injection prevention** - Uses `execFile()` instead of `exec()`
- **Path traversal protection** - Validates session paths
- **Environment filtering** - Allowlist of safe environment variables
- **Secure permissions** - Session directory uses 700, not 777
- **Symlink for /sessions** - No world-writable directories

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

Reverse engineered and implemented by examining the Claude Desktop Electron app structure, binary analysis with pyghidra, and iterative debugging.

---

<div align="center">

**MIT License** · See [LICENSE](LICENSE) for details

</div>
