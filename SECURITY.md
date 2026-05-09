# Security Policy

## Scope

This project is a Linux compatibility layer for Claude Desktop's Cowork feature.
It stubs macOS-native modules so the unmodified Electron app runs on Linux.
The layer does not implement OAuth flows, store credentials, or make API calls.
See [OAUTH-COMPLIANCE.md](docs/OAUTH-COMPLIANCE.md) for a full audit of credential handling.

Vulnerabilities in Claude Desktop itself or the Claude Code CLI should be reported
directly to Anthropic at <https://www.anthropic.com/security>.

## Reporting a Vulnerability

**You may open an issue for any security or permission problem you see.**

You can also Report vulnerabilities by emailing me at: **zack@definitelynot.ai**

Include:
- A description of the vulnerability and its impact
- Steps to reproduce (command, environment, distro/DE)
- Whether you believe it affects credential handling, token passthrough, or process spawning

## What Counts as a Vulnerability Here

You may report anything you see as a risk around here. I will workshop it and then reply.

 Response Commitment

- Acknowledgement within **48 hours**
- Assessment and patch timeline within **7 days**
- Credit in release notes (unless you prefer to remain anonymous)

## Supported Versions

Only the latest release on the `master` branch is actively maintained.
