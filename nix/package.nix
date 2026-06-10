{
  lib,
  stdenvNoCC,
  fetchurl,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
  unzip,
  asar,
  nodejs,
  python3,
  file,
  electron_41,
  dbus,
  gnused,
  gnugrep,
  findutils,
  gawk,
  coreutils,
  bashInteractive,
  curl,
  zstd,
  bubblewrap,
  xdg-utils,
  which,
  procps,
  # Pinned Claude Desktop release. To bump: run `node fetch-dmg.js --json` for
  # the current version/url/sha256, then `nix hash convert --to sri --hash-algo
  # sha256 <hex>` for `hash`. Newer releases ship as .zip (older ones were DMGs
  # in LZFSE format that p7zip cannot open); the .zip is what we expect here.
  claudeVersion ? "1.11187.4",
  claudeUrl ? "https://downloads.claude.ai/releases/darwin/universal/1.11187.4/Claude-58400536f3ccde1cff9a129de6c3112dc8cb489a.zip",
  claudeHash ? "sha256-qyVqIlNz1Y1PgBY940OOB2+i0E114w7MvubZ1LSx/Fs=",
}:

let
  electron = electron_41;

  claudeArchive = fetchurl {
    url = claudeUrl;
    hash = claudeHash;
  };

  # launch.sh resolves these from PATH at every launch; the in-app SDK loader
  # (claude-swift stub) shells out to curl/zstd/bwrap, and Chromium needs dbus.
  runtimePath = lib.makeBinPath [
    electron
    asar
    nodejs
    dbus
    file
    gnused
    gnugrep
    findutils
    gawk
    coreutils
    bashInteractive
    curl
    zstd
    bubblewrap
    xdg-utils
    which
    procps
  ];

  desktopItem = makeDesktopItem {
    name = "claude";
    desktopName = "Claude";
    comment = "AI assistant by Anthropic";
    exec = "claude-desktop %U";
    icon = "claude";
    terminal = false;
    startupWMClass = "Claude";
    categories = [
      "Utility"
      "Development"
      "Chat"
    ];
    keywords = [
      "AI"
      "assistant"
      "chat"
      "anthropic"
    ];
    mimeTypes = [ "x-scheme-handler/claude" ];
  };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "claude-cowork-linux";
  version = claudeVersion;

  src = ../.;

  nativeBuildInputs = [
    makeWrapper
    copyDesktopItems
    unzip
    asar
    nodejs
    python3
  ];

  desktopItems = [ desktopItem ];

  # The Claude app tree is prepared at build time (extract → asar-extract →
  # stubs → cowork patch). Per-launch work that mutates the tree (the sed
  # patches and `asar pack` in launch.sh) is left to the upstream launcher,
  # which the wrapper runs from a writable per-user copy — so the patch logic
  # lives in exactly one place (launch.sh) and never needs to be mirrored here.
  buildPhase = ''
    runHook preBuild

    unzip -q ${claudeArchive} -d claude-app
    appDir=$(find claude-app -maxdepth 2 -name "*.app" -type d | head -1)
    [ -n "$appDir" ] || (echo "Claude.app not found in archive" >&2; exit 1)
    res="$appDir/Contents/Resources"
    [ -f "$res/app.asar" ] || (echo "app.asar not found at $res" >&2; exit 1)

    tree=tree/linux-app-extracted
    mkdir -p tree
    asar extract "$res/app.asar" "$tree"

    if [ -d "$res/app.asar.unpacked" ]; then
      cp -r "$res/app.asar.unpacked"/* "$tree/" || true
    fi

    mkdir -p "$tree/resources"
    for item in "$res"/*; do
      case "$(basename "$item")" in
        app.asar | app.asar.unpacked) continue ;;
      esac
      cp -r "$item" "$tree/resources/" || true
    done
    mkdir -p "$tree/resources/i18n"
    if ls "$tree/resources"/*.json >/dev/null 2>&1; then
      mv "$tree/resources"/*.json "$tree/resources/i18n/"
    fi

    mkdir -p "$tree/node_modules/@ant/claude-swift/js" "$tree/node_modules/@ant/claude-native"
    cp stubs/@ant/claude-swift/js/index.js "$tree/node_modules/@ant/claude-swift/js/index.js"
    cp stubs/@ant/claude-native/index.js "$tree/node_modules/@ant/claude-native/index.js"
    for f in frame-fix-wrapper.js frame-fix-entry.js protocol-forwarder.js; do
      [ -f "stubs/frame-fix/$f" ] && cp "stubs/frame-fix/$f" "$tree/$f"
    done
    mkdir -p "$tree/cowork"
    cp -f stubs/cowork/*.js "$tree/cowork/"

    python3 enable-cowork.py "$tree/.vite/build/index.js"

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    share="$out/share/claude-cowork-linux"
    mkdir -p "$share"
    cp -r tree/linux-app-extracted "$share/"
    cp launch.sh launch-devtools.sh enable-cowork.py COMPAT.md "$share/"
    cp -r stubs "$share/"

    icns="$share/linux-app-extracted/resources/electron.icns"
    if [ -f "$icns" ]; then
      python3 ${./extract-icns.py} "$icns" "$out/share/icons/hicolor" || \
        echo "icon extraction failed (non-fatal)" >&2
    fi

    makeWrapper ${bashInteractive}/bin/bash "$out/bin/claude-desktop" \
      --prefix PATH : "${runtimePath}" \
      --add-flags ${./claude-desktop-launcher.sh} \
      --set CLAUDE_COWORK_STORE "$share" \
      --set CLAUDE_COWORK_VERSION "${finalAttrs.version}"

    runHook postInstall
  '';

  meta = {
    description = "Claude Desktop Cowork (Local Agent Mode) on Linux, packaged for NixOS";
    homepage = "https://github.com/johnzfitch/claude-cowork-linux";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
    mainProgram = "claude-desktop";
    sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
  };
})
