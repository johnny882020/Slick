import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      coverage: {
        provider: "v8",
        include: ["src/**"],
        exclude: ["src/bin.ts"],
        reporter: ["text", "json-summary"],
        thresholds: { lines: 90 },
      },
    },
  }),
);
