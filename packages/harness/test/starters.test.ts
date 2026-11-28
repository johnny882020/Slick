import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { RPC_ERRORS, type InstallResult, type ScanReport, type SkillSource } from "@oneseat/contracts";
import { createDaemon, parseSourceText, type DaemonOptions } from "../src/daemon.js";
import { installResult, listBundledSkills, RemovedStarters, REMOVED_STARTERS_FILE, seedStarterSkills } from "../src/starters.js";
import { MemorySkillStore, onCleanup, tmpDir, writeSkill } from "./helpers.js";

const scan = (skill: string, verdict: ScanReport["verdict"] = "pass"): ScanReport => ({
  skill,
  verdict,
  summary: "test",
  findings: [],
  declared: { net: [], read: [], write: [], env: [], run: [] },
  observed: { net: [], read: [], write: [], env: [], run: [] },
  filesRead: 0,
  bytesRead: 0,
});

/** A store that really installs local folders (through addDir), or refuses named ones. */
class InstallingStore extends MemorySkillStore {
  readonly installs: SkillSource[] = [];
  readonly refuse = new Set<string>();
  override async install(source: SkillSource): Promise<InstallResult> {
    this.installs.push(source);
    if (source.kind !== "local") return super.install(source);
    const name = basename(source.path);
    const lint = { skill: name, ok: true, issues: [] };
    if (this.refuse.has(name)) return { installed: false, scan: scan(name, "block"), lint, reason: "blocked by the security scan" };
    const skill = this.addDir(source.path);
    // Like the registry: extra fields beyond InstallResult.
    return { installed: true, skill, scan: scan(name), lint, skills: [skill], checks: [] } as InstallResult;
  }
}

function bundle(): string {
  const dir = tmpDir("oneseat-bundle-");
  writeSkill(dir, { name: "social-posts", description: "Plan and draft social posts. Use for social media." });
  writeSkill(dir, { name: "weekly-report", description: "Write the weekly report. Use on Mondays." });
  writeSkill(dir, { name: "customers", description: "Look up customers. Use for customer questions." });
  // Not starter skills: hidden, underscored, no SKILL.md, a plain file.
  writeSkill(dir, { name: ".hidden", description: "x" });
  writeSkill(dir, { name: "_shared", description: "x" });
  mkdirSync(join(dir, "no-skill-md"));
  writeFileSync(join(dir, "README.md"), "# starters\n");
  return dir;
}

describe("starter skills on disk", () => {
  it("lists bundled skills with name and description from SKILL.md", () => {
    const dir = bundle();
    mkdirSync(join(dir, "broken"));
    writeFileSync(join(dir, "broken", "SKILL.md"), "no frontmatter here");
    mkdirSync(join(dir, "folder-name"));
    writeFileSync(join(dir, "folder-name", "SKILL.md"), "---\nname: renamed\ndescription: 7\n---\nbody\n");
    expect(listBundledSkills(dir).map((b) => [b.name, b.description])).toEqual([
      ["broken", ""],
      ["customers", "Look up customers. Use for customer questions."],
      ["renamed", ""],
      ["social-posts", "Plan and draft social posts. Use for social media."],
      ["weekly-report", "Write the weekly report. Use on Mondays."],
    ]);
    expect(listBundledSkills(dir).find((b) => b.name === "renamed")!.dir).toBe(join(dir, "folder-name"));
    expect(listBundledSkills(undefined)).toEqual([]);
    expect(listBundledSkills(join(dir, "missing"))).toEqual([]);
  });

  it("remembers removed starter skills in a small JSON file", () => {
    const dataDir = join(tmpDir(), "nested");
    const r = new RemovedStarters(dataDir);
    expect(r.list()).toEqual([]);
    r.add("social-posts");
    r.add("customers");
    r.add("social-posts");
    expect(r.list()).toEqual(["customers", "social-posts"]);
    expect(r.has("customers")).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, REMOVED_STARTERS_FILE), "utf8"))).toEqual({ version: 1, removed: ["customers", "social-posts"] });
    r.delete("customers");
    r.delete("not-there");
    expect(r.list()).toEqual(["social-posts"]);
    expect(new RemovedStarters(dataDir).has("social-posts")).toBe(true);
  });

  it("treats a damaged file as nothing removed", () => {
    const dataDir = tmpDir();
    const r = new RemovedStarters(dataDir);
    for (const text of ["{not json", "null", '{"removed": "social-posts"}', "[]"]) {
      writeFileSync(r.path, text);
      expect(r.list()).toEqual([]);
    }
    writeFileSync(r.path, JSON.stringify({ removed: ["a", 3, "", "x".repeat(65), "a", "b"] }));
    expect(r.list()).toEqual(["a", "b"]);
  });

  it("seeds what is neither installed nor removed, and logs refusals", async () => {
    const dir = bundle();
    const dataDir = tmpDir();
    const store = new InstallingStore();
    store.add({ name: "weekly-report", description: "Already here. Use always." });
    store.refuse.add("customers");
    new RemovedStarters(dataDir).add("social-posts");
    const logs: string[] = [];
    expect(await seedStarterSkills(store, dir, dataDir, (l) => logs.push(l))).toEqual([]);
    expect(logs).toEqual(["bundled skill customers not installed: blocked by the security scan"]);
    store.refuse.clear();
    expect(await seedStarterSkills(store, dir, dataDir, () => {})).toEqual(["customers"]);
    expect(await seedStarterSkills(store, undefined, dataDir, () => {})).toEqual([]);
    expect(store.installs.map((s) => (s.kind === "local" ? basename(s.path) : s.kind))).toEqual(["customers", "customers"]);
  });

  it("logs the verdict when a refusal has no reason", async () => {
    const dir = bundle();
    const store = new (class extends MemorySkillStore {
      override async install(): Promise<InstallResult> {
        return { installed: false, scan: scan("x", "block"), lint: { skill: "x", ok: true, issues: [] } };
      }
    })();
    const logs: string[] = [];
    await seedStarterSkills(store, dir, tmpDir(), (l) => logs.push(l));
    expect(logs).toContain("bundled skill customers not installed: block");
  });

  it("keeps only the contract fields of an install result", () => {
    const r = { installed: false, scan: scan("a"), lint: { skill: "a", ok: true, issues: [] }, skills: [], checks: [] } as InstallResult;
    expect(installResult(r)).toEqual({ installed: false, scan: r.scan, lint: r.lint });
  });
});

describe("parseSourceText", () => {
  it("reads skills.sh ids and names, and everything parseSkillSource reads", () => {
    expect(parseSourceText("skills.sh:anthropics/knowledge-work-plugins/invoice-chase")).toEqual({
      kind: "skills.sh",
      owner: "anthropics",
      repo: "knowledge-work-plugins",
      skill: "invoice-chase",
    });
    expect(parseSourceText(" skills.sh:o/r@s ")).toEqual({ kind: "skills.sh", owner: "o", repo: "r", skill: "s" });
    expect(parseSourceText("skills.sh:o/r")).toEqual({ kind: "skills.sh", owner: "o", repo: "r" });
    expect(parseSourceText("o/r@s")).toEqual({ kind: "skills.sh", owner: "o", repo: "r", skill: "s" });
    expect(parseSourceText("./folder")).toEqual({ kind: "local", path: "./folder" });
    expect(() => parseSourceText("skills.sh:../etc")).toThrow(/is not a skills.sh name/);
  });
});

function daemonWith(extra: Partial<DaemonOptions> = {}, dataDir = tmpDir()) {
  const store = (extra.store as InstallingStore | undefined) ?? new InstallingStore();
  const daemon = createDaemon({ store, providers: {}, dataDir, startScheduler: false, log: () => {}, ...extra });
  onCleanup(() => void daemon.close());
  return { daemon, store, dataDir };
}

describe("skills.restorable / skills.restore / skills.remove", () => {
  it("removing a starter skill marks it; restoring reinstalls it from the bundle and clears the mark", async () => {
    const dir = bundle();
    const store = new InstallingStore();
    for (const b of listBundledSkills(dir)) store.addDir(b.dir);
    store.add({ name: "my-own", description: "Not a starter. Use for tests." });
    const { daemon, dataDir } = daemonWith({ store, bundledSkillsDir: dir });
    const removed = new RemovedStarters(dataDir);

    expect(await daemon.handle("skills.restorable", {})).toEqual({ skills: [] });
    expect(await daemon.handle("skills.remove", { name: "my-own" })).toEqual({ ok: true });
    expect(removed.list()).toEqual([]); // not a starter skill
    expect(await daemon.handle("skills.remove", { name: "social-posts" })).toEqual({ ok: true });
    expect(await daemon.handle("skills.remove", { name: "social-posts" })).toEqual({ ok: false });
    expect(removed.list()).toEqual(["social-posts"]);
    expect(await daemon.handle("skills.restorable", {})).toEqual({
      skills: [{ name: "social-posts", description: "Plan and draft social posts. Use for social media." }],
    });

    const res = await daemon.handle("skills.restore", { name: "social-posts" });
    expect(res.installed).toBe(true);
    expect(res.skill?.manifest.frontmatter.name).toBe("social-posts");
    expect(Object.keys(res).sort()).toEqual(["installed", "lint", "scan", "skill"]);
    expect(store.installs.at(-1)).toEqual({ kind: "local", path: join(dir, "social-posts") });
    expect(removed.list()).toEqual([]);
    expect(await daemon.handle("skills.restorable", {})).toEqual({ skills: [] });
  });

  it("restore needs no plan, refuses unknown and installed names, and keeps the mark when the scan refuses", async () => {
    const dir = bundle();
    const store = new InstallingStore();
    store.addDir(join(dir, "weekly-report"));
    const license = { has: () => false, status: () => ({ tier: "free" }), refreshIfDue: async () => undefined } as unknown as DaemonOptions["license"];
    const { daemon, dataDir } = daemonWith({ store, bundledSkillsDir: dir, ...(license ? { license } : {}) });
    new RemovedStarters(dataDir).add("customers");
    await expect(daemon.handle("skills.restore", { name: "nope" })).rejects.toMatchObject({ code: RPC_ERRORS.notFound, message: expect.stringContaining("not one of OneSeat's starter skills") });
    await expect(daemon.handle("skills.restore", { name: "weekly-report" })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams, message: expect.stringContaining("already installed") });
    await expect(daemon.handle("skills.restore", {} as never)).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    store.refuse.add("customers");
    const refused = await daemon.handle("skills.restore", { name: "customers" });
    expect(refused).toMatchObject({ installed: false, reason: "blocked by the security scan" });
    expect(new RemovedStarters(dataDir).list()).toEqual(["customers"]);
    store.refuse.clear();
    expect((await daemon.handle("skills.restore", { name: "customers" })).installed).toBe(true);
    expect(new RemovedStarters(dataDir).list()).toEqual([]);
    // Installing from elsewhere still needs the plan.
    await expect(daemon.handle("skills.install", { source: "o/r@s" })).rejects.toMatchObject({ code: RPC_ERRORS.upgradeRequired });
  });

  it("without a bundle nothing is restorable", async () => {
    const { daemon } = daemonWith();
    expect(await daemon.handle("skills.restorable", {})).toEqual({ skills: [] });
    await expect(daemon.handle("skills.restore", { name: "social-posts" })).rejects.toMatchObject({ code: RPC_ERRORS.notFound });
  });

  it("a removed starter skill stays removed when the app starts again", async () => {
    const dir = bundle();
    const dataDir = tmpDir();
    const store = new InstallingStore();
    expect((await seedStarterSkills(store, dir, dataDir, () => {})).sort()).toEqual(["customers", "social-posts", "weekly-report"]);
    const first = daemonWith({ store, bundledSkillsDir: dir }, dataDir).daemon;
    await first.handle("skills.remove", { name: "social-posts" });
    await first.close();
    // Next start: seeding skips it, and it is offered for restore.
    expect(await seedStarterSkills(store, dir, dataDir, () => {})).toEqual([]);
    const second = daemonWith({ store, bundledSkillsDir: dir }, dataDir).daemon;
    expect((await second.handle("skills.restorable", {})).skills.map((s) => s.name)).toEqual(["social-posts"]);
    await second.handle("skills.restore", { name: "social-posts" });
    await second.close();
    // After a restore, a later removal and seeding behave the same way again.
    store.skills.delete("social-posts");
    expect(await seedStarterSkills(store, dir, dataDir, () => {})).toEqual(["social-posts"]);
  });
});

describe("skills.search", () => {
  const found = [
    { id: "acme/skills/invoice-chase", repo: "acme/skills", skill: "invoice-chase", name: "invoice-chase", installs: 2258 },
    { id: "acme/skills/customers", repo: "acme/skills", skill: "customers", name: "Customers", installs: 4 },
  ];

  it("returns results marked installed, on any plan", async () => {
    const store = new InstallingStore();
    store.add({ name: "customers", description: "Look up customers. Use for customers." });
    const queries: string[] = [];
    const license = { has: () => false, status: () => ({ tier: "free" }), refreshIfDue: async () => undefined } as unknown as DaemonOptions["license"];
    const { daemon } = daemonWith({
      store,
      ...(license ? { license } : {}),
      searchSkills: async (q) => {
        queries.push(q);
        return found;
      },
    });
    expect(await daemon.handle("skills.search", { query: "invoice" })).toEqual({
      results: [
        { ...found[0], installed: false },
        { ...found[1], installed: true },
      ],
    });
    expect(await daemon.handle("skills.search", { query: "   " })).toEqual({ results: [] });
    expect(queries).toEqual(["invoice"]);
  });

  it("validates the query and reports search failures", async () => {
    const { daemon } = daemonWith({
      searchSkills: async () => {
        throw new Error("skills.sh did not answer within 10 seconds");
      },
    });
    await expect(daemon.handle("skills.search", { query: 3 } as never)).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(daemon.handle("skills.search", { query: "x".repeat(201) })).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
    await expect(daemon.handle("skills.search", { query: "invoice" })).rejects.toMatchObject({
      code: RPC_ERRORS.internal,
      message: "skills.sh did not answer within 10 seconds",
    });
  });

  it("is not available without a search function", async () => {
    const { daemon } = daemonWith();
    await expect(daemon.handle("skills.search", { query: "x" })).rejects.toMatchObject({ code: RPC_ERRORS.notFound });
  });

  it("inspect and install accept a search result id", async () => {
    const store = new InstallingStore();
    const { daemon } = daemonWith({ store });
    await daemon.handle("skills.install", { source: "skills.sh:acme/skills/invoice-chase" });
    expect(store.installs).toEqual([{ kind: "skills.sh", owner: "acme", repo: "skills", skill: "invoice-chase" }]);
    expect((await daemon.handle("skills.inspect", { source: "skills.sh:acme/skills/invoice-chase" })).scan.skill).toBe("skills");
  });
});
