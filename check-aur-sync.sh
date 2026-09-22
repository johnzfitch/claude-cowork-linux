#!/bin/bash
# ============================================================
# Is the published AUR package still the recipe in this tree?
# ============================================================
#
# WHY THIS EXISTS (issue #189)
# ----------------------------
# A reporter's `yay -S claude-cowork-linux` failed with "Platform-gate function
# not found in .../index.js". That reads as another per-version pattern
# mismatch (#166, #185) and was diagnosed as one twice before anyone compared
# versions. It was not a pattern problem at all:
#
#   * The AUR package was 1.1.4010-10. pkgrel 10 is the last release the publish
#     workflow succeeded in pushing -- run 8, 2026-03-26.
#   * Split-entry chunk sweeping, the thing the failing build needed, landed in
#     pkgrel 12.
#   * Every "Publish to AUR" run since 2026-04-23 failed. The current failure is
#     a malformed AUR_SSH_KEY secret, which only a repo admin can fix.
#
# So the recipe users install froze two pkgrels before the fix for the bug they
# were hitting, and nothing in this repo noticed for five months. The publish
# workflow going red is not the same signal as the package being stale: the
# workflow only runs when PKGBUILD or .SRCINFO changes, its failures are a line
# in an Actions list nobody reads, and a green run history says nothing about
# whether AUR ever received the push.
#
# This script closes that gap by asking the AUR what it actually serves.
#
# NON-BLOCKING BY DEFAULT
# -----------------------
# Plain runs report and exit 0. That is deliberate, not timidity: the drift this
# script exists to find can only be cleared by a repo admin re-adding a secret,
# so failing on it would pin every PR's CI red for reasons no contributor can
# act on -- the exact dynamic that let #170's packaging drift sit unfixed. The
# report lands as a job-summary table and a ::warning:: annotation instead.
#
# Pass --strict to exit non-zero on drift. Useful from a maintainer's shell, and
# the switch to flip once the publish pipeline is trustworthy again.
#
# Usage:
#   ./check-aur-sync.sh [--strict] [--pkgbuild PATH]

set -uo pipefail

STRICT=0
PKGBUILD_PATH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --strict)   STRICT=1; shift ;;
    --pkgbuild) PKGBUILD_PATH="${2:-}"; shift 2 ;;
    -h|--help)  sed -n '2,45p' "$0"; exit 0 ;;
    *)          echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$PKGBUILD_PATH" ] || PKGBUILD_PATH="$SCRIPT_DIR/PKGBUILD"

if [ ! -f "$PKGBUILD_PATH" ]; then
  echo "ERROR: no PKGBUILD at $PKGBUILD_PATH" >&2
  exit 2
fi

# Read the static assignments only. pkgver() recomputes the version from the
# live DMG API at build time, but what AUR publishes is this static pkgver plus
# pkgrel, which is also what .SRCINFO records -- so this is the pair to compare.
# grep the first bare assignment rather than sourcing: sourcing a PKGBUILD runs
# whatever else is in it.
PKGNAME="$(grep -m1 '^pkgname=' "$PKGBUILD_PATH" | cut -d= -f2- | tr -d "\"'")"
REPO_PKGVER="$(grep -m1 '^pkgver=' "$PKGBUILD_PATH" | cut -d= -f2- | tr -d "\"'")"
REPO_PKGREL="$(grep -m1 '^pkgrel=' "$PKGBUILD_PATH" | cut -d= -f2- | tr -d "\"'")"

if [ -z "$PKGNAME" ] || [ -z "$REPO_PKGVER" ] || [ -z "$REPO_PKGREL" ]; then
  echo "ERROR: could not read pkgname/pkgver/pkgrel from $PKGBUILD_PATH" >&2
  exit 2
fi

REPO_VERSION="${REPO_PKGVER}-${REPO_PKGREL}"

echo "repo recipe:     ${PKGNAME} ${REPO_VERSION}"

# ── Ask the AUR what it serves ──────────────────────────────────────────────
RPC="https://aur.archlinux.org/rpc/v5/info?arg[]=${PKGNAME}"
RAW=""
if command -v curl >/dev/null 2>&1; then
  RAW="$(curl -fsSL --max-time 30 --retry 2 --retry-delay 3 "$RPC" 2>/dev/null || true)"
fi

emit_summary() {
  # $1 = status word, $2 = detail line
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  {
    echo "### AUR sync: $1"
    echo
    echo "| | version |"
    echo "|:--|:--|"
    echo "| this tree | \`${REPO_VERSION}\` |"
    echo "| published on AUR | \`${AUR_VERSION:-unknown}\` |"
    echo
    echo "$2"
  } >> "$GITHUB_STEP_SUMMARY"
}

if [ -z "$RAW" ]; then
  # A third party being unreachable is not this repo's defect. Say so and pass:
  # a check that goes red when aur.archlinux.org has a bad minute teaches people
  # to ignore it, and then it is worth nothing when it is right.
  echo "AUR:             unreachable (could not query $RPC)"
  echo "::notice::Could not reach the AUR RPC; sync with ${REPO_VERSION} not verified."
  AUR_VERSION=""
  emit_summary "not verified" "The AUR RPC could not be reached, so this run proves nothing either way."
  exit 0
fi

# python3 rather than jq: present on GitHub runners and in archlinux base-devel,
# jq is neither by default.
read -r AUR_COUNT AUR_VERSION AUR_MODIFIED <<<"$(
  printf '%s' "$RAW" | python3 -c '
import json, sys, datetime
try:
    d = json.load(sys.stdin)
except ValueError:
    print("-1 - -"); sys.exit(0)
results = d.get("results") or []
if not results:
    print("0 - -"); sys.exit(0)
r = results[0]
ver = r.get("Version") or "-"
mod = r.get("LastModified")
try:
    mod = datetime.datetime.fromtimestamp(int(mod), datetime.timezone.utc).strftime("%Y-%m-%d")
except (TypeError, ValueError):
    mod = "-"
print(f"{len(results)} {ver} {mod}")
'
)"

if [ "$AUR_COUNT" = "-1" ]; then
  echo "AUR:             unparseable response from $RPC"
  echo "::notice::AUR RPC returned something that is not JSON; sync not verified."
  AUR_VERSION=""
  emit_summary "not verified" "The AUR RPC response could not be parsed."
  exit 0
fi

if [ "$AUR_COUNT" = "0" ]; then
  echo "AUR:             no package named ${PKGNAME}"
  echo "::warning::The AUR has no package named ${PKGNAME}. It was never published, or it was deleted."
  AUR_VERSION="absent"
  emit_summary "package absent" "The AUR has no \`${PKGNAME}\`. Nothing is being served to \`yay -S\` users."
  [ "$STRICT" = "1" ] && exit 1
  exit 0
fi

echo "AUR published:   ${PKGNAME} ${AUR_VERSION} (last modified ${AUR_MODIFIED})"

if [ "$AUR_VERSION" = "$REPO_VERSION" ]; then
  echo "IN SYNC"
  emit_summary "in sync" "\`yay -S ${PKGNAME}\` builds the recipe in this tree."
  exit 0
fi

# ── Drift ───────────────────────────────────────────────────────────────────
cat <<MSG

DRIFT: the AUR serves ${AUR_VERSION}, this tree carries ${REPO_VERSION}.

  Everyone installing with \`yay -S ${PKGNAME}\` (or any other helper) builds
  ${AUR_VERSION}'s build(), NOT the recipe in this tree. Note that they still get
  this tree's *scripts*: source= clones master with no tag or commit fragment,
  so a stale recipe drives current helpers. That combination is what produced
  the confusing failure in #189.

  To resolve:
    1. Check the most recent "Publish to AUR" run for the real error:
       https://github.com/johnzfitch/claude-cowork-linux/actions/workflows/aur-publish.yml
    2. A malformed or missing AUR_SSH_KEY is the failure that caused #189, and
       only a repo admin can re-add it:
         ssh-keygen -t ed25519 -N '' -f aur_key
       then paste ALL of aur_key (including the trailing newline) into the
       AUR_SSH_KEY repo secret, and register aur_key.pub on the AUR account.
    3. Re-run the workflow (workflow_dispatch) and re-run this check.
MSG

echo "::warning::AUR serves ${PKGNAME} ${AUR_VERSION} but this tree carries ${REPO_VERSION}. Users installing from the AUR are not getting this recipe."
emit_summary "DRIFT" "Users installing from the AUR build \`${AUR_VERSION}\`'s recipe, not this tree's. See the job log for how to resolve."

[ "$STRICT" = "1" ] && exit 1
exit 0
