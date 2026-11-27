// The SkillStore: install skills into <dataDir>/skills/<name>/ after they pass
// the scan (gate 4) and lint (gate 3), sign their content hash, and record
// them in <dataDir>/skills.lock.json.
//
// Layout:
//   <dataDir>/skills/<name>/           installed skill folders
//   <dataDir>/skills.lock.json         InstalledSkill records
//   <dataDir>/keys/install-signing.pem local ed25519 integrity key (0600)
//   <dataDir>/staging/                 temporary fetch folders
//
// A source holding many skills is installed as a unit: every skill is scanned
// and linted first, and if any is blocked, has lint errors, or (without
// allowWarnings) has warnings, none is installed. Name one skill
// ("owner/repo@skill") to install just that one.

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, resolve } from "node:path";
import {
  buildManifest,
  SKILL_FILE,
  SKILL_PERMISSIONS_FILE,
  toIndexEntry,
  type InstallResult,
  type InstalledSkill,
  type LintReport,
  type ScanReport,
  type SkillIndexEntry,
  type SkillSource,
  type SkillStore,
} from "@oneseat/contracts";
import { RegistryError } from "./errors.js";
import { fileEntry, filePaths, isInside, loadSkillDir, textOf, writeSkill } from "./files.js";
import { InstallSigner, hashDir } from "./integrity.js";
import { inspectSource, type SkillCheck } from "./inspect.js";
import { DEFAULT_LIMITS, type SourceLimits } from "./limits.js";
import { isSemver } from "./lint.js";
import type { FetchLike } from "./sources.js";

export const LOCK_FILE = "skills.lock.json";
export const SIGNING_KEY_FILE = join("keys", "install-signing.pem");
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface SkillStoreOptions {
  /** Folder that holds skills, the lockfile and the install key. */
  dataDir: string;
  /** Injectable fetch (tests, proxies). Default: globalThis.fetch. */
  fetch?: FetchLike;
  /** Where the ed25519 install key lives. Default: <dataDir>/keys/install-signing.pem. */
  signingKeyPath?: string;
  /** Source size caps. Default: 50 MB, 2000 files. */
  limits?: SourceLimits;
  /** Clock (tests). */
  now?: () => Date;
}

export interface RegistryInstallResult extends InstallResult {
  /** Every skill installed by this call (a source can hold many). */
  skills: InstalledSkill[];
  /** Per-skill reports. */
  checks: { name: string; scan: ScanReport; lint: LintReport }[];
}

export interface RegistrySkillStore extends SkillStore {
  readonly dataDir: string;
  readonly skillsDir: string;
  readonly lockPath: string;
  readonly signingKeyPath: string;
  install(source: SkillSource, opts?: { allowWarnings?: boolean }): Promise<RegistryInstallResult>;
  /** Like inspect(), with one report pair per skill in the source. */
  inspectAll(source: SkillSource): Promise<{ name: string; scan: ScanReport; lint: LintReport }[]>;
  /** PEM of the public half of the install key. */
  publicKey(): Promise<string>;
}

interface LockFile {
  lockfileVersion: 1;
  skills: Record<string, InstalledSkill>;
}

function assertName(name: string): void {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.length > 64)
    throw new RegistryError("bad-path", `invalid skill name "${name}"`);
}

function rand(): string {
  return randomBytes(6).toString("hex");
}

/** Version from metadata.version when it is semver, else 0.0.0+<first 8 of hash>. */
export function skillVersion(metadataVersion: string | undefined, contentHash: string): string {
  if (metadataVersion && isSemver(metadataVersion)) return metadataVersion;
  return `0.0.0+${contentHash.slice(0, 8)}`;
}

function firstMessages(reports: { name: string; scan: ScanReport; lint: LintReport }[], pick: (r: (typeof reports)[number]) => string[]): string {
  const msgs = reports.flatMap((r) => pick(r).map((m) => `${r.name}: ${m}`));
  const shown = msgs.slice(0, 3).join("; ");
  return msgs.length > 3 ? `${shown}; and ${msgs.length - 3} more` : shown;
}

export function createSkillStore(options: SkillStoreOptions): RegistrySkillStore {
  const dataDir = resolve(options.dataDir);
  const skillsDir = join(dataDir, "skills");
  const lockPath = join(dataDir, LOCK_FILE);
  const stagingRoot = join(dataDir, "staging");
  const signingKeyPath = resolve(options.signingKeyPath ?? join(dataDir, SIGNING_KEY_FILE));
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const limits = options.limits ?? DEFAULT_LIMITS;
  const now = options.now ?? (() => new Date());

  // One write at a time inside this process.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function readLock(): Promise<LockFile> {
    let text: string;
    try {
      text = await readFile(lockPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { lockfileVersion: 1, skills: {} };
      throw e;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new RegistryError("lockfile", `${LOCK_FILE} is not valid JSON: ${(e as Error).message}`);
    }
    const lock = raw as Partial<LockFile>;
    if (!lock || typeof lock !== "object" || lock.lockfileVersion !== 1 || typeof lock.skills !== "object" || lock.skills === null)
      throw new RegistryError("lockfile", `${LOCK_FILE} has an unknown format`);
    return lock as LockFile;
  }

  async function writeLock(lock: LockFile): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const tmp = `${lockPath}.${rand()}.tmp`;
    const sorted: LockFile = { lockfileVersion: 1, skills: {} };
    for (const k of Object.keys(lock.skills).sort()) sorted.skills[k] = lock.skills[k]!;
    await writeFile(tmp, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o644 });
    await rename(tmp, lockPath);
  }

  async function cleanLeftovers(): Promise<void> {
    const names = await readdir(skillsDir).catch(() => [] as string[]);
    for (const n of names) if (n.startsWith(".tmp-") || n.startsWith(".old-")) await rm(join(skillsDir, n), { recursive: true, force: true });
  }

  function normaliseSource(source: SkillSource): SkillSource {
    return source.kind === "local" ? { kind: "local", path: resolve(source.path) } : source;
  }

  async function inspectInternal(source: SkillSource) {
    return inspectSource(normaliseSource(source), { fetch: fetchFn, limits, stagingRoot });
  }

  const named = (checks: SkillCheck[]) => checks.map((c) => ({ name: c.lint.skill, scan: c.scan, lint: c.lint }));

  async function installChecks(source: SkillSource, checks: SkillCheck[]): Promise<InstalledSkill[]> {
    await mkdir(skillsDir, { recursive: true });
    await cleanLeftovers();
    const signer = await InstallSigner.open(signingKeyPath, { create: true });
    // Phase 1: write every skill to a temp folder and hash it.
    const staged: { name: string; tmp: string; hash: string }[] = [];
    try {
      for (const c of checks) {
        const name = c.lint.skill;
        assertName(name);
        const tmp = join(skillsDir, `.tmp-${name}-${rand()}`);
        staged.push({ name, tmp, hash: "" });
        await writeSkill(c.loaded, tmp);
        staged[staged.length - 1]!.hash = await hashDir(tmp);
      }
    } catch (e) {
      for (const s of staged) await rm(s.tmp, { recursive: true, force: true });
      throw e;
    }
    // Phase 2: swap each into place (rename is atomic on one filesystem).
    const lock = await readLock();
    const installed: InstalledSkill[] = [];
    for (const s of staged) {
      const final = join(skillsDir, s.name);
      let old: string | undefined;
      if (await lstat(final).catch(() => undefined)) {
        old = join(skillsDir, `.old-${s.name}-${rand()}`);
        await rename(final, old);
      }
      await rename(s.tmp, final);
      if (old) await rm(old, { recursive: true, force: true });
      const loaded = await loadSkillDir(final, limits);
      const skillMd = fileEntry(loaded, SKILL_FILE)!;
      const perm = fileEntry(loaded, SKILL_PERMISSIONS_FILE);
      const built = buildManifest({
        dir: final,
        dirName: s.name,
        skillMd: textOf(skillMd.bytes),
        permissionsJson: perm ? textOf(perm.bytes) : undefined,
        files: filePaths(loaded),
      });
      const manifest = built.manifest!;
      const record: InstalledSkill = {
        manifest,
        source,
        version: skillVersion(manifest.frontmatter.metadata?.["version"], s.hash),
        contentHash: s.hash,
        signature: signer.sign(s.hash),
        installedAt: now().toISOString(),
      };
      lock.skills[s.name] = record;
      installed.push(record);
    }
    // Phase 3: record them.
    await writeLock(lock);
    return installed;
  }

  const store: RegistrySkillStore = {
    dataDir,
    skillsDir,
    lockPath,
    signingKeyPath,

    async list() {
      const lock = await readLock();
      return Object.keys(lock.skills)
        .sort()
        .map((k) => lock.skills[k]!);
    },

    async get(name) {
      const lock = await readLock();
      return Object.prototype.hasOwnProperty.call(lock.skills, name) ? lock.skills[name] : undefined;
    },

    async index(): Promise<SkillIndexEntry[]> {
      return (await store.list()).map((s) => toIndexEntry(s.manifest));
    },

    async readFile(name, file) {
      const rec = await store.get(name);
      if (!rec) throw new RegistryError("not-installed", `skill "${name}" is not installed`);
      if (typeof file !== "string" || file.length === 0 || file.includes("\0"))
        throw new RegistryError("bad-path", "file path must be a non-empty string");
      const posixFile = file.replace(/\\/g, "/");
      if (posix.isAbsolute(posixFile) || isAbsolute(file) || /^[A-Za-z]:/.test(file))
        throw new RegistryError("bad-path", `"${file}" must be relative to the skill folder`);
      const segs = posix.normalize(posixFile).split("/");
      if (segs.includes("..")) throw new RegistryError("bad-path", `"${file}" is outside the skill folder`);
      const dir = join(skillsDir, name);
      const abs = join(dir, ...segs);
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        throw new RegistryError("bad-path", `"${file}" does not exist in skill "${name}"`);
      }
      if (!isInside(await realpath(dir), real)) throw new RegistryError("bad-path", `"${file}" is outside the skill folder`);
      if (!(await stat(real)).isFile()) throw new RegistryError("bad-path", `"${file}" is not a file`);
      return readFile(real, "utf8");
    },

    async inspect(source) {
      const out = await inspectInternal(source);
      return { scan: out.scan, lint: out.lint };
    },

    async inspectAll(source) {
      const out = await inspectInternal(source);
      return out.checks.length ? named(out.checks) : [{ name: out.label, scan: out.scan, lint: out.lint }];
    },

    install(source, opts = {}) {
      return exclusive(async (): Promise<RegistryInstallResult> => {
        const src = normaliseSource(source);
        const out = await inspectInternal(src);
        const reports = named(out.checks);
        const refuse = (reason: string): RegistryInstallResult => ({ installed: false, scan: out.scan, lint: out.lint, reason, skills: [], checks: reports });
        if (out.unsafe) return refuse(`source refused: ${out.unsafe.entries.length} unsafe entries (${out.unsafe.entries.map((e) => e.rule).join(", ")})`);
        const names = reports.map((r) => r.name);
        const dup = names.find((n, i) => names.indexOf(n) !== i);
        if (dup) return refuse(`the source holds two skills named "${dup}"`);
        const blocked = reports.filter((r) => r.scan.verdict === "block");
        if (blocked.length)
          return refuse(`blocked by the security scan: ${firstMessages(blocked, (r) => r.scan.findings.filter((f) => f.severity === "block").map((f) => `${f.file}${f.line ? `:${f.line}` : ""} ${f.message}`))}`);
        const lintFailed = reports.filter((r) => !r.lint.ok);
        if (lintFailed.length)
          return refuse(`lint errors: ${firstMessages(lintFailed, (r) => r.lint.issues.filter((i) => i.severity === "error").map((i) => i.message))}`);
        const warned = reports.filter((r) => r.scan.verdict === "warn" || r.lint.issues.some((i) => i.severity === "warning"));
        if (warned.length && !opts.allowWarnings)
          return refuse(
            `has warnings (pass allowWarnings to accept them): ${firstMessages(warned, (r) => [
              ...r.scan.findings.filter((f) => f.severity === "warn").map((f) => f.message),
              ...r.lint.issues.filter((i) => i.severity === "warning").map((i) => i.message),
            ])}`,
          );
        const skills = await installChecks(src, out.checks);
        return { installed: true, skill: skills[0], skills, scan: out.scan, lint: out.lint, checks: reports };
      });
    },

    remove(name) {
      return exclusive(async () => {
        assertName(name);
        const lock = await readLock();
        const dir = join(skillsDir, name);
        const exists = Boolean(await lstat(dir).catch(() => undefined));
        const recorded = Object.prototype.hasOwnProperty.call(lock.skills, name);
        if (!exists && !recorded) return false;
        if (exists) {
          const trash = join(skillsDir, `.old-${name}-${rand()}`);
          await rename(dir, trash);
          await rm(trash, { recursive: true, force: true });
        }
        if (recorded) {
          delete lock.skills[name];
          await writeLock(lock);
        }
        return true;
      });
    },

    async verify(name) {
      const rec = await store.get(name);
      if (!rec) return { ok: false, reason: `skill "${name}" is not installed` };
      assertName(name);
      const dir = join(skillsDir, name);
      const st = await lstat(dir).catch(() => undefined);
      if (!st?.isDirectory()) return { ok: false, reason: "the skill folder is missing" };
      const hash = await hashDir(dir);
      if (hash !== rec.contentHash) return { ok: false, reason: "files changed since install (content hash does not match)" };
      let signer: InstallSigner;
      try {
        signer = await InstallSigner.open(signingKeyPath, { create: false });
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
      if (!signer.verify(rec.contentHash, rec.signature)) return { ok: false, reason: "signature does not match the install key" };
      return { ok: true };
    },

    async publicKey() {
      return (await InstallSigner.open(signingKeyPath, { create: true })).publicKeyPem();
    },
  };
  return store;
}
