{
  description = "Claude Desktop Cowork (Local Agent Mode) on Linux, packaged for NixOS";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          claude-cowork-linux = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit claude-cowork-linux;
          default = claude-cowork-linux;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.claude-cowork-linux}/bin/claude-desktop";
        };
      });

      # `nix develop` then `bash ./install.sh` — runs the upstream installer with
      # all of its dependencies provided declaratively, instead of its imperative
      # `nix-env -iA` / `npm install -g electron` path (the npm electron binary is
      # a prebuilt ELF that does not run on NixOS).
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.electron_41
              pkgs.asar
              pkgs.nodejs
              pkgs.python3
              pkgs.unzip
              pkgs.p7zip
              pkgs._7zz
              pkgs.bubblewrap
              pkgs.curl
              pkgs.zstd
              pkgs.file
              pkgs.dbus
              pkgs.xdg-utils
            ];
          };
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt-rfc-style);
    };
}
