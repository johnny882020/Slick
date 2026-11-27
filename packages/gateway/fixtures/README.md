# Provider fixtures

**These fixtures are hand-written, not recorded.** We had no API keys when they
were made. Each file follows the provider's documented wire format:

| Folder | API | Format reference |
|---|---|---|
| `anthropic/` | Messages API, `POST /v1/messages` with `stream: true` | docs.anthropic.com: Messages, Streaming Messages, Errors |
| `openai/` | Responses API, `POST /v1/responses` with `stream: true` | platform.openai.com: Responses, Streaming events |
| `google/` | Gemini API, `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` | ai.google.dev: Generate content, Thought signatures |
| `local/` | OpenAI-compatible Chat Completions, as served by Ollama and LM Studio | Chat Completions streaming chunks |

Ids, signatures and encrypted reasoning blobs are made up. They have the right
shape, but no server issued them. Gemini files use CRLF line endings, as the
Gemini API does. `.gitattributes` keeps every fixture byte-exact.

A nightly job re-records the scenario fixtures from the live APIs, and runs
`test/live.test.ts`. Both need `ONESEAT_LIVE=1` and the provider keys. If a
recorded file differs from the hand-written one, the recorded file wins.

## Layout

A case is one response:

- `<case>.sse`: an event-stream body, served as `text/event-stream`
- `<case>.json`: a JSON body, served as `application/json`
- `<case>.meta.json` (optional): `{ "status": 429, "headers": { "retry-after": "7" } }`

Every provider folder has the same core cases, so one test can run against all of them:

| Case | What it covers |
|---|---|
| `weather_tool_call` | Gate 2, turn 1: one `get_weather {"city":"Paris"}` call |
| `weather_final_text` | Gate 2, turn 2: "It is 18°C in Paris.", end of turn |
| `text_only` | Plain streamed text, in several deltas, with cached input tokens where the API reports them |
| `parallel_tools` | Two calls in one turn (Paris, London) |
| `max_tokens` | Output cut off by the token limit |
| `multibyte` | Umlauts, CJK, emoji and a ZWJ sequence (tests replay it one byte at a time) |
| `error_429`, `error_401` | Rate limit with a retry hint, and a bad key |
| `models` | The models endpoint |

Provider-specific cases: Anthropic `thinking` (signed thinking blocks),
`stream_error`, `error_529`; OpenAI `reasoning` (summary and encrypted
content), `failed`, `stream_error`; Gemini `thinking` (thought parts and a
signed call), `safety`, `malformed_call`, `prompt_blocked`,
`error_api_key_invalid`; local `reasoning` (Ollama's `reasoning` field).

## Using them

```ts
import { fixtureFetch, createAnthropicProvider } from "@oneseat/gateway";

const f = fixtureFetch("packages/gateway/fixtures/anthropic", { chunkSize: 1 }).queue("weather_tool_call");
const provider = createAnthropicProvider({ apiKey: "test", fetch: f });
// ... f.requests[0].body is the JSON the adapter sent. Secret headers read "[REDACTED]".
```

## Recording

```bash
ONESEAT_RECORD=1 ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=... \
  pnpm --filter @oneseat/gateway record
```

This runs `test/conformance.test.ts` against the live APIs and rewrites the
scenario fixtures. The recorder never writes request headers. It keeps only the
`retry-after` response headers, and it passes every body through `redact()`,
so a key echoed by a server is never written. Set
`ONESEAT_RECORD_<PROVIDER>_MODEL` to record with a different model. Error cases
(`error_*`) cannot be recorded on demand, so they stay hand-written.
