import assert from "node:assert/strict";
import test from "node:test";

test("the module exports nothing but the plugin", async () => {
  // OpenCode reads the default export's id and setup; anything else
  // exported is dead weight that misleads about what the module loads.
  const module = await import("../memory.ts");
  assert.deepEqual(Object.keys(module), ["default"]);
});
