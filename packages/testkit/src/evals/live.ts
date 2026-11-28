// Live wiring for the eval CLI: build providers from @oneseat/gateway and harnesses from
// @oneseat/harness, both imported at run time.

import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { PROVIDER_IDS, type HarnessApi, type ModelProvider, type ProviderConfig, type ProviderFactory, type ProviderId, type SkillStore } from "@oneseat/contracts";
import { importWorkspacePackage, WorkspaceImportError } from "../workspace.js";
import type { EvalHarnessContext, EvalHarnessFactory } from "./runner.js";

/** Env var holding each provider's key. */
export const PROVIDER_KEY_ENV: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  local: "ONESEAT_LOCAL_API_KEY",
};

export interface ProviderModel {
  provider: ProviderId;
  model: string;
}

/** Parse "anthropic:claude-sonnet-5-5,openai:gpt-x". Splits at the first colon, so local models may contain colons. */
export function parseProviderList(text: string): ProviderModel[] {
  const out: ProviderModel[] = [];
  for (const raw of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const at = raw.indexOf(":");
    if (at <= 0) throw new Error(`provider "${raw}" must be <provider>:<model>, e.g. anthropic:claude-sonnet-5-5`);
    const provider = raw.slice(0, at) as ProviderId;
    const model = raw.slice(at + 1).trim();
    if (!PROVIDER_IDS.includes(provider)) throw new Error(`unknown provider "${provider}"; use one of ${PROVIDER_IDS.join(", ")}`);
    if (!model) throw new Error(`provider "${provider}" needs a model id after the colon`);
    out.push({ provider, model });
  }
  return out;
}

export interface ResolvedKeys {
  available: (ProviderModel & { apiKey: string; baseUrl?: string })[];
  /** Providers skipped for lack of a key, with the env var that was empty. */
  skipped: (ProviderModel & { env: string })[];
}

/** Match providers to keys in env. A provider whose key is empty is skipped, not failed. */
export function resolveProviderKeys(list: readonly ProviderModel[], env: Record<string, string | undefined>): ResolvedKeys {
  const available: ResolvedKeys["available"] = [];
  const skipped: ResolvedKeys["skipped"] = [];
  for (const p of list) {
    if (p.provider === "local") {
      const baseUrl = env["ONESEAT_LOCAL_BASE_URL"]?.trim();
      if (!baseUrl) skipped.push({ ...p, env: "ONESEAT_LOCAL_BASE_URL" });
      else available.push({ ...p, apiKey: env["ONESEAT_LOCAL_API_KEY"]?.trim() || "local", baseUrl });
      continue;
    }
    const name = PROVIDER_KEY_ENV[p.provider];
    const key = env[name]?.trim();
    if (key) available.push({ ...p, apiKey: key });
    else skipped.push({ ...p, env: name });
  }
  return { available, skipped };
}

const FACTORY_NAMES: Record<ProviderId, string[]> = {
  anthropic: ["createAnthropicProvider", "anthropicProvider", "anthropic"],
  openai: ["createOpenAIProvider", "createOpenAiProvider", "createOpenaiProvider", "openaiProvider", "openai"],
  google: ["createGoogleProvider", "createGeminiProvider", "googleProvider", "geminiProvider", "google", "gemini"],
  local: ["createLocalProvider", "createOpenAICompatibleProvider", "localProvider", "local"],
};

/**
 * Find a ProviderFactory in a gateway module. Accepted shapes, in order:
 * createProvider(id, config); providers[id] / factories[id]; createAnthropicProvider etc.
 */
export function pickProviderFactory(mod: Record<string, unknown>, id: ProviderId): ProviderFactory {
  const cp = mod["createProvider"];
  if (typeof cp === "function") return (config: ProviderConfig) => (cp as (id: ProviderId, c: ProviderConfig) => ModelProvider)(id, config);
  for (const key of ["providers", "factories", "PROVIDER_FACTORIES"]) {
    const table = mod[key] as Record<string, unknown> | undefined;
    if (table && typeof table === "object" && typeof table[id] === "function") return table[id] as ProviderFactory;
  }
  for (const n of FACTORY_NAMES[id]) if (typeof mod[n] === "function") return mod[n] as ProviderFactory;
  throw new Error(
    `@oneseat/gateway exports no factory for "${id}". Export createProvider(id, config) or ${FACTORY_NAMES[id][0]}(config). Found: ${Object.keys(mod).sort().join(", ") || "nothing"}`,
  );
}

/** Build live providers through @oneseat/gateway. */
export async function loadLiveProviders(available: ResolvedKeys["available"], root: string, importer?: (s: string) => Promise<unknown>): Promise<{ provider: ModelProvider; model: string; name: string }[]> {
  let mod: Record<string, unknown>;
  try {
    mod = await importWorkspacePackage("@oneseat/gateway", root, importer);
  } catch (e) {
    if (e instanceof WorkspaceImportError) throw e;
    throw new WorkspaceImportError(`cannot import @oneseat/gateway: ${(e as Error).message}`);
  }
  const names = new Map<string, number>();
  for (const a of available) names.set(a.provider, (names.get(a.provider) ?? 0) + 1);
  return available.map((a) => {
    const factory = pickProviderFactory(mod, a.provider);
    const provider = factory({ apiKey: a.apiKey, ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}) });
    return { provider, model: a.model, name: (names.get(a.provider) ?? 0) > 1 ? `${a.provider}:${a.model}` : a.provider };
  });
}

/** Options passed to @oneseat/harness createHarness() by the default eval adapter. */
export interface EvalHarnessCreateOptions {
  provider: ModelProvider;
  providers: Partial<Record<ProviderId, ModelProvider>>;
  store: SkillStore;
  dataDir: string;
  dbPath: string;
  workspaceDir: string;
}

/**
 * Build the harness factory for live evals. Uses, in order: a module given by --harness-module
 * exporting createEvalHarness(ctx, store); @oneseat/harness createEvalHarness(ctx, store);
 * @oneseat/harness createHarness(EvalHarnessCreateOptions).
 */
export async function loadHarnessFactory(opts: { root: string; store: SkillStore; harnessModule?: string; importer?: (s: string) => Promise<unknown> }): Promise<EvalHarnessFactory> {
  let mod: Record<string, unknown>;
  if (opts.harnessModule) {
    const p = isAbsolute(opts.harnessModule) ? opts.harnessModule : resolve(opts.root, opts.harnessModule);
    mod = (await (opts.importer ?? ((s: string) => import(s)))(pathToFileURL(p).href)) as Record<string, unknown>;
  } else mod = await importWorkspacePackage("@oneseat/harness", opts.root, opts.importer);
  const ceh = mod["createEvalHarness"];
  if (typeof ceh === "function") return (ctx: EvalHarnessContext) => (ceh as (c: EvalHarnessContext, s: SkillStore) => HarnessApi | Promise<HarnessApi>)(ctx, opts.store);
  const ch = mod["createHarness"];
  if (typeof ch === "function")
    return (ctx: EvalHarnessContext) =>
      (ch as (o: EvalHarnessCreateOptions) => HarnessApi | Promise<HarnessApi>)({
        provider: ctx.provider,
        providers: { [ctx.provider.id]: ctx.provider },
        store: opts.store,
        dataDir: ctx.dataDir,
        dbPath: ctx.dbPath,
        workspaceDir: ctx.workspaceDir,
      });
  throw new Error(`${opts.harnessModule ?? "@oneseat/harness"} exports neither createEvalHarness(ctx, store) nor createHarness(options). Found: ${Object.keys(mod).sort().join(", ") || "nothing"}`);
}
