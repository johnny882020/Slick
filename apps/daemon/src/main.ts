#!/usr/bin/env node
// OneSeat daemon sidecar. Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout.
// Logs go to stderr only. Env:
//   ONESEAT_HOME            data folder (the shell sets this to the app data dir)
//   ONESEAT_BUNDLED_SKILLS  starter skills folder installed on first run
//   ONESEAT_DEFAULT_MODEL   "provider:model" used by pinned apps, e.g. anthropic:claude-sonnet-5-5
//   ONESEAT_DENO            path to the deno binary for the script sandbox
import { serveStdio } from "@oneseat/harness";

// node:sqlite is stable enough for us; keep its one-time ExperimentalWarning out of the app log.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultDataDir, parseModelRef, startDaemon } from "./index.js";

/** Tauri installs sidecars side by side with the triple stripped: <dir>/deno[.exe]. */
function siblingDeno(): string | undefined {
  const p = join(dirname(process.execPath), process.platform === "win32" ? "deno.exe" : "deno");
  return existsSync(p) ? p : undefined;
}

async function main() {
  const defaultModel = parseModelRef(process.env.ONESEAT_DEFAULT_MODEL);
  const { daemon, dataDir, seeded } = await startDaemon({
    dataDir: defaultDataDir(),
    ...(process.env.ONESEAT_BUNDLED_SKILLS ? { bundledSkillsDir: process.env.ONESEAT_BUNDLED_SKILLS } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(process.env.ONESEAT_CLOUD_URL ? { cloudUrl: process.env.ONESEAT_CLOUD_URL } : {}),
    // Absolute: the sandbox starts deno from the skill's folder, not from our working folder.
    ...((process.env.ONESEAT_DENO || siblingDeno()) ? { denoPath: resolve((process.env.ONESEAT_DENO || siblingDeno())!) } : {}),
  });
  process.stderr.write(`oneseat-daemon ready (data: ${dataDir}${seeded.length ? `, seeded: ${seeded.join(", ")}` : ""})\n`);
  serveStdio(daemon);
  const stop = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  process.stderr.write(`oneseat-daemon failed to start: ${(e as Error).message}\n`);
  process.exit(1);
});
