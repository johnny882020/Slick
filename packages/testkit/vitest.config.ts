import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

// Shared config plus coverage settings. Gate 1 reads coverage/coverage-summary.json.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      coverage: {
        provider: "v8",
        include: ["src/**"],
        reporter: ["text-summary", "json-summary", "html"],
        reportsDirectory: "coverage",
      },
    },
  }),
);
