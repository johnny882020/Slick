// Bundle the daemon into one CommonJS file (Node SEA needs a single CJS script).
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "dist-bundle", "daemon.cjs");
mkdirSync(dirname(out), { recursive: true });

await build({
  entryPoints: [join(here, "..", "src", "main.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: out,
  conditions: ["@oneseat/source"],
  // node:sqlite and other built-ins stay external automatically.
  legalComments: "none",
  sourcemap: false,
  // import.meta.url has no meaning in a CJS bundle; main.ts guards on it.
  define: { "import.meta.url": "__oneseat_import_meta_url" },
  banner: { js: 'const __oneseat_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: "info",
});
console.log(`bundled -> ${out}`);
