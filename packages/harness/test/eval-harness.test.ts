import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedProvider, type HarnessEvent } from "@oneseat/contracts";
import { createMemorySkillStore } from "@oneseat/testkit";
import { createEvalHarness } from "../src/index.js";

describe("createEvalHarness", () => {
  it("runs a forced skill with schedules recorded and never fired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-eval-"));
    try {
      const store = createMemorySkillStore([{ name: "weekly-report", description: "Weekly report. Use when asked for a weekly report.", body: "# Weekly\nSchedule it." }]);
      const provider = createScriptedProvider([
        { steps: [{ tool: "schedule_task", input: { cron: "0 8 * * 1", input: "weekly report", skill: "weekly-report" } }] },
        { steps: [{ text: "Scheduled for Mondays at 08:00." }] },
      ]);
      const h = createEvalHarness({ dataDir: dir, workspaceDir: join(dir, "ws"), provider }, store);
      const events: HarnessEvent[] = [];
      for await (const e of h.run({ input: "every monday", provider: "local", model: "m", skill: "weekly-report", origin: { kind: "eval" } }, async () => ({ approved: false })))
        events.push(e);
      const end = events.at(-1)!;
      expect(end.type).toBe("done");
      expect(events.some((e) => e.type === "skill_loaded" && e.reason === "forced")).toBe(true);
      const toolEnd = events.find((e) => e.type === "tool_end");
      expect(toolEnd && toolEnd.type === "tool_end" && toolEnd.result.isError).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
