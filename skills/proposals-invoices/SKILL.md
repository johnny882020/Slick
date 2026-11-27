---
name: proposals-invoices
description: Creates proposals, quotes and invoices in the company's brand style - exact totals in integer cents with tax and discounts, invoice numbers in the INV-YYYY-NNNN sequence, due dates from payment terms, drafts saved to the database and a print-ready branded HTML invoice. Use when someone says "make an invoice", "bill this client", "invoice for", "quote", "estimate", "proposal", "what's the total with tax", "next invoice number", "due date", "print the invoice" or "mark invoice paid".
compatibility: Requires the OneSeat harness tools db_query, db_execute, run_skill_script (Deno) and make_artifact, and the local business database.
allowed-tools: db_query db_execute run_skill_script read_skill_file make_artifact load_skill workspace_write
metadata:
  version: "1.0.0"
  author: OneSeat
---

# Proposals and invoices

Money is integer cents everywhere. You never add, multiply or round money yourself: the totals
script does it. You never send an invoice: you draft it and a person approves sending.

## 1. Gather

1. Customer: find them in `customers` (load the **customers** skill if the name is ambiguous).
   Ask if there are several matches. Invoices need a `customer_id`.
2. Brand: `SELECT key, value FROM brand`. Use `company_name`, `primary_color`, `accent_color`,
   `ink`, `paper`, `font_display`, `font_text`, `logo_svg`. Missing keys keep the template defaults.
3. Line items: description, quantity (up to 3 decimals, e.g. 1.5 hours), unit price. Convert
   prices to cents: `$125` is `12500`. Ask for anything missing; never invent prices.
4. Tax rate and discount only if the person gives them (or a previous invoice for this customer
   used one). Tax as basis points: 8.25% is `825`.

## 2. Compute totals (always)

Call `run_skill_script` with `skill: "proposals-invoices"`, `script: "totals"` and one argument,
the JSON input:

```json
{"items":[{"description":"Brand workshop","quantity":3,"unit_cents":12500},
          {"description":"Design hours","quantity":1.5,"unit_cents":8000}],
 "tax_bps":825,"currency":"USD","issued_at":"2026-11-25","terms_days":30}
```

Result (abridged): `subtotal_cents 49500`, `tax_cents 4084`, `total_cents 53584`,
`due_at "2026-12-25"`, `formatted.total "$535.84"`. Use these numbers verbatim. Set
`"taxable": false` on lines that are not taxed (often shipping). If the script returns
`{"error": ...}`, fix the input or ask; do not fall back to mental math.

Rounding: each line rounds half-up to a cent once; tax is computed once on the taxable
subtotal after discount and rounds half-up.

## 3. Invoice number

Numbers are `INV-<year of issue date>-<4-digit sequence>`, restarting at 0001 each year, never
reused (void invoices keep their number). Get the next one right before inserting:

```sql
SELECT printf('INV-%s-%04d', ?, COALESCE(MAX(CAST(substr(number, 10) AS INTEGER)), 0) + 1) AS next_number
FROM invoices WHERE number LIKE 'INV-' || ? || '-%'
```

Params: `["2026", "2026"]`. With INV-2026-0007 and INV-2026-0012 on file, the next is
INV-2026-0013. If the insert fails on the UNIQUE number, re-run the query and retry once.

## 4. Due dates

- Default terms: Net 30 from the issue date. Use the person's terms if given ("Net 15", "due on
  receipt" = 0 days) and pass them as `terms_days`, or pass an exact `due_at`.
- Issue date: today unless the person says otherwise. Dates are `YYYY-MM-DD`.

## 5. Save the draft

Insert the invoice, then one row per item (`db_execute`, values as params):

```sql
INSERT INTO invoices (id, number, customer_id, status, issued_at, due_at, currency, total_cents, notes)
VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)
```

```sql
INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_cents)
VALUES ('itm_' || lower(hex(randomblob(8))), ?, ?, ?, ?)
```

- Make the invoice id yourself: `inv_` plus 16 hex characters, and reuse it for the items.
- `total_cents` is the script's `total_cents` (tax included).
- Put the tax and discount in `notes` on the first line so the total can be re-derived:
  `tax_bps=825; discount_cents=0; terms=Net 30`, then any human notes.
- Proposals go in `proposals` with `status 'draft'`, `body_md` from
  [assets/proposal-template.md](assets/proposal-template.md), `total_cents` from the script and
  `valid_until` (default 30 days after today).

## 6. Print-ready invoice

1. `read_skill_file` [assets/invoice-template.html](assets/invoice-template.html).
2. Replace the values in the `BRAND:START` block with the brand tokens. Fonts must stay system
   stacks; if the brand names a web font, keep the default stack.
3. Fill every `{{...}}`. Repeat the `ITEM` row per line using `formatted.unit` and
   `formatted.lines`. Delete the discount row when it is zero. Escape `&`, `<`, `>` in all text.
   `{{status}}` is `Draft` until the invoice is really sent.
4. Logo: paste `logo_svg` only if it is a plain `<svg>` with no `<script>`, no `on...=`
   attributes and no `href` to `http`. Otherwise leave it out.
5. `make_artifact` with `name: "Invoice INV-2026-0013"`, the filled `html`, `allowedSkills: []`
   and `window: {"width": 900, "height": 1100}`. Tell the person they can print it or save it
   as PDF from the window.

## Status changes

- `draft` to `sent`: only after a connected email or billing tool reports success, with the
  person's approval. Until then say "draft", never "sent".
- `paid`: only when the person says it was paid. `overdue`: `due_at` passed and not paid.
- Never `DELETE` invoices or items. Cancel with `status = 'void'`. Removing a line from a draft
  is a `DELETE` on `invoice_items`: ask first, name the line.

## Reply format

Show: number, customer, issue and due dates, each line with amount, subtotal, tax, total, and
the status **Draft (not sent)**. Offer: open the printable invoice, change something, or send it
(needs approval).
