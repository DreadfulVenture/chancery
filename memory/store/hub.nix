# The hub relay package. The hub imports memory_store/store.py for
# validate_record, so that module's import surface is a runtime dependency of
# this package — the interpreter below is the single place that list lives. A
# module-level import added to store.py must be added here: the bundled
# interpreter is what the check attr verifies, so a forgotten dependency
# fails `nix flake check` at build time instead of as a crash loop on a
# deployed machine (seen 2026-11-06: store.py grew `import pydantic`,
# the hub host's unit built its own empty interpreter, and the hub restarted until
# the deploy failed).
{
  pkgs,
  rev ? "dirty:unknown",
}:
let
  python = pkgs.python312.withPackages (ps: [ ps.pydantic ]);

  lib = pkgs.runCommand "memory-hub-lib" { } ''
    mkdir -p "$out/lib/memory-store/memory_store"
    cp ${./memory_store/server/hub_server.py} "$out/lib/memory-store/hub_server.py"
    cp ${./memory_store/__init__.py} "$out/lib/memory-store/memory_store/__init__.py"
    cp ${./memory_store/store.py} "$out/lib/memory-store/memory_store/store.py"
    cp ${./memory_store/spans.py} "$out/lib/memory-store/memory_store/spans.py"
    printf '%s\n' ${pkgs.lib.escapeShellArg rev} > "$out/lib/memory-store/VERSION"
  '';
in
pkgs.runCommand "memory-hub" { passthru.python = python; } ''
  mkdir -p "$out/bin"
  cp -R ${lib}/lib "$out/lib"
  cat > "$out/bin/memory-hub" <<EOF
    #!${pkgs.runtimeShell}
    exec ${python}/bin/python $out/lib/memory-store/hub_server.py "\$@"
  EOF
  chmod +x "$out/bin/memory-hub"
''
