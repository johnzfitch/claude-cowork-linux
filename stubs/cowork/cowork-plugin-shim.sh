#!/bin/bash
# cowork-plugin-shim.sh — Permission bridge between CLI plugins and Desktop UI
#
# Called by the Claude Code CLI when a plugin tool needs permission approval.
# Writes a JSON request to the shim-perm/requests/ directory, waits for the
# asar's pluginShimPermissionBridge to write a response, then exits.
#
# Layout (via VM mounts on macOS, symlinks on Linux):
#   .cowork-lib/shim.sh           ← this script (ro)
#   .cowork-perm-req/             ← request files (rw)
#   .cowork-perm-resp/            ← response files (read by shim)
#
# Usage: shim.sh <plugin> <op> <argv>
# Exit:  0 = allowed, 1 = denied/timeout
#
# Request JSON: {"plugin":"<name>","op":"<operation>","argv":"<command>"}
# Response:     plain text "allow" or "deny"

set -euo pipefail

PLUGIN="${1:-}"
OP="${2:-}"
ARGV="${3:-}"

if [ -z "$PLUGIN" ] || [ -z "$OP" ]; then
  exit 1
fi

# Derive request/response dirs from script location.
# The shim lives in .cowork-lib/ (or shim-lib/); request/response dirs
# are siblings under the same parent (mnt/ or sessionStorageDir/).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"

# VM mount layout: .cowork-perm-req/ and .cowork-perm-resp/ are siblings
if [ -d "$PARENT_DIR/.cowork-perm-req" ]; then
  REQ_DIR="$PARENT_DIR/.cowork-perm-req"
  RESP_DIR="$PARENT_DIR/.cowork-perm-resp"
# Real filesystem layout: shim-lib/ and shim-perm/ are siblings
elif [ -d "$PARENT_DIR/shim-perm/requests" ]; then
  REQ_DIR="$PARENT_DIR/shim-perm/requests"
  RESP_DIR="$PARENT_DIR/shim-perm/responses"
else
  exit 1
fi

# Generate unique filename
FILENAME="$(date +%s%N)-$$"

# Escape values for JSON (handle backslash, quotes, control chars)
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr -d '\n\r'
}

P_ESC="$(json_escape "$PLUGIN")"
O_ESC="$(json_escape "$OP")"
A_ESC="$(json_escape "$ARGV")"

# Write request atomically (tmp file + rename)
printf '{"plugin":"%s","op":"%s","argv":"%s"}\n' "$P_ESC" "$O_ESC" "$A_ESC" \
  > "$REQ_DIR/.$FILENAME.tmp"
mv "$REQ_DIR/.$FILENAME.tmp" "$REQ_DIR/$FILENAME"

# Wait for response (poll every 100ms, timeout 120s)
ELAPSED=0
TIMEOUT=1200
while [ ! -f "$RESP_DIR/$FILENAME" ]; do
  sleep 0.1
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    exit 1
  fi
done

RESPONSE="$(cat "$RESP_DIR/$FILENAME" 2>/dev/null || echo "deny")"
case "$RESPONSE" in
  allow*) exit 0 ;;
  *)      exit 1 ;;
esac
