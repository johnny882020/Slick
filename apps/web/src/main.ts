// Entry point: node apps/web/dist/main.js (Render), or pnpm --filter @oneseat/web dev.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSite } from "./load.js";
import { createWebServer } from "./server.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const rulesDir = process.env["RULES_DIR"] ?? resolve(root, "rules");
const examplesDir = process.env["EXAMPLES_DIR"] ?? resolve(root, "examples/audit");
const port = Number(process.env["PORT"] ?? 3000);

const site = await loadSite(rulesDir, examplesDir, new Date().toISOString().slice(0, 10));
const server = createWebServer({ ...site, version: process.env["RENDER_GIT_COMMIT"]?.slice(0, 7) ?? "dev" });
server.listen(port, () => console.log(`oblige-web listening on ${port} with ${site.packs.length} rule packs`));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
