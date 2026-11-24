/**
 * The status page's favicon href. review/zenigata/assets/favicon.svg is
 * data, never code — the packaged default, the way persona.md is — and
 * the head links it as a data URI: no route serves the asset and the
 * page fetches nothing for the icon. An unreadable asset is a cosmetic
 * miss — undefined plus a log line — and never fails the boot.
 */

import { readFile } from "node:fs/promises";
import type { Logger } from "./ctx.js";
import { redactSecrets } from "./redact.js";

export async function loadFaviconHref(
  logger: Logger,
): Promise<string | undefined> {
  try {
    // Resolves beside src/ (tsx, vitest) and beside dist/ in the Nix
    // package: ../assets lands on the packaged review/zenigata/assets in
    // both.
    const svg = await readFile(
      new URL("../assets/favicon.svg", import.meta.url),
      "utf8",
    );
    // Percent-encoding keeps the URI data-only: the fills' # and the
    // markup's quotes become escapes, so the link tag's attribute cannot
    // terminate early.
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
    );
    logger.info(
      `the favicon asset is unreadable; the page renders without its icon: ${message}`,
    );
    return undefined;
  }
}
