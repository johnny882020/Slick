import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createMemorySkillStore,
  createSkillStoreFromDir,
  describeSkillStoreConformance,
  renderSkillMd,
  runSkillStoreConformance,
  safeSkillPath,
  scanSkillFiles,
  SKILL_STORE_CHECKS,
  TRAVERSAL_PATHS,
  writeSkillSourceFixtures,
} from "../src/index.js";
import { createFsStore } from "./fakes/fs-store.js";

describeSkillStoreConformance(() => createMemorySkillStore());
describeSkillStoreConformance(({ storeDir }) => createFsStore(storeDir));

const tmp: string[] = [];
afterAll(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), "oneseat-testkit-"));
  tmp.push(d);
  return d;
}

describe("skill store conformance catches broken stores", () => {
  it("has a check per behaviour", () => expect(SKILL_STORE_CHECKS.length).toBe(10));

  it("catches a store without traversal checks", async () => {
    const r = await runSkillStoreConformance(({ storeDir }) => createFsStore(storeDir, ["no-traversal-check"]));
    const t = r.find((x) => x.name.includes("outside the skill folder"))!;
    expect(t.problems.join("\n")).toMatch(/resolved instead of rejecting/);
    expect(t.problems.join("\n")).toMatch(/read a file outside the skill/);
  });

  it("catches a store that installs blocked skills or leaks bodies in the index", async () => {
    const r = await runSkillStoreConformance(({ storeDir }) => createFsStore(storeDir, ["install-blocked", "index-bodies"]));
    expect(r.find((x) => x.name.startsWith("never installs"))!.problems.join()).toMatch(/blocked skill was installed/);
    expect(r.find((x) => x.name.startsWith("list()"))!.problems.join()).toMatch(/only name and description/);
  });

  it("reports a crashing store factory", async () => {
    const r = await runSkillStoreConformance(() => {
      throw new Error("no store");
    });
    expect(r.every((x) => x.problems.join().includes("no store"))).toBe(true);
  });
});

describe("memory skill store", () => {
  it("preloads inputs and installed skills, and logs reads", async () => {
    const s = createMemorySkillStore([
      { name: "one", description: "First skill. Use when testing.", body: "BODY1", files: { "a.md": "A" }, permissions: { net: ["x.test"] }, reasons: { "x.test": "why" }, effects: ["send"], version: "2.0.0" },
    ]);
    const one = (await s.get("one"))!;
    expect(one.version).toBe("2.0.0");
    expect(one.manifest.permissions.net).toEqual(["x.test"]);
    expect(one.manifest.effects).toEqual(["send"]);
    const copy = createMemorySkillStore([one]);
    expect((await copy.get("one"))!.manifest.body).toBe("BODY1");
    expect((await copy.verify("one")).ok).toBe(true);
    expect(await s.readFile("one", "a.md")).toBe("A");
    expect(await s.readFile("one", "./x/../a.md")).toBe("A");
    expect(s.reads).toHaveLength(2);
    expect(s.gets).toEqual(["one"]);
    await expect(s.readFile("one", "missing")).rejects.toThrow(/no file/);
    await expect(s.readFile("nope", "a.md")).rejects.toThrow(/not installed/);
    expect(() => createMemorySkillStore([{ name: "Bad Name", description: "x" }])).toThrow(/invalid skill/);
  });

  it("verify() fails after tampering and for unknown skills", async () => {
    const s = createMemorySkillStore([{ name: "one", description: "First skill. Use when testing.", body: "B" }]);
    expect(await s.verify("one")).toEqual({ ok: true });
    s.tamper("one", "SKILL.md", "changed");
    expect(await s.verify("one")).toEqual({ ok: false, reason: "content hash mismatch" });
    expect(await s.verify("zzz")).toEqual({ ok: false, reason: "not installed" });
    expect(() => s.tamper("zzz", "a", "b")).toThrow();
  });

  it("refuses non-local sources unless a loader is given, and warns need allowWarnings", async () => {
    const s = createMemorySkillStore();
    const r = await s.install({ kind: "github", owner: "o", repo: "r" });
    expect(r.installed).toBe(false);
    expect(r.reason).toMatch(/local folders only/);
    const files = new Map([
      ["SKILL.md", Buffer.from(renderSkillMd({ name: "net-skill", description: "Fetch rates. Use when asked." }))],
      ["oneseat.json", Buffer.from(JSON.stringify({ permissions: { net: ["a.test"] }, reasons: { "a.test": "rates" } }))],
    ]);
    const withLoader = createMemorySkillStore([], { loadSource: async () => files });
    expect((await withLoader.install({ kind: "skills.sh", owner: "o", repo: "r" })).installed).toBe(true);
    const warnFiles = new Map([["SKILL.md", Buffer.from(renderSkillMd({ name: "warn-skill", description: "Fetch rates. Use when asked." }))], ["oneseat.json", Buffer.from(JSON.stringify({ permissions: { net: ["b.test"] }, reasons: {} }))]]);
    const w = createMemorySkillStore([], { loadSource: async () => warnFiles });
    const wr = await w.install({ kind: "skills.sh", owner: "o", repo: "r" });
    expect(wr.installed).toBe(false);
    expect(wr.lint.ok).toBe(false);
    const missing = createMemorySkillStore([], { loadSource: async () => new Map() });
    expect((await missing.install({ kind: "skills.sh", owner: "o", repo: "r" })).lint.issues[0]!.rule).toBe("skill-md");
  });

  it("scanner flags undeclared hosts and outside paths, warns on hosts without reasons", () => {
    const files = new Map([
      ["scripts/a.ts", Buffer.from('fetch("https://ok.test/x"); fetch("https://bad.test:8443/y");\nDeno.readTextFile("../secret")')],
      ["README.md", Buffer.from("see https://docs.test")],
    ]);
    const manifest = { permissions: { net: ["ok.test", "noreason.test"], read: [], write: [], env: [], run: [] }, reasons: { "ok.test": "x" } } as never;
    const r = scanSkillFiles("s", files, manifest);
    expect(r.verdict).toBe("block");
    expect(r.findings.map((f) => f.rule).sort()).toEqual(["net-reason", "undeclared-file", "undeclared-network"]);
    expect(r.observed.net).toEqual(["ok.test", "bad.test:8443"]);
    expect(scanSkillFiles("s", new Map([["x.md", Buffer.from("https://a.test")]]), undefined).verdict).toBe("pass");
    const warnOnly = scanSkillFiles("s", new Map(), { permissions: { net: ["h.test"], read: [], write: [], env: [], run: [] }, reasons: {} } as never);
    expect(warnOnly.verdict).toBe("warn");
  });

  it("safeSkillPath keeps paths inside", () => {
    expect(safeSkillPath("a/b.md")).toBe("a/b.md");
    expect(safeSkillPath("./a/../b.md")).toBe("b.md");
    expect(safeSkillPath("a\\b.md")).toBe("a/b.md");
    for (const bad of [...TRAVERSAL_PATHS.filter((p) => !p.includes("%2e")), "", "..", 3 as never]) expect(safeSkillPath(bad)).toBeUndefined();
  });

  it("loads every skill folder from a directory, with files", async () => {
    const root = await tempDir();
    const fx = await writeSkillSourceFixtures(root);
    const store = await createSkillStoreFromDir(join(root, "src", "store-conformance"));
    expect((await store.list()).map((s) => s.manifest.frontmatter.name)).toEqual(["store-conformance"]);
    expect(await store.readFile("store-conformance", "templates/summary.md")).toContain("Total");
    expect(fx.good).toContain("store-conformance");
    const multi = await tempDir();
    await mkdir(join(multi, "a-skill"));
    await writeFile(join(multi, "a-skill", "SKILL.md"), renderSkillMd({ name: "a-skill", description: "A. Use when a." }));
    await mkdir(join(multi, "not-a-skill"));
    expect((await (await createSkillStoreFromDir(multi)).index()).map((e) => e.name)).toEqual(["a-skill"]);
    // The folder's path is kept, so the sandbox can run the skill's scripts (gate 5 evals).
    expect((await (await createSkillStoreFromDir(multi)).get("a-skill"))!.manifest.dir).toBe(join(multi, "a-skill"));
    expect((await createMemorySkillStore([{ name: "mem", description: "M. Use when m.", body: "Body" }]).get("mem"))!.manifest.dir).toBe("");
    await mkdir(join(multi, "b-skill"));
    await writeFile(join(multi, "b-skill", "SKILL.md"), "---\nname: wrong\ndescription: d\n---\n");
    await expect(createSkillStoreFromDir(multi)).rejects.toThrow(/invalid skill folder/);
  });
});
