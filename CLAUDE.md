# Compliance Keeper (built on the OneSeat engine)

**Product direction (2026-11-28):** Compliance Keeper answers one question for small EU sellers on
several marketplaces: *can I keep selling this product, in this country, on this marketplace, and
if not, what do I fix?* The plan is `docs/plan/compliance-keeper-development-plan.md`, the Phase 0
playbook is `docs/gtm/phase-0-playbook.md`, and the research behind it is in `reports/`.

The OneSeat engine below (harness, approvals, action log, sandbox, registry, gateway, testkit,
cloud) is reused. The desktop app and the generic starter skills are legacy and get no new features.

## Compliance Keeper layout and ownership

| Path | Stream | What |
|---|---|---|
| `packages/contracts/src/compliance.ts` | Lead | Compliance contracts v1. **Do not change without a lead review.** |
| `rules/<jurisdiction>/<obligation>.yaml` | S1 | Rule packs. Format: `docs/rulebook-format.md` |
| `packages/rulebook` | S1 | Load, lint (gate R1), citation checks (gate R2), signing, predicate evaluation |
| `packages/obligations` | S2 | Catalog × rulebook → requirements, fixes, "Can I sell?" map, gap-audit report, CSV import, `keeper-audit` CLI |
| `examples/audit` | S2 | Fictional example seller and catalog, plus the catalog template |
| `docs/gtm` | S7 | Outreach, interviews and the concierge audit playbook |

Rulebook rules:
- Every rule cites an official source.
- Predicates are deterministic.
- Missing data evaluates to "unknown"; never guess.
- New packs are `review.status: draft`.
- Only `approved` packs (named legal reviewer) may drive filings.
- AI proposes rules and classifications; the engine decides.

Commands: `pnpm lint:rules`, `pnpm audit:example`.

## OneSeat engine layout and ownership

| Path | Stream | What |
|---|---|---|
| `packages/contracts` | Lead | Frozen interfaces. **Do not change without a lead review.** |
| `packages/gateway` | A | `ModelProvider` adapters: Anthropic, OpenAI (Responses API / Codex), Google Gemini, local (OpenAI-compatible) |
| `packages/harness` | B | Agent loop, skill router, MCP tool runner, Deno script sandbox, memory, scheduler, approvals, daemon JSON-RPC server |
| `packages/registry` | C | `SkillStore`: install from folder / GitHub / skills.sh, scan, lint, sign, version |
| `apps/desktop` | D | Tauri 2 shell (Rust core + TS UI), keychain, skill library, "Pin as app" |
| `skills/` | E | Starter skill packs (Agent Skills standard) + eval cases |
| `packages/testkit`, `.github/` | F | Contract conformance suites, eval runner, gates, CI |
| `apps/daemon` | Lead | Wires gateway + registry + harness into the sidecar binary |

A stream changes only its own path. A PR that touches another stream's path is rejected.

## The contracts (packages/contracts/src)

1. **ModelProvider** (`model.ts`): `models()`, `send(ChatRequest): AsyncIterable<ChatEvent>`, `countTokens()`.
   Stream order: `message_start`, then `text_delta` / `reasoning_delta` / `reasoning_done` / `tool_call`
   (one per call, complete parsed input), then exactly one `message_end` — or one `error` that ends it.
   `ToolUsePart.providerMeta` / `ReasoningPart.providerMeta` carry opaque data that must round-trip
   (Gemini thought signatures, Anthropic thinking signatures).
2. **SkillManifest** (`skill.ts`): folder + `SKILL.md` (frontmatter: name, description, license,
   compatibility, metadata, allowed-tools) + optional `oneseat.json` (permissions, effects, reasons, scripts).
   Use `buildManifest()` / `parseSkillMd()`; never write another parser.
3. **ToolCall** (`tool.ts`): MCP tool shape `{name, description, inputSchema}`. `ToolDefinition.effects`
   drives approvals: `send`, `pay`, `delete` always need a person.
4. **ArtifactBundle** (`artifact.ts`): one self-contained HTML file + `app.json`. Pinned pages get
   `PINNED_APP_CSP` and only `oneseat.run(skill, input)`.
5. Shared extras: `harness.ts` (TaskRequest, HarnessEvent, SkillStore, daemon JSON-RPC methods).
   A run's events start with `session_start` and end with exactly one `done`; `error` is informational
   and is followed by `done` with `stopReason: "error"`. Listeners stop on `done` only. Also
   `evals.ts` (EvalSuite format), `data.ts` (business SQLite schema), `testing.ts` (`createScriptedProvider`).

## Rules

- TypeScript, ESM, Node >= 22.12, pnpm workspaces + Turborepo. Rust only in `apps/desktop/src-tauri`.
- Packages export TS source under the `@oneseat/source` condition (tests and typecheck need no build)
  and `dist/` by default. Copy the `package.json` / `tsconfig*.json` / `vitest.config.ts` shape of
  `packages/contracts`.
- Local first: SQLite on disk via `node:sqlite`. No cloud sync in release 1.
- Script sandbox: Deno, deny by default. Grant exactly the skill's declared `oneseat.json` permissions.
- Secrets: OS keychain only (Rust side). Keys reach the daemon in memory via `auth.set`.
  Never write a key to a skill, a log, a prompt, a fixture or an error message. Redact `x-api-key`,
  `authorization`, `x-goog-api-key` everywhere.
- Ask a person before any `send`, `pay` or `delete`. Log every tool action to `_os_action_log`.
- Provider tests use recorded or documented-format fixtures in CI. Live API tests run nightly only,
  when keys are present (`ONESEAT_LIVE=1`).
- Models: lead `claude-opus-5-5`. Anthropic ids: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`.
- Skills: description says what and when; SKILL.md under 500 lines; link files directly from SKILL.md
  (no chains); every network host has a reason.
- Small PRs, one feature each. Run `pnpm test` and `pnpm typecheck` before you commit.

## Gates

1. Unit — 90% line coverage on core logic. 2. Contract — same tool-call result on all 3 providers.
3. Skill lint. 4. Security scan — no undeclared network or file access. 5. Skill evals — skill wins or
ties a no-skill baseline on 10 cases. 6. End to end — 6 core UI flows green on Windows 11 and macOS.
7. Pilot — 10 teams, 2 weeks (manual, tracked in `docs/pilot.md`).

## Commands

```bash
pnpm install
pnpm test        # all packages
pnpm typecheck
pnpm build
pnpm gates       # gates 1-5 locally
```
