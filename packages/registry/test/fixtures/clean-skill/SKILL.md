---
name: clean-skill
description: Turn raw meeting notes into a short summary with decisions and action items. Use when the user pastes meeting notes or a transcript and asks for a summary.
license: MIT
metadata:
  version: 1.2.0
  author: OneSeat
---
# Meeting notes to summary

Read the notes the person gives you and write a summary in the format from
[the format guide](references/format.md).

## Steps

1. Find every decision that was made. Quote the exact wording when it matters.
2. List action items as "owner: task (due date)". Ask if an owner is missing.
3. Keep the summary under 200 words.

Example of the output shape:

```markdown
## Decisions
- Ship the pilot on 3 March.

## Action items
- Dana: book the room (Friday)
```
