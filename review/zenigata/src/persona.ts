/**
 * The persona text injected into every prompt. It is data, never code:
 * the packaged review/zenigata/persona.md is the default, and
 * ZENIGATA_PERSONA_FILE overrides it.
 */

import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";

export async function loadPersona(config: Config): Promise<string> {
  if (config.personaFile) {
    return readFile(config.personaFile, "utf8");
  }
  // From src/persona.ts (tsx, vitest) this resolves to the packaged
  // review/zenigata/persona.md; from dist/persona.js the Nix derivation
  // installs persona.md at <pkgRoot>/persona.md, and the built file sits
  // at <pkgRoot>/dist/, so ../ lands on the same file.
  const packaged = new URL("../persona.md", import.meta.url);
  return readFile(packaged, "utf8");
}
