// Wires gateway + registry + harness into one daemon.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PROVIDER_IDS, type ProviderId } from "@oneseat/contracts";
import { PROVIDER_FACTORIES } from "@oneseat/gateway";
import { createDaemon, LicenseManager, seedStarterSkills, type Daemon, type DaemonOptions } from "@oneseat/harness";
import { DEFAULT_CLOUD_URL, ONESEAT_LICENSE_PUBLIC_KEY } from "./license-key.js";
import { createSkillStore, searchSkillsSh, type FetchLike, type RegistrySkillStore } from "@oneseat/registry";

export interface StartOptions {
  dataDir?: string;
  /**
   * Folder of starter skills shipped with the app. Each start installs the ones that are not
   * installed, except the ones the person removed (skills.restore puts those back).
   */
  bundledSkillsDir?: string;
  /** fetch for skills.sh search (tests). Default globalThis.fetch. */
  fetch?: FetchLike;
  defaultModel?: { provider: ProviderId; model: string };
  denoPath?: string;
  log?: (line: string) => void;
  harness?: DaemonOptions["harness"];
  startScheduler?: boolean;
  /** OneSeat Cloud for licenses and feedback. Default DEFAULT_CLOUD_URL. */
  cloudUrl?: string;
  /** Turn plan gates off (tests that predate plans). Default on. */
  plans?: boolean;
  /** MCP connectors file (Pro and Team). Default `<dataDir>/mcp.json`; a missing file means none. */
  mcpConfigPath?: string;
}

export interface StartedDaemon {
  daemon: Daemon;
  store: RegistrySkillStore;
  dataDir: string;
  /** Skills installed from the bundle during this start. */
  seeded: string[];
}

/** Platform data folder, used when ONESEAT_HOME is not set. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.ONESEAT_HOME) return resolve(env.ONESEAT_HOME);
  if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "app.oneseat");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "app.oneseat");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "app.oneseat");
}

/** "anthropic:claude-sonnet-5-5" -> { provider, model }. */
export function parseModelRef(ref: string | undefined): { provider: ProviderId; model: string } | undefined {
  if (!ref) return undefined;
  const i = ref.indexOf(":");
  if (i <= 0) return undefined;
  const provider = ref.slice(0, i) as ProviderId;
  const model = ref.slice(i + 1);
  if (!PROVIDER_IDS.includes(provider) || !model) return undefined;
  return { provider, model };
}

export const DEFAULT_MODEL = { provider: "anthropic" as const, model: "claude-sonnet-5-5" };

/**
 * Install every bundled skill that is not installed yet and that the person did not remove
 * (removed starter skills are kept in <dataDir>/removed-starters.json). A bundled skill still
 * goes through scan + lint like any other source; a failure is logged, not fatal.
 */
export async function seedBundledSkills(store: RegistrySkillStore, dir: string, log: (l: string) => void): Promise<string[]> {
  return seedStarterSkills(store, dir, store.dataDir, log);
}

export async function startDaemon(opts: StartOptions = {}): Promise<StartedDaemon> {
  const dataDir = resolve(opts.dataDir ?? defaultDataDir());
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const store = createSkillStore({ dataDir });
  const seeded = opts.bundledSkillsDir ? await seedBundledSkills(store, opts.bundledSkillsDir, log) : [];
  const license =
    opts.plans === false ? undefined : new LicenseManager({ dataDir, publicKeyPem: ONESEAT_LICENSE_PUBLIC_KEY, cloudUrl: opts.cloudUrl ?? DEFAULT_CLOUD_URL, log });
  const daemon = createDaemon({
    ...(license ? { license } : {}),
    store,
    providers: PROVIDER_FACTORIES,
    dataDir,
    ...(opts.bundledSkillsDir ? { bundledSkillsDir: resolve(opts.bundledSkillsDir) } : {}),
    searchSkills: (query) => searchSkillsSh(query, opts.fetch ? { fetch: opts.fetch } : {}),
    // Without this the daemon never loaded connectors, so Pro/Team's MCP connectors did nothing.
    mcpConfigPath: opts.mcpConfigPath ?? join(dataDir, "mcp.json"),
    defaultModel: opts.defaultModel ?? DEFAULT_MODEL,
    log,
    ...(opts.denoPath ? { denoPath: opts.denoPath } : {}),
    ...(opts.harness ? { harness: opts.harness } : {}),
    ...(opts.startScheduler !== undefined ? { startScheduler: opts.startScheduler } : {}),
  });
  await daemon.ready;
  return { daemon, store, dataDir, seeded };
}
