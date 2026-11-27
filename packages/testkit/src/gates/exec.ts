// Run commands for the gates, streaming output while keeping a copy.

import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Echo output to this process as it arrives. Default true. */
  echo?: boolean;
}

export type Exec = (cmd: string, args: readonly string[], opts: ExecOptions) => Promise<ExecResult>;

const MAX_KEEP = 4 * 1024 * 1024;

/** Quote an argument for cmd.exe (used only on Windows, where pnpm is a .cmd shim). */
export function quoteWindowsArg(a: string): string {
  if (a.length > 0 && !/[\s"&|<>^%!()]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** Spawn a command. Never rejects: a spawn failure becomes code 127. */
export const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    const win = process.platform === "win32";
    const echo = opts.echo ?? true;
    let stdout = "";
    let stderr = "";
    const keep = (buf: string, chunk: string) => {
      const next = buf + chunk;
      return next.length > MAX_KEEP ? next.slice(next.length - MAX_KEEP) : next;
    };
    const child = win
      ? spawn([cmd, ...args].map(quoteWindowsArg).join(" "), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, shell: true, windowsHide: true })
      : spawn(cmd, [...args], { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout = keep(stdout, d);
      if (echo) process.stdout.write(d);
    });
    child.stderr?.on("data", (d: string) => {
      stderr = keep(stderr, d);
      if (echo) process.stderr.write(d);
    });
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}\n` }));
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
