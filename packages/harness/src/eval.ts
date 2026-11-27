// Entry point for the gate 5 eval runner (@oneseat/testkit/evals): one harness per case run,
// built the way the daemon builds it (sandboxed scripts, schedules), on a fresh data folder
// that the runner has already seeded.
import { join } from "node:path";
import type { HarnessApi, ModelProvider, SkillStore } from "@oneseat/contracts";
import { Harness, type HarnessOptions } from "./harness.js";
import { OneSeatDb } from "./db.js";
import { ScriptSandbox, findDeno } from "./sandbox.js";
import { Scheduler } from "./scheduler.js";
import { ScheduleStore } from "./stores.js";

export interface EvalHarnessContext {
  dataDir: string;
  dbPath?: string;
  workspaceDir: string;
  provider: ModelProvider;
}

export function createEvalHarness(
  ctx: EvalHarnessContext,
  store: SkillStore,
  overrides: Partial<Omit<HarnessOptions, "store" | "db" | "provider" | "workspaceDir">> = {},
): HarnessApi {
  const db = OneSeatDb.open(ctx.dataDir);
  const denoPath = findDeno();
  const sandbox = new ScriptSandbox({
    ...(denoPath ? { denoPath } : {}),
    workspaceDir: ctx.workspaceDir,
    cacheDir: join(ctx.dataDir, "deno-cache"),
    denyPaths: [db.path, `${db.path}-wal`, `${db.path}-shm`],
  });
  // schedule_task records the schedule; nothing fires during an eval.
  const schedules = new Scheduler({ store: new ScheduleStore(db), fire: async () => "eval-no-fire" });
  return new Harness({ store, db, provider: () => ctx.provider, workspaceDir: ctx.workspaceDir, sandbox, schedules, ...overrides });
}
