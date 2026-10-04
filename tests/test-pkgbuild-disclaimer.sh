#!/bin/bash
#
# PKGBUILD helper harness: the Helpers/disclaimer script and the icon step.
#
# What this file exists to keep true:
#
# 1. The AUR package's root-owned Helpers/disclaimer is fail-closed. Only a
#    call the in-process interception missed or REFUSED ever reaches it, so it
#    must not run what the exec-capability registry just blocked. It used to
#    `exec "$CMD" "$@"` for any command -- and took $1 as the command, so the
#    2.7032.0 shape `--pgroup -- <cli> ...` ran `exec --pgroup` (#195).
# 2. It still runs the Claude CLI for every argv shape the bundle uses, from
#    a fixed candidate list, never from the path the caller handed over.
# 3. package() installs the icon its desktop entry names (#195).
#
# Hermetic: the script is extracted from PKGBUILD itself and run with a temp
# HOME; no makepkg, no network.

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
trap 'rm -rf "$TMP"' EXIT

DISCLAIMER="$TMP/disclaimer"
awk '
  /Helpers\/disclaimer" <<'"'"'EOF'"'"'$/ { grab = 1; next }
  grab && /^EOF$/ { exit }
  grab { print }
' "$REPO_ROOT/PKGBUILD" > "$DISCLAIMER"
chmod +x "$DISCLAIMER"

section "Extraction"
if head -1 "$DISCLAIMER" | grep -q '^#!/bin/sh'; then
    pass "disclaimer script extracted from PKGBUILD"
else
    fail "could not extract the disclaimer heredoc from PKGBUILD"
    echo -e "\n${BOLD}${PASS} passed, ${FAIL} failed, ${SKIP} skipped${NC}"
    exit 1
fi
if command -v sh >/dev/null && sh -n "$DISCLAIMER"; then
    pass "script parses under sh -n"
else
    fail "script does not parse under sh -n"
fi

# A fake home whose ~/.local/bin/claude echoes its argv, one per line.
H="$TMP/home"
mkdir -p "$H/.local/bin"
cat > "$H/.local/bin/claude" <<'SH'
#!/bin/sh
echo "CLI-RAN"
for a in "$@"; do printf '[%s]\n' "$a"; done
SH
chmod +x "$H/.local/bin/claude"

# A Linux-runnable "claude" at a caller-chosen path. It must never be the one
# that runs: the caller names a CLI, the script picks which binary that is.
mkdir -p "$TMP/evil"
cat > "$TMP/evil/claude" <<'SH'
#!/bin/sh
echo "CALLER-PATH-RAN"
SH
chmod +x "$TMP/evil/claude"

MAC_CLI='/home/u/.config/Claude/claude-code/2.1.280/claude.app/Contents/MacOS/claude'

run() { HOME="$H" "$DISCLAIMER" "$@" 2>"$TMP/err"; }

section "The Claude CLI runs for every shape, args intact"
out="$(run --pgroup -- "$MAC_CLI" --output-format stream-json)"; rc=$?
[[ $rc -eq 0 && "$out" == $'CLI-RAN\n[--output-format]\n[stream-json]' ]] \
    && pass "--pgroup -- <cli> args (2.7032.0 shape)" \
    || fail "--pgroup shape: rc=$rc out=$out err=$(cat "$TMP/err")"

out="$(run --pgroup --mode=a/b:c -q -- "$MAC_CLI" -p)"; rc=$?
[[ $rc -eq 0 && "$out" == $'CLI-RAN\n[-p]' ]] \
    && pass "flags with =values (any characters after =), as isWrapperFlag allows" \
    || fail "flag=value shape: rc=$rc out=$out"

out="$(run -- "$MAC_CLI" -p hi)"; rc=$?
[[ $rc -eq 0 && "$out" == $'CLI-RAN\n[-p]\n[hi]' ]] \
    && pass "-- <cli> args (1.40609.0 shape)" \
    || fail "-- shape: rc=$rc out=$out"

out="$(run "$MAC_CLI" -p -- literal)"; rc=$?
[[ $rc -eq 0 && "$out" == $'CLI-RAN\n[-p]\n[--]\n[literal]' ]] \
    && pass "<cli> args with the command's own -- left alone (old shape)" \
    || fail "old shape: rc=$rc out=$out"

out="$(run --pgroup -- '/Applications/Claude.app/Contents/MacOS/Claude' 'arg with space')"; rc=$?
[[ $rc -eq 0 && "$out" == $'CLI-RAN\n[arg with space]' ]] \
    && pass "capitalised Claude.app/.../Claude, argument with a space" \
    || fail "capitalised path: rc=$rc out=$out"

out="$(run "$TMP/evil/claude")"; rc=$?
[[ "$out" != *CALLER-PATH-RAN* && "$out" == CLI-RAN* ]] \
    && pass "a runnable caller-supplied claude path is replaced, never executed" \
    || fail "caller path executed: out=$out"

section "Anything else is refused (fail closed)"
for argv in \
    "--pgroup -- /bin/echo PWNED" \
    "-- /bin/echo PWNED" \
    "/bin/echo PWNED" \
    "/bin/sh -c echo_PWNED" \
    "--pgroup $MAC_CLI" \
    "--cwd /tmp -- /bin/echo PWNED" \
    "--cwd /tmp -- $MAC_CLI" \
    "--bad/value -- $MAC_CLI" \
    "---x -- $MAC_CLI" \
    "- -- $MAC_CLI" \
    "-9 -- $MAC_CLI" \
    "--a.b -- $MAC_CLI" \
    "--" \
    "--pgroup --"; do
    # shellcheck disable=SC2086
    out="$(run $argv)"; rc=$?
    [[ $rc -eq 127 && "$out" != *PWNED* && "$out" != *CLI-RAN* ]] \
        && pass "refused: $argv" \
        || fail "not refused: $argv (rc=$rc out=$out)"
done
out="$(run)"; rc=$?
[[ $rc -eq 127 ]] && pass "refused: no arguments" || fail "no arguments: rc=$rc"
HOME="$H" "$DISCLAIMER" /bin/true >/dev/null 2>"$TMP/err"
if grep -q 'not admitted by the exec-capability registry' "$TMP/err"; then
    pass "refusal says why on stderr"
else
    fail "refusal gives no reason"
fi

section "A Mach-O CLI is never exec'd"
if [[ -e /usr/local/bin/claude || -e /usr/bin/claude ]]; then
    skip "a system claude exists here; cannot isolate the fallback list"
else
    H2="$TMP/home-macho"
    mkdir -p "$H2/.local/bin"
    printf '\xcf\xfa\xed\xfe\x07\x00\x00\x01' > "$H2/.local/bin/claude"
    chmod +x "$H2/.local/bin/claude"
    out="$(HOME="$H2" "$DISCLAIMER" -- "$MAC_CLI" 2>"$TMP/err")"; rc=$?
    [[ $rc -eq 127 ]] && grep -q 'no Linux Claude Code CLI' "$TMP/err" \
        && pass "executable Mach-O candidate skipped; exits 127 with a reason" \
        || fail "Mach-O handling: rc=$rc err=$(cat "$TMP/err")"
fi

section "Icon: package() installs what the desktop entry names"
grep -q '^Icon=claude-cowork$' "$REPO_ROOT/PKGBUILD" \
    && pass "desktop entry names Icon=claude-cowork" \
    || fail "desktop entry no longer names Icon=claude-cowork"
grep -q 'extract-icns.py" *\\$' "$REPO_ROOT/PKGBUILD" \
    && grep -q '"\$_icns" "${pkgdir}/usr/share/icons/hicolor" claude-cowork' "$REPO_ROOT/PKGBUILD" \
    && pass "package() runs extract-icns.py into hicolor as claude-cowork" \
    || fail "package() does not install a claude-cowork icon"

# Drive the extractor with a synthetic .icns: two PNG members, one non-PNG.
python3 - "$TMP/test.icns" <<'PY'
import struct, sys
png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 16
def chunk(t, payload): return t + struct.pack('>I', 8 + len(payload)) + payload
body = chunk(b'ic07', png) + chunk(b'ic10', png) + chunk(b'is32', b'\x01\x02\x03')
open(sys.argv[1], 'wb').write(b'icns' + struct.pack('>I', 8 + len(body)) + body)
PY
if python3 "$REPO_ROOT/nix/extract-icns.py" "$TMP/test.icns" "$TMP/hicolor" claude-cowork >/dev/null \
    && [[ -f "$TMP/hicolor/128x128/apps/claude-cowork.png" && -f "$TMP/hicolor/1024x1024/apps/claude-cowork.png" ]]; then
    pass "extractor writes <size>/apps/claude-cowork.png for each PNG member"
else
    fail "extractor did not write claude-cowork.png"
fi
python3 "$REPO_ROOT/nix/extract-icns.py" "$TMP/test.icns" "$TMP/hicolor2" >/dev/null \
    && [[ -f "$TMP/hicolor2/128x128/apps/claude.png" ]] \
    && pass "default name stays claude.png (Nix package)" \
    || fail "default icon name changed"
if python3 "$REPO_ROOT/nix/extract-icns.py" "$TMP/test.icns" "$TMP/hicolor3" ../escape >/dev/null 2>&1; then
    fail "an icon name with a path separator was accepted"
else
    pass "an icon name with a path separator is rejected"
fi

echo ""
echo -e "${BOLD}${PASS} passed, ${FAIL} failed, ${SKIP} skipped${NC}"
[[ $FAIL -eq 0 ]]
