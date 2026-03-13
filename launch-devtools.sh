#!/bin/bash
# Launcher with DevTools enabled for debugging

# Change to script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export CLAUDE_ENABLE_LOGGING=1

# Reuse launch.sh so DevTools runs against the same freshly repacked asar.
exec "$SCRIPT_DIR/launch.sh" --inspect "$@"
