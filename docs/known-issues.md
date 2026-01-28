# Known Issues

## Safe Storage Encryption Warning

**Message**: `Electron safeStorage encryption is not available on this system`

**Impact**: Low - tokens won't persist between sessions. You'll need to re-authenticate each time.

**Solution**: Install a keyring daemon. See [safestorage-tokens.md](safestorage-tokens.md).

---

## Hyprland Window Scaling

If Claude appears blurry or has incorrect opacity on Hyprland, install the window rules:

```bash
# Copy the config file
cp config/hyprland/claude.conf ~/.config/hypr/

# Add to ~/.config/hypr/hyprland.conf:
source = ~/.config/hypr/claude.conf
```

The rules provide:
- Full opacity for Claude windows (prevents transparency bleeding)
- Floating DevTools with proper sizing
- Optional XWayland forcing for Electron compatibility

---

## Chrome Extension Not Supported

**Message**: `[Chrome Extension MCP] Skipping native host setup: binary not found`

**Impact**: None for most users. The Chrome Extension integration isn't available on Linux.

**Reason**: The native messaging host binary was only built for macOS and Windows.

**Workaround**: Use MCP servers for similar functionality. See [extensions.md](extensions.md).

---

## Extension Filesystem Warning

**Message**: `Extension filesystem not found in installed extensions`

**Impact**: None. This refers to an internal extension system, not MCP servers.

---

## Blank or White Window

**Symptoms**: App launches but shows a blank white window.

**Cause**: Usually GPU/rendering issues with Electron.

**Solutions**:

1. Disable GPU acceleration:
   ```bash
   electron --disable-gpu /Applications/Claude.app/Contents/Resources/linux-loader.js
   ```

2. Try software rendering:
   ```bash
   LIBGL_ALWAYS_SOFTWARE=1 claude
   ```

3. On Wayland, try XWayland:
   ```bash
   GDK_BACKEND=x11 claude
   ```

---

## Slow Startup

**Symptoms**: App takes several seconds to show the window.

**Cause**: First-time startup initializes caches and may download resources.

**Solutions**:
- Subsequent starts should be faster
- Check network connectivity if stuck on loading
- Review `~/Library/Logs/Claude/startup.log` for bottlenecks

---

## Sandbox Errors (bubblewrap)

**Message**: `bwrap: Can't create user namespace` or similar

**Cause**: User namespaces may be disabled on your system.

**Solutions**:

1. Check if user namespaces are enabled:
   ```bash
   cat /proc/sys/kernel/unprivileged_userns_clone
   # Should be 1
   ```

2. Enable if needed (requires root):
   ```bash
   echo 1 | sudo tee /proc/sys/kernel/unprivileged_userns_clone
   ```

3. Make permanent in `/etc/sysctl.d/userns.conf`:
   ```
   kernel.unprivileged_userns_clone = 1
   ```

---

## Missing Notifications

**Symptoms**: Desktop notifications don't appear.

**Cause**: Missing `notify-send` or notification daemon not running.

**Solutions**:

1. Install libnotify:
   ```bash
   # Arch
   sudo pacman -S libnotify

   # Debian/Ubuntu
   sudo apt install libnotify-bin
   ```

2. Ensure a notification daemon is running (e.g., `dunst`, `mako`, or your DE's built-in)

---

## High Memory Usage

**Symptoms**: Claude uses significant RAM (1GB+).

**Cause**: Normal for Electron apps, especially with long conversations.

**Solutions**:
- Close and reopen for long-running sessions
- Limit conversation history length
- Ensure swap is configured if RAM is limited

---

## Reporting Issues

If you encounter issues not listed here:

1. Check logs:
   - `~/Library/Logs/Claude/startup.log` - Launch issues
   - `~/.local/share/claude-cowork/logs/claude-swift-trace.log` - Stub issues

2. Enable debug mode:
   ```bash
   CLAUDE_TRACE=1 ELECTRON_ENABLE_LOGGING=1 claude 2>&1 | tee ~/claude-debug.log
   ```

3. Report at the project repository with:
   - Linux distribution and version
   - Desktop environment / window manager
   - Relevant log snippets
   - Steps to reproduce
