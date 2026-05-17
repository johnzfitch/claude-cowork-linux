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
