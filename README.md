<div align="center">

<img src="https://github.com/user-attachments/assets/b50a50bb-2404-4153-a312-aa5784a16928" alt="Claude Cowork for Linux (Unofficial)" width="800">

 # Claude Cowork on Linux
 ### No macOS, no VM required.

<br>

![Platform](https://img.shields.io/badge/platform-Linux%20x86__64-blue?style=flat-square)
![Version](https://img.shields.io/badge/version-v5.3.0-brightgreen?style=flat-square)
![Tested](https://img.shields.io/badge/tested-Arch%20Linux-1793D1?style=flat-square&logo=archlinux&logoColor=white)
![Status](https://img.shields.io/badge/status-Working-success?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

**[Quick Start](#-quick-start)** &middot; **[How It Works](#-how-it-works)** &middot; **[Installing by Hand](#-installing-by-hand)** &middot; **[Troubleshooting](#-troubleshooting)** &middot; **[FAQ][faq]**

</div>

[faq]: docs/FAQ.md
[compat]: COMPAT.md
[contributing]: CONTRIBUTING.md
[oauth]: docs/OAUTH-COMPLIANCE.md
[issues]: https://github.com/johnzfitch/claude-cowork-linux/issues
[releases]: https://github.com/johnzfitch/claude-cowork-linux/releases

---

## ![](.github/assets/icons/info-24x24.png) Overview

Claude Cowork is the Claude Desktop mode that works inside a folder you point it at &mdash; it reads, writes, and organizes files there while it runs a plan. Upstream, Cowork ships for **macOS** and runs the agent inside a sandboxed Linux VM. This project stubs the macOS-native pieces of the unmodified Claude Desktop app so Cowork runs directly on Linux (x86_64): no VM, no macOS machine.

| Step | What happens |
|:-----|:-------------|
| ![](.github/assets/icons/script-24x24.png) **Stubbing** | macOS-only native modules (`@ant/claude-swift`, `@ant/claude-native`) are replaced with JavaScript implementations |
| ![](.github/assets/icons/console-24x24.png) **Direct execution** | The Claude Code CLI runs on the host instead of in a VM &mdash; you're already on Linux |
| ![](.github/assets/icons/translation-24x24.png) **Path translation** | VM paths (`/sessions/...`, `/usr/local/bin/claude`) are mapped to host paths |
| ![](.github/assets/icons/platform-24x24.png) **Platform spoofing** | App code sees `process.platform === 'darwin'` and macOS 14, so the darwin-only Cowork code paths run |

> [!IMPORTANT]
> This repository contains **no Anthropic code**. The installer downloads Claude Desktop from Anthropic's <abbr title="Content Delivery Network">CDN</abbr> on your machine.

---

## ![](.github/assets/icons/status-24x24.png) Status

- **Unofficial research preview.** Reverse-engineered; a Claude Desktop update can break it. [COMPAT.md][compat] records which Desktop builds are known good.
- **Linux x86_64.** Wayland is auto-detected via `$WAYLAND_DISPLAY` / `$XDG_SESSION_TYPE` (Electron Ozone backend).
- **Access.** Requires a Claude account with Cowork access. No macOS machine is needed &mdash; the installer fetches the macOS build and unpacks it.
- **Tests.** 599 `node:test` cases across 36 files (IPC, path translation, containment, credential handling, session persistence), plus seven shell suites covering the patch passes, compat pins, launcher stub sync, launcher flags, installer static checks, the installer's staged extract-and-swap, and the AUR package's disclaimer wrapper and icon. CI runs all of them on every push and pull request.

---

## ![](.github/assets/icons/platform-24x24.png) Compatibility

| Distro | Desktop | Status | Notes |
|:-------|:--------|:-------|:------|
| **Arch Linux** | Hyprland (Wayland) | Tested | Primary development environment |
| **Arch Linux** | KDE Plasma (Wayland) | Expected | KDE Wallet is exposed through the SecretService D-Bus API |
| **Manjaro** | Cinnamon (X11) | Reported working | Asar 1.26832.0, via both `install.sh` and `makepkg` |
| **Fedora 39+** | GNOME / KDE | Expected | May need `p7zip-plugins` for archive extraction; a Fedora 44 report (#171) was against an independent fork |
| **Ubuntu 22.04+** | GNOME / X11, WSLg | Reported working | gnome-keyring provides SecretService; see [WSL2 notes](#-troubleshooting) |
| **CachyOS** | KDE Plasma (Wayland) | Reported working | Asar 1.40609.0 |
| **Debian 12+** | Any | Expected | `p7zip-full` from apt |
| **openSUSE** | Any | Tested | Uses the `7zip` package (not `p7zip`) and `nodejs-default` |
| **NixOS** | Any | Packaged | Nix flake ([Method 4](#method-4-nix-flake-nixos)); `install.sh` does not work on NixOS |

"Reported working" rows come from contributor reports recorded in [COMPAT.md][compat], not from a maintainer test run.

**Known caveats:**
- Compositors without the `GlobalShortcuts` portal (GNOME before 48) have no global hotkey &mdash; bind `claude-desktop` to a custom shortcut in your DE settings instead.
- With no SecretService provider running, the launcher falls back to `--password-store=basic` (credentials on disk, not in a keyring).

Run `claude-desktop --doctor` after installing to check your environment.

---

## ![](.github/assets/icons/checkbox-24x24.png) Requirements

- **Linux x86_64**
- **Node.js 18+** and npm
- **Electron** (system package or npm global)
- **asar** (`npm install -g @electron/asar`)
- **7-Zip** (`p7zip`, or `7zip` on openSUSE) to unpack the macOS archive
- **Python 3** &mdash; `enable-cowork.py` applies the Cowork platform-gate patch at install and update time
- **bubblewrap** (checked by the installer and `--doctor`; also runs the experimental session sandbox, `CLAUDE_COWORK_SANDBOX=1`)
- **Secret service provider** (optional) &mdash; gnome-keyring, KDE Wallet, or KeePassXC. Without one the launcher uses `--password-store=basic`.
- A Claude plan with Cowork access

`install.sh` installs missing packages through your package manager (and asks for `sudo` only for that).

---

## ![](.github/assets/icons/rocket-24x24.png) Quick Start

### Method 1: install.sh (recommended)

```bash
git clone https://github.com/johnzfitch/claude-cowork-linux.git
cd claude-cowork-linux
./install.sh          # prompts before downloading Claude Desktop
claude-desktop
```

The installer shows the Claude Desktop version it found and asks before downloading it. Answering <kbd>t</kbd> at that prompt prints the download URL and SHA-256 of the last version recorded as tested in [COMPAT.md][compat] instead. Pass `--force` (or `--yes`) to skip the prompt in scripts.

### Method 2: AUR (Arch Linux)

```bash
yay -S claude-cowork-linux
```

> [!WARNING]
> The AUR listing is published by a workflow, and if that workflow fails the package silently keeps serving an old recipe. From 2026-04-23 until [#189](https://github.com/johnzfitch/claude-cowork-linux/issues/189) it did exactly that, and the symptom looked like a new bundle layout: <samp>ERROR: Platform-gate function not found in .../.vite/build/index.js</samp>. Compare the published package with this tree before relying on it:
>
> ```bash
> ./check-aur-sync.sh
> ```
>
> If they differ, build from the repo instead (Method 1, or `makepkg -si` in a clone). CI now runs the same check on every push.

### Method 3: curl pipe

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master/install.sh) --force
```

A piped install can't answer the download prompt, so it refuses to download without `--force`.

### Method 4: Nix flake (NixOS)

`install.sh` can't install on NixOS: it would run imperative `nix-env -iA`, and the npm `electron` it falls back to is a prebuilt binary that won't run there. The flake builds against `electron_41` from nixpkgs instead.

```bash
# Run without installing
nix run github:johnzfitch/claude-cowork-linux

# Or add to a NixOS / home-manager config
# environment.systemPackages = [ inputs.claude-cowork-linux.packages.${system}.default ];
```

The derivation extracts and patches a pinned Claude Desktop release at build time; a wrapper then mirrors the tree into `$XDG_DATA_HOME/claude-cowork-linux` (writable) and runs `launch.sh` with every dependency on `PATH`. The pin lives in [`nix/package.nix`](nix/package.nix) and follows the last tested build in [COMPAT.md][compat] (currently 1.26832.0). The build sweeps every main-process chunk for the Cowork gate, as `install.sh` does, and fails rather than ship a package with Cowork off. Override `claudeVersion` / `claudeUrl` / `claudeHash` to track another release; the derivation unpacks `.zip` archives only. `nix develop` gives a shell with everything `install.sh` needs.

### Updating

```bash
claude-desktop --update
```

This pulls the latest scripts and stubs into the install directory, then re-fetches, re-extracts, and re-patches Claude Desktop (with the same prompt as a fresh install). If the installed Desktop build is newer than the last tested one, the launcher prints a one-time `[WARN]` per version.

### Launcher options

<dl>
<dt><code>claude-desktop</code></dt>
<dd>Start detached; output goes to <code>~/.local/state/claude-cowork/logs/startup.log</code>.</dd>
<dt><code>claude-desktop --debug</code></dt>
<dd>Stay in the foreground with verbose IPC logging and CLI I/O tracing (<code>CLAUDE_COWORK_VERBOSE=1</code>, <code>CLAUDE_COWORK_TRACE_IO=1</code>). The trace log is redacted but still sensitive.</dd>
<dt><code>claude-desktop --devtools</code></dt>
<dd>Stay in the foreground, open DevTools, and dump webapp assets to <code>~/.local/state/claude-cowork/logs/webapp-assets/</code>.</dd>
<dt><code>claude-desktop --inspect</code> / <code>--perf</code> / <code>--dev</code></dt>
<dd>Passed to <code>launch.sh</code> unchanged &mdash; see <a href="#-development">Development</a>.</dd>
<dt><code>claude-desktop --doctor</code></dt>
<dd>Preflight diagnostics: binaries, Node, the Claude CLI, <code>/sessions</code>, secret service, patch markers, and installed-vs-tested asar version.</dd>
<dt><code>claude-desktop --update</code></dt>
<dd>Update scripts, stubs, and Claude Desktop (see above).</dd>
</dl>

`launch.sh` in the install directory takes further flags for development &mdash; see [Development](#-development).

---

## ![](.github/assets/icons/architecture-24x24.png) Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                 Claude Desktop (unmodified Electron app)          │
├──────────────────────────────────────────────────────────────────┤
│  frame-fix-entry.js → frame-fix-wrapper.js  (loads first)        │
│  ├── process.platform / os.platform → 'darwin' for app code      │
│  ├── stubs darwin-only Electron APIs (systemPreferences, …)      │
│  ├── IPC overrides registered by channel suffix                  │
│  └── Linux menus, tray icon, claude:// URL handling, shutdown    │
├──────────────────────────────────────────────────────────────────┤
│  @ant/claude-swift (stub)                                        │
│  └── vm.* API → session orchestrator (spawn, kill, stdin, events)│
├──────────────────────────────────────────────────────────────────┤
│  @ant/claude-native (stub)                                       │
│  ├── AuthRequest → system browser (xdg-open), origin-checked     │
│  └── safe_fs.js → openRootDir / *Beneath containment             │
├──────────────────────────────────────────────────────────────────┤
│  stubs/cowork/  orchestration layer (29 modules)                 │
│  ├── sessions & processes   ├── IPC                              │
│  ├── paths & files          └── security policy                  │
├──────────────────────────────────────────────────────────────────┤
│  Claude Code CLI (host binary, no VM)                            │
└──────────────────────────────────────────────────────────────────┘
```

At build/launch time, `patch-index.sh` applies sed passes to the minified main-process bundle (macOS titlebar options, `file://` preload origins, `--effort xhigh`, Handoff API no-ops, resource and MCP node-host paths, the Chrome-bridge WebSocket fallback), and `enable-cowork.py` replaces the Cowork platform gate in whichever `index*.chunk-*.js` carries it and stops the darwin automount-root rule from refusing `/home`. `launch.sh` and the AUR `PKGBUILD` source the same `patch-index.sh`, so the two paths can't drift apart.

### Path translation

| VM path | Host path |
|:--------|:----------|
| `/usr/local/bin/claude`, `claude` | Resolved on the host &mdash; see "Direct execution" under [How It Works](#-how-it-works) |
| `/sessions/...` | `~/.config/Claude/local-agent-mode-sessions/sessions/...` |

The frame-fix wrapper rewrites `/sessions/` paths at the Node `fs` layer, so the `/sessions` root symlink that `install.sh` offers to create (with `sudo`) is optional.

### Mount symlinks

When you pick a folder for a Cowork session, the swift stub creates one symlink per mount under the session directory, so the CLI sees the layout it would have inside the VM:

```
~/.config/Claude/local-agent-mode-sessions/sessions/<session>/mnt/
├── <mount name>  → ~/<path from additionalMounts>
└── uploads       → the session's host upload directory
```

Mount paths come from Claude Desktop's `additionalMounts` and must resolve inside your home directory; anything else is refused.

---

## ![](.github/assets/icons/how-it-works-24x24.png) How It Works

<details>
<summary><strong>1. Platform spoofing</strong></summary>

`frame-fix-wrapper.js` runs before any app code. It makes `process.platform` and `os.platform()` report `darwin` to app code (the stubs still see the real platform), reports macOS 14.0 from `process.getSystemVersion()`, and gives web contents a macOS user agent. The darwin-only Electron APIs the app then reaches for &mdash; the `systemPreferences` surface, the Handoff activity APIs, and similar &mdash; are stubbed so they answer safely instead of throwing.

</details>

<details>
<summary><strong>2. Platform gate bypass</strong></summary>

The function that decides whether Cowork is supported has a different minified name in every build (`ke()` on 1.26832.0, `xPt()` and `wj()` in older ones) and, on split-entry builds (1.19367.0+), lives in one of a few hundred `index*.chunk-*.js` files. `enable-cowork.py` sweeps every chunk, finds the gate by shape rather than by name, replaces it with one that returns `{status:"supported"}`, and leaves a `/*cowork-patched*/` marker.

</details>

<details>
<summary><strong>3. Swift addon stub</strong></summary>

Upstream, `@ant/claude-swift` drives Apple's Virtualization framework. The stub implements the same `vm` API surface (`setEventCallbacks`, `startVM`, `spawn`, `kill`, `writeStdin`, …) and hands spawning to `session_orchestrator.js`, which line-buffers the CLI's JSON stream, translates paths, and manages mounts and process lifecycle.

</details>

<details>
<summary><strong>4. Native utilities stub</strong></summary>

`@ant/claude-native` is a macOS native module. The stub provides what the app needs on Linux: OAuth via the system browser (`xdg-open`, restricted to Anthropic origins), keyboard and platform helpers, and &mdash; since asar 1.22209.x &mdash; the safe-fs containment API (`openRootDir` plus `*Beneath` operations) in `safe_fs.js`, which the app uses for artifact, upload, and transcript writes.

</details>

<details>
<summary><strong>5. Session orchestration layer</strong></summary>

`stubs/cowork/` holds 29 CommonJS modules plus the plugin permission shim:

<dl>
<dt>Sessions &amp; processes</dt>
<dd><code>session_orchestrator</code>, <code>process_manager</code>, <code>resume_coordinator</code>, <code>session_store</code>, <code>session_normalization</code>, <code>sessions_api</code>, <code>transcript_store</code>, <code>stream_protocol</code>, <code>spaces_store</code> (CoworkSpaces)</dd>
<dt>IPC</dt>
<dd><code>ipc_overrides</code>, <code>linux_ipc_stubs</code>, <code>eipc_channel</code>, <code>ipc_tap</code>, <code>bridge_canary</code>, <code>asar_adapter</code></dd>
<dt>Paths &amp; files</dt>
<dd><code>dirs</code> (XDG paths, VM&rarr;host translation), <code>file_identity</code>, <code>file_registry</code>, <code>file_watch_manager</code>, <code>mount_root_bound</code></dd>
<dt>Security policy</dt>
<dd><code>exec_capability_registry</code> (the only exec admission point), <code>user_mcp_allowlist</code>, <code>env_filter</code>, <code>credential_classifier</code>, <code>auto_permissions_cap</code>, <code>tool_preflight_policy</code>, <code>scheduled_task_gate</code></dd>
<dt>Desktop integration</dt>
<dd><code>portal_shortcuts</code> (Wayland GlobalShortcuts portal), <code>startup_check</code></dd>
</dl>

All paths follow the XDG Base Directory spec; each module has a test file in `tests/node/current-path/`.

</details>

<details>
<summary><strong>6. Direct execution</strong></summary>

On macOS, Cowork runs the CLI in a Linux VM. Here it runs on the host. The swift stub resolves the binary in this order, taking the first hit:

```
~/.config/Claude/claude-code-vm/<version>/claude   (newest first; Linux ELF or script only)
$CLAUDE_CODE_PATH                                   (explicit override)
~/.local/bin/claude
~/.npm-global/bin/claude
/usr/local/bin/claude
/usr/bin/claude
/home/linuxbrew/.linuxbrew/bin/claude
~/.linuxbrew/bin/claude
~/.local/share/mise/shims/claude
~/.asdf/shims/claude
claude                                              (PATH lookup)
```

Desktop-downloaded binaries that are macOS Mach-O files or symlinks are skipped, so a stale download can't cause an exit-127 session.

**Code tab.** Desktop downloads a macOS CLI into `~/.config/Claude/claude-code/<version>/claude`. On each start `launch.sh` replaces a Mach-O file there with a copy of your Linux `claude` (keeping the original as `claude.macho-backup`).

</details>

---

## ![](.github/assets/icons/folder-24x24.png) Project Structure

```
claude-cowork-linux/
├── install.sh              # installer, generated launcher, --doctor, --update
├── launch.sh               # sync stubs → patch → repack app.asar → start electron
├── patch-index.sh          # main-process sed passes, sourced by launch.sh and PKGBUILD
├── enable-cowork.py        # Cowork platform-gate patch (sweeps every chunk)
├── fetch-dmg.js            # finds the current Claude Desktop download (Homebrew cask metadata)
├── check-aur-sync.sh       # is the published AUR package this recipe?
├── PKGBUILD, .SRCINFO      # AUR package
├── flake.nix, flake.lock   # Nix flake
├── nix/                    # package.nix, launcher wrapper, icon extraction
├── stubs/
│   ├── @ant/claude-swift/js/index.js   # vm.* API → session orchestrator
│   ├── @ant/claude-native/             # index.js (auth, platform helpers), safe_fs.js
│   ├── cowork/                         # orchestration layer (29 modules + plugin shim)
│   └── frame-fix/                      # entry, wrapper (spoofing, API stubs), OAuth forwarder
├── tests/
│   ├── node/current-path/              # 36 node:test files, 599 cases
│   ├── test-*.sh                       # seven shell suites (patches, pins, sync, flags, install, swap, PKGBUILD)
│   └── Dockerfile.test                 # Arch container for full install runs
├── config/hyprland/claude.conf         # optional Hyprland window rules
├── docs/                               # FAQ, extensions, safeStorage tokens, OAuth compliance audit
├── COMPAT.md                           # tested Claude Desktop versions, pins, known breakage
├── CONTRIBUTING.md, SECURITY.md, LICENSE
└── .github/                            # CI, AUR publish workflow, issue templates, README icons
```

`install.sh` puts everything in `~/.local/share/claude-desktop/` (a clone of this repo plus `linux-app-extracted/`, the unpacked app) and writes the launcher to `~/.local/bin/claude-desktop`. Release notes live on the [Releases][releases] page.

---

## ![](.github/assets/icons/console-24x24.png) Installing by Hand

If the installer can't download Claude Desktop for you, download the macOS archive yourself and hand it over &mdash; everything after the download is the same:

```bash
node fetch-dmg.js --url                # prints the current download URL
./install.sh ~/Downloads/Claude-*.zip  # or a .dmg
# equivalently: CLAUDE_ARCHIVE=~/Downloads/Claude-1.26832.0.zip ./install.sh
```

What the installer does with the archive, in order:

1. `7z x` the archive, find `Claude.app`, and `asar extract` its `Contents/Resources/app.asar` into a **staging** directory, adding `app.asar.unpacked/` and the other `Resources/` files (i18n JSON goes to `resources/i18n/`).
2. Swap the staged tree in as `linux-app-extracted/`. A failure at any earlier point leaves the previous working tree in place.
3. Copy `stubs/` and the helper scripts into the install directory, and seed the `.installed-asar-version` sentinel.
4. Run `enable-cowork.py --sweep` over `index.js` and every `index*.chunk-*.js` that `patch-index.sh` discovers.
5. Create the session directory (mode `700`), optionally `/sessions`, the desktop entry and icon, the `claude://` handler, and `~/.local/bin/claude-desktop`.

On first launch `launch.sh` does the rest: syncs the stubs into the extracted tree, points `package.json`'s `main` at `frame-fix-entry.js`, applies the `patch-index.sh` passes, and repacks `app.asar` into `.asar-cache/`.

---

## Recovery

If a working install broke after a Claude Desktop update, the new build probably changed something this project hasn't caught up with yet.

### Roll back to the last tested build

```bash
cd ~/.local/share/claude-desktop
git pull

# Clear Chromium caches (sessions and credentials are kept)
rm -rf ~/.config/Claude/Cache ~/.config/Claude/"Code Cache" \
       ~/.config/Claude/GPUCache ~/.config/Claude/DawnGraphiteCache

bash install.sh          # no --force: it would skip the prompt and take the latest build
```

When the latest build is newer than the tested one, the prompt offers <kbd>t</kbd>, which prints the URL and SHA-256 recorded in [COMPAT.md][compat] for the tested build. Download and verify it, then:

```bash
CLAUDE_ARCHIVE=/path/to/Claude-<last-tested>.zip bash install.sh --force
```

### Stay put and wait for a fix

The launcher prints a `[WARN]` on the first launch of an untested build. If that build is broken for you, search the [open issues][issues] for its version number; when a fix lands, `claude-desktop --update` picks it up.

### Diagnostics

```bash
claude-desktop --doctor
```

<samp>[OK] Asar version: X (matches last tested)</samp> means you're on the verified baseline; <samp>[WARN] Asar version: X (newer than last tested Y -- see COMPAT.md)</samp> means you're ahead of it.

---

## ![](.github/assets/icons/warning-24x24.png) Troubleshooting

More in the **[FAQ][faq]**.

<details>
<summary><strong>Check that the Cowork patch applied</strong></summary>

On split-entry builds the gate lives in a chunk, not `index.js`, so search the whole build directory:

```bash
grep -l 'cowork-patched' ~/.local/share/claude-desktop/linux-app-extracted/.vite/build/*.js \
  && echo "Cowork patch applied" || echo "Patch missing - run claude-desktop --update"
```

`claude-desktop --doctor` runs the same check. With the patch in place the composer shows a **Chat / Cowork** mode toggle; stock Desktop shows Chat only.

</details>

<details>
<summary><strong><samp>EACCES: permission denied, mkdir '/sessions'</samp></strong></summary>

Create `/sessions` as a symlink into your home directory rather than a world-writable directory:

```bash
mkdir -p ~/.config/Claude/local-agent-mode-sessions/sessions
sudo ln -s ~/.config/Claude/local-agent-mode-sessions/sessions /sessions
```

</details>

<details>
<summary><strong><samp>Claude Code process exited with code 127</samp> / "Claude Code crashed"</strong></summary>

The CLI couldn't be executed. Run `claude-desktop --doctor`, make sure a Linux `claude` exists at one of the paths listed under "Direct execution" in [How It Works](#-how-it-works), and check `~/.local/state/claude-cowork/logs/startup.log` for `[exec-capability] BLOCKED` lines &mdash; those name the command that was refused and why. [COMPAT.md][compat] lists the builds that changed how the CLI is invoked.

</details>

<details>
<summary><strong><samp>Unexpected non-whitespace character after JSON</samp></strong></summary>

A JSON stream parsing problem. The stub line-buffers CLI output so each JSON object arrives whole; if this persists, check the trace log:

```bash
tail -50 ~/.local/state/claude-cowork/logs/claude-swift-trace.log
```

</details>

<details>
<summary><strong>"Failed to start Claude's workspace" / process exits immediately</strong></summary>

1. Run `claude-desktop --doctor`.
2. Check the trace log for `=== MODULE LOADING ===` (the stub loaded) and for the spawn error itself.
3. Common causes: no Claude binary found, `/sessions` missing, or a permission error on the session directory.

</details>

<details>
<summary><strong>App won't relaunch / appears to do nothing</strong></summary>

A previous instance didn't shut down cleanly and left a stale lock:

```bash
rm -f ~/.config/Claude/SingletonLock ~/.config/Claude/SingletonSocket ~/.config/Claude/SingletonCookie
claude-desktop
```

</details>

<details>
<summary><strong>Global shortcuts don't work on Wayland</strong></summary>

Electron's own `globalShortcut` relies on X11 `XGrabKey`, which Wayland doesn't expose, so the app registers shortcuts through the `org.freedesktop.portal.GlobalShortcuts` portal instead. That works on **KDE Plasma**, **Hyprland**, **COSMIC**, and **GNOME 48+** (`xdg-desktop-portal-gnome` 48 and later); the shortcut appears under Settings &rsaquo; Keyboard and may ask for confirmation the first time.

On GNOME before 48 and compositors without the portal, bind `claude-desktop` to a custom shortcut under Settings &rsaquo; Keyboard &rsaquo; Custom Shortcuts.

</details>

<details>
<summary><strong>Running under WSL2</strong></summary>

Cowork runs on WSL2 (tested with WSLg on Ubuntu). Four things to know; `./install.sh --doctor` checks the last three:

1. **Dependency conflicts.** NodeSource's `nodejs` bundles npm and conflicts with the distro `npm` package. The installer installs packages one at a time so one conflict doesn't block the rest.
2. **Missing Electron libraries.** Minimal installs lack NSS/NSPR/ALSA. The installer adds them on apt; by hand: `sudo apt install -y libnspr4 libnss3 libasound2t64` (`libasound2` before Ubuntu 24.04).
3. **OAuth opens in the Windows browser.** WSL's `xdg-open` forwards URLs to Windows, so the `claude://` login callback never reaches the Linux app. The installer offers an opt-in `~/.local/bin/xdg-open` wrapper that routes `claude://` to `claude-desktop` and `http(s)` to a Linux browser; install it with `bash install.sh --wsl-xdg-open`, remove it with `rm ~/.local/bin/xdg-open`. You need a Linux browser (from `.deb`/apt, not snap) for the round trip.
4. **No Secret Service.** Expected on stock WSL2: credentials fall back to the basic store and you sign in again after each WSL restart. Enabling systemd plus `gnome-keyring` makes logins persist.

</details>

---

## ![](.github/assets/icons/console-24x24.png) Development

```bash
./launch.sh             # sync stubs, patch, repack if anything changed, start detached
./launch.sh --dev       # same, in the foreground with output on the terminal
./launch.sh --devtools  # foreground + DevTools + webapp asset dump
./launch.sh --inspect   # foreground + Node inspector on 127.0.0.1:9229 (chrome://inspect)
./launch.sh --perf      # inspector + remote debugging on 127.0.0.1:9222 + IPC tap + verbose tracing
./install.sh --doctor   # environment preflight

npm test                                   # node:test suites (= node --test tests/node/current-path/*.test.cjs)
for t in tests/test-*.sh; do bash "$t"; done   # shell suites (test-install-paths.sh: pass 1 for the CI stage)
```

The install directory is itself a git checkout, and `launch.sh` re-syncs `stubs/` into the app on every start. To try a change against a real install, edit (or check out a branch) in `~/.local/share/claude-desktop` and relaunch. To run a fork through the full installer, see [CONTRIBUTING.md][contributing].

### Debug logging

<dl>
<dt><code>CLAUDE_COWORK_TRACE_IO=1</code></dt>
<dd>Include the CLI's stdin/stdout in the trace log (redacted, but still treat logs as sensitive).</dd>
<dt><code>CLAUDE_COWORK_VERBOSE=1</code></dt>
<dd>Verbose IPC-override logging (also set by <code>--perf</code>).</dd>
<dt><code>CLAUDE_COWORK_IPC_TAP=1</code></dt>
<dd>Log IPC channel traffic to <code>~/.local/state/claude-cowork/logs/ipc-tap.jsonl</code>.</dd>
<dt><code>CLAUDE_COWORK_DEBUG=1</code></dt>
<dd>Extra swift-stub debug output.</dd>
<dt><code>CLAUDE_LOG_DIR</code></dt>
<dd>Log directory; default <code>~/.local/state/claude-cowork/logs</code>.</dd>
</dl>

```bash
tail -f ~/.local/state/claude-cowork/logs/claude-swift-trace.log   # the most useful log
```

Trace lines look like:

```
[timestamp] === MODULE LOADING ===
[timestamp] vm.setEventCallbacks() CALLED with callbacks: stdout=...
[timestamp] vm.spawn() id=...
[timestamp] Resolved Claude binary (Linux): /home/<you>/.local/bin/claude
[timestamp] Process ... exited: code=0 signal=null
```

---

## ![](.github/assets/icons/shield-security-protection-24x24.png) Security

- **Single exec admission point.** Every command the app asks to run goes through `exec_capability_registry.js`, which admits known binaries and the specific commands you declared as MCP servers &mdash; not any file in a user-writable directory.
- **Fail-closed disclaimer wrapper.** The AUR package's root-owned `Helpers/disclaimer` refuses anything the registry refuses.
- **Environment allowlist.** Spawned processes get an allowlisted environment (`env_filter.js`); `credential_classifier.js` redacts tokens from logs, traces, and IPC.
- **Path containment.** Renderer-supplied paths are realpath-checked and must stay inside their root; `safe_fs.js` anchors `*Beneath` operations on a pinned parent fd with `O_NOFOLLOW`.
- **No shell strings.** Processes are started with `execFile` / `spawn` and argument arrays.
- **Origin-checked auth.** `AuthRequest.start()` only opens Anthropic origins; `claude://` URLs are allowlisted.
- **Header and fd guards.** Session-API tokens containing CR, LF, or NUL are rejected, and the auth-token file descriptor must be 3&ndash;9.
- **Private directories.** Session and log directories are mode `700`; `/sessions` is a symlink, never a world-writable directory.
- **Loopback-only debugging.** `--inspect` and `--perf` bind to `127.0.0.1`.
- **Session sandbox (opt-in, experimental).** `CLAUDE_COWORK_SANDBOX=1` runs each Cowork session under bubblewrap: read-only filesystem except the session's own folders, credential stores and Desktop state hidden, private PID/IPC namespaces. It fails closed if bubblewrap can't run. See the [FAQ][faq] entry for what is and isn't exposed.

How credentials move through the app is audited in [OAUTH-COMPLIANCE.md][oauth]. To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## Legal Notice

> [!CAUTION]
> This project is for **educational and research purposes**. Claude Desktop is proprietary software owned by Anthropic PBC, and using Cowork requires a valid Claude account.
>
> This repository contains only stub implementations and patches &mdash; **not** the Claude Desktop application. You must obtain Claude Desktop from Anthropic.
>
> This project is **not affiliated with, endorsed by, or sponsored by** Anthropic. "Claude" is a trademark of Anthropic PBC.

---

## Credits

Reverse engineered by examining the Claude Desktop Electron app, binary analysis with pyghidra-lite, and a lot of iterative debugging.

**Contributors** (see the full list on [GitHub](https://github.com/johnzfitch/claude-cowork-linux/graphs/contributors)):
- [@Boermt-die-Buse](https://github.com/Boermt-die-Buse) &mdash; Linux UI fixes: native window frames, titlebar patch, icon extraction
- [@JaPossert](https://github.com/JaPossert) &mdash; resources copy fix, Wayland global shortcuts report
- [@alpham8](https://github.com/alpham8) &mdash; openSUSE compatibility, binary resolution paths, Swift stub methods
- [@matiasandina](https://github.com/matiasandina) &mdash; icon fix and terminal detach proposals ([#37](https://github.com/johnzfitch/claude-cowork-linux/issues/37))
- [@chefboyrdave21](https://github.com/chefboyrdave21) &mdash; root-causing the automount-root refusal behind [#172](https://github.com/johnzfitch/claude-cowork-linux/issues/172) against a real bundle

---

<div align="center">

**MIT License** &middot; See [LICENSE](LICENSE) for details

</div>
