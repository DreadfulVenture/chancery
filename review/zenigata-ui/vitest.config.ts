import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        // The page's localStorage seen-state needs a stable origin.
        url: "http://zenigata-ui.invalid/",
      },
    },
  },
});
