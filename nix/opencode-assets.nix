# The OpenCode guidance assets as one package — agents, commands, and the
# skills both clients take — so consumers that render OpenCode config
# themselves take a real artifact dependency instead of reaching into this
# repo's tree. The assets come from the writs tree (writs/skills,
# writs/agents, writs/commands); the director agent is the one exception —
# it ships from the director package (coordinate/director), so the director
# product owns its agent (PRJ-453).
#
# Plan-mode permissions are NOT packaged here: they are published as nix
# data via the flake's opencodeConfig export, which deployments overlay
# onto their own config.
#
# Skills ship as one full tree per client (share/skills.cursor,
# share/skills.opencode) rather than one shared tree: split skills are
# composed per client by splicing the client's block over the marker in
# SKILL.md, so each client loads a complete document with nothing to route
# on at run time. The splice is plain replaceStrings rather than
# substituteAll on purpose — the skills carry shell snippets full of
# $variables that a substitute-style step would eat.
{
  lib,
  runCommand,
  writeText,
}:

let
  clients = [
    "cursor"
    "opencode"
  ];

  root = ../writs/skills;

  skillNames = lib.attrNames (
    lib.filterAttrs (_: entryType: entryType == "directory") (builtins.readDir root)
  );

  # review-pr predates the generic split form and keeps its own marker/name.
  reviewPrFor =
    host:
    writeText "review-pr-${host}-SKILL.md" (
      lib.replaceStrings [ "@workspaceSetup@" ] [ (builtins.readFile (root + "/review-pr/${host}.md")) ] (
        builtins.readFile (root + "/review-pr/SKILL.md")
      )
    );

  hasClientBlockSplit =
    name:
    builtins.pathExists (root + "/${name}/cursor.md")
    && builtins.pathExists (root + "/${name}/opencode.md")
    && lib.hasInfix "@clientBlock@" (builtins.readFile (root + "/${name}/SKILL.md"));

  composedClientBlock =
    name: host:
    writeText "skill-${name}-${host}-SKILL.md" (
      lib.replaceStrings
        [ "@clientBlock@" ]
        [ (lib.removeSuffix "\n" (builtins.readFile (root + "/${name}/${host}.md"))) ]
        (builtins.readFile (root + "/${name}/SKILL.md"))
    );

  installForHost =
    host:
    let
      clientBlockSkills = lib.filter hasClientBlockSplit skillNames;
    in
    ''
      mkdir -p "$out/share/skills.${host}"
      cp -R ${root}/. "$out/share/skills.${host}/"
      chmod -R u+w "$out/share/skills.${host}"
      cp ${reviewPrFor host} "$out/share/skills.${host}/review-pr/SKILL.md"
    ''
    + lib.concatStrings (
      map (name: ''
        cp ${composedClientBlock name host} "$out/share/skills.${host}/${name}/SKILL.md"
        rm "$out/share/skills.${host}/${name}/cursor.md" "$out/share/skills.${host}/${name}/opencode.md"
      '') clientBlockSkills
    );
in
runCommand "memory-store-opencode"
  {
    meta = {
      description = "OpenCode guidance assets (agents, commands, skills)";
      platforms = lib.platforms.all;
    };
  }
  (
    ''
      mkdir -p "$out/share/opencode/agents" "$out/share/opencode/commands"
      cp ${../writs/agents}/*.md "$out/share/opencode/agents/"
      cp ${../writs/commands}/*.md "$out/share/opencode/commands/"
    ''
    + lib.concatStrings (map installForHost clients)
  )
