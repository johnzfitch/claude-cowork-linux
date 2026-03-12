#!/bin/bash
#
# tools/fetch-dmg.sh — Download latest Claude Desktop DMG
#
# This is an OPTIONAL convenience tool. It uses rnet (a Python library) to
# bypass Cloudflare on Anthropic's API endpoint, then downloads the DMG
# with plain curl from the CDN.
#
# Usage:
#   tools/fetch-dmg.sh                    # Download to current directory
#   tools/fetch-dmg.sh ~/Downloads        # Download to specific directory
#   tools/fetch-dmg.sh --url-only         # Print CDN URL without downloading
#
# Then install:
#   ./install.sh ./Claude-*.dmg
#
# Requirements: python3, pip (rnet is installed automatically in a temp venv)

set -euo pipefail

RNET_PIP_SPEC="rnet>=3.0.0rc14"
MIN_DMG_SIZE=100000000

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die() { log_error "$@"; exit 1; }

# Find fetch-dmg.py relative to this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FETCH_SCRIPT=""
for candidate in "$REPO_ROOT/fetch-dmg.py" "$SCRIPT_DIR/fetch-dmg.py"; do
    if [[ -f "$candidate" ]]; then
        FETCH_SCRIPT="$candidate"
        break
    fi
done
[[ -n "$FETCH_SCRIPT" ]] || die "fetch-dmg.py not found"

# Parse args
OUTPUT_DIR="."
URL_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --url-only) URL_ONLY=true ;;
        *) OUTPUT_DIR="$arg" ;;
    esac
done

# Set up temporary venv with rnet
VENV_DIR=$(mktemp -d)
cleanup() { rm -rf "$VENV_DIR" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

log_info "Installing rnet in temporary venv..."
python3 -m venv "$VENV_DIR" || die "Failed to create Python venv (is python3-venv installed?)"

if ! "$VENV_DIR/bin/pip" install --quiet --pre "$RNET_PIP_SPEC" 2>/dev/null; then
    die "Failed to install rnet from PyPI. You can download the DMG manually from https://claude.ai/download"
fi

# Fetch metadata
log_info "Querying Anthropic API for latest DMG..."
DMG_URL=$("$VENV_DIR/bin/python3" "$FETCH_SCRIPT" --url 2>/dev/null) || \
    die "Failed to fetch DMG URL from API"
DMG_VERSION=$("$VENV_DIR/bin/python3" "$FETCH_SCRIPT" 2>/dev/null | awk '{print $1}') || \
    DMG_VERSION="unknown"

if $URL_ONLY; then
    echo "$DMG_URL"
    exit 0
fi

log_info "Latest version: $DMG_VERSION"
log_info "CDN URL: $DMG_URL"

# Download
mkdir -p "$OUTPUT_DIR"
DMG_PATH="$OUTPUT_DIR/Claude-${DMG_VERSION}.dmg"

log_info "Downloading to $DMG_PATH ..."
if ! curl -fSL --progress-bar -o "$DMG_PATH" "$DMG_URL"; then
    die "Download failed"
fi

# Validate size
SIZE=$(stat -c%s "$DMG_PATH" 2>/dev/null || echo 0)
if [[ "$SIZE" -lt "$MIN_DMG_SIZE" ]]; then
    rm -f "$DMG_PATH"
    die "Downloaded file too small (${SIZE} bytes) — may be a Cloudflare block page"
fi

log_success "Downloaded: $DMG_PATH ($(numfmt --to=iec "$SIZE" 2>/dev/null || echo "${SIZE} bytes"))"
echo ""
echo "Install with:"
echo "  ./install.sh $DMG_PATH"
