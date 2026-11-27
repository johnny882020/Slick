import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  dryRunEvals,
  EVAL_DB_FILE,
  loadEvalSuites,
  prepareRunDirs,
  renderDryRun,
  seedDatabase,
  trySeedInMemory,
  validateEvalSuite,
  writeWorkspace,
} from "../src/evals/index.js";

const tmp: string[] = [];
afterAll(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), "oneseat-evals-"));
  tmp.push(d);
  return d;
}

const cases = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => ({ id: `case-${i + 1}`, input: `Do task ${i + 1}`, checks: [{ type: "contains", value: "ok" }], ...extra }));

describe("validateEvalSuite", () => {
  it("accepts a valid suite", () => {
    expect(validateEvalSuite({ skill: "s", cases: cases(10) }, { skill: "s" })).toEqual([]);
  });

  it("reports every kind of problem with a path", () => {
    const suite = {
      skill: "other",
      cases: [
        { id: "", input: " ", checks: [] },
        { id: "ok-1", input: "x", checks: [{ type: "nope" }, "bad", { type: "contains" }, { type: "contains", value: "x", caseSensitive: "y" }, { type: "regex", pattern: "(", flags: "q" }, { type: "tool_called", name: "t", minTimes: 0 }, { type: "tool_not_called" }, { type: "max_words", value: -1 }, { type: "min_words" }, { type: "judge", rubric: "r", threshold: 2 }, { type: "json_valid" }], weight: 0 },
        { id: "ok-1", input: "x", checks: [{ type: "judge", rubric: "r" }], workspace: { "../escape.txt": "x", "a.txt": 3 }, db: { _os_action_log: [], customers: [{}, { "bad col": 1 }], purchases: "rows" } },
        "not an object",
        { id: "w", input: "x", checks: [{ type: "contains", value: "a" }], workspace: "nope", db: [] },
      ],
    };
    const issues = validateEvalSuite(suite, { skill: "s" });
    const text = issues.map((i) => `${i.path}: ${i.message}`).join("\n");
    for (const needle of [
      'skill: skill "other" must match the folder "s"',
      "cases[0].id: id must be a non-empty slug",
      "cases[0].input: input must be a non-empty string",
      "cases[0].checks: checks must be a non-empty list",
      'cases[1].checks[0].type: unknown check type "nope"',
      "cases[1].checks[1]: check must be an object",
      'cases[1].checks[2].value: contains needs a non-empty string "value"',
      "cases[1].checks[3].caseSensitive",
      "cases[1].checks[4].flags",
      "cases[1].checks[4].pattern: invalid RegExp",
      'cases[1].checks[5].minTimes: "minTimes" must be a positive integer',
      "cases[1].checks[6].name",
      'cases[1].checks[7].value: "value" must be a non-negative integer',
      "cases[1].checks[8].value",
      "cases[1].checks[9].threshold",
      "cases[1].weight",
      'cases[2].workspace["../escape.txt"]: workspace paths must be relative',
      'cases[2].workspace["a.txt"]: workspace file content must be a string',
      'cases[2].db._os_action_log: unknown table "_os_action_log"',
      "cases[2].db.customers[0]: row must be a non-empty object",
      "cases[2].db.customers[1].bad col: column names must be SQL identifiers",
      "cases[2].db.purchases: rows must be a list of objects",
      "cases[3]: case must be an object",
      "cases[4].workspace: workspace must map paths",
      "cases[4].db: db must map table names",
      'cases: case id "ok-1" is used 2 times',
      "cases: gate 5 needs at least 10 cases, found 5",
    ])
      expect(text).toContain(needle);
  });

  it("rejects non-objects and missing fields; warns on judge-only suites", () => {
    expect(validateEvalSuite(null)[0]!.message).toMatch(/must be an object/);
    expect(validateEvalSuite({ cases: "x" }).map((i) => i.path)).toEqual(["skill", "cases"]);
    const judgeOnly = validateEvalSuite({ skill: "s", cases: cases(1, { checks: [{ type: "judge", rubric: "r" }] }) }, { minCases: 1 });
    expect(judgeOnly).toEqual([expect.objectContaining({ severity: "warning" })]);
  });
});

describe("loading and dry runs", () => {
  async function skills() {
    const root = await tempDir();
    const add = async (name: string, suite?: unknown, raw?: string) => {
      await mkdir(join(root, name, "evals"), { recursive: true });
      await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
      if (suite !== undefined || raw !== undefined) await writeFile(join(root, name, "evals", "cases.json"), raw ?? JSON.stringify(suite));
    };
    await add("good-one", { skill: "good-one", cases: cases(10, { db: { customers: [{ id: "c1", name: "Ada" }] } }) });
    await add("bad-seed", { skill: "bad-seed", cases: cases(10, { db: { customers: [{ id: "c1", nosuchcolumn: "x" }] } }) });
    await add("no-evals");
    await add("bad-json", undefined, "{");
    await add("few", { skill: "few", cases: cases(2) });
    await mkdir(join(root, "not-a-skill"));
    return root;
  }

  it("loads valid suites and reports the rest", async () => {
    const root = await skills();
    const r = await loadEvalSuites(root);
    expect(r.suites.map((s) => s.skill)).toEqual(["bad-seed", "good-one"]);
    expect(r.missing).toEqual(["no-evals"]);
    expect(r.issues.map((i) => i.skill)).toEqual(expect.arrayContaining(["bad-json", "few"]));
    expect((await loadEvalSuites(root, { only: ["good-one"] })).suites).toHaveLength(1);
    expect((await loadEvalSuites(join(root, "missing"))).issues[0]!.message).toMatch(/cannot read skills folder/);
  });

  it("dry run seeds every case and fails on bad data, missing suites and too few cases", async () => {
    const root = await skills();
    const r = await dryRunEvals(root);
    expect(r.ok).toBe(false);
    const text = renderDryRun(r);
    expect(text).toMatch(/FAILED/);
    expect(text).toMatch(/bad-seed: cases\[0\]\.db: seed failed: customers\[0\]: table customers has no column named nosuchcolumn/);
    expect(text).toMatch(/no-evals: evals\/cases.json: skill has no eval cases/);
    expect(text).toMatch(/few: cases: gate 5 needs at least 10 cases/);
    expect(r.suites.map((s) => s.skill)).toEqual(["good-one"]);
    const one = await dryRunEvals(root, { only: ["good-one"] });
    expect(one.ok).toBe(true);
    expect(one.cases).toBe(10);
    expect(renderDryRun(one)).toMatch(/OK — 1 suite\(s\), 10 case\(s\), 0 judge check/);
    const empty = await tempDir();
    expect((await dryRunEvals(empty)).issues[0]!.message).toBe("no skills with eval cases found");
  });
});

describe("seeding a fresh data folder", () => {
  it("creates the business schema and inserts rows in dependency order", async () => {
    const dir = await tempDir();
    const path = join(dir, "x.db");
    const r = await seedDatabase(path, {
      purchases: [{ id: "p1", customer_id: "c1", product: "Plan", amount_cents: 1200, purchased_at: "2026-01-01" }],
      customers: [{ id: "c1", name: "Ada", tags: ["vip", "eu"], email: null }],
      brand: [{ key: "voice", value: { tone: "warm" } }],
      tickets: [{ id: "t1", subject: "Help", received_at: "2026-01-02", status: "open", priority: "high" }],
      proposals: [{ id: "pr1", title: "Website", status: "draft", total_cents: true }],
    });
    expect(r.rows).toBe(5);
    const db = new DatabaseSync(path);
    expect(db.prepare("SELECT ltv_cents FROM customer_ltv WHERE customer_id='c1'").get()).toEqual({ ltv_cents: 1200 });
    expect(db.prepare("SELECT tags, email FROM customers").get()).toEqual({ tags: '["vip","eu"]', email: null });
    expect(db.prepare("SELECT value FROM brand").get()).toEqual({ value: '{"tone":"warm"}' });
    expect(db.prepare("SELECT total_cents FROM proposals").get()).toEqual({ total_cents: 1 });
    db.close();
  });

  it("rolls back and names the row on bad data; refuses private tables", async () => {
    await expect(seedDatabase(":memory:", { tickets: [{ id: "t", subject: "s", received_at: "x", status: "bogus" }] })).rejects.toThrow(/tickets\[0\]: CHECK constraint failed/);
    await expect(seedDatabase(":memory:", { _os_action_log: [] } as never)).rejects.toThrow(/cannot seed table "_os_action_log"/);
    await expect(seedDatabase(":memory:", { customers: [{ "id; DROP": 1 }] } as never)).rejects.toThrow(/bad column name/);
    expect(await trySeedInMemory({})).toBeUndefined();
    expect(await trySeedInMemory({ db: { customers: [{ id: "c" }] } })).toMatch(/NOT NULL constraint failed: customers.name/);
    const dir = await tempDir();
    const path = join(dir, "y.db");
    await expect(seedDatabase(path, { customers: [{ id: "a", name: "A" }, { id: "a", name: "dup" }] })).rejects.toThrow(/customers\[1\]/);
    const db = new DatabaseSync(path);
    expect(db.prepare("SELECT COUNT(*) AS n FROM customers").get()).toEqual({ n: 0 });
    db.close();
  });

  it("writes workspace files and blocks traversal", async () => {
    const dir = await tempDir();
    expect(await writeWorkspace(dir, { "a.txt": "A", "deep/b.csv": "1,2" })).toBe(2);
    expect(await readFile(join(dir, "deep", "b.csv"), "utf8")).toBe("1,2");
    await expect(writeWorkspace(dir, { "../x": "no" })).rejects.toThrow(/leaves the workspace/);
    expect(await writeWorkspace(dir, undefined)).toBe(0);
  });

  it("prepareRunDirs makes a fresh seeded folder per run and cleans up", async () => {
    const base = await tempDir();
    const a = await prepareRunDirs({ db: { customers: [{ id: "c1", name: "Ada" }] }, workspace: { "in.txt": "hi" } }, { tmpRoot: base, label: "skill/case 1" });
    const b = await prepareRunDirs({}, { tmpRoot: base });
    expect(a.root).not.toBe(b.root);
    expect(a.dbPath).toBe(join(a.dataDir, EVAL_DB_FILE));
    expect(a.root).toMatch(/oneseat-eval-skill_case_1-/);
    expect(await readFile(join(a.workspaceDir, "in.txt"), "utf8")).toBe("hi");
    const db = new DatabaseSync(a.dbPath);
    expect(db.prepare("SELECT name FROM customers").get()).toEqual({ name: "Ada" });
    db.close();
    await a.cleanup();
    expect(existsSync(a.root)).toBe(false);
    const kept = await prepareRunDirs({}, { tmpRoot: base, keep: true });
    await kept.cleanup();
    expect(existsSync(kept.root)).toBe(true);
    await expect(prepareRunDirs({ workspace: { "../bad": "x" } }, { tmpRoot: base })).rejects.toThrow(/leaves the workspace/);
    await b.cleanup();
  });
});
