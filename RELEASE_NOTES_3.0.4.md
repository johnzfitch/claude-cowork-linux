# Release Notes — v3.0.4

## Graceful shutdown on Linux window managers

### Problem

Closing Claude Desktop via a window manager (Hyprland `killactive`, GNOME/KDE
close button, i3 `kill`, Sway, etc.) left the Electron process running in the
background. On the next launch, stale `SingletonLock` files blocked startup —
the app appeared to do nothing.

This affected all Linux desktop environments. The detached launcher (`nohup`)
introduced in v3.0.2 made it worse: without a terminal session to cushion
recovery from stale locks, relaunch silently failed.

### Root cause

We spoof `process.platform` as `"darwin"` so the asar's macOS-specific code
paths work. But this also activates macOS dock behavior:

1. The asar's BrowserWindow `close` handler checks `isMac()` and swallows the
   close event (hide-to-dock instead of quit)
2. The asar's `window-all-closed` handler checks `process.platform === "darwin"`
   and skips `app.quit()` (macOS convention: apps stay running after last window)
3. The asar's `before-quit` handler can cancel `app.quit()` calls

Result: the window disappears from the compositor but the process stays alive,
holding the singleton lock. Next launch sees the lock, can't connect to the
dead window's socket, and fails silently.

### Fix

Added graceful shutdown handling to `frame-fix-wrapper.js`:

- **`browser-window-created` hook**: patches every BrowserWindow with a `close`
  listener that schedules `app.exit(0)` via `setImmediate` (deferred so the
  asar's close handlers finish without "Object has been destroyed" errors)
- **`window-all-closed` handler**: registered before the asar's handler as a
  safety net — calls `app.exit(0)` if somehow triggered
- **Signal handlers**: `SIGTERM`, `SIGHUP`, `SIGINT` all call `app.exit(0)` so
  `kill`, `systemctl stop`, and terminal close all work
- Uses `app.exit()` instead of `app.quit()` because the asar's `before-quit`
  handler cancels quit attempts

### Testing

Verified on Hyprland (Wayland) with both `killactive` and `SIGTERM`:
- Window close: process exits, singleton files cleaned up, immediate relaunch works
- `kill <pid>`: clean exit
- `claude-desktop` from any directory: launches correctly
