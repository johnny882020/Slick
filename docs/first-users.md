# Run OneSeat with your first users

From this repo to feedback from real teams. The desktop app keeps each team's business
data and model key on their computer; **OneSeat Cloud** (Render + Neon) only handles the
website, licenses, installer links and feedback. Stripe is for paying customers only: pilot
teams never see a checkout. The decision is in
[`docs/adr/0001-pilot-onboarding-and-installers.md`](adr/0001-pilot-onboarding-and-installers.md).

```
Tester's computer                         OneSeat Cloud (Render, Frankfurt)
  OneSeat app ── model calls ──▶ Claude / OpenAI / Gemini (tester's own key)
      │  license check, feedback
      ▼
  https://oneseat-cloud.onrender.com ◀── Stripe webhooks (paying customers, test mode)
      │   /pilot, /admin, /download/windows, /download/mac
      ▼
  Neon Postgres "oneseat" (accounts, subscriptions, licenses, computers, feedback)

  GitHub release "pilot" ── the CI-tested installers that /download/* redirects to
```

## What is already set up

| Piece | Where | State |
|---|---|---|
| Website + API | Render service `oneseat-cloud`, https://oneseat-cloud.onrender.com | Live, auto-deploys from the PR branch |
| Database | Neon project `oneseat` (AWS eu-central-1), branches `main` and `dev` | Live; tables created on start |
| Pilot licenses | https://oneseat-cloud.onrender.com/admin → **Invite a pilot team** | Team plan, 15 computers, ends by itself |
| Pilot installers | GitHub release `pilot`, published by `.github/workflows/pilot-release.yml` | Run it with the `pilot-release` label |
| Download links | `/download/windows` and `/download/mac` redirect to `DOWNLOAD_WINDOWS_URL` / `DOWNLOAD_MAC_URL` | Work once the env vars are set |
| Plans (paying customers) | Stripe (test mode): OneSeat Pro $19/mo or $182.40/yr, Team $79/mo or $758.40/yr | Live as Payment Links |
| Billing portal | Stripe customer portal ("Manage billing" on the website) | Live |
| Webhook | Stripe → `/api/v1/stripe/webhook` (signed) | Live; verified end to end |
| Free plan | No account needed: 1 computer, the 7 starter skills | In the app |

The old Stripe pilot code `ONESEATPILOT` is not part of the pilot any more. Don't give it to
testers. It can be retired in Stripe once no test depends on it.

## 1. Finish the cloud setup (5 minutes, once)

In the Render dashboard → `oneseat-cloud` → **Environment**, add:

| Key | Value |
|---|---|
| `LICENSE_PRIVATE_KEY` | The one line in the file `license-private.escaped` Claude generated (it starts `-----BEGIN PRIVATE KEY-----\n`). It signs licenses; its public half is built into the app. Keep it secret and backed up. |
| `ADMIN_TOKEN` | Any long password (or the one in `admin-token.txt`). Opens `/admin` with user `admin`. |
| `DOWNLOAD_WINDOWS_URL` | `https://github.com/johnny882020/Slick/releases/download/pilot/OneSeat-Windows-x64-setup.exe` |
| `DOWNLOAD_MAC_URL` | `https://github.com/johnny882020/Slick/releases/download/pilot/OneSeat-macOS-AppleSilicon.dmg` |

Then check https://oneseat-cloud.onrender.com/healthz shows `"licensing":true`.

The service is on Render's free plan: the first request after 15 idle minutes takes about a
minute. Use the Starter plan before real customers.

To test the paid checkout (not needed for the pilot), run:

```bash
node apps/cloud/scripts/checkout-smoke.mjs https://buy.stripe.com/test_00wfZi5Dh72g05C9ovgw004
```

It buys Team in Stripe test mode (with the old 100%-off code), then activates the key and
verifies the signed license.

## 2. Check that CI and live QA are green

GitHub Actions needs minutes: Settings → Billing and plans → Usage (private repos count
macOS minutes 10× and Windows 2×). Raise the spending limit or make the repo public.

1. Pull request → **Checks**: all green on Windows, macOS and Linux, including the unsigned
   builds with their **install smoke test** and the cloud store on Postgres.
2. Add the label **`live-qa`** to the pull request. It runs the shipped engine through 8
   real-model scenarios on each provider that has a key and a model variable, then gate 5.
   Optional secret `ONESEAT_QA_LICENSE_KEY` (a pilot Team key from `/admin`) also tests
   license activation and pinned apps against OneSeat Cloud.
3. Ship to testers only when every Live QA row is PASS. A `BLOCKED (account)` row means a
   provider account ran out of credit or quota, not a OneSeat failure.

Accounts: Claude and OpenAI API keys need prepaid API credit (a Claude Pro/Max or ChatGPT
plan does not include it). Gemini's free tier works, but it allows only about 20 requests a day.

## 3. Publish the installers

After CI is green on the commit you want to ship, add the label **`pilot-release`** to the pull
request (or Actions tab → **Pilot release** → **Run workflow**). It takes the unsigned installers
that this CI run built and install-tested, and publishes them as the GitHub release `pilot`:

- `https://github.com/johnny882020/Slick/releases/download/pilot/OneSeat-Windows-x64-setup.exe`
- `https://github.com/johnny882020/Slick/releases/download/pilot/OneSeat-macOS-AppleSilicon.dmg`
- `SHA256SUMS.txt` with the checksums

Nothing is rebuilt. If it fails with "No successful CI run", wait for CI to finish and run it
again. The file names never change, so the Render env vars from step 1 stay the same.

Always send people the website's links, not the GitHub ones:
https://oneseat-cloud.onrender.com/download/windows and
https://oneseat-cloud.onrender.com/download/mac (or the `/download` page).

## 4. Try it yourself (15 minutes)

First create a pilot license for yourself (step 5). Then, on one Windows PC and one Mac:
install from `/pilot`, paste a model key, and

1. "Add a customer: Jane Smith, jane@acme.com." → "Who are my customers?"
2. "Draft an invoice for Jane: 3 hours at $150/hour, 8.25% tax." The total is $487.13.
3. "Write a thank-you email to Jane." It drafts and does not send.
4. "Delete Jane." An **Approve / Deny** box appears; deny it and Jane stays.
5. **Plan**: Free. Try **Pin as app** on a made app: it asks for Pro or Team.
6. **Plan** → paste your pilot license key → **Activate**. Pin the app; it opens in its own
   window and shows data.
7. **Plan → Send feedback**, then open https://oneseat-cloud.onrender.com/admin to see it.

## 5. Invite a pilot team

1. Open https://oneseat-cloud.onrender.com/admin. User `admin`, password = the `ADMIN_TOKEN`
   you set on Render.
2. Fill in **Invite a pilot team**: team name, contact email, and pilot length (2, 4, 6 or
   8 weeks; 4 is the default). Choose **Create pilot license**.
3. The next page shows the Team license key (15 computers, status `trialing`) and the end date.
   **It shows the key once.** Send the invitation right away: **Open the invitation in my
   email**, or copy the invitation text below the button.
4. The invitation has the key, the `/pilot` link, the two download links and the four steps.
   You can also attach `docs/pilot-tester-guide.md`.
5. Add the team to `docs/pilot.md`: name, license created date, pilot end date.

Each team uses one key on all its computers (up to 15). Start with 2–3 teams for a week, then
widen to 10 for the two-week pilot (gate 7).

If a key is lost, create a new license for the team; the old one ends on its own end date.

When the end date passes, activation and refresh return `canceled` and the app falls back to
Free. The team's data stays on their computers, and they can buy a plan at `/#plans`.

**Self-serve trial.** Testers no longer need an invitation key: on Free, **Plan → Try Team free
for 14 days** takes an email, and OneSeat Cloud (`POST /api/v1/trials`) issues a Team key
(15 computers, status `trialing`, ends after 14 days) and activates that computer with it. The
app shows the key once so the tester can use it on the team's other computers. One trial per
email and per computer, ever; a repeat gets `trial_used`. Trials appear on `/admin` with the
team "Trial" and a **trial** tag. Invitations from **Invite a pilot team** remain for the teams
you set up yourself (longer pilots, tracked in `docs/pilot.md`).

## 6. Collect feedback

- In the app: **Plan → Send feedback** (rating, topic, message). It lands in Neon and on
  `/admin` with the license, OS and app version. No keys or business data.
- The GitHub issue form "Pilot feedback" for teams that use GitHub.
- On `/admin`, the **Licenses** table shows each pilot team, its end date and computers
  active (for example `3 / 15`). Copy those into `docs/pilot.md` each week, with the team's
  feedback count (feedback rows show the sender's email and license id, not the team name).
  Any action without approval stops the pilot.

## 7. Ship fixes during the pilot

Fix on a branch → push → CI green → `live-qa` label → re-add the **`pilot-release`** label (or
re-run **Pilot release**) → tell testers to download again from the same links. The `pilot`
release always holds the newest tested build. Data, keys and licenses survive reinstalling.
The cloud redeploys itself on every push to the branch Render tracks.

## 8. Before charging real money

1. Merge the PR and point Render at `main` (Render → Settings → Branch).
2. Create a Stripe account for OneSeat (this one is "Integrity.si", and that name shows on
   checkout and receipts), set up Stripe Tax (e.g. EU VAT registrations), recreate the
   products, prices, links, portal and webhook in live mode, and update the Render env.
   Retire the `ONESEATPILOT` coupon.
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
