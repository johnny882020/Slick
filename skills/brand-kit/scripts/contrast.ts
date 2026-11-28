// WCAG 2.x contrast checks for brand colors. Needs no permissions.
// Run: deno run scripts/contrast.ts '<json>'   (or JSON on stdin)
//
// Input, either or both:
//   { "tokens": { "primary_color": "#1f4e79", "accent_color": "#b5452f", "ink": "#1b1b1b", "paper": "#ffffff" } }
//   { "pairs": [ { "fg": "#ff8800", "bg": "#ffffff", "label": "orange on white" } ] }
//
// For tokens it checks the pairs a page uses: ink on paper, primary and accent as text on paper,
// paper as text on primary (buttons), and the dark theme (paper on ink, primary on ink).
// Each failing pair gets a suggested fix: the nearest shade of the foreground that reaches 4.5:1.

export type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`color must be #RGB or #RRGGBB, got ${JSON.stringify(hex)}`);
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

export function toHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function ratio(fg: string, bg: string): number {
  const a = luminance(parseHex(fg));
  const b = luminance(parseHex(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Mix fg toward black or white (whichever raises contrast) until it reaches `target` on bg. */
export function suggest(fg: string, bg: string, target = 4.5): string | null {
  const f = parseHex(fg);
  const towardBlack = luminance(parseHex(bg)) > 0.18;
  const end: Rgb = towardBlack ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0; t <= 100; t++) {
    const mixed = f.map((v, i) => v + ((end[i]! - v) * t) / 100) as Rgb;
    const hex = toHex(mixed);
    if (ratio(hex, bg) >= target) return hex;
  }
  return null;
}

export interface PairResult {
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  aa_text: boolean;
  aa_large: boolean;
  aaa_text: boolean;
  suggestion?: string;
}

export function checkPair(fg: string, bg: string, label = `${fg} on ${bg}`): PairResult {
  const r = ratio(fg, bg);
  const out: PairResult = {
    label,
    fg: toHex(parseHex(fg)),
    bg: toHex(parseHex(bg)),
    ratio: r,
    aa_text: r >= 4.5,
    aa_large: r >= 3,
    aaa_text: r >= 7,
  };
  if (!out.aa_text) {
    const s = suggest(fg, bg);
    if (s) out.suggestion = s;
  }
  return out;
}

export interface Tokens {
  primary_color?: string;
  accent_color?: string;
  ink?: string;
  paper?: string;
}

export function checkTokens(t: Tokens): PairResult[] {
  const ink = t.ink ?? "#1b1b1b";
  const paper = t.paper ?? "#ffffff";
  const out = [checkPair(ink, paper, "body text: ink on paper"), checkPair(paper, ink, "dark theme: paper on ink")];
  if (t.primary_color) {
    out.push(checkPair(t.primary_color, paper, "links and headings: primary on paper"));
    out.push(checkPair(paper, t.primary_color, "button text: paper on primary"));
    out.push(checkPair(t.primary_color, ink, "dark theme: primary on ink"));
  }
  if (t.accent_color) out.push(checkPair(t.accent_color, paper, "accent text: accent on paper"));
  return out;
}

export function run(input: { tokens?: Tokens; pairs?: { fg: string; bg: string; label?: string }[] }) {
  if (!input || (input.tokens === undefined && input.pairs === undefined)) throw new Error('give "tokens" or "pairs"');
  const results = [
    ...(input.tokens ? checkTokens(input.tokens) : []),
    ...(input.pairs ?? []).map((p) => checkPair(p.fg, p.bg, p.label)),
  ];
  return { results, all_aa: results.every((r) => r.aa_text) };
}

if (import.meta.main) {
  try {
    const text = Deno.args.length > 0 ? Deno.args.join(" ") : await new Response(Deno.stdin.readable).text();
    console.log(JSON.stringify(run(JSON.parse(text)), null, 2));
  } catch (e) {
    console.log(JSON.stringify({ error: (e as Error).message }));
    Deno.exit(1);
  }
}
