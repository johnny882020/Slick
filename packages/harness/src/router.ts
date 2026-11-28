// Skill router. At session start the model sees only each skill's name and a short
// description. It calls load_skill when a task matches; linked files are opened on
// demand with read_skill_file. This module tracks what is loaded per session, which
// skills a run may use (pinned apps), and the allowed-tools restriction.

import { BUSINESS_TABLES, type SkillIndexEntry, type SkillManifest, type SkillStore } from "@oneseat/contracts";
import type { LoadedSkill } from "./stores.js";

/** Tools a loaded skill can always use, whatever its allowed-tools says. */
export const CORE_SKILL_TOOLS = ["load_skill", "read_skill_file", "run_skill_script"] as const;

/** Harness tools that a skill's allowed-tools never hides (asking the person is not a capability). */
export const ALWAYS_ALLOWED_TOOLS = ["ask_user"] as const;

/** ~100 tokens per skill in the index (4 characters per token). */
export const INDEX_DESCRIPTION_CHARS = 400;

export function compactDescription(text: string, max = INDEX_DESCRIPTION_CHARS): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function formatSkillIndex(entries: SkillIndexEntry[]): string {
  return entries.map((e) => `- ${e.name}: ${compactDescription(e.description)}`).join("\n");
}

/** What load_skill returns and what a forced skill puts in the system prompt. */
export function renderSkill(m: SkillManifest): string {
  const lines = [`# Skill: ${m.frontmatter.name}`, "", m.body.trim()];
  if (m.linkedFiles.length > 0) {
    lines.push("", "## Linked files (open with read_skill_file only when the instructions need them)");
    for (const f of m.linkedFiles) lines.push(`- ${f}`);
  }
  const scripts = Object.entries(m.scripts);
  if (scripts.length > 0) {
    lines.push("", "## Scripts (run with run_skill_script)");
    for (const [name, s] of scripts) lines.push(`- ${name}: ${s.description}`);
  }
  if (m.effects.length > 0)
    lines.push("", `## Effects\nThis skill can ${m.effects.join(", ")}. Each such action asks the person first.`);
  if (m.frontmatter.allowedTools && m.frontmatter.allowedTools.length > 0)
    lines.push("", `## Allowed tools\nWhile this skill is active you may use: ${m.frontmatter.allowedTools.join(", ")} (plus the skill tools).`);
  return lines.join("\n");
}

export interface SystemPromptInput {
  now: Date;
  skillsEnabled: boolean;
  index: SkillIndexEntry[];
  /** Skills loaded for the whole session (forced); their instructions go in the prompt. */
  active: SkillManifest[];
  /** Router-loaded skills whose load_skill result was dropped from the context. */
  reloadHints?: string[];
  preamble?: string;
  /** The run can ask the person questions (ask_user is offered). */
  canAsk?: boolean;
}

export const DEFAULT_PREAMBLE = `You are OneSeat, a careful assistant that does repetitive business tasks for a small team.
Work step by step with the tools you have. Prefer facts from tools over guesses, and say plainly when you cannot do something.

Local business data lives in a SQLite database with these tables: ${BUSINESS_TABLES.join(", ")} (and the view customer_ltv).
Read it with db_query (one SELECT at a time; PRAGMA table_info(<table>) shows columns). Change it with db_execute.
Files you make or read live in the workspace (workspace_read, workspace_write, workspace_list).
Remember lasting facts with memory_save and look them up with memory_search.

Any action that sends, pays or deletes asks the person first. If they decline, do not try again another way: say what you would have done and stop.
When you are done, reply with the result itself, short and plain. Your final reply must hold the whole result (the draft, the table, the answer): in pinned apps and schedules it is all the person gets, so never point to text "above".`;

export const ASKING_SECTION = `## Asking the person
Someone is watching this run and can answer questions. Call ask_user only when you truly cannot go on without them: required details are missing (and not in the database, memory or workspace), or there is a real choice only they can make.
Ask one short question at a time, with short options when there are natural choices. Otherwise make a sensible assumption, say what you assumed, and carry on. If they skip a question, go on with your best assumption or say what you still need.`;

export function buildSystemPrompt(input: SystemPromptInput): string {
  const parts = [input.preamble ?? DEFAULT_PREAMBLE, `Today is ${formatLocalDate(input.now)}.`];
  if (input.skillsEnabled && input.index.length > 0) {
    parts.push(
      [
        "## Skills",
        "Skills are folders of instructions for specific tasks. Only their names and descriptions are listed below.",
        "When the task clearly matches a skill's description, call load_skill with its name before any other tool, then follow its instructions. Do this even for a small change such as adding or deleting one record: skills carry the business's rules for that data.",
        "Do not load a skill that does not match, and do not load skills just to look. Open a skill's linked files with read_skill_file only when its instructions call for them; run its declared scripts with run_skill_script.",
        "<skills>",
        formatSkillIndex(input.index),
        "</skills>",
      ].join("\n"),
    );
  }
  for (const m of input.active) parts.push(`## Active skill (loaded for this task)\n${renderSkill(m)}`);
  if (input.reloadHints && input.reloadHints.length > 0)
    parts.push(
      `## Earlier skills\nThese skills were loaded earlier in this conversation: ${input.reloadHints.join(", ")}. Call load_skill again if you need their instructions.`,
    );
  // After the skills: asking is a fallback, never a reason to skip a matching skill.
  if (input.canAsk) parts.push(ASKING_SECTION);
  return parts.join("\n\n");
}

function formatLocalDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `${days[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Does a tool name match an allowed-tools entry? Supports "*" globs; "Tool(args)" matches on the name. */
export function toolMatches(name: string, pattern: string): boolean {
  const p = pattern.replace(/\(.*\)$/, "").trim();
  if (!p) return false;
  if (!p.includes("*")) return p === name;
  const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(name);
}

export interface SkillSessionOptions {
  store: SkillStore;
  /** No-skill baseline: no index, no skill tools. */
  disabled?: boolean;
  /** Restrict the run to these skills (pinned apps). Undefined means all installed skills. */
  allowedSkills?: string[];
  /** Skills already loaded in this session (continuation). */
  loaded?: LoadedSkill[];
}

export class SkillSession {
  readonly disabled: boolean;
  readonly allowedSkills: ReadonlySet<string> | undefined;
  private readonly store: SkillStore;
  private readonly loadedList: LoadedSkill[];
  private readonly manifests = new Map<string, SkillManifest | null>();

  constructor(opts: SkillSessionOptions) {
    this.store = opts.store;
    this.disabled = opts.disabled ?? false;
    this.allowedSkills = opts.allowedSkills ? new Set(opts.allowedSkills) : undefined;
    this.loadedList = (opts.loaded ?? []).filter((l) => this.isAllowed(l.name));
  }

  isAllowed(name: string): boolean {
    if (this.disabled) return false;
    return this.allowedSkills === undefined || this.allowedSkills.has(name);
  }

  async index(): Promise<SkillIndexEntry[]> {
    if (this.disabled) return [];
    const all = await this.store.index();
    return all.filter((e) => this.isAllowed(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The manifest of an installed skill this run may use, or undefined. */
  async manifest(name: string): Promise<SkillManifest | undefined> {
    if (!this.isAllowed(name)) return undefined;
    if (!this.manifests.has(name)) {
      const s = await this.store.get(name);
      this.manifests.set(name, s ? s.manifest : null);
    }
    return this.manifests.get(name) ?? undefined;
  }

  get loaded(): readonly LoadedSkill[] {
    return this.loadedList;
  }

  isLoaded(name: string): boolean {
    return this.loadedList.some((l) => l.name === name);
  }

  /** Record a load. Returns true the first time a skill is loaded in this session. */
  markLoaded(name: string, reason: LoadedSkill["reason"]): boolean {
    const existing = this.loadedList.find((l) => l.name === name);
    if (existing) {
      if (reason === "forced") existing.reason = "forced";
      return false;
    }
    this.loadedList.push({ name, reason });
    return true;
  }

  /**
   * Extra-tool restriction from allowed-tools. Undefined when no loaded skill declares
   * allowed-tools; otherwise the union of the declared lists (core skill tools always allowed).
   */
  async allowedToolPatterns(): Promise<string[] | undefined> {
    let patterns: string[] | undefined;
    for (const l of this.loadedList) {
      const m = await this.manifest(l.name);
      const at = m?.frontmatter.allowedTools;
      if (at && at.length > 0) patterns = [...(patterns ?? []), ...at];
    }
    return patterns;
  }

  async toolAllowed(name: string): Promise<boolean> {
    if ((CORE_SKILL_TOOLS as readonly string[]).includes(name) || (ALWAYS_ALLOWED_TOOLS as readonly string[]).includes(name)) return true;
    const patterns = await this.allowedToolPatterns();
    return patterns === undefined || patterns.some((p) => toolMatches(name, p));
  }
}
