---
name: weekly-report
description: Builds the weekly business report - revenue, orders, average order, new customers, support tickets, published posts and tracked metrics for the last full Monday-to-Sunday week compared with the week before, with exact changes and a one-page brief, optionally as a branded HTML one-pager, and can set it to run every Monday. Use when someone says "weekly report", "how did we do last week", "week over week", "weekly numbers", "Monday brief", "weekly summary", "KPIs this week" or "send me a report every week".
compatibility: Requires the OneSeat harness tools db_query, run_skill_script (Deno), make_artifact and schedule_task, and the local business database.
allowed-tools: db_query run_skill_script read_skill_file make_artifact schedule_task memory_search memory_save workspace_write
metadata:
  version: "1.0.0"
  author: OneSeat
---

# Weekly report

One page, real numbers, last full week (Monday to Sunday) against the week before. You only
read data; you never change it.

## 1. Fix the weeks

Run `run_skill_script` with `skill: "weekly-report"`, `script: "deltas"` and one argument
`{"today": "<YYYY-MM-DD>"}` (the date the person gives, else today). It returns
`current` and `prior`, each with `start`, `end`, `end_exclusive` and `label`.
Example: today `2026-11-25` gives current `2026-11-16`..`2026-11-22`, prior `2026-11-09`..`2026-11-15`.
A week in progress is never reported.

Every query below takes params `[current.start, prior.start, current.end_exclusive]` and splits
rows into the two weeks. Dates are text, so `< end_exclusive` includes all of Sunday.

## 2. Collect

Revenue and orders (purchases are the source of truth for revenue):

```sql
SELECT CASE WHEN purchased_at >= ? THEN 'current' ELSE 'prior' END AS week, currency,
       COUNT(*) AS orders, COALESCE(SUM(amount_cents), 0) AS revenue_cents
FROM purchases WHERE purchased_at >= ? AND purchased_at < ? GROUP BY week, currency
```

New customers:

```sql
SELECT CASE WHEN created_at >= ? THEN 'current' ELSE 'prior' END AS week, COUNT(*) AS new_customers
FROM customers WHERE created_at >= ? AND created_at < ? GROUP BY week
```

Tickets received, urgent, and still open:

```sql
SELECT CASE WHEN received_at >= ? THEN 'current' ELSE 'prior' END AS week, COUNT(*) AS received,
       SUM(priority = 'urgent') AS urgent, SUM(status <> 'closed') AS still_open
FROM tickets WHERE received_at >= ? AND received_at < ? GROUP BY week
```

Posts published:

```sql
SELECT CASE WHEN published_at >= ? THEN 'current' ELSE 'prior' END AS week, COUNT(*) AS published
FROM posts WHERE status = 'published' AND published_at >= ? AND published_at < ? GROUP BY week
```

Tracked metrics (rows belong to the week their `period_start` falls in):

```sql
SELECT name, unit, CASE WHEN period_start >= ? THEN 'current' ELSE 'prior' END AS week,
       SUM(value) AS total, AVG(value) AS average, COUNT(*) AS n
FROM metrics WHERE period_start >= ? AND period_start < ? GROUP BY name, unit, week
```

- Use `total` for counts and money, `average` for rates (unit `%`, `rate`, `score`, `minutes`).
- A week with no rows is 0 for counts. Say "no data" for metrics missing in a week.
- If a `revenue` metric exists too, still use purchases; mention the metric only if it differs
  by more than 5%.
- More than one currency: report revenue per currency, never add them.

## 3. Compute changes

Never do the arithmetic yourself. Call the `deltas` script again with today, the currency and
every number:

```json
{"today":"2026-11-25","currency":"USD","metrics":[
 {"name":"Revenue","current":482000,"prior":395000,"unit":"cents"},
 {"name":"Orders","current":14,"prior":12},
 {"name":"Urgent tickets","current":1,"prior":3,"better":"down"}]}
```

Average order = revenue_cents / orders, rounded to a whole cent (skip it when orders is 0).
Use the returned `current_text`, `prior_text`, `delta_text` and `verdict` as they are.

## 4. Write the brief

Fill [assets/brief-template.md](assets/brief-template.md). Rules:

- Under 400 words. Headline first, with a number. Every bullet cites a number from the table.
- "What went well" uses `verdict: better`; "Watch" uses `worse`, open urgent tickets and
  overdue invoices (`status IN ('sent','overdue') AND due_at < today`).
- No guessing at causes. Write "possible reason: ..." only if the data shows it (for example a
  campaign in `posts.campaign` that week).
- Show the date ranges and the comparison week at the top.

## 5. Optional extras

- **HTML one-pager**: offer it. `read_skill_file` [assets/one-pager-template.html](assets/one-pager-template.html),
  set the brand tokens (`SELECT key, value FROM brand`), replace the JSON in `report-data` (the
  `metrics` array is the deltas output; escape `<` as `<`), then `make_artifact` with
  `name: "Weekly report <current.label>"`, `allowedSkills: []`, `window: {"width": 900, "height": 1000}`.
- **Every Monday**: offer once. `memory_search` "weekly-report schedule" first. On a yes,
  `schedule_task` with `cron: "0 8 * * 1"`, `skill: "weekly-report"`,
  `input: "Write the weekly report for last week."` and `memory_save` that it exists.
- Save a copy with `workspace_write` to `reports/weekly-<current.start>.md` if asked.

## Hard rules

- Read-only: no `db_execute`. Never "send" the report; it can be shared after the person approves.
- Only numbers from queries or the script. If a table is empty, say "no data", not 0%.
