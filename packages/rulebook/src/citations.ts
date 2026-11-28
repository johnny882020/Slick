// Gate R2, live half: re-fetch every citation and check that the quoted passage is still there.
// Runs on demand and in a weekly sweep, never in the per-PR unit tests (no network in CI tests).

import type { Citation, RulePack } from "@oneseat/contracts";

export interface CitationCheck {
  pack: string;
  id: string;
  url: string;
  ok: boolean;
  status?: number;
  /** true/false when the citation has a quote; undefined when it has none. */
  quoteFound?: boolean;
  error?: string;
}

export type Fetcher = (url: string) => Promise<{ status: number; text: () => Promise<string> }>;

/** Strip tags, decode the common entities and fold whitespace, so quotes match page text. */
export function normalizeText(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&laquo;|&raquo;|&ldquo;|&rdquo;|&bdquo;/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[“”„«»]/g, '"')
    .replace(/[ \s]+/g, " ")
    .trim()
    .toLowerCase();
}

export function quoteInText(quote: string, pageText: string): boolean {
  return normalizeText(pageText).includes(normalizeText(quote));
}

export async function checkCitation(pack: string, c: Citation, fetcher: Fetcher): Promise<CitationCheck> {
  const base = { pack, id: c.id, url: c.url };
  try {
    const res = await fetcher(c.url);
    if (res.status < 200 || res.status >= 300) return { ...base, ok: false, status: res.status, error: `HTTP ${res.status}` };
    if (c.quote === undefined) return { ...base, ok: true, status: res.status };
    const found = quoteInText(c.quote, await res.text());
    return { ...base, ok: found, status: res.status, quoteFound: found, ...(found ? {} : { error: "quote not found on the page" }) };
  } catch (e) {
    return { ...base, ok: false, error: (e as Error).message };
  }
}

export async function checkCitations(packs: RulePack[], fetcher: Fetcher): Promise<CitationCheck[]> {
  const out: CitationCheck[] = [];
  for (const p of packs) for (const c of p.citations) out.push(await checkCitation(p.id, c, fetcher));
  return out;
}
