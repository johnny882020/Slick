// Script sandbox: skill scripts run under Deno, deny by default, with exactly the
// permissions the skill declares in oneseat.json.
//
//   read   skill folder (always, read-only) + declared read paths
//   write  declared write paths, which must be under $WORKSPACE
//   net    declared hosts; remote imports only from those hosts (--allow-import),
//          otherwise --no-remote. npm: specifiers are off unless registry.npmjs.org is declared.
//   env    declared variable names; the child environment is cleared to just those
//   run    declared executables
// Always: --no-prompt, --no-config, --no-lock, a timeout, an output cap, cwd = skill folder.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillManifest } from "@oneseat/contracts";

export class SandboxError extends Error {
  override name = "SandboxError";
}

export interface SandboxRoots {
  skill: string;
  workspace: string;
}

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUN_RE = /^[A-Za-z0-9._-]+$/;
const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

function exeName(): string {
  return platform() === "win32" ? "deno.exe" : "deno";
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Find a Deno binary: $ONESEAT_DENO, then PATH, then the `deno` npm package in a
 * node_modules folder above `from` (its native binary, not the Node shim, so a
 * timeout kill reaches the real process).
 */
export function findDeno(opts: { env?: NodeJS.ProcessEnv; from?: string[] } = {}): string | undefined {
  const env = opts.env ?? process.env;
  const explicit = env["ONESEAT_DENO"];
  if (explicit) return isFile(explicit) ? explicit : undefined;
  for (const dir of (env["PATH"] ?? env["Path"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, exeName());
    if (isFile(p) && !p.includes(`${sep}node_modules${sep}.bin${sep}`)) return p;
  }
  const starts = opts.from ?? [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let dir = resolve(start);
    for (;;) {
      const found = denoInNodeModules(join(dir, "node_modules"));
      if (found) return found;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

function denoInNodeModules(nm: string): string | undefined {
  const pkgDir = join(nm, "deno");
  if (!existsSync(join(pkgDir, "package.json"))) return undefined;
  const direct = join(pkgDir, exeName());
  if (isFile(direct)) return direct;
  const os = platform();
  const target = os === "linux" ? `linux-${arch()}-glibc` : `${os}-${arch()}`;
  try {
    const req = createRequire(join(pkgDir, "package.json"));
    const p = join(dirname(req.resolve(`@deno/${target}/package.json`)), exeName());
    if (isFile(p)) return p;
  } catch {
    /* platform package not installed */
  }
  const shim = join(nm, ".bin", os === "win32" ? "deno.cmd" : "deno");
  return isFile(shim) ? shim : undefined;
}

/**
 * Resolve a declared permission path. Relative paths and "$SKILL/..." are under the
 * skill folder; "$WORKSPACE/..." is under the workspace. Absolute paths, other roots
 * and ".." segments are refused.
 */
export function resolvePermissionPath(raw: string, roots: SandboxRoots, kind: "read" | "write"): string {
  const p = raw.trim();
  if (!p || p.includes("\0")) throw new SandboxError(`empty or invalid ${kind} path`);
  let root: string;
  let rest: string;
  const m = p.match(/^\$([A-Za-z_]+)(.*)$/);
  if (m) {
    const name = m[1]!.toUpperCase();
    if (name === "WORKSPACE") root = roots.workspace;
    else if (name === "SKILL") root = roots.skill;
    else throw new SandboxError(`unknown root "$${m[1]}" in ${kind} path "${raw}" (use $WORKSPACE or $SKILL)`);
    rest = m[2]!;
    if (rest && !/^[/\\]/.test(rest)) throw new SandboxError(`invalid ${kind} path "${raw}"`);
  } else {
    if (isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith("\\") || p.startsWith("~"))
      throw new SandboxError(`${kind} path "${raw}" must be relative to the skill or start with $WORKSPACE`);
    root = roots.skill;
    rest = p;
  }
  const segs = rest.split(/[/\\]+/).filter((s) => s && s !== ".");
  if (segs.includes("..")) throw new SandboxError(`${kind} path "${raw}" must not contain ".."`);
  const out = segs.length ? join(root, ...segs) : root;
  if (kind === "write" && !(out === roots.workspace || out.startsWith(roots.workspace + sep)))
    throw new SandboxError(`write path "${raw}" must be under $WORKSPACE`);
  return out;
}

export interface SandboxOptions {
  denoPath?: string;
  workspaceDir: string;
  /** DENO_DIR for the module cache. */
  cacheDir: string;
  timeoutMs?: number;
  /** Max characters kept from stdout and from stderr. */
  outputCap?: number;
  memoryMb?: number;
  /** Where declared env vars get their values. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Paths always denied for read and write (e.g. the database file). */
  denyPaths?: string[];
}

export interface ScriptRunRequest {
  manifest: SkillManifest;
  /** Script name as declared in oneseat.json "scripts". */
  script: string;
  args?: string[];
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ScriptRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface DenoInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export class ScriptSandbox {
  readonly denoPath: string | undefined;
  private readonly opts: SandboxOptions;

  constructor(opts: SandboxOptions) {
    this.opts = opts;
    this.denoPath = opts.denoPath ?? findDeno();
  }

  get available(): boolean {
    return this.denoPath !== undefined;
  }

  private roots(manifest: SkillManifest): SandboxRoots {
    if (!manifest.dir) throw new SandboxError(`skill "${manifest.frontmatter.name}" has no folder on disk`);
    mkdirSync(this.opts.workspaceDir, { recursive: true });
    return { skill: realpathSync(manifest.dir), workspace: realpathSync(this.opts.workspaceDir) };
  }

  /** Build the exact Deno command line for a script. Throws SandboxError on a bad declaration. */
  plan(req: Pick<ScriptRunRequest, "manifest" | "script" | "args">): DenoInvocation {
    if (!this.denoPath) throw new SandboxError("Deno is not available (set ONESEAT_DENO or install deno)");
    const m = req.manifest;
    const decl = m.scripts[req.script];
    if (!decl)
      throw new SandboxError(
        `skill "${m.frontmatter.name}" declares no script "${req.script}"${Object.keys(m.scripts).length ? ` (scripts: ${Object.keys(m.scripts).join(", ")})` : ""}`,
      );
    const roots = this.roots(m);
    const scriptPath = resolvePermissionPath(decl.file, roots, "read");
    if (!isFile(scriptPath)) throw new SandboxError(`script file "${decl.file}" not found in the skill folder`);
    const realScript = realpathSync(scriptPath);
    if (!realScript.startsWith(roots.skill + sep)) throw new SandboxError(`script "${decl.file}" is outside the skill folder`);

    const p = m.permissions;
    for (const h of p.net) if (!HOST_RE.test(h)) throw new SandboxError(`invalid network host "${h}"`);
    for (const e of p.env) {
      if (!ENV_RE.test(e)) throw new SandboxError(`invalid env name "${e}"`);
      if (SECRET_ENV_RE.test(e)) throw new SandboxError(`env "${e}" looks like a secret; skills may not read secrets`);
    }
    for (const r of p.run) if (!RUN_RE.test(r)) throw new SandboxError(`invalid executable name "${r}"`);
    const read = [roots.skill, ...p.read.map((r) => resolvePermissionPath(r, roots, "read"))];
    const write = p.write.map((w) => resolvePermissionPath(w, roots, "write"));

    const uniq = (xs: string[]) => [...new Set(xs)];
    const args = ["run", "--quiet", "--no-prompt", "--no-config", "--no-lock"];
    if (!p.net.includes("registry.npmjs.org")) args.push("--no-npm");
    if (p.net.length > 0) {
      args.push(`--allow-net=${uniq(p.net).join(",")}`);
      args.push(`--allow-import=${uniq(p.net).join(",")}`);
    } else args.push("--no-remote");
    args.push(`--allow-read=${uniq(read).join(",")}`);
    if (write.length > 0) args.push(`--allow-write=${uniq(write).join(",")}`);
    if (p.env.length > 0) args.push(`--allow-env=${uniq(p.env).join(",")}`);
    if (p.run.length > 0) args.push(`--allow-run=${uniq(p.run).join(",")}`);
    const deny = (this.opts.denyPaths ?? []).filter(Boolean);
    if (deny.length > 0) {
      args.push(`--deny-read=${deny.join(",")}`);
      args.push(`--deny-write=${deny.join(",")}`);
    }
    args.push("--deny-ffi");
    args.push(`--v8-flags=--max-old-space-size=${this.opts.memoryMb ?? 512}`);
    args.push(realScript, ...(req.args ?? []));

    mkdirSync(this.opts.cacheDir, { recursive: true });
    const env: Record<string, string> = { DENO_DIR: this.opts.cacheDir, NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1" };
    if (platform() === "win32" && process.env["SystemRoot"]) env["SystemRoot"] = process.env["SystemRoot"];
    const source = this.opts.env ?? process.env;
    for (const name of p.env) {
      const v = source[name];
      if (v !== undefined) env[name] = v;
    }
    if (p.run.length > 0 && source["PATH"]) env["PATH"] = source["PATH"];
    return { command: this.denoPath, args, cwd: roots.skill, env };
  }

  async run(req: ScriptRunRequest): Promise<ScriptRunResult> {
    const inv = this.plan(req);
    const timeoutMs = req.timeoutMs ?? this.opts.timeoutMs ?? 60_000;
    const cap = this.opts.outputCap ?? 64 * 1024;
    const started = Date.now();
    const posix = platform() !== "win32";
    return await new Promise<ScriptRunResult>((resolvePromise, reject) => {
      const child = spawn(inv.command, inv.args, {
        cwd: inv.cwd,
        env: inv.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: posix,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let aborted = false;
      let total = 0;
      const kill = () => {
        try {
          if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      };
      const take = (which: "out" | "err", chunk: Buffer) => {
        const s = chunk.toString("utf8");
        total += s.length;
        const current = which === "out" ? stdout : stderr;
        let next = current + s;
        if (next.length > cap) {
          truncated = true;
          next = next.slice(0, cap);
        }
        if (which === "out") stdout = next;
        else stderr = next;
        // A runaway writer is stopped well before it can exhaust memory.
        if (total > 8 * cap) kill();
      };
      child.stdout.on("data", (c: Buffer) => take("out", c));
      child.stderr.on("data", (c: Buffer) => take("err", c));
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = () => {
        aborted = true;
        kill();
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      if (req.signal?.aborted) onAbort();
      child.on("error", (e) => {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        reject(new SandboxError(`could not start Deno: ${e.message}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        resolvePromise({
          exitCode: code,
          signal,
          stdout,
          stderr,
          timedOut,
          truncated,
          aborted,
          durationMs: Date.now() - started,
        });
      });
      child.stdin.on("error", () => {
        /* script closed stdin early */
      });
      child.stdin.end(req.stdin ?? "");
    });
  }
}
