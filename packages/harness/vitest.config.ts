import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      coverage: {
        provider: "v8",
        include: ["src/**/*.ts"],
        exclude: ["src/index.ts"],
        reporter: ["text", "json-summary"],
      },
    },
  }),
);
