#!/usr/bin/env node
// Export one pinned app as its own installable desktop app.
//
// Writes a Tauri config override for a single-app build (product name, identifier, version,
// icon and the app's page as bundled resources) and runs `tauri build --config <override>`.
// The built app is the normal OneSeat shell: at startup it finds resources/pinned/app.json,
// pins that app, and opens only its window (the main window appears only to add a key).
//
//   node scripts/export-app.mjs --app <dir with app.json + index.html> [options]
//   pnpm --filter @oneseat/desktop export-app -- --app <dir>
//
// The "Export" button in OneSeat copies a pinned app to <dataDir>/exports/<id>/ and shows the
// exact command.
//
// Options:
//   --out <dir>        where to write the override and icons (default: <app dir>/tauri-export)
//   --bundles <list>   e.g. msi,nsis or dmg,app (default: msi,nsis on Windows, dmg,app on macOS)
//   --target <triple>  passed to tauri build
//   --no-build         only write the config; print the build command
//
// Signing: combine with scripts/signing-config.mjs (a second --config) on a CI runner that has
// the certificates; see README.md.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");

const APP_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function defaultBundles(platform = process.platform) {
  if (platform === "win32") return ["msi", "nsis"];
  if (platform === "darwin") return ["dmg", "app"];
  return [];
}

/** Validate the parts of app.json (AppJson in contracts/artifact.ts) the export needs. */
export function checkApp(app) {
  const problems = [];
  if (!app || typeof app !== "object") return ["app.json must be an object"];
  if (typeof app.id !== "string" || !APP_ID.test(app.id) || app.id.length > 64) problems.push("id must be a lowercase slug");
  if (typeof app.name !== "string" || !app.name.trim() || app.name.length > 80) problems.push("name must be 1 to 80 characters");
  if (typeof app.version !== "string" || !/^\d+\.\d+\.\d+/.test(app.version)) problems.push("version must be semver");
  const w = app.window;
  if (!w || typeof w.width !== "number" || typeof w.height !== "number") problems.push("window.width and window.height are required");
  return problems;
}

/** Product names become file names: keep them simple. */
export function productName(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 64) || "OneSeat App";
}

/**
 * The tauri.conf.json override (merged over src-tauri/tauri.conf.json by `tauri build --config`).
 * @param {object} app  app.json
 * @param {{ appDir: string, bundles: string[], icons?: string[] }} opts
 * @returns {Record<string, any>}
 */
export function exportConfig(app, { appDir, bundles, icons }) {
  const version = app.version.match(/^\d+\.\d+\.\d+/)[0];
  /** @type {Record<string, any>} */
  const config = {
    productName: productName(app.name),
    version,
    identifier: `app.oneseat.pinned.${app.id}`,
    mainBinaryName: `oneseat-${app.id}`,
    bundle: {
      shortDescription: `${productName(app.name)}, made with OneSeat.`,
      longDescription: `${productName(app.name)} is a OneSeat app. It runs only the skills it lists and has no internet access of its own.`,
      resources: {
        [resolve(appDir, "index.html")]: "pinned/index.html",
        [resolve(appDir, "app.json")]: "pinned/app.json",
      },
    },
  };
  if (bundles.length) config.bundle.targets = bundles;
  if (icons && icons.length) config.bundle.icon = icons;
  return config;
}

/** Decode a PNG data: URI icon, or null for emoji / SVG icons (those keep the OneSeat icon). */
export function pngFromIcon(icon) {
  const m = typeof icon === "string" && icon.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  return m ? Buffer.from(m[1], "base64") : null;
}

function parseArgs(argv) {
  const out = { build: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-build") out.build = false;
    else if (a === "--app" || a === "--out" || a === "--bundles" || a === "--target") out[a.slice(2)] = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a !== "--") throw new Error(`unknown option ${a}`);
  }
  return out;
}

function tauriBin() {
  const bin = join(desktopDir, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
  return existsSync(bin) ? bin : "tauri";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.app) {
    console.log("usage: node scripts/export-app.mjs --app <dir> [--out <dir>] [--bundles msi,nsis] [--target <triple>] [--no-build]");
    process.exit(args.help ? 0 : 2);
  }
  const appDir = resolve(args.app);
  const app = JSON.parse(readFileSync(join(appDir, "app.json"), "utf8"));
  const problems = checkApp(app);
  if (!existsSync(join(appDir, "index.html"))) problems.push("index.html is missing");
  if (problems.length) {
    console.error(`cannot export: ${problems.join("; ")}`);
    process.exit(1);
  }
  const outDir = resolve(args.out ?? join(appDir, "tauri-export"));
  mkdirSync(outDir, { recursive: true });

  let icons;
  const png = pngFromIcon(app.icon);
  if (png) {
    const src = join(outDir, "icon-source.png");
    writeFileSync(src, png);
    const iconDir = join(outDir, "icons");
    execFileSync(tauriBin(), ["icon", src, "-o", iconDir], { stdio: "inherit", shell: process.platform === "win32" });
    icons = readdirSync(iconDir)
      .filter((f) => /^(32x32|128x128|128x128@2x)\.png$|^icon\.(icns|ico)$/.test(f))
      .map((f) => join(iconDir, f));
  } else if (app.icon) {
    console.log("note: only PNG data: URI icons become app icons; this app keeps the OneSeat icon.");
  }

  const bundles = args.bundles ? args.bundles.split(",").map((s) => s.trim()).filter(Boolean) : defaultBundles();
  const config = exportConfig(app, { appDir, bundles, icons });
  const configFile = join(outDir, "tauri.export.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
  console.log(`config -> ${configFile}`);

  const buildArgs = ["build", "--config", configFile];
  if (bundles.length) buildArgs.push("--bundles", bundles.join(","));
  if (args.target) buildArgs.push("--target", args.target);
  if (!args.build) {
    console.log(`build with: (cd ${desktopDir} && CARGO_TARGET_DIR=${join(outDir, "target")} tauri ${buildArgs.join(" ")})`);
    return;
  }
  if (!bundles.length) console.log("note: no default installer formats on this OS; pass --bundles (for example deb,appimage).");
  // Build into the export's own target dir: a single-app build copies resources/pinned/* next to
  // the binary, and a shared src-tauri/target would then make the normal app start in single-app mode.
  const env = { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? join(outDir, "target") };
  console.log(`building into ${env.CARGO_TARGET_DIR}`);
  const r = spawnSync(tauriBin(), buildArgs, { cwd: desktopDir, stdio: "inherit", env, shell: process.platform === "win32" });
  process.exit(r.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
