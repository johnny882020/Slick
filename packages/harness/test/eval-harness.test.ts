import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedProvider, type HarnessEvent } from "@oneseat/contracts";
import { createMemorySkillStore, createSkillStoreFromDir } from "@oneseat/testkit";
import { fileURLToPath } from "node:url";
import { findDeno } from "../src/sandbox.js";
import { createEvalHarness } from "../src/index.js";

describe("createEvalHarness", () => {
  it("runs a forced skill with schedules recorded and never fired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-eval-"));
    let h: ReturnType<typeof createEvalHarness> | undefined;
    try {
      const store = createMemorySkillStore([{ name: "weekly-report", description: "Weekly report. Use when asked for a weekly report.", body: "# Weekly\nSchedule it." }]);
      const provider = createScriptedProvider([
        { steps: [{ tool: "schedule_task", input: { cron: "0 8 * * 1", input: "weekly report", skill: "weekly-report" } }] },
        { steps: [{ text: "Scheduled for Mondays at 08:00." }] },
      ]);
      h = createEvalHarness({ dataDir: dir, workspaceDir: join(dir, "ws"), provider }, store);
      const events: HarnessEvent[] = [];
      for await (const e of h.run({ input: "every monday", provider: "local", model: "m", skill: "weekly-report", origin: { kind: "eval" } }, async () => ({ approved: true })))
        events.push(e);
      const end = events.at(-1)!;
      // schedule_task always asks a person (security scan F2).
      expect(events.filter((e) => e.type === "approval_request").map((e) => e.type === "approval_request" && e.call.name)).toEqual(["schedule_task"]);
      expect(end.type).toBe("done");
      expect(events.some((e) => e.type === "skill_loaded" && e.reason === "forced")).toBe(true);
      const toolEnd = events.find((e) => e.type === "tool_end");
      expect(toolEnd && toolEnd.type === "tool_end" && toolEnd.result.isError).toBe(false);
    } finally {
      h?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Gate 5 loads the starter skills from their folders. A manifest without its folder made every
  // run_skill_script fail ("has no folder on disk"), so script-based skills lost to the baseline.
  it.skipIf(!findDeno())("runs a starter skill's script when the skill is loaded from its folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-eval-"));
    let h: ReturnType<typeof createEvalHarness> | undefined;
    try {
      const skills = fileURLToPath(new URL("../../../skills/proposals-invoices", import.meta.url));
      const store = await createSkillStoreFromDir(skills);
      const input = JSON.stringify({ items: [{ description: "Workshop", quantity: 3, unit_cents: 12500, taxable: true }], tax_bps: 825 });
      const provider = createScriptedProvider([
        { steps: [{ tool: "run_skill_script", input: { skill: "proposals-invoices", script: "totals", input } }] },
        { steps: [{ text: "Done." }] },
      ]);
      h = createEvalHarness({ dataDir: dir, workspaceDir: join(dir, "ws"), provider }, store);
      const events: HarnessEvent[] = [];
      for await (const e of h.run({ input: "invoice", provider: "local", model: "m", skill: "proposals-invoices", origin: { kind: "eval" } }, async () => ({ approved: false })))
        events.push(e);
      const toolEnd = events.find((e) => e.type === "tool_end");
      const result = toolEnd?.type === "tool_end" ? toolEnd.result : undefined;
      expect(result?.isError ? result.content : "").toBe("");
      // 3 x $125.00 = $375.00; 8.25% tax = $30.94 (half-up); total $405.94.
      expect(toolEnd?.type === "tool_end" ? toolEnd.result.content : "").toContain("40594");
    } finally {
      h?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
