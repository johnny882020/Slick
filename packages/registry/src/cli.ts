// oneseat-skills: lint, scan, install and manage skills from the command line.
// Exit codes: 0 ok, 1 a gate failed (lint errors, a block verdict, a refused
// install, a failed verify, nothing to remove), 2 usage or source errors.

import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseSkillSource, type LintReport, type ScanReport, type SkillSource } from "@oneseat/contracts";
import { RegistryError } from "./errors.js";
import { discoverSkillDirs } from "./files.js";
import { checkDir, inspectSource } from "./inspect.js";
import { createSkillStore } from "./store.js";
import type { FetchLike } from "./sources.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
}

const USAGE = `oneseat-skills <command> [options]

Commands:
  lint <path...>                 Lint skill folders (gate 3). A path may hold many skills.
  scan <source>                  Fetch and security-scan a source (gate 4).
  check <dir...>                 Lint and scan every skill in each folder (missing folder: nothing to do).
  install <source>               Fetch, scan, lint and install a skill.
  list                           List installed skills.
  verify [name]                  Re-hash and check the signature of one (or every) installed skill.
  remove <name>                  Remove an installed skill.

Sources: a local folder, owner/repo, owner/repo@skill (skills.sh), or a GitHub URL
(https://github.com/owner/repo/tree/<ref>/<path>).

Options:
  --json                         Print JSON.
  --allow-warnings               install: accept warnings (never blocks).
  --data-dir <dir>               Where skills are installed (default: $ONESEAT_DATA_DIR or ~/.oneseat).
  -h, --help                     Show this help.
`;

interface Args {
  command?: string;
  positional: string[];
  json: boolean;
  allowWarnings: boolean;
  dataDir?: string;
  help: boolean;
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], json: false, allowWarnings: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--json") args.json = true;
    else if (a === "--allow-warnings") args.allowWarnings = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--data-dir") {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError("--data-dir needs a folder");
      args.dataDir = v;
      i += 1;
    } else if (a.startsWith("--data-dir=")) args.dataDir = a.slice("--data-dir=".length);
    else if (a.startsWith("-") && a !== "-") throw new UsageError(`unknown option ${a}`);
    else if (args.command === undefined) args.command = a;
    else args.positional.push(a);
  }
  return args;
}

function expandHome(p: string, env: Record<string, string | undefined>): string {
  if (p === "~" || p.startsWith("~/")) return join(env["HOME"] ?? homedir(), p.slice(1));
  return p;
}

/** A local path when it exists or looks like one; otherwise skills.sh / GitHub syntax. */
export async function resolveSourceArg(arg: string, cwd: string, env: Record<string, string | undefined> = {}): Promise<SkillSource> {
  const expanded = expandHome(arg, env);
  const local = resolve(cwd, expanded);
  const looksLocal = /^(?:\.{1,2}(?:[\\/]|$)|[\\/]|~|[A-Za-z]:[\\/])/.test(arg);
  if (looksLocal || (await lstat(local).catch(() => undefined))) return { kind: "local", path: local };
  const parsed = parseSkillSource(arg);
  return parsed.kind === "local" ? { kind: "local", path: local } : parsed;
}

function loc(file: string | undefined, line: number | undefined): string {
  if (!file) return "";
  return line ? `${file}:${line}` : file;
}

export function formatLint(r: LintReport): string {
  const errors = r.issues.filter((i) => i.severity === "error").length;
  const warnings = r.issues.length - errors;
  const head = `${r.skill}  lint ${r.ok ? "ok" : "FAILED"}${errors || warnings ? ` (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})` : ""}`;
  const lines = r.issues.map((i) => `  ${i.severity.padEnd(7)}  ${loc(i.file, i.line).padEnd(24)}  ${i.rule}: ${i.message}`);
  return [head, ...lines].join("\n");
}

export function formatScan(r: ScanReport, verbose = false): string {
  const shown = r.findings.filter((f) => verbose || f.severity !== "info");
  const hidden = r.findings.length - shown.length;
  const head = `${r.skill}  scan ${r.verdict.toUpperCase()}  (${r.filesRead} files, ${r.bytesRead} bytes read)`;
  const lines = shown.map((f) => `  ${f.severity.padEnd(5)}  ${loc(f.file, f.line).padEnd(24)}  ${f.rule}: ${f.message}`);
  if (hidden) lines.push(`  (${hidden} info finding${hidden === 1 ? "" : "s"} not shown; use --json for all)`);
  return [head, `  ${r.summary.replace(/\n\n/g, "\n  ")}`, ...lines].join("\n");
}

export async function main(argv: string[], partial: Partial<CliIo> = {}): Promise<number> {
  const io: CliIo = {
    stdout: partial.stdout ?? ((t) => process.stdout.write(`${t}\n`)),
    stderr: partial.stderr ?? ((t) => process.stderr.write(`${t}\n`)),
    cwd: partial.cwd ?? process.cwd(),
    env: partial.env ?? process.env,
    ...(partial.fetch ? { fetch: partial.fetch } : {}),
  };
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.stderr(`error: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help || !args.command || args.command === "help") {
    io.stdout(USAGE);
    return args.command || args.help ? 0 : 2;
  }
  const out = (value: unknown, text: string) => io.stdout(args.json ? JSON.stringify(value, null, 2) : text);
  const dataDir = resolve(io.cwd, expandHome(args.dataDir ?? io.env["ONESEAT_DATA_DIR"] ?? join(io.env["HOME"] ?? homedir(), ".oneseat"), io.env));
  const store = () => createSkillStore({ dataDir, ...(io.fetch ? { fetch: io.fetch } : {}) });
  const need = (n: number, what: string) => {
    if (args.positional.length < n) throw new UsageError(`${args.command} needs ${what}`);
  };

  try {
    switch (args.command) {
      case "lint": {
        need(1, "at least one path");
        const reports: LintReport[] = [];
        for (const p of args.positional) {
          const abs = resolve(io.cwd, expandHome(p, io.env));
          const dirs = await discoverSkillDirs(abs);
          if (!dirs.length) throw new RegistryError("no-skills", `no SKILL.md found in ${p}`);
          for (const d of dirs) reports.push((await checkDir(d)).lint);
        }
        const ok = reports.every((r) => r.ok);
        out({ ok, results: reports }, reports.map((r) => formatLint(r)).join("\n\n"));
        return ok ? 0 : 1;
      }
      case "scan": {
        need(1, "a source");
        const src = await resolveSourceArg(args.positional[0]!, io.cwd, io.env);
        const outcome = await inspectSource(src, { ...(io.fetch ? { fetch: io.fetch } : {}) });
        const results = outcome.checks.length
          ? outcome.checks.map((c) => ({ scan: c.scan, lint: c.lint }))
          : [{ scan: outcome.scan, lint: outcome.lint }];
        const blocked = results.some((r) => r.scan.verdict === "block");
        out({ ok: !blocked, results }, results.map((r) => formatScan(r.scan)).join("\n\n"));
        return blocked ? 1 : 0;
      }
      case "check": {
        need(1, "at least one folder");
        const results: { scan: ScanReport; lint: LintReport }[] = [];
        const notes: string[] = [];
        for (const p of args.positional) {
          const abs = resolve(io.cwd, expandHome(p, io.env));
          const st = await lstat(abs).catch(() => undefined);
          if (!st?.isDirectory()) {
            notes.push(`no skills folder at ${p}; nothing to check`);
            continue;
          }
          const dirs = await discoverSkillDirs(abs);
          if (!dirs.length) notes.push(`no skills in ${p}; nothing to check`);
          for (const d of dirs) {
            const c = await checkDir(d);
            results.push({ scan: c.scan, lint: c.lint });
          }
        }
        const ok = results.every((r) => r.lint.ok && r.scan.verdict !== "block");
        const text = [
          ...notes,
          ...results.map((r) => `${formatLint(r.lint)}\n${formatScan(r.scan)}`),
          results.length ? `${results.length} skill${results.length === 1 ? "" : "s"} checked: ${ok ? "all passed gates 3 and 4" : "FAILED"}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        out({ ok, notes, results }, text);
        return ok ? 0 : 1;
      }
      case "install": {
        need(1, "a source");
        const src = await resolveSourceArg(args.positional[0]!, io.cwd, io.env);
        const res = await store().install(src, { allowWarnings: args.allowWarnings });
        const text = res.installed
          ? `installed ${res.skills.map((s) => `${s.manifest.frontmatter.name}@${s.version}`).join(", ")}\n${formatScan(res.scan)}`
          : `not installed: ${res.reason}\n\n${formatScan(res.scan)}\n\n${formatLint(res.lint)}`;
        out(res, text);
        return res.installed ? 0 : 1;
      }
      case "list": {
        const skills = await store().list();
        const text = skills.length
          ? skills.map((s) => `${s.manifest.frontmatter.name.padEnd(28)} ${s.version.padEnd(18)} ${sourceText(s.source)}`).join("\n")
          : "no skills installed";
        out(skills, text);
        return 0;
      }
      case "verify": {
        const s = store();
        const names = args.positional.length ? args.positional : (await s.list()).map((x) => x.manifest.frontmatter.name);
        const results = [];
        for (const name of names) results.push({ name, ...(await s.verify(name)) });
        const ok = results.every((r) => r.ok);
        out({ ok, results }, results.length ? results.map((r) => `${r.name}  ${r.ok ? "ok" : `FAILED: ${r.reason}`}`).join("\n") : "no skills installed");
        return ok ? 0 : 1;
      }
      case "remove": {
        need(1, "a skill name");
        const removed = await store().remove(args.positional[0]!);
        out({ ok: removed }, removed ? `removed ${args.positional[0]}` : `${args.positional[0]} is not installed`);
        return removed ? 0 : 1;
      }
      default:
        throw new UsageError(`unknown command "${args.command}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`error: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof RegistryError) {
      if (args.json) io.stdout(JSON.stringify({ ok: false, error: { code: e.code, message: e.message } }, null, 2));
      else io.stderr(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

function sourceText(s: SkillSource): string {
  switch (s.kind) {
    case "local":
      return s.path;
    case "github":
      return `github:${s.owner}/${s.repo}${s.ref ? `@${s.ref}` : ""}${s.path ? `/${s.path}` : ""}`;
    case "skills.sh":
      return `${s.owner}/${s.repo}${s.skill ? `@${s.skill}` : ""}`;
  }
}
