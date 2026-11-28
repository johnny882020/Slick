// Shared Vitest config. Workspace packages resolve to their TypeScript source
// through the "@oneseat/source" export condition, so tests never need a build.
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@oneseat/source"] },
  ssr: { resolve: { conditions: ["@oneseat/source"] } },
  test: { environment: "node", testTimeout: 20_000 },
});
