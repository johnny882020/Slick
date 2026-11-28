import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      coverage: {
        provider: "v8",
        include: ["src/**/*.ts"],
        // bin.ts only calls main() and process.exit(); main() is tested in-process.
        exclude: ["src/bin.ts"],
        reporter: ["text", "json-summary"],
        thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
      },
    },
  }),
);
