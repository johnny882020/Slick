# Oblige

*Compliance by design.*

**Can I keep selling this product, in this country, on this marketplace? And if not, what do I fix?**

Oblige checks every product a small seller lists across EU countries and marketplaces.
It covers packaging take-back, product safety (GPSR), and later electronics, batteries and textiles
take-back. It shows what's missing, ranks the fixes by how many listings each one protects, and
keeps the evidence. The rules are versioned, cited packs evaluated by a deterministic engine.

- Plan: [`docs/plan/oblige-development-plan.md`](docs/plan/oblige-development-plan.md)
- Phase 0 playbook (outreach, interviews, concierge audits): [`docs/gtm/phase-0-playbook.md`](docs/gtm/phase-0-playbook.md)
- Rule format: [`docs/rulebook-format.md`](docs/rulebook-format.md) · packs in [`rules/`](rules/)
- Research behind the decision: [`reports/`](reports/)

Run a gap audit on the fictional example seller:

```bash
pnpm install
```

```bash
pnpm audit:example
```

It writes `examples/audit/sample-report.html` and `.md`.

---

# OneSeat engine (reused)

One desktop app (Windows + macOS), one skills library, any model. A single general agent runs
repetitive business tasks as [Agent Skills](https://agentskills.io); the team connects one model
key (Claude, OpenAI/Codex, Gemini, or a local OpenAI-compatible server) instead of paying for
several per-seat tools.

`CLAUDE.md` has the layout, the frozen contracts and the rules. Each package has its own README.

## Layout

| Path | What |
|---|---|
| `packages/contracts` | ModelProvider, SkillManifest, ToolCall, ArtifactBundle, daemon protocol, business schema |
| `packages/gateway` | Adapters: Anthropic Messages, OpenAI Responses (Codex), Gemini, local Chat Completions |
| `packages/harness` | Agent loop, skill router, MCP client, Deno sandbox, SQLite memory, scheduler, approvals, daemon server |
| `packages/registry` | Skill install (folder / GitHub / skills.sh), security scan, lint, signing; `oneseat-skills` CLI |
| `packages/testkit` | Conformance suites, eval runner (gate 5), gates runner |
| `apps/daemon` | The sidecar: wires the three packages; builds a single executable + Deno |
| `apps/desktop` | Tauri 2 shell: keychain, skill library, runs, approvals, schedules, "Pin as app" |
| `skills/` | Seven starter skills, each with 10 eval cases |
| `apps/cloud` | OneSeat Cloud (Render): website, Stripe plans, licenses, feedback; Neon Postgres |

## Run it

```bash
pnpm install
pnpm build
pnpm test
pnpm gates            # gates 1-6 (5 needs keys: pnpm gates --live-evals)
```

Desktop app in development (uses `apps/daemon/dist/main.js` automatically once built):

```bash
pnpm --filter @oneseat/desktop tauri dev
```

Release sidecars (run on each target OS before `tauri build`):

```bash
pnpm --filter @oneseat/daemon run build:sidecar
```

Running it with first users, including the cloud setup: [`docs/first-users.md`](docs/first-users.md).

## Status

- Gates 1–4 and 6 pass locally (Linux). Gate 5 (skill vs no-skill evals) needs provider keys;
  the nightly workflow runs it live. Gate 7 is the manual pilot (`docs/pilot.md`).
- Provider fixtures are hand-written from each vendor's documented wire format; the nightly
  job re-records them against the live APIs when keys are set as repository secrets.
- Windows and macOS builds are configured in CI (`.github/workflows`) but have not run yet.
