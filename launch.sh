#!/bin/bash
# Test launcher for claude-cowork-linux
# Uses the AppImage's electron with a repacked app.asar (bakes in stubs/patches)

set -o pipefail

# Change to script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure ~/.local/bin is in PATH (common for user-local electron installs)
export PATH="$HOME/.local/bin:$PATH"

# Point Cowork at the user's Claude Code CLI binary
if [ -z "$CLAUDE_CODE_PATH" ]; then
  for _candidate in "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude" "/usr/local/bin/claude"; do
    if [ -x "$_candidate" ]; then
      export CLAUDE_CODE_PATH="$_candidate"
      break
    fi
  done
fi

# Wayland auto-detect: let Electron use native Wayland when available
if [ -z "$ELECTRON_OZONE_PLATFORM_HINT" ]; then
  export ELECTRON_OZONE_PLATFORM_HINT=auto
fi

# Resolve electron binary: prefer system electron + local .asar-cache, fall back to AppImage
if command -v electron >/dev/null 2>&1; then
  ELECTRON_BIN="$(command -v electron)"
  ASAR_FILE=".asar-cache/app.asar"
  mkdir -p ".asar-cache"
elif [[ -x "$HOME/.local/bin/electron" ]]; then
  ELECTRON_BIN="$HOME/.local/bin/electron"
  ASAR_FILE=".asar-cache/app.asar"
  mkdir -p ".asar-cache"
elif [[ -x "./squashfs-root/usr/lib/node_modules/electron/dist/electron" ]]; then
  ELECTRON_BIN="./squashfs-root/usr/lib/node_modules/electron/dist/electron"
  ASAR_FILE="squashfs-root/usr/lib/node_modules/electron/dist/resources/app.asar"
else
  echo "ERROR: No electron binary found. Install electron or place an AppImage in squashfs-root/"
  exit 1
fi

STUB_FILE="linux-app-extracted/node_modules/@ant/claude-swift/js/index.js"
STUB_SRC_FILE="stubs/@ant/claude-swift/js/index.js"

NATIVE_STUB_FILE="linux-app-extracted/node_modules/@ant/claude-native/index.js"
NATIVE_STUB_SRC_FILE="stubs/@ant/claude-native/index.js"

# Ensure the extracted app tree has the latest stubs baked in before packing.
# This avoids relying on runtime module interception (ESM import() bypasses Module._load).
if [ -f "$STUB_SRC_FILE" ]; then
  mkdir -p "$(dirname "$STUB_FILE")"
  cp -f "$STUB_SRC_FILE" "$STUB_FILE"
fi

if [ -f "$NATIVE_STUB_SRC_FILE" ]; then
  mkdir -p "$(dirname "$NATIVE_STUB_FILE")"
  # Copy index.js plus any sibling helper modules it require()s (e.g.
  # safe_fs.js, added for the asar 1.22209.x safe-fs containment API).
  for _nat_src in stubs/@ant/claude-native/*.js; do
    [ -f "$_nat_src" ] && cp -f "$_nat_src" "$(dirname "$NATIVE_STUB_FILE")/$(basename "$_nat_src")"
  done
fi

# Sync frame-fix files so wrapper changes take effect without a full reinstall
for _ff_file in frame-fix-entry.js frame-fix-wrapper.js; do
  if [ -f "stubs/frame-fix/$_ff_file" ]; then
    cp -f "stubs/frame-fix/$_ff_file" "linux-app-extracted/$_ff_file"
  fi
done

# Sync cowork orchestration modules into the extracted app tree.
if [ -d "stubs/cowork" ]; then
  mkdir -p "linux-app-extracted/cowork"
  cp -f stubs/cowork/*.js "linux-app-extracted/cowork/"
fi

# Replace macOS pty.node with the Linux ELF build. The DMG ships a Mach-O
# universal binary that dlopen rejects ("invalid ELF header"), breaking
# any LocalSessions.startShellPty path. Built against Electron 41 ABI.
if [ -f "stubs/node-pty-linux/pty.node" ]; then
  _PTY_DEST="linux-app-extracted/node_modules/node-pty/build/Release"
  if [ -d "$_PTY_DEST" ]; then
    cp -f stubs/node-pty-linux/pty.node "$_PTY_DEST/pty.node"
  fi
fi

# Install plugin permission shim so the asar can find it.
# The asar resolves the shim from its own resources/ directory (inside the asar),
# so we copy it into the extracted tree before repacking. Also copy to Electron's
# resources dir as a fallback for process.resourcesPath lookups.
if [ -f "stubs/cowork/cowork-plugin-shim.sh" ]; then
  mkdir -p "linux-app-extracted/resources"
  cp -f stubs/cowork/cowork-plugin-shim.sh "linux-app-extracted/resources/cowork-plugin-shim.sh"
  chmod +x "linux-app-extracted/resources/cowork-plugin-shim.sh"
  _RESOURCES_DIR="$(dirname "$ELECTRON_BIN")/resources"
  if [ -d "$_RESOURCES_DIR" ]; then
    cp -f stubs/cowork/cowork-plugin-shim.sh "$_RESOURCES_DIR/cowork-plugin-shim.sh"
    chmod +x "$_RESOURCES_DIR/cowork-plugin-shim.sh"
  fi
fi

# ============================================================
# Linux UI Fixes (applied before every repack)
# ============================================================

# Fix i18n: the app expects resources/i18n/*.json but DMG extracts to resources/*.json
if [ -d "linux-app-extracted/resources" ] && [ ! -d "linux-app-extracted/resources/i18n" ]; then
  echo "Fixing i18n paths..."
  mkdir -p "linux-app-extracted/resources/i18n"
  for f in linux-app-extracted/resources/*.json; do
    [ -f "$f" ] && cp "$f" "linux-app-extracted/resources/i18n/"
  done
fi

# Fix entry point: use frame-fix-entry.js so BrowserWindow gets native Linux frames
PKG_JSON="linux-app-extracted/package.json"
if [ -f "$PKG_JSON" ] && grep -q '"main":.*index\.pre\.js"' "$PKG_JSON"; then
  echo "Fixing entry point to use frame-fix-entry.js..."
  sed -i 's|"main":.*"\.vite/build/index\.pre\.js"|"main": "frame-fix-entry.js"|' "$PKG_JSON"
fi

# ── Main-process patches ────────────────────────────────────────────────────
# The sed passes that make the minified main-process bundle work on Linux live
# in patch-index.sh, not here. launch.sh and PKGBUILD's build() both source that
# one file, so the two entry points cannot drift apart again (#170: launch.sh
# had grown to 9 passes while the AUR recipe still applied 3, and AUR users
# silently lost the MCP node-host and resourcesPath fixes).
if [ ! -f "$SCRIPT_DIR/patch-index.sh" ]; then
  echo "ERROR: patch-index.sh not found next to launch.sh ($SCRIPT_DIR)." >&2
  echo "       It carries every main-process patch pass. Launching without it" >&2
  echo "       would start an unpatched app: macOS titlebars, no local MCP" >&2
  echo "       servers, and a renderer shell that never loads. Re-run" >&2
  echo "       install.sh to restore it." >&2
  exit 1
fi
# shellcheck source=patch-index.sh
source "$SCRIPT_DIR/patch-index.sh"

patch_index_apply_all "linux-app-extracted/.vite/build"

# Only repack if stub is newer than asar (or asar doesn't exist)
# Repack if any file in the extracted tree is newer than the cached asar.
_needs_repack=false
if [ ! -f "$ASAR_FILE" ]; then
  _needs_repack=true
else
  while IFS= read -r -d '' _f; do
    if [ "$_f" -nt "$ASAR_FILE" ]; then
      _needs_repack=true
      break
    fi
  done < <(find linux-app-extracted -type f -print0)
fi
if [ "$_needs_repack" = true ]; then
  echo "Repacking app.asar..."
  # Stop on failure. launch.sh has no `set -e`, so an asar pack that died
  # (asar not installed, disk full, a partially-written target) used to fall
  # straight through to launching electron against whatever was there before —
  # a stale asar, or none at all. The stale case is the dangerous one: the app
  # comes up looking fine, running the previous build, with the failure already
  # scrolled off.
  if ! asar pack linux-app-extracted "$ASAR_FILE"; then
    echo "ERROR: asar pack failed." >&2
    echo "       Refusing to launch against a stale or missing $ASAR_FILE." >&2
    echo "       Is the 'asar' command installed, and is there free disk space?" >&2
    exit 1
  fi
else
  echo "Using cached app.asar (no changes)"
fi

# ============================================================
# Fix Code tab binary: the asar downloads a macOS Mach-O binary to
# claude-code/<version>/claude. Replace with the Linux binary so
# HostCLIRunner (Code tab) works on Linux.
# ============================================================
CLAUDE_CODE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude-code"
if [[ -d "$CLAUDE_CODE_DIR" ]]; then
  LINUX_CLAUDE=""
  for _candidate in "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude" "/usr/local/bin/claude" "/usr/bin/claude"; do
    if [[ -x "$_candidate" ]]; then
      LINUX_CLAUDE="$_candidate"
      break
    fi
  done
  if [[ -n "$LINUX_CLAUDE" ]]; then
    LINUX_CLAUDE_REAL="$(readlink -f "$LINUX_CLAUDE")"
    for _version_dir in "$CLAUDE_CODE_DIR"/*/; do
      _ccd_bin="${_version_dir}claude"
      if [[ -f "$_ccd_bin" && ! -L "$_ccd_bin" ]]; then
        # Check if it's a Mach-O binary (not a Linux ELF)
        if file "$_ccd_bin" 2>/dev/null | grep -q "Mach-O"; then
          # Symlinks are banned -- copy the real Linux binary into place so the
          # resolver only ever sees a real full path (no loose symlinks).
          echo "Fixing Code tab binary: replacing macOS binary with real Linux binary"
          echo "  $_ccd_bin <- $LINUX_CLAUDE_REAL (copy)"
          mv "$_ccd_bin" "${_ccd_bin}.macho-backup"
          cp "$LINUX_CLAUDE_REAL" "$_ccd_bin"
          chmod +x "$_ccd_bin"
        fi
      fi
    done
  fi
fi

# --devtools flag opens DevTools + asset dumper on launch
# --perf flag enables Chromium tracing + Node inspector for profiling
_args=()
_perf=false
_dev=false
for arg in "$@"; do
  if [[ "$arg" == "--devtools" ]]; then
    export CLAUDE_DEVTOOLS=1
    _dev=true
  elif [[ "$arg" == "--perf" ]]; then
    _perf=true
    _dev=true
  elif [[ "$arg" == "--dev" ]]; then
    _dev=true
  else
    _args+=("$arg")
  fi
done
set -- "${_args[@]}"

# Enable logging
export ELECTRON_ENABLE_LOGGING=1
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
LOG_DIR="${CLAUDE_LOG_DIR:-$STATE_HOME/claude-cowork/logs}"
export CLAUDE_LOG_DIR="$LOG_DIR"

if [[ -n "$CLAUDE_DEVTOOLS" ]]; then
  echo ""
  echo "  DEVTOOLS MODE"
  echo "  Assets will be saved to: $LOG_DIR/webapp-assets/"
  echo "  Previous assets backed up to: $LOG_DIR/webapp-assets.bak/"
  echo "  Compare: diff $LOG_DIR/webapp-assets/ $LOG_DIR/webapp-assets.bak/"
  echo ""
fi

# Wayland support for Hyprland, Sway, and other Wayland compositors
if [[ -n "$WAYLAND_DISPLAY" ]] || [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
  export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"
  echo "Wayland detected, using Ozone platform (hint=${ELECTRON_OZONE_PLATFORM_HINT})"
  if [[ "$XDG_CURRENT_DESKTOP" == *"GNOME"* ]]; then
    echo "NOTE: GNOME Wayland does not support the GlobalShortcuts portal — configure shortcuts via GNOME Settings instead"
  fi
fi

# Create log directory (mode 700: logs may contain session metadata)
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"

# Detect password store backend.
# gnome-libsecret is preferred (works with gnome-keyring, KeePassXC, KDE Wallet
# via the freedesktop SecretService D-Bus interface).  Fall back to basic if
# the SecretService bus name isn't claimed -- avoids hard failures on minimal
# desktops or headless setups.
PASSWORD_STORE="gnome-libsecret"
if ! dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
     org.freedesktop.DBus.NameHasOwner string:"org.freedesktop.secrets" 2>/dev/null \
     | grep -q "boolean true"; then
  echo "WARN: org.freedesktop.secrets not available, falling back to --password-store=basic"
  PASSWORD_STORE="basic"
fi

# Register claude:// protocol handler if not already set
if command -v xdg-mime >/dev/null 2>&1; then
  _current_handler="$(xdg-mime query default x-scheme-handler/claude 2>/dev/null || true)"
  if [[ -z "$_current_handler" ]]; then
    _desktop_dirs=("$HOME/.local/share/applications" "/usr/share/applications")
    for _dd in "${_desktop_dirs[@]}"; do
      for _df in "$_dd"/claude*.desktop; do
        if [[ -f "$_df" ]] && grep -q "x-scheme-handler/claude" "$_df" 2>/dev/null; then
          xdg-mime default "$(basename "$_df")" x-scheme-handler/claude 2>/dev/null || true
          break 2
        fi
      done
    done
  fi
fi

# Sandbox check: prefer Chromium sandbox when unprivileged user namespaces
# are available. --no-sandbox is required on distros without userns support
# (disables Chromium renderer process isolation — see security notes).
_sandbox_flag="--no-sandbox"
if [[ -f /proc/sys/kernel/unprivileged_userns_clone ]]; then
  if [[ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" == "1" ]]; then
    _sandbox_flag=""
    echo "User namespaces available — Chromium sandbox enabled"
  fi
elif [[ -f /proc/sys/user/max_user_namespaces ]]; then
  _max_ns="$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)"
  if [[ "$_max_ns" -gt 0 ]] 2>/dev/null; then
    _sandbox_flag=""
    echo "User namespaces available — Chromium sandbox enabled"
  fi
fi

# Build electron args
_electron_args=(
  "./${ASAR_FILE}"
  ${_sandbox_flag}
  --password-store="$PASSWORD_STORE"
  --enable-features=GlobalShortcutsPortal
  --class=Claude
)

if [[ "$_perf" == true ]]; then
  export CLAUDE_DEVTOOLS=1
  export CLAUDE_COWORK_IPC_TAP=1
  export CLAUDE_COWORK_TRACE_IO=1
  export CLAUDE_COWORK_VERBOSE=1
  # SECURITY: Bind to localhost only — never expose to network
  _electron_args+=(
    --inspect=127.0.0.1:9229
    --remote-debugging-port=9222
  )
  echo ""
  echo "  PERF MODE"
  echo "  Main process:  chrome://inspect (port 9229) -> Profiler tab"
  echo "  Renderer:      DevTools will open -> Performance tab -> Record"
  echo "  IPC tap:       $LOG_DIR/ipc-tap.log"
  echo "  Trace IO:      Enabled (stdin/stdout logging)"
  echo ""
fi

# Run electron with the repacked app.asar
if [[ "$_dev" == true ]]; then
  # Foreground: terminal stays attached (--dev, --devtools, --perf)
  echo "Launching Claude Desktop (foreground, electron: $ELECTRON_BIN)..."
  "$ELECTRON_BIN" \
    "${_electron_args[@]}" \
    "$@" \
    2>&1 | tee -a "$LOG_DIR/startup.log"
  exit "${PIPESTATUS[0]}"
else
  # Default: launch headless, detach from terminal
  echo "Launching Claude Desktop..."
  nohup "$ELECTRON_BIN" \
    "${_electron_args[@]}" \
    "$@" \
    >> "$LOG_DIR/startup.log" 2>&1 &
  disown
  echo "PID $! — logs: $LOG_DIR/startup.log"
fi
