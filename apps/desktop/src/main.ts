// Fonts are bundled (no CDN): Vite copies the woff2 files into dist, served under font-src 'self'.
// Variable faces load the weight axis only; unicode-range means a subset downloads only when used.
import "@fontsource-variable/newsreader/index.css"; // display (Latin)
import "@fontsource-variable/frank-ruhl-libre/index.css"; // display (Hebrew)
import "@fontsource-variable/instrument-sans/index.css"; // UI and body (Latin)
import "@fontsource-variable/heebo/index.css"; // UI and body (Hebrew)
import "@fontsource/ibm-plex-mono/latin-400.css"; // ids, codes, labels, figures
import "@fontsource/ibm-plex-mono/latin-ext-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-ext-500.css";
import "./styles.css";
import { startApp } from "./app";
import { createTransport } from "./transport";

const root = document.getElementById("app");
if (root) {
  createTransport()
    .then((t) => startApp(root, t))
    .catch((e: unknown) => {
      root.textContent = `OneSeat could not start: ${e instanceof Error ? e.message : String(e)}`;
    });
}
