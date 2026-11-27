# OneSeat pilot: tester guide

Thank you for trying OneSeat. It is one desktop app that runs everyday business tasks
(customer lookups, emails, invoices, social posts, support replies, weekly reports) with
the AI model you choose. This is an early test build.

**Time needed:** 10 minutes to set up, then use it for real work for two weeks.

## 1. Get a model key

OneSeat uses your own key, so you pay the model provider directly for what you use.
Pick one:

- Claude: console.anthropic.com → API keys
- OpenAI: platform.openai.com → API keys
- Gemini: aistudio.google.com → Get API key

Your account with that provider needs some prepaid credit (a few dollars is plenty to
start). Without it the key is accepted but every task fails with the provider's message,
such as "credit balance is too low".

The key is stored in your computer's own keychain (Windows Credential Manager or macOS
Keychain). It is never written to a file or sent anywhere except to that provider.

## 2. Install

Pilot builds are not signed yet, so your computer will warn you once. That is expected.

**Windows 10 / 11**
1. Run `OneSeat_x.y.z_x64-setup.exe`. It installs for your user only and needs no admin rights.
2. If "Windows protected your PC" appears: select **More info → Run anyway**.

**macOS (Apple silicon: M1 or newer)**
1. Open the `.dmg` and drag **OneSeat** to **Applications**.
2. The first time, right-click **OneSeat** in Applications → **Open** → **Open**.
3. If macOS says the app "is damaged and can't be opened", open Terminal and run:
   `xattr -cr /Applications/OneSeat.app` — then open it again.

Intel Macs are not supported by pilot builds yet.

## 3. First run

1. Choose your provider and paste your key. OneSeat checks it and shows the models.
2. Seven starter skills are already installed: Customers, Outreach, Proposals & invoices,
   Social posts, Support inbox, Weekly report, Brand kit.
3. Type a task in plain words, for example:
   - "Add a customer: Jane Smith, jane@acme.com, Acme Ltd."
   - "Draft an invoice for Jane: 3 hours of consulting at $150/hour, 8.25% tax."
   - "Write a LinkedIn post about our new spring offer."
   - "Make a small app that shows my top customers." → **Pin as app** opens it in its own window.

## 4. What OneSeat will never do without you

Before it **sends** anything, **pays** anything or **deletes** anything, OneSeat stops and
shows an **Approve / Deny** box. Every action is listed under **Activity**. If anything
ever happens without asking you, please report it right away — that is the most
important thing we are testing.

## 5. Your data

Everything stays on your computer: the database, skills and pinned apps are in
- Windows: `%APPDATA%\app.oneseat`
- macOS: `~/Library/Application Support/app.oneseat`

Only the text of your requests (and the data a skill looks up to answer them) goes to the
model provider you chose.

## 6. Tell us how it went

Please send feedback at least once a week, and any time something breaks or confuses you:
- the link your OneSeat contact gave you (or the "Pilot feedback" form on GitHub), or
- reply to the pilot email.

Useful things to include: what you typed, what you expected, what happened, and a
screenshot. Never include your API key. The app log is here if we ask for it:
- Windows: `%LOCALAPPDATA%\app.oneseat\logs\oneseat.log`
- macOS: `~/Library/Logs/app.oneseat/oneseat.log`

Keys and secrets are removed from the log automatically.
