#!/usr/bin/env node
// Install smoke test of a built release bundle, on a clean CI machine.
//
// Installs the real installer (Windows: NSIS setup.exe /S; macOS: the .dmg), launches the
// installed app, and waits until the bundled daemon sidecar has started and seeded the
// starter skills (through scan + lint) into the app's data folder. Then it quits the app.
// This proves the installer, both sidecars (daemon + deno), the skills resource and the
// first-run path all work on that OS. It needs no API key and no display interaction.
//
//   node scripts/install-smoke.mjs <bundle dir>   (apps/desktop/src-tauri/target/release/bundle)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STARTER_SKILLS = ["brand-kit", "customers", "outreach", "proposals-invoices", "social-posts", "support-inbox", "weekly-report"];
const IDENTIFIER = "app.oneseat";
const TIMEOUT_MS = Number(process.env.ONESEAT_SMOKE_TIMEOUT_MS ?? 120_000);

function find(dir, pred) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (pred(p, e)) out.push(p);
    else if (e.isDirectory() && !e.name.endsWith(".app")) out.push(...find(p, pred));
  }
  return out;
}

/** A short listing of a folder, `depth` levels deep, for failure messages. */
function tree(dir, depth, prefix = "") {
  if (!existsSync(dir)) return [`${prefix}(missing: ${dir})`];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).slice(0, 40)) {
    out.push(`${prefix}${e.name}${e.isDirectory() ? "/" : ""}`);
    if (e.isDirectory() && depth > 1) out.push(...tree(join(dir, e.name), depth - 1, `${prefix}  `));
  }
  return out;
}

/** Where the installed app keeps its data and log (Tauri app_data_dir / app_log_dir). */
export function appPaths(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "win32")
    return {
      data: join(env.APPDATA ?? join(home, "AppData", "Roaming"), IDENTIFIER),
      log: join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), IDENTIFIER, "logs", "oneseat.log"),
    };
  if (platform === "darwin")
    return { data: join(home, "Library", "Application Support", IDENTIFIER), log: join(home, "Library", "Logs", IDENTIFIER, "oneseat.log") };
  return { data: join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), IDENTIFIER), log: join(home, ".local", "share", IDENTIFIER, "logs", "oneseat.log") };
}

/** What a healthy first launch leaves behind. Returns problems (empty = healthy). */
export function checkFirstRun(dataDir, logText) {
  const problems = [];
  for (const s of STARTER_SKILLS)
    if (!existsSync(join(dataDir, "skills", s, "SKILL.md"))) problems.push(`starter skill ${s} was not installed`);
  if (!existsSync(join(dataDir, "skills.lock.json"))) problems.push("skills.lock.json missing (registry did not record installs)");
  if (!existsSync(join(dataDir, "oneseat.db"))) problems.push("oneseat.db missing (harness did not open its database)");
  if (!/daemon ready \(deno found\)/.test(logText)) problems.push('log has no "daemon ready (deno found)": the deno sidecar was not found');
  if (!/daemon Running/.test(logText)) problems.push('log has no "daemon Running": the shell did not finish the daemon handshake');
  if (/panicked|daemon failed to start/i.test(logText)) problems.push("log shows a panic or a failed daemon start");
  return problems;
}

function installWindows(bundle) {
  const setup = find(join(bundle, "nsis"), (p) => /-setup\.exe$/i.test(p))[0];
  if (!setup) throw new Error(`no NSIS installer under ${bundle}`);
  console.log(`installing ${setup}`);
  execFileSync(setup, ["/S"], { stdio: "inherit" });
  const root = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "OneSeat");
  const exe = find(root, (p) => /\\(OneSeat|oneseat-desktop)\.exe$/i.test(p))[0];
  if (!exe) throw new Error(`installed app not found under ${root}`);
  for (const side of ["oneseat-daemon.exe", "deno.exe"])
    if (!existsSync(join(root, side))) throw new Error(`installer did not ship ${side} next to the app`);
  return exe;
}

function installMac(bundle) {
  const dmg = find(join(bundle, "dmg"), (p) => p.endsWith(".dmg"))[0];
  if (!dmg) throw new Error(`no .dmg under ${bundle}`);
  const mnt = mkdtempSync(join(tmpdir(), "oneseat-dmg-"));
  console.log(`mounting ${dmg}`);
  execFileSync("hdiutil", ["attach", dmg, "-nobrowse", "-mountpoint", mnt], { stdio: "inherit" });
  const app = readdirSync(mnt).find((n) => n.endsWith(".app"));
  if (!app) throw new Error("no .app inside the dmg");
  const dest = join(mkdtempSync(join(tmpdir(), "oneseat-apps-")), app);
  execFileSync("cp", ["-R", join(mnt, app), dest]);
  execFileSync("hdiutil", ["detach", mnt], { stdio: "inherit" });
  const macos = join(dest, "Contents", "MacOS");
  for (const side of ["oneseat-daemon", "deno"])
    if (!existsSync(join(macos, side))) throw new Error(`app bundle does not ship ${side} in Contents/MacOS`);
  const main = readdirSync(macos).find((n) => n !== "oneseat-daemon" && n !== "deno");
  if (!main) throw new Error("no main binary in Contents/MacOS");
  const resources = join(dest, "Contents", "Resources");
  console.log(`Contents/Resources:\n${tree(resources, 2).map((l) => `  ${l}`).join("\n")}`);
  if (!existsSync(join(resources, "skills", "customers", "SKILL.md")))
    throw new Error("app bundle does not ship the starter skills in Contents/Resources/skills (see the listing above)");
  return join(macos, main);
}

async function main() {
  const bundle = process.argv[2];
  if (!bundle || !existsSync(bundle)) {
    console.error("usage: install-smoke.mjs <bundle dir>");
    process.exit(2);
  }
  const exe = process.platform === "win32" ? installWindows(bundle) : process.platform === "darwin" ? installMac(bundle) : null;
  if (!exe) {
    console.log("install smoke: nothing to do on this OS (Windows and macOS only)");
    return;
  }
  const { data, log } = appPaths();
  console.log(`launching ${exe}\n  data: ${data}\n  log:  ${log}`);
  const child = spawn(exe, [], { stdio: "ignore", detached: process.platform !== "win32" });
  const started = Date.now();
  let problems = [];
  try {
    while (Date.now() - started < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 2000));
      if (child.exitCode !== null) throw new Error(`the app exited early with code ${child.exitCode}`);
      const text = existsSync(log) ? readFileSync(log, "utf8") : "";
      problems = checkFirstRun(data, text);
      if (problems.length === 0) break;
    }
  } finally {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const text = existsSync(log) ? readFileSync(log, "utf8") : "(no log file)";
  if (problems.length > 0) {
    console.error(`install smoke FAILED after ${Math.round((Date.now() - started) / 1000)}s:\n- ${problems.join("\n- ")}\n--- app log ---\n${text.slice(-6000)}`);
    process.exit(1);
  }
  const size = statSync(join(data, "oneseat.db")).size;
  console.log(`install smoke PASSED in ${Math.round((Date.now() - started) / 1000)}s: ${STARTER_SKILLS.length} starter skills seeded, database ${size} bytes, deno found, daemon running`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(`install smoke FAILED: ${e.message}`);
    process.exit(1);
  });
}
