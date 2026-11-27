// @oneseat/gateway — ModelProvider adapters.

export { parseSSE, type SSEMessage, type ParseSSEOptions, type ByteSource } from "./sse.js";
export {
  redact,
  redactHeaders,
  REDACTED,
  SECRET_HEADERS,
  providerError,
  kindForStatus,
  parseRetryAfter,
  isRetryableKind,
} from "./errors.js";
export { withRetry, retryDelay, type RetryOptions } from "./retry.js";
export { toGeminiSchema, toObjectSchema } from "./schema.js";
export { streamChat, DecodeError, type StreamDecoder, type StreamSpec } from "./http.js";
export {
  createAnthropicProvider,
  buildAnthropicRequest,
  buildAnthropicCountRequest,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_VERSION,
  ANTHROPIC_FALLBACK_MODELS,
  type AnthropicReasoningMeta,
} from "./providers/anthropic.js";
export {
  createOpenAIProvider,
  buildOpenAIRequest,
  buildOpenAICountRequest,
  OPENAI_BASE_URL,
  OPENAI_FALLBACK_MODELS,
  TOOL_ERROR_PREFIX,
  type OpenAIProviderOptions,
  type OpenAIReasoningMeta,
} from "./providers/openai.js";
export {
  createGoogleProvider,
  buildGoogleRequest,
  buildGoogleCountRequest,
  geminiThinkingConfig,
  GOOGLE_BASE_URL,
  GOOGLE_FALLBACK_MODELS,
  type GoogleProviderOptions,
  type GoogleMeta,
} from "./providers/google.js";
export { createLocalProvider, buildLocalRequest, LOCAL_BASE_URL, type LocalProvider } from "./providers/local.js";
export { createProvider, PROVIDER_FACTORIES, EXPERIMENTAL_PROVIDERS } from "./registry.js";
export {
  fixtureFetch,
  chunkedStream,
  type FixtureFetch,
  type FixtureFetchOptions,
  type FixtureMeta,
  type RecordedRequest,
} from "./fixtures.js";
