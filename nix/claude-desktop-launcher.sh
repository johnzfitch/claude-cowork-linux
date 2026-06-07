#!/usr/bin/env bash
set -euo pipefail

# launch.sh mutates its own directory (sed patches + `asar pack` into
# .asar-cache/), so it cannot run from the read-only Nix store. Mirror the
# prepared tree into a writable per-user copy, refreshing only when the store
# path changes (i.e. after a flake/version bump).
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
work_dir="$data_home/claude-cowork-linux"
marker="$work_dir/.nix-store-path"

if [ ! -f "$marker" ] || [ "$(cat "$marker" 2>/dev/null)" != "$CLAUDE_COWORK_STORE" ]; then
  rm -rf "$work_dir"
  mkdir -p "$work_dir"
  cp -r --no-preserve=mode,ownership "$CLAUDE_COWORK_STORE"/. "$work_dir"/
  printf '%s\n' "$CLAUDE_COWORK_STORE" > "$marker"
fi

cd "$work_dir"
exec bash ./launch.sh "$@"
