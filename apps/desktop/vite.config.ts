import { defaultClientConditions, defineConfig } from "vite";

// Tauri expects a fixed dev port; HMR uses the next one (allowed by devCsp in tauri.conf.json).
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  resolve: {
    // Workspace packages resolve to their TypeScript source (see CLAUDE.md).
    conditions: ["@oneseat/source", ...defaultClientConditions],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : { port: 1421 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // WebView2 on Windows is Chromium; WKWebView on macOS 11+ is Safari 14+.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // @oneseat/contracts imports `yaml` for SKILL.md parsing, which the UI never calls.
      // yaml has no side effects, so let Rollup drop it (saves ~50 KB).
      treeshake: { moduleSideEffects: (id) => !/[\\/]node_modules[\\/](\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?yaml[\\/]/.test(id) },
    },
  },
});
