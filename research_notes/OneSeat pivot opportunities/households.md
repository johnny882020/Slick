# Household, prosumer and family-caregiver life admin: costly jobs that AI has not solved well (as of Nov 2026)

Scope note: US and EU. Researched 2026-11-28 with about 29 web searches and fetches. Primary sources are preferred. Company-reported numbers are labelled as such. Older evidence is marked with its year. The founder's rejected ideas (a generic small-business agent, an accounting-firm month-end desk, invoice/receivables chasing, public tender bidding, supplier compliance questionnaires) are out of scope and are not considered here. None of the household jobs below overlaps with them.

Context on the engine (from the assignment, not researched): desktop plus cloud agent, human approval before any outside effect, audit log, local data storage, sandboxed scripts, skills stored as files, MCP connectors. Below, this is called "the engine".

---

## Q1. Which life-admin jobs cost people money or many hours, and how much is at stake?

### Takeaway
The best-quantified losses are in US health insurance. About 1 in 5 privately insured adults faced a denial in 2025. 43% of people with a claim denial ended up in medical debt. Yet fewer than 1% of denied ACA claims are appealed. The next largest burdens are measured in hours rather than dollars: estate settlement takes about 500-570 executor hours over 16-18 months, and family caregivers spend $11,508 a year out of pocket. EU flight compensation is a smaller, well-defined pot (€250-600 per claim) whose rules are changing.

### Cited Findings

**Health insurance denials and medical bills (US)**
- Commonwealth Fund 2025 Affordability Survey (published June 2026), privately insured working-age adults: 13% reported a prior-authorization denial in the past year, 8% a claim denial, and 1% both. 21% reported at least one denial affecting themselves or a family member. — [Commonwealth Fund](https://www.commonwealthfund.org/publications/surveys/2026/jun/how-health-insurance-coverage-denials-affect-americans-2025-affordability-survey); [Healthcare Dive](https://healthcaredive.com/news/1-in-5-adults-denied-doctor-recommended-care-commonwealth-fund/822106/)
- In the same survey, nearly 70% of people with a claim denial said it cost their household more money. 43% said it caused medical debt they are still paying off. More than half said the original bill was $1,000 or more. — [Commonwealth Fund](https://www.commonwealthfund.org/publications/surveys/2026/jun/how-health-insurance-coverage-denials-affect-americans-2025-affordability-survey); [Time, Nov 12 2026](https://time.com/article/2026/11/12/how-ai-can-help-you-appeal-health-insurance-denials/)
- Only about half of people with denied care appealed. Of those who did not, 56% were not sure they had the right to. Only 33% of people who challenged a claim denial got the bill reduced or eliminated. Many waited two weeks or longer for a decision. — [Commonwealth Fund](https://www.commonwealthfund.org/publications/surveys/2026/jun/how-health-insurance-coverage-denials-affect-americans-2025-affordability-survey) (note: "half" refers to all adults with denied care, and figures differ by framing)
- KFF analysis of 2024 ACA Marketplace data (published Mar 2026): fewer than 1% of denied claims were appealed, and insurers upheld 66% of appeals. In 2023, HealthCare.gov insurers denied 19% of in-network claims and upheld 56% of appeals. — [KFF 2024 data](https://www.kff.org/private-insurance/claims-denials-and-appeals-in-aca-marketplace-plans-in-2024/); [KFF 2023 data](https://www.kff.org/affordable-care-act/claims-denials-and-appeals-in-aca-marketplace-plans-in-2023/)
- KFF on 2025 prior-authorization data: standard denial rates averaged 12% in Medicare Advantage, 14% in Medicaid MCOs and 18% in ACA marketplaces. 43% of ACA FFM prior-auth denials were overturned on appeal. — [Fierce Healthcare](https://www.fiercehealthcare.com/payers/insurers-denied-between-12-18-prior-auth-requests-2025-kff)
- Medical debt: nearly one-third of privately insured working-age adults are paying off medical bills or debt (Commonwealth Fund, Sept 2026). — [Commonwealth Fund](https://www.commonwealthfund.org/publications/issue-briefs/2026/sep/how-medical-bills-and-debt-impact-americans-private-insurance). An older 2022 NPR/KFF figure is about 100 million Americans, or 41% of adults, with medical debt. — [Checkbook](https://www.checkbook.org/national/consumers-notebook/articles/Federal-Judge-Kills-CFPB-Rule-that-Banned-Medical-Debt-in-Credit-Reports-7678)
- The CFPB rule removing about $49B of medical debt from about 15M credit reports was vacated on July 11, 2025, with the Trump-era CFPB joining the request. That removes a federal backstop and makes disputing a bill before it reaches collections more valuable. — [Axios](https://www.axios.com/2025/07/13/court-scraps-biden-medical-debt-rule); [CFPB archive](https://www.consumerfinance.gov/archive/newsroom/cfpb-finalizes-rule-to-remove-medical-bills-from-credit-reports/)
- A widely cited claim says "80% of medical bills contain an error". The source is a secondary health-news piece, so treat the figure as weak or unverified. — [Healthline](https://www.healthline.com/health-news/80-percent-hospital-bills-have-errors-are-you-being-overcharged)
- One anecdote: an itemized-bill request cut a bill from $1,100 to $618. — [Upworthy](https://www.upworthy.com/asking-the-hospitals-billing-department-one-simple-question-saved-a-patient-482/)

**Estate settlement after a death (US)**
- Executors spend about 570 hours, and settlement usually is not complete until 16 months after the death. The figure rises to 18 months when the executor does the tasks personally (Empathy's "Cost of Dying" report, cited by Freethink and Fortune). — [Freethink](https://www.freethink.com/hard-tech/what-to-do-when-someone-dies); [Fortune, May 2025](https://fortune.com/2025/05/29/exclusive-empathy-raises-72-million-series-c-to-tackle-the-agonizing-logistics-of-death/)
- EstateExec's 2025 survey of 1,201 US adults: settling an estate takes almost 16 months on average, and 80% are settled within 18 months. The average estate spent $12,400 on legal plus accounting fees. — [Trust & Will citing EstateExec](https://trustandwill.com/learn/how-much-does-an-executor-get-paid)
- In 2018, the most common probate attorney rate was $300-400/hour, and 6 in 10 estates paid hourly (Martindale-Nolo; old data). — [Lawyers.com](https://legal-info4.lawyers.com/trusts-estates/how-much-do-lawyers-charge-to-help-with-probate.html)

**Family caregiving for elderly parents (US)**
- AARP/NAC *Caregiving in the US 2025* (July 2025): 63M family caregivers, a 45% increase since 2015. Nearly 1 in 4 provide 40+ hours of care per week. — [AARP press release](https://www.aarp.org/press/releases/2025-07-24-new-report-reveals-crisis-point-for-americas-63-million-family-caregivers.html); [AARP](https://www.aarp.org/caregiving/basics/caregiving-in-us-survey-2025/)
- AARP 2026 Out-of-Pocket Costs Study (Oct 28, 2026): caregivers spend $11,508 a year on average, up almost 60% since 2021. Housing and household make up 42% ($4,797) and medical 29% ($3,313). — [AARP press release](https://www.aarp.org/press/releases/2026-10-28-aarp-family-caregivers-out-of-pocket-costs-jump-almost-60-in-five-years-to-more-than-11500-annually/)
- Medicaid long-term care: applicants report "cumbersome paperwork demands, strict deadlines, and difficulty understanding eligibility, application, and renewal requirements". Common denial reasons are missing documentation, exceeding asset limits, and failing residency criteria. LTC Medicaid requires annual renewal. There is a 5-year look-back on gifts. — [Columbia SIPA capstone](https://www.sipa.columbia.edu/sites/default/files/migrated/downloads/CPD_ColumbiaCapstone.pdf); [Medicaid Planning Assistance](https://www.medicaidplanningassistance.org/how-to-apply-for-medicaid/); [Stetson aging journal](https://www.stetson.edu/law/agingjournal/media/vol-17/6-martin---final-final.pdf); [AgingCare forum](https://www.agingcare.com/questions/amp/449877)
- Example of what an error costs: a Maryland home-care Medicaid application was denied two months after submission because of an asset-calculation error. The family then spent two more months correcting it. — [Baltimore Banner](https://www.thebaltimorebanner.com/community/public-health/maryland-medicaid-home-care-backlog-K573AO6C3ZFDPH436D55LB6EYU/)
- Medicaid-covered family caregivers provide an average of 35 hours a week of unpaid care. — [AARP PPI](https://www-pi.aarp.org/content/dam/aarp/ppi/topics/health/coverage-access/medicaid-provides-critical-health-care-coverage-family-caregivers.doi.10.26419-2fppi.00371.001.pdf)

**Homeowner property claims after damage (US)**
- A WSJ investigation, cited secondhand by Weiss Ratings, found more than 44% of home insurance claims at the five largest insurers were closed without payment in 2025. — [Open Class Actions](https://openclassactions.com/blog/homeowners-insurance-claim-denied-underpaid.php) (secondary)
- Consumer Reports survey (year unconfirmed): about 10% of claimants disagreed with the insurer over the payout amount, rising to 19% when damage was $25k or more. — [UP Help](https://uphelp.org/consumer-reports-rates-home-insurers/?print=pdf)
- A Florida public-adjuster trade group reports a typical settlement of $22,266 with a public adjuster versus $18,659 without. This is a biased source. — [Insure.com](https://www.insure.com/customer-stories/home-insurance/how-public-adjusters-help-with-home-insurance-claims/)

**Tenant deposits**
- Baselane survey: 26% of renters have lost a deposit at some point. The median deposit was $750 (2024). Only 35% got their deposit back within a week. — [Baselane](https://www.baselane.com/resources/security-deposit-statistics)
- An undated Porch survey says landlords hold back 36.1% of deposits on average. — [Domino](https://www.domino.com/content/what-can-landlord-deduct-from-security-deposit/)
- UK, Generation Rent 2025: almost 1 in 4 tenants say their deposit was unfairly withheld, but most never challenge it. — [Generation Rent](https://www.generationrent.org/?p=10650)

**EU flight delay compensation (EU261)**
- Current compensation is €250-600 per passenger. A reform deal was reached June 15-16, 2026 (Parliament voted 646-12 on July 7, Council on July 13). It is expected to enter into force around August 2027. EPRS and others say the 3-hour delay threshold was kept, against the Commission's proposal to raise it. AeroMorning reports 4h/6h thresholds instead, which conflicts with the official sources. The final text should be checked. — [EPRS](https://eprs.europarl.europa.eu/contents/publications/EPRS/2026/06/EPRS_ATA(2026)789371.html); [CAPA](https://centreforaviation.com/news/eu-reaches-agreement-on-eu261-passenger-rights-regulation-revisions-1362892); [Euronews](https://www.euronews.com/2026/07/21/air-passenger-rights-reform-what-the-new-rules-mean-for-you); [AeroMorning](https://aeromorning.com/en/eu261-reform-a-compromise-with-no-winners-in-europe/); [CMS law note](https://cms.law/en/int/legal-updates/new-european-regulation-on-air-passenger-rights-what-impact-for-the-air-transport-sector)

**Subscriptions and bill negotiation (US)**
- Rocket Money self-reports a 90% negotiation success rate and an average of $105 saved per bill negotiated. — [Rocket Money learn page](https://www.rocketmoney.com/learn/personal-finance/best-bill-negotiation-services)
- The FTC click-to-cancel rule was vacated by the Eighth Circuit on July 8, 2025. The FTC issued an ANPRM in March 2026 to restart the rule. Enforcement continues under ROSCA and state auto-renewal laws. — [Gibson Dunn](https://gibsondunn.com/ftc-restarts-negative-option-rulemaking-after-eighth-circuit-vacatur-enforcement-under-rosca-continues/); [Jones Day, May 2026](https://www.jonesday.com/en/insights/2026/05/ftc-revives-clicktocancel-rule-new-risks-for-subscription-businesses)

### Inferences
- The largest dollars-at-stake per event that a consumer can act on are US health claim denials (often $1,000+) and property claims ($10k+). The largest time sinks are estate settlement (about 500 hours) and caregiver benefits paperwork (recurring and annual).
- The KFF "<1% appealed" figure sits alongside a 43% overturn rate on prior-auth appeals and a 33% reduction rate on claim appeals. That gap between low uptake and decent win rates is the clearest sign of a market where the job goes undone, not one where it is done badly.
- With the medical-debt credit rule gone, the federal click-to-cancel rule gone, and the CFPB pulled back, US consumers have fewer regulatory backstops in 2026. That raises demand for self-help tools.

### Gaps
- I found no reliable hours-per-household figure for medical bill disputes or Medicaid applications. AARP gives care hours, not admin hours.
- I found no reliable US data on parking or traffic ticket dismissal rates, immigration paperwork costs, side-income tax filing, or household document organization. These were not researched in depth because of the tool budget.
- EU-side medical, estate and caregiving data was not found. EU systems differ: universal coverage makes claim denials far less salient, and probate and succession rules vary by country.

---

## Q2. What do people already pay for, and what do reviews and forums say is still broken?

### Takeaway
Consumers already pay on three models. The first is a contingency share of recovery: Rocket Money takes 35-60% of first-year savings, AirHelp 35% (plus 15% for legal action), Flightright about 30%, and public adjusters 10-20%. The second is a flat fee per case: Claimable is about $40 per appeal, Mediloop $129 per bill, Billyze $79 per report, and Empathy charged $65 once at launch. The third is a subscription: Carefull is $29/month or $299/year. Complaints focus on fee opacity, actions taken without consent, and AI that cannot handle complex cases.

### Cited Findings

**Prices and fees**
- Rocket Money's bill-negotiation fee is "35% - 60% of your first year's savings". It is charged only on success and is non-refundable once charged. Rocket Money's help centre says that from Nov 2, 2026 negotiation is limited to Premium+ members (one 2026 review contradicts this). — [Rocket Money help](https://help.rocketmoney.com/en/articles/9744474-bill-negotiation-charge); [Penny Hoarder](https://www.thepennyhoarder.com/budgeting/rocket-money-review/)
- AirHelp's fee page (updated Aug 11, 2026) lists a 35% service fee including VAT, plus a 15% legal-action fee. Legal action is reportedly needed in about 3% of cases. Flightright charges up to about 30% plus VAT. A French review reports 27% rising to 36% in litigation. Sources conflict, and several are written by competitors. — [AirHelp fees](https://www.airhelp.com/en-int/our-fees); [IBTimes](https://www.ibtimes.co.uk/best-flight-compensation-companies-europe-uk-compared-1829519); [Luxe Admiral](https://www.luxe-admiral.com/blog/flightright-avis)
- Public adjusters: Texas caps the fee at 10% of the total claim payment, and the fee can apply to the whole settlement, not only the disputed part. The typical national range is 10-20%. — [Texas DOI](https://tdi.texas.gov/tips/public-adjusters.html); [Bankrate](https://www.bankrate.com/finance/insurance/hiring-a-public-adjuster-1.aspx)
- Medical: Claimable charges about $40 per appeal. Mediloop charges $129 per bill negotiation and also sells an annual household plan. Billyze charges $79 per bill-error report and refunds the fee if it finds no discrepancy on bills over $1,000. Fight Health Insurance and Counterforce Health are free. — [Time, Nov 2026](https://time.com/article/2026/11/12/how-ai-can-help-you-appeal-health-insurance-denials/); [Counterforce](https://www.counterforcehealth.org/)
- Sheer Health answers questions for free using AI plus humans, and charges to handle denials and out-of-network reimbursement (as of Nov 2025). — [Stateline/Lund Report](https://www.thelundreport.org/content/ai-vs-ai-patients-deploy-bots-battle-health-insurers-deny-care)
- Empathy charged a one-time $65 after a free month at launch (2021, possibly outdated). It is now also sold through employers and banks, for example the TD pilot in Canada in 2025. — [Freethink](https://www.freethink.com/hard-tech/what-to-do-when-someone-dies); [TD Stories](https://stories.td.com/ca/en/article/empathy-app)
- Carefull, which monitors elder finances and fraud and also helps with bill cancellation and negotiation, costs $29/month or $299/year in recent coverage, up from $9.99-12.99/month in 2021. Advisors get it free through Carefull Pro; another source cites $1,300-2,000 per advisor seat per year. — [TechCrunch](https://techcrunch.com/?p=2612309); [Greenlight comparison](https://greenlight.com/carefull-vs-greenlight); [PR Newswire 2021](https://prnewswire.com/news-releases/carefull-raises-3-2m-launches-platform-to-help-families-protect-a-loved-ones-finances-301229455.html); [WealthManagement](https://wealthmanagement.com/financial-technology/protecting-a-loved-one-s-finances-there-s-an-app-for-that)
- Executor fees come out of the estate. For example, Ohio guidelines give about $15k on a $500k estate, and New York pays 5% of the first $100k. Families therefore have an estate-funded budget for paid help. — [Trust & Will](https://trustandwill.com/learn/how-much-does-an-executor-get-paid); [SmartAsset](https://smartasset.com/estate-planning/executor-fees)

**What is broken (user voice and reviews)**
- Rocket Money has 273 BBB complaints in 3 years. Reported issues include "surprise charges over $100", poor support, trouble cancelling, and negotiations that "made changes they didn't agree to, then charged a fee". — [BBB](https://prod.bbb.org/us/md/silver-spring/profile/billing-services/rocket-money-inc-0241-236043013/complaints?page=13); [Inquirer review summary](https://usa.inquirer.net/166883/rocket-money-reviews-and-ratings)
- A July 2026 TV news piece warns that online bill negotiators "require personal data access". This is exactly the trust objection that local storage plus approval-before-action addresses. — [Atlanta News First, Jul 10 2026](https://www.atlantanewsfirst.com/2026/07/10/online-bill-negotiators-promise-savings-require-personal-data-access/)
- A patient whose self-drafted AI appeal failed said: "AI in and of itself isn't an answer." AI used by a knowledgeable professional is "a different story". Sheer Health then found a coding error, and surgery was approved about 3 weeks later. Sheer's cofounder said "there are complicated cases out there AI just can't resolve." — [Stateline/Lund Report, Nov 2025](https://www.thelundreport.org/content/ai-vs-ai-patients-deploy-bots-battle-health-insurers-deny-care)
- Harvard Law's Carmel Shachar says it is hard for a layperson to tell "when it is hallucinating". — [Stateline/Lund Report](https://www.thelundreport.org/content/ai-vs-ai-patients-deploy-bots-battle-health-insurers-deny-care)
- Patients don't appeal "because they don't know what paperwork to file or who to contact". Insurers hold most of the information about denial reasons. — [Time, Nov 2026](https://time.com/article/2026/11/12/how-ai-can-help-you-appeal-health-insurance-denials/)
- Some Commonwealth Fund respondents said providers threatened collections while the appeal was pending. — [Time, Nov 2026](https://time.com/article/2026/11/12/how-ai-can-help-you-appeal-health-insurance-denials/)
- An AgingCare caregiver on liquidating a parent's accounts for Medicaid: "each company has a different process, with different forms, for liquidating these funds, and I'm overwhelmed by this." Forum advice repeatedly says to see an elder-law attorney before filing. — [AgingCare](https://www.agingcare.com/questions/amp/449877)
- A forum claim says getting a POA after a dementia diagnosis can take months and several thousand dollars in legal fees. This is unverified forum content. — [AlzConnected/AgingCare results](https://alzconnected.org/discussion/comment/185195)
- An independent review of Empathy says it focuses on emotional support and guidance, so "you will still need to do all the administrative work yourself". The reviewer is a competitor (Elayne), so this is biased. — [Elayne](https://www.elayne.com/resources/empathy-reviews-pricing-alternatives)

### Inferences
- Contingency fees of 30-60% leave room for a cheaper, transparent, flat-fee or low-percentage product. That is especially true where the user still does most of the work anyway, such as uploading documents and approving the letter.
- The recurring complaint, "changed things I didn't agree to, then charged me", maps directly to the engine's approval-before-action model and audit log. That is a marketable difference, not just an internal feature.
- The medical-appeal market splits into free letter generators (Counterforce, Fight Health Insurance) and human-plus-AI services (Sheer). The gap in between is a persistent case manager: one that gathers records, tracks deadlines, escalates to external review and regulator complaints, and follows up with the provider's billing office.

### Gaps
- I found almost no verbatim Reddit quotes. Searches did not surface r/HealthInsurance, r/AgingParents or r/caregivers threads, probably because search indexing of Reddit is limited. Founders should mine these subreddits directly before building.
- I found no App Store or Trustpilot review data for Claimable, Sheer, Empathy or AirHelp.
- I did not verify current pricing for Sheer, Empathy (2026), Counsel Health, or Lantern. Lantern appears to be an employer specialty-care benefit rather than a consumer bill tool (not verified). Counsel Health is believed to be an AI-plus-physician medical advice product, not a bill tool (not verified).

---

## Q3. Which jobs do big companies now cover, and which remain open and why?

### Takeaway
ChatGPT Health (January 2026, broadly available in the US, excluded from the EEA, UK and Switzerland at launch) now covers explanation: medical records, benefits, plan comparison and surprise bills. Nobody large covers acting on the user's behalf. That means filing appeals, calling billers, submitting Medicaid or benefits applications, or running estate checklists end to end. Liability, unauthorized-practice-of-law risk, HIPAA and GDPR exposure, and the need for case-specific documents keep that work open.

### Cited Findings
- ChatGPT Health launched Jan 7, 2026. Users can connect lab results, visit summaries and clinical history through patient portals, Epic and Oracle Health, and b.well. Users can also compare plans on coverage and out-of-pocket costs. OpenAI says connected data is not used for training or ads, but it did not say the product is HIPAA-compliant. The EEA, Switzerland and the UK were excluded at launch. — [OpenAI](https://openai.com/index/introducing-chatgpt-health/); [Fierce Healthcare](https://www.fiercehealthcare.com/ai-and-machine-learning/openai-makes-health-chatgpt-widely-available-moving-deeper-consumer-health); [TechTarget](https://www.techtarget.com/patientengagement/news/366637098/OpenAI-launches-ChatGPT-Health-for-consumer-use); [Tom's Guide](https://www.tomsguide.com/ai/chatgpt/openai-launches-chatgpt-health-bringing-medical-records-and-wellness-data-into-chatgpt)
- I found no source confirming that ChatGPT Health integrates with billing or claims systems or submits appeals. The insurance feature looks like explanation and comparison only. — [HIT Consultant](https://hitconsultant.net/2026/01/07/openai-debuts-chatgpt-health/)
- Patients already use general chatbots, for example Grok to analyze an itemized hospital bill. 56% of AI users are not confident that AI health information is accurate (KFF, Aug 2024). — [Stateline/Lund Report](https://www.thelundreport.org/content/ai-vs-ai-patients-deploy-bots-battle-health-insurers-deny-care)
- Regulatory precedent on AI legal claims: in January/February 2025 the FTC finalized its order against DoNotPay ("robot lawyer"). It requires $193,000 in relief, notices to 2021-2023 subscribers, and a ban on claiming lawyer-equivalent performance without evidence. — [FTC](https://www.ftc.gov/node/87474); [ABA Journal](https://www.abajournal.com/news/article/robot-lawyer-website-donotpay-settles-ftc-claims-it-couldnt-deliver-on-promises); [Engadget](https://www.engadget.com/ai/donotpay-robot-lawyer-fined-193k-by-the-ftc-for-not-being-a-lawyer-223227153.html)
- On the insurer side, AI denials are under scrutiny. UnitedHealth, Humana and Cigna (PXDX) face lawsuits and investigations. In 2025, Arizona, Maryland, Nebraska and Texas banned AI as the sole decision-maker in prior-auth and medical-necessity denials, and more than a dozen states passed health-AI laws. — [Stateline/Lund Report](https://www.thelundreport.org/content/ai-vs-ai-patients-deploy-bots-battle-health-insurers-deny-care)
- EU: German flight-claim firms (Flightright) operate under a debt-collection (Inkasso) licence under the RDG, taking assignment of the claim. They have won about 180,000 judgments, a stakeholder figure. In 2026 the legal-tech lobby is seeking RDG liberalisation, and the consumer federation vzbv wants a dedicated legal-tech licence category. No 2026 bill text was confirmed. — [Cambridge Core article](https://www.cambridge.org/core/product/E0CFDB931436E79564BEA688AAA0EAA1/core-reader); [Bundestag lobby register](https://www.lobbyregister.bundestag.de/inhalte-der-interessenvertretung/stellungnahmengutachtensuche/SG2606110049); [vzbv statement 2025](https://www.vzbv.de/sites/default/files/2025-02/25-01-17_vzbv%20Stellungnahme_Legal%20Tech_mit%20Anh%C3%A4ngen.pdf); [LTO on Flightright](https://www.lto.de/recht/legal-tech/l/fluggastrechte-entschaedigung-automatisch-gruene-legal-tech-plattform-flightright/print.html)
- Banks and wealth firms are distributing, not building. Empathy is sold through TD and Citi partnerships, and Carefull through Nationwide and advisors. — [Citi](https://www.citigroup.com/global/news/perspectives/2025/flowers-financial-resilience-how-empathy-transforming-loss-support-legacy-planning); [WealthManagement on Nationwide-Carefull](https://www.wealthmanagement.com/financial-technology/preventing-elder-fraud-nationwide-partners-with-carefull)

### Inferences
- **Covered:** explaining an EOB, denial letter, bill or benefit, and comparing plans. ChatGPT Health, Gemini and bank assistants make "explain my document" a commodity, so a product built only on that has no moat.
- **Open:** (a) assembling a complete, cited evidence packet from the user's own documents (records, policy, EOBs, call logs); (b) tracking statutory deadlines across many months; (c) preparing outside submissions such as appeals, external review, state DOI complaints, Medicaid applications, estate creditor and institution notices, and flight claims, then sending them only after the user approves; (d) keeping an audit trail usable in an escalation. These need on-behalf action plus sensitive document custody. That is the engine's shape, and it is the part frontier labs avoid because of liability and HIPAA.
- In the US, UPL risk can be managed if the product is a self-help tool where the user is the filer, makes no "lawyer" claims (the DoNotPay lesson), and refers complex cases to licensed humans. In the EU, taking assignment of claims (the Flightright model) needs a licence. A self-help or "user sends it" model avoids that, but forgoes the contingency economics.
- Local data storage is a stronger trust story in the EU, where ChatGPT Health was not offered at launch and GDPR special-category health data applies, and among older caregivers handling a parent's bank and medical records.

### Gaps
- I did not research what Google Gemini, Apple, or US bank assistants (Bank of America Erica, etc.) do for bill disputes or subscription cancellation in 2026.
- I did not research US state-bar UPL actions against consumer AI in 2025-2026. A search returned nothing.
- EU Directive 2023/2673 (the "withdrawal button" for online contracts, believed to apply from June 2026) was not verified in this session.

---

## Q4. Which startups are attacking these jobs, on what pricing models, with what traction?

### Takeaway
VC money in 2026 billing AI has gone mostly to the provider side: Candid $120M, Lassie $35M, Adonis $40M and Charta $55M, according to aggregators. Consumer-side players are small, often free or nonprofit, or sold per case. In estate settlement, Empathy has raised $72M in its Series C and sells through employers and banks. Caregiver tooling is fragmented and partly grant-funded: the HHS Caregiver AI Prize named 19 Phase 1 winners in Nov 2026 with up to $100k each, Ianacare among them.

### Competition map

| Job | Players (pricing) | Model | Traction / notes |
|---|---|---|---|
| Health claim / prior-auth appeal | Claimable (about $40/appeal; 28 conditions, 90 treatments; self-reported about 80% success) | Per case | [PYMNTS 2026](https://www.pymnts.com/artificial-intelligence-2/2026/insurance-denials-meet-their-match-in-ai-powered-appeals/), [US News](https://health.usnews.com/wellness/articles/use-ai-to-help-fight-a-health-insurance-denial), [Time](https://time.com/article/2026/11/12/how-ai-can-help-you-appeal-health-insurance-denials/) |
| | Counterforce Health (free nonprofit; claims "2x win rate"), Fight Health Insurance (free) | Free | [Counterforce](https://www.counterforcehealth.org/), [Wikipedia](https://en.wikipedia.org/wiki/Counterforce_Health) |
| | Sheer Health (free Q&A; paid human-plus-AI case handling) | Freemium plus service | "thousands of cases" of last-minute surgery non-approval ([Stateline](https://www.thelundreport.org/content/ai-vs-ai-patients-deploy-bots-battle-health-insurers-deny-care)) |
| Medical bill errors / negotiation | Mediloop ($129/bill; annual household plan), Billyze ($79/report, refund guarantee) | Per case | [Time](https://time.com/article/2026/11/12/how-ai-can-help-you-appeal-health-insurance-denials/) |
| Provider-side (not direct competitors, but they shape insurer and provider behaviour) | Candid ($120M), Lassie ($35M Series A), Adonis ($40M Series C), Charta ($55M Series B), Anomaly ($17M) | B2B | Aggregator data, unverified: [RevCycleAI tracker](https://revcycleai.com/blog/rcm-funding/), [Emergefolio](https://emergefolio.com/healthcare-ai-funding-news/) |
| Bill negotiation / subscriptions | Rocket Money (35-60% of year-1 savings; Premium+ only from Nov 2026), Carefull (includes bill help) | Contingency / subscription | [Rocket Money help](https://help.rocketmoney.com/en/articles/9744474-bill-negotiation-charge) |
| EU flight compensation | AirHelp (35% plus 15% legal), Flightright (about 30% plus VAT), many others | Contingency, claim assignment | About 180k judgments for Flightright (stakeholder claim) ([Bundestag](https://www.lobbyregister.bundestag.de/inhalte-der-interessenvertretung/stellungnahmengutachtensuche/SG2606110049)) |
| Estate settlement | Empathy ($13M seed, $72M Series C in May 2025; $65 one-time at launch; B2B2C through TD, Citi, employers), Elayne (YC; AI executor for employees; claims to save up to 400 hours), Eversettled ($5M, Emergence; probate AI), Atticus (content plus services) | B2B2C / one-time | [Fortune](https://fortune.com/2025/05/29/exclusive-empathy-raises-72-million-series-c-to-tackle-the-agonizing-logistics-of-death/), [YC Elayne](https://www.ycombinator.com/launches/LkE-elayne-ai-estate-planner-executor-for-employees-and-their-families), [TechFundingNews](https://techfundingnews.com/eversettled-5m-funding-emergence-capital-probate-ai/), [Atticus](https://www.weareatticus.com/learn/executor-of-estate-fees) |
| Caregiver admin / elder finances | Carefull ($29/mo; raised $16.5M per TechCrunch), Ianacare (AI plus human navigators; HHS prize winner), HHS Caregiver AI Prize (19 winners, up to $100k each) | Subscription / employer / grants | [TechCrunch](https://techcrunch.com/?p=2612309), [HHS](https://www.hhs.gov/press-room/hhs-announces-caregiver-ai-prize-challenge-phase-one-winners.html), [DailyCaring](https://dailycaring.com/ai-caregiving-tools/) |
| Property claims | Public adjusters (10-20% contingency; capped at 10% in Texas) | Contingency, licensed | [Texas DOI](https://tdi.texas.gov/tips/public-adjusters.html) |
| AI "robot lawyer" generalist | DoNotPay (FTC order 2025) | Subscription | Cautionary tale: [FTC](https://www.ftc.gov/node/87474) |

### Cited Findings
- Coverage notes that the open models became good enough for appeal drafting around early 2024. Fight Health Insurance reuses language from published state regulator decisions, for example a California ruling overturning an X-ray-before-MRI requirement. — [Time](https://time.com/article/2026/11/12/how-ai-can-help-you-appeal-health-insurance-denials/)
- Claimable's founder: "if you could ... give patients the ability to argue articulately against the insurer, you might actually change someone's life." In one case, a Crohn's patient denied Remicade had it approved 5 days after a Claimable letter. — [Time](https://time.com/article/2026/11/12/how-ai-can-help-you-appeal-health-insurance-denials/)
- Investor rule of thumb for caregiver AI: a Series A needs $2-8M ARR. Unverified guide. — [StartupFundraising](https://startupfundraising.com/ai-elder-care-aging-in-place-fundraising)

### Inferences
- Consumer health appeals are getting crowded at the letter-writing layer, with free tools pushing the price toward zero. Room remains for a case-management layer above the letter: deadlines, records gathering, external review, DOI complaints, and provider-billing holds to keep the bill out of collections.
- Estate settlement is the best-funded consumer category. It is distributed B2B2C (employers, banks, insurers) because a death is unpredictable and paid search for it is expensive and sensitive. A small team would likely need the same channel, or a partner such as an estate attorney or funeral home.
- Caregiver admin has strong pain and no dominant tool. Its buyers (adult children aged 45-65) spend $11.5k a year out of pocket, but caregiver apps have historically sold through employers and payers.

### Gaps
- I found no public revenue or user numbers for Claimable, Sheer, Counterforce, Mediloop or Billyze.
- AirHelp and Flightright success rates and volumes were not found.
- Counsel Health and Lantern were not verified. They appear to be outside the consumer bill/appeal job.

---

## Q5. Candidate narrow opportunities for a 2-5 engineer team with the engine

### Takeaway
Ranked by fit: (1) health-claim appeal case manager for caregivers and chronic patients, US; (2) Medicaid LTC / benefits application packet builder for adult children, US; (3) executor's estate-admin workspace, US first, sold through estate attorneys or employers; (4) a home-insurance claim file builder (property claim evidence and supplement), US; (5) an EU travel and consumer-claims self-filer that uses no claim assignment, to avoid the licence. Subscription cancellation and bill negotiation is the weakest option: Rocket Money dominates, margins are fee-based, and the job is commoditising.

### Cited Findings (supporting each option; see Q1-Q4 for full sourcing)

**Option A. Health-claim appeal and medical-bill dispute case manager (US). Best fit.**
- Who pays: chronic-illness patients and family caregivers managing a parent's or child's claims. Stakes: 43% of claim denials led to debt, often $1,000+. — [Commonwealth Fund](https://www.commonwealthfund.org/publications/surveys/2026/jun/how-health-insurance-coverage-denials-affect-americans-2025-affordability-survey)
- Price evidence: $40/appeal (Claimable), $79-129/bill (Billyze, Mediloop), and Sheer's paid tier. Free alternatives exist for letters only. — [Time](https://time.com/article/2026/11/12/how-ai-can-help-you-appeal-health-insurance-denials/)
- Frequency: recurring for chronic patients and caregivers (about 21% of privately insured adults had a denial in a year).
- What is unsolved: knowing which paperwork to file and who to contact, insurer information asymmetry, collections threats while an appeal is pending, and complex cases AI alone fails. — [Time](https://time.com/article/2026/11/12/how-ai-can-help-you-appeal-health-insurance-denials/); [Stateline](https://www.thelundreport.org/content/ai-vs-ai-patients-deploy-bots-battle-health-insurers-deny-care)

**Option B. Medicaid long-term care / benefits application packet builder (US caregivers).**
- Pain: cumbersome paperwork, deadlines, annual renewals, the 5-year look-back, and denials for missing documents. Asset-calculation errors cost families months. — [Columbia SIPA](https://www.sipa.columbia.edu/sites/default/files/migrated/downloads/CPD_ColumbiaCapstone.pdf); [Baltimore Banner](https://www.thebaltimorebanner.com/community/public-health/maryland-medicaid-home-care-backlog-K573AO6C3ZFDPH436D55LB6EYU/)
- Who pays: adult children (63M caregivers, $11.5k/yr out of pocket) or elder-law attorneys as a B2B tool. — [AARP 2026](https://www.aarp.org/press/releases/2026-10-28-aarp-family-caregivers-out-of-pocket-costs-jump-almost-60-in-five-years-to-more-than-11500-annually/)
- The job is a sorted packet of 3-5 years of bank statements plus a transfer analysis. One JustAnswer user describes DHS requesting 3 years of bank statements. — [JustAnswer](https://www.justanswer.com/law/7lofd-department-human-services-requested-bank-statements.html)

**Option C. Executor estate-admin workspace (US).**
- Pain: about 570 hours and 16-18 months. The average estate spends $12.4k on legal and accounting. Executor compensation is estate-funded. — [Fortune](https://fortune.com/2025/05/29/exclusive-empathy-raises-72-million-series-c-to-tackle-the-agonizing-logistics-of-death/); [Trust & Will/EstateExec](https://trustandwill.com/learn/how-much-does-an-executor-get-paid)
- Competition: Empathy ($85M+ raised in total; B2B2C), Elayne (YC), Eversettled ($5M), and EstateExec. A review of Empathy says the admin work is still left to the user. — [Elayne review](https://www.elayne.com/resources/empathy-reviews-pricing-alternatives)

**Option D. Homeowner property claim file builder (US).**
- Stakes: claims of $25k+ have a 19% dispute rate. A secondhand WSJ figure says 44% of claims at the top-5 insurers closed without payment in 2025. Public adjusters charge 10-20% of the whole claim. — [UP Help/CR](https://uphelp.org/consumer-reports-rates-home-insurers/?print=pdf); [Open Class Actions](https://openclassactions.com/blog/homeowners-insurance-claim-denied-underpaid.php); [Bankrate](https://www.bankrate.com/finance/insurance/hiring-a-public-adjuster-1.aspx)
- Legal risk: negotiating a claim for a fee requires a public adjuster licence in most states. Texas DOI regulates them. — [Texas DOI](https://tdi.texas.gov/tips/public-adjusters.html)

**Option E. EU consumer-claims self-filer (flights first, later deposits and purchase disputes).**
- Fees today are 30-35% plus up to 15% for litigation. The reform keeps the 3h threshold, per EPRS, and is expected from 2027. — [AirHelp](https://www.airhelp.com/en-int/our-fees); [EPRS](https://eprs.europarl.europa.eu/contents/publications/EPRS/2026/06/EPRS_ATA(2026)789371.html)
- Licence risk: the Flightright model relies on an RDG Inkasso licence and claim assignment. A self-filing tool, where the user sends and the user is the claimant, avoids that but cannot litigate. — [Cambridge Core](https://www.cambridge.org/core/product/E0CFDB931436E79564BEA688AAA0EAA1/core-reader)

**Option F, ruled out or weak. Subscription cancellation and bill negotiation.**
- Rocket Money owns the category, charges 35-60%, and attracts trust complaints. The FTC rule is vacated but ROSCA enforcement continues. Low ticket (about $105 saved per bill, company-reported), so CAC is hard to recover. — [Rocket Money](https://help.rocketmoney.com/en/articles/9744474-bill-negotiation-charge); [Rocket Money learn](https://www.rocketmoney.com/learn/personal-finance/best-bill-negotiation-services)

### Inferences (feasibility judgements: these are the analyst's reasoning, not sourced facts)

**A. Health appeal case manager. Feasibility: HIGH. Recommended #1.**
- Product: the user drops in the denial letter, EOBs, policy (SBC/plan document) and records, all stored locally. The agent extracts the denial reason, the plan's appeal deadline, and the internal → external review → state DOI path. It drafts the appeal using plan language plus published external-review decisions, as Fight Health Insurance does. It drafts a "please hold this account from collections pending appeal" letter to the provider. After user approval it sends by email, fax API, or the insurer portal, and logs every call. A deadline calendar runs over the following months.
- Engine fit: local storage of PHI, approval before each fax or email, and an audit log that doubles as evidence for an external review or DOI complaint. Skills-as-files fit per-insurer and per-state playbooks.
- Pricing: per-case $49-99, or a $15-25/month "family claims" plan for caregivers and chronic patients. A success fee of 10-20% of the reduced amount is possible on bills, but adds billing complexity.
- CAC risk: moderate. Search intent is strong ("appeal insurance denial") but free tools compete there. Better channels are disease communities (Crohn's, oncology, autism ABA, GLP-1 denials), patient advocates, and employers.
- Legal: HIPAA does not apply to a consumer-direct app, but FTC Health Breach Notification Rule and state health-privacy laws (e.g., WA My Health My Data) likely do; this was not verified this session. Avoid "lawyer" claims (DoNotPay). The patient is the appellant.
- 3-month MVP: a denial-letter parser, a deadline engine for the ERISA, ACA marketplace, Medicare Advantage and Medicaid paths, an appeal drafter with a citations pack, a provider hold letter, a fax/email send step behind an approval gate, and a case timeline. Start with 3-5 high-volume denial types, for example prior-auth for imaging, specialty drugs and GLP-1s, and out-of-network emergency care under the No Surprises Act.

**B. Medicaid LTC packet builder. Feasibility: MEDIUM-HIGH. Recommended #2, possibly sold B2B to elder-law firms.**
- Product: ingest 36-60 months of a parent's bank statements and PDFs locally. The agent classifies transactions, flags look-back transfers, builds the state's required document checklist, fills the application, and tracks renewal deadlines.
- Engine fit: very sensitive financial data kept local, sandboxed scripts for statement parsing, per-state skills, and approval before submission.
- Pricing: a consumer one-off of $199-499 is plausible next to elder-law fees in the thousands, but that comparison is not sourced. A B2B elder-law or care-manager seat is the better first market, because CAC is lower and the attorney carries the legal advice and the UPL risk.
- Risk: there are 50 state variants, and look-back analysis touches legal advice. Stay in the "organize and flag" role and leave planning advice to the attorney.
- 3-month MVP: one or two states, a statement parser plus transfer flags, a document checklist, and a renewal tracker.

**C. Executor workspace. Feasibility: MEDIUM.**
- Product: the agent inventories accounts from mail and statements, generates and tracks notification letters to banks, insurers, Social Security, credit bureaus and subscriptions, and keeps the creditor-claim period and the estate ledger. Each outgoing letter needs approval.
- Fit: strong, because of document volume, a long horizon and audit needs. But Empathy is well funded and distribution is B2B2C. As a solo consumer play, CAC on grief-related search is a concern.
- 3-month MVP: a single-state checklist, letter generation, an asset/liability ledger, and an accounting export for the court.

**D. Property claim file builder. Feasibility: MEDIUM-LOW.** The stakes are high, but the product needs photo and estimate tooling (Xactimate-style line items), and adjuster licensing limits fee-for-negotiation. A possible wedge is "claim documentation and supplement request" sold to homeowners after storms, or a white-label tool for public adjusters.

**E. EU self-filer. Feasibility: MEDIUM. Small-ticket economics.** Value per claim is €250-600 and incumbents are strong. The local-data and GDPR story is good. The main risk is the 2027 regulation change.

**Cross-cutting**
- The engine's approval-before-action design, audit log and local storage answer the top consumer objections in this segment: unconsented changes and fees (Rocket Money), sending all personal data to a third party (bill negotiators), and AI mistakes nobody catches (appeals). These should lead the positioning.
- Consumer CAC is the main business risk for every option. B2B2C channels (employers, elder-law firms, patient-advocacy groups, banks) appear across the funded players (Empathy, Carefull, Ianacare).

### Gaps
- I found no CAC benchmarks for consumer health or estate apps.
- I found no data on willingness to pay a subscription for a "family claims manager" versus per case.
- The privacy regime for a consumer health app (FTC HBNR, WA MHMDA) and state UPL exposure were not verified this session.
- Parking and traffic tickets, immigration paperwork, side-income taxes and household document organization were not researched in enough depth to rank. They are presumed lower priority because big players (TurboTax and others) and law-firm models already cover them, but this is unverified.
