#!/usr/bin/env node
// Runs the built CLI (dist/). Build first: pnpm --filter @oneseat/testkit build (or pnpm build).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// node:sqlite (used to seed eval databases) is stable enough for tests; keep its notice out of gate output.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  if (String(warning?.message ?? warning).includes("SQLite is an experimental feature")) return;
  emitWarning(warning, ...rest);
};

const entry = new URL("../dist/evals/cli.js", import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
  process.stderr.write("oneseat-evals: @oneseat/testkit is not built. Run `pnpm build` first.\n");
  process.exit(2);
}
const { evalMain } = await import(entry.href);
process.exitCode = await evalMain(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  cwd: process.env.INIT_CWD || process.cwd(),
});
