#!/bin/bash
#
# Claude Desktop for Linux - Installer
#
# Usage: ./install.sh [path/to/Claude.dmg]
#        curl -fsSL https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master/install.sh | bash
#
# This script:
#   1. Checks/installs dependencies (git, 7z, node, electron, asar)
#   2. Clones the claude-cowork-linux repo
#   3. Extracts Claude Desktop from a macOS DMG
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

VERSION="3.0.6"
REPO_URL="https://github.com/johnzfitch/claude-cowork-linux.git"
INSTALL_DIR="$HOME/.local/share/claude-desktop"
CLAUDE_DOWNLOAD_PAGE="https://claude.ai/download"
RNET_WHEEL_URL="https://github.com/johnzfitch/claude-cowork-linux/releases/download/v3.0.2/rnet-3.0.0rc14-cp311-abi3-manylinux_2_34_x86_64.whl"

# Minimum expected DMG size (100MB)
MIN_DMG_SIZE=100000000

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
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        log_info "Updating existing installation..."
        git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || log_info "Local modifications present, using existing version"
        log_success "Repository updated"
    else
        # Remove stale non-git install dir if present
        if [[ -d "$INSTALL_DIR" ]]; then
            log_warn "Removing previous (non-git) installation at $INSTALL_DIR"
            rm -rf "$INSTALL_DIR"
        fi
        log_info "Cloning claude-cowork-linux to $INSTALL_DIR..."
        mkdir -p "$(dirname "$INSTALL_DIR")"
        git clone "$REPO_URL" "$INSTALL_DIR" || die "Failed to clone repository"
        log_success "Repository cloned"
    fi
}

# ============================================================
# Step 3: Get the Claude Desktop DMG
# ============================================================

fetch_dmg_via_rnet() {
    # Auto-download DMG using rnet to bypass Cloudflare on the API endpoint.
    # The CDN URL (downloads.claude.ai) works fine with plain curl.
    local dmg_path="$1"
    local venv_dir="$WORK_DIR/rnet-venv"
    local fetch_script

    # Locate fetch-dmg.py (repo clone or running from source)
    if [[ -f "$INSTALL_DIR/fetch-dmg.py" ]]; then
        fetch_script="$INSTALL_DIR/fetch-dmg.py"
    elif [[ -f "$(dirname "$0")/fetch-dmg.py" ]]; then
        fetch_script="$(dirname "$0")/fetch-dmg.py"
    else
        log_warn "fetch-dmg.py not found, skipping auto-download"
        return 1
    fi

    log_info "Setting up rnet for auto-download..."
    python3 -m venv "$venv_dir" 2>/dev/null || { log_warn "Failed to create venv"; return 1; }

    # Install rnet wheel from GitHub release
    if ! "$venv_dir/bin/pip" install --quiet "$RNET_WHEEL_URL" 2>/dev/null; then
        log_warn "Failed to install rnet wheel"
        rm -rf "$venv_dir"
        return 1
    fi

    log_info "Fetching latest DMG URL..."
    local dmg_url
    dmg_url=$("$venv_dir/bin/python3" "$fetch_script" --url 2>/dev/null) || {
        log_warn "Failed to fetch DMG URL"
        rm -rf "$venv_dir"
        return 1
    }

    rm -rf "$venv_dir"

    log_info "Downloading DMG from CDN..."
    if curl -fSL --progress-bar -o "$dmg_path" "$dmg_url"; then
        local size
        size=$(stat -c%s "$dmg_path" 2>/dev/null || echo 0)
        if [[ "$size" -ge "$MIN_DMG_SIZE" ]]; then
            log_success "Downloaded DMG: $(format_size "$size")"
            return 0
        fi
        log_warn "Downloaded file too small ($(format_size "$size")), may be corrupt"
        rm -f "$dmg_path"
    fi

    log_warn "CDN download failed"
    return 1
}

get_dmg() {
    local dmg_path="$1"

    # 1. User-provided DMG path
    if [[ -n "${CLAUDE_DMG:-}" ]]; then
        local resolved_path
        resolved_path=$(realpath -e "$CLAUDE_DMG" 2>/dev/null) || die "DMG not found: $CLAUDE_DMG"
        [[ -f "$resolved_path" ]] || die "CLAUDE_DMG must be a regular file: $CLAUDE_DMG"
        log_info "Using user-provided DMG: $resolved_path"
        cp "$resolved_path" "$dmg_path"
        return 0
    fi

    # 2. Check install dir for existing DMG
    local existing_dmg=""
    existing_dmg=$(find "$INSTALL_DIR" -maxdepth 1 \( -name "Claude*.dmg" -o -name "claude*.dmg" \) -type f -print -quit 2>/dev/null)
    if [[ -n "$existing_dmg" ]]; then
        log_info "Found existing DMG: $existing_dmg"
        cp "$existing_dmg" "$dmg_path"
        return 0
    fi

    # 3. Auto-download via rnet (bypasses Cloudflare)
    if command_exists python3; then
        if fetch_dmg_via_rnet "$dmg_path"; then
            return 0
        fi
        log_warn "Auto-download failed, falling back to browser download"
    fi

    # 4. Browser download fallback
    local dl_dir
    dl_dir=$(xdg-user-dir DOWNLOAD 2>/dev/null || echo "$HOME/Downloads")
    local marker="$WORK_DIR/.download-marker"
    touch "$marker"

    log_info "Opening claude.ai/download in your browser..."
    log_info "Download the macOS (Universal) DMG — the installer will continue automatically."
    echo ""
    if ! xdg-open "$CLAUDE_DOWNLOAD_PAGE" 2>/dev/null; then
        log_warn "Could not open browser automatically."
        log_info "Please open this URL manually: $CLAUDE_DOWNLOAD_PAGE"
    fi

    log_info "Waiting for Claude*.dmg in $dl_dir ..."
    local found="" elapsed=0 timeout=600
    while [[ -z "$found" ]]; do
        sleep 2
        elapsed=$((elapsed + 2))
        if [[ "$elapsed" -ge "$timeout" ]]; then
            die "Timed out. Re-run with: CLAUDE_DMG=/path/to/Claude.dmg $0"
        fi
        found=$(find "$dl_dir" -maxdepth 1 \( -name "Claude*.dmg" -o -name "claude*.dmg" \) \
            -newer "$marker" -type f -print -quit 2>/dev/null)
    done
    log_success "Detected: $found"

    # Wait for download to finish (file size must stabilize)
    log_info "Waiting for download to complete..."
    local prev_size=-1 curr_size=0 stall_elapsed=0 stall_timeout=300
    while true; do
        curr_size=$(stat -c%s "$found" 2>/dev/null || echo 0)
        if [[ "$prev_size" -eq "$curr_size" && "$curr_size" -gt 0 \
              && ! -f "${found}.crdownload" ]]; then
            break
        fi
        if [[ "$curr_size" -gt "$prev_size" ]]; then
            stall_elapsed=0
        else
            stall_elapsed=$((stall_elapsed + 3))
        fi
        prev_size=$curr_size
        sleep 3
        if [[ "$stall_elapsed" -ge "$stall_timeout" ]]; then
            die "Download stalled for 5 minutes. File: $found ($(format_size "$curr_size"))"
        fi
    done
    log_success "Download complete: $(format_size "$curr_size")"
    cp "$found" "$dmg_path"
}

# ============================================================
# Step 4: Extract DMG into linux-app-extracted/
# ============================================================

extract_dmg() {
    local dmg_path="$1"
    local target_dir="$INSTALL_DIR/linux-app-extracted"

    # Extract DMG
    log_info "Extracting DMG..." >&2
    local extract_dir="$WORK_DIR/extract"
    local seven_z_exit=0
    7z x -y -o"$extract_dir" "$dmg_path" >/dev/null 2>&1 || seven_z_exit=$?
    # 7z exit 1 = warning, exit 2 = "Dangerous link path" (e.g. /Applications symlink
    # in DMG). Both are non-fatal on Linux — the symlink is macOS-specific.
    # See: https://github.com/johnzfitch/claude-cowork-linux/issues/35
    if [[ $seven_z_exit -gt 2 ]]; then
        die "Failed to extract DMG (7z exit code: $seven_z_exit)"
    fi
    if [[ $seven_z_exit -eq 1 || $seven_z_exit -eq 2 ]]; then
        log_warn "7z exited with code $seven_z_exit (non-fatal; e.g. skipped macOS symlinks)"
    fi

    # Find Claude.app and app.asar
    local claude_app
    claude_app=$(find "$extract_dir" -name "Claude.app" -type d | head -1)
    [[ -n "$claude_app" ]] || die "Claude.app not found in DMG"

    local asar_file="$claude_app/Contents/Resources/app.asar"
    [[ -f "$asar_file" ]] || die "app.asar not found at: $asar_file"

    # Extract asar into linux-app-extracted/
    if [[ -d "$target_dir" ]]; then
        log_info "Removing previous linux-app-extracted..."
        rm -rf "$target_dir"
    fi
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
        log_warn "Try re-running the installer with a fresh DMG download"
    fi

    log_success "Extracted app to linux-app-extracted/"
}

# ============================================================
# Step 5: Bake stubs into node_modules
# ============================================================

install_stubs() {
    local target_dir="$INSTALL_DIR/linux-app-extracted"

    log_info "Installing stubs..."

    # Copy stubs from the repo into the extracted app's node_modules
    local swift_src="$INSTALL_DIR/stubs/@ant/claude-swift/js/index.js"
    local native_src="$INSTALL_DIR/stubs/@ant/claude-native/index.js"

    [[ -f "$swift_src" ]] || die "Swift stub not found: $swift_src"
    [[ -f "$native_src" ]] || die "Native stub not found: $native_src"

    mkdir -p "$target_dir/node_modules/@ant/claude-swift/js"
    mkdir -p "$target_dir/node_modules/@ant/claude-native"

    cp "$swift_src" "$target_dir/node_modules/@ant/claude-swift/js/index.js"
    cp "$native_src" "$target_dir/node_modules/@ant/claude-native/index.js"

    # Copy frame-fix files if present in repo
    for f in frame-fix-wrapper.js frame-fix-entry.js; do
        if [[ -f "$INSTALL_DIR/stubs/frame-fix/$f" ]]; then
            cp "$INSTALL_DIR/stubs/frame-fix/$f" "$target_dir/$f"
        elif [[ -f "$INSTALL_DIR/$f" ]]; then
            cp "$INSTALL_DIR/$f" "$target_dir/$f"
        fi
    done

    log_success "Stubs installed"
}

# ============================================================
# Step 6: Apply patches
# ============================================================

apply_patches() {
    local index_js="$INSTALL_DIR/linux-app-extracted/.vite/build/index.js"
    local patch_script=""

    if [[ -f "$INSTALL_DIR/enable-cowork.py" ]]; then
        patch_script="$INSTALL_DIR/enable-cowork.py"
    elif [[ -f "$(dirname "$0")/enable-cowork.py" ]]; then
        patch_script="$(dirname "$0")/enable-cowork.py"
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
LOG_DIR="\$HOME/.local/share/claude-cowork/logs"
mkdir -p "\$LOG_DIR"

cd "\$COWORK_DIR"

case "\${1:-}" in
    --devtools) shift; exec ./launch-devtools.sh "\$@" 2>&1 | tee -a "\$LOG_DIR/startup.log" ;;
    --debug)    shift; export CLAUDE_TRACE=1; exec ./launch.sh "\$@" 2>&1 | tee -a "\$LOG_DIR/startup.log" ;;
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
    # User data dirs (macOS-style paths that Claude Desktop expects)
    local data_dir="$HOME/Library/Application Support/Claude"
    mkdir -p "$data_dir"/{Projects,Conversations}
    mkdir -p "$HOME/Library/Logs/Claude"
    mkdir -p "$HOME/Library/Caches/Claude"
    mkdir -p "$HOME/Library/Preferences"
    chmod 700 "$data_dir"

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
    # Also check claude-code-vm
    local vm_root="$HOME/Library/Application Support/Claude/claude-code-vm"
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
        log_error "/sessions: NOT FOUND -- run: sudo ln -s \"$HOME/Library/Application Support/Claude/LocalAgentModeSessions/sessions\" /sessions"
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

    # --- Python ---
    if command_exists python3; then
        local py_ver
        py_ver=$(python3 --version 2>&1 | awk '{print $2}')
        log_success "Python: $py_ver"
        ok=$((ok + 1))
    else
        log_warn "Python 3: not found (needed for auto-download and patches)"
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
    # Handle --doctor flag
    if [[ "${1:-}" == "--doctor" ]]; then
        doctor
        exit $?
    fi

    # Positional arg → CLAUDE_DMG
    if [[ -n "${1:-}" && -z "${CLAUDE_DMG:-}" ]]; then
        export CLAUDE_DMG="$1"
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

    # Step 3: Get DMG
    local dmg_path="$WORK_DIR/Claude.dmg"
    get_dmg "$dmg_path"
    echo ""

    # Step 4: Extract DMG → linux-app-extracted/
    extract_dmg "$dmg_path"
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
    echo ""
    echo "Update:"
    echo "  cd $INSTALL_DIR && git pull && bash install.sh"
    echo ""
    echo "Installed: $INSTALL_DIR"
    echo "Logs:      ~/.local/share/claude-cowork/logs/startup.log"
    echo ""
    echo "Make sure ~/.local/bin is on your PATH."
    echo ""
}

main "$@"
