// Check post lengths against channel limits. Needs no permissions.
// Run: deno run scripts/length.ts '{"posts":[{"channel":"x","body":"..."}]}'   (or JSON on stdin)
//
// x uses weighted counting like the platform: URLs count 23, characters outside the basic
// Latin/Greek/Cyrillic/Hebrew/Arabic ranges (emoji, CJK) count 2. Other channels count
// user-perceived characters (grapheme clusters).

export interface ChannelRule {
  limit: number;
  visible?: number;
  maxHashtags?: number;
  weighted?: boolean;
}

export const CHANNELS: Record<string, ChannelRule> = {
  x: { limit: 280, weighted: true },
  linkedin: { limit: 3000, visible: 210 },
  instagram: { limit: 2200, visible: 125, maxHashtags: 30 },
  facebook: { limit: 63206, visible: 480 },
  threads: { limit: 500 },
  bluesky: { limit: 300 },
  mastodon: { limit: 500 },
  tiktok: { limit: 4000, visible: 100 },
  pinterest: { limit: 500, visible: 50 },
  google_business: { limit: 1500, visible: 250 },
  newsletter_subject: { limit: 60 },
  newsletter_preview: { limit: 90 },
};

export const ALIASES: Record<string, string> = {
  twitter: "x",
  ig: "instagram",
  insta: "instagram",
  fb: "facebook",
  gbp: "google_business",
  google: "google_business",
};

export function normalizeChannel(channel: string): string {
  const c = channel.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ALIASES[c] ?? c;
}

const URL_RE = /\bhttps?:\/\/[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|co|shop|store|app|dev)(?:\/[^\s]*)?/gi;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function weightOne(cp: number): boolean {
  return (
    (cp >= 0x0000 && cp <= 0x10ff) ||
    (cp >= 0x2000 && cp <= 0x200d) ||
    (cp >= 0x2010 && cp <= 0x201f) ||
    (cp >= 0x2032 && cp <= 0x2037)
  );
}

export function graphemes(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** Weighted length as counted by x (twitter-text v3 rules, simplified). */
export function weightedLength(text: string): number {
  let n = 0;
  const rest = text.replace(URL_RE, () => {
    n += 23;
    return "";
  });
  for (const { segment } of segmenter.segment(rest)) {
    const cps = [...segment].map((c) => c.codePointAt(0)!);
    n += cps.every(weightOne) ? cps.length : 2;
  }
  return n;
}

export function countHashtags(text: string): number {
  return (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

export interface LengthResult {
  channel: string;
  length: number;
  limit: number;
  ok: boolean;
  over_by: number;
  hashtags: number;
  visible?: number;
  hook_fits_visible?: boolean;
  problems: string[];
}

export function checkPost(channel: string, body: string): LengthResult {
  const id = normalizeChannel(channel);
  const rule = CHANNELS[id];
  if (!rule) throw new Error(`unknown channel "${channel}"; known: ${Object.keys(CHANNELS).join(", ")}`);
  const length = rule.weighted ? weightedLength(body) : graphemes(body);
  const hashtags = countHashtags(body);
  const problems: string[] = [];
  if (length > rule.limit) problems.push(`${length - rule.limit} over the ${rule.limit} limit`);
  if (rule.maxHashtags !== undefined && hashtags > rule.maxHashtags)
    problems.push(`${hashtags} hashtags, max ${rule.maxHashtags}`);
  if (body.trim() === "") problems.push("empty post");
  const out: LengthResult = {
    channel: id,
    length,
    limit: rule.limit,
    ok: problems.length === 0,
    over_by: Math.max(0, length - rule.limit),
    hashtags,
    problems,
  };
  if (rule.visible !== undefined) {
    out.visible = rule.visible;
    const firstLine = body.split("\n")[0] ?? "";
    out.hook_fits_visible = graphemes(firstLine) <= rule.visible;
  }
  return out;
}

export function checkAll(input: { posts: { channel: string; body: string }[] }): { results: LengthResult[]; all_ok: boolean } {
  if (!input || !Array.isArray(input.posts) || input.posts.length === 0) throw new Error("posts must be a non-empty list");
  const results = input.posts.map((p, i) => {
    if (!p || typeof p.channel !== "string" || typeof p.body !== "string")
      throw new Error(`posts[${i}] needs "channel" and "body" strings`);
    return checkPost(p.channel, p.body);
  });
  return { results, all_ok: results.every((r) => r.ok) };
}

if (import.meta.main) {
  try {
    const text = Deno.args.length > 0 ? Deno.args.join(" ") : await new Response(Deno.stdin.readable).text();
    console.log(JSON.stringify(checkAll(JSON.parse(text)), null, 2));
  } catch (e) {
    console.log(JSON.stringify({ error: (e as Error).message }));
    Deno.exit(1);
  }
}
