import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import {
  buildManifest,
  createScriptedProvider,
  type ApprovalDecision,
  type ApprovalHandler,
  type HarnessEvent,
  type InstalledSkill,
  type InstallResult,
  type LintReport,
  type ScanReport,
  type ScriptEntry,
  type SkillIndexEntry,
  type SkillPermissionsFile,
  type SkillSource,
  type SkillStore,
  type TaskRequest,
} from "@oneseat/contracts";
import { afterEach } from "vitest";
import { OneSeatDb } from "../src/db.js";
import { Harness, type HarnessOptions } from "../src/harness.js";

const cleanups: (() => void)[] = [];
/** Assertion errors thrown inside scripted turns (the harness would treat them as provider errors). */
const scriptErrors: Error[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* ignore */
    }
  }
  const errs = scriptErrors.splice(0);
  if (errs.length > 0) throw new Error(`assertion failed inside a scripted turn: ${errs.map((e) => e.message).join(" | ")}`);
});

/** Wrap function entries so a failed expect() inside them fails the test. */
export function checked(script: ScriptEntry[]): ScriptEntry[] {
  return script.map((entry) =>
    typeof entry === "function"
      ? (req, i) => {
          try {
            return entry(req, i);
          } catch (e) {
            scriptErrors.push(e as Error);
            throw e;
          }
        }
      : entry,
  );
}

export function tmpDir(prefix = "oneseat-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

export function onCleanup(fn: () => void): void {
  cleanups.push(fn);
}

export interface SkillSpec {
  name: string;
  description: string;
  body?: string;
  allowedTools?: string;
  /** Extra files, path -> content. */
  files?: Record<string, string>;
  oneseat?: SkillPermissionsFile;
}

export function skillMd(spec: SkillSpec): string {
  const lines = ["---", `name: ${spec.name}`, `description: ${JSON.stringify(spec.description)}`];
  if (spec.allowedTools) lines.push(`allowed-tools: ${spec.allowedTools}`);
  lines.push("---", spec.body ?? `# ${spec.name}\n\nDo the ${spec.name} task.`);
  return lines.join("\n") + "\n";
}

/** Write a skill folder to disk. */
export function writeSkill(root: string, spec: SkillSpec): string {
  const dir = join(root, spec.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd(spec));
  if (spec.oneseat) writeFileSync(join(dir, "oneseat.json"), JSON.stringify(spec.oneseat, null, 2));
  for (const [p, c] of Object.entries(spec.files ?? {})) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

const passScan = (skill: string): ScanReport => ({
  skill,
  verdict: "pass",
  summary: "test",
  findings: [],
  declared: { net: [], read: [], write: [], env: [], run: [] },
  observed: { net: [], read: [], write: [], env: [], run: [] },
  filesRead: 0,
  bytesRead: 0,
});

/** In-memory SkillStore test double (stream C builds the real one). */
export class MemorySkillStore implements SkillStore {
  readonly skills = new Map<string, { installed: InstalledSkill; files: Record<string, string> }>();
  readonly reads: { name: string; file: string }[] = [];

  add(spec: SkillSpec): InstalledSkill {
    const files: Record<string, string> = { "SKILL.md": skillMd(spec), ...(spec.files ?? {}) };
    if (spec.oneseat) files["oneseat.json"] = JSON.stringify(spec.oneseat);
    const { manifest, issues } = buildManifest({
      dir: "",
      dirName: spec.name,
      skillMd: files["SKILL.md"]!,
      ...(files["oneseat.json"] ? { permissionsJson: files["oneseat.json"] } : {}),
      files: Object.keys(files),
    });
    if (!manifest) throw new Error(`bad skill: ${issues.map((i) => i.message).join("; ")}`);
    const installed: InstalledSkill = {
      manifest,
      source: { kind: "local", path: `/mem/${spec.name}` },
      version: "1.0.0",
      contentHash: "0".repeat(64),
      signature: "",
      installedAt: new Date(0).toISOString(),
    };
    this.skills.set(spec.name, { installed, files });
    return installed;
  }

  /** Add a skill that lives on disk (for the sandbox). */
  addDir(dir: string): InstalledSkill {
    const files: Record<string, string> = {};
    for (const f of listFiles(dir)) files[f] = readFileSync(join(dir, f), "utf8");
    const name = dir.split(sep).pop()!;
    const { manifest, issues } = buildManifest({
      dir,
      dirName: name,
      skillMd: files["SKILL.md"]!,
      ...(files["oneseat.json"] ? { permissionsJson: files["oneseat.json"] } : {}),
      files: Object.keys(files),
    });
    if (!manifest) throw new Error(`bad skill: ${issues.map((i) => i.message).join("; ")}`);
    const installed: InstalledSkill = {
      manifest,
      source: { kind: "local", path: dir },
      version: "1.0.0",
      contentHash: "0".repeat(64),
      signature: "",
      installedAt: new Date(0).toISOString(),
    };
    this.skills.set(name, { installed, files });
    return installed;
  }

  async list(): Promise<InstalledSkill[]> {
    return [...this.skills.values()].map((s) => s.installed);
  }
  async get(name: string): Promise<InstalledSkill | undefined> {
    return this.skills.get(name)?.installed;
  }
  async index(): Promise<SkillIndexEntry[]> {
    return [...this.skills.values()].map((s) => ({
      name: s.installed.manifest.frontmatter.name,
      description: s.installed.manifest.frontmatter.description,
    }));
  }
  async readFile(name: string, file: string): Promise<string> {
    const s = this.skills.get(name);
    if (!s) throw new Error(`no skill ${name}`);
    if (file.startsWith("/") || file.split("/").includes("..")) throw new Error("path outside the skill folder");
    const c = s.files[file];
    if (c === undefined) throw new Error(`no file ${file}`);
    this.reads.push({ name, file });
    return c;
  }
  async install(source: SkillSource): Promise<InstallResult> {
    const name = source.kind === "local" ? source.path.split("/").pop()! : "x";
    const lint: LintReport = { skill: name, ok: true, issues: [] };
    return { installed: false, scan: passScan(name), lint, reason: "test double" };
  }
  async inspect(source: SkillSource): Promise<{ scan: ScanReport; lint: LintReport }> {
    const name = source.kind === "local" ? source.path.split("/").pop()! : source.repo;
    return { scan: passScan(name), lint: { skill: name, ok: true, issues: [] } };
  }
  async remove(name: string): Promise<boolean> {
    return this.skills.delete(name);
  }
  async verify(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

export async function collect(events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

export function ofType<T extends HarnessEvent["type"]>(events: HarnessEvent[], type: T): Extract<HarnessEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<HarnessEvent, { type: T }>[];
}

export function done(events: HarnessEvent[]): Extract<HarnessEvent, { type: "done" }> {
  const d = events[events.length - 1];
  if (!d || d.type !== "done") throw new Error(`last event is ${d?.type}, not done`);
  return d;
}

export const approveAll: ApprovalHandler = async () => ({ approved: true });
export const denyAll =
  (note?: string): ApprovalHandler =>
  async () =>
    ({ approved: false, ...(note ? { note } : {}) }) as ApprovalDecision;

export function setup(
  script: ScriptEntry[],
  extra: Partial<HarnessOptions> & { store?: MemorySkillStore } = {},
): { harness: Harness; provider: ReturnType<typeof createScriptedProvider>; db: OneSeatDb; store: MemorySkillStore; dir: string } {
  const dir = tmpDir();
  const db = OneSeatDb.open(dir);
  onCleanup(() => db.close());
  const store = extra.store ?? new MemorySkillStore();
  const provider = createScriptedProvider(checked(script));
  const harness = new Harness({
    store,
    db,
    provider: () => provider,
    workspaceDir: join(dir, "workspace"),
    sleep: async () => undefined,
    ...extra,
  });
  return { harness, provider, db, store, dir };
}

export function task(input: string, more: Partial<TaskRequest> = {}): TaskRequest {
  return { input, provider: "local", model: "scripted-1", ...more };
}
