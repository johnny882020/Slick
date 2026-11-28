# Business database schema

Local SQLite file, created by the harness. Read with `db_query`, write with `db_execute`.
Tables starting with `_os_` are private to the harness and always refused.

Conventions:

- Ids are `TEXT`. New ids use a prefix plus random hex, e.g. `'cus_' || lower(hex(randomblob(8)))`.
  Prefixes: `cus_` customers, `pur_` purchases, `msg_` messages, `inv_` invoices, `itm_` invoice items,
  `prp_` proposals, `tkt_` tickets, `pst_` posts, `met_` metrics.
- Money is `INTEGER` cents (`amount_cents`, `total_cents`, `unit_cents`). Never store floats for money.
- Dates are ISO 8601 text: `2026-11-25` or `2026-11-25T14:03:00Z`. They sort and compare as text.

## customers

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| name | TEXT NOT NULL | |
| email | TEXT | store lowercased, trimmed |
| company | TEXT | |
| phone | TEXT | |
| tags | TEXT NOT NULL default '' | comma-separated, e.g. `vip,wholesale` |
| notes | TEXT NOT NULL default '' | free text |
| created_at | TEXT NOT NULL default now | when the customer was added |

## purchases

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| customer_id | TEXT NOT NULL -> customers.id | |
| product | TEXT NOT NULL | |
| amount_cents | INTEGER NOT NULL | |
| currency | TEXT NOT NULL default 'USD' | |
| purchased_at | TEXT NOT NULL | |

## messages

Real sent and received history only. Drafts never go here.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| customer_id | TEXT -> customers.id | may be NULL for unknown senders |
| channel | TEXT NOT NULL | one of `email`, `chat`, `social`, `phone`, `other` |
| direction | TEXT NOT NULL | `in` (from the customer) or `out` (from us) |
| subject | TEXT NOT NULL default '' | |
| body | TEXT NOT NULL default '' | |
| sent_at | TEXT NOT NULL | |

## invoices and invoice_items

`invoices`: id, number (UNIQUE, `INV-YYYY-NNNN`), customer_id, status (`draft`, `sent`, `paid`,
`overdue`, `void`), issued_at, due_at, currency, total_cents, notes.

`invoice_items`: id, invoice_id, description, quantity (REAL), unit_cents (INTEGER).

## proposals

id, customer_id, title, status (`draft`, `sent`, `accepted`, `declined`), body_md, total_cents,
created_at, valid_until.

## tickets

id, customer_id, subject, body, status (`open`, `pending`, `closed`), priority (`low`, `normal`,
`high`, `urgent`), category, received_at, draft_reply, assignee.

## Other tables

- `posts`: social posts (channel, body, status, scheduled_for, published_at, campaign).
- `metrics`: named numbers per period (name, value, unit, period_start, period_end, source).
- `brand`: key/value brand tokens (company_name, primary_color, voice, ...).

## View: customer_ltv

One row per customer, including customers with no purchases.

| column | meaning |
|---|---|
| customer_id | customers.id |
| name, email | copied from customers |
| ltv_cents | sum of all purchases.amount_cents (0 if none) |
| purchase_count | number of purchases |
| last_purchase_at | latest purchased_at, NULL if none |

LTV sums every currency together. If a customer has purchases in more than one currency, report
per currency from `purchases` instead.

## Example queries

Customer by email (case-insensitive):

```sql
SELECT * FROM customers WHERE lower(email) = lower(trim(?))
```

Lifetime value for one customer:

```sql
SELECT ltv_cents, purchase_count, last_purchase_at FROM customer_ltv WHERE customer_id = ?
```

Last 5 messages with a customer:

```sql
SELECT channel, direction, subject, body, sent_at FROM messages
WHERE customer_id = ? ORDER BY sent_at DESC LIMIT 5
```

Revenue per product, all time:

```sql
SELECT product, COUNT(*) AS orders, SUM(amount_cents) AS revenue_cents
FROM purchases GROUP BY product ORDER BY revenue_cents DESC
```
