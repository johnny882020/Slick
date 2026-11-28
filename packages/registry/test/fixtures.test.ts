// Gates 3 and 4 on every fixture skill: the verdict, the rules that fire, and
// the lint result must match what each fixture was written to show.

import { describe, expect, it } from "vitest";
import { checkDir } from "../src/index.js";
import { fixture } from "./helpers/util.js";

interface Expectation {
  verdict: "pass" | "warn" | "block";
  /** Rules that must appear with severity "block". */
  blocks?: string[];
  /** Rules that must appear with severity "warn". */
  warns?: string[];
  lintOk: boolean;
  lintErrors?: string[];
  lintWarnings?: string[];
}

const EXPECTED: Record<string, Expectation> = {
  "clean-skill": { verdict: "pass", lintOk: true },
  "declared-host": { verdict: "pass", lintOk: true },
  "undeclared-fetch": { verdict: "block", blocks: ["undeclared-network-host"], lintOk: true },
  "prompt-injection": { verdict: "block", blocks: ["prompt-injection"], warns: ["credential-mention"], lintOk: true },
  "html-comment": { verdict: "block", blocks: ["hidden-instruction"], lintOk: true },
  "zero-width": { verdict: "block", blocks: ["hidden-characters"], lintOk: true },
  "chained-link": { verdict: "pass", lintOk: true, lintWarnings: ["chained-link"] },
  "too-long": { verdict: "pass", lintOk: false, lintErrors: ["body-length"] },
  Bad_Name: { verdict: "pass", lintOk: false, lintErrors: ["name-format"] },
  "base64-eval": { verdict: "block", blocks: ["obfuscated-code", "dynamic-code"], warns: ["encoded-blob"], lintOk: true },
  "python-requests": { verdict: "block", blocks: ["undeclared-network-host"], lintOk: true },
  "shell-curl": { verdict: "block", blocks: ["undeclared-network-host", "undeclared-process"], lintOk: true },
  "elf-binary": { verdict: "block", blocks: ["binary-executable"], lintOk: true },
};

describe("fixture skills (gates 3 and 4)", () => {
  for (const [name, exp] of Object.entries(EXPECTED)) {
    it(`${name}: scan ${exp.verdict}, lint ${exp.lintOk ? "ok" : "fails"}`, async () => {
      const { scan, lint, loaded } = await checkDir(fixture(name));
      const rules = (sev: string) => scan.findings.filter((f) => f.severity === sev).map((f) => f.rule);
      expect(scan.verdict, JSON.stringify(scan.findings, null, 2)).toBe(exp.verdict);
      for (const r of exp.blocks ?? []) expect(rules("block")).toContain(r);
      for (const r of exp.warns ?? []) expect(rules("warn")).toContain(r);
      if (exp.verdict === "pass") expect(rules("warn")).toEqual([]);
      expect(lint.ok, JSON.stringify(lint.issues, null, 2)).toBe(exp.lintOk);
      const errors = lint.issues.filter((i) => i.severity === "error").map((i) => i.rule);
      const warnings = lint.issues.filter((i) => i.severity === "warning").map((i) => i.rule);
      expect(errors.sort()).toEqual([...(exp.lintErrors ?? [])].sort());
      expect(warnings.sort()).toEqual([...(exp.lintWarnings ?? [])].sort());
      // Every file is read, text and binary alike.
      const files = loaded.entries.filter((e) => e.kind === "file");
      expect(scan.filesRead).toBe(files.length);
      expect(scan.bytesRead).toBe(files.reduce((n, e) => n + (e.kind === "file" ? e.bytes.length : 0), 0));
      expect(scan.summary.length).toBeGreaterThan(40);
    });
  }

  it("blocking findings carry a file and a line where one exists", async () => {
    for (const [name, line] of [
      ["undeclared-fetch", 3],
      ["prompt-injection", 9],
      ["html-comment", 9],
      ["zero-width", 7],
      ["base64-eval", 3],
      ["python-requests", 9],
      ["shell-curl", 4],
    ] as const) {
      const { scan } = await checkDir(fixture(name));
      const block = scan.findings.find((f) => f.severity === "block")!;
      expect(block.line, name).toBe(line);
      expect(block.file.length).toBeGreaterThan(0);
    }
  });

  it("records observed hosts, programs and declared permissions", async () => {
    const bad = (await checkDir(fixture("undeclared-fetch"))).scan;
    expect(bad.observed.net).toEqual(["evil.example.com"]);
    expect(bad.declared.read).toEqual(["tasks.json"]);
    expect(bad.observed.read).toEqual(["tasks.json"]);
    const good = (await checkDir(fixture("declared-host"))).scan;
    expect(good.declared.net).toEqual(["api.frankfurter.app"]);
    expect(good.observed.net).toEqual(["api.frankfurter.app"]);
    expect(good.summary).toContain("api.frankfurter.app: Daily exchange rates");
    expect(good.summary).toContain("Scripts it can run: rates (scripts/rates.ts)");
    expect(good.summary).toContain("Verdict: pass.");
    const sh = (await checkDir(fixture("shell-curl"))).scan;
    expect(sh.observed.run).toEqual(["curl"]);
    expect(sh.observed.net).toEqual(["paste.example.org"]);
    const py = (await checkDir(fixture("python-requests"))).scan;
    expect(py.observed.net).toEqual(["collect.example.net"]);
  });

  it("summaries are plain English and never repeat hidden characters", async () => {
    const zw = (await checkDir(fixture("zero-width"))).scan;
    expect(zw.summary).not.toMatch(/​/);
    expect(zw.summary).toContain("Verdict: blocked");
    const clean = (await checkDir(fixture("clean-skill"))).scan;
    expect(clean.summary).toContain('"clean-skill": Turn raw meeting notes');
    expect(clean.summary).toContain("It declares no access: it is instructions only.");
    expect(clean.summary).toContain("Its instructions start:");
  });
});
