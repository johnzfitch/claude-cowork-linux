#!/bin/bash
#
# extract_archive staging harness.
#
# What this file exists to keep true: an upgrade leaves NOTHING of the
# previous bundle behind in linux-app-extracted, and a failed extraction
# leaves the live tree exactly as it was.
#
# Extracting on top of the existing tree accumulated every chunk of every
# asar version ever installed -- chunk names are content-hashed, so an
# upgrade never overwrites old files, only adds new ones. Nothing loads the
# leftovers, but the doctor's cowork-patched grep and apply_patches'
# any_patched test both match on them, so a bundle whose platform gate no
# longer matches our patterns (#189) still reported success on machines
# that upgraded in place, with Cowork silently disabled.
#
# Hermetic: a temp HOME, fake `7z`/`asar` binaries, fixture "archives" that
# are plain directories. No network, no Docker, no real install touched.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0

pass()    { echo -e "  ${GREEN}PASS${NC} $*"; PASS=$((PASS + 1)); }
fail()    { echo -e "  ${RED}FAIL${NC} $*"; FAIL=$((FAIL + 1)); }
section() { echo -e "\n${BOLD}=== $* ===${NC}"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ============================================================
# Fixtures: fake tools and two "asar versions"
# ============================================================

FAKE_BIN="$TMP/bin"
FAKE_HOME="$TMP/home"
mkdir -p "$FAKE_BIN" "$FAKE_HOME"

# Fake 7z: "extract" an archive that is really a directory by copying it
# into the -o<dir> target.
cat > "$FAKE_BIN/7z" <<'EOF'
#!/bin/bash
out=""; archive=""
for a in "$@"; do
    case "$a" in
        -o*) out="${a#-o}" ;;
        x|-y) ;;
        *) archive="$a" ;;
    esac
done
mkdir -p "$out"
cp -r "$archive"/. "$out/"
EOF

# Fake asar: `asar extract <file> <dir>` copies the tree the "asar file"
# points at (its contents name a fixture dir). FAKE_ASAR_FAIL=1 simulates
# a truncated download dying mid-extract, after writing partial output.
cat > "$FAKE_BIN/asar" <<'EOF'
#!/bin/bash
[[ "$1" == "extract" ]] || exit 0
src="$(cat "$2")"
mkdir -p "$3"
if [[ "${FAKE_ASAR_FAIL:-}" == "1" ]]; then
    echo partial > "$3/partial.js"
    exit 1
fi
cp -r "$src"/. "$3/"
EOF
chmod +x "$FAKE_BIN/7z" "$FAKE_BIN/asar"

# An archive fixture: Claude.app skeleton whose app.asar names the payload dir.
make_archive() { # $1=archive dir  $2=payload dir
    local res="$1/Claude.app/Contents/Resources"
    mkdir -p "$res"
    printf '%s' "$2" > "$res/app.asar"
    echo '{}' > "$res/en-US.json"
}

PAYLOAD_V1="$TMP/payload-v1"
PAYLOAD_V2="$TMP/payload-v2"
mkdir -p "$PAYLOAD_V1/.vite/build" "$PAYLOAD_V2/.vite/build"
echo 'v1' > "$PAYLOAD_V1/.vite/build/index.js"
echo 'v1-only' > "$PAYLOAD_V1/.vite/build/index.chunk-OLDHASH.js"
echo 'v2' > "$PAYLOAD_V2/.vite/build/index.js"
echo 'v2-only' > "$PAYLOAD_V2/.vite/build/index.chunk-NEWHASH.js"

make_archive "$TMP/archive-v1" "$PAYLOAD_V1"
make_archive "$TMP/archive-v2" "$PAYLOAD_V2"

# ============================================================
# Drive extract_archive from a sourced install.sh
# ============================================================

export HOME="$FAKE_HOME"
export PATH="$FAKE_BIN:$PATH"
# shellcheck source=../install.sh
source "$REPO_ROOT/install.sh"
set +e   # install.sh turns on -e; assertions below must not abort the harness

LIVE="$INSTALL_DIR/linux-app-extracted"

section "Fresh install extracts the v1 tree"
( extract_archive "$TMP/archive-v1" ) >/dev/null 2>&1
[[ -f "$LIVE/.vite/build/index.chunk-OLDHASH.js" ]] \
    && pass "v1 chunk present after first extract" \
    || fail "v1 chunk missing after first extract"

section "Upgrade wipes the previous bundle's chunks"
( extract_archive "$TMP/archive-v2" ) >/dev/null 2>&1
[[ -f "$LIVE/.vite/build/index.chunk-NEWHASH.js" ]] \
    && pass "v2 chunk present after upgrade" \
    || fail "v2 chunk missing after upgrade"
[[ ! -e "$LIVE/.vite/build/index.chunk-OLDHASH.js" ]] \
    && pass "v1 chunk gone after upgrade" \
    || fail "v1 chunk still present after upgrade (stale accumulation)"
[[ -z "$(find "$INSTALL_DIR" -maxdepth 1 -name 'linux-app-extracted.*' 2>/dev/null)" ]] \
    && pass "no staging/old orphans left beside the live tree" \
    || fail "staging/old orphans left beside the live tree"

section "Failed extraction leaves the live tree untouched"
( FAKE_ASAR_FAIL=1 extract_archive "$TMP/archive-v1" ) >/dev/null 2>&1
rc=$?
[[ $rc -ne 0 ]] \
    && pass "extract_archive fails on asar failure (exit $rc)" \
    || fail "extract_archive succeeded despite asar failure"
[[ -f "$LIVE/.vite/build/index.chunk-NEWHASH.js" && ! -e "$LIVE/.vite/build/index.chunk-OLDHASH.js" ]] \
    && pass "live tree still the v2 bundle" \
    || fail "live tree damaged by failed extraction"
[[ ! -e "$LIVE/.vite/build/partial.js" ]] \
    && pass "no partial output reached the live tree" \
    || fail "partial output reached the live tree"

# ============================================================
echo ""
echo -e "${BOLD}${PASS} passed, ${FAIL} failed${NC}"
[[ $FAIL -eq 0 ]]
