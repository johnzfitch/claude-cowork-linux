# Security Audit & Hardening — claude-cowork-linux

**Date:** 2026-03-10
**Auditor:** Claude Opus 4.6
**Commit:** See `git log --oneline -1`

---

## Changes Made

### 1. Removed binary wheel download (HIGH → Fixed)

**Before:** `install.sh` and `PKGBUILD` downloaded a precompiled native binary wheel
(`rnet-3.0.0rc14-cp311-abi3-manylinux_2_34_x86_64.whl`) from a GitHub release with
**no checksum verification**. A compromised release could inject arbitrary native code.

**After:** `rnet` is installed from PyPI via `pip install --pre "rnet>=3.0.0rc14"`.
PyPI packages have built-in integrity checks (pip verifies hashes from the package index).

**Files:** `install.sh`, `PKGBUILD`, `.SRCINFO`

### 2. Added SHA-256 checksum verification for DMG downloads (NEW)

**Before:** Downloaded DMG files were only checked for minimum size (100MB).
No integrity verification.

**After:**
- `fetch-dmg.py` extracts `sha256`/`checksum` field from API response (new `--sha256` flag)
- `install.sh` verifies DMG checksum after download using `sha256sum` (new `verify_checksum()`)
- `PKGBUILD` `prepare()` verifies DMG checksum, fails build on mismatch
- If API doesn't provide a hash, a warning is logged (graceful degradation)

**Files:** `fetch-dmg.py`, `install.sh`, `PKGBUILD`

### 3. Restricted `files.*` API to Claude data directories (HIGH → Fixed)

**Before:** `this.files.read()`, `write()`, `exists()`, `stat()`, `list()`, `watch()`
in the Swift stub accepted **arbitrary file paths** with no validation. Combined with
Electron's `--no-sandbox`, this allowed reading/writing any file the user owns.

**After:** All `files.*` methods validate paths against an allowlist:
- `~/Library/Application Support/Claude/` (app data, sessions, configs)
- `~/Library/Logs/Claude/` (log files)
- `~/Library/Caches/Claude/` (cache)

Blocked paths return `Promise.reject(new Error('Access denied: path not allowed'))`.
Path traversal (`..`) is explicitly blocked. All blocked attempts are logged via `trace()`.

**File:** `stubs/@ant/claude-swift/js/index.js`

### 4. Fixed incorrect upstream URL (LOW)

**Before:** README linked to `github.com/nicholasgasior/rnet` (non-existent).
**After:** Corrected to `github.com/0x676e67/rnet` (actual upstream).

**File:** `README.md`

---

## Test Results

```
=== Path validation (19 tests) ===
PASS  ALLOW  config in app support
PASS  ALLOW  project file
PASS  ALLOW  session file
PASS  ALLOW  log file
PASS  ALLOW  cache file
PASS  ALLOW  exact base dir
PASS  BLOCK  /etc/passwd
PASS  BLOCK  /etc/shadow
PASS  BLOCK  SSH key (~/.ssh/id_rsa)
PASS  BLOCK  bashrc
PASS  BLOCK  tmp file
PASS  BLOCK  traversal to SSH (../../../.ssh/id_rsa)
PASS  BLOCK  empty string
PASS  BLOCK  null
PASS  BLOCK  undefined
PASS  BLOCK  other app support dir
PASS  BLOCK  traversal to etc (../../etc/passwd)
PASS  BLOCK  user documents
PASS  BLOCK  root bashrc
19 passed, 0 failed

=== Checksum verification (3 tests) ===
PASS  correct hash accepted
PASS  wrong hash rejected
PASS  empty hash skipped (return code 2)

=== Static analysis (repo test harness stage 1) ===
PASS  install.sh syntax OK
PASS  PKGBUILD syntax OK
PASS  fetch-dmg.py syntax OK
PASS  enable-cowork.py syntax OK
4 passed, 0 failed

=== JS stub syntax ===
PASS  swift stub (index.js)
PASS  native stub (index.js)
PASS  frame-fix wrapper
```

---

## Remaining Risks (not addressed in this patch)

| # | Severity | Issue | Reason not fixed |
|---|----------|-------|------------------|
| 1 | HIGH | `--no-sandbox` in Electron launch | Required on many Linux distros due to user namespace restrictions; bubblewrap may be alternative |
| 2 | HIGH | `curl \| bash` install pattern | Convention issue; users should clone + inspect instead |
| 3 | MEDIUM | Platform spoofing (darwin/arm64) | Core functionality of the project; removing breaks it |
| 4 | MEDIUM | Global `Object.defineProperty` override | Required for feature detection bypass |
| 5 | MEDIUM | Global `os.tmpdir()` override | Required for VM bundle path emulation |
