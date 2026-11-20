# The oc-wake CLI as its own package (PRJ-383 review 189): the wake is not
# the memory plugin's surface — the operator's ownership ruling keeps a
# product's background behavior with the product that owns it, and a wake
# timer is not memory — so memory-store-plugin stops carrying it. The bin
# ships under lib/oc-wake with a bin/ wrapper that execs the package's own
# nodejs, so the bin's shebang stops depending on the user's PATH.
#
# The bin creates its state dir lazily at first use ($XDG_STATE_HOME/chancery
# — see docs/oc-wake.md), so the package carries no state paths.
{
  lib,
  runCommand,
  nodejs,
}:

runCommand "oc-wake"
  {
    meta = {
      description = "oc-wake: schedule one wake prompt for an opencode session";
      # The bin reads /proc/<pid>/stat — the watchdog's identity is the
      # pid + starttime pair — and no darwin build of it exists.
      platforms = lib.platforms.linux;
    };
  }
  ''
        mkdir -p "$out/bin" "$out/lib/oc-wake"
        install -m 0644 ${./bin/oc-wake} "$out/lib/oc-wake/oc-wake"
        cat > "$out/bin/oc-wake" <<EOF
    #!/bin/sh
    exec ${nodejs}/bin/node "$out/lib/oc-wake/oc-wake" "\$@"
    EOF
        chmod +x "$out/bin/oc-wake"
  ''
