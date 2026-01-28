#!/bin/bash
# Security verification test for claude-cowork-linux

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Claude Cowork Linux Security Tests ==="
echo

# Test 1: Verify bwrap args don't include /run or /var
echo "[TEST 1] Checking bwrap configuration..."
if grep -q "'--bind', '/run'" stubs/@ant/claude-swift/js/index.js; then
    echo "❌ FAIL: /run is still bind-mounted"
    exit 1
fi
if grep -q "'--bind', '/var'" stubs/@ant/claude-swift/js/index.js; then
    echo "❌ FAIL: /var is still bind-mounted"
    exit 1
fi
if grep -q "'--unshare-net'" stubs/@ant/claude-swift/js/index.js; then
    echo "✅ PASS: Network isolation enabled"
else
    echo "❌ FAIL: Network isolation missing"
    exit 1
fi
echo "✅ PASS: Bwrap configuration secure"
echo

# Test 2: Verify environment variable filtering
echo "[TEST 2] Checking environment variable isolation..."
if grep -q "SSH_AUTH_SOCK" stubs/@ant/claude-swift/js/index.js | grep -q "vmEnv\["; then
    echo "❌ FAIL: SSH_AUTH_SOCK is being passed"
    exit 1
fi
if grep -q "CLAUDE_SANDBOX: 'true'" stubs/@ant/claude-swift/js/index.js; then
    echo "✅ PASS: Claude sandbox flag set"
else
    echo "❌ FAIL: Claude sandbox flag missing"
    exit 1
fi
echo "✅ PASS: Environment isolation configured"
echo

# Test 3: Verify log rotation exists
echo "[TEST 3] Checking log rotation..."
if grep -q "MAX_LOG_SIZE" stubs/@ant/claude-swift/js/index.js; then
    echo "✅ PASS: Log rotation implemented"
else
    echo "❌ FAIL: Log rotation missing"
    exit 1
fi
echo

# Test 4: Verify cleanup function exists
echo "[TEST 4] Checking memory leak fixes..."
if grep -q "removeAllListeners" stubs/@ant/claude-swift/js/index.js; then
    echo "✅ PASS: Listener cleanup implemented"
else
    echo "❌ FAIL: Listener cleanup missing"
    exit 1
fi
if grep -q "CREATED_DIRS" stubs/@ant/claude-swift/js/index.js; then
    echo "✅ PASS: Directory caching implemented"
else
    echo "❌ FAIL: Directory caching missing"
    exit 1
fi
echo

# Test 5: Verify read-only system mounts
echo "[TEST 5] Checking read-only system mounts..."
if grep -q "'--ro-bind', '/usr'" stubs/@ant/claude-swift/js/index.js; then
    echo "✅ PASS: /usr is read-only"
else
    echo "❌ FAIL: /usr should be read-only"
    exit 1
fi
if grep -q "'--ro-bind', '/bin'" stubs/@ant/claude-swift/js/index.js; then
    echo "✅ PASS: /bin is read-only"
else
    echo "❌ FAIL: /bin should be read-only"
    exit 1
fi
echo

# Test 6: Verify tmpfs isolation
echo "[TEST 6] Checking tmpfs isolation..."
if grep -q "'--tmpfs', '/tmp'" stubs/@ant/claude-swift/js/index.js; then
    echo "✅ PASS: /tmp is isolated"
else
    echo "❌ FAIL: /tmp should be isolated tmpfs"
    exit 1
fi
echo

# Test 7: Check for backpressure handling
echo "[TEST 7] Checking backpressure handling..."
if grep -q "canWrite" stubs/@ant/claude-swift/js/index.js; then
    echo "✅ PASS: Backpressure handling implemented"
else
    echo "❌ FAIL: Backpressure handling missing"
    exit 1
fi
echo

echo "==================================="
echo "✅ ALL SECURITY TESTS PASSED"
echo "==================================="
echo
echo "Manual runtime tests:"
echo "1. Run ./test-launch.sh"
echo "2. Ask Claude to: 'Run: curl https://google.com'"
echo "   Expected: Network error (isolated by default)"
echo "3. Ask Claude to: 'Run: ls /run'"
echo "   Expected: Empty or doesn't exist"
echo "4. Ask Claude to: 'Run: echo \$SSH_AUTH_SOCK'"
echo "   Expected: Empty output"
echo
echo "To isolate network: export CLAUDE_ISOLATE_NETWORK=true"
echo "To enable traces: export CLAUDE_TRACE=1"
