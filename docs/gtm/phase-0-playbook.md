# Phase 0 playbook: outreach, interviews and concierge gap audits

**Goal of Phase 0 (30 Nov – 11 Dec 2026):** at least 10 paid gap audits at €149, 15 seller
interviews, and 2 signed letters of intent from authorised-representative (AR) or take-back-scheme
partners. If we miss these, the lead re-plans (`docs/plan/oblige-development-plan.md`,
gate 0 → 1).

Items marked **[human]** need the founder. The rest is prepared by agents.

---

## 1. Who we are looking for

**Screener.** All five must be true:

1. Sells physical consumer products online in **two or more EU countries**.
2. Uses **two or more channels** (for example Amazon plus bol, Kaufland, Allegro, eBay, Etsy,
   Zalando, or their own Shopify or WooCommerce shop).
3. Has **10–5,000 SKUs**.
4. Is the brand owner, the manufacturer or the importer, so the packaging and product-safety
   duties fall on them.
5. Is the person who deals with compliance, or can bring that person to the call.

**Good signs** (prioritise these): based outside the country they sell into, often outside the EU
(UK, China, US, Turkey); has had a listing blocked, hidden or warned in the last 12 months; already
pays a compliance bureau or AR.

**Where to find them** **[human]** sends; agents draft and track:

| Channel | Approach | Target contacts |
|---|---|---|
| Seller communities: Amazon Seller Forums EU, Shopify Community, Etsy forums, eBay UK, sector groups on LinkedIn and Facebook | Helpful post plus the free checklist (section 2.3); invite to a 30-minute call | 25 |
| LinkedIn search: "Amazon seller" or "ecommerce manager" × "EU" × "marketplace" | Direct message (section 2.1) | 25 |
| Marketplace agencies and consultants (Amazon agencies, multi-channel agencies) | Partner message (section 2.2): an audit for their clients, with a revenue share | 10 agencies → 10–20 sellers |
| AR and compliance bureaus (partner LOIs) | Partner message (section 2.2) | 5 bureaus |
| Trade fairs and webinars (for example cross-border ecommerce events) | Booth or talk follow-ups | 5–10 |

**Tracking.** One row per contact in a shared sheet with these columns: name, company, country,
channels, SKUs, source, first contact date, replies, interview date, audit offered, audit paid,
notes. Never put customer data from audits in the sheet.

---

## 2. Messages

Write in the seller's language when you can. Keep it short and specific. Never claim a legal
result.

### 2.1 Direct message to a seller

> Hi {first name}, I saw {company} sells on {channel 1} and {channel 2} in {countries}.
>
> We're building a tool that checks every product against the packaging and product-safety rules
> in each EU country and marketplace (LUCID in Germany, the French UIN, GPSR responsible person and
> so on), and shows what's missing before a marketplace blocks a listing.
>
> Could I ask you a few questions about how you handle this today? 30 minutes, no sales pitch. As
> thanks, I'll run a free check on 20 of your products.

### 2.2 Message to an agency or AR partner

> Hi {first name}, we're building a gap audit for multi-marketplace sellers. It checks every SKU,
> country and channel for packaging registration, product safety and electronics take-back duties,
> and produces a prepared file for each missing registration.
>
> For AR and compliance firms, that means clients arrive with their data already collected, and
> filings come to you ready to sign. For agencies, it's a paid audit you can offer your clients,
> with a revenue share.
>
> Would you be open to a 20-minute call about a pilot with 3–5 of your clients?

### 2.3 Community post (no link-dropping; follow each group's rules)

> **Selling in several EU countries? A checklist of the duties marketplaces now check**
>
> Since GPSR (Dec 2024) and the new EU packaging regulation (Aug 2026), marketplaces ask for more
> before a listing can stay live. Here are the questions I'd check per country:
> 1. Are you registered for packaging in each country you ship to (LUCID in DE, UIN in FR,
>    Afvalfonds in NL, …)?
> 2. Do you have a take-back scheme contract where one is required?
> 3. If you're outside the EU, is an EU responsible person named on the product and the listing?
> 4. Are warnings and safety information in each country's language?
> 5. Electronics or batteries: are you registered for take-back in each country?
>
> Happy to answer questions. We're also looking for 10 sellers to test an automated check of this
> (free for the first 20 products).

### 2.4 Audit offer after an interview

> Thanks for your time today. As promised, here is the free check of 20 products: {link}.
>
> The full audit covers every product, country and channel. It ranks every fix by how many listings
> it protects and includes a prepared file for each registration. It costs €149, and that's credited
> in full if you continue with us within 3 months. Shall I run it?

---

## 3. Interview guide (45 minutes)

Ask about **past behaviour**, not opinions about the future. Record with consent, and take notes in
the affinity template.

**Warm-up (5 min).** Role; what they sell; which countries and channels; team size.

**Context (10 min).**
- "Walk me through the last time you started selling in a new EU country. What did you have to
  register or set up?"
- "Who handles packaging registration, product safety information and take-back today? Which tools
  or firms do you use?"
- "What do you pay for that per year? Per country?"

**Deep dive (20 min).**
- "When did a marketplace last ask you for compliance information, block, hide or warn a listing?
  What happened? How long were the listings offline? What did it cost you?"
- "How do you know today that you're compliant in every country? What would you show an
  inspector?"
- "Which part takes the most time: finding out the rules, collecting the data, filing, reporting
  volumes, or updating listings?"
- "Have you ever stopped selling in a country, or decided not to start, because of these rules?"

**Concept reaction (10 min).** Show the sample report (`examples/audit/sample-report.html`).
- "What here would you act on first? What's missing or wrong?"
- "Who else would need to see this before you'd use it?"
- "If this were available today, what would you stop paying for or doing?"

**Wrap-up (5 min).** "Anything I should have asked?" Offer the free 20-product check and the paid
audit (2.4).

**After each call.** Within 24 hours, fill in the affinity template:
- named incidents (with dates and costs);
- current spend;
- tools used;
- quotes;
- objections;
- willingness to pay, as observed behaviour only.

---

## 4. Concierge gap audit (what a paid audit includes, and how we run it)

**Price:** €149, credited in full against a subscription within 3 months. **[human]** sends a Stripe
payment link before the work starts.

### 4.1 Intake (seller, 15 minutes)

1. **Catalog:** an export from their marketplace or shop, or our template
   (`examples/audit/catalog-template.csv`). At minimum: SKU, title, where each product is listed
   (`amazon:DE;bol:NL`), and whether it is packaged, electrical, contains a battery or is a textile.
2. **Company questionnaire** (becomes `seller.json`):
   - legal name;
   - country of establishment;
   - role (manufacturer, brand owner, importer or reseller);
   - every registration number they hold, per country, with its register and end date;
   - take-back scheme contracts;
   - EU responsible person;
   - authorised representatives.
3. **Consent:** they agree that we process their catalog to produce the audit, under our data
   processing terms. Data stays in the EU and is deleted 30 days after delivery unless they subscribe.

### 4.2 Production (agent, about 15 minutes)

```bash
pnpm --filter @oneseat/rulebook lint:rules
```

```bash
pnpm --filter @oneseat/obligations gap-audit -- --catalog <catalog.csv> --seller <seller.json> --rules ../../rules --html <out>.html --md <out>.md --json <out>.json
```

The agent then checks the output:
- every "Need data" row has a matching question in the delivery email;
- every fix names a filing route;
- no fix relies on a rule pack that failed lint.

### 4.3 Human review (**[human]** or the legal reviewer, 20–30 minutes)

- [ ] Spot-check 10 SKUs against the rules by hand: do the obligations make sense for each product?
- [ ] Check the top 5 fixes: right country, right register, right filing route?
- [ ] Is anything marked "missing" that the seller told us they already hold? If so, correct
      `seller.json` and re-run.
- [ ] Do the notes at the bottom of the report state which rule packs are drafts?
- [ ] Remove anything that reads like legal advice beyond the cited rules.

### 4.4 Delivery

Send the HTML report with a short email:
- the 3 most urgent fixes in plain words;
- the data we still need;
- the offer to have us prepare the filings, through a subscription or partner AR;
- a 20-minute walkthrough call.

Log the outcome in the tracking sheet: delivered, call held, converted, and why or why not.

### 4.5 What we learn from every audit

Record these for each audit; they feed the Phase 1 build and the rulebook:
- time spent per stage;
- seller data that was missing (which columns);
- rules the reviewer corrected (open a rule-change item for each);
- fixes the seller chose first;
- objections.

---

## 5. Partner letters of intent (**[human]**, target 2)

Non-binding, one page. The partner agrees to:
- run a pilot with Oblige for 3 months;
- receive prepared filings for their clients;
- give feedback on the format;
- discuss a revenue share or referral fee.

We agree to send them qualified clients, a free partner console during the pilot, and prepared
files in their required format. Draft the LOI with the `legal:*` skills, then have a lawyer review it.

---

## 6. Gate 0 checklist

- [ ] 80 contacts reached
- [ ] 15 interviews held and synthesised
- [ ] ≥ 10 paid audits delivered
- [ ] ≥ 5 interviewees describe a block, hiding or warning in the last 12 months
- [ ] 2 partner LOIs signed
- [ ] Legal reviewer has reviewed the 6 draft rule packs
- [ ] Marketplace developer applications submitted (Amazon SP-API, bol, Kaufland, Allegro, eBay,
      Etsy, Shopify Partner)
