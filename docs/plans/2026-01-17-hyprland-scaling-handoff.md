# Hyprland HiDPI Scaling Handoff

## Problem

Claude Cowork (Electron app) renders at 1x scale on Hyprland, resulting in a tiny, unusable UI. The display is using HiDPI scaling (likely 2x), but the Electron app doesn't respect this.

## Screenshots

See `/home/zack/Screenshots/screenshot-2026-01-17_13-41-*.png`:
- The Claude Cowork window appears extremely small
- Text and UI elements are barely readable
- Debug console windows render at correct scale, only the Electron app is affected

## Root Cause

Electron apps on Wayland/Hyprland often don't automatically detect display scaling. This is a known issue with:
1. Electron's Wayland support (still maturing)
2. XWayland fallback not receiving scale information
3. Missing environment variables for DPI awareness

## Potential Solutions

### 1. Force Device Scale Factor (Quick Fix)

Modify `run.sh` to pass scale factor to Electron:

```bash
# Option A: Electron flag
npx electron app --force-device-scale-factor=2

# Option B: Environment variable
ELECTRON_FORCE_DEVICE_SCALE_FACTOR=2 npx electron app
```

### 2. GDK/GTK Scaling

```bash
GDK_SCALE=2 GDK_DPI_SCALE=0.5 npx electron app
```

### 3. Native Wayland Mode

Electron can run natively on Wayland instead of XWayland:

```bash
npx electron app --enable-features=UseOzonePlatform --ozone-platform=wayland
```

Combined with scale factor:
```bash
npx electron app \
  --enable-features=UseOzonePlatform \
  --ozone-platform=wayland \
  --force-device-scale-factor=2
```

### 4. Auto-detect Scale Factor

Query Hyprland for monitor scale and apply dynamically:

```bash
# Get scale from hyprctl
SCALE=$(hyprctl monitors -j | jq '.[0].scale')
npx electron app --force-device-scale-factor=$SCALE
```

## Implementation Plan

1. **Detect environment**: Check if running on Hyprland/Wayland
2. **Query display scale**: Use `hyprctl monitors -j` or `wlr-randr`
3. **Apply scale factor**: Pass to Electron via flag or env var
4. **Test native Wayland**: Try Ozone platform for better integration
5. **Update `run.sh`**: Add automatic scaling detection
6. **Update `debug.sh`**: Same changes for debug mode

## Files to Modify

- `run.sh` - Main launch script
- `debug.sh` - Debug launch script
- Possibly create a `config.sh` for user-configurable scale override

## Testing

1. Run on Hyprland with 2x scaling
2. Verify UI renders at correct size
3. Test window resizing, dragging
4. Test native Wayland mode if XWayland fallback has issues
5. Test on X11 to ensure no regression

## References

- Electron Wayland support: https://www.electronjs.org/docs/latest/api/command-line-switches
- Hyprland scaling: https://wiki.hyprland.org/Configuring/Monitors/
- Ozone platform: https://chromium.googlesource.com/chromium/src/+/HEAD/docs/ozone_overview.md

## Notes

- User's setup: Arch Linux, Hyprland, likely 2x or 1.5x display scaling
- The README mentions "Wayland support is not implemented" - this is related
- May want to add a `--scale` flag to run.sh for manual override
