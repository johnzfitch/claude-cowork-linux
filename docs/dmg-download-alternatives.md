# DMG Download Design Alternatives

**Context:** The installer needs the Claude Desktop macOS DMG to extract `app.asar`.
Anthropic's API endpoint (`claude.ai/api/desktop/darwin/universal/dmg/latest`) is behind
Cloudflare bot protection, so plain `curl`/`wget` gets blocked. The CDN URL returned by
the API works fine with `curl`. Anthropic does not publish SHA-256 checksums for DMG files.

This document compares three alternative designs, ranked by security hygiene.

---

## Option A: Manual-only (remove auto-download entirely)

**Approach:** Remove `fetch-dmg.py` and `rnet` from the install path entirely. The
installer only accepts a DMG via argument or `CLAUDE_DMG=` env var, or watches the
Downloads folder after opening the browser.

**Security:** Best. Zero third-party dependencies in the download chain. User
downloads the DMG themselves from `claude.ai/download` — same trust model as any
other app install.

**UX:** Requires manual browser download on every install/update. The existing
browser-download-and-watch flow handles this gracefully (opens page, waits for
file to appear in ~/Downloads).

**PKGBUILD impact:** `pkgver()` must use a pinned version (updated with releases)
rather than querying the API. This is actually more reliable for AUR builds.

See: `prototypes/option-a-install.sh.patch`, `prototypes/option-a-PKGBUILD.patch`

---

## Option B: Separate opt-in fetch tool

**Approach:** Extract rnet usage into a standalone `tools/fetch-dmg.sh` that users
can run independently. The installer itself never touches rnet — it only accepts a
DMG path. Power users who want automation run the fetch tool first, then pass the
result to the installer.

**Security:** Good. rnet is still used but isolated from the critical install path.
Users who don't trust it simply skip it. The fetch tool is clearly opt-in and can
be audited independently.

**UX:** Two-step for auto-download users (`tools/fetch-dmg.sh && ./install.sh`),
but can be combined in a one-liner. AUR PKGBUILD can use the tool in `prepare()`.

See: `prototypes/option-b-fetch-dmg.sh`, `prototypes/option-b-install.sh.patch`,
     `prototypes/option-b-PKGBUILD.patch`

---

## Option C: Pinned version + direct CDN URL

**Approach:** Ship a `DMG_VERSION` and `DMG_URL` in the repo that get updated with
each release. No API call needed — the CDN URL is known. A `tools/update-dmg-url.sh`
helper (using rnet) is provided for maintainers to refresh the pinned URL, but end
users never run it.

**Security:** Good. End users never run rnet. The URL is auditable in the repo.
The CDN download uses plain curl with size validation.

**UX:** Best for end users (fully automatic, no extra deps). Slightly more
maintainer burden (must update the pinned URL on each Claude Desktop release).

See: `prototypes/option-c-install.sh.patch`, `prototypes/option-c-PKGBUILD.patch`,
     `prototypes/option-c-update-dmg-url.sh`

---

## Ranking

| Rank | Option | Security | User Friendliness | Maintainer Burden | Recommendation |
|------|--------|----------|--------------------|-------------------|----------------|
| 1    | **C: Pinned URL** | High (no rnet for users) | High (automatic) | Medium (update URL per release) | **Recommended** |
| 2    | **A: Manual-only** | Highest (zero deps) | Medium (browser download) | Low | Good fallback |
| 3    | **B: Opt-in tool** | Good (isolated rnet) | Medium (two-step) | Low | Good compromise |

**Why C > A:** Option C gives users the same automatic experience they have today
but eliminates rnet from their trust chain. The pinned URL is a plain HTTPS download
from Anthropic's CDN — no different from clicking "Download" on the website. The
maintainer runs the rnet tool once per release, inspects the URL, and commits it.

**Why A > B:** If we're going to keep rnet at all, Option C is strictly better than
B because it confines rnet to the maintainer rather than offering it to users. Option
A is the purist choice if you want zero rnet in the repo at all.

---

## What about SHA-256 verification?

Anthropic's API does not currently return a `sha256` or `checksum` field. PR #42's
`--sha256` flag gracefully degrades (logs a warning) but will never actually verify
anything until Anthropic adds this. Rather than shipping dead verification code, it's
better to:

1. Keep the size check (catches truncated/corrupt downloads)
2. Document that Anthropic doesn't publish checksums
3. If/when they do, add verification at that point

For Option C, the maintainer could manually compute and commit the SHA-256 of each
DMG they test, providing a "known good" hash even without Anthropic publishing one.
This is noted in the Option C prototype.
