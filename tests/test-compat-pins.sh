#!/bin/bash
#
# Tests for the COMPAT.md pinning-table lookup used by install.sh.
#
# install.sh's "install the tested version" path (answer `t` at the download
# prompt) prints the Anthropic CDN URL and SHA-256 recorded for
# LAST_TESTED_ASAR_VERSION. Those live in the "Pinning a tested version" table
# in COMPAT.md, and the URL embeds a per-release hash, so it cannot be
# reconstructed if the row is missing -- a version recorded as tested with no
# pinning row leaves the user with nothing to download (issue #165).
#
# These tests pin both halves of that contract:
#   - compat_read_pin() parses the table (and correctly refuses `<pending>`);
#   - COMPAT.md actually carries a row for LAST_TESTED_ASAR_VERSION.
#
# The function is extracted verbatim from install.sh rather than copied, so the
# test tracks the shipped code. No network needed.
#
#   ./tests/test-compat-pins.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0
pass() { echo -e "  ${GREEN}PASS${NC} $*"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $*"; FAIL=$((FAIL + 1)); }
section() { echo -e "\n${BOLD}=== $* ===${NC}"; }

# assert_eq <got> <want> <label>
assert_eq() {
  if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi
}

# ---------------------------------------------------------------------------
section "1. Extract compat_read_pin() from install.sh"
# ---------------------------------------------------------------------------
HELPERS="$TMP/helpers.sh"
awk '/^compat_read_pin\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' \
  "$REPO_ROOT/install.sh" > "$HELPERS"
if grep -q '^compat_read_pin() {' "$HELPERS" && grep -q '^}$' "$HELPERS"; then
  pass "extracted compat_read_pin() from install.sh"
else
  fail "compat_read_pin() not found in install.sh"
  echo -e "\n${BOLD}Summary:${NC} ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
  exit 1
fi
# shellcheck source=/dev/null
source "$HELPERS"

# ---------------------------------------------------------------------------
section "2. Table parsing"
# ---------------------------------------------------------------------------
FIXTURE="$TMP/COMPAT.md"
cat > "$FIXTURE" <<'EOF'
# Compatibility

<!-- LAST_TESTED_ASAR_VERSION=1.19367.0 -->

| Asar      | Status | Date       | Notes |
|:----------|:-------|:-----------|:------|
| 1.6259.1  | [OK]   | 2026-05-14 | baseline |

| Asar      | CDN URL (Anthropic) | SHA-256 |
|:----------|:--------------------|:--------|
| 1.6259.1  | `https://downloads.claude.ai/releases/darwin/universal/1.6259.1/Claude-abc.dmg` | `98c9de8d` |
| 1.19367.0 | `https://downloads.claude.ai/releases/darwin/universal/1.19367.0/Claude-def.dmg` | `<pending>` |
EOF

got="$(compat_read_pin 1.6259.1 url "$FIXTURE")"
assert_eq "$got" \
  "https://downloads.claude.ai/releases/darwin/universal/1.6259.1/Claude-abc.dmg" \
  "url looked up by version"

got="$(compat_read_pin 1.6259.1 sha256 "$FIXTURE")"
assert_eq "$got" "98c9de8d" "sha256 looked up by version"

# A `<pending>` checksum must read as absent, not be echoed at the user as if
# it were a real hash to compare against.
if compat_read_pin 1.19367.0 sha256 "$FIXTURE" >/dev/null 2>&1; then
  fail "<pending> sha256 must not be returned"
else
  pass "<pending> sha256 reported as missing"
fi

# ...but the URL on that same row is real and must still resolve.
got="$(compat_read_pin 1.19367.0 url "$FIXTURE")"
assert_eq "$got" \
  "https://downloads.claude.ai/releases/darwin/universal/1.19367.0/Claude-def.dmg" \
  "url still returned when its row's sha256 is <pending>"

# A misspelled field must fail loudly rather than fall through to the URL
# column: silently answering a different question than the caller asked is the
# failure mode this helper exists to prevent.
if got="$(compat_read_pin 1.6259.1 sha "$FIXTURE" 2>/dev/null)"; then
  fail "unknown field must return non-zero"
else
  assert_eq "$got" "" "unknown field prints nothing on stdout"
fi

# Unknown version, and the status table's own rows (same file, 4 columns, no
# URL cell) must not produce a bogus hit.
if compat_read_pin 9.9.9 url "$FIXTURE" >/dev/null 2>&1; then
  fail "unknown version must return non-zero"
else
  pass "unknown version returns non-zero"
fi
if compat_read_pin 1.6259.1 url "$TMP/does-not-exist.md" >/dev/null 2>&1; then
  fail "missing COMPAT.md must return non-zero"
else
  pass "missing COMPAT.md returns non-zero"
fi

# ---------------------------------------------------------------------------
section "3. The real COMPAT.md pins its own LAST_TESTED_ASAR_VERSION"
# ---------------------------------------------------------------------------
COMPAT="$REPO_ROOT/COMPAT.md"
last_tested="$(grep -oE '^<!-- LAST_TESTED_ASAR_VERSION=[^[:space:]]+ -->$' "$COMPAT" \
  | head -1 | sed -E 's/.*=([^[:space:]]+) -->/\1/')"
if [[ -n "$last_tested" ]]; then
  pass "LAST_TESTED_ASAR_VERSION present ($last_tested)"
else
  fail "LAST_TESTED_ASAR_VERSION missing from COMPAT.md"
fi

# The whole point of #165: a version recorded as tested that has no pinning row
# cannot be obtained by anyone. A `<pending>` SHA-256 is fine -- a missing URL
# is not.
if url="$(compat_read_pin "$last_tested" url "$COMPAT")"; then
  pass "pinning table has a CDN URL for $last_tested"
  case "$url" in
    https://downloads.claude.ai/releases/darwin/universal/"$last_tested"/*)
      pass "recorded URL points at the $last_tested release path" ;;
    *)
      fail "recorded URL is not a $last_tested CDN path: $url" ;;
  esac
else
  fail "no CDN URL recorded for $last_tested -- see 'Reporting a tested version' in COMPAT.md"
fi

# ---------------------------------------------------------------------------
section "4. Project version agrees everywhere it is written"
# ---------------------------------------------------------------------------
# v5.2.0 shipped with install.sh, package.json and the README badge all still
# reading 5.1.0, so `--doctor` and the generated launcher reported the wrong
# release. A version bump has to touch all three.
v_install="$(grep -m1 -oE '^VERSION="[^"]+"' "$REPO_ROOT/install.sh" | cut -d'"' -f2)"
v_pkg="$(grep -m1 -oE '"version":[[:space:]]*"[^"]+"' "$REPO_ROOT/package.json" | sed -E 's/.*"([^"]+)"$/\1/')"
v_badge="$(grep -m1 -oE 'badge/version-v[0-9][0-9.]*-' "$REPO_ROOT/README.md" | sed -E 's#badge/version-v(.*)-#\1#')"
if [[ -n "$v_install" ]]; then pass "install.sh VERSION present ($v_install)"; else fail "install.sh VERSION missing"; fi
assert_eq "$v_pkg" "$v_install" "package.json version matches install.sh"
assert_eq "$v_badge" "$v_install" "README version badge matches install.sh"

# ---------------------------------------------------------------------------
echo -e "\n${BOLD}Summary:${NC} ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
[[ "$FAIL" -eq 0 ]]
