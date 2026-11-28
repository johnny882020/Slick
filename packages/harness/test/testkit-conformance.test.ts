// The shared HarnessApi suite (stream F) against the real harness.
import { join } from "node:path";
import { describeHarnessConformance } from "@oneseat/testkit";
import { createHarness, OneSeatDb, type RegisteredTool } from "../src/index.js";

describeHarnessConformance((provider, store, ctx) => {
  const extraTools: RegisteredTool[] = ctx.tools.map((t) => ({
    definition: t.definition,
    run: async (input) => ({ content: await t.run(input) }),
  }));
  return createHarness({
    store,
    db: OneSeatDb.open(ctx.dataDir),
    provider: () => provider,
    workspaceDir: join(ctx.dataDir, "workspace"),
    extraTools,
  });
});
