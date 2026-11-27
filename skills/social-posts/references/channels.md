# Channel rules

`posts.channel` uses the ids in the first column. "Limit" is the hard limit the platform enforces.
"Visible" is roughly how much shows before "see more" - put the hook there. The length script
enforces the hard limits; aim to stay 5% under them.

| id | Limit | Visible | Hashtags | Links | Best length |
|---|---|---|---|---|---|
| `x` | 280, weighted (URL = 23, emoji and CJK = 2) | all | 0-2, inside the sentence | 1, counts 23 | 70-140 |
| `linkedin` | 3,000 | ~210 | 3-5, at the end | in the body is fine, 1 max | 600-1,300 |
| `instagram` | 2,200; max 30 hashtags | ~125 | 3-8, at the end | not clickable: say "link in bio" | 150-500 |
| `facebook` | 63,206 | ~480 | 0-2 | 1 | 40-250 |
| `threads` | 500 | all | 1 topic tag | 1 | 100-300 |
| `bluesky` | 300 | all | 0-2 | 1 | 100-250 |
| `mastodon` | 500 | all | 1-3, CamelCase | 1 | 100-400 |
| `tiktok` | 4,000 caption | ~100 | 3-5 | not clickable | 50-300 |
| `pinterest` | 500 description, 100 title | ~50 | 2-5 keywords, not tags | 1 destination link | 100-300 |
| `google_business` | 1,500 | ~250 | none | use the button | 150-300 |
| `newsletter` | subject 60 (advice), preview text 90 | subject + preview | none | as needed | 150-400 words |

Aliases: "twitter" means `x`; "IG" and "insta" mean `instagram`; "FB" means `facebook`;
"GBP" and "Google post" mean `google_business`.

## Style per channel

- **x**: one idea, one line break at most. Lead with the point. No thread unless asked; a thread
  is numbered `1/`, `2/`, each under the limit.
- **linkedin**: first line is a hook that stands alone (it is all most people see). Short
  paragraphs of 1-2 sentences with blank lines between. End with a question or a clear next step.
  No "I'm humbled/thrilled to announce". No more than 3 emoji.
- **instagram**: write for someone looking at the picture. First 125 characters carry the hook.
  Hashtags in a separate final block. Suggest the image or reel idea in one line above the
  caption, marked `Visual:`.
- **facebook**: conversational, like talking to a neighbour. Questions get comments.
- **threads / bluesky / mastodon**: casual, human, no marketing voice, no hashtag walls.
- **tiktok**: caption supports the video; suggest the hook for the first 2 seconds as `Visual:`.
- **pinterest**: keyword-rich, describes what the pin shows and who it helps.
- **google_business**: what is new, when, where, and the action (Call, Book, Order).
- **newsletter**: subject is specific (no "Newsletter #12"), preview text extends the subject.

## Everywhere

- Use the brand `voice`. Plain words, active voice, one call to action.
- No claims you cannot back up ("best in town", "#1"), no invented prices, dates, stats or
  testimonials. Put unknowns in `[brackets]`.
- No ALL CAPS words except acronyms. No more than one exclamation mark per post.
- Accessibility: CamelCase multi-word hashtags (`#SmallBusiness`), and suggest alt text for images.
- Never tag or mention accounts the person did not name.

## Times (local, when the person has no preference)

| Channel | Good slots |
|---|---|
| linkedin | Tue-Thu 08:00-10:00 |
| instagram | Mon-Fri 11:00-13:00, Sun 10:00 |
| facebook | Mon-Fri 09:00-13:00 |
| x, threads, bluesky, mastodon | Mon-Fri 08:00-10:00 or 12:00 |
| tiktok | Tue-Thu 18:00-21:00 |
| google_business | Mon 09:00 |
| newsletter | Tue or Thu 07:00-09:00 |
