"""Packaging tests.

The hub package deliberately ships a subset of the app. A subset breaks
silently: add an import to memory_store/store.py and the hub raises
ImportError at startup, after deploy, with nothing between the commit and
the outage. This walks the entrypoint's transitive local imports and
asserts the shipped set closes over them.
"""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PACKAGE_DIR = ROOT / "memory_store"
PACKAGE = "memory_store"
# The repo root, for the cross-product packaging surfaces the tests read.
REPO = ROOT.parent.parent


def local_modules() -> dict[str, Path]:
    """Dotted module name -> source path for every module under the app
    package, tests excluded."""
    modules = {}
    for path in PACKAGE_DIR.rglob("*.py"):
        relative = path.relative_to(PACKAGE_DIR)
        if relative.parts[0] == "tests":
            continue
        stem = ".".join([PACKAGE, *relative.with_suffix("").parts])
        if stem.endswith(".__init__"):
            stem = stem[: -len(".__init__")]
        modules[stem] = path
        if relative.name == "__init__.py":
            modules[".".join([PACKAGE, *relative.parent.parts])] = path
    return modules


def packaged_modules(nix_file: Path) -> set[str]:
    """Module names the derivation copies, read off its `cp ${./name.py}`
    lines — the package definition is the contract under test, so reading it
    beats restating the list here."""
    text = nix_file.read_text(encoding="utf-8")
    paths = set(re.findall(r"\$\{(?:\./|\.\./)([A-Za-z0-9_/][A-Za-z0-9_./]*)\.py\}", text))
    names = set()
    for path in paths:
        parts = path.rstrip("/").split("/")
        dotted = ".".join(parts)
        names.add(dotted[: -len(".__init__")] if dotted.endswith(".__init__") else dotted)
    return names


def referenced_modules(node: ast.AST, current: str, known: dict[str, Path]) -> set[str]:
    """Dotted local-module names an import node names, absolute or relative."""
    targets: set[str] = set()
    if isinstance(node, ast.Import):
        targets = {alias.name for alias in node.names}
        return targets
    if not isinstance(node, ast.ImportFrom):
        return targets
    base = current
    if node.level:
        # Relative, resolved per Python's own rule: a package's __init__ IS
        # its package, any other module's package is its name minus the last
        # part, and each level past the first pops one parent. Under the
        # package root is invalid python; resolving it to a bare name no
        # module carries keeps the walk safe either way.
        parts = (
            current.split(".")
            if known.get(current) is not None and known[current].name == "__init__.py"
            else current.split(".")[:-1]
        )
        base = ".".join(parts[: max(len(parts) - node.level + 1, 0)])
    if node.module:
        prefix = f"{base}.{node.module}" if base else node.module
        targets.add(prefix)
        for alias in node.names:
            targets.add(f"{prefix}.{alias.name}")
    else:
        # `from . import name`: name may be a submodule of the base package.
        for alias in node.names:
            targets.add(f"{base}.{alias.name}" if base else alias.name)
    return targets


def transitive_local_imports(entrypoint: str, known: dict[str, Path]) -> set[str]:
    """Entry-point module name plus every local module reachable from it by
    import, including imports inside functions — the daemon defers several
    of its heaviest."""
    seen: set[str] = set()
    pending = [entrypoint]
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        path = known.get(name)
        if path is None:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            for candidate in referenced_modules(node, name, known):
                if candidate in known:
                    pending.append(candidate)
    return seen


class HubSubsetTests(unittest.TestCase):
    def test_hub_package_closes_over_its_imports(self):
        packaged = packaged_modules(ROOT / "hub.nix")
        known = local_modules()
        self.assertIn(
            f"{PACKAGE}.server.hub_server", packaged, "hub.nix no longer copies its entrypoint"
        )
        needed = transitive_local_imports(f"{PACKAGE}.server.hub_server", known)
        missing = needed - packaged
        self.assertEqual(
            missing,
            set(),
            f"hub.nix ships {sorted(packaged)} but the hub entrypoint reaches {sorted(needed)}",
        )


class MainPackageTests(unittest.TestCase):
    def test_main_package_is_not_an_enumerated_list(self):
        # The main package takes every app module as a set. Naming them
        # one by one is how a module nobody remembered to add went missing
        # with no build error.
        self.assertEqual(packaged_modules(ROOT / "package.nix"), set())

    def test_daemon_package_ships_what_the_daemon_reads(self):
        # The daemon reads the Cursor hook and the contract text out of its
        # own lib at runtime, so they close over it like the python modules.
        text = (ROOT / "package.nix").read_text(encoding="utf-8")
        self.assertIn("../cursor-client", text)
        self.assertIn("./instructions", text)
        self.assertTrue((ROOT.parent / "cursor-client" / "hook.py").exists())
        self.assertTrue((ROOT / "instructions" / "memory.md").exists())

    def test_client_assets_ship_in_their_own_packages(self):
        # The plugin and the guidance assets are real packages — the
        # distribution boundary consumers that are not home-manager build
        # against — and the daemon package no longer carries them: one
        # shipper per artifact, or two copies drift.
        plugin = (ROOT.parent / "opencode-client" / "package.nix").read_text(encoding="utf-8")
        self.assertIn("/*.ts", plugin)
        assets = (REPO / "nix" / "opencode-assets.nix").read_text(encoding="utf-8")
        self.assertIn("../writs/skills", assets)
        self.assertIn("../writs/agents", assets)
        self.assertIn("../writs/commands", assets)
        daemon = (ROOT / "package.nix").read_text(encoding="utf-8")
        self.assertNotIn("../writs", daemon)
        self.assertNotRegex(daemon, r"^\s*\.\./plugin$", re.MULTILINE)

    def test_skills_ship(self):
        # The module links one skill per directory under writs/skills into
        # each enabled client, reading the names off the directory, and
        # links them out of the per-client trees the assets package composes,
        # which copy this same set. The two have to agree, and a skill
        # directory without a SKILL.md is not a skill either client will
        # load.
        skills_root = REPO / "writs" / "skills"
        assets = (REPO / "nix" / "opencode-assets.nix").read_text(encoding="utf-8")
        self.assertIn("../writs/skills", assets)
        skills = sorted(path.name for path in skills_root.iterdir() if path.is_dir())
        self.assertNotEqual(skills, [])
        missing = [name for name in skills if not (skills_root / name / "SKILL.md").exists()]
        self.assertEqual(missing, [], f"skills without a SKILL.md: {missing}")

    def test_review_pr_composes_per_client(self):
        # review-pr carries a @workspaceSetup@ marker the package splices a
        # host block over, one tree per client. Anti-drift pair: the
        # cursor variant's persistent clone must not leak into the opencode
        # variant, whose source is the current checkout.
        skills_root = REPO / "writs" / "skills"
        skill = skills_root / "review-pr" / "SKILL.md"
        self.assertIn("@workspaceSetup@", skill.read_text(encoding="utf-8"))
        for host in ("cursor", "opencode"):
            block = (skills_root / "review-pr" / f"{host}.md").read_text(encoding="utf-8")
            self.assertNotIn("@workspaceSetup@", block)
        cursor_asset = (skills_root / "review-pr" / "cursor.md").read_text(encoding="utf-8")
        opencode_asset = (skills_root / "review-pr" / "opencode.md").read_text(encoding="utf-8")
        self.assertIn("~/git/review", cursor_asset)
        self.assertNotIn("~/git/review", opencode_asset)
        assets = (REPO / "nix" / "opencode-assets.nix").read_text(encoding="utf-8")
        self.assertIn("skills.cursor", assets)
        self.assertIn("skills.opencode", assets)


if __name__ == "__main__":
    unittest.main()
