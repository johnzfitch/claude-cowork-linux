# FAQ and Troubleshooting

Commands below assume an `install.sh` install: the launcher is `claude-desktop` and the scripts live in `~/.local/share/claude-desktop/`. The AUR package's launcher is `claude-cowork`, and it has no `--doctor` or `--update`. The Nix package's `claude-desktop` runs `launch.sh`, so it takes `launch.sh`'s flags rather than the `install.sh` launcher's.

## Installation

<details>
<summary><strong>Which distros are supported?</strong></summary>

`install.sh` installs missing packages with apt, pacman, dnf or zypper (it also knows `nix-env`, but NixOS should use the flake, below). It needs git, 7z, Node.js 18+ with npm, bubblewrap, curl and zstd from your distro, installs `electron` and `asar` with npm into `~/.local` if they are missing, and needs Python 3 for the Cowork patch (see "Do I need Python?"). The AUR package and the Nix flake are built for x86_64 only.

Reported working, each against a specific Claude Desktop build (see [COMPAT.md](../COMPAT.md) for which): Arch Linux (Hyprland), openSUSE, Manjaro (Cinnamon/X11), CachyOS (KDE Plasma/Wayland), Arch with the AUR package (KDE Plasma/Wayland), Fedora 44 (GNOME Wayland), Ubuntu 24.04, and Ubuntu under WSL2 with WSLg.

**NixOS**: use the flake, not `install.sh`. The npm Electron that `install.sh` installs is a prebuilt binary that doesn't run on NixOS.

```bash
nix run github:johnzfitch/claude-cowork-linux
```

The flake builds a pinned Claude Desktop release (set in `nix/package.nix`) against nixpkgs' `electron_41`. `nix develop` gives a shell with every dependency `install.sh` needs, if you want the manual installer flow.

</details>

<details>
<summary><strong>Where does the app install?</strong></summary>

| Method | App files | Launcher |
|--------|-----------|----------|
| `install.sh` | `~/.local/share/claude-desktop/` (override with `CLAUDE_INSTALL_DIR`) | `~/.local/bin/claude-desktop`, plus `~/.local/bin/claude-cowork` as an alias |
| AUR (`yay -S claude-cowork-linux`) | `/usr/lib/claude-cowork/` | `/usr/bin/claude-cowork` |
| Nix flake | the Nix store, copied on first launch to `${XDG_DATA_HOME:-~/.local/share}/claude-cowork-linux/` (the copy needs to be writable) | `claude-desktop` |

For every method, config and session data go to `~/.config/Claude/` and the port's logs go to `~/.local/state/claude-cowork/logs/` (both follow `XDG_CONFIG_HOME` / `XDG_STATE_HOME`).

</details>

<details>
<summary><strong>Do I need Python?</strong></summary>

For `install.sh`, yes, if you want Cowork. Downloading Claude Desktop uses Node.js (`fetch-dmg.js` reads Homebrew's cask metadata for the current URL). But the platform-gate patch that enables Cowork is `enable-cowork.py`, and the installer runs it with `python3` without checking for it first. The installer does not install Python.

Without Python 3 the install still finishes, but it prints `Cowork patch matched no target`, Cowork stays disabled, and the icon is not extracted. `claude-desktop --doctor` reports `Python 3: not found (needed for enable-cowork.py patch)`. Install `python3`, then re-run `bash install.sh` (or `claude-desktop --update`).

The AUR package lists Python as a build dependency, and the Nix build provides it.

</details>

<details>
<summary><strong>7z gives "Dangerous link path" warnings during install</strong></summary>

This is normal. macOS DMGs include an `/Applications` symlink that 7z flags as dangerous on Linux. The installer treats 7z exit codes 1 and 2 as warnings (`7z exited with code 2 (non-fatal; e.g. skipped macOS symlinks)`), and extraction succeeds.

Any higher exit code stops the install with `Failed to extract archive (7z exit code: N)`. If that happens with a `.dmg`, the image may be LZFSE-compressed, which p7zip can't open. Older `.dmg` CDN URLs serve these. Use the `.zip` instead: recent releases ship as `.zip`, and that is what the installer's auto-download fetches.

</details>

<details>
<summary><strong>install.sh stops with "Install dir exists and is not a git checkout"</strong></summary>

The install directory has to be a git checkout of this repo. The installer checks this with `git rev-parse`, so clones, worktrees and submodules all count. If the directory exists, isn't empty and isn't a checkout, the installer stops rather than delete it, because `git clone` can't fill a non-empty directory. Move the directory aside or remove it, or point `CLAUDE_INSTALL_DIR` at an empty or absent path, and re-run.

Older installers deleted such a directory, then failed with `fatal: Unable to read current working directory` when run from inside it. Current installers never delete it.

A related message is `Local repo has modifications, stubs will be synced from source`, which means `git pull --ff-only` in the install directory failed. Local edits cause this, and so does a `CLAUDE_REPO_REF` pin that left the checkout on a detached HEAD. The install keeps going, but it uses whatever scripts the checkout already has. To get it fast-forwarding again:

```bash
git -C ~/.local/share/claude-desktop status
git -C ~/.local/share/claude-desktop checkout master && git -C ~/.local/share/claude-desktop pull
```

</details>

<details>
<summary><strong>How do I update?</strong></summary>

```bash
claude-desktop --update
```

This runs `install.sh --update` from the install directory, which does the following:

1. Pulls the latest scripts and stubs (`git pull --ff-only`).
2. Fetches Claude Desktop, with the same confirmation prompt as a fresh install. Non-interactive runs need `--force`, which skips the prompt.
3. Re-extracts the app, re-installs the stubs, and re-runs `enable-cowork.py`.
4. Records the new asar version in `.installed-asar-version`.

It leaves the launcher, the desktop entry and the icon alone.

A fix that only touches stubs or `patch-index.sh` doesn't need a new download. Run `git -C ~/.local/share/claude-desktop pull` and relaunch. On every start, `launch.sh` copies the stubs into the extracted app, re-applies the `patch-index.sh` passes and repacks `app.asar` if anything changed. Changes to `enable-cowork.py` take effect only through `--update` or a re-install.

For the AUR, rebuild the package (for example `yay -S claude-cowork-linux`). The build always downloads the newest Claude Desktop. For Nix, update the flake input. The Claude Desktop version is pinned in `nix/package.nix`.

</details>

<details>
<summary><strong>How do I roll back to the last tested Claude Desktop build?</strong></summary>

The last tested asar version is the `LAST_TESTED_ASAR_VERSION` line at the top of [COMPAT.md](../COMPAT.md), and its "Pinning a tested version" table records a CDN URL and SHA-256 for the builds that have them. Run the installer **interactively and without `--force`**:

```bash
cd ~/.local/share/claude-desktop && git pull
bash install.sh
```

If the latest build is newer than the tested one, the installer offers `Choice [y/t/N]`. Pick `t`. It prints the `curl` and `sha256sum -c` commands for the tested build from that table, then stops. Download the archive, check it, and install from it:

```bash
CLAUDE_ARCHIVE="$PWD/Claude-<version>.zip" claude-desktop --update
# or a full re-install:
CLAUDE_ARCHIVE="$PWD/Claude-<version>.zip" bash install.sh
```

`--force` skips the prompt and downloads the latest build, so don't use it here. If the tested version has no pinning row, the installer says so. In that case, take a nearby row from the table or use an archive you already have.

To see which build you have: `cat ~/.local/share/claude-desktop/.installed-asar-version`. The launcher prints a one-time `[WARN]` for each installed build that is newer than the last tested one.

</details>

<details>
<summary><strong>Is the AUR package current?</strong></summary>

From a checkout of this repo:

```bash
./check-aur-sync.sh            # report only, exits 0
./check-aur-sync.sh --strict   # exits 1 on drift
```

The script asks the AUR RPC what it serves for `claude-cowork-linux` and compares that with the `pkgver-pkgrel` in this tree's `PKGBUILD`. It prints `IN SYNC` or `DRIFT: the AUR serves X, this tree carries Y`. It needs `curl` and `python3`, and it reports "not verified" and exits 0 when the AUR is unreachable.

`pacman -Q claude-cowork-linux` shows what you have installed. Compare the `pkgrel`, the number after the dash. The version part is the Claude Desktop build that `pkgver()` found when you built the package, not the static `pkgver` in the file.

A stale AUR package runs an old `build()` against this repo's current scripts, because `source=` clones master. That mix produced the `Platform-gate function not found` failure in #189. While the AUR is behind, `install.sh` is the install path that runs the current recipe.

</details>

---

## Login and Auth

<details>
<summary><strong>IndexedDB / LevelDB LOCK login loop (#44)</strong></summary>

**Symptom**: App launches but loops on the login screen, or shows "Session expired" repeatedly.

**Cause**: Stale LevelDB LOCK files from a previous crash.

**Fix** (with Claude closed):
```bash
rm -f ~/.config/Claude/Local\ Storage/leveldb/LOCK
rm -f ~/.config/Claude/IndexedDB/*/LOCK
claude-desktop
```

This is an upstream Electron problem that can hit any Electron app after an unclean shutdown. The wrapper quits cleanly when the last window closes and on SIGTERM, SIGHUP and SIGINT. If the lock files keep coming back, something is probably killing the app in a way it can't handle, such as SIGKILL or a session that ends without signalling it.

</details>

<details>
<summary><strong>OAuth 401 errors</strong></summary>

If Cowork sessions fail with 401 auth errors, check that `filterEnv()` (`stubs/cowork/env_filter.js`) hasn't been modified. How credentials reach the CLI:

1. Claude Desktop builds the session's environment itself. For first-party sessions it sets `ANTHROPIC_API_KEY=""` and `ANTHROPIC_AUTH_TOKEN=""` so nothing inherited overrides its own credential; for bearer-scheme credentials (gateways, `sk-ant-oat` keys) it puts the credential in `ANTHROPIC_AUTH_TOKEN`. `filterEnv()` forwards those keys, empty values included &mdash; dropping them breaks those sessions.
2. From your own shell, `filterEnv()` forwards only a short allowlist (`PATH`, `HOME`, display and locale variables, `ANTHROPIC_API_KEY` and the Bedrock/Vertex switches). Exporting `ANTHROPIC_AUTH_TOKEN` in your shell does not reach the CLI, and an exported `ANTHROPIC_API_KEY` is overridden by the bundle's `""`.

To see which auth variables the bundle passed (names only; values are not logged):

```bash
grep "spawn envVars auth keys" ~/.local/state/claude-cowork/logs/claude-swift-trace.log | tail -5
```

If a key the bundle sends is being dropped, `startup.log` says so by name:

```bash
grep "\[env-filter\] dropped" ~/.local/state/claude-cowork/logs/startup.log
```

Open an issue with that line and the asar version.

See [OAUTH-COMPLIANCE.md](OAUTH-COMPLIANCE.md) for full details.

</details>

<details>
<summary><strong>Safe Storage / token persistence</strong></summary>

**Message**: `Electron safeStorage encryption is not available on this system`

**Impact**: You'll need to re-authenticate each time you start the app.

On every start, the launcher checks D-Bus for a Secret Service (`org.freedesktop.secrets`). If there isn't one, it logs `WARN: org.freedesktop.secrets not available, falling back to --password-store=basic` to `startup.log` and starts Electron with the basic store. `claude-desktop --doctor` shows the same check as `Secret service (org.freedesktop.secrets)`.

**Fix**: Run any Secret Service provider, such as gnome-keyring, KDE Wallet or KeePassXC. See [safestorage-tokens.md](safestorage-tokens.md).

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

This is usually a GPU or rendering problem in Electron. If `claude-desktop` doesn't recognise an argument, it passes it through `launch.sh` to Electron, so Chromium flags work directly:

```bash
# Option 1: Disable GPU acceleration (the AUR launcher already does;
# the install.sh and Nix launchers don't)
claude-desktop --disable-gpu

# Option 2: Software rendering
LIBGL_ALWAYS_SOFTWARE=1 claude-desktop

# Option 3: Run under XWayland instead of native Wayland
claude-desktop --ozone-platform=x11
```

If `startup.log` contains `WARN: package.json still points at index.pre.js but not in the shape this patch rewrites`, the cause is different. The bundle layout changed, and the entry point was never pointed at the Linux frame fix, which also leaves a renderer that never loads. Check [COMPAT.md](../COMPAT.md) for your asar version and open an issue if it isn't listed.

</details>

<details>
<summary><strong>App won't relaunch / stale lock</strong></summary>

Only one instance runs at a time. A second launch while one is running exits at once, and `startup.log` shows `[SingleInstance] Another instance is running, quitting`. Check for a leftover process first:

```bash
pgrep -af app.asar
```

If nothing is running, a previous instance left its lock files behind:

```bash
rm -f ~/.config/Claude/SingletonLock ~/.config/Claude/SingletonSocket ~/.config/Claude/SingletonCookie
claude-desktop
```

The app quits on window close and on SIGTERM, SIGHUP and SIGINT, so stale locks usually mean it was killed in a way it couldn't catch.

</details>

<details>
<summary><strong>Slow startup</strong></summary>

On each start, `launch.sh` repacks `app.asar` if any file in the extracted app is newer than the cached one. That happens after an install, an update, or a stub change, and the log shows `Repacking app.asar...`. Later starts print `Using cached app.asar (no changes)` and skip the repack. The first launch also initializes Chromium's caches.

If every start says `Repacking app.asar...`, something in `linux-app-extracted/` is being rewritten on each launch. Please report it. Timings and messages are in `~/.local/state/claude-cowork/logs/startup.log`.

</details>

<details>
<summary><strong>launch.sh exits with an ERROR</strong></summary>

`claude-desktop` runs `launch.sh` in the background, so these errors only appear in `~/.local/state/claude-cowork/logs/startup.log`:

| Message | Fix |
|---------|-----|
| `ERROR: No electron binary found.` | `launch.sh` looks for `electron` on `PATH`, then `~/.local/bin/electron`. Re-run `bash install.sh`, or `npm install -g --prefix ~/.local electron`. |
| `ERROR: patch-index.sh not found next to launch.sh` | The install directory is incomplete. Re-run `bash install.sh`. |
| `ERROR: asar pack failed.` | Check that the `asar` command is installed and that there is free disk space. `launch.sh` refuses to start Electron against a stale `app.asar`. |

</details>

---

## Cowork (Local Agent Mode)

<details>
<summary><strong>"Failed to start Claude's workspace"</strong></summary>

1. Run `claude-desktop --doctor` to check your environment.
2. Check which Claude CLI the stub picked up:
   ```bash
   grep "Resolved Claude binary" ~/.local/state/claude-cowork/logs/claude-swift-trace.log | tail -3
   ```
   The stub tries a runnable SDK binary under `~/.config/Claude/claude-code-vm/` first. Then it uses `CLAUDE_CODE_PATH` if that is set. Then it checks `~/.local/bin/claude`, `~/.npm-global/bin/claude`, `/usr/local/bin/claude`, `/usr/bin/claude`, Linuxbrew, and the mise/asdf shims, and finally plain `claude` on `PATH`. Set `CLAUDE_CODE_PATH` to force a specific binary.
3. The in-app SDK download needs `curl` and `zstd`. Without them the SDK binary never arrives and sessions don't spawn (#132).
4. Check the startup self-test. It writes one JSON line per launch, and a failure also shows up in `startup.log` as `[COWORK STARTUP CHECK FAILED]`:
   ```bash
   tail -1 ~/.local/state/claude-cowork/logs/cowork-startup.log
   ```
5. Check the trace log (see [Debugging](#debugging)).

The `/sessions` symlink is optional. The wrapper rewrites `/sessions/...` paths to `~/.config/Claude/local-agent-mode-sessions/sessions/...` inside the app. If the symlink exists, it must point there. The installer corrects a wrong target, and `--doctor` shows the current target.

</details>

<details>
<summary><strong>Cowork mode is missing, or doctor says "Cowork patch: not applied"</strong></summary>

In current Claude Desktop builds, Cowork is a `Chat`/`Cowork` mode toggle on the composer. Stock builds show only Chat on Linux, so a missing toggle means the platform-gate patch didn't apply.

- During install, `Cowork patch matched no target: the platform gate was not found in index.js or any index*.chunk-*.js` means `enable-cowork.py` didn't recognise this bundle's gate. This also happens when `python3` is missing (see "Do I need Python?").
- `claude-desktop --doctor` greps the extracted app for the patch marker and reports `Cowork patch: applied` or `not applied`.

Check [COMPAT.md](../COMPAT.md) for your asar version. If the version isn't listed, open an issue with it. To go back to a build that is known to work, see the rollback entry under Installation.

</details>

<details>
<summary><strong>Process exits immediately (exit code 1)</strong></summary>

The exit line is always logged:
```bash
grep "exited: code=" ~/.local/state/claude-cowork/logs/claude-swift-trace.log | tail -5
```

The CLI's stderr only appears in the trace log when `CLAUDE_COWORK_TRACE_IO=1` is set (see [Debugging](#debugging)).

Common causes:
- Claude binary not found (see the entry above)
- A `/sessions` symlink pointing somewhere other than `~/.config/Claude/local-agent-mode-sessions/sessions`
- Permission issues on session directories

</details>

<details>
<summary><strong>Transcripts lost after restart</strong></summary>

Transcripts are written under the session's `.claude` directory. The stub translates the bundle's `/sessions/...` paths, including `CLAUDE_CONFIG_DIR`, to host paths before it spawns the CLI. Check that chain:

```bash
# 1. Check the env translation
grep "Translated envVar CLAUDE_CONFIG_DIR" ~/.local/state/claude-cowork/logs/claude-swift-trace.log | tail -3

# 2. If /sessions exists, it must point here
readlink /sessions
# Should be: ~/.config/Claude/local-agent-mode-sessions/sessions

# 3. Check session .claude directories resolve correctly
ls -la ~/.config/Claude/local-agent-mode-sessions/sessions/*/mnt/.claude

# 4. Check transcripts exist
find ~/.config/Claude/local-agent-mode-sessions/ -name "*.jsonl" -path "*projects*"
```

</details>

<details>
<summary><strong>Code tab: exit code 126 / binary not executable</strong></summary>

The asar downloads a macOS Mach-O binary to `~/.config/Claude/claude-code/<version>/claude`. On each start, `launch.sh` finds it and replaces it with a copy of your Linux Claude binary. It takes the first of `~/.local/bin/claude`, `~/.npm-global/bin/claude`, `/usr/local/bin/claude` or `/usr/bin/claude`, and keeps the original as `claude.macho-backup`. It copies rather than symlinks, so the path resolver only ever sees a real binary. This step is part of `launch.sh` only, so it runs for the install.sh and Nix launchers but not the AUR launcher. It also only matches that flat layout. Builds that put the CLI under `claude.app/Contents/MacOS/` are covered by the next entry.

If the fix didn't apply:
```bash
# Find the Mach-O binary
file ~/.config/Claude/claude-code/*/claude

# Replace manually
LINUX_CLAUDE=$(which claude)
for bin in ~/.config/Claude/claude-code/*/claude; do
  if file "$bin" | grep -q "Mach-O"; then
    mv "$bin" "${bin}.macho-backup"
    cp "$(readlink -f "$LINUX_CLAUDE")" "$bin"
  fi
done
```

</details>

<details>
<summary><strong>"Claude Code crashed" on every message / exit code 127 (asar 1.40609.0+)</strong></summary>

**Log**: `startup.log` shows `[exec-capability] BLOCKED (unresolvable): --` (or `--pgroup`), then
`Claude Code process exited with code 127` a few milliseconds after spawn.

Newer bundles call the disclaimer wrapper as `disclaimer -- <cmd> [args...]` (from asar 1.40609.0) or `disclaimer --pgroup -- <cmd> [args...]` (2.7032.0). Older versions of the port read the command from the first argument and saw `--` or `--pgroup`. They couldn't resolve it, so they fell through to the fail-closed disclaimer stub, which exits 127 by design (#185, #195).

Update the port and relaunch (see "How do I update?"; AUR users rebuild the package). The `Fix Code tab binary` step in `launch.sh` is not the lever here: it only matches the flat `claude-code/<version>/claude` layout, and the bundle re-downloads the macOS binary at session start anyway. What has to work is `resolveDisclaimerCommand()` in `stubs/cowork/exec_capability_registry.js`, which skips the wrapper flags and the separator before it reads the command.

</details>

---

## Desktop Environment

<details>
<summary><strong>Global shortcuts don't work on GNOME Wayland (#28)</strong></summary>

`xdg-desktop-portal-gnome` implements the GlobalShortcuts portal since **GNOME 48** (refined in 50) — shortcuts work there, appear under Settings > Keyboard, and may prompt for confirmation on first registration. On GNOME < 48 the portal is missing and shortcuts silently fail.

`launch.sh` prints `NOTE: GNOME Wayland does not support the GlobalShortcuts portal` on every GNOME Wayland session, whatever the GNOME version. On GNOME 48 and later you can ignore it.

**Workaround for GNOME < 48**: Set a custom shortcut in GNOME Settings > Keyboard > Custom Shortcuts to launch `claude-desktop`.

The port's portal client (`stubs/cowork/portal_shortcuts.js`) works with any compositor whose portal backend implements `org.freedesktop.portal.GlobalShortcuts`. Its notes list KDE Plasma, Hyprland, COSMIC and wlroots compositors such as Sway. To check yours:

```bash
busctl --user introspect org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop | grep GlobalShortcuts
```

</details>

<details>
<summary><strong>Tray icon invisible or wrong variant (#64)</strong></summary>

The app ships a macOS template tray icon (black-on-transparent) that Linux panels don't auto-tint. The wrapper uses the white variant by default, since most Linux panels are dark. On a light panel, set `CLAUDE_TRAY_ICON=light` before launching to use the black variant instead.

</details>

<details>
<summary><strong>Hyprland: blurry or incorrect opacity</strong></summary>

Install the window rules from the repo (`config/hyprland/claude.conf`; for `install.sh` installs it is in the install directory):
```bash
cp ~/.local/share/claude-desktop/config/hyprland/claude.conf ~/.config/hypr/
# Add to ~/.config/hypr/hyprland.conf:
source = ~/.config/hypr/claude.conf
```

The rules match the window class `Claude`, which every launcher sets with `--class=Claude`. They force full opacity and float the DevTools window.

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

If Node.js was installed from NodeSource, the distro `npm` package conflicts with it and apt refuses the transaction. The installer installs missing packages one at a time on apt, so the conflict no longer blocks `zstd`, `curl`, etc. NodeSource's `nodejs` package already bundles npm — don't install distro `npm` alongside it.

</details>

<details>
<summary><strong>Electron fails to start: missing shared libraries</strong></summary>

Fresh minimal Ubuntu/WSL2 installs lack the NSS/NSPR/ALSA libraries that the npm Electron build links against. The installer adds them on apt-based systems. To add them by hand:

```bash
sudo apt install -y libnspr4 libnss3 libasound2t64   # libasound2 before Ubuntu 24.04
```

`./install.sh --doctor` runs `ldd` against the npm Electron binary and lists anything unresolved.

</details>

<details>
<summary><strong>OAuth login opens in the Windows browser and never completes</strong></summary>

WSL2's `xdg-open` forwards URLs to Windows via interop, bypassing `$BROWSER`. The login page opens in your Windows browser, but the `claude://` callback is registered in Linux — so the login never round-trips.

Fix: install the opt-in wrapper. It shadows `xdg-open` in `~/.local/bin` and routes `claude://` URLs to `claude-desktop`. It sends `http(s)` URLs to `$BROWSER` or the first of firefox, chromium, google-chrome or brave-browser that it finds, and passes everything else to the system `xdg-open`. A full install on WSL2 offers it interactively; you can also install it on its own at any time:

```bash
bash install.sh --wsl-xdg-open
```

For non-interactive installs, set `INSTALL_WSL_XDG_OPEN=1`. The installer won't overwrite a `~/.local/bin/xdg-open` that it didn't write.

You need a Linux browser for the OAuth page (install Chrome or Firefox via apt/.deb, **not snap**, so it runs under WSLg). Without one, `http(s)` links still open in Windows, and `--doctor` warns about it. To remove the wrapper: `rm ~/.local/bin/xdg-open`. Note the wrapper affects every app in your WSL session that calls `xdg-open`.

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

This is harmless. The Chrome Extension native messaging host binary is only built for macOS/Windows. Newer bundles pair the Claude in Chrome extension over a WebSocket bridge instead of that native host. That path does work on Linux once the bridge transport passes are applied (see the next entry). Otherwise use MCP servers instead. See [extensions.md](extensions.md).

</details>

<details>
<summary><strong>Claude in Chrome never pairs: "o.net.WebSocket is not a constructor"</strong></summary>

**Log**: `startup.log` shows
`[bridge-ws] using net.WebSocket transport for wss://bridge.claudeusercontent.com/chrome/<uuid>`,
then `[claude-in-chrome] Failed to create WebSocket after 21ms: o.net.WebSocket is not a constructor`,
and eventually `Giving up bridge reconnection after 100 attempts`.

The desktop app chooses between Electron's `net.WebSocket` and the bundled `ws` package behind a remote feature flag. Some Electron builds have no `net.WebSocket` (Electron 42.1.0 in the #187 report). On those, the constructor call throws before any network I/O. `install.sh` installs whatever Electron npm currently serves, and the AUR package uses Arch's `electron`, so which build you have depends on when you installed. The in-app assistant tends to report this as the extension being signed out, but re-authenticating in the side panel cannot fix it.

Two `patch-index.sh` passes (#187) test for `net.WebSocket` and fall back to `ws` when it is absent. Where `net.WebSocket` exists, the flag still decides. Update the port and relaunch: the launcher re-applies the passes to the extracted tree and repacks `app.asar` whenever anything in it changed. For the AUR, the passes are applied at build time, so rebuild the package. If the log still says `using net.WebSocket transport` afterwards, the pass did not match your bundle. Run `claude-desktop --doctor` and open an issue with the asar version.

</details>

<details>
<summary><strong>MCP server not appearing after config change</strong></summary>

1. Check config syntax:
   ```bash
   python3 -m json.tool ~/.config/Claude/claude_desktop_config.json
   ```
2. Restart Claude Desktop completely
3. Verify the command works standalone:
   ```bash
   npx -y @modelcontextprotocol/server-filesystem --help
   ```

</details>

<details>
<summary><strong>Local MCP server disconnects: "BLOCKED (not a declared MCP server)"</strong></summary>

The bundle starts local MCP servers through the disclaimer wrapper, and the port only runs commands from the following sources:

- the Claude CLI
- system command paths
- binaries you have declared as MCP servers

The declarations it reads are:

- `mcpServers` in `~/.config/Claude/claude_desktop_config.json`
- `mcpServers` in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`)
- the per-project `mcpServers` in that same file
- each of those projects' `.mcp.json`

A user-installed binary that isn't declared in any of these is refused. `startup.log` names it:

```
[exec-capability] BLOCKED (not a declared MCP server): /path/to/binary -- add it to "mcpServers" in claude_desktop_config.json or .claude.json to allow it.
```

Add the server to one of those files and restart. Servers that a plugin declares in a config file at some other path are not read yet, so they are refused too.

</details>

<details>
<summary><strong>"Extension filesystem not found" warning</strong></summary>

This is non-critical. Refers to an internal extension system, not MCP servers. The app works fine without it.

</details>

---

## Debugging

<details>
<summary><strong>Where do logs live?</strong></summary>

All of these are in `~/.local/state/claude-cowork/logs/`, or `$XDG_STATE_HOME/claude-cowork/logs/`:

| File | What writes it |
|------|----------------|
| `startup.log` | Electron's own output when started through `claude-desktop` or `launch.sh` (install.sh and Nix). The AUR launcher doesn't write it; its output goes to the terminal or session that started it. |
| `claude-swift-trace.log` | The VM/spawn stub, on every launch: CLI resolution, spawns, path translation, exits. When it passes 50 MB it is cut down to its last 10 MB at startup. |
| `cowork-startup.log` | One JSON line per launch from the startup self-test. |
| `ipc-tap.jsonl`, `bridge-canary.jsonl` | IPC traffic, only with `CLAUDE_COWORK_IPC_TAP=1` (which `--perf` sets). |
| `claude-native-trace.log` | The native-module stub, only with `CLAUDE_NATIVE_TRACE` set. |
| `epipe-suppressed.log` | Broken-pipe errors the wrapper swallowed instead of showing an error dialog. |
| `webapp-assets/`, `webapp-assets.bak/` | The `--devtools` asset dump (below). |

`launch.sh`, the swift stub and the asset dumper use `CLAUDE_LOG_DIR` if you set it. The self-test, IPC tap and bridge canary always write to the XDG path.

Claude Desktop's own data, including sessions and transcripts, is under `~/.config/Claude/`.

</details>

<details>
<summary><strong>How to capture logs</strong></summary>

```bash
cd ~/.local/share/claude-desktop

# Run in the foreground: output goes to the terminal and is appended to startup.log
./launch.sh --dev

# Watch the stub trace log
tail -f ~/.local/state/claude-cowork/logs/claude-swift-trace.log

# Verbose trace: adds CLI stdout/stderr lines (truncated, credentials redacted)
CLAUDE_COWORK_TRACE_IO=1 ./launch.sh --dev
```

`./launch.sh` with no flags detaches like `claude-desktop`, so piping it into `tee` only captures the launcher's own lines. Use `--dev` instead.

</details>

<details>
<summary><strong>Debugging the main process (Node inspector, profiling)</strong></summary>

```bash
cd ~/.local/share/claude-desktop

# Node inspector on the main process, bound to 127.0.0.1:9229 (foreground)
./launch.sh --inspect

# Profiling: inspector on 9229, remote debugging on 127.0.0.1:9222, DevTools,
# IPC tap, CLI I/O tracing and verbose IPC logging (foreground)
./launch.sh --perf
```

Attach from `chrome://inspect` in a Chromium browser. `launch.sh` binds both ports to localhost only. It replaces the old `launch-devtools.sh`, which has been removed.

</details>

<details>
<summary><strong>DevTools and webapp asset inspection</strong></summary>

Launch with `--devtools` to open Chromium DevTools and automatically dump the
webapp's JS/CSS/JSON/HTML assets (from `claude.ai` and `*.anthropic.com`) to disk:

```bash
./launch.sh --devtools        # foreground
claude-desktop --devtools     # detached; output goes to startup.log
```

Assets are saved to `~/.local/state/claude-cowork/logs/webapp-assets/`.
The previous dump is rotated to `webapp-assets.bak/` on each launch.

**Useful commands after an asar or webapp update:**

```bash
# Compare current vs previous webapp assets to spot protocol changes
diff -rq ~/.local/state/claude-cowork/logs/webapp-assets/ \
         ~/.local/state/claude-cowork/logs/webapp-assets.bak/

# Search dumped assets for the Cowork IPC channel names the webapp calls
rg "LocalAgentModeSessions_\\\$_" ~/.local/state/claude-cowork/logs/webapp-assets/

# Verify transcript path chain
grep "Translated envVar CLAUDE_CONFIG_DIR" \
  ~/.local/state/claude-cowork/logs/claude-swift-trace.log

# List session metadata files with their CLI session IDs
find ~/.config/Claude/local-agent-mode-sessions -name 'local_*.json' \
  -exec node -e 'const d=require(process.argv[1]);console.log(d.sessionId, d.cliSessionId||"MISSING")' {} \;
```

To see which IPC handlers the main process registers, run with `--perf`. The IPC tap writes every registration and call to `ipc-tap.jsonl`.

</details>

<details>
<summary><strong>Trace log format</strong></summary>

The stub writes to `~/.local/state/claude-cowork/logs/claude-swift-trace.log`:

```
[timestamp] === MODULE LOADING ===
[timestamp] Trace IO logging: disabled
[timestamp] vm.setEventCallbacks() CALLED with callbacks: stdout=true stderr=true exit=true
[timestamp] vm.startVM() bundlePath=... memoryGB=...
[timestamp] vm.spawn() id=...
[timestamp] vm.spawn() command=...
[timestamp] vm.spawn() args=[...]
[timestamp] Resolved Claude binary (Linux): /home/you/.local/bin/claude
[timestamp] Translated envVar CLAUDE_CONFIG_DIR: /sessions/<name>/mnt/.claude -> ~/.config/Claude/local-agent-mode-sessions/sessions/<name>/mnt/.claude
[timestamp] stdout line: {"type":"stream_event",...}      (only with CLAUDE_COWORK_TRACE_IO=1)
[timestamp] Process ... exited: code=0 signal=null
```

Credentials are redacted before they're written.

</details>

<details>
<summary><strong>Running the doctor command</strong></summary>

```bash
claude-desktop --doctor
# or, from the install directory or any checkout
./install.sh --doctor
```

It checks the following:

- Required binaries: git, 7z, node, npm, electron, asar, bwrap, curl, zstd.
- Node.js 18 or newer.
- Electron's shared libraries, by running `ldd` on the npm build.
- The Claude CLI.
- The `/sessions` symlink, which is optional.
- The Secret Service.
- On WSL, the xdg-open wrapper and a Linux browser.
- The installed asar version against the last tested one.
- The extracted app, the Cowork patch marker and the swift stub.
- Python 3.
- Whether `claude-desktop` and `claude-cowork` on `PATH` are the installed launchers.

It exits non-zero only on failures. Warnings are informational.

The checks for the extracted app and the asar version look in `~/.local/share/claude-desktop` (or `CLAUDE_INSTALL_DIR`), so on AUR and Nix installs those lines warn even when the app is fine.

</details>

---

## Reporting Issues

If your issue isn't listed here:

1. Capture logs (see [Debugging](#debugging))
2. Run `claude-desktop --doctor` (or `./install.sh --doctor`)
3. Report at [github.com/johnzfitch/claude-cowork-linux/issues](https://github.com/johnzfitch/claude-cowork-linux/issues) with:
   - Distro and desktop environment
   - Install method (install.sh, AUR or Nix) and the port's version or commit
   - Claude Desktop (asar) version: `cat ~/.local/share/claude-desktop/.installed-asar-version`
   - Relevant log snippets (redact any tokens)
   - Steps to reproduce
