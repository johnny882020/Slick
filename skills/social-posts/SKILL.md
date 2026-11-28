---
name: social-posts
description: Writes social media posts for each channel (X, LinkedIn, Instagram, Facebook, Threads, Bluesky, TikTok, newsletters) within each platform's length limit and style, saves and schedules them, sets publish reminders, and exports a content calendar as CSV or a visual HTML calendar. Use when someone says "write a post", "LinkedIn post", "tweet", "caption", "social media", "announce on", "schedule posts", "content calendar", "posting plan", "what's scheduled" or "repurpose this for Instagram".
compatibility: Requires the OneSeat harness tools db_query, db_execute, run_skill_script (Deno), workspace_write, make_artifact and schedule_task.
allowed-tools: db_query db_execute run_skill_script read_skill_file workspace_write make_artifact schedule_task memory_search memory_save
metadata:
  version: "1.0.0"
  author: OneSeat
---

# Social posts

Write posts that fit each channel, keep them in the `posts` table, and help the person publish
on time. You never publish: posting goes through a connected tool and the person approves it.

## 1. Write

1. Read [references/channels.md](references/channels.md) for limits, style and good times.
2. Read the brand: `SELECT key, value FROM brand WHERE key IN ('company_name', 'voice')`.
3. Ask only if the topic is unclear. Otherwise write one post per requested channel. No channel
   named: suggest LinkedIn + Instagram + one short channel and write those.
4. Facts come from the person or the database (products from `purchases`, numbers from
   `metrics`). Unknown details go in `[brackets]`. Never invent prices, dates or quotes.
5. Check every post with `run_skill_script` (`skill: "social-posts"`, `script: "length"`, args:
   one JSON string `{"posts":[{"channel":"x","body":"..."}]}`). Rewrite anything with
   `ok: false` and check again. Never trust your own character count.

Show each post like this (length from the script):

```
**X** - 142/280
<post text>

**LinkedIn** - 812/3000 (hook: 96/210 visible)
<post text>
```

## 2. Save and schedule

- Save drafts the person wants to keep:

```sql
INSERT INTO posts (id, channel, body, status, scheduled_for, campaign)
VALUES ('pst_' || lower(hex(randomblob(8))), ?, ?, 'draft', NULL, ?)
```

- Schedule: same insert (or `UPDATE posts SET status = 'scheduled', scheduled_for = ? WHERE id = ?`)
  with `status = 'scheduled'` and `scheduled_for` as local ISO time `2026-12-02T09:00`. No time
  given: pick a slot from the times table and say which.
- Never set `published` or `published_at` yourself. Only after a connected posting tool reports
  success (approved by the person), or the person says "posted", run
  `UPDATE posts SET status = 'published', published_at = ? WHERE id = ?`.
- Reminder (optional, offer once): `memory_search` "social-posts reminder"; if none exists,
  `schedule_task` with `cron: "45 8 * * *"`, `skill: "social-posts"` and
  `input: "List posts scheduled for today and remind me to publish them."`, then `memory_save`
  that it exists. Do not create duplicate reminders.

## 3. Content calendar

Query the range (default: today through 30 days ahead):

```sql
SELECT id, channel, body, status, scheduled_for, published_at, campaign FROM posts
WHERE COALESCE(scheduled_for, published_at) >= ? AND COALESCE(scheduled_for, published_at) < ?
ORDER BY COALESCE(scheduled_for, published_at)
```

**CSV**: header exactly `date,time,channel,status,campaign,post_id,text`, one row per post.
Quote any field with a comma, quote or line break, and double inner quotes (`"He said ""hi"""`).
`workspace_write` it to `calendar/content-calendar-<start>-to-<end>.csv` and give the path.

**HTML calendar**: `read_skill_file` [assets/calendar-template.html](assets/calendar-template.html),
put the brand tokens in the `BRAND:START` block, replace the JSON in `calendar-data` with
`{"title": ..., "posts": [{"id","date","time","channel","status","campaign","text"}]}` (escape
every `<` in text as `\u003c`), then `make_artifact` with `name: "Content calendar <month>"`,
`allowedSkills: []`, `window: {"width": 1100, "height": 800}`.

## Hard rules

- Never say a post was published, posted or is live unless a tool confirmed it this run.
  Scheduled means "saved with a time", not "will auto-post".
- Never delete posts. To drop one, ask; deleting needs the person's approval.
- Each channel gets its own version. Do not paste the same text everywhere.
