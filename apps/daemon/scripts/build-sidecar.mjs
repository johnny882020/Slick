// Build the daemon as a single executable (Node SEA) plus the native Deno binary,
// named for Tauri's externalBin:
//   apps/desktop/src-tauri/binaries/oneseat-daemon-<target-triple>[.exe]
//   apps/desktop/src-tauri/binaries/deno-<target-triple>[.exe]
//
// Usage: node scripts/build-sidecar.mjs [--target <triple>]
// The target OS must match the host OS (SEA injection needs the host's tools), but the
// architecture may differ (macOS universal builds): the Node and Deno binaries for the
// other architecture are downloaded from nodejs.org and the npm registry.
// Requires dist-bundle/daemon.cjs (scripts/bundle.mjs).
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..", "..");
const bundle = join(root, "dist-bundle", "daemon.cjs");
if (!existsSync(bundle)) throw new Error("missing dist-bundle/daemon.cjs; run scripts/bundle.mjs first");

function hostTriple() {
  try {
    const m = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host:\s*(\S+)/m);
    if (m) return m[1];
  } catch {
    /* no rustc */
  }
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

const argv = process.argv.slice(2).filter((a) => a !== "--");
const ti = argv.indexOf("--target");
const triple = ti >= 0 ? argv[ti + 1] : (process.env.TAURI_TARGET_TRIPLE ?? hostTriple());
if (!triple) throw new Error("--target needs a value");

const targetOs = triple.includes("apple-darwin") ? "darwin" : triple.includes("windows") ? "win32" : "linux";
const targetArch = triple.startsWith("aarch64") ? "arm64" : "x64";
if (targetOs !== process.platform) throw new Error(`cannot build ${triple} on ${process.platform}; run on the target OS`);
const exe = targetOs === "win32" ? ".exe" : "";
const native = targetArch === process.arch;

const outDir = join(root, "..", "desktop", "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "oneseat-sidecar-"));

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** Node binary for the target: this one, or the same version for the other arch. */
async function nodeFor() {
  if (native) return process.execPath;
  const v = process.version; // e.g. v22.12.0
  const plat = targetOs === "win32" ? "win" : targetOs;
  const name = `node-${v}-${plat}-${targetArch}`;
  const tgz = join(work, `${name}.tar.gz`);
  await download(`https://nodejs.org/dist/${v}/${name}.tar.gz`, tgz);
  execFileSync("tar", ["-xzf", tgz, "-C", work]);
  return join(work, name, "bin", "node");
}

function denoPlatformPkg() {
  return targetOs === "linux" ? `linux-${targetArch}-glibc` : `${targetOs}-${targetArch}`;
}

/** Native deno for the target: from node_modules (pnpm), or from the npm registry. */
async function denoFor() {
  if (native && process.env.ONESEAT_DENO) return process.env.ONESEAT_DENO;
  const want = denoPlatformPkg();
  const pnpmDir = join(repo, "node_modules", ".pnpm");
  let version;
  if (existsSync(pnpmDir)) {
    for (const d of readdirSync(pnpmDir)) {
      if (d.startsWith(`@deno+${want}@`)) {
        const bin = join(pnpmDir, d, "node_modules", "@deno", want, `deno${exe}`);
        if (existsSync(bin)) return bin;
      }
      const m = d.match(/^deno@(\d+\.\d+\.\d+)$/);
      if (m) version = m[1];
    }
  }
  if (!version) throw new Error("no deno npm package installed; run pnpm install");
  const tgz = join(work, `deno-${want}.tgz`);
  await download(`https://registry.npmjs.org/@deno/${want}/-/${want}-${version}.tgz`, tgz);
  const dir = join(work, `deno-${want}`);
  mkdirSync(dir);
  execFileSync("tar", ["-xzf", tgz, "-C", dir]);
  return join(dir, "package", `deno${exe}`);
}

// --- daemon (SEA) ---
const outFile = join(outDir, `oneseat-daemon-${triple}${exe}`);
const seaConfig = join(root, "dist-bundle", "sea-config.json");
const blob = join(root, "dist-bundle", "daemon.blob");
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }),
);
// The blob is architecture-independent without code cache / snapshot.
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });
copyFileSync(await nodeFor(), outFile);
if (targetOs === "darwin") execFileSync("codesign", ["--remove-signature", outFile], { stdio: "inherit" });
const postject = join(root, "node_modules", ".bin", process.platform === "win32" ? "postject.cmd" : "postject");
const args = [outFile, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (targetOs === "darwin") args.push("--macho-segment-name", "NODE_SEA");
execFileSync(postject, args, { stdio: "inherit", shell: process.platform === "win32" });
if (targetOs === "darwin") execFileSync("codesign", ["--sign", "-", outFile], { stdio: "inherit" });
if (targetOs !== "win32") chmodSync(outFile, 0o755);
console.log(`sidecar -> ${outFile}`);

// --- deno ---
const denoOut = join(outDir, `deno-${triple}${exe}`);
copyFileSync(await denoFor(), denoOut);
if (targetOs !== "win32") chmodSync(denoOut, 0o755);
console.log(`deno    -> ${denoOut}`);
