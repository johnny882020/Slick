#!/usr/bin/env node
// oblige-rules lint <dir> | citations <dir> | hash <dir>
import { loadRulebook } from "./load.js";
import { checkCitations, FAILING_OUTCOMES } from "./citations.js";
import { packHash } from "./sign.js";

async function main(argv: string[]): Promise<number> {
  const [cmd, dir = "rules"] = argv;
  const { packs, issues } = await loadRulebook(dir);
  if (cmd === "lint") {
    for (const i of issues) console.log(`${i.level === "error" ? "ERROR" : "warn "} ${i.pack} ${i.at}: ${i.message}`);
    const errors = issues.filter((i) => i.level === "error").length;
    console.log(`${packs.length} pack(s) loaded, ${errors} error(s), ${issues.length - errors} warning(s)`);
    return errors > 0 ? 1 : 0;
  }
  if (cmd === "citations") {
    const results = await checkCitations(packs, (url) =>
      fetch(url, { redirect: "follow", headers: { "user-agent": "oblige-rules citation check", "accept-language": "eng,en,de,fr,it,es,nl" } }),
    );
    for (const r of results) console.log(`${r.outcome.padEnd(13)} ${r.pack} ${r.id} ${r.status ?? ""} ${r.url}`);
    const counts = new Map<string, number>();
    for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
    console.log([...counts].map(([k, v]) => `${k}: ${v}`).join(", "));
    return results.some((r) => FAILING_OUTCOMES.includes(r.outcome)) ? 1 : 0;
  }
  if (cmd === "hash") {
    for (const p of packs) console.log(`${packHash(p)}  ${p.id}@${p.version} (${p.review.status})`);
    return 0;
  }
  console.error("usage: oblige-rules lint|citations|hash <rules dir>");
  return 2;
}

main(process.argv.slice(2).filter((a) => a !== "--")).then((code) => process.exit(code), (e) => {
  console.error(e);
  process.exit(1);
});
