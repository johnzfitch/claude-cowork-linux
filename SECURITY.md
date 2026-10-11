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

You can also report vulnerabilities by email to: **zack@definitelynot.ai**

Include:
- A description of the vulnerability and its impact
- Steps to reproduce (command, environment, distro/DE)
- Whether you believe it affects credential handling, token passthrough, or process spawning

## What Counts as a Vulnerability Here

Anything you see as a risk here: report it and it will be worked through with you.

In particular: a way for a renderer-supplied path to escape its root, a way to
get a command past `exec_capability_registry.js`, a credential reaching a log or
a spawned process, or a patch pass that weakens a check in the bundle.

## Response Commitment

- Acknowledgement within **48 hours**
- Assessment and patch timeline within **7 days**
- Credit in release notes (unless you prefer to remain anonymous)

## Supported Versions

Only the latest release and `master` are maintained. Fixes are not backported.
