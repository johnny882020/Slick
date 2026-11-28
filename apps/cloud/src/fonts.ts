// Self-hosted web fonts from the style guide (all SIL OFL 1.1, from @fontsource packages).
// Served by this service, not a font CDN, so visitors' addresses never go to a third party.
// Only Latin, Latin Extended and Hebrew subsets are served; unicode-range lets a browser
// fetch a file only when a page uses those characters.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** [package, css file, family name to expose, subsets]. */
const SOURCES: [string, string, string, string[]][] = [
  ["@fontsource-variable/newsreader", "index.css", "Newsreader", ["latin", "latin-ext"]],
  ["@fontsource-variable/frank-ruhl-libre", "index.css", "Frank Ruhl Libre", ["hebrew"]],
  ["@fontsource-variable/instrument-sans", "index.css", "Instrument Sans", ["latin", "latin-ext"]],
  ["@fontsource-variable/heebo", "index.css", "Heebo", ["hebrew"]],
  ["@fontsource/ibm-plex-mono", "400.css", "IBM Plex Mono", ["latin"]],
  ["@fontsource/ibm-plex-mono", "500.css", "IBM Plex Mono", ["latin"]],
];

export interface FontBundle {
  /** @font-face rules pointing at /fonts/<file>. */
  css: string;
  /** File name -> bytes, for the /fonts/ route. Nothing else is served from there. */
  files: Map<string, Buffer>;
}

let cached: FontBundle | undefined;

export function loadFonts(): FontBundle {
  if (cached) return cached;
  const files = new Map<string, Buffer>();
  const rules: string[] = [];
  for (const [pkg, cssFile, family, subsets] of SOURCES) {
    const dir = dirname(require.resolve(`${pkg}/package.json`));
    const css = readFileSync(join(dir, cssFile), "utf8");
    for (const m of css.matchAll(/\/\* ([a-z0-9-]+) \*\/\s*@font-face\s*\{([^}]*)\}/g)) {
      const [, name, body] = m as unknown as [string, string, string];
      if (!subsets.some((s) => name.includes(`-${s}-`)) || name.includes("italic")) continue;
      // "latin" must not also pick up "latin-ext" unless asked for.
      if (!subsets.includes("latin-ext") && name.includes("-latin-ext-")) continue;
      const file = `${name}.woff2`;
      files.set(file, readFileSync(join(dir, "files", file)));
      const weight = /font-weight:\s*([^;]+);/.exec(body)?.[1] ?? "400";
      const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1];
      const variable = /woff2-variations/.test(body);
      rules.push(
        `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:${weight};src:url(/fonts/${file}) format("${variable ? "woff2-variations" : "woff2"}"),url(/fonts/${file}) format("woff2")${range ? `;unicode-range:${range}` : ""}}`,
      );
    }
  }
  cached = { css: rules.join("\n"), files };
  return cached;
}
