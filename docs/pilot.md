# Gate 7 — Pilot

Release 1 ships only after this gate is signed off by a person. It is not automated.

**Rule:** 10 teams, 2 weeks. Pass when there is no data loss, no unapproved send, and every team
reaches a first skill run in under 5 minutes. Release 1 is done when each pilot team cancels at
least one paid seat.

## Per team

| Team | Start | OS | Provider | First run (min) | Data loss | Unapproved send | Seats cancelled | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |
| 6 | | | | | | | | |
| 7 | | | | | | | | |
| 8 | | | | | | | | |
| 9 | | | | | | | | |
| 10 | | | | | | | | |

## How to measure

- **First run:** time from installer opened to the first `done` event of a skill run. The action
  log (`Activity` screen, or `actions.log`) has timestamps; the installer start time is self-reported.
- **Unapproved send:** export the action log at the end of week 2. Every row with effect `send`,
  `pay` or `delete` must have `approved = true`. Any other value fails the gate.
- **Data loss:** ask each team; compare `oneseat.db` row counts at day 1 and day 14 for tables they use.

## Sign-off

- [ ] All six starter skills pass gates 1–6 on Claude, Codex and Gemini.
- [ ] 10 teams complete 2 weeks.
- [ ] No data loss, no unapproved send.
- [ ] First run under 5 minutes for every team.
- [ ] Three artifacts pinned as native apps on Windows 11 and macOS.
- Signed by: ____________  Date: __________
