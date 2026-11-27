import type { ModelProvider, ProviderConfig, ProviderFactory, ProviderId } from "@oneseat/contracts";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createGoogleProvider } from "./providers/google.js";
import { createLocalProvider } from "./providers/local.js";
import { createOpenAIProvider } from "./providers/openai.js";

export const PROVIDER_FACTORIES: Readonly<Record<ProviderId, ProviderFactory>> = Object.freeze({
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
  google: createGoogleProvider,
  local: createLocalProvider,
});

/** Provider ids whose adapters are still experimental. */
export const EXPERIMENTAL_PROVIDERS: readonly ProviderId[] = ["local"];

export function createProvider(id: ProviderId, config: ProviderConfig): ModelProvider {
  const factory = (PROVIDER_FACTORIES as Partial<Record<string, ProviderFactory>>)[id];
  if (!factory) throw new Error(`unknown provider "${String(id)}"`);
  return factory(config);
}
