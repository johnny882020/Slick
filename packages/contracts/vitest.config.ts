import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      coverage: {
        provider: "v8",
        include: ["src/**"],
        // Type-only modules have no runtime lines to cover.
        exclude: ["src/evals.ts", "src/harness.ts"],
        reporter: ["text", "json-summary"],
        thresholds: { lines: 90 },
      },
    },
  }),
);
