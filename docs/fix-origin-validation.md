# Fix: IPC Origin Validation Error

## Problem
When running Claude Desktop on Linux, IPC calls from renderer processes failed with:
```
Error: Incoming "getInitialLocale" call on interface "DesktopIntl" from 'file:///...' did not pass origin validation
```

## Root Cause

### Issue 1: Origin Validation (`Q7` function)
The `Q7()` function in `app/.vite/build/index.js` validates the origin of IPC calls from renderer processes. It only allowed `file://` protocol URLs when `app.isPackaged === true`.

When running with `electron <directory>` (unpackaged), `app.isPackaged` returns `false`, causing all `file://` URLs to be rejected.

### Issue 2: Hardcoded Build Paths
The error showed paths like `/home/zack/dev/claudeosx-2/claude-linux/` because Vite baked absolute file paths into the bundle during the original build. This is not the actual cause of the error - it's just what appears in error messages.

## Solution

### Patch Applied
Modified the `Q7()` function to allow `file://` protocol on Linux regardless of `app.isPackaged` status:

**Original:**
```javascript
e.protocol==="file:"&&ce.app.isPackaged===!0
```

**Patched:**
```javascript
e.protocol==="file:"&&(ce.app.isPackaged===!0||process.platform==="linux")
```

This tells the origin validator: "Allow file:// URLs if the app is packaged OR if we're running on Linux"

### Files Modified

1. **`app/.vite/build/index.js`** - Applied Q7 patch directly (backup saved as `.bak`)
2. **`install.sh`** - Updated installer to apply Q7 patch during future installations

## Testing

To verify the fix works:

```bash
# Clear logs for a fresh test
: > ~/.local/share/claude-cowork/logs/claude-cowork.log

# Run the app
./run.sh

# Check for the error
grep "origin validation" ~/.local/share/claude-cowork/logs/claude-cowork.log
```

If the fix works, you should NOT see any "origin validation" errors.

## Extension Filesystem Warning

The warning "Extension filesystem not found in installed extensions" is a separate, non-fatal issue. The app will function without it. This can be addressed later if needed.

## Technical Details

### Why `app.isPackaged` is False
- Running `electron <directory>` loads an unpackaged app
- Electron sets `app.isPackaged = false` for unpackaged apps
- The original macOS app is packaged into an `.asar` file, so `isPackaged = true` there
- On Linux, we extract the asar and run it unpacked for flexibility

### Why This Fix is Safe
- The origin validation still checks that:
  - Calls come from top-level frames (not iframes)
  - Protocol is `file://` (local files only)
  - Other security checks remain in place
- We're only relaxing the "must be packaged" requirement on Linux
- This doesn't open up remote origins or bypass other security measures

## Related Files
- `app/.vite/build/index.js` - Main bundle with patches
- `install.sh` - Installation script with automated patching
- `stubs/@ant/claude-swift/js/index.js` - Linux VM stub
- `stubs/@ant/claude-native/index.js` - Native addon stub
