// Gate 3: skill lint. Checks a skill folder against the Agent Skills standard
// and the OneSeat rules (CLAUDE.md): the description says what and when,
// SKILL.md stays under SKILL_MAX_LINES, files are linked directly from
// SKILL.md (no chains) and never outside the folder, every network host has a
// reason, declared scripts exist, and evals/cases.json is a valid EvalSuite.

import { posix } from "node:path";
import {
  SKILL_FILE,
  SKILL_MAX_LINES,
  SKILL_PERMISSIONS_FILE,
  buildManifest,
  extractLinks,
  parseSkillMd,
  type EvalCheck,
  type LintReport,
  type SkillIssue,
} from "@oneseat/contracts";
import { isSecretName } from "./detect.js";
import { fileEntry, filePaths, isDirPath, textOf, type LoadedSkill } from "./files.js";
import { LARGE_FILE_BYTES } from "./limits.js";

export const EVALS_FILE = "evals/cases.json";
/** Gate 5 runs this many cases per skill. */
export const EVAL_CASES_EXPECTED = 10;
export const DESCRIPTION_MIN = 40;

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function isSemver(v: string): boolean {
  return SEMVER.test(v);
}

const TRIGGER =
  /\b(?:use\s+(?:this\s+(?:skill\s+)?|it\s+)?(?:when|for|to|if|whenever|on|after|before|while)\b|when\s+(?:the\s+)?(?:user|you|someone|a\s+person|people|asked|working|handling|dealing|preparing|reviewing|writing)\b|whenever\b|if\s+the\s+user\b|trigger(?:s|ed)?\b|use\s+this\b|for\s+requests?\s+(?:about|to|like|that|for)\b|invoke\s+(?:this\s+|it\s+)?when\b|(?:applies|helpful|useful|relevant)\s+when\b|ideal\s+for\b)/i;

const GENERIC_WHOLE =
  /^(?:an?\s+|the\s+)?(?:helpful\s+|useful\s+|simple\s+|general\s+|generic\s+|basic\s+|handy\s+|my\s+|new\s+)*(?:skill|tool|helper|assistant|utility|thing|agent)s?\b(?:\s+(?:for|that|to|which)\s+(?:does\s+|helps?\s+(?:with\s+)?)?(?:stuff|things|tasks|anything|everything|various\s+\w+|many\s+\w+|general\s+\w+|help(?:ing)?|you))?[.!]?$/i;
const GENERIC_PHRASE =
  /\b(?:does\s+stuff|various\s+things|helps?\s+with\s+(?:tasks|things|stuff|anything|everything)|general[-\s]purpose|misc(?:ellaneous)?\s+(?:tasks|stuff|things)|(?:does|handles)\s+(?:everything|anything)|lorem\s+ipsum|todo:?\s+write)\b/i;

const HOST_FORMAT = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;
const DENO_SCRIPT = /\.(?:ts|mts|js|mjs|tsx|jsx)$/i;
const KNOWN_PERMISSION_KEYS = new Set(["$schema", "permissions", "effects", "reasons", "scripts"]);

function words(s: string): number {
  return s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/** Issues with a description: it must say what the skill does and when to use it. */
export function lintDescription(description: string): SkillIssue[] {
  const issues: SkillIssue[] = [];
  const err = (rule: string, message: string) => issues.push({ severity: "error", rule, message, file: SKILL_FILE });
  const d = description.trim().replace(/\s+/g, " ");
  if (d.length < DESCRIPTION_MIN)
    err("description-vague", `description is too short (${d.length} characters); say what the skill does and when to use it in at least ${DESCRIPTION_MIN}`);
  if (GENERIC_WHOLE.test(d) || GENERIC_PHRASE.test(d)) err("description-vague", "description is generic; name the task the skill does");
  const t = TRIGGER.exec(d);
  if (!t) err("description-when", 'description must say when to use the skill (e.g. "Use when the user asks for ...")');
  else {
    // The "what" is everything except the trigger clause (trigger to end of its sentence).
    const after = d.slice(t.index);
    const end = after.search(/[.!?](?:\s|$)/);
    const what = d.slice(0, t.index) + (end === -1 ? "" : after.slice(end + 1));
    if (words(what) < 3) err("description-what", "description must also say what the skill does, not only when to use it");
  }
  return issues;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkIssue(check: unknown, where: string): string | undefined {
  if (!isRecord(check)) return `${where} must be an object`;
  const c = check as Partial<EvalCheck> & Record<string, unknown>;
  const str = (k: string) => typeof c[k] === "string" && (c[k] as string).length > 0;
  const num = (k: string) => typeof c[k] === "number" && Number.isFinite(c[k]);
  switch (c.type) {
    case "contains":
    case "not_contains":
      if (!str("value")) return `${where} needs a "value" string`;
      if (c["caseSensitive"] !== undefined && typeof c["caseSensitive"] !== "boolean") return `${where}.caseSensitive must be true or false`;
      return undefined;
    case "regex":
      if (!str("pattern")) return `${where} needs a "pattern" string`;
      if (c["flags"] !== undefined && typeof c["flags"] !== "string") return `${where}.flags must be a string`;
      try {
        new RegExp(c["pattern"] as string, (c["flags"] as string | undefined) ?? "");
      } catch (e) {
        return `${where} has an invalid regex: ${(e as Error).message}`;
      }
      return undefined;
    case "tool_called":
      if (!str("name")) return `${where} needs a "name" string`;
      if (c["minTimes"] !== undefined && !(num("minTimes") && (c["minTimes"] as number) >= 1)) return `${where}.minTimes must be a number >= 1`;
      return undefined;
    case "tool_not_called":
      return str("name") ? undefined : `${where} needs a "name" string`;
    case "json_valid":
      return undefined;
    case "max_words":
    case "min_words":
      return num("value") && (c["value"] as number) >= 0 ? undefined : `${where} needs a "value" number`;
    case "judge":
      if (!str("rubric")) return `${where} needs a "rubric" string`;
      if (c["threshold"] !== undefined && !(num("threshold") && (c["threshold"] as number) >= 0 && (c["threshold"] as number) <= 1))
        return `${where}.threshold must be between 0 and 1`;
      return undefined;
    default:
      return `${where} has unknown type ${JSON.stringify(c.type)}`;
  }
}

/** Validate the text of evals/cases.json as an EvalSuite. */
export function lintEvalSuite(text: string, skillName: string | undefined): SkillIssue[] {
  const issues: SkillIssue[] = [];
  const err = (rule: string, message: string) => issues.push({ severity: "error", rule, message, file: EVALS_FILE });
  const warn = (rule: string, message: string) => issues.push({ severity: "warning", rule, message, file: EVALS_FILE });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    err("evals-json", `evals/cases.json is not valid JSON: ${(e as Error).message}`);
    return issues;
  }
  if (!isRecord(raw)) {
    err("evals-shape", "evals/cases.json must be an object with \"skill\" and \"cases\"");
    return issues;
  }
  if (typeof raw["skill"] !== "string" || !raw["skill"]) err("evals-shape", '"skill" must be the skill name');
  else if (skillName && raw["skill"] !== skillName) warn("evals-skill-name", `"skill" is "${raw["skill"]}" but the skill is "${skillName}"`);
  const cases = raw["cases"];
  if (!Array.isArray(cases)) {
    err("evals-shape", '"cases" must be a list');
    return issues;
  }
  const ids = new Set<string>();
  cases.forEach((c, i) => {
    const where = `cases[${i}]`;
    if (!isRecord(c)) return err("evals-case", `${where} must be an object`);
    const id = c["id"];
    if (typeof id !== "string" || !id.trim()) err("evals-case", `${where} needs an "id" string`);
    else if (ids.has(id)) err("evals-duplicate-id", `case id "${id}" is used more than once`);
    else ids.add(id);
    if (typeof c["input"] !== "string" || !c["input"].trim()) err("evals-case", `${where} needs an "input" string`);
    const checks = c["checks"];
    if (!Array.isArray(checks) || checks.length === 0) err("evals-case", `${where} needs at least one check`);
    else
      checks.forEach((ch, k) => {
        const problem = checkIssue(ch, `${where}.checks[${k}]`);
        if (problem) err("evals-check", problem);
      });
    const weight = c["weight"];
    if (weight !== undefined && !(typeof weight === "number" && Number.isFinite(weight) && weight > 0))
      err("evals-case", `${where}.weight must be a positive number`);
    const ws = c["workspace"];
    if (ws !== undefined && !(isRecord(ws) && Object.values(ws).every((v) => typeof v === "string")))
      err("evals-case", `${where}.workspace must map file paths to text`);
    const db = c["db"];
    if (db !== undefined && !(isRecord(db) && Object.values(db).every((rows) => Array.isArray(rows) && rows.every(isRecord))))
      err("evals-case", `${where}.db must map table names to lists of rows`);
  });
  if (cases.length < EVAL_CASES_EXPECTED)
    warn("evals-count", `${cases.length} eval case${cases.length === 1 ? "" : "s"}; gate 5 runs ${EVAL_CASES_EXPECTED}`);
  return issues;
}

function lineOf(text: string, needle: string): number | undefined {
  const i = text.indexOf(needle);
  return i === -1 ? undefined : text.slice(0, i).split("\n").length;
}

function escapes(rel: string): boolean {
  const n = posix.normalize(rel);
  return n === ".." || n.startsWith("../") || posix.isAbsolute(rel);
}

/** Lint a loaded skill folder. */
export function lintSkill(skill: LoadedSkill): LintReport {
  const issues: SkillIssue[] = [];
  const add = (severity: SkillIssue["severity"], rule: string, message: string, file?: string, line?: number) => {
    const i: SkillIssue = { severity, rule, message };
    if (file !== undefined) i.file = file;
    if (line !== undefined) i.line = line;
    issues.push(i);
  };
  let name = skill.dirName;
  const skillMd = fileEntry(skill, SKILL_FILE);
  const permEntry = fileEntry(skill, SKILL_PERMISSIONS_FILE);
  const permText = permEntry ? textOf(permEntry.bytes) : undefined;
  if (!skillMd) {
    add("error", "skill-md-missing", "the skill has no SKILL.md", SKILL_FILE);
    return { skill: name, ok: false, issues };
  }
  const mdText = textOf(skillMd.bytes).replace(/\r\n/g, "\n");
  const built = buildManifest({ dir: skill.dir, dirName: skill.dirName, skillMd: mdText, permissionsJson: permText, files: filePaths(skill) });
  issues.push(...built.issues);
  let parsed: ReturnType<typeof parseSkillMd> | undefined;
  try {
    parsed = parseSkillMd(mdText);
  } catch {
    /* reported by buildManifest as "parse" */
  }
  if (parsed) {
    const fmName = parsed.frontmatter["name"];
    if (typeof fmName === "string" && fmName) name = fmName;
    const desc = parsed.frontmatter["description"];
    if (typeof desc === "string" && desc.trim()) issues.push(...lintDescription(desc));
    const version = built.manifest?.frontmatter.metadata?.["version"];
    if (version !== undefined && !isSemver(version))
      add("warning", "version-format", `metadata.version "${version}" is not semver; the install version will be 0.0.0+<hash>`, SKILL_FILE);

    // Body length.
    const bodyLines = parsed.body.replace(/\n$/, "").split("\n").length;
    if (bodyLines > SKILL_MAX_LINES)
      add("error", "body-length", `SKILL.md body is ${bodyLines} lines; keep it under ${SKILL_MAX_LINES} and move detail into linked files`, SKILL_FILE, parsed.bodyStartLine + SKILL_MAX_LINES);

    // Links: exist, stay inside, and are direct.
    const direct = extractLinks(parsed.body);
    const directSet = new Set(direct.map((l) => posix.normalize(l)));
    for (const link of direct) {
      const line = lineOf(mdText, `](${link}`) ?? lineOf(mdText, link);
      const target = posix.normalize(link);
      if (escapes(link)) {
        add("error", "link-escape", `link "${link}" points outside the skill folder`, SKILL_FILE, line);
        continue;
      }
      const entry = skill.entries.find((e) => e.path === target);
      if (entry?.kind === "symlink" && entry.resolved === undefined) {
        add("error", "link-escape", `link "${link}" is a symlink that points outside the skill folder`, SKILL_FILE, line);
        continue;
      }
      const file = fileEntry(skill, target);
      if (!file && !isDirPath(skill, target)) {
        add("error", "link-missing", `linked file "${link}" does not exist`, SKILL_FILE, line);
        continue;
      }
      if (!file || !/\.(?:md|markdown|mdx)$/i.test(target)) continue;
      const sub = textOf(file.bytes);
      for (const next of extractLinks(sub)) {
        const nextLine = lineOf(sub, `](${next}`) ?? lineOf(sub, next);
        const resolved = posix.normalize(posix.join(posix.dirname(target), next));
        if (escapes(resolved)) {
          add("error", "link-escape", `link "${next}" points outside the skill folder`, target, nextLine);
          continue;
        }
        if (resolved === SKILL_FILE || directSet.has(resolved)) continue;
        if (fileEntry(skill, resolved) || isDirPath(skill, resolved))
          add("warning", "chained-link", `"${target}" links to "${resolved}": chained link; link it from SKILL.md directly`, target, nextLine);
        else add("warning", "link-missing", `linked file "${next}" does not exist`, target, nextLine);
      }
    }
  }

  // oneseat.json details beyond the contract parser.
  if (permText !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(permText);
    } catch {
      raw = undefined; // reported by parsePermissionsFile
    }
    if (isRecord(raw)) {
      for (const k of Object.keys(raw))
        if (!KNOWN_PERMISSION_KEYS.has(k)) add("warning", "permissions-unknown-key", `unknown key "${k}" in oneseat.json`, SKILL_PERMISSIONS_FILE);
      const m = built.manifest;
      const perms = m?.permissions;
      const reasons = m?.reasons ?? {};
      if (perms) {
        for (const host of perms.net) {
          if (!HOST_FORMAT.test(host))
            add("error", "net-host-format", `network entry "${host}" must be a hostname (optionally host:port or *.domain), not a URL`, SKILL_PERMISSIONS_FILE);
          const reason = reasons[host];
          if (reason !== undefined && reason.trim().length === 0)
            add("error", "net-reason", `network host "${host}" has an empty reason`, SKILL_PERMISSIONS_FILE);
          else if (reason !== undefined && words(reason) < 3)
            add("warning", "net-reason-short", `the reason for "${host}" is very short; say what the skill uses it for`, SKILL_PERMISSIONS_FILE);
        }
        for (const host of Object.keys(reasons))
          if (!perms.net.includes(host)) add("warning", "reason-unused", `reason given for "${host}", which is not in permissions.net`, SKILL_PERMISSIONS_FILE);
        for (const env of perms.env)
          if (isSecretName(env)) add("error", "env-secret", `"${env}" looks like a secret; keys never reach skills`, SKILL_PERMISSIONS_FILE);
      }
      if (m) {
        for (const [key, s] of Object.entries(m.scripts)) {
          const p = s.file.replace(/^\.\//, "");
          if (escapes(p)) add("error", "script-escape", `script "${key}" (${s.file}) is outside the skill folder`, SKILL_PERMISSIONS_FILE);
          else if (!fileEntry(skill, posix.normalize(p))) add("error", "script-missing", `script "${key}" points to ${s.file}, which does not exist`, SKILL_PERMISSIONS_FILE);
          else if (!DENO_SCRIPT.test(p))
            add("warning", "script-runtime", `script "${key}" (${s.file}) is not a TypeScript/JavaScript file; the sandbox runs scripts with Deno`, SKILL_PERMISSIONS_FILE);
          if (!s.description.trim()) add("error", "script-description", `script "${key}" needs a description`, SKILL_PERMISSIONS_FILE);
        }
      }
    }
  }

  for (const e of skill.entries)
    if (e.kind === "file" && e.bytes.length > LARGE_FILE_BYTES)
      add("warning", "file-size", `${e.path} is ${(e.bytes.length / 1024 / 1024).toFixed(1)} MB; keep skill files under 1 MB`, e.path);

  const evals = fileEntry(skill, EVALS_FILE);
  if (evals) issues.push(...lintEvalSuite(textOf(evals.bytes), name));

  return { skill: name, ok: !issues.some((i) => i.severity === "error"), issues };
}
