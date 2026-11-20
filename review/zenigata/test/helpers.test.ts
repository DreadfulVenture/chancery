/**
 * Pin for the shared harness helper's poll contract: a probe answers with
 * a value present (undefined, null, and false all mean "not yet"), so an
 * eventual answer of 0 or an empty string resolves instead of burning the
 * timeout.
 */

import { describe, expect, it } from "vitest";
import { waitFor } from "./helpers.js";

describe("waitFor", () => {
  it("resolves on a numeric probe whose eventual answer is 0", async () => {
    let ticks = 0;
    const landed = await waitFor(() => {
      ticks += 1;
      return ticks < 3 ? undefined : 0;
    });
    expect(landed).toBe(0);
    expect(ticks).toBe(3);
  });

  it("resolves on a probe whose eventual answer is an empty string", async () => {
    let ticks = 0;
    const landed = await waitFor(() => {
      ticks += 1;
      return ticks < 3 ? undefined : "";
    });
    expect(landed).toBe("");
    expect(ticks).toBe(3);
  });

  it("still treats false as not-yet and burns the timeout on it", async () => {
    await expect(waitFor(() => false, 50)).rejects.toThrow("waitFor timed out");
  });
});
