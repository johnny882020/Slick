# Run OneSeat with your first users

From this repo to feedback from real teams. The desktop app keeps each team's business
data and model key on their computer; **OneSeat Cloud** (Render + Neon + Stripe) only
handles the website, plans, licenses and feedback.

```
Tester's computer                         OneSeat Cloud (Render, Frankfurt)
  OneSeat app ── model calls ──▶ Claude / OpenAI / Gemini (tester's own key)
      │  license check, feedback
      ▼
  https://oneseat-cloud.onrender.com ◀── Stripe webhooks (Payment Links, test mode)
      │
      ▼
  Neon Postgres "oneseat" (accounts, subscriptions, licenses, computers, feedback)
```

## What is already set up

| Piece | Where | State |
|---|---|---|
| Website + API | Render service `oneseat-cloud`, https://oneseat-cloud.onrender.com | Live, auto-deploys from the PR branch |
| Database | Neon project `oneseat` (AWS eu-central-1), branches `main` and `dev` | Live; tables created on start |
| Plans | Stripe (test mode): OneSeat Pro $19/mo or $182.40/yr, Team $79/mo or $758.40/yr | Live as Payment Links |
| Pilot code | `ONESEATPILOT`: 100% off Pro or Team for 2 months, 15 uses, no card needed | Live |
| Billing portal | Stripe customer portal ("Manage billing" on the website) | Live |
| Webhook | Stripe → `/api/v1/stripe/webhook` (signed) | Live; verified end to end |
| Free plan | No account needed: 1 computer, the 7 starter skills | In the app |

Verified live: a test checkout of Team with the pilot code → Stripe webhook → Render →
Neon → the welcome page shows the license key (`apps/cloud/scripts/checkout-smoke.mjs`).

## 1. Finish the cloud setup (5 minutes, once)

In the Render dashboard → `oneseat-cloud` → **Environment**, add:

| Key | Value |
|---|---|
| `LICENSE_PRIVATE_KEY` | The one line in the file `license-private.escaped` Claude generated (it starts `-----BEGIN PRIVATE KEY-----\n`). It signs licenses; its public half is built into the app. Keep it secret and backed up. |
| `ADMIN_TOKEN` | Any long password (or the one in `admin-token.txt`). Opens `/admin` with user `admin`. |
| `DOWNLOAD_WINDOWS_URL`, `DOWNLOAD_MAC_URL` | Where you host the installers (step 3), when you have them. |

Then check https://oneseat-cloud.onrender.com/healthz shows `"licensing":true`, and run:

```bash
node apps/cloud/scripts/checkout-smoke.mjs https://buy.stripe.com/test_00wfZi5Dh72g05C9ovgw004
```

It buys Team with the pilot code in test mode, then activates the key and verifies the
signed license. The service is on Render's free plan: the first request after 15 idle
minutes takes about a minute. Use the Starter plan before real customers.

## 2. Check that CI and live QA are green

GitHub Actions needs minutes: Settings → Billing and plans → Usage (private repos count
macOS minutes 10× and Windows 2×). Raise the spending limit or make the repo public.

1. Pull request → **Checks**: all green on Windows, macOS and Linux, including the unsigned
   builds with their **install smoke test** and the cloud store on Postgres.
2. Add the label **`live-qa`** to the pull request. It runs the shipped engine through 8
   real-model scenarios on each provider that has a key and a model variable, then gate 5.
   Optional secret `ONESEAT_QA_LICENSE_KEY` (a pilot Team key) also tests license
   activation and pinned apps against OneSeat Cloud.
3. Ship to testers only when every Live QA row is PASS. A `BLOCKED (account)` row means a
   provider account ran out of credit or quota, not a OneSeat failure.

Accounts: Claude and OpenAI API keys need prepaid API credit (a Claude Max or ChatGPT
plan does not include it). Gemini's free tier works but its daily quota is small.

## 3. Get and host the installers

Pull request → **Checks** → latest **CI** run → **Artifacts**:
`unsigned-windows-latest` (`nsis/OneSeat_<version>_x64-setup.exe`) and
`unsigned-macos-latest` (`dmg/OneSeat_<version>_aarch64.dmg`, Apple silicon). Upload both to
a file host you control (Google Drive, Dropbox, S3/R2) with public links, and put the links
in `DOWNLOAD_WINDOWS_URL` / `DOWNLOAD_MAC_URL`. The website's Download page then works.

## 4. Try it yourself (15 minutes)

On one Windows PC and one Mac: install, paste a model key, then

1. "Add a customer: Jane Smith, jane@acme.com." → "Who are my customers?"
2. "Draft an invoice for Jane: 3 hours at $150/hour, 8.25% tax." The total is $487.13.
3. "Write a thank-you email to Jane." It drafts and does not send.
4. "Delete Jane." An **Approve / Deny** box appears; deny it and Jane stays.
5. **Plan**: Free. Try **Pin as app** on a made app: it asks for Pro or Team.
6. Buy Team on https://oneseat-cloud.onrender.com/pilot with code `ONESEATPILOT`, paste the
   key in **Plan → Activate**. Pin the app; it opens in its own window and shows data.
7. **Plan → Send feedback**, then open https://oneseat-cloud.onrender.com/admin to see it.

## 5. Invite the first teams

Send each team https://oneseat-cloud.onrender.com/pilot, the installer link, the code
`ONESEATPILOT`, and `docs/pilot-tester-guide.md`. Start with 2–3 teams for a week, then
widen to 10 for the two-week pilot (gate 7). Each team's Team license covers 15 computers.

## 6. Collect feedback

- In the app: **Plan → Send feedback** (rating, topic, message). It lands in Neon and on
  `/admin` with the team's license, OS and app version. No keys or business data.
- The GitHub issue form "Pilot feedback" for teams that use GitHub.
- Track each team in `docs/pilot.md`. Any action without approval stops the pilot.

## 7. Ship fixes during the pilot

Fix on a branch → PR → CI builds new installers → `live-qa` label → upload the new
installers → tell testers. Data, keys and licenses survive reinstalling. The cloud
redeploys itself on every push to the branch Render tracks.

## 8. Before charging real money

1. Merge the PR and point Render at `main` (Render → Settings → Branch).
2. Create a Stripe account for OneSeat (this one is "Integrity.si", and that name shows on
   checkout and receipts), set up Stripe Tax (e.g. EU VAT registrations), recreate the
   products, prices, links, portal and webhook in live mode, and update the Render env.
3. Move Render to a paid plan (no cold starts) and enable Neon backups you are happy with.
4. Sign the installers: add the release secrets and push a `v*` tag (`.github/workflows/release.yml`).

## Running it from source (developers)

```bash
pnpm install
pnpm build
pnpm --filter @oneseat/desktop tauri dev
```

```bash
pnpm test
pnpm gates
```

Cloud locally (in-memory store, no Stripe):

```bash
pnpm --filter @oneseat/cloud build && node apps/cloud/dist/main.js
```
