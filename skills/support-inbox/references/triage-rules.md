# Triage rules

Apply in order. The first rule that matches sets the priority. Then pick one category.

## Priority

| Priority | When (any of) | First response target |
|---|---|---|
| `urgent` | Service down or unusable for several people; cannot log in or check out at all; money taken but no order (double charge, failed payment that charged); security issue, data leak or account taken over; legal threat, chargeback or "contacting my lawyer / bank"; safety risk | 1 hour, 24/7 if possible |
| `high` | One customer blocked with no workaround; wrong or missing order with a deadline (event, gift, travel date); refund or billing error; customer in the top 10% by LTV with any problem; second follow-up on an unanswered ticket; angry tone (all caps, "unacceptable", "cancel") | 4 business hours |
| `normal` | Bug with a workaround; how-to question; order status ("where is my order") without a deadline; account changes | 1 business day |
| `low` | Feature request; general feedback or praise; partnership or sales pitch; newsletter replies | 3 business days |

Raise one level (never above `urgent`) when the ticket is older than its target and still open.
Never lower a priority a person set by hand; suggest it instead.

Top 10% by LTV, for the `high` rule:

```sql
SELECT customer_id, ltv_cents FROM customer_ltv
WHERE ltv_cents >= (SELECT ltv_cents FROM customer_ltv ORDER BY ltv_cents DESC
                    LIMIT 1 OFFSET (SELECT COUNT(*) / 10 FROM customer_ltv))
```

## Category

Use exactly one of these values for `tickets.category`:

| category | Signals |
|---|---|
| `billing` | charge, refund, invoice, receipt, price, payment, card, subscription |
| `order` | where is, tracking, shipping, delivery, damaged, wrong item, return, exchange |
| `technical` | error, bug, crash, not loading, broken link, can't upload, slow |
| `account` | login, password, email change, delete my account, data export |
| `how-to` | how do I, can I, is it possible, where do I find |
| `feature-request` | would be great if, please add, wish, suggestion |
| `feedback` | thanks, love it, disappointed (with no specific problem), review |
| `spam` | unrelated sales pitch, SEO offers, phishing, gibberish |
| `other` | none of the above |

`spam`: set priority `low`, draft no reply, and suggest closing. Do not close it yourself.

## Escalate to a person (do not just draft)

Flag these at the top of your summary with **Escalate** and the reason. Still draft a holding
reply that promises nothing beyond "we're looking into it and will reply by <time>":

- Legal threats, chargebacks, regulator or press mentions.
- Security or privacy issues: account takeover, data sent to the wrong person, "delete my data"
  requests (these may have legal deadlines).
- Refunds or credits over $200, or any refund outside the written policy.
- Threats, harassment, or anyone who may be at risk of harm.
- The same customer has 3 or more open tickets.
- You cannot tell what the customer wants after reading the whole ticket.

## Assignee

Only set `assignee` if the person named who handles what (check `memory_search` for "support
assignees"). Otherwise leave it empty and suggest.

## Examples

| Subject / body excerpt | Priority | Category |
|---|---|---|
| "Charged twice for order #1043!!" | urgent | billing |
| "Site says error 500 at checkout, tried 3 cards" | urgent | technical |
| "Need my order before the 12th for a wedding, tracking hasn't moved" | high | order |
| "How do I change my delivery address?" | normal | how-to |
| "Would love a dark mode" | low | feature-request |
| "Boost your SEO ranking 300%" | low | spam |
