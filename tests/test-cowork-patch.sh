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
#   - patch-index.sh's seds apply across a chunk with rotated identifiers, and
#     both consumers (launch.sh, PKGBUILD) still source that one shared list
#     rather than growing private copies that drift apart (#170).
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

# The exact discovery used by install.sh apply_patches and launch.sh: glob the
# build dir, don't follow the shim's require()s. Chunks require() each other
# transitively, so the shim names only a subset (131 of 333 on 1.26832.0), and
# a second index2.chunk-* series now carries the platform gate. Takes the build
# directory, not the shim, so it mirrors the shipped mechanism.
discover_chunks() { find "$1" -maxdepth 1 -name 'index*.chunk-*.js' -type f -printf '%f\n' 2>/dev/null | sort; }

# Write a chunk exercising every patch site, using identifiers that are NOT the
# values any older hardcoded pattern used (function qZ9/var r; validator $m/arg
# n; objects Zq/Yw/Xp/mB/kk/jn; setUserActivity arg qq).
write_patch_fixture() {
  cat > "$1" <<'EOF'
"use strict";
function qZ9(){const r=process.platform;if(r!=="darwin"&&r!=="win32")return{status:"unsupported",reason:"nope"};return{status:"supported"}}
const gate=qZ9();
function checkOrigin(n){if(!$m(n))throw new Error(`Incoming "doThing" call on interface "MyIface" from '${(i=n.senderFrame)==null?void 0:i.url}' did not pass origin validation`)}
function hostPlat(){if(process.platform==="darwin")return"darwin-x64";throw new Error("Unsupported platform: "+process.platform)}
function extInstall(){return{status:2,error:`Unsupported platform: ${process.platform} not allowed`}}
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

# Same sites as write_patch_fixture, in the shapes 1.26832.0 actually emits.
# This is the regression that motivated #166 and it is invisible to a
# double-quoted fixture: the minifier moved to backtick template literals, so
# every pattern anchored on `"` missed and EVERY patch silently no-opped while
# install.sh still reported success. Without this fixture someone can re-narrow
# ["`] back to " tomorrow and the suite stays green.
#
# Also covers the smaller shape changes that landed with it: `let` instead of
# `const` in the gate, a bare `throw Error(` instead of `throw new Error(`, and
# minified values that gained dots and negations (r.default, !1) where the old
# patterns assumed [A-Za-z0-9_$]+.
write_patch_fixture_backtick() {
  cat > "$1" <<'EOF'
"use strict";
function ke(){let t=process.platform;if(t!==`darwin`&&t!==`win32`)return{status:`unsupported`,reason:`Cowork is not currently supported on ${a.it()}`,unsupportedCode:`unsupported_platform`};return{status:`supported`}}
const gate=ke();
function checkOrigin(n){if(!$m(n))throw Error(`Incoming "choose" call on interface "LocalExecConsent" from '${n.senderFrame?.url}' did not pass origin validation`)}
function hostPlat(e){if(process.platform===`linux`)return e===`arm64`?`linux-arm64`:`linux-x64`;throw Error(`Unsupported platform: ${process.platform}-${e}`)}
function extInstall(){if(process.platform!==`darwin`)return{status:E.i.Error,error:`Unsupported platform: ${process.platform}. Only macOS is supported.`};return{status:0}}
const winOpts={minWidth:600,titleBarStyle:`hidden`,titleBarOverlay:!1,trafficLightPosition:Xe.o,show:t,webPreferences:{}};
const aboutOpts={titleBarStyle:`hiddenInset`,autoHideMenuBar:!0,skipTaskbar:!0};
function guard(){return Zq.protocol===`file:`&&r.default.app.isPackaged===!0}
function buildArgs(){Xp.push(`--effort`,this.options.effort)}
function handoff(){mB.app.invalidateCurrentActivity();mB.app.setUserActivity(qq,{})}
function wrapSpawn(t){return process.platform!==`darwin`?t:{cmd:rpt(),args:[t.cmd,...t.args]}}
const res=T.app.isPackaged?process.resourcesPath:someFallback;
function c(e,t){let n=i.app.isPackaged?r.default.join(process.resourcesPath,`app.asar`):i.app.getAppPath();return r.default.join(n,`.vite`)}
function v(){return o.default.join(process.resourcesPath,`app.asar`,`.vite`,`build`,`shell-path-worker`,`shellPathWorker.js`)}
EOF
}

# ---------------------------------------------------------------------------
section "1. Static analysis"
# ---------------------------------------------------------------------------
if python3 -c "import ast; ast.parse(open('$REPO_ROOT/enable-cowork.py').read())" 2>/dev/null; then
  pass "enable-cowork.py parses"; else fail "enable-cowork.py parses"; fi
for s in launch.sh install.sh patch-index.sh; do
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
assert_grep  "$CHUNK" 'function qZ9\(\)\{return\{status:"supported"\}\}' "platform gate returns supported"
# IPC guard: validator $m and sender arg n both preserved, file:// exempted
assert_grep  "$CHUNK" 'if\(!\$m\(n\)&&!\(n\.senderFrame&&n\.senderFrame\.url&&n\.senderFrame\.url\.startsWith\("file://"\)\)\)' \
             "IPC guard exempts file:// (rotated validator \$m + arg n)"
assert_grep  "$CHUNK" 'return"darwin-x64"'             "getHostPlatform throw -> darwin-x64"
refute_grep  "$CHUNK" 'error:`Unsupported platform'    "return-style platform gate neutralized"
assert_parses "$CHUNK" "chunk parses after enable-cowork.py"

# Exit-code contract that install.sh apply_patches relies on to log success
# accurately: a file with the gate (or already patched) exits 0; a shim with no
# gate exits non-zero. apply_patches only reports success if >=1 target exits 0.
if python3 "$REPO_ROOT/enable-cowork.py" "$CHUNK" >/dev/null 2>&1; then
  pass "re-running on an already-patched gate file exits 0 (idempotent)"
else
  fail "re-running on an already-patched gate file should exit 0"
fi
SHIM="$TMP/shim_index.js"
printf '"use strict";\nrequire("./index.chunk-V9ybBkRT.js");\n' > "$SHIM"
if python3 "$REPO_ROOT/enable-cowork.py" "$SHIM" >/dev/null 2>&1; then
  fail "shim with no platform gate should exit non-zero"
else
  pass "shim with no platform gate exits non-zero (apply_patches won't false-succeed)"
fi

# ---------------------------------------------------------------------------
section "3. build-dir chunk discovery (install.sh / launch.sh)"
# ---------------------------------------------------------------------------
mkdir -p "$TMP/build"
printf '"use strict";\nrequire("./index.chunk-V9ybBkRT.js");\n' > "$TMP/build/index.js"
: > "$TMP/build/index.chunk-V9ybBkRT.js"
# Named by the shim -> must be found.
found="$(discover_chunks "$TMP/build")"
[[ "$found" == *"index.chunk-V9ybBkRT.js"* ]] && pass "split-entry: shim-named chunk discovered" \
  || fail "split-entry: shim-named chunk discovered (got: '$found')"
# The index2 series carries the platform gate on 1.26832.0.
: > "$TMP/build/index2.chunk-CQIegP9t.js"
found="$(discover_chunks "$TMP/build")"
[[ "$found" == *"index2.chunk-CQIegP9t.js"* ]] && pass "index2 series discovered (gate lives here on 1.26832.0)" \
  || fail "index2 series discovered (got: '$found')"
# Required transitively by another chunk, never named by the shim: this is the
# case that made the --effort patch silently no-op before the glob switch.
: > "$TMP/build/index2.chunk-Cqfh0Vpp.js"
found="$(discover_chunks "$TMP/build")"
[[ "$found" == *"index2.chunk-Cqfh0Vpp.js"* ]] && pass "transitively-required chunk discovered (not named by shim)" \
  || fail "transitively-required chunk discovered (got: '$found')"
# Non-chunk files in the same dir must not be picked up.
: > "$TMP/build/mainWindow.js"
[[ "$(discover_chunks "$TMP/build")" != *"mainWindow.js"* ]] && pass "non-chunk files ignored" \
  || fail "non-chunk files ignored"
# Single-entry build (no chunks) -> discovery finds nothing (clean no-op)
mkdir -p "$TMP/build_single"
printf '"use strict";var x=1;\n' > "$TMP/build_single/index.js"
[[ -z "$(discover_chunks "$TMP/build_single")" ]] && pass "single-entry: no chunk discovered (backward compatible)" \
  || fail "single-entry: no chunk discovered"

# ---------------------------------------------------------------------------
section "4. shared patch-index.sh passes on a chunk with rotated identifiers"
# ---------------------------------------------------------------------------
# launch.sh and PKGBUILD both source patch-index.sh, so there is one pass list
# to exercise rather than two near-copies. Source the shipped file directly --
# no awk extraction, so the test cannot drift from the code the way the two
# hand-maintained blocks drifted from each other (#170).
#
# Drive it through patch_index_apply_all against a real build directory so the
# chunk discovery and the node --check verification are exercised too, not just
# the seds.
SHARED="$REPO_ROOT/patch-index.sh"
if [[ ! -f "$SHARED" ]]; then
  fail "patch-index.sh exists at repo root"
else
  pass "patch-index.sh exists at repo root"
  NPASSES="$(grep -c '^  patch_index "' "$SHARED" || true)"
  if [[ "${NPASSES:-0}" -lt 9 ]]; then
    fail "patch-index.sh defines all 9 passes (found $NPASSES)"
  else
    pass "patch-index.sh defines all 9 passes ($NPASSES)"
  fi

  LBUILD="$TMP/shared_build"
  mkdir -p "$LBUILD"
  LCHUNK="$LBUILD/index.js"
  write_patch_fixture "$LCHUNK"
  ( source "$SHARED"; patch_index_apply_all "$LBUILD" ) >/dev/null 2>&1
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
  assert_parses "$LCHUNK" "chunk parses after the shared passes"

  # Discovery must reach index*.chunk-*.js siblings, not just index.js.
  DBUILD="$TMP/discovery_build"
  mkdir -p "$DBUILD"
  echo '"use strict";' > "$DBUILD/index.js"
  write_patch_fixture "$DBUILD/index2.chunk-Cqfh0Vpp.js"
  ( source "$SHARED"; patch_index_apply_all "$DBUILD" ) >/dev/null 2>&1
  assert_grep "$DBUILD/index2.chunk-Cqfh0Vpp.js" 'this\.options\.effort==="xhigh"\?"max"' \
              "passes reach a chunk the shim never require()s"

  # Idempotency: a second run must not corrupt an already-patched tree.
  BEFORE="$(cat "$LCHUNK")"
  ( source "$SHARED"; patch_index_apply_all "$LBUILD" ) >/dev/null 2>&1
  if [[ "$BEFORE" == "$(cat "$LCHUNK")" ]]; then
    pass "re-running the passes on a patched tree is a no-op"
  else
    fail "re-running the passes on a patched tree changed it again"
  fi

  # mainView.js: on a miss the pass must leave the file completely alone. sed -i
  # rewrites regardless of whether the pattern matched, and a miss also leaves
  # the marker absent — so the old shape re-ran every launch, bumped mtime every
  # launch, and made launch.sh's "anything newer than the cached asar?" check
  # true forever, repacking the whole asar on every start. Pin mtime, not just
  # content: content was already unchanged, which is why this went unnoticed.
  MVBUILD="$TMP/mainview_build"
  mkdir -p "$MVBUILD"
  echo '"use strict";' > "$MVBUILD/index.js"
  # identifier is `q`, not `e`, so the substitution cannot match
  printf 'function h(q){return q.hostname===`localhost`}\n' > "$MVBUILD/mainView.js"
  touch -d '2020-01-01 00:00:00' "$MVBUILD/mainView.js"
  MV_BEFORE="$(stat -c %Y "$MVBUILD/mainView.js")"
  ( source "$SHARED"; patch_index_apply_all "$MVBUILD" ) >/dev/null 2>&1
  if [[ "$MV_BEFORE" == "$(stat -c %Y "$MVBUILD/mainView.js")" ]]; then
    pass "mainView.js untouched when the substitution target is absent"
  else
    fail "mainView.js rewritten on a miss (bumps mtime, forces a repack every launch)"
  fi
  # And it must still patch when the target IS present, and be idempotent after.
  printf 'function h(e){return e.hostname===`localhost`}\n' > "$MVBUILD/mainView.js"
  ( source "$SHARED"; patch_index_apply_all "$MVBUILD" ) >/dev/null 2>&1
  assert_grep "$MVBUILD/mainView.js" 'e\.protocol==="file:"' "mainView.js patched when the target is present"
  MV_PATCHED="$(stat -c %Y "$MVBUILD/mainView.js")"
  ( source "$SHARED"; patch_index_apply_all "$MVBUILD" ) >/dev/null 2>&1
  if [[ "$MV_PATCHED" == "$(stat -c %Y "$MVBUILD/mainView.js")" ]]; then
    pass "mainView.js untouched on a second run (marker holds)"
  else
    fail "mainView.js rewritten on a second run"
  fi

  # PKGBUILD builds with PATCH_INDEX_STRICT_SYNTAX=1 so a chunk that no longer
  # parses fails the build instead of shipping a blank-window package; launch.sh
  # leaves it unset so a bad chunk only warns rather than blocking a launch.
  if [[ "$HAVE_NODE" -eq 0 ]]; then
    skip "syntax gate strict/warn split (node not installed)"
  else
    BADBUILD="$TMP/bad_build"
    mkdir -p "$BADBUILD"
    printf 'function f({ // unbalanced\n' > "$BADBUILD/index.js"
    if ( source "$SHARED"; PATCH_INDEX_STRICT_SYNTAX=1; \
         patch_index_apply_all "$BADBUILD" ) >/dev/null 2>&1; then
      fail "strict syntax gate fails the build on an unparseable chunk"
    else
      pass "strict syntax gate fails the build on an unparseable chunk"
    fi
    if ( source "$SHARED"; patch_index_apply_all "$BADBUILD" ) >/dev/null 2>&1; then
      pass "default syntax check warns without failing"
    else
      fail "default syntax check warns without failing"
    fi
  fi

  # patch_index must return 0 when nothing matched. PKGBUILD's build() runs
  # under makepkg's `set -e`, so a non-zero return from a legitimately-missing
  # pass would abort the package build.
  if ( set -e; source "$SHARED"; INDEX_TARGETS=(); \
       PATCH_INDEX_WARN_ON_MISS=0 patch_index "x" 'nomatch' 's/a/b/' ) >/dev/null 2>&1; then
    pass "patch_index returns 0 on no match (safe under PKGBUILD's set -e)"
  else
    fail "patch_index returns non-zero on no match (would abort makepkg build)"
  fi
fi

# ---------------------------------------------------------------------------
section "5. both consumers use the shared list (drift guard, issue #170)"
# ---------------------------------------------------------------------------
# launch.sh grew to 9 passes while PKGBUILD's build() stayed at 3, and because
# /usr/bin/claude-cowork execs electron directly against the packaged asar and
# never runs launch.sh, AUR users silently lost six of them. The fix is one
# shared list; these assertions are what keep it one.
for _consumer in launch.sh PKGBUILD; do
  if grep -qE 'source .*patch-index\.sh' "$REPO_ROOT/$_consumer"; then
    pass "$_consumer sources patch-index.sh"
  else
    fail "$_consumer sources patch-index.sh"
  fi
  if grep -qE '(^|[^_])patch_index_apply_all ' "$REPO_ROOT/$_consumer"; then
    pass "$_consumer calls patch_index_apply_all"
  else
    fail "$_consumer calls patch_index_apply_all"
  fi
  # A local redefinition is exactly how the two lists drifted apart before.
  if grep -qE '^\s*patch_index\(\) \{' "$REPO_ROOT/$_consumer"; then
    fail "$_consumer defines its own patch_index() (drift risk)"
  else
    pass "$_consumer does not redefine patch_index()"
  fi
  if grep -qE '^\s*patch_index "' "$REPO_ROOT/$_consumer"; then
    fail "$_consumer still carries inline patch_index calls (drift risk)"
  else
    pass "$_consumer carries no inline patch_index calls"
  fi
done

# launch.sh refuses to start without it, so install.sh must ship it alongside.
if grep -q 'patch-index.sh' "$REPO_ROOT/install.sh"; then
  pass "install.sh copies patch-index.sh into the install dir"
else
  fail "install.sh does not copy patch-index.sh (installed launcher would abort)"
fi

# Source-level guards: chunk discovery now lives in the shared script, and the
# recipe must still run enable-cowork.py across every discovered target.
if grep -qF "name 'index*.chunk-*.js'" "$REPO_ROOT/patch-index.sh"; then
  pass "shared script discovers index*.chunk-*.js chunks"
else
  fail "shared script: chunk discovery missing"
fi
if grep -q 'enable-cowork.py" "$_t"' "$REPO_ROOT/PKGBUILD"; then
  pass "PKGBUILD: runs enable-cowork.py across every discovered target"
else
  fail "PKGBUILD: enable-cowork.py not run per-target (regressed to index.js only?)"
fi
# ---------------------------------------------------------------------------
section "6. backtick-literal bundle (asar 1.26832.0 shapes, issue #166)"
# ---------------------------------------------------------------------------
# Everything above uses a double-quoted fixture. 1.26832.0 emits backtick
# template literals instead, which made every pattern miss and every patch
# no-op silently. Re-run both toolchains against a fixture in those shapes so
# a future re-narrowing of ["`] back to " fails here instead of shipping.
BTCHUNK="$TMP/backtick_chunk.js"
write_patch_fixture_backtick "$BTCHUNK"

# enable-cowork.py: the platform gate must be found despite `let` + backticks.
if python3 "$REPO_ROOT/enable-cowork.py" "$BTCHUNK" >/dev/null 2>&1; then
  pass "backtick: enable-cowork.py finds the platform gate (exit 0)"
else
  fail "backtick: enable-cowork.py finds the platform gate (exit 0)"
fi
assert_grep "$BTCHUNK" 'function ke\(\)\{return\{status:"supported"\}\}' "backtick: gate returns supported"
# Bare `throw Error(` — the old pattern required `new`.
refute_grep "$BTCHUNK" 'throw Error\(`Unsupported platform'          "backtick: getHostPlatform throw rewritten"
assert_grep "$BTCHUNK" 'did not pass origin validation'              "backtick: IPC guard site still present"
assert_grep "$BTCHUNK" 'startsWith\("file://"\)'                    "backtick: IPC origin guard exempts file://"
refute_grep "$BTCHUNK" 'error:`Unsupported platform'                 "backtick: return-style platform gate neutralized"
assert_parses "$BTCHUNK" "backtick: chunk parses after enable-cowork.py"

# The fixture above is found via the exact `ke()` entry in KNOWN_PATTERNS, so it
# does NOT exercise PLATFORM_GATE_RE. Minified names rotate every build, so the
# regex fallback is what actually carries the next one — give it a gate name
# that is in no known-pattern list, still backtick/`let` shaped.
BTGATE="$TMP/backtick_unknown_gate.js"
cat > "$BTGATE" <<'EOF'
"use strict";
function zQ7x(){let q=process.platform;if(q!==`darwin`&&q!==`win32`)return{status:`unsupported`,reason:`nope`};return{status:`supported`}}
EOF
if python3 "$REPO_ROOT/enable-cowork.py" "$BTGATE" >/dev/null 2>&1; then
  pass "backtick: regex fallback finds an unknown-named gate"
else
  fail "backtick: regex fallback finds an unknown-named gate"
fi
assert_grep "$BTGATE" 'function zQ7x\(\)\{return\{status:"supported"\}\}' "backtick: unknown-named gate rewritten"
assert_parses "$BTGATE" "backtick: unknown-named gate parses after patching"

# getHostPlatform throw whose message contains a call. HOST_PLATFORM_THROW_RE
# used [^)]*, which stops at the FIRST ')', so the match ended inside the call
# and the substitution left its closing paren behind as `return"darwin-x64")`.
# enable-cowork.py reported SUCCESS and exited 0 on a file it had just made
# unparseable. Every fixture above happens to use a paren-free message, which is
# why nothing caught it.
PARENGATE="$TMP/host_platform_paren.js"
cat > "$PARENGATE" <<'EOF'
"use strict";
function ke(){let t=process.platform;if(t!==`darwin`&&t!==`win32`)return{status:`unsupported`,reason:`nope`};return{status:`supported`}}
function hostPlat(){if(process.platform==="darwin")return"darwin-x64";throw new Error("Unsupported platform: "+getPlatformName())}
EOF
python3 "$REPO_ROOT/enable-cowork.py" "$PARENGATE" >/dev/null 2>&1
refute_grep "$PARENGATE" 'throw new Error\("Unsupported platform'  "paren: getHostPlatform throw rewritten"
refute_grep "$PARENGATE" 'return"darwin-x64"\)'                    "paren: no dangling paren left behind"
assert_parses "$PARENGATE" "paren: chunk still parses after patching"

# Nesting deeper than the pattern handles must fail CLOSED — leave the throw
# alone — rather than emit invalid JS.
DEEPGATE="$TMP/host_platform_deep.js"
cat > "$DEEPGATE" <<'EOF'
"use strict";
function ke(){let t=process.platform;if(t!==`darwin`&&t!==`win32`)return{status:`unsupported`,reason:`nope`};return{status:`supported`}}
function hostPlat(){throw new Error("Unsupported platform: "+fmt(name(x)))}
EOF
python3 "$REPO_ROOT/enable-cowork.py" "$DEEPGATE" >/dev/null 2>&1
assert_parses "$DEEPGATE" "deep nesting: fails closed, chunk still parses"

# The corruption guard must actually fire, on stderr, without changing the
# exit code — both callers read non-zero as "no platform gate here", so failing
# that way would hide the corruption instead of surfacing it.
BADJS="$TMP/unparseable.js"
cat > "$BADJS" <<'EOF'
"use strict";
function ke(){let t=process.platform;if(t!==`darwin`&&t!==`win32`)return{status:`unsupported`,reason:`nope`};return{status:`supported`}}
function oops(){ return 1)  }
EOF
BADERR="$(python3 "$REPO_ROOT/enable-cowork.py" "$BADJS" 2>&1 >/dev/null)"
BADRC=$?
if [[ "$HAVE_NODE" -eq 0 ]]; then
  skip "corruption guard warns on stderr (node not installed)"
elif [[ "$BADERR" == *"not valid JavaScript after patching"* ]]; then
  pass "corruption guard warns on stderr"
else
  fail "corruption guard silent on an unparseable file"
fi
if [[ "$BADRC" -eq 0 ]]; then
  pass "corruption guard leaves the exit-code contract alone"
else
  fail "corruption guard changed the exit code (callers read non-zero as 'no gate here')"
fi

# The shared patch passes against the same shapes.
if [[ -f "$SHARED" ]]; then
  BTBUILD="$TMP/backtick_build"
  mkdir -p "$BTBUILD"
  BTL="$BTBUILD/index.js"
  write_patch_fixture_backtick "$BTL"
  ( source "$SHARED"; patch_index_apply_all "$BTBUILD" ) >/dev/null 2>&1
  refute_grep "$BTL" 'titleBarStyle:`hidden`'          "backtick: main-window titlebar removed (!1 / dotted value)"
  refute_grep "$BTL" 'titleBarStyle:`hiddenInset`'     "backtick: about-window titlebar removed"
  assert_grep "$BTL" 'return Zq\.protocol==="file:"\}' "backtick: origin isPackaged dropped (r.default arg)"
  assert_grep "$BTL" 'this\.options\.effort==="xhigh"\?"max"' "backtick: --effort xhigh -> max"
  refute_grep "$BTL" 'T\.app\.isPackaged?process\.resourcesPath:'    "backtick: resourcesPath fallback forced"
  assert_grep "$BTL" 'i\.app\.isPackaged\?r\.default\.join\(i\.app\.getAppPath\(\)' "backtick: guarded MCP join uses getAppPath()"
  # Unguarded join (@shawnyeager, #167): no isPackaged, so the guarded pass
  # can't reach it and shellPathWorker.js resolves through the overridden
  # resourcesPath. The catch-all pass must run after the guarded one.
  refute_grep "$BTL" 'process\.resourcesPath,`app\.asar`' "backtick: unguarded shellPathWorker join rewritten"
  assert_grep "$BTL" 'shell-path-worker'                  "backtick: shellPathWorker site still resolves a path"
  assert_grep "$BTL" 'function wrapSpawn\(t\)\{return process\.platform!==`darwin`\?t:\{cmd:rpt\(\)' \
              "backtick: disclaimer wrap site left intact (#132)"
  assert_parses "$BTL" "backtick: chunk parses after the shared passes"
fi

# ---------------------------------------------------------------------------
echo -e "\n${BOLD}Summary:${NC} ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${SKIP} skipped${NC}"
[[ "$FAIL" -eq 0 ]]
