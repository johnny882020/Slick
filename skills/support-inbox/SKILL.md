---
name: support-inbox
description: Sorts the support inbox - sets priority (urgent, high, normal, low) and category for each ticket, shows response-time targets, flags tickets to escalate, and drafts personal replies saved on the ticket for a person to approve. Never sends replies or closes tickets on its own. Use when someone says "support inbox", "tickets", "triage", "what needs a reply", "customer complaints", "draft replies", "urgent issues", "help desk", "refund request" or "who is waiting on us".
compatibility: Requires the OneSeat harness tools db_query and db_execute and the local business database. Sending needs a connected email or help-desk tool and a person's approval.
allowed-tools: db_query db_execute read_skill_file memory_search memory_save load_skill
metadata:
  version: "1.0.0"
  author: OneSeat
---

# Support inbox

Sort tickets, draft replies, and hand decisions to a person. You never send a reply and never
close a ticket without the person approving that exact ticket.

## 1. Load the queue

```sql
SELECT t.id, t.subject, t.body, t.status, t.priority, t.category, t.received_at, t.draft_reply,
       t.assignee, c.name, c.email, l.ltv_cents
FROM tickets t
LEFT JOIN customers c ON c.id = t.customer_id
LEFT JOIN customer_ltv l ON l.customer_id = t.customer_id
WHERE t.status <> 'closed'
ORDER BY t.received_at
```

For context on one ticket, also read the customer's last 3 `messages` and last 3 `purchases`.

## 2. Triage

Apply [references/triage-rules.md](references/triage-rules.md): priority first, then exactly one
category, then the escalation checks. Save each change:

```sql
UPDATE tickets SET priority = ?, category = ? WHERE id = ?
```

Do not change `status` during triage, except `open` to `pending` when the person says they are
waiting on the customer.

## 3. Draft replies

1. Start from the matching macro in [assets/macros.md](assets/macros.md) and personalise it:
   their name, their product or order, their exact problem.
2. Use only facts from the ticket and the database. Refund amounts, policies and dates you do
   not know go in `[brackets]` for the person.
3. Save the draft on the ticket:

```sql
UPDATE tickets SET draft_reply = ? WHERE id = ?
```

4. Spam gets no draft. Escalated tickets get a short holding reply only.

## 4. Report

Reply with a table sorted urgent, high, normal, low (oldest first within each):

```
| Ticket | Customer | Subject | Priority | Category | Waiting | Target |
|---|---|---|---|---|---|---|
| T-3 | Sam Lee | Charged twice | urgent | billing | 5 h | 1 h - overdue |
```

Then: **Escalate** items with reasons, then each draft under its ticket id, each marked
**Draft saved - not sent**. End with what the person can do next: approve and send a draft,
edit it, or close a ticket (each needs their OK).

Waiting time = now (or the date the person gives) minus `received_at`. Targets: urgent 1 h,
high 4 business hours, normal 1 business day, low 3 business days.

## Sending and closing

- Send only through a connected email or help-desk tool, after the person approves that reply.
  After the tool reports success: record it in `messages` (`direction 'out'`, `channel 'email'`),
  clear `draft_reply`, and set `status = 'pending'`.
- Close only when the person says so for that ticket: `UPDATE tickets SET status = 'closed' WHERE id = ?`.
  "Close all" still needs you to list the tickets and get a yes.
- No send tool connected: say so; the person can copy the draft.
- Never claim a reply was sent, and never `DELETE` tickets.

## Example

Ticket T-3 "Charged twice for my order" from a customer with two identical purchases today:
priority `urgent`, category `billing`, escalate (money taken twice), holding reply from the
double-charge macro naming the amount and date, saved to `draft_reply`, reported as
"Draft saved - not sent".
