# Safe Storage and Token Persistence

## The Warnings

From the launcher (`launch.sh`, used by the `claude-desktop` launcher and the Nix package), in `startup.log`:

```
WARN: org.freedesktop.secrets not available, falling back to --password-store=basic
```

From Claude Desktop itself:

```
[warn] safeStorage not available, tokens will not persist
```

## What This Means

Electron's `safeStorage` API encrypts stored tokens with a key kept in the system keyring. As
this project launches it, Electron reaches the keyring only through the freedesktop
**Secret Service** D-Bus API.

At every start, the launcher asks the session bus whether anything owns the name
`org.freedesktop.secrets`:

- **Yes**: Electron is started with `--password-store=gnome-libsecret`, which talks to that
  Secret Service provider.
- **No** (or `dbus-send` is not installed): Electron is started with `--password-store=basic`
  and `launch.sh` prints the warning above.

Any Secret Service provider works: `gnome-keyring`, KeePassXC with Secret Service
integration enabled, or KWallet when it is providing the Secret Service interface. The AUR
launcher (`claude-cowork`) runs the same check silently.

Without a Secret Service provider, Claude Desktop:
- Still works normally
- Can authenticate and use your account
- Warns that it won't save auth tokens between sessions, so expect to sign in again each time you start the app

## Check if You Have a Secret Service Provider

This is the check the launcher runs:

```bash
dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
  org.freedesktop.DBus.NameHasOwner string:"org.freedesktop.secrets"
# "boolean true" means the launcher will use the keyring
```

Or run the preflight diagnostics, which include it:

```bash
claude-desktop --doctor
# [OK] Secret service (org.freedesktop.secrets): available
```

To see what is installed:

```bash
# Is gnome-keyring or kwallet running?
ps aux | grep -E 'gnome-keyring|kwalletd'

# Is secret-tool available (used in Testing below)?
which secret-tool
```

## Solutions

### Option 1: Install and Configure GNOME Keyring (Recommended)

Works on any desktop environment:

```bash
# Arch/Manjaro
sudo pacman -S gnome-keyring libsecret

# Debian/Ubuntu (libsecret-tools provides secret-tool)
sudo apt install gnome-keyring libsecret-1-0 libsecret-tools

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

For window-manager-specific lines (Hyprland, i3, Sway, XFCE), see
[Desktop Environment Specifics](#desktop-environment-specifics).

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

KWallet usually starts automatically on KDE. The launcher only uses it if it owns
`org.freedesktop.secrets`; run the `dbus-send` check above. If it says `boolean false`,
KWallet is not providing the Secret Service interface and the launcher will fall back to
`basic`. Option 1 works alongside KDE.

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

If this works, restart Claude Desktop. The launcher checks for the keyring each time it
starts, so the keyring must be running **before** you launch the app.

## Verify It's Fixed

```bash
# Clear old logs
: > ~/.local/state/claude-cowork/logs/startup.log

# Start Claude Desktop
claude-desktop

# Check for either warning
grep -E "safeStorage|password-store=basic" ~/.local/state/claude-cowork/logs/startup.log
```

If the keyring is in use, neither warning appears. (The AUR `claude-cowork` launcher does not
write `startup.log`; use the `dbus-send` check instead.)

## Security Notes

### With Keyring (Recommended)
- Tokens stored encrypted with a key held in the system keyring
- Protected by your login password (or keyring password)
- Secure cross-session persistence

### Without Keyring
- Tokens not persisted between sessions, per Claude Desktop's warning
- Re-authentication required each startup

## Troubleshooting

### "No such interface 'org.freedesktop.Secret.Service'"

The keyring daemon isn't running. Start it:

```bash
gnome-keyring-daemon --start --components=secrets
```

### Keyring Unlocking Prompts

If you get repeated unlock prompts, set the default keyring's password to match your login
password with Seahorse, the GNOME keyring manager:

```bash
seahorse
```

### Still Not Working?

The launcher's check needs `dbus-send` (from the `dbus` package) and a session bus:

```bash
which dbus-send
echo $DBUS_SESSION_BUS_ADDRESS
```

If `dbus-send` is missing, install `dbus`. If `DBUS_SESSION_BUS_ADDRESS` is empty, your
desktop environment's startup isn't exporting the session bus to the environment you launch
Claude Desktop from; the `dbus-update-activation-environment --all` lines below fix this
for most window managers.

### WSL2

Stock WSL2 has no Secret Service, so the launcher uses the basic password store and you sign
in again after each WSL restart. See the WSL2 section of [FAQ.md](FAQ.md#wsl2).

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
Should work out of the box. If not, the keyring package might not be installed.

## Summary

**The warning is harmless but annoying.** Running a Secret Service provider before you launch:
- Saves you from re-authenticating every session
- Encrypts stored tokens with a keyring-held key

Most users want Option 1 (gnome-keyring), as it works on any desktop environment.
