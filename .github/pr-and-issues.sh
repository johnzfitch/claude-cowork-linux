#!/bin/bash
#
# Run this script after authenticating with `gh auth login` to:
#   1. Update PR #36 with full title and description
#   2. Comment on and close resolved issues (#35, #33, #31)
#   3. Comment on issue #28 (leave open — upstream GNOME limitation)
#   4. Comment on PR #32 (acknowledge + recommend close)
#
# Usage:
#   gh auth login
#   bash .github/pr-and-issues.sh

set -euo pipefail

REPO="johnzfitch/claude-cowork-linux"

echo "=== Step 1: Update PR #36 ==="
gh pr edit 36 --repo "$REPO" \
  --title "fix: resolve issues #28, #33, #35; update #31; incorporate PR #32 improvements" \
  --body "$(cat <<'PRBODY'
## Summary

Addresses multiple open issues and incorporates key improvements from PR #32:

- **#35**: Tolerate 7z exit codes 1-2 during DMG extraction (macOS `/Applications` symlink warning is non-fatal on Linux)
- **#34**: Remove all hardcoded `/home/zack` developer paths — use `SCRIPT_DIR` and `os.homedir()` instead
- **#33**: Always create `resources/i18n/` directory and validate i18n JSON files exist post-extraction with clear warning
- **#31**: Update README subscription requirement from "Claude account" to "Claude Pro (or higher)"
- **#28**: Add runtime GNOME Wayland warning for GlobalShortcuts portal limitation; update README compatibility notes
- **PR #32**: Incorporate openSUSE zypper package fixes (`7zip`, `nodejs-default`, `npm`), Linuxbrew/mise/asdf binary resolution paths, and missing Swift stub methods (`api.setCredentials()`, `quickAccess.overlay.*`, `quickAccess.dictation.*`)

### Files changed (7)

| File | Changes |
|------|---------|
| `install.sh` | 7z exit code tolerance, i18n validation, openSUSE zypper packages |
| `test-flow.sh` | Replace hardcoded `/home/zack` with `SCRIPT_DIR` |
| `test-launch.sh` | GNOME Wayland GlobalShortcuts warning |
| `cowork/sdk_bridge.js` | `os.homedir()` fallback, Linuxbrew/mise/asdf binary paths |
| `stubs/@ant/claude-swift/js/index.js` | Linuxbrew/mise/asdf paths, `api.setCredentials()`, `quickAccess.overlay.*`, `quickAccess.dictation.*` stubs |
| `README.md` | Pro tier, openSUSE "Tested", GNOME shortcuts clarity, `7zip` note |
| `docs/extensions.md` | Replace `/home/zack` with `/home/user` in examples |

## Test plan

- [x] `bash -n install.sh` / `bash -n test-flow.sh` / `bash -n test-launch.sh` — all pass
- [x] `node -c stubs/@ant/claude-swift/js/index.js` / `node -c cowork/sdk_bridge.js` / `node -c linux-loader.js` — all pass
- [x] `grep -rn "/home/zack"` across all `.js`, `.sh`, `.md` files — zero matches
- [x] Security scan: no secrets, no `eval()`, no string-form `exec()`, `redactForLogs()` in use
- [x] Cross-distro package verification: Arch (`p7zip`), Ubuntu (`p7zip-full`), Fedora (`p7zip`), openSUSE (`7zip` + `nodejs-default` + `npm`), NixOS (`nixpkgs.p7zip`)
- [x] Wayland detection: `ELECTRON_OZONE_PLATFORM_HINT=wayland` set correctly; GNOME substring match handles `ubuntu:GNOME`
- [x] Binary resolution: Swift stub and sdk_bridge.js candidate lists now consistent (8 paths each)

Closes #33, closes #35. Updates #31, #28.
PRBODY
)"

echo "=== Step 2: Comment + close issue #35 (7z exit code) ==="
gh issue comment 35 --repo "$REPO" --body "Fixed in PR #36. The installer now tolerates 7z exit codes 1 and 2 (the macOS \`/Applications\` symlink warning is non-fatal on Linux). Exit codes >2 still fail. A warning is logged when codes 1 or 2 are encountered.

See: install.sh lines 314-323."
gh issue close 35 --repo "$REPO"

echo "=== Step 3: Comment + close issue #33 (i18n ENOENT) ==="
gh issue comment 33 --repo "$REPO" --body "Fixed in PR #36. The installer now:
- Always creates \`resources/i18n/\` before attempting to move JSON files
- Validates that at least one i18n JSON file exists after extraction
- Warns with a clear message if files are missing, suggesting a fresh DMG download

This ensures the \`ENOENT\` for \`resources/i18n/en-US.json\` won't silently occur."
gh issue close 33 --repo "$REPO"

echo "=== Step 4: Comment + close issue #31 (Claude Pro tier) ==="
gh issue comment 31 --repo "$REPO" --body "Updated in PR #36. The README now reads \"Claude Pro (or higher) subscription for Cowork access\" in the requirements section. Thanks for catching this!"
gh issue close 31 --repo "$REPO"

echo "=== Step 5: Comment on issue #28 (GNOME shortcuts — leave open) ==="
gh issue comment 28 --repo "$REPO" --body "PR #36 adds a runtime warning when GNOME+Wayland is detected, informing users to configure shortcuts via GNOME Settings. The README compatibility table has also been updated with clearer guidance.

The underlying limitation remains an upstream GNOME issue (xdg-desktop-portal-gnome doesn't implement the GlobalShortcuts portal). The \`--enable-features=GlobalShortcutsPortal\` flag is included for KDE/Hyprland where it works. Keeping this open to track upstream GNOME progress."

echo "=== Step 6: Comment on PR #32 (acknowledge + recommend close) ==="
gh pr comment 32 --repo "$REPO" --body "Thank you @alpham8 for the thorough openSUSE testing and the confirm-before-quit work!

PR #36 incorporates several key changes from this PR:
- **openSUSE zypper packages**: \`7zip\` + \`nodejs-default\` + \`npm\` (added npm explicitly as a safety measure)
- **Linuxbrew/mise/asdf binary resolution**: Added all fallback paths to both the Swift stub and sdk_bridge.js
- **openSUSE status**: Updated from \"Untested\" to \"Tested\" in the README
- **Swift stub methods**: Added \`api.setCredentials()\`, \`quickAccess.overlay.*\`, and \`quickAccess.dictation.*\`

The confirm-before-quit dialog is a larger behavioral change that could be submitted separately. Recommending this PR be closed in favor of #36 for the incorporated changes, and a follow-up PR for the quit dialog if desired."

echo ""
echo "=== Done ==="
echo "PR #36 updated, issues #35/#33/#31 closed, #28 commented, PR #32 commented."
echo "Issue #28 left open (upstream GNOME limitation)."
echo "Issue #37 left open (separate feature request, not in scope)."
echo "PR #32 left open for maintainer/author to close."
