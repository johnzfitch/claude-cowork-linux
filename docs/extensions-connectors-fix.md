# Extensions & Connectors Platform Fix

## Problem

When clicking on extensions/connectors in Claude Desktop, they appear greyed out with the message "Only available on macOS" even though we're running on Linux.

## Root Cause

Claude Desktop uses a variable `$n` defined as:
```javascript
$n=process.platform==="darwin"
```

This variable determines feature availability throughout the app. When `$n` is false (on Linux), extensions and connectors are disabled in the UI.

## Solution

We patch the `$n` variable to also return true on Linux:

**Original:**
```javascript
$n=process.platform==="darwin"
```

**Patched:**
```javascript
$n=process.platform==="darwin"||process.platform==="linux"
```

## What This Enables

With this patch, extensions and connectors become available on Linux:

- ✅ **Connectors** - Can be clicked and configured
- ✅ **Extensions** - Can be installed and used
- ✅ **MCP Servers** - Already worked, continue to work
- ✅ **Desktop integrations** - Features become available

## What About macOS-Only Features?

Some features genuinely require macOS (like AppleScript via `osascript`). These have their own guards that will:
- Still attempt to run
- Fail gracefully with proper error messages
- Not crash the app

For example, the `osascript` tool:
```javascript
if(!$n)throw new Error("osascript is only available on macOS");
```

This check will now pass on Linux, but the actual `osascript` command will fail when executed (since the command doesn't exist on Linux). The error will be caught and displayed appropriately.

## Trade-offs

### Pros
- ✅ Extensions and connectors become clickable
- ✅ Most features work out of the box
- ✅ Simple, single-variable patch
- ✅ Doesn't break existing functionality

### Cons
- ⚠️ macOS-only tools (osascript, etc.) will attempt to run and fail
- ⚠️ Error messages might say "tool failed" instead of "not available on Linux"
- ⚠️ Some paths might use macOS-specific locations

In practice, most features work fine. The few macOS-specific features fail gracefully.

## Alternative Considered: Selective Spoofing

We considered making only extensions think they're on macOS while the rest of the app knows it's Linux. However:
- Would require complex patching of multiple checks
- Hard to maintain across updates
- The simple approach works well enough

## Files Modified

1. **`app/.vite/build/index.js`** - Patched `$n` variable (backup saved as `.bak`)
2. **`install.sh`** - Updated installer to apply this patch automatically

## Testing

After applying the patch:

1. Restart Claude Desktop
2. Go to Settings → Extensions/Connectors
3. They should now be clickable (not greyed out)
4. Try configuring a connector
5. Most should work fine on Linux

## Reverting

If you need to revert:

```bash
# Restore from backup
cp app/.vite/build/index.js.bak app/.vite/build/index.js
```

Or re-run the installer with a fresh DMG extraction.

## See Also

- `docs/extensions.md` - How to configure MCP servers (recommended extension method)
- `docs/fix-origin-validation.md` - Origin validation fix (applied earlier)
- `install.sh` - Automatic patching during installation
