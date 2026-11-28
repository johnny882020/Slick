# Customer queries

Copy these. Every `?` is a positional parameter: pass values in `params`, in order.
Where a query takes `today`, pass the date the person gave (`2026-11-25`) or use `date('now')`.

## Find

By name, email, company or phone (one search term, used four times):

```sql
SELECT id, name, email, company, phone, tags FROM customers
WHERE lower(name) LIKE '%' || lower(?) || '%'
   OR lower(email) LIKE '%' || lower(?) || '%'
   OR lower(company) LIKE '%' || lower(?) || '%'
   OR replace(replace(replace(phone, ' ', ''), '-', ''), '+', '') LIKE '%' || ? || '%'
ORDER BY name LIMIT 20
```

## Profile

```sql
SELECT c.*, l.ltv_cents, l.purchase_count, l.last_purchase_at
FROM customers c JOIN customer_ltv l ON l.customer_id = c.id
WHERE c.id = ?
```

```sql
SELECT product, amount_cents, currency, purchased_at FROM purchases
WHERE customer_id = ? ORDER BY purchased_at DESC LIMIT 5
```

```sql
SELECT channel, direction, subject, substr(body, 1, 300) AS body, sent_at FROM messages
WHERE customer_id = ? ORDER BY sent_at DESC LIMIT 5
```

```sql
SELECT id, subject, status, priority FROM tickets WHERE customer_id = ? AND status <> 'closed'
```

```sql
SELECT number, status, total_cents, due_at FROM invoices
WHERE customer_id = ? AND status IN ('draft', 'sent', 'overdue')
```

## Segments

Top N by LTV (params: limit):

```sql
SELECT customer_id, name, email, ltv_cents, purchase_count, last_purchase_at
FROM customer_ltv WHERE purchase_count > 0 ORDER BY ltv_cents DESC LIMIT ?
```

Lapsed: bought before, nothing in the last N days (params: today, days as text like '-90 days'):

```sql
SELECT customer_id, name, email, ltv_cents, purchase_count, last_purchase_at
FROM customer_ltv
WHERE purchase_count > 0 AND last_purchase_at < date(?, ?)
ORDER BY ltv_cents DESC
```

New this month (params: today):

```sql
SELECT id, name, email, company, created_at FROM customers
WHERE created_at >= date(?, 'start of month')
ORDER BY created_at
```

Never bought:

```sql
SELECT customer_id, name, email FROM customer_ltv WHERE purchase_count = 0 ORDER BY name
```

Has a tag (params: tag, lowercase):

```sql
SELECT id, name, email, tags FROM customers
WHERE ',' || replace(tags, ' ', '') || ',' LIKE '%,' || ? || ',%'
```

Revenue in a date range (params: start, end exclusive):

```sql
SELECT COUNT(*) AS orders, COALESCE(SUM(amount_cents), 0) AS revenue_cents
FROM purchases WHERE purchased_at >= ? AND purchased_at < ?
```

## Writes

Add a customer (params: name, email, company, phone, tags):

```sql
INSERT INTO customers (id, name, email, company, phone, tags)
VALUES ('cus_' || lower(hex(randomblob(8))), ?, lower(trim(?)), ?, ?, ?)
RETURNING id, name, email
```

Update one field (example: email; params: email, id):

```sql
UPDATE customers SET email = lower(trim(?)) WHERE id = ?
```

Append a tag without duplicating it (params: tag, tag, id, tag):

```sql
UPDATE customers
SET tags = CASE WHEN tags = '' THEN ? ELSE tags || ',' || ? END
WHERE id = ? AND ',' || tags || ',' NOT LIKE '%,' || ? || ',%'
```

Record a purchase (params: customer_id, product, amount_cents, currency, purchased_at):

```sql
INSERT INTO purchases (id, customer_id, product, amount_cents, currency, purchased_at)
VALUES ('pur_' || lower(hex(randomblob(8))), ?, ?, ?, ?, ?)
```

## Duplicates

Same email:

```sql
SELECT lower(trim(email)) AS email_key, group_concat(id) AS ids, COUNT(*) AS n
FROM customers WHERE email IS NOT NULL AND email <> ''
GROUP BY email_key HAVING n > 1
```

Same name and company:

```sql
SELECT lower(trim(name)) AS name_key, lower(trim(COALESCE(company, ''))) AS company_key,
       group_concat(id) AS ids, COUNT(*) AS n
FROM customers GROUP BY name_key, company_key HAVING n > 1
```

Merge: move history from the duplicate to the kept id. Run each with params `[keep_id, dup_id]`:

```sql
UPDATE purchases SET customer_id = ? WHERE customer_id = ?
```

```sql
UPDATE messages SET customer_id = ? WHERE customer_id = ?
```

```sql
UPDATE invoices SET customer_id = ? WHERE customer_id = ?
```

```sql
UPDATE proposals SET customer_id = ? WHERE customer_id = ?
```

```sql
UPDATE tickets SET customer_id = ? WHERE customer_id = ?
```

Mark the duplicate (params: keep_id, dup_id):

```sql
UPDATE customers
SET tags = CASE WHEN tags = '' THEN 'merged' ELSE tags || ',merged' END,
    notes = trim(notes || ' merged into ' || ?)
WHERE id = ?
```

Only after the person approves, in this conversation, deleting the marked row (params: dup_id):

```sql
DELETE FROM customers WHERE id = ? AND ',' || tags || ',' LIKE '%,merged,%'
```
