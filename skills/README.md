# OneSeat starter skills

Seven skill packs in the [Agent Skills](https://agentskills.io) format. Each folder has a
`SKILL.md` (frontmatter + instructions), an `oneseat.json` (declared permissions, effects and
scripts), linked `references/` and `assets/`, optional Deno `scripts/`, and `evals/cases.json`
(10 cases each, `EvalSuite` from `packages/contracts/src/evals.ts`).

| Pack | What it does | Scripts | Effects |
|---|---|---|---|
| [`customers`](customers/) | Find customers, profiles, LTV (`customer_ltv`), segments, safe inserts and updates, dedupe and merge | - | delete (approval) |
| [`outreach`](outreach/) | Personal follow-up, win-back, thank-you and reply drafts grounded in customer history | - | send (approval) |
| [`proposals-invoices`](proposals-invoices/) | Proposals and invoices in brand style, exact cent totals, `INV-YYYY-NNNN` numbering, print-ready HTML | `totals` | send, delete (approval) |
| [`social-posts`](social-posts/) | Posts per channel within limits, scheduling, reminders, CSV and HTML content calendar | `length` | send, delete (approval) |
| [`support-inbox`](support-inbox/) | Ticket priority and category, SLA targets, escalation, reply drafts saved on the ticket | - | send (approval) |
| [`weekly-report`](weekly-report/) | Last full Monday-Sunday week vs the week before, exact deltas, one-page brief and HTML one-pager | `deltas` | - |
| [`brand-kit`](brand-kit/) | Brand tokens in the `brand` table, contrast checks, self-contained branded pages and pinnable apps | `contrast` | - |

## Shared conventions

- Data lives in the local SQLite business database (`packages/contracts/src/data.ts`). Skills read
  with `db_query` and write with `db_execute`, always with `params`, never building SQL from user text.
- Money is integer cents. Totals, deltas, lengths and contrast ratios come from scripts, not
  mental math.
- Skills draft; people approve. Nothing is sent, posted, paid or deleted without a person's
  approval, and no skill says something was sent unless a connected tool confirmed it.
- `messages` holds only real sent and received history. Outreach drafts are returned in chat,
  optionally saved to the workspace (`drafts/outreach/`) and noted in memory.
- Pages made with `make_artifact` are one self-contained HTML file: system font stacks, no remote
  files, light and dark, phone width. `allowedSkills` lists every skill the page calls.
- Every script needs no permissions (`oneseat.json` grants none) and reads its JSON input from
  the first argument or stdin.

## Tests

```bash
npx --yes deno@2 test skills/proposals-invoices/scripts/ skills/social-posts/scripts/ \
  skills/weekly-report/scripts/ skills/brand-kit/scripts/
```
