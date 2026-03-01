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

   # openSUSE
   sudo zypper install libnotify-tools
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

## openSUSE-Specific Notes

**Package names differ from other distros:**
- **7-Zip**: Called `7zip` on Tumbleweed/Slowroll, but `p7zip` on Leap 15.6. The installer auto-detects which is available.
- **Node.js**: Provided by `nodejs-default` (meta package). On Leap 15.6 this ships Node 16, which is too old (18+ required). See below for the fix.
- **npm**: Must be installed explicitly on openSUSE (`npm` package) — it is NOT pulled automatically by `nodejs-default` on all versions.
- Electron is available as `nodejs-electron` from the main OSS repository, or install via npm
- Notifications require `libnotify-tools` (not `libnotify-bin`)
- **Icon extraction** (optional): `python3-Pillow` is needed for `.icns` to `.png` icon conversion in `test-launch.sh`. Install with `sudo zypper install python3-Pillow`.

**Node.js on Leap 15.6:**
Leap 15.6 ships Node.js 16 by default, but Claude Desktop requires Node.js 18+. To get a newer version, add the NodeJS community repository:
```bash
sudo zypper ar https://download.opensuse.org/repositories/devel:/languages:/nodejs/openSUSE_Leap_$(. /etc/os-release && echo $VERSION_ID)/ nodejs-community
sudo zypper refresh
sudo zypper install nodejs20 npm20
```

**KDE Wallet integration:**
openSUSE with KDE Plasma typically has `kwalletd6` running, which exposes the `org.freedesktop.secrets` D-Bus interface. The launcher auto-detects this and uses `--password-store=gnome-libsecret` (which works with any SecretService provider, not just gnome-keyring).

**File manager integration:**
The `revealFile()` function uses the `org.freedesktop.FileManager1` D-Bus interface, which works with Dolphin (KDE), Nautilus (GNOME), Thunar (Xfce), and other compliant file managers. Falls back to `xdg-open` if D-Bus is unavailable.

**User namespaces:**
Modern openSUSE Tumbleweed kernels (6.x) have unprivileged user namespaces enabled by default. The `/proc/sys/kernel/unprivileged_userns_clone` sysctl does not exist on these kernels because the feature is always available. bubblewrap works out of the box.

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
