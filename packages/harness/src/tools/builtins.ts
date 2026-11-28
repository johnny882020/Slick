// Built-in tools: database, memory, workspace files, artifacts and schedules.
// The skill tools (load_skill, read_skill_file, run_skill_script) live in skills.ts.

import { mkdir, readdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  findBridgeCalls,
  slugify,
  validateArtifactBundle,
  type AppJson,
  type Schedule,
  type SkillStore,
} from "@oneseat/contracts";
import { isValidCron, nextRun } from "../cron.js";
import type { OneSeatDb } from "../db.js";
import type { ScheduleInput } from "../scheduler.js";
import { checkReadSql, checkWriteSql, stripSql } from "../sql.js";
import type { ArtifactDrafts, MemoryStore } from "../stores.js";
import { errorMessage, newId } from "../util.js";
import { displayPath, resolveInside } from "../workspace.js";
import { fail, ok, type RegisteredTool } from "./registry.js";

export interface BuiltinServices {
  db: OneSeatDb;
  memory: MemoryStore;
  drafts: ArtifactDrafts;
  store: SkillStore;
  workspaceDir: string;
  schedules?: { upsert(input: ScheduleInput): Schedule };
  /** Max rows db_query returns. Default 200. */
  queryRowLimit?: number;
  /** Max bytes workspace_read opens. Default 1 MB. */
  maxReadBytes?: number;
  now?: () => Date;
}

const SQL_PARAMS = {
  type: "array",
  description: "Values for ? placeholders, in order.",
  items: { type: ["string", "number", "boolean", "null"] },
};

type SqlValue = string | number | null | bigint | Uint8Array;

/** JSON values to SQLite values. Whole numbers bind as INTEGER (node:sqlite binds plain numbers as REAL). */
function sqlParams(input: Record<string, unknown>): SqlValue[] {
  const raw = (input["params"] as unknown[] | undefined) ?? [];
  return raw.map((v) => {
    if (typeof v === "boolean") return v ? 1n : 0n;
    if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
    return v as SqlValue;
  });
}

function cleanRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "bigint") out[k] = Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
    else if (v instanceof Uint8Array) out[k] = `[blob ${v.byteLength} bytes]`;
    else out[k] = v;
  }
  return out;
}

export function dbQueryTool(s: BuiltinServices): RegisteredTool {
  return {
    definition: {
      name: "db_query",
      description:
        "Read the local business database (SQLite). One SELECT, WITH ... SELECT or PRAGMA table_info(<table>) statement. Returns rows as JSON.",
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string", description: "A single read-only SQL statement." }, params: SQL_PARAMS },
        required: ["sql"],
        additionalProperties: false,
      },
      effects: ["read"],
      source: "builtin",
    },
    summarize: (input) => `Query database: ${String(input["sql"]).replace(/\s+/g, " ").slice(0, 140)}`,
    async run(input) {
      const sql = String(input["sql"]);
      const check = checkReadSql(sql);
      if (!check.ok) return fail(`db_query refused: ${check.reason}`);
      const limit = s.queryRowLimit ?? 200;
      try {
        const stmt = s.db.readOnly().prepare(sql);
        const rows: Record<string, unknown>[] = [];
        let truncated = false;
        for (const row of stmt.iterate(...sqlParams(input))) {
          if (rows.length >= limit) {
            truncated = true;
            break;
          }
          rows.push(cleanRow(row as Record<string, unknown>));
        }
        return ok({ rowCount: rows.length, ...(truncated ? { truncated: true, note: `only the first ${limit} rows are shown; add LIMIT or filters` } : {}), rows });
      } catch (e) {
        return fail(`SQL error: ${errorMessage(e)}`);
      }
    },
  };
}

export function dbExecuteTool(s: BuiltinServices): RegisteredTool {
  return {
    definition: {
      name: "db_execute",
      description:
        "Change the local business database (SQLite): one INSERT, UPDATE, DELETE, REPLACE, CREATE TABLE|INDEX|VIEW IF NOT EXISTS, ALTER TABLE or DROP statement. DELETE and DROP ask the person first.",
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string", description: "A single SQL statement that changes data or schema." }, params: SQL_PARAMS },
        required: ["sql"],
        additionalProperties: false,
      },
      effects: ["write"],
      source: "builtin",
    },
    effectsFor(input) {
      const check = checkWriteSql(String(input["sql"] ?? ""));
      return check.ok && check.deletes ? ["write", "delete"] : ["write"];
    },
    summarize(input) {
      const sql = String(input["sql"]).replace(/\s+/g, " ").trim();
      const check = checkWriteSql(sql);
      const label = !check.ok || !check.deletes ? "Change database" : /\b(DELETE|DROP)\b/i.test(stripSql(sql)) ? "Delete data" : "Overwrite data";
      return `${label}: ${sql.slice(0, 140)}`;
    },
    async run(input) {
      const sql = String(input["sql"]);
      const check = checkWriteSql(sql);
      if (!check.ok) return fail(`db_execute refused: ${check.reason}`);
      try {
        const r = s.db.db.prepare(sql).run(...sqlParams(input));
        return ok({ changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) });
      } catch (e) {
        return fail(`SQL error: ${errorMessage(e)}`);
      }
    },
  };
}

export function memoryTools(s: BuiltinServices): RegisteredTool[] {
  return [
    {
      definition: {
        name: "memory_save",
        description: "Save a lasting fact or preference to long-term memory (for example how the owner likes invoices worded).",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "The fact, in one or two sentences." },
            tags: { type: "array", items: { type: "string" }, description: "Optional short tags." },
          },
          required: ["content"],
          additionalProperties: false,
        },
        effects: ["write"],
        source: "builtin",
      },
      summarize: (input) => `Remember: ${String(input["content"]).slice(0, 140)}`,
      async run(input, ctx) {
        const content = String(input["content"]).trim();
        if (!content) return fail("content is empty");
        const tags = ((input["tags"] as string[] | undefined) ?? []).map((t) => t.trim().replace(/,/g, " ")).filter(Boolean);
        const id = s.memory.save(content, tags, ctx.sessionId);
        return ok({ saved: true, id });
      },
    },
    {
      definition: {
        name: "memory_search",
        description: "Search long-term memory for saved facts and preferences.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Words to look for." },
            limit: { type: "integer", description: "Max results (default 10)." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        effects: ["read"],
        source: "builtin",
      },
      summarize: (input) => `Search memory: ${String(input["query"]).slice(0, 140)}`,
      async run(input) {
        const limit = Math.max(1, Math.min(50, Number(input["limit"] ?? 10)));
        const items = s.memory.search(String(input["query"]), limit);
        return ok({ results: items });
      },
    },
  ];
}

export function workspaceTools(s: BuiltinServices): RegisteredTool[] {
  const maxRead = s.maxReadBytes ?? 1024 * 1024;
  return [
    {
      definition: {
        name: "workspace_read",
        description: "Read a text file from the workspace folder.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Path relative to the workspace." } },
          required: ["path"],
          additionalProperties: false,
        },
        effects: ["read"],
        source: "builtin",
      },
      summarize: (input) => `Read workspace file ${String(input["path"])}`,
      async run(input) {
        try {
          const p = resolveInside(s.workspaceDir, String(input["path"]));
          const st = await stat(p).catch(() => undefined);
          if (!st) return fail(`no such file: ${String(input["path"])}`);
          if (st.isDirectory()) return fail(`${String(input["path"])} is a folder; use workspace_list`);
          if (st.size > maxRead) return fail(`file is ${st.size} bytes; the limit is ${maxRead}`);
          return ok(await readFile(p, "utf8"));
        } catch (e) {
          return fail(errorMessage(e));
        }
      },
    },
    {
      definition: {
        name: "workspace_write",
        description: "Write a text file in the workspace folder (creates folders as needed). Set append to add to the end.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to the workspace." },
            content: { type: "string" },
            append: { type: "boolean" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        effects: ["write"],
        source: "builtin",
      },
      summarize: (input) => `${input["append"] ? "Append to" : "Write"} workspace file ${String(input["path"])}`,
      async run(input) {
        try {
          const p = resolveInside(s.workspaceDir, String(input["path"]));
          if (p === resolveInside(s.workspaceDir, ".")) return fail("path must name a file");
          const st = await stat(p).catch(() => undefined);
          if (st?.isDirectory()) return fail(`${String(input["path"])} is a folder`);
          await mkdir(dirname(p), { recursive: true });
          const content = String(input["content"]);
          if (input["append"] === true) await appendFile(p, content, "utf8");
          else await writeFile(p, content, "utf8");
          return ok({ path: displayPath(s.workspaceDir, p), bytes: Buffer.byteLength(content) });
        } catch (e) {
          return fail(errorMessage(e));
        }
      },
    },
    {
      definition: {
        name: "workspace_list",
        description: "List files in a workspace folder.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Folder relative to the workspace (default the top)." },
            recursive: { type: "boolean" },
          },
          additionalProperties: false,
        },
        effects: ["read"],
        source: "builtin",
      },
      summarize: (input) => `List workspace folder ${String(input["path"] ?? ".")}`,
      async run(input) {
        try {
          const root = resolveInside(s.workspaceDir, String(input["path"] ?? "."));
          const st = await stat(root).catch(() => undefined);
          if (!st) return fail(`no such folder: ${String(input["path"])}`);
          if (!st.isDirectory()) return fail(`${String(input["path"])} is a file`);
          const entries: { path: string; type: "file" | "dir"; size?: number }[] = [];
          const max = 500;
          const walk = async (dir: string) => {
            for (const d of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
              if (entries.length >= max) return;
              const full = join(dir, d.name);
              if (d.isDirectory()) {
                entries.push({ path: displayPath(s.workspaceDir, full), type: "dir" });
                if (input["recursive"] === true) await walk(full);
              } else if (d.isFile()) {
                entries.push({ path: displayPath(s.workspaceDir, full), type: "file", size: (await stat(full)).size });
              }
            }
          };
          await walk(root);
          return ok({ entries, ...(entries.length >= max ? { truncated: true } : {}) });
        } catch (e) {
          return fail(errorMessage(e));
        }
      },
    },
  ];
}

export function makeArtifactTool(s: BuiltinServices): RegisteredTool {
  return {
    definition: {
      name: "make_artifact",
      description:
        "Make a small self-contained HTML app the person can pin as its own window. No remote scripts, styles, images or fetch: the page may only call oneseat.run(skill, input) for skills listed in allowedSkills. Returns a draft id.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "App name shown to the person." },
          html: { type: "string", description: "One complete HTML document with inline CSS and JS." },
          allowedSkills: { type: "array", items: { type: "string" }, description: "Skills the page may call." },
          window: {
            type: "object",
            properties: { width: { type: "integer" }, height: { type: "integer" }, resizable: { type: "boolean" } },
            required: ["width", "height"],
            additionalProperties: false,
          },
          icon: { type: "string", description: "One emoji or a PNG/SVG data: URI." },
        },
        required: ["name", "html", "allowedSkills"],
        additionalProperties: false,
      },
      effects: ["write"],
      source: "builtin",
    },
    summarize: (input) => `Make app draft "${String(input["name"])}"`,
    async run(input, ctx) {
      const name = String(input["name"]).trim();
      const allowedSkills = [...new Set(input["allowedSkills"] as string[])];
      const win = input["window"] as AppJson["window"] | undefined;
      const app: AppJson = {
        id: slugify(name),
        name,
        version: "1.0.0",
        window: win ?? { width: 900, height: 700, resizable: true },
        allowedSkills,
      };
      if (typeof input["icon"] === "string") app.icon = input["icon"];
      const creator = [...ctx.skills.loaded].reverse()[0]?.name;
      if (creator) app.createdBy = creator;
      const html = String(input["html"]);
      const issues = validateArtifactBundle({ html, app });
      const errors = issues.filter((i) => i.severity === "error");
      const calls = findBridgeCalls(html).filter((c) => !allowedSkills.includes(c));
      for (const c of calls) errors.push({ severity: "error", rule: "bridge-skill", message: `the page calls oneseat.run("${c}") but "${c}" is not in allowedSkills` });
      const installed = new Set((await s.store.index()).map((e) => e.name));
      for (const sk of allowedSkills)
        if (!installed.has(sk)) errors.push({ severity: "error", rule: "unknown-skill", message: `allowedSkills names "${sk}", which is not installed` });
        else if (!ctx.skills.isAllowed(sk))
          errors.push({ severity: "error", rule: "skill-not-allowed", message: `"${sk}" is not available to this run` });
      if (errors.length > 0) return fail(`The app is not valid:\n${errors.map((e) => `- ${e.rule}: ${e.message}`).join("\n")}`);
      const draft = s.drafts.save({ id: newId("draft"), app, html, runId: ctx.runId, sessionId: ctx.sessionId });
      return ok({
        draftId: draft.id,
        appId: app.id,
        name: app.name,
        allowedSkills,
        warnings: issues.filter((i) => i.severity === "warning").map((w) => w.message),
        note: "Draft saved. The person can pin it as an app from the OneSeat window.",
      });
    },
  };
}

export function scheduleTaskTool(s: BuiltinServices): RegisteredTool {
  return {
    definition: {
      name: "schedule_task",
      description:
        "Run a task on a schedule. cron is 5 fields in local time (minute hour day-of-month month day-of-week), e.g. \"0 9 * * 1\" for 9:00 every Monday. input is what to ask; skill optionally forces a skill.",
      inputSchema: {
        type: "object",
        properties: {
          cron: { type: "string" },
          input: { type: "string", description: "The task, written as the person would ask it." },
          skill: { type: "string", description: "Optional skill to load for each run." },
        },
        required: ["cron", "input"],
        additionalProperties: false,
      },
      effects: ["write"],
      source: "builtin",
    },
    // A schedule is lasting work that runs with nobody watching, so a person always approves it.
    alwaysAsk: true,
    summarize: (input) => `Schedule "${String(input["input"]).slice(0, 100)}" at cron ${String(input["cron"])}`,
    async run(input, ctx) {
      if (!s.schedules) return fail("scheduling is not available in this session");
      // Pinned apps and scheduled runs have nobody to approve, and must not create more work.
      const origin = ctx.task.origin?.kind;
      if (origin === "app" || origin === "schedule")
        return fail("schedules can only be made from the main window, where a person approves them");
      const cron = String(input["cron"]).trim();
      if (!isValidCron(cron)) return fail(`invalid cron "${cron}": use 5 fields: minute hour day-of-month month day-of-week`);
      if (!nextRun(cron, (s.now ?? (() => new Date()))())) return fail(`cron "${cron}" never runs`);
      const skill = typeof input["skill"] === "string" && input["skill"] ? String(input["skill"]) : undefined;
      if (skill && !(await ctx.skills.manifest(skill))) return fail(`no skill named "${skill}" is available`);
      const task: Schedule["task"] = { input: String(input["input"]), provider: ctx.task.provider, model: ctx.task.model };
      if (skill) task.skill = skill;
      if (ctx.task.effort) task.effort = ctx.task.effort;
      // Keep this run's skill restriction, so the schedule can never reach more than its maker.
      const allowed = ctx.skills.allowedSkills;
      const sch = s.schedules.upsert({ cron, task, enabled: true, ...(allowed ? { allowedSkills: [...allowed] } : {}) });
      return ok({ scheduleId: sch.id, cron: sch.cron, nextRunAt: sch.nextRunAt });
    },
  };
}

export function createBuiltinTools(s: BuiltinServices): RegisteredTool[] {
  return [dbQueryTool(s), dbExecuteTool(s), ...memoryTools(s), ...workspaceTools(s), makeArtifactTool(s), scheduleTaskTool(s)];
}
