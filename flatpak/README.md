# Flathub draft (#85)

**Status: draft skeleton, never built.** `flatpak-builder` was not available in
the environment this was written in, so nothing here has been run — not
`flatpak-builder --user --install`, not a launch, not a Cowork task. Read this
before trying it, and please report back what breaks.

## What this reproduces

`io.github.johnzfitch.ClaudeCoworkLinux.yml`'s build-commands are a
near-verbatim port of `nix/package.nix`'s `buildPhase`: extract Claude's
archive, drop in the stubs, run `enable-cowork.py` once at build time. The
runtime wrapper (`claude-desktop-wrapper.sh`) mirrors
`nix/claude-desktop-launcher.sh`'s trick for the same reason: `/app` is
read-only and `launch.sh` mutates its own directory (sed patches, `asar pack`
into `.asar-cache/`) on every run, so the prepared tree gets mirrored into a
writable per-user copy on first run or version bump. No extra permission is
needed for that mirror because Flatpak already gives every app its own
private `XDG_DATA_HOME`.

## What's a guess, not a fact

- **`extra-data` sha256/size are placeholders.** Run
  `node fetch-dmg.js --json` and fill them in before attempting a build — an
  extra-data source with a wrong hash just fails at install time, so this
  isn't a silent risk, but it will stop you immediately if skipped.
- **The runtime/base versions (`24.08`) are unverified against
  `org.electronjs.Electron2.BaseApp`'s actual compatibility matrix.** Nix
  pins `electron_41`; whichever BaseApp version actually ships an Electron 41
  compatible with that should be used instead of the placeholder here.
- **`--filesystem=home`** is the blunt version of attached-folder access.
  Portal-based folder access (matching what a native file-open dialog would
  grant) is the right long-term answer and hasn't been attempted.

## What's a known, unresolved gap — not a guess

**Sandbox-in-sandbox.** Cowork spawns `bwrap` itself to isolate agent task
execution. Running that nested inside Flatpak's own sandbox is the
"riskiest unknown" the maintainer flagged on #85, and this draft does not
solve it. The `--talk-name=org.freedesktop.Flatpak` finish-arg is requested
so a future fix can use `flatpak-spawn --host` to run the task sandbox on the
host instead of nesting it — the pattern distrobox and devcontainer-in-flatpak
setups use — but no code here actually does that. `launch.sh` / the cowork
sandbox spawner would need to detect `$FLATPAK_ID` and switch how it invokes
`bwrap` accordingly. That's a real code change to the sandbox spawn path, not
a manifest change, and it needs testing inside an actual flatpak sandbox to
know if it even works, neither of which happened here.

## To actually try this

```
flatpak-builder --user --install --force-clean build-dir \
  flatpak/io.github.johnzfitch.ClaudeCoworkLinux.yml
flatpak run io.github.johnzfitch.ClaudeCoworkLinux
```

Expect the Cowork sandbox step to be where it breaks first. That's the part
most worth a bug report back on #85.
