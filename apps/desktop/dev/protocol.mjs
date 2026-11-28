// Shared by dev/bridge.mjs and tests: the UI allowlist and the pinned-app CSP.
// The allowlist mirrors src/protocol.ts and src-tauri/src/allowlist.rs (tests keep them equal).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const UI_METHODS = [
  "daemon.hello",
  "auth.clear",
  "auth.status",
  "models.list",
  "harness.run",
  "harness.cancel",
  "harness.approve",
  "harness.answer",
  "skills.list",
  "skills.inspect",
  "skills.install",
  "skills.remove",
  "skills.search",
  "skills.restorable",
  "skills.restore",
  "apps.pin",
  "apps.list",
  "apps.unpin",
  "schedules.list",
  "schedules.upsert",
  "schedules.remove",
  "actions.log",
  "apps.draft",
  "apps.drafts",
  "mcp.status",
  "license.status",
  "license.activate",
  "license.deactivate",
  "license.trial",
  "feedback.send",
];

export const SHELL_ONLY_METHODS = ["auth.set", "apps.run"];

export const PROVIDERS = ["anthropic", "openai", "google", "local"];

export const SHELL_ERRORS = { daemonUnavailable: -32010, timeout: -32011, forbidden: -32012, keychain: -32013 };

/**
 * PINNED_APP_CSP, read from packages/contracts/src/artifact.ts (the single source).
 * Evaluates the `[ "...", ... ].join("; ")` literal without executing TypeScript.
 */
export function readPinnedCsp(file = join(here, "..", "..", "..", "packages", "contracts", "src", "artifact.ts")) {
  const src = readFileSync(file, "utf8");
  const m = src.match(/export const PINNED_APP_CSP = \[([\s\S]*?)\]\.join\(\s*"([^"]*)"\s*\)/);
  if (!m) throw new Error(`PINNED_APP_CSP not found in ${file}`);
  const parts = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  return parts.join(m[2]);
}

/** The initialization script pinned windows get (same file the Rust core embeds). */
export function readPinnedInitScript() {
  return readFileSync(join(here, "..", "src-tauri", "src", "pinned_init.js"), "utf8");
}

export const APP_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
