import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

// Shared config plus coverage settings. Gate 1 reads coverage/coverage-summary.json.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // Eval runner tests create many temp folders and SQLite files; Windows runners are slow at both.
      ...(process.platform === "win32" ? { testTimeout: 60_000, hookTimeout: 30_000 } : {}),
      coverage: {
        provider: "v8",
        include: ["src/**"],
        reporter: ["text-summary", "json-summary", "html"],
        reportsDirectory: "coverage",
      },
    },
  }),
);
