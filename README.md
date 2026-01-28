# Claude Desktop for Linux

Run Claude Desktop (the official Anthropic desktop app) on Linux using compatibility stubs and bubblewrap sandboxing.

## One-Click Install

```bash
curl -fsSL https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master/install-oneclick.sh | bash
```

That's it! The installer will:
- Install dependencies (7z, node, electron, asar, bubblewrap)
- Download Claude Desktop from Anthropic's CDN
- Extract and patch for Linux compatibility
- Create desktop entry and `claude` command

## Features

- Full Claude Desktop functionality on Linux
- Native file/folder picker dialogs (using Electron's built-in dialog)
- Secure sandbox using bubblewrap (bwrap)
- Hyprland/Wayland window rules included
- Auto-downloads official Claude app (or use your own DMG)

## Manual Installation

If you prefer manual installation or want to use your own DMG:

```bash
# Clone repo
git clone https://github.com/johnzfitch/claude-cowork-linux.git
cd claude-cowork-linux

# Option A: Auto-download (recommended)
./install-oneclick.sh

# Option B: Use your own DMG
CLAUDE_DMG=/path/to/Claude.dmg ./install-oneclick.sh

# Option C: Legacy installer (requires DMG in directory)
mv ~/Downloads/Claude*.dmg .
./install.sh
```

## Requirements

- **Linux** (tested on Arch, Ubuntu, Debian, Fedora)
- **Node.js** >= 18.0.0
- **~500MB disk space**

Dependencies are auto-installed, but for reference:
- `p7zip` / `p7zip-full` - extract DMG
- `nodejs` + `npm` - runtime
- `electron` - app framework
- `@electron/asar` - package extraction
- `bubblewrap` - sandbox (usually pre-installed)

## Usage

```bash
claude                    # Normal launch
claude --debug            # Enable trace logging
claude --devtools         # Enable Chrome DevTools
claude --isolate-network  # Run with network isolation
```

## Directory Structure

```
/Applications/Claude.app/              # App (macOS-style path for compat)
~/Library/Application Support/Claude/  # User data
~/Library/Logs/Claude/                 # Logs
~/Library/Caches/Claude/               # Cache
~/.local/share/claude-cowork/          # Session data
```

## Hyprland Users

Window rules are included:

```bash
cp config/hyprland/claude.conf ~/.config/hypr/
echo 'source = ~/.config/hypr/claude.conf' >> ~/.config/hypr/hyprland.conf
hyprctl reload
```

## Troubleshooting

### App won't start
```bash
cat ~/Library/Logs/Claude/startup.log
claude --debug
```

### File picker doesn't work
Ensure xdg-desktop-portal is running:
```bash
systemctl --user status xdg-desktop-portal
```

### Window appears dimmed (Hyprland)
Add the Claude window rules - see Hyprland section above.

## Security

The app runs inside a bubblewrap sandbox with:
- User namespace isolation
- Read-only system directories (`/usr`, `/bin`, `/lib`, `/etc`)
- Isolated `/tmp` (not shared with host)
- Only home directory is writable
- `/run` and `/var` are NOT mounted (prevents IPC socket access)

Network isolation (optional):
```bash
claude --isolate-network
```

## How It Works

1. **Platform spoofing**: Tricks the app into thinking it's running on macOS
2. **Swift stub**: Replaces native Swift module with JavaScript equivalents
3. **Bubblewrap sandbox**: Creates isolated filesystem namespace
4. **Electron**: Runs the app using system Electron

## Uninstall

```bash
sudo rm -rf /Applications/Claude.app
sudo rm /usr/local/bin/claude
rm -rf ~/Library/Application\ Support/Claude
rm -rf ~/Library/Logs/Claude
rm -rf ~/Library/Caches/Claude
rm -rf ~/.local/share/claude-cowork
rm ~/.local/share/applications/claude.desktop
```

## License

MIT License - see [LICENSE](LICENSE)

## Contributing

Pull requests welcome! Please ensure:
- No proprietary Claude Desktop code is committed
- Test on at least one Linux distribution
- Update documentation as needed

## Disclaimer

This is an unofficial community project. Claude Desktop is a product of Anthropic. This project only provides compatibility layers to run the official app on Linux.
