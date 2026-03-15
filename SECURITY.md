# Security Policy

## Scope

This project is a Linux compatibility layer for Claude Desktop's Cowork feature.
It stubs macOS-native modules so the unmodified Electron app runs on Linux.
The layer does not implement OAuth flows, store credentials, or make API calls.
See [OAUTH-COMPLIANCE.md](docs/OAUTH-COMPLIANCE.md) for a full audit of credential handling.

Vulnerabilities in Claude Desktop itself or the Claude Code CLI should be reported
directly to Anthropic at <https://www.anthropic.com/security>.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities by emailing: **zack@johnzfitch.com**

Include:
- A description of the vulnerability and its impact
- Steps to reproduce (command, environment, distro/DE)
- Whether you believe it affects credential handling, token passthrough, or process spawning

## What Counts as a Vulnerability Here

Areas of highest sensitivity in this codebase:

| Area | File | Risk |
|------|------|------|
| Token passthrough | `stubs/@ant/claude-swift/js/index.js` -- `filterEnv()` | OAuth token leaking to unexpected processes |
| Process spawning | `stubs/@ant/claude-swift/js/index.js` -- `spawn()` | Command injection via path or env var |
| Auth URL validation | `stubs/@ant/claude-native/index.js` -- `AuthRequest.start()` | Open redirect to non-Anthropic domain |
| Log redaction | `stubs/@ant/claude-swift/js/index.js` -- `redactForLogs()` | Token appearing in trace log |
| Path traversal | `stubs/@ant/claude-swift/js/index.js` -- `isPathSafe()` | Session path escaping SESSIONS_BASE |
| Credential detection | `stubs/cowork/credential_classifier.js` | False negatives allowing token leakage |
| HTTP header injection | `stubs/cowork/sessions_api.js` | CRLF injection in API headers |
| File descriptor bounds | `stubs/cowork/sessions_api.js` | FD exhaustion or out-of-bounds access |
| Asar path handling | `stubs/cowork/asar_adapter.js` | Path traversal in asar file operations |

## Response Commitment

- Acknowledgement within **48 hours**
- Assessment and patch timeline within **7 days**
- Credit in release notes (unless you prefer to remain anonymous)

## Supported Versions

Only the latest release on the `master` branch is actively maintained.
