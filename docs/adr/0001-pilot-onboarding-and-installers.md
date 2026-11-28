# ADR-0001: Pilot onboarding and installer distribution

**Status:** Accepted
**Date:** 2026-11-27
**Deciders:** OneSeat lead (product owner), streams C (cloud) and F (CI)

## Context

A pilot tester has to get from an invitation to a first useful run. Before this decision that path
was broken in two places.

**Installers were not hosted.** CI builds and install-tests unsigned Windows and macOS installers,
but they only existed as CI artifacts: they need a GitHub login and they expire after 30 days. The
website's Download page had no URL, so it said "coming soon" on both platforms. The pilot page's
first step linked to that page, so the pilot was blocked before it started.

**The pilot ran through a paid checkout.** The pilot page showed the $79/month Team price, and
asked the tester to start a Stripe subscription and enter a 100%-off code. The page never said
what the code was. After checkout the tester copied a license key (shown for 24 hours) into the
app. That is three systems and a fake purchase to get a free trial. It also has other problems:

- It runs real people through Stripe **test mode**, under the Stripe account's business name.
- Every pilot team becomes a $0 subscription that we have to cancel by hand when the pilot ends.
- Nothing ties a license to a pilot team, so gate 7 (`docs/pilot.md`) can't be tracked per team.

The forces that matter:

- **Local first:** business data and model keys never leave the tester's computer (CLAUDE.md).
- **Small team, small budget:** there is no ops staff. Render and Neon are on free plans.
- **Gate 7:** 10 teams for 2 weeks, tracked per team, and any action taken without approval stops the pilot.
- **Shipped means tested:** testers must get the same files the install smoke test installed.

## Decision

1. **Pilot teams get admin-issued Team licenses, not a checkout.** On `/admin`, the lead creates a
   pilot license for a team: its name, a contact email, and the pilot length (4 weeks by default).
   The service makes an ordinary Team license (15 computers, status `trialing`) with an end date,
   and shows the key once together with a ready-to-send invitation. The tester pastes the key into
   **Plan → Activate**. That is the activation path paying customers already use, so the desktop
   app and the contracts don't change. When the end date passes, activation and refresh return
   `canceled` and the app falls back to Free. The tester's data stays, and they can buy a plan.
   Stripe is kept for paying customers only.
2. **Installers ship as the GitHub release `pilot`, from the CI run that tested them.** The
   `pilot-release.yml` workflow takes `unsigned-windows-latest` and `unsigned-macos-latest` from
   the green CI run for a commit and publishes them under fixed names with a `SHA256SUMS.txt`. It
   runs from the `pilot-release` label or by hand. Nothing is rebuilt.
3. **The website owns stable download URLs.** `/download/windows` and `/download/mac` redirect to
   the configured file (`DOWNLOAD_WINDOWS_URL`, `DOWNLOAD_MAC_URL`). Pages, emails and the app link
   to those routes, never to file hosting, so the host can change later without breaking a link.
4. **The pilot page is a checklist with no prices.** The steps are: download, get a model key,
   paste the license key from your invitation, work for two weeks, send feedback from the app. It
   names the exact settings and the costs to expect.

## Options considered: pilot access

### A. Status quo: Stripe checkout with a 100%-off code
| Dimension | Assessment |
|---|---|
| Complexity | Low to build, high for the tester (three systems, a hidden code, a 24-hour key page) |
| Cost | Free, but every team is a $0 subscription to cancel by hand |
| Scalability | Fine |
| Familiarity | Already built |

**Pros:** It exercises the paid path.
**Cons:** It is a fake purchase. The tester sees a price on a free trial, the code is never shown,
it runs on Stripe test mode, nothing tracks licenses per team, and nothing ends the trial.

### B. Admin-issued pilot licenses (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low: two columns, one admin form, one end-date check; the app doesn't change |
| Cost | Free |
| Scalability | Fine for a pilot (tens of teams); one form per team |
| Familiarity | Reuses the license, activation and refresh code that is already tested |

**Pros:** One step for the tester. Each license carries its team name, which `/admin` and gate 7
use. The pilot ends by itself. The tester goes through the same activation path as paying customers.
**Cons:** The lead creates each team by hand, which is a feature at pilot scale. A key can be
shared, but the 15-computer limit and the end date bound that.

### C. Self-serve invite codes redeemed in the app
| Dimension | Assessment |
|---|---|
| Complexity | Medium: a new daemon method, a contracts change (lead review), UI and a cloud endpoint |
| Cost | Free |
| Scalability | Better than B when there are many teams |

**Pros:** No key to copy. **Cons:** It changes the frozen contracts to save one paste. A shared
code can mint licenses unless it is capped. Revisit this when the pilot grows past about 50 teams.

### D. An unlocked pilot build with no licensing
**Pros:** The simplest option. **Cons:** The build testers get differs from the one customers will
get, the licensing path is never tested, and feedback can't be tied to a team. Rejected.

## Options considered: installer hosting

| Option | Cost | Effort | Public, stable URL | Ships the tested bytes |
|---|---|---|---|---|
| **GitHub release `pilot` from CI artifacts (chosen)** | Free (public repo) | One workflow | Yes | Yes, the same artifact |
| CI artifacts directly | Free | None | No: they need a GitHub login and expire after 30 days | Yes |
| Object storage (S3 / R2) | Small | A bucket and credentials | Yes | Only with an upload step |
| Serve from the Render service | Free plan | Low | Yes | No: the disk is ephemeral, and 150 MB files on a cold-starting free instance |

## Trade-off analysis

B moves a little work to the lead (one form per team) to take three steps and a fake purchase away
from every tester. At pilot scale that's the right way round. It also reuses the activation path
whose signatures, computer limits and offline grace are already tested, instead of adding a second
way to get a license. C only beats B once the lead can't keep up with creating teams.

For hosting, the deciding point is "ship the tested bytes". The release is made from the exact
artifacts the install smoke test installed and launched. The redirect routes keep the hosting
choice reversible.

## Consequences

- **Easier:** Inviting a team takes one form and one email. Every license and every piece of
  feedback names its team. The pilot ends without anyone cancelling a subscription.
- **Easier:** Links in the invitation email keep working when installers move, for example to
  signed builds on a CDN.
- **Harder:** The `pilot` release always shows the most recent tested build. A tester who needs an
  older one gets it from the CI run linked in the release notes.
- **Still true:** Pilot builds are unsigned, so SmartScreen and Gatekeeper warn on first launch.
  The download and pilot pages show the one-time steps. Signing stays in `release.yml`.
- **Revisit:** Self-serve invite codes (option C) past about 50 teams. Signed installers before the
  first paid customer. Stripe live mode and tax before charging (see `docs/first-users.md`).

## Action items

1. [x] `pilot-release.yml`: publish the CI-tested installers as the `pilot` release.
2. [x] Cloud: `team` and `ends_at` on licenses; a pilot license form on `/admin` (same-origin POST only); the end date enforced in activation and refresh.
3. [x] Cloud: `/download/windows` and `/download/mac` redirects; the Download and pilot pages rewritten.
4. [ ] Lead: run the pilot release, set `DOWNLOAD_*_URL` on Render, create the first team's license, send the invitation.
5. [ ] Later: retire the `ONESEATPILOT` Stripe coupon once no pilot depends on it.

## Addendum (2026-11-28): self-serve Team trial

The first pilot feedback ("Didn't receive a License key") showed that Free users who find OneSeat
on their own have no way to try Team. So, alongside option B, **Plan → Start free trial** now lets
anyone start a **14-day Team trial** (`license.trial` → `POST /api/v1/trials`). It is one per email
and one per computer, and it ends by itself like a pilot license. This is option C's self-serve
idea, without a shared code: the trial is tied to a computer, so it can't be shared out to many
people. Admin-issued pilot licenses stay in place for teams the lead invites.
