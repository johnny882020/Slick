---
name: customers
description: Looks up and maintains the local customer database - find a customer, show their purchases, messages and lifetime value (LTV), build segments such as top customers by LTV, lapsed customers (no purchase in 90 days) and new customers this month, add or update customer records safely, and find and merge duplicates. Use when someone says "find customer", "who is", "customer history", "what did they buy", "best customers", "top spenders", "lapsed", "haven't bought", "new customers", "add a customer", "update email", "duplicates" or "merge contacts".
compatibility: Requires the OneSeat harness tools db_query and db_execute and the local business database.
allowed-tools: db_query db_execute read_skill_file memory_search
metadata:
  version: "1.0.0"
  author: OneSeat
---

# Customers

You work on the local SQLite business database. Read with `db_query`, write with
`db_execute`. Always pass values as `params` (positional `?`), never paste user text into SQL.

Before writing a non-trivial query, read [references/schema.md](references/schema.md)
(tables, columns, the `customer_ltv` view). Ready-made queries for every task below are in
[references/queries.md](references/queries.md); copy them instead of improvising.

## Dates

- "Today" is the date the person gives. If none, use SQLite `date('now')`.
- Dates are ISO text (`2026-11-25` or `2026-11-25T14:03:00Z`). Compare with half-open ranges:
  `purchased_at >= ? AND purchased_at < ?`.

## Find a customer

1. Search `customers` by name, email, company or phone with `LIKE` and `lower()`. Match email
   case-insensitively.
2. If several rows match, list them (name, email, company, id) and ask which one. Never guess.
3. If nothing matches, say so and offer to add them.

## Customer profile

For one customer, run these and report them together:

1. The `customers` row (tags, notes).
2. LTV from the `customer_ltv` view: `ltv_cents`, `purchase_count`, `last_purchase_at`.
3. Last 5 purchases from `purchases`, newest first.
4. Last 5 messages from `messages`, newest first, with direction (`in` = from them, `out` = from us).
5. Open tickets and unpaid invoices, if any.

Money is integer cents. Show it as currency: `ltv_cents = 123450` is `$1,234.50`. Never sum
formatted strings; sum cents in SQL.

## Segments

| Segment | Rule |
|---|---|
| Top by LTV | `customer_ltv` ordered by `ltv_cents DESC`, default 10 |
| Lapsed | has purchased, and `last_purchase_at` is more than 90 days before today |
| Never bought | `purchase_count = 0` |
| New this month | `customers.created_at` on or after the first day of today's month |
| Tagged | `',' \|\| tags \|\| ','` LIKE `'%,vip,%'` (tags are comma-separated) |

Always say the rule you used and the date it was measured from, e.g. "lapsed = no purchase
since 2026-08-27 (90 days before 2026-11-25)".

## Add or update

- Check for an existing customer with the same email first (case-insensitive). Update instead
  of creating a duplicate.
- New ids: `'cus_' || lower(hex(randomblob(8)))`. Store email trimmed and lowercased.
- Update only the columns the person asked to change. Use `WHERE id = ?`, one customer at a time.
- Tags: keep comma-separated, no spaces, lowercase. Append, do not overwrite, unless asked.
- After a write, re-read the row and show what changed.

## Duplicates and merges

1. Find candidates: same lowercased email, same digits-only phone, or same name + company.
2. Show each pair side by side and propose which row to keep (the oldest `created_at`).
3. On a "yes", move history to the kept id: `UPDATE` `purchases`, `messages`, `invoices`,
   `proposals` and `tickets` `SET customer_id = <keep> WHERE customer_id = <dup>`. Merge tags
   and notes into the kept row.
4. Mark the duplicate instead of deleting it: add tag `merged` and note `merged into <keep>`.
5. Removing the duplicate row is a `DELETE`. Ask first, in plain words, naming the row.

## Hard rules

- Never run `DELETE` (or `DROP`, `TRUNCATE`-style bulk changes) without the person's explicit
  approval in this conversation. The harness will also ask them.
- Never `UPDATE` without a `WHERE` clause. Never touch tables whose names start with `_os_`.
- Never invent customers, amounts or dates. If the data is not there, say so.

## Calls from pinned apps

When the input is a JSON object with an `action`, reply with JSON only (no prose, no code
fence), so the page receives it as `data`:

| action | input fields | reply |
|---|---|---|
| `top_ltv` | `limit` (default 10) | `{"customers":[...]}` |
| `lapsed` | `days` (default 90), `today` | `{"customers":[...]}` |
| `new_this_month` | `today` | `{"customers":[...]}` |
| `find` | `query` | `{"customers":[...]}` |
| `profile` | `id` | `{"customer":{...},"purchases":[...],"messages":[...]}` |

Each customer object: `id`, `name`, `email`, `ltv_cents`, `purchase_count`, `last_purchase_at`.
On a problem reply `{"error":"<short reason>"}`.

## Example

Input: "Who are my top 3 customers?"

1. `db_query` with `SELECT customer_id, name, email, ltv_cents, purchase_count, last_purchase_at
   FROM customer_ltv ORDER BY ltv_cents DESC LIMIT ?` and `params: [3]`.
2. Answer:

```
Top 3 customers by lifetime value
1. Dana Ortiz (dana@ortiz.co) - $4,820.00 over 12 purchases, last on 2026-11-02
2. ...
```
