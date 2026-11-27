import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkCoverage,
  coverageProviderArgs,
  defaultExec,
  gatesExitCode,
  gatesMain,
  GATE_NAMES,
  parseCoverageSummary,
  parseGatesArgs,
  parseScanOutput,
  quoteWindowsArg,
  readCoverageSummary,
  renderGatesMarkdown,
  renderGatesTable,
  resolveSkillsCli,
  runGates,
  summariseConformanceJson,
  type Exec,
  type ExecResult,
  type GateResult,
} from "../src/gates/index.js";

const tmp: string[] = [];
afterAll(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), "oneseat-gates-"));
  tmp.push(d);
  return d;
}

const summary = (pct: number, total = 200) => ({ total: { lines: { total, covered: Math.round((total * pct) / 100), skipped: 0, pct }, statements: { total, covered: 1, skipped: 0, pct: 50 }, functions: { total: 0, covered: 0, skipped: 0, pct: "Unknown" }, branches: { total: 4, covered: 2, skipped: 0, pct: 50 } } });

async function pkg(root: string, dir: string, manifest: Record<string, unknown>) {
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, "package.json"), JSON.stringify(manifest));
}

async function fakeRepo(opts: { skills?: number; noRegistryBin?: boolean; noDesktop?: boolean } = {}) {
  const root = await tempDir();
  await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n  - "apps/*"\n');
  for (const p of ["contracts", "gateway", "harness", "registry"]) await pkg(root, `packages/${p}`, { name: `@oneseat/${p}`, scripts: { test: "vitest run" }, ...(p === "registry" && !opts.noRegistryBin ? { bin: { "oneseat-skills": "./dist/cli.js" } } : {}) });
  await pkg(root, "packages/testkit", { name: "@oneseat/testkit", scripts: { test: "vitest run" } });
  await mkdir(join(root, "packages", "testkit", "coverage"), { recursive: true });
  await writeFile(join(root, "packages", "testkit", "coverage", "coverage-summary.json"), JSON.stringify(summary(97)));
  await mkdir(join(root, "packages", "registry", "dist"), { recursive: true });
  await writeFile(join(root, "packages", "registry", "dist", "cli.js"), "");
  if (!opts.noDesktop) await pkg(root, "apps/desktop", { name: "@oneseat/desktop", scripts: { e2e: "playwright test" } });
  for (let s = 0; s < (opts.skills ?? 2); s++) {
    const name = `skill-${s}`;
    await mkdir(join(root, "skills", name, "evals"), { recursive: true });
    await writeFile(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Does ${name}. Use when asked.\n---\n`);
    await writeFile(join(root, "skills", name, "evals", "cases.json"), JSON.stringify({ skill: name, cases: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, input: "x", checks: [{ type: "min_words", value: 1 }] })) }));
  }
  return root;
}

interface FakeExecConfig {
  coverage?: Record<string, number | "fail" | "no-provider">;
  turboCode?: number;
  conformance?: unknown;
  conformanceCode?: number;
  lint?: Record<string, number>;
  scan?: Record<string, { code?: number; stdout?: string }>;
  e2eCode?: number;
}

function fakeExec(root: string, cfg: FakeExecConfig) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args): Promise<ExecResult> => {
    calls.push([cmd, ...args]);
    const a = [...args];
    if (a.includes("turbo")) return { code: cfg.turboCode ?? 0, stdout: "", stderr: "" };
    if (a.includes("vitest") && a.some((x) => x.startsWith("--coverage"))) {
      const name = a[a.indexOf("--filter") + 1]!;
      const dir = name.replace("@oneseat/", "");
      const c = cfg.coverage?.[dir] ?? 95;
      if (c === "fail") return { code: 1, stdout: "1 failed", stderr: "" };
      if (c === "no-provider") return { code: 1, stdout: "", stderr: "MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'" };
      await mkdir(join(root, "packages", dir, "coverage"), { recursive: true });
      await writeFile(join(root, "packages", dir, "coverage", "coverage-summary.json"), JSON.stringify(summary(c)));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (a.includes("-t")) {
      const out = a.find((x) => x.startsWith("--outputFile.json="))!.split("=")[1]!;
      if (cfg.conformance !== undefined) await writeFile(out, JSON.stringify(cfg.conformance));
      return { code: cfg.conformanceCode ?? 0, stdout: "conformance run", stderr: "" };
    }
    if (a[1] === "lint") {
      const skill = a[2]!.split(/[\\/]/).pop()!;
      const code = cfg.lint?.[skill] ?? 0;
      return { code, stdout: code ? "error: name-format" : "ok", stderr: "" };
    }
    if (a[1] === "scan") {
      const skill = a[2]!.split(/[\\/]/).pop()!;
      const s = cfg.scan?.[skill] ?? { stdout: JSON.stringify({ skill, verdict: "pass", findings: [] }) };
      return { code: s.code ?? 0, stdout: s.stdout ?? "", stderr: "scan stderr" };
    }
    if (a.includes("e2e")) return { code: cfg.e2eCode ?? 0, stdout: "6 passed", stderr: "" };
    return { code: 99, stdout: "", stderr: `unexpected ${a.join(" ")}` };
  };
  return { exec, calls };
}

const PARITY_OK = {
  testResults: [
    {
      assertionResults: [
        ...["anthropic", "openai", "google"].map((p) => ({ ancestorTitles: [`conformance: ModelProvider ${p}`], fullName: `conformance: ModelProvider ${p} text reply`, title: "text reply", status: "passed" })),
        { ancestorTitles: ["conformance: cross-provider tool-call parity (anthropic, openai, google): weather"], fullName: "parity all agree", title: "all agree", status: "passed" },
        { ancestorTitles: ["other suite"], fullName: "other", status: "failed" },
      ],
    },
  ],
};

async function run(ids: number[], root: string, cfg: FakeExecConfig = {}, extra: Record<string, unknown> = {}) {
  const fx = fakeExec(root, cfg);
  const logs: string[] = [];
  const results = await runGates(ids, { root, exec: fx.exec, env: {}, log: (l) => logs.push(l), ...extra });
  return { results, calls: fx.calls, logs, r: results[0]! };
}

describe("coverage parsing", () => {
  it("parses istanbul json-summary and checks the threshold", async () => {
    const s = parseCoverageSummary(summary(91.5));
    expect(s.lines).toEqual({ total: 200, covered: 183, pct: 91.5 });
    expect(s.functions!.pct).toBeNaN();
    expect(checkCoverage("@oneseat/x", s, 90)).toMatchObject({ ok: true, message: "@oneseat/x: 91.50% lines (183/200)" });
    expect(checkCoverage("@oneseat/x", parseCoverageSummary(summary(89.99)), 90)).toMatchObject({ ok: false });
    expect(checkCoverage("@oneseat/x", parseCoverageSummary(summary(90)), 90).ok).toBe(true);
    expect(checkCoverage("@oneseat/x", parseCoverageSummary({ total: { lines: { total: 0, covered: 0, pct: "Unknown" } } }), 90).message).toMatch(/measured no lines/);
    expect(checkCoverage("@oneseat/x", undefined, 90, "ENOENT").message).toBe("@oneseat/x: no coverage summary (ENOENT)");
    expect(parseCoverageSummary({ total: { lines: { total: 10, covered: 5 } } }).lines.pct).toBe(50);
    expect(() => parseCoverageSummary({})).toThrow(/total.lines/);
    expect(() => parseCoverageSummary({ total: { lines: { total: "x" } } })).toThrow();
    const dir = await tempDir();
    await writeFile(join(dir, "s.json"), JSON.stringify(summary(99)));
    expect((await readCoverageSummary(join(dir, "s.json"))).lines.pct).toBe(99);
  });
});

describe("gate 1: unit tests + coverage", () => {
  it("passes when every core package is at or above 90%", async () => {
    const root = await fakeRepo();
    const { r, calls } = await run([1], root, { coverage: { contracts: 100, gateway: 92, harness: 90, registry: 95.5 } });
    expect(r.status).toBe("PASS");
    expect(r.reason).toBe("core packages at or above 90% lines: contracts 100.0%, gateway 92.0%, harness 90.0%, registry 95.5%");
    expect(r.details).toContain("@oneseat/testkit: 97.00% lines (194/200) (not a core package; informational)");
    expect(calls[0]).toEqual(["pnpm", "exec", "turbo", "run", "test", "--filter=@oneseat/desktop", "--filter=@oneseat/testkit"].filter((x) => x !== "--filter=@oneseat/desktop"));
    expect(calls[1]).toEqual(expect.arrayContaining(["--filter", "@oneseat/contracts", "exec", "vitest", "run", "--coverage.reporter=json-summary", "--coverage.include=src/**", "--coverage.provider=custom"]));
    expect(calls[1]!.find((a) => a.startsWith("--coverage.customProviderModule="))).toMatch(/@vitest\/coverage-v8\/dist\/index\.js$/);
  });

  it("uses the package's own coverage provider when it has one", () => {
    expect(coverageProviderArgs(import.meta.dirname)).toEqual(["--coverage.provider=v8"]);
    expect(coverageProviderArgs("/nowhere", () => undefined)).toEqual(["--coverage.provider=v8"]);
    expect(coverageProviderArgs("/nowhere", () => "C:\\x\\index.js")).toEqual(["--coverage.provider=custom", "--coverage.customProviderModule=C:/x/index.js"]);
  });

  it("fails under the threshold, on failing tests, missing packages and a missing coverage provider", async () => {
    const root = await fakeRepo();
    const low = await run([1], root, { coverage: { gateway: 80 } });
    expect(low.r.status).toBe("FAIL");
    expect(low.r.reason).toMatch(/@oneseat\/gateway: 80.00% lines \(160\/200\), below 90%/);
    const failing = await run([1], root, { coverage: { harness: "fail" }, turboCode: 2 });
    expect(failing.r.reason).toMatch(/tests failed in @oneseat\/testkit \(turbo exit 2\)/);
    expect(failing.r.reason).toMatch(/@oneseat\/harness: tests failed \(exit 1\)/);
    const noProvider = await run([1], root, { coverage: { registry: "no-provider" } });
    expect(noProvider.r.reason).toMatch(/@vitest\/coverage-v8 is not installed for @oneseat\/registry/);
    await rm(join(root, "packages", "harness"), { recursive: true });
    const missing = await run([1], root);
    expect(missing.r.reason).toMatch(/core package packages\/harness is missing/);
  });

  it("can read existing summaries without running tests, with a custom threshold and core list", async () => {
    const root = await fakeRepo();
    await mkdir(join(root, "packages", "contracts", "coverage"), { recursive: true });
    await writeFile(join(root, "packages", "contracts", "coverage", "coverage-summary.json"), JSON.stringify(summary(85)));
    const r = await run([1], root, {}, { coverageFromExisting: true, coverageThreshold: 80, corePackages: ["contracts"] });
    expect(r.calls).toEqual([]);
    expect(r.r.status).toBe("PASS");
    const none = await run([1], root, {}, { coverageFromExisting: true, corePackages: ["gateway"] });
    expect(none.r.reason).toMatch(/@oneseat\/gateway: no coverage summary/);
  });
});

describe("gate 2: provider parity", () => {
  it("summarises vitest JSON for conformance suites", () => {
    const s = summariseConformanceJson(PARITY_OK);
    expect(s).toMatchObject({ providerSuites: ["anthropic", "google", "openai"], parityProviders: ["anthropic", "google", "openai"], passed: 4, failed: 0 });
    expect(summariseConformanceJson(null).passed).toBe(0);
    const f = summariseConformanceJson({ testResults: [{ assertionResults: [{ ancestorTitles: ["conformance: ModelProvider x"], fullName: "x boom", status: "failed" }, { ancestorTitles: ["conformance: ModelProvider x"], status: "skipped" }] }] });
    expect(f).toMatchObject({ failed: 1, skipped: 1, failures: ["x boom"] });
  });

  it("passes with parity on all 3 providers and fails otherwise", async () => {
    const root = await fakeRepo();
    const ok = await run([2], root, { conformance: PARITY_OK });
    expect(ok.r.status).toBe("PASS");
    expect(ok.r.reason).toBe("same tool-call result on anthropic, google, openai; 4 conformance tests passed");
    expect(ok.calls[0]).toEqual(expect.arrayContaining(["--filter", "@oneseat/gateway", "-t", "conformance:", "--reporter=json"]));
    const two = structuredClone(PARITY_OK);
    two.testResults[0]!.assertionResults[3]!.ancestorTitles = ["conformance: cross-provider tool-call parity (anthropic, openai): weather"];
    expect((await run([2], root, { conformance: two })).r.reason).toMatch(/parity covers 2 provider\(s\)/);
    const oneSuite = { testResults: [{ assertionResults: [PARITY_OK.testResults[0]!.assertionResults[0]!, PARITY_OK.testResults[0]!.assertionResults[3]!] }] };
    expect((await run([2], root, { conformance: oneSuite })).r.reason).toMatch(/covers 1 adapter/);
    expect((await run([2], root, { conformance: { testResults: [] } })).r.reason).toMatch(/no conformance tests ran/);
    expect((await run([2], root, { conformance: PARITY_OK, conformanceCode: 1 })).r.reason).toMatch(/failed \(exit 1\)/);
    expect((await run([2], root, {})).r.reason).toMatch(/no vitest JSON report/);
    await rm(join(root, "packages", "gateway"), { recursive: true });
    expect((await run([2], root, {})).r.reason).toBe("packages/gateway (@oneseat/gateway) is missing");
  });
});

describe("gates 3 and 4: skill lint and security scan", () => {
  it("finds the registry CLI or says why not", async () => {
    const root = await fakeRepo();
    expect(resolveSkillsCli(root, {}).path).toBe(join(root, "packages", "registry", "dist", "cli.js"));
    expect(resolveSkillsCli(root, { ONESEAT_SKILLS_CLI: join(root, "nope.js") }).error).toMatch(/missing file/);
    expect(resolveSkillsCli(root, { ONESEAT_SKILLS_CLI: join(root, "packages", "registry", "dist", "cli.js") }).path).toBeDefined();
    await rm(join(root, "packages", "registry", "dist"), { recursive: true });
    expect(resolveSkillsCli(root, {}).error).toMatch(/not built/);
    const noBin = await fakeRepo({ noRegistryBin: true });
    expect(resolveSkillsCli(noBin, {}).error).toMatch(/no "oneseat-skills" bin/);
    await rm(join(noBin, "packages", "registry"), { recursive: true });
    expect(resolveSkillsCli(noBin, {}).error).toMatch(/is missing/);
    expect((await run([3], noBin)).r.status).toBe("FAIL");
  });

  it("parses scan output in every accepted shape", () => {
    expect(parseScanOutput('{"verdict":"pass","findings":[]}')).toEqual({ verdicts: ["pass"], findings: [] });
    expect(parseScanOutput('log line\n{"scan":{"verdict":"block","findings":[{"severity":"block","rule":"undeclared-network","file":"s.ts","line":3,"message":"x"},{"severity":"warn"}]}}')).toEqual({ verdicts: ["block"], findings: ["undeclared-network s.ts:3 x"] });
    expect(parseScanOutput('[{"verdict":"warn"},{"verdict":"pass"}]')!.verdicts).toEqual(["warn", "pass"]);
    expect(parseScanOutput('{"reports":[{"verdict":"pass"}]}')!.verdicts).toEqual(["pass"]);
    expect(parseScanOutput("no json")).toBeUndefined();
    expect(parseScanOutput("{broken")).toBeUndefined();
    expect(parseScanOutput('{"other":1}')).toBeUndefined();
  });

  it("lints every skill folder", async () => {
    const root = await fakeRepo();
    const ok = await run([3], root);
    expect(ok.r).toMatchObject({ status: "PASS", reason: "2 skill(s) lint clean" });
    expect(ok.calls.map((c) => c.slice(1, 3))).toEqual([[join(root, "packages", "registry", "dist", "cli.js"), "lint"], [join(root, "packages", "registry", "dist", "cli.js"), "lint"]]);
    const bad = await run([3], root, { lint: { "skill-1": 1 } });
    expect(bad.r).toMatchObject({ status: "FAIL", reason: "lint failed: skill-1" });
    const empty = await fakeRepo({ skills: 0 });
    expect((await run([3], empty)).r.reason).toMatch(/no skill folders under skills/);
  });

  it("scans every skill and fails on block, unreadable or missing reports", async () => {
    const root = await fakeRepo();
    expect((await run([4], root)).r).toMatchObject({ status: "PASS", reason: "2 skill(s) scanned, none blocked" });
    const warn = await run([4], root, { scan: { "skill-0": { stdout: '{"verdict":"warn"}' } } });
    expect(warn.r.reason).toBe("2 skill(s) scanned, none blocked (warnings: skill-0)");
    const block = await run([4], root, { scan: { "skill-1": { code: 2, stdout: '{"verdict":"block","findings":[{"severity":"block","rule":"undeclared-network","file":"x.ts","message":"evil.test"}]}' } } });
    expect(block.r).toMatchObject({ status: "FAIL", reason: "scan blocked: skill-1" });
    expect(block.r.details.join("\n")).toMatch(/undeclared-network x.ts evil.test/);
    expect((await run([4], root, { scan: { "skill-0": { code: 1, stdout: "" } } })).r.details.join()).toMatch(/scan failed \(exit 1\) with no JSON report/);
    expect((await run([4], root, { scan: { "skill-0": { code: 0, stdout: "all good" } } })).r.details.join()).toMatch(/printed no JSON report/);
  });
});

describe("gate 5: evals", () => {
  it("is SKIPPED, never PASS, without live evals or keys, after validating suites", async () => {
    const root = await fakeRepo();
    const dry = await run([5], root);
    expect(dry.r.status).toBe("SKIPPED");
    expect(dry.r.reason).toMatch(/^skipped: live evals not requested/);
    expect(dry.r.details[0]).toBe("dry run OK: 2 suite(s), 20 case(s)");
    const noKeys = await run([5], root, {}, { liveEvals: true, evalProviders: "anthropic:claude-sonnet-5-5,google:gemini-x" });
    expect(noKeys.r).toMatchObject({ status: "SKIPPED", reason: "skipped: no keys (ANTHROPIC_API_KEY, GEMINI_API_KEY unset); suites validated" });
  });

  it("fails on invalid suites or providers", async () => {
    const root = await fakeRepo();
    await writeFile(join(root, "skills", "skill-0", "evals", "cases.json"), JSON.stringify({ skill: "skill-0", cases: [] }));
    expect((await run([5], root)).r).toMatchObject({ status: "FAIL", reason: "eval suites are invalid (1 error(s))" });
    const good = await fakeRepo();
    expect((await run([5], good, {}, { evalProviders: "nope" })).r.reason).toMatch(/bad eval providers/);
  });

  it("re-scores a recorded report when it cannot run live", async () => {
    const root = await fakeRepo({ skills: 1 });
    const runs = Array.from({ length: 10 }, (_, i) => [true, false].map((withSkill) => ({ skill: "skill-0", caseId: `c${i}`, provider: "anthropic", model: "m", withSkill, score: 1, checks: [], outputText: withSkill ? "two words" : "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1, skillLoaded: true, weight: 1 }))).flat();
    await writeFile(join(root, "rec.json"), JSON.stringify({ version: 1, mode: "live", providers: [{ name: "anthropic", provider: "anthropic", model: "m" }], minCases: 10, tieEpsilon: 0.01, runs, verdicts: [], pass: true, noSkill: [] }));
    const r = await run([5], root, {}, { recordedEvals: join(root, "rec.json") });
    expect(r.r.status).toBe("SKIPPED");
    expect(r.r.reason).toMatch(/recorded report re-scored: 1\/1 verdict\(s\) pass/);
    const bad = await run([5], root, {}, { recordedEvals: join(root, "missing.json") });
    expect(bad.r.reason).toMatch(/recorded report unreadable/);
  });

  it("runs live when asked and keys exist, and reports the eval CLI's failure", async () => {
    const root = await fakeRepo({ skills: 1 });
    const fx = fakeExec(root, {});
    const [r] = await runGates([5], { root, exec: fx.exec, env: { ANTHROPIC_API_KEY: "k" }, liveEvals: true, log: () => {} });
    expect(r!.status).toBe("FAIL");
    expect(r!.reason).toMatch(/gate 5 failed \(exit 1\)/);
  });
});

describe("gate 6 and 7", () => {
  it("runs the desktop e2e script", async () => {
    const root = await fakeRepo();
    const ok = await run([6], root);
    expect(ok.r.status).toBe("PASS");
    expect(ok.calls[0]).toEqual(["pnpm", "--filter", "@oneseat/desktop", "e2e"]);
    expect((await run([6], root, { e2eCode: 1 })).r).toMatchObject({ status: "FAIL", reason: "desktop e2e failed (exit 1)" });
    const noScript = await fakeRepo();
    await pkg(noScript, "apps/desktop", { name: "@oneseat/desktop", scripts: {} });
    expect((await run([6], noScript)).r.reason).toBe('@oneseat/desktop has no "e2e" script');
    expect((await run([6], await fakeRepo({ noDesktop: true }))).r.reason).toMatch(/apps\/desktop .* is missing/);
  });

  it("gate 7 is MANUAL with a pointer to the template", async () => {
    const r = (await run([7], await fakeRepo())).r;
    expect(r.status).toBe("MANUAL");
    expect(r.reason).toMatch(/packages\/testkit\/templates\/pilot.md/);
  });

  it("unknown gates and crashing gates FAIL", async () => {
    const root = await fakeRepo();
    expect((await run([9], root)).r).toMatchObject({ status: "FAIL", reason: "unknown gate 9" });
    const crash = await runGates([6], { root, exec: async () => { throw new Error("spawn exploded"); }, env: {}, log: () => {} });
    expect(crash[0]).toMatchObject({ status: "FAIL", reason: "gate crashed: spawn exploded" });
  });
});

describe("oneseat-gates CLI", () => {
  it("parses flags", () => {
    const o = parseGatesArgs(["--only", "3,1,1", "--skip", "3", "--root", "/r", "--skills-dir", "s", "--threshold", "85", "--core", "contracts,gateway", "--coverage-from-existing", "--live-evals", "--eval-providers", "anthropic:x", "--recorded-evals", "rec.json", "--eval-out", "out", "--report", "g.json"], "/w", {});
    if (o === "help") throw new Error("help");
    expect(o.ids).toEqual([1]);
    expect(o.skippedIds).toEqual([3]);
    expect(o.report).toBe("/w/g.json");
    expect(o.gate).toMatchObject({ root: "/r", skillsDir: "/w/s", coverageThreshold: 85, corePackages: ["contracts", "gateway"], coverageFromExisting: true, liveEvals: true, evalProviders: "anthropic:x", recordedEvals: "/w/rec.json", evalOut: "/w/out" });
    const all = parseGatesArgs([], "/w", {});
    expect(all !== "help" && all.ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parseGatesArgs(["-h"])).toBe("help");
    expect(() => parseGatesArgs(["--only", "8"])).toThrow(/unknown gate/);
    expect(() => parseGatesArgs(["--threshold", "120"])).toThrow(/0 to 100/);
  });

  it("prints a summary table, writes a JSON report and the GitHub step summary, exits 1 on FAIL", async () => {
    const root = await fakeRepo();
    const out: string[] = [];
    const err: string[] = [];
    const stepSummary = join(root, "summary.md");
    const fx = fakeExec(root, { e2eCode: 1 });
    const code = await gatesMain(["--only", "5,6,7", "--skip", "5", "--report", "reports/gates.json"], { stdout: (s) => out.push(s), stderr: (s) => err.push(s), cwd: root, env: { GITHUB_STEP_SUMMARY: stepSummary }, exec: fx.exec });
    expect(code).toBe(1);
    const table = out.join("");
    expect(table).toMatch(/Gate\s+Name\s+Status\s+Reason/);
    expect(table).toMatch(/5\s+Skill evals vs no-skill\s+SKIPPED\s+skipped by --skip/);
    expect(table).toMatch(/6\s+Desktop end to end\s+FAIL\s+desktop e2e failed/);
    expect(table).toMatch(/7\s+Pilot\s+MANUAL/);
    expect(table).toMatch(/0 PASS, 1 FAIL, 1 SKIPPED, 1 MANUAL\. A gate FAILED\./);
    expect(err.join("")).toMatch(/gate 6 details:/);
    const report = JSON.parse(await readFile(join(root, "reports", "gates.json"), "utf8"));
    expect(report.exitCode).toBe(1);
    expect(report.results.map((r: GateResult) => r.id)).toEqual([5, 6, 7]);
    expect(await readFile(stepSummary, "utf8")).toMatch(/\| 6 \| Desktop end to end \| \*\*FAIL\*\* \|/);
    const ok = await gatesMain(["--only", "7"], { stdout: () => {}, stderr: () => {}, cwd: root, env: {} });
    expect(ok).toBe(0);
    const bad: string[] = [];
    expect(await gatesMain(["--bogus"], { stdout: () => {}, stderr: (s) => bad.push(s), cwd: root, env: {} })).toBe(2);
    expect(bad.join("")).toMatch(/Usage: oneseat-gates/);
    const help: string[] = [];
    expect(await gatesMain(["--help"], { stdout: (s) => help.push(s), stderr: () => {}, cwd: root, env: {} })).toBe(0);
    expect(help.join("")).toMatch(/1 unit tests/);
  });

  it("renders markdown with details and escapes pipes", () => {
    const results: GateResult[] = [{ id: 2, name: GATE_NAMES[2]!, status: "PASS", reason: "a | b", details: ["d1"], durationMs: 1 }];
    const md = renderGatesMarkdown(results);
    expect(md).toContain("| 2 | Provider contract parity | PASS | a \\| b |");
    expect(md).toContain("<details><summary>Gate 2 details</summary>");
    expect(renderGatesTable(results)).toMatch(/No gate failed\./);
    expect(gatesExitCode(results)).toBe(0);
  });
});

describe("exec", () => {
  it("runs a command, captures output and never rejects", async () => {
    const r = await defaultExec(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], { cwd: process.cwd(), echo: false });
    expect(r).toEqual({ code: 3, stdout: "out", stderr: "err" });
    const missing = await defaultExec("definitely-not-a-command-oneseat", [], { cwd: process.cwd(), echo: false });
    expect(missing.code).not.toBe(0);
  });
  it("quotes Windows arguments", () => {
    expect(quoteWindowsArg("plain")).toBe("plain");
    expect(quoteWindowsArg("has space")).toBe('"has space"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
  });
});
