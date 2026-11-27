---
name: outreach
description: Drafts personal emails and replies to customers using their real history - purchases, last messages and lifetime value - for follow-ups, win-backs of lapsed customers, thank-you notes and replies to inbound emails. Returns drafts for approval and never sends on its own. Use when someone says "write to", "email this customer", "follow up with", "reply to", "draft a response", "thank-you note", "win back", "reach out to lapsed customers", "check in with" or "send a note".
compatibility: Requires the OneSeat harness tools db_query and load_skill and the local business database. Sending needs a connected email tool and a person's approval.
allowed-tools: load_skill db_query db_execute memory_search memory_save workspace_write read_skill_file
metadata:
  version: "1.0.0"
  author: OneSeat
---

# Outreach

Write emails that sound like the owner wrote them by hand, grounded in what the customer
actually bought and said. You draft. A person sends.

## 1. Load context first (always)

1. `load_skill` **customers** and use its queries to find the customer. If several match, ask.
2. Pull, for each recipient:
   - LTV, purchase count and last purchase date from the `customer_ltv` view.
   - Last 3 purchases (`purchases`, newest first): product, amount, date.
   - Last 3 messages (`messages`, newest first): direction, subject, a short body excerpt.
   - Open tickets (`tickets` where status is not `closed`). Never pitch someone with an open complaint;
     acknowledge it instead.
3. Read the brand: `SELECT key, value FROM brand WHERE key IN ('company_name', 'voice')`.
4. `memory_search` for the person's sign-off, tone preferences and recent drafts to this customer.

If there is no customer record and no inbound message, ask who they are before writing.

## 2. Pick the template

Use [assets/templates.md](assets/templates.md). Pick by situation:

| Situation | Template |
|---|---|
| Recent purchase, open question, or quote sent with no reply | Follow-up |
| Bought before, nothing in 90+ days | Win-back |
| Just bought, big order, referral, review, milestone | Thank-you |
| They wrote to us (latest message is `direction = 'in'`) | Reply to inbound |

## 3. Tone rules

- Under 120 words for the body unless the person asks for more. One idea, one ask.
- First line is about them: name the product they bought or the thing they said. No
  "I hope this email finds you well", no "just checking in", no "touching base".
- Plain words, short sentences, contractions. Match `voice` from the brand table if set.
- No fake urgency, no invented discounts, deadlines, stats or features. Offer only what the person
  gave you or what is in the data. If an offer would help, put it in `[brackets]` for them to fill.
- Never mention LTV, segments, "our records show" or how much they have spent. Use the data to
  choose what to say, not as content.
- Reply to inbound: answer their question in the first two sentences. If you cannot answer from
  the data, say what you will find out and by when, in brackets for the person to confirm.
- Subject: under 50 characters, specific, no clickbait, no ALL CAPS, no emoji.

## 4. Output

Return each draft in this shape, then the approval line:

```
To: Sam Lee <sam@leebakery.com>
Subject: Your wholesale question
---
Hi Sam,
...
Thanks,
<sign-off from memory, or [Your name]>
```

End with: **Draft only - not sent.** Then offer: edit it, save it, or send it with the connected
email tool (the person will be asked to approve).

## 5. Where drafts live

- Drafts are returned in the chat. They are **not** written to the `messages` table, which holds
  only real sent and received history.
- For 3 or more drafts, or when asked to keep them, `workspace_write` them to
  `drafts/outreach/<YYYY-MM-DD>-<customer-id>-<template>.md`.
- `memory_save` one line per draft: `Drafted <template> for <customer id> on <date>, not sent.`
  Also save tone or sign-off preferences the person states.
- Only after a connected send tool reports success (and the person approved it), record the real
  email: `INSERT INTO messages (id, customer_id, channel, direction, subject, body, sent_at)
  VALUES ('msg_' || lower(hex(randomblob(8))), ?, 'email', 'out', ?, ?, ?)`.

## Hard rules

- Never say or imply an email was sent unless a send tool returned success in this run.
  Do not write "I've sent", "sent!", "has been sent" or "delivered" for a draft.
- No send tool connected: say so, and give the draft to copy.
- Batch requests (e.g. "win back all lapsed customers"): draft at most 10, personalise each, and
  list who you skipped and why (open ticket, no email, contacted in the last 14 days).
