# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Linuxbrew binary path (`/home/linuxbrew/.linuxbrew/bin/claude`) as candidate in
  Claude binary resolution for systems using Homebrew on Linux
- PATH-based fallback in `install.sh --doctor` for Claude binary detection
  (finds claude installed via linuxbrew, mise, asdf, or other version managers)
- openSUSE-specific section in `docs/known-issues.md` covering package names,
  KDE Wallet integration, and user namespace status
- openSUSE `libnotify-tools` package in notification troubleshooting docs
- Confirm-before-quit dialog when closing the main window. On macOS the close
  button hides the window to the dock/tray; on Linux (especially KDE Plasma 6
  Wayland) restoring from the system tray is unreliable, so closing now asks
  "Do you really want to quit Claude?" with localized button labels (10 languages).
  This prevents accidental data loss from unintentionally quitting the app
- Swift stub additions: `api.setCredentials()`, `quickAccess.overlay.*`, and
  `quickAccess.dictation.*` stubs to prevent errors from newer asar versions

### Changed

- Window close behavior: closing the window now minimizes to the taskbar instead
  of hiding to the system tray. On KDE Plasma 6 Wayland, Electron's system tray
  integration is broken — KDE calls `ProvideXdgActivationToken` on the
  `StatusNotifierItem` D-Bus interface before `Activate`, but Electron does not
  implement this method. Without an activation token the Wayland compositor
  silently blocks `BrowserWindow.focus()`, making it impossible to restore the
  window from the tray. The previous KWin scripting workaround
  (`org.kde.kwin.Scripting`) was fragile and had race conditions, so it was
  replaced with the simpler confirm-before-quit approach
- openSUSE compatibility status updated from "Untested" to "Tested" (openSUSE
  Tumbleweed with KDE Plasma, kernel 6.19.2)
- Requirements section now lists distro-specific 7-Zip package names
  (`p7zip` on Arch/Debian/Fedora, `7zip` on openSUSE)

### Fixed

- `install.sh`: zypper package name `p7zip` changed to `7zip` for openSUSE
  Tumbleweed (the `p7zip` package does not exist on openSUSE)
- `install.sh`: zypper package list changed from `nodejs npm` to `nodejs-default`
  for openSUSE (npm is provided by `nodejs-common`, pulled automatically)
- `test-flow.sh`: replaced hardcoded path `/home/zack/dev/claude-cowork-linux`
  with `SCRIPT_DIR` variable derived from `${BASH_SOURCE[0]}`
- README trace log path corrected from `~/.local/share/claude-cowork/logs/` to
  actual location `~/Library/Application Support/Claude/logs/`

## [3.0.2] - 2026-02-27

### Added

- `--doctor` preflight diagnostics flag for `install.sh` and `claude-desktop`
  launcher (validates 15 checks: binaries, node version, CLI, /sessions, secret
  service, patches, stubs)
- `CustomPlugins_$_listAvailablePlugins` IPC handler stub to prevent error spam
  from new asar builds
- Linux UI fixes: native window frames, icon extraction from `.icns`, titlebar
  patch removing macOS `titleBarOverlay`/`trafficLightPosition`
- Dynamic eipc UUID extraction (UUID changes per asar build; no more hardcoding)
- i18n path fix for resource JSON files

### Changed

- Spawn command handling accepts bare `claude` and vetted absolute paths, not
  just `/usr/local/bin/claude` (Claude Desktop changed its spawn call)
- Password store detection: runtime SecretService D-Bus check with fallback to
  `--password-store=basic` (no longer hard dependency on gnome-keyring)
- AUR PKGBUILD: `gnome-keyring` moved from hard dep to optdep
- IPC handler tracking refactored: removed tracked `ipc-handler-setup.js`,
  aligned launcher runtime

### Fixed

- Filter out macOS-only mounts (`/Applications`) in Cowork sessions to prevent
  `EACCES` errors on Linux

## [3.0.1] - 2026-02-24

### Added

- `FileSystem_$_readLocalFile` IPC handler for Cowork file preview
- Wayland global shortcuts portal support (`--enable-features=GlobalShortcutsPortal`)

### Fixed

- 7z exit code handling (exit 1 = warning, not error)
- Resources copy from DMG extraction
- Version bump to 3.0.1

### Security

- Restrict `readLocalFile` to session directories with file size cap

## [3.0.0] - 2026-02-22

### Added

- Auto-download DMG via rnet (bypasses Cloudflare on the API endpoint)
- Browser-first DMG download fallback with XDG download directory watching
- Complete installer (`install.sh`): dependency detection, repo cloning, DMG
  extraction, stub installation, patch application, launcher and desktop entry
  creation
- PKGBUILD rewrite for AUR distribution
- SDK bridge class for session state management
- Multi-UUID EIPC event dispatch with dynamic UUID discovery
- Linux binary resolution (claude-code-vm, CLAUDE_CODE_PATH, ~/.local/bin, PATH)
- OAuth compliance audit and documentation
- AuthRequest URL origin validation (Anthropic-only domains)
- Environment variable filtering with `BLOCKED_ENV_KEY_PATTERN` and
  `CREDENTIAL_EXEMPT_KEYS`

### Changed

- Installer refactored to user-local paths (no sudo for app install)
- Installer uses clone + extract workflow matching dev environment
- DMG download strategy: rnet auto-download -> CDN curl -> browser fallback

### Fixed

- Auth 401 error: reverted `ANTHROPIC_AUTH_TOKEN` injection that bypassed CLI's
  OAuth handler
- Launcher path bug and version-resilient cowork patch
- Download timeout handling in installer
- Browser download watcher hardening
- Install log output redirected to stderr

### Security

- OAuth token and environment variable handling hardened
- `BLOCKED_ENV_KEY_PATTERN` narrowed with `CREDENTIAL_EXEMPT_KEYS`

## [1.23.26] - 2026-01-28

### Added

- AUR PKGBUILD for Arch Linux distribution

## [1.1.799] - 2026-01-28

### Added

- Frame-fix wrapper files for AUR build compatibility
- `js/` directory structure for claude-swift stub

### Fixed

- PKGBUILD adapted to use Windows installer source
- `js/` directory for claude-swift stub creation
- stdin error handler preservation during cleanup to catch late EPIPE

## [1.0.0] - 2026-01-14

### Added

- Initial release: Claude Cowork running on Linux without VM
- Platform spoofing (darwin/arm64 headers for server-side feature gating)
- Swift addon stub (`@ant/claude-swift`): `vm.spawn()`, `vm.kill()`,
  `vm.writeStdin()`, `vm.setEventCallbacks()`, `vm.startVM()`
- Native module stub (`@ant/claude-native`): auth via `xdg-open`, keyboard
  constants, platform helpers
- Path translation: `/sessions/...` to host paths, `/usr/local/bin/claude`
  to resolved binary
- Mount symlink creation for session directories
- Session persistence via `sessions.json`
- Environment variable allowlist filtering
- Automatic logging with rotation
- VM path translation and file operations
- Cowork tab restoration by patching platform check
- Wayland support with X11 fallback
- Desktop integration stubs (file viewing, notifications)
- One-click installer with security improvements

### Security

- Command injection prevention (execFile instead of exec)
- Path traversal protection
- Secure file permissions (0o700 directories, 0o600 logs)
- Trace log redaction for sensitive values

[Unreleased]: https://github.com/johnzfitch/claude-cowork-linux/compare/v3.0.2...HEAD
[3.0.2]: https://github.com/johnzfitch/claude-cowork-linux/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/johnzfitch/claude-cowork-linux/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/johnzfitch/claude-cowork-linux/compare/v1.23.26...v3.0.0
[1.23.26]: https://github.com/johnzfitch/claude-cowork-linux/compare/v1.1.799...v1.23.26
[1.1.799]: https://github.com/johnzfitch/claude-cowork-linux/compare/v1.0.0...v1.1.799
[1.0.0]: https://github.com/johnzfitch/claude-cowork-linux/releases/tag/v1.0.0
