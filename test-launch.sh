#!/bin/bash
# Test launcher for claude-cowork-linux
# Uses the AppImage's electron with repacked asar (the approach that worked)

cd /home/zack/dev/claude-cowork-linux

ASAR_FILE="squashfs-root/usr/lib/node_modules/electron/dist/resources/app.asar"
STUB_FILE="linux-app-extracted/node_modules/@ant/claude-swift/js/index.js"

# Only repack if stub is newer than asar (or asar doesn't exist)
if [ ! -f "$ASAR_FILE" ] || [ "$STUB_FILE" -nt "$ASAR_FILE" ]; then
  echo "Repacking app.asar (stub changed)..."
  asar pack linux-app-extracted "$ASAR_FILE"
else
  echo "Using cached app.asar (no changes)"
fi

# Enable logging
export ELECTRON_ENABLE_LOGGING=1

# Create log directory
mkdir -p ~/.local/share/claude-cowork/logs

# Run with AppImage's electron (unbuffered output)
echo "Launching Claude Desktop..."
exec stdbuf -oL -eL ./squashfs-root/usr/lib/node_modules/electron/dist/electron \
  ./squashfs-root/usr/lib/node_modules/electron/dist/resources/app.asar \
  --no-sandbox 2>&1 | stdbuf -oL tee -a ~/.local/share/claude-cowork/logs/startup.log
