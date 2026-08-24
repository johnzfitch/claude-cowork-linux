#!/usr/bin/env bash
set -euo pipefail

# /app is read-only inside the sandbox, and launch.sh mutates its own
# directory (sed patches + `asar pack` into .asar-cache/). Mirror the
# prepared tree into XDG_DATA_HOME, refreshing only when the app's version
# changes. XDG_DATA_HOME already resolves to a private per-app directory
# under the sandbox (~/.var/app/<id>/data) with no extra --filesystem grant
# needed — same trick nix/claude-desktop-launcher.sh uses for the Nix store.
store=/app/share/claude-cowork-linux
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
work_dir="$data_home/claude-cowork-linux"
marker="$work_dir/.flatpak-store-version"

if [ ! -f "$marker" ] || ! cmp -s "$marker" "$store/.version"; then
  rm -rf "$work_dir"
  mkdir -p "$work_dir"
  cp -r --no-preserve=mode,ownership "$store"/. "$work_dir"/
  cp "$store/.version" "$marker"
fi

cd "$work_dir"
exec bash ./launch.sh "$@"
