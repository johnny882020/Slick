---
name: brand-kit
description: Keeps the company brand - name, colors, fonts, voice and logo - in the local brand table, checks colors for accessible contrast, and builds self-contained branded HTML pages and small apps that can be pinned as desktop apps and call other skills for live data. Use when someone says "our brand", "brand colors", "set our logo", "change the font", "brand voice", "make a page", "build me an app", "dashboard", "landing page", "pin as app", "make it on-brand" or "style guide".
compatibility: Requires the OneSeat harness tools db_query, db_execute, run_skill_script (Deno) and make_artifact.
allowed-tools: db_query db_execute run_skill_script read_skill_file make_artifact
metadata:
  version: "1.0.0"
  author: OneSeat
---

# Brand kit

Two jobs: keep the brand tokens right, and turn them into pages and apps that work offline.
Read [references/design-rules.md](references/design-rules.md) before building any page.

## Brand tokens

Stored in `brand` as key/value rows. These keys, and only these, are the kit:

| key | value | default |
|---|---|---|
| `company_name` | display name | ask |
| `primary_color` | `#RRGGBB`, buttons, links, headings | `#1f4e79` |
| `accent_color` | `#RRGGBB`, highlights, badges | `#b5452f` |
| `ink` | `#RRGGBB`, body text | `#1b1b1b` |
| `paper` | `#RRGGBB`, background | `#ffffff` |
| `font_display` | a system font stack from the design rules | System sans |
| `font_text` | a system font stack from the design rules | System sans |
| `voice` | 2-4 lines: three adjectives, "we say", "we never say" | ask |
| `logo_svg` | one inline `<svg>`, under 20 KB | none |

Read: `SELECT key, value FROM brand`. Show the current kit before changing it.

Write one key at a time, with params:

```sql
INSERT INTO brand (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
```

Before saving:

- Colors: normalise to lowercase `#rrggbb`. Named colors ("navy") become hex; say which.
- Run the contrast check (below) on the new set. If a pair fails, save what the person asked
  for, then show the failing pair, its ratio and the suggested shade, and ask whether to use it.
- Fonts: only a stack from the design rules. Web font requested: explain and map it.
- Logo: accept only `<svg>` with no `<script>`, no `on...=` attributes, no `<foreignObject>`,
  no `href`/`xlink:href` to `http`, `//` or `data:text`. Strip comments and editor metadata.
- Never delete brand rows. To reset a key, set it to its default.

## Contrast check

`run_skill_script` with `skill: "brand-kit"`, `script: "contrast"`, args: one JSON string,
`{"tokens":{"primary_color":"#ff8800","accent_color":"#b5452f","ink":"#1b1b1b","paper":"#ffffff"}}`
or `{"pairs":[{"fg":"#ff8800","bg":"#ffffff"}]}`. It returns each pair's `ratio`, `aa_text`
(4.5:1), `aa_large` (3:1) and a `suggestion` when it fails. Example: `#ff8800` on white is
2.39:1, fails for text; suggestion `#b35f00`. Report ratios as "2.39:1".

## Build a page or app

1. Read the tokens. Missing ones use the defaults above.
2. Start from [assets/app-template.html](assets/app-template.html) for anything with live data,
   or write a page from scratch following the design rules. Replace the `BRAND:START` block with
   the tokens.
3. Live data comes only from `oneseat.run("<skill>", input)`, which resolves to
   `{ok, text, data, error}`. `data` is set when the skill replies with JSON. The template calls
   `oneseat.run("customers", {action: "top_ltv", limit: 10})` and renders `data.customers`.
   Ask skills for JSON with an `action` object; the customers skill documents its actions.
4. Static pages (a price list, a one-pager) embed their data and call nothing.
5. Call `make_artifact`:

```json
{"name": "Top customers", "html": "<!doctype html>...",
 "allowedSkills": ["customers"], "window": {"width": 900, "height": 700}}
```

## app.json fields (made from make_artifact when the person pins the page)

| field | rule |
|---|---|
| `id` | lowercase slug from the name, e.g. `top-customers` |
| `name` | 1-80 characters |
| `version` | semver, start at `1.0.0`, bump on each change |
| `icon` | one emoji, or a PNG/SVG `data:` URI |
| `window` | `width` and `height` 200-4000; optional `minWidth`, `minHeight`, `resizable` |
| `allowedSkills` | every skill the page calls with `oneseat.run`, and nothing else; `[]` for static pages |
| `createdBy` | `brand-kit` |

`allowedSkills` must list every skill name used in an `oneseat.run("...")` call in the HTML,
or those calls fail in the pinned window. Before calling `make_artifact`, list the calls you
wrote and compare.

## Before you hand it over

- No remote `src`/`href`/`url()`/`@import`, no iframes, no web fonts, no `fetch`.
- Works at 360px wide, light and dark, keyboard focus visible, text contrast 4.5:1.
- Loading, empty and error states for every `oneseat.run` call.
- Tell the person: what the page shows, which skills it calls, and that "Pin as app" puts it
  in its own window.
