#!/bin/bash
#
# Claude Desktop for Linux - Installer
#
# Usage: ./install.sh [--force] [path/to/Claude.dmg|zip]
#        curl -fsSL https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master/install.sh | bash
#
# This script:
#   1. Checks/installs dependencies (git, 7z, node, electron, asar)
#   2. Clones the claude-cowork-linux repo
#   3. Extracts Claude Desktop from a macOS archive (DMG or ZIP)
#   4. Creates ~/.local/bin/claude-desktop launcher
#   5. Creates desktop entry
#
# Everything installs to user-local paths. Sudo is only used if system
# packages (7z, node, etc.) need to be installed via your package manager.
#
# License: MIT
# Source: https://github.com/johnzfitch/claude-cowork-linux

set -euo pipefail

# ============================================================
# Configuration
# ============================================================

VERSION="4.0.0"
REPO_URL="https://github.com/johnzfitch/claude-cowork-linux.git"
INSTALL_DIR="$HOME/.local/share/claude-desktop"
INSTALL_FORCE=0

# Minimum expected archive size (100MB) — applies to both DMG and ZIP
MIN_ARCHIVE_SIZE=100000000

# Temp directory (cleaned up on exit)
WORK_DIR=$(mktemp -d)
cleanup() { rm -rf "$WORK_DIR" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ============================================================
# Utility Functions
# ============================================================

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die() { log_error "$@"; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

confirm_destructive_removal() {
    local target="$1"
    local reason="$2"

    [[ -e "$target" ]] || return 0
    log_info "$reason Replacing..."
}

format_size() {
    local size=$1
    local units=("B" "KB" "MB" "GB")
    local unit=0
    local num=$size
    while (( num > 1024 && unit < 3 )); do
        num=$((num / 1024))
        unit=$((unit + 1))
    done
    echo "${num}${units[$unit]}"
}

detect_pkg_manager() {
    if command_exists apt-get; then echo "apt"
    elif command_exists pacman; then echo "pacman"
    elif command_exists dnf; then echo "dnf"
    elif command_exists zypper; then echo "zypper"
    elif command_exists nix-env; then echo "nix"
    else echo "unknown"; fi
}

# ============================================================
# Step 1: Dependencies
# ============================================================

install_dependencies() {
    log_info "Checking dependencies..."

    local pkg_manager
    pkg_manager=$(detect_pkg_manager)
    local missing=()

    for cmd in git 7z node npm bwrap; do
        if ! command_exists "$cmd"; then
            missing+=("$cmd")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_info "Missing packages: ${missing[*]}"
        case "$pkg_manager" in
            apt) sudo apt-get update -qq && sudo apt-get install -y git p7zip-full nodejs npm bubblewrap ;;
            pacman) sudo pacman -S --noconfirm --needed git p7zip nodejs npm bubblewrap ;;
            dnf) sudo dnf install -y git p7zip nodejs npm bubblewrap ;;
            zypper) sudo zypper install -y git 7zip nodejs-default npm bubblewrap ;;
            nix) nix-env -iA nixpkgs.git nixpkgs.p7zip nixpkgs.nodejs nixpkgs.bubblewrap ;;
            *) die "Unknown package manager. Install manually: git p7zip nodejs npm bubblewrap" ;;
        esac
    fi

    # Install npm packages to user prefix
    local npm_prefix="$HOME/.local"
    mkdir -p "$npm_prefix"
    npm config set prefix "$npm_prefix" 2>/dev/null || true
    export PATH="$npm_prefix/bin:$PATH"

    if ! command_exists asar; then
        log_info "Installing @electron/asar..."
        npm install --silent -g @electron/asar || die "Failed to install asar"
    fi

    if ! command_exists electron; then
        log_info "Installing electron..."
        npm install --silent -g electron || die "Failed to install electron"
    fi

    # Verify
    for cmd in git 7z node npm asar electron bwrap; do
        if command_exists "$cmd"; then
            log_success "Found: $cmd"
        else
            die "Missing: $cmd"
        fi
    done

    local node_version
    node_version=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ "$node_version" -lt 18 ]]; then
        die "Node.js 18+ required, found v$node_version"
    fi
    log_success "Node.js version OK (v$node_version)"
}

# ============================================================
# Step 2: Clone or update the repo
# ============================================================

setup_repo() {
    if git -C "$INSTALL_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        log_info "Updating existing installation..."
        git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null \
            || log_info "Local repo has modifications, stubs will be synced from source"
        log_success "Repository updated"
    else
        if [[ -d "$INSTALL_DIR" ]]; then
            log_info "Existing non-git install dir found, will overlay"
        fi
        log_info "Cloning claude-cowork-linux to $INSTALL_DIR..."
        mkdir -p "$(dirname "$INSTALL_DIR")"
        git clone "$REPO_URL" "$INSTALL_DIR" || die "Failed to clone repository"
        log_success "Repository cloned"
    fi
}

# ============================================================
# Step 3: Get the Claude Desktop archive (ZIP or DMG)
# ============================================================

CLAUDE_DOWNLOAD_REDIRECT="https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect"

find_claude_archive() {
    # Search a directory for Claude archive files (ZIP or DMG)
    local dir="$1"
    [[ -d "$dir" ]] || return 1
    find "$dir" -maxdepth 1 \( -name "Claude*.zip" -o -name "claude*.zip" \
        -o -name "Claude*.dmg" -o -name "claude*.dmg" \) -type f -print -quit 2>/dev/null
}

show_archive_info() {
    # Display version, SHA, size, and filesystem date for a found archive
    local file="$1"
    local size created
    size=$(stat -c%s "$file" 2>/dev/null || echo 0)
    created=$(stat -c%y "$file" 2>/dev/null | cut -d. -f1)
    echo ""
    log_info "  File:    $(basename "$file")"
    log_info "  Size:    $(format_size "$size")"
    [[ -n "$created" ]] && log_info "  Date:    $created"

    # Try to get version/sha from fetch-dmg.js for comparison
    local fetch_script=""
    if [[ -f "$(dirname "$0")/fetch-dmg.js" ]]; then
        fetch_script="$(dirname "$0")/fetch-dmg.js"
    elif [[ -f "$INSTALL_DIR/fetch-dmg.js" ]]; then
        fetch_script="$INSTALL_DIR/fetch-dmg.js"
    fi
    if [[ -n "$fetch_script" ]] && command_exists node; then
        local json
        json=$(node "$fetch_script" --json 2>/dev/null) || return 0
        local version sha256
        version=$(printf '%s' "$json" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.version||'')})" 2>/dev/null)
        sha256=$(printf '%s' "$json" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.sha256||'')})" 2>/dev/null)
        [[ -n "$version" ]] && log_info "  Latest:  v$version"
        [[ -n "$sha256" ]]  && log_info "  SHA256:  ${sha256:0:16}..."
    fi
    echo ""
}

fetch_archive_via_node() {
    # Auto-download Claude archive (ZIP or DMG) using the Homebrew cask API.
    local archive_path="$1"
    local fetch_script

    # Prefer script dir (invoked source) over install dir (may be stale)
    if [[ -f "$(dirname "$0")/fetch-dmg.js" ]]; then
        fetch_script="$(dirname "$0")/fetch-dmg.js"
    elif [[ -f "$INSTALL_DIR/fetch-dmg.js" ]]; then
        fetch_script="$INSTALL_DIR/fetch-dmg.js"
    else
        log_warn "fetch-dmg.js not found, skipping auto-download"
        return 1
    fi

    log_info "Fetching latest download URL..."
    local archive_url
    local fetch_err
    archive_url=$(node "$fetch_script" --url 2>&1) || {
        fetch_err="$archive_url"
        log_warn "Failed to fetch download URL: ${fetch_err}"
        return 1
    }

    log_info "Downloading Claude archive from CDN..."
    if curl -fSL --progress-bar -o "$archive_path" "$archive_url"; then
        local size
        size=$(stat -c%s "$archive_path" 2>/dev/null || echo 0)
        if [[ "$size" -ge "$MIN_ARCHIVE_SIZE" ]]; then
            log_success "Downloaded archive: $(format_size "$size")"
            return 0
        fi
        log_warn "Downloaded file too small ($(format_size "$size")), may be corrupt"
        rm -f "$archive_path"
    fi

    log_warn "CDN download failed"
    return 1
}

scan_for_archive() {
    # Scan all common locations for a Claude archive
    local script_dir="$1"
    local dl_dirs=()
    local xdg_dl
    xdg_dl=$(xdg-user-dir DOWNLOAD 2>/dev/null)
    [[ -n "$xdg_dl" && -d "$xdg_dl" ]] && dl_dirs+=("$xdg_dl")
    [[ -d "$HOME/Downloads" ]]          && dl_dirs+=("$HOME/Downloads")
    [[ -d "$HOME/downloads" ]]          && dl_dirs+=("$HOME/downloads")
    dl_dirs+=("$script_dir" "$INSTALL_DIR")

    for search_dir in "${dl_dirs[@]}"; do
        local hit
        hit=$(find_claude_archive "$search_dir")
        if [[ -n "$hit" ]]; then
            printf '%s' "$hit"
            return 0
        fi
    done
    return 1
}

get_archive() {
    local archive_path="$1"
    local script_dir
    script_dir=$(cd "$(dirname "$0")" && pwd)

    # 1. User-provided archive path (CLAUDE_DMG kept for backward compat)
    local user_archive="${CLAUDE_ARCHIVE:-${CLAUDE_DMG:-}}"
    if [[ -n "$user_archive" ]]; then
        local resolved_path
        resolved_path=$(realpath -e "$user_archive" 2>/dev/null) || die "Archive not found: $user_archive"
        [[ -f "$resolved_path" ]] || die "Archive must be a regular file: $user_archive"
        log_info "Using user-provided archive: $resolved_path"
        show_archive_info "$resolved_path"
        cp "$resolved_path" "$archive_path"
        return 0
    fi

    # 2. Auto-download via Node.js (Homebrew cask API)
    if command_exists node; then
        if fetch_archive_via_node "$archive_path"; then
            return 0
        fi
        log_warn "Auto-download failed"
    fi

    # 3. Scan common locations, then prompt user to download if needed
    local found=""
    found=$(scan_for_archive "$script_dir") || true

    if [[ -z "$found" ]]; then
        echo ""
        log_info "Download the Claude macOS installer (we extract the app from it):"
        echo ""
        echo "    $CLAUDE_DOWNLOAD_REDIRECT"
        echo ""
        echo "  Save it here: $script_dir/"
        echo ""
        echo -n "  Press ENTER when the download is complete..."
        read -r
        found=$(scan_for_archive "$script_dir") || true
    fi

    if [[ -n "$found" ]]; then
        log_success "Found: $found"
        show_archive_info "$found"
        cp "$found" "$archive_path"
        return 0
    fi

    die "No Claude archive found. Re-run with: CLAUDE_ARCHIVE=/path/to/Claude.zip $0"
}

# ============================================================
# Step 4: Extract archive into linux-app-extracted/
# ============================================================

extract_archive() {
    local archive_path="$1"
    local target_dir="$INSTALL_DIR/linux-app-extracted"

    # Extract archive (7z handles both DMG and ZIP)
    log_info "Extracting archive..." >&2
    local extract_dir="$WORK_DIR/extract"
    local seven_z_exit=0
    7z x -y -o"$extract_dir" "$archive_path" >/dev/null 2>&1 || seven_z_exit=$?
    # 7z exit 1 = warning, exit 2 = "Dangerous link path" (e.g. /Applications symlink
    # in DMG). Both are non-fatal on Linux — the symlink is macOS-specific.
    # See: https://github.com/johnzfitch/claude-cowork-linux/issues/35
    if [[ $seven_z_exit -gt 2 ]]; then
        die "Failed to extract archive (7z exit code: $seven_z_exit)"
    fi
    if [[ $seven_z_exit -eq 1 || $seven_z_exit -eq 2 ]]; then
        log_warn "7z exited with code $seven_z_exit (non-fatal; e.g. skipped macOS symlinks)"
    fi

    # Find Claude.app and app.asar
    local claude_app
    claude_app=$(find "$extract_dir" -name "Claude.app" -type d | head -1)
    [[ -n "$claude_app" ]] || die "Claude.app not found in archive"

    local asar_file="$claude_app/Contents/Resources/app.asar"
    [[ -f "$asar_file" ]] || die "app.asar not found at: $asar_file"

    # Extract on top of existing tree (overwrites stale files, preserves extras)
    log_info "Extracting app.asar..."
    asar extract "$asar_file" "$target_dir" || die "Failed to extract app.asar"

    # Copy unpacked native modules if present
    local unpacked="$claude_app/Contents/Resources/app.asar.unpacked"
    if [[ -d "$unpacked" ]]; then
        cp -r "$unpacked"/* "$target_dir/" 2>/dev/null || true
    fi

    # Copy resources/ from DMG (i18n, icons, etc.) excluding the asar itself
    local resources_dir="$claude_app/Contents/Resources"
    mkdir -p "$target_dir/resources"
    for item in "$resources_dir"/*; do
        local name
        name=$(basename "$item")
        case "$name" in
            app.asar|app.asar.unpacked) continue ;;
        esac
        cp -r "$item" "$target_dir/resources/$name" 2>/dev/null || true
    done

    # The app expects i18n JSON files at resources/i18n/*.json (not resources/*.json)
    mkdir -p "$target_dir/resources/i18n"
    if ls "$target_dir/resources"/*.json >/dev/null 2>&1; then
        mv "$target_dir/resources"/*.json "$target_dir/resources/i18n/"
    fi

    # Validate that i18n files were extracted — missing files cause ENOENT at startup.
    # See: https://github.com/johnzfitch/claude-cowork-linux/issues/33
    if ! ls "$target_dir/resources/i18n"/*.json >/dev/null 2>&1; then
        log_warn "No i18n JSON files found in resources/i18n/ — the app may fail to start"
        log_warn "Try re-running the installer with a fresh download"
    fi

    log_success "Extracted app to linux-app-extracted/"
}

# ============================================================
# Step 5: Bake stubs into node_modules
# ============================================================

install_stubs() {
    local target_dir="$INSTALL_DIR/linux-app-extracted"
    local script_dir
    script_dir=$(cd "$(dirname "$0")" && pwd)

    # Prefer stubs from the script directory (where install.sh was invoked)
    # over the install directory (may be stale if git pull failed).
    local stub_src="$script_dir"
    if [[ ! -d "$stub_src/stubs" ]]; then
        stub_src="$INSTALL_DIR"
    fi

    log_info "Installing stubs from $stub_src..."

    local swift_src="$stub_src/stubs/@ant/claude-swift/js/index.js"
    local native_src="$stub_src/stubs/@ant/claude-native/index.js"

    [[ -f "$swift_src" ]] || die "Swift stub not found: $swift_src"
    [[ -f "$native_src" ]] || die "Native stub not found: $native_src"

    mkdir -p "$target_dir/node_modules/@ant/claude-swift/js"
    mkdir -p "$target_dir/node_modules/@ant/claude-native"

    cp "$swift_src" "$target_dir/node_modules/@ant/claude-swift/js/index.js"
    cp "$native_src" "$target_dir/node_modules/@ant/claude-native/index.js"

    # Copy frame-fix files
    for f in frame-fix-wrapper.js frame-fix-entry.js; do
        if [[ -f "$stub_src/stubs/frame-fix/$f" ]]; then
            cp "$stub_src/stubs/frame-fix/$f" "$target_dir/$f"
        fi
    done

    # Copy cowork orchestration modules
    if [[ -d "$stub_src/stubs/cowork" ]]; then
        mkdir -p "$target_dir/cowork"
        cp -f "$stub_src"/stubs/cowork/*.js "$target_dir/cowork/"
    fi

    # Also sync stubs into the install dir's stubs/ so future launches
    # from the install dir (via claude-desktop launcher) use current code
    if [[ "$stub_src" != "$INSTALL_DIR" && -d "$INSTALL_DIR" ]]; then
        log_info "Syncing stubs to install dir..."
        cp -rf "$stub_src/stubs" "$INSTALL_DIR/"
    fi

    log_success "Stubs installed"
}

# ============================================================
# Step 6: Apply patches
# ============================================================

apply_patches() {
    local index_js="$INSTALL_DIR/linux-app-extracted/.vite/build/index.js"
    local script_dir
    script_dir=$(cd "$(dirname "$0")" && pwd)
    local patch_script=""

    # Prefer script dir (invoked source) over install dir (may be stale)
    if [[ -f "$script_dir/enable-cowork.py" ]]; then
        patch_script="$script_dir/enable-cowork.py"
    elif [[ -f "$INSTALL_DIR/enable-cowork.py" ]]; then
        patch_script="$INSTALL_DIR/enable-cowork.py"
    fi

    if [[ -n "$patch_script" && -f "$index_js" ]]; then
        log_info "Applying cowork patch..."
        python3 "$patch_script" "$index_js" || log_warn "Patch may have already been applied"
        log_success "Patches applied"
    else
        log_warn "Patch script or index.js not found, skipping patches"
    fi
}

# ============================================================
# Step 7: Create launcher
# ============================================================

create_launcher() {
    mkdir -p "$HOME/.local/bin"

    cat > "$HOME/.local/bin/claude-desktop" << EOF
#!/bin/bash
# Claude Desktop for Linux — launcher
# Generated by install.sh v$VERSION

COWORK_DIR="${INSTALL_DIR}"
STATE_HOME="\${XDG_STATE_HOME:-\$HOME/.local/state}"
LOG_DIR="\${CLAUDE_LOG_DIR:-\$STATE_HOME/claude-cowork/logs}"
export CLAUDE_LOG_DIR="\$LOG_DIR"
mkdir -p "\$LOG_DIR"

cd "\$COWORK_DIR"

case "\${1:-}" in
    --devtools) shift; export CLAUDE_DEVTOOLS=1; exec ./launch.sh "\$@" ;;
    --debug)    shift; export CLAUDE_TRACE=1; exec ./launch.sh "\$@" ;;
    --doctor)   exec ./install.sh --doctor ;;
    *)
        nohup bash -c 'cd "\$1" && shift && exec ./launch.sh "\$@"' \
            -- "\$COWORK_DIR" "\$@" >> "\$LOG_DIR/startup.log" 2>&1 &
        disown
        ;;
esac
EOF

    chmod +x "$HOME/.local/bin/claude-desktop"
    # Alias for familiarity
    ln -sf "$HOME/.local/bin/claude-desktop" "$HOME/.local/bin/claude-cowork"

    log_success "Created launchers: ~/.local/bin/claude-desktop, ~/.local/bin/claude-cowork"
}

# ============================================================
# Step 8: Desktop entry + user dirs
# ============================================================

setup_environment() {
    # XDG-compliant paths — Electron on Linux uses ~/.config/Claude/ as userData
    local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
    local state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
    local cache_home="${XDG_CACHE_HOME:-$HOME/.cache}"

    local data_dir="$config_home/Claude"
    local log_dir="$state_home/claude-cowork/logs"
    local cache_dir="$cache_home/claude-cowork"
    local sessions_dir="$data_dir/local-agent-mode-sessions/sessions"

    mkdir -p "$data_dir"
    mkdir -p "$log_dir"
    mkdir -p "$cache_dir"
    mkdir -p "$sessions_dir"
    chmod 700 "$data_dir"

    # /sessions symlink — the asar passes VM-internal /sessions/... paths that
    # our stub translates to host paths under this sessions directory.
    if [[ ! -e /sessions ]]; then
        log_info "Creating /sessions symlink (requires sudo)..."
        sudo ln -s "$sessions_dir" /sessions \
            && log_success "/sessions -> $sessions_dir" \
            || log_warn "Failed to create /sessions symlink. Run manually: sudo ln -s \"$sessions_dir\" /sessions"
    elif [[ -L /sessions ]]; then
        local current_target
        current_target=$(readlink /sessions)
        if [[ "$current_target" != "$sessions_dir" ]]; then
            log_warn "/sessions points to $current_target (expected $sessions_dir)"
            log_info "Updating /sessions symlink..."
            sudo ln -sfn "$sessions_dir" /sessions \
                && log_success "/sessions -> $sessions_dir" \
                || log_warn "Failed to update /sessions symlink"
        fi
    fi

    # Default configs if missing
    if [[ ! -f "$data_dir/config.json" ]]; then
        cat > "$data_dir/config.json" << 'CONF'
{
  "scale": 0,
  "locale": "en-US",
  "userThemeMode": "system",
  "hasTrackedInitialActivation": false
}
CONF
    fi

    if [[ ! -f "$data_dir/claude_desktop_config.json" ]]; then
        cat > "$data_dir/claude_desktop_config.json" << 'CONF'
{
  "preferences": {
    "chromeExtensionEnabled": true
  }
}
CONF
    fi

    # Desktop entry
    mkdir -p "$HOME/.local/share/applications"
    cat > "$HOME/.local/share/applications/claude.desktop" << EOF
[Desktop Entry]
Type=Application
Name=Claude
Comment=AI assistant by Anthropic
Exec=$HOME/.local/bin/claude-desktop %U
Icon=claude
Terminal=false
Categories=Utility;Development;Chat;
Keywords=AI;assistant;chat;anthropic;
StartupWMClass=Claude
MimeType=x-scheme-handler/claude;
EOF
    chmod +x "$HOME/.local/share/applications/claude.desktop"

    if command_exists update-desktop-database; then
        update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    fi

    log_success "Environment configured"
}

# ============================================================
# Step 9: Icon extraction (hicolor PNG from embedded .icns blobs)
# ============================================================

setup_icon() {
    local icns="$INSTALL_DIR/linux-app-extracted/resources/electron.icns"
    if [[ ! -f "$icns" ]]; then
        log_warn "electron.icns not found — skipping icon installation"
        return 0
    fi

    python3 - "$icns" << 'PYEOF' && log_success "App icon installed to hicolor theme" || log_warn "Icon extraction failed (non-fatal)"
import struct, os, sys
icns_path = sys.argv[1]
with open(icns_path, 'rb') as f:
    data = f.read()
size_map = {b'ic07': 128, b'ic08': 256, b'ic09': 512, b'ic10': 1024}
installed = []
offset = 8
while offset < len(data) - 8:
    chunk_type = data[offset:offset+4]
    chunk_size = struct.unpack('>I', data[offset+4:offset+8])[0]
    if chunk_size < 8:
        break
    chunk_data = data[offset+8:offset+chunk_size]
    px = size_map.get(chunk_type)
    if px and chunk_data[:8] == b'\x89PNG\r\n\x1a\n':
        d = os.path.expanduser(f'~/.local/share/icons/hicolor/{px}x{px}/apps')
        os.makedirs(d, exist_ok=True)
        with open(f'{d}/claude.png', 'wb') as out:
            out.write(chunk_data)
        installed.append(px)
    offset += chunk_size
if not installed:
    raise SystemExit('No PNG chunks found in .icns')
print(f"Installed sizes: {sorted(installed)}")
PYEOF

    if command_exists gtk-update-icon-cache; then
        gtk-update-icon-cache --force "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
    fi
}

# ============================================================
# Doctor: preflight validation
# ============================================================

doctor() {
    echo ""
    echo "=========================================="
    echo " Claude Desktop for Linux - Doctor"
    echo " Version: $VERSION"
    echo "=========================================="
    echo ""

    local ok=0 warn=0 fail=0

    check_launcher_resolution() {
        local cmd="$1"
        local expected="$2"
        local matches=""

        matches=$(which -a "$cmd" 2>/dev/null | awk '!seen[$0]++') || matches=""
        if [[ -z "$matches" ]]; then
            log_warn "$cmd launcher: not found in PATH"
            warn=$((warn + 1))
            return
        fi

        local first expected_real first_real
        first=$(printf '%s\n' "$matches" | head -1)
        expected_real=$(readlink -f "$expected" 2>/dev/null || printf '%s' "$expected")
        first_real=$(readlink -f "$first" 2>/dev/null || printf '%s' "$first")
        if [[ "$first" == "$expected" || "$first_real" == "$expected_real" ]]; then
            log_success "$cmd launcher: $first"
            ok=$((ok + 1))
        else
            log_warn "$cmd launcher resolves to $first (expected $expected)"
            warn=$((warn + 1))
        fi

        local extra
        extra=$(printf '%s\n' "$matches" | sed -n '2,10p')
        if [[ -n "$extra" ]]; then
            local divergent=""
            while IFS= read -r entry; do
                [[ -n "$entry" ]] || continue
                local entry_real
                entry_real=$(readlink -f "$entry" 2>/dev/null || printf '%s' "$entry")
                if [[ "$entry_real" != "$expected_real" ]]; then
                    divergent=1
                    break
                fi
            done <<< "$extra"

            if [[ -n "$divergent" ]]; then
                log_warn "$cmd has additional PATH entries: $(printf '%s' "$extra" | paste -sd ', ' -)"
                warn=$((warn + 1))
            fi
        fi
    }

    # --- Required binaries ---
    for cmd in git 7z node npm electron asar bwrap; do
        if command_exists "$cmd"; then
            log_success "$cmd: $(command -v "$cmd")"
            ok=$((ok + 1))
        else
            log_error "$cmd: NOT FOUND"
            fail=$((fail + 1))
        fi
    done

    # --- Node.js version ---
    if command_exists node; then
        local node_ver
        node_ver=$(node --version | sed 's/v//' | cut -d. -f1)
        if [[ "$node_ver" -ge 18 ]]; then
            log_success "Node.js version: v$node_ver (>= 18)"
            ok=$((ok + 1))
        else
            log_error "Node.js version: v$node_ver (need >= 18)"
            fail=$((fail + 1))
        fi
    fi

    # --- Claude Code CLI ---
    local claude_found=""
    for p in \
        "$HOME/.local/bin/claude" \
        "$HOME/.npm-global/bin/claude" \
        "/usr/local/bin/claude" \
        "/usr/bin/claude"; do
        if [[ -x "$p" ]]; then
            claude_found="$p"
            break
        fi
    done
    # Also check claude-code-vm under XDG config
    local vm_root="${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude-code-vm"
    if [[ -z "$claude_found" && -d "$vm_root" ]]; then
        claude_found=$(find "$vm_root" -name claude -type f -executable 2>/dev/null | head -1)
    fi
    if [[ -n "$claude_found" ]]; then
        log_success "Claude binary: $claude_found"
        ok=$((ok + 1))
    else
        log_warn "Claude binary: not found (Cowork will download it on first run)"
        warn=$((warn + 1))
    fi

    # --- /sessions symlink ---
    if [[ -L /sessions ]]; then
        local target
        target=$(readlink /sessions)
        log_success "/sessions symlink -> $target"
        ok=$((ok + 1))
    elif [[ -d /sessions ]]; then
        log_warn "/sessions exists but is a directory (should be a symlink)"
        warn=$((warn + 1))
    else
        log_error "/sessions: NOT FOUND -- run: sudo ln -s \"\${XDG_CONFIG_HOME:-\$HOME/.config}/Claude/local-agent-mode-sessions/sessions\" /sessions"
        fail=$((fail + 1))
    fi

    # --- Secret service (D-Bus) ---
    if dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
         org.freedesktop.DBus.NameHasOwner string:"org.freedesktop.secrets" 2>/dev/null \
         | grep -q "boolean true"; then
        log_success "Secret service (org.freedesktop.secrets): available"
        ok=$((ok + 1))
    else
        log_warn "Secret service: not available (will fall back to basic password store)"
        warn=$((warn + 1))
    fi

    # --- Extracted app ---
    local app_dir="${INSTALL_DIR}/linux-app-extracted"
    if [[ -d "$app_dir/.vite/build" ]]; then
        log_success "Extracted app: $app_dir"
        ok=$((ok + 1))
        # Check cowork patch
        if grep -q 'cowork-patched' "$app_dir/.vite/build/index.js" 2>/dev/null; then
            log_success "Cowork patch: applied"
            ok=$((ok + 1))
        else
            log_warn "Cowork patch: not applied (run install.sh to apply)"
            warn=$((warn + 1))
        fi
        # Check stubs
        if [[ -f "$app_dir/node_modules/@ant/claude-swift/js/index.js" ]]; then
            log_success "Swift stub: installed"
            ok=$((ok + 1))
        else
            log_error "Swift stub: MISSING"
            fail=$((fail + 1))
        fi
    else
        log_warn "Extracted app: not found at $app_dir (run install.sh)"
        warn=$((warn + 1))
    fi

    # --- Python (optional, for enable-cowork.py) ---
    if command_exists python3; then
        local py_ver
        py_ver=$(python3 --version 2>&1 | awk '{print $2}')
        log_success "Python: $py_ver (optional)"
        ok=$((ok + 1))
    else
        log_warn "Python 3: not found (needed for enable-cowork.py patch)"
        warn=$((warn + 1))
    fi

    # --- Launcher resolution ---
    check_launcher_resolution "claude-desktop" "$HOME/.local/bin/claude-desktop"
    check_launcher_resolution "claude-cowork" "$HOME/.local/bin/claude-cowork"

    echo ""
    echo "=========================================="
    echo -e " ${GREEN}$ok passed${NC}  ${YELLOW}$warn warnings${NC}  ${RED}$fail failed${NC}"
    echo "=========================================="
    echo ""
    if [[ $fail -gt 0 ]]; then
        echo "Fix the failures above, then re-run: ./install.sh --doctor"
        return 1
    elif [[ $warn -gt 0 ]]; then
        echo "Warnings are non-fatal but may affect some features."
        return 0
    else
        echo "Everything looks good."
        return 0
    fi
}

# ============================================================
# Main
# ============================================================

main() {
    local archive_arg=""
    for arg in "$@"; do
        case "$arg" in
            --doctor)
                doctor
                exit $?
                ;;
            --force|--yes)
                INSTALL_FORCE=1
                ;;
            *)
                if [[ -n "$archive_arg" ]]; then
                    die "Unexpected argument: $arg"
                fi
                archive_arg="$arg"
                ;;
        esac
    done

    # Positional arg → CLAUDE_ARCHIVE (CLAUDE_DMG kept for backward compat)
    if [[ -n "$archive_arg" && -z "${CLAUDE_ARCHIVE:-}" && -z "${CLAUDE_DMG:-}" ]]; then
        export CLAUDE_ARCHIVE="$archive_arg"
    fi

    echo ""
    echo "=========================================="
    echo " Claude Desktop for Linux - Installer"
    echo " Version: $VERSION"
    echo "=========================================="
    echo ""

    if [[ $EUID -eq 0 ]]; then
        die "Do not run as root."
    fi

    # Step 1: Dependencies
    install_dependencies
    echo ""

    # Step 2: Clone/update repo
    setup_repo
    echo ""

    # Step 3: Get Claude archive (ZIP or DMG)
    local archive_path="$WORK_DIR/Claude.archive"
    get_archive "$archive_path"
    echo ""

    # Step 4: Extract archive → linux-app-extracted/
    extract_archive "$archive_path"
    echo ""

    # Step 5: Bake stubs into node_modules
    install_stubs
    echo ""

    # Step 6: Apply patches
    apply_patches
    echo ""

    # Step 7: Create launcher
    create_launcher
    echo ""

    # Step 8: Desktop entry + user dirs
    setup_environment
    echo ""

    # Step 9: Icon extraction
    setup_icon
    echo ""

    # Step 10: Preflight validation
    log_info "Running post-install checks..."
    doctor || true
    echo ""

    # Done
    echo "=========================================="
    echo -e "${GREEN} Installation Complete!${NC}"
    echo "=========================================="
    echo ""
    echo "Launch Claude:"
    echo "  claude-desktop       (or claude-cowork)"
    echo ""
    echo "Options:"
    echo "  claude-desktop --debug      Enable trace logging"
    echo "  claude-desktop --devtools   Open with DevTools"
    echo "  claude-desktop --doctor     Run preflight diagnostics"
    echo "  bash install.sh --force     Skip confirmation before replacing old installs"
    echo ""
    echo "Update:"
    echo "  cd $INSTALL_DIR && git pull && bash install.sh"
    echo ""
    echo "Installed: $INSTALL_DIR"
    echo "Logs:      \${XDG_STATE_HOME:-~/.local/state}/claude-cowork/logs/startup.log"
    echo ""
    echo "Make sure ~/.local/bin is on your PATH."
    echo ""
}

main "$@"
