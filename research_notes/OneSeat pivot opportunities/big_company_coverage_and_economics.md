# Big-company coverage, general-agent failure modes, and economics of small vertical AI companies (as of Nov 28, 2026)

Scope note: Research was done on Nov 28, 2026 with web search plus page fetches. Many figures come from secondary coverage, vendor blogs or Sacra estimates, and each is flagged. "Vendor claim" means the company says it about itself. "Est." means a third-party estimate. Evidence from before 2026 is labeled with its date. The founder's rejected directions are a generic SMB agent, an accounting-firm month-end desk, invoice/receivables chasing, public tenders, and supplier compliance questionnaires. They are not proposed here. Where big players already cover them, that is noted as confirmation that the rejection was right.

---

## Q1. What have the big AI/software companies shipped for SMBs and prosumers in 2025-2026, and at what price?

### Takeaway
By late 2026 every horizontal and vertical incumbent ships a "do-the-back-office" agent. Pricing is roughly $20-25 per seat or bundled at "no additional cost". These agents connect to QuickBooks, HubSpot, Google, Microsoft, Shopify and PayPal and ask for approval before anything is sent. Generic SMB office work is therefore commoditized: inbox, docs, marketing content, bookkeeping Q&A, invoicing and reminders, month-end prep, store edits, and inbound support chat. The same goes for restaurant and commerce operations inside POS and commerce platforms. Incumbents are now pushing into phone answering too (Toast Answering Agent, Freed Front Desk, Square Squaremates). The open ground lies outside the big suites. It includes outbound and multi-party phone and paper work, liability-bearing professional tasks, legacy or desktop-only software, regulated local data (especially in the EU), and contingency-style money recovery.

### Cited Findings

**Anthropic (Claude for Small Business, Cowork)**
- Claude for Small Business launched May 13, 2026. It is a toggle inside Claude Cowork with connectors for PayPal, Intuit QuickBooks, HubSpot, Canva, Docusign, Google Workspace and Microsoft 365. It ships 15 "agentic workflows" and 15 skills, including payroll planning, monthly close, a business "pulse" dashboard, campaigns, an invoice chaser, margin analyzer, month-end prepper, tax-season organizer, contract reviewer, lead triager and content strategist — [Anthropic](https://www.anthropic.com/news/claude-for-small-business)
- Approval model: the user starts every task, and the user approves before anything is sent, posted or paid. Existing tool permissions carry over. The page does not state a price, and it says nothing about EU availability. All launch-tour stops are in the US — [Anthropic](https://www.anthropic.com/news/claude-for-small-business)
- Secondary sources conflict on access. One says the bundle comes with any Claude subscription. Zapier says Cowork requires the desktop app and has no web or mobile version (search summary; unverified) — [Zapier](https://zapier.com/blog/claude-for-small-business.md); [Appwrite](https://appwrite.io/blog/post/anthropic-just-launched-claude-for-small-business)
- Intuit expanded its QuickBooks connector in Claude and its plugin in ChatGPT with sales invoicing, payroll and lending features, moving past read-only access — [Intuit](https://www.intuit.com/blog/news-social/quickbooks-expands-into-claude-and-chatgpt-with-new-sales-invoicing-payroll-and-lending-features/)
- Anthropic's pre-launch survey of 503 SMB decision-makers found data security was the most-cited barrier to adoption. The launch page says "half" of owners named it as their biggest hesitation — [Claude blog](https://claude.com/blog/what-1-000-small-business-owners-taught-us-about-ai); [Anthropic](https://www.anthropic.com/news/claude-for-small-business)

**OpenAI (ChatGPT Business/Work, apps, connectors, agents)**
- The ChatGPT small business program was announced July 21, 2026. It offers webinars, in-person "Small Business AI Academies", guides, and curated partner plugins, skills and promotions from Dropbox, Shopify, Intuit, Slack, Atlassian, Wix and others. "ChatGPT Work" on GPT-5.6 "completes multi-step tasks end-to-end" with files, apps and memory. No program price was given — [OpenAI](https://openai.com/index/introducing-chatgpt-small-business-program)
- OpenAI's vendor stats: 78% of AI Jam participants built a working workflow in a day, and 42% saved more than 5 hours a week (vendor claim) — [OpenAI](https://openai.com/index/introducing-chatgpt-small-business-program)
- ChatGPT Business is about $20/user/month billed annually or $25 monthly, with a 2-seat minimum. Connectors are included (M365, Google Drive, Slack, GitHub, HubSpot, SharePoint, Box and others). Sources disagree on the headline price — [eesel.ai](https://www.eesel.ai/blog/chatgpt-work-review); [tldv](https://tldv.io/blog/chatgpt-pricing/)
- Agent runs on Business and Enterprise use credit-based rates. Some usage is included, and extra usage can be bought. Agent runs triggered outside ChatGPT (e.g., from Slack) were in free preview until June 2026, with promotional pricing through at least Dec 31, 2026 — [OpenAI Help](https://help.openai.com/articles/11481834)
- An OpenAI help page now says "ChatGPT agent is no longer available" and points users to ChatGPT Work for multi-step tasks. Other OpenAI pages still describe agent mode, so the status conflicts and the page date is unconfirmed — [OpenAI Help](https://help.openai.com/en/articles/11752874-chatgpt-agent)
- OpenAI's consumer agent "dots", along with Meta's Muse and Instinct, can place calls and book appointments with local businesses when the user permits (Oct 2026) — [SF Standard](https://sfstandard.com/2026/10/29/ai-agents-calling-local-businesses/)

**Microsoft (Copilot Business, agents)**
- Microsoft 365 Copilot Business became generally available Dec 2, 2025 at $21/user/month (older evidence). Copilot Studio lets customers build no-code custom agents — [Microsoft](https://www.microsoft.com/en-us/microsoft-365/blog/2025/12/02/microsoft-365-copilot-business-the-future-of-work-for-small-businesses/)
- After July 1, 2026, partner tables list Business Standard + Copilot at about $23-23.50 and Business Premium + Copilot at $32. A Basic + Copilot promo of $21 runs for 1-300 seats through Dec 31, 2026 (partner sources; verify live) — [SoftwareOne](https://www.softwareone.com/en/channel-partner/articles/2026/05/26/lower-copilot-prices-bigger-partner-opportunity); [Microsoft Partner](https://partner.microsoft.com/en-US/blog/article/partner-led-smb-m365-copilot)

**Google (Gemini in Workspace, Gemini Enterprise, phone agent)**
- Gemini Enterprise Business edition starts at $21/seat/month and targets small teams with no IT setup. It includes prebuilt Google agents (e.g., Deep Research) and a no-code Workflow Builder, with a 30-day free trial for up to 300 people. Gemini is now bundled into Workspace plans with higher base prices (2025 reports) — [Google Cloud](https://cloud.google.com/gemini-enterprise/business); [TechRepublic](https://www.techrepublic.com/article/google-workspace-gemini-pricing-plans/)
- Google added a pay-as-you-go option for Gemini Enterprise — [eWeek](https://www.eweek.com/news/google-gemini-enterprise-pay-as-you-go-pricing/)
- "Ask for Me" started as a 2025 Search Labs test in which Google AI phones nail salons and mechanics for prices and availability. At I/O (May 19, 2026, per the article's URL) Google confirmed it would place calls for home repair, beauty and pet care across the US, returning summaries in about 30 minutes. Businesses can opt out, and the AI discloses that it is automated — [TechCrunch 2025](https://techcrunch.com/2025/01/30/googles-ask-for-me-feature-calls-businesses-on-your-behalf-to-inquire-about-services-pricing/); [Retail Insider 2026](https://retail-insider.com/articles/2026/08/when-the-first-customer-to-call-your-business-is-an-ai-assistant/)

**Intuit (QuickBooks agents)**
- Intuit's agents handle "sending invoices, tracking payments, reconciling books, and managing customer leads". Availability varies by QBO plan — [Intuit US help](https://quickbooks.intuit.com/learn-support/en-us/help-article/alerts-notifications/innovations-ai-agents-coming-quickbooks-online/L3AxZPc8R_US_en_US)
- Intuit Intelligence and its AI agents are "currently available at no additional cost" (AU/CA pages) but not on Self-Employed. Terms may change. The CA page says agents work only in English and French — [QuickBooks AU](https://quickbooks.intuit.com/au/blog/accountants-and-bookkeepers/intuit-intelligence-ias/); [QuickBooks CA](https://quickbooks.intuit.com/ca/resources/accountants/your-new-more-powerful-quickbooks/)
- Intuit planned an August 2026 expansion that adds agent-builder tools, QuickBooks Workforce, and a consumption-based model for "AI and human intelligence services", with price increases at the high end. Early adoption was strongest on the Advanced and Plus tiers. No prices were disclosed — [Constellation Research](https://www.constellationr.com/index%2Ephp/insights/news/intuit-plots-ai-agent-expansion-august-consumption-model)

**Xero**
- At Xerocon London (July 2026), JAX "automatically reconciles books and chases invoices". XeroForce lets users build no-code custom agents (early access, GA later in 2026), and receipt-chasing is coming. No pricing was found — [Xero blog](https://blog.xero.com/product-updates/xerocon-london-2026-agentic-era-small-business-finance/)

**Shopify**
- The Fall '26 Edition makes Sidekick multi-step: it stages bulk changes after a single plan approval, edits draft orders, handles print-on-demand, explains payouts and chargebacks, and tests changes with SimGym. Shopify says daily Sidekick sessions grew 4.2x YoY (vendor claim). The edition also adds a storefront shopping agent in Inbox, Campaign Autopilot for ads, AI-generated chargeback responses in Shopify Protect ("rolling out soon"), and store management from ChatGPT, Claude, Gemini, Copilot, Grok and Meta Muse. No AI pricing was found — [Shopify Editions Fall '26](https://www.shopify.com/uk/editions/fall2026)
- The Winter '26 Edition (Dec 2025) had 150+ updates centered on Sidekick and Agentic Storefronts, which place products inside ChatGPT, Perplexity and Copilot — [Shopify](https://www.shopify.com/news/winter-26-edition-renaissance); [Inside Retail](https://insideretail.com.au/digital/sidekick-agentic-storefronts-simgym-how-shopifys-latest-edition-harnesses-ai-202512)

**HubSpot**
- Since April 14, 2026, Breeze Customer Agent costs $0.50 per resolved conversation (50 credits), down from $1 per conversation. Prospecting Agent costs $1 per lead recommended for outreach (100 credits). Both are on Pro and Enterprise only, with a 28-day trial — [HubSpot](https://www.hubspot.com/company-news/hubspots-customer-agent-and-prospecting-agent-now-you-pay-when-the-task-is-complete); [MarTech](https://martech.org/hubspot-moves-to-outcome-based-pricing-for-some-breeze-ai-agents/)
- A third-party guide defines a "resolution" as no handoff to a human for 72 hours. Credits are pooled across agents, and extra credits are about $10 per 1,000 (third-party, unverified) — [eesel.ai](https://www.eesel.ai/blog/hubspot-ai-pricing)

**Salesforce**
- Starter Suite costs $25/user/month. Agentforce costs $2 per conversation or Flex Credits at $500 per 100k credits (about $0.10 per action), plus $5/user/month for an Agentforce user license. UK pricing is £400 per 100k credits and £1.60 per conversation. Pages are undated — [Salesforce Agentforce pricing](https://www.salesforce.com/agentforce/pricing/); [Salesforce Flex Credits](https://www.salesforce.com/blog/flex-credits/)
- One source says Salesforce agreed June 15, 2026 to buy Fin (ex-Intercom) for about $3.6B, closing Sept 10, 2026. This is single-sourced and should be treated as unverified — [DragApp](https://www.dragapp.com/blog/salesforce-buys-fin/)

**Square and Toast (POS verticals)**
- Square launched Squaremates on Nov 12, 2026, replacing the beta Managerbot. It is a business agent for restaurant operators that builds schedules and finds lapsed customers, and it proposes actions for the owner to approve (search snippet; article fetch blocked) — [QSR Magazine](https://www.qsrmagazine.com/news/square-launches-ai-agent-to-help-restaurants-run-their-businesses/)
- Square integrates with ChatGPT and Claude for AI-powered discovery — [Square](https://squareup.com/us/es/press/claude-chatgpt-integrations)
- Toast (Oct 7, 2026):
  - IQ Team costs $60/month plus $9 per employee/month and includes a Scheduling Agent. Toast says beta users had 41% fewer overtime hours per employee (vendor claim).
  - IQ Grow costs $699/month and bundles Marketing, SEO, Reviews and Offers agents.
  - Menu Agent, Answering Agent ("answers the phone") and Configurable Agents are in early access, with no pricing — [Nation's Restaurant News](https://www.nrn.com/restaurant-technology/toast-unveils-an-array-of-new-ai-agents-for-restaurants)
- Toast IQ Grow pilot customers saw +8% sales vs comparable restaurants (vendor claim) — [Nasdaq/Zacks](https://www.nasdaq.com/articles/toast-ai-strategy-will-agents-drive-restaurant-growth)

**Vertical SaaS incumbents moving into phones**
- Freed, an AI scribe, now sells "Front Desk" at $149/month per clinic for 250 calls (Sacra; undated) — [Sacra](https://sacra.com/c/freed/)

### Inferences
- **Already covered by big players, so poor targets:**
  - Inbox triage and drafting
  - Docs, decks and spreadsheet analysis
  - Marketing content and ad campaigns
  - Inbound website chat support
  - CRM lead triage and prospecting
  - Bookkeeping Q&A, reconciliation and invoicing/reminders
  - Month-end prep and payroll planning
  - Store and catalog edits
  - Restaurant scheduling, marketing and reviews
  - Contract review "lite"
  - Business dashboards

  These ship either bundled at about $20-25 per seat or at no added cost inside the system of record. This independently confirms the founder's rejections of invoice chasing, the month-end desk and a generic SMB agent.
- **The approval gate is no longer a differentiator.** Anthropic, Shopify, Square, Toast and Xero all now market "you approve before it sends or pays". The engine's differentiators have to come from local data and on-device execution, a durable audit trail as evidence, sandboxed niche skills, and reach into channels or software the suites don't touch.
- **The phone is being contested from both ends.** Consumer agents (Google Ask for Me, OpenAI dots, Meta Muse) call businesses, while POS and vertical incumbents (Toast, Freed, Square) answer for businesses. A generic SMB receptionist is becoming crowded. A niche where the agent makes multi-party outbound calls for a professional (insurers, agencies, payers, landlords, government offices) and documents them is less covered.
- **Big-player SMB launches are US-first.** Anthropic's tour, OpenAI's academies and Google's Ask for Me are all US-only. Intuit's agents are English- and French-only. There is a window in EU languages, EU-specific procedures and EU data-residency-sensitive professions. This is an inference from launch geography, not proof of EU absence.

### Gaps
- Apple: no 2025-2026 small-business or prosumer agent offering turned up in this session. Apple Intelligence's business relevance was not researched.
- No published price was found for Claude for Small Business or Cowork, Xero JAX or XeroForce, Shopify Sidekick, or Square Squaremates. Live US Copilot and Workspace prices after July 2026 were not verified on first-party pricing pages.
- Microsoft's agent lineup in the Business SKU (Researcher, Analyst, Agent Mode) is not confirmed on the GA page.
- EU availability of Claude Cowork and Claude for Small Business, and of ChatGPT Work's agentic features, could not be confirmed.

---

## Q2. Where do general agents still fail (reliability, long-running work, phone/paper, local regulation, liability, legacy software, sensitive data)?

### Takeaway
Benchmarks and field reports agree on three points. Frontier agents now complete a meaningful but small share of real end-to-end professional jobs: the best score on the Remote Labor Index rose from 2.5% in Oct 2025 to about 16% in mid-2026, per secondary reports. They still loop, stall at logins and payments, and need a human to check their output. Phone and real-world transactions remain weak; in one restaurant group's experience, no AI agent had ever completed a reservation. Trust and data security are still the top stated SMB barrier. EU rules add obligations to disclose AI interactions (in force Aug 2, 2026) and to comply with platform rules. For liability-bearing work, the regulatory precedent is to punish "as good as a lawyer" claims made without evidence.

### Cited Findings

**End-to-end reliability on real work**
- Remote Labor Index (Scale AI + CAIS, Oct 2025): every model automated under 3% of real freelance projects, and the best reached 2.5%. "Automation" means the deliverable was judged at least as good as the professional's, with 94.4% inter-annotator agreement — [arXiv](https://arxiv.org/abs/2510.26787v1); [Scale Labs](https://labs.scale.com/papers/rli)
- Reported July 2026: the top model ("Fable 5") scored 16.1% on RLI, about double the runner-up ("Opus 4.8"). The frontier more than quadrupled in under 8 months. This is secondary coverage and was not verified on the leaderboard — [The Decoder](https://the-decoder.com/ai-agents-can-now-complete-16-percent-of-freelance-jobs-at-pro-quality-up-from-2-5-percent-eight-months-ago/); [Inbenta](https://www.inbenta.com/ai-this-week/ai-agents-now-automate-1-in-6-freelance-jobs-as-fable-5-shatters-cais-remote-labor-index-records)
- In a hands-on review (2025, older evidence), ChatGPT agent was slower than doing the task by hand and repeatedly got stuck in loops until the reviewer stepped in — [Android Authority](https://www.androidauthority.com/chatgpt-agent-review-3583538/)
- OpenAI's documentation says the agent pauses at logins and asks the user to take over the browser. It "may need to restart" if the handback fails. OpenAI warns of prompt injection and advises against typing passwords into chat — [OpenAI Help](https://help.openai.com/en/articles/11752874-chatgpt-agent)
- Claude Cowork reviews list the common problems as usage limits, permissions and unverified output. Error messages are "technical and alarming" for non-technical owners, and getting started is the hardest part. Recommended practice is to keep the first tasks reversible — [eesel.ai](https://www.eesel.ai/blog/claude-cowork-review); [Graduate School USA](https://www.graduateschool.edu/learn/ai/claude-cowork-limitations); [Duke DDMC](https://sites.duke.edu/ddmc/2026/02/24/what-claude-cowork-actually-does-and-what-it-doesnt/)

**Enterprise and analyst signals**
- Gartner (June 2025, older) predicts over 40% of agentic AI projects will be canceled by the end of 2027 because of cost, unclear value or weak risk controls. It also estimates only about 130 of thousands of "agentic" vendors are real ("agent washing") — [Gartner](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)
- An unclear ROI case is slowing broad Microsoft 365 Copilot rollouts (article date unconfirmed) — [Computerworld](https://www.computerworld.com/article/4119325/why-ai-assistants-still-face-barriers-at-scale.html)
- Gartner published "Microsoft 365 Copilot and Agents: Assessing Impact and Value in 2026" on June 9, 2026. Only the abstract was found — [Gartner](https://www.gartner.com/en/conferences/apac/digital-workplace-japan/sessions/detail/5654497-Microsoft-365-Copilot-and-Agents-Assessing-Impact-and-Value-in-2026)

**Phone and real-world transactions**
- SF Standard (Oct 29, 2026) on consumer agents calling local businesses:
  - Lazy Bear Restaurant Group's COO said no AI agent has ever successfully made a reservation at its restaurants. Agents get stuck at payment, repeat themselves and misunderstand replies. She worries agent calls will tie up staff.
  - Voygr's agents called 848 SF businesses. About 1 in 3 stayed on the line after learning it was an AI, and about 1 in 25 businesses already had their own AI answering.
  - Vets and dentists were most likely to keep talking. Dry cleaners and bars were most likely to hang up. Owners complained that agents don't identify who built them.
  — [SF Standard](https://sfstandard.com/2026/10/29/ai-agents-calling-local-businesses/)
- Google's early Ask for Me test reported it "couldn't reach" some salons (2025) — [Business Insider NL](https://businessinsider.nl/i-tried-googles-new-tool-that-calls-businesses-for-you-to-get-information-heres-how-helpful-it-actually-is)
- In a OnePoll survey, 31% of people hang up immediately on reaching an automated system — [Briefglance](https://briefglance.com/articles/the-hidden-toll-of-voice-ai-when-bots-forget-why-they-called). An AnswerConnect/OnePoll survey of 6,000 adults found about a third do — [Entrepreneur](https://www.entrepreneur.com/growing-a-business/stop-losing-500-a-month-the-mistake-starts-with-a/491642)
- Tenyx, a voice-AI vendor, says about 7 in 10 people are frustrated with automated voice agents (vendor-run) — [Chain Store Age](https://chainstoreage.com/survey-automated-voice-agents-lead-frustrated-customers-turnover)
- Voice-agent failure modes in field write-ups:
  - Invalid bookings, wrong hours and double-bookings when calendar integration is shallow
  - Mispronounced product names and wrong caller names
  - Hanging up because the agent "believes its job is finished"
  - One owner's anecdote: 22% of calls escalated to a human
  — [Marchex](https://www.marchex.com/avoiding-the-top-ai-agent-pitfalls-lessons-from-millions-of-customer-calls/); [Open University guide](https://www.open.edu/openlearncreate/mod/page/view.php?id=244418); [Lilach Bullock](https://www.lilachbullock.com/ai-answering-phone-small-business/)

**Liability-bearing tasks**
- The FTC finalized its DoNotPay order on Jan 16, 2025 (older evidence). It requires $193k in monetary relief and notice to 2021-2023 subscribers, and bars claims of matching a human lawyer without evidence. The FTC said the "robot lawyer" failed to live up to claims that it was an adequate substitute for a lawyer — [FTC](https://www.ftc.gov/system/files/ftc_gov/pdf/DoNotPayInc-APCOAPC.pdf); [MLex](https://www.mlex.com/mlex/amp/articles/2296777)

**EU vs US: regulation and availability**
- ChatGPT Agent and Operator launched excluding the EEA in 2025 (older evidence). Reported reasons were GDPR, the DMA and the AI Act — [Trending Topics](https://www.trendingtopics.eu/openai-fuehrt-ki-agenten-operator-in-mehreren-laendern-ein-eu-ausgenommen); [DataStudios](https://www.datastudios.org/post/chatgpt-agent-appears-in-europe-despite-no-formal-announcement)
- On Aug 31, 2026, the European Commission designated ChatGPT a very large online search engine under the DSA, with four months to comply — [Irish Times](https://www.irishtimes.com/business/2026/08/31/chatgpt-faces-tougher-rules-under-eu-online-safety-regime/)
- The AI Act Digital Omnibus (Regulation (EU) 2026/1744, in force July 27, 2026) has these effects:
  - It moves stand-alone Annex III high-risk obligations to Dec 2, 2027 and Annex I to Aug 2, 2028.
  - Article 50 transparency duties, including telling people they are interacting with AI, stay in force from Aug 2, 2026.
  - The only grace period is for 50(2) generative-AI marking of systems already on the market, which runs to Dec 2, 2026.
  - One Goodwin line conflicts and suggests a longer delay.
  — [Goodwin](https://www.goodwinlaw.com/en/insights/publications/2026/08/alerts-technology-dpc-eu-ai-act-transparency-obligations-now-in-force); [Gibson Dunn](https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines/); [Orrick](https://www.orrick.com/en/Insights/2026/05/EUs-Digital-Omnibus-on-AI-7-Key-Changes-You-Need-to-Know)

**Language and locale**
- Intuit's AI agents process only English and French (CA page) — [QuickBooks CA](https://quickbooks.intuit.com/ca/resources/accountants/your-new-more-powerful-quickbooks/)

### Inferences
- **Reliability is the product.** With about 16% end-to-end automation on hard professional work, a narrow, scripted, auditable workflow will beat open-ended agents for customers who pay for outcomes. The engine fits this pattern: a human approves before outside effects, there is an audit log, and skills are sandboxed. It should be sold as "we do X to a known standard and prove it", not "an agent that can do anything".
- **Phone, payment and multi-party channels are where general agents fail most visibly** (stalled at payment, hung up on, unidentified). There is room for a vertical agent that can show identity, consent and logs. Examples: calls to insurers, carriers, benefit offices or landlords for a professional, with transcripts in the audit log. In the EU, Article 50 disclosure is now mandatory, which favors vendors with built-in disclosure and logging.
- **Liability-bearing work** (legal, tax, medical claims) needs a human professional in the loop and evidence-backed marketing (DoNotPay precedent). Two structures fit: tools *for* licensed professionals, or contingency services where the human signs.
- **Sensitive data and local execution** remain top SMB concerns. Anthropic's own survey found data security the top barrier. This supports a desktop and local-data angle, especially for EU professionals. The supporting evidence here is survey-based, not proof of willingness to pay.

### Gaps
- No rigorous independent study of SMB voice-agent error rates (wrong bookings, hallucinations) was found.
- No 2026 survey specifically measuring SMB disappointment with Copilot, Gemini or ChatGPT agents was found.
- Integration failures with legacy or niche desktop software (e.g., practice-management systems without APIs) were not documented in this session. They are an open hypothesis.
- A widely repeated test claims Claude for Small Business found 17 of 20 seeded P&L errors in about 6 minutes. Its original outlet was not verified, so it is excluded from the findings.
- The US position on AI voice calls (FCC/TCPA consent for AI-voiced outbound calls) was not verified in this session. It needs checking before any outbound-calling niche.

---

## Q3. Which small or bootstrapped AI companies reached real revenue ($1M-$50M ARR) serving SMBs, professionals or consumers, and how do they price?

### Takeaway
The clearest $10M-$50M ARR wins share a profile. They serve one professional persona, sell self-serve or bottom-up at about $28-$120 per user per month, and replace a painful daily chore (Freed for clinicians, Fyxer for email). Both now face bundling by platforms: free scribes and Gmail/Copilot. Bigger outcome-tied vertical players go much further: EvenUp has about $150M in contracted revenue in plaintiff law, and Avoca is at a $1B valuation in trades phone answering. Contingency businesses (Chargeflow at 25%, Ownwell at 25-35%, AirHelp at 35%) show strong willingness to pay where money is recovered. Bootstrapped examples at $1M+ ARR exist, but they are mostly horizontal tools sold self-serve with self-reported numbers.

### Cited Findings

**Professional-persona, bottom-up subscription**
- **Freed** (AI scribe for independent clinicians; Sacra estimates):
  - ARR went from about $1M to $13M in the year ending Aug 2024, then $19M in Mar 2025, about $27M at end-2025 (+66% YoY), and about $33M in Aug 2026 (+22% YTD). Growth slowed as free alternatives spread.
  - Pricing was originally $99/month (about $1K ACV after discounts). Current tiers are $39 (40 notes), $79 (unlimited) and $119 per month per clinician. Front Desk costs $149/month for 250 calls.
  - It sells PLG/self-serve with a BAA at signup.
  - It raised a $4M seed in Nov 2023 and a $30M Series A from Sequoia in Mar 2025, about $34M in total. Sacra describes a "lean team" with no headcount.
  — [Sacra](https://sacra.com/c/freed/); [Sacra $19M](https://sacra.com/research/freed-at-19m-arr/); [BusinessWire](https://www.businesswire.com/news/home/20250305397400/en/Freed-Secures-30M-Series-A-Led-by-Sequoia-Capital-to-Free-Clinicians-from-Administrative-Burdens-with-AI-Assistant)
- **Freed's competitive pressure:** OpenEvidence and Doximity offer free scribes, Epic has native AI Charting, and Heidi offers a free unlimited tier. For scale comparison, Abridge reached about $100M ARR and a $5.3B valuation in 2025, and Ambience about $30M ARR and $1B — [Sacra](https://sacra.com/c/freed/)
- **Fyxer AI** (email and meeting assistant for executives and professionals):
  - ARR was $1M in Dec 2024. Startups Magazine reports $17M and 180k+ users within about 7 months. Entrepreneur UK reports $25M ARR in 10 months. Simplify Jobs and ARR trackers report $35M by May 2026 (secondary). Sacra's lower figure is $9M in 2025, so sources conflict.
  - Pricing is about $28 per user per month (Standard).
  - Risk: Gmail/Gemini and Copilot compete directly.
  — [Startups Magazine](https://startupsmagazine.co.uk/article-fyxer-ai-secures-30m-expand-ai-executive-assistant-platform); [Entrepreneur UK](https://uk.entrepreneur.com/?p=6760); [Simplify](https://simplify.jobs/c/Fyxer); [Sacra](https://sacra.com/research/fyxer-ai-9myr-glean-for-white-collar-contractors); [Madrona](https://www.madrona.com/fyxer-ai-productivity-tools-for-email-and-meetings/)

**Outcome-tied professional and vertical (larger, VC-backed; reference points)**
- **EvenUp** (personal-injury demand letters): about $150M in contracted recurring revenue (Business Insider interview via secondary coverage). It serves 2,000+ law firms and raised $150M in Oct 2025 — [Sacra](https://sacra.com/c/evenup/); [Artificial Lawyer](https://www.artificiallawyer.com/2025/10/07/plaintiff-bar-ai-takes-off-evenup-bags-150m/)
- **Eve** (plaintiff law): roughly 2,000 firms (up from 1,400+). It reported 10x revenue growth as of Jan 2026, and Sacra estimates about $500 per attorney per month. **Supio** doubled customers in H1 and raised $60M in Apr 2025. Sacra calls the plaintiff-AI category competitive and fragmented — [Sacra Eve](https://sacra.com/research/eve); [Dealroom](https://dealroom.co/companies/eve-legal/)
- **Avoca** (voice agents for HVAC, plumbing, roofing and electrical): raised $125M+ at a $1B valuation (Apr 27, 2026) and has 800+ customers. It says it is "on track to book $1B in jobs in 2026" (company projection). It is expanding into outbound and integrations beyond ServiceTitan. No ARR was disclosed — [Avoca](https://www.avoca.ai/blog/avoca-raises-125m-series-b-1b-valuation); [Kleiner Perkins](https://www.kleinerperkins.com/perspectives/avoca-bringing-ai-to-the-backbone-of-the-real-economy/); [TheAIInsider](https://theaiinsider.tech/2026/04/29/avoca-closes-125m-at-1b-valuation-to-power-americas-services-economy-with-ai/)
- **Intercom Fin** (AI support agent): $0.99 per outcome, down from $1.90. Sacra estimates it passed $100M ARR growing about 350% per year. Dealroom puts it at about $110M within about $400M company revenue in Apr 2026 (estimates) — [Sacra](https://sacra.com/research/intercom); [Dealroom](https://dealroom.co/charts/fin-intercom)

**AI receptionist / SMB phone (pricing anchors)**
- Smith.ai AI Receptionist starts at $150/month for 75 calls (about $2 per call). Marlie AI costs $49/month. Sameday costs $449/month for 500 minutes, done-for-you (vendor pages via blog roundups, mid-2026) — [Techloy](https://www.techloy.com/8-best-ai-receptionists-for-home-services-in-2026/); [JustCall](https://justcall.io/blog/best-ai-receptionist-for-hvac.html)
- Newo raised $25M (Feb 2026) for SMB AI receptionists — [Pulse](https://www.pulse.bot/saas/news/newo-lands-25m-to-bring-production-ready-ai-receptionists-to-small-businesses-42280009-75ba-4fff-98fc-c219c5830403)
- Acrely (YC) pivoted from real-estate scheduling to home services after inbound demand and signed 6 customers in 2 weeks — [YC Launch](https://www.ycombinator.com/launches/OH3-acrely-the-ai-customer-service-representative-for-home-services)

**Contingency / % of recovered money**
- **Chargeflow** takes 25% of recovered chargebacks, with no fee on lost disputes. Other products: Alerts at $29 per deflected chargeback, Prevent at $0.20 per scanned transaction. It claims $200M+ recovered for 20k+ businesses (vendor claim; an older page says $100M+) — [Chargeflow pricing](https://www.chargeflow.io/pricing); [Redo](https://redo.com/resources/articles/comparisons/chargeflow-pricing)
- Disputifier charges 20% of recovered revenue, capped at $250 per won chargeback. Many players publish no rate — [Redo](https://redo.com/resources/articles/chargebacks/chargeback-recovery)
- **Ownwell** (property-tax appeals) charges a 25-35% contingency on savings, depending on state.
  - Performance: average savings of $774 a year, with an 86-88% success rate (company/affiliated sources).
  - Funding: a $50M Series B in Feb 2026, $74M in total.
  - Footprint: about 7-9 states.
  - Criticisms: the fee recurs every year taxes fall, even when the drop is market-driven, and counties say appeals can be filed free.
  — [Inman](https://www.inman.com/2026/02/25/ownwell-raises-50m-to-grow-its-property-tax-appeal-fintech/); [AppealDesk](https://www.appealdesk.com/blog/ownwell-pricing-review); [AJC](https://www.ajc.com/news/2025/07/some-companies-offer-paid-help-with-taxes-county-officials-say-its-free)
- **AirHelp** (EU261 flight compensation, an EU-specific market) charges 35% incl. VAT, plus 15% if it goes to court, capped at 50%. The AirHelp+ membership starts at £39 or €39.99 a year. AirAdvisor charges 30%, and FlightCompensations a flat €39 — [AirHelp](https://www.airhelp.com/en-int/our-fees); [IBTimes UK](https://www.ibtimes.co.uk/best-flight-compensation-companies-europe-uk-compared-1829519)

**Bootstrapped / small-team examples (self-reported)**
- ParakeetAI (real-time AI call assistant) reported $1M MRR about 2 years after its 2024 start, bootstrapped with a "very small team" and organic distribution — [Indie Hackers](https://www.indiehackers.com/post/YRaa1QlGTjaqh0XgzWkc)
- Happier Leads went from $50K to $1.5M ARR with zero employees in about 2 years, using self-built AI agents for support and engineering — [Indie Hackers](https://www.indiehackers.com/post/igZlngx39s8WnbclJ9NM)
- Zernio crossed $1M ARR within about 10 months via self-serve — [Indie Hackers](https://www.indiehackers.com/post/42RGhUiSGBTIdX6zLsaD)
- Chatbase is a bootstrapped AI chatbot-agent business built on self-serve and content marketing — [StartupHub](https://www.startuphub.ai/news/chatbase-ceo-on-ai-chatbots-and-bootstrapping-growth)
- Outward Intelligence hit $1M bootstrapped. Its founders knew the market's pain points and automatable tasks before building (June 2026) — [eWeek](https://www.eweek.com/news/outward-intelligence-ai-startup/)

**VC / benchmark frame**
- Bessemer State of AI (Aug 2025, older) benchmarks two cohorts:
  - "Shooting Stars": about $3M ARR in year 1, $12M in year 2 and $40M in year 3, with about 60% gross margin and about $164K ARR per FTE in year 1.
  - "Supernovas": about $40M in year 1 and $125M in year 2, but with about 25% gross margin (often negative) and fragile retention.
  — [Bessemer](https://www.bvp.com/atlas/the-state-of-ai-2025)
- a16z with Mercury (Oct 2025) found startup AI spend is about 60% horizontal and 40% vertical apps, and predicted "AI-native services businesses" — [a16z](https://a16z.com/the-ai-application-spending-report-where-startup-dollars-really-go/)
- a16z's State of Markets (about Sept 2026; secondary) says only about 2% of US households pay for AI services — [Crypto Briefing](https://cryptobriefing.com/us-households-pay-ai-services-a16z/)
- YC RFS:
  - Spring 2026 included "AI-native agencies" and Summer 2026 "AI-native service companies" (secondary summaries) — [Inc.](https://www.inc.com/ben-sherry/y-combinator-just-released-its-latest-startup-wishlist-heres-every-idea-it-has-for-founders/91297137); [Modelence](https://modelence.com/yc-rfs-summer-2026/ai-native-service-companies)
  - The current Winter 2027 list includes "The $15-an-Hour Expert" ("anywhere a credential is the bottleneck, this model works"), "AI for City Hall" (permits and inspections), "AI for the Air-Gapped Economy" (on-prem frontier AI for banks, hospitals and defense: "slower and harder to sell… where the largest budgets and the most defensible companies are"), and "Plaid for Government Benefits" — [YC RFS](https://www.ycombinator.com/rfs)

### Inferences
- **Two viable shapes for a 2-5 engineer team:**
  - A single-persona professional tool at $40-$150 per user per month, sold self-serve. Freed and Fyxer show this can reach $10M-$35M, but it carries high platform-absorption risk.
  - An outcome or contingency service in a money-recovery niche (Chargeflow, Ownwell, AirHelp pattern), where the agent does the paperwork and the audit log is the evidence trail.

  The second shape fits the engine better: approval before outside effects, plus logs that support the claim and dispute paper trail.
- **Areas to avoid:**
  - SMB voice receptionists for home services, now crowded (Avoca's $1B and 800+ customers, Newo, Smith.ai, plus incumbent POS and vertical SaaS answering agents).
  - Generic clinician scribing (free bundles).
  - Plaintiff PI demand letters (EvenUp, Eve and Supio, well funded).
- **YC's "Air-Gapped Economy" and "$15-an-hour expert" theses** line up with a local-data, desktop, sandboxed, audited engine. The likely buyers are small regulated practices (EU especially) that can't or won't send data to US clouds. This is an inference to validate, not observed revenue.

### Gaps
- Team sizes, CAC and gross margin for Freed, Fyxer, Chargeflow and Ownwell were not disclosed in the sources found.
- No EU-native vertical AI company with disclosed $1M-$50M ARR was found in this session (e.g., EU practice-software or claims startups).
- Revenue for Ownwell, Chargeflow and AirHelp was not found, only fee models and claims.
- No data was found on Amazon FBA reimbursement services, R&D tax-credit AI firms, medical-billing denial-appeal startups, or Rocket Money's bill-negotiation fee.
- Most Indie Hackers figures are self-reported, and several posts are paywalled.

---

## Q4. Which pricing models show the highest SMB willingness to pay (outcome, contingency, replacing a hire or service)? What is the evidence for "service-as-software"?

### Takeaway
Big platforms are converging on per-outcome AI pricing at $0.50-$2 per resolved conversation (HubSpot, Intercom, Salesforce), against roughly $10-15 for a human-handled resolution (est.). That suggests SMBs accept pay-per-result, but unit prices on commodity tasks are being driven toward cost. The highest observed take rates are in contingency on recovered money: 20-35% of the recovery, sometimes capped. Vertical "AI employee" bundles cluster around $150-$700 per month (Smith.ai $150, Sameday $449, Toast Grow $699), well above $20 seat pricing. Retention data shows products above $250 per month retain like normal B2B SaaS, while those under $50 churn heavily.

### Cited Findings
- **Per-resolution and per-outcome pricing:**
  - HubSpot charges $0.50 per resolved conversation and $1 per qualified prospecting lead (Apr 2026) — [HubSpot](https://www.hubspot.com/company-news/hubspots-customer-agent-and-prospecting-agent-now-you-pay-when-the-task-is-complete)
  - Intercom Fin charges $0.99 per outcome (down from $1.90), with a 50-outcome monthly minimum (about $49.50) when standalone on Zendesk or Salesforce — [Featurebase](https://www.featurebase.app/blog/fin-ai-pricing.md); [Sacra](https://sacra.com/chat/h/a419a844-b238-4e9d-94c0-bae80585618f/)
  - Salesforce charges $2 per conversation, or $0.10 per action via Flex Credits (a conversation is about 3-6 actions, or $0.30-$0.60) — [Salesforce](https://www.salesforce.com/blog/flex-credits/)
  - AI resolutions cost about $0.99-$1.50 vs $10-$15 for a human-handled resolution (third-party estimate) — [Sacra](https://sacra.com/chat/h/ea6794a1-b8c6-4d1b-998d-0f9297e7fd59/)
- **Consumption models from systems of record:** OpenAI uses credit-based agent runs — [OpenAI Help](https://help.openai.com/articles/11481834). Google offers pay-as-you-go Gemini Enterprise — [eWeek](https://www.eweek.com/news/google-gemini-enterprise-pay-as-you-go-pricing/). Intuit is moving to a consumption model for "AI and human intelligence services" — [Constellation](https://www.constellationr.com/index%2Ephp/insights/news/intuit-plots-ai-agent-expansion-august-consumption-model)
- **Contingency:** Chargeflow 25%; Disputifier 20% capped at $250 per win; Ownwell 25-35% of tax savings; AirHelp 35% (up to 50% with legal action); AirAdvisor 30% — [Chargeflow](https://www.chargeflow.io/pricing); [Redo](https://redo.com/resources/articles/chargebacks/chargeback-recovery); [AppealDesk](https://www.appealdesk.com/blog/ownwell-pricing-review); [AirHelp](https://www.airhelp.com/en-int/our-fees); [IBTimes UK](https://www.ibtimes.co.uk/best-flight-compensation-companies-europe-uk-compared-1829519)
- **Membership as an alternative to contingency:** AirHelp+ from €39.99 a year removes percentage fees, and FlightCompensations charges a flat €39 per passenger. Even contingency markets see flat-fee competition — [AirHelp](https://www.airhelp.com/en-int/our-fees); [IBTimes UK](https://www.ibtimes.co.uk/best-flight-compensation-companies-europe-uk-compared-1829519)
- **"Replace a hire or service" bundles:**
  - Toast IQ Grow at $699/month is positioned against hiring a marketer — [NRN](https://www.nrn.com/restaurant-technology/toast-unveils-an-array-of-new-ai-agents-for-restaurants)
  - AI receptionists: Smith.ai $150/month for 75 calls; Sameday $449/month for 500 minutes, done-for-you — [Techloy](https://www.techloy.com/8-best-ai-receptionists-for-home-services-in-2026/)
  - Freed Front Desk: $149/month for 250 calls — [Sacra](https://sacra.com/c/freed/)
  - Avoca frames its value as jobs booked ("$1B in jobs in 2026", a projection) rather than seats — [TheAIInsider](https://theaiinsider.tech/2026/04/29/avoca-closes-125m-at-1b-valuation-to-power-americas-services-economy-with-ai/)
  - Eve charges about $500 per attorney per month (Sacra estimate) — [Sacra](https://sacra.com/research/eve)
- **Price and retention:** AI-native products above $250/month see 70% GRR and 85% NRR, the same as B2B SaaS. At $50-249 they see 45% GRR and 61% NRR. Below $50 they see 23% GRR and 32% NRR (ChartMogul, Dec 2025, about 200 AI-native companies; directional) — [ChartMogul](https://chartmogul.com/reports/saas-retention-the-ai-churn-wave/)
- **Thesis framing:** a16z's vertical SaaS series argues AI turns "labor into software" and that labor spend dwarfs software spend (2024) — [a16z](https://a16z.com/vertical-saas-now-with-ai-inside/). Secondary coverage of a Jan 2026 a16z piece describes pricing moving to outcomes over seats (original not found) — [Huxiu](https://m.huxiu.com/article/4828027.html)

### Inferences
- **Highest durable willingness to pay comes in three forms:**
  1. A contingency share of money the SMB or consumer would not otherwise recover, at 20-35%.
  2. A flat monthly price of $250-$700 or more, positioned against a named service or hire.
  3. Per-outcome pricing only where the outcome is high-value (a job booked, a claim won) rather than a commodity chat resolution, which is heading toward about $0.50.
- **Seat pricing under $50 is the worst position.** It competes with $20-25 bundled suites and shows the worst retention.
- **Contingency needs verifiable outcomes and an evidence trail.** The audit log and human-approval design map directly onto claim, dispute and appeal workflows.
- **Contingency also carries reputational risk.** Ownwell's recurring fee draws criticism, and counties point out that appeals can be filed free. Fee caps or a flat membership option reduce that risk.

### Gaps
- No independent dataset compares SMB conversion or retention under outcome vs seat pricing.
- No margin data was found for contingency AI businesses (e.g., the cost to process one claim).
- The US vs EU difference in contingency-fee acceptance and in rules on claims-management firms was not researched. UK and EU claims-management regulation may matter.

---

## Q5. What are the common failure patterns of AI-for-SMB startups (churn, CAC, low ACV, platform risk)?

### Takeaway
There are four dominant failure patterns. (1) Low-priced AI products churn fast, with GRR around 23% under $50/month and annual retention of 21% for AI apps. (2) Platforms absorb the wedge: free scribes, Gmail/Copilot assistants, and POS and accounting agents at "no additional cost". (3) Unit prices for commodity outcomes collapse to about $0.50 per resolution. (4) Agentic projects die from unclear value and cost, and the market is full of "agent-washed" vendors. Vertical players that survive move from a thin feature to workflow and system-of-record depth, or tie price to outcomes.

### Cited Findings
- **Churn:**
  - AI-native median GRR was 40% and NRR 48% vs 82% median NRR for B2B SaaS (2025, $250k+ ARR companies). Drivers are "AI tourists", products that are easy to buy and easy to cancel, usage revenue booked as recurring, and platforms absorbing thin wrappers — [ChartMogul](https://chartmogul.com/reports/saas-retention-the-ai-churn-wave/); [Growth Unhinged](https://www.growthunhinged.com/p/the-ai-churn-wave)
  - Mobile AI apps had 21.1% annual retention vs 30.7% for non-AI apps across 3,519 AI apps (Mar 2026) — [RevenueCat](https://www.revenuecat.com/blog/growth/ai-app-retention-study); [TechCrunch](https://techcrunch.com/2026/03/10/ai-powered-apps-struggle-with-long-term-retention-new-report-shows)
  - SMB SaaS monthly churn is typically 2-4% vs 0.3-0.8% for enterprise (blog benchmark) — [Userpilot](https://userpilot.com/blog/customer-churn/)
- **Platform absorption:**
  - Freed's growth slowed from +66% (2025) to +22% YTD (2026) as OpenEvidence, Doximity, Epic and Heidi offered free or native scribes — [Sacra](https://sacra.com/c/freed/)
  - Fyxer faces Gmail/Gemini and Copilot — [Simplify](https://simplify.jobs/c/Fyxer)
  - Intuit agents ship at "no additional cost" — [QuickBooks AU](https://quickbooks.intuit.com/au/blog/accountants-and-bookkeepers/intuit-intelligence-ias/)
  - Square's Canada assistant is free — [Square CA](https://squareup.com/ca/fr/press/square-ai)
  - A critic expects voice agents to be commoditized by the frontier labs by 2027 (single, low-authority source) — [Enterprise DNA](https://enterprisedna.co/resources/news/avoca-voice-ai-trades-unicorn-2026)
- **Price compression on commodity outcomes:** HubSpot halved its price from $1 to $0.50 per resolution, and Intercom cut from $1.90 to $0.99 — [HubSpot](https://www.hubspot.com/company-news/hubspots-customer-agent-and-prospecting-agent-now-you-pay-when-the-task-is-complete); [Sacra](https://sacra.com/chat/h/a419a844-b238-4e9d-94c0-bae80585618f/)
- **Value, cost and agent-washing:** Gartner expects over 40% of agentic projects to be canceled by 2027, and estimates only about 130 "real" agentic vendors (2025) — [Gartner](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)
- **Thin margins at hypergrowth:** Bessemer's "Supernovas" run about 25% gross margin, often negative, on inference costs, vs about 60% for "Shooting Stars" (2025) — [Bessemer](https://www.bvp.com/atlas/the-state-of-ai-2025)
- **Low consumer willingness to pay:** about 2% of US households pay for AI services (secondary report of a16z, 2026) — [Crypto Briefing](https://cryptobriefing.com/us-households-pay-ai-services-a16z/)
- **Regulatory and claims risk:** the FTC's DoNotPay order bars unsupported "substitute for a lawyer" claims and imposed $193k in relief — [FTC](https://www.ftc.gov/system/files/ftc_gov/pdf/DoNotPayInc-APCOAPC.pdf). Contingency players face "you could do this free" criticism — [AJC](https://www.ajc.com/news/2025/07/some-companies-offer-paid-help-with-taxes-county-officials-say-its-free)
- **Small-business market structure:** about 96% of small businesses have under $1M in annual revenue (Mastercard, quoted Oct 2026). This implies low ACV ceilings for micro-SMBs — [SF Standard](https://sfstandard.com/2026/10/29/ai-agents-calling-local-businesses/)
- **Onboarding friction:** Cowork's own small-business users name getting started as the hardest part — [eesel.ai](https://www.eesel.ai/blog/claude-cowork-review)
- **Done-for-you setup:** vendors like Sameday include setup in the price — [Techloy](https://www.techloy.com/8-best-ai-receptionists-for-home-services-in-2026/)

### Inferences
- **For a 2-5 engineer team, the main risks are low ACV plus SMB churn plus platform bundling.** Mitigations:
  - Price at or above about $250/month, or take a contingency share.
  - Pick workflows the suites structurally avoid: liability-bearing, multi-party phone or paper, legacy desktop software, EU-local data, and niche procedures in local languages.
  - Own the evidence trail, since the audit log can become a compliance or claims record that is costly to switch away from.
- **Avoid wedges that sit inside a system of record's own UI,** such as POS, QuickBooks or Xero, Shopify, or the EHR. Those vendors are bundling agents at no added cost.
- **Done-for-you onboarding** (setup as part of the price) seems necessary for non-technical SMB buyers. It raises CAC and cost to serve. A professional buyer (lawyer, clinician, broker, property manager) is likely cheaper to reach through associations or niche software marketplaces than a generic SMB. This is an inference; no CAC data was found.

### Gaps
- No CAC or payback data for AI-for-SMB startups was found in this session.
- No documented shutdowns or post-mortems of specific AI-for-SMB startups from 2025-2026 were found. That would strengthen this section.
- No evidence was found on whether incumbent bundling has measurably increased churn at specific standalone vendors, beyond Freed's growth slowdown.
