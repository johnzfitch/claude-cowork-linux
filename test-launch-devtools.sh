#!/bin/bash
# Test launcher with DevTools enabled

cd /home/zack/dev/claude-cowork-linux

# Enable logging and DevTools
export ELECTRON_ENABLE_LOGGING=1
export CLAUDE_DEV_TOOLS=detach
export CLAUDE_ENABLE_LOGGING=1

# Clear log
echo "=== TEST RUN WITH DEVTOOLS ===" > ~/Library/Logs/Claude/startup.log

# Launch
exec electron linux-loader.js "$@" 2>&1 | tee -a ~/Library/Logs/Claude/startup.log
