# Gate 7 — Pilot (10 teams, 2 weeks)

Copy this file to `docs/pilot.md` and keep it up to date during the pilot. Gate 7 is manual:
`pnpm gates` prints it as MANUAL and points here. It passes when every exit criterion below is
ticked and signed off.

- **Release under test:** vX.Y.Z (tag) — installers from the draft GitHub release
- **Pilot window:** YYYY-MM-DD to YYYY-MM-DD (14 days)
- **Pilot lead:**
- **Gates 1–6 green on the release tag:** link to the release workflow run

## Teams

| # | Team / business | Contact | OS (Win 11 / macOS) | Model provider | Installed on | Skills in use | Status |
|---:|---|---|---|---|---|---|---|
| 1 | | | | | | | not started |
| 2 | | | | | | | not started |
| 3 | | | | | | | not started |
| 4 | | | | | | | not started |
| 5 | | | | | | | not started |
| 6 | | | | | | | not started |
| 7 | | | | | | | not started |
| 8 | | | | | | | not started |
| 9 | | | | | | | not started |
| 10 | | | | | | | not started |

Aim for a mix: at least 3 teams on each OS, and at least 2 teams on each of Anthropic, OpenAI and Google.

## Setup checklist (per team, day 1)

- [ ] Installer ran without a security warning (signed .msi/.exe or notarised .dmg)
- [ ] One model key connected; it is stored in the OS keychain, not on disk
- [ ] Starter skills listed in the skill library
- [ ] First task run end to end in under 10 minutes from install
- [ ] One app pinned with "Pin as app" and reopened after a restart
- [ ] Team knows how approvals work: nothing is sent, paid or deleted without their click

## Weekly check-in

| Team | Week | Tasks run | Tasks that saved time | Approvals asked | Approvals denied | Crashes / errors | Top request | Notes |
|---|---:|---:|---:|---:|---:|---:|---|---|
| | 1 | | | | | | | |
| | 2 | | | | | | | |

## Issues found

| Date | Team | Severity (blocker / major / minor) | What happened | Skill / area | Issue link | Fixed in |
|---|---|---|---|---|---|---|
| | | | | | | |

## No-skill check (from the release's eval report)

List skill rules the no-skill check flagged (`oneseat-evals --from eval-report.json --no-skill-check`)
and whether pilot teams hit the same problem.

| Skill | Rule or check | Seen in pilot? | Decision (keep / cut / rewrite) |
|---|---|---|---|
| | | | |

## Exit criteria

- [ ] 10 teams used OneSeat on at least 8 of the 14 days
- [ ] No open blocker issues; every major issue has a fix or an accepted workaround
- [ ] No action was sent, paid or deleted without an approval (check each team's action log)
- [ ] No model key appeared in any log, skill, prompt or crash report
- [ ] At least 8 of 10 teams say they would keep using it (record the question and answers below)
- [ ] Each starter skill was used by at least 2 teams, or is marked for removal

## Feedback

| Team | Would keep using it? (yes / no) | Why |
|---|---|---|
| | | |

## Sign-off

| Role | Name | Date | Decision |
|---|---|---|---|
| Pilot lead | | | |
| Lead engineer | | | |
| Product | | | |
