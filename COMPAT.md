# Compatibility

This file tracks which Claude Desktop asar versions have been verified
to work with claude-cowork-linux. `install.sh` and the launcher grep the
machine-readable lines below; the table further down is for humans.

<!-- machine-readable; do not remove the next two lines -->
<!-- LAST_TESTED_ASAR_VERSION=1.6259.1 -->
<!-- LAST_TESTED_DATE=2026-05-14 -->

## Tested versions

| Asar     | Status     | Date       | Notes                                                |
|:---------|:-----------|:-----------|:-----------------------------------------------------|
| 1.6259.1 | [OK]       | 2026-05-14 | v5.1.0 baseline. Activity stubs and bridge rails verified via test suite. |
| 1.6608.2 | [PARTIAL]  | 2026-05-07 | `/setup-cowork` reports "Unsupported platform: linux-x64" -- see issue #114. |
| 1.6700.0 | [UNTESTED] | -          | Not yet exercised by any contributor.                |

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

| Asar     | CDN URL (Anthropic)                                                                                   | SHA-256 |
|:---------|:------------------------------------------------------------------------------------------------------|:--------|
| 1.6259.1 | `https://downloads.claude.ai/releases/darwin/universal/1.6259.1/Claude-5095e7dddcba4ca974d351ee397e17d204814f07.dmg` | `98c9de8dde01f083b73e7ef08cfaf7adfd2c1386e88d2995b4202dea1a31e898` |

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

## Reporting a tested version

Open a PR that bumps `LAST_TESTED_ASAR_VERSION` (the HTML comment line
above) and adds a row to the table. In the PR body, include:

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
