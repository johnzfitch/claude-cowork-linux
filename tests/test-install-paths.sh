#!/bin/bash
#
# Test harness for claude-cowork-linux install paths.
#
# Validates install.sh, PKGBUILD, and curl-pipe install in stages.
# Each stage can be run independently:
#
#   ./tests/test-install-paths.sh          # all stages
#   ./tests/test-install-paths.sh 2        # just stage 2
#   ./tests/test-install-paths.sh 3 5      # stages 3 through 5
#
# Stages:
#   1  Static analysis (bash -n, python -c)
#   2  fetch-dmg.py output modes
#   3  DMG download + extraction
#   4  Stub baking + patching
#   5  asar repack
#   6  install.sh in Docker
#   7  PKGBUILD via makepkg
#   8  curl-pipe simulation in Docker

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARED_TMP=""
DOCKER_IMAGE="claude-cowork-test:latest"
DOCKER_DNS="${DOCKER_DNS:-9.9.9.9}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

# ============================================================
# Helpers
# ============================================================

log_stage() { echo -e "\n${BOLD}${BLUE}=== Stage $1: $2 ===${NC}"; }
pass()      { echo -e "  ${GREEN}PASS${NC} $*"; PASS=$((PASS + 1)); }
fail()      { echo -e "  ${RED}FAIL${NC} $*"; FAIL=$((FAIL + 1)); }
skip()      { echo -e "  ${YELLOW}SKIP${NC} $*"; SKIP=$((SKIP + 1)); }
info()      { echo -e "  ${BLUE}INFO${NC} $*"; }

assert_file_exists() {
    if [[ -f "$1" ]]; then
        pass "$2"
    else
        fail "$2 (missing: $1)"
    fi
}

assert_file_size_ge() {
    local file="$1" min="$2" label="$3"
    if [[ ! -f "$file" ]]; then
        fail "$label (file missing: $file)"
        return
    fi
    local size
    size=$(stat -c%s "$file" 2>/dev/null || echo 0)
    if [[ "$size" -ge "$min" ]]; then
        pass "$label ($(numfmt --to=iec "$size"))"
    else
        fail "$label (${size} < ${min})"
    fi
}

assert_grep() {
    local pattern="$1" file="$2" label="$3"
    if grep -q "$pattern" "$file" 2>/dev/null; then
        pass "$label"
    else
        fail "$label (pattern not found: $pattern)"
    fi
}

ensure_shared_tmp() {
    if [[ -z "$SHARED_TMP" ]]; then
        SHARED_TMP=$(mktemp -d)
        info "Shared temp dir: $SHARED_TMP"
    fi
}

cleanup() {
    if [[ -n "$SHARED_TMP" && -d "$SHARED_TMP" ]]; then
        rm -rf "$SHARED_TMP"
    fi
}
trap cleanup EXIT INT TERM

has_docker() {
    command -v docker &>/dev/null || command -v podman &>/dev/null
}

docker_cmd() {
    if command -v docker &>/dev/null; then
        echo "docker"
    elif command -v podman &>/dev/null; then
        echo "podman"
    fi
}

build_test_image() {
    local cmd
    cmd=$(docker_cmd)
    if ! $cmd image inspect "$DOCKER_IMAGE" &>/dev/null; then
        info "Building test container image..."
        $cmd build --network=host -t "$DOCKER_IMAGE" -f "$REPO_ROOT/tests/Dockerfile.test" "$REPO_ROOT/tests"
    fi
}

# ============================================================
# Stage 1: Static analysis
# ============================================================

stage_1() {
    log_stage 1 "Static analysis"

    # bash -n syntax check
    if bash -n "$REPO_ROOT/install.sh" 2>/dev/null; then
        pass "install.sh syntax OK"
    else
        fail "install.sh syntax check"
    fi

    if bash -n "$REPO_ROOT/PKGBUILD" 2>/dev/null; then
        pass "PKGBUILD syntax OK"
    else
        fail "PKGBUILD syntax check"
    fi

    # Python syntax checks
    if python3 -c "import py_compile; py_compile.compile('$REPO_ROOT/fetch-dmg.py', doraise=True)" 2>/dev/null; then
        pass "fetch-dmg.py syntax OK"
    else
        fail "fetch-dmg.py syntax check"
    fi

    if python3 -c "import py_compile; py_compile.compile('$REPO_ROOT/enable-cowork.py', doraise=True)" 2>/dev/null; then
        pass "enable-cowork.py syntax OK"
    else
        fail "enable-cowork.py syntax check"
    fi
}

# ============================================================
# Stage 2: fetch-dmg.py output modes
# ============================================================

stage_2() {
    log_stage 2 "fetch-dmg.js output modes"

    if ! command -v node >/dev/null 2>&1; then
        skip "node not installed"
        return
    fi

    local script="$REPO_ROOT/fetch-dmg.js"

    # --json mode
    local json_out
    json_out=$(node "$script" --json 2>/dev/null) || { fail "--json mode exited non-zero"; return; }

    if echo "$json_out" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); if(!d.version||!d.url) process.exit(1)" 2>/dev/null; then
        pass "--json has version + url keys"
    else
        fail "--json missing expected keys"
    fi

    # --url mode
    local url_out
    url_out=$(node "$script" --url 2>/dev/null) || { fail "--url mode exited non-zero"; return; }

    if [[ "$url_out" == https://downloads.claude.ai/* ]]; then
        pass "--url starts with https://downloads.claude.ai/"
    else
        fail "--url unexpected prefix: $url_out"
    fi

    # default mode (version + url)
    local default_out
    default_out=$(node "$script" 2>/dev/null) || { fail "default mode exited non-zero"; return; }

    local word_count
    word_count=$(echo "$default_out" | wc -w)
    if [[ "$word_count" -ge 2 ]]; then
        pass "default mode outputs version + url ($word_count words)"
    else
        fail "default mode unexpected output: $default_out"
    fi
}

# ============================================================
# Stage 3: DMG download + extraction
# ============================================================

stage_3() {
    log_stage 3 "DMG download + extraction"
    ensure_shared_tmp

    # Get URL
    local dmg_url=""
    if [[ -n "${CLAUDE_DMG:-}" && -f "${CLAUDE_DMG:-}" ]]; then
        info "Using CLAUDE_DMG=$CLAUDE_DMG"
        cp "$CLAUDE_DMG" "$SHARED_TMP/Claude.dmg"
    elif command -v node >/dev/null 2>&1; then
        dmg_url=$(node "$REPO_ROOT/fetch-dmg.js" --url 2>/dev/null) || {
            fail "Could not fetch DMG URL"
            return
        }
        info "Downloading DMG..."
        curl -fSL --progress-bar -o "$SHARED_TMP/Claude.dmg" "$dmg_url" || {
            fail "DMG download failed"
            return
        }
    else
        skip "No DMG source (set CLAUDE_DMG or install node)"
        return
    fi

    assert_file_size_ge "$SHARED_TMP/Claude.dmg" 100000000 "DMG >= 100MB"

    # Extract with 7z
    info "Extracting DMG with 7z..."
    7z x -y -o"$SHARED_TMP/extract" "$SHARED_TMP/Claude.dmg" >/dev/null 2>&1 || {
        fail "7z extraction failed"
        return
    }

    local claude_app
    claude_app=$(find "$SHARED_TMP/extract" -name "Claude.app" -type d | head -1)
    if [[ -n "$claude_app" ]]; then
        pass "Found Claude.app"
    else
        fail "Claude.app not found in DMG"
        return
    fi

    local asar_file="$claude_app/Contents/Resources/app.asar"
    assert_file_exists "$asar_file" "app.asar exists"

    # Extract asar
    info "Extracting app.asar..."
    asar extract "$asar_file" "$SHARED_TMP/linux-app-extracted" || {
        fail "asar extract failed"
        return
    }

    assert_file_exists "$SHARED_TMP/linux-app-extracted/.vite/build/index.js" "index.js exists in extracted app"
}

# ============================================================
# Stage 4: Stub baking + patching
# ============================================================

stage_4() {
    log_stage 4 "Stub baking + patching"
    ensure_shared_tmp

    local app_dir="$SHARED_TMP/linux-app-extracted"
    if [[ ! -d "$app_dir" ]]; then
        skip "No extracted app (run stage 3 first)"
        return
    fi

    # Bake stubs
    mkdir -p "$app_dir/node_modules/@ant/claude-swift/js"
    mkdir -p "$app_dir/node_modules/@ant/claude-native"
    cp "$REPO_ROOT/stubs/@ant/claude-swift/js/index.js" \
       "$app_dir/node_modules/@ant/claude-swift/js/index.js"
    cp "$REPO_ROOT/stubs/@ant/claude-native/index.js" \
       "$app_dir/node_modules/@ant/claude-native/index.js"

    assert_file_exists "$app_dir/node_modules/@ant/claude-swift/js/index.js" "Swift stub installed"
    assert_file_exists "$app_dir/node_modules/@ant/claude-native/index.js" "Native stub installed"

    # Copy frame-fix files
    for f in frame-fix-entry.js frame-fix-wrapper.js; do
        if [[ -f "$REPO_ROOT/stubs/frame-fix/$f" ]]; then
            cp "$REPO_ROOT/stubs/frame-fix/$f" "$app_dir/$f"
        fi
    done
    assert_file_exists "$app_dir/frame-fix-entry.js" "frame-fix-entry.js present"
    assert_file_exists "$app_dir/frame-fix-wrapper.js" "frame-fix-wrapper.js present"

    # Apply patch
    local index_js="$app_dir/.vite/build/index.js"
    if [[ ! -f "$index_js" ]]; then
        skip "index.js missing, cannot test patch"
        return
    fi

    python3 "$REPO_ROOT/enable-cowork.py" "$index_js" || {
        fail "enable-cowork.py first run failed"
        return
    }
    assert_grep "cowork-patched" "$index_js" "Patch marker present"

    # Idempotency: run again, should succeed
    if python3 "$REPO_ROOT/enable-cowork.py" "$index_js" 2>/dev/null; then
        pass "Patch idempotent (second run OK)"
    else
        fail "Patch not idempotent"
    fi
}

# ============================================================
# Stage 5: asar repack
# ============================================================

stage_5() {
    log_stage 5 "asar repack"
    ensure_shared_tmp

    local app_dir="$SHARED_TMP/linux-app-extracted"
    if [[ ! -d "$app_dir" ]]; then
        skip "No extracted app (run stages 3-4 first)"
        return
    fi

    local output="$SHARED_TMP/app.asar"
    info "Repacking asar..."
    asar pack "$app_dir" "$output" || {
        fail "asar pack failed"
        return
    }

    assert_file_size_ge "$output" 1000000 "Repacked asar >= 1MB"

    # Verify key entries exist in listing
    local listing
    listing=$(asar list "$output" 2>/dev/null)

    if echo "$listing" | grep -q "\.vite/build/index.js"; then
        pass "asar contains .vite/build/index.js"
    else
        fail "asar missing .vite/build/index.js"
    fi

    if echo "$listing" | grep -q "node_modules/@ant/claude-swift/js/index.js"; then
        pass "asar contains swift stub"
    else
        fail "asar missing swift stub"
    fi

    if echo "$listing" | grep -q "node_modules/@ant/claude-native/index.js"; then
        pass "asar contains native stub"
    else
        fail "asar missing native stub"
    fi
}

# ============================================================
# Stage 6: install.sh in Docker
# ============================================================

stage_6() {
    log_stage 6 "install.sh in Docker"

    if ! has_docker; then
        skip "Docker/Podman not available"
        return
    fi

    ensure_shared_tmp
    if [[ ! -f "$SHARED_TMP/Claude.dmg" ]]; then
        skip "No DMG available (run stage 3 first)"
        return
    fi

    build_test_image

    local cmd
    cmd=$(docker_cmd)

    info "Running install.sh in container..."
    local output
    output=$($cmd run --rm --dns "$DOCKER_DNS" \
        -v "$REPO_ROOT:/mnt/repo:ro" \
        -v "$SHARED_TMP/Claude.dmg:/mnt/Claude.dmg:ro" \
        -e CLAUDE_DMG=/mnt/Claude.dmg \
        -e HOME=/home/testuser \
        "$DOCKER_IMAGE" \
        bash -c '
            useradd -m testuser 2>/dev/null || true
            su testuser -c "
                export HOME=/home/testuser
                export PATH=\"\$HOME/.local/bin:\$PATH\"
                mkdir -p \$HOME/.local/share
                # Point INSTALL_DIR at a writable copy of the repo
                cp -r /mnt/repo \$HOME/.local/share/claude-desktop
                cd \$HOME/.local/share/claude-desktop
                # Run install.sh with CLAUDE_DMG set — skip deps (already in image)
                # and skip repo clone (we copied it)
                bash install.sh 2>&1
                echo "---VALIDATION---"
                # Check outputs
                test -x \$HOME/.local/bin/claude-desktop && echo "LAUNCHER_OK" || echo "LAUNCHER_MISSING"
                test -L \$HOME/.local/bin/claude-cowork && echo "SYMLINK_OK" || echo "SYMLINK_MISSING"
                test -f \$HOME/.local/share/applications/claude.desktop && echo "DESKTOP_ENTRY_OK" || echo "DESKTOP_ENTRY_MISSING"
                test -f \$HOME/.local/share/claude-desktop/linux-app-extracted/node_modules/@ant/claude-swift/js/index.js && echo "STUB_OK" || echo "STUB_MISSING"
                grep -q cowork-patched \$HOME/.local/share/claude-desktop/linux-app-extracted/.vite/build/index.js 2>/dev/null && echo "PATCH_OK" || echo "PATCH_MISSING"
            "
        ' 2>&1) || {
        fail "Docker run failed"
        echo "$output" | tail -20
        return
    }

    local validation
    validation=$(echo "$output" | sed -n '/---VALIDATION---/,$p')

    for check in LAUNCHER_OK SYMLINK_OK DESKTOP_ENTRY_OK STUB_OK PATCH_OK; do
        if echo "$validation" | grep -q "$check"; then
            pass "Docker install: $check"
        else
            fail "Docker install: ${check/_OK/_MISSING}"
        fi
    done
}

# ============================================================
# Stage 7: PKGBUILD via makepkg
# ============================================================

stage_7() {
    log_stage 7 "PKGBUILD via makepkg"

    if ! command -v makepkg &>/dev/null; then
        skip "makepkg not available (not on Arch?)"
        return
    fi

    ensure_shared_tmp
    local build_dir="$SHARED_TMP/makepkg-test"
    mkdir -p "$build_dir"

    # Copy PKGBUILD
    cp "$REPO_ROOT/PKGBUILD" "$build_dir/PKGBUILD"

    info "Running makepkg..."
    if (cd "$build_dir" && makepkg -sf --noconfirm 2>&1 | tail -5); then
        pass "makepkg completed"
    else
        fail "makepkg failed"
        return
    fi

    # Find the built package
    local pkg
    pkg=$(find "$build_dir" -name "*.pkg.tar.zst" -o -name "*.pkg.tar.xz" | head -1)
    if [[ -n "$pkg" ]]; then
        pass "Package produced: $(basename "$pkg")"
    else
        fail "No .pkg.tar.zst produced"
        return
    fi

    # Inspect contents
    local contents
    contents=$(tar -tf "$pkg" 2>/dev/null || bsdtar -tf "$pkg" 2>/dev/null)

    if echo "$contents" | grep -q "usr/lib/claude-cowork/app.asar"; then
        pass "Package contains app.asar"
    else
        fail "Package missing app.asar"
    fi

    if echo "$contents" | grep -q "usr/bin/claude-cowork"; then
        pass "Package contains launcher"
    else
        fail "Package missing launcher"
    fi

    if echo "$contents" | grep -q "usr/share/applications/claude-cowork.desktop"; then
        pass "Package contains desktop entry"
    else
        fail "Package missing desktop entry"
    fi
}

# ============================================================
# Stage 8: curl-pipe simulation in Docker
# ============================================================

stage_8() {
    log_stage 8 "curl-pipe simulation in Docker"

    if ! has_docker; then
        skip "Docker/Podman not available"
        return
    fi

    ensure_shared_tmp
    if [[ ! -f "$SHARED_TMP/Claude.dmg" ]]; then
        skip "No DMG available (run stage 3 first)"
        return
    fi

    build_test_image

    local cmd
    cmd=$(docker_cmd)

    info "Running curl-pipe simulation in container..."
    local output
    output=$($cmd run --rm --dns "$DOCKER_DNS" \
        -v "$REPO_ROOT:/mnt/repo:ro" \
        -v "$SHARED_TMP/Claude.dmg:/mnt/Claude.dmg:ro" \
        -e CLAUDE_DMG=/mnt/Claude.dmg \
        -e HOME=/home/testuser \
        "$DOCKER_IMAGE" \
        bash -c '
            useradd -m testuser 2>/dev/null || true
            su testuser -c "
                export HOME=/home/testuser
                export PATH=\"\$HOME/.local/bin:\$PATH\"
                # Simulate curl pipe: stdin install, no \$0 dirname
                bash <(cat /mnt/repo/install.sh) 2>&1
                echo \"---VALIDATION---\"
                test -x \$HOME/.local/bin/claude-desktop && echo \"LAUNCHER_OK\" || echo \"LAUNCHER_MISSING\"
                test -d \$HOME/.local/share/claude-desktop/.git && echo \"REPO_CLONED_OK\" || echo \"REPO_CLONED_MISSING\"
            "
        ' 2>&1) || {
        fail "Docker run failed"
        echo "$output" | tail -20
        return
    }

    local validation
    validation=$(echo "$output" | sed -n '/---VALIDATION---/,$p')

    for check in LAUNCHER_OK REPO_CLONED_OK; do
        if echo "$validation" | grep -q "$check"; then
            pass "curl-pipe: $check"
        else
            fail "curl-pipe: ${check/_OK/_MISSING}"
        fi
    done
}

# ============================================================
# Main
# ============================================================

main() {
    local start_stage="${1:-1}"
    local end_stage="${2:-8}"

    echo -e "${BOLD}Claude Cowork Linux — Install Path Test Harness${NC}"
    echo -e "Repo: $REPO_ROOT"
    echo -e "Stages: $start_stage through $end_stage"

    for stage in $(seq "$start_stage" "$end_stage"); do
        "stage_$stage"
    done

    echo ""
    echo -e "${BOLD}Results:${NC} ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${SKIP} skipped${NC}"

    if [[ "$FAIL" -gt 0 ]]; then
        exit 1
    fi
}

main "$@"
