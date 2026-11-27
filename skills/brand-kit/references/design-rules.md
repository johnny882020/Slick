# Design rules for branded pages and apps

A page made with `make_artifact` is one HTML file. Pinned, it runs offline in its own window
under a strict content policy: no network, no remote files, only `oneseat.run(skill, input)`.

## Self-contained (the validator rejects these)

- No `src`, `href`, `action`, `poster` or `data` pointing at `http://`, `https://` or `//`.
  Plain `<a href="https://...">` links are allowed; they open in the system browser.
- No `<iframe>`, `<base>`, `<meta http-equiv="refresh">`.
- No CSS `@import` or `url()` to remote files. No web fonts (Google Fonts, Adobe, CDNs).
- No `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`. Data comes from
  `oneseat.run`.
- Images: inline `<svg>` or `data:` URIs only. Keep the whole file under 5 MB (aim for < 200 KB).

## Fonts: system stacks only

Store the full stack in `brand.font_display` / `brand.font_text`. Pick from:

| Name | Stack | Feels like |
|---|---|---|
| System sans | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | neutral, modern (default) |
| Humanist | `Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif` | friendly, warm |
| Geometric | `Avenir, Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif` | clean, design-led |
| Rounded | `ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT", Calibri, sans-serif` | playful, soft |
| Transitional serif | `Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif` | trustworthy, editorial |
| Old-style serif | `"Iowan Old Style", "Palatino Linotype", "URW Palladio L", P052, Georgia, serif` | crafted, classic |
| Didone | `Didot, "Bodoni MT", "Noto Serif Display", "URW Palladio L", P052, Sylfaen, serif` | fashion, luxury (headings only) |
| Slab | `Rockwell, "Rockwell Nova", "Roboto Slab", "DejaVu Serif", "Sitka Small", serif` | sturdy, workshop |
| Industrial | `Bahnschrift, "DIN Alternate", "Franklin Gothic Medium", "Nimbus Sans Narrow", sans-serif-condensed, sans-serif` | technical, signage |
| Mono | `ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace` | code, numbers |

A person asks for a web font (e.g. "Inter", "Playfair"): explain pages cannot load remote fonts,
and map it to the closest stack (Inter, Helvetica, Roboto -> System sans; Playfair, Bodoni ->
Didone; Lato, Open Sans -> Humanist; Montserrat, Futura -> Geometric; Merriweather -> Transitional).

## Color and contrast (WCAG 2.2 AA)

- Body text 4.5:1 or more against its background. Large text (24px, or 19px bold) and icons,
  borders of inputs and focus rings 3:1 or more.
- Check every pair with the contrast script; never eyeball it. Use its `suggestion` for a
  failing pair, and tell the person the original was kept for large or decorative use.
- Do not carry meaning with color alone: pair red/green with a sign, word or icon.
- Light colors (yellow, orange, light green) as `primary`: use them for fills and borders, and
  put `ink` text on them, not `paper`.

## Light and dark

- Declare `color-scheme: light dark`. Light theme: `paper` background, `ink` text.
- Dark theme in `@media (prefers-color-scheme: dark)`: background near `#121417`, text near
  `#eceff3`, and a lighter shade of `primary` (mix it with white until it passes 4.5:1 on the
  dark background).
- Documents meant for print (invoices) may force `color-scheme: light`.

## Phone width and layout

- Works from 360px wide with no sideways scrolling: `max-width` containers, `minmax(0, 1fr)`
  grids, `overflow-wrap: anywhere` on user text, tables that scroll inside their own box.
- 16px side padding, 16px minimum body font, line height 1.4 to 1.6.
- Tap targets at least 44 by 44 px. Visible focus outline on every control.
- One column under 700px.

## Behaviour

- Render data with `textContent` or by building elements. Never put model or user text into
  `innerHTML`.
- Every `oneseat.run` call has a loading state, an empty state and an error state with the
  `error` text. If `window.oneseat` is missing (preview outside the app), show a clear note.
- Call `oneseat.run` with the skill name as a string literal, e.g. `oneseat.run("customers", ...)`,
  so the checker can match it against `allowedSkills`.
- Do not store personal data in `localStorage`. Keep state in the database via skills.
- Respect `prefers-reduced-motion`: no animation over 200 ms without it.

## Voice

`brand.voice` is 2 to 4 short lines: three adjectives, then one "we say" and one "we never say".
Example: `Warm, plain, a bit cheeky. We say: "Here's what's new." We never say: "Synergy".`
