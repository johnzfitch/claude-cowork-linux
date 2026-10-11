#!/bin/bash
#
# Launcher stub-sync harness.
#
# Two things this file exists to keep true, both of which broke silently and
# stayed broken for months because nothing looked:
#
#   1. The repack cache actually caches. launch.sh re-syncs the stub tree into
#      linux-app-extracted on every start, then repacks app.asar only "if any
#      file in the extracted tree is newer than the cached asar". A bare
#      `cp -f` stamps the destination with the current time whether or not a
#      byte changed, so that question answered yes on every launch: the cache
#      never hit, the "Using cached app.asar (no changes)" branch was
#      unreachable, and every single start repacked the whole ~300-file tree.
#      The same shape bit the mainView.js sed (see patch-index.sh) and the
#      package.json entry-point sed below -- a write that always happens,
#      feeding an mtime check that assumes writes mean changes.
#
#   2. Every deployment path delivers a stub's whole module set, not just its
#      index.js. stubs/@ant/claude-native/index.js require()s ./safe_fs.js at
#      module load; PKGBUILD copied index.js alone for four months after that
#      helper landed, so the AUR package shipped a stub whose first require()
#      throws MODULE_NOT_FOUND. install.sh and launch.sh copy
#      the glob; any consumer that hand-lists files will fail here.
#
# Hermetic: a temp tree, a temp HOME, and fake `electron`/`asar` binaries. No
# network, no Docker, no real install touched.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

pass()    { echo -e "  ${GREEN}PASS${NC} $*"; PASS=$((PASS + 1)); }
fail()    { echo -e "  ${RED}FAIL${NC} $*"; FAIL=$((FAIL + 1)); }
skip()    { echo -e "  ${YELLOW}SKIP${NC} $*"; SKIP=$((SKIP + 1)); }
section() { echo -e "\n${BOLD}=== $* ===${NC}"; }

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ============================================================
# Fixture: a minimal tree launch.sh can drive end to end
# ============================================================

FAKE_BIN="$TMP/bin"
FAKE_HOME="$TMP/home"
TREE="$TMP/tree"

build_fixture() {
    rm -rf "$TREE" "$FAKE_HOME"
    mkdir -p "$FAKE_BIN" "$FAKE_HOME" \
             "$TREE/stubs/@ant/claude-swift/js" \
             "$TREE/stubs/@ant/claude-native" \
             "$TREE/stubs/cowork" \
             "$TREE/stubs/frame-fix" \
             "$TREE/linux-app-extracted/.vite/build" \
             "$TREE/linux-app-extracted/resources"

    cp "$REPO_ROOT/launch.sh" "$REPO_ROOT/patch-index.sh" "$TREE/"

    echo 'module.exports={};' > "$TREE/stubs/@ant/claude-swift/js/index.js"
    echo 'module.exports={};' > "$TREE/stubs/@ant/claude-native/index.js"
    echo 'module.exports={};' > "$TREE/stubs/@ant/claude-native/safe_fs.js"
    echo 'module.exports={};' > "$TREE/stubs/cowork/dirs.js"
    for f in frame-fix-entry.js frame-fix-wrapper.js protocol-forwarder.js; do
        echo 'module.exports={};' > "$TREE/stubs/frame-fix/$f"
    done
    printf '#!/bin/sh\nexit 0\n' > "$TREE/stubs/cowork/cowork-plugin-shim.sh"

    echo 'var x=1;' > "$TREE/linux-app-extracted/.vite/build/index.js"
    # The shape the real bundle ships, and the only one the entry-point sed
    # rewrites. A different shape is asserted separately below.
    echo '{"main":".vite/build/index.pre.js"}' > "$TREE/linux-app-extracted/package.json"

    printf '#!/bin/sh\nexit 0\n' > "$FAKE_BIN/electron"
    # `asar pack <dir> <out>` -- just materialise the output file.
    printf '#!/bin/sh\nmkdir -p "$(dirname "$3")"; : > "$3"\n' > "$FAKE_BIN/asar"
    chmod +x "$FAKE_BIN/electron" "$FAKE_BIN/asar"
}

# Run launch.sh against the fixture with nothing inherited from the caller's
# environment beyond a minimal PATH, so a developer's real ~/.config/Claude and
# real electron install can't influence the result.
run_launch() {
    env -i HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/local/bin:/usr/bin:/bin" \
        bash "$TREE/launch.sh" 2>&1
}

# ============================================================
# 1. The repack cache
# ============================================================

section "Repack cache (launch.sh)"

if ! command -v cmp >/dev/null 2>&1; then
    skip "repack cache behaviour (cmp not installed)"
else
    build_fixture

    out1="$(run_launch)"
    if grep -q "Repacking app.asar" <<<"$out1"; then
        pass "first launch repacks (no cached asar yet)"
    else
        fail "first launch should repack; got: $(head -3 <<<"$out1")"
    fi

    out2="$(run_launch)"
    if grep -q "Using cached app.asar (no changes)" <<<"$out2"; then
        pass "second launch reuses the cached asar (sync must not bump mtime)"
    else
        fail "second launch repacked with nothing changed -- the stub sync is stamping mtimes again"
    fi

    # A real edit must still be picked up: a cache that never invalidates is
    # worse than one that never hits.
    echo 'module.exports={changed:1};' > "$TREE/stubs/cowork/dirs.js"
    out3="$(run_launch)"
    if grep -q "Repacking app.asar" <<<"$out3"; then
        pass "an edited stub forces a repack"
    else
        fail "an edited stub did not force a repack -- the cache never invalidates"
    fi

    out4="$(run_launch)"
    if grep -q "Using cached app.asar (no changes)" <<<"$out4"; then
        pass "cache holds again once the edit has been packed"
    else
        fail "cache did not settle after an edit"
    fi
fi

# ============================================================
# 2. The entry-point patch guards on what it substitutes
# ============================================================

section "Entry-point patch (launch.sh)"

if ! command -v cmp >/dev/null 2>&1; then
    skip "entry-point patch behaviour (cmp not installed)"
else
    build_fixture
    run_launch >/dev/null
    if grep -q '"main": "frame-fix-entry.js"' "$TREE/linux-app-extracted/package.json"; then
        pass "main is repointed at frame-fix-entry.js"
    else
        fail "main was not repointed: $(cat "$TREE/linux-app-extracted/package.json")"
    fi

    # A main the sed cannot rewrite must say so. It used to pass the looser
    # guard, no-op in the sed, print "Fixing entry point..." anyway, and bump
    # mtime on every launch forever while the app ran its own entry point.
    build_fixture
    echo '{"main":"./.vite/build/index.pre.js"}' > "$TREE/linux-app-extracted/package.json"
    out="$(run_launch)"
    if grep -q "WARN: package.json still points at index.pre.js" <<<"$out"; then
        pass "an unrewritable main warns instead of silently claiming success"
    else
        fail "an unrewritable main was patched silently or not reported"
    fi
    if grep -q "Fixing entry point" <<<"$out"; then
        fail "claimed to fix an entry point it did not rewrite"
    else
        pass "does not claim to have fixed what it skipped"
    fi
fi

# ============================================================
# 3. Every deployment path ships a stub's whole module set
# ============================================================

section "Stub module-set parity"

NATIVE_DIR="$REPO_ROOT/stubs/@ant/claude-native"

# Every relative require() in the native stub must resolve in the repo. A
# require of a file that was never committed fails the same way a deployment
# path that forgets to copy it does.
#
# Both quote styles, and a hard failure when the scan finds NOTHING. A pattern
# that quietly stops matching is how a check turns into a check-shaped no-op:
# with a single-quote-only pattern, reformatting the stub to
# require("./safe_fs.js") would have left this reporting green while inspecting
# an empty list -- the same vacuous pass this PR removes from
# exec_capability_registry.test.cjs. index.js has relative requires today, so
# zero matches means the pattern broke, not that the dependencies went away.
dep_count=0
missing_src=""
while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    dep_count=$((dep_count + 1))
    [ -f "$NATIVE_DIR/$dep" ] || [ -f "$NATIVE_DIR/$dep.js" ] || missing_src="$missing_src $dep"
done < <(grep -oE "require\(['\"]\./[^'\"]+['\"]\)" "$NATIVE_DIR/index.js" 2>/dev/null \
         | sed -E "s|require\(['\"]\./([^'\"]+)['\"]\)|\1|")
if [ "$dep_count" -eq 0 ]; then
    fail "no relative require() found in the native stub -- this scan's pattern has stopped matching"
elif [ -z "$missing_src" ]; then
    pass "all $dep_count sibling modules @ant/claude-native/index.js require()s exist in stubs/"
else
    fail "native stub require()s files not in stubs/:$missing_src"
fi

# Consumers must copy the directory, not hand-list index.js. safe_fs.js landed
# months after PKGBUILD's copy line was written and never reached the package.
for consumer in install.sh launch.sh PKGBUILD nix/package.nix; do
    if grep -qE 'claude-native/\*\.js' "$REPO_ROOT/$consumer"; then
        pass "$consumer copies the whole @ant/claude-native module set"
    else
        fail "$consumer names individual native stub files -- a new sibling module will not ship"
    fi
done

# Repo-wide, so a deployment path added later cannot reintroduce this without
# tripping the check -- PR #178's draft flatpak manifest carries the same
# single-file copy today. Scoped to lines that actually COPY the stub, so a
# docs mention doesn't match. Plain grep
# rather than `git grep`: this must work in an exported tree too.
found_any=0
while IFS= read -r offender; do
    [ -n "$offender" ] || continue
    found_any=1
    rel="${offender#"$REPO_ROOT"/}"
    if grep -qE 'claude-native/\*\.js' "$offender"; then
        pass "$rel names index.js but also copies the whole module set"
    else
        fail "$rel copies claude-native/index.js alone -- safe_fs.js will not ship"
    fi
done < <(grep -rlE 'cp .*claude-native/index\.js' "$REPO_ROOT" \
             --exclude-dir=.git --exclude-dir=node_modules \
             --exclude=index.js 2>/dev/null | sort)
if [ "$found_any" -eq 0 ]; then
    pass "no deployment path copies claude-native/index.js by name"
fi

# ============================================================
# 4. frame-fix file list parity
# ============================================================

section "frame-fix file list parity"

# The generated launcher execs linux-app-extracted/protocol-forwarder.js for
# the claude:// OAuth fast path. install.sh placed it there; launch.sh's sync
# list omitted it, so an edited forwarder never reached a launch.
for consumer in install.sh launch.sh nix/package.nix; do
    if grep -q 'protocol-forwarder.js' "$REPO_ROOT/$consumer"; then
        pass "$consumer syncs protocol-forwarder.js"
    else
        fail "$consumer does not sync protocol-forwarder.js"
    fi
done

# ============================================================

echo ""
echo -e "${BOLD}Summary:${NC} ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${SKIP} skipped${NC}"
[ "$FAIL" -eq 0 ]
