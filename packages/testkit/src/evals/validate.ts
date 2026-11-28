// Validate skills/<name>/evals/cases.json (EvalSuite) before anything runs.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BUSINESS_TABLES, type EvalCheck, type EvalSuite } from "@oneseat/contracts";
import { safeSkillPath } from "../memory-store.js";

export interface EvalIssue {
  severity: "error" | "warning";
  /** JSON path inside the suite, e.g. cases[3].checks[0].pattern. */
  path: string;
  message: string;
  /** Skill folder name, when loaded from disk. */
  skill?: string;
}

export const EVAL_CHECK_TYPES: readonly EvalCheck["type"][] = [
  "contains",
  "not_contains",
  "regex",
  "tool_called",
  "tool_not_called",
  "json_valid",
  "max_words",
  "min_words",
  "judge",
];

export const DEFAULT_MIN_CASES = 10;
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkCheck(c: unknown, path: string, issues: EvalIssue[]): void {
  const err = (p: string, message: string): void => {
    issues.push({ severity: "error", path: `${path}${p}`, message });
  };
  if (!isObj(c)) return err("", "check must be an object");
  const type = c["type"];
  if (!EVAL_CHECK_TYPES.includes(type as EvalCheck["type"])) return err(".type", `unknown check type ${JSON.stringify(type)}; use one of ${EVAL_CHECK_TYPES.join(", ")}`);
  const str = (k: string) => {
    if (typeof c[k] !== "string" || (c[k] as string).length === 0) err(`.${k}`, `${String(type)} needs a non-empty string "${k}"`);
  };
  const posInt = (k: string, required: boolean) => {
    const v = c[k];
    if (v === undefined && !required) return;
    if (typeof v !== "number" || !Number.isInteger(v) || v < (k === "minTimes" ? 1 : 0)) err(`.${k}`, `"${k}" must be a ${k === "minTimes" ? "positive" : "non-negative"} integer`);
  };
  switch (type) {
    case "contains":
    case "not_contains":
      str("value");
      if (c["caseSensitive"] !== undefined && typeof c["caseSensitive"] !== "boolean") err(".caseSensitive", "caseSensitive must be a boolean");
      break;
    case "regex":
      str("pattern");
      if (c["flags"] !== undefined && (typeof c["flags"] !== "string" || !/^[dgimsuyv]*$/.test(c["flags"]))) err(".flags", "flags must be RegExp flags");
      try {
        new RegExp(String(c["pattern"]), typeof c["flags"] === "string" ? c["flags"] : "");
      } catch (e) {
        err(".pattern", `invalid RegExp: ${(e as Error).message}`);
      }
      break;
    case "tool_called":
      str("name");
      posInt("minTimes", false);
      break;
    case "tool_not_called":
      str("name");
      break;
    case "json_valid":
      break;
    case "max_words":
    case "min_words":
      posInt("value", true);
      break;
    case "judge":
      str("rubric");
      if (c["threshold"] !== undefined && (typeof c["threshold"] !== "number" || c["threshold"] < 0 || c["threshold"] > 1)) err(".threshold", "threshold must be between 0 and 1");
      break;
  }
}

function checkCase(c: unknown, path: string, issues: EvalIssue[]): void {
  const err = (p: string, message: string): void => {
    issues.push({ severity: "error", path: `${path}${p}`, message });
  };
  if (!isObj(c)) return err("", "case must be an object");
  if (typeof c["id"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c["id"])) err(".id", "id must be a non-empty slug (letters, digits, . _ -)");
  if (typeof c["input"] !== "string" || c["input"].trim().length === 0) err(".input", "input must be a non-empty string");
  if (!Array.isArray(c["checks"]) || c["checks"].length === 0) err(".checks", "checks must be a non-empty list");
  else c["checks"].forEach((ch, i) => checkCheck(ch, `${path}.checks[${i}]`, issues));
  if (c["weight"] !== undefined && (typeof c["weight"] !== "number" || !(c["weight"] > 0) || !Number.isFinite(c["weight"]))) err(".weight", "weight must be a positive number");
  if (c["workspace"] !== undefined) {
    if (!isObj(c["workspace"])) err(".workspace", "workspace must map paths to file contents");
    else
      for (const [p, v] of Object.entries(c["workspace"])) {
        if (safeSkillPath(p) === undefined) err(`.workspace[${JSON.stringify(p)}]`, "workspace paths must be relative and stay inside the workspace");
        if (typeof v !== "string") err(`.workspace[${JSON.stringify(p)}]`, "workspace file content must be a string");
      }
  }
  if (c["db"] !== undefined) {
    if (!isObj(c["db"])) err(".db", "db must map table names to rows");
    else
      for (const [table, rows] of Object.entries(c["db"])) {
        if (!(BUSINESS_TABLES as readonly string[]).includes(table)) err(`.db.${table}`, `unknown table "${table}"; seed only ${BUSINESS_TABLES.join(", ")}`);
        if (!Array.isArray(rows)) {
          err(`.db.${table}`, "rows must be a list of objects");
          continue;
        }
        rows.forEach((row, i) => {
          if (!isObj(row) || Object.keys(row).length === 0) err(`.db.${table}[${i}]`, "row must be a non-empty object");
          else for (const k of Object.keys(row)) if (!IDENTIFIER.test(k)) err(`.db.${table}[${i}].${k}`, "column names must be SQL identifiers");
        });
      }
  }
}

/** Validate an unknown value as an EvalSuite. */
export function validateEvalSuite(raw: unknown, opts: { skill?: string; minCases?: number } = {}): EvalIssue[] {
  const issues: EvalIssue[] = [];
  const minCases = opts.minCases ?? DEFAULT_MIN_CASES;
  if (!isObj(raw)) return [{ severity: "error", path: "", message: "suite must be an object {skill, cases}" }];
  if (typeof raw["skill"] !== "string" || raw["skill"].length === 0) issues.push({ severity: "error", path: "skill", message: "skill must be a non-empty string" });
  else if (opts.skill !== undefined && raw["skill"] !== opts.skill) issues.push({ severity: "error", path: "skill", message: `skill "${raw["skill"]}" must match the folder "${opts.skill}"` });
  if (!Array.isArray(raw["cases"])) {
    issues.push({ severity: "error", path: "cases", message: "cases must be a list" });
    return issues;
  }
  const cases = raw["cases"] as unknown[];
  cases.forEach((c, i) => checkCase(c, `cases[${i}]`, issues));
  const ids = new Map<string, number>();
  for (const c of cases) if (isObj(c) && typeof c["id"] === "string") ids.set(c["id"], (ids.get(c["id"]) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) issues.push({ severity: "error", path: "cases", message: `case id "${id}" is used ${n} times` });
  if (cases.length < minCases) issues.push({ severity: "error", path: "cases", message: `gate 5 needs at least ${minCases} cases, found ${cases.length}` });
  const deterministic = cases.filter((c) => isObj(c) && Array.isArray(c["checks"]) && (c["checks"] as { type?: string }[]).some((ch) => ch?.type !== "judge")).length;
  if (cases.length > 0 && deterministic === 0) issues.push({ severity: "warning", path: "cases", message: "every case is judge-only; add a deterministic check so recorded runs can be re-scored" });
  return issues;
}

export interface LoadedSuites {
  suites: EvalSuite[];
  issues: EvalIssue[];
  /** Skill folders with no evals/cases.json. */
  missing: string[];
}

/** Load every skills/<name>/evals/cases.json under skillsDir. Invalid suites are reported, not returned. */
export async function loadEvalSuites(skillsDir: string, opts: { minCases?: number; only?: readonly string[] } = {}): Promise<LoadedSuites> {
  const suites: EvalSuite[] = [];
  const issues: EvalIssue[] = [];
  const missing: string[] = [];
  let entries: string[];
  try {
    entries = (await readdir(skillsDir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  } catch (e) {
    return { suites, missing, issues: [{ severity: "error", path: skillsDir, message: `cannot read skills folder: ${(e as Error).message}` }] };
  }
  for (const name of entries) {
    if (opts.only && opts.only.length > 0 && !opts.only.includes(name)) continue;
    let text: string;
    try {
      await readFile(join(skillsDir, name, "SKILL.md"));
    } catch {
      continue; // not a skill folder
    }
    try {
      text = await readFile(join(skillsDir, name, "evals", "cases.json"), "utf8");
    } catch {
      missing.push(name);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      issues.push({ severity: "error", path: "evals/cases.json", message: `not valid JSON: ${(e as Error).message}`, skill: name });
      continue;
    }
    const found = validateEvalSuite(raw, { skill: name, ...(opts.minCases !== undefined ? { minCases: opts.minCases } : {}) }).map((i) => ({ ...i, skill: name }));
    issues.push(...found);
    if (!found.some((i) => i.severity === "error")) suites.push(raw as EvalSuite);
  }
  return { suites, issues, missing };
}

