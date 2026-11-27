// An in-memory SkillStore for harness tests and eval runs. It uses the contract parser
// and a small, conservative scanner; @oneseat/registry is the real implementation.

import { generateKeyPairSync, sign, verify as verifySignature } from "node:crypto";
import { posix } from "node:path";
import {
  buildManifest,
  emptyPermissions,
  SKILL_FILE,
  SKILL_PERMISSIONS_FILE,
  toIndexEntry,
  type InstalledSkill,
  type InstallResult,
  type LintReport,
  type ScanFinding,
  type ScanReport,
  type SkillEffect,
  type SkillIndexEntry,
  type SkillManifest,
  type SkillPermissions,
  type SkillSource,
  type SkillStore,
} from "@oneseat/contracts";
import { findSkillDirs, hashSkillContents, readSkillFolder, type SkillFolder } from "./skills.js";

export interface MemorySkillInput {
  name: string;
  description: string;
  /** Markdown body of SKILL.md. */
  body?: string;
  /** Extra files, relative path -> content. */
  files?: Record<string, string>;
  permissions?: Partial<SkillPermissions>;
  effects?: SkillEffect[];
  reasons?: Record<string, string>;
  version?: string;
  source?: SkillSource;
}

export interface MemorySkillStore extends SkillStore {
  /** Every readFile() call, in order. */
  readonly reads: { name: string; file: string }[];
  /** Every get() call, in order. */
  readonly gets: string[];
  /** Change a stored file without re-signing (to test verify()). */
  tamper(name: string, file: string, content: string): void;
}

export interface MemorySkillStoreOptions {
  /** Load files for non-local sources (tests). Default: only local folders install. */
  loadSource?: (source: SkillSource) => Promise<Map<string, Buffer>>;
  /** Skill folders read from disk (readSkillFolder) to preload as-is, without a scan. */
  folders?: readonly SkillFolder[];
}

/** Build SKILL.md text from a name, description and body. */
export function renderSkillMd(input: { name: string; description: string; body?: string; version?: string }): string {
  const meta = input.version ? `metadata:\n  version: ${JSON.stringify(input.version)}\n` : "";
  return `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n${meta}---\n${input.body ?? ""}`;
}

function filesFromInput(input: MemorySkillInput): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  files.set(SKILL_FILE, Buffer.from(renderSkillMd(input)));
  for (const [k, v] of Object.entries(input.files ?? {})) files.set(k.replace(/\\/g, "/"), Buffer.from(v));
  if (input.permissions || input.effects || input.reasons)
    files.set(
      SKILL_PERMISSIONS_FILE,
      Buffer.from(JSON.stringify({ permissions: { ...emptyPermissions(), ...input.permissions }, effects: input.effects ?? [], reasons: input.reasons ?? {} })),
    );
  return files;
}

const SCRIPT_EXT = /\.(m?[jt]sx?|cjs|py|sh|ps1|rb|bash|zsh)$/i;
const URL_RE = /\bhttps?:\/\/([a-z0-9.-]+(?::\d+)?)/gi;
const FILE_ESCAPE_RE = /(?:^|["'`\s(])(\/etc\/|\/Users\/|\/home\/|~\/|[A-Za-z]:\\|\.\.\/)/;

/** A conservative scan: undeclared network hosts and file access outside the skill block install. */
export function scanSkillFiles(name: string, files: ReadonlyMap<string, Buffer>, manifest: SkillManifest | undefined): ScanReport {
  const declared = manifest?.permissions ?? emptyPermissions();
  const observed = emptyPermissions();
  const findings: ScanFinding[] = [];
  let bytesRead = 0;
  for (const [file, buf] of files) {
    bytesRead += buf.length;
    if (!SCRIPT_EXT.test(file)) continue;
    const lines = buf.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(URL_RE)) {
        const host = m[1]!.toLowerCase();
        if (!observed.net.includes(host)) observed.net.push(host);
        if (!declared.net.includes(host) && !declared.net.includes(host.split(":")[0]!))
          findings.push({ severity: "block", rule: "undeclared-network", file, line: i + 1, message: `script reaches ${host}, which oneseat.json does not declare` });
      }
      if (FILE_ESCAPE_RE.test(line))
        findings.push({ severity: "block", rule: "undeclared-file", file, line: i + 1, message: "script touches a path outside the skill folder" });
    });
  }
  for (const host of declared.net)
    if (!manifest?.reasons[host]) findings.push({ severity: "warn", rule: "net-reason", file: SKILL_PERMISSIONS_FILE, message: `host ${host} has no reason` });
  const verdict = findings.some((f) => f.severity === "block") ? "block" : findings.some((f) => f.severity === "warn") ? "warn" : "pass";
  const summary =
    verdict === "block"
      ? `${name}: blocked — ${findings.filter((f) => f.severity === "block").length} undeclared access finding(s).`
      : `${name}: ${files.size} file(s); network: ${declared.net.join(", ") || "none"}.`;
  return { skill: name, verdict, summary, findings, declared, observed, filesRead: files.size, bytesRead };
}

/** Normalise a path inside a skill. Returns undefined if it escapes the folder. */
export function safeSkillPath(file: string): string | undefined {
  if (typeof file !== "string" || file.length === 0 || file.includes("\0")) return undefined;
  const p = file.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.startsWith("//")) return undefined;
  const n = posix.normalize(p);
  if (n === ".." || n.startsWith("../") || n.startsWith("/")) return undefined;
  return n.replace(/^\.\//, "");
}

/** Create an in-memory SkillStore preloaded with skills. */
export function createMemorySkillStore(skills: readonly (InstalledSkill | MemorySkillInput)[] = [], opts: MemorySkillStoreOptions = {}): MemorySkillStore {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const entries = new Map<string, { skill: InstalledSkill; files: Map<string, Buffer>; hash: string; sig: string }>();
  const reads: { name: string; file: string }[] = [];
  const gets: string[] = [];

  const signHash = (hash: string) => sign(null, Buffer.from(hash), privateKey).toString("base64");

  function materialise(files: Map<string, Buffer>, source: SkillSource, dirName?: string): { skill?: InstalledSkill; lint: LintReport; scan: ScanReport } {
    const skillMd = files.get(SKILL_FILE);
    const perms = files.get(SKILL_PERMISSIONS_FILE);
    const built = skillMd
      ? buildManifest({ dir: "", ...(dirName ? { dirName } : {}), skillMd: skillMd.toString("utf8"), ...(perms ? { permissionsJson: perms.toString("utf8") } : {}), files: [...files.keys()] })
      : { issues: [{ severity: "error" as const, rule: "skill-md", message: `${SKILL_FILE} is missing`, file: SKILL_FILE }] };
    const name = built.manifest?.frontmatter.name ?? dirName ?? "unknown";
    const lint: LintReport = { skill: name, ok: !built.issues.some((i) => i.severity === "error"), issues: built.issues };
    const scan = scanSkillFiles(name, files, built.manifest);
    if (!built.manifest) return { lint, scan };
    const contentHash = hashSkillContents(files);
    const version = built.manifest.frontmatter.metadata?.["version"] ?? `0.0.0+${contentHash.slice(0, 8)}`;
    const skill: InstalledSkill = { manifest: built.manifest, source, version, contentHash, signature: signHash(contentHash), installedAt: new Date().toISOString() };
    return { skill, lint, scan };
  }

  for (const s of skills) {
    if ("manifest" in s) {
      const files = new Map<string, Buffer>([[SKILL_FILE, Buffer.from(renderSkillMd({ name: s.manifest.frontmatter.name, description: s.manifest.frontmatter.description, body: s.manifest.body }))]]);
      const hash = hashSkillContents(files);
      entries.set(s.manifest.frontmatter.name, { skill: s, files, hash, sig: signHash(hash) });
      continue;
    }
    const files = filesFromInput(s);
    const r = materialise(files, s.source ?? { kind: "local", path: `memory:${s.name}` });
    if (!r.skill) throw new Error(`invalid skill "${s.name}": ${r.lint.issues.map((i) => i.message).join("; ")}`);
    if (s.version) r.skill.version = s.version;
    entries.set(s.name, { skill: r.skill, files, hash: r.skill.contentHash, sig: r.skill.signature });
  }

  for (const folder of opts.folders ?? []) {
    const dirName = posix.basename(folder.dir.replace(/\\/g, "/").replace(/\/+$/, ""));
    const r = materialise(new Map(folder.contents), { kind: "local", path: folder.dir }, dirName);
    if (!r.skill) throw new Error(`invalid skill folder ${folder.dir}: ${r.lint.issues.filter((i) => i.severity === "error").map((i) => i.message).join("; ")}`);
    entries.set(r.skill.manifest.frontmatter.name, { skill: r.skill, files: new Map(folder.contents), hash: r.skill.contentHash, sig: r.skill.signature });
  }

  async function load(source: SkillSource): Promise<{ files: Map<string, Buffer>; dirName?: string }> {
    if (opts.loadSource) return { files: await opts.loadSource(source) };
    if (source.kind !== "local") throw new Error(`the memory store installs local folders only, not ${source.kind}`);
    const folder = await readSkillFolder(source.path);
    return { files: folder.contents, dirName: posix.basename(source.path.replace(/\\/g, "/").replace(/\/+$/, "")) };
  }

  const store: MemorySkillStore = {
    reads,
    gets,
    tamper(name, file, content) {
      const e = entries.get(name);
      if (!e) throw new Error(`skill "${name}" is not installed`);
      e.files.set(file, Buffer.from(content));
    },
    async list() {
      return [...entries.values()].map((e) => e.skill).sort((a, b) => a.manifest.frontmatter.name.localeCompare(b.manifest.frontmatter.name));
    },
    async get(name) {
      gets.push(name);
      return entries.get(name)?.skill;
    },
    async index(): Promise<SkillIndexEntry[]> {
      return (await store.list()).map((s) => toIndexEntry(s.manifest));
    },
    async readFile(name, file) {
      reads.push({ name, file });
      const e = entries.get(name);
      if (!e) throw new Error(`skill "${name}" is not installed`);
      const p = safeSkillPath(file);
      if (p === undefined) throw new Error(`path "${file}" is outside the skill folder`);
      const buf = e.files.get(p);
      if (!buf) throw new Error(`skill "${name}" has no file "${p}"`);
      return buf.toString("utf8");
    },
    async inspect(source) {
      const { files, dirName } = await load(source);
      const r = materialise(files, source, dirName);
      return { scan: r.scan, lint: r.lint };
    },
    async install(source, installOpts = {}): Promise<InstallResult> {
      let loaded: { files: Map<string, Buffer>; dirName?: string };
      try {
        loaded = await load(source);
      } catch (e) {
        const msg = (e as Error).message;
        const empty = scanSkillFiles("unknown", new Map(), undefined);
        return { installed: false, scan: empty, lint: { skill: "unknown", ok: false, issues: [{ severity: "error", rule: "fetch", message: msg }] }, reason: msg };
      }
      const r = materialise(loaded.files, source, loaded.dirName);
      if (!r.lint.ok || !r.skill) return { installed: false, scan: r.scan, lint: r.lint, reason: "lint failed" };
      if (r.scan.verdict === "block") return { installed: false, scan: r.scan, lint: r.lint, reason: r.scan.summary };
      if (r.scan.verdict === "warn" && !installOpts.allowWarnings) return { installed: false, scan: r.scan, lint: r.lint, reason: "scan has warnings; pass allowWarnings" };
      entries.set(r.skill.manifest.frontmatter.name, { skill: r.skill, files: loaded.files, hash: r.skill.contentHash, sig: r.skill.signature });
      return { installed: true, skill: r.skill, scan: r.scan, lint: r.lint };
    },
    async remove(name) {
      return entries.delete(name);
    },
    async verify(name) {
      const e = entries.get(name);
      if (!e) return { ok: false, reason: "not installed" };
      const hash = hashSkillContents(e.files);
      if (hash !== e.hash) return { ok: false, reason: "content hash mismatch" };
      const ok = verifySignature(null, Buffer.from(hash), publicKey, Buffer.from(e.sig, "base64"));
      return ok ? { ok } : { ok, reason: "bad signature" };
    },
  };
  return store;
}

/** A memory store holding every skill folder under dir (or dir itself), files included. */
export async function createSkillStoreFromDir(dir: string): Promise<MemorySkillStore> {
  const folders: SkillFolder[] = [];
  for (const d of await findSkillDirs(dir)) folders.push(await readSkillFolder(d));
  return createMemorySkillStore([], { folders });
}
