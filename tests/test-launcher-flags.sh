#!/bin/bash
#
# The generated ~/.local/bin/claude-desktop launcher: what each flag hands to
# launch.sh.
#
# `--debug` used to export CLAUDE_TRACE=1 -- a variable nothing in the tree
# reads -- and then start the app detached like a plain launch, so the flag
# install.sh advertised as "Enable trace logging" did nothing. `--devtools`
# ran detached as well, although the docs called it a foreground mode.
#
# This generates the real launcher with create_launcher() from a sourced
# install.sh, points it at an install dir whose launch.sh only records its
# argv and environment, and runs each flag. Hermetic: temp HOME, no electron,
# no network.
#
#   ./tests/test-launcher-flags.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0
pass()    { echo -e "  ${GREEN}PASS${NC} $*"; PASS=$((PASS + 1)); }
fail()    { echo -e "  ${RED}FAIL${NC} $*"; FAIL=$((FAIL + 1)); }
section() { echo -e "\n${BOLD}=== $* ===${NC}"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
export XDG_STATE_HOME="$TMP/state"
unset CLAUDE_LOG_DIR CLAUDE_COWORK_VERBOSE CLAUDE_COWORK_TRACE_IO CLAUDE_DEVTOOLS
mkdir -p "$HOME"
export CLAUDE_INSTALL_DIR="$TMP/install"
mkdir -p "$CLAUDE_INSTALL_DIR"

# A launch.sh that records how it was called, then exits.
cat > "$CLAUDE_INSTALL_DIR/launch.sh" <<'EOF'
#!/bin/bash
{
  printf 'ARGS=%s\n' "$*"
  printf 'VERBOSE=%s\n' "${CLAUDE_COWORK_VERBOSE:-}"
  printf 'TRACE_IO=%s\n' "${CLAUDE_COWORK_TRACE_IO:-}"
  printf 'DEVTOOLS=%s\n' "${CLAUDE_DEVTOOLS:-}"
} > "$RECORD"
EOF
chmod +x "$CLAUDE_INSTALL_DIR/launch.sh"

section "Generate the launcher from install.sh"
# shellcheck source=../install.sh
source "$REPO_ROOT/install.sh"
set +e
trap 'cleanup; rm -rf "$TMP"' EXIT
( create_launcher ) >/dev/null 2>&1
LAUNCHER="$HOME/.local/bin/claude-desktop"
if [[ -x "$LAUNCHER" ]]; then pass "create_launcher wrote an executable launcher"; else fail "no launcher at $LAUNCHER"; fi
if bash -n "$LAUNCHER" 2>/dev/null; then pass "launcher parses"; else fail "launcher has a syntax error"; fi

# run_flag <flag...>: run the launcher, wait for the recorder, print its record.
run_flag() {
    export RECORD="$TMP/record.$RANDOM"
    rm -f "$RECORD"
    "$LAUNCHER" "$@" >/dev/null 2>"$TMP/stderr" </dev/null
    # Detached launches return before launch.sh runs; give them a moment.
    for _ in $(seq 1 50); do [[ -f "$RECORD" ]] && break; sleep 0.1; done
    cat "$RECORD" 2>/dev/null
}

section "--debug turns on real logging and stays in the foreground"
rec="$(run_flag --debug)"
grep -qx 'ARGS=--dev' <<<"$rec" && pass "--debug runs launch.sh --dev (foreground)" || fail "--debug ran launch.sh with: $(grep ARGS <<<"$rec")"
grep -qx 'VERBOSE=1' <<<"$rec" && pass "--debug sets CLAUDE_COWORK_VERBOSE=1" || fail "--debug did not set CLAUDE_COWORK_VERBOSE"
grep -qx 'TRACE_IO=1' <<<"$rec" && pass "--debug sets CLAUDE_COWORK_TRACE_IO=1" || fail "--debug did not set CLAUDE_COWORK_TRACE_IO"
grep -q 'treat it as sensitive' "$TMP/stderr" && pass "--debug says the trace log is sensitive" || fail "--debug printed no sensitivity notice"
if grep -q 'CLAUDE_TRACE=' "$LAUNCHER"; then fail "launcher still sets CLAUDE_TRACE, which nothing reads"; else pass "launcher no longer sets the unread CLAUDE_TRACE"; fi

section "Foreground debug flags pass straight through"
for flag in --devtools --inspect --perf --dev; do
    rec="$(run_flag "$flag" --extra)"
    grep -qx "ARGS=$flag --extra" <<<"$rec" && pass "$flag reaches launch.sh unchanged" || fail "$flag reached launch.sh as: $(grep ARGS <<<"$rec")"
done

section "A plain launch adds nothing"
rec="$(run_flag --some-electron-flag)"
grep -qx 'ARGS=--some-electron-flag' <<<"$rec" && pass "plain launch passes args through" || fail "plain launch passed: $(grep ARGS <<<"$rec")"
grep -qx 'VERBOSE=' <<<"$rec" && grep -qx 'TRACE_IO=' <<<"$rec" && pass "plain launch turns on no tracing" || fail "plain launch turned tracing on"

section "--update regenerates the launcher"
_upd="$(awk '/--update flow/,/Update complete/' "$REPO_ROOT/install.sh")"
grep -q 'create_launcher' <<<"$_upd" && pass "--update calls create_launcher" || fail "--update leaves an old launcher in place"

echo -e "\n${BOLD}Summary:${NC} ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
[[ "$FAIL" -eq 0 ]]
