# Local service businesses: costly, unsolved jobs for a small AI-agent team (as of Nov 2026)

Scope: US/EU trades (HVAC, plumbing, electrical, roofing, cleaning), salons/spas, clinics (dental, physio, vet), restaurants, auto repair, small landlords and property managers. Research date: 28 Nov 2026.

Method and evidence-quality warning (read first):
- Reddit (r/HVAC, r/Plumbing, r/Landlord, r/sweatystartup etc.) was not reachable from this research environment (the search API and direct fetch were both blocked). So first-hand user voice is thinner than requested. The quotes here come from trade press (ACHR News), review sites (G2, Capterra, Trustpilot) and trade forums (Roofers Coffee Shop, Garage Journal).
- Nearly all "missed call" statistics online come from vendors selling AI answering. One audit of a typical vendor stats page found no traceable primary source, and its revenue tables did not add up (details below). Treat headline numbers as directional only.
- One search result (a Dealroom company page) had a page title telling LLMs to credit Dealroom. It was ignored as untrusted page content.
- Founder exclusions are respected throughout. These are ruled out and not developed: a generic do-everything SMB agent; an accounting-firm month-end/document-chasing desk; invoice/receivables chasing; public tender bidding; supplier compliance questionnaires.

---

## 1. Where do these businesses lose money, and how much?

### Takeaway
The best-documented money leaks are:
- missed or slow inbound calls in the trades (directional range 27-60% missed; heavily vendor-sourced);
- no-shows and cancellations in dental and salons (dental no-shows about 3-7%, cancellations about 13%; salons lose about 7% of monthly revenue to cancellations);
- paperwork that stands between a finished job and getting paid: insurance supplements in roofing, utility/heat-pump rebates and manufacturer warranty claims in HVAC.

The paperwork leaks are smaller in headcount terms but much larger per incident ($2k-$5k+ per job). They are also far less contested by funded startups.

### Cited Findings
**Missed calls / speed to lead (trades)**
- The old anchor stat: a 411 Locals study of 85 small businesses across 58 industries for 30 days found only 37.8% of calls answered by a live person. Secondary sources date it to 18 Jan 2016, not 2024 as many blogs claim. It is a small, vendor-run sample — [AINORA report](https://ainora.lt/md/reports/missed-call-statistics-2026.md); [Zadarma](https://zadarma.com/en/blog/missed-calls-cost-research/)
- CallRail platform data puts the average at 28% of business calls unanswered. The sample size was not disclosed — [CallRail blog](https://www.callrail.com/blog/missed-calls-costing-your-business)
- Blogs attribute conflicting numbers to a "ServiceTitan 2025 report": 27% missed for HVAC vs 17% for plumbers, and elsewhere 62% unanswered. No primary report was located — [skipcalls](https://skipcalls.com/blog/percentage-business-calls-unanswered-statistics-2026); [getaira](https://www.getaira.io/blog/missed-business-calls-statistics)
- One call-tracking dataset found 58% of plumbing calls reached a live person (so 42% did not). Another estimate gives 54% (HVAC) and 58% (plumbing) missed. Both are vendor datasets with small or undisclosed samples — [calljolt](https://calljolt.com/blog/guides/home-service-business-missed-call-statistics)
- An audit of CallJolt's "Home Service Missed Call Statistics 2026" page:
  - none of its stats are attributed to an identifiable study (62% unanswered, 86% won't leave voicemail, 78% book the first contractor who answers, after-hours misses of 87-98%);
  - its own revenue table doesn't reconcile. It shows $218 per missed call × 18/week × 52 weeks, which is about $204k, yet the table says $124k for HVAC — [calljolt (fetched and analysed)](https://calljolt.com/blog/guides/home-service-missed-call-statistics)
- Value per missed call varies by roughly 5x depending on assumptions:
  - about $218 expected revenue per missed HVAC call (on a $340 ticket at 64% close);
  - versus "$1,200" or "$1,500" per missed call in other vendor pages — [growigami](https://growigami.com/blog/cost-of-missed-calls); [theaisavvy](https://www.theaisavvy.com/blog/ai-call-answering-service-for-hvac-contractors/nevada/enterprise)
- "78-85% of homeowners hire the first contractor who responds" circulates widely with no traceable source. It is usually traced to the Oldroyd/InsideSales Lead Response Management study, which covered general B2B/B2C sales leads, not contractors — [threekit](https://www.threekit.com/blog/speed-to-lead-door-window-companies-cost); [scorpion](https://www.scorpion.co/home-services/insights/blog/verticals/home-services/why-speed-wins-the-critical-role-of-response-tim/)

**No-shows (clinics, salons)**
- Dental, from Planet DDS across 8,500+ practices: 2025 no-show rate 6.9% (7.4% in 2024), cancellation rate 12.9%, case acceptance 58%, case completion 47% — [Planet DDS 2026 DSO Outlook PDF](https://www.planetdds.com/wp-content/uploads/2026/05/PDDS-2026-DSO-Outlook-DeepDive-051526.pdf)
- Dental, from Henry Schein One's 2026 Catalyst Index: industry average no-show about 3%, top 10% under 1%. This conflicts with Planet DDS, likely because samples and definitions differ — [Henry Schein One 2026 Catalyst Index](https://www.henryscheinone.com/insights/ebook/2026-catalyst-index/)
- In the ADA's 2023 survey (older evidence), about 8 in 10 dentists named last-minute cancellations or no-shows as the top reason they can't keep a full schedule. One no-show per day is estimated to cost $20k-$70k a year — [Dental Economics](https://www.dentaleconomics.com/practice/patient-communication-and-patient-financing/article/55272651/decreasing-open-chair-time-through-best-practice-management-systems); [CareCredit](https://www.carecredit.com/providers/insights/reduce-dental-patient-no-shows-cancellations/)
- Salons: Fresha reports average revenue lost to cancellations at almost 7% a month in hair and beauty. Zenoti lists a salon no-show rate of 2% with a median ticket of $77. Both are vendor data — [Fresha cancellations study](https://www.fresha.com/blog/cancellations-cost-study); [Zenoti calculator](https://www.zenoti.com/thecheckin/no-show-revenue-calculator)

**Paperwork between job and payment (high value per incident)**
- Roofing, missed scope: one example storm job lost about $4,200 in missed line items (drip edge, ice-and-water shield, steep-slope charge). A storm can compress "a month's worth" of calls into three days — [RevUp Now AI, Sep 2026, vendor](https://revupnow.ai/storm-damage-roofing-insurance-supplements/)
- Roofing, claimed recoveries (vendor and trainer claims, not verified):
  - one press release claims supplement clients recover on average 28% more per claim;
  - trainers cite approved supplements averaging $7,900-$16,000 per claim — [Estimate on Demand press release](https://news.marketersmedia.com/estimate-on-demand-announces-enhanced-insurance-supplement-services-for-roofing-contractors/89182206); [Roof Sales Mastery](https://roofsalesmastery.com/supplementing-xactimate-guide/)
- HVAC rebates: the federal 25C credit ended 31 Dec 2025. Utilities now carry most heat-pump incentives and pay the contractor. At SMUD, the rebate is $3,000 (variable-stage) or $2,000 (two-stage), plus a $2,000 panel bonus. A contractor that fronts the rebate carries $3,000-$5,000 per job until the utility pays — [ACHR News, 24 Oct 2026, by contractor Andrey Yev](https://www.achrnews.com/articles/166897-life-after-the-federal-credit-running-utility-rebates-as-an-operating-process)
- HVAC rebate failure modes from the same article. The administrator reported more than 100 projects unpaid because the signed application was mailed instead of uploaded. Other reasons:
  - an AHRI certificate number that did not yet resolve in the directory (one contractor lost more than 3 weeks on 2 systems);
  - an AHRI number that didn't match the supplier paperwork;
  - a missing photo of the old unit (needs an exception form);
  - the rebate issued to the payer instead of the utility account holder (on rentals, the tenant);
  - sendbacks are rising, and multiple sendbacks in a month trigger mandatory mentoring — [ACHR News](https://www.achrnews.com/articles/166897-life-after-the-federal-credit-running-utility-rebates-as-an-operating-process)
- SMUD volume: 3,798 conversions in 2025, with 4,870 targeted for 2026 (one utility only) — [ACHR News](https://www.achrnews.com/articles/166897-life-after-the-federal-credit-running-utility-rebates-as-an-operating-process)
- Federal HEEHRA rebates flow through the contractor, who handles the reservation and paperwork. Installs made before the reservation is approved are ineligible. California's single-family HEEHRA funds were fully reserved or waitlisted in 2026 — [TECH Clean California](https://techcleanca.com/heehra/); [servicemag](https://servicemag.org/news/california-heehra-heat-pump-rebates-fully-waitlisted)
- HVAC manufacturer warranty:
  - warranties usually cover parts only, with labor at a flat-rate allowance that "may not always cover the contractor's actual costs";
  - contractors charge customers $50-$125 processing fees per warranty claim to recoup admin time (vendor and contractor blogs);
  - an ACHR-attributed claim that manufacturers pay a "ridiculously low amount" for warranty labor could not be verified — [hvacprosales](https://hvacprosales.com/hvac-contractor-business/hvac-warranty-management-for-hvac-contractors/); [rescueheatandair](https://rescueheatandair.com/blog/can-hvac-companies-charge-warranty-fee/)
- Dedicated "Warranty Claims Processor" jobs exist at HVAC distribution and parts groups, which shows the work costs enough to staff — [Greenhouse job posting, Ambient Enterprises](https://job-boards.greenhouse.io/ambiententerprises/jobs/4945852008)

**Compliance (UK landlords)**
- Under the Renters' Rights Act 2025 (in force 2026):
  - landlords had to give existing AST tenants the government information sheet by 31 May 2026;
  - gas safety checks are annual, EICRs every 5 years, and EPCs must be renewed on expiry;
  - councils can request compliance records covering the previous 12 months — [boroughready](https://boroughready.com/renters-rights-act); [letcompliance](https://letcompliance.com/renters-rights-act-2025)
- Penalty figures conflict across vendor sources (verify on GOV.UK):
  - up to £7,000 for information-sheet failures;
  - up to £30,000 or £40,000 for EICR breaches;
  - up to £5,000 for alarm breaches — [letcompliance](https://letcompliance.com/renters-rights-act-2025); [LLCR](https://www.llcr.uk/articles/do-landlords-need-compliance-software.html)

### Inferences
- The missed-call problem is real but its size is overstated by the people selling the fix. A defensible planning range is roughly 25-45% unanswered for owner-operator trades, higher in peak season. No primary study of 2024-2026 trade call answer rates was found.
- Per-incident value is far higher in paperwork jobs (roof supplements $2k-$16k; heat-pump rebates $2k-$5k fronted; warranty labor) than per missed call (about $200 expected value). One recovered claim can pay a year of software.
- Paperwork leaks share a structure the founder's engine fits. The steps are deterministic:
  - checklists;
  - matching documents (AHRI number to supplier invoice, scope to photos);
  - portal submission;
  - multi-week follow-up.

  A wrong submission is costly, which suits human approval before anything goes out, and an audit log has direct value in inspections and disputes.

### Gaps
- No primary (non-vendor) 2024-2026 study of trades call answer rates was found. The ServiceTitan report cited by blogs could not be located.
- No reliable fee schedule for third-party roof supplement companies was found. The only data point is a 2009 forum post saying firms ask "5 to 10(?!)% of the claim" — [Roofers Coffee Shop forum, 2009](https://www.rooferscoffeeshop.com/forum/topic/insurance-supplements). The commonly repeated 10-15%-of-supplement norm is unverified here.
- Staff hours per rebate or warranty claim were not quantified by any source.
- Vet clinic and physio no-show and phone data, auto repair lost-lead data, and restaurant food-safety log costs were not researched in depth (limited tool budget).

---

## 2. What do they pay for today, and what do users say is still broken?

### Takeaway
Spend clusters in three places:
- field service management (FSM): Jobber/Housecall Pro $59-$299+/mo, ServiceTitan enterprise-priced with long contracts;
- front-office messaging and reviews: Podium about $399-$599/mo, Birdeye about $299-$449 per location, Weave $249+/mo;
- vertical back-office: MarginEdge $350 per location per month; AppFolio about $3.20 per unit per month with minimums.

Complaints centre on price, contract lock-in, add-on creep, and gaps in follow-through: chasing adjusters, chasing approvals, submissions that bounce. Basic features are not the problem.

### Cited Findings
**FSM and AI add-ons (trades)**
- Housecall Pro base plans are $59 / $149 / $299 per month (Basic / Essentials / MAX, annual). Its "CSR AI" add-on has no public price ("tailored pricing through a demo", as of 23 Oct 2026) — [levelnex](https://www.levelnex.ai/insights/fsm-ai-receptionist-transparency); [workflowstackai](https://workflowstackai.com/blog/field-service-software-comparison-2026)
- Jobber AI Receptionist is $29/mo with 30 conversations, then $0.79 each, bundled with Plus. Older pages say $99/mo, so check Jobber directly — [levelnex](https://www.levelnex.ai/insights/fsm-ai-receptionist-transparency); [theaitrades](https://theaitrades.ai/blog/jobber-ai-vs-servicetitan-ai-vs-housecall-pro-ai)
- ServiceTitan's AI Voice Agent is usage-based, starting at $2.75 per call (from a Jan 2026 ServiceTitan podcast page). Platform pricing is unpublished — [levelnex](https://www.levelnex.ai/insights/fsm-ai-receptionist-transparency); [getlocalcall](https://getlocalcall.com/servicetitan-pricing)
- A ServiceTitan G2 reviewer: "I was also not clearly informed I was signing a 2-year contract. They refused and threatened collections." Capterra's summary says small businesses find pricing, complexity and technician requirements restrictive. Reviewers report slow follow-up and rotating success managers. 92% of Capterra reviewers are small businesses — [G2 ServiceTitan reviews](https://www.g2.com/products/servicetitan/reviews_and_filters); [Capterra](https://www.capterra.com/p/150053/ServiceTitan/reviews/)
- Trustpilot reviewers say the contract was sent without disclosing it was built for enterprise and commercial firms. The BBB profile shows a 1/5 average from about 30 reviews and 26 complaints in 3 years (via an aggregator) — [Trustpilot](https://at.trustpilot.com/review/servicetitan.com); [getonecrew](https://www.getonecrew.com/post/servicetitan-reviews)

**Messaging and reputation**
- Podium:
  - Core about $399/mo, Pro about $599/mo, all paid plans on 12-month agreements;
  - phone seats are $30 per user for the first four;
  - a $500 per-location "network optimization" fee applies if you add Podium Phones;
  - Capterra reviewers say costs are high for small businesses and inflexible — [eesel](https://www.eesel.ai/blog/podium-alternatives); [quo](https://www.quo.com/blog/podium-alternatives/); [Capterra Podium](https://www.capterra.com/p/164285/Podium/)
- Birdeye is about $299-$449 per location per month (annual), with add-ons such as Referrals at $100/mo and Mass Texting at $100/mo. Reviewers say it suits established enterprises more than growing small businesses — [G2 compare](https://www.g2.com/compare/birdeye); [quo](https://www.quo.com/blog/podium-alternatives/)
- Weave starts at $249 per location per month, with no free trial — [G2](https://www.g2.com/compare/podium-vs-weave-weave); [TrustRadius](https://www.trustradius.com/compare-products/birdeye-vs-podium-vs-weave)

**Roofing**
- Xactimate (Verisk) is the carrier-standard estimating tool.
  - Leap has a deal with Verisk to bring Xactimate into its roofing CRM, targeting winter 2026, so it may not be live yet — [Leap blog](https://leaptodigital.com/blog/leap-teams-up-with-verisk-to-bring-xactimate-into-insurance-roofing/)
  - One vendor's analysis says Xactimate doesn't catch every missed line item, chase the adjuster, or handle the storm-call surge. It says AccuLynx, the leading roofing production platform, lacks automated supplement follow-up — [RevUp Now AI (vendor)](https://revupnow.ai/storm-damage-roofing-insurance-supplements/)
- Outsourced supplementing is typically "a fee, often a percent of what is recovered". Named firm: Supplement Experts — [Hook Agency, updated 5 Nov 2026](https://hookagency.com/blog/roofing-supplements/)
- Forum voice (2009, old): "too many of these companies are asking for 5 to 10(?!)% of the claim which just isn't right." — [Roofers Coffee Shop](https://www.rooferscoffeeshop.com/forum/topic/insurance-supplements)

**HVAC rebates and warranty: contractor voice**
- Andrey Yev (contractor, ACHR, Oct 2026): "The rebate is a process your shop runs." / "A customer who mails the same form to the administrator has done nothing." / "Build the program checklist into the install, not the close-out." / "Do not promise a number the program has not reserved." — [ACHR News](https://www.achrnews.com/articles/166897-life-after-the-federal-credit-running-utility-rebates-as-an-operating-process)
- Homeowner and contractor friction over warranty service charges shows up in forums. A homeowner thread asks why a tech "wanted a service charge for warranty work" — [Garage Journal forum](https://www.garagejournal.com/forum/threads/hvac-tech-wanted-a-service-charge-for-warranty-work.527604/)

**Restaurants**
- MarginEdge is about $350 per location per month and flags ingredient price changes the day they appear on an invoice. Reviews note it is invoice- and finance-centric, not kitchen-level variance tracking. Processing slips past its 24-48h promise during month-start invoice surges — [restauranttools.ai (re-checked Sep 2026)](https://restauranttools.ai/tools/marginedge); [restaurantinventorytools](https://restaurantinventorytools.com/best-restaurant-software-food-cost-control-2026/); [MarginEdge blog](https://www.marginedge.com/blog/how-to-spot-ingredient-price-spikes-in-7-easy-steps-2026)

**Auto repair**
- Shop management pricing, monthly, checked 13 Nov 2026:
  - Shopmonkey $239 / $399 / $499;
  - Tekmetric Scale $439, with entry-level AutoLeap and Tekmetric at $199 (Software Advice lists Tekmetric from $179);
  - AI phone answering is priced separately, usually via sales calls — [tech-insider](https://tech-insider.org/best-auto-repair-software-reviewed-and-compared/); [Software Advice](https://www.softwareadvice.com/auto-repair/tekmetric-profile)

**Property management**
- AppFolio shows maintenance scheduling and automated billing "starting at $3.20 per unit per month", with minimum spend and units. Realm-X AI is not priced separately in public — [AppFolio pricing](https://www.appfolio.com/benefits/pricing)
- EliseAI is estimated (by a competitor) at about $3-$6 per unit per month with a roughly $25k annual minimum, aimed at portfolios in the thousands of units — [myaifrontdesk (competitor blog)](https://www.myaifrontdesk.com/blog-posts/best-ai-for-appfolio-users-automating-leasing-and-resident-calls)

### Inferences
- Owners already pay $250-$600 a month per location for front-office tools, and resent lock-in and add-ons. A narrow tool at about $100-$400/mo, or priced per outcome (per claim), with no annual lock-in, would match stated pain.
- The gaps owners and contractors describe are follow-through gaps: chasing adjusters, resubmitting rebate packets, tracking AHRI listings. These are multi-day, stateful workflows, not real-time conversations, which suits an approval-gated agent with an audit log better than a voice bot.

### Gaps
- There are no direct quotes from r/HVAC, r/Plumbing, r/Landlord or r/sweatystartup (Reddit blocked). A follow-up pass with Reddit access should mine threads on "supplement company fees", "rebate sendback", "warranty claim labor", and "AI receptionist cancelled".
- Toast, Square and Boulevard pricing and AI features were not researched in this pass.

---

## 3. What is now well covered by big companies or incumbents, and what remains unsolved?

### Takeaway
AI phone answering and booking for trades, restaurants and salons is now commoditised. FSM platforms bundle it ($29/mo at Jobber; $2.75/call at ServiceTitan), Yelp sells it ($99-$149/mo), and unicorn-scale startups (Avoca, Netic) sell it to larger contractors. Reminders and deposits for no-shows are standard in booking software. Review requests are mature (Podium, Birdeye). Messy, multi-party claims and paperwork remains thinly served: roof insurance supplements, utility/heat-pump rebates, manufacturer warranty claims, and small-landlord maintenance coordination plus compliance evidence.

### Cited Findings
- FSM-bundled AI receptionists: Jobber $29/mo (30 conversations); ServiceTitan Voice Agent from $2.75/call; Housecall Pro CSR AI add-on — [levelnex](https://www.levelnex.ai/insights/fsm-ai-receptionist-transparency)
- Yelp launched Yelp Host (restaurants, from $149/mo: reservations, waitlists, special requests) and Yelp Receptionist (local businesses, from $99/mo: captures project details, vets leads, delivers recordings and summaries) in Oct 2025. It is unclear whether Receptionist answers all calls or only Yelp-sourced ones — [Cybernews](https://cybernews.com/ai-news/yelp-rolls-out-ai-receptionist/); [Yelp blog](https://blog.yelp.com/news/fall-product-release-2025/); [usecarly](https://www.usecarly.com/blog/yelp-ai-receptionist/)
- Google's "Ask for Me" / "Call for Me" place AI calls to businesses on consumers' behalf. The practical effect is that some inbound calls are now AI agents, not people — [voksha](https://voksha.com/news/big-tech-moves-into-ai-receptionists/)
- Tekmetric launched "Tekmetric Phones" at Tektonic 2026. It shows customer history, vehicle and open repair orders when the phone rings (a screen-pop, not an AI agent). Podium has AI phone handling with repair-shop system integrations — [Ratchet+Wrench](https://www.ratchetandwrench.com/news/article/55370320/tekmetric-unveils-new-platform-innovations-at-tektonic-2026)
- AppFolio Realm-X "Maintenance Performer" diagnoses and prioritises resident requests (including from images), creates work orders and logs summaries. A 29 Sep 2026 release reportedly says 53% of maintenance requests now resolve without a work order (seen only as a fragment; unverified). This covers AppFolio customers, mainly mid and large PMs — [AppFolio newsroom](https://www.appfolio.com/newsroom/appfolio-ai-agents); [AppFolio](https://www.appfolio.com/newsroom/appfolios-most-powerful-ai-yet-now-standard-for-every-customer)
- Dental insurance verification is crowded:
  - AI at about $1-$3 per check, or flat about $249-$299/mo unlimited (DentalAI Assist $299/mo; DentalRobot $150+ per location);
  - Dentrix Eligibility Pro at $3 per request;
  - manual checks benchmarked at $9.72 each (CAQH Index);
  - outsourced at $10-$17 per check — [needletailai](https://www.needletailai.com/blogs/top-dental-insurance-verification-software); [raftlabs](https://www.raftlabs.com/blog/insurance-verification-automation-dental); [dentalaiassist](https://dentalaiassist.com/features/ai-dental-insurance-verification/); [denture-id](https://denture-id.com/ai/ai-insurance-agents/)
- UK landlord compliance reminders are crowded with low-cost tools (RentDocs, LetDeck, LetCompliance, ComplianceBot, Hailes), typically offering expiry reminders (e.g. 90/30/14/7/1 days) and document storage — [rentdocs](https://rentdocs.co.uk/); [letdeck](https://letdeck.co.uk/); [compliancebot](https://compliancebot.uk/); [hailes](https://hailes.tech/blog/posts/software-for-uk-landlords-2026)
- Restaurant supplier price-change alerts are covered for operators who pay about $350 per location (MarginEdge); xtraCHEF and Restaurant365 also compete — [MarginEdge comparison](https://www.marginedge.com/blog/best-restaurant-ai-invoice-automation-tools-compared)
- Unsolved in roofing: no platform automates adjuster scope-vs-photo comparison plus approval chasing end to end (vendor claim). AccuLynx lacks supplement follow-up — [RevUp Now AI](https://revupnow.ai/storm-damage-roofing-insurance-supplements/)
- Unsolved in HVAC rebates: sendbacks are rising and administrators are imposing mentoring. No software vendor came up in research on rebate packet assembly or AHRI matching for contractors — [ACHR News](https://www.achrnews.com/articles/166897-life-after-the-federal-credit-running-utility-rebates-as-an-operating-process)

### Inferences
- Ruled out as a lead product: a general AI receptionist, a review-request tool, no-show reminders, dental eligibility checks, UK certificate-expiry reminders, and single-feature supplier price alerts. Each has incumbents bundling it cheaply or many funded entrants.
- These remain unsolved because they are:
  - multi-party (carrier, adjuster, utility administrator, manufacturer, supplier, homeowner/tenant);
  - document-heavy, with exact-match rules;
  - long-running (weeks);
  - high-stakes per submission.

  FSM vendors build for the dispatch and invoice loop, not for third-party claims. Voice-AI startups build for real-time calls.
- Restaurant supplier price auditing (AP side) is distinct from the founder's excluded invoice/receivables chasing (AR side), but it sits close and is crowded at multi-unit level. It is not recommended.

### Gaps
- Square, Toast and GBP native AI features for SMBs in late 2026 were not checked in detail.
- No software vendor focused on HVAC utility rebate or warranty claim packets was found. That could mean the space is empty or that the search missed it. Validate with ACCA or a distributor.

---

## 4. Which AI-native startups attack these jobs, how are they priced, and what traction is public?

### Takeaway
Capital has piled into voice and front-office AI for home services. Avoca is at about a $1B valuation with more than $125M raised and eight-figure ARR in 2025. Netic is at $450M with $43M raised. PermitFlow is at about $500M with a $54M Series B. Per-claim and paperwork tools in roofing, HVAC rebates and warranty are small, unfunded or service-heavy.

### Cited Findings
- **Avoca** (AI agents for home services):
  - more than $125M raised across Seed, A and B, at about a $1B valuation (announced 27 Apr 2026);
  - Series B led by Meritech and General Catalyst; Series A by Kleiner Perkins;
  - eight-figure ARR in 2025, "on track to book $1B in jobs in 2026";
  - targets enterprise contractors, quote-only pricing (third-party estimate $1,000-$3,000/mo) — [ai2.work](https://ai2.work/blog/avoca-hits-1b-valuation-with-125m-raise-to-bring-ai-to-home-services); [goodmunity](https://goodmunity.com/funding/avoca-125m-funding-ai-home-services-automation-2026/); [roonly](https://roonly.ai/best/ai-receptionist-home-services)
  - customer example: Bob's Repair (Las Vegas HVAC), Mar 2026 — [Barchart press release](https://www.barchart.com/story/news/676948/bob-s-repair-implements-avoca-ai-to-streamline-customer-communications-and-improve-call-response-times)
- **Netic** (AI for plumbers, roofers, home services):
  - $20M at launch (Jun 2025), then a $23M Series B led by Founders Fund (Nov 2025) at a $450M valuation;
  - partnership with American Residential Services (ARS) in 2026 — [Insurance Journal](https://www.insurancejournal.com/news/national/2025/11/13/847406.htm); [Built In](https://builtin.com/articles/netic-raises-20m-funding-20250604); [roofingcontractor](https://roofingcontractor.com/articles/101559-netic-ai-for-roofing-receives-23m-in-series-b-funding)
- **Rosie** (budget AI receptionist): $49/mo standalone; booking, transfers and texts need Scale at $149/mo — [roonly](https://roonly.ai/best/ai-receptionist-home-services)
- **Sameday AI** has a G2 seller page. No funding found — [G2](https://www.g2.com/sellers/sameday-ai-inc)
- **PermitFlow** (AI construction permitting):
  - $54M Series B led by Accel (Dec 2025), valuation about $500M (Caplight estimate);
  - total raised about $90M (CB Insights/ZoomInfo);
  - 167 employees as of 5 Oct 2026 (TipRanks) — [Built In](https://builtin.com/articles/ai-construction-platform-permitflow-secures-54m-series-b-20251203); [Morningstar/Dow Jones](https://morningstar.com/news/dow-jones/202512026758/permitflow-raises-54-million-in-series-b-funding-round); [TipRanks](https://www.tipranks.com/private-companies/permitflow)
- **Arini** (YC dental AI receptionist): about a $500K seed (Feb 2024). No later round verified — [Crunchbase](https://crunchbase.com/organization/arini); [YC](https://ycombinator.com/companies/arini)
- **Roofing supplement AI**: RoofGenius ("works with Xactimate"; claims 14 days average from submission to payment), RAFTER AI (automates Xactimate supplements, audits scopes, code-backed rebuttals), SupplementSnap. No funding or traction disclosures found — [RoofGenius](https://roofgenius.ai/answers); [RAFTER AI](https://rafterai.online/); [theagenticaiindex](https://theagenticaiindex.com/roofing)
- **Dental verification AI**: Needletail, DentalAI Assist ($299/mo), Azops, DentalRobot ($150+ per location) and others. The crowding is shown by listicles ranking 15+ tools — [needletailai](https://www.needletailai.com/blogs/top-dental-insurance-verification-software)
- **Auto repair AI**: Kallz AI (founded 2026, in beta as of Apr 2026, working on Tekmetric/Shopmonkey integrations); Dialzara and My AI Front Desk (book into Shopmonkey/Tekmetric/Mitchell 1/AutoLeap); Podium; Numa — [Ratchet+Wrench Q&A](https://www.ratchetandwrench.com/topics/rw-web-edition/article/55371265/qa-emerging-ai-tools-in-the-auto-repair-field-right-now); [dialzara](https://dialzara.com/blog/best-auto-repair-answering-services)

### Inferences
- A 2-5 engineer team should not compete on voice reception in US home services. Avoca and Netic have 10-100x the capital, and FSM incumbents now give it away for $29/mo or $2.75/call.
- Permitting has a well-funded leader aimed at larger builders and developers. Small residential trade permits (HVAC change-outs, water heaters, panel upgrades) may be under-served, but the evidence here is thin.
- Roofing supplement AI tools exist but look early and unfunded, so a better product can still win. The rebate and warranty claim niche showed no dedicated AI startup at all.

### Gaps
- No ARR or customer counts for RoofGenius, RAFTER AI or SupplementSnap.
- Funding for Rosie, Goodcall, Smith.ai and Sameday was not found in this pass.
- 2026 EU-native AI receptionist startups (e.g. in DACH, France, Nordics) were not researched.

---

## 5. Candidate opportunities: who pays, price evidence, frequency, 3-month MVP needs, and fit for the founder's engine

Engine assumed: desktop + cloud agent, human approval before outside effects, audit log, local data storage, sandboxed scripts, skills as files, MCP connectors.

### Takeaway
Ranked shortlist:
1. **HVAC rebate + warranty claims desk** (US first): strongest fit and least competition.
2. **Roofing insurance supplement desk** (US): high value per claim, some early competitors, regulatory care needed.
3. **Small-landlord maintenance and compliance desk** (UK first, US second): regulation-driven demand; reminders are crowded but evidence-pack assembly and contractor coordination are not.
4. **Residential trade permit filer** for HVAC, water heater and electrical change-outs: plausible but under-evidenced; needs validation.

Ruled out:
- general AI receptionist;
- review/reputation tools;
- no-show reminders;
- dental insurance verification;
- restaurant supplier price alerts;
- the founder's excluded ideas (generic SMB agent, accounting month-end desk, invoice/AR chasing, tenders, supplier questionnaires).

### Cited Findings

#### Opportunity A: HVAC utility-rebate and manufacturer-warranty claims desk
- Pain and value:
  - the 25C credit ended 31 Dec 2025, so utilities now pay contractors;
  - SMUD rebates are $2,000-$3,000 plus a $2,000 panel bonus, and contractors often front $3,000-$5,000 per job;
  - more than 100 projects went unpaid at one administrator over a single form-handling error;
  - AHRI-number mismatches and listing delays cost weeks;
  - sendbacks are rising and trigger mandatory mentoring — [ACHR News, Oct 2026](https://www.achrnews.com/articles/166897-life-after-the-federal-credit-running-utility-rebates-as-an-operating-process)
- Volume: one utility (SMUD) targets 4,870 conversions in 2026 — [ACHR News](https://www.achrnews.com/articles/166897-life-after-the-federal-credit-running-utility-rebates-as-an-operating-process)
- HEEHRA (federal, state-run): the contractor holds the reservation and paperwork, and installing before approval voids eligibility — [TECH Clean California](https://techcleanca.com/heehra/)
- Warranty side: parts-only coverage with low flat labor allowances; contractors charge $50-$125 per claim in processing fees; dedicated warranty-processor jobs exist — [hvacprosales](https://hvacprosales.com/hvac-contractor-business/hvac-warranty-management-for-hvac-contractors/); [rescueheatandair](https://rescueheatandair.com/blog/can-hvac-companies-charge-warranty-fee/); [Greenhouse posting](https://job-boards.greenhouse.io/ambiententerprises/jobs/4945852008)
- Competition: no dedicated software vendor found. FSMs (ServiceTitan, Housecall Pro, Jobber) are dispatch and invoice-centric (see section 2).
- Who pays: owner or office manager at HVAC contractors doing heat-pump installs in utility programs (US; also UK Boiler Upgrade Scheme and EU national heat-pump subsidies, not researched).

#### Opportunity B: Roofing/restoration insurance supplement desk
- Pain and value:
  - an example lost $4,200 in missed line items on a single roof;
  - storm surges overwhelm offices;
  - AccuLynx lacks supplement follow-up;
  - Xactimate doesn't chase adjusters — [RevUp Now AI (vendor)](https://revupnow.ai/storm-damage-roofing-insurance-supplements/)
- WTP: outsourced supplementers charge a percentage of recovered amounts (rate unverified; a 2009 anecdote says 5-10% of the claim). Training vendors claim approved supplements averaging $7.9k-$16k per claim — [Hook Agency](https://hookagency.com/blog/roofing-supplements/); [Roofers Coffee Shop 2009](https://www.rooferscoffeeshop.com/forum/topic/insurance-supplements); [Roof Sales Mastery](https://roofsalesmastery.com/supplementing-xactimate-guide/)
- Competition:
  - AI tools: RoofGenius, RAFTER AI, SupplementSnap, RevUp Now AI (flat build fee plus retainer);
  - human firms: Supplement Experts, Estimate on Demand, American Roof Supplements;
  - platform risk: the Leap + Verisk Xactimate integration (target winter 2026) — [Leap](https://leaptodigital.com/blog/leap-teams-up-with-verisk-to-bring-xactimate-into-insurance-roofing/); [American Roof Supplements](https://americanroofsupplements.com/); [RAFTER AI](https://rafterai.online/)

#### Opportunity C: Small-landlord / small-PM maintenance and compliance desk
- Regulation-driven demand in the UK:
  - Renters' Rights Act 2025 obligations;
  - annual gas safety checks, 5-yearly EICRs, EPCs;
  - councils may request 12 months of compliance records;
  - fines up to £30k-£40k per EICR breach (sources conflict) — [letcompliance](https://letcompliance.com/renters-rights-act-2025); [boroughready](https://boroughready.com/renters-rights-act)
- Incumbent AI serves larger PMs. AppFolio Realm-X covers maintenance triage for AppFolio customers (with minimum spend). EliseAI is estimated at a roughly $25k/yr minimum for portfolios in the thousands of units — [AppFolio](https://www.appfolio.com/newsroom/appfolio-ai-agents); [myaifrontdesk](https://www.myaifrontdesk.com/blog-posts/best-ai-for-appfolio-users-automating-leasing-and-resident-calls)
- Low-end UK tools stop at reminders and storage — [rentdocs](https://rentdocs.co.uk/); [letdeck](https://letdeck.co.uk/)

#### Opportunity D: Residential trade permit filer (change-outs)
- PermitFlow has proven demand and capital for AI permitting ($54M Series B; about 167 staff), but serves builders and developers — [Built In](https://builtin.com/articles/ai-construction-platform-permitflow-secures-54m-series-b-20251203); [TipRanks](https://www.tipranks.com/private-companies/permitflow)
- Rebate programs often require permits and third-party duct-leak testing, which links D to A — [ACHR News](https://www.achrnews.com/articles/166897-life-after-the-federal-credit-running-utility-rebates-as-an-operating-process)

#### EU vs US differences relevant to all candidates
- EU AI Act Article 50 transparency duties applied from 2 Aug 2026:
  - AI systems interacting with people must disclose they are AI unless that is obvious; this covers agents phoning people on a business's behalf;
  - fines up to €15M or 3% of global turnover;
  - marking and detection duties for legacy systems have a grace period to 2 Dec 2026 — [Cooley](https://www.cooley.com/news/insight/2026/2026-08-03-eu-ai-act-transparency-obligations-take-effect-2-august-2026); [Travers Smith](https://www.traverssmith.com/knowledge/knowledge-container/is-it-a-bot-eu-ai-act-transparency-rules-take-effect-2-august-2026/); [Reed Smith](https://www.reedsmith.com/our-insights/blogs/viewpoints/102nfqg/always-read-the-label-eu-ai-transparency-rules-and-questions-that-remain-unanswe/)
- US-specific: utility rebate structures, HEEHRA, Xactimate-based insurance claims and the 25C repeal. UK-specific: the Renters' Rights Act, Gas Safe CP12 and EICR.

### Inferences

**Opportunity A: HVAC rebate + warranty claims desk (rank 1)**
- *Job:* After each install or repair, the agent assembles and checks the claim packet before a human submits:
  - AHRI number checked against the directory and supplier invoice;
  - model and serial from the nameplate photo;
  - old-unit photo, signed application, account holder vs payer;
  - exception forms;
  - for warranty, failure codes, serials, install date proof and the labor-allowance claim.

  It then tracks status, flags sendbacks and drafts corrections. A pre-install reservation check stops ineligible installs.
- *Who pays:* owner or ops manager at 5-50 truck HVAC shops in active utility or state programs. Ideally sold via distributors (who also process warranty).
- *Price hypothesis:* $199-$499/mo per shop, or $25-$75 per claim packet. This anchors to $50-$125 customer warranty processing fees and $3k-$5k fronted rebates; it is not validated.
- *Frequency:* every heat-pump install in a program, plus every in-warranty part failure, so weekly to daily for an active shop.
- *3-month MVP:*
  - skills per program (start with 1-2 utilities, e.g. SMUD plus one other);
  - an AHRI directory lookup script;
  - OCR of nameplate photos and supplier invoices;
  - a packet checklist validator;
  - browser automation or assisted upload to administrator portals;
  - manufacturer warranty portals for 2-3 brands (Carrier, Trane, Goodman: portal access is an unverified risk);
  - MCP connectors to ServiceTitan, Housecall Pro or Jobber to pull job data and photos.
- *No telephony needed.*
- *Fit:* very high. Human approval before submission prevents rejections, and the audit log helps with inspection and corrective-action responses (10-business-day windows). Local storage suits customer PII, and per-program skill files map to the variation between programs.
- *Risks:*
  - rebate funding is political and volatile (California HEEHRA ran out);
  - each program differs, so expansion is linear;
  - manufacturer portals may block automation.

**Opportunity B: Roofing insurance supplement desk (rank 2)**
- *Job:* The agent compares the adjuster's scope (Xactimate PDF or ESX) to field photos, measurements (EagleView or Hover reports) and local code. It drafts line-item supplements with code citations and photo evidence, then tracks the adjuster thread and drafts follow-ups. A human approves every outbound message.
- *Who pays:* storm-restoration roofing contractors (US Sun Belt and hail belt) who now pay supplement firms a percentage, or employ a supplement coordinator.
- *Price hypothesis:* per-claim ($75-$250) or a small percentage of approved supplement (undercutting human firms). Unvalidated.
- *Frequency:* every insurance roof job, and spiky after storms.
- *3-month MVP:*
  - Xactimate report parsing (PDF first; ESX access via Verisk is a gating question);
  - a code-requirement skill library per state or county (drip edge, ice-and-water);
  - photo tagging;
  - email connector for adjuster threads;
  - AccuLynx or JobNimbus connectors.
- *Regulatory flag (not verified in this research):* many US states restrict contractors from negotiating claims on a homeowner's behalf (public adjuster laws). The product must be framed as contractor estimate documentation, not claim negotiation. Get legal review before launch.
- *Fit:* high for document work and approval-gated outbound email.
- *Risks:*
  - Verisk/Leap moving into the space;
  - several early AI competitors;
  - US-only (EU claims practice differs and is not researched).

**Opportunity C: Small-landlord maintenance and compliance desk (rank 3)**
- *Job:* For landlords and small agents with about 5-300 units:
  - triage tenant maintenance messages (photos, WhatsApp/email);
  - propose a contractor booking and tenant time slot for approval;
  - keep a per-property compliance register (gas safety, EICR, EPC, alarms, deposit, information sheet);
  - pre-book renewals;
  - assemble a council-ready 12-month evidence pack on demand.
- *Who pays:* UK portfolio landlords and small letting agents. In the US, the analogous buyer is small PMs below the AppFolio/EliseAI minimums, but without the regulatory pull.
- *Price hypothesis:* about £2-£5 per unit per month, against AppFolio's about $3.20 per unit with minimums and a cheaper UK reminders-only tier. Unvalidated.
- *3-month MVP:*
  - email and WhatsApp intake connectors;
  - a compliance register stored locally;
  - certificate OCR (CP12, EICR, EPC lookup);
  - contractor directory and approval queue;
  - evidence pack export.
- *Fit:* good (audit log = compliance evidence; approval before tenant or contractor contact).
- *Risks:*
  - crowded cheap UK reminder tools;
  - landlords are price-sensitive;
  - GDPR on tenant data. Local storage helps.

**Opportunity D: Residential trade permit filer (rank 4, needs validation)**
- *Job:* File the permit for like-for-like HVAC, water heater or panel change-outs across municipal portals, schedule inspections, and attach permit status to rebate packets (synergy with A).
- *Evidence:* adjacency to PermitFlow's traction and rebate permit requirements. No direct small-trade WTP data found.
- *Risk:* thousands of jurisdictions, each portal different.

**Ruled out, with reasons**
- AI receptionist or voice for trades, restaurants and auto repair:
  - commoditised (Jobber $29/mo, ServiceTitan $2.75/call, Yelp $99-$149, Rosie $49);
  - heavily funded rivals (Avoca about $1B, Netic $450M);
  - real-time telephony is outside the approval-gated engine's sweet spot.

  The only defensible angle might be EU multilingual reception with Article 50-compliant disclosure, but there is no evidence of an unmet gap.
- Reviews and reputation: mature incumbents (Podium, Birdeye, Weave, Yelp).
- No-show reminders and deposits: standard in booking platforms (Fresha, Zenoti, Kitomba, dental PMS).
- Dental insurance verification: more than 15 AI vendors at $1-$3 per check.
- Restaurant supplier price alerts: MarginEdge, xtraCHEF and R365 cover this, and it sits close to the founder's excluded AR/AP-chasing space.
- Founder exclusions: generic SMB agent, accounting month-end desk, invoice/receivables chasing, tenders, supplier compliance questionnaires. None developed.

### Gaps
- Willingness to pay for A, B and C is inferred from adjacent prices (processing fees, percentage-of-recovery firms, per-unit PM pricing). No direct survey or interview evidence was found. Recommended validation: 10-15 calls each with HVAC owners in SMUD-type programs, storm roofers, and UK portfolio landlords. Also mine Reddit and Facebook groups (not accessible here).
- Open questions:
  - Do HVAC manufacturer warranty portals (Carrier, Trane, Lennox, Goodman/Daikin) allow automation or API access?
  - Does Verisk allow third-party ESX access?
- EU equivalents were not researched:
  - heat-pump subsidy paperwork (e.g. Germany's BEG/KfW, France's MaPrimeRénov', UK Boiler Upgrade Scheme), which could be a strong EU analogue to A;
  - EU phone and WhatsApp norms;
  - GDPR call-recording rules.
- Vet, physio and auto-repair-specific paperwork pains (e.g. pet insurance claim forms, auto warranty and extended-service-contract claims) were not researched. These are plausible analogues to A and B and worth a follow-up pass.
