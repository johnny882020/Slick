// Skill tools: load_skill, read_skill_file, run_skill_script.

import type { SkillManifest, SkillStore, ToolEffect } from "@oneseat/contracts";
import { renderSkill } from "../router.js";
import type { ScriptSandbox } from "../sandbox.js";
import { errorMessage, truncateText } from "../util.js";
import { normaliseRelativePath } from "../workspace.js";
import { fail, ok, type RegisteredTool, type ToolContext } from "./registry.js";

export const SKILL_TOOL_NAMES = ["load_skill", "read_skill_file", "run_skill_script"] as const;

async function unknownSkill(name: string, ctx: ToolContext): Promise<string> {
  const names = (await ctx.skills.index()).map((e) => e.name);
  return `No skill named "${name}" is available.${names.length ? ` Available skills: ${names.join(", ")}.` : ""}`;
}

export function loadSkillTool(): RegisteredTool {
  return {
    definition: {
      name: "load_skill",
      description: "Load a skill's instructions (SKILL.md) by name. Call this when the task matches a skill in the index.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name from the index." } },
        required: ["name"],
        additionalProperties: false,
      },
      effects: ["read"],
      source: "builtin",
    },
    summarize: (input) => `Load skill ${String(input["name"])}`,
    async run(input, ctx) {
      const name = String(input["name"]).trim();
      const m = await ctx.skills.manifest(name);
      if (!m) return fail(await unknownSkill(name, ctx));
      const first = ctx.skills.markLoaded(name, "router");
      if (first) ctx.emit({ type: "skill_loaded", name, reason: "router" });
      return ok(first ? renderSkill(m) : `(already loaded)\n\n${renderSkill(m)}`);
    },
  };
}

export function readSkillFileTool(store: SkillStore, maxChars = 100_000): RegisteredTool {
  return {
    definition: {
      name: "read_skill_file",
      description: "Open a file inside a loaded skill's folder (for example a template linked from its SKILL.md).",
      inputSchema: {
        type: "object",
        properties: {
          skill: { type: "string" },
          path: { type: "string", description: "Path relative to the skill folder, as linked in SKILL.md." },
        },
        required: ["skill", "path"],
        additionalProperties: false,
      },
      effects: ["read"],
      source: "builtin",
    },
    summarize: (input) => `Read ${String(input["path"])} from skill ${String(input["skill"])}`,
    async run(input, ctx) {
      const skill = String(input["skill"]).trim();
      const m = await ctx.skills.manifest(skill);
      if (!m) return fail(await unknownSkill(skill, ctx));
      if (!ctx.skills.isLoaded(skill)) return fail(`Load the skill first: call load_skill with name "${skill}".`);
      let path: string;
      try {
        path = normaliseRelativePath(String(input["path"]));
      } catch (e) {
        return fail(errorMessage(e));
      }
      if (!path) return fail("path must name a file in the skill folder");
      if (!m.files.includes(path)) {
        const hint = m.linkedFiles.length ? ` Linked files: ${m.linkedFiles.join(", ")}.` : "";
        return fail(`"${path}" is not a file in skill "${skill}".${hint}`);
      }
      try {
        const text = await store.readFile(skill, path);
        ctx.emit({ type: "skill_file_read", skill, file: path });
        return ok(truncateText(text, maxChars, "file").text);
      } catch (e) {
        return fail(`could not read ${path}: ${errorMessage(e)}`);
      }
    },
  };
}

/** What running one of the skill's scripts can do, from its oneseat.json. */
export function scriptEffects(m: SkillManifest): ToolEffect[] {
  const out = new Set<ToolEffect>(["read"]);
  if (m.permissions.write.length > 0) out.add("write");
  if (m.permissions.net.length > 0) out.add("network");
  if (m.permissions.run.length > 0) out.add("write");
  for (const e of m.effects) out.add(e);
  if ([...out].some((e) => e === "write" || e === "send" || e === "pay" || e === "delete")) out.delete("read");
  return (["read", "write", "network", "send", "pay", "delete"] as ToolEffect[]).filter((e) => out.has(e));
}

export function runSkillScriptTool(sandbox: ScriptSandbox | undefined): RegisteredTool {
  return {
    definition: {
      name: "run_skill_script",
      description: "Run a script a loaded skill declares, in a sandbox with only the skill's declared permissions.",
      inputSchema: {
        type: "object",
        properties: {
          skill: { type: "string" },
          script: { type: "string", description: "Script name from the skill's Scripts list." },
          args: { type: "array", items: { type: "string" } },
          input: { type: "string", description: "Text passed to the script on stdin." },
        },
        required: ["skill", "script"],
        additionalProperties: false,
      },
      effects: ["read"],
      source: "builtin",
    },
    async effectsFor(input, ctx) {
      const m = await ctx.skills.manifest(String(input["skill"]));
      return m ? scriptEffects(m) : ["read"];
    },
    async summarize(input, ctx) {
      const skill = String(input["skill"]);
      const script = String(input["script"]);
      const m = await ctx.skills.manifest(skill);
      const desc = m?.scripts[script]?.description;
      const args = (input["args"] as string[] | undefined) ?? [];
      const effects = m?.effects.length ? ` (can ${m.effects.join(", ")})` : "";
      return `Run script "${script}" of skill ${skill}${desc ? ` - ${desc}` : ""}${args.length ? ` with ${args.join(" ")}` : ""}${effects}`;
    },
    async run(input, ctx) {
      const skill = String(input["skill"]);
      const m = await ctx.skills.manifest(skill);
      if (!m) return fail(await unknownSkill(skill, ctx));
      if (!ctx.skills.isLoaded(skill)) return fail(`Load the skill first: call load_skill with name "${skill}".`);
      if (!sandbox?.available) return fail("Scripts cannot run: the Deno sandbox is not installed.");
      try {
        const r = await sandbox.run({
          manifest: m,
          script: String(input["script"]),
          args: (input["args"] as string[] | undefined) ?? [],
          stdin: typeof input["input"] === "string" ? input["input"] : "",
          signal: ctx.signal,
        });
        const out = {
          exitCode: r.exitCode,
          ...(r.timedOut ? { timedOut: true } : {}),
          ...(r.truncated ? { truncated: true } : {}),
          stdout: r.stdout,
          stderr: r.stderr,
        };
        const failed = r.timedOut || r.aborted || r.exitCode !== 0;
        return { content: JSON.stringify(out, null, 2), isError: failed };
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  };
}

export function createSkillTools(store: SkillStore, sandbox: ScriptSandbox | undefined): RegisteredTool[] {
  return [loadSkillTool(), readSkillFileTool(store), runSkillScriptTool(sandbox)];
}
