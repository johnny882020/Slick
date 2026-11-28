# Where Oblige runs

Last updated 2026-11-28. There are no secrets in this file: keys live in Render and Neon only.

| What | Where | Details |
|---|---|---|
| Code | GitHub `johnny882020/Slick`, branch `claude/wonderful-cori-2lnltp` | Moves to `Oblige-EU/oblige` once that repository exists and the Claude GitHub App is installed on the organisation |
| Website and gap check | Render web service `oblige-web` (Frankfurt, Starter) | https://oblige-web.onrender.com · service `srv-dc5bahkipgvc73bnv45g` · deploys on every push to the branch |
| Weekly rulebook check | Render cron job `oblige-citation-check` (Frankfurt, Starter) | Mondays 04:17 UTC · job `crn-dc5baiff3r2c73e83ljg` · fails, and Render emails, only when a citation that was confirmed before stops matching its source (baseline: `rules/citation-baseline.txt`) |
| Database (not used yet) | Neon project `oblige` (`quiet-mouse-16963843`), AWS eu-central-1, Postgres 17 | Branches `main` (production) and `dev`. Phase 1 wires it in for accounts, saved audits and the evidence vault |
| Legacy | Render `oneseat-cloud`, Neon `oneseat` | Old OneSeat service and data. Suspend the service and export what you need before deleting anything |

## Web routes

| Route | What |
|---|---|
| `/` | Home page and the current rulebook coverage |
| `/check` | Self-serve gap check: CSV catalog + company details → report. Runs in memory; nothing is stored or logged |
| `/sample` | Sample report for the fictional example seller |
| `/catalog-template.csv` | Catalog template |
| `/healthz` | Health check (JSON with commit and pack count) |
| `/api/v1/rulebook` | Rule packs: id, version, counts, review status |

Limits: 3 MB uploads, 5,000 products, 10 gap checks per client per minute.

## Moving to the Oblige-EU repository

1. Create `Oblige-EU/oblige` (private, empty) and install the Claude GitHub App and Render's GitHub
   app on the organisation, with access to that repository.
2. Push this branch there and make it `main`.
3. In Render, point `oblige-web` and `oblige-citation-check` at the new repository and branch
   (Settings → Build & Deploy → Repository), or recreate them from `render.yaml`.
