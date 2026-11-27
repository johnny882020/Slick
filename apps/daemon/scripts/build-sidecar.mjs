// Build the daemon as a single executable (Node SEA) named for Tauri's externalBin:
//   apps/desktop/src-tauri/binaries/oneseat-daemon-<target-triple>[.exe]
// Run on each target OS (CI matrix). Requires dist-bundle/daemon.cjs (scripts/bundle.mjs).
import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = join(root, "dist-bundle", "daemon.cjs");
if (!existsSync(bundle)) throw new Error("missing dist-bundle/daemon.cjs; run scripts/bundle.mjs first");

function targetTriple() {
  if (process.env.TAURI_TARGET_TRIPLE) return process.env.TAURI_TARGET_TRIPLE;
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const m = out.match(/^host:\s*(\S+)/m);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

const triple = targetTriple();
const exe = process.platform === "win32" ? ".exe" : "";
const outDir = join(root, "..", "desktop", "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `oneseat-daemon-${triple}${exe}`);

const seaConfig = join(root, "dist-bundle", "sea-config.json");
const blob = join(root, "dist-bundle", "daemon.blob");
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }),
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

copyFileSync(process.execPath, outFile);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", outFile], { stdio: "inherit" });

const postject = join(root, "node_modules", ".bin", process.platform === "win32" ? "postject.cmd" : "postject");
const args = [outFile, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
execFileSync(postject, args, { stdio: "inherit", shell: process.platform === "win32" });

if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", outFile], { stdio: "inherit" });
if (process.platform !== "win32") chmodSync(outFile, 0o755);
console.log(`sidecar -> ${outFile}`);

// Ship the native Deno binary for the script sandbox as a second sidecar:
//   binaries/deno-<target-triple>[.exe]   (the shell passes its path as ONESEAT_DENO)
function findNativeDeno() {
  const pnpmDir = join(root, "..", "..", "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return undefined;
  const os = process.platform === "win32" ? "win32" : process.platform;
  const want = os === "linux" ? `linux-${process.arch}-glibc` : `${os}-${process.arch}`;
  for (const d of readdirSync(pnpmDir)) {
    if (!d.startsWith(`@deno+${want}@`)) continue;
    const bin = join(pnpmDir, d, "node_modules", "@deno", want, `deno${exe}`);
    if (existsSync(bin)) return bin;
  }
  return undefined;
}
const deno = process.env.ONESEAT_DENO ?? findNativeDeno();
if (!deno) throw new Error("no native deno binary found; run pnpm install (the harness depends on the deno npm package)");
const denoOut = join(outDir, `deno-${triple}${exe}`);
copyFileSync(deno, denoOut);
if (process.platform !== "win32") chmodSync(denoOut, 0o755);
console.log(`deno    -> ${denoOut}`);
