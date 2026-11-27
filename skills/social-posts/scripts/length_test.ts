// Run: deno test skills/social-posts/scripts/
import { strictEqual, throws } from "node:assert/strict";
import { checkAll, checkPost, countHashtags, graphemes, normalizeChannel, weightedLength } from "./length.ts";

Deno.test("x counts URLs as 23 and emoji as 2", () => {
  strictEqual(weightedLength("hello"), 5);
  strictEqual(weightedLength("see https://example.com/a/very/long/path?x=1"), 4 + 23);
  strictEqual(weightedLength("ok 👍"), 5);
  strictEqual(weightedLength("👨‍👩‍👧"), 2);
  strictEqual(weightedLength("日本"), 4);
});

Deno.test("limits per channel", () => {
  strictEqual(checkPost("x", "a".repeat(280)).ok, true);
  const over = checkPost("twitter", "a".repeat(281));
  strictEqual(over.ok, false);
  strictEqual(over.over_by, 1);
  strictEqual(over.channel, "x");
  strictEqual(checkPost("bluesky", "a".repeat(301)).ok, false);
  strictEqual(checkPost("linkedin", "a".repeat(3000)).ok, true);
});

Deno.test("instagram hashtag cap and visible hook", () => {
  const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
  const r = checkPost("IG", `Fresh loaves today\n\n${tags}`);
  strictEqual(r.hashtags, 31);
  strictEqual(r.ok, false);
  strictEqual(r.hook_fits_visible, true);
});

Deno.test("helpers", () => {
  strictEqual(graphemes("café"), 4);
  strictEqual(countHashtags("#One two #Three_3 a#b"), 2);
  strictEqual(normalizeChannel("Google Business"), "google_business");
});

Deno.test("rejects bad input", () => {
  throws(() => checkAll({ posts: [] }));
  throws(() => checkPost("myspace", "hi"));
});
