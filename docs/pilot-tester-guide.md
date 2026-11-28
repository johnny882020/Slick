# OneSeat pilot: tester guide

Thank you for trying OneSeat. It is one desktop app that runs everyday business tasks
(customer lookups, emails, invoices, social posts, support replies, weekly reports) with
the AI model you choose. This is an early test build.

**Time needed:** 10 minutes to set up, then use it for real work for two weeks.

**You need:** a Windows 10/11 PC or a Mac with Apple silicon, a model key (step 2), and either
your invitation email (it has your team's license key) or an email address for the free trial
(step 3).

The pilot is free. You don't buy anything and you don't need a card. You only pay your model
provider for what you use.

Start here: **https://oneseat-cloud.onrender.com/pilot**

## 1. Install

Download OneSeat from the pilot page, or directly:
- Windows: https://oneseat-cloud.onrender.com/download/windows
- Mac: https://oneseat-cloud.onrender.com/download/mac

Pilot builds are not signed yet, so your computer will warn you once. That is expected.

**Windows 10 / 11**
1. Run `OneSeat-Windows-x64-setup.exe`. It installs for your user only and needs no admin rights.
2. If "Windows protected your PC" appears: select **More info → Run anyway**.

**macOS (Apple silicon: M1 or newer)**
1. Open `OneSeat-macOS-AppleSilicon.dmg` and drag **OneSeat** to **Applications**.
2. The first time, right-click **OneSeat** in Applications → **Open** → **Open**.
3. If macOS says the app "is damaged and can't be opened", open Terminal and run:
   `xattr -cr /Applications/OneSeat.app` — then open it again.

Intel Macs are not supported by pilot builds yet.

## 2. Connect a model key

OneSeat uses your own key, so you pay the model provider directly for what you use.
Open OneSeat, choose your provider and paste the key. OneSeat checks it and shows the models.

- **Claude (recommended):** console.anthropic.com → API keys. Then add some prepaid credit
  under Billing (a few dollars is plenty to start).
- OpenAI: platform.openai.com → API keys, with prepaid credit.
- Gemini: aistudio.google.com → Get API key.

These are *API* keys, billed separately from chat subscriptions: a Claude Pro/Max or
ChatGPT subscription does not include API use. Without prepaid credit, Claude and OpenAI
accept the key but every task fails with the provider's message, such as "credit balance
is too low".

Gemini's free tier is fine for a quick look, but it allows only about 20 requests a day,
and Google may use what you send to improve its products. Don't use it with real customer
data. For real work, use a paid account with any of the three.

The key is stored in your computer's own keychain (Windows Credential Manager or macOS
Keychain). It is never written to a file or sent anywhere except to that provider.

## 3. Activate your pilot license

1. In OneSeat, open **Plan**.
2. Paste the license key from your invitation email (it looks like `OS-XXXX-XXXX-XXXX-XXXX`).
3. Choose **Activate**.

Use the same key on every computer in your team (up to 15). Please keep the key within your team.

**No invitation? Start the free trial instead.** On Free, **Plan** shows **Try Team free for
14 days**: enter your email and choose **Start free trial**. OneSeat turns on the Team plan on
this computer and shows your team's license key. Copy it and paste it under **License key** on
your team's other computers (up to 15). There is one trial per email and per computer, and no
card is needed. When the 14 days end, OneSeat goes back to Free; your data stays on your
computer.

The license gives you the full Team plan: pinned apps, schedules, skill imports and tool
connectors.

## 4. First run

1. Seven starter skills are already installed: Customers, Outreach, Proposals & invoices,
   Social posts, Support inbox, Weekly report, Brand kit.
2. Type a task in plain words, for example:
   - "Add a customer: Jane Smith, jane@acme.com, Acme Ltd."
   - "Draft an invoice for Jane: 3 hours of consulting at $150/hour, 8.25% tax."
   - "Write a LinkedIn post about our new spring offer."
   - "Make a small app that shows my top customers." → **Pin as app** opens it in its own window.
3. Then use it for your real work for two weeks.

## 5. What OneSeat will never do without you

Before it **sends** anything, **pays** anything or **deletes** anything, OneSeat stops and
shows an **Approve / Deny** box. Every action is listed under **Activity**. If anything
ever happens without asking you, please report it right away — that is the most
important thing we are testing.

## 6. Your data

Everything stays on your computer: the database, skills and pinned apps are in
- Windows: `%APPDATA%\app.oneseat`
- macOS: `~/Library/Application Support/app.oneseat`

Only the text of your requests (and the data a skill looks up to answer them) goes to the
model provider you chose.

## 7. When the pilot ends

Your license switches to Free on the end date in your invitation. Your data, skills and
pinned apps stay on your computer. To keep Pro or Team features, choose a plan at
https://oneseat-cloud.onrender.com/#plans and paste the new key in **Plan**.

## 8. Tell us how it went

Please send feedback at least once a week, and any time something breaks or confuses you:
- in the app: **Plan → Send feedback** (fastest; it includes your app version), or
- the "Pilot feedback" form on GitHub, or a reply to the pilot email.

Useful things to include: what you typed, what you expected, what happened, and a
screenshot. Never include your API key or customer data. The app log is here if we ask for it:
- Windows: `%LOCALAPPDATA%\app.oneseat\logs\oneseat.log`
- macOS: `~/Library/Logs/app.oneseat/oneseat.log`

Keys and secrets are removed from the log automatically.

## Getting a new version

When we fix something, we'll tell you. Download again from the same link and install over
the old version. Your data, model key and license stay.
