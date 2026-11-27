/**
 * The client bundle's build: esbuild bundles the lit app into one
 * browser script the UI server serves as a static asset, beside the
 * page shell and its stylesheet. No code-as-string: the bundle is the
 * logic the browser runs, and the tests import the same modules the
 * bundle is built from. Run with node 24 (it runs TypeScript natively).
 */

import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await mkdir(join(root, "dist/client"), { recursive: true });
await build({
  entryPoints: [join(root, "src/client/main.ts")],
  bundle: true,
  format: "iife",
  target: ["es2022"],
  charset: "utf8",
  sourcemap: false,
  outfile: join(root, "dist/client/app.js"),
});

await cp(join(root, "index.html"), join(root, "dist/client/index.html"));
await cp(
  join(root, "src/client/styles.css"),
  join(root, "dist/client/styles.css"),
);
await cp(join(root, "assets"), join(root, "dist/client/assets"), {
  recursive: true,
});
