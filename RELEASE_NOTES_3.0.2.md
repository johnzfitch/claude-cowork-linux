<div align="center">

# v3.0.2 &mdash; Distro Hardening &amp; Preflight Diagnostics

**2026-02-27**

</div>

---

> [!IMPORTANT]
> This release fixes a **breaking change** in Claude Desktop&rsquo;s latest build: the asar now sends bare `claude` as the spawn command instead of `/usr/local/bin/claude`. Without this update, Cowork sessions fail to start.

---

## What Changed

<table>
<thead>
<tr>
<th>Area</th>
<th>Change</th>
<th>Why</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>Spawn&nbsp;command</strong></td>
<td>Accept bare <code>claude</code> and vetted absolute paths, not just <code>/usr/local/bin/claude</code></td>
<td>Claude Desktop changed its spawn call; old stub rejected it as &ldquo;unexpected command&rdquo;</td>
</tr>
<tr>
<td><strong>Password&nbsp;store</strong></td>
<td>Detect <abbr title="freedesktop.org Secret Service D-Bus API">SecretService</abbr> at runtime; fall back to <code>--password-store=basic</code></td>
<td>Hard dependency on <code>gnome-keyring</code> broke KDE-only and minimal installs</td>
</tr>
<tr>
<td><strong>Preflight</strong></td>
<td>New <code>--doctor</code> flag on <code>install.sh</code> and <code>claude-desktop</code></td>
<td>Validates 15 checks: binaries, node version, CLI, <code>/sessions</code>, secret service, patches, stubs</td>
</tr>
<tr>
<td><strong>Plugin&nbsp;listing</strong></td>
<td>Stub <code>CustomPlugins_$_listAvailablePlugins</code> IPC handler</td>
<td>New asar calls this on session start; missing handler caused error spam</td>
</tr>
<tr>
<td><strong>IPC&nbsp;discovery</strong></td>
<td>Dynamic eipc UUID extraction instead of hardcoded value</td>
<td>UUID changes per asar build; hardcoding broke on every update</td>
</tr>
<tr>
<td><strong>Linux&nbsp;UI</strong></td>
<td>Native window frames, icon extraction from <code>.icns</code>, titlebar patch</td>
<td>Removes macOS <code>titleBarOverlay</code>/<code>trafficLightPosition</code> that rendered as blank space</td>
</tr>
<tr>
<td><strong>Asar&nbsp;mounts</strong></td>
<td>Filter out <code>/Applications</code> and other macOS-only mounts</td>
<td>Prevented <code>EACCES</code> errors from trying to symlink <code>/Applications</code> on Linux</td>
</tr>
<tr>
<td><strong>AUR</strong></td>
<td><code>gnome-keyring</code> moved from hard dep to optdep; launcher detects at runtime</td>
<td>KDE/minimal users no longer forced to install gnome-keyring</td>
</tr>
</tbody>
</table>

---

## Compatibility

| Distro | Desktop | Status |
|:-------|:--------|:-------|
| **Arch Linux** | Hyprland / KDE / GNOME | Tested &amp; Expected |
| **Ubuntu 22.04+** | GNOME / X11 | Expected |
| **Fedora 39+** | GNOME / KDE | Expected |
| **Debian 12+** | Any | Expected |
| **NixOS** | Any | Untested |
| **openSUSE Tumbleweed** | KDE Plasma | Tested |

<details>
<summary><strong>Known caveats</strong></summary>

- GNOME Wayland: no global shortcuts (upstream `xdg-desktop-portal-gnome` limitation) &mdash; set a custom shortcut in GNOME Settings instead.
- Without a <abbr title="e.g. gnome-keyring, KeePassXC, KDE Wallet">SecretService provider</abbr>, credentials are stored on disk via `--password-store=basic`.
- The `/sessions` root symlink requires `sudo` once during install.

</details>

---

## Diagnostics

Run preflight checks at any time:

```bash
claude-desktop --doctor      # from launcher
./install.sh --doctor        # from repo
```

<details>
<summary><strong>Example output</strong></summary>

```
==========================================
 Claude Desktop for Linux - Doctor
 Version: 3.0.2
==========================================

[OK] git: /usr/bin/git
[OK] 7z: /usr/bin/7z
[OK] node: ~/.local/share/mise/installs/node/24.13.0/bin/node
[OK] npm: ~/.local/share/mise/installs/node/24.13.0/bin/npm
[OK] electron: ~/.local/bin/electron
[OK] asar: /usr/bin/asar
[OK] bwrap: /usr/bin/bwrap
[OK] Node.js version: v24 (>= 18)
[OK] Claude binary: ~/.local/bin/claude
[OK] /sessions symlink -> ~/.local/share/claude-cowork/sessions
[OK] Secret service (org.freedesktop.secrets): available
[OK] Extracted app: ~/.local/share/claude-desktop/linux-app-extracted
[OK] Cowork patch: applied
[OK] Swift stub: installed
[OK] Python: 3.14.2

==========================================
 15 passed  0 warnings  0 failed
==========================================
```

</details>

---

## Install / Upgrade

<dl>
<dt><kbd>install.sh</kbd> (recommended)</dt>
<dd>

```bash
# Fresh install
git clone https://github.com/johnzfitch/claude-cowork-linux.git
cd claude-cowork-linux && ./install.sh

# Upgrade
cd ~/.local/share/claude-desktop && git pull && ./install.sh
```

</dd>
<dt><kbd>AUR</kbd> (Arch Linux)</dt>
<dd>

```bash
yay -S claude-cowork-linux
```

</dd>
<dt><kbd>curl</kbd> pipe</dt>
<dd>

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master/install.sh)
```

</dd>
</dl>

---

## Commits since v3.0.1

| Commit | Summary |
|:-------|:--------|
| `88d5607` | harden: distro compatibility and preflight diagnostics |
| `a2bd3e5` | refactor: remove tracked ipc handler and align launcher runtime |
| `bf59c0d` | refactor: track ipc-handler-setup.js at repo root |
| `10710b6` | fix: implement CustomPlugins listAvailablePlugins via CLI |
| `73c9d44` | fix: stub CustomPlugins to prevent spawn errors |
| `da832b8` | fix: skip asar mounts in Cowork sessions |
| `b1d9ae3` | fix: add Linux UI fixes to launcher |
| `947e497` | fix: dynamic eipc UUID discovery and i18n path fix |
| `83ea15c` | docs: fix outdated README information |
| `d2925ec` | docs: update patch verification |
| `2a25387` | chore: sync PKGBUILD with AUR |

---

## Contributors

Thanks to the community members whose work landed in this release:

- **[@Boermt-die-Buse](https://github.com/Boermt-die-Buse)** &mdash; Linux UI fixes: native window frames, titlebar patch, icon extraction ([PR&nbsp;#29](https://github.com/johnzfitch/claude-cowork-linux/pull/29))
- **[@JaPossert](https://github.com/JaPossert)** &mdash; Resources copy fix preventing startup crash ([PR&nbsp;#27](https://github.com/johnzfitch/claude-cowork-linux/pull/27)), Wayland global shortcuts report ([#28](https://github.com/johnzfitch/claude-cowork-linux/issues/28))

---

<div align="center">

**[Full diff](https://github.com/johnzfitch/claude-cowork-linux/compare/v3.0.1...v3.0.2)** &middot; **[README](https://github.com/johnzfitch/claude-cowork-linux#readme)** &middot; **[Issues](https://github.com/johnzfitch/claude-cowork-linux/issues)**

MIT License &mdash; See [LICENSE](LICENSE) for details.

</div>
