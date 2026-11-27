# Run OneSeat with your first users

The fastest path from this repo to feedback from real teams, with every step checked
before anyone outside sees it. Signed installers come later (step 8); the pilot uses the
unsigned builds CI makes on every push.

## 0. One-time setup (GitHub → Settings → Secrets and variables → Actions)

| Kind | Name | Value |
|---|---|---|
| Secret | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | Your keys (done) |
| Variable | `OPENAI_EVAL_MODEL` | The OpenAI / Codex model id to test |
| Variable | `GEMINI_EVAL_MODEL` | The Gemini model id to test |
| Variable | `ANTHROPIC_EVAL_MODEL` | Optional; default `claude-sonnet-5-5` |

A provider whose key or model variable is missing is skipped, and the run summary says so.
Gemini defaults to `gemini-3.8-flash` (the id Google's API recommends; 2.5 models are closed to
new accounts). Set `OPENAI_EVAL_MODEL` to a model your OpenAI account can use.

**Which accounts work for the API.** OneSeat calls each provider's *API*, which is billed
separately from chat subscriptions:

| Provider | What works | What does not |
|---|---|---|
| Anthropic (Claude) | Console account with prepaid API credit (console.anthropic.com → Plans & Billing) | A Claude Pro or Max subscription: it covers claude.ai and Claude Code, not API keys |
| OpenAI | Platform account with prepaid credit (platform.openai.com → Billing) | A free account or a ChatGPT subscription |
| Google Gemini | The free tier works (rate limited); a paid tier for real data | — |

On Gemini's free tier, Google's terms let it use prompts and responses to improve its
products, and requests per minute and per day are capped. It is fine for trying OneSeat
and for QA with the sample data; testers working with real customer data should use a
paid tier with any provider.

**Each provider account needs credit.** A key without credit is accepted, but every call
fails ("credit balance is too low" / "no credits remaining"). Live QA reports that provider
as **BLOCKED (account)**, not as a OneSeat failure. Add credit in the provider's billing page
(Anthropic Console → Plans & Billing; OpenAI Platform → Billing) before step 2.

## 1. Check that CI is green

Open the pull request → **Checks**. Everything must be green on Windows, macOS and Linux:
unit tests and coverage (gate 1), provider parity (2), skill lint (3), security scan (4),
desktop end-to-end flows (6), the Rust core, and the **unsigned builds with their install
smoke test**. The install smoke test installs the real installer on a clean machine,
launches the app, and checks that the background engine (daemon + deno) starts and
installs all seven starter skills.

## 2. Run live QA with real models

On the pull request, add the label **`live-qa`** (right sidebar → Labels; create it the
first time). That starts the **Nightly live** workflow on the PR with your keys:

- **Live QA of the shipped daemon** — the exact daemon binary that ships, driven the way
  the app drives it, through 8 scenarios on each provider: top customers by lifetime value;
  an invoice whose total must come out at exactly $487.13 from the sandboxed totals script;
  a thank-you email that must not claim to be sent; support triage that must not close
  tickets; a LinkedIn post; the weekly report (revenue $2,499 vs $0); an on-brand app that
  is pinned and then calls a skill through the app bridge (and is refused a skill it does
  not list); and a delete that must wait for approval and stay undone when denied.
- **Gate 5** — every starter skill against a no-skill baseline on 10 cases each.

Read the run's **Summary** page. Ship to testers only when every Live QA row is PASS.
To run it again after a fix, remove and re-add the label. After merging, the same jobs run
every night and can be started from **Actions → Nightly live → Run workflow**.

Cost: live QA is 8 short tasks per provider. Gate 5 is about 140 runs per provider plus
judging, so it costs more; run it before each pilot build rather than on every push.

## 3. Get the installers

Pull request → **Checks** → any job of the latest **CI** run → **Summary** → **Artifacts**:

- `unsigned-windows-latest` → `nsis/OneSeat_<version>_x64-setup.exe` (per-user, no admin rights;
  give testers this one) and `msi/…msi`
- `unsigned-macos-latest` → `dmg/OneSeat_<version>_aarch64.dmg` (Apple silicon)

Artifacts are kept for 30 days and need a GitHub login with access to the repo, so
download them and share them from your own drive.

## 4. Try it yourself first (15 minutes)

Install on one Windows PC and one Mac, then:

1. Paste a key. The model list appears.
2. "Add a customer: Jane Smith, jane@acme.com, Acme Ltd." Then "Who are my customers?"
3. "Draft an invoice for Jane: 3 hours at $150/hour, 8.25% tax." The total is $487.13.
4. "Write a thank-you email to Jane." It drafts and does not send.
5. "Delete Jane." An **Approve / Deny** box appears. Deny it; Jane is still there.
6. "Make a small app that lists my customers." Then **Pin as app**: it opens in its own window and shows data.
7. **Skills → Add skill** with a GitHub skill such as `owner/repo`. The scan report appears before anything installs.
8. **Activity** lists every action, with approvals.

## 5. Invite the first teams

Send each team the installer for their computer and `docs/pilot-tester-guide.md`
(it covers keys, the unsigned-app warnings, what to try, and how to report). Start with
2–3 teams for a week, then widen to 10 for the two-week pilot (gate 7).

## 6. Collect feedback

- Testers report through the **Pilot feedback** issue form (`.github/ISSUE_TEMPLATE`), or
  your own form or email if they don't use GitHub. The form never asks for keys or data.
- Track each team in `docs/pilot.md`: first-run minutes, data loss, unapproved actions,
  seats cancelled.
- Any report of an action without approval stops the pilot until it is fixed.

## 7. Ship fixes during the pilot

Fix on a branch → open a PR → CI builds new installers → add `live-qa` → share the new
build. Testers install over the old version; their data and keys are kept (they live in
the app data folder and the OS keychain, not in the install folder).

## 8. After the pilot: signed releases

Add the signing secrets used by `.github/workflows/release.yml` (Apple certificate and
notarization, Windows code-signing certificate, Tauri updater key), then push a `v*` tag.
That builds signed `.msi` / `.exe` and a universal `.dmg` (Apple silicon and Intel) as a
draft GitHub release, after gates 1–6 pass.

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
