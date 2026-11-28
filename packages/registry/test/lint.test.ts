import { describe, expect, it } from "vitest";
import { lintDescription, lintEvalSuite, lintSkill, isSemver, type LoadedSkill } from "../src/index.js";
import { DESC, mem, skillMd } from "./helpers/util.js";

const rules = (issues: { rule: string; severity: string }[], sev?: string) => issues.filter((i) => !sev || i.severity === sev).map((i) => i.rule);
const perms = (p: object) => JSON.stringify(p);

describe("lintDescription", () => {
  it("accepts a description that says what and when", () => {
    expect(lintDescription(DESC)).toEqual([]);
    expect(lintDescription("Summarise meeting notes into decisions and action items whenever a transcript is pasted.")).toEqual([]);
    expect(lintDescription("Reconcile the bank statement against the ledger. Triggers on month-end close requests.")).toEqual([]);
  });

  it("rejects short and generic descriptions", () => {
    expect(rules(lintDescription("Helps. Use when needed."))).toContain("description-vague");
    expect(rules(lintDescription("A helpful skill for various things. Use when the user needs anything at all, really."))).toContain("description-vague");
    expect(rules(lintDescription("A useful tool."))).toContain("description-vague");
  });

  it("requires a when", () => {
    expect(rules(lintDescription("Turns raw meeting notes into a tidy summary with owners and dates."))).toEqual(["description-when"]);
  });

  it("requires a what", () => {
    expect(rules(lintDescription("Use when the user asks for a weekly report on the team's numbers."))).toEqual(["description-what"]);
  });
});

describe("lintSkill", () => {
  it("passes a minimal valid skill", () => {
    const r = lintSkill(mem({}));
    expect(r).toEqual({ skill: "test-skill", ok: true, issues: [] });
  });

  it("fails without SKILL.md", () => {
    const r = lintSkill({ dir: "/x", dirName: "x", entries: [] });
    expect(r.ok).toBe(false);
    expect(rules(r.issues)).toEqual(["skill-md-missing"]);
  });

  it("reports parse errors and folder mismatches", () => {
    expect(rules(lintSkill(mem({ "SKILL.md": "# no frontmatter" })).issues)).toContain("parse");
    const r = lintSkill(mem({ "SKILL.md": skillMd("other-name") }));
    expect(rules(r.issues)).toContain("name-dir");
    expect(r.skill).toBe("other-name");
  });

  it("checks semver in metadata.version", () => {
    expect(rules(lintSkill(mem({ "SKILL.md": skillMd("test-skill", "# x\n", "metadata:\n  version: v1\n") })).issues)).toEqual(["version-format"]);
    expect(lintSkill(mem({ "SKILL.md": skillMd("test-skill", "# x\n", "metadata:\n  version: 2.0.0-rc.1+b5\n") })).issues).toEqual([]);
    expect(isSemver("1.2.3")).toBe(true);
    expect(isSemver("01.2.3")).toBe(false);
  });

  it("limits the body to SKILL_MAX_LINES", () => {
    const ok = lintSkill(mem({ "SKILL.md": skillMd("test-skill", "x\n".repeat(500)) }));
    expect(ok.ok).toBe(true);
    const long = lintSkill(mem({ "SKILL.md": skillMd("test-skill", "x\n".repeat(501)) }));
    expect(rules(long.issues)).toEqual(["body-length"]);
    expect(long.issues[0]!.line).toBe(505);
  });

  it("checks links: missing, escaping, folders, symlinks", () => {
    const body = "See [a](refs/a.md), [gone](refs/gone.md), [up](../secret.md), [dir](refs/), [web](https://x.example.com) and [anchor](#top).\n";
    const r = lintSkill(mem({ "SKILL.md": skillMd("test-skill", body), "refs/a.md": "# A\n" }));
    expect(rules(r.issues, "error").sort()).toEqual(["link-escape", "link-missing"]);
    expect(r.issues.find((i) => i.rule === "link-missing")!.line).toBe(5);
    const skill: LoadedSkill = mem({ "SKILL.md": skillMd("test-skill", "[x](x.md) [y](y.md)\n") });
    skill.entries.push({ kind: "symlink", path: "x.md", target: "/etc/passwd" });
    skill.entries.push({ kind: "symlink", path: "y.md", target: "SKILL.md", resolved: "SKILL.md" });
    const s = lintSkill(skill);
    expect(rules(s.issues)).toEqual(["link-escape"]);
  });

  it("warns about chained links but not about links back or direct ones", () => {
    const r = lintSkill(
      mem({
        "SKILL.md": skillMd("test-skill", "[a](refs/a.md) [c](refs/c.md)\n"),
        "refs/a.md": "[b](b.md) [c](c.md) [home](../SKILL.md) [gone](nope.md) [out](../../x.md) [d](sub/)\n",
        "refs/b.md": "b",
        "refs/c.md": "c",
        "refs/sub/d.md": "d",
      }),
    );
    const chained = r.issues.filter((i) => i.rule === "chained-link").map((i) => i.message);
    expect(chained).toHaveLength(2);
    expect(chained[0]).toContain('links to "refs/b.md": chained link; link it from SKILL.md directly');
    expect(chained[1]).toContain('"refs/sub/"');
    expect(rules(r.issues, "warning")).toContain("link-missing");
    expect(rules(r.issues, "error")).toEqual(["link-escape"]);
    expect(r.issues.find((i) => i.rule === "link-escape")!.file).toBe("refs/a.md");
  });

  it("validates oneseat.json beyond the contract parser", () => {
    const r = lintSkill(
      mem({
        "oneseat.json": perms({
          permissions: { net: ["https://x.example.com/path", "ok.example.com", "blank.example.com", "*.wild.example.com:8443"], env: ["GITHUB_TOKEN", "TZ"] },
          reasons: { "https://x.example.com/path": "Fetches the daily report file.", "ok.example.com": "api", "blank.example.com": " ", "*.wild.example.com:8443": "Company servers for reports.", "extra.example.com": "never used" },
          scripts: { a: { file: "scripts/a.ts", description: "Does a." }, b: { file: "../b.ts", description: "x" }, c: { file: "c.py", description: " " }, d: { file: "missing.ts", description: "d" } },
          extra: true,
        }),
        "scripts/a.ts": "console.log(1)",
        "c.py": "print(1)",
      }),
    );
    expect(rules(r.issues, "error").sort()).toEqual(["env-secret", "net-host-format", "net-reason", "script-description", "script-escape", "script-missing"].sort());
    expect(rules(r.issues, "warning").sort()).toEqual(["net-reason-short", "permissions-unknown-key", "reason-unused", "script-runtime"].sort());
  });

  it("reports contract errors in oneseat.json", () => {
    expect(rules(lintSkill(mem({ "oneseat.json": "{bad" })).issues)).toEqual(["permissions-json"]);
    expect(rules(lintSkill(mem({ "oneseat.json": perms({ permissions: { net: ["a.example.com"] } }) })).issues)).toEqual(["net-reason"]);
    expect(rules(lintSkill(mem({ "oneseat.json": perms({ effects: ["launch"] }) })).issues)).toEqual(["effects-type"]);
  });

  it("warns about files over 1 MB", () => {
    const r = lintSkill(mem({ "data/big.csv": new Uint8Array(1024 * 1024 + 1) }));
    expect(rules(r.issues)).toEqual(["file-size"]);
    expect(r.ok).toBe(true);
  });

  it("checks evals/cases.json when present", () => {
    expect(rules(lintSkill(mem({ "evals/cases.json": "{" })).issues)).toEqual(["evals-json"]);
  });
});

describe("lintEvalSuite", () => {
  const suite = (cases: unknown[], skill: unknown = "s") => JSON.stringify({ skill, cases });
  const tenCases = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, input: "hi", checks: [{ type: "json_valid" }] }));

  it("accepts a valid suite", () => {
    expect(lintEvalSuite(suite(tenCases), "s")).toEqual([]);
  });

  it("rejects bad shapes", () => {
    expect(rules(lintEvalSuite("[]", "s"))).toEqual(["evals-shape"]);
    expect(rules(lintEvalSuite(JSON.stringify({ cases: [] }), "s"))).toContain("evals-shape");
    expect(rules(lintEvalSuite(JSON.stringify({ skill: "s", cases: {} }), "s"))).toEqual(["evals-shape"]);
    expect(rules(lintEvalSuite(suite(tenCases, "other"), "s"))).toEqual(["evals-skill-name"]);
  });

  it("requires unique ids, inputs and checks", () => {
    const issues = lintEvalSuite(
      suite([
        ...tenCases,
        { id: "c1", input: "dup", checks: [{ type: "json_valid" }] },
        "not an object",
        { input: "", checks: [] },
        { id: "w", input: "x", checks: [{ type: "json_valid" }], weight: 0, workspace: { a: 1 }, db: { t: [1] } },
      ]),
      "s",
    );
    expect(rules(issues)).toContain("evals-duplicate-id");
    expect(issues.filter((i) => i.rule === "evals-case").length).toBe(7);
  });

  it("validates every check type", () => {
    const checks = [
      { type: "contains" },
      { type: "contains", value: "x", caseSensitive: "yes" },
      { type: "not_contains", value: "x", caseSensitive: true },
      { type: "regex" },
      { type: "regex", pattern: "(" },
      { type: "regex", pattern: "a", flags: 1 },
      { type: "regex", pattern: "a", flags: "i" },
      { type: "tool_called" },
      { type: "tool_called", name: "t", minTimes: 0 },
      { type: "tool_called", name: "t", minTimes: 2 },
      { type: "tool_not_called" },
      { type: "tool_not_called", name: "t" },
      { type: "max_words" },
      { type: "min_words", value: 3 },
      { type: "judge" },
      { type: "judge", rubric: "r", threshold: 2 },
      { type: "judge", rubric: "r", threshold: 0.5 },
      { type: "nope" },
      "x",
    ];
    const issues = lintEvalSuite(suite([{ id: "a", input: "i", checks }]), "s");
    const checkErrors = issues.filter((i) => i.rule === "evals-check").map((i) => i.message);
    expect(checkErrors).toHaveLength(13);
    expect(checkErrors.some((m) => m.includes("invalid regex"))).toBe(true);
    expect(rules(issues)).toContain("evals-count");
  });
});
