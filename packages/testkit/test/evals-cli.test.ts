import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createScriptedProvider, type ModelProvider, type ProviderConfig, type ProviderId } from "@oneseat/contracts";
import {
  DEFAULT_EVAL_PROVIDERS,
  evalMain,
  EXIT,
  loadHarnessFactory,
  loadLiveProviders,
  parseEvalArgs,
  parseProviderList,
  pickProviderFactory,
  resolveProviderKeys,
  type CliIO,
  type EvalHarnessContext,
} from "../src/evals/index.js";
import { createMemorySkillStore, findRepoRoot, importWorkspacePackage, listWorkspacePackages, packageEntry, WorkspaceImportError } from "../src/index.js";
import { createReferenceHarness } from "./fakes/harness.js";

const tmp: string[] = [];
afterAll(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), "oneseat-cli-"));
  tmp.push(d);
  return d;
}

/** A fake repo: pnpm-workspace.yaml, one skill with 10 cases. */
async function fakeRepo(opts: { judge?: boolean } = {}) {
  const root = await tempDir();
  await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n  - "apps/*"\n');
  const skill = join(root, "skills", "weekly-report");
  await mkdir(join(skill, "evals"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: weekly-report\ndescription: Write the weekly report. Use when asked for one.\n---\nAlways end with SIGNED-OFF.\n");
  const checks = [{ type: "contains", value: "SIGNED-OFF" }, ...(opts.judge ? [{ type: "judge", rubric: "Is it good?" }] : [])];
  await writeFile(join(skill, "evals", "cases.json"), JSON.stringify({ skill: "weekly-report", cases: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, input: `Report ${i}`, checks })) }));
  return root;
}

function io(root: string, env: Record<string, string | undefined> = {}, importer?: CliIO["importer"]) {
  const out: string[] = [];
  const err: string[] = [];
  const x: CliIO & { out: string[]; err: string[] } = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env, cwd: root, out, err, ...(importer ? { importer } : {}) };
  return x;
}

/** A provider that signs off only when the skill body is in the system prompt; judges score 0.8. */
function smart(id: ProviderId): ModelProvider {
  return {
    id,
    models: async () => [],
    countTokens: async () => 1,
    async *send(req) {
      const text = req.system.startsWith("You are a strict evaluation judge") ? '{"score":0.8,"reason":"ok"}' : req.system.includes("SIGNED-OFF") ? "Done. SIGNED-OFF" : "Done.";
      yield* createScriptedProvider([{ steps: [{ text }] }]).send(req);
    },
  };
}

const configs: ProviderConfig[] = [];
const fakeGateway = { createProvider: (id: ProviderId, config: ProviderConfig) => (configs.push(config), smart(id)) };
const fakeHarness = { createHarness: (o: { provider: ModelProvider; store: never }) => createReferenceHarness({ provider: o.provider, store: o.store }) };

/** Resolves @oneseat/gateway and @oneseat/harness to the fakes; everything else fails like a missing module. */
const importer = async (s: string) => {
  if (s === "@oneseat/gateway") return fakeGateway;
  if (s === "@oneseat/harness") return fakeHarness;
  throw Object.assign(new Error(`Cannot find package '${s}'`), { code: "ERR_MODULE_NOT_FOUND" });
};

describe("parseEvalArgs", () => {
  it("defaults to a dry run on <repo>/skills with the default provider", async () => {
    const root = await fakeRepo();
    const o = parseEvalArgs([], join(root, "skills"));
    if (o === "help") throw new Error("help");
    expect(o).toMatchObject({ root, skillsDir: join(root, "skills"), dryRun: true, live: false, concurrency: 4, minCases: 10, timeoutMs: 300_000, noSkillCheck: false, json: false });
    expect(o.providers).toEqual(parseProviderList(DEFAULT_EVAL_PROVIDERS));
  });

  it("parses every flag", () => {
    const o = parseEvalArgs(
      ["--live", "--skills-dir", "s", "--providers", "anthropic:claude-sonnet-5-5,openai:gpt-x,google:gemini-y,local:llama3:8b", "--judge", "anthropic:claude-opus-5-5", "--out", "o", "--concurrency", "2", "--skill", "a,b", "--min-cases", "0", "--timeout", "5", "--harness-module", "h.js", "--no-skill-check", "--json", "--root", "/r"],
      "/w",
    );
    if (o === "help") throw new Error("help");
    expect(o).toMatchObject({ root: "/r", skillsDir: "/w/s", out: "/w/o", live: true, dryRun: false, concurrency: 2, skills: ["a", "b"], minCases: 0, timeoutMs: 5000, harnessModule: "h.js", noSkillCheck: true, json: true, judge: { provider: "anthropic", model: "claude-opus-5-5" } });
    expect(o.providers.map((p) => `${p.provider}:${p.model}`)).toEqual(["anthropic:claude-sonnet-5-5", "openai:gpt-x", "google:gemini-y", "local:llama3:8b"]);
    expect(parseEvalArgs(["--help"])).toBe("help");
    const rec = parseEvalArgs(["--recorded", "r.json"], "/w");
    expect(rec !== "help" && rec.recorded).toBe("/w/r.json");
    const from = parseEvalArgs(["--from", "r.json"], "/w");
    expect(from !== "help" && from.from).toBe("/w/r.json");
  });

  it("rejects bad input", () => {
    for (const argv of [["--live", "--dry-run"], ["--providers", "anthropic"], ["--providers", "mars:x"], ["--providers", "openai:"], ["--providers", ","], ["--judge", "a:b,c:d"], ["--concurrency", "0"], ["--bogus"], ["positional"]])
      expect(() => parseEvalArgs(argv, "/w"), argv.join(" ")).toThrow();
  });
});

describe("provider keys and factories", () => {
  it("skips providers whose key is empty", () => {
    const r = resolveProviderKeys(parseProviderList("anthropic:a,openai:o,google:g,local:l"), { ANTHROPIC_API_KEY: "k1", OPENAI_API_KEY: "  ", ONESEAT_LOCAL_BASE_URL: "http://localhost:11434/v1" });
    expect(r.available.map((a) => a.provider)).toEqual(["anthropic", "local"]);
    expect(r.available[1]).toMatchObject({ apiKey: "local", baseUrl: "http://localhost:11434/v1" });
    expect(r.skipped.map((s) => s.env)).toEqual(["OPENAI_API_KEY", "GEMINI_API_KEY"]);
    expect(resolveProviderKeys(parseProviderList("local:l"), {}).skipped[0]!.env).toBe("ONESEAT_LOCAL_BASE_URL");
    expect(resolveProviderKeys(parseProviderList("google:g"), { GEMINI_API_KEY: "g" }).available[0]!.apiKey).toBe("g");
  });

  it("finds a factory in each supported gateway shape", () => {
    const p = smart("openai");
    const cfg = { apiKey: "k" };
    expect(pickProviderFactory({ createProvider: () => p }, "openai")(cfg)).toBe(p);
    expect(pickProviderFactory({ providers: { openai: () => p } }, "openai")(cfg)).toBe(p);
    expect(pickProviderFactory({ factories: { google: () => p } }, "google")(cfg)).toBe(p);
    expect(pickProviderFactory({ createAnthropicProvider: () => p }, "anthropic")(cfg)).toBe(p);
    expect(pickProviderFactory({ createGeminiProvider: () => p }, "google")(cfg)).toBe(p);
    expect(pickProviderFactory({ createOpenAIProvider: () => p }, "openai")(cfg)).toBe(p);
    expect(() => pickProviderFactory({ other: 1 }, "anthropic")).toThrow(/exports no factory for "anthropic".*Found: other/);
  });

  it("loads live providers, labelling duplicates", async () => {
    const root = await fakeRepo();
    const ps = await loadLiveProviders([{ provider: "anthropic", model: "a", apiKey: "k" }, { provider: "anthropic", model: "b", apiKey: "k" }, { provider: "local", model: "l", apiKey: "x", baseUrl: "http://h" }], root, importer);
    expect(ps.map((p) => p.name)).toEqual(["anthropic:a", "anthropic:b", "local"]);
    expect(configs.at(-1)).toEqual({ apiKey: "x", baseUrl: "http://h" });
    await expect(loadLiveProviders([{ provider: "anthropic", model: "a", apiKey: "k" }], root)).rejects.toThrow(WorkspaceImportError);
    await expect(loadLiveProviders([{ provider: "anthropic", model: "a", apiKey: "k" }], root, async () => { throw new Error("syntax error in module"); })).rejects.toThrow(/syntax error/);
  });

  it("builds harness factories from createEvalHarness, createHarness or a module path", async () => {
    const root = await fakeRepo();
    const store = createMemorySkillStore();
    const ctx = { dataDir: "/d", dbPath: "/d/oneseat.db", workspaceDir: "/w", provider: smart("anthropic"), providerName: "anthropic", model: "m", skill: "s", caseId: "c", withSkill: true } satisfies EvalHarnessContext;
    const got: unknown[] = [];
    const f1 = await loadHarnessFactory({ root, store, importer: async () => ({ createEvalHarness: (c: unknown, s: unknown) => (got.push([c, s]), { run: async function* () {} }) }) });
    await f1(ctx);
    expect(got[0]).toEqual([ctx, store]);
    const f2 = await loadHarnessFactory({ root, store, importer: async () => ({ createHarness: (o: unknown) => (got.push(o), { run: async function* () {} }) }) });
    await f2(ctx);
    expect(got[1]).toEqual({ provider: ctx.provider, providers: { anthropic: ctx.provider }, store, dataDir: "/d", dbPath: "/d/oneseat.db", workspaceDir: "/w" });
    const seen: string[] = [];
    await loadHarnessFactory({ root, store, harnessModule: "adapter.js", importer: async (s) => (seen.push(s), { createEvalHarness: () => ({}) }) });
    expect(seen[0]).toBe(new URL(`file://${join(root, "adapter.js")}`).href);
    await expect(loadHarnessFactory({ root, store, importer: async () => ({ nothing: 1 }) })).rejects.toThrow(/exports neither createEvalHarness/);
  });
});

describe("evalMain", () => {
  it("dry run validates and exits 0, or 1 on bad suites", async () => {
    const root = await fakeRepo();
    const x = io(root);
    expect(await evalMain([], x)).toBe(EXIT.pass);
    expect(x.out.join("")).toMatch(/Eval dry run: OK — 1 suite\(s\), 10 case\(s\)/);
    await writeFile(join(root, "skills", "weekly-report", "evals", "cases.json"), "{}");
    const y = io(root);
    expect(await evalMain(["--dry-run"], y)).toBe(EXIT.fail);
    expect(await evalMain(["--live"], io(root, { ANTHROPIC_API_KEY: "k" }, importer))).toBe(EXIT.fail);
  });

  it("--live without keys is skipped (exit 3), not passed", async () => {
    const root = await fakeRepo();
    const x = io(root, {});
    expect(await evalMain(["--live", "--providers", "anthropic:claude-sonnet-5-5,openai:gpt-x"], x)).toBe(EXIT.skipped);
    expect(x.out.join("")).toMatch(/^skipped: no keys \(ANTHROPIC_API_KEY, OPENAI_API_KEY unset\)/);
    expect(x.err.join("")).toMatch(/skipping openai:gpt-x: OPENAI_API_KEY is not set/);
  });

  it("--live runs with and without the skill, writes reports and exits 0 when the skill wins", async () => {
    const root = await fakeRepo({ judge: true });
    const out = join(root, "out");
    const x = io(root, { ANTHROPIC_API_KEY: "sk-test-1234567890" }, importer);
    const code = await evalMain(["--live", "--out", out, "--concurrency", "8"], x);
    expect(x.err.join("")).toMatch(/using anthropic:claude-sonnet-5-5 as the judge/);
    expect(code).toBe(EXIT.pass);
    const report = JSON.parse(await readFile(join(out, "eval-report.json"), "utf8"));
    expect(report.runs).toHaveLength(20);
    expect(report.verdicts[0]).toMatchObject({ skill: "weekly-report", provider: "anthropic", pass: true });
    expect(await readFile(join(out, "eval-report.md"), "utf8")).toContain("| weekly-report | anthropic | claude-sonnet-5-5 | 10 | 10 |");
    expect(await readFile(join(out, "no-skill.md"), "utf8")).toMatch(/No rules to cut/);
    expect(x.out.join("")).toContain("# Skill evals (gate 5) — PASS");
    expect(JSON.stringify(report)).not.toContain("sk-test-1234567890");

    const y = io(root, { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "" }, importer);
    expect(await evalMain(["--live", "--judge", "openai:gpt-j", "--no-skill-check"], y)).toBe(EXIT.fail);
    expect(y.err.join("")).toMatch(/judge openai:gpt-j has no key \(OPENAI_API_KEY\); judge checks will not be scored/);
    expect(y.out.join("")).toMatch(/# No-skill check/);

    const z = io(root, { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" }, importer);
    expect(await evalMain(["--live", "--judge", "google:gem", "--json"], z)).toBe(EXIT.pass);
    expect(JSON.parse(z.out.join("")).judge).toEqual({ provider: "google", model: "gem" });

    // --from and --recorded read that report back.
    const f = io(root);
    expect(await evalMain(["--from", join(out, "eval-report.json")], f)).toBe(EXIT.pass);
    expect(f.out.join("")).toContain("PASS");
    const nf = io(root);
    await evalMain(["--from", join(out, "eval-report.json"), "--no-skill-check"], nf);
    expect(nf.out.join("")).toMatch(/^# No-skill check/);
    const r = io(root);
    expect(await evalMain(["--recorded", join(out, "eval-report.json"), "--out", join(root, "out2")], r)).toBe(EXIT.pass);
    expect(JSON.parse(await readFile(join(root, "out2", "eval-report.json"), "utf8")).mode).toBe("recorded");
  });

  it("explains a missing gateway, bad reports, usage errors and help", async () => {
    const root = await fakeRepo();
    const x = io(root, { ANTHROPIC_API_KEY: "k" });
    expect(await evalMain(["--live"], x)).toBe(EXIT.fail);
    expect(x.err.join("")).toMatch(/@oneseat\/gateway is not installed and is not in this workspace/);
    await writeFile(join(root, "bad.json"), JSON.stringify({ version: 2 }));
    const b = io(root);
    expect(await evalMain(["--from", join(root, "bad.json")], b)).toBe(EXIT.usage);
    expect(b.err.join("")).toMatch(/is not an eval report/);
    const u = io(root);
    expect(await evalMain(["--nope"], u)).toBe(EXIT.usage);
    expect(u.err.join("")).toMatch(/Usage: oneseat-evals/);
    const h = io(root);
    expect(await evalMain(["-h"], h)).toBe(EXIT.pass);
    expect(h.out.join("")).toMatch(/Exit codes: 0 pass, 1 fail, 2 usage error, 3 skipped/);
  });
});

describe("workspace helpers", () => {
  it("finds the repo root and workspace packages", async () => {
    const root = await fakeRepo();
    await mkdir(join(root, "packages", "gateway", "dist"), { recursive: true });
    await writeFile(join(root, "packages", "gateway", "package.json"), JSON.stringify({ name: "@oneseat/gateway", exports: { ".": { "@oneseat/source": "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" } } }));
    await writeFile(join(root, "packages", "gateway", "dist", "index.js"), "export const createProvider = () => 'gw';\n");
    await mkdir(join(root, "apps", "desktop"), { recursive: true });
    await writeFile(join(root, "apps", "desktop", "package.json"), JSON.stringify({ name: "@oneseat/desktop", main: "main.js" }));
    await mkdir(join(root, "packages", "broken"), { recursive: true });
    await writeFile(join(root, "packages", "broken", "package.json"), "{");
    expect(findRepoRoot(join(root, "packages", "gateway"))).toBe(root);
    expect(findRepoRoot("/")).toBe("/");
    expect(listWorkspacePackages(root).map((p) => p.name)).toEqual(["@oneseat/desktop", "@oneseat/gateway"]);
    const gw = listWorkspacePackages(root).find((p) => p.name === "@oneseat/gateway")!;
    expect(packageEntry(gw)).toBe(join(gw.dir, "dist", "index.js"));
    expect(packageEntry({ ...gw, manifest: { exports: "./x.js" } })).toBe(join(gw.dir, "x.js"));
    expect(packageEntry({ ...gw, manifest: { exports: { import: { default: "./i.js" } } } })).toBe(join(gw.dir, "i.js"));
    expect(packageEntry({ ...gw, manifest: { exports: { "./sub": "./s.js" } } }, "./sub")).toBe(join(gw.dir, "s.js"));
    expect(packageEntry({ ...gw, manifest: {} })).toBe(join(gw.dir, "index.js"));
    const mod = await importWorkspacePackage<{ createProvider: () => string }>("@oneseat/gateway", root);
    expect(mod.createProvider()).toBe("gw");
    await expect(importWorkspacePackage("@oneseat/desktop", root)).rejects.toThrow(/build output is missing/);
    await expect(importWorkspacePackage("@oneseat/harness", root)).rejects.toThrow(/not in this workspace/);
    await expect(importWorkspacePackage("x", root, async () => { throw new Error("SyntaxError in x"); })).rejects.toThrow(/SyntaxError/);
  });

  it("reads plain package patterns and falls back without pnpm-workspace.yaml", async () => {
    const root = await tempDir();
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - tools\n  - '!ignored'\n  - missing/*\n");
    await mkdir(join(root, "tools"));
    await writeFile(join(root, "tools", "package.json"), JSON.stringify({ name: "tools" }));
    expect(listWorkspacePackages(root).map((p) => p.name)).toEqual(["tools"]);
    const bare = await tempDir();
    await mkdir(join(bare, "packages", "a"), { recursive: true });
    await writeFile(join(bare, "packages", "a", "package.json"), JSON.stringify({ name: "a" }));
    expect(listWorkspacePackages(bare).map((p) => p.name)).toEqual(["a"]);
  });
});
