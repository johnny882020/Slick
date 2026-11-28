# Security review, 2026-11-28

## Scope and method

- **Claude Security scan.** Low effort, $20 cap. Run on commit `e24a404` over the code that faces
  untrusted input:
  - `apps/cloud/src`
  - `apps/desktop/src-tauri/src`
  - `packages/harness/src`
  - `packages/registry/src`

  Each finding was confirmed by 2 of 2 verifiers.
- **Manual review** of the areas the scan did not cover:
  - the desktop UI: no raw HTML sinks; text is always set as text
  - gateway key redaction: key shapes, auth headers and keys in query strings
  - workflow scripts: no untrusted `${{ }}` text inside `run:`
- **Dependency audits:**
  - `pnpm audit`, all and `--prod`
  - `cargo audit` on `apps/desktop/src-tauri`, 548 crates
- **Live headers** of the cloud service.

## Findings and fixes

| ID | Severity | What | Fix |
|---|---|---|---|
| F1 | Medium | MCP tools without annotations were treated as non-destructive. An unannotated `send_email` or `delete_file` ran without approval. | `mcpToolEffects` applies the MCP 2025-06-18 defaults: a tool that is not read-only counts as destructive and open-world unless it says otherwise, and a write in the open world counts as a send. |
| F2 | Low | `schedule_task` needed no approval and dropped a pinned app's skill list, so a restricted run could create unrestricted, repeating runs. | `schedule_task` always asks a person, and is refused in app and schedule runs. A schedule stores the creating run's `allowedSkills` and enforces them when it fires and through edits. |
| F3 | Low | `db_execute` missed some statements that destroy data: `ALTER TABLE … DROP <col>` without `COLUMN`, `REPLACE`, and `INSERT OR REPLACE`. | These count as deletes. So do `UPDATE … OR REPLACE` and an `UPDATE` with no `WHERE`. An upsert's `DO UPDATE` is not counted. |
| D1 | 2 critical, 2 high, 6 moderate | Advisories in test tooling: vitest, tinypool, @vitest/mocker, happy-dom, and glob and minimatch under coverage. Nothing in shipped code. | vitest and @vitest/coverage-v8 upgraded to 4.1.12, happy-dom to 21.0.4. `pnpm audit` is clean. CI now runs `pnpm audit --prod --audit-level high`. |
| H1 | Hardening | The cloud service sent no HSTS or Permissions-Policy header. | Every response sends `Strict-Transport-Security`. Pages also send `Permissions-Policy` and `Cross-Origin-Opener-Policy`. |

## Accepted, with reasons

`cargo audit` reports no vulnerabilities. It gives 9 warnings, all pulled in by Tauri 2 and its
Linux GTK stack:

- **Unmaintained crates, no fixed release:** `chrono`, `proc-macro-error`, `zbus_names`,
  `zvariant`, `zvariant_derive`. Re-check them when Tauri moves off them.
- **Unsoundness in `glib` 0.18** (`VariantStrIter`, RUSTSEC-2024-0429). It is the Linux GTK
  binding, used only by Linux builds. Release 1 ships Windows and macOS.

## Not covered

- The model gateway, the daemon wiring and the starter skills were reviewed by hand, not by the
  scan.
- A medium or high effort scan of the whole repository would cover them. Run one before a
  public release.
