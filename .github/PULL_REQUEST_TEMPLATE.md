## What does this change?

<!-- Brief description of the change and why it's needed. -->

## Type

- [ ] Bug fix
- [ ] Distro / DE compatibility
- [ ] New feature
- [ ] Documentation
- [ ] Refactor

## Testing

<!-- How did you verify this? Include distro, DE, and any relevant log snippets. -->

- Distro / desktop:
- Tested with `./install.sh --doctor`:
- Tested a full Cowork session:

## Security impact

<!-- If this touches filterEnv, spawn, AuthRequest, isPathSafe, safe_fs.js,
     exec_capability_registry.js, the PKGBUILD disclaimer, or any credential handling:
     describe the impact and confirm it aligns with docs/OAUTH-COMPLIANCE.md.
     The full list is under "Security-Sensitive Areas" in CONTRIBUTING.md. -->

- [ ] This change does not touch credential handling, token passthrough, or process spawning
- [ ] This change does touch security-sensitive code — explanation below:

<!-- explanation if needed -->

## Checklist

- [ ] No API keys, tokens, `.env` files, or log output with credentials included
- [ ] Commit messages follow the project style (no emoji, brief summary + explanation)
- [ ] `./install.sh --doctor` passes cleanly on my system
- [ ] `npm test` and the shell suites in `tests/` pass (see CONTRIBUTING.md)
