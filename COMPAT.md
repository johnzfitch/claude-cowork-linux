# Compatibility

This file tracks which Claude Desktop asar versions have been verified
to work with claude-cowork-linux. `install.sh` and the launcher grep the
machine-readable lines below; the table further down is for humans.

<!-- machine-readable; do not remove the next two lines -->
<!-- LAST_TESTED_ASAR_VERSION=1.28929.0 -->
<!-- LAST_TESTED_DATE=2026-08-14 -->

## Tested versions

| Asar      | Status     | Date       | Notes                                                |
|:----------|:-----------|:-----------|:-----------------------------------------------------|
| 1.6259.1  | [OK]       | 2026-05-14 | v5.1.0 baseline. Activity stubs and bridge rails verified via test suite. |
| 1.6608.2  | [PARTIAL]  | 2026-05-07 | `/setup-cowork` reports "Unsupported platform: linux-x64" -- see issue #114. |
| 1.6700.0  | [UNTESTED] | -          | Not yet exercised by any contributor.                |
| 1.19367.0 | [OK]       | 2026-07-15 | First **split-entry** build: `index.pre.js` + `index.js` shim that require()s the real code from `index.chunk-*.js`. Requires the entry-routing fix (#154/#157) and chunk-aware patching (install.sh/launch.sh/enable-cowork.py discover and patch the chunk; identifier matching generalized for per-build minifier rotation). End-to-end launch + Cowork session reported by contributors in #152/#154; patch logic covered by `tests/test-cowork-patch.sh`. Not re-exercised via a GUI session by a maintainer. |
| 1.20186.0 | [PARTIAL]  | 2026-07-15 | Split-entry bundle; installer/launcher patching applies as on 1.19367.0. The **AUR** `PKGBUILD` still needs split-bundle handling and a `package.json` `main` rewrite -- see #156. Contributor reports the packed app reaches startup and passes the test suite on this version. |
| 1.22209.x | [PARTIAL]  | 2026-07-23 | Two contract changes land here, both handled in #160. CoworkSpaces file ops changed from `(path)` to `(spaceId, path)` (the stubs accept both shapes, so a rollback still works), and artifact/upload/attachment/transcript writes moved to a native safe-fs API (`openRootDir` + `*Beneath`), implemented for Linux in `stubs/@ant/claude-native/safe_fs.js`. Contributor-reported live; not exercised by a maintainer. |
| 1.24012.9 | [PARTIAL]  | 2026-08-01 | Local MCP servers failed to connect ("Server disconnected" before any JSON-RPC): the bundle routes MCP spawns through the macOS disclaimer wrapper, which our unwrap rejected for user-installed binaries, and `realpath` walked npm-global shims out of the allowlist entirely (#164). Fixed by removing the unwrap's per-callsite carve-out so admission runs through the one shared rule, and by admitting user binaries the user declared as MCP servers instead of any file sitting in a user-writable directory. Contributor-reported; fix not exercised by a maintainer on this build. The 1.24012.1 `DeviceRegistry` blocker below is unrelated and still applies. |
| 1.24012.1 | [PARTIAL]  | 2026-07-24 | Cowork sessions fail to link: the asar's own `DeviceRegistry.signCreateSessionBind` throws "device not registered (no row-PK for this account)", producing the "Couldn't link this session to a computer" banner. Not stubbable -- signing that binding here would forge a device-identity check (see #161). `BuddyBleTransport.reportState`, reported alongside it, is stubbed as a no-op. |
| 1.28929.0 | [OK]       | 2026-08-14 | Adds `index2.chunk-*`, uses backticks and `let` in the Cowork platform gate, and distributes IPC guards across auxiliary chunks. Large internal MCP results also need host `Read` access to SDK-owned `.claude/projects/*/tool-results/*` files. Verified on Fedora 44 + GNOME Wayland with Electron 43.2.0: update/extract/repack, Cowork session start, tool permission prompts, and Visualize `read_me`/`show_widget` through iframe `firstrender` and `complete`. |

Status legend:

- `[OK]`       -- end-to-end exercised, ships clean.
- `[PARTIAL]`  -- launches and most features work, but at least one known regression. See Notes.
- `[FAIL]`     -- known to be broken; do not update to this version.
- `[UNTESTED]` -- no contributor has reported results.

## Pinning a tested version

This project never hosts or redistributes the Claude Desktop archive --
the binary is Anthropic's and the installer always fetches it from
Anthropic's own CDN (the same place `claude-desktop --update` pulls the
latest from). What we *can* record here is a pointer to a known-good
build plus its checksum, so that if the latest CDN release regresses you
can fetch the last tested version yourself and verify the bytes match
what was exercised.

| Asar      | CDN URL (Anthropic)                                                                                   | SHA-256 |
|:----------|:------------------------------------------------------------------------------------------------------|:--------|
| 1.6259.1  | `https://downloads.claude.ai/releases/darwin/universal/1.6259.1/Claude-5095e7dddcba4ca974d351ee397e17d204814f07.dmg` | `98c9de8dde01f083b73e7ef08cfaf7adfd2c1386e88d2995b4202dea1a31e898` |
| 1.19367.0 | `https://downloads.claude.ai/releases/darwin/universal/1.19367.0/Claude-1a5be1fbf83d1832486e03a667557c18f0a0ec7a.dmg` | `<pending>` |
| 1.28929.0 | `https://downloads.claude.ai/releases/darwin/universal/1.28929.0/Claude-d1a6bcd4ef8627d603a8290548a984220b6701cf.zip` | `d56ea682de438242b9fd142b0e4f8b55ba65c01a4ab22def02e881ef924bde8a` |

The URL for each release embeds a per-release hash, so it cannot be
constructed from the version number -- a build has a pinnable URL only if
someone recorded it here. `install.sh` reads this table: when you answer
`t` ("show instructions for installing the tested version") at the
download prompt, it prints the recorded URL and checksum for
`LAST_TESTED_ASAR_VERSION` directly, and tells you plainly when there is
no row rather than printing a placeholder you cannot fill in (#165).

The 1.19367.0 URL was contributed in #165 and has not been re-fetched or
checksummed by a maintainer; it is a `.dmg`, so the LZFSE note below may
apply. If you download it, please compute the SHA-256 and open a PR
filling in the `<pending>` cell.

To pin and verify a tested version:

```sh
# 1. Download the tested build directly from Anthropic's CDN. Use -o to name
#    the file predictably; curl -fLO would keep the long hash-based filename.
curl -fL -o Claude-1.6259.1.dmg "<CDN URL from the table above>"

# 2. Verify the checksum matches the SHA-256 recorded above.
sha256sum Claude-1.6259.1.dmg

# 3. Install from the verified archive (the installer does not re-download).
CLAUDE_ARCHIVE="$PWD/Claude-1.6259.1.dmg" bash install.sh
```

These URLs and checksums are best-effort pointers contributed by users,
not an endorsement to redistribute. If a recorded SHA-256 shows
`<pending>`, compute it locally and open a PR to fill it in.

> **Note on DMG vs ZIP:** older `.dmg` CDN URLs now serve LZFSE-compressed
> images that `p7zip`/`7zz` cannot open. Recent releases ship as `.zip`
> (the artifact the Homebrew cask tracks), which extracts cleanly — prefer
> the `.zip` when pinning. `node fetch-dmg.js --json` prints the current
> version, `.zip` URL, and SHA-256.

## Reporting a tested version

Open a PR that bumps `LAST_TESTED_ASAR_VERSION` (the HTML comment line
above), adds a row to the tested-versions table, and **adds the archive
you tested to the pinning table too** -- the CDN URL you downloaded from,
plus `sha256sum` of that exact file.

Without that row the next person has a version number recorded as working
and no way to obtain it: the URL is not derivable from the version, and
`install.sh`'s "install the tested version" path has nothing to print.
That was #165. `tests/test-compat-pins.sh` checks that whatever
`LAST_TESTED_ASAR_VERSION` points at has a pinning row.

In the PR body, include:

1. Distro and desktop environment (e.g. "Arch Linux + Hyprland (Wayland)").
2. Electron version (`electron --version` from your install).
3. Which features you exercised:
   - First-run install via `install.sh`
   - Login via the `claude://` OAuth callback
   - Cowork session start with a tool permission prompt
   - In-app shell / PTY panel
   - At least one MCP tool call

Reports that only confirm "the app launches" are useful but should be
flagged with `[PARTIAL]` until a fuller exercise is recorded.

## Why this file exists

`install.sh` no longer auto-downloads the latest Claude Desktop asar
without prompting. The installer reads `LAST_TESTED_ASAR_VERSION` from
this file, fetches the latest version available on Anthropic's CDN, and
warns if the latest is newer than the last tested. The user decides
whether to proceed.

The launcher (`claude-desktop`, `claude-cowork`) reads the installed
asar version from `$INSTALL_DIR/.installed-asar-version` (written by
`install.sh` at the end of install/update) and prints a `[WARN]` line
to stderr if the installed version is newer than the last tested. The
warning fires once per version change -- after the user sees it once,
they will not see it again for the same installed asar.

To re-trigger the warning manually, delete
`$XDG_STATE_HOME/claude-cowork/logs/.last-warned-asar-version`.

## See also

- README.md "Recovery" section for what to do if your install breaks
  after an update.
- `install.sh --doctor` reports the installed-vs-tested version state
  as an `[OK]` or `[WARN]` line.
- `claude-desktop --update` re-runs the download/extract/repack flow
  with the same prompt as a fresh install.
