#!/bin/bash
# Claude Desktop Linux - Test Flow
# Tests the Wayland/GPU fixes and stub refactoring

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }
info() { echo -e "${BLUE}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
step() { echo -e "\n${YELLOW}=== $* ===${NC}"; }

cd /home/zack/dev/claude-cowork-linux

step "1. Environment Check"

# Check problematic vars are disabled
if env | grep -qE "^CLAUDE_DEV_TOOLS=|^CLAUDE_USE_WAYLAND=|^ENABLE_WAYLAND=|^DISABLE_DBUS_CONFIG="; then
    fail "Problematic env vars still set. Run: source ~/.zshrc"
    env | grep -E "^CLAUDE_DEV_TOOLS=|^CLAUDE_USE_WAYLAND=|^ENABLE_WAYLAND=|^DISABLE_DBUS_CONFIG=" || true
    echo ""
    warn "Fix: source ~/.zshrc (or open new terminal)"
else
    pass "Problematic env vars disabled"
fi

# Check Wayland var
if [[ "$ELECTRON_OZONE_PLATFORM_HINT" == "wayland" ]]; then
    pass "ELECTRON_OZONE_PLATFORM_HINT=wayland"
elif [[ -n "$WAYLAND_DISPLAY" ]] || [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
    warn "Wayland detected but ELECTRON_OZONE_PLATFORM_HINT not set"
    info "Run: source ~/.zshrc"
else
    info "Not running Wayland (X11 session)"
fi

step "2. Wayland Detection Test"

if [[ -n "$WAYLAND_DISPLAY" ]]; then
    pass "WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
else
    info "WAYLAND_DISPLAY not set"
fi

if [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
    pass "XDG_SESSION_TYPE=wayland"
else
    info "XDG_SESSION_TYPE=$XDG_SESSION_TYPE"
fi

step "3. Stub Download URLs"

info "Testing Swift stub URL..."
if curl -sfI "https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master/stubs/@ant/claude-swift/js/index.js" >/dev/null 2>&1; then
    pass "Swift stub URL reachable"
else
    fail "Swift stub URL unreachable"
fi

info "Testing Native stub URL..."
if curl -sfI "https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master/stubs/@ant/claude-native/index.js" >/dev/null 2>&1; then
    pass "Native stub URL reachable"
else
    fail "Native stub URL unreachable"
fi

step "4. Script Syntax Check"

for script in test-launch.sh install.sh; do
    if [[ -f "$script" ]]; then
        if bash -n "$script" 2>/dev/null; then
            pass "$script syntax OK"
        else
            fail "$script has syntax errors"
        fi
    fi
done

step "5. Log Directory"

LOG_DIR="$HOME/.local/share/claude-cowork/logs"
if [[ -d "$LOG_DIR" ]]; then
    pass "Log directory exists: $LOG_DIR"
    ls -lh "$LOG_DIR" 2>/dev/null | tail -5
else
    info "Log directory will be created on first launch"
fi

step "6. Recent Errors Check"

STARTUP_LOG="$LOG_DIR/startup.log"
if [[ -f "$STARTUP_LOG" ]]; then
    DISPOSED_COUNT=$(grep -c "webFrameMain.*disposed" "$STARTUP_LOG" 2>/dev/null || echo 0)
    GPU_ERRORS=$(grep -c "SharedImageManager\|ProduceSkia" "$STARTUP_LOG" 2>/dev/null || echo 0)
    MCP_DISCONNECTS=$(grep -c "mcp_unexpected_close" "$STARTUP_LOG" 2>/dev/null || echo 0)

    if [[ $DISPOSED_COUNT -gt 0 ]]; then
        warn "Found $DISPOSED_COUNT 'webFrameMain disposed' errors in log"
    else
        pass "No 'webFrameMain disposed' errors"
    fi

    if [[ $GPU_ERRORS -gt 0 ]]; then
        warn "Found $GPU_ERRORS GPU errors in log"
    else
        pass "No GPU errors"
    fi

    if [[ $MCP_DISCONNECTS -gt 0 ]]; then
        warn "Found $MCP_DISCONNECTS MCP disconnect events in log"
    else
        pass "No MCP disconnects"
    fi
else
    info "No startup log yet (first launch)"
fi

step "7. Ready to Launch"

echo ""
info "Pre-flight checks complete."
echo ""
echo "To launch Claude Desktop:"
echo "  ./test-launch.sh"
echo ""
echo "Watch for:"
echo "  - 'Wayland detected' message"
echo "  - No immediate crash"
echo "  - Streaming responses (not batched)"
echo ""
echo "Stress test:"
echo "  - Switch workspaces during response"
echo "  - Minimize/restore window"
echo "  - Run for 5+ minutes"
echo ""

read -p "Launch now? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    info "Launching Claude Desktop..."
    exec ./test-launch.sh
fi
