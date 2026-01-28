# Safe Storage and Token Persistence

## The Warning

```
[warn] safeStorage not available, tokens will not persist
```

## What This Means

Electron's `safeStorage` API provides encrypted token storage using the system keyring. On Linux, it requires:
- **GNOME**: `gnome-keyring` daemon running
- **KDE**: `kwallet` daemon running
- **Other**: `libsecret` compatible keyring

Without a keyring, Claude Desktop:
- ✅ Still works normally
- ✅ Can authenticate and use your account
- ❌ Won't save auth tokens between sessions
- ❌ You'll need to re-authenticate each time you start the app

## Check if You Have a Keyring

```bash
# Check if gnome-keyring is running
ps aux | grep gnome-keyring

# Check if kwallet is running
ps aux | grep kwalletd

# Check if secret-tool is available
which secret-tool
```

## Solutions

### Option 1: Install and Configure GNOME Keyring (Recommended)

Works on any desktop environment:

```bash
# Arch/Manjaro
sudo pacman -S gnome-keyring libsecret

# Debian/Ubuntu
sudo apt install gnome-keyring libsecret-1-0

# Fedora
sudo dnf install gnome-keyring libsecret
```

**Start the keyring daemon:**

Add to your `~/.xinitrc`, `~/.xprofile`, or window manager startup:

```bash
# Start gnome-keyring-daemon
eval $(gnome-keyring-daemon --start)
export SSH_AUTH_SOCK
```

For systemd (most modern distros):

```bash
# Enable the service
systemctl --user enable --now gnome-keyring-daemon.service
```

**For Hyprland users:**

Add to `~/.config/hypr/hyprland.conf`:

```
exec-once = gnome-keyring-daemon --start --components=secrets
```

### Option 2: Use KWallet (KDE Users)

If you're on KDE Plasma:

```bash
# Arch/Manjaro
sudo pacman -S kwallet

# Debian/Ubuntu
sudo apt install kwalletmanager

# Fedora
sudo dnf install kwalletmanager
```

KWallet usually starts automatically on KDE.

### Option 3: Live with Re-Authentication

If you don't want to install a keyring:
- Accept that you'll need to log in each time
- This is still secure (just less convenient)
- Your session data and files are still saved

## Testing

After installing and starting a keyring:

```bash
# Test secret storage
echo "test" | secret-tool store --label="Test" test key

# Retrieve it
secret-tool lookup test key

# Clean up test
secret-tool clear test key
```

If this works, restart Claude Desktop and the warning should be gone.

## Verify It's Fixed

```bash
# Clear old logs
: > ~/Library/Logs/Claude/startup.log

# Start Claude
claude

# Check for the warning
grep "safeStorage" ~/Library/Logs/Claude/startup.log
```

If safeStorage is working, you won't see the warning.

## Security Notes

### With Keyring (Recommended)
- Tokens stored encrypted in system keyring
- Protected by your login password (or keyring password)
- Secure cross-session persistence

### Without Keyring
- Tokens not persisted between sessions
- Re-authentication required each startup
- Still secure during the session (tokens in memory only)

## Troubleshooting

### "No such interface 'org.freedesktop.Secret.Service'"

The keyring daemon isn't running. Start it:

```bash
gnome-keyring-daemon --start --components=secrets
```

### Keyring Unlocking Prompts

If you get repeated unlock prompts:

```bash
# Set default keyring password to match login password
# Run this once after installing gnome-keyring
seahorse  # GUI keyring manager
# or
secret-tool store --label="Login" login password
```

### Still Not Working?

Check environment variables:

```bash
# These should be set when keyring is running
echo $GNOME_KEYRING_CONTROL
echo $XDG_RUNTIME_DIR
```

If not set, your desktop environment startup isn't initializing the keyring properly.

## Desktop Environment Specifics

### Hyprland
Add to `~/.config/hypr/hyprland.conf`:
```
exec-once = dbus-update-activation-environment --all
exec-once = gnome-keyring-daemon --start --components=secrets
```

### i3 / Sway
Add to config:
```
exec --no-startup-id gnome-keyring-daemon --start --components=secrets
exec --no-startup-id dbus-update-activation-environment --all
```

### XFCE
Usually handles this automatically. If not:
Settings → Session and Startup → Add:
```
gnome-keyring-daemon --start --components=secrets
```

### GNOME/KDE
Should work out of the box. If not, keyring package might not be installed.

## Summary

**The warning is harmless but annoying.** Installing a keyring daemon:
- ✅ Saves you from re-authenticating every session
- ✅ Properly encrypts stored tokens
- ✅ Follows Linux security best practices
- ✅ Takes 5 minutes to set up

Most users want Option 1 (gnome-keyring) as it works everywhere.
