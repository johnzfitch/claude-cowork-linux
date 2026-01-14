#!/bin/bash
# Claude Desktop for Linux launcher with automatic logging

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
ELECTRON="$SCRIPT_DIR/node_modules/.bin/electron"

# Logging configuration
LOG_DIR="$HOME/.local/share/claude-cowork/logs"
MAX_LOGS=5
MAX_LOG_SIZE=$((10 * 1024 * 1024))  # 10MB per log

# Create log directory
mkdir -p "$LOG_DIR"

# Rotate logs if current log is too large
rotate_logs() {
    local current="$LOG_DIR/claude-cowork.log"
    if [ -f "$current" ] && [ "$(stat -c%s "$current" 2>/dev/null || echo 0)" -gt "$MAX_LOG_SIZE" ]; then
        # Rotate: remove oldest, shift others
        rm -f "$LOG_DIR/claude-cowork.$MAX_LOGS.log" 2>/dev/null
        for i in $(seq $((MAX_LOGS - 1)) -1 1); do
            [ -f "$LOG_DIR/claude-cowork.$i.log" ] && mv "$LOG_DIR/claude-cowork.$i.log" "$LOG_DIR/claude-cowork.$((i + 1)).log"
        done
        mv "$current" "$LOG_DIR/claude-cowork.1.log"
    fi
}

rotate_logs

# Session marker
SESSION_START=$(date '+%Y-%m-%d %H:%M:%S')
{
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Session started: $SESSION_START"
    echo "═══════════════════════════════════════════════════════════════"
} >> "$LOG_DIR/claude-cowork.log"

# GPU flags for Linux stability
export ELECTRON_ENABLE_LOGGING=1

# Clear trace log for fresh session
> /tmp/claude-swift-trace.log 2>/dev/null

# Run with logging - stderr to log, stdout to both terminal and log
exec "$ELECTRON" "$APP_DIR" \
    --disable-gpu-sandbox \
    --enable-features=UseOzonePlatform \
    --ozone-platform=x11 \
    --disable-gpu-compositing \
    "$@" \
    2>> "$LOG_DIR/claude-cowork.log"
