#!/bin/bash
#
# Regression tests for the Cowork patch machinery.
#
# Claude Desktop's main bundle is minified, and two things change every build:
#   1. the minifier reassigns short identifiers (the IPC sender arg was `i` in
#      older builds and is `n` now; validators can even contain `$`);
#   2. newer builds split the Vite main entry so index.js becomes a thin shim
#      that require()s the real code from an index.chunk-<hash>.js file.
#
# These tests pin both behaviours so a future build reshuffle can't silently
# turn the patches into no-ops:
#   - enable-cowork.py patches a chunk whose identifiers differ from anything
#     hardcoded (platform gate, IPC origin guards, host-platform, return gate);
#   - the index.js -> index.chunk discovery used by install.sh / launch.sh finds
#     the chunk from the shim, and is a clean no-op on single-entry builds;
#   - launch.sh's patch_index seds apply across a chunk with rotated identifiers.
#
# No network or Docker needed. Requires python3 and node.
#
#   ./tests/test-cowork-patch.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0; SKIP=0
pass() { echo -e "  ${GREEN}PASS${NC} $*"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $*"; FAIL=$((FAIL + 1)); }
skip() { echo -e "  ${YELLOW}SKIP${NC} $*"; SKIP=$((SKIP + 1)); }
section() { echo -e "\n${BOLD}=== $* ===${NC}"; }

HAVE_NODE=0
command -v node >/dev/null 2>&1 && HAVE_NODE=1

# assert_grep <file> <ERE pattern> <label>   — pattern MUST be present
assert_grep() { if grep -qE "$2" "$1"; then pass "$3"; else fail "$3"; fi; }
# refute_grep <file> <ERE pattern> <label>   — pattern must be ABSENT
refute_grep() { if grep -qE "$2" "$1"; then fail "$3"; else pass "$3"; fi; }
# assert_parses <file> <label>
assert_parses() {
  if [[ "$HAVE_NODE" -eq 0 ]]; then skip "$2 (node not installed)"; return; fi
  if node --check "$1" 2>/dev/null; then pass "$2"; else fail "$2 (node --check failed)"; fi
}

# The exact discovery used by install.sh apply_patches and launch.sh.
discover_chunks() { grep -oE 'index2?\.chunk-[A-Za-z0-9_-]+\.js' "$1" | sort -u; }

# Write a chunk exercising every patch site, using identifiers that are NOT the
# values any older hardcoded pattern used (function qZ9/var r; validator $m/arg
# n; objects Zq/Yw/Xp/mB/kk/jn; setUserActivity arg qq).
write_patch_fixture() {
  cat > "$1" <<'EOF'
"use strict";
function qZ9(){const r=process.platform;if(r!=="darwin"&&r!=="win32")return{status:"unsupported",reason:"nope"};return{status:"supported"}}
const gate=qZ9();
function checkOrigin(n){if(!$m(n))throw new Error(`Incoming "doThing" call on interface "MyIface" from '${(i=n.senderFrame)==null?void 0:i.url}' did not pass origin validation`)}
function checkOriginNoNew(e){if(!tn(e))throw Error(`Incoming "getInitialLocale" call on interface "DesktopIntl" from '${e.senderFrame?.url}' did not pass origin validation`)}
function hostPlat(){if(process.platform==="darwin")return"darwin-x64";throw new Error("Unsupported platform: "+process.platform)}
function extInstall(){return{status:2,error:`Unsupported platform: ${process.platform} not allowed`}}
async function hostRead(De){let ee;try{ee=await helpers.resolveFilePath(De,!0)}catch(e){return e}return ee}
const winOpts={show:!1,titleBarStyle:"hidden",titleBarOverlay:Ab,trafficLightPosition:Cd,webPreferences:{}};
const aboutOpts={titleBarStyle:"hiddenInset",autoHideMenuBar:!0,skipTaskbar:!0};
function guard(){return Zq.protocol==="file:"&&Yw.app.isPackaged===!0}
function buildArgs(){Xp.push("--effort",this.options.effort)}
function handoff(){mB.app.invalidateCurrentActivity();mB.app.setUserActivity(qq,{})}
function wrapSpawn(t){return process.platform!=="darwin"?t:{cmd:rpt(),args:[t.cmd,...t.args]}}
const res=kk.app.isPackaged?process.resourcesPath:someFallback;
const host=kk.app.isPackaged?jn.join(process.resourcesPath,"app.asar","mcp-runtime","nodeHost.js"):jn.join(kk.app.getAppPath(),"nodeHost.js");
EOF
}

# Desktop 1.28929.0 moved the gate into index2.chunk-* and switched the
# minifier's string style to backticks. Keep this fixture close to the real
# bundle shape so quote-style or secondary-chunk regressions are caught.
write_128929_fixture() {
  cat > "$1" <<'EOF'
"use strict";
function Me(){let r=process.platform;if(r!==`darwin`&&r!==`win32`)return{status:`unsupported`,reason:`nope`,unsupportedCode:`unsupported_platform`};return{status:`supported`}}
const support=Me();
EOF
}

# ---------------------------------------------------------------------------
section "1. Static analysis"
# ---------------------------------------------------------------------------
if python3 -c "import ast; ast.parse(open('$REPO_ROOT/enable-cowork.py').read())" 2>/dev/null; then
  pass "enable-cowork.py parses"; else fail "enable-cowork.py parses"; fi
for s in launch.sh install.sh; do
  if bash -n "$REPO_ROOT/$s" 2>/dev/null; then pass "$s syntax"; else fail "$s syntax"; fi
done

# ---------------------------------------------------------------------------
section "2. enable-cowork.py on a chunk with rotated identifiers"
# ---------------------------------------------------------------------------
CHUNK="$TMP/index.chunk-V9ybBkRT.js"
write_patch_fixture "$CHUNK"
assert_parses "$CHUNK" "fixture chunk parses before patching"
python3 "$REPO_ROOT/enable-cowork.py" "$CHUNK" >/dev/null 2>&1
assert_grep  "$CHUNK" 'cowork-patched'                 "platform-gate marker present"
assert_grep  "$CHUNK" 'cowork-ipc-patched'             "IPC marker present"
assert_grep  "$CHUNK" 'cowork-platform-return-patched' "return-gate marker present"
assert_grep  "$CHUNK" 'cowork-tool-result-resolve-patched' "tool-result resolver marker present"
assert_grep  "$CHUNK" 'function qZ9\(\)\{return\{status:"supported"\}\}' "platform gate returns supported"
# IPC guard: validator $m and sender arg n both preserved, file:// exempted
assert_grep  "$CHUNK" 'if\(!\$m\(n\)&&!\(n\.senderFrame&&n\.senderFrame\.url&&n\.senderFrame\.url\.startsWith\("file://"\)\)\)' \
             "IPC guard exempts file:// (rotated validator \$m + arg n)"
assert_grep  "$CHUNK" 'if\(!tn\(e\)&&!\(e\.senderFrame&&e\.senderFrame\.url&&e\.senderFrame\.url\.startsWith\("file://"\)\)\)' \
             "IPC guard supports throw Error without new (1.28929)"
assert_grep  "$CHUNK" 'return"darwin-x64"'             "getHostPlatform throw -> darwin-x64"
refute_grep  "$CHUNK" 'error:`Unsupported platform'    "return-style platform gate neutralized"
assert_grep  "$CHUNK" '\.claude\\/projects.*tool-results.*\.test\(De\)\)ee=De;else try' \
             "SDK-spooled tool results bypass the automount resolver"
assert_parses "$CHUNK" "chunk parses after enable-cowork.py"

CHUNK2="$TMP/index2.chunk-DOB7tBaF.js"
write_128929_fixture "$CHUNK2"
python3 "$REPO_ROOT/enable-cowork.py" "$CHUNK2" >/dev/null 2>&1
assert_grep "$CHUNK2" 'cowork-patched' "1.28929 index2 gate marker present"
assert_grep "$CHUNK2" 'function Me\(\)\{return\{status:"supported"\}\}' "1.28929 backtick gate returns supported"
assert_parses "$CHUNK2" "1.28929 index2 chunk parses after patch"

# Exit-code contract that install.sh apply_patches relies on to log success
# accurately: a file with the gate (or already patched) exits 0; a shim with no
# gate exits non-zero. apply_patches only reports success if >=1 target exits 0.
if python3 "$REPO_ROOT/enable-cowork.py" "$CHUNK" >/dev/null 2>&1; then
  pass "re-running on an already-patched gate file exits 0 (idempotent)"
else
  fail "re-running on an already-patched gate file should exit 0"
fi
SHIM="$TMP/shim_index.js"
cat > "$SHIM" <<'EOF'
"use strict";
require("./index.chunk-V9ybBkRT.js");
function auxOnly(e){if(!tn(e))throw Error(`Incoming "auxOnly" call on interface "Aux" from '${e.senderFrame?.url}' did not pass origin validation`)}
async function readSpooled(p){let out;try{out=await safe.resolveFilePath(p,!0)}catch(e){return e}return out}
EOF
if python3 "$REPO_ROOT/enable-cowork.py" "$SHIM" >/dev/null 2>&1; then
  fail "shim with no platform gate should exit non-zero"
else
  pass "shim with no platform gate exits non-zero (apply_patches won't false-succeed)"
fi
assert_grep "$SHIM" 'cowork-ipc-patched' "auxiliary patches run even when platform gate is in another chunk"
assert_grep "$SHIM" 'cowork-tool-result-resolve-patched' "tool-result auxiliary patch runs without a platform gate"

# ---------------------------------------------------------------------------
section "3. index.js -> chunk discovery (install.sh / launch.sh)"
# ---------------------------------------------------------------------------
mkdir -p "$TMP/build"
printf '"use strict";\nrequire("./index.chunk-V9ybBkRT.js");\nrequire("./index2.chunk-DOB7tBaF.js");\n' > "$TMP/build/index.js"
: > "$TMP/build/index.chunk-V9ybBkRT.js"
: > "$TMP/build/index2.chunk-DOB7tBaF.js"
found="$(discover_chunks "$TMP/build/index.js")"
[[ "$found" == $'index.chunk-V9ybBkRT.js\nindex2.chunk-DOB7tBaF.js' ]] && pass "split-entry: index and index2 chunks discovered from shim" \
  || fail "split-entry: index and index2 chunks discovered from shim (got: '$found')"
# Single-entry build (no shim) -> discovery finds nothing (clean no-op)
printf '"use strict";var x=1;\n' > "$TMP/build/single.js"
[[ -z "$(discover_chunks "$TMP/build/single.js")" ]] && pass "single-entry: no chunk discovered (backward compatible)" \
  || fail "single-entry: no chunk discovered"

# ---------------------------------------------------------------------------
section "4. launch.sh patch_index seds on a chunk with rotated identifiers"
# ---------------------------------------------------------------------------
# Extract the real patch_index() helper + every patch_index invocation verbatim
# from launch.sh so this test tracks the shipped code, not a copy.
BLOCK="$TMP/patch_block.sh"
awk '/^patch_index\(\) \{/{f=1} f{print} /Only repack if stub/{exit}' "$REPO_ROOT/launch.sh" \
  | sed '/# Only repack if stub/d' > "$BLOCK"
NCALLS="$(grep -c '^patch_index ' "$BLOCK" || true)"
if [[ "${NCALLS:-0}" -lt 1 ]]; then
  fail "extracted patch_index block from launch.sh (found $NCALLS calls)"
else
  pass "extracted patch_index block from launch.sh ($NCALLS calls)"
  LCHUNK="$TMP/launch_chunk.js"
  write_patch_fixture "$LCHUNK"
  ( INDEX_TARGETS=("$LCHUNK"); source "$BLOCK" ) >/dev/null 2>&1
  refute_grep "$LCHUNK" 'titleBarStyle:"hidden"'                     "main-window titlebar removed"
  refute_grep "$LCHUNK" 'titleBarStyle:"hiddenInset"'                "about-window titlebar removed"
  assert_grep "$LCHUNK" 'return Zq\.protocol==="file:"\}'            "origin isPackaged requirement dropped for file://"
  assert_grep "$LCHUNK" 'this\.options\.effort==="xhigh"\?"max"'     "--effort xhigh -> max"
  assert_grep "$LCHUNK" '\(mB\.app\.invalidateCurrentActivity\|\|function\(\)\{\}\)\(\)' "Handoff invalidateCurrentActivity no-op fallback"
  assert_grep "$LCHUNK" '\(mB\.app\.setUserActivity\|\|function\(\)\{\}\)\)\(qq,'          "Handoff setUserActivity no-op fallback"
  refute_grep "$LCHUNK" 'kk\.app\.isPackaged\?process\.resourcesPath:' "resourcesPath fallback forced"
  assert_grep "$LCHUNK" 'kk\.app\.isPackaged\?jn\.join\(kk\.app\.getAppPath\(\),"mcp-runtime"' "MCP node-host uses getAppPath()"
  # The disclaimer wrap site must survive patching untouched. Neutralising it to
  # the asar's non-darwin (identity) branch is a tempting simplification -- it
  # removes the wrap/unwrap round-trip -- but that wrap is the only chokepoint
  # where our spawn interception sees the bundle's spawn decisions, and the
  # unwrap substitutes our resolved Claude binary for whatever path the asar
  # chose. Patching it away regresses #132, silently and only at session spawn.
  assert_grep "$LCHUNK" 'function wrapSpawn\(t\)\{return process\.platform!=="darwin"\?t:\{cmd:rpt\(\)' \
              "disclaimer wrap site left intact (removing it would regress #132)"
  assert_parses "$LCHUNK" "chunk parses after launch.sh patches"
fi

# ---------------------------------------------------------------------------
section "5. PKGBUILD build() patches reach the chunk (AUR path, issue #156)"
# ---------------------------------------------------------------------------
# The AUR PKGBUILD applies the same class of patches as launch.sh, but in its
# own build() function. It regressed once (issue #156): it patched index.js
# only and hardcoded minified identifiers, silently disabling Cowork on
# split-entry builds. Extract its patch_index() helper + invocations verbatim
# and exercise them on a chunk with rotated identifiers so the drift can't recur.
PKGBLOCK="$TMP/pkg_patch_block.sh"
awk '/^    patch_index\(\) \{/{inf=1} inf{print} inf&&/^    \}/{inf=0}' "$REPO_ROOT/PKGBUILD" > "$PKGBLOCK"
grep -A2 '^    patch_index "' "$REPO_ROOT/PKGBUILD" | grep -v '^--$' >> "$PKGBLOCK"
PKCALLS="$(grep -c '^    patch_index ' "$PKGBLOCK" || true)"
if [[ "${PKCALLS:-0}" -lt 1 ]]; then
  fail "extracted patch_index block from PKGBUILD (found $PKCALLS calls)"
else
  pass "extracted patch_index block from PKGBUILD ($PKCALLS calls)"
  PKCHUNK="$TMP/pkg_chunk.js"
  write_patch_fixture "$PKCHUNK"
  ( _index_targets=("$PKCHUNK"); source "$PKGBLOCK" ) >/dev/null 2>&1
  refute_grep "$PKCHUNK" 'titleBarStyle:"hidden"'          "PKGBUILD: main-window titlebar removed (chunk)"
  refute_grep "$PKCHUNK" 'titleBarStyle:"hiddenInset"'     "PKGBUILD: about-window titlebar removed (chunk)"
  assert_grep "$PKCHUNK" 'return Zq\.protocol==="file:"\}' "PKGBUILD: origin isPackaged dropped for file:// (chunk)"
  assert_grep "$PKCHUNK" 'function wrapSpawn\(t\)\{return process\.platform!=="darwin"\?t:\{cmd:rpt\(\)' \
              "PKGBUILD: disclaimer wrap site left intact (chunk)"
  assert_parses "$PKCHUNK" "PKGBUILD: chunk parses after patch_index seds"
fi
# Source-level guards: the recipe must discover chunks and run enable-cowork.py
# across every discovered target, never regress to the index.js-only invocation.
if grep -qF 'chunk-[A-Za-z0-9_-]+' "$REPO_ROOT/PKGBUILD"; then
  pass "PKGBUILD: discovers index[2].chunk-*.js from the shim"
else
  fail "PKGBUILD: chunk discovery missing"
fi
if grep -q 'enable-cowork.py" "$_t"' "$REPO_ROOT/PKGBUILD"; then
  pass "PKGBUILD: runs enable-cowork.py across every discovered target"
else
  fail "PKGBUILD: enable-cowork.py not run per-target (regressed to index.js only?)"
fi

# ---------------------------------------------------------------------------
echo -e "\n${BOLD}Summary:${NC} ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${SKIP} skipped${NC}"
[[ "$FAIL" -eq 0 ]]
